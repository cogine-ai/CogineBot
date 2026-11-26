import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";

/** Keep account, Space, and session admission valid through a scoped write. */
export async function lockActiveMembership(
  tx: Prisma.TransactionClient,
  actor: Actor,
  sessionId?: string,
): Promise<void> {
  const users = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "user" WHERE id=${actor.userId} FOR SHARE`;
  const spaces = await tx.$queryRaw<Array<{ id: string; deletingAt: Date | null }>>`
    SELECT id, "deletingAt" FROM spaces WHERE id=${actor.spaceId} FOR SHARE`;
  const members = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM space_members WHERE "spaceId"=${actor.spaceId} AND "userId"=${actor.userId} FOR SHARE`;
  if (!users.length || !spaces.length || spaces[0]!.deletingAt || !members.length)
    throw new ORPCError("FORBIDDEN");
  if (sessionId) {
    const sessions = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "session" WHERE id=${sessionId} AND "userId"=${actor.userId}
        AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') FOR SHARE`;
    if (!sessions.length) throw new ORPCError("UNAUTHORIZED");
  }
}
