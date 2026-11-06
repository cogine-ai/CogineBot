import type { Actor, PageDetail, PageSummary } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, Prisma } from "@rakazo/db";

const DEFAULT_LIST_LIMIT = 30;

type PageDeps = { prisma: PrismaClient };

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
    visibility: row.visibility === "link" ? "link" : "private",
    currentVersion: row.currentVersion,
    pinned: row.pinnedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A page deleted between the ownership read and the write, by another tab, reads as gone. */
async function stillThere<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new IsolationError();
    }
    throw error;
  }
}

async function requirePage(prisma: PrismaClient, actor: Actor, pageId: string) {
  const row = await prisma.page.findFirst({
    where: { id: pageId, spaceId: actor.spaceId, userId: actor.userId },
    select: { ...summarySelect, shareSecretId: true },
  });
  if (!row) throw new IsolationError();
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
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as ListCursor;
    const valid =
      typeof parsed.id === "string" &&
      !Number.isNaN(Date.parse(parsed.updatedAt)) &&
      (parsed.pinnedAt === null || !Number.isNaN(Date.parse(parsed.pinnedAt)));
    if (valid) return parsed;
  } catch {}
  throw new PageListCursorError();
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
  const where: Prisma.PageWhereInput = {
    spaceId: actor.spaceId,
    userId: actor.userId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.botId ? { botId: input.botId, ...(input.groupId ? {} : { groupId: null }) } : {}),
    ...(input.cursor ? { AND: [afterCursor(decodeCursor(input.cursor))] } : {}),
    ...(input.query ? { title: { contains: input.query, mode: "insensitive" } } : {}),
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
  deps: PageDeps,
  actor: Actor,
  input: { pageId: string; version?: number },
): Promise<PageDetail> {
  const row = await requirePage(deps.prisma, actor, input.pageId);
  const version = input.version ?? row.currentVersion;
  const [stored, owner] = await Promise.all([
    deps.prisma.pageVersion.findUnique({
      where: { pageId_version: { pageId: row.id, version } },
      select: { code: true },
    }),
    deps.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { name: true, image: true },
    }),
  ]);
  if (!stored) throw new IsolationError();
  return {
    ...pageSummary(row),
    version,
    code: stored.code,
    owner: { name: owner?.name ?? "", image: owner?.image ?? null },
    shareUrl: null,
  };
}

export async function renamePage(
  prisma: PrismaClient,
  actor: Actor,
  pageId: string,
  title: string,
) {
  await requirePage(prisma, actor, pageId);
  return pageSummary(
    await stillThere(
      prisma.page.update({
        where: { id: pageId },
        data: { title, updatedAt: new Date() },
        select: summarySelect,
      }),
    ),
  );
}

export async function pinPage(prisma: PrismaClient, actor: Actor, pageId: string, pinned: boolean) {
  const row = await requirePage(prisma, actor, pageId);
  if ((row.pinnedAt !== null) === pinned) return pageSummary(row);
  return pageSummary(
    await stillThere(
      prisma.page.update({
        where: { id: pageId },
        data: { pinnedAt: pinned ? new Date() : null },
        select: summarySelect,
      }),
    ),
  );
}

/** The App persistence client cleans removed token material after this transaction commits. */
export async function removePage(deps: PageDeps, actor: Actor, pageId: string) {
  const row = await requirePage(deps.prisma, actor, pageId);
  await deps.prisma.$transaction(async (tx) => {
    // The deleted row's token, not a stale ownership read; a concurrent swap may have changed it.
    const deleted = await stillThere(
      tx.page.delete({ where: { id: row.id }, select: { shareSecretId: true } }),
    );
    if (deleted.shareSecretId) await tx.secret.deleteMany({ where: { id: deleted.shareSecretId } });
  });
  return { ok: true as const };
}
