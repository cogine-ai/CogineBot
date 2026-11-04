"""Offline exact-reference and saved-login CDP boundaries; no browser process."""

import base64
import json
import struct
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import page_secrets as secrets


def exact_ref(target="tab-a", frame="frame-a", loader="loader-a"):
    payload = json.dumps([target, frame, loader, "a" * 32], separators=(",", ":"))
    return "r2." + base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


class CdpBoundaryTest(unittest.TestCase):
    def test_closed_extended_frame_does_not_spin(self):
        for partial in (b"\x81\x7e", b"\x81\x7f", b"\x81\x80"):
            with self.subTest(partial=partial):
                client = secrets.CdpClient("ws://127.0.0.1:9222/test")
                client._sock = Mock()
                client._sock.recv.return_value = b""
                client._buf.extend(partial)
                with self.assertRaisesRegex(RuntimeError, "closed"):
                    client._read_frame()

    def test_bounds_frame_before_reading_payload(self):
        client = secrets.CdpClient("ws://127.0.0.1:9222/test")
        client._sock = Mock()
        client._buf.extend(b"\x81\x7f" + struct.pack("!Q", 10_000_000))
        with self.assertRaisesRegex(RuntimeError, "too large"):
            client._read_frame()
        client._sock.recv.assert_not_called()

    def test_discovery_cannot_leave_the_requested_loopback_endpoint(self):
        for endpoint in (
            "ws://example.test:9222/session", "ws://127.0.0.1:9223/session",
            "wss://127.0.0.1:9222/session", "ws://127.0.0.1.evil.test:9222/session",
        ):
            with self.subTest(endpoint=endpoint):
                with patch.object(secrets, "http_get_json", return_value={"webSocketDebuggerUrl": endpoint}):
                    with self.assertRaisesRegex(RuntimeError, "Unexpected CDP"):
                        secrets.discover_ws_url(9222)

    def test_discovery_bounds_the_body_before_json_parsing(self):
        opened = Mock()
        opened.__enter__ = Mock(return_value=opened)
        opened.__exit__ = Mock(return_value=False)
        opened.recv.return_value = b"HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n"
        with patch.object(secrets.socket, "create_connection", return_value=opened):
            with self.assertRaisesRegex(RuntimeError, "too large"):
                secrets.discover_ws_url(9222)
        opened.recv.assert_called_once_with(4096)
        opened.__exit__.assert_called_once()

    def test_expired_deadline_prevents_discovery(self):
        with patch.object(secrets.time, "monotonic", return_value=100), \
                patch.object(secrets.socket, "create_connection") as opened:
            with self.assertRaises(TimeoutError):
                secrets.discover_ws_url(9222, deadline=99)
            opened.assert_not_called()

    def test_context_lookup_rejects_default_foreign_and_unbound_contexts(self):
        for aux, session in (
            ({"frameId": "frame-a", "isDefault": True}, "session-a"),
            ({"frameId": "other-frame", "isDefault": False}, "session-a"),
            ({"frameId": "frame-a", "isDefault": False}, "session-b"),
            ({}, "session-a"),
        ):
            with self.subTest(aux=aux, session=session):
                client = secrets.CdpClient("ws://127.0.0.1:9222/test")
                client._handle_event({"method": "Runtime.executionContextCreated", "sessionId": session,
                                      "params": {"context": {"id": 42, "name": secrets.WORLD_NAME,
                                                             "auxData": aux}}})
                self.assertIsNone(client.find_world_context(secrets.WORLD_NAME, "frame-a", "session-a"))

    def test_world_reuses_only_the_named_bound_isolated_context(self):
        client = secrets.CdpClient("ws://127.0.0.1:9222/test")
        calls = []

        def call(method, params=None, *, session_id=None, timeout_s=10.0):
            calls.append((method, params, session_id))
            if method == "Runtime.enable":
                client._handle_event({"method": "Runtime.executionContextCreated", "sessionId": session_id,
                                      "params": {"context": {"id": 42, "name": secrets.WORLD_NAME,
                                                             "auxData": {"frameId": "frame-a", "isDefault": False}}}})
                return {}
            if method == "Runtime.evaluate":
                return {"result": {"value": True}}
            raise AssertionError(f"Unexpected CDP call: {method}")

        client.call = call
        self.assertEqual(secrets.world_in(client, "session-a", "frame-a"), 42)
        self.assertNotIn("Page.createIsolatedWorld", [method for method, _, _ in calls])
        evaluated = [params for method, params, _ in calls if method == "Runtime.evaluate"]
        self.assertEqual(evaluated[0]["contextId"], 42)
        self.assertEqual(evaluated[0]["expression"], secrets.EVAL_HELPERS)

    def test_world_creates_a_named_context_when_missing(self):
        client = secrets.CdpClient("ws://127.0.0.1:9222/test")

        def call(method, params=None, *, session_id=None, timeout_s=10.0):
            if method == "Runtime.enable":
                return {}
            if method == "Page.createIsolatedWorld":
                self.assertEqual(params, {"frameId": "frame-a", "worldName": secrets.WORLD_NAME})
                self.assertEqual(session_id, "session-a")
                return {"executionContextId": 7}
            if method == "Runtime.evaluate":
                self.assertEqual(params["contextId"], 7)
                return {"result": {"value": True}}
            raise AssertionError(f"Unexpected CDP call: {method}")

        client.call = call
        self.assertEqual(secrets.world_in(client, "session-a", "frame-a"), 7)


