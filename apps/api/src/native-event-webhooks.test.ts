import { createHmac } from "node:crypto";
import type { NativeNotionHookStore } from "@rakazo/adapters";
import {
  calendarChannelTokenHash,
  NativeActionError,
  NativeRoutineEventService,
  verifyNotionSignal,
} from "@rakazo/adapters";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { readNativeEventBytes, registerNativeEventWebhooks } from "./native-event-webhooks.js";

const PAGE = "11111111-1111-4111-8111-111111111111",
  BOT = "22222222-2222-4222-8222-222222222222",
  WORKSPACE = "33333333-3333-4333-8333-333333333333",
  EVENT = "44444444-4444-4444-8444-444444444444";
const HOOK = "synthetic-owner-only-hook",
  TOKEN = "synthetic-hook-verification-token";
const trusted = {
  id: HOOK,
  configId: "config-a",
  revision: 3,
  verified: true,
  integrationId: PAGE,
  subscriptionId: BOT,
  verificationToken: TOKEN,
};
function payload() {
  return {
    id: EVENT,
    timestamp: new Date().toISOString(),
    workspace_id: WORKSPACE,
    subscription_id: BOT,
    integration_id: PAGE,
    type: "page.content_updated",
    accessible_by: [{ id: BOT, type: "bot" }],
    entity: { id: PAGE, type: "page" },
    authors: [{ id: PAGE, type: "person" }],
    data: { private_text: "synthetic body never enters jobs" },
  };
}
function signed() {
  const body = ` \n${JSON.stringify(payload(), null, 2)}\n`,
    signature = `sha256=${createHmac("sha256", TOKEN).update(body).digest("hex")}`;
  return { body, signature };
}
const target = {
  id: "trigger-a",
  version: 2,
  spec: { kind: "notion.page_content_changed", target: { type: "page", pageId: PAGE } },
};
function fixture(rows: unknown[] = [], sendToQueue?: (job: unknown) => Promise<unknown>) {
  const enqueue = vi.fn(async (job: unknown): Promise<void> => {
    await sendToQueue?.(job);
  });
  const query = vi.fn(async (_query: unknown) => rows),
    createTask = vi.fn(),
    createRun = vi.fn(),
    createMessage = vi.fn(),
    append = vi.fn(async () => undefined),
    authorization = vi.fn();
  const prisma = {
    $queryRaw: query,
    task: { create: createTask },
    run: { create: createRun },
    message: { create: createMessage },
  } as unknown as PrismaClient;
  const captured: Uint8Array[] = [];
  // Setup/credential lifecycle has independent PG tests. This fixture exercises the actual runtime signature class and service routing.
  const acceptSigned = vi.fn(async (id: string, raw: Uint8Array, signature: string | null) => {
    captured.push(raw);
    if (id !== HOOK) return undefined;
    return { hook: trusted, event: verifyNotionSignal(raw, signature, trusted) };
  });
  const captureChallenge = vi.fn(async () => false),
    hooks = { acceptSigned, captureChallenge } as unknown as NativeNotionHookStore;
  const service = new NativeRoutineEventService(
    prisma,
    { authorization } as unknown as ConstructorParameters<typeof NativeRoutineEventService>[1],
    hooks,
    { enqueue },
    { append } as unknown as Pick<ThreadEvents, "append">,
    "https://api.example.test",
  );
  const app = new Hono();
  registerNativeEventWebhooks(app, service);
  const noMessages = () => {
    expect(createTask).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(authorization).not.toHaveBeenCalled();
  };
  return { app, query, enqueue, captured, acceptSigned, captureChallenge, noMessages };
}
const send = (f: ReturnType<typeof fixture>, data = signed()) =>
  f.app.request(`/api/connectors/events/notion/${HOOK}`, {
    method: "POST",
    headers: { "x-notion-signature": data.signature },
    body: data.body,
  });
