import { randomUUID } from "node:crypto";
import type { PageTransferRecord } from "@rakazo/contracts";
import { PageTransferRecordSchema } from "@rakazo/contracts";
import { pageLinksAsTitles } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError, lockSpaceForContentCreation, runAsTenant } from "@rakazo/db";
import { checkPageSource } from "@rakazo/page-kit/validate";

const PAGE_BATCH = 32;

type PageTransferScope = { userId: string; spaceId: string };
type PageTransferTarget = PageTransferScope & {
  botIds?: ReadonlyMap<string, string>;
  groupIds?: ReadonlyMap<string, string>;
};
type PageRecord = Extract<PageTransferRecord, { type: "page" }>;
type VersionRecord = Extract<PageTransferRecord, { type: "page_version" }>;

export class PageTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageTransferError";
  }
}

/** Export one owner's Pages using each header's version as the upper bound for its history. */
export async function* exportPageRecords(
  prisma: PrismaClient,
  scope: PageTransferScope,
): AsyncGenerator<PageTransferRecord> {
  const owner = { userId: scope.userId, spaceId: scope.spaceId };
  const readMembership = () =>
    runAsTenant(owner, () =>
      prisma.spaceMember.findUnique({
        where: { spaceId_userId: owner },
        select: { id: true },
      }),
    );
  const membership = await readMembership();
  if (!membership) throw new IsolationError();
  // A new membership must not resume a stream started under the previous grant.
  const ownedPage = {
    ...owner,
    space: { memberships: { some: { id: membership.id, userId: owner.userId } } },
  };
  const association = { id: true, spaceId: true, userId: true } as const;
  const ownId = (ref: (PageTransferScope & { id: string }) | null) =>
    ref?.spaceId === owner.spaceId && ref.userId === owner.userId ? ref.id : null;

  for (let cursor = ""; ; ) {
    const pages = await runAsTenant(owner, () =>
      prisma.page.findMany({
        where: { ...ownedPage, id: { gt: cursor } },
        orderBy: { id: "asc" },
        take: PAGE_BATCH,
        select: {
          id: true,
          bot: { select: association },
          group: { select: association },
          title: true,
          pinnedAt: true,
          currentVersion: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    for (const page of pages) {
      yield {
        type: "page",
        id: page.id,
        botId: ownId(page.bot),
        groupId: ownId(page.group),
        title: page.title,
        pinnedAt: page.pinnedAt?.toISOString() ?? null,
        currentVersion: page.currentVersion,
        createdAt: page.createdAt.toISOString(),
        updatedAt: page.updatedAt.toISOString(),
      };
      for (let version = 0; ; ) {
        const versions = await runAsTenant(owner, () =>
          prisma.pageVersion.findMany({
            where: {
              pageId: page.id,
              page: ownedPage,
              version: { gt: version, lte: page.currentVersion },
            },
            orderBy: { version: "asc" },
            take: PAGE_BATCH,
            select: { id: true, version: true, title: true, source: true, createdAt: true },
          }),
        );
        for (const row of versions) {
          yield {
            type: "page_version",
            ...row,
            pageId: page.id,
            createdAt: row.createdAt.toISOString(),
          };
        }
        version = versions.at(-1)?.version ?? version;
        if (version === page.currentVersion) break;
        // Deletion or lost access can end the cursor before the observed head.
        if (versions.length < PAGE_BATCH) {
          throw new PageTransferError("Page history changed during export. Retry the export.");
        }
      }
    }
    if (pages.length < PAGE_BATCH) break;
    cursor = pages.at(-1)!.id;
  }
  // An empty final batch can also mean that membership was lost between reads.
  if ((await readMembership())?.id !== membership.id) throw new IsolationError();
}

/** Remap Page links in chat Markdown. Page JSX is transferred verbatim. */
export function remapTransferredPageLinks(text: string, pageIds: ReadonlyMap<string, string>) {
  if (!pageIds.size || !text.includes("(page:")) return text;
  let updated = "";
  let cursor = 0;
  pageLinksAsTitles(text, (id, _title, _start, end) => {
    const replacement = pageIds.get(id);
    if (!replacement) return;
    const idStart = end - 1 - id.length;
    updated += text.slice(cursor, idStart) + replacement;
    cursor = end - 1;
  });
  return updated + text.slice(cursor);
}

/** Resolve the record graph and compile historical source before opening the destination transaction. */
function preparePageImport(input: readonly unknown[], target: PageTransferTarget) {
  const recordIds = new Set<string>();
  const pages: PageRecord[] = [];
  const versions = new Map<string, Map<number, VersionRecord>>();
  for (const value of input) {
    const parsed = PageTransferRecordSchema.safeParse(value);
    if (!parsed.success) throw new PageTransferError("Invalid Page transfer record");
    const record = parsed.data;
    if (recordIds.has(record.id)) throw new PageTransferError("Duplicate Page transfer record ID");
    recordIds.add(record.id);
    if (record.type === "page") {
      pages.push(record);
    } else {
      let history = versions.get(record.pageId);
      if (!history) {
        history = new Map();
        versions.set(record.pageId, history);
      }
      if (history.has(record.version)) throw new PageTransferError("Duplicate Page version");
      history.set(record.version, record);
    }
  }
  const pageIds = new Map(pages.map(({ id }) => [id, randomUUID()]));
  for (const pageId of versions.keys()) {
    if (!pageIds.has(pageId)) throw new PageTransferError("Page version is missing its Page");
  }
  const versionIds = new Map<string, string>();
  const pageRows: Prisma.PageCreateManyInput[] = [];
  const versionRows: Prisma.PageVersionCreateManyInput[] = [];
  const scope = { userId: target.userId, spaceId: target.spaceId };
  for (const page of pages) {
    const history = versions.get(page.id);
    if (!history) throw new PageTransferError("Page has no versions");
    const pageId = pageIds.get(page.id)!;
    let newestVersion = 0;
    for (const record of history.values()) {
      const id = randomUUID();
      versionIds.set(record.id, id);
      newestVersion = Math.max(newestVersion, record.version);
      const check = checkPageSource(record.source);
      // Keep the source as history, but do not run source that failed today's checks.
      const code = check.ok
        ? check.code
        : `throw new Error(${JSON.stringify(check.errors.join("\n"))});`;
      versionRows.push({
        id,
        pageId,
        version: record.version,
        title: record.title,
        source: record.source,
        code,
        createdAt: new Date(record.createdAt),
      });
    }
    pageRows.push({
      ...scope,
      id: pageId,
      title: page.title,
      botId: page.botId === null ? null : (target.botIds?.get(page.botId) ?? null),
      groupId: page.groupId === null ? null : (target.groupIds?.get(page.groupId) ?? null),
      visibility: "private",
      pinnedAt: page.pinnedAt === null ? null : new Date(page.pinnedAt),
      currentVersion: newestVersion,
      createdAt: new Date(page.createdAt),
      updatedAt: new Date(page.updatedAt),
    });
  }
  return { pageRows, versionRows, pageIds, versionIds };
}

/** Import pre-collected portable records into one trusted destination, without activating anything. */
export async function importPageRecords(
  prisma: PrismaClient,
  target: PageTransferTarget,
  input: readonly unknown[],
) {
  const scope = { userId: target.userId, spaceId: target.spaceId };
  const { pageRows, versionRows, pageIds, versionIds } = preparePageImport(input, target);
  const botIds = [...new Set(pageRows.flatMap(({ botId }) => (botId == null ? [] : [botId])))];
  const groupIds = [
    ...new Set(pageRows.flatMap(({ groupId }) => (groupId == null ? [] : [groupId]))),
  ];
  await runAsTenant(scope, () =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceForContentCreation(tx, scope);
        if (
          (botIds.length &&
            (await tx.bot.count({ where: { ...scope, id: { in: botIds } } })) !== botIds.length) ||
          (groupIds.length &&
            (await tx.chatGroup.count({ where: { ...scope, id: { in: groupIds } } })) !==
              groupIds.length)
        ) {
          throw new IsolationError();
        }
        if (pageRows.length) await tx.page.createMany({ data: pageRows });
        for (let start = 0; start < versionRows.length; start += PAGE_BATCH) {
          await tx.pageVersion.createMany({ data: versionRows.slice(start, start + PAGE_BATCH) });
        }
      },
      { timeout: 30_000 },
    ),
  );
  return { pageIds, versionIds };
}