class ExactReferenceTest(unittest.TestCase):
    def test_registers_the_actual_backend_node_without_a_name_lookup(self):
        client = Mock()
        tree = {"frameTree": {"frame": {"id": "frame-a", "loaderId": "loader-a"}}}
        client.call.side_effect = [tree, {"object": {"objectId": "exact-node"}},
                                   {"result": {"value": True}}, tree]
        ref = secrets.register_node(client, "session-a", 7, target_id="tab-a",
                                    frame_id="frame-a", loader_id="loader-a", backend_node_id=41)
        self.assertEqual(secrets.ref_binding(ref, "tab-a"), ("frame-a", "loader-a"))
        self.assertEqual([call.args[0] for call in client.call.call_args_list],
                         ["Page.getFrameTree", "DOM.resolveNode", "Runtime.callFunctionOn", "Page.getFrameTree"])
        _, first, second, _ = client.call.call_args_list
        self.assertEqual(first.args, ("DOM.resolveNode", {"backendNodeId": 41, "executionContextId": 7}))
        self.assertEqual(first.kwargs, {"session_id": "session-a"})
        self.assertEqual(second.args[0], "Runtime.callFunctionOn")
        self.assertEqual(second.args[1]["objectId"], "exact-node")
        self.assertEqual(second.args[1]["arguments"], [{"value": ref}, {"value": {}}])
        self.assertNotIn("querySelector", second.args[1]["functionDeclaration"])

    def test_registration_does_not_return_a_ref_when_its_document_changes_during_bind(self):
        client = Mock()
        client.call.side_effect = [
            {"frameTree": {"frame": {"id": "frame-a", "loaderId": "loader-a"}}},
            {"object": {"objectId": "exact-node"}}, {"result": {"value": True}},
            {"frameTree": {"frame": {"id": "frame-a", "loaderId": "replacement-loader"}}},
        ]
        with self.assertRaisesRegex(secrets.Refused, "document has changed"):
            secrets.register_node(client, "session-a", 7, target_id="tab-a",
                                  frame_id="frame-a", loader_id="loader-a", backend_node_id=41)

    def test_ref_cannot_be_reused_on_another_tab_or_have_missing_identity(self):
        self.assertEqual(secrets.ref_binding(exact_ref(), "tab-a"), ("frame-a", "loader-a"))
        for ref, target in ((exact_ref(), "tab-b"), ("e12", "tab-a"), ("r2.invalid", "tab-a"),
                            (exact_ref(frame=""), "tab-a"), (exact_ref(loader=""), "tab-a")):
            with self.subTest(ref=ref, target=target), self.assertRaises(secrets.Refused):
                secrets.ref_binding(ref, target)

    def test_same_frame_with_a_new_document_loader_is_refused_before_world_or_fill(self):
        client = Mock()
        client.call.side_effect = [{}, {}, {"frameTree": {"frame": {"id": "frame-a", "loaderId": "new-loader"}}}]
        with patch.object(secrets, "world_in") as world:
            with self.assertRaisesRegex(secrets.Refused, "document has changed"):
                secrets.frame_context(client, "session-a", "frame-a", "old-loader")
            world.assert_not_called()
        self.assertNotIn("Runtime.callFunctionOn", [call.args[0] for call in client.call.call_args_list])

    def test_oopif_uses_its_own_session_and_world(self):
        client = Mock()
        client.frame_sessions.side_effect = lambda session: ["frame-session"] if session == "page-session" else []

        def call(method, params=None, *, session_id=None, timeout_s=10.0):
            if method == "Page.getFrameTree":
                frame = {"id": "frame-a", "loaderId": "loader-a"} if session_id == "frame-session" else {"id": "main", "loaderId": "main-loader"}
                return {"frameTree": {"frame": frame}}
            return {}

        client.call.side_effect = call
        with patch.object(secrets, "world_in", return_value=17) as world:
            self.assertEqual(secrets.frame_context(client, "page-session", "frame-a", "loader-a"),
                             ("frame-session", 17))
        world.assert_called_once_with(client, "frame-session", "frame-a")

    def test_oopif_own_session_wins_over_the_parent_frame_stub(self):
        client = Mock()
        client.frame_sessions.side_effect = lambda session: ["child-session"] if session == "page-session" else []

        def call(method, params=None, *, session_id=None, timeout_s=10.0):
            if method == "Page.getFrameTree":
                own = {"frame": {"id": "child", "loaderId": "child-loader"}}
                if session_id == "child-session":
                    return {"frameTree": own}
                return {"frameTree": {"frame": {"id": "main", "loaderId": "main-loader"}, "childFrames": [own]}}
            return {}

        client.call.side_effect = call
        with patch.object(secrets, "world_in", return_value=17) as world:
            self.assertEqual(secrets.frame_context(client, "page-session", "child", "child-loader"),
                             ("child-session", 17))
        world.assert_called_once_with(client, "child-session", "child")


