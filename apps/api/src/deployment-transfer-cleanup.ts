import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { lockSpaceLifecycle, Prisma } from "@rakazo/db";
import type { TransferContext, TransferRow } from "./deployment-transfer-store.js";
import { lockTransferRow, transferItems } from "./deployment-transfer-store.js";

/** Explicit cancellation retires only a confirmed, unadopted, owned write. */
type OwnerCleanup = {
  prisma: PrismaClient;
  secrets: SecretStore;
  context: TransferContext;
  row: TransferRow;
};
type InternalCleanup = {
  prisma: PrismaClient;
  secrets: SecretStore;
  row: TransferRow;
  signal?: AbortSignal;
  orphaned: true;
};
async function orphanedScope(client: PrismaClient | Prisma.TransactionClient, row: TransferRow) {
  const [user, space, member, bot] = await Promise.all([
    client.user.findUnique({ where: { id: row.localUserId }, select: { id: true } }),
    client.space.findUnique({ where: { id: row.localSpaceId }, select: { id: true } }),
    client.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: row.localSpaceId, userId: row.localUserId } },
      select: { id: true },
    }),
    client.bot.findUnique({
      where: { id: row.localBotId },
      select: { userId: true, spaceId: true },
    }),
  ]);
  return (
    !user ||
    !space ||
    !member ||
    !bot ||
    bot.userId !== row.localUserId ||
    bot.spaceId !== row.localSpaceId
  );
}
async function cleanupKnownTransfer(input: OwnerCleanup | InternalCleanup) {
  const { prisma, secrets } = input;
  const internal = "orphaned" in input;
  const signal = internal ? input.signal : input.context.signal;
  let row = input.row;
  if (row.side !== "target" || (!internal && !row.cancelRequestedAt) || row.writeRevokedAt)
    return row;
  for (const candidate of row.items) {
    // A reservation alone does not exclude a late remote create. Never delete it.
    if (!candidate.ciphertext || !candidate.secretRecordId || candidate.status === "accepted")
      continue;
    const authorizeClaim = async (tx: Prisma.TransactionClient, current: TransferRow) => {
      if ((!current.cancelRequestedAt && !internal) || current.writeRevokedAt) return null;
      const item = current.items.find((item) => item.id === candidate.id);
      if (!item?.ciphertext || !item.secretRecordId || item.status === "accepted") return null;
      // An explicit retry can fence an interrupted delete. Repeating retirement of
      // this confirmed owned ref cannot create a resource or revive an adoption.
      const claimed = await tx.deploymentTransferItem.update({
        where: { id: item.id },
        data: {
          cleanupState: "pending",
          writeFence: { increment: 1 },
          revision: { increment: 1 },
        },
      });
      await tx.deploymentTransferSession.update({
        where: { id: current.id },
        data: {
          revision: { increment: 1 },
          ...(internal
            ? {
                cancelRequestedAt: current.cancelRequestedAt ?? new Date(),
                status: "cancelled",
                ciphertext: null,
                secretRecordId: null,
              }
            : {}),
        },
      });
      return claimed;
    };
    const claim = await prisma.$transaction(async (tx) => {
      await lockSpaceLifecycle(tx, row.localSpaceId);
      const current = await lockTransferRow(tx, row.id);
      if (internal && !(await orphanedScope(tx, current))) return null;
      return authorizeClaim(tx, current);
    });
    if (!claim?.ciphertext || !claim.secretRecordId) continue;
    let deleted = false;
    try {
      await secrets.delete(claim.ciphertext, {
        recordId: claim.secretRecordId,
        signal,
      });
      deleted = true;
    } catch {
      /* An uncertain delete keeps its owned reference and evidence. */
    }
    row = await prisma.$transaction(async (tx) => {
      const current = await lockTransferRow(tx, row.id);
      const item = current.items.find((item) => item.id === claim.id);
      if (
        !item ||
        item.status === "accepted" ||
        item.writeFence !== claim.writeFence ||
        item.cleanupState !== "pending" ||
        item.ciphertext !== claim.ciphertext
      )
        return current;
      if (deleted && !current.writeRevokedAt) {
        // The provider deletion was confirmed above. Clearing via bound SQL avoids the
        // generic persistence hook issuing a second deletion after this owned cleanup.
        await tx.$executeRaw(Prisma.sql`UPDATE deployment_transfer_items
          SET ciphertext=NULL, "recoveryRef"=NULL, "cleanupState"='done', "writeState"='settled',
            status='cancelled', "reasonCode"='cancelled', revision=revision+1, "updatedAt"=CURRENT_TIMESTAMP
          WHERE id=${item.id} AND "writeFence"=${claim.writeFence} AND "cleanupState"='pending'
            AND ciphertext=${claim.ciphertext} AND status<>'accepted'`);
      } else
        await tx.deploymentTransferItem.update({
          where: { id: item.id },
          data: {
            cleanupState: "unknown",
            revision: { increment: 1 },
          },
        });
      return tx.deploymentTransferSession.update({
        where: { id: current.id },
        data: { revision: { increment: 1 } },
        include: transferItems,
      });
    });
  }
  return row;
}

export const cleanupCancelledTransfer = (input: OwnerCleanup) => cleanupKnownTransfer(input);

/** Trusted maintenance entry; ordinary RPC permissions are never bypassed by a caller flag. */
export async function cleanupOrphanedTransfers(input: {
  prisma: PrismaClient;
  secrets: SecretStore;
  dryRun?: boolean;
  signal?: AbortSignal;
}) {
  const result = { candidates: 0, retired: 0, uncertain: 0, remainingPending: 0 };
  let cursor: string | undefined;
  for (;;) {
    input.signal?.throwIfAborted();
    const rows = await input.prisma.deploymentTransferSession.findMany({
      where: {
        side: "target",
        writeRevokedAt: null,
        ...(cursor ? { id: { gt: cursor } } : {}),
        items: { some: { ciphertext: { not: null }, status: { not: "accepted" } } },
      },
      orderBy: { id: "asc" },
      take: 100,
      include: transferItems,
    });
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      if (!(await orphanedScope(input.prisma, row))) continue;
      const candidates = row.items.filter(
        (item) => item.status !== "accepted" && item.ciphertext && item.secretRecordId,
      );
      result.candidates += candidates.length;
      if (input.dryRun) continue;
      const updated = await cleanupKnownTransfer({ ...input, row, orphaned: true });
      result.retired += candidates.filter((before) =>
        updated.items.some((after) => after.id === before.id && after.cleanupState === "done"),
      ).length;
      result.uncertain += candidates.filter((before) =>
        updated.items.some((after) => after.id === before.id && after.cleanupState === "unknown"),
      ).length;
    }
  }
  result.remainingPending = await input.prisma.deploymentTransferItem.count({
    where: { OR: [{ ciphertext: { not: null } }, { recoveryRef: { not: null } }] },
  });
  return result;
}