describe("native event HTTP boundary", () => {
  it("preserves actual signed raw bytes and strips author/body before a durable exact Routine signal job", async () => {
    const f = fixture([target]),
      data = signed(),
      response = await send(f, data);
    expect(response.status).toBe(204);
    expect(f.captured[0]).toEqual(new TextEncoder().encode(data.body));
    expect(f.enqueue).toHaveBeenCalledOnce();
    const job = f.enqueue.mock.calls[0]![0] as {
      name: string;
      payload: {
        triggerId: string;
        triggerVersion: number;
        hookId: string;
        hookRevision: number;
        signal: unknown;
      };
    };
    expect(job).toMatchObject({
      name: "native.notion.signal",
      payload: { triggerId: "trigger-a", triggerVersion: 2, hookId: HOOK, hookRevision: 3 },
    });
    expect(JSON.stringify(job)).not.toContain("private_text");
    expect(JSON.stringify(job)).not.toContain("authors");
    expect(JSON.stringify(job)).not.toContain(TOKEN);
    f.noMessages();
    const sql = f.query.mock.calls[0]![0] as { sql: string };
    expect(sql.sql).toContain("r.active=true");
    expect(sql.sql).toContain('c."userId"=r."userId"');
    expect(sql.sql).toContain('c."spaceId"=r."spaceId"');
    expect(sql.sql).toContain('g."authGeneration"=t."authGeneration"');
    expect(sql.sql).toContain("'oauth'");
  });
  it("does not acknowledge before the existing durable queue accepts the signal", async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (entered = r));
    const enqueue = vi.fn(async (_job: unknown) => {
        entered();
        await held;
      }),
      f = fixture([target], enqueue);
    let finished = false;
    const response = Promise.resolve(send(f)).then((r) => {
      finished = true;
      return r;
    });
    await ready;
    expect(finished).toBe(false);
    release();
    expect((await response).status).toBe(204);
    f.noMessages();
  });
  it("maps the actual invalid-signature class to401 without reading resources or enqueueing", async () => {
    const f = fixture([target]),
      data = signed();
    expect((await send(f, { ...data, signature: `sha256=${"0".repeat(64)}` })).status).toBe(401);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    f.noMessages();
  });
  it("returns503 on durable enqueue failure so provider delivery may retry", async () => {
    const f = fixture(
      [target],
      vi.fn(async () => {
        throw new Error("synthetic queue unavailable");
      }),
    );
    expect((await send(f)).status).toBe(503);
    f.noMessages();
  });
  it("zero active exact Routines cause no jobs, messages, Tasks, Runs or generic Bot webhook", async () => {
    const f = fixture();
    expect((await send(f)).status).toBe(204);
    expect(f.query).toHaveBeenCalledOnce();
    expect(f.enqueue).not.toHaveBeenCalled();
    f.noMessages();
  });
  it("a selected different resource cannot consume an otherwise valid signed event", async () => {
    const f = fixture([
      { ...target, spec: { ...target.spec, target: { type: "page", pageId: WORKSPACE } } },
    ]);
    expect((await send(f)).status).toBe(204);
    expect(f.enqueue).not.toHaveBeenCalled();
    f.noMessages();
  });
  it("rejects GET and oversize bodies before challenge/signature/queue processing", async () => {
    const f = fixture([target]);
    expect((await f.app.request(`/api/connectors/events/notion/${HOOK}`)).status).toBe(404);
    expect(
      (
        await f.app.request(`/api/connectors/events/notion/${HOOK}`, {
          method: "POST",
          body: "x".repeat(262145),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await f.app.request("/api/connectors/events/calendar", {
          method: "POST",
          body: "unexpected body",
        })
      ).status,
    ).toBe(413);
    expect(f.acceptSigned).not.toHaveBeenCalled();
    expect(f.captureChallenge).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    f.noMessages();
  });
  it("stream byte bound remains effective when declared content length is smaller", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-length": "1" },
      body: "abcdef",
    });
    expect(await readNativeEventBytes(request, 5)).toBeUndefined();
  });
  it("an unsigned setup challenge is isolated from runtime event queries", async () => {
    const f = fixture([target]);
    expect(
      (
        await f.app.request(`/api/connectors/events/notion/${HOOK}`, {
          method: "POST",
          body: JSON.stringify({ verification_token: TOKEN }),
        })
      ).status,
    ).toBe(204);
    expect(f.captureChallenge).toHaveBeenCalledOnce();
    expect(f.acceptSigned).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    f.noMessages();
  });
  it("Calendar uses exact channel headers, enqueues a source hint only, and rejects a wrong token", async () => {
    const channel = {
      id: "channel-a",
      tokenHash: calendarChannelTokenHash("synthetic-channel-token"),
      phase: "active",
      resourceId: "resource-a",
      resourceUri: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      expiration: Date.now() + 60000,
    };
    const f = fixture([
      { id: "trigger-calendar", version: 4, state: { calendarChannels: [channel] } },
    ]);
    const headers = {
      "x-goog-channel-id": channel.id,
      "x-goog-channel-token": "synthetic-channel-token",
      "x-goog-resource-id": channel.resourceId,
      "x-goog-resource-uri": channel.resourceUri,
      "x-goog-resource-state": "exists",
      "x-goog-message-number": "8",
    };
    expect(
      (await f.app.request("/api/connectors/events/calendar", { method: "POST", headers })).status,
    ).toBe(204);
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "native.source.poll",
        payload: { triggerId: "trigger-calendar", triggerVersion: 4 },
      }),
    );
    f.enqueue.mockClear();
    expect(
      (
        await f.app.request("/api/connectors/events/calendar", {
          method: "POST",
          headers: { ...headers, "x-goog-channel-token": "wrong" },
        })
      ).status,
    ).toBe(401);
    expect(f.enqueue).not.toHaveBeenCalled();
    f.noMessages();
  });
});

