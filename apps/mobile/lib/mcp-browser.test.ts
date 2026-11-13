import { afterEach, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({ open: vi.fn(), dismiss: vi.fn() }));
vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: browser.open,
  dismissAuthSession: browser.dismiss,
}));

import { openMcpBrowser } from "./mcp-browser";

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
it("releases an expired attempt even if the host cannot dismiss its browser", async () => {
  vi.useFakeTimers();
  browser.open.mockReturnValue(new Promise(() => {}));
  browser.dismiss.mockImplementation(() => {
    throw new Error("unsupported");
  });
  const result = openMcpBrowser(
    "https://auth.example.test",
    "coginebot:///mcp",
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(browser.open).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(300000);
  expect(await result).toEqual({ type: "cancel" });
  expect(vi.getTimerCount()).toBe(0);
});
it("aborts an active browser without waiting for a late native return", async () => {
  const controller = new AbortController();
  browser.open.mockReturnValue(new Promise(() => {}));
  const result = openMcpBrowser("https://auth.example.test", "coginebot:///mcp", controller.signal);
  await vi.waitFor(() => expect(browser.open).toHaveBeenCalled());
  controller.abort();
  expect(await result).toEqual({ type: "cancel" });
  expect(browser.dismiss).toHaveBeenCalledTimes(1);
});
it("does not open the browser after its scope was already revoked", async () => {
  const controller = new AbortController();
  controller.abort();
  expect(
    await openMcpBrowser("https://auth.example.test", "coginebot:///mcp", controller.signal),
  ).toEqual({ type: "cancel" });
  expect(browser.open).not.toHaveBeenCalled();
});
