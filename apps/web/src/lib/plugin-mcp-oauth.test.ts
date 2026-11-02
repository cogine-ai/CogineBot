// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authorizePluginMcp } from "./plugin-mcp-oauth";

const required = {
  status: "authorization_required" as const,
  sessionId: "session-one",
  authorizationUrl: "https://auth.example.test/authorize",
};
type Channel = {
  onmessage: ((event: MessageEvent) => void) | null;
  close: ReturnType<typeof vi.fn>;
};
let channels: Channel[];
let closed = false;
function makePopup() {
  return {
    name: "",
    opener: window as Window | null,
    get closed() {
      return closed;
    },
    close: vi.fn(),
    location: { replace: vi.fn() },
  };
}
let popup: ReturnType<typeof makePopup>;
const begin = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  begin.mockReset();
  begin.mockResolvedValue(required);
  closed = false;
  popup = makePopup();
  channels = [];
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      close = vi.fn();
      constructor() {
        channels.push(this);
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
function complete(channel: Channel, sessionId = "session-one") {
  channel.onmessage?.(
    new MessageEvent("message", { data: { type: "mcp-oauth-complete", sessionId } }),
  );
}
it("opens synchronously before a slow begin and navigates the same owned popup after correlation is ready", async () => {
  let release!: (value: typeof required) => void;
  begin.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const result = start();
  expect(window.open).toHaveBeenCalledWith(
    "about:blank",
    expect.stringMatching(/^rakazo-mcp-oauth-pending-/),
    "popup,width=560,height=720",
  );
  expect(vi.mocked(window.open).mock.invocationCallOrder[0]).toBeLessThan(
    begin.mock.invocationCallOrder[0]!,
  );
  expect(channels).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(popup.location.replace).not.toHaveBeenCalled();
  popup.location.replace.mockImplementation(() => {
    expect(channels).toHaveLength(1);
    expect(channels[0]!.onmessage).toBeTypeOf("function");
    expect(popup.opener).toBeNull();
  });
  release(required);
  await Promise.resolve();
  expect(window.open).toHaveBeenCalledOnce();
  expect(popup.name).toBe("rakazo-mcp-oauth-session-one");
  expect(popup.location.replace).toHaveBeenCalledWith(required.authorizationUrl);
  complete(channels[0]!);
  expect(await result).toBe("returned");
});
it("accepts only the exact session and returns a readback hint", async () => {
  let settled = false;
  const result = start().then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  complete(channels[0]!, "other-session");
  await Promise.resolve();
  expect(settled).toBe(false);
  complete(channels[0]!);
  expect(await result).toBe("returned");
  expect(channels[0]!.close).toHaveBeenCalledOnce();
});
it("does not begin authorization when the user-activated popup is blocked or throws", async () => {
  vi.mocked(window.open)
    .mockReturnValueOnce(null)
    .mockImplementationOnce(() => {
      throw new DOMException("blocked", "SecurityError");
    });
  expect(await start()).toBe("pending");
  expect(await start()).toBe("pending");
  expect(begin).not.toHaveBeenCalled();
  expect(channels).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps the correlated channel alive when COOP reports closed before later completion", async () => {
  let settled = false;
  const result = start().then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  closed = true;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(settled).toBe(false);
  expect(channels[0]!.close).not.toHaveBeenCalled();
  complete(channels[0]!);
  expect(await result).toBe("returned");
});
it("closes its blank popup immediately on abort and ignores a late begin reply", async () => {
  let release!: (value: typeof required) => void;
  begin.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const result = start(() => true, controller.signal);
  controller.abort();
  expect(popup.close).toHaveBeenCalledOnce();
  expect(await result).toBe("cancelled");
  release(required);
  await Promise.resolve();
  expect(popup.location.replace).not.toHaveBeenCalled();
  expect(channels).toHaveLength(0);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});
it("does not open an obsolete scope and closes its own popup if the scope later expires", async () => {
  expect(await start(() => false)).toBe("cancelled");
  expect(window.open).not.toHaveBeenCalled();
  let current = true;
  const result = start(() => current);
  await Promise.resolve();
  current = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toBe("cancelled");
  expect(popup.close).toHaveBeenCalledOnce();
  expect(channels[0]!.close).toHaveBeenCalledOnce();
});
it("gives simultaneous sessions separate provisional windows and aborts only its own popup", async () => {
  const firstPopup = makePopup();
  const secondPopup = makePopup();
  vi.mocked(window.open)
    .mockReturnValueOnce(firstPopup as unknown as Window)
    .mockReturnValueOnce(secondPopup as unknown as Window);
  begin.mockResolvedValueOnce(required).mockResolvedValueOnce({
    ...required,
    sessionId: "session-two",
    authorizationUrl: "https://auth.example.test/two",
  });
  const firstAbort = new AbortController();
  const first = start(() => true, firstAbort.signal);
  const second = start();
  const names = vi.mocked(window.open).mock.calls.map((call) => call[1]);
  expect(new Set(names).size).toBe(2);
  await Promise.resolve();
  expect(firstPopup.name).toBe("rakazo-mcp-oauth-session-one");
  expect(secondPopup.name).toBe("rakazo-mcp-oauth-session-two");
  firstAbort.abort();
  expect(await first).toBe("cancelled");
  expect(firstPopup.close).toHaveBeenCalledOnce();
  expect(secondPopup.close).not.toHaveBeenCalled();
  expect(channels[0]!.close).toHaveBeenCalledOnce();
  expect(channels[1]!.close).not.toHaveBeenCalled();
  complete(channels[1]!, "session-two");
  expect(await second).toBe("returned");
  expect(window.open).toHaveBeenCalledTimes(2);
});
it("closes the blank popup and clears listeners when begin fails", async () => {
  begin.mockRejectedValueOnce(new Error("begin failed"));
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  await expect(start(() => true, controller.signal)).rejects.toThrow("begin failed");
  expect(popup.close).toHaveBeenCalledOnce();
  expect(channels).toHaveLength(0);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["already_connected", "authorization_not_requested"] as const)(
  "closes the unused blank popup for %s",
  async (status) => {
    begin.mockResolvedValueOnce({ status });
    expect(await start()).toBe(status);
    expect(popup.close).toHaveBeenCalledOnce();
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(channels).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("keeps a missing completion uncertain until timeout and cleans navigation errors", async () => {
  const timedOut = start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await timedOut).toBe("pending");
  expect(popup.close).toHaveBeenCalledOnce();
  expect(channels[0]!.close).toHaveBeenCalledOnce();
  popup.location.replace.mockImplementationOnce(() => {
    throw new DOMException("navigation blocked", "SecurityError");
  });
  await expect(start()).rejects.toThrow("navigation blocked");
  expect(channels[1]!.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("does not navigate the provider when clearing the opener fails and cleans owned resources", async () => {
  Object.defineProperty(popup, "opener", {
    set() {
      throw new DOMException("opener isolation denied", "SecurityError");
    },
  });
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  await expect(start(() => true, controller.signal)).rejects.toThrow("opener isolation denied");
  expect(popup.location.replace).not.toHaveBeenCalled();
  expect(popup.close).toHaveBeenCalledOnce();
  expect(channels[0]!.close).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});
