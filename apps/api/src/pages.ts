import { ORPCError } from "@orpc/server";
import type { Actor, PageDetail, PageSummary } from "@rakazo/contracts";
import { PageInputIdSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { PAGE_SHARE_SECRET_KIND, Prisma } from "@rakazo/db";

const DEFAULT_LIST_LIMIT = 30;

const summarySelect = {
  id: true,
  title: true,
  botId: true,
  groupId: true,
  visibility: true,
  currentVersion: true,
  pinnedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PageSelect;

type SummaryRow = Prisma.PageGetPayload<{ select: typeof summarySelect }>;

function pageSummary(row: SummaryRow): PageSummary {
  return {
    id: row.id,
    title: row.title,
    botId: row.botId,
    groupId: row.groupId,
    visibility: "private",
    ...(row.visibility === "link" ? { sharedByLink: true } : {}),
    currentVersion: row.currentVersion,
    pinned: row.pinnedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function pageUnavailable() {
  return new ORPCError("NOT_FOUND", { message: "This page isn't available" });
}

/** Missing and inaccessible pages have the same response from scoped writes. */
async function stillThere<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw pageUnavailable();
    }
    throw error;
  }
}

function ownerScope(actor: Actor) {
  return { spaceId: actor.spaceId, userId: actor.userId };
}

async function requirePage(prisma: PrismaClient, actor: Actor, pageId: string) {
  const row = await prisma.page.findFirst({
    where: { id: pageId, ...ownerScope(actor) },
    select: summarySelect,
  });
  if (!row) throw pageUnavailable();
  return row;
}

export class PageListCursorError extends Error {
  constructor() {
    super("Invalid page list cursor");
  }
}

type ListCursor = { pinnedAt: string | null; updatedAt: string; id: string };

function encodeCursor(row: SummaryRow): string {
  const cursor: ListCursor = {
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): ListCursor {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") === value) {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (parsed && typeof parsed === "object") {
        const { id, updatedAt, pinnedAt } = parsed as Partial<Record<keyof ListCursor, unknown>>;
        const pageId = PageInputIdSchema.safeParse(id);
        if (
          pageId.success &&
          isCursorDate(updatedAt) &&
          (pinnedAt === null || isCursorDate(pinnedAt))
        )
          return { id: pageId.data, updatedAt, pinnedAt };
      }
    }
  } catch {}
  throw new PageListCursorError();
}

function isCursorDate(value: unknown): value is string {
  // Use the ordinary positive four-digit ISO years emitted by this list.
  if (typeof value !== "string" || value.length !== 24 || value.startsWith("0000-")) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

/** Rows after the cursor in (pinned first by pin time, then newest update, then id) order. */
function afterCursor(cursor: ListCursor): Prisma.PageWhereInput {
  const updatedAt = new Date(cursor.updatedAt);
  const sameUpdate: Prisma.PageWhereInput = {
    OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: cursor.id } }],
  };
  if (cursor.pinnedAt === null) return { pinnedAt: null, ...sameUpdate };
  const pinnedAt = new Date(cursor.pinnedAt);
  return {
    OR: [{ pinnedAt: null }, { pinnedAt: { lt: pinnedAt } }, { pinnedAt, ...sameUpdate }],
  };
}

export async function listPages(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId?: string; groupId?: string; cursor?: string; limit?: number; query?: string },
) {
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  if (input.query?.includes("\0"))
    throw new ORPCError("BAD_REQUEST", { message: "Invalid page list query" });
  // Prisma implements case-insensitive contains with ILIKE.
  const query = input.query?.replace(/[\\%_]/g, "\\$&");
  const where: Prisma.PageWhereInput = {
    ...ownerScope(actor),
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.botId ? { botId: input.botId, ...(input.groupId ? {} : { groupId: null }) } : {}),
    ...(input.cursor !== undefined ? { AND: [afterCursor(decodeCursor(input.cursor))] } : {}),
    ...(query ? { title: { contains: query, mode: "insensitive" } } : {}),
  };
  const rows = await prisma.page.findMany({
    where,
    select: summarySelect,
    orderBy: [{ pinnedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(pageSummary),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

export async function getPage(
  prisma: PrismaClient,
  actor: Actor,
  input: { pageId: string; version?: number },
): Promise<PageDetail> {
  const row = await requirePage(prisma, actor, input.pageId);
  const version = input.version ?? row.currentVersion;
  const [stored, owner] = await Promise.all([
    prisma.pageVersion.findUnique({
      where: { pageId_version: { pageId: row.id, version }, page: ownerScope(actor) },
      select: { code: true },
    }),
    prisma.user.findUnique({
      where: { id: actor.userId },
      select: { name: true, image: true },
    }),
  ]);
  if (!stored) throw pageUnavailable();
  return {
    ...pageSummary(row),
    version,
    code: stored.code,
    owner: { name: owner?.name ?? "", image: owner?.image ?? null },
  };
}

export async function renamePage(
  prisma: PrismaClient,
  actor: Actor,
  pageId: string,
  title: string,
) {
  return pageSummary(
    await stillThere(
      prisma.page.update({
        where: { id: pageId, ...ownerScope(actor) },
        data: { title, updatedAt: new Date() },
        select: summarySelect,
      }),
    ),
  );
}

export async function pinPage(prisma: PrismaClient, actor: Actor, pageId: string, pinned: boolean) {
  const [changed] = await prisma.page.updateManyAndReturn({
    where: { id: pageId, ...ownerScope(actor), pinnedAt: pinned ? null : { not: null } },
    data: { pinnedAt: pinned ? new Date() : null },
    select: summarySelect,
  });
  return pageSummary(changed ?? (await requirePage(prisma, actor, pageId)));
}

export async function removePage(prisma: PrismaClient, actor: Actor, pageId: string) {
  await prisma.$transaction(async (tx) => {
    // Read the token attached at deletion, including one rotated by a concurrent owner.
    const deleted = await stillThere(
      tx.page.delete({
        where: { id: pageId, ...ownerScope(actor) },
        select: { shareSecretId: true },
      }),
    );
    if (deleted.shareSecretId) {
      await tx.secret.deleteMany({
        where: { id: deleted.shareSecretId, ...ownerScope(actor), kind: PAGE_SHARE_SECRET_KIND },
      });
    }
  });
  return { ok: true as const };
}
