import { mergeConnectionSelections } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";

export async function ownedConnectionSelection(
  tx: Prisma.TransactionClient,
  scope: { spaceId: string; userId: string },
  previous: readonly string[],
  batches: readonly (readonly string[])[],
): Promise<string[]> {
  const ids = [...new Set([...previous, ...batches.flat()])];
  if (!ids.length) return [];
  const references = await tx.connection.findMany({
    where: { id: { in: ids }, spaceId: scope.spaceId, userId: scope.userId },
    select: { id: true, connectorId: true, provider: true },
  });
  // Keep missing ids in the intent. Execution must reject them, never silently
  // discard the user's target and fall back to an available sibling account.
  return mergeConnectionSelections(previous, batches, references);
}

export async function updateTaskConnectionSelection(
  tx: Prisma.TransactionClient,
  scope: { spaceId: string; userId: string },
  taskId: string,
  batches: readonly (readonly string[])[],
): Promise<void> {
  if (!batches.some((ids) => ids.length)) return;
  const task = await tx.task.findFirst({
    where: { id: taskId, spaceId: scope.spaceId, userId: scope.userId },
    select: { connectionIds: true },
  });
  if (!task) throw new IsolationError();
  const connectionIds = await ownedConnectionSelection(tx, scope, task.connectionIds, batches);
  const updated = await tx.task.updateMany({
    where: { id: taskId, spaceId: scope.spaceId, userId: scope.userId },
    data: { connectionIds },
  });
  if (updated.count !== 1) throw new IsolationError();
}
