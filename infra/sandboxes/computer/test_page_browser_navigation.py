"""Offline protocol regressions for the product page-browser helper."""

import importlib.machinery
import importlib.util
import json
import pathlib
import socket
import struct
import unittest
from unittest.mock import patch


PATH = pathlib.Path(__file__).with_name("rakazo-page-browser")
LOADER = importlib.machinery.SourceFileLoader("page_browser_navigation_product", str(PATH))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
PRODUCT = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(PRODUCT)


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    time = monotonic

    def sleep(self, seconds):
        self.now += seconds


def server_frame(message):
    data = json.dumps(message).encode()
    if len(data) < 126:
        return bytes([0x81, len(data)]) + data
    return bytes([0x81, 126]) + struct.pack("!H", len(data)) + data


class ProtocolSocket:
    """A CDP peer, with delayed wire events independent of outgoing commands."""

    def __init__(self, clock):
        self.clock = clock
        self.timeout = 0.0
        self.buffer = bytearray()
        self.scheduled = []
        self.document = "old"
        self.loader = "old"
        self.mutations = 0
        self.commands = []
        self.lose_navigation_ack = False
        self.lose_action_ack = False
        self.lose_snapshot_ack = False
        self.mode = "queued"

    def settimeout(self, value):
        self.timeout = value

    def close(self):
        pass

    def queue(self, message):
        self.buffer.extend(server_frame(message))

    def event(self, method, params, session="selected"):
        self.queue({"method": method, "params": params, "sessionId": session})

    def navigation(self):
        if self.mode == "foreign":
            self.event("Page.frameRequestedNavigation", {"frameId": "main", "disposition": "currentTab"}, "foreign")
            self.event("Page.frameNavigated", {"frame": {"id": "child", "loaderId": "child"}})
            return
        self.event("Page.frameRequestedNavigation", {"frameId": "main", "disposition": "currentTab"})
        if self.mode == "request-only":
            return
        if self.mode == "stopped":
            self.event("Page.frameStoppedLoading", {"frameId": "main"})
            return
        if self.mode == "same-document":
            self.document = "spa"
            self.event("Page.navigatedWithinDocument", {"frameId": "main", "url": "http://page.test/spa"})
            return
        self.document = "next"
        self.loader = "next"
        self.event("Page.frameNavigated", {"frame": {"id": "main", "loaderId": "next"}})
        self.event("Runtime.executionContextDestroyed", {"executionContextId": 7})
        if self.mode in ("loading", "loading-stopped"):
            if self.mode == "loading-stopped":
                self.event("Page.frameStoppedLoading", {"frameId": "main"})
            self.event("Page.lifecycleEvent", {"frameId": "main", "loaderId": "old", "name": "DOMContentLoaded"})
            self.event("Page.lifecycleEvent", {"frameId": "main", "loaderId": "next", "name": "DOMContentLoaded"}, "foreign")
            self.event("Page.lifecycleEvent", {"frameId": "child", "loaderId": "next", "name": "DOMContentLoaded"})
        elif self.mode == "bfcache":
            self.event("Page.frameNavigated", {"frame": {"id": "main", "loaderId": "next"}, "type": "BackForwardCacheRestore"})
        elif self.mode == "redirect":
            self.document = "final"
            self.loader = "final"
            self.event("Page.frameNavigated", {"frame": {"id": "main", "loaderId": "final"}})
            self.event("Page.lifecycleEvent", {"frameId": "main", "loaderId": "next", "name": "DOMContentLoaded"})
            self.scheduled.append((self.clock.now + 0.05, lambda: self.event("Page.lifecycleEvent", {"frameId": "main", "loaderId": "final", "name": "DOMContentLoaded"})))
        else:
            self.event("Page.lifecycleEvent", {"frameId": "main", "loaderId": "next", "name": "DOMContentLoaded"})

    def schedule_navigation(self):
        if self.mode not in ("none", "no-commit-event"):
            self.scheduled.append((self.clock.now + (1.0 if self.mode == "late" else 0.02), self.navigation))

    def sendall(self, frame):
        length = frame[1] & 0x7F
        offset = 2
        if length == 126:
            length = struct.unpack("!H", frame[2:4])[0]
            offset = 4
        elif length == 127:
            length = struct.unpack("!Q", frame[2:10])[0]
            offset = 10
        mask = frame[offset:offset + 4]
        raw = frame[offset + 4:offset + 4 + length]
        request = json.loads(bytes(value ^ mask[index % 4] for index, value in enumerate(raw)))
        self.commands.append(request["method"])
        method, params = request["method"], request.get("params", {})
        result = {}
        if method == "Page.getFrameTree":
            result = {"frameTree": {"frame": {"id": "main", "loaderId": self.loader}}}
        elif method == "Page.createIsolatedWorld":
            result = {"executionContextId": 7 if self.loader == "old" else 8}
        elif method == "Page.navigate":
            self.schedule_navigation()
            if self.lose_navigation_ack:
                return
            result = {"frameId": "main", "loaderId": "next"}
        elif method == "Runtime.evaluate":
            expression = params["expression"]
            value = True
            if expression.startswith("window.__rakazoPageBrowser.click("):
                self.mutations += 1
                self.schedule_navigation()
                if self.lose_action_ack:
                    return
                value = {"url": "http://page.test/old", "title": "old"}
            elif expression.startswith("Boolean(window.__rakazoPageBrowser.resolve("):
                value = self.loader == "old"
            elif ".snapshot()" in expression:
                if self.lose_snapshot_ack:
                    return
                value = {"url": "http://page.test/" + self.document, "title": self.document,
                         "tree": self.document, "elements": []}
            result = {"result": {"value": value}}
        self.queue({"id": request["id"], "result": result})

    def recv(self, count):
        if not self.buffer:
            due = min(self.scheduled, default=None, key=lambda item: item[0])
            if due and due[0] <= self.clock.now + self.timeout:
                self.scheduled.remove(due)
                self.clock.now = due[0]
                due[1]()
            else:
                self.clock.now += self.timeout
                raise socket.timeout()
        data = bytes(self.buffer[:count])
        del self.buffer[:count]
        return data


