import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const PAGE_SHARE_SECRET_KIND = "page_share";

type PageShareOwner = Pick<Actor, "spaceId" | "userId">;
type PreparedPageShare = {
  botId: string | null;
  groupId: string | null;
  tokenHash: string;
  secret: { id: string; ciphertext: string };
  unreadable: string | null;
};

export class PageShareConflictError extends Error {
  constructor() {
    super("The page share changed. Try again.");
    this.name = "PageShareConflictError";
  }
}

/** Atomically change the link for one owner Page and its sealed token row. */
export async function swapPageShare(
  prisma: PrismaClient,
  { spaceId, userId }: PageShareOwner,
  pageId: string,
  next: PreparedPageShare | null,
): Promise<{ kept: boolean }> {
  if (next && !/^[a-f0-9]{64}$/.test(next.tokenHash)) {
    throw new Error("Invalid page share token digest");
  }
  const page = { id: pageId, spaceId, userId };
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransactionRetry(() =>
        prisma.$transaction(async (tx) => {
          const current = await tx.page.findFirst({
            where: page,
            select: {
              botId: true,
              groupId: true,
              visibility: true,
              shareTokenHash: true,
              shareSecretId: true,
            },
          });
          if (!current) throw new IsolationError();
          // Bot deletion preserves the Page, but a prepared link cannot cross that detachment.
          if (next && (next.botId !== current.botId || next.groupId !== current.groupId)) {
            throw new PageShareConflictError();
          }
          if (
            next &&
            current.visibility === "link" &&
            current.shareTokenHash &&
            current.shareSecretId &&
            current.shareSecretId !== next.unreadable
          ) {
            return { kept: true };
          }
          if (next) {
            await tx.secret.create({
              data: {
                id: next.secret.id,
                ciphertext: next.secret.ciphertext,
                spaceId,
                userId,
                kind: PAGE_SHARE_SECRET_KIND,
              },
            });
          }
          const moved = await tx.page.updateMany({
            where: { ...page, ...current },
            data: next
              ? {
                  visibility: "link",
                  shareTokenHash: next.tokenHash,
                  shareSecretId: next.secret.id,
                }
              : { visibility: "private", shareTokenHash: null, shareSecretId: null },
          });
          if (moved.count !== 1) throw new PageShareConflictError();
          if (current.shareSecretId) {
            await tx.secret.deleteMany({
              where: { id: current.shareSecretId, spaceId, userId, kind: PAGE_SHARE_SECRET_KIND },
            });
          }
          return { kept: false };
        }),
      );
    } catch (error) {
      if (!(error instanceof PageShareConflictError) || attempt !== 0) throw error;
    }
  }
}

/** Revoke links while the caller still owns the transaction deleting the Pages or their parent. */
export async function deletePageShareSecrets(
  tx: Prisma.TransactionClient,
  pages: Prisma.PageWhereInput,
): Promise<void> {
  // Lock even private Pages so a concurrent link cannot appear before their deletion.
  const locked = await tx.page.updateManyAndReturn({
    where: pages,
    data: { visibility: "private", shareTokenHash: null },
    select: { id: true, spaceId: true, userId: true, shareSecretId: true },
  });
  const linked = locked.flatMap((page) =>
    page.shareSecretId ? [{ ...page, shareSecretId: page.shareSecretId }] : [],
  );
  if (linked.length === 0) return;
  await tx.page.updateMany({
    where: { id: { in: linked.map(({ id }) => id) } },
    data: { shareSecretId: null },
  });
  await tx.secret.deleteMany({
    where: {
      kind: PAGE_SHARE_SECRET_KIND,
      OR: linked.map(({ shareSecretId: id, spaceId, userId }) => ({ id, spaceId, userId })),
    },
  });
}
