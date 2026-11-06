import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  getPage,
  listPages,
  PageListCursorError,
  pinPage,
  removePage,
  renamePage,
} from "./pages.js";

const actor = { userId: "user-a", spaceId: "space-a" } as Actor;
const at = new Date("2026-01-02T10:00:00.000Z");
const row = {
  id: "page-a",
  title: "Plan",
  botId: "bot-a",
  groupId: null,
  visibility: "private",
  currentVersion: 2,
  pinnedAt: null,
  createdAt: at,
  updatedAt: at,
  shareSecretId: null,
};

/** The external database boundary; production authorization still builds the real scoped queries. */
function database(overrides: Record<string, unknown> = {}) {
  const page = {
    findFirst: vi.fn().mockResolvedValue(row),
    findMany: vi.fn().mockResolvedValue([row]),
    update: vi.fn().mockResolvedValue(row),
    ...overrides,
  };
  const pageVersion = { findUnique: vi.fn().mockResolvedValue({ code: "stored-code" }) };
  const user = { findUnique: vi.fn().mockResolvedValue({ name: "Owner", image: null }) };
  const prisma = { page, pageVersion, user } as unknown as PrismaClient;
  return { prisma, page, pageVersion, user };
}

describe("private pages", () => {
  it("always intersects library filters with the verified user and Space", async () => {
    const { prisma, page } = database();
    await listPages(prisma, actor, { botId: "bot-a", query: "plan" });
    expect(page.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          botId: "bot-a",
          groupId: null,
          title: { contains: "plan", mode: "insensitive" },
        },
      }),
    );
    await listPages(prisma, actor, { groupId: "group-a", botId: "bot-a" });
    expect(page.findMany.mock.lastCall?.[0].where).toMatchObject({
      userId: actor.userId,
      spaceId: actor.spaceId,
      groupId: "group-a",
      botId: "bot-a",
    });
  });

  it("carries the pin/update/id cursor into the next scoped library query", async () => {
    const pinnedAt = new Date("2026-01-01T00:00:00.000Z");
    const { prisma, page } = database({
      findMany: vi.fn().mockResolvedValue([
        { ...row, pinnedAt },
        { ...row, id: "older" },
      ]),
    });
    const first = await listPages(prisma, actor, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    await listPages(prisma, actor, { cursor: first.nextCursor! });
    expect(page.findMany.mock.lastCall?.[0].where).toMatchObject({
      userId: actor.userId,
      spaceId: actor.spaceId,
      AND: [{ OR: [{ pinnedAt: null }, { pinnedAt: { lt: pinnedAt } }, expect.any(Object)] }],
    });
    expect(page.findMany.mock.lastCall?.[0].orderBy).toEqual([
      { pinnedAt: { sort: "desc", nulls: "last" } },
      { updatedAt: "desc" },
      { id: "desc" },
    ]);
  });

  it("rejects an invalid cursor before querying the database", async () => {
    const { prisma, page } = database();
    await expect(listPages(prisma, actor, { cursor: "not-json" })).rejects.toBeInstanceOf(
      PageListCursorError,
    );
    expect(page.findMany).not.toHaveBeenCalled();
  });

  it("reads the requested stored version after ownership and never opens a share token", async () => {
    const { prisma, page, pageVersion } = database({
      findFirst: vi
        .fn()
        .mockResolvedValue({ ...row, visibility: "link", shareSecretId: "old-link" }),
    });
    const detail = await getPage({ prisma }, actor, { pageId: row.id, version: 1 });
    expect(page.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id, spaceId: actor.spaceId, userId: actor.userId },
      }),
    );
    expect(pageVersion.findUnique).toHaveBeenCalledWith({
      where: { pageId_version: { pageId: row.id, version: 1 } },
      select: { code: true },
    });
    expect(detail).toMatchObject({
      version: 1,
      currentVersion: 2,
      code: "stored-code",
      shareUrl: null,
    });
    expect(detail).not.toHaveProperty("shareSecretId");
  });

  it("does not read a version or mutate a page missing from the actor scope", async () => {
    const { prisma, page, pageVersion } = database({ findFirst: vi.fn().mockResolvedValue(null) });
    const deps = { prisma };
    await expect(getPage(deps, actor, { pageId: "foreign" })).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(renamePage(prisma, actor, "foreign", "Title")).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(pinPage(prisma, actor, "foreign", true)).rejects.toBeInstanceOf(IsolationError);
    await expect(removePage(deps, actor, "foreign")).rejects.toBeInstanceOf(IsolationError);
    expect(pageVersion.findUnique).not.toHaveBeenCalled();
    expect(page.update).not.toHaveBeenCalled();
  });

  it("maps concurrent deletion to the same unavailable result", async () => {
    const { prisma } = database({
      update: vi.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("gone", {
          code: "P2025",
          clientVersion: "test",
        }),
      ),
    });
    await expect(renamePage(prisma, actor, row.id, "Renamed")).rejects.toBeInstanceOf(
      IsolationError,
    );
  });

  it("leaves pin time intact when the requested pin state already matches", async () => {
    const { prisma, page } = database();
    expect(await pinPage(prisma, actor, row.id, false)).toMatchObject({ pinned: false });
    expect(page.update).not.toHaveBeenCalled();
  });

  it("deletes the actually removed row's token in the same transaction", async () => {
    const { prisma } = database();
    const events: string[] = [];
    const tx = {
      page: { delete: vi.fn().mockResolvedValue({ shareSecretId: "new-link" }) },
      secret: {
        deleteMany: vi.fn().mockImplementation(async () => {
          events.push("secret-row");
        }),
      },
    };
    prisma.$transaction = vi.fn().mockImplementation(async (work) => {
      const result = await work(tx);
      events.push("commit");
      return result;
    });
    await expect(removePage({ prisma }, actor, row.id)).resolves.toEqual({ ok: true });
    expect(tx.secret.deleteMany).toHaveBeenCalledWith({ where: { id: "new-link" } });
    expect(events).toEqual(["secret-row", "commit"]);
  });

  it("preserves the transaction failure from a rolled-back delete", async () => {
    const { prisma } = database();
    const failure = new Error("transaction rolled back");
    prisma.$transaction = vi.fn().mockRejectedValue(failure);
    await expect(removePage({ prisma }, actor, row.id)).rejects.toBe(failure);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
