import { NativeActionError } from "@rakazo/adapters";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerNativeEnterpriseWebhooks } from "./native-enterprise-webhooks.js";

describe("enterprise callback HTTP boundary", () => {
  it("passes the exact bounded bytes and signed query to the verifier, returning only the challenge", async () => {
    const accept = vi.fn(async () => ({
      type: "challenge" as const,
      challenge: "synthetic-challenge",
    }));
    const app = new Hono();
    registerNativeEnterpriseWebhooks(app, { accept });
    const response = await app.request(
      "/api/connectors/enterprise/config-fixture?echostr=encrypted&timestamp=123&nonce=fake&msg_signature=signed",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("synthetic-challenge");
    expect(accept.mock.calls[0]?.[0]).toBe("config-fixture");
    const received = accept.mock.calls[0] as unknown as [
      string,
      { rawBody: Uint8Array; query: Record<string, string> },
      AbortSignal,
    ];
    expect(received[1].query).toEqual({
      echostr: "encrypted",
      timestamp: "123",
      nonce: "fake",
      msg_signature: "signed",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("preserves raw encrypted JSON for verification and returns the Feishu challenge envelope", async () => {
    const accept = vi.fn(async () => ({
      type: "challenge" as const,
      challenge: "synthetic-challenge",
    }));
    const app = new Hono();
    registerNativeEnterpriseWebhooks(app, { accept });
    const raw = ' { "encrypt" : "synthetic" }\n';
    const response = await app.request("/api/connectors/enterprise/config-fixture", {
      method: "POST",
      body: raw,
      headers: { "x-lark-signature": "synthetic-signature" },
    });
    expect(await response.json()).toEqual({ challenge: "synthetic-challenge" });
    const args = accept.mock.calls[0] as unknown as [
      string,
      { rawBody: Uint8Array; headers: Record<string, string> },
    ];
    expect(new TextDecoder().decode(args[1].rawBody)).toBe(raw);
    expect(args[1].headers["x-lark-signature"]).toBe("synthetic-signature");
  });
  it("never echoes provider tickets or install codes in its acknowledgement", async () => {
    const accept = vi.fn(async () => ({
      type: "ticket" as const,
      platform: "wecom" as const,
      appId: "suite-fixture",
      ticket: "private-ticket-fixture",
      issuedAt: 123,
      eventId: "receipt-fixture",
    }));
    const app = new Hono();
    registerNativeEnterpriseWebhooks(app, { accept });
    const response = await app.request("/api/connectors/enterprise/config-fixture", {
      method: "POST",
      body: "encrypted-fixture",
    });
    expect(await response.text()).toBe("success");
  });
  it("rejects oversized callbacks before invoking any verifier or credential store", async () => {
    const accept = vi.fn();
    const app = new Hono();
    registerNativeEnterpriseWebhooks(app, { accept });
    const response = await app.request("/api/connectors/enterprise/config-fixture", {
      method: "POST",
      body: "oversize",
      headers: { "content-length": "262145" },
    });
    expect(response.status).toBe(413);
    expect(accept).not.toHaveBeenCalled();
  });
  it.each([
    [new NativeActionError("authorization_required", "secret-marker-must-not-echo"), 401],
    [new Error("secret-marker-must-not-echo"), 503],
  ])("returns a bounded failure for rejected or unavailable callbacks", async (error, status) => {
    const accept = vi.fn(async () => {
      throw error;
    });
    const app = new Hono();
    registerNativeEnterpriseWebhooks(app, { accept });
    const response = await app.request("/api/connectors/enterprise/config-fixture", {
      method: "POST",
      body: "encrypted-fixture",
    });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("secret-marker");
  });
});
