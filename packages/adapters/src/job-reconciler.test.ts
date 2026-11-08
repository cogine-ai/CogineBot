import type {
  AdapterContext,
  BackgroundJob,
  JobPublisher,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { stuckWorkStatusMessages } from "@rakazo/core";
import type { Pool, Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { createThreadMessage } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { returnBotMessageOutcome } from "./bot-messages.js";
import {
  createJobReconciler,
  createPostgresReconciliationLeadership,
  type ReconciliationLeadership,
} from "./job-reconciler.js";
import { deliverMessagingOutbound } from "./messaging-delivery.js";
import { loopGuardStopText } from "./tool-loop.js";

vi.mock("./bot-messages.js", () => ({ returnBotMessageOutcome: vi.fn() }));

function publisher() {
  const enqueue = vi.fn(async (_job: BackgroundJob): Promise<void> => undefined);
  const jobs: JobPublisher = {
    enqueue,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return { jobs, enqueue };
}

function fakePrisma(
  runs: Array<{
    id: string;
    status?: string;
    updatedAt: Date;
    wakeAt?: Date | null;
    botId?: string;
    bot?: { computerId: string | null };
  }> = [],
  routines: Array<{ id: string; nextRunAt: Date | null }> = [],
  controls: Array<{
    id: string;
    controlBotId: string | null;
    controlLeaseId: string | null;
    controlLeaseExpiresAt: Date | null;
    updatedAt: Date;
  }> = [],
) {
  return {
    computerExecutionLease: { findMany: vi.fn(async () => []) },
    run: { findMany: vi.fn(async () => runs) },
    routine: { findMany: vi.fn(async () => routines) },
    computer: { findMany: vi.fn(async () => controls) },
    messagingOutbound: { findFirst: vi.fn(async () => null) },
  } as unknown as PrismaClient;
}

function retryScanPrisma(
  runs: Array<{ id: string; updatedAt: Date; status: "queued" | "failed"; routineRetryAt?: Date }>,
  prisma = fakePrisma(),
) {
  const findMany = async ({ where = {}, take }: Prisma.RunFindManyArgs = {}) => {
    const filters = Array.isArray(where.AND) ? where.AND : [];
    const ordinary = filters[0]?.OR?.some((filter) => filter.status === "queued");
    const retry =
      where.status === "failed"
        ? where
        : filters[0]?.OR?.find((filter) => filter.status === "failed");
    if (!ordinary && !retry) return [];
    const limit = retry?.routineRetryAt;
    const dueThrough = limit && typeof limit === "object" && "lte" in limit ? limit.lte : undefined;
    const cursor = (ordinary ? filters[1] : where)?.OR?.[1];
    const column = ordinary ? "updatedAt" : "routineRetryAt";
    const cursorAt = cursor?.[column];
    const lowerId = typeof cursor?.id === "object" ? cursor.id.gt : undefined;
    const cursorId = typeof lowerId === "string" ? lowerId : "";
    return runs
      .filter((run) => {
        if (run.status === "queued") return ordinary;
        return run.routineRetryAt && dueThrough instanceof Date && run.routineRetryAt <= dueThrough;
      })
      .filter((run) => {
        const at = run[column];
        return (
          !(cursorAt instanceof Date) ||
          (at && (at > cursorAt || (at.getTime() === cursorAt.getTime() && run.id > cursorId)))
        );
      })
      .sort((a, b) => a[column]!.getTime() - b[column]!.getTime() || a.id.localeCompare(b.id))
      .slice(0, take);
  };
  vi.mocked(prisma.run.findMany).mockImplementation(findMany as typeof prisma.run.findMany);
  return prisma;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createJobReconciler", () => {
  it("recovers a retry that became due behind a full ordinary Run cursor", async () => {
    const startedAt = new Date("2026-11-01T12:00:00.000Z");
    const retryAt = new Date(startedAt.getTime() + 1);
    const prisma = retryScanPrisma([
      { id: "queued-a", status: "queued", updatedAt: startedAt },
      { id: "queued-b", status: "queued", updatedAt: retryAt },
      {
        id: "failed-before-the-cursor",
        status: "failed",
        updatedAt: new Date(retryAt.getTime() - 12 * 60_000),
        routineRetryAt: retryAt,
      },
    ]);
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 1, maxPagesPerPass: 1 });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(startedAt);
      await reconciler.reconcileOnce();
      expect(enqueue.mock.calls.map(([job]) => job.replaceKey)).toEqual(["run:queued-a"]);

      enqueue.mockClear();
      vi.setSystemTime(retryAt);
      await reconciler.reconcileOnce();
      expect(enqueue.mock.calls.map(([job]) => job.replaceKey)).toEqual(
        expect.arrayContaining(["run:queued-b", "routine.retry:failed-before-the-cursor"]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("paginates due retries across publication failures and preserves the scan cutoff", async () => {
    const at = new Date("2026-11-01T12:00:00.000Z");
    const next = new Date(at.getTime() + 1);
    const prisma = retryScanPrisma(
      ["a", "b", "c", "d"].map((id) => ({
        id,
        status: "failed",
        updatedAt: new Date(at.getTime() - 12 * 60_000),
        routineRetryAt: id === "d" ? next : at,
      })),
    );
    const { jobs, enqueue } = publisher();
    enqueue.mockImplementation(async (job) => {
      if (job.replaceKey === "routine.retry:a") throw new Error("publication unavailable");
    });
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 2, maxPagesPerPass: 1 });
    const published = () => enqueue.mock.calls.map(([job]) => job.replaceKey);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(at);
      await reconciler.reconcileOnce();
      expect(published()).toEqual(["routine.retry:a", "routine.retry:b"]);

      enqueue.mockClear();
      vi.setSystemTime(next);
      await reconciler.reconcileOnce();
      expect(published()).toEqual(["routine.retry:c"]);

      enqueue.mockClear();
      await reconciler.reconcileOnce();
      expect(published()).toEqual(["routine.retry:a", "routine.retry:b"]);

      enqueue.mockClear();
      await reconciler.reconcileOnce();
      expect(published()).toEqual(["routine.retry:c", "routine.retry:d"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes due retries independently of ordinary Run publication errors", async () => {
    const at = new Date();
    const prisma = retryScanPrisma([
      { id: "queued", status: "queued", updatedAt: at },
      { id: "failed", status: "failed", updatedAt: at, routineRetryAt: at },
    ]);
    const { jobs, enqueue } = publisher();
    enqueue.mockImplementation(async (job) => {
      if (job.name === "run.continue") throw new Error("ordinary publication unavailable");
    });

    await expect(createJobReconciler({ prisma, jobs }).reconcileOnce()).rejects.toThrow(
      "ordinary publication unavailable",
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ replaceKey: "routine.retry:failed" }),
    );
  });

  it("stops the entire pass if leadership is lost between retry pages", async () => {
    const at = new Date();
    const prisma = retryScanPrisma([
      { id: "queued", status: "queued", updatedAt: at },
      { id: "failed-a", status: "failed", updatedAt: at, routineRetryAt: at },
      { id: "failed-b", status: "failed", updatedAt: at, routineRetryAt: at },
    ]);
    const { jobs, enqueue } = publisher();
    const leadership = {
      tryAcquire: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
      release: vi.fn(async () => undefined),
    };

    await createJobReconciler(
      { prisma, jobs, leadership },
      { batchSize: 1, maxPagesPerPass: 2 },
    ).reconcileOnce();

    expect(enqueue.mock.calls.map(([job]) => job.replaceKey)).toEqual(["routine.retry:failed-a"]);
    expect(leadership.tryAcquire).toHaveBeenCalledTimes(2);
  });

  it("continues recovering queued Runs while one group teardown pass is in flight", async () => {
    const pending = deferred();
    const reconcileGroupRunTeardowns = vi.fn(() => pending.promise);
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({
      prisma: fakePrisma([{ id: "run-waiting", status: "queued", updatedAt: new Date() }]),
      jobs,
      reconcileGroupRunTeardowns,
    });

    try {
      await reconciler.reconcileOnce();
      await reconciler.reconcileOnce();
      expect(reconcileGroupRunTeardowns).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    } finally {
      pending.resolve();
      await reconciler.stop();
    }
  });

  it("leaves queued resource waits untouched and recovers them after release", async () => {
    const run = {
      id: "run-waiting",
      status: "queued",
      wakeAt: null,
      updatedAt: new Date(Date.now() - 60_000),
      botId: "bot-1",
      bot: { computerId: "computer-1" },
    };
    const prisma = fakePrisma([run]);
    vi.mocked(prisma.computerExecutionLease.findMany).mockResolvedValue([
      { computerId: "computer-1", botId: "bot-1", runId: "run-holder" },
    ] as never);
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs });

    await reconciler.reconcileOnce();

    expect(enqueue).not.toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(prisma.computerExecutionLease.findMany).toHaveBeenCalledWith({
      where: { botId: { in: ["bot-1"] }, expiresAt: { gt: expect.any(Date) } },
      select: { computerId: true, botId: true, runId: true },
    });

    vi.mocked(prisma.computerExecutionLease.findMany).mockResolvedValue([]);
    await reconciler.reconcileOnce();

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run.continue",
        payload: { runId: run.id },
        keepExisting: true,
      }),
    );
  });

  it.each([
    { computerId: "computer-1", botId: "bot-1", runId: "run-lost" },
    { computerId: "old-computer", botId: "bot-1", runId: "run-holder" },
    { computerId: "computer-1", botId: "other-bot", runId: "run-holder" },
  ])("recovers a lost queued run with a nonblocking lease %j", async (lease) => {
    const prisma = fakePrisma([
      {
        id: "run-lost",
        status: "queued",
        wakeAt: null,
        updatedAt: new Date(),
        botId: "bot-1",
        bot: { computerId: "computer-1" },
      },
    ]);
    vi.mocked(prisma.computerExecutionLease.findMany).mockResolvedValue([lease] as never);
    const { jobs, enqueue } = publisher();

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run.continue",
        payload: { runId: "run-lost" },
        keepExisting: true,
      }),
    );
  });

  it("replaces any lock for an expired lease but only an old lock for a queued run", async () => {
    const prisma = fakePrisma([
      { id: "run-queued", status: "queued", updatedAt: new Date() },
      { id: "run-expired", status: "running", updatedAt: new Date() },
    ]);
    const { jobs, enqueue } = publisher();
    const before = Date.now();

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    const cutoff = (runId: string) => {
      const job = enqueue.mock.calls
        .map(([queued]) => queued)
        .find((queued) => queued.name === "run.continue" && queued.payload.runId === runId);
      return job?.name === "run.continue" ? job.replaceLockedBefore?.getTime() : undefined;
    };
    expect(cutoff("run-expired")).toBeGreaterThanOrEqual(before);
    expect(cutoff("run-queued")).toBeLessThanOrEqual(Date.now() - 5 * 60_000);
    expect(cutoff("run-queued")).toBeGreaterThanOrEqual(before - 5 * 60_000);
  });

  it("publishes a thousand due routines in one bounded pass", async () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const rows = Array.from({ length: 1_000 }, (_, index) => ({
      id: `routine-${String(index).padStart(4, "0")}`,
      nextRunAt: at,
    }));
    const prisma = fakePrisma();
    const findMany = vi.mocked(prisma.routine.findMany);
    findMany.mockImplementation(((args: Parameters<typeof prisma.routine.findMany>[0]) => {
      const filters = args?.where?.AND as Array<{ OR?: Array<{ id?: { gt: string } }> }>;
      const after = filters[1]?.OR?.[1]?.id?.gt;
      return Promise.resolve(rows.filter((row) => !after || row.id > after).slice(0, 100));
    }) as typeof prisma.routine.findMany);
    const { jobs, enqueue } = publisher();
    const auxiliary = vi.fn(async () => undefined);
    await createJobReconciler({ prisma, jobs, reconcileCloudAgents: auxiliary }).reconcileOnce();
    expect(enqueue).toHaveBeenCalledTimes(1_000);
    expect(new Set(enqueue.mock.calls.map(([job]) => job.replaceKey)).size).toBe(1_000);
    expect(findMany).toHaveBeenCalledTimes(10);
    expect(prisma.computer.findMany).toHaveBeenCalledOnce();
    // Stuck-work, due retries, ordinary Runs, and unmirrored messaging each scan once.
    expect(prisma.run.findMany).toHaveBeenCalledTimes(4);
    expect(prisma.messagingOutbound.findFirst).toHaveBeenCalledOnce();
    expect(auxiliary).toHaveBeenCalledOnce();
  });

  it("resumes after its page budget without rescanning completed categories", async () => {
    const prisma = fakePrisma();
    const at = new Date();
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `routine-${i}`, nextRunAt: at }));
    const findMany = vi.mocked(prisma.routine.findMany);
    findMany.mockImplementation(((args: Parameters<typeof prisma.routine.findMany>[0]) => {
      const filters = args?.where?.AND as Array<{ OR?: Array<{ id?: { gt: string } }> }>;
      const after = filters[1]?.OR?.[1]?.id?.gt;
      return Promise.resolve(rows.filter((row) => !after || row.id > after).slice(0, 2));
    }) as typeof prisma.routine.findMany);
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 2, maxPagesPerPass: 2 });
    await reconciler.reconcileOnce();
    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(prisma.computer.findMany).toHaveBeenCalledOnce();
    await reconciler.reconcileOnce();
    expect(enqueue.mock.calls.map(([job]) => job.replaceKey)).toEqual(
      rows.map((row) => `routine:${row.id}`),
    );
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("settles every publication before rejecting and retries the same page", async () => {
    const at = new Date();
    const prisma = fakePrisma(
      [],
      [
        { id: "routine-1", nextRunAt: at },
        { id: "routine-2", nextRunAt: at },
      ],
    );
    const { jobs, enqueue } = publisher();
    const pending = deferred();
    enqueue
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockImplementationOnce(() => pending.promise);
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 2, maxPagesPerPass: 1 });
    let settled = false;
    const first = reconciler.reconcileOnce().catch((error) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    const overlap = reconciler.reconcileOnce().catch(() => undefined);
    pending.resolve();
    expect(await first).toEqual(new Error("queue unavailable"));
    await overlap;
    await reconciler.reconcileOnce();
    expect(prisma.routine.findMany).toHaveBeenCalledTimes(2);
    expect(vi.mocked(prisma.routine.findMany).mock.calls[1]?.[0]?.where?.AND).toHaveLength(1);
    expect(enqueue.mock.calls.slice(0, 2)).toEqual(enqueue.mock.calls.slice(2));
  });

  it("stops between pages after in-flight publication and then releases leadership", async () => {
    const prisma = fakePrisma([], [{ id: "routine-1", nextRunAt: new Date() }]);
    const pending = deferred();
    const { jobs, enqueue } = publisher();
    enqueue.mockImplementation(() => pending.promise);
    const leadership = {
      tryAcquire: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    };
    const reconciler = createJobReconciler({ prisma, jobs, leadership }, { batchSize: 1 });
    const first = reconciler.reconcileOnce();
    const overlap = reconciler.reconcileOnce();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    const stop = reconciler.stop();
    expect(leadership.release).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all([first, overlap, stop]);
    await reconciler.reconcileOnce();
    expect(prisma.routine.findMany).toHaveBeenCalledOnce();
    expect(leadership.release).toHaveBeenCalledOnce();
  });

  it("checks leadership again before starting another page", async () => {
    const prisma = fakePrisma([], [{ id: "routine-1", nextRunAt: new Date() }]);
    const { jobs, enqueue } = publisher();
    const leadership = {
      tryAcquire: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
      release: vi.fn(),
    };
    await createJobReconciler({ prisma, jobs, leadership }, { batchSize: 1 }).reconcileOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(leadership.tryAcquire).toHaveBeenCalledTimes(2);
  });

  it("continues the main scans when an auxiliary reconciler fails", async () => {
    const prisma = fakePrisma();
    const { jobs } = publisher();
    const reconcileCloudAgents = vi.fn(async () => {
      throw new Error("cloud unavailable");
    });
    const reconcileComputerUpdates = vi.fn(() => {
      throw new Error("queue unavailable");
    });
    const reconcileNativeEvents = vi.fn(async () => undefined);
    await createJobReconciler({
      prisma,
      jobs,
      reconcileCloudAgents,
      reconcileComputerUpdates,
      reconcileNativeEvents,
    }).reconcileOnce();
    expect(reconcileCloudAgents).toHaveBeenCalledOnce();
    expect(reconcileComputerUpdates).toHaveBeenCalledOnce();
    expect(reconcileNativeEvents).toHaveBeenCalledOnce();
    expect(prisma.run.findMany).toHaveBeenCalled();
    expect(prisma.routine.findMany).toHaveBeenCalled();
    expect(prisma.computer.findMany).toHaveBeenCalled();
    expect(prisma.messagingOutbound.findFirst).toHaveBeenCalled();
  });

  it("restores a due pending messaging outbox drain", async () => {
    const prisma = fakePrisma();
    vi.mocked(prisma.messagingOutbound.findFirst).mockResolvedValue({ id: "outbound-1" } as never);
    const { jobs, enqueue } = publisher();

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    expect(prisma.messagingOutbound.findFirst).toHaveBeenCalledWith({
      where: {
        status: "pending",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: expect.any(Date) } }],
      },
      select: { id: true },
    });
    expect(enqueue).toHaveBeenCalledWith({
      name: "messaging.deliver",
      payload: {},
      replaceKey: "messaging.deliver:drain",
    });
  });

  it("restores a completed messaging run that was not durably mirrored", async () => {
    const prisma = fakePrisma();
    vi.mocked(prisma.run.findMany).mockImplementation((async ({
      where,
    }: Prisma.RunFindManyArgs = {}) =>
      where?.trigger === "messaging"
        ? [{ id: "run-unmirrored" }]
        : []) as typeof prisma.run.findMany);
    const { jobs, enqueue } = publisher();

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    expect(prisma.run.findMany).toHaveBeenCalledWith({
      where: {
        trigger: "messaging",
        status: { in: ["completed", "failed"] },
        messagingMirroredAt: null,
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true },
    });
    expect(enqueue).toHaveBeenCalledWith({
      name: "messaging.deliver",
      payload: { runId: "run-unmirrored" },
      replaceKey: "messaging.deliver:run-unmirrored",
    });
  });

  it("restores queued runs, due retries, and near-due routines with stable replacement keys", async () => {
    const scheduledFor = new Date(Date.now() + 30_000);
    const retryAt = new Date(Date.now() - 30_000);
    const controlExpiresAt = new Date(Date.now() + 15_000);
    const prisma = retryScanPrisma(
      [
        { id: "run-1", status: "queued", updatedAt: new Date() },
        { id: "failed-1", status: "failed", updatedAt: new Date(), routineRetryAt: retryAt },
      ],
      fakePrisma(
        [],
        [{ id: "routine-1", nextRunAt: scheduledFor }],
        [
          {
            id: "computer-1",
            controlBotId: "bot-1",
            controlLeaseId: "lease-1",
            controlLeaseExpiresAt: controlExpiresAt,
            updatedAt: new Date(),
          },
        ],
      ),
    );
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs });

    await reconciler.reconcileOnce();

    expect(enqueue).toHaveBeenCalledWith({
      name: "run.continue",
      payload: { runId: "run-1" },
      replaceKey: "run:run-1",
      keepExisting: true,
      replaceLockedBefore: expect.any(Date),
    });
    expect(enqueue).toHaveBeenCalledWith({
      name: "routine.wakeup",
      payload: { routineId: "routine-1", scheduledFor: scheduledFor.toISOString() },
      availableAt: scheduledFor,
      replaceKey: "routine:routine-1",
    });
    expect(enqueue).toHaveBeenCalledWith({
      name: "routine.retry",
      payload: { runId: "failed-1" },
      availableAt: retryAt,
      replaceKey: "routine.retry:failed-1",
      keepExisting: true,
      replaceLockedBefore: expect.any(Date),
    });
    expect(enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "failed-1" } }),
    );
    expect(enqueue).toHaveBeenCalledWith({
      name: "computer.control-expire",
      payload: { computerId: "computer-1", leaseId: "lease-1" },
      availableAt: controlExpiresAt,
      replaceKey: "computer.control-expire:computer-1:lease-1",
    });
    expect(vi.mocked(prisma.computer.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { controlLeaseId: { not: null } },
            {
              OR: [
                { controlLeaseExpiresAt: null },
                { controlLeaseExpiresAt: { lte: expect.any(Date) } },
              ],
            },
          ],
        },
        orderBy: [{ controlLeaseExpiresAt: "asc" }, { id: "asc" }],
      }),
    );
  });

  it("restores expiry for orphaned user-control leases without a control bot", async () => {
    const controlExpiresAt = new Date(Date.now() - 5_000);
    const prisma = fakePrisma(
      [],
      [],
      [
        {
          id: "computer-orphan",
          controlBotId: null,
          controlLeaseId: "lease-orphan",
          controlLeaseExpiresAt: controlExpiresAt,
          updatedAt: new Date(),
        },
      ],
    );
    const { jobs, enqueue } = publisher();

    await createJobReconciler({ prisma, jobs }).reconcileOnce();

    expect(enqueue).toHaveBeenCalledWith({
      name: "computer.control-expire",
      payload: { computerId: "computer-orphan", leaseId: "lease-orphan" },
      availableAt: controlExpiresAt,
      replaceKey: "computer.control-expire:computer-orphan:lease-orphan",
    });
  });

  it("finishes a frozen control scan before admitting leases ahead of its cursor", async () => {
    const firstExpiry = new Date(Date.now() + 10_000);
    const secondExpiry = new Date(Date.now() + 20_000);
    const controls = [
      {
        id: "computer-1",
        controlBotId: "bot-1",
        controlLeaseId: "lease-1",
        controlLeaseExpiresAt: firstExpiry,
      },
      {
        id: "computer-2",
        controlBotId: "bot-2",
        controlLeaseId: "lease-2",
        controlLeaseExpiresAt: secondExpiry,
      },
      {
        id: "computer-3",
        controlBotId: "bot-3",
        controlLeaseId: "lease-3",
        controlLeaseExpiresAt: null,
      },
    ];
    const computerFindMany = vi
      .fn()
      .mockResolvedValueOnce(controls.slice(0, 2))
      .mockResolvedValueOnce(controls.slice(2))
      .mockResolvedValueOnce([
        {
          id: "computer-0",
          controlBotId: "bot-0",
          controlLeaseId: "lease-0",
          controlLeaseExpiresAt: firstExpiry,
        },
      ]);
    const prisma = {
      run: { findMany: vi.fn(async () => []) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: computerFindMany },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 2, maxPagesPerPass: 1 });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(computerFindMany.mock.calls[1]?.[0]).toMatchObject({
      orderBy: [{ controlLeaseExpiresAt: "asc" }, { id: "asc" }],
      where: {
        AND: [
          expect.anything(),
          expect.anything(),
          {
            OR: [
              { controlLeaseExpiresAt: { gt: secondExpiry } },
              { controlLeaseExpiresAt: secondExpiry, id: { gt: "computer-2" } },
              { controlLeaseExpiresAt: null },
            ],
          },
        ],
      },
    });
    const firstDeadline =
      computerFindMany.mock.calls[0]?.[0].where.AND[1].OR[1].controlLeaseExpiresAt.lte;
    const secondDeadline =
      computerFindMany.mock.calls[1]?.[0].where.AND[1].OR[1].controlLeaseExpiresAt.lte;
    expect(secondDeadline).toEqual(firstDeadline);
    expect(computerFindMany.mock.calls[2]?.[0].where.AND).toHaveLength(2);
    expect(enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: { computerId: "computer-0", leaseId: "lease-0" },
      }),
    );
  });

  it("advances stable cursors so recoverable work beyond one batch is dispatched", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const runs = Array.from({ length: 5 }, (_, index) => ({
      id: `run-${index + 1}`,
      updatedAt: at,
    }));
    const routines = Array.from({ length: 5 }, (_, index) => ({
      id: `routine-${index + 1}`,
      nextRunAt: new Date(at.getTime() + index),
    }));
    const runPages = [runs.slice(0, 2), runs.slice(2, 4), runs.slice(4)];
    let runPage = 0;
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.messagingMirroredAt === null || args.where?.status === "failed") return [];
      // The stuck-work scan is the only run query that looks at takeover waits.
      if (JSON.stringify(args.where).includes("waiting_takeover")) return [];
      return runPages[runPage++] ?? [];
    });
    const routineFindMany = vi
      .fn()
      .mockResolvedValueOnce(routines.slice(0, 2))
      .mockResolvedValueOnce(routines.slice(2, 4))
      .mockResolvedValueOnce(routines.slice(4));
    const prisma = {
      computerExecutionLease: { findMany: vi.fn(async () => []) },
      run: { findMany: runFindMany },
      routine: { findMany: routineFindMany },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 2, maxPagesPerPass: 1 });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(enqueue).toHaveBeenCalledTimes(10);
    expect(enqueue.mock.calls.map(([job]) => job.replaceKey)).toEqual([
      "run:run-1",
      "run:run-2",
      "routine:routine-1",
      "routine:routine-2",
      "run:run-3",
      "run:run-4",
      "routine:routine-3",
      "routine:routine-4",
      "run:run-5",
      "routine:routine-5",
    ]);
    expect(runFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        where: {
          AND: [
            expect.anything(),
            {
              OR: [{ updatedAt: { gt: at } }, { updatedAt: at, id: { gt: "run-2" } }],
            },
          ],
        },
      }),
    );
    expect(routineFindMany.mock.calls[1]?.[0]).toMatchObject({
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      where: {
        AND: [
          expect.anything(),
          {
            OR: [
              { nextRunAt: { gt: routines[1]?.nextRunAt } },
              {
                nextRunAt: routines[1]?.nextRunAt,
                id: { gt: "routine-2" },
              },
            ],
          },
        ],
      },
    });
  });

  it("does not scan when another replica is the reconciliation leader", async () => {
    const prisma = fakePrisma();
    const leadership: ReconciliationLeadership = {
      tryAcquire: vi.fn(async () => false),
      release: vi.fn(async () => undefined),
    };
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs, leadership });

    await reconciler.reconcileOnce();
    await reconciler.stop();

    expect(prisma.run.findMany).not.toHaveBeenCalled();
    expect(prisma.routine.findMany).not.toHaveBeenCalled();
    expect(prisma.computer.findMany).not.toHaveBeenCalled();
    expect(prisma.messagingOutbound.findFirst).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(leadership.release).toHaveBeenCalledOnce();
  });

  it("retries terminal bot outcomes that were not returned", async () => {
    const terminalRun = {
      id: "run-terminal",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    let terminalScan = 0;
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.messagingMirroredAt === null) return [];
      if (args.where?.trigger === "bot_message") {
        terminalScan += 1;
        return terminalScan === 2 ? [] : [terminalRun];
      }
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
      message: {
        findMany: vi.fn(async () => [
          { blocks: [{ kind: "text", text: "Finished." }], clientNonce: null },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true).mockResolvedValueOnce(false);

    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 1 });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(runFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        where: {
          trigger: "bot_message",
          botOutcomeReturnedAt: null,
          OR: [
            { status: { in: ["completed", "failed"] } },
            { status: "cancelled", error: { in: [...stuckWorkStatusMessages()] } },
          ],
        },
      }),
    );
    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      "Finished.",
      "result",
    );
    expect(prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: terminalRun.id, botOutcomeReturnedAt: null },
        data: { updatedAt: expect.any(Date) },
      }),
    );
    expect(returnBotMessageOutcome).toHaveBeenCalledTimes(2);
  });

  it("prefers the latest final reply over earlier untagged narration", async () => {
    const terminalRun = {
      id: "run-takeover",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.messagingMirroredAt === null) return [];
      if (args.where?.trigger === "bot_message") return [terminalRun];
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
      message: {
        findMany: vi.fn(async () => [
          {
            blocks: [{ kind: "text", text: "Opening the calendar app…" }],
            clientNonce: null,
          },
          {
            blocks: [{ kind: "text", text: "Tuesday afternoon works." }],
            clientNonce: null,
          },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 1 });
    await reconciler.reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      "Tuesday afternoon works.",
      "result",
    );
  });

  it("recovers a completed loop-guard stop as an unread result", async () => {
    const terminalRun = {
      id: "run-loop-guard",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    const stuckText = loopGuardStopText("search", { key: "search:{}", count: 8 });
    expect(stuckText).toContain("with the same input 8 times in a row");
    const prisma = {
      run: {
        findMany: vi.fn(async (args: { where?: Record<string, unknown> } = {}) =>
          args.where?.trigger === "bot_message" ? [terminalRun] : [],
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
      message: {
        findMany: vi.fn(async () => [
          { blocks: [{ kind: "text", text: "Searching…" }], clientNonce: null },
          { blocks: [{ kind: "text", text: stuckText }], clientNonce: null },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    await createJobReconciler({ prisma, jobs, events }).reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      stuckText,
      "result",
    );
  });

  it("prefers the final reply over progress when reconciling", async () => {
    const terminalRun = {
      id: "run-mixed",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.messagingMirroredAt === null) return [];
      if (args.where?.trigger === "bot_message") return [terminalRun];
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
      message: {
        findMany: vi.fn(async () => [
          {
            blocks: [{ kind: "text", text: "Checking calendars…" }],
            clientNonce: "user-progress:run-mixed:0",
          },
          {
            blocks: [{ kind: "text", text: "Tuesday afternoon works." }],
            clientNonce: null,
          },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 1 });
    await reconciler.reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      "Tuesday afternoon works.",
      "result",
    );
  });

  it("returns progress-only transcripts as status", async () => {
    const terminalRun = {
      id: "run-progress",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status: "completed",
      error: null,
      bot: { name: "Researcher" },
    };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.messagingMirroredAt === null) return [];
      if (args.where?.trigger === "bot_message") return [terminalRun];
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
      message: {
        findMany: vi.fn(async () => [
          {
            blocks: [{ kind: "text", text: "Checking calendars…" }],
            clientNonce: "user-progress:run-progress:0",
          },
        ]),
      },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    const reconciler = createJobReconciler({ prisma, jobs, events }, { batchSize: 1 });
    await reconciler.reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      "Checking calendars…",
      "status",
    );
  });

  it.each(["cancelled", "failed"])("returns a %s peer run as unread status", async (status) => {
    const terminalRun = {
      id: "run-stuck",
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      status,
      error: stuckWorkStatusMessages()[0],
      bot: { name: "Researcher" },
    };
    const runFindMany = vi.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      if (args.where?.messagingMirroredAt === null) return [];
      if (args.where?.trigger === "bot_message") return [terminalRun];
      return [];
    });
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      messagingOutbound: { findFirst: vi.fn(async () => null) },
      message: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const { jobs } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    vi.mocked(returnBotMessageOutcome).mockResolvedValue(true);

    await createJobReconciler({ prisma, jobs, events }).reconcileOnce();

    expect(returnBotMessageOutcome).toHaveBeenCalledWith(
      { prisma, jobs, events },
      terminalRun,
      { id: "bot-1", name: "Researcher" },
      status === "failed"
        ? `Could not complete the delegated request: ${stuckWorkStatusMessages()[0]}`
        : stuckWorkStatusMessages()[0],
      "status",
    );
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });
});