describe("Discord command HTTP protocol receipt", () => {
  it("returns an ephemeral queued response only after passing exact bounded raw bytes to the service", async () => {
    const app = new Hono(),
      ingestDiscord = vi.fn(
        async (
          _configId: string,
          _raw: Uint8Array,
          _headers: Headers | Record<string, string>,
          _signal: AbortSignal,
        ) => ({ type: 4 as const, data: { content: "Routine queued.", flags: 64 as const } }),
      );
    registerNativeEventWebhooks(app, {
      ingestNotion: async () => 0,
      ingestCalendar: async () => 0,
      ingestDiscord,
    });
    const raw = '  {"type":2,"untrusted":"bytes retained exactly"}\n';
    const response = await app.request("/api/connectors/events/discord/config-a", {
      method: "POST",
      headers: { "x-signature-ed25519": "fixture-signature" },
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: 4,
      data: { content: "Routine queued.", flags: 64 },
    });
    expect(ingestDiscord).toHaveBeenCalledTimes(1);
    expect(ingestDiscord.mock.calls[0]?.[0]).toBe("config-a");
    expect(new TextDecoder().decode(ingestDiscord.mock.calls[0]?.[1])).toBe(raw);
  });
  it("queue failures are 503 and invalid signatures are 401, with no successful queued acknowledgement", async () => {
    for (const error of [
      new Error("durable queue failed"),
      new NativeActionError("authorization_required", "invalid signature"),
    ]) {
      const app = new Hono();
      registerNativeEventWebhooks(app, {
        ingestNotion: async () => 0,
        ingestCalendar: async () => 0,
        ingestDiscord: async () => {
          throw error;
        },
      });
      const response = await app.request("/api/connectors/events/discord/config-a", {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(error instanceof NativeActionError ? 401 : 503);
      expect(await response.text()).not.toContain("queued");
    }
  });
});
