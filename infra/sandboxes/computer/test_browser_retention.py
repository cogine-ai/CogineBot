"""Offline live-process acceptance for generated browser retention commands."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import quote
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import json
import os
import runpy
import signal
import struct
import subprocess
import sys
import time


CdpClient = runpy.run_path("/usr/local/bin/rakazo-page-browser")["CdpClient"]


def wait_for(predicate, description, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.03)
    raise AssertionError(f"timed out: {description}")


def run(commands, key):
    result = subprocess.run(
        ["bash", "-c", commands[key]], text=True, capture_output=True, timeout=90
    )
    assert result.returncode == 0, f"{key}: {result.stderr} {result.stdout}"
    return result.stdout


def read_json(url):
    with urlopen(url, timeout=3) as response:
        return json.load(response)


def browser(port):
    client = CdpClient(read_json(f"http://127.0.0.1:{port}/json/version")["webSocketDebuggerUrl"])
    client.connect()
    return client


def evaluate(port, target, expression):
    client = browser(port)
    try:
        session = client.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        result = client.call("Runtime.evaluate", {"expression": expression, "returnByValue": True}, session_id=session)
        assert "exceptionDetails" not in result, result
        return result.get("result", {}).get("value")
    finally:
        client.close()


def pages(port):
    return read_json(f"http://127.0.0.1:{port}/json/list")


def state(port, target):
    return evaluate(port, target, "({sentinel:window.retentionSentinel,draft:document.querySelector('input')?.value,inputs:window.retentionInputs})")


def pids(predicate):
    result = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            argv = (proc / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        if argv and predicate(argv):
            result.append(int(proc.name))
    return result


def running(pid):
    try:
        return bool(Path(f"/proc/{pid}/cmdline").read_bytes())
    except OSError:
        return False


def browser_pid(profile):
    return int(Path("/tmp/rakazo/browser-pid-" + Path(profile).name.removeprefix("chromium-bot-")).read_text())


def kill_matching(predicate):
    found = pids(predicate)
    assert found, "expected a live process to crash"
    for pid in found:
        os.kill(pid, signal.SIGKILL)
    wait_for(lambda: all(not running(pid) for pid in found), "crashed processes to exit")
    return found


def websocket(port, token):
    client = CdpClient(f"ws://127.0.0.1:{port}/websockify?token={quote(token)}")
    client.connect()
    client._sock.settimeout(3)
    return client


def assert_denied(port, token):
    client = CdpClient(f"ws://127.0.0.1:{port}/websockify?token={quote(token)}")
    try:
        client.connect()
    except (OSError, RuntimeError):
        return
    finally:
        client.close()
    raise AssertionError(f"revoked {token} still connects")


def assert_closed(client):
    try:
        while True:
            client._read_frame()
    except (RuntimeError, ConnectionResetError, BrokenPipeError):
        pass
    finally:
        client.close()


class Rfb:
    def __init__(self, port, token):
        self.client = websocket(port, token)
        self.pending = bytearray()
        assert self.read(12).startswith(b"RFB 003."), "missing RFB server banner"
        self.send(b"RFB 003.008\n")
        count = self.read(1)[0]
        assert count and 1 in self.read(count), "fixture expects RFB None security"
        self.send(b"\1")
        assert self.read(4) == b"\0\0\0\0", "RFB security rejected"
        self.send(b"\1")
        initial = self.read(24)
        self.read(struct.unpack(">I", initial[20:24])[0])
        bytes_per_pixel = initial[4] // 8
        self.send(struct.pack(">BBHi", 2, 0, 1, 0))
        self.send(struct.pack(">BBHHHH", 3, 0, 0, 0, 1, 1))
        while True:
            kind = self.read(1)[0]
            if kind == 0:
                rectangles = struct.unpack(">H", self.read(3)[1:])[0]
                for _ in range(rectangles):
                    _, _, width, height, encoding = struct.unpack(">HHHHi", self.read(12))
                    assert encoding == 0, f"unexpected RFB encoding {encoding}"
                    self.read(width * height * bytes_per_pixel)
                break
            if kind == 3:
                length = struct.unpack(">I", self.read(7)[3:])[0]
                self.read(length)
            else:
                assert kind == 2, f"unexpected RFB server message {kind}"

    def send(self, payload):
        # RFB handshake and key messages fit short binary frames.
        assert len(payload) < 126
        self.client._send_control(2, payload)

    def read(self, size):
        while len(self.pending) < size:
            self.pending.extend(self.client._read_frame())
        result = bytes(self.pending[:size])
        del self.pending[:size]
        return result

    def key(self, value):
        self.send(struct.pack(">BBHI", 4, 1, 0, ord(value)))
        self.send(struct.pack(">BBHI", 4, 0, 0, ord(value)))

    def ping(self):
        self.client._send_control(9, b"peer")
        data = bytes(self.client._buf)
        self.client._buf.clear()
        while b"\x8a\x04peer" not in data:
            chunk = self.client._sock.recv(8192)
            assert chunk, "peer viewer disconnected"
            data += chunk

    def close(self):
        self.client.close()


class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        label = self.path.strip("/")
        self.wfile.write(
            f"<title>{label}</title><input value='draft-{label}' autofocus>"
            f"<script>window.retentionSentinel='{label}';window.retentionInputs=0;"
            "document.querySelector('input').addEventListener('input',()=>window.retentionInputs++);</script>".encode()
        )

    def log_message(self, *_args):
        pass


def control_request(commands, steps=None):
    steps = steps or []
    request = Request(
        "http://127.0.0.1:7070/v1/desktop",
        data=json.dumps({"steps": steps, "observe": False, "display": ":" + commands["displaya"]}).encode(),
        headers={"authorization": "Bearer " + commands["controlToken"], "content-type": "application/json"},
    )
    try:
        with urlopen(request, timeout=1) as response:
            return json.load(response).get("completed") == len(steps)
    except HTTPError as error:
        raise AssertionError(f"control endpoint returned HTTP {error.code}") from error
    except OSError:
        return False


def main():
    commands = json.loads(Path(sys.argv[1]).read_text())
    server = ThreadingHTTPServer(("127.0.0.1", 8090), Page)
    Thread(target=server.serve_forever, daemon=True).start()
    run(commands, "reset")
    for bot in "ab":
        run(commands, "ensure" + bot)
    ports = {bot: int(commands["debug" + bot]) for bot in "ab"}
    targets = {}
    for bot in "ab":
        client = browser(ports[bot])
        try:
            for suffix in ["1", "2"]:
                label = bot + suffix
                target = client.call("Target.createTarget", {"url": f"http://127.0.0.1:8090/{label}"})["targetId"]
                targets[label] = target
                wait_for(lambda: state(ports[bot], target).get("sentinel") == label, "fixture page script")
        finally:
            client.close()
    original_pids = {bot: browser_pid(commands["profile" + bot]) for bot in "ab"}
    expected = {label: state(ports[label[0]], target) for label, target in targets.items()}

    def retained():
        for bot in "ab":
            assert browser_pid(commands["profile" + bot]) == original_pids[bot]
            assert running(original_pids[bot])
            present = {page["id"] for page in pages(ports[bot])}
            assert all(targets[label] in present for label in targets if label.startswith(bot))
        for label, target in targets.items():
            assert state(ports[label[0]], target) == expected[label], label

    run(commands, "grant")
    display = commands["displaya"]
    kill_matching(lambda argv: argv[0].endswith(b"x11vnc") and any(arg.startswith(f"/tmp/rakazo/sockets/control-{display}-".encode()) for arg in argv))
    run(commands, "recover")
    retained()
    # The shared gateway can restart without killing either private browser.
    gateway_arg = f"0.0.0.0:{commands['viewPort']}".encode()
    kill_matching(lambda argv: gateway_arg in argv and b"--token-source=/tmp/rakazo/desktop-targets" in argv)
    run(commands, "recover")
    retained()
    wait_for(lambda: control_request(commands), "initial HTTP control readiness")

    # A file target reaches the same live profile rather than replacing its tabs.
    file = Path("/home/rakazo/retained # %.html")
    file.write_text("<title>Retained file</title><p>offline fixture</p>")
    run(commands, "openfile")
    wait_for(lambda: any(page.get("title") == "Retained file" for page in pages(ports["a"])), "file URL forwarding")
    retained()
    client = browser(ports["a"])
    try:
        client.call("Target.activateTarget", {"targetId": targets["a1"]})
    finally:
        client.close()
    view_port = int(commands["viewPort"])
    control_port = int(commands["controlPort"])
    viewer = Rfb(view_port, "view-a")
    controller = Rfb(control_port, "control-a")
    peer = Rfb(view_port, "view-b")
    run(commands, "focus")
    original_caret = evaluate(ports["a"], targets["a1"], "document.querySelector('input').selectionStart")
    evaluate(ports["a"], targets["a1"], "var input=document.querySelector('input');input.focus();input.setSelectionRange(input.value.length,input.value.length);true")
    assert evaluate(ports["a"], targets["a1"], "document.hasFocus()"), "fixture input is not focused"
    after_key = {**expected["a1"], "draft": expected["a1"]["draft"] + "c", "inputs": expected["a1"]["inputs"] + 1}
    controller.key("c")
    wait_for(lambda: state(ports["a"], targets["a1"]) == after_key, "one control input")
    expected["a1"] = after_key
    viewer.key("v")
    time.sleep(0.2)
    assert state(ports["a"], targets["a1"]) == expected["a1"], "view token accepted input"

    # A completed HTTP action is not replayed when the independently supervised daemon restarts.
    assert control_request(commands, [{"argv": ["env", "DISPLAY=:" + display, "xdotool", "key", "--clearmodifiers", "e"]}])
    after_http = {**expected["a1"], "draft": expected["a1"]["draft"] + "e", "inputs": expected["a1"]["inputs"] + 1}
    wait_for(lambda: state(ports["a"], targets["a1"]) == after_http, "one HTTP control input")
    expected["a1"] = after_http
    control_match = lambda argv: len(argv) > 1 and argv[1] == b"/usr/local/bin/rakazo-computer-control"
    old_daemon = kill_matching(control_match)
    wait_for(lambda: pids(control_match) and all(pid not in old_daemon for pid in pids(control_match)) and control_request(commands), "HTTP control restart", 6)
    assert "restarting in 1 second" in Path("/tmp/rakazo/control.log").read_text()
    retained()

    run(commands, "terminal")
    terminal = websocket(control_port, "terminal-a")
    payload = b"echo $$ >/tmp/retained-terminal.pid\n"
    terminal._send_control(2, bytes([0]) + struct.pack(">I", len(payload)) + payload)
    wait_for(lambda: Path("/tmp/retained-terminal.pid").exists(), "terminal shell input")
    terminal_pid = int(Path("/tmp/retained-terminal.pid").read_text())
    assert running(terminal_pid)
    old_targets = [
        line.split("unix_socket:", 1)[1]
        for mapping in Path("/tmp/rakazo/desktop-targets").glob("*")
        for line in mapping.read_text().splitlines()
        if line.startswith(("view-a: ", "control-a: ", "terminal-a: "))
    ]
    assert len(old_targets) == 3
    run(commands, "retain")
    retained()
    for client in [viewer.client, controller.client, terminal]:
        assert_closed(client)
    wait_for(lambda: not running(terminal_pid), "released terminal shell to exit")
    assert not Path(f"/tmp/rakazo/terminal-state-{display}").exists()
    assert not Path(f"/tmp/rakazo/control-token-{display}").exists()
    assert all(not Path(target).exists() for target in old_targets)
    peer.ping()
    for token in ["view-a", "control-a", "terminal-a"]:
        assert_denied(view_port, token)
    run(commands, "next")
    retained()
    assert not Path(f"/tmp/rakazo/control-token-{display}").exists(), "watch restored released input authority"
    next_viewer = Rfb(view_port, "view-a-next")
    next_viewer.key("v")
    time.sleep(0.2)
    assert state(ports["a"], targets["a1"]) == expected["a1"]
    run(commands, "nextgrant")
    next_controller = Rfb(control_port, "control-a-next")
    after_replacement = {**expected["a1"], "draft": expected["a1"]["draft"] + "d", "inputs": expected["a1"]["inputs"] + 1}
    next_controller.key("d")
    wait_for(lambda: state(ports["a"], targets["a1"]) == after_replacement, "one replacement control input")
    next_controller.close()
    next_viewer.close()
    run(commands, "cancela")
    wait_for(lambda: not running(original_pids["a"]), "cancelled browser to exit")
    assert running(original_pids["b"]), "cancellation killed the peer browser"
    peer.ping()
    for label in ["b1", "b2"]:
        assert state(ports["b"], targets[label]) == expected[label]
    peer.close()
    run(commands, "cancelb")
    print("RETENTION_EVIDENCE " + json.dumps({"managed": commands["managed"] == "true", "retainedTargets": 4, "unchangedBrowserPids": 2, "originalCaret": original_caret, "rfbInputs": 2, "httpInputs": 1, "duplicateInputs": 0, "readonlyInputAttempts": 2, "terminalShellRevoked": True}), flush=True)
    print("PASS: retained browser state, current control recovery, readonly RFB, access and terminal revocation, file forwarding, independent daemon recovery, and isolated cancellation")


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        for pid in pids(lambda argv: argv[0].endswith(b"x11vnc")):
            print(f"DIAGNOSTIC process {pid}: " + Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace"), flush=True)
        for pattern in ["x11vnc-control-*.log", "screen-*-x11vnc.log", "gateway-*.log", "control.log", "desktop-targets/*"]:
            for file in Path("/tmp/rakazo").glob(pattern):
                if file.is_file():
                    print(f"DIAGNOSTIC {file}:\n{file.read_text(errors='replace')[-4000:]}", flush=True)
        raise
