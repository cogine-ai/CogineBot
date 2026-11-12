import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AdapterContext,
  BackgroundJob,
  JobPublisher,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  createDb,
  createThreadMessage,
  finalizeRun,
  Prisma,
  readMessagingDelivery,
} from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { MessagingSendError } from "./chat-sdk-surface.js";
import { createRunExecutor } from "./executor.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { FakeWebProvider } from "./fake-web.js";
import { createJobReconciler } from "./job-reconciler.js";
import {
  applyMessagingOutboundStatus,
  deliverMessagingOutbound,
  mirrorMessagingOutbound,
} from "./messaging-delivery.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("failed messaging recovery (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let scope: {
    organizationId: string;
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
  };
  const messageIds = new Set<string>();

  beforeEach(async () => {
    db = createDb(databaseUrl!, { applicationName: "messaging-recovery-fixture" });
    prisma = db.prisma;
    const organizationId = randomUUID();
    const spaceId = randomUUID();
    const userId = randomUUID();
    await prisma.user.create({
      data: { id: userId, name: "Fixture", email: `${userId}@example.test` },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Fixture" } });
    const bot = await prisma.bot.create({
      data: {
        spaceId,
        userId,
        name: "Messaging Fixture",
        color: "slate",
        thread: { create: { spaceId, userId } },
      },
      include: { thread: true },
    });
    if (!bot.thread) throw new Error("Missing fixture thread");
    scope = { organizationId, spaceId, userId, botId: bot.id, threadId: bot.thread.id };
    await prisma.messagingIdentity.create({
      data: {
        provider: "slack",
        address: randomUUID(),
        spaceId,
        userId,
        botId: bot.id,
        dmThreadId: "slack:synthetic-recovery",
      },
    });
  });

  afterEach(async () => {
    if (!db) return;
    try {
      if (messageIds.size) {
        await prisma.messagingOutbound.deleteMany({
          where: { sourceMessageId: { in: [...messageIds] } },
        });
        messageIds.clear();
      }
      if (scope) {
        await prisma.organization.deleteMany({ where: { id: scope.organizationId } });
        await prisma.user.deleteMany({ where: { id: scope.userId } });
      }
    } finally {
      await prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function terminalRun(status: string, trigger: string, reply?: string) {
    const task = await prisma.task.create({
      data: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        threadId: scope.threadId,
        prompt: "Synthetic inbound",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        threadId: scope.threadId,
        taskId: task.id,
        trigger,
        status: "running",
        leaseOwner: "fixture-worker",
        leaseFence: 7,
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 7, status: "running" },
    });
    const message =
      reply === undefined
        ? undefined
        : await createThreadMessage(prisma, {
            threadId: scope.threadId,
            runId: run.id,
            botId: scope.botId,
            role: "bot",
            blocks: [{ kind: "text", text: reply }],
            lease: { owner: "fixture-worker", fence: 7 },
          });
    if (message) messageIds.add(message.id);
    // Seed the durable boundary after terminal commit and before automatic mirroring.
    // This uses real PostgreSQL writes, without running an executor or sending externally.
    await prisma.$transaction(async (tx) => {
      await tx.run.update({
        where: { id: run.id },
        data: { status, completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
      });
      await tx.task.update({ where: { id: task.id }, data: { status } });
      await tx.attempt.update({
        where: { id: attempt.id },
        data: { status, finishedAt: new Date() },
      });
    });
    return {
      run: await prisma.run.findUniqueOrThrow({ where: { id: run.id } }),
      attempt: await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      message,
    };
  }

  async function runningMessagingRun() {
    const task = await prisma.task.create({
      data: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        threadId: scope.threadId,
        prompt: "Synthetic active messaging task",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        threadId: scope.threadId,
        taskId: task.id,
        trigger: "messaging",
        status: "running",
        leaseOwner: "fixture-worker",
        leaseFence: 7,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 7, status: "running" },
    });
    const progress = await createThreadMessage(prisma, {
      threadId: scope.threadId,
      runId: run.id,
      botId: scope.botId,
      role: "bot",
      blocks: [{ kind: "text", text: "Progress before completion" }],
      lease: { owner: "fixture-worker", fence: 7 },
    });
    messageIds.add(progress.id);
    return { run, attempt, progress };
  }

  async function finishMessagingRun(
    client: PrismaClient,
    active: Awaited<ReturnType<typeof runningMessagingRun>>,
  ) {
    const result = await finalizeRun(client, {
      spaceId: scope.spaceId,
      threadId: scope.threadId,
      botId: scope.botId,
      runId: active.run.id,
      taskId: active.run.taskId,
      attemptId: active.attempt.id,
      leaseOwner: "fixture-worker",
      leaseFence: 7,
      outcome: "completed",
      blocks: [{ kind: "text", text: "Final response after progress" }],
    });
    const messages = await client.message.findMany({
      where: { runId: active.run.id, role: "bot" },
      orderBy: { seq: "asc" },
    });
    for (const message of messages) messageIds.add(message.id);
    expect(result).toEqual({ continuationRunId: null });
    expect(messages).toHaveLength(2);
    expect(messages[1]?.blocks).toEqual([{ kind: "text", text: "Final response after progress" }]);
    return messages[1]!;
  }

  function recovery() {
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    const jobs: JobPublisher = {
      enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const sendToThread = vi.fn(async () => {
      throw new Error("This recovery test must not send externally");
    });
    const messaging = { sendToThread } as unknown as MessagingSurface;
    const events = {
      notify: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(),
    } as unknown as ThreadEvents;
    return {
      enqueue,
      jobs,
      messaging,
      events,
      sendToThread,
      mirror: (runId: string) =>
        mirrorMessagingOutbound({ prisma, jobs, messaging, events }, runId),
      reconciler: createJobReconciler({ prisma, jobs }),
    };
  }

  function outboundDeps(sendToThread: MessagingSurface["sendToThread"], client = prisma) {
    const fixture = recovery();
    return {
      prisma: client,
      jobs: fixture.jobs,
      events: fixture.events,
      messaging: {
        sendToThread,
        platforms: () => [
          {
            provider: "telegram",
            capabilities: { direct: true, groups: false, typing: false, files: true },
          },
        ],
      } as MessagingSurface,
    };
  }

  function deliveryContext(): AdapterContext {
    return {
      operationId: "fixture-delivery",
      traceId: "fixture-delivery",
      spaceId: scope.spaceId,
      userId: scope.userId,
      botId: scope.botId,
      signal: new AbortController().signal,
    };
  }

  it("keeps parts ordered under competing drains and lets another conversation pass a rate limit", async () => {
    const saved = (await terminalRun("completed", "messaging", "Saved reply")).message!;
    const other = (await terminalRun("completed", "messaging", "Other reply")).message!;
    const make = (sourceMessageId: string, partIndex: number, body: string, threadId: string) => ({
      sourceMessageId,
      partIndex,
      body,
      threadId,
      kind: "group",
      provider: "sendblue",
      idempotencyKey: `fixture:${sourceMessageId}:${partIndex}`,
      createdAt: new Date(0),
    });
    await prisma.messagingOutbound.createMany({
      data: [
        make(saved.id, 0, "first", "sendblue:fixture-lane-1"),
        make(saved.id, 2, "second", "sendblue:fixture-lane-1"),
        make(other.id, 0, "other", "sendblue:fixture-lane-2"),
      ],
    });
    let rateLimited = true;
    const send = vi.fn<MessagingSurface["sendToThread"]>(async ({ body }) => {
      if (body === "first" && rateLimited)
        throw new MessagingSendError("retryable", "rate_limited", 60_000);
      return { handle: `fixture-${body}` };
    });
    const deps = outboundDeps(send);
    const drain = () => deliverMessagingOutbound(deps, {}, deliveryContext());
    await Promise.all([drain(), drain()]);
    expect(send.mock.calls.map(([request]) => request.body).sort()).toEqual(["first", "other"]);
    const waiting = await prisma.messagingOutbound.findFirstOrThrow({
      where: { body: "first", sourceMessageId: saved.id },
    });
    expect(waiting).toMatchObject({
      status: "pending",
      attempts: 1,
      lastErrorClass: "rate_limited",
    });
    expect(waiting.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(55_000);

    rateLimited = false;
    await prisma.messagingOutbound.update({
      where: { id: waiting.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await Promise.all([drain(), drain()]);
    expect(send.mock.calls.slice(2).map(([request]) => request.body)).toEqual(["first", "second"]);
  });

  it("joins an early signed-provider receipt to the eventual handle and leaves late weaker receipts unchanged", async () => {
    const saved = await terminalRun("completed", "messaging", "Saved reply");
    const handle = `receipt-${saved.message!.id}`;
    const event = { type: "status" as const, provider: "slack", handle };
    const send = vi.fn<MessagingSurface["sendToThread"]>(async () => {
      await applyMessagingOutboundStatus(prisma, { ...event, status: "DELIVERED" });
      return { handle };
    });
    const deps = outboundDeps(send);
    await deliverMessagingOutbound(deps, { runId: saved.run.id }, deliveryContext());
    await applyMessagingOutboundStatus(prisma, { ...event, status: "SENT" });
    await applyMessagingOutboundStatus(prisma, { ...event, status: "ERROR" });
    const id = saved.message!.id;
    expect(
      await prisma.messagingOutbound.findFirstOrThrow({ where: { sourceMessageId: id } }),
    ).toMatchObject({
      providerHandle: handle,
      deliveryState: "delivered",
      deliveredAt: expect.any(Date),
    });
    expect((await readMessagingDelivery(prisma, [id])).get(id)).toEqual({ state: "delivered" });
    expect(await prisma.messagingOutbound.count({ where: { status: "receipt" } })).toBe(0);
    expect(
      await prisma.event.findMany({
        where: { threadId: scope.threadId, type: "thread.message.delivery" },
        orderBy: { seq: "asc" },
        select: { payload: true },
      }),
    ).toMatchObject([
      { payload: { messageId: id, delivery: { state: "sending" } } },
      { payload: { messageId: id, delivery: { state: "delivered" } } },
    ]);
  });

  it("does not dispatch again after a provider accepts and the status write fails", async () => {
    const saved = await terminalRun("completed", "messaging", "Saved reply");
    let fail = true;
    const faulty = prisma.$extends({
      query: {
        messagingOutbound: {
          async updateMany({ args, query }) {
            if (fail && args.data.deliveryState === "accepted") {
              fail = false;
              throw new Error("Synthetic acceptance write interruption");
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const send = vi.fn<MessagingSurface["sendToThread"]>(async () => ({
      handle: "fixture-accepted",
    }));
    await deliverMessagingOutbound(
      outboundDeps(send, faulty),
      { runId: saved.run.id },
      deliveryContext(),
    );
    await deliverMessagingOutbound(outboundDeps(send), { runId: saved.run.id }, deliveryContext());
    expect(fail).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(
      (await readMessagingDelivery(prisma, [saved.message!.id])).get(saved.message!.id),
    ).toEqual({ state: "unknown" });
  });

  it.each(["accepted", "rate_limited"] as const)(
    "holds the next part during a timed-out provider call and records a late %s outcome",
    async (outcome) => {
      const saved = (await terminalRun("completed", "messaging", "Saved reply")).message!;
      await prisma.messagingOutbound.createMany({
        data: ["first", "second"].map((body, index) => ({
          sourceMessageId: saved.id,
          body,
          kind: "group",
          provider: "sendblue",
          threadId: "sendblue:fixture-in-flight",
          idempotencyKey: `fixture:${saved.id}:${index}`,
          partIndex: index,
          createdAt: new Date(0),
        })),
      });
      let acceptLate!: (result: { handle: string }) => void;
      let rejectLate!: (reason: Error) => void;
      const late = new Promise<{ handle: string }>((resolve, reject) => {
        acceptLate = resolve;
        rejectLate = reject;
      });
      let firstAttempt = true;
      const send = vi.fn<MessagingSurface["sendToThread"]>(async ({ body }) => {
        if (body === "first" && firstAttempt) {
          firstAttempt = false;
          throw new MessagingSendError("unknown", "outcome_unknown", undefined, undefined, late);
        }
        return { handle: body === "first" ? "fixture-retried-first" : "fixture-second" };
      });
      const deps = outboundDeps(send);
      const drain = () => deliverMessagingOutbound(deps, {}, deliveryContext());
      await drain();
      await drain();
      expect(send.mock.calls.map(([request]) => request.body)).toEqual(["first"]);
      expect(
        await prisma.messagingOutbound.findFirstOrThrow({
          where: { sourceMessageId: saved.id, partIndex: 0 },
        }),
      ).toMatchObject({ deliveryState: "unknown", claimStartedAt: expect.any(Date) });

      const where = { sourceMessageId: saved.id, partIndex: 0 };
      if (outcome === "rate_limited") {
        rejectLate(new MessagingSendError("retryable", "rate_limited", 60_000));
        await vi.waitFor(async () => {
          expect(await prisma.messagingOutbound.findFirstOrThrow({ where })).toMatchObject({
            deliveryState: null,
            status: "pending",
            attempts: 1,
            claimStartedAt: null,
            nextAttemptAt: expect.any(Date),
          });
        });
        await drain();
        expect(send).toHaveBeenCalledOnce();
        await prisma.messagingOutbound.updateMany({ where, data: { nextAttemptAt: new Date(0) } });
      } else {
        acceptLate({ handle: "fixture-late-first" });
        await vi.waitFor(async () => {
          expect(await prisma.messagingOutbound.findFirstOrThrow({ where })).toMatchObject({
            providerHandle: "fixture-late-first",
            deliveryState: "accepted",
            claimStartedAt: null,
          });
        });
      }
      await drain();
      expect(send.mock.calls.map(([request]) => request.body)).toEqual(
        outcome === "rate_limited" ? ["first", "first", "second"] : ["first", "second"],
      );
    },
  );

  it("retains successful text and sends one notice in the original conversation on file rejection", async () => {
    const saved = await terminalRun("completed", "messaging", "Text survived");
    const id = saved.message!.id;
    await prisma.messagingIdentity.update({
      where: { botId: scope.botId },
      data: { provider: "telegram", dmThreadId: "telegram:fixture" },
    });
    const file = await prisma.artifact.create({
      data: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        name: "fixture.pdf",
        mimeType: "application/pdf",
        size: 1,
        hash: "fixture-hash",
        storageKey: "fixture-bytes",
      },
    });
    await prisma.message.update({
      where: { id },
      data: {
        blocks: [
          { kind: "text", text: "Text survived" },
          {
            kind: "file",
            artifactId: file.id,
            name: "fixture.pdf",
            mimeType: "application/pdf",
            size: 1,
          },
          {
            kind: "file",
            artifactId: "second-missing-fixture-artifact",
            name: "second.pdf",
            mimeType: "application/pdf",
            size: 1,
          },
        ],
      },
    });
    const send = vi.fn<MessagingSurface["sendToThread"]>(async ({ body, attachment }) => {
      if (attachment) throw new MessagingSendError("permanent", "rejected");
      return { handle: body };
    });
    const get = vi.fn(async () => new Uint8Array([1]));
    const deps = { ...outboundDeps(send), artifacts: { get } };
    await deliverMessagingOutbound(deps, { runId: saved.run.id }, deliveryContext());
    await deliverMessagingOutbound(deps, { runId: saved.run.id }, deliveryContext());
    expect(get).toHaveBeenCalledExactlyOnceWith(
      "fixture-bytes",
      expect.objectContaining({
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
      }),
    );
    expect(
      send.mock.calls.map(([request]) => [
        request.threadId,
        request.attachment?.name ?? request.body,
      ]),
    ).toEqual([
      ["telegram:fixture", "Text survived"],
      ["telegram:fixture", "fixture.pdf"],
      ["telegram:fixture", "An attachment could not be sent."],
    ]);
    expect((await readMessagingDelivery(prisma, [id])).get(id)).toEqual({
      state: "partial_failure",
      reason: "attachment_unavailable",
    });
  });

  it("recovers a persisted failed reply with one outbox row and no Run or attempt replay", async () => {
    const failed = await terminalRun("failed", "messaging", "Persisted before failure");
    expect(failed.message).toMatchObject({
      runId: failed.run.id,
      blocks: [{ kind: "text", text: "Persisted before failure" }],
    });
    expect(
      await prisma.messagingOutbound.count({ where: { sourceMessageId: failed.message!.id } }),
    ).toBe(0);
    const fixture = recovery();
    await fixture.reconciler.reconcileOnce();
    await fixture.reconciler.reconcileOnce();
    expect(fixture.enqueue.mock.calls.map(([job]) => job)).toEqual([
      {
        name: "messaging.deliver",
        payload: { runId: failed.run.id },
        replaceKey: `messaging.deliver:${failed.run.id}`,
      },
      {
        name: "messaging.deliver",
        payload: { runId: failed.run.id },
        replaceKey: `messaging.deliver:${failed.run.id}`,
      },
    ]);
    await fixture.mirror(failed.run.id);
    await fixture.mirror(failed.run.id);
    await fixture.reconciler.reconcileOnce();
    expect(fixture.enqueue).toHaveBeenCalledTimes(3);
    // The third call is the outbox drain, never another attempt of the failed Run.
    expect(fixture.enqueue).toHaveBeenLastCalledWith({
      name: "messaging.deliver",
      payload: {},
      replaceKey: "messaging.deliver:drain",
    });
    expect(
      await prisma.messagingOutbound.findMany({ where: { sourceMessageId: failed.message!.id } }),
    ).toEqual([
      expect.objectContaining({
        idempotencyKey: `msg:${failed.message!.id}`,
        body: "Persisted before failure",
        status: "pending",
        sourceMessageId: failed.message!.id,
        providerHandle: null,
      }),
    ]);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: failed.run.id } })).toEqual({
      ...failed.run,
      messagingMirroredAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: failed.attempt.id } })).toEqual(
      failed.attempt,
    );
    expect(await prisma.attempt.count({ where: { runId: failed.run.id } })).toBe(1);
    expect(fixture.sendToThread).not.toHaveBeenCalled();
  });

  it("settles an empty failed messaging Run while excluding cancelled and non-messaging replies", async () => {
    const empty = await terminalRun("failed", "messaging");
    const excluded = await Promise.all([
      terminalRun("cancelled", "messaging", "Cancelled reply"),
      terminalRun("failed", "user", "In-app reply"),
      terminalRun("failed", "routine", "Routine reply"),
    ]);
    const fixture = recovery();
    await fixture.reconciler.reconcileOnce();
    expect(fixture.enqueue).toHaveBeenCalledExactlyOnceWith({
      name: "messaging.deliver",
      payload: { runId: empty.run.id },
      replaceKey: `messaging.deliver:${empty.run.id}`,
    });
    await fixture.mirror(empty.run.id);
    await fixture.reconciler.reconcileOnce();
    expect(fixture.enqueue).toHaveBeenCalledOnce();
    expect(
      await prisma.messagingOutbound.count({ where: { sourceMessageId: { in: [...messageIds] } } }),
    ).toBe(0);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: empty.run.id } })).toEqual({
      ...empty.run,
      messagingMirroredAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    for (const entry of excluded) {
      expect(await prisma.run.findUniqueOrThrow({ where: { id: entry.run.id } })).toEqual(
        entry.run,
      );
      expect(await prisma.attempt.findUniqueOrThrow({ where: { id: entry.attempt.id } })).toEqual(
        entry.attempt,
      );
    }
    expect(fixture.sendToThread).not.toHaveBeenCalled();
  });

  it("keeps a nonterminal mirror snapshot recoverable when finalization commits before its marker", async () => {
    const active = await runningMessagingRun();
    const fixture = recovery();
    const writer = createDb(databaseUrl!, { applicationName: "messaging-finalize-fixture" });
    let releaseSnapshot!: () => void;
    const snapshotReleased = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let capturedIds: string[] | undefined;
    let capturedRunStatus: string | undefined;
    const observed = prisma.$extends({
      query: {
        run: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (args.where.id === active.run.id) capturedRunStatus ??= row?.status;
            return row;
          },
        },
        message: {
          async findMany({ args, query }) {
            const rows = await query(args);
            if (
              capturedIds === undefined &&
              args.where?.runId === active.run.id &&
              args.where.role === "bot"
            ) {
              capturedIds = rows.map((message) => message.id!);
              // The real query has finished; do not hold a database transaction
              // while the other client commits the final message and terminal row.
              await snapshotReleased;
            }
            return rows;
          },
        },
      },
    });
    const mirroring = mirrorMessagingOutbound(
      { prisma: observed as unknown as PrismaClient, ...fixture },
      active.run.id,
    );
    // Observe early failures without changing the original promise we assert below.
    void mirroring.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(capturedIds).toEqual([active.progress.id]), {
        timeout: 10_000,
        interval: 20,
      });
      expect(capturedRunStatus).toBe("running");
      const final = await finishMessagingRun(writer.prisma, active);
      const terminal = await prisma.run.findUniqueOrThrow({ where: { id: active.run.id } });
      const finishedAttempt = await prisma.attempt.findUniqueOrThrow({
        where: { id: active.attempt.id },
      });
      releaseSnapshot();
      await mirroring;

      const afterOldSnapshot = await prisma.run.findUniqueOrThrow({ where: { id: active.run.id } });
      expect(afterOldSnapshot.messagingMirroredAt).toBeNull();
      expect(afterOldSnapshot).toEqual(terminal);
      expect(terminal.messagingMirroredAt).toBeNull();
      expect(
        await prisma.messagingOutbound.findMany({
          where: { sourceMessageId: { in: [active.progress.id, final.id] } },
        }),
      ).toEqual([
        expect.objectContaining({
          sourceMessageId: active.progress.id,
          body: "Progress before completion",
        }),
      ]);

      await fixture.reconciler.reconcileOnce();
      expect(fixture.enqueue.mock.calls.map(([job]) => job)).toContainEqual({
        name: "messaging.deliver",
        payload: { runId: active.run.id },
        replaceKey: `messaging.deliver:${active.run.id}`,
      });
      await fixture.mirror(active.run.id);
      await fixture.mirror(active.run.id);
      expect(
        await prisma.messagingOutbound.findMany({
          where: { sourceMessageId: { in: [active.progress.id, final.id] } },
          orderBy: { sourceMessageId: "asc" },
        }),
      ).toEqual(
        [active.progress, final]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((message) =>
            expect.objectContaining({
              sourceMessageId: message.id,
              idempotencyKey: `msg:${message.id}`,
              status: "pending",
            }),
          ),
      );
      expect(await prisma.run.findUniqueOrThrow({ where: { id: active.run.id } })).toEqual({
        ...terminal,
        messagingMirroredAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
      expect(await prisma.attempt.findUniqueOrThrow({ where: { id: active.attempt.id } })).toEqual(
        finishedAttempt,
      );
      expect(await prisma.attempt.count({ where: { runId: active.run.id } })).toBe(1);
      expect(await prisma.externalEffect.count({ where: { runId: active.run.id } })).toBe(0);
      expect(fixture.enqueue.mock.calls.some(([job]) => job.name === "run.continue")).toBe(false);
      expect(fixture.sendToThread).not.toHaveBeenCalled();
    } finally {
      releaseSnapshot();
      await mirroring.catch(() => undefined);
      await writer.prisma.$disconnect();
      await writer.pool.end();
    }
  });

  it("keeps a lease-losing handler from settling another worker's messaging Run", async () => {
    const active = await runningMessagingRun();
    const fixture = recovery();
    const runtime = new ScriptedAgentRuntime();
    const runtimeRun = vi.spyOn(runtime, "run");
    // This real executor exits at its live-lease guard, before runtime/sandbox
    // setup. The unused IO boundaries are deliberately absent from this fixture.
    const executor = createRunExecutor({
      prisma,
      runtime,
      events: fixture.events,
      jobs: fixture.jobs,
      secrets: [],
      browser: new FakeBrowserProvider(),
      web: new FakeWebProvider(),
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const handlers = createBackgroundJobHandlers({
      executor,
      prisma,
      runtime,
      events: fixture.events,
      jobs: fixture.jobs,
      workerId: "losing-worker",
      messaging: fixture.messaging,
    } as Parameters<typeof createBackgroundJobHandlers>[0]);
    const before = await prisma.run.findUniqueOrThrow({ where: { id: active.run.id } });
    await handlers["run.continue"]({ runId: active.run.id });
    expect(runtimeRun).not.toHaveBeenCalled();
    const afterLoser = await prisma.run.findUniqueOrThrow({ where: { id: active.run.id } });
    expect(afterLoser.messagingMirroredAt).toBeNull();
    expect(afterLoser).toEqual(before);
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: active.attempt.id } })).toEqual(
      active.attempt,
    );
    expect(
      await prisma.messagingOutbound.findMany({ where: { sourceMessageId: active.progress.id } }),
    ).toEqual([expect.objectContaining({ body: "Progress before completion" })]);

    // The winning owner commits through the production terminal transaction;
    // its process never reaches the automatic handler mirror in this scenario.
    const final = await finishMessagingRun(prisma, active);
    const finishedAttempt = await prisma.attempt.findUniqueOrThrow({
      where: { id: active.attempt.id },
    });
    await fixture.reconciler.reconcileOnce();
    expect(fixture.enqueue.mock.calls.map(([job]) => job)).toContainEqual({
      name: "messaging.deliver",
      payload: { runId: active.run.id },
      replaceKey: `messaging.deliver:${active.run.id}`,
    });
    await fixture.mirror(active.run.id);
    expect(await prisma.messagingOutbound.count({ where: { sourceMessageId: final.id } })).toBe(1);
    expect(await prisma.attempt.count({ where: { runId: active.run.id } })).toBe(1);
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: active.attempt.id } })).toEqual(
      finishedAttempt,
    );
    expect(fixture.enqueue.mock.calls.some(([job]) => job.name === "run.continue")).toBe(false);
    expect(fixture.sendToThread).not.toHaveBeenCalled();
  });

  it.each(["waiting_input", "waiting_takeover"])(
    "mirrors existing %s progress without marking the Run settled",
    async (status) => {
      const active = await runningMessagingRun();
      await prisma.run.update({
        where: { id: active.run.id },
        data: { status, leaseOwner: null, leaseExpiresAt: null },
      });
      const before = await prisma.run.findUniqueOrThrow({ where: { id: active.run.id } });
      const fixture = recovery();
      await fixture.mirror(active.run.id);
      await fixture.mirror(active.run.id);
      expect(await prisma.run.findUniqueOrThrow({ where: { id: active.run.id } })).toEqual(before);
      expect(
        await prisma.messagingOutbound.count({ where: { sourceMessageId: active.progress.id } }),
      ).toBe(1);
      expect(await prisma.attempt.findUniqueOrThrow({ where: { id: active.attempt.id } })).toEqual(
        active.attempt,
      );
      expect(fixture.sendToThread).not.toHaveBeenCalled();
    },
  );

  it("backfills only pre-cutover failed messaging snapshots without changing pending delivery or active work", async () => {
    const historical = await terminalRun("failed", "messaging", "Historical partial reply");
    const [phone, marked, completed, cancelled, user, routine, peer] = await Promise.all([
      terminalRun("failed", "phone"),
      terminalRun("failed", "messaging"),
      terminalRun("completed", "messaging"),
      terminalRun("cancelled", "messaging"),
      terminalRun("failed", "user"),
      terminalRun("failed", "routine"),
      terminalRun("failed", "bot_message"),
    ]);
    const active = await runningMessagingRun();
    const waiting = await runningMessagingRun();
    await prisma.run.update({
      where: { id: waiting.run.id },
      data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
    });
    const completedAt = new Date("2026-10-20T01:02:03.004Z");
    const updatedAt = new Date("2026-10-21T02:03:04.005Z");
    const existingMarker = new Date("2026-10-22T03:04:05.006Z");
    await prisma.run.update({
      where: { id: historical.run.id },
      data: { completedAt, updatedAt, checkpoint: "retained historical checkpoint" },
    });
    await prisma.run.update({
      where: { id: phone.run.id },
      data: { completedAt: null, updatedAt },
    });
    await prisma.run.update({
      where: { id: marked.run.id },
      data: { messagingMirroredAt: existingMarker },
    });
    const identity = await prisma.messagingIdentity.findUniqueOrThrow({
      where: { botId: scope.botId },
    });
    const pending = await prisma.messagingOutbound.create({
      data: {
        idempotencyKey: `msg:${historical.message!.id}`,
        kind: "dm",
        identityId: identity.id,
        body: "Historical partial reply",
        sourceMessageId: historical.message!.id,
        status: "pending",
        attempts: 2,
        nextAttemptAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.externalEffect.create({
      data: {
        spaceId: scope.spaceId,
        runId: historical.run.id,
        kind: "fixture.receipt",
        idempotencyKey: `fixture:${historical.run.id}`,
        status: "completed",
        request: { fixture: true },
        result: { receipt: "retained" },
      },
    });
    const fixtures = [
      historical,
      phone,
      marked,
      completed,
      cancelled,
      user,
      routine,
      peer,
      active,
      waiting,
    ];
    const runIds = fixtures.map((fixture) => fixture.run.id).sort();
    const taskIds = fixtures.map((fixture) => fixture.run.taskId);
    const protectedRows = () =>
      Promise.all([
        prisma.run.findMany({ where: { id: { in: runIds } }, orderBy: { id: "asc" } }),
        prisma.attempt.findMany({ where: { runId: { in: runIds } }, orderBy: { id: "asc" } }),
        prisma.externalEffect.findMany({
          where: { runId: { in: runIds } },
          orderBy: { id: "asc" },
        }),
        prisma.messagingOutbound.findMany({ where: { id: pending.id } }),
        prisma.message.findMany({ where: { runId: { in: runIds } }, orderBy: { id: "asc" } }),
        prisma.event.findMany({ where: { runId: { in: runIds } }, orderBy: { id: "asc" } }),
        prisma.task.findMany({ where: { id: { in: taskIds } }, orderBy: { id: "asc" } }),
        prisma.space.findUniqueOrThrow({ where: { id: scope.spaceId } }),
      ]);
    const protectedBefore = await protectedRows();
    const previousSql = await readFile(
      new URL(
        "../../db/prisma/migrations/20260901040000_messaging_mirror_recovery/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const cutoverSql = await readFile(
      new URL(
        "../../db/prisma/migrations/20261104000000_failed_messaging_mirror_cutover/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const updateOffset = previousSql.indexOf('UPDATE "runs"');
    expect(updateOffset).toBeGreaterThanOrEqual(0);
    await prisma.$transaction(
      async (tx) => {
        // Run the actual UPDATE bodies against a private full-column copy,
        // never the public table or another fixture's historical rows.
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE "runs" (LIKE public."runs" INCLUDING DEFAULTS) ON COMMIT DROP',
        );
        await tx.$executeRawUnsafe("SET LOCAL search_path TO pg_temp, public");
        expect(
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO pg_temp."runs"
            SELECT * FROM public."runs" WHERE id IN (${Prisma.join(runIds)})
          `),
        ).toBe(runIds.length);
        const readTemplate = () =>
          tx.$queryRaw<
            Array<{ id: string; messagingMirroredAt: Date | null } & Record<string, unknown>>
          >(Prisma.sql`SELECT * FROM pg_temp."runs" ORDER BY id`);
        const before = await readTemplate();
        // The old migration only protected completed history. Comparing its
        // UPDATE is a control; the old ADD COLUMN is not reapplied here.
        expect(await tx.$executeRawUnsafe(previousSql.slice(updateOffset))).toBe(1);
        const afterPrevious = await readTemplate();
        expect(
          afterPrevious.find((run) => run.id === historical.run.id)?.messagingMirroredAt,
        ).toBeNull();
        expect(
          afterPrevious.find((run) => run.id === phone.run.id)?.messagingMirroredAt,
        ).toBeNull();
        expect(
          afterPrevious.find((run) => run.id === completed.run.id)?.messagingMirroredAt,
        ).toBeInstanceOf(Date);
        expect(await tx.$executeRawUnsafe(cutoverSql)).toBe(2);
        const markers = new Map([
          [historical.run.id, completedAt],
          [phone.run.id, updatedAt],
        ]);
        expect(await readTemplate()).toEqual(
          afterPrevious.map((run) => ({
            ...run,
            messagingMirroredAt: markers.get(run.id) ?? run.messagingMirroredAt,
          })),
        );
        expect(
          (await readTemplate()).find((run) => run.id === marked.run.id)?.messagingMirroredAt,
        ).toEqual(existingMarker);
        expect(await tx.$executeRawUnsafe(cutoverSql)).toBe(0);
        // A later failure is not pre-acknowledged by the one-time cutover.
        await tx.$executeRaw`UPDATE pg_temp."runs" SET status='failed' WHERE id=${active.run.id}`;
        expect(
          (await readTemplate()).find((run) => run.id === active.run.id)?.messagingMirroredAt,
        ).toBeNull();
        expect(before).toHaveLength(runIds.length);
        await tx.$executeRawUnsafe('TRUNCATE TABLE pg_temp."runs"');
        expect(await tx.$executeRawUnsafe(cutoverSql)).toBe(0);
      },
      { timeout: 10_000 },
    );
    expect(await protectedRows()).toEqual(protectedBefore);
  });
});
