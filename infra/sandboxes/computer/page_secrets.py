"""Exact-node saved-login fills over loopback CDP (stdlib only).

The browser wrapper registers AX backend nodes in an isolated-world map. Login values
are carried only in CDP arguments; no selector or accessible-name fallback is used.
"""

from __future__ import annotations

import base64
import fcntl
import stat
import tempfile
from contextlib import contextmanager
import hashlib
import json
import os
import socket
import struct
import time
from typing import Any
from urllib.parse import urlsplit

WORLD_NAME = "rakazo-page-browser"

# A frame asked for, began or committed a load of another document. Same-document changes, such as
# a new URL fragment, leave the page and its fields in place and are not counted.
NAVIGATION_EVENTS = ("Page.frameRequestedNavigation", "Page.frameStartedNavigating", "Page.frameNavigated")


MAX_FRAME_DEPTH = 4
MAX_FRAME_SESSIONS = 32


def remaining(deadline: float | None, maximum: float) -> float:
    left = maximum if deadline is None else min(maximum, deadline - time.monotonic())
    if left <= 0:
        raise TimeoutError("Page browser deadline exceeded")
    return left


class KeysNotKept(RuntimeError):
    """The action ran, but the page did not retain its intended value."""


class Refused(RuntimeError):
    """The step was declined before anything it does not report was changed."""


