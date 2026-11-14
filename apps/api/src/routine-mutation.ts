import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";

// Hash canonical input, including the operation and target. Never use content
// alone as identity: two intentional, identical Routines are valid.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function routineMutation(actor: Actor, operation: string, input: { mutationId?: string }) {
  if (!input.mutationId) return undefined;
  const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
  return {
    id: hash([actor.userId, actor.spaceId, input.mutationId]),
    userId: actor.userId,
    spaceId: actor.spaceId,
    requestHash: hash([operation, input]),
  };
}
type Intent = ReturnType<typeof routineMutation>;
type Db = Pick<PrismaClient, "routineMutation">;
export async function readRoutineMutation(db: Db, intent: Intent) {
  if (!intent) return undefined;
  const receipt = await db.routineMutation.findFirst({
    where: { id: intent.id, userId: intent.userId, spaceId: intent.spaceId },
  });
  if (!receipt) return undefined;
  if (receipt.requestHash !== intent.requestHash)
    throw new ORPCError("CONFLICT", {
      message: "Save intent changed. Restore the previous save and retry.",
    });
  return receipt.routineId ?? undefined;
}
export async function claimRoutineMutation(tx: Prisma.TransactionClient, intent: Intent) {
  if (!intent) return undefined;
  // ON CONFLICT serializes simultaneous retries; SERIALIZABLE retries take a
  // fresh snapshot. An incomplete receipt can never escape the write transaction.
  await tx.$executeRaw`INSERT INTO routine_mutations (id,"userId","spaceId","requestHash") VALUES (${intent.id},${intent.userId},${intent.spaceId},${intent.requestHash}) ON CONFLICT (id) DO NOTHING`;
  return readRoutineMutation(tx, intent);
}
export async function finishRoutineMutation(
  tx: Prisma.TransactionClient,
  intent: Intent,
  routineId: string,
) {
  if (intent) await tx.routineMutation.update({ where: { id: intent.id }, data: { routineId } });
}
