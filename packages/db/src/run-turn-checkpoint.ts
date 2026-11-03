import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

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

function checkpointContent(
  row: {
    runId: string;
    spaceId: string;
    kind: string;
    status: string;
    request: Prisma.JsonValue;
    result: Prisma.JsonValue;
  },
  run: RunScope,
): { blob?: string; pendingSecretEffectId?: string } | undefined {
  if (
    row.runId !== run.id ||
    row.spaceId !== run.spaceId ||
    row.kind !== RUN_TURN_CHECKPOINT_KIND ||
    row.status !== RUN_TURN_CHECKPOINT_KIND
  )
    return undefined;
  const request = row.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) return undefined;
  const fields = Object.keys(request).length;
  const blob = typeof row.result === "string" && row.result.length > 0 ? row.result : undefined;
  if (fields === 0 && blob !== undefined) return { blob };
  const id = request.pendingSecretEffectId;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (fields === 1 && blob !== undefined) return { blob, pendingSecretEffectId: id };
  // A helper without transcript capture still binds its one protected-input card.
  if (fields === 2 && request.capture === "none" && row.result === null)
    return { pendingSecretEffectId: id };
  return undefined;
}

export async function loadRunTurnCheckpoint(
  prisma: PrismaClient,
  run: RunScope,
): Promise<string | undefined> {
  const row = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: keyOf(run.id) },
    select: { runId: true, spaceId: true, kind: true, status: true, request: true, result: true },
  });
  if (!row) return undefined;
  // A present but invalid record must not silently restart the turn from scratch.
  const content = checkpointContent(row, run);
  if (!content) throw new Error("Unsupported turn checkpoint");
  return content.blob;
}

/** A present Pi checkpoint must bind its secret card to exactly one server-owned effect. */
export async function loadRunTurnCheckpointSecretEffectId(
  tx: Pick<Prisma.TransactionClient, "externalEffect">,
  run: RunScope,
): Promise<string | undefined> {
  const row = await tx.externalEffect.findUnique({
    where: { idempotencyKey: keyOf(run.id) },
    select: { runId: true, spaceId: true, kind: true, status: true, request: true, result: true },
  });
  if (!row) return undefined;
  const content = checkpointContent(row, run);
  if (!content?.pendingSecretEffectId)
    throw new Error("Unsupported turn checkpoint secret binding");
  return content.pendingSecretEffectId;
}

export async function saveRunTurnCheckpoint(
  prisma: PrismaClient,
  run: RunScope,
  leaseOwner: string,
  leaseFence: number,
  blob: string | undefined,
  pendingSecretEffectId?: string,
): Promise<void> {
  if (blob !== undefined && (typeof blob !== "string" || blob.length === 0))
    throw new Error("Unsupported turn checkpoint");
  if (
    pendingSecretEffectId !== undefined &&
    (typeof pendingSecretEffectId !== "string" || pendingSecretEffectId.length === 0)
  )
    throw new Error("Unsupported turn checkpoint secret binding");
  if (blob === undefined && pendingSecretEffectId === undefined)
    throw new Error("Unsupported turn checkpoint");
  const request =
    pendingSecretEffectId === undefined
      ? {}
      : blob === undefined
        ? { pendingSecretEffectId, capture: "none" }
        : { pendingSecretEffectId };
  const result = blob === undefined ? Prisma.DbNull : blob;
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
      create: { ...scope, request, result },
      update: { request, result },
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