describe("createPostgresReconciliationLeadership", () => {
  it("retains leadership for one replica and transfers it after release", async () => {
    let locked = false;
    const clients: Array<{
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
    }> = [];
    const pool = {
      connect: vi.fn(async () => {
        const client = {
          query: vi.fn(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
              const acquired = !locked;
              if (acquired) locked = true;
              return { rows: [{ acquired }] };
            }
            const released = locked;
            locked = false;
            return { rows: [{ released }] };
          }),
          release: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn(),
        };
        clients.push(client);
        return client;
      }),
    } as unknown as Pick<Pool, "connect">;
    const first = createPostgresReconciliationLeadership(pool);
    const second = createPostgresReconciliationLeadership(pool);

    await expect(first.tryAcquire()).resolves.toBe(true);
    await expect(first.tryAcquire()).resolves.toBe(true);
    await expect(second.tryAcquire()).resolves.toBe(false);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(clients[1]?.release).toHaveBeenCalledOnce();

    await first.release();
    await expect(second.tryAcquire()).resolves.toBe(true);
    expect(clients[0]?.removeListener).toHaveBeenCalledWith("error", expect.any(Function));
    expect(clients[0]?.release).toHaveBeenCalledWith(false);
  });
});

function messagingRecoveryFixture(
  options: { trigger?: string; channel?: boolean; identity?: boolean } = {},
) {
  const run = {
    id: "failed-messaging-run",
    spaceId: "space-recovery",
    userId: "user-recovery",
    botId: "bot-recovery",
    threadId: "thread-recovery",
    status: "running",
    trigger: options.trigger ?? "messaging",
    messagingMirroredAt: null as Date | null,
    updatedAt: new Date("2026-11-04T00:00:00Z"),
    sourceMessage: {
      blocks: options.channel ? [{ kind: "channel_message", channelId: "channel-recovery" }] : [],
    },
  };
  const attempt = { id: "attempt-recovery", runId: run.id, status: "running", leaseFence: 7 };
  const messages: Array<{
    id: string;
    runId: string;
    role: string;
    seq: number;
    blocks: MessageBlock[];
  }> = [];
  const outbox: Array<{
    id: string;
    idempotencyKey: string;
    status: string;
    body: string;
    identityId?: string;
    threadId?: string;
    providerHandle?: string;
  }> = [];
  const identity =
    options.identity === false
      ? null
      : {
          id: "identity-recovery",
          botId: run.botId,
          provider: "slack",
          address: "fixture-owner",
          userId: run.userId,
          spaceId: run.spaceId,
          dmThreadId: "slack:recovery-dm",
          outboundSinceInbound: 0,
        };
  let nextMessageSeq = 1;
  const client = {
    run: {
      findUnique: vi.fn(async () => run),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            trigger?: string;
            status?: string | { in: string[] };
            messagingMirroredAt?: null;
          };
        }) => {
          // Match the actual recovery predicate; unconditional rows would conceal completed-only regressions.
          if (where.messagingMirroredAt !== null) return [];
          const statuses =
            typeof where.status === "string" ? [where.status] : (where.status?.in ?? []);
          return run.trigger === where.trigger &&
            statuses.includes(run.status) &&
            run.messagingMirroredAt === null
            ? [run]
            : [];
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; trigger?: string };
          data: { messagingMirroredAt: Date };
        }) => {
          if (where.id !== run.id || (where.trigger !== undefined && where.trigger !== run.trigger))
            return { count: 0 };
          run.messagingMirroredAt = data.messagingMirroredAt;
          return { count: 1 };
        },
      ),
    },
    thread: { update: vi.fn(async () => ({ nextMessageSeq: ++nextMessageSeq })) },
    message: {
      create: vi.fn(async ({ data }: { data: Omit<(typeof messages)[number], "id"> }) => {
        const row = { id: `durable-reply-${messages.length + 1}`, ...data };
        messages.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: { runId: string; role: string } }) =>
        messages.filter((message) => message.runId === where.runId && message.role === where.role),
      ),
    },
    computerExecutionLease: { findMany: vi.fn(async () => []) },
    routine: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => ({ name: "Fixture Owner" })) },
    messagingIdentity: {
      findUnique: vi.fn(async () => identity),
      update: vi.fn(async () => identity),
    },
    messagingChannel: {
      findUnique: vi.fn(async () => ({ id: "channel-recovery", threadId: "slack:recovery-group" })),
    },
    messagingChannelMember: { findMany: vi.fn(async () => []) },
    messagingOutbound: {
      findFirst: vi.fn(async () => outbox.find((row) => row.status === "pending") ?? null),
      findMany: vi.fn(async ({ where }: { where: { status: string } }) =>
        outbox.filter((row) => row.status === where.status),
      ),
      createMany: vi.fn(
        async ({ data }: { data: Array<Omit<(typeof outbox)[number], "id" | "status">> }) => {
          let count = 0;
          for (const item of data) {
            if (outbox.some((row) => row.idempotencyKey === item.idempotencyKey)) continue;
            outbox.push({ id: `outbound-${outbox.length + 1}`, status: "pending", ...item });
            count += 1;
          }
          return { count };
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<(typeof outbox)[number]>;
        }) => {
          const row = outbox.find((entry) => entry.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status?: string };
          data: Partial<(typeof outbox)[number]>;
        }) => {
          const row = outbox.find(
            (entry) =>
              entry.id === where.id &&
              (where.status === undefined || entry.status === where.status),
          );
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
  };
  const prisma = {
    ...client,
    $transaction: vi.fn(async (work: (tx: typeof client) => unknown) => work(client)),
  } as unknown as PrismaClient;
  const { jobs, enqueue } = publisher();
  const sendToThread = vi.fn(async () => ({ handle: "synthetic-recovery-handle" }));
  const messaging = { sendToThread } as unknown as MessagingSurface;
  const events = {
    notify: vi.fn(async () => undefined),
    sendUserMessage: vi.fn(),
  } as unknown as ThreadEvents;
  const context: AdapterContext = {
    operationId: "fixture-recovery",
    traceId: "fixture-recovery",
    userId: run.userId,
    spaceId: run.spaceId,
    signal: new AbortController().signal,
  };
  const reconciler = createJobReconciler({ prisma, jobs });
  const deliver = () =>
    deliverMessagingOutbound({ prisma, jobs, messaging, events }, { runId: run.id }, context);
  const persistReply = (blocks: MessageBlock[]) =>
    createThreadMessage(prisma, {
      threadId: run.threadId,
      runId: run.id,
      botId: run.botId,
      role: "bot",
      blocks,
    });
  const fail = () => {
    run.status = "failed";
    attempt.status = "failed";
  };
  return {
    run,
    attempt,
    messages,
    outbox,
    prisma,
    client,
    enqueue,
    sendToThread,
    events,
    reconciler,
    deliver,
    persistReply,
    fail,
  };
}

