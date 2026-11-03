import { randomUUID } from "node:crypto";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireComputerExecutionLease,
  acquireDedicatedScreenLeaseFence,
  ComputerBusyError,
  holdComputerExecutionLeaseForTakeover,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  screenLeaseIdForRun,
} from "./computer-lifecycle.js";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { findRunRecoveryBlockers } from "./run-recovery.js";
import { RunJobPublisher, RunStarter, RunWorkerHost } from "./run-wakeup.js";
import { InMemoryJobQueue } from "./wakeup.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
type BotRef = { id: string; threadId: string };
const future = () => new Date(Date.now() + 5 * 60_000);
const wait = (assertion: () => Promise<void> | void) =>
  vi.waitFor(assertion, { timeout: 5_000, interval: 20 });

describePostgres("computer execution ownership and recovery (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let scope: { organizationId: string; spaceId: string; userId: string };
  let bot: BotRef;

  beforeEach(async () => {
    db = createDb(databaseUrl!, { applicationName: "computer-lease-fixture" });
    prisma = db.prisma;
    scope = { organizationId: randomUUID(), spaceId: randomUUID(), userId: randomUUID() };
    await prisma.user.create({
      data: { id: scope.userId, name: "Fixture", email: `${scope.userId}@example.test` },
    });
    await prisma.organization.create({
      data: {
        id: scope.organizationId,
        name: "Fixture",
        slug: scope.organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: scope.spaceId, organizationId: scope.organizationId, name: "Fixture" },
    });
    bot = await createBot();
  });

  afterEach(async () => {
    if (!db) return;
    try {
      if (scope) {
        await prisma.organization.deleteMany({ where: { id: scope.organizationId } });
        await prisma.user.deleteMany({ where: { id: scope.userId } });
      }
    } finally {
      await prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function createBot(): Promise<BotRef> {
    const row = await prisma.bot.create({
      data: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        name: "Lease Fixture",
        color: "slate",
        thread: { create: { spaceId: scope.spaceId, userId: scope.userId } },
      },
      include: { thread: true },
    });
    if (!row.thread) throw new Error("fixture thread missing");
    return { id: row.id, threadId: row.thread.id };
  }

  async function createComputer(owner: BotRef, computerScope: "dedicated" | "team") {
    const row = await prisma.computer.create({
      data: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        scope: computerScope,
        scopeKey: randomUUID(),
        homeKey: randomUUID(),
        kind: "fake",
        state: "running",
      },
    });
    await prisma.bot.update({ where: { id: owner.id }, data: { computerId: row.id } });
    return row;
  }

  async function createRun(owner: BotRef, data: Partial<Prisma.RunUncheckedCreateInput> = {}) {
    const task = await prisma.task.create({
      data: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: owner.id,
        threadId: owner.threadId,
        prompt: "fixture",
        status: "queued",
      },
    });
    return prisma.run.create({
      data: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: owner.id,
        threadId: owner.threadId,
        taskId: task.id,
        status: "queued",
        trigger: "user",
        ...data,
      },
    });
  }

  const storedLease = (computerId: string, botId = bot.id) =>
    prisma.computerExecutionLease.findUniqueOrThrow({
      where: { computerId_botId: { computerId, botId } },
    });

  it("keeps dedicated resource waits pristine until release and an explicit producer wake", async () => {
    const computer = await createComputer(bot, "dedicated");
    const holder = await createRun(bot, {
      status: "running",
      leaseOwner: "holder-worker",
      leaseFence: 1,
      leaseExpiresAt: future(),
    });
    const held = await acquireDedicatedScreenLeaseFence(prisma, {
      computerId: computer.id,
      botId: bot.id,
      runId: holder.id,
      workerId: "holder-worker",
      runFence: 1,
    });
    const contender = await createRun(bot, {
      status: "running",
      leaseOwner: "contender-worker",
      leaseFence: 1,
      leaseExpiresAt: future(),
    });
    const heldRow = await storedLease(computer.id);
    await expect(
      acquireDedicatedScreenLeaseFence(prisma, {
        computerId: computer.id,
        botId: bot.id,
        runId: contender.id,
        workerId: "contender-worker",
        runFence: 1,
      }),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(await storedLease(computer.id)).toEqual(heldRow);
    const queued = await createRun(bot);
    const before = await prisma.run.update({
      where: { id: queued.id },
      data: { createdAt: new Date(0), updatedAt: new Date(0) },
    });
    const sentinelBot = await createBot();
    const sentinel = await createRun(sentinelBot);
    expect(
      await findRunRecoveryBlockers(
        prisma,
        [{ id: queued.id, botId: bot.id, bot: { computerId: computer.id } }],
        new Date(),
      ),
    ).toEqual(new Map([[queued.id, holder.id]]));

    const realtime = new InMemoryRealtimeFanout();
    const starter = new RunStarter(realtime);
    const jobs = new RunJobPublisher(prisma, new InMemoryJobQueue(), starter);
    const host = new RunWorkerHost(prisma, realtime, starter, { intervalMs: 60_000, batchSize: 1 });
    const entered: string[] = [];
    try {
      await host.start({
        "run.continue": async ({ runId }, execution) => {
          if (runId === sentinel.id) {
            await prisma.run.update({ where: { id: runId }, data: { status: "completed" } });
            entered.push(runId);
            return;
          }
          if (runId !== queued.id) throw new Error("unexpected fixture dispatch");
          const claim = await prisma.run.updateMany({
            where: {
              id: runId,
              spaceId: scope.spaceId,
              botId: bot.id,
              status: "queued",
              leaseFence: 0,
            },
            data: {
              status: "running",
              leaseOwner: "next-worker",
              leaseFence: 1,
              leaseExpiresAt: future(),
            },
          });
          if (claim.count !== 1) return;
          const next = await acquireDedicatedScreenLeaseFence(prisma, {
            computerId: computer.id,
            botId: bot.id,
            runId,
            workerId: "next-worker",
            runFence: 1,
          });
          expect(next.fence).toBeGreaterThan(held.fence);
          expect(await renewComputerExecutionLease(prisma, next)).toBe(true);
          execution!.onRunStarted();
          await releaseComputerExecutionLease(prisma, next);
          await prisma.run.update({
            where: { id: runId },
            data: { status: "completed", leaseOwner: null, leaseExpiresAt: null },
          });
          entered.push(runId);
        },
      } as BackgroundJobHandlers);
      await wait(() => expect(entered).toEqual([sentinel.id]));
      expect(await prisma.run.findUniqueOrThrow({ where: { id: queued.id } })).toEqual(before);
      expect(await prisma.attempt.count({ where: { runId: queued.id } })).toBe(0);
      expect(await storedLease(computer.id)).toEqual(heldRow);
      await releaseComputerExecutionLease(prisma, held);
      const tombstone = await storedLease(computer.id);
      expect(tombstone.fence).toBe(held.fence);
      expect(tombstone.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(
        await findRunRecoveryBlockers(
          prisma,
          [{ id: queued.id, botId: bot.id, bot: { computerId: computer.id } }],
          new Date(),
        ),
      ).toEqual(new Map());
      // The release helper does not publish by itself. Exercise the actual
      // production producer explicitly after the resource becomes available.
      await jobs.enqueue(runContinueJob(queued.id));
      await wait(() => expect(entered).toEqual([sentinel.id, queued.id]));
      expect((await prisma.run.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe(
        "completed",
      );
      expect((await storedLease(computer.id)).runId).toBe(queued.id);
    } finally {
      await host.stop();
      await jobs.close();
      await realtime.close();
    }
  });

  it("increments a same-Run dedicated screen fence only for the newer owned worker", async () => {
    const computer = await createComputer(bot, "dedicated");
    const run = await createRun(bot, {
      status: "running",
      leaseOwner: "old-worker",
      leaseFence: 1,
      leaseExpiresAt: future(),
    });
    const first = await acquireDedicatedScreenLeaseFence(prisma, {
      computerId: computer.id,
      botId: bot.id,
      runId: run.id,
      workerId: "old-worker",
      runFence: 1,
    });
    await prisma.run.update({
      where: { id: run.id },
      data: { leaseOwner: "new-worker", leaseFence: 2, leaseExpiresAt: future() },
    });
    const second = await acquireDedicatedScreenLeaseFence(prisma, {
      computerId: computer.id,
      botId: bot.id,
      runId: run.id,
      workerId: "new-worker",
      runFence: 2,
    });
    expect(second.fence).toBe(first.fence + 1);
    expect(screenLeaseIdForRun(second, run.id)).toBe(`${run.id}:${second.fence}`);
    const row = await storedLease(computer.id);
    await expect(
      acquireDedicatedScreenLeaseFence(prisma, {
        computerId: computer.id,
        botId: bot.id,
        runId: run.id,
        workerId: "old-worker",
        runFence: 1,
      }),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(await renewComputerExecutionLease(prisma, first)).toBe(false);
    await releaseComputerExecutionLease(prisma, first);
    expect(await storedLease(computer.id)).toEqual(row);
    expect(await renewComputerExecutionLease(prisma, second)).toBe(true);
    await releaseComputerExecutionLease(prisma, second);
    expect((await storedLease(computer.id)).fence).toBe(second.fence);
  });

  it("requires current Team worker ownership and never treats a legacy resume flag as API authority", async () => {
    const computer = await createComputer(bot, "team");
    const run = await createRun(bot, {
      status: "running",
      leaseOwner: "old-worker",
      leaseFence: 1,
      leaseExpiresAt: future(),
    });
    const base = { computerId: computer.id, botId: bot.id, runId: run.id };
    const first = await acquireComputerExecutionLease(prisma, {
      ...base,
      workerId: "old-worker",
      runFence: 1,
    });
    expect(first).not.toBeNull();
    const row = await storedLease(computer.id);
    await expect(
      acquireComputerExecutionLease(prisma, { ...base, resumeHeldLease: true }),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    await prisma.run.update({
      where: { id: run.id },
      data: { leaseOwner: "new-worker", leaseFence: 2, leaseExpiresAt: future() },
    });
    await expect(
      acquireComputerExecutionLease(prisma, {
        ...base,
        workerId: "old-worker",
        runFence: 1,
        resumeHeldLease: true,
      }),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(await storedLease(computer.id)).toEqual(row);
    const next = await acquireComputerExecutionLease(prisma, {
      ...base,
      workerId: "new-worker",
      runFence: 2,
    });
    expect(next?.fence).toBe(first!.fence + 1);
    await releaseComputerExecutionLease(prisma, next);
    const api = await acquireComputerExecutionLease(prisma, base);
    expect(api?.fence).toBe(next!.fence + 1);
    await releaseComputerExecutionLease(prisma, api);
  });

  it("refuses dedicated acquisition when Bot switching or assignment changed", async () => {
    const computer = await createComputer(bot, "dedicated");
    const run = await createRun(bot, {
      status: "running",
      leaseOwner: "worker",
      leaseFence: 1,
      leaseExpiresAt: future(),
    });
    const input = {
      computerId: computer.id,
      botId: bot.id,
      runId: run.id,
      workerId: "worker",
      runFence: 1,
    };
    await acquireDedicatedScreenLeaseFence(prisma, input);
    const before = await storedLease(computer.id);
    await prisma.bot.update({ where: { id: bot.id }, data: { computerSwitching: true } });
    await expect(acquireDedicatedScreenLeaseFence(prisma, input)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(await storedLease(computer.id)).toEqual(before);
    const replacement = await prisma.computer.create({
      data: {
        userId: scope.userId,
        spaceId: scope.spaceId,
        scope: "dedicated",
        kind: "fake",
        state: "running",
        homeKey: randomUUID(),
        scopeKey: randomUUID(),
      },
    });
    await prisma.bot.update({
      where: { id: bot.id },
      data: { computerSwitching: false, computerId: replacement.id },
    });
    await expect(acquireDedicatedScreenLeaseFence(prisma, input)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(await storedLease(computer.id)).toEqual(before);
    expect(
      await prisma.computerExecutionLease.count({
        where: { computerId: replacement.id, botId: bot.id },
      }),
    ).toBe(0);
  });

  it.each([false, true])(
    "keeps user-held control protected during recovery (expired=%s)",
    async (expired) => {
      const computer = await createComputer(bot, "dedicated");
      const waiting = await createRun(bot, {
        status: "running",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: future(),
      });
      const lease = await acquireDedicatedScreenLeaseFence(prisma, {
        computerId: computer.id,
        botId: bot.id,
        runId: waiting.id,
        workerId: "worker",
        runFence: 1,
      });
      expect(await holdComputerExecutionLeaseForTakeover(prisma, lease)).toBe(true);
      await prisma.run.update({
        where: { id: waiting.id },
        data: {
          status: "waiting_takeover",
          leaseOwner: null,
          leaseExpiresAt: null,
          checkpoint: "takeover",
        },
      });
      const controlLeaseId = randomUUID();
      await prisma.computer.update({
        where: { id: computer.id },
        data: {
          controlHolder: "user",
          controlBotId: bot.id,
          controlRunId: waiting.id,
          controlLeaseId,
          controlLeaseExpiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)),
        },
      });
      const held = await storedLease(computer.id);
      const queued = await createRun(bot);
      const sentinelBot = await createBot();
      const sentinel = await createRun(sentinelBot);
      const queuedBefore = await prisma.run.findUniqueOrThrow({ where: { id: queued.id } });
      const realtime = new InMemoryRealtimeFanout();
      const host = new RunWorkerHost(prisma, realtime, new RunStarter(realtime), {
        intervalMs: 60_000,
        batchSize: 1,
      });
      const entered: string[] = [];
      try {
        await host.start({
          "run.continue": async ({ runId }) => {
            entered.push(runId);
            await prisma.run.update({ where: { id: runId }, data: { status: "completed" } });
          },
        } as BackgroundJobHandlers);
        await wait(() => expect(entered).toContain(sentinel.id));
        expect(entered).not.toContain(waiting.id);
        expect(entered).not.toContain(queued.id);
        expect(await prisma.run.findUniqueOrThrow({ where: { id: queued.id } })).toEqual(
          queuedBefore,
        );
        expect((await prisma.run.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe(
          "waiting_takeover",
        );
        expect(await prisma.attempt.count({ where: { runId: queued.id } })).toBe(0);
        expect(await storedLease(computer.id)).toEqual(held);
        expect(
          await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } }),
        ).toMatchObject({
          controlHolder: "user",
          controlRunId: waiting.id,
          controlBotId: bot.id,
          controlLeaseId,
        });
      } finally {
        await host.stop();
        await realtime.close();
      }
    },
  );
});
