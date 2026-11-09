import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { runQuotaResumeJob } from "@rakazo/adapter-kit";
import type { Bot, Group, ThreadSnapshot } from "@rakazo/contracts";
import { RUN_QUOTA_WAIT_MAX_MS, runQuotaWaitStateSchema } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseComputerExecutionLease } from "../../../packages/adapters/src/computer-lifecycle.js";
import { createJobReconciler } from "../../../packages/adapters/src/job-reconciler.js";
import { ModelQuotaWaitError } from "../../../packages/adapters/src/model-output-recovery.js";
import { startNextWaitingRun } from "../../../packages/adapters/src/run-lifecycle.js";
import { discardBotIntroFromCreate } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

class TimedProviderRuntime implements AgentRuntime {
  resetAt: Date | undefined;
  readonly resumed: string[] = [];

  describe() {
    return {
      id: "timed-provider-fixture",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: true, compaction: false, tools: false, scripted: true },
    };
  }

  async abort(): Promise<void> {}

  async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
    if (request.quotaResume) {
      await request.quotaResume.claim();
      this.resumed.push(request.runId);
    }
    if (this.resetAt) {
      const resetAt = this.resetAt;
      this.resetAt = undefined;
      throw new ModelQuotaWaitError("Provider rate limit", resetAt, {
        provider: request.model.provider,
        modelId: request.model.id,
        modelCredentialId: null,
        connectionRevision: null,
        endpointDigest: "a".repeat(64),
        costOwner: "deployment",
      });
    }
    await request.claimSteering?.([]);
    yield { type: "text", text: "The model is available again." };
    yield { type: "done" };
  }
}