describe("terminal messaging recovery", () => {
  it("recovers a durable response after failure without restarting the run or duplicating delivery", async () => {
    const fixture = messagingRecoveryFixture();
    await fixture.persistReply([{ kind: "text", text: "The saved reply" }]);
    fixture.fail();
    const terminal = structuredClone(fixture.run);
    const attempt = structuredClone(fixture.attempt);

    await fixture.reconciler.reconcileOnce();
    await fixture.reconciler.reconcileOnce();
    expect(fixture.enqueue.mock.calls.map(([job]) => job)).toEqual([
      {
        name: "messaging.deliver",
        payload: { runId: fixture.run.id },
        replaceKey: `messaging.deliver:${fixture.run.id}`,
      },
      {
        name: "messaging.deliver",
        payload: { runId: fixture.run.id },
        replaceKey: `messaging.deliver:${fixture.run.id}`,
      },
    ]);
    await fixture.deliver();
    await fixture.deliver();
    await fixture.reconciler.reconcileOnce();

    expect(fixture.enqueue).toHaveBeenCalledTimes(2);
    expect(fixture.outbox).toEqual([
      expect.objectContaining({
        idempotencyKey: `msg:${fixture.messages[0]!.id}`,
        body: "The saved reply",
        status: "sent",
        providerHandle: "synthetic-recovery-handle",
      }),
    ]);
    expect(fixture.sendToThread).toHaveBeenCalledExactlyOnceWith(
      { threadId: "slack:recovery-dm", body: "The saved reply" },
      expect.anything(),
    );
    expect(fixture.run).toEqual({ ...terminal, messagingMirroredAt: expect.any(Date) });
    expect(fixture.attempt).toEqual(attempt);
  });

  it("settles a failed run without a reply without inventing an error message", async () => {
    const fixture = messagingRecoveryFixture();
    fixture.fail();
    await fixture.reconciler.reconcileOnce();
    expect(fixture.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "messaging.deliver", payload: { runId: fixture.run.id } }),
    );
    await fixture.deliver();
    await fixture.reconciler.reconcileOnce();
    expect(fixture.enqueue).toHaveBeenCalledOnce();
    expect(fixture.run.status).toBe("failed");
    expect(fixture.run.messagingMirroredAt).toBeInstanceOf(Date);
    expect(fixture.outbox).toEqual([]);
    expect(fixture.sendToThread).not.toHaveBeenCalled();
  });

  it.each(["user", "routine", "bot_message", "cancelled"])(
    "does not recover %s as failed inbound messaging",
    async (excluded) => {
      const fixture = messagingRecoveryFixture({
        trigger: excluded === "cancelled" ? "messaging" : excluded,
      });
      await fixture.persistReply([{ kind: "text", text: "Not for automatic recovery" }]);
      fixture.fail();
      if (excluded === "cancelled") fixture.run.status = "cancelled";
      await fixture.reconciler.reconcileOnce();
      expect(fixture.enqueue).not.toHaveBeenCalled();
      expect(fixture.run.messagingMirroredAt).toBeNull();
      expect(fixture.outbox).toEqual([]);
    },
  );

  it("keeps a failed channel run with a private answer out of the group and peer fan-out", async () => {
    const fixture = messagingRecoveryFixture({ channel: true });
    await fixture.persistReply([
      { kind: "ask", text: "Which detail?", status: "answered", answer: "Private fixture detail" },
      { kind: "text", text: "Reply using private detail" },
    ]);
    fixture.fail();
    await fixture.reconciler.reconcileOnce();
    expect(fixture.enqueue).toHaveBeenCalledOnce();
    await fixture.deliver();
    await fixture.deliver();
    expect(fixture.run.messagingMirroredAt).toBeInstanceOf(Date);
    expect(fixture.outbox).toEqual([]);
    expect(fixture.sendToThread).not.toHaveBeenCalled();
    expect(fixture.events.sendUserMessage).not.toHaveBeenCalled();
    expect(fixture.client.messagingChannelMember.findMany).not.toHaveBeenCalled();
  });

  it("settles recovery without sending after the messaging identity has been removed", async () => {
    const fixture = messagingRecoveryFixture({ identity: false });
    await fixture.persistReply([{ kind: "text", text: "Saved while linked" }]);
    fixture.fail();
    await fixture.reconciler.reconcileOnce();
    expect(fixture.enqueue).toHaveBeenCalledOnce();
    await fixture.deliver();
    expect(fixture.run.messagingMirroredAt).toBeInstanceOf(Date);
    expect(fixture.outbox).toEqual([]);
    expect(fixture.sendToThread).not.toHaveBeenCalled();
  });
});
