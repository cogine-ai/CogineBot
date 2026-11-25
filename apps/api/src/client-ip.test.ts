import * as dns from "node:dns/promises";
import { createClientIpResolver, parseTrustedProxies } from "@rakazo/core/node/trusted-proxy";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createAuditRequestIpReader } from "./client-ip.js";
import { throttleKey, windowCounter } from "./window-counter.js";

vi.mock("node:dns/promises", { spy: true });

describe("shared Page rate limits", () => {
  it("only consults the chain behind an allowed socket peer", async () => {
    const resolve = createClientIpResolver(parseTrustedProxies(" 127.0.0.1, , 10.0.0.0/24 "));
    expect(await resolve({ peer: "203.0.113.4", forwarded: "192.0.2.1" })).toBe("203.0.113.4");
    expect(
      await resolve({
        peer: "::ffff:7f00:1",
        forwarded: "192.0.2.1, 203.0.113.4, 10.0.0.3",
      }),
    ).toBe("203.0.113.4");
    expect(await resolve({ peer: "127.0.0.1", forwarded: "192.0.2.1, malformed" })).toBe(
      "127.0.0.1",
    );
    expect(await resolve({ forwarded: "203.0.113.1" })).toBeUndefined();
    expect(await createClientIpResolver()({ peer: "127.0.0.1", forwarded: "203.0.113.4" })).toBe(
      "127.0.0.1",
    );
    expect(
      await createClientIpResolver(["none"])({
        peer: "127.0.0.1",
        forwarded: "203.0.113.4",
      }),
    ).toBe("127.0.0.1");
  });

  it("refreshes a named proxy's address without accepting an untrusted hop", async () => {
    let clock = 0;
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(["10.0.0.4"])
      .mockResolvedValueOnce(["10.0.0.5"])
      .mockRejectedValueOnce(new Error("synthetic DNS failure"));
    const resolve = createClientIpResolver(["gateway"], { resolve: lookup, now: () => clock });
    const forwarded = "[2001:db8:1:2::3]:123";
    expect(await resolve({ peer: "10.0.0.4", forwarded })).toBe("2001:db8:1:2::3");
    expect(await resolve({ peer: "10.0.0.5", forwarded })).toBe("10.0.0.5");
    expect(await resolve({ peer: "10.0.0.3", forwarded })).toBe("10.0.0.3");
    expect(lookup).toHaveBeenCalledOnce();
    clock += 30_000;
    expect(await resolve({ peer: "10.0.0.5", forwarded })).toBe("2001:db8:1:2::3");
    expect(await resolve({ peer: "10.0.0.4", forwarded })).toBe("10.0.0.4");
    clock += 30_000;
    expect(await resolve({ peer: "10.0.0.5", forwarded })).toBe("10.0.0.5");
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("uses bounded coarse network overflow without resetting active caller windows", () => {
    let clock = 0;
    const count = windowCounter(60_000, () => clock);
    expect(throttleKey("2001:db8:42:5::1")).toBe(throttleKey("2001:db8:0042:5::9"));
    expect(throttleKey("2001:db8:42:5::1")).not.toBe(throttleKey("2001:db8:42:6::1"));
    for (let index = 0; index < 10_000; index++)
      expect(count(throttleKey(`10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`))).toBe(1);
    expect(count(throttleKey("192.0.2.1"))).toBe(1);
    expect(count(throttleKey("192.0.2.2"))).toBe(2);
    expect(count(throttleKey("192.0.3.2"))).toBe(1);
    expect(count(throttleKey("2001:db8:42:5::1"))).toBe(1);
    expect(count(throttleKey("2001:db8:42:6::1"))).toBe(2);
    for (let index = 0; index < 10_000; index++)
      expect(count(throttleKey(`2001:db8:${(100 + index).toString(16)}::1`))).toBeLessThanOrEqual(
        5,
      );
    const overflow = count(throttleKey("203.0.113.1"));
    expect(count(throttleKey("198.51.100.1"))).toBe(overflow + 1);
    expect(count(throttleKey("10.0.0.1"))).toBe(2);
    clock += 60_000;
    expect(count(throttleKey("10.0.0.1"))).toBe(1);
  });
});

describe("audit request address", () => {
  const request = (trustedProxies: string[]) => {
    const app = new Hono();
    const bindIp = createAuditRequestIpReader(trustedProxies);
    const socket = { remoteAddress: "198.51.100.22" };
    app.get("/", async (c) => {
      const readIp = bindIp(c);
      // The connected peer can disappear before the committed operation is audited.
      socket.remoteAddress = "";
      return c.json({ ip: (await readIp()) ?? null });
    });
    return app.request(
      "/",
      { headers: { "x-forwarded-for": "203.0.113.19" } },
      { incoming: { socket } },
    );
  };

  it("omits the address when the proxy configuration is invalid", async () => {
    const response = await request(["invalid proxy!"]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ip: null });
  });

  it("retains the original peer while collecting the address after commit", async () => {
    const response = await request([]);
    await expect(response.json()).resolves.toEqual({ ip: "198.51.100.22" });
  });

  it("does not wait for a stalled named-proxy lookup", async () => {
    vi.useFakeTimers();
    const lookup = vi.mocked(dns.lookup).mockImplementationOnce(() => new Promise(() => {}));
    try {
      const response = request(["proxy.example.test"]);
      await vi.advanceTimersByTimeAsync(250);
      expect(lookup).toHaveBeenCalledWith("proxy.example.test", { all: true });
      await expect((await response).json()).resolves.toEqual({ ip: null });
    } finally {
      lookup.mockRestore();
      vi.useRealTimers();
    }
  });
});
