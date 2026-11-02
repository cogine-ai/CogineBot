import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import { deploymentTransferDigest, ensureDeploymentIdentity } from "@rakazo/adapters";
import type { Actor, DeploymentTransferScope } from "@rakazo/contracts";
import { DEPLOYMENT_TRANSFER_TTL_MS, normalizeDeploymentTransferOrigin } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { lockSpaceForContentCreation, Prisma as Sql, withTransactionRetry } from "@rakazo/db";

export type TransferContext = {
  actor: Actor | null;
  sessionId?: string;
  sessionUserId?: string;
  sessionAuthenticated?: boolean;
  signal?: AbortSignal;
};
export const transferItems = { items: { orderBy: { itemKey: "asc" as const } } };
export type TransferRow = Prisma.DeploymentTransferSessionGetPayload<{
  include: typeof transferItems;
}>;
export type TransferItemRow = TransferRow["items"][number];
export const transferNonce = () => randomBytes(32).toString("base64url");
export const transferHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function transferTokenMatches(expectedHash: string | null, token: string): boolean {
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  return timingSafeEqual(
    Buffer.from(expectedHash, "hex"),
    createHash("sha256").update(token).digest(),
  );
}
export const jsonValue = (value: unknown) => value as Prisma.InputJsonValue;
export const transferUnavailable = () =>
  new ORPCError("BAD_REQUEST", {
    message: "This credential transfer is unavailable. Check its status before trying again.",
  });
export const transferConflict = () =>
  new ORPCError("CONFLICT", {
    message: "This transfer changed. Check its status and review the current plan.",
  });

export function localTransferScope(row: TransferRow): DeploymentTransferScope {
  return { userId: row.localUserId, spaceId: row.localSpaceId, botId: row.localBotId };
}

export function transferUser(context: TransferContext): { userId: string; sessionId: string } {
  context.signal?.throwIfAborted();
  if (!context.sessionAuthenticated || !context.sessionId || !context.sessionUserId)
    throw new ORPCError("UNAUTHORIZED");
  return { userId: context.sessionUserId, sessionId: context.sessionId };
}

/** Actual resource ownership, current membership and the exact auth session; no Space role gate. */
export async function lockTransferScope(
  tx: Prisma.TransactionClient,
  scope: DeploymentTransferScope,
  sessionId: string,
  write: boolean,
) {
  await lockSpaceForContentCreation(tx, scope);
  const users = await tx.$queryRaw<Array<{ id: string }>>(
    Sql.sql`SELECT id FROM "user" WHERE id=${scope.userId} FOR SHARE`,
  );
  const members = await tx.$queryRaw<Array<{ id: string }>>(
    Sql.sql`SELECT id FROM space_members WHERE "spaceId"=${scope.spaceId} AND "userId"=${scope.userId} FOR SHARE`,
  );
  const sessions = await tx.$queryRaw<Array<{ id: string }>>(
    Sql.sql`SELECT id FROM "session" WHERE id=${sessionId} AND "userId"=${scope.userId} AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') FOR SHARE`,
  );
  if (!users.length || !members.length || !sessions.length) throw new ORPCError("UNAUTHORIZED");
  const bot = await tx.bot.findFirst({
    where: { id: scope.botId, userId: scope.userId, spaceId: scope.spaceId, archivedAt: null },
    select: { id: true, name: true },
  });
  if (write && !bot) throw new ORPCError("FORBIDDEN");
  return bot;
}

export async function lockTransferRow(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<TransferRow> {
  await tx.$queryRaw(
    Sql.sql`SELECT id FROM deployment_transfer_sessions WHERE id=${id} FOR UPDATE`,
  );
  return tx.deploymentTransferSession.findUniqueOrThrow({ where: { id }, include: transferItems });
}

export function assertTransferWrite(row: TransferRow, now: number, originalSessionId?: string) {
  const expiry =
    row.side === "source"
      ? Math.min(row.expiresAt.getTime(), row.createdAt.getTime() + DEPLOYMENT_TRANSFER_TTL_MS)
      : row.expiresAt.getTime();
  if (row.cancelRequestedAt || row.writeRevokedAt || expiry <= now) throw transferConflict();
  if (originalSessionId && row.localSessionId !== originalSessionId) throw transferConflict();
}

export function createTransferStore(deps: {
  prisma: PrismaClient;
  secrets: SecretStore;
  origin: string;
}) {
  async function binding(
    scope: DeploymentTransferScope,
    intent: string,
    client: PrismaClient | Prisma.TransactionClient = deps.prisma,
  ) {
    const member = await client.spaceMember.findUnique({
      where: {
        spaceId_userId: {
          spaceId: scope.spaceId,
          userId: scope.userId,
        },
      },
      select: { id: true },
    });
    if (!member) throw transferConflict();
    return deploymentTransferDigest("binding", { intent, membershipId: member.id });
  }
  return {
    binding,
    async identity() {
      // Only this feature is unavailable on an HTTP install; core initialization stays unchanged.
      const origin = normalizeDeploymentTransferOrigin(deps.origin);
      return { ...(await ensureDeploymentIdentity(deps)), origin };
    },
    async currentScope(context: TransferContext, botId: string) {
      const user = transferUser(context);
      if (!context.actor || context.actor.userId !== user.userId) throw new ORPCError("FORBIDDEN");
      const scope = { userId: user.userId, spaceId: context.actor.spaceId, botId };
      await deps.prisma.$transaction((tx) => lockTransferScope(tx, scope, user.sessionId, true));
      return scope;
    },
    async owned(context: TransferContext, id: string) {
      const user = transferUser(context);
      const row = await deps.prisma.deploymentTransferSession.findFirst({
        where: { id, localUserId: user.userId },
        include: transferItems,
      });
      if (!row) throw new ORPCError("NOT_FOUND");
      await deps.prisma.$transaction((tx) =>
        lockTransferScope(tx, localTransferScope(row), user.sessionId, false),
      );
      return row;
    },
    async transact<T>(
      context: TransferContext,
      row: TransferRow,
      write: boolean,
      action: (tx: Prisma.TransactionClient, current: TransferRow) => Promise<T>,
    ): Promise<T> {
      const user = transferUser(context);
      if (row.localUserId !== user.userId) throw new ORPCError("NOT_FOUND");
      return withTransactionRetry(() =>
        deps.prisma.$transaction(
          async (tx) => {
            await lockTransferScope(tx, localTransferScope(row), user.sessionId, write);
            const current = await lockTransferRow(tx, row.id);
            if (current.localUserId !== user.userId) throw new ORPCError("NOT_FOUND");
            if (write) {
              const scope = localTransferScope(current);
              const intent = deploymentTransferDigest(
                "binding",
                current.side === "target"
                  ? {
                      scope,
                      sourceOrigin: current.sourceOrigin,
                      targetOrigin: current.targetOrigin,
                    }
                  : {
                      scope,
                      targetOrigin: current.targetOrigin,
                      locator: current.targetTransferId,
                    },
              );
              if (current.requestBinding !== (await binding(scope, intent, tx)))
                throw transferConflict();
            }
            return action(tx, current);
          },
          { timeout: 15_000 },
        ),
      );
    },
  };
}
