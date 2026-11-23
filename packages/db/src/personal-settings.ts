import type { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";

export type PersonalSettingsScope = { userId: string; spaceId: string };

/** Serialize personal default changes with updates to one Space's chosen value. */
export async function lockPersonalSettings(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  actor: PersonalSettingsScope,
) {
  const [user] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "user" WHERE id = ${actor.userId} FOR NO KEY UPDATE`;
  const [space] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM spaces WHERE id = ${actor.spaceId} AND "deletingAt" IS NULL FOR SHARE`;
  const [member] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM space_members
    WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR NO KEY UPDATE`;
  if (!user || !space || !member) throw new IsolationError();
}