describe.skipIf(!enabled).sequential("durable model limit wait (PostgreSQL)", () => {
  let database: ReturnType<typeof createDb>;
  let handles: Awaited<ReturnType<typeof createApp>>;
  let runtime: TimedProviderRuntime;
  let dataDir: string;

  async function startApp() {
    return createApp({
      prisma: database.prisma,
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      runtime,
      wakeupDriver: "memory",
      signupsEnabled: "true",
      encryptionKey: "offline-timed-provider-fixture-key",
      webOrigin: origin,
      authUrl: origin,
    });
  }

  beforeAll(() => {
    database = createDb(process.env.DATABASE_URL!);
  });
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "model-limit-wait-"));
    runtime = new TimedProviderRuntime();
    handles = await startApp();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  afterAll(async () => {
    await database?.prisma.$disconnect();
    await database?.pool.end();
  });

  async function rpc<T>(cookie: string, procedure: string, input: unknown): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ json: input }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${procedure}: ${response.status} ${body}`);
    return discardBotIntroFromCreate(
      handles,
      cookie,
      procedure,
      (JSON.parse(body) as { json: T }).json,
    );
  }

  async function parkChat() {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `model-limit-${randomUUID()}@example.test`,
        password: "fixturepassword",
        name: "Model limit tester",
      }),
    });
    expect(response.ok).toBe(true);
    const cookie = sessionCookieHeader(response);
    const bot = await rpc<Bot>(cookie, "bots/create", { name: "Waiting fixture" });
    await handles.awaitIdle!();

    vi.useFakeTimers({ toFake: ["Date"] });
    const until = new Date(Date.now() + 60_000);
    runtime.resetAt = until;
    const { runId } = await rpc<{ runId: string }>(cookie, "threads/send", {
      botId: bot.id,
      text: "Answer when the model is available.",
    });
    await handles.awaitIdle!();
    const run = await database.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({
      status: "waiting_limit",
      wakeAt: until,
      quotaWait: { revision: 1, dispatchedFence: null },
    });
    const snapshot = await rpc<ThreadSnapshot>(cookie, "threads/get", { botId: bot.id });
    expect(snapshot.run).toMatchObject({
      id: runId,
      status: "waiting_limit",
      quotaWaitUntil: until.toISOString(),
    });
    return { cookie, bot, run, until };
  }

  it("restores the same Run after a restart and keeps accepted input without waking early", async () => {
    const { cookie, bot, run, until } = await parkChat();
    await rpc(cookie, "threads/send", { botId: bot.id, text: "Please also include the date." });
    await handles.awaitIdle!();
    expect(runtime.resumed).not.toContain(run.id);
    expect(await database.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "waiting_limit",
      wakeAt: until,
    });

    await handles.jobs.cancel(`run:${run.id}:quota:1`);
    vi.setSystemTime(until);
    await handles.jobs.enqueue(runQuotaResumeJob(run.id, 2, until));
    await handles.awaitIdle!();
    expect(runtime.resumed).not.toContain(run.id);
    expect(await database.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "waiting_limit",
    });

    await handles.stop();
    runtime = new TimedProviderRuntime();
    vi.setSystemTime(until);
    handles = await startApp();
    const recovery = createJobReconciler({ prisma: database.prisma, jobs: handles.jobs });
    await recovery.reconcileOnce();
    await handles.awaitIdle!();

    expect(runtime.resumed.filter((id) => id === run.id)).toEqual([run.id]);
    expect(await database.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      taskId: run.taskId,
      status: "completed",
      quotaWait: { revision: 1, dispatchedFence: expect.any(Number) },
    });
    expect(
      await database.prisma.steeringMessage.count({
        where: { message: { threadId: run.threadId } },
      }),
    ).toBe(0);
  });

  it("keeps a timed retry when the bot is changing computers", async () => {
    const { bot, run, until } = await parkChat();
    await handles.jobs.cancel(`run:${run.id}:quota:1`);
    await database.prisma.bot.update({
      where: { id: bot.id },
      data: { computerSwitching: true },
    });
    vi.setSystemTime(until);
    await handles.jobs.enqueue(runQuotaResumeJob(run.id, 1, until));
    await handles.awaitIdle!();
    expect(runtime.resumed).not.toContain(run.id);
    const retry = await database.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(retry).toMatchObject({ status: "waiting_limit", quotaWait: run.quotaWait });
    expect(retry.wakeAt!.getTime()).toBeGreaterThan(until.getTime());

    await database.prisma.bot.update({
      where: { id: bot.id },
      data: { computerSwitching: false },
    });
    vi.setSystemTime(retry.wakeAt!);
    await handles.awaitIdle!();
    expect(runtime.resumed.filter((id) => id === run.id)).toEqual([run.id]);
  });

  it("wakes a due quota wait as soon as the same bot's computer lease is released", async () => {
    const { bot, run, until } = await parkChat();
    await handles.jobs.cancel(`run:${run.id}:quota:1`);
    const state = runQuotaWaitStateSchema.parse(run.quotaWait);
    // Leave less than one normal reconciliation interval before the wait expires.
    const releaseAt = new Date(Date.parse(state.beganAt) + RUN_QUOTA_WAIT_MAX_MS - 2_000);
    const owner = await database.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { computerId: true },
    });
    const runId = "synthetic-computer-lease-holder";
    const expiresAt = new Date(releaseAt.getTime() + 60_000);
    const holder = await database.prisma.computerExecutionLease.upsert({
      where: { computerId_botId: { computerId: owner.computerId!, botId: bot.id } },
      create: { computerId: owner.computerId!, botId: bot.id, runId, expiresAt },
      update: { runId, expiresAt },
    });
    const deps = { prisma: database.prisma, jobs: handles.jobs };

    await startNextWaitingRun(deps, bot.id, holder.runId);
    await handles.awaitIdle!();
    expect(runtime.resumed).not.toContain(run.id);

    vi.setSystemTime(releaseAt);
    await handles.jobs.enqueue(runQuotaResumeJob(run.id, state.revision, until));
    await handles.awaitIdle!();
    expect(runtime.resumed).not.toContain(run.id);
    expect(await database.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "waiting_limit",
      wakeAt: releaseAt,
      quotaWait: run.quotaWait,
    });

    await releaseComputerExecutionLease(database.prisma, holder);
    await startNextWaitingRun(deps, bot.id, holder.runId);
    await handles.awaitIdle!();
    expect(runtime.resumed.filter((id) => id === run.id)).toEqual([run.id]);
    expect(await database.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "completed",
      quotaWait: { ...state, dispatchedFence: expect.any(Number) },
    });
  });

  it("expires a wait even when another Run still holds the computer", async () => {
    const { bot, run, until } = await parkChat();
    await handles.jobs.cancel(`run:${run.id}:quota:1`);
    const persistedWait = runQuotaWaitStateSchema.parse(run.quotaWait);
    const expiresAt = new Date(Date.parse(persistedWait.beganAt) + RUN_QUOTA_WAIT_MAX_MS + 60_000);
    const owner = await database.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { computerId: true },
    });
    const blockingRunId = "synthetic-computer-lease-holder";
    const blocker = await database.prisma.computerExecutionLease.upsert({
      where: { computerId_botId: { computerId: owner.computerId!, botId: bot.id } },
      create: { computerId: owner.computerId!, botId: bot.id, runId: blockingRunId, expiresAt },
      update: { runId: blockingRunId, expiresAt },
    });

    vi.setSystemTime(until);
    const recovery = createJobReconciler({ prisma: database.prisma, jobs: handles.jobs });
    await recovery.reconcileOnce();
    await handles.awaitIdle!();
    expect(await database.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "waiting_limit",
    });

    vi.setSystemTime(new Date(expiresAt.getTime() - 30_000));
    await recovery.reconcileOnce();
    await handles.awaitIdle!();
    expect(runtime.resumed).not.toContain(run.id);
    expect(await database.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "failed",
      quotaWait: { revision: 1, dispatchedFence: null },
    });
    expect(
      await database.prisma.computerExecutionLease.findUniqueOrThrow({ where: { id: blocker.id } }),
    ).toMatchObject({ runId: blockingRunId, expiresAt });
  });

  it("keeps Stop terminal when the old wait job arrives", async () => {
    const { cookie, bot, run, until } = await parkChat();
    await rpc(cookie, "threads/stop", { botId: bot.id });
    vi.setSystemTime(until);
    await handles.jobs.enqueue(runQuotaResumeJob(run.id, 1, until));
    await handles.awaitIdle!();
    expect(runtime.resumed).not.toContain(run.id);
    expect(await database.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
      quotaWait: { revision: 1, dispatchedFence: null },
    });
  });

  it("routes group follow-ups past hidden waits and prefers steerable work over visible waits", async () => {
    const { cookie, bot, run, until } = await parkChat();
    const peer = await rpc<Bot>(cookie, "bots/create", { name: "Group quota peer" });
    await handles.awaitIdle!();
    const group = await rpc<Group>(cookie, "groups/create", {
      name: "Group quota follow-up",
      botIds: [bot.id, peer.id],
    });
    const scope = {
      threadId: group.threadId,
      botId: group.members[0]!.botId,
      spaceId: run.spaceId,
      userId: run.userId,
    };
    const task = await database.prisma.task.create({
      data: { ...scope, prompt: "Synthetic parked group work", status: "running" },
    });
    const wait = await database.prisma.run.create({
      data: {
        ...scope,
        taskId: task.id,
        trigger: "tickets",
        status: "waiting_limit",
        wakeAt: until,
        quotaWait: runQuotaWaitStateSchema.parse(run.quotaWait),
      },
    });

    async function followUp(text: string) {
      const clientNonce = randomUUID();
      await rpc(cookie, "threads/followUp", { groupId: group.id, text, clientNonce });
      await handles.awaitIdle!();
      return database.prisma.message.findUniqueOrThrow({
        where: { threadId_clientNonce: { threadId: group.threadId, clientNonce } },
      });
    }

    const foreground = await followUp("Start work in the group.");
    expect(foreground.runId).not.toBe(wait.id);
    expect(
      await database.prisma.run.findUniqueOrThrow({ where: { id: foreground.runId! } }),
    ).toMatchObject({ trigger: "follow_up", sourceMessageId: foreground.id, status: "completed" });

    await database.prisma.run.update({ where: { id: wait.id }, data: { trigger: "user" } });
    const pending = await followUp("Keep this input until the model is available.");
    expect(pending.runId).toBe(wait.id);
    expect(
      await database.prisma.steeringMessage.findFirstOrThrow({ where: { messageId: pending.id } }),
    ).toMatchObject({ runId: null, claimedAt: null });
    expect(await database.prisma.run.findUniqueOrThrow({ where: { id: wait.id } })).toMatchObject({
      status: "waiting_limit",
      wakeAt: until,
    });
    expect(runtime.resumed).not.toContain(wait.id);

    const handoffTask = await database.prisma.task.create({
      data: { ...scope, prompt: "Synthetic handed-off work", status: "queued" },
    });
    const handoff = await database.prisma.run.create({
      data: {
        ...scope,
        taskId: handoffTask.id,
        trigger: "follow_up",
        status: "queued",
        wakeAt: new Date(until.getTime() + 60_000),
      },
    });
    for (const status of ["queued", "waiting_takeover"] as const) {
      await database.prisma.run.update({ where: { id: handoff.id }, data: { status } });
      const steered = await followUp(`Continue the handed-off work in ${status}.`);
      expect(steered.runId).toBe(handoff.id);
      expect(
        await database.prisma.steeringMessage.findFirstOrThrow({
          where: { messageId: steered.id },
        }),
      ).toMatchObject({ runId: handoff.id, claimedAt: null });
    }
    expect(await database.prisma.run.findUniqueOrThrow({ where: { id: wait.id } })).toMatchObject({
      status: "waiting_limit",
      wakeAt: until,
      quotaWait: { revision: 1, dispatchedFence: null },
    });
    expect(runtime.resumed).not.toContain(wait.id);
  });

  it("keeps a visible quota wait beside the primary direct-chat question", async () => {
    const { cookie, bot, run, until } = await parkChat();
    const scope = {
      threadId: run.threadId,
      botId: bot.id,
      spaceId: run.spaceId,
      userId: run.userId,
    };
    const questionTask = await database.prisma.task.create({
      data: { ...scope, prompt: "Synthetic pending question", status: "running" },
    });
    const question = await database.prisma.run.create({
      data: {
        ...scope,
        taskId: questionTask.id,
        trigger: "user",
        status: "waiting_input",
        createdAt: new Date(run.createdAt.getTime() + 1),
      },
    });
    const hiddenTask = await database.prisma.task.create({
      data: { ...scope, prompt: "Synthetic parked ticket", status: "running" },
    });
    await database.prisma.run.create({
      data: {
        ...scope,
        taskId: hiddenTask.id,
        trigger: "tickets",
        status: "waiting_limit",
        wakeAt: until,
        quotaWait: runQuotaWaitStateSchema.parse(run.quotaWait),
      },
    });

    const snapshot = await rpc<ThreadSnapshot>(cookie, "threads/get", { botId: bot.id });
    expect(snapshot.run).toMatchObject({ id: question.id, status: "waiting_input" });
    expect(snapshot.activeRuns).toMatchObject([
      { id: question.id, status: "waiting_input" },
      { id: run.id, status: "waiting_limit", quotaWaitUntil: until.toISOString() },
    ]);
  });
});