class ExactCollectorTest(unittest.TestCase):
    def collector(self, *, replace_document_on_bind=False):
        page = object.__new__(secrets.ExactPage)
        page.target, page.session = "tab", "session"
        page.navigation = secrets.NavigationState("session", {"id": "main", "loaderId": "old", "url": "https://example.test"})
        client = page.client = Mock()
        client.frame_sessions.return_value = []
        client.find_world_context.return_value = 7
        calls, bound = [], []
        state = {"loader": "old"}

        def call(method, params=None, *, session_id=None, timeout_s=30.0):
            calls.append((method, params, session_id))
            if method == "Page.getFrameTree":
                return {"frameTree": {"frame": {"id": "main", "loaderId": state["loader"], "url": "https://example.test"}}}
            if method == "Runtime.evaluate":
                return {"result": {"value": True}}
            if method == "Accessibility.getFullAXTree":
                return {"nodes": [
                    {"ignored": True, "role": {"value": "button"}, "backendDOMNodeId": 1},
                    {"role": {"value": "StaticText"}, "backendDOMNodeId": 2},
                    {"role": {"value": "button"}, "name": {"value": "Save"}, "backendDOMNodeId": 42},
                    {"role": {"value": "button"}, "name": {"value": "No backend"}},
                ]}
            if method == "DOM.resolveNode":
                return {"object": {"objectId": "backend-42"}}
            if method == "Runtime.callFunctionOn":
                function = params["functionDeclaration"]
                if ".state()" in function:
                    value = {"url": "https://example.test", "title": "Page", "text": "Readable", "masked": []}
                elif ".bind(" in function:
                    bound.append(params)
                    if replace_document_on_bind:
                        state["loader"] = "replacement"
                    value = True
                elif ".describe(" in function:
                    value = {"ref": params["arguments"][0]["value"], "role": "button", "name": "Save"}
                elif ".cursor(" in function:
                    value = []
                else:
                    value = True
                return {"result": {"value": value}}
            return {}

        client.call.side_effect = call
        return page, calls, bound

    def test_snapshot_registers_only_a_real_actionable_ax_backend_node(self):
        page, calls, bound = self.collector()
        snapshot = page.snapshot()
        self.assertEqual(len(snapshot["elements"]), 1)
        element = snapshot["elements"][0]
        self.assertEqual(secrets.ref_binding(element["ref"], "tab"), ("main", "old"))
        resolutions = [params for method, params, _ in calls if method == "DOM.resolveNode"]
        self.assertEqual(resolutions, [{"backendNodeId": 42, "executionContextId": 7}])
        self.assertEqual(bound[0]["objectId"], "backend-42")
        self.assertEqual(bound[0]["arguments"], [{"value": element["ref"]}, {"value": {"role": "button", "name": "Save", "ax": True}}])
        self.assertNotIn("querySelector", bound[0]["functionDeclaration"])
        self.assertNotIn("frameOrigin", element)
        self.assertTrue(all(session == "session" for _, _, session in calls))

    def test_snapshot_does_not_return_a_binding_when_the_document_changes_during_registration(self):
        page, calls, bound = self.collector(replace_document_on_bind=True)
        with self.assertRaisesRegex(secrets.Refused, "document has changed"):
            page.snapshot()
        self.assertEqual(len(bound), 1)
        self.assertFalse(any(method == "Runtime.callFunctionOn" and ".describe(" in params["functionDeclaration"]
                             for method, params, _ in calls))
    def test_global_control_cap_limits_ax_and_cursor_minting_but_keeps_all_frame_masks(self):
        page = object.__new__(secrets.ExactPage)
        page.target, page.session = "tab", "main-session"
        page.navigation = secrets.NavigationState("main-session", {"id": "main", "loaderId": "main-loader"})
        frames = [{"id": name, "loaderId": name + "-loader", "session": name + "-session",
                   **({"parentId": "main"} if name != "main" else {})} for name in ("main", "first", "second")]
        page.frames = Mock(return_value=frames)
        page.client = Mock()
        calls, bindings, cursor_limits, states = [], [], [], []
        def call(method, params=None, *, session_id=None, timeout_s=30.0):
            calls.append((method, params, session_id))
            frame = next(frame for frame in frames if frame["session"] == session_id)
            if method == "Page.getFrameTree":
                return {"frameTree": {"frame": frame}}
            if method == "Accessibility.getFullAXTree":
                return {"nodes": [{"role": {"value": "button"}, "name": {"value": f"Button {i}"},
                                   "backendDOMNodeId": i + 1} for i in range(150)]}
            if method == "DOM.resolveNode":
                return {"object": {"objectId": str(params["backendNodeId"])}}
            if method == "Runtime.callFunctionOn":
                function = params["functionDeclaration"]
                if ".state()" in function:
                    states.append(frame["id"])
                    value = {"url": "https://example.test", "text": frame["id"], "masked": ["masked-" + frame["id"]]}
                elif ".bind(" in function:
                    bindings.append(params["arguments"][0]["value"])
                    value = True
                elif ".describe(" in function:
                    value = {"ref": params["arguments"][0]["value"], "role": "button", "name": "Exact"}
                elif ".cursor(" in function:
                    args = [arg["value"] for arg in params["arguments"]]
                    limit = args[3] if len(args) > 3 else 160
                    cursor_limits.append((session_id, limit))
                    value = [{"ref": "r2." + base64.urlsafe_b64encode(json.dumps(["tab", frame["id"], frame["loaderId"], f"{i + 500:032x}"]).encode()).decode().rstrip("="),
                              "role": "button", "name": "Extra"} for i in range(limit)]
                else:
                    value = True
                return {"result": {"value": value}}
            return {}
        page.client.call.side_effect = call
        with patch.object(secrets, "world_in", return_value=7):
            snapshot = page.snapshot()
        self.assertEqual(len(snapshot["elements"]), 160)
        self.assertEqual(len(bindings), 150)
        self.assertEqual(cursor_limits, [("main-session", 10)])
        self.assertEqual([session for method, _, session in calls if method == "Accessibility.getFullAXTree"], ["main-session"])
        self.assertEqual(states, ["main", "first", "second"])
        self.assertEqual(set(snapshot["masked"]), {"masked-main", "masked-first", "masked-second"})



