import { runSecretKind } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { clearRunTurnCheckpoints } from "./run-turn-checkpoint.js";

/** A named login that belongs to this Run. The encoded id has no separator or LIKE wildcard. */
export function runLoginKind(runId: string, name: string): string {
  return `run-login:${Buffer.from(runId).toString("hex")}:${name}`;
}

/** Call after winning the terminal Run write, inside the same transaction. */
export async function clearEndedRunState(
  tx: Pick<Prisma.TransactionClient, "externalEffect" | "secret">,
  runs: ReadonlyArray<{ id: string; userId: string; spaceId: string }>,
): Promise<void> {
  if (runs.length === 0) return;
  await clearRunTurnCheckpoints(tx, runs);
  await tx.secret.deleteMany({
    where: {
      OR: runs.flatMap(({ id, userId, spaceId }) => [
        { userId, spaceId, kind: runSecretKind(id) },
        { userId, spaceId, kind: { startsWith: runLoginKind(id, "") } },
      ]),
    },
  });
}
