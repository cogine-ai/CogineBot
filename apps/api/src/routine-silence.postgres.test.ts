import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { routineRetryJob, routineWakeupJob, runContinueJob } from "@rakazo/adapter-kit";
import { createJobReconciler } from "@rakazo/adapters";
import type { Actor, Bot, Routine, RoutineHistory, ThreadMessage } from "@rakazo/contracts";
import { RoutineHistorySchema } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import type { MockInstance } from "vitest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ExpoPushProvider } from "../../../packages/adapters/src/expo-push.js";
import { TransientModelError } from "../../../packages/adapters/src/model-output-recovery.js";
import { discardBotIntroFromCreate } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const origin = "http://127.0.0.1:5173";
const MINUTE = 60_000;

/** The provider seam emits completions; the actual worker owns every persisted run and message. */
class RoutineCompletionRuntime implements AgentRuntime {
  mode:
    | "empty"
    | "sentinel"
    | "result"
    | "steering-result"
    | "failure"
    | "transient"
    | "tool-then-transient" = "empty";
  readonly calls: string[] = [];
  readonly claimedSteering: string[] = [];

  describe() {
    return {
      id: "offline-routine-completion",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: true },
    };
  }

  async abort(): Promise<void> {}

  async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
    this.calls.push(request.runId);
    if (this.mode === "failure") throw new Error("Offline synthetic provider failure");
    if (this.mode === "tool-then-transient") {
      yield {
        type: "tool",
        name: "schedule_list",
        args: {},
        executionId: `offline-schedule-list:${request.runId}`,
      };
    }
    if (this.mode === "transient" || this.mode === "tool-then-transient") {
      throw new TransientModelError("Synthetic provider temporarily unavailable");
    }
    if (this.mode === "steering-result") {
      const messages = await request.claimSteering?.([]);
      this.claimedSteering.push(...(messages?.map((message) => message.text) ?? []));
    }
    const text =
      this.mode === "sentinel"
        ? "NO_RESPONSE"
        : this.mode === "result" || this.mode === "steering-result"
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
  afterEach(() => vi.useRealTimers());

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

  async function fixture(crons = ["0 9 * * *"]) {
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
      crons,
      active: false,
    });
    return { cookie, actor, bot, routine };
  }

  async function history(owner: Awaited<ReturnType<typeof fixture>>) {
    return RoutineHistorySchema.parse(
      await rpc<RoutineHistory>(owner.cookie, "routines/history", { routineId: owner.routine.id }),
    ).runs;
  }

  it.each(["empty", "sentinel", "result", "failure"] as const)(
    "persists scheduled %s completion with matching history, unread state and notifications",
    async (mode) => {
      const owner = await fixture();
      const { cookie, actor, bot, routine } = owner;
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
      const runsInHistory = await history(owner);
      expect(runsInHistory).toHaveLength(1);
      const historyRun = runsInHistory[0]!;
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

  async function failOneShot() {
    const owner = await fixture(["@once"]);
    vi.useFakeTimers({ toFake: ["Date"] });
    const scheduledAt = new Date(Date.now() + MINUTE);
    await rpc<Routine>(owner.cookie, "routines/update", {
      routineId: owner.routine.id,
      active: true,
      runAt: scheduledAt.toISOString(),
    });
    runtime.mode = "transient";
    vi.setSystemTime(scheduledAt);
    await handles.awaitIdle!();
    const runs = await history(owner);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", messageId: null });
    const [routine] = await rpc<Routine[]>(owner.cookie, "routines/list", { botId: owner.bot.id });
    expect(routine).toMatchObject({ id: owner.routine.id, active: false, nextRunAt: null });
    const retryAt = new Date(scheduledAt.getTime() + 12 * MINUTE);
    const source = await database.prisma.run.findUniqueOrThrow({ where: { id: runs[0]!.id } });
    expect(source.routineRetryAt).toEqual(retryAt);
    return { owner, source, retryAt };
  }

  it("retries an automatically deactivated one-shot exactly once, at twelve minutes", async () => {
    const { owner, source, retryAt } = await failOneShot();
    const deliver = () =>
      handles.jobs.enqueue({ ...routineRetryJob(source.id, new Date()), replaceKey: undefined });

    vi.setSystemTime(new Date(retryAt.getTime() - 1));
    await deliver();
    await handles.awaitIdle!();
    expect((await history(owner)).map(({ id }) => id)).toEqual([source.id]);

    vi.setSystemTime(retryAt);
    // Two unkeyed deliveries exercise the worker's DB claim, bypassing queue deduplication.
    await Promise.all([deliver(), deliver()]);
    await handles.awaitIdle!();
    const runs = await history(owner);
    expect(runs).toHaveLength(2);
    const child = runs.find(({ id }) => id !== source.id)!;
    expect(child).toMatchObject({ status: "failed", messageId: null });
    expect(await database.prisma.run.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({
      retryOfRunId: source.id,
      routineRetryAt: null,
      threadId: source.threadId,
    });
    expect(runtime.calls.filter((id) => id === source.id || id === child.id)).toEqual([
      source.id,
      child.id,
    ]);
    vi.setSystemTime(new Date(retryAt.getTime() + 12 * MINUTE));
    await handles.awaitIdle!();
    expect(await history(owner)).toHaveLength(2);
    expect(handles.backgroundFailures?.()).toEqual([]);
  });

  it.each(["pause", "archive", "stop"] as const)(
    "honors a user %s before the failed one-shot can retry",
    async (action) => {
      const { owner, source, retryAt } = await failOneShot();
      if (action === "pause") {
        await rpc<Routine>(owner.cookie, "routines/update", {
          routineId: owner.routine.id,
          active: false,
        });
      } else if (action === "archive") {
        await rpc(owner.cookie, "bots/archive", { botId: owner.bot.id });
      } else {
        await rpc(owner.cookie, "threads/stop", { botId: owner.bot.id });
      }
      vi.setSystemTime(retryAt);
      await handles.awaitIdle!();
      expect(await database.prisma.run.count({ where: { retryOfRunId: source.id } })).toBe(0);
      expect(handles.backgroundFailures?.()).toEqual([]);
    },
  );

  it("recovers a missed retry wake from the durable failed Run", async () => {
    const { owner, source, retryAt } = await failOneShot();
    const { replaceKey } = routineRetryJob(source.id, retryAt);
    await handles.jobs.cancel(replaceKey!);
    runtime.mode = "result";
    vi.setSystemTime(retryAt);
    const reconciler = createJobReconciler({ prisma: database.prisma, jobs: handles.jobs });
    await reconciler.reconcileOnce();
    await handles.awaitIdle!();
    expect(await history(owner)).toHaveLength(2);
    expect(await database.prisma.run.count({ where: { retryOfRunId: source.id } })).toBe(1);
    expect(handles.backgroundFailures?.()).toEqual([]);
  });

  it("cancels a queued retry after pause and answers the human message waiting behind it", async () => {
    const { owner, source, retryAt } = await failOneShot();
    vi.setSystemTime(retryAt);
    const enqueue = handles.jobs.enqueue.bind(handles.jobs);
    const holdRunWake = vi.spyOn(handles.jobs, "enqueue").mockImplementation(async (job) => {
      if (job.name !== "run.continue") await enqueue(job);
    });
    let child: { id: string; taskId: string; threadId: string };
    try {
      await handles.awaitIdle!();
      child = await database.prisma.run.findUniqueOrThrow({
        where: { retryOfRunId: source.id },
      });
      expect(child).toMatchObject({ status: "queued", startedAt: null });
      await rpc(owner.cookie, "threads/send", {
        botId: owner.bot.id,
        text: "Please answer this instead.",
      });
      await rpc<Routine>(owner.cookie, "routines/update", {
        routineId: owner.routine.id,
        active: false,
      });
    } finally {
      holdRunWake.mockRestore();
    }
    runtime.mode = "steering-result";
    await handles.jobs.enqueue(runContinueJob(child.id));
    await handles.awaitIdle!();
    expect(runtime.calls).not.toContain(child.id);
    expect(await database.prisma.run.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({
      status: "cancelled",
      startedAt: null,
    });
    expect(
      await database.prisma.task.findUniqueOrThrow({ where: { id: child.taskId } }),
    ).toMatchObject({
      status: "cancelled",
    });
    expect(
      await database.prisma.event.count({
        where: { runId: child.id, type: "run.cancelled" },
      }),
    ).toBe(1);
    const followUp = await database.prisma.run.findFirstOrThrow({
      where: { threadId: child.threadId, trigger: "follow_up" },
    });
    expect(followUp.status).toBe("completed");
    expect(runtime.calls).toContain(followUp.id);
    expect(runtime.claimedSteering).toContain("Please answer this instead.");
    expect(
      await database.prisma.message.count({
        where: { runId: followUp.id, role: "bot" },
      }),
    ).toBe(1);
    expect(handles.backgroundFailures?.()).toEqual([]);
  });

  async function failRecurring(
    nextInMs: number,
    mode: RoutineCompletionRuntime["mode"] = "transient",
  ) {
    const owner = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    // The stored schedule is a clock fixture. The authenticated Test Run and worker are real.
    await database.prisma.routine.update({
      where: { id: owner.routine.id },
      data: { active: true, nextRunAt: new Date(Date.now() + nextInMs) },
    });
    runtime.mode = mode;
    const { runId } = await rpc<{ runId: string }>(owner.cookie, "routines/testRun", {
      routineId: owner.routine.id,
    });
    await handles.awaitIdle!();
    const runs = await history(owner);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: runId, status: "failed", messageId: null });
    return { owner, source: await database.prisma.run.findUniqueOrThrow({ where: { id: runId } }) };
  }

  it.each([
    { nextInMs: 42 * MINUTE, lateByMs: 0, retry: false },
    { nextInMs: 42 * MINUTE + 1, lateByMs: 0, retry: true },
    { nextInMs: 42 * MINUTE + 1, lateByMs: 1, retry: false },
  ])(
    "applies the 30-minute window at admission and delivery ($nextInMs, +$lateByMs ms)",
    async ({ nextInMs, lateByMs, retry }) => {
      const { owner, source } = await failRecurring(nextInMs);
      const retryAt = Date.now() + 12 * MINUTE;
      expect(source.routineRetryAt).toEqual(nextInMs === 42 * MINUTE ? null : new Date(retryAt));
      runtime.mode = "result";
      vi.setSystemTime(retryAt + lateByMs);
      await handles.awaitIdle!();
      const runs = await history(owner);
      expect(runs).toHaveLength(retry ? 2 : 1);
      if (retry) {
        const child = runs.find(({ id }) => id !== source.id)!;
        expect(child.status).toBe("completed");
        expect(child.messageId).not.toBeNull();
      }
      expect(handles.backgroundFailures?.()).toEqual([]);
    },
  );

  it("does not retry a failure after a real tool invocation", async () => {
    const { owner, source } = await failRecurring(60 * MINUTE, "tool-then-transient");
    expect(
      await database.prisma.event.count({ where: { runId: source.id, type: "agent.tool.called" } }),
    ).toBe(1);
    expect(source.routineRetryAt).toBeNull();
    vi.setSystemTime(Date.now() + 12 * MINUTE);
    await handles.awaitIdle!();
    expect(await history(owner)).toHaveLength(1);
    expect(handles.backgroundFailures?.()).toEqual([]);
  });

  it("does not retry an older failure after a newer Run", async () => {
    const { owner, source } = await failRecurring(60 * MINUTE);
    expect(source.routineRetryAt).not.toBeNull();
    runtime.mode = "result";
    const { runId } = await rpc<{ runId: string }>(owner.cookie, "routines/testRun", {
      routineId: owner.routine.id,
    });
    await handles.awaitIdle!();
    vi.setSystemTime(Date.now() + 12 * MINUTE);
    await handles.awaitIdle!();
    expect(await history(owner)).toEqual([
      expect.objectContaining({ id: runId, status: "completed" }),
      expect.objectContaining({ id: source.id, status: "failed" }),
    ]);
    expect(handles.backgroundFailures?.()).toEqual([]);
  });
});
