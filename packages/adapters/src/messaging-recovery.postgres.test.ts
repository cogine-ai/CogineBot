import { randomUUID } from "node:crypto";
import type { BackgroundJob, JobPublisher, MessagingSurface } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { createDb, createThreadMessage } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobReconciler } from "./job-reconciler.js";
import { mirrorMessagingOutbound } from "./messaging-delivery.js";

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
          where: { idempotencyKey: { in: [...messageIds].map((id) => `msg:${id}`) } },
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
      sendToThread,
      mirror: (runId: string) =>
        mirrorMessagingOutbound({ prisma, jobs, messaging, events }, runId),
      reconciler: createJobReconciler({ prisma, jobs }),
    };
  }

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
});
