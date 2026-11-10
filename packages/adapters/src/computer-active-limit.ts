import type { ComputerRef, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { computerSleepJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { powerProvider } from "./computer-power.js";
import { toComputerRef } from "./computer-support.js";

export const DEFAULT_COMPUTER_MAX_ACTIVE_MS = 2 * 60 * 60 * 1000;

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
    const computers = await runAsSystem("reconcile overdue computer time limits", () =>
      deps.prisma.computer.findMany({
        where: {
          state: "running",
          kind: { not: "desktop" },
          providerRef: { not: null },
          runningSince: { lte: new Date(now - limitMs) },
          stopRequestedAt: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: {
          id: true,
          homeKey: true,
          kind: true,
          providerRef: true,
          providerAuthority: true,
          runningSince: true,
        },
        orderBy: { id: "asc" },
        take: 100,
      }),
    );
    const queued = await Promise.allSettled(
      computers.map(async (computer) => {
        const deadline = computerActiveDeadline(
          deps.sandbox,
          toComputerRef(computer),
          computer.runningSince,
        );
        if (!deadline || !computer.runningSince) return;
        return deps.jobs.enqueue({
          ...computerSleepJob(computer.id, deadline, { since: computer.runningSince, limitMs }),
          keepExisting: true,
        });
      }),
    );
    for (const result of queued) {
      if (result.status === "rejected") {
        getLogger().warn("computer.active_limit_reconcile_failed", { error: result.reason });
      }
    }
    cursor = computers.length === 100 ? computers.at(-1)?.id : undefined;
  };
}
