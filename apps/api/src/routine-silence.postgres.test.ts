import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import type { Actor, Bot, Routine, RoutineHistory, ThreadMessage } from "@rakazo/contracts";
import { RoutineHistorySchema } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import type { MockInstance } from "vitest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExpoPushProvider } from "../../../packages/adapters/src/expo-push.js";
import { discardBotIntroFromCreate } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const origin = "http://127.0.0.1:5173";

/** The provider seam emits completions; the actual worker owns every persisted run and message. */
class RoutineCompletionRuntime implements AgentRuntime {
  mode: "empty" | "sentinel" | "result" | "failure" = "empty";
  readonly calls: string[] = [];

  describe() {
    return {
      id: "offline-routine-completion",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: true, compaction: false, tools: false, scripted: true },
    };
  }

  async abort(): Promise<void> {}

  async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
    this.calls.push(request.runId);
    if (this.mode === "failure") throw new Error("Offline synthetic provider failure");
    const text =
      this.mode === "sentinel"
        ? "NO_RESPONSE"
        : this.mode === "result"
          ? "A new result is available."
          : "";
    if (text) yield { type: "text", text };
    yield { type: "done" };
  }
}

describePostgres("scheduled routine completion acceptance", () => {
  let database: ReturnType<typeof createDb>;
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;
  const runtime = new RoutineCompletionRuntime();
  let sendNotice: MockInstance<ExpoPushProvider["send"]>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "routine-silence-acceptance-"));
    database = createDb(process.env.DATABASE_URL!);
    // Capture the executor's actual notification boundary without a device or network send.
    sendNotice = vi.spyOn(ExpoPushProvider.prototype, "send").mockResolvedValue(undefined);
    handles = await createApp({
      prisma: database.prisma,
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      runtime,
      wakeupDriver: "memory",
      signupsEnabled: "true",
      encryptionKey: "offline-routine-silence-test-key",
      webOrigin: origin,
      authUrl: origin,
    });
  });
  afterAll(async () => {
    await handles?.stop();
    sendNotice?.mockRestore();
    await database?.prisma.$disconnect();
    await database?.pool.end();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function rpc<T>(cookie: string, procedure: string, input: unknown = {}): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ json: input }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${procedure}: ${response.status} ${text}`);
    const result = (JSON.parse(text) as { json: T }).json;
    return discardBotIntroFromCreate(handles, cookie, procedure, result);
  }

  it.each(["empty", "sentinel", "result", "failure"] as const)(
    "persists scheduled %s completion with matching history, unread state and notifications",
    async (mode) => {
      runtime.mode = "empty";
      const response = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `routine-completion-${randomUUID()}@example.test`,
          password: "password12",
          name: "Routine completion tester",
        }),
      });
      expect(response.ok).toBe(true);
      const cookie = sessionCookieHeader(response);
      const actor = await rpc<Actor>(cookie, "me");
      const bot = await rpc<Bot>(cookie, "bots/create", {
        name: "Scheduled observer",
        notifyOnFinish: true,
      });
      await handles.awaitIdle!();
      const routine = await rpc<Routine>(cookie, "routines/create", {
        botId: bot.id,
        name: "Observe scheduled work",
        prompt: "Check whether there is a new result.",
        crons: ["0 9 * * *"],
        active: false,
      });
      await rpc(cookie, "threads/markRead", { botId: bot.id });
      const before = await database.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
      expect(before.unread).toBe(false);
      expect(await database.prisma.run.count({ where: { routineId: routine.id } })).toBe(0);
      sendNotice.mockClear();
      runtime.calls.length = 0;
      runtime.mode = mode;

      // Move only the stored schedule clock into the past. A real queue wakeup then
      // claims the routine, creates its task/run, and dispatches the execution worker.
      const scheduledAt = new Date(Date.now() - 1_000);
      await database.prisma.routine.update({
        where: { id: routine.id },
        data: { active: true, nextRunAt: scheduledAt },
      });
      await handles.jobs.enqueue(routineWakeupJob(routine.id, scheduledAt));
      await handles.awaitIdle!();

      const runs = await database.prisma.run.findMany({ where: { routineId: routine.id } });
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(runtime.calls).toEqual([run.id]);
      expect(run).toMatchObject({
        trigger: "routine",
        userId: actor.userId,
        threadId: before.id,
        status: mode === "failure" ? "failed" : "completed",
      });
      const storedTask = await database.prisma.task.findUniqueOrThrow({
        where: { id: run.taskId },
      });
      expect(storedTask.status).toBe(run.status);
      const events = await database.prisma.event.findMany({ where: { runId: run.id } });
      expect(events.some((event) => event.type === "routine.fired")).toBe(true);
      expect(
        events.some(
          (event) => event.type === (mode === "failure" ? "run.failed" : "run.completed"),
        ),
      ).toBe(true);
      const messages = await database.prisma.message.findMany({ where: { runId: run.id } });
      const after = await database.prisma.thread.findUniqueOrThrow({ where: { id: before.id } });
      const history = RoutineHistorySchema.parse(
        await rpc<RoutineHistory>(cookie, "routines/history", { routineId: routine.id }),
      );
      expect(history.runs).toHaveLength(1);
      const historyRun = history.runs[0]!;
      expect(historyRun).toMatchObject({ id: run.id, status: run.status, groupId: null });
      const snapshot = await rpc<{ messages: ThreadMessage[] }>(cookie, "threads/get", {
        botId: bot.id,
      });

      if (mode === "empty" || mode === "sentinel") {
        expect(messages).toHaveLength(0);
        expect(snapshot.messages.some((message) => message.runId === run.id)).toBe(false);
        expect(after.nextMessageSeq).toBe(before.nextMessageSeq);
        expect(after.unread).toBe(false);
        expect(historyRun).toMatchObject({ error: null, messageId: null });
        expect(sendNotice).not.toHaveBeenCalled();
      } else if (mode === "result") {
        expect(messages).toHaveLength(1);
        expect(snapshot.messages.find((message) => message.runId === run.id)?.id).toBe(
          messages[0]!.id,
        );
        expect(after.nextMessageSeq).toBe(before.nextMessageSeq + 1);
        expect(after.unread).toBe(true);
        expect(historyRun).toMatchObject({ error: null, messageId: messages[0]!.id });
        expect(sendNotice).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            kind: "completion",
            botId: bot.id,
            threadId: before.id,
            body: "A new result is available.",
          }),
          expect.objectContaining({ spaceId: actor.spaceId, userId: actor.userId }),
        );
        await rpc(cookie, "threads/markRead", { botId: bot.id });
        expect(
          (await database.prisma.thread.findUniqueOrThrow({ where: { id: before.id } })).unread,
        ).toBe(false);
      } else {
        expect(messages).toHaveLength(0);
        expect(after.nextMessageSeq).toBe(before.nextMessageSeq);
        expect(after.unread).toBe(false);
        expect(historyRun).toMatchObject({
          error: "Offline synthetic provider failure",
          messageId: null,
        });
        expect(sendNotice).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ kind: "failure", botId: bot.id, threadId: before.id }),
          expect.objectContaining({ spaceId: actor.spaceId, userId: actor.userId }),
        );
      }
      expect((await rpc<Bot>(cookie, "bots/get", { botId: bot.id })).unread).toBe(
        mode === "result" ? false : before.unread,
      );
      expect(handles.backgroundFailures?.()).toEqual([]);
    },
    30_000,
  );
});
