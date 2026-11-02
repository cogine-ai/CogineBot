import dns from "node:dns/promises";
import { describe, expect, it, vi } from "vitest";
import { DEPLOYMENT_TRANSFER_MAX_WIRE_BYTES } from "./deployment-transfer-crypto.js";
import { createDeploymentTransferPeer } from "./deployment-transfer-peer.js";

const origin = "https://peer.example.test";
const publicAddress = { address: "93.184.216.34", family: 4 };

describe("fixed backend transfer transport", () => {
  it("uses only fixed paths, pinned DNS, the real Host and backend-only bearer", async () => {
    const resolveHostname = vi.fn(async () => [publicAddress]);
    const calls: {
      path: string;
      method?: string;
      headers: Headers;
      body?: string | null;
      address: string;
    }[] = [];
    const request: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const address = await dns.lookup(url.hostname);
      calls.push({
        path: url.pathname,
        method: init?.method,
        headers: new Headers(init?.headers),
        body: init?.body as string | undefined,
        address: address.address,
      });
      expect(init?.redirect).toBe("manual");
      return Response.json({ ok: true });
    });
    const peer = createDeploymentTransferPeer({ fetch: request, resolveHostname });
    try {
      await peer.identity(origin);
      await peer.challenge(origin, "L".repeat(43));
      await peer.propose(origin, { fixture: "proposal" });
      await peer.grant(origin, { fixture: "grant" });
      await peer.item(origin, "T".repeat(43), { payload: { value: "synthetic-only" } });
      await peer.status(origin, { fixture: "status" });
      await peer.cancel(origin, { fixture: "cancel" });
      expect(calls.map((c) => c.path)).toEqual(
        ["identity", "challenge", "proposal", "grant", "item", "status", "cancel"].map(
          (p) => `/api/deployment-transfer/v1/${p}`,
        ),
      );
      expect(calls[0]?.method).toBe("GET");
      expect(calls.slice(1).every((c) => c.method === "POST")).toBe(true);
      expect(
        calls.every(
          (c) =>
            c.address === publicAddress.address && c.headers.get("host") === "peer.example.test",
        ),
      ).toBe(true);
      expect(calls[4]?.headers.get("authorization")).toBe(`Bearer ${"T".repeat(43)}`);
      expect(calls.filter((c) => c.headers.has("authorization"))).toHaveLength(1);
      expect(resolveHostname).toHaveBeenCalledTimes(7);
    } finally {
      await peer.close();
    }
  });
  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "100.64.0.1",
    "fd7a:115c:a1e0::1",
    "::ffff:10.0.0.1",
  ])("rejects private/metadata/MagicDNS addresses before any request: %s", async (address) => {
    const request = vi.fn<typeof fetch>();
    const peer = createDeploymentTransferPeer({
      fetch: request,
      resolveHostname: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
    });
    try {
      await expect(peer.identity("https://fixture.ts.net")).rejects.toThrow("peer is unavailable");
      expect(request).not.toHaveBeenCalled();
    } finally {
      await peer.close();
    }
  });
  it("rejects a mixed public/private answer and never follows a credential-bearing redirect", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 307, headers: { location: "https://other.example.test" } }),
    );
    const mixed = createDeploymentTransferPeer({
      fetch: request,
      resolveHostname: async () => [publicAddress, { address: "10.0.0.1", family: 4 }],
    });
    try {
      await expect(mixed.identity(origin)).rejects.toThrow("peer is unavailable");
      expect(request).not.toHaveBeenCalled();
    } finally {
      await mixed.close();
    }
    const peer = createDeploymentTransferPeer({
      fetch: request,
      resolveHostname: async () => [publicAddress],
    });
    try {
      await expect(peer.item(origin, "T".repeat(43), { value: "synthetic-only" })).rejects.toThrow(
        "peer is unavailable",
      );
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await peer.close();
    }
  });
  it.each([
    () => Response.json({ error: "synthetic-secret-echo" }, { status: 400 }),
    () =>
      new Response("synthetic-secret-echo", { headers: { "content-type": "application/json" } }),
    () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    () =>
      new Response(`"${"x".repeat(DEPLOYMENT_TRANSFER_MAX_WIRE_BYTES)}"`, {
        headers: { "content-type": "application/json" },
      }),
  ])("bounds response decoding and never includes a peer error body (%#)", async (response) => {
    const peer = createDeploymentTransferPeer({
      fetch: async () => response(),
      resolveHostname: async () => [publicAddress],
    });
    try {
      const error = await peer.identity(origin).catch((reason: unknown) => reason);
      if (!(error instanceof Error)) throw new Error("Expected a peer refusal");
      expect(error.message).toBe("Deployment transfer peer is unavailable");
      expect(error.cause).toBeUndefined();
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain("synthetic-secret-echo");
    } finally {
      await peer.close();
    }
  });
  it("aborts an uncooperative fetch and closes the same transport once", async () => {
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const request = vi.fn<typeof fetch>(() => {
      started();
      return new Promise(() => {});
    });
    const peer = createDeploymentTransferPeer({
      fetch: request,
      resolveHostname: async () => [publicAddress],
    });
    const caller = new AbortController();
    const pending = peer.identity(origin, caller.signal);
    await active;
    caller.abort();
    await expect(pending).rejects.toThrow("peer is unavailable");
    const closing = peer.close();
    expect(peer.close()).toBe(closing);
    await closing;
    await expect(peer.identity(origin)).rejects.toThrow("peer is unavailable");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed origins, oversized requests and header injection before fetch", async () => {
    const request = vi.fn<typeof fetch>();
    const peer = createDeploymentTransferPeer({
      fetch: request,
      resolveHostname: async () => [publicAddress],
    });
    try {
      for (const value of [
        "http://peer.example.test",
        `${origin}?`,
        `${origin}#`,
        "https://@peer.example.test",
        `${origin}/another`,
      ])
        await expect(peer.identity(value)).rejects.toThrow("peer is unavailable");
      await expect(peer.item(origin, "T\r\nX-Echo: synthetic", {})).rejects.toThrow(
        "peer is unavailable",
      );
      await expect(
        peer.propose(origin, { x: "x".repeat(DEPLOYMENT_TRANSFER_MAX_WIRE_BYTES + 1) }),
      ).rejects.toThrow("peer is unavailable");
      expect(request).not.toHaveBeenCalled();
    } finally {
      await peer.close();
    }
  });
});
