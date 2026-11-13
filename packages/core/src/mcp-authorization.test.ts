import { MCP_NATIVE_REDIRECT_URI } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { authorizeMcp } from "./mcp-authorization.js";

function setup() {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      status: "authorization_required",
      sessionId: "attempt",
      authorizationUrl: "https://auth.example.test/authorize?state=attempt",
    })
    .mockResolvedValue({ ok: true });
  const open = vi.fn().mockResolvedValue({
    type: "success",
    url: `${MCP_NATIVE_REDIRECT_URI}?state=attempt&code=synthetic-code`,
  });
  const controller = new AbortController();
  const current = vi.fn(() => true);
  let time = 0;
  return {
    request,
    open,
    controller,
    current,
    setTime: (value: number) => {
      time = value;
    },
    run: () =>
      authorizeMcp({
        serverId: "server",
        request,
        open,
        signal: controller.signal,
        isCurrent: current,
        now: () => time,
      }),
  };
}
it("binds native authorization to its server and completes once", async () => {
  const x = setup();
  expect(await x.run()).toBe("connected");
  expect(x.request).toHaveBeenNthCalledWith(
    1,
    "mcp/oauth/begin",
    { serverId: "server", redirectUri: MCP_NATIVE_REDIRECT_URI },
    x.controller.signal,
  );
  expect(x.request).toHaveBeenNthCalledWith(
    2,
    "mcp/oauth/complete",
    { sessionId: "attempt", state: "attempt", code: "synthetic-code" },
    x.controller.signal,
  );
});
it.each([
  "coginebot:///mcp?state=other&code=value",
  "coginebot:///mcp?state=attempt&state=attempt&code=value",
  "coginebot:///mcp?state=attempt&code=value&code=other",
  "coginebot:///mcp?state=attempt&error=denied",
  "coginebot:///mcp?state=attempt",
  "coginebot:///other?state=attempt&code=value",
  "https://evil.example.test/mcp?state=attempt&code=value",
  "coginebot://mcp?state=attempt&code=value",
  "coginebot:///mcp?state=attempt&code=value#fragment",
  "invalid",
])("does not exchange an invalid callback: %s", async (url) => {
  const x = setup();
  x.open.mockResolvedValue({ type: "success", url });
  expect(await x.run()).toBe("failed");
  expect(x.request).toHaveBeenCalledTimes(1);
});
it.each(["cancel", "dismiss"])("recovers from browser %s without completing", async (type) => {
  const x = setup();
  x.open.mockResolvedValue({ type });
  expect(await x.run()).toBe("cancelled");
  expect(x.request).toHaveBeenCalledTimes(1);
});
it.each(["already_connected", "authorization_not_requested"])(
  "preserves real %s state without opening a browser",
  async (status) => {
    const x = setup();
    x.request.mockReset().mockResolvedValue({ status });
    expect(await x.run()).toBe(status);
    expect(x.open).not.toHaveBeenCalled();
  },
);
it("rejects expired return without sending the code", async () => {
  const x = setup();
  x.open.mockImplementation(async () => {
    x.setTime(300001);
    return { type: "success", url: `${MCP_NATIVE_REDIRECT_URI}?state=attempt&code=value` };
  });
  expect(await x.run()).toBe("expired");
  expect(x.request).toHaveBeenCalledTimes(1);
});
it.each(["scope", "abort"])("discards late authorization after %s change", async (change) => {
  const x = setup();
  x.open.mockImplementation(async () => {
    if (change === "scope") x.current.mockReturnValue(false);
    else x.controller.abort();
    return { type: "success", url: `${MCP_NATIVE_REDIRECT_URI}?state=attempt&code=value` };
  });
  expect(await x.run()).toBe("cancelled");
  expect(x.request).toHaveBeenCalledTimes(1);
});
it("never replays a code after a lost completion response", async () => {
  const x = setup();
  x.request
    .mockReset()
    .mockResolvedValueOnce({
      status: "authorization_required",
      sessionId: "attempt",
      authorizationUrl: "https://auth.example.test/authorize?state=attempt",
    })
    .mockRejectedValueOnce(new Error("lost"));
  await expect(x.run()).rejects.toThrow("lost");
  expect(x.request.mock.calls.filter(([p]) => p.endsWith("complete"))).toHaveLength(1);
});