class NativeClickTest(unittest.TestCase):
    def native_page(self, allowed=(True, True, True, True)):
        page = object.__new__(secrets.ExactPage)
        page.target, page.session = "tab-a", "session-a"
        page.prepare_frame = Mock()
        page.locate = Mock(return_value=("session-a", 7))
        page.client = Mock()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        with patch.object(secrets.tempfile, "gettempdir", return_value=directory.name):
            page.pointer_guard = secrets.PointerGuard("owned-instance", "tab-a", time.monotonic() + 22)
        page.pointer_states = Mock(return_value=[])
        checks = iter(allowed)

        def call(method, params=None, *, session_id=None, timeout_s=30.0):
            if method == "Runtime.callFunctionOn":
                function = params["functionDeclaration"]
                if ".describe(" in function:
                    return {"result": {"value": {"tag": "button"}}}
                if ".clickNode(" in function:
                    return {"result": {"objectId": "exact-button"}}
                if ".clickContains(" in function:
                    return {"result": {"value": next(checks)}}
                raise AssertionError("Unexpected script mutation")
            if method == "DOM.getBoxModel":
                return {"model": {"content": [0, 0, 10, 0, 10, 10, 0, 10]}}
            if method == "DOM.getNodeForLocation":
                return {"frameId": "frame-a", "backendNodeId": 42}
            if method == "DOM.resolveNode":
                return {"object": {"objectId": "hit-button"}}
            if method == "Input.dispatchMouseEvent":
                if params["type"] == "mousePressed":
                    self.assertIsNotNone(page.pointer_guard.read(), "Press must be persisted before CDP dispatch")
                return {}
            raise AssertionError(method)

        page.client.call.side_effect = call
        return page

    def events(self, page):
        return [call.args[1] for call in page.client.call.call_args_list if call.args[0] == "Input.dispatchMouseEvent"]

    def test_click_dispatches_one_native_move_press_release_sequence(self):
        page = self.native_page()
        page.act(exact_ref(), "click")
        events = self.events(page)
        self.assertEqual([event["type"] for event in events], ["mouseMoved", "mousePressed", "mouseReleased"])
        self.assertTrue(all(event["x"] == 5 and event["y"] == 5 for event in events))
        self.assertEqual(events[1]["clickCount"], 1)
        self.assertEqual(events[2]["clickCount"], 1)
        self.assertEqual(events[2]["buttons"], 0)
        self.assertEqual(sum(call.args[0] == "DOM.getNodeForLocation" for call in page.client.call.call_args_list), 4)

    def test_fractional_target_bounds_use_one_integer_css_point_for_hit_and_native_input(self):
        page = self.native_page()
        original = page.client.call.side_effect
        def fractional(method, params=None, **kwargs):
            if method == "DOM.getBoxModel":
                return {"model": {"content": [0.2, 0.4, 10.2, 0.4, 10.2, 10.4, 0.2, 10.4]}}
            return original(method, params, **kwargs)
        page.client.call.side_effect = fractional
        page.act(exact_ref(), "click")
        hits = [call.args[1] for call in page.client.call.call_args_list if call.args[0] == "DOM.getNodeForLocation"]
        self.assertTrue(hits)
        self.assertTrue(all((hit["x"], hit["y"]) == (5, 5) for hit in hits))
        self.assertTrue(all((event["x"], event["y"]) == (5, 5) for event in self.events(page)))

    def test_covered_target_dispatches_no_pointer_input(self):
        page = self.native_page((False,))
        with self.assertRaises(secrets.Refused):
            page.act(exact_ref(), "click")
        self.assertEqual(self.events(page), [])

    def test_changed_target_after_press_keeps_guard_without_a_blind_release_or_repeat(self):
        page = self.native_page((True, True, True, False))
        with self.assertRaisesRegex(RuntimeError, "stopped after pointer"):
            page.act(exact_ref(), "click")
        events = self.events(page)
        self.assertEqual([event["type"] for event in events], ["mouseMoved", "mousePressed"])
        self.assertIsNotNone(page.pointer_guard.read())
        before = len(page.client.call.call_args_list)
        with self.assertRaisesRegex(secrets.Refused, "uncertain"):
            page.act(exact_ref(), "fill", "not-dispatched")
        self.assertEqual(len(page.client.call.call_args_list), before)

    def test_target_changed_during_observer_preparation_dispatches_no_press_or_release(self):
        page = self.native_page()
        original = page.client.call.side_effect
        valid = {"value": True}
        def call(method, params=None, **kwargs):
            if method == "Runtime.callFunctionOn" and ".clickContains(" in params.get("functionDeclaration", ""):
                return {"result": {"value": valid["value"]}}
            return original(method, params, **kwargs)
        page.client.call.side_effect = call
        def prepare(token):
            valid["value"] = False
            return []
        page.pointer_states.side_effect = prepare
        with self.assertRaises(RuntimeError):
            page.act(exact_ref(), "click")
        self.assertEqual([event["type"] for event in self.events(page)], ["mouseMoved"])
        self.assertIsNone(page.pointer_guard.read())

    def test_lost_press_ack_keeps_persistent_guard_until_ordered_witness_recovery(self):
        page = self.native_page()
        original = page.client.call.side_effect
        def lose_press(method, params=None, **kwargs):
            if method == "Input.dispatchMouseEvent" and params["type"] == "mousePressed":
                self.assertIsNotNone(page.pointer_guard.read())
                raise TimeoutError("lost press ACK")
            return original(method, params, **kwargs)
        page.client.call.side_effect = lose_press
        with self.assertRaises(TimeoutError):
            page.act(exact_ref(), "click")
        self.assertEqual([event["type"] for event in self.events(page)], ["mouseMoved", "mousePressed"])
        token = page.pointer_guard.read()["token"]
        with patch.object(secrets.tempfile, "gettempdir", return_value=secrets.os.path.dirname(page.pointer_guard.home)):
            reopened = secrets.PointerGuard("owned-instance", "tab-a", time.monotonic() + 22)
        self.assertEqual(reopened.read()["token"], token)
        page.pointer_states.return_value = [{"down": 2, "up": 1, "target": "tab-a", "frame": "frame-a", "loader": "loader-a"}]
        with self.assertRaises(secrets.Refused):
            page.assert_mutations_allowed()
        self.assertEqual(page.pointer_guard.read()["token"], token)
        page.pointer_states.return_value = [{"down": 2, "up": 3, "target": "tab-a", "frame": "frame-a", "loader": "loader-a"}]
        page.assert_mutations_allowed()
        self.assertIsNone(page.pointer_guard.read())
        self.assertEqual([event["type"] for event in self.events(page)], ["mouseMoved", "mousePressed"])


