import { runContinueJob, runQuotaResumeJob } from "@rakazo/adapter-kit";
import { runQuotaWaitStateSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";
import type { TakeoverResumeCheckpoint } from "./takeover-resume.js";
import { TAKEOVER_RESUME_CHECKPOINTS } from "./takeover-resume.js";

export async function renewRunLease(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
): Promise<boolean> {
  const renewed = await deps.prisma.run.updateMany({
    where: {
      id: runId,
      status: "running",
      leaseOwner: workerId,
      leaseFence: fence,
    },
    data: { leaseExpiresAt: new Date(Date.now() + 5 * 60_000) },
  });
  return renewed.count === 1;
}

/** Consecutive setup failures, including this one, after which a run fails instead of retrying. */
export const RUN_SETUP_FAILURE_LIMIT = 8;

/**
 * Setup failures in a row before the current attempt. Busy-computer and database waits are
 * setup_failed attempts without an error; they neither count nor break the streak.
 */
export async function setupFailureStreak(prisma: PrismaClient, runId: string): Promise<number> {
  const recent = await prisma.attempt.findMany({
    where: {
      runId,
      status: { not: "running" },
      NOT: { status: "setup_failed", error: null },
    },
    orderBy: { fence: "desc" },
    take: RUN_SETUP_FAILURE_LIMIT,
    select: { status: true },
  });
  const streak = recent.findIndex((attempt) => attempt.status !== "setup_failed");
  return streak === -1 ? recent.length : streak;
}

export function computerRetryDelay(fence: number): number {
  return Math.min(10_000, 250 * 2 ** Math.min(Math.max(fence - 1, 0), 5));
}

/**
 * An outage at the computer provider usually lasts minutes, so the retries a run gets before
 * failing are spread over about a quarter of an hour instead of spent within seconds.
 */
export function providerOutageRetryDelay(priorFailures: number): number {
  return Math.min(5 * 60_000, 15_000 * 2 ** Math.min(priorFailures, 5));
}

/**
 * A bot uses its computer for one run at a time. On release, start the oldest
 * other run already due, including a quota wait parked on the computer.
 */
export async function startNextWaitingRun(
  { prisma, jobs }: Pick<ExecutorDeps, "prisma" | "jobs">,
  botId: string,
  releasedBy: string,
): Promise<void> {
  const now = new Date();
  const scope = { botId, id: { not: releasedBy } };
  const orderBy = [{ createdAt: "asc" as const }, { id: "asc" as const }];
  const queued = {
    status: "queued",
    OR: [{ wakeAt: null }, { wakeAt: { lte: now } }],
  };
  const next = await prisma.run.findFirst({
    where: {
      ...scope,
      OR: [queued, { status: "waiting_limit", wakeAt: { lte: now } }],
    },
    orderBy,
    select: { id: true, status: true, wakeAt: true, quotaWait: true },
  });
  if (!next) return;
  if (next.status !== "waiting_limit") {
    await jobs.enqueue(runContinueJob(next.id));
    return;
  }

  const state = runQuotaWaitStateSchema.safeParse(next.quotaWait).data;
  if (state?.dispatchedFence === null && next.wakeAt && Date.parse(state.until) <= now.getTime()) {
    await jobs.enqueue(runQuotaResumeJob(next.id, state.revision, next.wakeAt));
    return;
  }
  // An invalid or stale wait must not prevent another queued run from using the computer.
  const fallback = await prisma.run.findFirst({
    where: { ...scope, ...queued },
    orderBy,
    select: { id: true },
  });
  if (fallback) await jobs.enqueue(runContinueJob(fallback.id));
}

/** Open the model only while this worker still owns the running lease. */
export function mayOpenModelStream(
  run: { status: string; leaseOwner: string | null; leaseFence: number | null } | null,
  workerId: string,
  fence: number,
  aborted: boolean,
): boolean {
  return (
    run?.status === "running" && run.leaseOwner === workerId && run.leaseFence === fence && !aborted
  );
}

function computerRunRequeueData(
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  error: string | null = null,
  heldForTakeover = false,
) {
  return {
    status:
      heldForTakeover && !resumeCheckpoint ? ("waiting_takeover" as const) : ("queued" as const),
    error,
    leaseOwner: null,
    leaseExpiresAt: null,
    checkpoint: resumeCheckpoint,
  };
}

export async function writeComputerRunRequeue(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  heldForTakeover = false,
  error: string | null = null,
  retryAt: Date | null = new Date(Date.now() + computerRetryDelay(fence)),
): Promise<boolean> {
  const whereLease = {
    id: runId,
    status: "running" as const,
    leaseOwner: workerId,
    leaseFence: fence,
  };
  const releasedHold = {
    status: "queued" as const,
    // An explicit due time distinguishes a resource wait from a legacy retry
    // whose writer does not know wakeAt. No retry job is scheduled for this wait.
    wakeAt: retryAt ?? new Date(),
    error,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  const preserve = await deps.prisma.run.updateMany({
    where: {
      ...whereLease,
      checkpoint: { in: [...TAKEOVER_RESUME_CHECKPOINTS] },
    },
    data: releasedHold,
  });
  if (preserve.count === 1) return true;
  const plannedData = computerRunRequeueData(resumeCheckpoint, error, heldForTakeover);
  const planned = await deps.prisma.run.updateMany({
    where: { ...whereLease, checkpoint: null },
    data: {
      ...plannedData,
      wakeAt: plannedData.status === "queued" ? releasedHold.wakeAt : retryAt,
    },
  });
  if (planned.count === 1) return true;
  const retried = await deps.prisma.run.updateMany({
    where: {
      ...whereLease,
      checkpoint: { in: [...TAKEOVER_RESUME_CHECKPOINTS] },
    },
    data: releasedHold,
  });
  return retried.count === 1;
}

/**
 * This worker is stopping and still owns the run. Queue it for another worker.
 * The row stays recoverable: no failure is recorded, and the lease does not keep
 * the next worker from claiming it.
 */
export async function requeueRunAfterShutdown(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
): Promise<boolean> {
  const released = await deps.prisma.run.updateMany({
    where: {
      id: runId,
      status: "running",
      leaseOwner: workerId,
      leaseFence: fence,
    },
    data: {
      status: "queued",
      error: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      wakeAt: new Date(),
    },
  });
  if (released.count !== 1) return false;
  await deps.jobs
    .enqueue(runContinueJob(runId))
    .catch((error) => getLogger().error("shutdown run requeue", error));
  return true;
}

/**
 * `untilReleased` is for a computer another run of the same bot holds: the run waits
 * without a retry timer, and the run releasing the computer starts it.
 */
export async function requeueComputerRun(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  heldForTakeover = false,
  untilReleased = false,
): Promise<void> {
  const retryAt = new Date(Date.now() + computerRetryDelay(fence));
  const released = await writeComputerRunRequeue(
    deps,
    runId,
    workerId,
    fence,
    resumeCheckpoint,
    heldForTakeover,
    null,
    untilReleased ? null : retryAt,
  );
  if (!released || untilReleased) return;
  await deps.jobs.enqueue({
    ...runContinueJob(runId),
    availableAt: retryAt,
  });
}
