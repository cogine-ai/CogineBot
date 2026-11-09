import type { RunQuotaWaitState } from "@rakazo/contracts";
import { RUN_QUOTA_WAIT_MAX_MS, runQuotaWaitStateSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

type RecoveryRun = {
  id: string;
  botId: string;
  bot: { computerId: string | null };
  quotaWait?: unknown;
};

export function pendingQuotaWaitExpired(
  state: RunQuotaWaitState | undefined,
  now: number,
): boolean {
  return state?.dispatchedFence === null && now > Date.parse(state.beganAt) + RUN_QUOTA_WAIT_MAX_MS;
}

/** Leave resource waits untouched so recovery preserves their age and execution history. */
export async function findRunRecoveryBlockers(
  prisma: PrismaClient,
  runs: readonly RecoveryRun[],
  now: Date,
): Promise<Map<string, string>> {
  const clock = now.getTime();
  const candidates = runs.filter((run) => {
    if (run.quotaWait == null) return true;
    const state = runQuotaWaitStateSchema.safeParse(run.quotaWait).data;
    if (state?.dispatchedFence !== null) return true;
    // Expiry only needs a Run fence. A recovered due wait also needs its first computer
    // admission so an existing holder can be reported before later scans skip the wait.
    return (
      !pendingQuotaWaitExpired(state, clock) &&
      (state.waitingForComputer || Date.parse(state.until) > clock)
    );
  });
  const leases = candidates.length
    ? await prisma.computerExecutionLease.findMany({
        where: { botId: { in: candidates.map((run) => run.botId) }, expiresAt: { gt: now } },
        select: { computerId: true, botId: true, runId: true },
      })
    : [];
  const blockers = new Map<string, string>();
  for (const run of candidates) {
    const lease = leases.find(
      (lease) =>
        lease.botId === run.botId &&
        lease.computerId === run.bot.computerId &&
        lease.runId !== run.id,
    );
    if (lease) blockers.set(run.id, lease.runId);
  }
  return blockers;
}