class GlobalPointerGuardTest(unittest.TestCase):
    def test_same_browser_guard_cannot_be_bypassed_by_a_new_target_frame_or_store(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(secrets.tempfile, "gettempdir", return_value=directory):
            first = secrets.PointerGuard("owned-browser", "tab-a", time.monotonic() + 22)
            first.arm("a" * 32, "frame-a", "loader-a")
            second = secrets.PointerGuard("owned-browser", "tab-b", time.monotonic() + 22)
            self.assertEqual(second.path, first.path)
            self.assertEqual(second.read(), {"version": 1, "token": "a" * 32, "target": "tab-a", "frame": "frame-a", "loader": "loader-a"})
            with self.assertRaises(secrets.Refused):
                second.arm("b" * 32, "frame-b", "loader-b")
            second.clear("b" * 32)
            self.assertEqual(first.read()["token"], "a" * 32)
            page = object.__new__(secrets.ExactPage)
            page.target, page.pointer_guard = "tab-b", second
            page.pointer_states = Mock(return_value=[{"down": None, "up": None}])
            with self.assertRaises(secrets.Refused):
                page.assert_mutations_allowed()
            self.assertEqual(first.read()["token"], "a" * 32)

    def test_other_target_trusted_looking_witness_cannot_clear_the_original_owner_guard(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(secrets.tempfile, "gettempdir", return_value=directory):
            original = secrets.PointerGuard("owned-browser", "tab-a", time.monotonic() + 22)
            original.arm("a" * 32, "frame-a", "loader-a")
            page = object.__new__(secrets.ExactPage)
            page.target = "tab-b"
            page.pointer_guard = secrets.PointerGuard("owned-browser", "tab-b", time.monotonic() + 22)
            page.pointer_states = Mock(return_value=[{"down": 2, "up": 3, "target": "tab-a", "frame": "frame-a", "loader": "loader-a"}])
            with self.assertRaises(secrets.Refused):
                page.assert_mutations_allowed()
            self.assertEqual(original.read()["token"], "a" * 32)

    def test_sibling_frame_witness_cannot_clear_the_original_frame_guard(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(secrets.tempfile, "gettempdir", return_value=directory):
            page = object.__new__(secrets.ExactPage)
            page.target = "tab-a"
            page.pointer_guard = secrets.PointerGuard("owned-browser", "tab-a", time.monotonic() + 22)
            page.pointer_guard.arm("a" * 32, "frame-a", "loader-a")
            page.client = Mock()
            page.frames = Mock(return_value=[
                {"id": "frame-a", "loaderId": "loader-a", "session": "origin-session"},
                {"id": "frame-b", "loaderId": "loader-b", "session": "sibling-session"}])
            def witness(client, session, world, function, *values):
                return {"down": 2, "up": 3} if session == "sibling-session" else {"down": None, "up": None}
            with patch.object(secrets, "world_in", return_value=7), patch.object(secrets, "eval_json", return_value=True), \
                    patch.object(secrets, "call_with", side_effect=witness):
                with self.assertRaises(secrets.Refused):
                    page.assert_mutations_allowed()
            self.assertIsNotNone(page.pointer_guard.read())

    def test_same_frame_new_document_witness_cannot_clear_the_old_loader_guard(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(secrets.tempfile, "gettempdir", return_value=directory):
            page = object.__new__(secrets.ExactPage)
            page.target = "tab-a"
            page.pointer_guard = secrets.PointerGuard("owned-browser", "tab-a", time.monotonic() + 22)
            page.pointer_guard.arm("a" * 32, "frame-a", "old-loader")
            page.client = Mock()
            page.frames = Mock(return_value=[{"id": "frame-a", "loaderId": "new-loader", "session": "session"}])
            with patch.object(secrets, "world_in", return_value=7), patch.object(secrets, "eval_json", return_value=True), \
                    patch.object(secrets, "call_with", return_value={"down": 2, "up": 3}):
                with self.assertRaises(secrets.Refused):
                    page.assert_mutations_allowed()
            self.assertEqual(page.pointer_guard.read()["loader"], "old-loader")

    def test_owner_process_exit_at_press_leaves_global_guard_for_the_next_target(self):
        import subprocess
        import sys
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory, "owner-stop.json")
            script = r"""
import json, os
from pathlib import Path
from test_page_secrets import NativeClickTest, exact_ref
case = NativeClickTest()
page = case.native_page(allowed=(True,) * 8)
original = page.client.call.side_effect
def stop(method, params=None, **kwargs):
    result = original(method, params, **kwargs)
    if method == 'Input.dispatchMouseEvent' and params['type'] == 'mousePressed':
        Path(os.environ['OWNED_STOP_MARKER']).write_text(json.dumps({'home':page.pointer_guard.home,
            'state':page.pointer_guard.read(),'events':case.events(page)}))
        os._exit(130)
    return result
page.client.call.side_effect = stop
page.act(exact_ref(), 'click')
"""
            result = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).parent,
                env={"PATH": "/usr/bin:/bin", "TMPDIR": directory, "OWNED_STOP_MARKER": str(marker),
                     "PYTHONDONTWRITEBYTECODE": "1"}, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 130, result.stderr)
            stopped = json.loads(marker.read_text())
            self.assertTrue(Path(stopped["home"]).is_relative_to(directory))
            self.assertEqual([event["type"] for event in stopped["events"]], ["mouseMoved", "mousePressed"])
            with patch.object(secrets.tempfile, "gettempdir", return_value=str(Path(stopped["home"]).parent)):
                reopened = secrets.PointerGuard("owned-instance", "next-tab", time.monotonic() + 22)
            self.assertEqual(reopened.read(), stopped["state"])
            page = object.__new__(secrets.ExactPage)
            page.target, page.pointer_guard = "next-tab", reopened
            page.pointer_states = Mock(return_value=[])
            with self.assertRaises(secrets.Refused):
                page.assert_mutations_allowed()
            self.assertIsNotNone(reopened.read())

    def test_a_separate_browser_instance_does_not_share_the_pending_pointer_state(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(secrets.tempfile, "gettempdir", return_value=directory):
            old = secrets.PointerGuard("owned-old-browser", "tab", time.monotonic() + 22)
            old.arm("a" * 32, "frame", "loader")
            fresh = secrets.PointerGuard("owned-new-browser", "tab", time.monotonic() + 22)
            self.assertNotEqual(old.path, fresh.path)
            self.assertIsNone(fresh.read())
            self.assertIsNotNone(old.read())


class NativeFileInputTest(unittest.TestCase):
    def page(self, *, multiple=False, connected=True, exact=True):
        page = object.__new__(secrets.ExactPage)
        page.target, page.session = "tab-a", "session-a"
        page.assert_mutations_allowed = Mock()
        page.prepare_frame = Mock()
        page.locate = Mock(return_value=("session-a", 7))
        page.client = Mock()

        def call(method, params=None, *, session_id=None, timeout_s=30.0):
            if method == "Runtime.callFunctionOn":
                if params.get("returnByValue") is False:
                    return {"result": {"objectId": "file-input"}}
                return {"result": {"value": {"multiple": multiple, "connected": connected, "exact": exact}}}
            if method == "DOM.setFileInputFiles":
                return {}
            raise AssertionError(method)

        page.client.call.side_effect = call
        return page

    def test_single_file_input_refuses_multiple_files_before_changing_the_selection(self):
        page = self.page()
        with self.assertRaisesRegex(secrets.Refused, "single|multiple|one file"):
            page.upload(exact_ref(), ["/owned/one.txt", "/owned/two.txt"])
        self.assertFalse(any(call.args[0] == "DOM.setFileInputFiles" for call in page.client.call.call_args_list))

    def test_single_and_multiple_inputs_dispatch_only_their_allowed_exact_file_list(self):
        for multiple, files in ((False, ["/owned/one.txt"]), (True, ["/owned/one.txt", "/owned/two.txt"])):
            with self.subTest(multiple=multiple):
                page = self.page(multiple=multiple)
                page.upload(exact_ref(), files)
                writes = [call for call in page.client.call.call_args_list if call.args[0] == "DOM.setFileInputFiles"]
                self.assertEqual(len(writes), 1)
                self.assertEqual(writes[0].args[1], {"objectId": "file-input", "files": files})

    def test_detached_or_replaced_file_inputs_are_refused_before_changing_selection(self):
        for connected, exact in ((False, True), (True, False)):
            with self.subTest(connected=connected, exact=exact):
                page = self.page(connected=connected, exact=exact)
                with self.assertRaises(secrets.Refused):
                    page.upload(exact_ref(), ["/owned/one.txt"])
                self.assertFalse(any(call.args[0] == "DOM.setFileInputFiles" for call in page.client.call.call_args_list))


class SavedLoginDispatchTest(unittest.TestCase):
    def step(self, **overrides):
        return {"kind": "fill", "ref": exact_ref(), "text": "synthetic-password",
                "origin": "https://login.example.test", "field": "password", **overrides}

    def test_unsupported_secret_shapes_are_refused_before_discovery(self):
        for overrides in ({"kind": "pay_token"}, {"field": "card"}, {"field": "unknown"},
                          {"field": None}, {"ref": None}, {"origin": ""}, {"text": None},
                          {"ref": exact_ref(target="other-tab")}):
            with self.subTest(overrides=overrides), patch.object(secrets, "discover_ws_url") as discover:
                with self.assertRaises(secrets.Refused) as raised:
                    secrets.run_step(9222, "tab-a", self.step(**overrides))
                self.assertNotIn("synthetic-password", str(raised.exception))
                discover.assert_not_called()

    def test_login_values_go_only_in_call_arguments_bound_to_the_exact_frame(self):
        for field in ("username", "password"):
            with self.subTest(field=field):
                client = Mock()
                client.call.side_effect = [{"sessionId": "page-session"}, {"result": {"value": True}}]
                secret = "1" if field == "username" else 'synthetic-quote"\\password'
                step = self.step(field=field, text=secret)
                deadline = secrets.time.monotonic() + 5
                with patch.object(secrets, "discover_ws_url", return_value="ws://127.0.0.1:9222/test"), \
                        patch.object(secrets, "CdpClient", return_value=client), \
                        patch.object(secrets, "frame_context", return_value=("frame-session", 17)):
                    secrets.run_step(9222, "tab-a", step, deadline=deadline)
                client.connect.assert_called_once()
                client.close.assert_called_once()
                method, params = client.call.call_args.args
                self.assertEqual(method, "Runtime.callFunctionOn")
                self.assertEqual(client.call.call_args.kwargs, {"session_id": "frame-session"})
                self.assertEqual(params["executionContextId"], 17)
                self.assertEqual(params["arguments"], [{"value": step[key]} for key in ("ref", "text", "origin", "field")])
                self.assertNotIn(secret, params["functionDeclaration"])

    def test_non_refusal_script_errors_are_opaque(self):
        for message in ("Error: synthetic-password", "TypeError: password=synthetic-password"):
            with self.subTest(message=message), self.assertRaisesRegex(RuntimeError, "Page browser evaluation failed") as raised:
                secrets.page_value({"exceptionDetails": {"exception": {"description": message}}})
            self.assertNotIn("synthetic-password", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
