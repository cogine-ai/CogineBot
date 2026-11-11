import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { clearEndedRunState } from "./run-secrets.js";

/** Return only cancelled winners; a run that finished after the caller's read keeps its outcome. */
export async function cancelRunsInTransaction<Run extends { id: string; taskId: string }>(
  tx: Pick<Prisma.TransactionClient, "run" | "attempt" | "task" | "externalEffect" | "secret">,
  runs: ReadonlyArray<Run>,
  cancelledAt: Date,
): Promise<Run[]> {
  if (runs.length === 0) return [];
  const winners = await tx.run.updateManyAndReturn({
    where: { id: { in: runs.map((run) => run.id) }, status: { in: [...ACTIVE_RUN_STATUSES] } },
    data: {
      status: "cancelled",
      completedAt: cancelledAt,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
    select: { id: true, spaceId: true, userId: true },
  });
  const winnerIds = new Set(winners.map((run) => run.id));
  const cancelled = runs.filter((run) => winnerIds.has(run.id));
  if (cancelled.length === 0) return [];
  const runIds = cancelled.map((run) => run.id);
  await clearEndedRunState(tx, winners);
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: cancelledAt },
  });
  await tx.task.updateMany({
    where: { id: { in: cancelled.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
  return cancelled;
}
