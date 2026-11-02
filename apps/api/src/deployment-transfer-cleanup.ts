import type { SecretStore } from "@rakazo/adapter-kit";
import { reconcileSecretWrite } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { lockSpaceLifecycle, Prisma } from "@rakazo/db";
import type { TransferContext, TransferRow } from "./deployment-transfer-store.js";
import { lockTransferRow, transferItems } from "./deployment-transfer-store.js";

/** Explicit cancellation retires confirmed owned writes or authoritatively empty inline reservations. */
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
    if (
      (!candidate.ciphertext && !candidate.recoveryRef) ||
      !candidate.secretRecordId ||
      candidate.status === "accepted"
    )
      continue;
    const authorizeClaim = async (tx: Prisma.TransactionClient, current: TransferRow) => {
      if ((!current.cancelRequestedAt && !internal) || current.writeRevokedAt) return null;
      const item = current.items.find((item) => item.id === candidate.id);
      if (
        !item ||
        (!item.ciphertext && !item.recoveryRef) ||
        !item.secretRecordId ||
        item.status === "accepted"
      )
        return null;
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
    let claim = await prisma.$transaction(async (tx) => {
      await lockSpaceLifecycle(tx, row.localSpaceId);
      const current = await lockTransferRow(tx, row.id);
      if (internal && !(await orphanedScope(tx, current))) return null;
      return authorizeClaim(tx, current);
    });
    if (!claim?.secretRecordId) continue;
    if (!claim.ciphertext && claim.recoveryRef) {
      const prepared = claim;
      let found: string | null = null;
      let emptyInline = false;
      try {
        const observed = await reconcileSecretWrite(secrets, prepared.recoveryRef!, {
          recordId: prepared.secretRecordId!,
          signal,
        });
        // A provider may confirm only this immutable prepared locator and its AAD.
        if (observed.state === "found" && observed.ref === prepared.recoveryRef)
          found = observed.ref;
        else if (observed.state === "absent")
          emptyInline =
            secrets.resourceIdentity?.(prepared.recoveryRef!, {
              recordId: prepared.secretRecordId!,
              signal,
            }).kind === "inline";
      } catch {
        /* A remote 404 or an unavailable provider cannot exclude a late create. */
      }
      const settled = await prisma.$transaction(async (tx) => {
        const current = await lockTransferRow(tx, row.id);
        const item = current.items.find((item) => item.id === prepared.id);
        if (
          !current.cancelRequestedAt ||
          current.writeRevokedAt ||
          !item ||
          item.status === "accepted" ||
          item.writeFence !== prepared.writeFence ||
          item.cleanupState !== "pending" ||
          item.ciphertext !== null ||
          item.secretRecordId !== prepared.secretRecordId ||
          item.recoveryRef !== prepared.recoveryRef
        )
          return { row: current, item: null };
        const resolved = await tx.deploymentTransferItem.update({
          where: { id: item.id },
          data: emptyInline
            ? {
                recoveryRef: null,
                cleanupState: "done",
                writeState: "settled",
                status: "cancelled",
                reasonCode: "cancelled",
                revision: { increment: 1 },
              }
            : found
              ? { ciphertext: found, writeState: "stored", revision: { increment: 1 } }
              : { cleanupState: "unknown", revision: { increment: 1 } },
        });
        const updated = await tx.deploymentTransferSession.update({
          where: { id: current.id },
          data: { revision: { increment: 1 } },
          include: transferItems,
        });
        return { row: updated, item: found ? resolved : null };
      });
      row = settled.row;
      claim = settled.item;
    }
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
        items: {
          some: {
            status: { not: "accepted" },
            OR: [{ ciphertext: { not: null } }, { recoveryRef: { not: null } }],
          },
        },
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
        (item) =>
          item.status !== "accepted" &&
          (item.ciphertext || item.recoveryRef) &&
          item.secretRecordId,
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