class ByteSocket:
    """A peer that keeps delivering bytes just before individual socket timeouts."""

    def __init__(self, clock, data, tick=0.1, first_chunk=b""):
        self.clock, self.data, self.tick = clock, bytearray(data), tick
        self.first_chunk = first_chunk
        self.timeout = 0.0
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def close(self):
        self.closed = True

    def settimeout(self, value):
        self.timeout = value

    def sendall(self, data):
        pass

    def recv(self, count):
        if self.first_chunk:
            data, self.first_chunk = self.first_chunk, b""
            return data
        if self.timeout < self.tick:
            self.clock.now += self.timeout
            raise socket.timeout()
        if not self.data:
            return b""
        self.clock.now += self.tick
        data = bytes(self.data[:1])
        del self.data[:1]
        return data


class NavigationProtocolTests(unittest.TestCase):
    def act(self, mode="queued", actions=None, deadline=None, lose_ack=False):
        clock = Clock()
        with patch.object(PRODUCT, "time", clock):
            peer = ProtocolSocket(clock)
            peer.mode, peer.lose_action_ack = mode, lose_ack
            client = PRODUCT.CdpClient("ws://127.0.0.1:9222/devtools/browser/test")
            if deadline is not None:
                client.deadline = deadline
            client._sock = peer
            result = PRODUCT.act(client, "selected", actions or [{"kind": "click", "ref": "old-ref"}])
        return result, peer, clock

    def test_queued_navigation_observes_new_document_after_exactly_one_click(self):
        clock = Clock()
        with patch.object(PRODUCT, "time", clock):
            peer = ProtocolSocket(clock)
            client = PRODUCT.CdpClient("ws://127.0.0.1:9222/devtools/browser/test")
            client._sock = peer
            result = PRODUCT.act(client, "selected", [{"kind": "click", "ref": "old-ref"}])
        self.assertTrue(result["ok"])
        self.assertEqual(result["completed"], 1)
        self.assertEqual(result["url"], "http://page.test/next")
        self.assertEqual(result["tree"], "next")
        self.assertEqual(peer.mutations, 1)

    def test_fragment_trickle_cannot_extend_absolute_cdp_deadline(self):
        clock = Clock()

        class TrickleSocket(ProtocolSocket):
            def recv(self, count):
                if self.timeout < 0.2:
                    clock.now += self.timeout
                    raise socket.timeout()
                clock.now += 0.2
                return super().recv(1)

        with patch.object(PRODUCT, "time", clock):
            peer = TrickleSocket(clock)
            client = PRODUCT.CdpClient("ws://127.0.0.1:9222/devtools/browser/test")
            client.deadline = 1.0
            client._sock = peer
            with self.assertRaises(TimeoutError):
                client.call("Page.getFrameTree")
        self.assertLessEqual(clock.now, 1.001)

    def test_explicit_navigation_does_not_infer_ack_from_new_document(self):
        clock = Clock()
        with patch.object(PRODUCT, "time", clock):
            peer = ProtocolSocket(clock)
            peer.lose_navigation_ack = True
            client = PRODUCT.CdpClient("ws://127.0.0.1:9222/devtools/browser/test")
            client._sock = peer
            result = PRODUCT.navigate(client, "selected", "http://page.test/next")
        self.assertFalse(result["ok"])
        self.assertTrue(result.get("uncertain"))
        self.assertTrue(result.get("timedOut"))
        self.assertEqual(result["url"], "http://page.test/next")
        self.assertEqual(peer.commands.count("Page.navigate"), 1)

    def test_explicit_navigation_ack_with_loader_waits_for_commit(self):
        clock = Clock()
        with patch.object(PRODUCT, "time", clock):
            peer = ProtocolSocket(clock)
            peer.mode = "no-commit-event"
            client = PRODUCT.CdpClient("ws://127.0.0.1:9222/devtools/browser/test")
            client._sock = peer
            result = PRODUCT.navigate(client, "selected", "http://page.test/next")
        self.assertTrue(result["ok"])
        self.assertTrue(result.get("timedOut"))
        self.assertFalse(result["uncertain"])
        self.assertEqual(result["url"], "http://page.test/old")
        self.assertAlmostEqual(clock.now, 5.0)

    def test_no_navigation_and_arbitrary_late_timer_return_after_signal_grace(self):
        for mode in ("none", "late", "foreign"):
            with self.subTest(mode=mode):
                result, peer, clock = self.act(mode)
                self.assertTrue(result["ok"])
                self.assertFalse(result.get("timedOut", False))
                self.assertEqual(result["url"], "http://page.test/old")
                self.assertAlmostEqual(clock.now, 0.35)
                self.assertEqual(peer.mutations, 1)

    def test_same_document_and_bfcache_need_no_new_dcl(self):
        for mode, document in (("same-document", "spa"), ("bfcache", "next")):
            with self.subTest(mode=mode):
                result, peer, clock = self.act(mode)
                self.assertTrue(result["ok"])
                self.assertEqual(result["url"], "http://page.test/" + document)
                self.assertFalse(result.get("timedOut", False))
                self.assertLess(clock.now, 0.1)

    def test_matching_current_loader_dcl_is_required_after_redirect(self):
        result, peer, clock = self.act("redirect")
        self.assertTrue(result["ok"])
        self.assertEqual(result["url"], "http://page.test/final")
        self.assertAlmostEqual(clock.now, 0.07)
        self.assertEqual(peer.mutations, 1)

    def test_stale_loader_subframe_and_other_session_cannot_end_dcl_wait(self):
        result, peer, clock = self.act("loading")
        self.assertTrue(result["ok"])
        self.assertTrue(result["timedOut"])
        self.assertFalse(result["uncertain"])
        self.assertEqual(result["url"], "http://page.test/next")
        self.assertAlmostEqual(clock.now, 10.02)
        self.assertEqual(peer.mutations, 1)

    def test_uncommitted_request_timeout_stops_partial_batch(self):
        actions = [{"kind": "click", "ref": "old-ref"}] * 2
        result, peer, clock = self.act("request-only", actions)
        self.assertFalse(result["ok"])
        self.assertTrue(result["timedOut"])
        self.assertFalse(result["uncertain"])
        self.assertEqual(result["completed"], 1)
        self.assertEqual(peer.mutations, 1)
        self.assertEqual(result["tree"], "old")
        self.assertAlmostEqual(clock.now, 5.02)

    def test_stopped_request_without_commit_observes_current_document_without_timeout(self):
        result, peer, clock = self.act("stopped")
        self.assertTrue(result["ok"])
        self.assertFalse(result.get("timedOut", False))
        self.assertFalse(result["uncertain"])
        self.assertEqual(result["url"], "http://page.test/old")
        self.assertEqual(peer.mutations, 1)
        self.assertAlmostEqual(clock.now, 0.02)

    def test_stopped_loading_after_commit_cannot_replace_matching_dcl(self):
        result, peer, clock = self.act("loading-stopped")
        self.assertTrue(result["ok"])
        self.assertTrue(result["timedOut"])
        self.assertFalse(result["uncertain"])
        self.assertEqual(result["url"], "http://page.test/next")
        self.assertAlmostEqual(clock.now, 10.02)

    def test_old_refs_never_bind_new_document_and_keep_partial_progress(self):
        result, peer, clock = self.act(actions=[{"kind": "click", "ref": "old-ref"}] * 2)
        self.assertFalse(result["ok"])
        self.assertFalse(result["uncertain"])
        self.assertEqual(result["completed"], 1)
        self.assertEqual(result["url"], "http://page.test/next")
        self.assertEqual(peer.mutations, 1)

    def test_lost_action_ack_remains_uncertain_despite_navigation(self):
        result, peer, clock = self.act(lose_ack=True)
        self.assertFalse(result["ok"])
        self.assertTrue(result["uncertain"])
        self.assertTrue(result["timedOut"])
        self.assertEqual(result["completed"], 0)
        self.assertEqual(result["url"], "http://page.test/next")
        self.assertEqual(peer.mutations, 1)
        self.assertAlmostEqual(clock.now, 19.0)

    def test_whole_batch_shares_budget_and_keeps_final_observation_reserve(self):
        result, peer, clock = self.act("none", [{"kind": "click", "ref": "old-ref"}] * 24, 4.0)
        self.assertFalse(result["ok"])
        self.assertTrue(result["timedOut"])
        self.assertEqual(result["completed"], 3)
        self.assertFalse(result["uncertain"])
        self.assertEqual(result["tree"], "old")
        self.assertEqual(peer.mutations, 3)
        self.assertAlmostEqual(clock.now, 1.0)

    def test_snapshot_failure_never_reports_an_old_observation_as_fresh(self):
        clock = Clock()
        with patch.object(PRODUCT, "time", clock):
            peer = ProtocolSocket(clock)
            peer.lose_snapshot_ack = True
            client = PRODUCT.CdpClient("ws://127.0.0.1:9222/devtools/browser/test")
            client._sock = peer
            result = PRODUCT.act(client, "selected", [{"kind": "click", "ref": "old-ref"}])
        self.assertFalse(result["ok"])
        self.assertTrue(result["timedOut"])
        self.assertEqual(result["completed"], 1)
        self.assertFalse(result["uncertain"])
        self.assertNotIn("tree", result)
        self.assertNotIn("url", result)
        self.assertIn("Observation unavailable", result["error"])
        self.assertAlmostEqual(clock.now, 3.02)

    def test_http_header_and_body_trickle_obey_absolute_deadline(self):
        for first_chunk in (b"", b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\n\r\n"):
            with self.subTest(stage="body" if first_chunk else "headers"):
                clock = Clock()
                peer = ByteSocket(clock, b"HTTP/1.1 200 OK\r\n" + b"x" * 200,
                                  first_chunk=first_chunk)
                with patch.object(PRODUCT, "time", clock), patch.object(PRODUCT.socket, "create_connection", return_value=peer):
                    with self.assertRaises(TimeoutError):
                        PRODUCT.http_get_json("http://127.0.0.1:9222/json/version", deadline=0.5)
                self.assertAlmostEqual(clock.now, 0.5)
                self.assertTrue(peer.closed)

    def test_http_discovery_reads_bounded_content_length_without_waiting_for_close(self):
        clock = Clock()
        body = b'{"Browser":"Chromium"}'
        peer = ByteSocket(clock, b"", first_chunk=b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
        with patch.object(PRODUCT, "time", clock), patch.object(PRODUCT.socket, "create_connection", return_value=peer):
            result = PRODUCT.http_get_json("http://127.0.0.1:9222/json/version", deadline=0.5)
        self.assertEqual(result, {"Browser": "Chromium"})
        self.assertEqual(clock.now, 0)
        self.assertTrue(peer.closed)

    def test_websocket_handshake_trickle_is_bounded_and_closes_failed_socket(self):
        clock = Clock()
        peer = ByteSocket(clock, b"HTTP/1.1 101 Switching Protocols\r\n" + b"x" * 200)
        with patch.object(PRODUCT, "time", clock), patch.object(PRODUCT.socket, "create_connection", return_value=peer):
            client = PRODUCT.CdpClient("ws://127.0.0.1:9222/devtools/browser/test", deadline=0.5)
            with self.assertRaises(TimeoutError):
                client.connect()
        self.assertAlmostEqual(clock.now, 0.5)
        self.assertTrue(peer.closed)

    def test_expired_budget_dispatches_no_cdp_command(self):
        clock = Clock()
        with patch.object(PRODUCT, "time", clock):
            peer = ProtocolSocket(clock)
            client = PRODUCT.CdpClient("ws://127.0.0.1:9222/devtools/browser/test", deadline=0.0)
            client._sock = peer
            with self.assertRaises(TimeoutError):
                client.call("Page.navigate", {"url": "http://page.test/next"})
        self.assertEqual(peer.commands, [])

    def test_invalid_navigation_url_is_refused_before_dispatch(self):
        for url in ("file:///tmp/page", "javascript:void(0)", "https://user:pass@page.test"):
            with self.subTest(url=url):
                clock = Clock()
                with patch.object(PRODUCT, "time", clock):
                    peer = ProtocolSocket(clock)
                    client = PRODUCT.CdpClient("ws://127.0.0.1:9222/devtools/browser/test")
                    client._sock = peer
                    with self.assertRaises(RuntimeError):
                        PRODUCT.navigate(client, "selected", url)
                self.assertEqual(peer.commands, [])


if __name__ == "__main__":
    unittest.main()
