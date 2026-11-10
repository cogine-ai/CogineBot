import type { ComputerRef, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { computerSleepJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { inspectComputerPower, powerProvider } from "./computer-power.js";
import { toComputerRef } from "./computer-support.js";

export const DEFAULT_COMPUTER_MAX_ACTIVE_MS = 2 * 60 * 60 * 1000;
export const ABANDONED_ACTIVE_LIMIT_CLAIM_MS = 60 * 60_000;
const ABANDONED_ACTIVE_LIMIT_QUEUE_MS = 5 * 60_000;

/** Older rows get a conservative deadline after the first verified running observation. */
export function computerActiveEpoch(computer: {
  runningSince?: Date | null;
  runningObservedAt?: Date | null;
}) {
  return computer.runningSince ?? computer.runningObservedAt;
}

export function computerMaxActiveMs(): number {
  const raw = Number(process.env.COMPUTER_MAX_ACTIVE_MS?.trim() || DEFAULT_COMPUTER_MAX_ACTIVE_MS);
  return Number.isFinite(raw) && (raw === 0 || raw >= 60_000)
    ? raw
    : DEFAULT_COMPUTER_MAX_ACTIVE_MS;
}

export function computerActiveDeadline(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  runningSince: Date | null | undefined,
): Date | undefined {
  const limit = computerMaxActiveMs();
  if (
    limit > 0 &&
    runningSince &&
    ref.kind !== "desktop" &&
    powerProvider(sandbox, ref)?.billsWhileRunning?.(ref) === true
  ) {
    const at = new Date(runningSince.getTime() + limit);
    if (Number.isFinite(at.getTime())) return at;
  }
}

export function scheduleComputerActiveLimit(
  jobs: JobPublisher,
  id: string,
  runningSince: Date,
  at: Date,
) {
  return jobs
    .enqueue(computerSleepJob(id, at, { since: runningSince, limitMs: computerMaxActiveMs() }))
    .catch((error) => {
      getLogger().warn("computer.active_limit_schedule_failed", { "computer.id": id, error });
    });
}

/** Repair missed or exhausted deadline jobs via the existing reconciler. */
export function createComputerActiveLimitRecovery(deps: {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  jobs: JobPublisher;
}) {
  let lastPass: number | undefined;
  let cursor: string | undefined;
  return async () => {
    const now = Date.now();
    const limitMs = computerMaxActiveMs();
    if (limitMs === 0 || (lastPass !== undefined && now - lastPass < 60_000)) return;
    lastPass = now;
    const dueBy = new Date(now - limitMs);
    const abandonedBefore = new Date(now - ABANDONED_ACTIVE_LIMIT_CLAIM_MS);
    const computers = await runAsSystem("reconcile overdue computer time limits", () =>
      deps.prisma.computer.findMany({
        where: {
          kind: { not: "desktop" },
          providerRef: { not: null },
          stopRequestedAt: null,
          maintenanceId: null,
          AND: [
            {
              OR: [
                { state: "running" },
                { state: "suspending", updatedAt: { lte: abandonedBefore } },
              ],
            },
            {
              OR: [
                { runningSince: { lte: dueBy } },
                { runningSince: null, runningObservedAt: { lte: dueBy } },
                { state: "running", runningSince: null, runningObservedAt: null },
              ],
            },
          ],
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: {
          id: true,
          homeKey: true,
          kind: true,
          providerRef: true,
          providerAuthority: true,
          runningSince: true,
          runningObservedAt: true,
          state: true,
          screenGeneration: true,
          updatedAt: true,
          spaceId: true,
          userId: true,
        },
        orderBy: { id: "asc" },
        take: 25,
      }),
    );
    for (let offset = 0; offset < computers.length; offset += 5) {
      const queued = await Promise.allSettled(
        computers.slice(offset, offset + 5).map(async (computer) => {
          const ref = toComputerRef(computer);
          let epoch = computerActiveEpoch(computer);
          if (!epoch) {
            if (!computerActiveDeadline(deps.sandbox, ref, new Date(now))) return;
            const power = await inspectComputerPower(deps.sandbox, ref, {
              operationId: "computer.limit.observe",
              traceId: "computer.limit.observe",
              userId: computer.userId,
              spaceId: computer.spaceId,
              signal: AbortSignal.timeout(10_000),
            });
            if (power !== "running") return;
            const observedAt = new Date();
            const recorded = await runAsSystem("record verified running computer observation", () =>
              deps.prisma.computer.updateMany({
                where: {
                  id: computer.id,
                  providerRef: computer.providerRef,
                  providerAuthority: computer.providerAuthority,
                  kind: computer.kind,
                  screenGeneration: computer.screenGeneration,
                  state: "running",
                  updatedAt: computer.updatedAt,
                  stopRequestedAt: null,
                  maintenanceId: null,
                  runningSince: null,
                  runningObservedAt: null,
                },
                data: { runningObservedAt: observedAt, updatedAt: computer.updatedAt },
              }),
            );
            if (recorded.count !== 1) return;
            epoch = observedAt;
          }
          const deadline = computerActiveDeadline(deps.sandbox, ref, epoch);
          if (!deadline) return;
          await deps.jobs.enqueue({
            ...computerSleepJob(computer.id, deadline, { since: epoch, limitMs }),
            keepExisting: true,
            replaceLockedBefore:
              computer.state === "suspending"
                ? abandonedBefore
                : new Date(now - ABANDONED_ACTIVE_LIMIT_QUEUE_MS),
          });
        }),
      );
      for (const result of queued) {
        if (result.status === "rejected") {
          getLogger().warn("computer.active_limit_reconcile_failed", { error: result.reason });
        }
      }
    }
    cursor = computers.length === 25 ? computers.at(-1)?.id : undefined;
  };
}
