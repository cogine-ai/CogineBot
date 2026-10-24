import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Actor,
  Bot,
  Routine,
  RoutineHistory,
  RoutineRunCursor,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { RoutineHistorySchema } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discardBotIntroFromCreate } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const origin = "http://127.0.0.1:5173";

describePostgres("routine failure history HTTP acceptance", () => {
  let database: ReturnType<typeof createDb>;
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "routine-history-acceptance-"));
    database = createDb(process.env.DATABASE_URL!);
    handles = await createApp({
      prisma: database.prisma,
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      encryptionKey: "offline-routine-history-test-key",
      webOrigin: origin,
      authUrl: origin,
    });
  });
  afterAll(async () => {
    await handles?.stop();
    await database?.prisma.$disconnect();
    await database?.pool.end();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  function raw(cookie: string, procedure: string, input: unknown = {}, spaceId?: string) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...(cookie ? { cookie } : {}),
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }
  async function rpc<T>(cookie: string, procedure: string, input: unknown = {}, spaceId?: string) {
    const response = await raw(cookie, procedure, input, spaceId);
    const text = await response.text();
    if (!response.ok) throw new Error(`${procedure}: ${response.status} ${text}`);
    const result = (JSON.parse(text) as { json: T }).json;
    return discardBotIntroFromCreate(handles, cookie, procedure, result);
  }
  async function account() {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `routine-history-${randomUUID()}@example.test`,
        password: "password12",
        name: "Routine history tester",
      }),
    });
    expect(response.ok).toBe(true);
    const cookie = sessionCookieHeader(response);
    const actor = await rpc<Actor>(cookie, "me");
    return { cookie, actor };
  }
  async function fixture() {
    const owner = await account();
    const bot = await rpc<Bot>(owner.cookie, "bots/create", { name: "History bot" });
    const routine = await rpc<Routine>(owner.cookie, "routines/create", {
      botId: bot.id,
      name: "History routine",
      prompt: "Record a synthetic observation",
      crons: ["0 9 * * *"],
    });
    const thread = await database.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    return { ...owner, bot, routine, thread };
  }
  async function seedRun(
    owner: Awaited<ReturnType<typeof fixture>>,
    input: { id?: string; threadId?: string; status: string; error?: string; createdAt?: Date },
  ) {
    const threadId = input.threadId ?? owner.thread.id;
    const createdAt = input.createdAt ?? new Date("2026-10-20T09:00:00Z");
    const task = await database.prisma.task.create({
      data: {
        spaceId: owner.actor.spaceId,
        userId: owner.actor.userId,
        botId: owner.bot.id,
        threadId,
        prompt: "Synthetic historical routine task",
        status: input.status,
      },
    });
    return database.prisma.run.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        spaceId: owner.actor.spaceId,
        userId: owner.actor.userId,
        botId: owner.bot.id,
        threadId,
        taskId: task.id,
        routineId: owner.routine.id,
        trigger: "routine",
        status: input.status,
        error: input.error,
        createdAt,
        startedAt: input.status === "queued" ? null : createdAt,
        completedAt: input.status === "queued" ? null : createdAt,
      },
    });
  }
  async function history(owner: Awaited<ReturnType<typeof fixture>>, before?: RoutineRunCursor) {
    const value = await rpc<RoutineHistory>(owner.cookie, "routines/history", {
      routineId: owner.routine.id,
      ...(before ? { before } : {}),
    });
    return RoutineHistorySchema.parse(value);
  }

  it("returns cleaned bounded failure diagnostics without inventing messages for silent runs", async () => {
    const owner = await fixture();
    const diagnostic = `401: {"message":"${"界😀".repeat(1800)}","token":"synthetic-secret-value"}`;
    const failed = await seedRun(owner, { status: "failed", error: diagnostic });
    const silent = await seedRun(owner, { status: "completed", error: "stale diagnostic" });
    const queued = await seedRun(owner, { status: "queued" });
    const value = await history(owner);
    const byId = new Map(value.runs.map((run) => [run.id, run]));
    const details = byId.get(failed.id)?.error ?? "";
    expect(details.length).toBeGreaterThan(300);
    expect(new TextEncoder().encode(details).length).toBeLessThanOrEqual(8192);
    expect(details).not.toContain("synthetic-secret-value");
    expect(details.endsWith("\n[Diagnostics truncated at 8 KiB]")).toBe(true);
    expect(byId.get(silent.id)?.error).toBeNull();
    expect(byId.get(queued.id)?.error).toBeNull();
    expect(value.runs.every((run) => run.messageId === null)).toBe(true);
  });

  it.each(["bot", "group"] as const)(
    "returns complete cleaned %s thread failure diagnostics through authenticated history reloads",
    async (kind) => {
      const owner = await fixture();
      let threadId = owner.thread.id;
      let target: { botId?: string; groupId?: string } = { botId: owner.bot.id };
      if (kind === "group") {
        const peer = await rpc<Bot>(owner.cookie, "bots/create", { name: "Diagnostic peer" });
        const group = await rpc<{ id: string }>(owner.cookie, "groups/create", {
          name: "Diagnostic group",
          botIds: [owner.bot.id, peer.id],
          clientNonce: `diagnostic-group:${randomUUID()}`,
        });
        threadId = (
          await database.prisma.thread.findUniqueOrThrow({ where: { groupId: group.id } })
        ).id;
        target = { groupId: group.id };
      }
      await handles.awaitIdle?.();
      const run = await seedRun(owner, {
        status: "failed",
        threadId,
        createdAt: new Date(Date.now() + 1_000),
        error: `${"x".repeat(350)} SAFE_DIAGNOSTIC_AFTER_300 token=synthetic-private-thread-value\n{"client_secret":"AIzaSyntheticThreadCredential","api-key":"opaque-thread-key"}\n${JSON.stringify({ response_body: JSON.stringify({ message: "provider failure", client_secret: "SYNTHETIC_NESTED_THREAD_VALUE" }) })}\nAuthorization: Token SYNTHETIC_THREAD_AUTH_FIRST\r\n SYNTHETIC_THREAD_AUTH_SECOND\nprivate_key=-----BEGIN PRIVATE KEY-----\nSYNTHETIC_THREAD_PRIVATE_PEM\n-----END PRIVATE KEY-----\nclient_secret: 'SYNTHETIC_THREAD_YAML_FIRST\\''SYNTHETIC_THREAD_YAML_SECOND'\n${"界😀".repeat(1600)}`,
      });
      const before = await database.prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
      const first = await rpc<ThreadSnapshot>(owner.cookie, "threads/get", target);
      const reloaded = await rpc<ThreadSnapshot>(owner.cookie, "threads/get", target);
      expect(first.run?.id).toBe(run.id);
      expect(reloaded.run?.error).toBe(first.run?.error);
      const details = reloaded.run!.error!;
      expect(details).toContain("SAFE_DIAGNOSTIC_AFTER_300");
      expect(details).toContain("token=[Redacted]");
      expect(details).not.toContain("synthetic-private-thread-value");
      expect(details).not.toContain("AIzaSyntheticThreadCredential");
      expect(details).not.toContain("opaque-thread-key");
      expect(details).not.toContain("SYNTHETIC_NESTED_THREAD_VALUE");
      expect(details).not.toMatch(/SYNTHETIC_THREAD_(?:AUTH|PRIVATE_PEM|YAML)/);
      expect(details).toContain('"client_secret":"[Redacted]"');
      expect(details).toContain('"api-key":"[Redacted]"');
      expect(new TextEncoder().encode(details).length).toBeLessThanOrEqual(8192);
      expect(details.endsWith("\n[Diagnostics truncated at 8 KiB]")).toBe(true);
      expect(reloaded.messages.some((message) => message.runId === run.id)).toBe(false);
      const after = await database.prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
      expect(after.nextMessageSeq).toBe(before.nextMessageSeq);
      expect(after.nextEventSeq).toBe(before.nextEventSeq);
      expect(after.unread).toBe(before.unread);
      expect((await raw("", "threads/get", target)).status).toBe(401);
      const other = await account();
      const space = await rpc<{ id: string }>(owner.cookie, "spaces/create", {
        name: "Other diagnostic Space",
      });
      // Thread target isolation uses the existing opaque RPC error boundary.
      // Routine history above has its own explicit not-found response.
      for (const denied of [
        await raw(other.cookie, "threads/get", target),
        await raw(owner.cookie, "threads/get", target, space.id),
      ]) {
        const body = await denied.text();
        expect(denied.status).toBe(500);
        expect(JSON.parse(body)).toEqual({
          json: {
            defined: false,
            code: "INTERNAL_SERVER_ERROR",
            status: 500,
            message: "Internal server error",
          },
        });
        expect(body).not.toMatch(
          /SAFE_DIAGNOSTIC_AFTER_300|synthetic-private-thread-value|"run"|"messages"/,
        );
        expect(body).not.toContain(run.id);
        expect(body).not.toContain(threadId);
      }
    },
  );

  it("pages tied timestamps with a 20-row result and 21st-row lookahead without duplication", async () => {
    const owner = await fixture();
    const prefix = `routine-history-${randomUUID()}`;
    for (let index = 0; index < 21; index += 1)
      await seedRun(owner, {
        id: `${prefix}-${String(index).padStart(2, "0")}`,
        status: "completed",
      });
    const first = await history(owner);
    expect(first.runs.map((run) => run.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `${prefix}-${String(20 - index).padStart(2, "0")}`),
    );
    expect(first.nextCursor).toEqual({ id: `${prefix}-01`, createdAt: "2026-10-20T09:00:00.000Z" });
    const second = await history(owner, first.nextCursor!);
    expect(second.runs.map((run) => run.id)).toEqual([`${prefix}-00`]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.runs, ...second.runs].map((run) => run.id)).size).toBe(21);
  });

  it("links only a matching bot reply in the group's actual execution thread", async () => {
    const owner = await fixture();
    const peer = await rpc<Bot>(owner.cookie, "bots/create", { name: "Group peer" });
    const group = await rpc<{ id: string }>(owner.cookie, "groups/create", {
      name: "History group",
      botIds: [owner.bot.id, peer.id],
      clientNonce: `history-group:${randomUUID()}`,
    });
    const groupThread = await database.prisma.thread.findUniqueOrThrow({
      where: { groupId: group.id },
    });
    const run = await seedRun(owner, { status: "completed", threadId: groupThread.id });
    const reply = await database.prisma.message.create({
      data: {
        threadId: groupThread.id,
        seq: 100,
        role: "bot",
        blocks: [{ kind: "text", text: "A synthetic result" }],
        runId: run.id,
      },
    });
    // Historical mismatched rows must not offer a link to a different conversation.
    await database.prisma.message.create({
      data: {
        threadId: owner.thread.id,
        seq: 101,
        role: "bot",
        blocks: [{ kind: "text", text: "Wrong conversation" }],
        runId: run.id,
        createdAt: new Date("2026-10-21T09:00:00Z"),
      },
    });
    expect((await history(owner)).runs[0]).toMatchObject({
      id: run.id,
      groupId: group.id,
      messageId: reply.id,
      error: null,
    });
  });

  it("rejects unauthenticated, foreign-user, other-Space and archived-bot history reads", async () => {
    const owner = await fixture();
    await seedRun(owner, { status: "failed", error: "synthetic owner-only diagnostic" });
    const input = { routineId: owner.routine.id };
    expect((await raw("", "routines/history", input)).status).toBe(401);
    const other = await account();
    expect((await raw(other.cookie, "routines/history", input)).status).toBe(404);
    const space = await rpc<{ id: string }>(owner.cookie, "spaces/create", {
      name: "Other history Space",
    });
    expect((await raw(owner.cookie, "routines/history", input, space.id)).status).toBe(404);
    await rpc(owner.cookie, "bots/archive", { botId: owner.bot.id }, owner.actor.spaceId);
    expect((await raw(owner.cookie, "routines/history", input, owner.actor.spaceId)).status).toBe(
      404,
    );
  });
});
