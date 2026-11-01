import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { createDb, updateSpaceCollaborationForMember } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { messageConnectedAgent } from "./agent-connections.js";
import { messageBot, returnBotMessageOutcome } from "./bot-messages.js";
import { spawnBot } from "./child-bots.js";
import type { ExecutorDeps } from "./executor.js";
import { createRunExecutor } from "./executor.js";
import { handoffToGroupBot } from "./group-handoff.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describePostgres("Space collaboration dispatch boundaries (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const spaces: string[] = [];
  const bots: string[] = [];
  beforeAll(() => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await prisma.agentConnection.deleteMany({
        where: {
          OR: [{ requesterBotId: { in: bots } }, { targetBotId: { in: bots } }],
        },
      });
      await prisma.organization.deleteMany({ where: { id: { in: spaces } } });
      await prisma.user.deleteMany({ where: { id: { in: spaces } } });
    } finally {
      await prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function fixture() {
    const spaceId = randomUUID();
    spaces.push(spaceId);
    await prisma.user.create({
      data: {
        id: spaceId,
        name: "Collaboration owner",
        email: `${spaceId}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: {
        id: spaceId,
        name: "Collaboration fixture",
        slug: spaceId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: {
        id: spaceId,
        organizationId: spaceId,
        name: "Collaboration fixture",
        isDefault: true,
      },
    });
    await prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: spaceId,
        userId: spaceId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId, userId: spaceId } },
      update: { role: "owner" },
      create: {
        id: randomUUID(),
        spaceId,
        organizationId: spaceId,
        userId: spaceId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const addBot = async (name: string) => {
      const bot = await prisma.bot.create({
        data: {
          spaceId,
          userId: spaceId,
          name,
          color: "ink",
        },
      });
      bots.push(bot.id);
      const thread = await prisma.thread.create({
        data: { spaceId, userId: spaceId, botId: bot.id },
      });
      return { bot, thread };
    };
    const sender = await addBot("Coordinator");
    const target = await addBot("Researcher");
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId: spaceId,
        botId: sender.bot.id,
        threadId: sender.thread.id,
        prompt: "Coordinate a task",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId: spaceId,
        botId: sender.bot.id,
        threadId: sender.thread.id,
        taskId: task.id,
        trigger: "user",
        status: "running",
        startedAt: new Date(),
      },
    });
    const enqueue = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const deps = { prisma, jobs: { enqueue }, events: { notify } };
    const toggle = async (allowed: boolean) => {
      const current = await prisma.space.findUniqueOrThrow({ where: { id: spaceId } });
      return updateSpaceCollaborationForMember(prisma, {
        currentSpaceId: spaceId,
        spaceId,
        userId: spaceId,
        allowBotCollaboration: allowed,
        expectedCollaborationRevision: current.collaborationRevision,
      });
    };
    const send = (deliveryKey = "dispatch-1") =>
      messageBot(deps, run, sender.bot, {
        bot_id: target.bot.id,
        message: "Research the fixture",
        deliveryKey,
      });
    const recipientRuns = () => prisma.run.findMany({ where: { botId: target.bot.id } });
    const transcript = (threadId = sender.thread.id) =>
      prisma.message.findMany({
        where: { threadId },
        orderBy: { seq: "asc" },
      });
    return {
      spaceId,
      sender,
      target,
      run,
      deps,
      enqueue,
      notify,
      toggle,
      send,
      recipientRuns,
      transcript,
    };
  }

  async function connect(
    left: Awaited<ReturnType<typeof fixture>>,
    right: Awaited<ReturnType<typeof fixture>>,
  ) {
    const source = await prisma.messagingIdentity.create({
      data: {
        provider: "fixture",
        address: `source-${left.spaceId}`,
        botId: left.sender.bot.id,
        spaceId: left.spaceId,
        userId: left.spaceId,
      },
    });
    const target = await prisma.messagingIdentity.create({
      data: {
        provider: "fixture",
        address: `target-${right.spaceId}`,
        botId: right.sender.bot.id,
        spaceId: right.spaceId,
        userId: right.spaceId,
      },
    });
    const connection = await prisma.agentConnection.create({
      data: {
        requesterBotId: source.botId,
        targetBotId: target.botId,
        status: "approved",
      },
    });
    const send = () =>
      messageConnectedAgent(left.deps, left.run, left.sender.bot, {
        address: target.address,
        message: "Coordinate across Spaces",
        deliveryKey: "connected-1",
      });
    return { source, target, connection, send };
  }

  it("refuses delivery when the Space policy is disabled without creating messages or runs", async () => {
    const f = await fixture();
    await f.toggle(false);
    await expect(f.send()).resolves.toEqual({ ok: false, error: "policy_disabled" });
    expect(await f.recipientRuns()).toEqual([]);
    expect(await f.transcript()).toEqual([]);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("recovers a failed receipt settlement without losing recovery or dispatching twice", async () => {
    const f = await fixture();
    await messageBot(f.deps, f.run, f.sender.bot, {
      bot_id: f.target.bot.id,
      message: "An update that needs no automatic reply",
      intent: "fyi",
      deliveryKey: "settlement-recovery",
    });
    const delivery = await prisma.run.findFirstOrThrow({ where: { botId: f.target.bot.id } });
    await prisma.run.update({
      where: { id: delivery.id },
      data: { status: "completed", startedAt: new Date(), completedAt: new Date() },
    });
    const unavailable = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === "$transaction")
          return async () => {
            throw new Error("Receipt transaction unavailable");
          };
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(
      returnBotMessageOutcome({ ...f.deps, prisma: unavailable }, delivery, f.target.bot, "Done"),
    ).rejects.toThrow("Receipt transaction unavailable");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      botOutcomeReturnedAt: null,
      collaborationStatus: "waiting_peer",
    });
    await expect(returnBotMessageOutcome(f.deps, delivery, f.target.bot, "Done")).resolves.toBe(
      true,
    );
    await expect(returnBotMessageOutcome(f.deps, delivery, f.target.bot, "Done")).resolves.toBe(
      true,
    );
    expect(await prisma.run.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      botOutcomeReturnedAt: expect.any(Date),
      collaborationStatus: "completed",
    });
    expect((await f.transcript())[0]?.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_sent", deliveryStatus: "completed" }),
    ]);
    expect(await f.recipientRuns()).toHaveLength(1);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });

  it("keeps a Bot's disabled tool restriction narrower than an enabled Space", async () => {
    const f = await fixture();
    await prisma.bot.update({
      where: { id: f.sender.bot.id },
      data: { disabledBuiltinTools: ["message_bot"] },
    });
    await expect(f.send()).resolves.toEqual({ ok: false, error: "policy_disabled" });
    expect(await f.recipientRuns()).toEqual([]);
  });

  it("cancels queued delivery and its waiting card, and never replays its key after reopening", async () => {
    const f = await fixture();
    await expect(f.send()).resolves.toMatchObject({ ok: true });
    const delivery = await prisma.run.findFirstOrThrow({ where: { botId: f.target.bot.id } });
    expect(delivery).toMatchObject({
      origin: "bot_peer",
      parentRunId: f.run.id,
      collaborationSourceBotId: f.sender.bot.id,
      collaborationSourceSpaceId: f.spaceId,
      collaborationRevision: 0,
      collaborationSourceRevision: 0,
      collaborationStatus: "waiting_peer",
    });
    expect(delivery.sourceMessageId).not.toBeNull();
    await f.toggle(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: "cancelled",
      error: "policy_disabled",
      collaborationStatus: "policy_disabled",
    });
    expect((await f.transcript())[0]?.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_sent", deliveryStatus: "policy_disabled" }),
    ]);
    await f.toggle(true);
    await expect(f.send()).resolves.toEqual({ ok: false, error: "policy_disabled" });
    expect(await f.recipientRuns()).toHaveLength(1);
    expect(await f.transcript(f.target.thread.id)).toHaveLength(1);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });

  it("lets an already-started local phase finish while permanently suppressing its automatic return", async () => {
    const f = await fixture();
    await f.send();
    const delivery = await prisma.run.findFirstOrThrow({ where: { botId: f.target.bot.id } });
    await prisma.run.update({
      where: { id: delivery.id },
      data: { status: "running", startedAt: new Date() },
    });
    await f.toggle(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: "running",
      collaborationStatus: "policy_disabled",
    });
    await prisma.run.update({
      where: { id: delivery.id },
      data: { status: "completed", completedAt: new Date() },
    });
    await expect(
      returnBotMessageOutcome(f.deps, delivery, f.target.bot, "Finished locally"),
    ).resolves.toBe(true);
    await f.toggle(true);
    await expect(
      returnBotMessageOutcome(f.deps, delivery, f.target.bot, "Retry after reopening"),
    ).resolves.toBe(true);
    expect(await f.transcript()).toHaveLength(1);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: delivery.id } })).botOutcomeReturnedAt,
    ).not.toBeNull();
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });

  it("marks explicit same-Space returns as peer_return rather than human follow-up", async () => {
    const f = await fixture();
    await f.send();
    const delivery = await prisma.run.findFirstOrThrow({ where: { botId: f.target.bot.id } });
    await prisma.run.update({
      where: { id: delivery.id },
      data: { status: "running", startedAt: new Date() },
    });
    await expect(
      messageBot(f.deps, delivery, f.target.bot, {
        bot_id: f.sender.bot.id,
        message: "Research complete",
        intent: "result",
        deliveryKey: "result-1",
      }),
    ).resolves.toMatchObject({ ok: true });
    const returned = await prisma.run.findFirstOrThrow({ where: { parentRunId: delivery.id } });
    expect(returned.origin).toBe("peer_return");
    await f.toggle(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: returned.id } })).toMatchObject({
      status: "cancelled",
      error: "policy_disabled",
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "running",
      origin: "human",
    });
  });

  it.each(["source", "target"] as const)(
    "requires the %s Space for an approved connected delivery",
    async (side) => {
      const left = await fixture();
      const right = await fixture();
      const connection = await connect(left, right);
      await (side === "source" ? left : right).toggle(false);
      await expect(connection.send()).resolves.toEqual({ ok: false, error: "policy_disabled" });
      expect(await right.transcript()).toEqual([]);
      expect(left.enqueue).not.toHaveBeenCalled();
    },
  );

  it("retains the approved connection and exact receiving identity as independent requirements", async () => {
    const left = await fixture();
    const right = await fixture();
    const connection = await connect(left, right);
    await prisma.agentConnection.update({
      where: { id: connection.connection.id },
      data: { status: "revoked" },
    });
    await expect(connection.send()).resolves.toMatchObject({ ok: false });
    await prisma.agentConnection.update({
      where: { id: connection.connection.id },
      data: { status: "approved" },
    });
    await prisma.messagingIdentity.update({
      where: { id: connection.target.id },
      data: { userId: left.spaceId },
    });
    await expect(connection.send()).resolves.toEqual({ ok: false, error: "policy_disabled" });
    expect(await right.transcript()).toEqual([]);
  });

  it("rechecks identity after waiting for a recipient thread lock", async () => {
    const left = await fixture();
    const right = await fixture();
    const connection = await connect(left, right);
    const locked = deferred();
    const release = deferred();
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${right.sender.thread.id} FOR UPDATE`;
        locked.resolve();
        await release.promise;
      },
      { timeout: 10_000 },
    );
    await locked.promise;
    const pending = connection.send();
    void pending.catch(() => undefined); // The original promise is asserted below after releasing the lock.
    try {
      const deadline = Date.now() + 3_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%threads%' AND query LIKE '%FOR UPDATE%'
        `;
        if (Number(rows[0]?.waiting ?? 0) > 0) {
          waiting = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(waiting).toBe(true);
      await prisma.messagingIdentity.update({
        where: { id: connection.target.id },
        data: { address: `changed-${right.spaceId}` },
      });
    } finally {
      release.resolve();
      await blocker;
    }
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "agent identity is no longer available",
    });
    expect(await right.transcript()).toEqual([]);
    expect(left.enqueue).not.toHaveBeenCalled();
  });

  it("settles a connected delivery locally without an implicit cross-Space return", async () => {
    const left = await fixture();
    const right = await fixture();
    const connection = await connect(left, right);
    await expect(connection.send()).resolves.toMatchObject({ ok: true });
    const delivery = await prisma.run.findFirstOrThrow({ where: { parentRunId: left.run.id } });
    expect(delivery).toMatchObject({
      origin: "external_agent",
      spaceId: right.spaceId,
      userId: right.spaceId,
    });
    await prisma.run.update({
      where: { id: delivery.id },
      data: { status: "completed", startedAt: new Date(), completedAt: new Date() },
    });
    await expect(
      returnBotMessageOutcome(left.deps, delivery, right.sender.bot, "Complete"),
    ).resolves.toBe(true);
    expect(await left.transcript()).toHaveLength(1);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: delivery.id } })).botOutcomeReturnedAt,
    ).not.toBeNull();
    expect(left.enqueue).toHaveBeenCalledTimes(1);
  });

  it("keeps empty child creation available but blocks a child prompt while disabled", async () => {
    const f = await fixture();
    await f.toggle(false);
    const input = {
      spawnedBy: { ...f.sender.bot, spaceId: f.spaceId, userId: f.spaceId },
      runId: f.run.id,
      name: "Child",
      spawnKey: `empty-${f.spaceId}`,
    };
    await expect(
      spawnBot({ prisma, jobs: f.deps.jobs as unknown as JobPublisher }, input),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      spawnBot(
        { prisma, jobs: f.deps.jobs as unknown as JobPublisher },
        {
          ...input,
          spawnKey: `prompt-${f.spaceId}`,
          prompt: "Do this now",
        },
      ),
    ).resolves.toEqual({ error: "policy_disabled" });
    expect(await prisma.run.count({ where: { spaceId: f.spaceId, trigger: "spawn" } })).toBe(0);
    expect(await prisma.bot.count({ where: { spaceId: f.spaceId } })).toBe(3);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("preserves a child already created when collaboration closes before its assignment", async () => {
    const f = await fixture();
    const spawnKey = `between-stages-${f.spaceId}`;
    const created = deferred();
    const release = deferred();
    // Keep real database queries and commits. Pause only the boundary's return
    // after child creation commits, before the next transaction can dispatch.
    const boundary = new Proxy(prisma, {
      get(target, property) {
        if (property !== "$transaction") return Reflect.get(target, property);
        return async (
          callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ) => {
          const result = await target.$transaction(callback, options);
          if (
            result &&
            typeof result === "object" &&
            "spawnKey" in result &&
            result.spawnKey === spawnKey
          ) {
            created.resolve();
            await release.promise;
          }
          return result;
        };
      },
    });
    const pending = spawnBot(
      { prisma: boundary, jobs: f.deps.jobs as unknown as JobPublisher },
      {
        spawnedBy: { ...f.sender.bot, spaceId: f.spaceId, userId: f.spaceId },
        runId: f.run.id,
        name: "Child between stages",
        spawnKey,
        prompt: "Dispatch after creation",
      },
    );
    try {
      await Promise.race([
        created.promise,
        pending.then(() => {
          throw new Error("Child creation did not reach the commit barrier");
        }),
      ]);
      await f.toggle(false);
    } finally {
      release.resolve();
    }
    await expect(pending).resolves.toEqual({ error: "policy_disabled" });
    expect(await prisma.bot.count({ where: { spaceId: f.spaceId, spawnKey } })).toBe(1);
    expect(await prisma.run.count({ where: { spaceId: f.spaceId, trigger: "spawn" } })).toBe(0);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("binds a child prompt to its real parent and never replays a cancelled spawn", async () => {
    const f = await fixture();
    const input = {
      spawnedBy: { ...f.sender.bot, spaceId: f.spaceId, userId: f.spaceId },
      runId: f.run.id,
      name: "Child",
      spawnKey: `prompt-${f.spaceId}`,
      prompt: "Do this now",
    };
    await expect(
      spawnBot({ prisma, jobs: f.deps.jobs as unknown as JobPublisher }, input),
    ).resolves.toMatchObject({ ok: true });
    const delivery = await prisma.run.findFirstOrThrow({ where: { parentRunId: f.run.id } });
    expect(delivery).toMatchObject({
      origin: "child_prompt",
      collaborationSourceBotId: f.sender.bot.id,
    });
    expect(delivery.sourceMessageId).not.toBeNull();
    await f.toggle(false);
    await f.toggle(true);
    expect((await f.transcript())[0]?.blocks).toEqual([
      expect.objectContaining({ kind: "child_bot", deliveryStatus: "policy_disabled" }),
    ]);
    await expect(
      spawnBot({ prisma, jobs: f.deps.jobs as unknown as JobPublisher }, input),
    ).resolves.toEqual({ error: "policy_disabled" });
    expect(await prisma.run.count({ where: { parentRunId: f.run.id } })).toBe(1);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });

  it("records group origin without cancelling an unrelated human follow_up", async () => {
    const f = await fixture();
    const group = await prisma.chatGroup.create({
      data: {
        spaceId: f.spaceId,
        userId: f.spaceId,
        name: "Collaboration group",
        members: { create: [{ botId: f.sender.bot.id }, { botId: f.target.bot.id }] },
      },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: f.spaceId, userId: f.spaceId, groupId: group.id },
    });
    await prisma.run.update({ where: { id: f.run.id }, data: { threadId: thread.id } });
    const groupRun = { ...f.run, threadId: thread.id };
    const humanTask = await prisma.task.create({
      data: {
        spaceId: f.spaceId,
        userId: f.spaceId,
        botId: f.target.bot.id,
        threadId: thread.id,
        prompt: "Human follow-up",
        status: "queued",
      },
    });
    const human = await prisma.run.create({
      data: {
        spaceId: f.spaceId,
        userId: f.spaceId,
        botId: f.target.bot.id,
        threadId: thread.id,
        taskId: humanTask.id,
        status: "queued",
        trigger: "follow_up",
      },
    });
    await expect(
      handoffToGroupBot(f.deps, groupRun, group.id, {
        bot_id: f.target.bot.id,
        message: "Take the next stage",
      }),
    ).resolves.toMatchObject({ ok: true });
    const peer = await prisma.run.findFirstOrThrow({ where: { parentRunId: f.run.id } });
    expect(peer).toMatchObject({ origin: "group_handoff", trigger: "follow_up" });
    await f.toggle(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: peer.id } })).toMatchObject({
      status: "cancelled",
      error: "policy_disabled",
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: human.id } })).toMatchObject({
      status: "queued",
      origin: "human",
    });
    expect((await f.transcript(thread.id))[0]?.blocks).toEqual([
      expect.objectContaining({ kind: "handoff", deliveryStatus: "policy_disabled" }),
    ]);
  });

  it("rechecks a queued peer's current policy before the real executor can dispatch a model", async () => {
    const f = await fixture();
    await f.send();
    const delivery = await prisma.run.findFirstOrThrow({ where: { botId: f.target.bot.id } });
    // Represents a recovered queue whose current policy no longer grants dispatch.
    await prisma.space.update({ where: { id: f.spaceId }, data: { allowBotCollaboration: false } });
    const execute = vi.fn();
    const executor = createRunExecutor({
      prisma,
      events: f.deps.events,
      jobs: f.deps.jobs,
      runtime: { describe: () => ({ capabilities: { scripted: false } }), run: execute },
      web: {},
      browser: {},
      sandbox: {},
    } as unknown as ExecutorDeps);
    await executor.continueRun(delivery.id, "collaboration-worker");
    expect(execute).not.toHaveBeenCalled();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: "cancelled",
      error: "policy_disabled",
      startedAt: null,
    });
  });
});