def remaining_time(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Page browser deadline exhausted")
    return remaining


def _http_get_json(url: str, timeout: float = 5.0, deadline: float | None = None) -> Any:
    deadline = min(deadline if deadline is not None else float("inf"), time.monotonic() + timeout)
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port:
        raise RuntimeError("Unexpected CDP discovery endpoint")
    with socket.create_connection((parsed.hostname, parsed.port), timeout=remaining_time(deadline)) as sock:
        sock.settimeout(remaining_time(deadline))
        sock.sendall(f"GET {parsed.path} HTTP/1.1\r\nHost: 127.0.0.1:{parsed.port}\r\nConnection: close\r\n\r\n".encode("ascii"))
        data = bytearray()
        while b"\r\n\r\n" not in data:
            sock.settimeout(remaining_time(deadline))
            chunk = sock.recv(4096)
            if not chunk:
                raise RuntimeError("CDP discovery headers closed")
            data.extend(chunk)
            if len(data) > 16_384:
                raise RuntimeError("CDP discovery headers too large")
        headers, _, body = bytes(data).partition(b"\r\n\r\n")
        lines = headers.decode("iso-8859-1").split("\r\n")
        if lines[0].split(" ")[1] != "200":
            raise RuntimeError("CDP discovery request failed")
        fields = dict(line.lower().split(":", 1) for line in lines[1:] if ":" in line)
        if fields.get("transfer-encoding", "").strip() not in ("", "identity"):
            raise RuntimeError("Unsupported CDP discovery transfer encoding")
        length = int(fields["content-length"]) if "content-length" in fields else None
        if length is not None and (length < 0 or length > 1024 * 1024):
            raise RuntimeError("CDP discovery response too large")
        data = bytearray(body)
        while length is None or len(data) < length:
            sock.settimeout(remaining_time(deadline))
            chunk = sock.recv(min(65536, length - len(data)) if length is not None else 65536)
            if not chunk:
                if length is not None and len(data) < length:
                    raise RuntimeError("CDP discovery body closed")
                break
            data.extend(chunk)
            if len(data) > 1024 * 1024:
                raise RuntimeError("CDP discovery response too large")
        return json.loads(bytes(data[:length] if length is not None else data).decode("utf-8"))




def http_get_json(url: str, timeout: float = 5.0, deadline: float | None = None) -> Any:
    try:
        return _http_get_json(url,timeout,deadline)
    except socket.timeout:
        raise TimeoutError("CDP discovery deadline exceeded") from None


def discover_ws_url(port: int, *, deadline: float | None = None) -> str:
    data = http_get_json(f"http://127.0.0.1:{port}/json/version", deadline=deadline)
    ws = data.get("webSocketDebuggerUrl")
    if not isinstance(ws, str) or not ws:
        raise RuntimeError("CDP version endpoint missing webSocketDebuggerUrl")
    parsed = urlsplit(ws)
    if parsed.scheme != "ws" or parsed.hostname != "127.0.0.1" or parsed.port != port:
        raise RuntimeError("Unexpected CDP endpoint")
    return ws


class NavigationState:
    def __init__(self, session_id: str, frame: dict[str, Any]) -> None:
        self.session_id = session_id
        self.frame_id = frame["id"]
        self.loader_id = frame.get("loaderId")
        self.document_url = str(frame.get("url") or "") + str(frame.get("urlFragment") or "")
        self.pending_url: str | None = None
        self.pending_cross_document = False
        self.expected_loader: str | None = None
        self.committed_loaders: set[str] = set()
        self.last_cross_expectation: tuple[str, str | None, int] | None = None
        self.requested = 0
        self.within_document = 0
        self.committed = 0
        self.requested_at = 0.0
        self.committed_at = 0.0
        self.dom_loaded = False

    def mark(self) -> tuple[int, int, int]:
        return (self.requested, self.within_document, self.committed)

    def begin_action(self) -> tuple[int, int, int]:
        # Loader evidence belongs only to the action being marked, not the helper's past work.
        self.committed_loaders.clear()
        return self.mark()

    @property
    def pending(self) -> bool:
        return self.pending_url is not None

    def request(self, url: Any, cross_document: bool) -> None:
        if not self.pending:
            self.requested_at = time.monotonic()
        self.requested += 1
        self.pending_url = url if isinstance(url, str) else ""
        self.pending_cross_document = self.pending_cross_document or cross_document

    def expect_navigation(self, loader_id: str, url: str, mark: tuple[int, int, int]) -> None:
        if loader_id in self.committed_loaders:
            return
        successor = self.last_cross_expectation
        if successor is not None and successor[2] > mark[0]:
            target, expected_loader, _ = successor
            distinct = target != url or (expected_loader is not None and expected_loader != loader_id)
            settled = self.committed != mark[2] and (
                expected_loader == self.loader_id if expected_loader is not None else target == self.document_url
            )
            if distinct and (self.pending or settled):
                # A newer observed expectation survives even after it has committed.
                return
        self.request(url, True)
        self.expected_loader = loader_id

    def event(self, message: dict[str, Any]) -> None:
        if message.get("sessionId") != self.session_id:
            return
        method, params = message.get("method"), message.get("params") or {}
        if method == "Page.frameNavigated":
            frame = params.get("frame") or {}
            if frame.get("id") == self.frame_id:
                previous_loader = self.loader_id
                self.loader_id = frame.get("loaderId")
                self.document_url = str(frame.get("url") or "") + str(frame.get("urlFragment") or "")
                self.committed += 1
                if isinstance(self.loader_id, str):
                    self.committed_loaders.add(self.loader_id)
                self.committed_at = time.monotonic()
                self.dom_loaded = params.get("type") == "BackForwardCacheRestore"
                if (self.expected_loader is None or self.expected_loader == self.loader_id) and (
                    not self.pending_cross_document or self.loader_id != previous_loader or self.dom_loaded
                ):
                    self.pending_url = None
                    self.pending_cross_document = False
                    self.expected_loader = None
        elif params.get("frameId") == self.frame_id:
            if method == "Page.frameRequestedNavigation" and params.get("disposition") == "currentTab":
                target = params.get("url")
                fragment = (isinstance(target, str) and "#" in target and self.document_url
                            and target.split("#", 1)[0] == self.document_url.split("#", 1)[0]
                            and params.get("reason") in ("anchorClick", "scriptInitiated"))
                self.request(target, not fragment)
                if not fragment:
                    self.expected_loader = None
                    self.last_cross_expectation = (self.pending_url or "", None, self.requested)
            elif method == "Page.frameStartedNavigating":
                loader_id = params.get("loaderId")
                same_document = params.get("navigationType") in ("sameDocument", "historySameDocument")
                self.request(params.get("url"), not same_document)
                if not same_document and isinstance(loader_id, str) and loader_id:
                    self.expected_loader = loader_id
                    self.last_cross_expectation = (self.pending_url or "", loader_id, self.requested)
            elif method == "Page.navigatedWithinDocument":
                self.within_document += 1
                self.document_url = str(params.get("url") or "")
                if not self.pending_cross_document and self.pending_url == params.get("url"):
                    self.pending_url = None
                    self.expected_loader = None
            elif (method == "Page.lifecycleEvent" and params.get("loaderId") == self.loader_id
                  and params.get("name") == "DOMContentLoaded"):
                self.dom_loaded = True


class CdpClient:
    def __init__(self, ws_url: str, *, deadline: float | None = None) -> None:
        self.deadline = deadline if deadline is not None else time.monotonic() + 22.0
        self._ws_url = ws_url
        self._sock: socket.socket | None = None
        self._buf = bytearray()
        self._next_id = 1
        self.context_id: int | None = None
        self.navigation: NavigationState | None = None
        self._pending: dict[int, dict[str, Any] | None] = {}
        self._contexts: dict[int, dict[str, Any]] = {}
        # Navigations to another document started or committed in each frame, per CDP session.
        self._navigations: dict[tuple[Any, str], int] = {}
        self._frame_sessions: dict[str, Any] = {}
        self.dialogs: set[str | None] = set()

    def connect(self) -> None:
        parts = urlsplit(self._ws_url)
        if parts.scheme != "ws" or parts.hostname != "127.0.0.1" or not parts.port or parts.username or parts.password:
            raise RuntimeError("Unexpected CDP endpoint")
        try:
            sock = socket.create_connection((parts.hostname, parts.port),timeout=remaining(self.deadline,10.0))
            self._sock = sock
            key = base64.b64encode(os.urandom(16)).decode("ascii")
            sock.settimeout(remaining(self.deadline,10.0))
            sock.sendall((f"GET {parts.path or '/'} HTTP/1.1\r\nHost: {parts.netloc}\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode("ascii"))
            data = b""
            while b"\r\n\r\n" not in data:
                sock.settimeout(remaining(self.deadline,10.0))
                chunk = sock.recv(4096)
                if not chunk:
                    raise RuntimeError("CDP websocket handshake closed")
                data += chunk
                if len(data) > 16384:
                    raise RuntimeError("CDP handshake too large")
            header,_,leftover = data.partition(b"\r\n\r\n")
            status = header.split(b"\r\n",1)[0].split()
            if len(status) < 2 or status[1] != b"101":
                raise RuntimeError("CDP websocket upgrade failed")
            expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest())
            if expected not in header:
                raise RuntimeError("CDP websocket accept mismatch")
            self._buf.extend(leftover)
        except socket.timeout:
            self.close()
            raise TimeoutError("CDP websocket handshake deadline exceeded") from None
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def _send(self, opcode: int, payload: bytes) -> None:
        assert self._sock is not None
        mask = os.urandom(4)
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", n))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", n))
        self._sock.settimeout(remaining(self.deadline, 10.0))
        self._sock.sendall(bytes(header) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _need(self, size: int) -> None:
        assert self._sock is not None
        while len(self._buf) < size:
            self._sock.settimeout(remaining(self.deadline, 10.0))
            chunk = self._sock.recv(65536)
            if not chunk:
                raise RuntimeError("CDP websocket closed")
            self._buf.extend(chunk)

    def _read_frame(self) -> bytes:
        while True:
            self._need(2)
            b1, b2 = self._buf[0], self._buf[1]
            opcode, masked, length, offset = b1 & 0x0F, bool(b2 & 0x80), b2 & 0x7F, 2
            if length == 126:
                self._need(4)
                length, offset = struct.unpack("!H", self._buf[2:4])[0], 4
            elif length == 127:
                self._need(10)
                length, offset = struct.unpack("!Q", self._buf[2:10])[0], 10
            # Bounded before the payload is read: these steps never ask for anything large.
            if length > 2 * 1024 * 1024:
                raise RuntimeError("CDP frame too large")
            if not (b1 & 0x80):
                raise RuntimeError("Fragmented CDP message unsupported")
            mask = b""
            if masked:
                self._need(offset + 4)
                mask = bytes(self._buf[offset:offset + 4])
                offset += 4
            self._need(offset + length)
            payload = bytes(self._buf[offset:offset + length])
            del self._buf[:offset + length]
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                raise RuntimeError("CDP websocket closed by peer")
            if opcode == 0x9:
                self._send(0xA, payload)
                continue
            if opcode in (0x0, 0x1, 0x2):
                return payload

    def _handle_event(self, message: dict[str, Any]) -> None:
        if self.navigation is not None:
            self.navigation.event(message)
        method = message.get("method")
        params = message.get("params") or {}
        session_id = message.get("sessionId")
        if method == "Page.javascriptDialogOpening":
            self.dialogs.add(session_id)
        elif method == "Page.javascriptDialogClosed":
            self.dialogs.discard(session_id)
        elif method == "Runtime.executionContextCreated":
            context = params.get("context")
            if isinstance(context, dict) and isinstance(context.get("id"), int):
                self._contexts[context["id"]] = {**context, "_sessionId": session_id}
        elif method == "Runtime.executionContextDestroyed":
            self._contexts.pop(params.get("executionContextId"), None)
        elif method == "Runtime.executionContextsCleared":
            self._contexts = {cid: ctx for cid, ctx in self._contexts.items() if ctx.get("_sessionId") != session_id}
        elif method in NAVIGATION_EVENTS:
            frame_id = params.get("frameId") or (params.get("frame") or {}).get("id")
            if not isinstance(frame_id, str) or params.get("disposition", "currentTab") != "currentTab":
                return
            if params.get("navigationType") in ("sameDocument", "historySameDocument"):
                return
            self._navigations[(session_id, frame_id)] = self._navigations.get((session_id, frame_id), 0) + 1
        elif method == "Target.attachedToTarget":
            child = params.get("sessionId")
            if isinstance(child, str) and (params.get("targetInfo") or {}).get("type") == "iframe":
                self._frame_sessions[child] = session_id
        elif method == "Target.detachedFromTarget":
            self._frame_sessions.pop(params.get("sessionId"), None)

    def frame_sessions(self, parent_session_id: str) -> list[str]:
        return [child for child, parent in self._frame_sessions.items() if parent == parent_session_id]

    def navigations(self, session_id: str, frame_id: str) -> int:
        return self._navigations.get((session_id, frame_id), 0)

    def find_world_context(self, world_name: str, frame_id: str, session_id: str) -> int | None:
        for context_id, context in self._contexts.items():
            aux = context.get("auxData") or {}
            if (context.get("name") == world_name and context.get("_sessionId") == session_id
                    and isinstance(aux, dict) and aux.get("frameId") == frame_id and aux.get("isDefault") is False):
                return context_id
        return None

    def call(self, method: str, params: dict[str, Any] | None = None, *, session_id: str | None = None,
             timeout_s: float = 30.0) -> dict[str, Any]:
        assert self._sock is not None
        previous = self.deadline
        deadline = min(previous,time.monotonic() + timeout_s)
        remaining(deadline,timeout_s)
        self.deadline = deadline
        msg_id = self._next_id
        self._next_id += 1
        payload: dict[str, Any] = {"id":msg_id,"method":method,"params":params or {}}
        if session_id:
            payload["sessionId"] = session_id
        self._pending[msg_id] = None
        try:
            self._send(0x1,json.dumps(payload).encode("utf-8"))
            while time.monotonic() < deadline:
                pending = self._pending.get(msg_id)
                if pending is not None:
                    if "error" in pending:
                        raise RuntimeError(f"{method} failed")
                    result = pending.get("result")
                    return result if isinstance(result,dict) else {}
                self._sock.settimeout(remaining(deadline,timeout_s))
                try:
                    message = json.loads(self._read_frame().decode("utf-8"))
                except socket.timeout:
                    continue
                if not isinstance(message,dict):
                    continue
                if message.get("id") in self._pending:
                    self._pending[int(message["id"])] = message
                elif message.get("method"):
                    self._handle_event(message)
            raise TimeoutError(f"CDP call timed out: {method}")
        except socket.timeout:
            raise TimeoutError(f"CDP call timed out: {method}") from None
        finally:
            self._pending.pop(msg_id,None)
            self.deadline = previous

    def pump_until(self, predicate: Any, deadline: float) -> bool:
        assert self._sock is not None
        previous = self.deadline
        self.deadline = min(previous, deadline)
        try:
            while not predicate() and time.monotonic() < self.deadline:
                try:
                    message = json.loads(self._read_frame().decode("utf-8"))
                except (socket.timeout, TimeoutError):
                    continue
                if isinstance(message, dict):
                    if message.get("id") in self._pending:
                        self._pending[int(message["id"])] = message
                    elif message.get("method"):
                        self._handle_event(message)
            return bool(predicate())
        finally:
            self.deadline = previous


def follow_navigation(client: CdpClient, navigation: NavigationState,
                      mark: tuple[int, int, int], deadline: float) -> bool:
    """Follow the selected document without redispatching its action. Return timeout only."""
    client.pump_until(lambda: navigation.pending_cross_document or navigation.committed != mark[2],
                      min(deadline, time.monotonic() + 0.35))
    dom_deadline = None
    while True:
        if navigation.pending:
            commit_deadline = min(deadline, navigation.requested_at + 5.0)
            if dom_deadline is not None:
                commit_deadline = min(commit_deadline, dom_deadline)
            if not client.pump_until(lambda: not navigation.pending, commit_deadline):
                return True
        if navigation.committed != mark[2]:
            if dom_deadline is None:
                dom_deadline = min(deadline, navigation.committed_at + 10.0)
            if navigation.dom_loaded:
                return False
            if not client.pump_until(lambda: navigation.pending or navigation.dom_loaded, dom_deadline):
                return True
            if navigation.pending:
                continue
            return False
        return time.monotonic() >= deadline




POINTER_OBSERVER = r"""
(() => {
  if (window.__rakazoPointerObserver?.version === 2) return true;
  const tokens = new Map();
  const track = event => {
    if (!event.isTrusted) return;
    const stamp = performance.timeOrigin + performance.now();
    for (const state of tokens.values()) {
      if ((event.type === 'pointerdown' || event.type === 'mousedown') && (event.buttons & 1)) {
        state.down = stamp; state.up = null;
      } else if ((event.type === 'pointerup' || event.type === 'mouseup') && event.button === 0 && event.buttons === 0) state.up = stamp;
    }
  };
  for (const name of ['pointerdown','mousedown','pointerup','mouseup']) addEventListener(name,track,true);
  window.__rakazoPointerObserver = {version:2,
    arm(token) { if (!tokens.has(token)) { tokens.clear(); tokens.set(token,{down:null,up:null}); } return tokens.get(token); },
    read(token) { return tokens.get(token) || {down:null,up:null}; }};
  return true;
})()
"""


class PointerGuard:
    """A possible press survives this helper process; a new Run is not recovery evidence."""
    def __init__(self, instance: str, target: str, deadline: float) -> None:
        self.deadline = deadline
        self.target = target
        self.home = os.path.join(tempfile.gettempdir(),f"rakazo-ab-{os.getuid()}")
        os.makedirs(self.home,mode=0o700,exist_ok=True)
        info = os.lstat(self.home)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("The browser pointer guard folder is not private")
        key = hashlib.sha256(instance.encode()).hexdigest()
        self.path = os.path.join(self.home,'pointer-' + key + '.json')
        self.lock = self.path + '.lock'

    @contextmanager
    def locked(self):
        fd = os.open(self.lock,os.O_CREAT | os.O_RDWR | getattr(os,'O_NOFOLLOW',0),0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise RuntimeError("Invalid browser pointer lock")
            while True:
                try:
                    fcntl.flock(fd,fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    time.sleep(min(0.01,remaining(self.deadline,0.01)))
            yield
        finally:
            os.close(fd)

    def _read(self) -> dict[str, Any] | None:
        try:
            fd = os.open(self.path,os.O_RDONLY | getattr(os,'O_NOFOLLOW',0))
        except FileNotFoundError:
            return None
        with os.fdopen(fd,'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                raise Refused("Browser pointer state requires takeover inspection.")
            raw = stream.read(4097)
        try:
            row = json.loads(raw)
            token = row['token']
            if (len(raw) > 4096 or row.get('version') != 1 or not isinstance(token,str)
                    or len(token) != 32 or any(c not in '0123456789abcdef' for c in token)
                    or any(not isinstance(row.get(key),str) or not row[key] for key in ('target','frame','loader'))):
                raise ValueError()
            return row
        except (ValueError,KeyError,TypeError):
            raise Refused("Browser pointer state requires takeover inspection.") from None

    def read(self) -> dict[str, Any] | None:
        with self.locked():
            return self._read()

    def arm(self, token: str, frame_id: str, loader_id: str) -> None:
        with self.locked():
            if self._read() is not None:
                raise Refused("Browser pointer state requires takeover inspection.")
            fd,tmp = tempfile.mkstemp(prefix='.pointer-',dir=self.home)
            try:
                with os.fdopen(fd,'w') as stream:
                    json.dump({'version':1,'token':token,'target':self.target,'frame':frame_id,'loader':loader_id},stream)
                    stream.flush(); os.fsync(stream.fileno())
                os.link(tmp,self.path)
            finally:
                os.unlink(tmp)

    def clear(self, token: str) -> None:
        with self.locked():
            row = self._read()
            if row is not None and row['token'] == token:
                os.unlink(self.path)


EVAL_HELPERS = r"""
(() => {
  if (window.__rakazoPageBrowserExact?.version === 2) return true;
  const refs = new Map();
  let seen = new WeakSet();
  const loginFilled = new WeakSet();
  const secrets = new Set();
  const refused = message => new Error(`Refused: ${message}`);
  const parent = el => el.parentElement || el.getRootNode()?.host || null;
  function transparentInput(el, info) {
    return info.ax === true && el instanceof HTMLInputElement
      && ['text','email','tel','url','search','number'].includes(el.type)
      && !el.disabled && !el.readOnly && el.getAttribute('aria-hidden') !== 'true';
  }
  function fileInput(el) {
    return el instanceof HTMLInputElement && el.type === 'file' && !el.disabled
      && el.getAttribute('aria-disabled') !== 'true';
  }
  function visible(el, allowTransparent = false, allowFile = false) {
    if (!(el instanceof Element) || !el.isConnected || el.ownerDocument !== document) return false;
    for (let at = el; at; at = parent(at)) {
      const style = getComputedStyle(at);
      if (style.display === 'none' || style.visibility !== 'visible' || (!allowFile && at.getAttribute('aria-hidden') === 'true')
          || (Number(style.opacity) === 0 && !(allowTransparent && at === el))) return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function resolve(ref, allowTransparent = false, allowFile = false) {
    const item = refs.get(ref);
    if (!item || !visible(item.el,allowTransparent && transparentInput(item.el,item.info),allowFile && fileInput(item.el))) throw refused('Stale element ref. Take a fresh snapshot.');
    return item.el;
  }
  function editable(el) {
    if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true')
      throw refused('Element is not writable.');
  }
  function hit(el) {
    const rect = el.getBoundingClientRect();
    let top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    while (top?.shadowRoot?.elementFromPoint) {
      const inner = top.shadowRoot.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!inner || inner === top) break;
      top = inner;
    }
    for (let at = top; at; at = parent(at)) if (at === el) return true;
    return false;
  }
  function prepare(ref, allowTransparent = false) {
    const item = refs.get(ref);
    const transparent = allowTransparent && item && transparentInput(item.el,item.info)
      && Number(getComputedStyle(item.el).opacity) === 0;
    const el = resolve(ref,transparent);
    editable(el);
    el.scrollIntoView({block:'center', inline:'center'});
    if (!visible(el,transparent) || (!transparent && !hit(el))) throw refused('Element is covered, so the action would not reach it.');
    return el;
  }
  function setter(el, value) {
    const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype
      : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : null;
    if (prototype) Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
    else if (el.isContentEditable) el.textContent = value;
    else throw refused('Element does not accept text.');
  }
  function choicesValue(el) { return String(el.value); }
  function valueOf(el) { return el.isContentEditable ? el.textContent : el.value; }
  function changed(el) {
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  }
  function keepSecret(el, value) {
    loginFilled.add(el);
    if (value) secrets.add(String(value));
  }
  function allElements(root = document) {
    const result = [];
    for (const el of root.querySelectorAll('*')) {
      result.push(el);
      if (el.shadowRoot) result.push(...allElements(el.shadowRoot));
    }
    return result;
  }
  window.__rakazoPageBrowserExact = {
    version: 2,
    reset() { refs.clear(); seen = new WeakSet(); },
    bind(ref, el, info = {}) {
      if (!visible(el,transparentInput(el,info),fileInput(el))) throw refused('Element is no longer visible.');
      refs.set(ref, {el, info});
      seen.add(el);
      return true;
    },
    resolve,
    resolveForTyping(ref) {
      const el = resolve(ref,true);
      editable(el);
      return el;
    },
    holdsLogin(el) { return loginFilled.has(el); },
    state() {
      for (const el of allElements()) {
        if ((el.type === 'password' || loginFilled.has(el)) && el.value) secrets.add(String(el.value));
      }
      return {url:location.href, title:(document.title || '').slice(0,200),
        text:(document.body?.innerText || '').slice(0,200000), masked:[...secrets]};
    },
    describe(ref) {
      const el = resolve(ref,true,true), item = refs.get(ref), info = item.info;
      const out = {ref, role:String(info.role || el.getAttribute('role') || el.tagName.toLowerCase()),
        name:String(info.name || '').slice(0,200), tag:el.tagName.toLowerCase()};
      if (fileInput(el)) { out.role = 'file upload'; out.multiple = el.multiple; }
      if (el.type !== 'password' && !loginFilled.has(el) && 'value' in el && el.value !== '')
        out.value = String(el.value).slice(0,2000);
      if (['checkbox','radio'].includes(el.type)) out.value = el.checked ? 'checked' : 'unchecked';
      else if (info.checked !== undefined) out.value = info.checked ? 'checked' : 'unchecked';
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.disabled = true;
      if (el instanceof HTMLSelectElement) {
        // These records stay in this isolated world. Re-describing a control must not
        // refresh the evidence behind a previously published option reference.
        const tokens = refs.optionTokens ||= new Map();
        const records = item.options ||= new WeakMap();
        for (const [token, record] of tokens)
          if (refs.get(record.ref) !== record.item) tokens.delete(token);
        const all = [...el.options];
        const shown = all.slice(0,100);
        for (const option of all.filter(o => o.selected)) if (!shown.includes(option)) shown.push(option);
        out.options = shown.map(o => {
          const label = String(o.label), value = String(o.value);
          let record = records.get(o);
          if (!record || record.label !== label || record.value !== value) {
            const token = 'or2.' + Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2,'0')).join('');
            record = {token, ref, item, select:el, document, option:o, label, value};
            records.set(o,record);
            tokens.set(token,record);
          }
          return {label:label.slice(0,2000), value:value.slice(0,2000), optionToken:record.token,
            ...(label.length > 2000 ? {labelTruncated:true} : {}),
            ...(value.length > 2000 ? {valueTruncated:true} : {}),
            ...(o.selected ? {selected:true} : {}),
            ...((o.disabled || (o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled)) ? {disabled:true} : {})};
        });
        if (all.length > shown.length) out.optionsTotal = all.length;
      }
      return out;
    },
    act(ref, kind, value) {
      const el = prepare(ref,kind === 'focus');
      if (kind === 'focus') {
        el.focus();
        if (resolve(ref,true) !== el) throw refused('The field changed while taking focus.');
        return true;
      }
      if (kind === 'click') throw refused('Native mouse dispatch is required.');
      if (kind !== 'fill') throw refused('Unsupported exact element action.');
      let selectedRecord;
      if (el instanceof HTMLSelectElement) {
        const options = [...el.options];
        const text = String(value), record = refs.optionTokens?.get(text);
        let choices;
        if (record || /^or2\.[a-f0-9]{32}$/.test(text)) {
          if (!record || record.ref !== ref || refs.get(ref) !== record.item
              || record.select !== el || record.document !== document
              || !record.option.isConnected || record.option.ownerDocument !== document
              || record.option.closest('select') !== el || !options.includes(record.option)
              || String(record.option.label) !== record.label || String(record.option.value) !== record.value)
            throw refused('Stale option ref. Take a fresh snapshot.');
          selectedRecord = record;
          choices = [record.option];
        } else {
          choices = options.filter(o => o.value === text);
          if (!choices.length) choices = options.filter(o => o.label === text);
        }
        if (choices.length !== 1 || choices[0].disabled
            || (choices[0].parentElement instanceof HTMLOptGroupElement && choices[0].parentElement.disabled)) throw refused('No unique enabled option matched.');
        if (selectedRecord) {
          // Setting select.value can choose a different option with the same value.
          const setSelected = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'selected').set;
          for (const option of options) setSelected.call(option,false);
          setSelected.call(selectedRecord.option,true);
        } else setter(el, choices[0].value);
      } else {
        if (el instanceof HTMLInputElement && !['text','search','email','url','tel','password','number'].includes(el.type))
          throw refused('This input requires desktop tools.');
        setter(el, String(value));
      }
      const wanted = el instanceof HTMLSelectElement ? choicesValue(el) : String(value);
      if (String(valueOf(el)) !== wanted)
        throw new Error('NotKept: The input did not accept every character.');
      changed(el);
      if (!el.isConnected || String(valueOf(el)) !== wanted)
        throw new Error('NotKept: The page did not keep every character typed.');
      if (selectedRecord && (!selectedRecord.option.isConnected
          || el.ownerDocument !== document || selectedRecord.option.ownerDocument !== document
          || selectedRecord.option.closest('select') !== el || !selectedRecord.option.selected
          || el.selectedOptions.length !== 1 || el.selectedOptions[0] !== selectedRecord.option
          || String(selectedRecord.option.label) !== selectedRecord.label
          || String(selectedRecord.option.value) !== selectedRecord.value))
        throw new Error('NotKept: The page did not keep the selected option.');
      return true;
    },
    fill(ref, value, origin, field) {
      if (!['username','password'].includes(field)) throw refused('Unsupported saved login field.');
      let saved;
      try { saved = new URL(origin); } catch { throw refused('Invalid saved login origin.'); }
      if (saved.protocol !== 'https:' || location.protocol !== 'https:' || !isSecureContext || self.origin !== location.origin)
        throw refused('Website logins require a secure, same-site frame.');
      if (saved.origin !== location.origin) throw refused('The field is not on the saved login site.');
      const el = resolve(ref);
      editable(el);
      if (!(el instanceof HTMLInputElement)
          || (field === 'password' ? el.type !== 'password' : !['text','email','tel'].includes(el.type)))
        throw refused('The saved login does not match this field type.');
      const wanted = String(value);
      setter(el, wanted);
      if (el.value !== wanted) {
        setter(el, '');
        throw refused('The field did not accept the saved login and was cleared.');
      }
      keepSecret(el, wanted);
      changed(el);
      if (!el.isConnected || el.value !== wanted) {
        if (el.value) secrets.add(String(el.value));
        throw new Error('NotKept: The page did not keep the saved login.');
      }
      return true;
    },
    cursor(target, frame, loader, limit = 160) {
      const out = [];
      const maximum = Math.max(0,Math.min(160,Number.isFinite(limit) ? Math.floor(limit) : 0));
      const roles = new Set(['button','link','textbox','checkbox','radio','combobox','listbox','menuitem',
        'menuitemcheckbox','menuitemradio','option','searchbox','slider','spinbutton','switch','tab','treeitem']);
      const tags = new Set(['a','button','input','select','textarea','details','summary']);
      for (const el of allElements()) {
        if (out.length >= maximum) break;
        const file = fileInput(el);
        if (seen.has(el) || !visible(el,false,file) || (!file && el.closest('[hidden],[aria-hidden="true"]'))) continue;
        const role = el.getAttribute('role');
        if (!file && (tags.has(el.tagName.toLowerCase()) || roles.has(role))) continue;
        const style = getComputedStyle(el);
        const pointer = style.cursor === 'pointer', click = el.hasAttribute('onclick') || el.onclick !== null;
        const tab = el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1';
        if (!file && !pointer && !click && !tab && !el.isContentEditable) continue;
        if (!file && pointer && !click && !tab && !el.isContentEditable
            && el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue;
        const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2,'0')).join('');
        const ref = 'r2.' + btoa(JSON.stringify([target,frame,loader,token])).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
        const info = {role:file ? 'file upload' : el.isContentEditable ? 'textbox' : click || pointer ? 'button' : role || 'generic',
          name:String(el.getAttribute('aria-label') || Array.from(el.labels || [], label => label.textContent).join(' ') || el.textContent || '').trim().slice(0,200)};
        const input = el.querySelector('input[type="radio"],input[type="checkbox"]');
        if (input && (input.hidden || getComputedStyle(input).display === 'none' || getComputedStyle(input).visibility === 'hidden')) {
          info.role = input.type;
          info.checked = input.checked;
        }
        this.bind(ref,el,info);
        out.push(this.describe(ref));
      }
      return out;
    },
    clickNode(ref) { return prepare(ref); },
    clickContains(ref, hit) {
      const el = resolve(ref);
      for (let at = hit; at; at = parent(at)) if (at === el) return true;
      return false;
    },
    file(ref) {
      const el = resolve(ref,false,true);
      editable(el);
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') throw refused('The target is not a file input.');
      return el;
    }
  };
  return true;
})()
"""


def page_value(result: dict[str, Any]) -> Any:
    if result.get("exceptionDetails"):
        details = result["exceptionDetails"]
        description = str((details.get("exception") or {}).get("description") or "").split("\n")[0]
        message = description.removeprefix("Error: ")
        if message.startswith("NotKept: "):
            raise KeysNotKept(message.removeprefix("NotKept: "))
        if message.startswith("Refused: "):
            raise Refused(message.removeprefix("Refused: "))
        raise RuntimeError("Page browser evaluation failed")
    return (result.get("result") or {}).get("value")


def eval_json(client: CdpClient, session_id: str, expression: str, context_id: int | None = None) -> Any:
    return page_value(client.call("Runtime.evaluate", {
        "expression": expression, "contextId": client.context_id if context_id is None else context_id,
        "returnByValue": True, "awaitPromise": True,
    }, session_id=session_id))


def type_character(client: CdpClient, session_id: str, char: str) -> None:
    """The engine's key/insert-text semantics on the existing CDP connection."""
    if char == '\n' or char.isascii() and char.isalnum():
        key = 'Enter' if char == '\n' else char
        code = 'Enter' if char == '\n' else ('Key' + char.upper() if char.isalpha() else 'Digit' + char)
        key_code = 13 if char == '\n' else ord(char.upper())
        common = {'key':key,'code':code,'windowsVirtualKeyCode':key_code,'nativeVirtualKeyCode':key_code}
        if char == '\n':
            common['modifiers'] = 8  # Shift+Enter adds a line instead of submitting a form.
        text = '\r' if char == '\n' else char
        client.call('Input.dispatchKeyEvent',{'type':'keyDown',**common,'text':text,'unmodifiedText':text},session_id=session_id)
        client.call('Input.dispatchKeyEvent',{'type':'keyUp',**common},session_id=session_id)
    else:
        client.call('Input.insertText',{'text':char},session_id=session_id)


def call_with(client: CdpClient, session_id: str, world: int, function: str, *values: Any) -> Any:
    return page_value(client.call("Runtime.callFunctionOn", {
        "functionDeclaration": function, "executionContextId": world,
        "arguments": [{"value": value} for value in values], "returnByValue": True,
    }, session_id=session_id))


def world_in(client: CdpClient, session_id: str, frame_id: str) -> int:
    client.call("Runtime.enable", session_id=session_id)
    world = client.find_world_context(WORLD_NAME, frame_id, session_id)
    if world is None:
        world = client.call("Page.createIsolatedWorld", {"frameId": frame_id, "worldName": WORLD_NAME},
                            session_id=session_id)["executionContextId"]
    eval_json(client, session_id, EVAL_HELPERS, context_id=world)
    return world


def register_node(client: CdpClient, session_id: str, world: int, *, target_id: str,
                  frame_id: str, loader_id: str, backend_node_id: int, info: dict[str, Any] | None = None) -> str:
    if not all(isinstance(value, str) and value for value in (target_id, frame_id, loader_id)):
        raise Refused("The element document identity is unknown.")
    require_document(client, session_id, frame_id, loader_id)
    binding = [target_id, frame_id, loader_id, os.urandom(16).hex()]
    ref = "r2." + base64.urlsafe_b64encode(json.dumps(binding, separators=(",", ":")).encode()).decode().rstrip("=")
    node = client.call("DOM.resolveNode", {"backendNodeId": backend_node_id, "executionContextId": world},
                       session_id=session_id)
    object_id = (node.get("object") or {}).get("objectId")
    if not object_id:
        raise Refused("The element is no longer available.")
    page_value(client.call("Runtime.callFunctionOn", {
        "objectId": object_id,
        "functionDeclaration": "function (ref, info) { return window.__rakazoPageBrowserExact.bind(ref, this, info); }",
        "arguments": [{"value": ref}, {"value": info or {}}], "returnByValue": True,
    }, session_id=session_id))
    require_document(client, session_id, frame_id, loader_id)
    return ref


def require_document(client: CdpClient, session: str, frame_id: str, loader_id: str) -> None:
    stack = [client.call("Page.getFrameTree", session_id=session)["frameTree"]]
    while stack:
        item = stack.pop()
        frame = item["frame"]
        if frame.get("id") == frame_id:
            if frame.get("loaderId") == loader_id:
                return
            break
        stack.extend(item.get("childFrames") or [])
    raise Refused("The element document has changed.")


def ref_binding(ref: Any, target_id: str) -> tuple[str, str]:
    try:
        if not isinstance(ref, str) or not ref.startswith("r2.") or len(ref) > 2048:
            raise ValueError()
        encoded = ref[3:]
        binding = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        if (not isinstance(binding, list) or len(binding) != 4
                or not all(isinstance(value, str) and value for value in binding)
                or binding[0] != target_id or len(binding[3]) != 32):
            raise ValueError()
        return binding[1], binding[2]
    except (ValueError, TypeError, UnicodeError):
        raise Refused("Invalid or stale exact element ref.") from None


def frame_context(client: CdpClient, session_id: str, wanted: str, loader: str) -> tuple[str, int]:
    sessions, seen, candidates = [session_id], set(), []
    while sessions and len(seen) < MAX_FRAME_SESSIONS:
        session = sessions.pop(0)
        if session in seen:
            continue
        seen.add(session)
        client.call("Page.enable",session_id=session)
        client.call("Target.setAutoAttach",{"autoAttach":True,"waitForDebuggerOnStart":False,
            "flatten":True,"filter":[{"type":"iframe"}]},session_id=session)
        tree = client.call("Page.getFrameTree",session_id=session)["frameTree"]
        stack = [(tree,0)]
        while stack:
            item,depth = stack.pop()
            frame = item["frame"]
            if frame.get("id") == wanted:
                if session == session_id and depth == 0:
                    if frame.get("loaderId") != loader:
                        raise Refused("The element document has changed.")
                    return session,world_in(client,session,wanted)
                candidates.append((depth,session,frame.get("loaderId")))
            if depth < MAX_FRAME_DEPTH:
                stack.extend((child,depth+1) for child in item.get("childFrames") or [])
        sessions.extend(client.frame_sessions(session))
    if not candidates:
        raise Refused("The element frame is no longer available.")
    roots = [candidate for candidate in candidates if candidate[0] == 0]
    chosen = roots or candidates
    if len(chosen) != 1:
        raise Refused("The element frame ownership is ambiguous.")
    _,session,current_loader = chosen[0]
    if current_loader != loader:
        raise Refused("The element document has changed.")
    return session,world_in(client,session,wanted)


def run_step(port: int, target_id: str, step: dict[str, Any], *, deadline: float | None = None) -> None:
    if (step.get("kind") != "fill" or step.get("field") not in ("username", "password")
            or not isinstance(step.get("origin"), str) or not step["origin"]
            or not isinstance(step.get("text"), str)):
        raise Refused("A saved login requires an origin, exact ref, and username or password field.")
    frame_id, loader_id = ref_binding(step.get("ref"), target_id)
    client = CdpClient(discover_ws_url(port, deadline=deadline), deadline=deadline)
    try:
        client.connect()
        session = client.call("Target.attachToTarget", {"targetId": target_id, "flatten": True})["sessionId"]
        frame_session, world = frame_context(client, session, frame_id, loader_id)
        call_with(client, frame_session, world, "function (ref, text, origin, field) { "
                  "return window.__rakazoPageBrowserExact.fill(ref, text, origin, field); }",
                  step["ref"], step["text"], step["origin"], step["field"])
    finally:
        client.close()


FRAME_READY = """function () {
  if (!this.isConnected || this.ownerDocument !== document) return false;
  for (let at = this; at; at = at.parentElement || at.getRootNode()?.host) {
    const style = getComputedStyle(at);
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
  }
  this.scrollIntoView({block:'center',inline:'center'});
  const rect = this.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1 || this.clientWidth <= 1 || this.clientHeight <= 1) return false;
  let top = document.elementFromPoint(rect.x + rect.width / 2,rect.y + rect.height / 2);
  while (top?.shadowRoot?.elementFromPoint) {
    const inner = top.shadowRoot.elementFromPoint(rect.x + rect.width / 2,rect.y + rect.height / 2);
    if (!inner || inner === top) break;
    top = inner;
  }
  return top === this || this.contains(top);
}"""


CONTROL_ROLES = frozenset({"button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
    "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider",
    "spinbutton", "treeitem"})


class ExactPage:
    def __init__(self, port: int, target_id: str, *, deadline: float) -> None:
        self.target = target_id
        self.deadline = deadline
        self.client = CdpClient(discover_ws_url(port, deadline=deadline), deadline=deadline)
        self.pointer_guard = PointerGuard(self.client._ws_url,target_id,deadline)
        try:
            self.client.connect()
            self.session = self.client.call("Target.attachToTarget", {
                "targetId": target_id, "flatten": True})["sessionId"]
            root = self.client.call("Page.getFrameTree", session_id=self.session)["frameTree"]["frame"]
            self.navigation = NavigationState(self.session, root)
            self.client.navigation = self.navigation
            self.client.call("Page.enable", session_id=self.session)
            self.client.call("Page.setLifecycleEventsEnabled", {"enabled": True}, session_id=self.session)
        except BaseException:
            self.client.close()
            raise

    def close(self) -> None:
        self.client.close()

    def frames(self, root_session: str | None = None, *, require_complete: bool = False) -> list[dict[str, Any]]:
        pending, seen, found = [root_session or self.session], set(), {}
        while pending and len(seen) < MAX_FRAME_SESSIONS:
            session = pending.pop(0)
            if session in seen:
                continue
            seen.add(session)
            self.client.call("Page.enable", session_id=session)
            self.client.call("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": False,
                "flatten": True, "filter": [{"type": "iframe"}]}, session_id=session)
            tree = self.client.call("Page.getFrameTree", session_id=session)["frameTree"]
            stack = [(tree, 0)]
            while stack:
                item, depth = stack.pop()
                frame = item["frame"]
                if require_complete and any(not isinstance(frame.get(key),str) or not frame[key]
                                            for key in ('id','loaderId')):
                    raise RuntimeError("The browser frame identity is incomplete.")
                if frame.get("id") and frame.get("loaderId"):
                    # An OOPIF's own root session is authoritative over its parent's stub.
                    old = found.get(frame["id"])
                    if old is None or depth == 0:
                        found[frame["id"]] = {**(old or {}), **frame, "session": session, "depth": depth}
                if require_complete and depth >= MAX_FRAME_DEPTH and item.get("childFrames"):
                    raise RuntimeError("The browser frame tree is incomplete.")
                if depth < MAX_FRAME_DEPTH:
                    stack.extend((child, depth + 1) for child in item.get("childFrames") or [])
            pending.extend(self.client.frame_sessions(session))
        if require_complete and any(session not in seen for session in pending):
            raise RuntimeError("The browser frame sessions are incomplete.")
        return list(found.values())

    def pending_document_present(self, pending: dict[str, Any]) -> bool:
        """A failed or bounded inspection never proves that a pressed document is gone."""
        if pending['target'] == self.target:
            frames = self.frames(require_complete=True)
        else:
            targets = self.client.call("Target.getTargets").get("targetInfos")
            if not isinstance(targets,list) or any(not isinstance(item,dict)
                    or not isinstance(item.get('targetId'),str) or not item['targetId'] for item in targets):
                raise RuntimeError("The browser target list is unavailable.")
            if not any(item['targetId'] == pending['target'] for item in targets):
                return False
            session = self.client.call("Target.attachToTarget",{
                "targetId":pending['target'],"flatten":True})['sessionId']
            if not isinstance(session,str) or not session:
                raise RuntimeError("The original browser target could not be inspected.")
            try:
                frames = self.frames(session,require_complete=True)
            finally:
                self.client.call("Target.detachFromTarget",{"sessionId":session})
        return any(frame['id'] == pending['frame'] and frame['loaderId'] == pending['loader'] for frame in frames)

    def pointer_states(self, token: str, *, arm: bool = True) -> list[dict[str, Any]]:
        states = []
        for frame in self.frames():
            session = frame['session']
            world = world_in(self.client,session,frame['id'])
            eval_json(self.client,session,POINTER_OBSERVER,context_id=world)
            state = call_with(self.client,session,world,
                "function (token, arm) { return window.__rakazoPointerObserver[arm ? 'arm' : 'read'](token); }",token,arm)
            if isinstance(state,dict):
                states.append({**state,'target':self.target,'frame':frame['id'],'loader':frame['loaderId']})
        return states

    def assert_mutations_allowed(self) -> None:
        try:
            self._resolve_pending_pointer()
        except Refused:
            raise
        except Exception:
            raise Refused("Browser pointer input is uncertain; its release could not be verified. Request takeover inspection.") from None

    def _resolve_pending_pointer(self) -> None:
        pending = self.pointer_guard.read()
        if pending is None:
            return
        down = []
        if pending['target'] == self.target:
            states = [state for state in self.pointer_states(pending['token'],arm=False)
                      if all(state.get(key) == pending[key] for key in ('target','frame','loader'))]
            down = [state['down'] for state in states if type(state.get('down')) in (int,float)]
            up = [state['up'] for state in states if type(state.get('up')) in (int,float)]
            if down and up and max(up) > max(down):
                self.pointer_guard.clear(pending['token'])
                return
        try:
            present = self.pending_document_present(pending)
        except Exception:
            raise Refused("Browser pointer input is uncertain; its original document could not be verified. Request takeover inspection.") from None
        if present:
            if pending['target'] == self.target and not down:
                states = [state for state in self.pointer_states('recovery:' + pending['token'])
                          if all(state.get(key) == pending[key] for key in ('target','frame','loader'))]
                if any(type(state.get('up')) in (int,float) for state in states):
                    self.pointer_guard.clear(pending['token'])
                    return
            raise Refused("Browser pointer input is uncertain. Request takeover on its original page and release the pointer before continuing.")
        # This token was never armed before the original press. Only a later trusted
        # release in a still-observable document can recover a missing origin.
        states = self.pointer_states('recovery:' + pending['token'])
        if any(type(state.get('up')) in (int,float) for state in states):
            self.pointer_guard.clear(pending['token'])
            return
        raise Refused("The original pointer document has closed. Request takeover, release the pointer on the current page, then continue.")

    def prepare_frame(self, ref: str) -> None:
        frame_id, loader = ref_binding(ref, self.target)
        frames = {frame['id']:frame for frame in self.frames()}
        frame = frames.get(frame_id)
        if frame is None or frame.get('loaderId') != loader:
            raise Refused('The element document has changed.')
        chain, seen = [], set()
        while frame.get('parentId'):
            if frame['id'] in seen or len(chain) >= MAX_FRAME_DEPTH:
                raise Refused('The element frame chain is not available.')
            seen.add(frame['id'])
            parent = frames.get(frame['parentId'])
            if parent is None:
                raise Refused('The element frame parent is not available.')
            chain.append((parent,frame))
            frame = parent
        for parent,child in reversed(chain):
            session = parent['session']
            world = world_in(self.client,session,parent['id'])
            require_document(self.client,session,parent['id'],parent['loaderId'])
            backend = self.client.call('DOM.getFrameOwner',{'frameId':child['id']},session_id=session)['backendNodeId']
            node = self.client.call('DOM.resolveNode',{'backendNodeId':backend,'executionContextId':world},session_id=session)
            result = self.client.call('Runtime.callFunctionOn',{'objectId':node['object']['objectId'],
                'functionDeclaration':FRAME_READY,'returnByValue':True},session_id=session)
            if page_value(result) is not True:
                raise Refused('The element frame is hidden or covered.')

    def locate(self, ref: str) -> tuple[str, int]:
        frame, loader = ref_binding(ref, self.target)
        return frame_context(self.client, self.session, frame, loader)

    def invoke(self, ref: str, function: str, *values: Any) -> Any:
        session, world = self.locate(ref)
        return call_with(self.client, session, world, function, ref, *values)

    def eval_for_ref(self, ref: str, expression: str) -> Any:
        session, world = self.locate(ref)
        return eval_json(self.client, session, expression, context_id=world)

    def snapshot(self) -> dict[str, Any]:
        entries, texts, masked, main = [], [], set(), {}
        for frame in self.frames():
            session, frame_id, loader = frame["session"], frame["id"], frame["loaderId"]
            world = world_in(self.client, session, frame_id)
            require_document(self.client, session, frame_id, loader)
            call_with(self.client, session, world, "function () { window.__rakazoPageBrowserExact.reset(); }")
            state = call_with(self.client, session, world,
                "function () { return window.__rakazoPageBrowserExact.state(); }") or {}
            masked.update(str(value) for value in state.get("masked") or [] if value)
            if frame.get("parentId") is None and session == self.session:
                main = state
            elif state.get("text"):
                texts.append({"url": state.get("url"), "text": state["text"]})
            if len(entries) >= 160:
                require_document(self.client,session,frame_id,loader)
                continue  # The frame text/masks/reset still belong to the whole-page observation.
            available = 160 - len(entries)
            ax = self.client.call("Accessibility.getFullAXTree", {"frameId": frame_id}, session_id=session)
            frame_entries = []
            for node in ax.get("nodes") or []:
                if node.get("ignored"):
                    continue
                role = str((node.get("role") or {}).get("value") or "")
                backend = node.get("backendDOMNodeId")
                if role not in CONTROL_ROLES or not isinstance(backend, int):
                    continue
                info = {"role": role, "name": str((node.get("name") or {}).get("value") or ""), "ax": True}
                try:
                    ref = register_node(self.client, session, world, target_id=self.target,
                        frame_id=frame_id, loader_id=loader, backend_node_id=backend, info=info)
                    item = call_with(self.client, session, world,
                        "function (ref) { return window.__rakazoPageBrowserExact.describe(ref); }", ref)
                except Refused:
                    continue  # Hidden/non-DOM AX controls are not callable targets.
                if isinstance(item, dict):
                    frame_entries.append(item)
                if len(frame_entries) >= available:
                    break
            remaining_controls = available - len(frame_entries)
            if remaining_controls > 0:
                extra = call_with(self.client,session,world,
                    "function (target, frame, loader, limit) { return window.__rakazoPageBrowserExact.cursor(target,frame,loader,limit); }",
                    self.target,frame_id,loader,remaining_controls) or []
                if isinstance(extra,list):
                    frame_entries.extend(item for item in extra[:remaining_controls] if isinstance(item,dict))
            require_document(self.client, session, frame_id, loader)
            if frame_id != self.navigation.frame_id:
                parts = urlsplit(str(frame.get("url") or state.get("url") or ""))
                origin = f"{parts.scheme}://{parts.netloc.rpartition('@')[2]}" if parts.scheme in ("http","https") else "unknown"
                for item in frame_entries:
                    item["frameOrigin"] = origin
            entries.extend(frame_entries)
        return {**main, "elements": entries, "frameText": texts, "masked": list(masked)}

    def click(self, ref: str) -> None:
        self.assert_mutations_allowed()
        self.prepare_frame(ref)
        session,world = self.locate(ref)
        frame,loader = ref_binding(ref,self.target)
        result = self.client.call("Runtime.callFunctionOn",{"executionContextId":world,
            "functionDeclaration":"function (ref) { return window.__rakazoPageBrowserExact.clickNode(ref); }",
            "arguments":[{"value":ref}],"returnByValue":False},session_id=session)
        if result.get("exceptionDetails"):
            page_value(result)
        node = (result.get("result") or {}).get("objectId")
        if not node:
            raise Refused("The click target is no longer available.")
        model = self.client.call("DOM.getBoxModel",{"objectId":node},session_id=session)["model"]
        quad = model.get("content") or []
        if len(quad) != 8 or not all(isinstance(v,(int,float)) for v in quad):
            raise Refused("The click target has no valid bounds.")
        x,y = round(sum(quad[::2])/4),round(sum(quad[1::2])/4)
        def check() -> None:
            self.locate(ref)
            hit = self.client.call("DOM.getNodeForLocation",{"x":round(x),"y":round(y),
                "includeUserAgentShadowDOM":True},session_id=session)
            if hit.get("frameId") != frame or not isinstance(hit.get("backendNodeId"),int):
                raise Refused("The click target is covered or its frame changed.")
            found = self.client.call("DOM.resolveNode",{"backendNodeId":hit["backendNodeId"],
                "executionContextId":world},session_id=session)["object"].get("objectId")
            if not found:
                raise Refused("The click target is no longer available.")
            checked = self.client.call("Runtime.callFunctionOn",{"executionContextId":world,
                "functionDeclaration":"function (ref, hit) { return window.__rakazoPageBrowserExact.clickContains(ref,hit); }",
                "arguments":[{"value":ref},{"objectId":found}],"returnByValue":True},session_id=session)
            if page_value(checked) is not True:
                raise Refused("The click target is covered or has been replaced.")
        entered,pressed,released = False,False,False
        token: str | None = None
        try:
            check()
            entered = True
            self.client.call("Input.dispatchMouseEvent",{"type":"mouseMoved","x":x,"y":y},session_id=session)
            check()
            token = os.urandom(16).hex()
            self.pointer_states(token)
            self.pointer_guard.arm(token,frame,loader)
            check()
            pressed = True
            self.client.call("Input.dispatchMouseEvent",{"type":"mousePressed","x":x,"y":y,
                "button":"left","buttons":1,"clickCount":1},session_id=session)
            check()
            self.client.call("Input.dispatchMouseEvent",{"type":"mouseReleased","x":x,"y":y,
                "button":"left","buttons":0,"clickCount":1},session_id=session)
            released = True
            self.pointer_guard.clear(token)
        except BaseException as exc:
            if token is not None and not pressed:
                self.pointer_guard.clear(token)
            if isinstance(exc,Refused) and entered:
                raise RuntimeError("Native click stopped after pointer input; inspect the current state.") from None
            raise
        # A possibly delivered press is intentionally not repaired with a blind mouseup.
        # Its guard survives this process until a real trusted release is observed.

    def act(self, ref: str, kind: str, value: str | None = None) -> Any:
        self.assert_mutations_allowed()
        if kind == "click":
            info = self.invoke(ref,"function (ref) { return window.__rakazoPageBrowserExact.describe(ref); }")
            if isinstance(info,dict) and info.get("tag") == "select":
                return self.act(ref,"focus")
            return self.click(ref)
        self.prepare_frame(ref)
        return self.invoke(ref, "function (ref, kind, value) { "
            "return window.__rakazoPageBrowserExact.act(ref, kind, value); }", kind, value)

    def login(self, step: dict[str, Any]) -> None:
        self.assert_mutations_allowed()
        if step.get("kind") != "fill" or step.get("field") not in ("username", "password"):
            raise Refused("Unsupported saved login field.")
        if not isinstance(step.get("origin"), str) or not step["origin"] or not isinstance(step.get("text"), str):
            raise Refused("A saved login requires its site and text.")
        self.prepare_frame(step["ref"])
        self.invoke(step["ref"], "function (ref, text, origin, field) { "
            "return window.__rakazoPageBrowserExact.fill(ref, text, origin, field); }",
            step["text"], step["origin"], step["field"])

    def upload(self, ref: str, files: list[str]) -> None:
        self.assert_mutations_allowed()
        self.prepare_frame(ref)
        session, world = self.locate(ref)
        result = self.client.call("Runtime.callFunctionOn", {"executionContextId": world,
            "functionDeclaration": "function (ref) { return window.__rakazoPageBrowserExact.file(ref); }",
            "arguments": [{"value": ref}], "returnByValue": False}, session_id=session)
        if result.get("exceptionDetails"):
            page_value(result)
        object_id = (result.get("result") or {}).get("objectId")
        if not object_id:
            raise Refused("The file input is no longer available.")
        properties = page_value(self.client.call("Runtime.callFunctionOn", {"objectId":object_id,
            "functionDeclaration":"function (ref) { return {multiple:this.multiple,connected:this.isConnected,exact:this === window.__rakazoPageBrowserExact.file(ref)}; }",
            "arguments":[{"value":ref}],"returnByValue":True},session_id=session))
        if not isinstance(properties,dict) or properties.get("connected") is not True or properties.get("exact") is not True:
            raise Refused("The file input has changed.")
        if len(files) > 1 and properties.get("multiple") is not True:
            raise Refused("This file input accepts only one file.")
        self.client.call("DOM.setFileInputFiles", {"objectId": object_id, "files": files}, session_id=session)
