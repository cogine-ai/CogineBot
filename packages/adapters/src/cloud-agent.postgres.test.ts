import { randomUUID } from "node:crypto";
import type { AdapterContext, BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import {
  CloudAgentRequestRejected,
  CloudAgentRetryLater,
  CloudAgentUnavailable,
} from "@rakazo/adapter-kit";
import { clearThread, createDb, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { executeCloudAgentTool, reconcileCloudAgents } from "./cloud-agent-service.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";
import { createJobReconciler } from "./job-reconciler.js";
import { CursorCloudAgentEmulator } from "./testing/cursor-cloud-agent-emulator.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("cloud agent lifecycle and recovery (PostgreSQL + Cursor emulator)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const users: string[] = [];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
  });
  afterAll(async () => {
    if (!db) return;
    await prisma.cloudAgent.deleteMany({ where: { userId: { in: users } } });
    await prisma.organization.deleteMany({ where: { id: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function setup() {
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "Cloud test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Cloud test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Cloud test", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Cloud test", color: "test-color" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Test",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "completed",
        trigger: "user",
      },
    });
    const wire = new CursorCloudAgentEmulator();
    const connection: CloudAgentConnection = {
      key: `test-connection:${id}`,
      spaceId: id,
      provider: new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch }),
    };
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    const jobs: JobPublisher = {
      enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const deps = {
      prisma,
      jobs,
      events: { notify: vi.fn(async () => undefined) },
      cloudAgent: connection,
    };
    const context: AdapterContext & { botId: string } = {
      operationId: randomUUID(),
      traceId: "test",
      spaceId: id,
      userId: id,
      botId: bot.id,
      signal: new AbortController().signal,
    };
    const tool = (
      name: string,
      args: Record<string, unknown>,
      overrides: Partial<typeof context> = {},
    ) =>
      executeCloudAgentTool(deps, { ...context, ...overrides }, run, `cloud_agent_${name}`, args);
    const launch = async () => {
      const result = await tool("launch", {
        prompt: "Add README",
        repository: "https://github.com/example/demo",
        openPr: true,
      });
      if (!("id" in result)) throw new Error("Launch failed");
      return result.id;
    };
    const state = (agentId: string) =>
      prisma.cloudAgent.findUniqueOrThrow({ where: { id: agentId } });
    const pollNow = (agentId: string) => pollCloudAgent(deps, { agentId });
    const poll = async (agentId: string) => {
      // Most scenarios drive the next scheduled tick without waiting in real time.
      await prisma.cloudAgent.updateMany({
        where: { id: agentId, nextPollAt: { gt: new Date() } },
        data: { nextPollAt: new Date(0) },
      });
      await pollNow(agentId);
    };
    const clear = () => clearThread(prisma, { spaceId: id, botId: bot.id, threadId: thread.id });
    const wakes = () =>
      prisma.run.findMany({ where: { threadId: thread.id, trigger: "cloud_agent" } });
    const finish = async (agentId: string) => {
      wire.complete((await state(agentId)).remoteId!);
      await poll(agentId);
    };
    return {
      id,
      bot,
      thread,
      run,
      wire,
      connection,
      enqueue,
      deps,
      context,
      tool,
      launch,
      state,
      poll,
      pollNow,
      clear,
      wakes,
      finish,
    };
  }

  it("persists before remote I/O, launches once, and wakes exactly once per generation", async () => {
    const h = await setup();
    const id = await h.launch();
    expect(h.wire.requests).toHaveLength(0);
    expect(await h.launch()).toBe(id);
    expect(await prisma.cloudAgent.count({ where: { userId: h.id } })).toBe(1);
    await h.poll(id);
    await h.finish(id);
    expect(await h.state(id)).toMatchObject({
      status: "finished",
      wakeGeneration: 0,
      nextPollAt: null,
    });
    expect(await h.wakes()).toHaveLength(1);
    await prisma.cloudAgent.update({ where: { id }, data: { nextPollAt: new Date() } });
    await h.poll(id);
    expect(await h.wakes()).toHaveLength(1);
  });

  it("recovers an accepted launch whose response was lost without creating a second remote agent", async () => {
    const h = await setup();
    const id = await h.launch();
    h.wire.loseNextLaunchResponse = true;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      remoteId: null,
      launchDispatched: true,
      status: "running",
    });
    h.wire.failNextRequest = 429;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      remoteId: null,
      launchDispatched: true,
      status: "running",
    });
    h.wire.failNextRequest = 404;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      remoteId: null,
      launchDispatched: true,
      status: "running",
    });
    h.connection.provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: h.wire.fetch,
    });
    await h.poll(id);
    expect((await h.state(id)).remoteId).toBeTruthy();
    expect(h.wire.ids.size).toBe(1);
    expect(h.wire.requests.filter((request) => request.path === "/v1/agents")).toHaveLength(4);
  });

  it("keeps the provider delay across status reads, duplicate jobs, and a repeated launch", async () => {
    const h = await setup();
    const id = await h.launch();
    const launch = vi
      .spyOn(h.connection.provider, "launch")
      .mockRejectedValueOnce(new CloudAgentRetryLater("rate_limit", 120_000));
    const startedAt = Date.now();
    await h.pollNow(id);
    const { nextPollAt } = await h.state(id);
    expect(nextPollAt?.getTime()).toBeGreaterThanOrEqual(startedAt + 120_000);
    expect(await h.state(id)).toMatchObject({ launchDispatched: false, errorCount: 1 });

    h.enqueue.mockClear();
    await h.tool("status", { id });
    expect(await h.launch()).toBe(id);
    await Promise.all([h.pollNow(id), h.pollNow(id)]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect((await h.state(id)).nextPollAt).toEqual(nextPollAt);
    for (const [job] of h.enqueue.mock.calls) {
      expect(job.availableAt).toEqual(nextPollAt);
    }

    await h.tool("cancel", { id });
    await h.poll(id);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", nextPollAt: null });
    expect(h.wire.requests).toHaveLength(0);
  });

  it("reconciles durable launch and wake intents after queue failure", async () => {
    const h = await setup();
    h.enqueue.mockRejectedValue(new Error("Queue unavailable"));
    const id = await h.launch();
    expect((await h.state(id)).nextPollAt).not.toBeNull();
    h.enqueue.mockResolvedValue(undefined);
    h.enqueue.mockClear();
    await reconcileCloudAgents(h.deps);
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cloud_agent.poll", payload: { agentId: id } }),
    );
    await h.poll(id);
    h.enqueue.mockRejectedValue(new Error("Queue unavailable"));
    await h.finish(id);
    const [wake] = await h.wakes();
    expect(wake?.status).toBe("queued");
    h.enqueue.mockResolvedValue(undefined);
    h.enqueue.mockClear();
    await createJobReconciler({ prisma, jobs: h.deps.jobs }).reconcileOnce();
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: wake!.id } }),
    );
  });

  it("never dispatches a launch whose card transaction fails", async () => {
    const h = await setup();
    await expect(h.tool("launch", { prompt: "Task" }, { userId: "wrong-owner" })).rejects.toThrow();
    expect(await prisma.cloudAgent.count({ where: { userId: h.id } })).toBe(0);
    expect(h.wire.requests).toHaveLength(0);
  });

  it("cancels locally when chat clears before dispatch, and remotely after dispatch", async () => {
    const before = await setup();
    const beforeId = await before.launch();
    await before.clear();
    await before.poll(beforeId);
    expect((await before.state(beforeId)).status).toBe("cancelled");
    expect(before.wire.requests).toHaveLength(0);
    const after = await setup();
    const afterId = await after.launch();
    await after.poll(afterId);
    await after.clear();
    await after.poll(afterId);
    expect(await after.state(afterId)).toMatchObject({ status: "cancelled", nextPollAt: null });
    expect(await prisma.message.count({ where: { threadId: after.thread.id } })).toBe(0);
    expect(await after.wakes()).toHaveLength(0);
    expect(await after.tool("status", { id: afterId })).toMatchObject({
      id: afterId,
      status: "cancelled",
    });
  });

  it("retains ownership and cancels when the original bot is deleted", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await prisma.bot.delete({ where: { id: h.bot.id } });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", nextPollAt: null });
  });

  it("does not wake an owner whose membership is revoked during the provider request", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    h.wire.complete((await h.state(id)).remoteId!);
    const original = h.connection.provider.get.bind(h.connection.provider);
    vi.spyOn(h.connection.provider, "get").mockImplementationOnce(async (...args) => {
      const snapshot = await original(...args);
      await prisma.spaceMember.delete({
        where: { spaceId_userId: { spaceId: h.id, userId: h.id } },
      });
      return snapshot;
    });
    await h.poll(id);
    expect(await h.wakes()).toHaveLength(0);
    expect((await h.state(id)).nextPollAt).toBeNull();
  });

  it("isolates users, spaces, and credential bindings before any provider request", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    const requests = h.wire.requests.length;
    expect(await h.tool("cancel", { id }, { userId: "other-user" })).toMatchObject({
      error: "Unknown cloud agent.",
    });
    expect(
      await h.tool("reply", { id, prompt: "Attack" }, { spaceId: "other-space" }),
    ).toHaveProperty("error");
    h.connection.spaceId = undefined;
    await h.poll(id);
    expect(h.wire.requests).toHaveLength(requests);
    h.connection.spaceId = h.id;
    h.connection.key = "rotated-key";
    expect(await h.tool("status", { id })).toMatchObject({ error: "Unknown cloud agent." });
    await h.poll(id);
    expect(h.wire.requests).toHaveLength(requests);
  });

  it("pins a follow-up to its returned run even when agent metadata is stale", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Add tests" });
    h.wire.staleLatestRunId = oldRun;
    await h.poll(id);
    const newRun = (await h.state(id)).latestRunId;
    expect(newRun).not.toBe(oldRun);
    await h.poll(id);
    expect((await h.state(id)).status).toBe("running");
    expect(await h.wakes()).toHaveLength(1);
    h.wire.complete((await h.state(id)).remoteId!);
    await h.poll(id);
    expect(await h.wakes()).toHaveLength(2);
    expect(await h.state(id)).toMatchObject({
      latestRunId: newRun,
      generation: 1,
      wakeGeneration: 1,
    });
  });

  it("cancels the known follow-up run even when latest agent metadata is stale", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Tests" });
    await h.poll(id);
    const newRun = (await h.state(id)).latestRunId;
    h.wire.staleLatestRunId = oldRun;
    await h.tool("cancel", { id });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      status: "cancelled",
      latestRunId: newRun,
      cancelRequested: false,
    });
  });

  it("keeps an accepted follow-up receipt when Stop arrives before the response", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Add tests" });
    const entered = deferred();
    const release = deferred();
    const provider = h.connection.provider;
    const reply = provider.reply.bind(provider);
    let newRunId: string | undefined;
    vi.spyOn(provider, "reply").mockImplementationOnce(async (...args) => {
      const snapshot = await reply(...args);
      newRunId = snapshot.latestRunId ?? undefined;
      entered.resolve();
      await release.promise;
      return snapshot;
    });
    const observe = vi.spyOn(provider, "observeRunSuccessor");
    const cancel = vi.spyOn(provider, "cancel");
    const polling = h.pollNow(id);
    try {
      await Promise.race([
        entered.promise,
        polling.then(() => {
          throw new Error("Expected the follow-up to be accepted before Stop");
        }),
      ]);
      expect(newRunId).toBeTruthy();
      expect(newRunId).not.toBe(oldRun);
      h.wire.staleLatestRunId = oldRun;
      h.wire.staleRunListId = oldRun;
      expect(await h.tool("cancel", { id })).toMatchObject({ cancellationPending: true });
    } finally {
      release.resolve();
      await polling;
    }

    expect(await h.state(id)).toMatchObject({
      status: "running",
      latestRunId: newRunId,
      followup: null,
      followupDispatching: false,
      cancelRequested: true,
    });
    await h.poll(id);
    expect(observe).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.any(Object),
      newRunId,
    );
    expect(await h.state(id)).toMatchObject({
      status: "cancelled",
      latestRunId: newRunId,
      cancelRequested: false,
    });
  });

  it("observes a successor after a lost follow-up response without adopting or resending it", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Add tests" });
    h.wire.loseNextReplyResponse = true;
    await h.poll(id);
    expect((await h.state(id)).followupDispatching).toBe(true);
    h.wire.staleLatestRunId = oldRun;
    h.wire.staleRunListId = oldRun;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 6 * 60_000);
      await h.poll(id);
      await h.poll(id);
    } finally {
      vi.useRealTimers();
    }
    expect(await h.state(id)).toMatchObject({
      status: "running",
      followup: { prompt: "Add tests" },
      followupDispatching: true,
      latestRunId: oldRun,
    });
    expect(await h.tool("status", { id })).not.toHaveProperty("followupSuccessorObserved");
    expect(await h.wakes()).toHaveLength(1);
    h.wire.staleRunListId = undefined;
    await h.poll(id);
    await h.finish(id);
    expect(await h.state(id)).toMatchObject({
      status: "running",
      followup: { prompt: "Add tests", runObserved: true },
      followupDispatching: true,
      latestRunId: oldRun,
    });
    expect(await h.tool("status", { id })).toMatchObject({
      followupPending: true,
      followupSuccessorObserved: true,
    });
    expect(await h.wakes()).toHaveLength(1);
    expect(h.wire.requests).toContainEqual(
      expect.objectContaining({ method: "GET", path: expect.stringMatching(/\/runs$/) }),
    );
    expect(
      h.wire.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/runs"),
      ),
    ).toHaveLength(1);
  });

  it("pins the previous remote run before dispatching a legacy follow-up without a run ID", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const { latestRunId } = await h.state(id);
    await prisma.cloudAgent.update({ where: { id }, data: { latestRunId: null } });
    await h.tool("reply", { id, prompt: "Tests" });
    h.wire.loseNextReplyResponse = true;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ latestRunId, followupDispatching: true });

    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      latestRunId,
      followup: { prompt: "Tests", runObserved: true },
      followupDispatching: true,
    });
    expect(
      h.wire.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/runs"),
      ),
    ).toHaveLength(1);
  });

  it.each([401, 403])(
    "retries a follow-up after a pre-send credential rejection (%s)",
    async (code) => {
      const h = await setup();
      const id = await h.launch();
      await h.poll(id);
      await h.finish(id);
      const { latestRunId } = await h.state(id);
      await h.tool("reply", { id, prompt: "Tests" });
      h.wire.failNextRequest = code;
      await h.poll(id);
      expect(await h.state(id)).toMatchObject({
        status: "running",
        followup: { prompt: "Tests" },
        followupDispatching: false,
        latestRunId,
        errorCount: 1,
      });
      expect(
        h.wire.requests.filter(
          (request) => request.method === "POST" && request.path.endsWith("/runs"),
        ),
      ).toHaveLength(0);
      await h.poll(id);
      expect(await h.state(id)).toMatchObject({ followup: null, followupDispatching: false });
      expect((await h.state(id)).latestRunId).not.toBe(latestRunId);
      expect(await h.wakes()).toHaveLength(1);
      expect(
        h.wire.requests.filter(
          (request) => request.method === "POST" && request.path.endsWith("/runs"),
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    { rejection: "temporary", status: "cancelled" },
    { rejection: "definitive", status: "failed" },
  ])("settles a $rejection rejection arriving after Stop", async ({ rejection, status }) => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    await h.tool("reply", { id, prompt: "Tests" });
    const entered = deferred();
    const release = deferred();
    const reply = vi.spyOn(h.connection.provider, "reply").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw rejection === "temporary"
        ? new CloudAgentRetryLater("rate_limit", 120_000)
        : new CloudAgentRequestRejected();
    });
    const cancel = vi.spyOn(h.connection.provider, "cancel");
    const polling = h.pollNow(id);
    try {
      await Promise.race([
        entered.promise,
        polling.then(() => {
          throw new Error("Expected the follow-up to reach its provider");
        }),
      ]);
      expect(await h.tool("cancel", { id })).toMatchObject({ cancellationPending: true });
    } finally {
      release.resolve();
      await polling;
    }

    expect((await h.state(id)).followupDispatching).toBe(false);
    await h.pollNow(id);
    expect(await h.state(id)).toMatchObject({
      status,
      cancelRequested: false,
      followup: null,
      nextPollAt: null,
    });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("reads a dispatch marker committed by another worker before claiming the lease", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    await h.tool("reply", { id, prompt: "Tests" });
    const beforeClaim = deferred();
    const release = deferred();
    const pauseClaim = async () => {
      beforeClaim.resolve();
      await release.promise;
    };
    const pausedPrisma = prisma.$extends({
      query: {
        cloudAgent: {
          async updateManyAndReturn({ args, query }) {
            await pauseClaim();
            return query(args);
          },
          async updateMany({ args, query }) {
            if (typeof args.data.leaseToken === "string") await pauseClaim();
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const reply = vi.spyOn(h.connection.provider, "reply");
    const polling = pollCloudAgent({ ...h.deps, prisma: pausedPrisma }, { agentId: id });
    try {
      await Promise.race([
        beforeClaim.promise,
        polling.then(() => {
          throw new Error("Expected the worker to claim a lease");
        }),
      ]);
      // The other worker wrote its dispatch marker, then lost the lease before settling.
      await prisma.cloudAgent.update({ where: { id }, data: { followupDispatching: true } });
    } finally {
      release.resolve();
      await polling;
    }
    expect(await h.state(id)).toMatchObject({ status: "running", followupDispatching: true });
    expect(reply).not.toHaveBeenCalled();
    expect(await h.wakes()).toHaveLength(1);
  });

  it("does not report cancellation success while transport fails or the provider is still running", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.tool("cancel", { id });
    h.wire.failNextRequest = 503;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", cancelRequested: true });
    h.wire.cancelPending = true;
    await h.poll(id);
    expect((await h.state(id)).nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 1_000);
    expect(await h.state(id)).toMatchObject({ status: "running", cancelRequested: true });
    h.wire.cancelPending = false;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", cancelRequested: false });
  });

  it("keeps cancellation pending with an old run or an unverified successor", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Tests" });
    h.wire.loseNextReplyResponse = true;
    await h.poll(id);
    await h.tool("cancel", { id });
    h.wire.staleLatestRunId = oldRun;
    h.wire.staleRunListId = oldRun;
    const cancel = vi.spyOn(h.connection.provider, "cancel");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 6 * 60_000);
      await h.poll(id);
    } finally {
      vi.useRealTimers();
    }
    expect(await h.state(id)).toMatchObject({
      status: "running",
      cancelRequested: true,
      followupDispatching: true,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(await h.wakes()).toHaveLength(1);
    h.wire.staleRunListId = undefined;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      status: "running",
      cancelRequested: true,
      latestRunId: oldRun,
      followup: { prompt: "Tests", runObserved: true },
      followupDispatching: true,
    });
    expect(await h.tool("status", { id })).toMatchObject({
      cancellationPending: true,
      followupPending: true,
      followupSuccessorObserved: true,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(await h.wakes()).toHaveLength(1);
  });

  it("waits for external predecessors and retries cancellation only for the received run", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const initial = await h.state(id);
    expect(initial.prUrl).toContain("/pull/");
    const remoteId = initial.remoteId!;
    const internalId = h.wire.ids.get(remoteId)!;
    const external = await h.wire.provider.reply(
      internalId,
      { prompt: "External work" },
      h.context,
    );
    const reply = vi.spyOn(h.connection.provider, "reply");

    expect(await h.tool("reply", { id, prompt: "Tests" })).not.toHaveProperty("prUrl");
    await h.poll(id);
    expect(reply).not.toHaveBeenCalled();
    expect(await h.state(id)).toMatchObject({
      latestRunId: initial.latestRunId,
      followupDispatching: false,
      branch: null,
      prUrl: null,
    });

    h.wire.complete(remoteId, { prUrl: "https://github.com/example/demo/pull/2" });
    const newerExternal = await h.wire.provider.reply(
      internalId,
      { prompt: "More external work" },
      h.context,
    );
    h.wire.complete(remoteId);
    await h.poll(id);
    const newRunId = h.wire.provider.agents.get(internalId)!.latestRunId;
    expect(newRunId).not.toBe(external.latestRunId);
    expect(newRunId).not.toBe(newerExternal.latestRunId);
    expect(await h.state(id)).toMatchObject({
      latestRunId: newRunId,
      followup: null,
      followupDispatching: false,
    });

    await h.tool("cancel", { id });
    const cancel = vi
      .spyOn(h.connection.provider, "cancel")
      .mockRejectedValueOnce(new Error("Connection lost while cancelling"));
    h.wire.staleRunListId = newerExternal.latestRunId;
    const listReads = () =>
      h.wire.requests.filter(
        (request) => request.method === "GET" && request.path.endsWith("/runs"),
      ).length;
    const priorListReads = listReads();
    await h.poll(id);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]?.[2]).toBe(newRunId);
    expect(await h.state(id)).toMatchObject({
      latestRunId: newRunId,
      followupDispatching: false,
      status: "running",
      cancelRequested: true,
    });
    expect(await h.wakes()).toHaveLength(1);

    await h.poll(id);
    expect(listReads()).toBe(priorListReads);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel.mock.calls[1]?.[2]).toBe(newRunId);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(await h.state(id)).toMatchObject({
      latestRunId: newRunId,
      status: "cancelled",
      cancelRequested: false,
      nextPollAt: null,
      branch: null,
      prUrl: null,
    });
    const card = await prisma.message.findFirstOrThrow({ where: { id: initial.messageId! } });
    expect(card.blocks).toContainEqual(expect.objectContaining({ status: "cancelled" }));
    expect(JSON.stringify(card.blocks)).not.toContain("/pull/");
  });

  it("does not adopt or cancel an external run when the local follow-up never reaches the provider", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const { remoteId, latestRunId } = await h.state(id);
    const internalId = h.wire.ids.get(remoteId!)!;
    const startExternalRun = vi.fn(() =>
      h.wire.provider.reply(internalId, { prompt: "External work" }, h.context),
    );
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (input, init) => {
        if (init?.method === "POST" && new URL(String(input)).pathname.endsWith("/runs")) {
          await startExternalRun();
          throw new Error("Connection lost before the local request reached the provider");
        }
        return h.wire.fetch(input, init);
      },
    });
    h.connection.provider = provider;
    const cancel = vi.spyOn(provider, "cancel");
    await h.tool("reply", { id, prompt: "Tests" });
    await h.poll(id);
    const external = await h.wire.provider.get(internalId, h.context);
    expect(external.latestRunId).not.toBe(latestRunId);
    expect(await h.state(id)).toMatchObject({
      latestRunId,
      followup: { prompt: "Tests" },
      followupDispatching: true,
    });

    await h.tool("cancel", { id });
    await h.poll(id);
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      status: "running",
      latestRunId,
      followup: { prompt: "Tests", runObserved: true },
      followupDispatching: true,
      cancelRequested: true,
    });
    expect(await h.tool("status", { id })).toMatchObject({
      cancellationPending: true,
      followupPending: true,
      followupSuccessorObserved: true,
    });
    expect(startExternalRun).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(await h.wakes()).toHaveLength(1);
    expect(await h.wire.provider.get(internalId, h.context)).toMatchObject({
      status: "running",
      latestRunId: external.latestRunId,
    });
  });

  it("withdraws a follow-up rejected as busy without cancelling the external run", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const { remoteId, latestRunId } = await h.state(id);
    const internalId = h.wire.ids.get(remoteId!)!;
    const startExternalRun = vi.fn(() =>
      h.wire.provider.reply(internalId, { prompt: "External work" }, h.context),
    );
    const provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (input, init) => {
        if (init?.method === "POST" && new URL(String(input)).pathname.endsWith("/runs")) {
          await startExternalRun();
          return Response.json({ error: { code: "agent_busy" } }, { status: 409 });
        }
        return h.wire.fetch(input, init);
      },
    });
    h.connection.provider = provider;
    const cancel = vi.spyOn(provider, "cancel");
    await h.tool("reply", { id, prompt: "Tests" });
    await h.poll(id);
    expect(startExternalRun).toHaveBeenCalledTimes(1);
    expect(await h.state(id)).toMatchObject({
      status: "running",
      latestRunId,
      followup: { prompt: "Tests" },
      followupDispatching: false,
    });
    const external = await h.wire.provider.get(internalId, h.context);
    expect(external.latestRunId).not.toBe(latestRunId);

    await h.tool("cancel", { id });
    await h.poll(id);
    expect(cancel).not.toHaveBeenCalled();
    expect(startExternalRun).toHaveBeenCalledTimes(1);
    expect(await h.state(id)).toMatchObject({
      status: "cancelled",
      latestRunId,
      followup: null,
      cancelRequested: false,
      nextPollAt: null,
    });
    expect(await h.wire.provider.get(internalId, h.context)).toMatchObject({
      status: "running",
      latestRunId: external.latestRunId,
    });
  });

  it.each(["not_found", "expired"] as const)(
    "stops polling a permanently unavailable run (%s) without leaking provider errors",
    async (reason) => {
      const h = await setup();
      const id = await h.launch();
      await h.poll(id);
      if (reason === "not_found") h.wire.failNextRequest = 404;
      else
        vi.spyOn(h.connection.provider, "get").mockRejectedValueOnce(
          new CloudAgentUnavailable(reason),
        );

      await h.poll(id);
      expect(await h.state(id)).toMatchObject({ status: "failed", nextPollAt: null });
      expect(await h.wakes()).toHaveLength(1);
      const requests = h.wire.requests.length;
      expect(await h.tool("cancel", { id })).toMatchObject({ status: "failed" });
      await h.pollNow(id);
      expect(h.wire.requests).toHaveLength(requests);
      expect(await h.wakes()).toHaveLength(1);
      expect(await h.state(id)).toMatchObject({ status: "failed", nextPollAt: null });
      const card = await prisma.message.findFirstOrThrow({
        where: { id: (await h.state(id)).messageId! },
      });
      expect(JSON.stringify(card.blocks)).not.toContain("fake-key");
    },
  );

  it("cancels a queued follow-up without dispatching it", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    await h.tool("reply", { id, prompt: "Tests" });
    await h.tool("cancel", { id });
    const requests = h.wire.requests.length;
    await h.poll(id);
    expect(h.wire.requests).toHaveLength(requests);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", followup: null });
  });

  it("recovers remote identity after the database fails following an accepted create", async () => {
    const h = await setup();
    const id = await h.launch();
    const original = h.connection.provider.launch.bind(h.connection.provider);
    vi.spyOn(h.connection.provider, "launch").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("Database unavailable"));
      return result;
    });
    await h.poll(id);
    expect((await h.state(id)).remoteId).toBeNull();
    await h.poll(id);
    expect((await h.state(id)).remoteId).toBeTruthy();
    expect(h.wire.ids.size).toBe(1);
  });

  it("fences concurrent pollers and preserves cancellation during launch", async () => {
    const h = await setup();
    const id = await h.launch();
    const entered = deferred();
    const release = deferred();
    const original = h.connection.provider.launch.bind(h.connection.provider);
    vi.spyOn(h.connection.provider, "launch").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const polling = h.poll(id);
    await entered.promise;
    await h.poll(id);
    await h.tool("cancel", { id });
    release.resolve();
    await polling;
    await h.poll(id);
    await h.poll(id);
    expect(h.wire.ids.size).toBe(1);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", cancelRequested: false });
  });

  it("rejects overlapping follow-ups and preserves remote failure as a terminal result", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    expect(await h.tool("reply", { id, prompt: "Busy" })).toHaveProperty("error");
    h.wire.complete((await h.state(id)).remoteId!, { failed: true });
    await h.poll(id);
    expect((await h.state(id)).status).toBe("failed");
    expect(await h.wakes()).toHaveLength(1);
    await h.tool("reply", { id, prompt: "Try again" });
    expect(await h.tool("reply", { id, prompt: "Duplicate" })).toHaveProperty("error");
  });

  it("marks definitive create rejection failed while retaining retryable network failures", async () => {
    const h = await setup();
    const id = await h.launch();
    h.wire.failNextRequest = 503;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", errorCount: 1 });
    h.wire.failNextRequest = 400;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", launchDispatched: true });
    expect(await h.wakes()).toHaveLength(0);

    const initial = await setup();
    const initialId = await initial.launch();
    initial.wire.failNextRequest = 400;
    await initial.poll(initialId);
    expect(await initial.state(initialId)).toMatchObject({ status: "failed", nextPollAt: null });
    expect(await initial.wakes()).toHaveLength(1);
    expect(initial.wire.ids.size).toBe(0);
  });
});
