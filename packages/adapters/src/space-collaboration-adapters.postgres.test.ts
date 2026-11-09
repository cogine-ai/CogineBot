import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { stuckWorkStatusMessages } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  authorizeCollaborationRunStart,
  cancelRunsInTransaction,
  claimDelegatedApprovedEffect,
  createDb,
  createThreadEvents,
  loadDelegatedApprovals,
  loadThreadAttention,
  recheckDelegatedApprovalDispatch,
  updateSpaceCollaborationForMember,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  connectAgent,
  messageConnectedAgent,
  prepareAgentConnectionResponse,
  respondAgentConnection,
} from "./agent-connections.js";
import { buildApprovalAskBlock } from "./approval-ask.js";
import {
  approvedActionReceipt,
  approvedReplayArgs,
  claimApprovedEffect,
  completeExternalEffect,
} from "./approval-effect.js";
import { messageBot, returnBotMessageOutcome } from "./bot-messages.js";
import { spawnBot } from "./child-bots.js";
import type { ExecutorDeps } from "./executor.js";
import { createRunExecutor } from "./executor.js";
import { handoffToGroupBot } from "./group-handoff.js";
import { createJobReconciler } from "./job-reconciler.js";
import { InMemoryRealtimeFanout } from "./realtime.js";

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
  const connectionInvites = new Set<string>();
  beforeAll(() => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
  });
  afterEach(async () => {
    if (!connectionInvites.size) return;
    await prisma.messagingOutbound.deleteMany({
      where: { idempotencyKey: { in: [...connectionInvites] } },
    });
    connectionInvites.clear();
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

  async function linkConnectionPeers(
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
    return { source, target };
  }

  async function connect(
    left: Awaited<ReturnType<typeof fixture>>,
    right: Awaited<ReturnType<typeof fixture>>,
  ) {
    const { source, target } = await linkConnectionPeers(left, right);
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

  it("keeps a reopened connection pending when an older response was already in flight", async () => {
    const left = await fixture();
    const right = await fixture();
    const { target } = await linkConnectionPeers(left, right);
    const inviteKey = `connect:${left.sender.bot.id}:${target.botId}`;
    connectionInvites.add(inviteKey);
    const ask = () =>
      connectAgent(left.deps, left.run, left.sender.bot, { address: target.address });
    const readConnection = () =>
      prisma.agentConnection.findUniqueOrThrow({
        where: {
          requesterBotId_targetBotId: {
            requesterBotId: left.sender.bot.id,
            targetBotId: right.sender.bot.id,
          },
        },
      });
    const readInvite = () =>
      prisma.messagingOutbound.findUniqueOrThrow({
        where: { idempotencyKey: inviteKey },
      });

    await expect(ask()).resolves.toEqual({ ok: true, status: "pending" });
    const first = await readConnection();
    expect(first).toMatchObject({ status: "pending", requestVersion: 1 });
    const firstInvite = await readInvite();
    await expect(ask()).resolves.toEqual({ ok: true, status: "pending" });
    expect(await readConnection()).toMatchObject({ id: first.id, requestVersion: 1 });
    expect(await readInvite()).toMatchObject({ id: firstInvite.id });

    const snapshot = await prepareAgentConnectionResponse(prisma, right.sender.bot.id, true);
    expect(snapshot).toEqual({
      accept: true,
      connection_id: first.id,
      connection_version: 1,
      requester_name: left.sender.bot.name,
      requester_address: `source-${left.spaceId}`,
      requester_provider: "fixture",
    });
    const observed = deferred();
    const release = deferred();
    const pausedClient = prisma.$extends({
      query: {
        agentConnection: {
          async findFirst({ args, query }) {
            const result = await query(args);
            if (args.where?.id === first.id) {
              observed.resolve();
              await release.promise;
            }
            return result;
          },
        },
      },
    }) as unknown as PrismaClient;
    const initialResponse = { connectionId: first.id, connectionVersion: 1 };
    const stale = respondAgentConnection(
      { ...right.deps, prisma: pausedClient },
      right.run,
      right.sender.bot,
      { ...initialResponse, accept: true },
    );
    try {
      await Promise.race([
        observed.promise,
        stale.then(() => {
          throw new Error("Expected the response to read the observed request");
        }),
      ]);
      await expect(
        respondAgentConnection(right.deps, right.run, right.sender.bot, {
          ...initialResponse,
          accept: false,
        }),
      ).resolves.toEqual({ ok: true, status: "declined" });
      expect(await readConnection()).toMatchObject({
        id: first.id,
        status: "declined",
        requestVersion: 1,
      });
      await expect(ask()).resolves.toEqual({ ok: true, status: "pending" });
    } finally {
      release.resolve();
    }

    await expect(stale).resolves.toMatchObject({ ok: false });
    expect(await readConnection()).toMatchObject({
      id: first.id,
      status: "pending",
      requestVersion: 2,
    });
    const secondInvite = await readInvite();
    expect(secondInvite.id).not.toBe(firstInvite.id);
    await expect(ask()).resolves.toEqual({ ok: true, status: "pending" });
    expect(await readConnection()).toMatchObject({ id: first.id, requestVersion: 2 });
    expect(await readInvite()).toMatchObject({ id: secondInvite.id });

    await expect(
      respondAgentConnection(right.deps, right.run, right.sender.bot, {
        ...initialResponse,
        connectionVersion: 2,
        accept: true,
      }),
    ).resolves.toEqual({ ok: true, status: "approved" });
  });

  it("advances the connection version on a status-only reopen from a previous release", async () => {
    const left = await fixture();
    const right = await fixture();
    const { target } = await linkConnectionPeers(left, right);
    connectionInvites.add(`connect:${left.sender.bot.id}:${target.botId}`);
    await expect(
      connectAgent(left.deps, left.run, left.sender.bot, { address: target.address }),
    ).resolves.toEqual({ ok: true, status: "pending" });
    const connection = await prisma.agentConnection.findFirstOrThrow({
      where: { requesterBotId: left.sender.bot.id, targetBotId: right.sender.bot.id },
    });
    expect(connection.requestVersion).toBe(1);

    await prisma.agentConnection.update({
      where: { id: connection.id },
      data: { status: "revoked", revocationVersion: connection.requestVersion },
    });
    // The previous application image only wrote status and updatedAt on reopen.
    await prisma.agentConnection.update({
      where: { id: connection.id },
      data: { status: "pending" },
    });
    await prisma.agentConnection.update({
      where: { id: connection.id },
      data: { status: "pending" },
    });
    await expect(
      respondAgentConnection(right.deps, right.run, right.sender.bot, {
        accept: true,
        connectionId: connection.id,
        connectionVersion: connection.requestVersion,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(
      await prisma.agentConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).toMatchObject({
      status: "pending",
      requestVersion: 2,
    });
  });

  it("refuses unversioned decisions from an older application on both fresh and reopened requests", async () => {
    const left = await fixture();
    const right = await fixture();
    const fresh = await prisma.agentConnection.create({
      data: {
        requesterBotId: left.sender.bot.id,
        targetBotId: right.sender.bot.id,
        status: "pending",
      },
    });
    const closed = await prisma.agentConnection.create({
      data: {
        requesterBotId: left.target.bot.id,
        targetBotId: right.sender.bot.id,
        status: "revoked",
      },
    });
    const reopened = await prisma.agentConnection.update({
      where: { id: closed.id },
      data: { status: "pending" },
    });
    expect([fresh.requestVersion, reopened.requestVersion]).toEqual([1, 2]);
    for (const request of [fresh, reopened]) {
      for (const status of ["approved", "declined"]) {
        // The previous executor sends only the resolved id and pending status.
        await expect(
          prisma.agentConnection.updateMany({
            where: { id: request.id, status: "pending" },
            data: { status },
          }),
        ).resolves.toEqual({ count: 0 });
      }
      await expect(
        prisma.agentConnection.updateMany({
          where: { id: request.id, status: "pending" },
          data: { status: "approved", responseVersion: request.requestVersion + 1 },
        }),
      ).resolves.toEqual({ count: 0 });
    }
    await expect(
      respondAgentConnection(right.deps, right.run, right.sender.bot, {
        accept: true,
        connectionId: fresh.id,
        connectionVersion: fresh.requestVersion,
      }),
    ).resolves.toMatchObject({ ok: true, status: "approved" });
    await expect(
      respondAgentConnection(right.deps, right.run, right.sender.bot, {
        accept: false,
        connectionId: reopened.id,
        connectionVersion: reopened.requestVersion,
      }),
    ).resolves.toMatchObject({ ok: true, status: "declined" });
    for (const request of [fresh, reopened]) {
      expect(
        await prisma.agentConnection.findUniqueOrThrow({ where: { id: request.id } }),
      ).toMatchObject({ responseVersion: request.requestVersion });
    }
    const next = await prisma.agentConnection.update({
      where: { id: reopened.id },
      data: { status: "pending" },
    });
    expect(next).toMatchObject({ status: "pending", requestVersion: 3, responseVersion: null });
    await expect(
      prisma.agentConnection.updateMany({
        where: { id: next.id, status: "pending" },
        data: { status: "approved", responseVersion: 2 },
      }),
    ).resolves.toEqual({ count: 0 });
  });

  it("requires the current revocation version even on approved or reopened connections", async () => {
    const left = await fixture();
    const right = await fixture();
    const connection = await prisma.agentConnection.create({
      data: {
        requesterBotId: left.sender.bot.id,
        targetBotId: right.sender.bot.id,
        status: "pending",
      },
    });
    const approve = (requestVersion: number) =>
      respondAgentConnection(right.deps, right.run, right.sender.bot, {
        accept: true,
        connectionId: connection.id,
        connectionVersion: requestVersion,
      });
    const legacyRevoke = (status: string) =>
      prisma.agentConnection.updateMany({
        where: { id: connection.id, status },
        data: { status: "revoked" },
      });
    const currentRevoke = (requestVersion: number) =>
      prisma.agentConnection.updateMany({
        where: { id: connection.id, status: "approved", requestVersion },
        data: { status: "revoked", revocationVersion: requestVersion },
      });
    const readConnection = () =>
      prisma.agentConnection.findUniqueOrThrow({ where: { id: connection.id } });

    await expect(legacyRevoke("pending")).resolves.toEqual({ count: 0 });
    await expect(approve(1)).resolves.toMatchObject({ ok: true, status: "approved" });
    await expect(legacyRevoke("approved")).resolves.toEqual({ count: 0 });
    await expect(currentRevoke(1)).resolves.toEqual({ count: 1 });
    await expect(legacyRevoke("revoked")).resolves.toEqual({ count: 1 });
    await expect(readConnection()).resolves.toMatchObject({
      status: "revoked",
      requestVersion: 1,
      responseVersion: 1,
      revocationVersion: 1,
    });

    const reopened = await prisma.agentConnection.update({
      where: { id: connection.id },
      data: { status: "pending" },
    });
    expect(reopened).toMatchObject({
      status: "pending",
      requestVersion: 2,
      responseVersion: null,
      revocationVersion: null,
    });
    await expect(approve(2)).resolves.toMatchObject({ ok: true, status: "approved" });
    await expect(legacyRevoke("approved")).resolves.toEqual({ count: 0 });
    await expect(
      prisma.agentConnection.updateMany({
        where: { id: connection.id, status: "approved" },
        data: { status: "revoked", revocationVersion: 1 },
      }),
    ).resolves.toEqual({ count: 0 });
    await expect(readConnection()).resolves.toMatchObject({
      status: "approved",
      requestVersion: 2,
      responseVersion: 2,
      revocationVersion: null,
    });
    await expect(currentRevoke(2)).resolves.toEqual({ count: 1 });
    await expect(readConnection()).resolves.toMatchObject({
      status: "revoked",
      requestVersion: 2,
      responseVersion: 2,
      revocationVersion: 2,
    });
  });

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

  it.each([null, "Stopped by user"])(
    "settles ordinary cancelled bot deliveries silently with error %s",
    async (error) => {
      const f = await fixture();
      await f.send();
      const delivery = await prisma.run.findFirstOrThrow({ where: { botId: f.target.bot.id } });
      const events = createThreadEvents(prisma);
      if (error)
        await prisma.$transaction((tx) => cancelRunsInTransaction(tx, [delivery], new Date()));
      else
        await events.clearThread({
          spaceId: f.spaceId,
          threadId: f.target.thread.id,
          botId: f.target.bot.id,
        });
      if (error) await prisma.run.update({ where: { id: delivery.id }, data: { error } });
      expect(await prisma.message.count({ where: { id: delivery.sourceMessageId! } })).toBe(
        error ? 1 : 0,
      );
      const jobs: JobPublisher = {
        enqueue: f.enqueue,
        cancel: async () => undefined,
        close: async () => undefined,
      };
      const reconciler = createJobReconciler({ prisma, jobs, events });
      await reconciler.reconcileOnce();
      await reconciler.reconcileOnce();
      expect(await prisma.run.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
        status: "cancelled",
        error,
        collaborationStatus: "completed",
      });
      expect((await f.transcript())[0]?.blocks).toEqual([
        expect.objectContaining({ kind: "bot_message_sent", deliveryStatus: "completed" }),
      ]);
      expect(await f.transcript()).toHaveLength(1);
      expect(await f.recipientRuns()).toHaveLength(1);
      expect(f.enqueue).toHaveBeenCalledTimes(1);
    },
  );

  it("retains stuck cancellation outcome delivery without replaying it on recovery", async () => {
    const f = await fixture();
    await f.send();
    const delivery = await prisma.run.findFirstOrThrow({ where: { botId: f.target.bot.id } });
    await prisma.run.update({
      where: { id: delivery.id },
      data: {
        status: "cancelled",
        startedAt: new Date(),
        completedAt: new Date(),
        error: stuckWorkStatusMessages()[0],
      },
    });
    const jobs: JobPublisher = {
      enqueue: f.enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const reconciler = createJobReconciler({ prisma, jobs, events: createThreadEvents(prisma) });
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: "cancelled",
      collaborationStatus: "completed",
      botOutcomeReturnedAt: expect.any(Date),
    });
    expect(
      await prisma.run.count({ where: { parentRunId: delivery.id, origin: "peer_return" } }),
    ).toBe(1);
    expect(await f.transcript()).toHaveLength(2);
  });

  it("keeps later receipts recoverable when the oldest settlement repeatedly fails", async () => {
    const f = await fixture();
    await f.send("blocked-settlement");
    await f.send("healthy-settlement");
    const deliveries = await prisma.run.findMany({
      where: { parentRunId: f.run.id },
      orderBy: { createdAt: "asc" },
    });
    expect(deliveries).toHaveLength(2);
    const blocked = deliveries[0]!;
    const healthy = deliveries[1]!;
    for (const [index, delivery] of deliveries.entries())
      await prisma.run.update({
        where: { id: delivery.id },
        data: {
          status: "cancelled",
          completedAt: new Date(),
          updatedAt: new Date(index === 0 ? "2000-01-01T00:00:00Z" : "2001-01-01T00:00:00Z"),
        },
      });
    let failBlocked = true;
    const interrupted = new Proxy(prisma, {
      get(target, property) {
        if (property !== "$transaction") return Reflect.get(target, property);
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(current, name) {
                  if (name !== "run") return Reflect.get(current, name);
                  return new Proxy(current.run, {
                    get(delegate, method) {
                      if (method !== "findUnique") return Reflect.get(delegate, method);
                      return (args: Prisma.RunFindUniqueArgs) => {
                        if (failBlocked && args.where.id === blocked.id)
                          throw new Error("Receipt storage unavailable for this delivery");
                        return delegate.findUnique(args);
                      };
                    },
                  });
                },
              }),
            ),
          );
      },
    });
    const jobs: JobPublisher = {
      enqueue: f.enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const reconciler = createJobReconciler(
      { prisma: interrupted, jobs, events: createThreadEvents(prisma) },
      { batchSize: 1 },
    );
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: blocked.id } })).toMatchObject({
      status: "cancelled",
      collaborationStatus: "waiting_peer",
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: healthy.id } })).toMatchObject({
      status: "cancelled",
      collaborationStatus: "completed",
    });
    failBlocked = false;
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: blocked.id } })).toMatchObject({
      status: "cancelled",
      collaborationStatus: "completed",
    });
    expect(await f.transcript()).toHaveLength(2);
    expect(await prisma.run.count({ where: { parentRunId: f.run.id } })).toBe(2);
  });

  it("returns a delegated result when the worker cannot invoke the messaging tool", async () => {
    const f = await fixture();
    await f.send();
    const delivery = await prisma.run.findFirstOrThrow({ where: { botId: f.target.bot.id } });
    await prisma.run.update({
      where: { id: delivery.id },
      data: { status: "running", startedAt: new Date() },
    });
    await prisma.bot.update({
      where: { id: f.target.bot.id },
      data: { disabledBuiltinTools: ["message_bot"] },
    });
    await expect(
      messageBot(f.deps, delivery, f.target.bot, {
        bot_id: f.sender.bot.id,
        message: "An explicit tool call",
        intent: "result",
        deliveryKey: "explicit-blocked-result",
      }),
    ).resolves.toMatchObject({ ok: false, error: "policy_disabled" });
    await prisma.run.update({
      where: { id: delivery.id },
      data: { status: "completed", completedAt: new Date() },
    });
    await expect(
      returnBotMessageOutcome(f.deps, delivery, f.target.bot, "The authorized result"),
    ).resolves.toBe(true);
    const returned = await prisma.run.findFirstOrThrow({
      where: { parentRunId: delivery.id, origin: "peer_return" },
    });
    await expect(
      prisma.$transaction((tx) => authorizeCollaborationRunStart(tx, returned.id)),
    ).resolves.toMatchObject({ allowed: true });
    expect(await f.transcript()).toHaveLength(2);
    await f.toggle(false);
    await f.toggle(true);
    await expect(
      prisma.$transaction((tx) => authorizeCollaborationRunStart(tx, returned.id)),
    ).resolves.toMatchObject({ allowed: false });
  });

  it.each(["automatic", "explicit"] as const)(
    "rechecks a queued %s result after the worker messaging tool is disabled",
    async (kind) => {
      const f = await fixture();
      await f.send();
      const delivery = await prisma.run.findFirstOrThrow({ where: { botId: f.target.bot.id } });
      await prisma.run.update({
        where: { id: delivery.id },
        data: { status: "running", startedAt: new Date() },
      });
      if (kind === "explicit")
        await expect(
          messageBot(f.deps, delivery, f.target.bot, {
            bot_id: f.sender.bot.id,
            message: "Explicit result",
            intent: "result",
            deliveryKey: "explicit-result-effect",
          }),
        ).resolves.toMatchObject({ ok: true });
      await prisma.run.update({
        where: { id: delivery.id },
        data: { status: "completed", completedAt: new Date() },
      });
      if (kind === "automatic")
        await expect(
          returnBotMessageOutcome(f.deps, delivery, f.target.bot, "Automatic result"),
        ).resolves.toBe(true);
      const returned = await prisma.run.findFirstOrThrow({
        where: { parentRunId: delivery.id, origin: "peer_return" },
      });
      await prisma.bot.update({
        where: { id: f.target.bot.id },
        data: { disabledBuiltinTools: ["message_bot"] },
      });
      await expect(
        prisma.$transaction((tx) => authorizeCollaborationRunStart(tx, returned.id)),
      ).resolves.toMatchObject({ allowed: kind === "automatic" });
    },
  );

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
      data: { status: "revoked", revocationVersion: connection.connection.requestVersion },
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
  describe("delegated approvals", () => {
    const approvalSpaces = new Set<string>();
    async function approvalSpace() {
      const f = await fixture();
      approvalSpaces.add(f.spaceId);
      return f;
    }
    afterEach(async () => {
      await prisma.organization.deleteMany({ where: { id: { in: [...approvalSpaces] } } });
      await prisma.user.deleteMany({ where: { id: { in: [...approvalSpaces] } } });
      approvalSpaces.clear();
    });
    async function delegatedFixture(initialKind = "destination.write") {
      const f = await approvalSpace();
      await expect(f.send()).resolves.toMatchObject({ ok: true });
      const [run] = await f.recipientRuns();
      if (!run?.collaborationMessageId || !run.sourceMessageId) throw new Error("Dispatch missing");
      const source = {
        spaceId: f.spaceId,
        userId: f.spaceId,
        botId: f.sender.bot.id,
        threadId: f.sender.thread.id,
      };
      const dispatchMessageId = run.collaborationMessageId;
      const session = await prisma.session.create({
        data: {
          id: randomUUID(),
          userId: source.userId,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await prisma.run.update({ where: { id: f.run.id }, data: { status: "completed" } });
      const realtime = new InMemoryRealtimeFanout();
      const events = createThreadEvents(prisma, realtime);
      const pause = async (kind = "destination.write", screen = false) => {
        const request = {
          collection: "notes",
          title: "Reviewed",
          body: "original approved arguments",
        };
        const effect = await prisma.externalEffect.create({
          data: {
            idempotencyKey: randomUUID(),
            spaceId: f.spaceId,
            runId: run.id,
            kind,
            status: "intended",
            request,
          },
        });
        const attempt = await prisma.attempt.create({
          data: { runId: run.id, status: "running", fence: 1 },
        });
        await prisma.run.update({
          where: { id: run.id },
          data: {
            status: "running",
            startedAt: new Date(),
            leaseFence: 1,
            leaseOwner: "fixture-worker",
          },
        });
        const ask = buildApprovalAskBlock(effect.id, kind, request, []);
        const block = screen ? { ...ask, reviewMode: "screen" as const } : ask;
        expect(
          await events.pauseRunForInput({
            spaceId: f.spaceId,
            botId: run.botId,
            threadId: run.threadId,
            runId: run.id,
            leaseOwner: "fixture-worker",
            leaseFence: 1,
            attemptId: attempt.id,
            blocks: [block],
          }),
        ).toBe(true);
        const message = await prisma.message.findFirstOrThrow({
          where: { threadId: run.threadId, runId: run.id, role: "bot" },
          orderBy: { seq: "desc" },
        });
        return { effect, message, block, request };
      };
      const { effect, message, block, request } = await pause(initialKind);
      const target = {
        runId: run.id,
        messageId: message.id,
        effectId: effect.id,
        dispatchMessageId,
      };
      const query = (overrides: Partial<typeof source> = {}, ids = [dispatchMessageId]) =>
        loadDelegatedApprovals(prisma, { ...source, ...overrides }, ids);
      const answer = (
        action: "allow" | "deny" | "always",
        override: Partial<typeof target> = {},
        clientNonce = randomUUID(),
      ) =>
        events.answerDelegatedApproval({
          ...source,
          ...target,
          ...override,
          action,
          clientNonce,
          sessionId: session.id,
        });
      const activate = () =>
        prisma.run.update({
          where: { id: run.id },
          data: {
            status: "running",
            leaseFence: 2,
            leaseOwner: "resumed-worker",
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
      const claim = () =>
        claimDelegatedApprovedEffect(prisma, {
          spaceId: source.spaceId,
          runId: run.id,
          effectId: effect.id,
          leaseOwner: "resumed-worker",
          leaseFence: 2,
        });
      const recheck = () =>
        recheckDelegatedApprovalDispatch(prisma, {
          spaceId: source.spaceId,
          runId: run.id,
          effectId: effect.id,
          leaseOwner: "resumed-worker",
          leaseFence: 2,
        });
      return {
        f,
        run,
        source,
        dispatchMessageId,
        effect,
        message,
        block,
        request,
        target,
        query,
        answer,
        events,
        realtime,
        pause,
        session,
        activate,
        claim,
        recheck,
      };
    }

    it("projects the original approval after the sender completes and wakes its own cursor-free stream", async () => {
      const t = await delegatedFixture();
      expect(await t.query()).toEqual([
        expect.objectContaining({
          ...t.target,
          botId: t.run.botId,
          state: "pending",
          block: t.block,
        }),
      ]);
      const abort = new AbortController();
      const cursor = (
        await prisma.event.findFirstOrThrow({
          where: { threadId: t.source.threadId },
          orderBy: { seq: "desc" },
        })
      ).seq;
      const subscribed = deferred();
      const subscribe = t.realtime.subscribe.bind(t.realtime);
      t.realtime.subscribe = async (...args) => {
        const unsubscribe = await subscribe(...args);
        subscribed.resolve();
        return unsubscribe;
      };
      const stream = t.events.follow(t.source.threadId, cursor, abort.signal, {
        botId: t.source.botId,
        spaceId: t.source.spaceId,
      });
      try {
        const next = stream.next();
        await subscribed.promise;
        expect(await t.answer("allow")).toBe("accepted");
        expect((await next).value).toMatchObject({
          type: "heartbeat",
          threadId: t.source.threadId,
          seq: 0,
          payload: {},
        });
        expect(await t.answer("allow")).toBe("already_answered");
        expect(await t.answer("deny")).toBe("conflict");
      } finally {
        abort.abort();
        await stream.return(undefined);
      }
      expect(await prisma.run.findUnique({ where: { id: t.f.run.id } })).toMatchObject({
        status: "completed",
      });
      expect(await prisma.run.findUnique({ where: { id: t.run.id } })).toMatchObject({
        status: "queued",
      });
      const enqueue = vi.fn(async () => undefined);
      const jobs: JobPublisher = { enqueue, cancel: async () => {}, close: async () => {} };
      await createJobReconciler({ prisma, jobs, events: t.events }).reconcileOnce();
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "run.continue", payload: { runId: t.run.id } }),
      );
      expect(await t.query()).toMatchObject([{ state: "allowed" }]);
      const approved = await prisma.externalEffect.findUniqueOrThrow({
        where: { id: t.effect.id },
      });
      expect(approvedReplayArgs(approved.request, { body: "changed later" }, "fixture")).toEqual(
        t.request,
      );
      await t.activate();
      expect(await Promise.all([t.claim(), t.claim()])).toEqual(
        expect.arrayContaining([true, false]),
      );
      const url = "https://example.com/posts/123";
      const receipt = { data: { url, privateResult: "do not return" }, logId: "fixture-log" };
      expect(
        await completeExternalEffect(
          prisma,
          t.effect.id,
          "executing",
          receipt,
          approvedActionReceipt(receipt, "result"),
        ),
      ).toBe(true);
      expect(await t.query()).toMatchObject([{ state: "succeeded", receiptUrl: url }]);
      expect(JSON.stringify(await t.query())).not.toContain("privateResult");
      expect(
        await prisma.event.count({ where: { threadId: t.source.threadId, seq: { gt: cursor } } }),
      ).toBe(0);
    });

    it.each(["dispatch", "execution"] as const)(
      "rechecks collaboration after approval in the %s chat",
      async (entry) => {
        const t = await delegatedFixture();
        if (entry === "dispatch") {
          expect(await t.answer("allow")).toBe("accepted");
        } else {
          expect(
            await t.events.answerRunInput({
              spaceId: t.source.spaceId,
              threadId: t.run.threadId,
              answeredByUserId: t.source.userId,
              runId: t.run.id,
              messageId: t.message.id,
              answer: "allow",
            }),
          ).toBe(true);
        }
        await t.f.toggle(false);
        await t.f.toggle(true);
        await t.activate();
        expect(await t.claim()).toBe(false);
        expect(await t.claim()).toBe(false);
        expect(
          await prisma.externalEffect.findUniqueOrThrow({ where: { id: t.effect.id } }),
        ).toMatchObject({ status: "completed", result: { code: "delegated_approval_revoked" } });
        expect(await t.query()).toMatchObject([{ state: "failed" }]);
      },
    );

    it("blocks effect claim if Stop cancels the resumed lease", async () => {
      const t = await delegatedFixture();
      expect(await t.answer("allow")).toBe("accepted");
      await t.activate();
      await prisma.$transaction((tx) => cancelRunsInTransaction(tx, [t.run], new Date()));
      expect(await t.claim()).toBe(false);
      expect(await t.query()).toMatchObject([{ state: "inactive" }]);
    });

    it("rechecks collaboration after claim if adapter preflight has not dispatched the action", async () => {
      const t = await delegatedFixture();
      expect(await t.answer("allow")).toBe("accepted");
      await t.activate();
      expect(await t.claim()).toBe(true);
      expect(await t.recheck()).toBe(true);
      await t.f.toggle(false);
      expect(await prisma.run.findUnique({ where: { id: t.run.id } })).toMatchObject({
        status: "running",
        leaseOwner: "resumed-worker",
      });
      expect(await t.recheck()).toBe(false);
    });

    it.each(["destination.write", "request_secret", "request_takeover"])(
      "keeps protected tool approvals in the execution chat when upgrading %s",
      async (kind) => {
        const t = await delegatedFixture(kind);
        const ordinary = kind === "destination.write";
        if (ordinary) {
          expect(await t.answer("allow")).toBe("accepted");
        } else {
          expect(await t.query()).toEqual([]);
          expect(await t.answer("allow")).toBe("conflict");
          expect(
            await t.events.answerRunInput({
              spaceId: t.source.spaceId,
              threadId: t.run.threadId,
              answeredByUserId: t.source.userId,
              runId: t.run.id,
              messageId: t.message.id,
              answer: "allow",
            }),
          ).toBe(true);
          expect(await t.answer("allow")).toBe("conflict");
          expect(await t.query()).toEqual([]);
          expect(
            await prisma.externalEffect.findUniqueOrThrow({ where: { id: t.effect.id } }),
          ).toMatchObject({ status: "approved", requiresPeerApprovalRecheck: false });
        }
        const sql = await readFile(
          new URL(
            "../../db/prisma/migrations/20261109000800_delegated_approval_receipts/migration.sql",
            import.meta.url,
          ),
          "utf8",
        );
        const update = sql
          .slice(sql.indexOf('UPDATE "external_effects"'), sql.lastIndexOf("COMMIT;"))
          .trim();
        const rollback = new Error("discard the legacy approval fixture");
        await expect(
          prisma.$transaction(async (tx) => {
            await tx.externalEffect.update({
              where: { id: t.effect.id },
              data: { requiresPeerApprovalRecheck: false, delegatedApprovalNonce: null },
            });
            await tx.$executeRawUnsafe(update);
            expect(
              await tx.externalEffect.findUniqueOrThrow({ where: { id: t.effect.id } }),
            ).toMatchObject({ status: "approved", requiresPeerApprovalRecheck: ordinary });
            throw rollback;
          }),
        ).rejects.toBe(rollback);
      },
    );

    it("does not let a nonce from a previous decision authorize a second action", async () => {
      const t = await delegatedFixture();
      const nonce = randomUUID();
      expect(await t.answer("allow", {}, nonce)).toBe("accepted");
      expect(await t.answer("allow", {}, nonce)).toBe("already_answered");
      const next = await t.pause();
      const target = { effectId: next.effect.id, messageId: next.message.id };
      expect(await t.answer("allow", target, nonce)).toBe("conflict");
      expect(await t.answer("deny", target)).toBe("accepted");
    });

    it("serializes the original and delegated responses and preserves the first decision", async () => {
      const t = await delegatedFixture();
      const [fromA, fromB] = await Promise.all([
        t.answer("deny"),
        t.events.answerRunInput({
          spaceId: t.source.spaceId,
          threadId: t.run.threadId,
          answeredByUserId: t.source.userId,
          runId: t.run.id,
          messageId: t.message.id,
          answer: "allow",
        }),
      ]);
      expect(Number(fromA === "accepted") + Number(fromB)).toBe(1);
      const decision = fromB ? "allow" : "deny";
      expect(await t.answer(decision)).toBe("already_answered");
      expect(await t.answer(fromB ? "deny" : "allow")).toBe("conflict");
      expect(await t.query()).toMatchObject([{ state: fromB ? "allowed" : "denied" }]);
      expect(
        await prisma.event.count({
          where: { runId: t.run.id, type: "thread.message.updated" },
        }),
      ).toBe(1);
    });

    it("rejects forged sources and isolates special and superseded approvals", async () => {
      const t = await delegatedFixture();
      const unrelated = await approvalSpace();
      expect(await t.query({ userId: unrelated.spaceId })).toEqual([]);
      expect(await t.query({ spaceId: unrelated.spaceId })).toEqual([]);
      expect(await t.query({}, [t.message.id])).toEqual([]);
      expect(await t.answer("allow", { runId: unrelated.run.id })).toBe("conflict");
      expect(await t.answer("allow", { effectId: randomUUID() })).toBe("conflict");
      const screen = await t.pause("save_page", true);
      expect(await t.query()).toMatchObject([{ effectId: t.effect.id, state: "inactive" }]);
      expect(await t.answer("allow")).toBe("conflict");
      expect(
        await t.events.answerRunInput({
          spaceId: t.source.spaceId,
          threadId: t.run.threadId,
          runId: t.run.id,
          messageId: t.message.id,
          answeredByUserId: t.source.userId,
          answer: "allow",
        }),
      ).toBe(false);
      expect(
        await t.answer("allow", { messageId: screen.message.id, effectId: screen.effect.id }),
      ).toBe("conflict");
      const latest = await t.pause();
      const attention = await loadThreadAttention(prisma, [t.run.threadId]);
      expect(attention.get(t.run.threadId)?.answerableApprovalMessageIds).toEqual([
        latest.message.id,
      ]);
      expect(await t.query()).toMatchObject([
        { effectId: t.effect.id, state: "inactive" },
        { effectId: latest.effect.id, state: "pending" },
      ]);
      expect(
        await t.answer("deny", { messageId: latest.message.id, effectId: latest.effect.id }),
      ).toBe("accepted");
      expect(await claimApprovedEffect(prisma, latest.effect.id)).toBe(false);
      await prisma.message.update({
        where: { id: t.run.sourceMessageId! },
        data: { blocks: [{ kind: "text", text: "Pretend this is a dispatch." }] },
      });
      expect(await t.query()).toEqual([]);
      expect(
        await t.answer("deny", { messageId: latest.message.id, effectId: latest.effect.id }),
      ).toBe("conflict");
    });

    it.each(["clear", "stop", "policy", "membership", "archive", "session"] as const)(
      "refuses a delegated answer after %s",
      async (boundary) => {
        const t = await delegatedFixture();
        if (boundary === "clear") await t.events.clearThread(t.source);
        if (boundary === "stop")
          await prisma.$transaction((tx) => cancelRunsInTransaction(tx, [t.run], new Date()));
        if (boundary === "policy") {
          await t.f.toggle(false);
          await t.f.toggle(true);
        }
        if (boundary === "membership")
          await prisma.spaceMember.delete({
            where: { spaceId_userId: { spaceId: t.source.spaceId, userId: t.source.userId } },
          });
        if (boundary === "archive")
          await prisma.bot.update({
            where: { id: t.run.botId },
            data: { archivedAt: new Date() },
          });
        if (boundary === "session") await prisma.session.delete({ where: { id: t.session.id } });
        expect(await t.answer("allow")).toBe("conflict");
        expect((await t.query()).some((card) => card.state === "pending")).toBe(
          boundary === "session",
        );
        expect(
          await prisma.externalEffect.findUnique({ where: { id: t.effect.id } }),
        ).toMatchObject({
          status: "intended",
        });
        if (boundary === "clear")
          expect(
            await t.events.answerRunInput({
              spaceId: t.source.spaceId,
              threadId: t.run.threadId,
              answeredByUserId: t.source.userId,
              runId: t.run.id,
              messageId: t.message.id,
              answer: "allow",
            }),
          ).toBe(true);
      },
    );
  });
});
