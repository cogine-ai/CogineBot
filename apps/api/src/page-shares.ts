import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretNotFoundError } from "@rakazo/adapter-kit";
import { deferPreparedSecretCleanup, persistPreparedSecret } from "@rakazo/adapters";
import type { Actor, PageShareInput, PageShareState } from "@rakazo/contracts";
import { pageShareTokenFromSlug, pageShareUrl } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  IsolationError,
  PAGE_SHARE_SECRET_KIND,
  PageShareConflictError,
  swapPageShare,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

interface PageShareDeps {
  prisma: PrismaClient;
  secrets: SecretStore;
  env: { webOrigin: string };
  pageSharingEnabled?: boolean;
}

const privateShare = { visibility: "private", shareUrl: null } as const;

function sharingUnavailable() {
  return new ORPCError("NOT_FOUND", { message: "Page sharing is unavailable" });
}

function pageUnavailable() {
  return new ORPCError("NOT_FOUND", { message: "This page isn't available" });
}

function sharingConflict() {
  return new ORPCError("CONFLICT", { message: "Page sharing changed. Try again." });
}

function linkUnavailable() {
  return new ORPCError("SERVICE_UNAVAILABLE", { message: "Could not load the Page link" });
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function requireOwnedShare(prisma: PrismaClient, actor: Actor, pageId: string) {
  const row = await prisma.page.findFirst({
    where: { id: pageId, spaceId: actor.spaceId, userId: actor.userId },
    select: {
      id: true,
      title: true,
      botId: true,
      groupId: true,
      visibility: true,
      shareTokenHash: true,
      shareSecretId: true,
    },
  });
  if (!row) throw pageUnavailable();
  return row;
}

/** Read only the token for this owner and exact link generation. */
async function readLink(
  deps: PageShareDeps,
  actor: Actor,
  row: Awaited<ReturnType<typeof requireOwnedShare>>,
  signal?: AbortSignal,
) {
  const { id, visibility, shareSecretId, shareTokenHash } = row;
  if (visibility !== "link" || !shareSecretId || !shareTokenHash) return null;
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const secret = await deps.prisma.secret.findFirst({
    where: { id: shareSecretId, ...scope, kind: PAGE_SHARE_SECRET_KIND },
    select: { ciphertext: true },
  });
  if (!secret) return null;
  let token: string;
  try {
    token = await deps.secrets.load(secret.ciphertext, { recordId: shareSecretId, signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SecretNotFoundError) return null;
    getLogger().warn("Page share token could not be loaded");
    throw linkUnavailable();
  }
  if (pageShareTokenFromSlug(token) !== token || hashToken(token) !== shareTokenHash) return null;
  // Opening the sealed token can cross a concurrent revocation or rotation.
  const stillCurrent = await deps.prisma.page.findFirst({
    where: { id, ...scope, visibility: "link", shareSecretId, shareTokenHash },
    select: { title: true },
  });
  if (!stillCurrent) throw sharingConflict();
  return pageShareUrl(deps.env.webOrigin, stillCurrent.title, token);
}

export async function getPageShare(
  deps: PageShareDeps,
  actor: Actor,
  pageId: string,
  signal?: AbortSignal,
): Promise<PageShareState> {
  if (!deps.pageSharingEnabled) throw sharingUnavailable();
  const row = await requireOwnedShare(deps.prisma, actor, pageId);
  if (row.visibility !== "link" || !row.shareTokenHash || !row.shareSecretId) return privateShare;
  const shareUrl = await readLink(deps, actor, row, signal);
  if (!shareUrl) throw linkUnavailable();
  return { visibility: "link", shareUrl };
}

export async function setPageShare(
  deps: PageShareDeps,
  actor: Actor,
  { pageId, visibility }: PageShareInput,
  signal = new AbortController().signal,
): Promise<PageShareState> {
  const { prisma, secrets } = deps;
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  if (visibility === "link" && !deps.pageSharingEnabled) throw sharingUnavailable();
  try {
    // Revocation remains available while link issuance and reads are disabled.
    if (visibility === "private") {
      await swapPageShare(prisma, owner, pageId, null);
      return privateShare;
    }

    const row = await requireOwnedShare(prisma, actor, pageId);
    const existing = await readLink(deps, actor, row, signal);
    if (existing) return { visibility: "link", shareUrl: existing };

    const token = randomBytes(32).toString("base64url");
    const stored = await secrets.put(token, {
      operationId: `page-share:${pageId}`,
      traceId: `page-share:${pageId}`,
      ...owner,
      signal,
    });
    const outcome = await deferPreparedSecretCleanup(prisma, () =>
      persistPreparedSecret(prisma, secrets, stored, () =>
        swapPageShare(prisma, owner, pageId, {
          tokenHash: hashToken(token),
          secret: stored,
          botId: row.botId,
          groupId: row.groupId,
          unreadable: row.shareSecretId,
        }),
      ),
    );
    if (outcome.kept) {
      const winner = await readLink(
        deps,
        actor,
        await requireOwnedShare(prisma, actor, pageId),
        signal,
      );
      if (!winner) throw sharingConflict();
      return { visibility: "link", shareUrl: winner };
    }
    return { visibility: "link", shareUrl: pageShareUrl(deps.env.webOrigin, row.title, token) };
  } catch (error) {
    if (error instanceof IsolationError) throw pageUnavailable();
    if (error instanceof PageShareConflictError) throw sharingConflict();
    throw error;
  }
}
