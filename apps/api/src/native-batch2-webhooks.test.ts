import type { NativeRoutineEventService } from "@rakazo/adapters";
import { InvalidNativeEventSignal, InvalidNativeSlackSignal } from "@rakazo/adapters";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerNativeEventWebhooks } from "./native-event-webhooks.js";

function fixture() {
  const methods = {
    ingestCalendar: vi.fn(async () => 0),
    ingestNotion: vi.fn(async () => 0),
    ingestDrive: vi.fn(async () => 0),
    ingestGmail: vi.fn(async (_raw: Uint8Array, _authorization: string | null) => 0),
    ingestSlack: vi.fn(
      async (
        _id: string,
        _raw: Uint8Array,
        _sig: string | null,
        _timestamp: string | null,
      ): Promise<{ challenge?: string }> => ({}),
    ),
  };
  const app = new Hono();
  registerNativeEventWebhooks(app, methods as unknown as NativeRoutineEventService);
  return { app, ...methods };
}
describe("native batch two webhook HTTP boundary", () => {
  it("passes exact signed Slack bytes and only echoes a verified challenge", async () => {
    const f = fixture();
    f.ingestSlack.mockResolvedValue({ challenge: "verified-challenge" });
    const raw = '{ "type": "url_verification", "challenge": "verified-challenge" }';
    const response = await f.app.request("/api/connectors/events/slack/hook-a", {
      method: "POST",
      headers: { "x-slack-signature": "v0=synthetic", "x-slack-request-timestamp": "123" },
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "verified-challenge" });
    expect(f.ingestSlack).toHaveBeenCalledWith(
      "hook-a",
      new TextEncoder().encode(raw),
      "v0=synthetic",
      "123",
    );
  });
  it("returns retryable failure until the durable inbox/queue operation completes", async () => {
    const f = fixture();
    f.ingestSlack.mockRejectedValue(new Error("queue commit unavailable"));
    const response = await f.app.request("/api/connectors/events/slack/hook-a", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });
  it("fails invalid Slack proof without echoing its payload", async () => {
    const f = fixture();
    f.ingestSlack.mockRejectedValue(new InvalidNativeSlackSignal());
    const response = await f.app.request("/api/connectors/events/slack/hook-a", {
      method: "POST",
      body: '{"challenge":"unverified"}',
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });
  it("keeps Gmail authorization separate from connector user tokens", async () => {
    const f = fixture(),
      body = JSON.stringify({
        subscription: "projects/p/subscriptions/s",
        message: { data: "e30=" },
      });
    const response = await f.app.request("/api/connectors/events/gmail", {
      method: "POST",
      headers: { authorization: "Bearer pubsub-identity-proof" },
      body,
    });
    expect(response.status).toBe(204);
    expect(f.ingestGmail).toHaveBeenCalledWith(
      new TextEncoder().encode(body),
      "Bearer pubsub-identity-proof",
    );
  });
  it.each(["gmail", "drive"])("rejects invalid %s proof", async (kind) => {
    const f = fixture();
    (kind === "gmail" ? f.ingestGmail : f.ingestDrive).mockRejectedValue(
      new InvalidNativeEventSignal(),
    );
    const response = await f.app.request(`/api/connectors/events/${kind}`, {
      method: "POST",
      ...(kind === "gmail" ? { body: "{}" } : {}),
    });
    expect(response.status).toBe(401);
  });
  it.each([
    { kind: "gmail", size: 65537 },
    { kind: "drive", size: 1 },
    { kind: "slack/hook-a", size: 1_000_001 },
  ])("bounds $kind raw bytes before verification", async (input) => {
    const f = fixture();
    const response = await f.app.request(`/api/connectors/events/${input.kind}`, {
      method: "POST",
      body: "x".repeat(input.size),
    });
    expect(response.status).toBe(413);
    expect(f.ingestGmail).not.toHaveBeenCalled();
    expect(f.ingestDrive).not.toHaveBeenCalled();
    expect(f.ingestSlack).not.toHaveBeenCalled();
  });
});
