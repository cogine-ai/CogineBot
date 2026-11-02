// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authorizePluginMcp } from "./plugin-mcp-oauth";

let channel: { onmessage: ((event: MessageEvent) => void) | null; close: ReturnType<typeof vi.fn> };
let closed = false;
const popup = {
  get closed() {
    return closed;
  },
  close: vi.fn(),
};
const begin = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  closed = false;
  popup.close.mockClear();
  begin.mockResolvedValue({
    status: "authorization_required",
    sessionId: "session-one",
    authorizationUrl: "https://auth.example.test/authorize",
  });
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      close = vi.fn();
      constructor() {
        channel = this;
      }
    },
  );
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function start(isCurrent = () => true, signal = new AbortController().signal) {
  return authorizePluginMcp({ serverId: "server-one", signal, isCurrent, begin });
}
it("accepts only the exact OAuth session and returns a readback hint", async () => {
  let settled = false;
  const result = start().then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  channel.onmessage?.(
    new MessageEvent("message", {
      data: { type: "mcp-oauth-complete", sessionId: "other-session" },
    }),
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  channel.onmessage?.(
    new MessageEvent("message", { data: { type: "mcp-oauth-complete", sessionId: "session-one" } }),
  );
  expect(await result).toBe("returned");
  expect(channel.close).toHaveBeenCalledOnce();
});
it("keeps popup blocking and timeout uncertain without navigating the main tab", async () => {
  vi.mocked(window.open).mockReturnValueOnce(null);
  expect(await start()).toBe("pending");
  const result = start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await result).toBe("pending");
  expect(popup.close).toHaveBeenCalledOnce();
});
it("cancels on popup closure, abort and obsolete scope without accepting late completion", async () => {
  const first = start();
  await Promise.resolve();
  closed = true;
  await vi.advanceTimersByTimeAsync(500);
  expect(await first).toBe("cancelled");
  closed = false;
  const abort = new AbortController();
  const second = start(() => true, abort.signal);
  await Promise.resolve();
  abort.abort();
  expect(await second).toBe("cancelled");
  let current = true;
  const third = start(() => current);
  await Promise.resolve();
  current = false;
  channel.onmessage?.(
    new MessageEvent("message", { data: { type: "mcp-oauth-complete", sessionId: "session-one" } }),
  );
  expect(await third).toBe("cancelled");
});
it("never opens an authorization reply after the captured scope expires", async () => {
  let current = true;
  begin.mockImplementationOnce(async () => {
    current = false;
    return {
      status: "authorization_required",
      sessionId: "session-one",
      authorizationUrl: "https://auth.example.test/authorize",
    };
  });
  expect(await start(() => current)).toBe("cancelled");
  expect(window.open).not.toHaveBeenCalled();
});

it("gives simultaneous sessions separate windows and aborts only its own popup", async () => {
  const firstPopup = { closed: false, close: vi.fn() };
  const secondPopup = { closed: false, close: vi.fn() };
  vi.mocked(window.open)
    .mockReturnValueOnce(firstPopup as unknown as Window)
    .mockReturnValueOnce(secondPopup as unknown as Window);
  begin
    .mockResolvedValueOnce({
      status: "authorization_required",
      sessionId: "session-one",
      authorizationUrl: "https://auth.example.test/one",
    })
    .mockResolvedValueOnce({
      status: "authorization_required",
      sessionId: "session-two",
      authorizationUrl: "https://auth.example.test/two",
    });
  const firstAbort = new AbortController();
  const first = start(() => true, firstAbort.signal);
  await Promise.resolve();
  const second = start();
  await Promise.resolve();
  expect(vi.mocked(window.open).mock.calls.map((call) => call[1])).toEqual([
    "rakazo-mcp-oauth-session-one",
    "rakazo-mcp-oauth-session-two",
  ]);
  firstAbort.abort();
  expect(await first).toBe("cancelled");
  expect(firstPopup.close).toHaveBeenCalledOnce();
  expect(secondPopup.close).not.toHaveBeenCalled();
  channel.onmessage?.(
    new MessageEvent("message", { data: { type: "mcp-oauth-complete", sessionId: "session-two" } }),
  );
  expect(await second).toBe("returned");
});

it("cleans the channel and abort listener when opening a popup throws", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  vi.mocked(window.open).mockImplementationOnce(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  expect(await start(() => true, controller.signal)).toBe("pending");
  expect(channel.close).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});
