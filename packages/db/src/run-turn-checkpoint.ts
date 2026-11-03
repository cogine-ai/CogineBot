import type { Prisma, PrismaClient } from "./client.js";

// This reserved effect kind/status keeps server-only transcripts out of approval
// queues and client events while reusing Run/Space cascades and latest-only storage.
export const RUN_TURN_CHECKPOINT_KIND = "runtime_checkpoint";
type RunScope = { id: string; spaceId: string };
const keyOf = (runId: string) => JSON.stringify([RUN_TURN_CHECKPOINT_KIND, runId]);
const scopeOf = (run: RunScope) => ({
  idempotencyKey: keyOf(run.id),
  runId: run.id,
  spaceId: run.spaceId,
  kind: RUN_TURN_CHECKPOINT_KIND,
  status: RUN_TURN_CHECKPOINT_KIND,
});

export async function loadRunTurnCheckpoint(
  prisma: PrismaClient,
  run: RunScope,
): Promise<string | undefined> {
  const row = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: keyOf(run.id) },
    select: { runId: true, spaceId: true, kind: true, status: true, result: true },
  });
  if (!row) return undefined;
  // A present but invalid record must not silently restart the turn from scratch.
  if (
    row.runId !== run.id ||
    row.spaceId !== run.spaceId ||
    row.kind !== RUN_TURN_CHECKPOINT_KIND ||
    row.status !== RUN_TURN_CHECKPOINT_KIND ||
    typeof row.result !== "string" ||
    row.result.length === 0
  )
    throw new Error("Unsupported turn checkpoint");
  return row.result;
}

export async function saveRunTurnCheckpoint(
  prisma: PrismaClient,
  run: RunScope,
  leaseOwner: string,
  leaseFence: number,
  blob: string,
): Promise<void> {
  if (typeof blob !== "string" || blob.length === 0) throw new Error("Unsupported turn checkpoint");
  await prisma.$transaction(async (tx) => {
    // The Run write lock orders this save against terminal transitions: a later
    // terminal writer clears it, and an earlier terminal writer rejects this save.
    const locked = await tx.run.updateMany({
      where: { id: run.id, spaceId: run.spaceId, status: "running", leaseOwner, leaseFence },
      data: { leaseFence },
    });
    if (locked.count !== 1) throw new Error("Run lease expired before checkpoint");
    const scope = scopeOf(run);
    await tx.externalEffect.upsert({
      where: scope,
      create: { ...scope, request: {}, result: blob },
      update: { result: blob },
    });
  });
}

/** Drop a running run's saved turn only while this worker still holds its lease. */
export async function dropRunTurnCheckpoint(
  prisma: PrismaClient,
  run: RunScope,
  leaseOwner: string,
  leaseFence: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const locked = await tx.run.updateMany({
      where: { id: run.id, spaceId: run.spaceId, status: "running", leaseOwner, leaseFence },
      data: { leaseFence },
    });
    if (locked.count !== 1) throw new Error("Run lease expired before checkpoint");
    await clearRunTurnCheckpoints(tx, [run]);
  });
}

/** Call in the winning terminal transaction; its Run lock rejects any later save. */
export async function clearRunTurnCheckpoints(
  tx: Pick<Prisma.TransactionClient, "externalEffect">,
  runs: readonly RunScope[],
): Promise<void> {
  if (runs.length === 0) return;
  await tx.externalEffect.deleteMany({ where: { OR: runs.map(scopeOf) } });
}
