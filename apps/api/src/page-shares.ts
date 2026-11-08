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
      currentVersion: true,
      shareRevision: true,
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
  return {
    shareUrl: pageShareUrl(deps.env.webOrigin, stillCurrent.title, token),
    generation: shareSecretId,
  };
}

export async function getPageShare(
  deps: PageShareDeps,
  actor: Actor,
  pageId: string,
  signal?: AbortSignal,
): Promise<PageShareState> {
  const row = await requireOwnedShare(deps.prisma, actor, pageId);
  const publishingEnabled = deps.pageSharingEnabled === true;
  if (row.visibility !== "link")
    return { visibility: "private", publishingEnabled, shareUrl: null, generation: null };
  if (!publishingEnabled)
    return { visibility: "link", publishingEnabled, shareUrl: null, generation: null };
  const link = await readLink(deps, actor, row, signal);
  if (!link) throw linkUnavailable();
  return { visibility: "link", publishingEnabled, ...link };
}

export async function setPageShare(
  deps: PageShareDeps,
  actor: Actor,
  input: PageShareInput,
  signal = new AbortController().signal,
): Promise<PageShareState> {
  const { prisma, secrets } = deps;
  const { pageId, visibility } = input;
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  if (visibility === "link" && !deps.pageSharingEnabled) throw sharingUnavailable();
  try {
    // Revocation remains available while link issuance and reads are disabled.
    if (visibility === "private") {
      await swapPageShare(prisma, owner, pageId, null);
      return {
        visibility,
        publishingEnabled: deps.pageSharingEnabled === true,
        shareUrl: null,
        generation: null,
      };
    }

    const row = await requireOwnedShare(prisma, actor, pageId);
    if (row.currentVersion !== input.expectedVersion || row.title !== input.expectedTitle) {
      throw sharingConflict();
    }
    const existing = await readLink(deps, actor, row, signal);
    if (existing) {
      return { visibility, publishingEnabled: true, ...existing };
    }

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
          expectedVersion: input.expectedVersion,
          expectedTitle: input.expectedTitle,
          expectedShareRevision: row.shareRevision,
          unreadable: row.shareSecretId,
        }),
      ),
    );
    if (outcome.kept) {
      const latest = await requireOwnedShare(prisma, actor, pageId);
      if (
        latest.shareRevision !== outcome.shareRevision ||
        latest.shareSecretId !== outcome.shareSecretId
      ) {
        throw sharingConflict();
      }
      const winner = await readLink(deps, actor, latest, signal);
      if (!winner) throw sharingConflict();
      return { visibility, publishingEnabled: true, ...winner };
    }
    return {
      visibility,
      publishingEnabled: true,
      shareUrl: pageShareUrl(deps.env.webOrigin, row.title, token),
      generation: stored.id,
    };
  } catch (error) {
    if (error instanceof IsolationError) throw pageUnavailable();
    if (error instanceof PageShareConflictError) throw sharingConflict();
    throw error;
  }
}
