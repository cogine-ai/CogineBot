import { ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
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
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

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
    await expect(getPage(deps, actor, { pageId: "foreign" })).rejects.toBeInstanceOf(ORPCError);
    await expect(renamePage(prisma, actor, "foreign", "Title")).rejects.toBeInstanceOf(ORPCError);
    await expect(pinPage(prisma, actor, "foreign", true)).rejects.toBeInstanceOf(ORPCError);
    await expect(removePage(deps, actor, "foreign")).rejects.toBeInstanceOf(ORPCError);
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
    await expect(renamePage(prisma, actor, row.id, "Renamed")).rejects.toBeInstanceOf(ORPCError);
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

/** Real RPC serialization with the database as the external seam. */
function pageRpcFixture() {
  let removed = false;
  const db = database({
    findFirst: vi.fn(async ({ where }) =>
      !removed &&
      where.id === row.id &&
      where.userId === actor.userId &&
      where.spaceId === actor.spaceId
        ? row
        : null,
    ),
  });
  const tx = {
    page: {
      delete: vi.fn(async () => {
        removed = true;
        return { shareSecretId: "deleted-token" };
      }),
    },
    secret: { deleteMany: vi.fn(async () => ({ count: 1 })) },
  };
  db.prisma.$transaction = vi.fn(async (work: (tx: unknown) => unknown) => work(tx)) as never;
  const handler = new RPCHandler(
    createRouter({
      prisma: db.prisma,
      env: { webOrigin: "http://127.0.0.1", sandboxProvider: "fake", agentRuntime: "scripted" },
    } as RouterDeps),
  );
  async function call(proc: string, input: unknown, requestActor: Actor | null = actor) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/pages/${proc}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: requestActor } },
    );
    return { status: response.status, body: await response.json() };
  }
  return { ...db, tx, call };
}

const pageOperations = [
  { proc: "get", input: { pageId: row.id } },
  { proc: "rename", input: { pageId: row.id, title: "Renamed" } },
  { proc: "pin", input: { pageId: row.id, pinned: true } },
  { proc: "remove", input: { pageId: row.id } },
];

describe("private Pages RPC unavailable boundary", () => {
  it.each(
    pageOperations.flatMap((operation) =>
      ["missing", "user", "Space"].map((boundary) => ({ ...operation, boundary })),
    ),
  )(
    "$proc sends a private NOT_FOUND for $boundary without reading source or writing",
    async ({ proc, input, boundary }) => {
      const f = pageRpcFixture();
      const scopedActor = {
        ...actor,
        ...(boundary === "user"
          ? { userId: "foreign-user" }
          : boundary === "Space"
            ? { spaceId: "foreign-space" }
            : {}),
      };
      const result = await f.call(
        proc,
        boundary === "missing" ? { ...input, pageId: "missing-page" } : input,
        scopedActor,
      );
      expect(result.status).toBe(404);
      expect(result.body.json).toMatchObject({ code: "NOT_FOUND" });
      expect(JSON.stringify(result.body)).not.toMatch(
        /page-a|missing-page|foreign-user|foreign-space|Plan|stored-code|deleted-token/,
      );
      expect(f.pageVersion.findUnique).not.toHaveBeenCalled();
      expect(f.page.update).not.toHaveBeenCalled();
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("preserves the complete private DTO and historical version without opening share secrets", async () => {
    const f = pageRpcFixture();
    const result = await f.call("get", { pageId: row.id, version: 1 });
    expect(result).toEqual({
      status: 200,
      body: {
        json: {
          id: row.id,
          title: row.title,
          botId: row.botId,
          groupId: null,
          visibility: "private",
          currentVersion: 2,
          pinned: false,
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
          version: 1,
          code: "stored-code",
          owner: { name: "Owner", image: null },
          shareUrl: null,
        },
      },
    });
    expect(f.page.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id, userId: actor.userId, spaceId: actor.spaceId },
        select: expect.not.objectContaining({ shareSecretId: true }),
      }),
    );
  });

  it.each(["rename", "pin"])("keeps an owned %s response successful", async (proc) => {
    const f = pageRpcFixture();
    f.page.update.mockResolvedValue({ ...row, title: "Renamed", pinnedAt: at });
    const result = await f.call(proc, {
      pageId: row.id,
      ...(proc === "rename" ? { title: "Renamed" } : { pinned: true }),
    });
    expect(result.status).toBe(200);
    expect(result.body.json).toMatchObject({
      id: row.id,
      currentVersion: 2,
      title: "Renamed",
      pinned: true,
    });
  });

  it("sends NOT_FOUND when the requested stored version is gone", async () => {
    const f = pageRpcFixture();
    f.pageVersion.findUnique.mockResolvedValue(null);
    const result = await f.call("get", { pageId: row.id, version: 1 });
    expect(result.status).toBe(404);
    expect(result.body.json).toMatchObject({ code: "NOT_FOUND" });
    expect(f.page.update).not.toHaveBeenCalled();
  });

  it.each(pageOperations.filter(({ proc }) => proc !== "get"))(
    "$proc sends NOT_FOUND for deletion after the scoped ownership read",
    async ({ proc, input }) => {
      const f = pageRpcFixture();
      const gone = new Prisma.PrismaClientKnownRequestError("private row disappeared", {
        code: "P2025",
        clientVersion: "test",
      });
      if (proc === "remove") f.tx.page.delete.mockRejectedValue(gone);
      else f.page.update.mockRejectedValue(gone);
      const result = await f.call(proc, input);
      expect(result.status).toBe(404);
      expect(result.body.json).toMatchObject({ code: "NOT_FOUND" });
      expect(JSON.stringify(result.body)).not.toContain("private row disappeared");
      expect(f.tx.secret.deleteMany).not.toHaveBeenCalled();
    },
  );

  it("makes a repeated remove distinguishably gone without deleting another token", async () => {
    const f = pageRpcFixture();
    expect(await f.call("remove", { pageId: row.id })).toEqual({
      status: 200,
      body: { json: { ok: true } },
    });
    const repeated = await f.call("remove", { pageId: row.id });
    expect(repeated.status).toBe(404);
    expect(repeated.body.json).toMatchObject({ code: "NOT_FOUND" });
    expect(f.tx.page.delete).toHaveBeenCalledOnce();
    expect(f.tx.secret.deleteMany).toHaveBeenCalledOnce();
  });

  it.each(["read", "version", "write", "transaction", "secret"])(
    "keeps an unknown %s failure opaque as INTERNAL_SERVER_ERROR",
    async (stage) => {
      const f = pageRpcFixture();
      const failure = new Error("private database diagnostic");
      if (stage === "read") f.page.findFirst.mockRejectedValue(failure);
      if (stage === "version") f.pageVersion.findUnique.mockRejectedValue(failure);
      if (stage === "write") f.page.update.mockRejectedValue(failure);
      if (stage === "transaction") f.prisma.$transaction = vi.fn().mockRejectedValue(failure);
      if (stage === "secret") f.tx.secret.deleteMany.mockRejectedValue(failure);
      const result = await f.call(
        stage === "write" ? "rename" : ["transaction", "secret"].includes(stage) ? "remove" : "get",
        { pageId: row.id, ...(stage === "write" ? { title: "Renamed" } : {}) },
      );
      expect(result.status).toBe(500);
      expect(result.body.json).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      expect(JSON.stringify(result.body)).not.toContain("private database diagnostic");
    },
  );

  it.each(["other-Prisma", "Isolation"])(
    "does not reinterpret an unrelated %s database failure",
    async (kind) => {
      const f = pageRpcFixture();
      const failure =
        kind === "Isolation"
          ? new IsolationError("private secret isolation diagnostic")
          : new Prisma.PrismaClientKnownRequestError("private unique diagnostic", {
              code: "P2002",
              clientVersion: "test",
            });
      if (kind === "Isolation") f.tx.secret.deleteMany.mockRejectedValue(failure);
      else f.page.update.mockRejectedValue(failure);
      const result = await f.call(kind === "Isolation" ? "remove" : "rename", {
        pageId: row.id,
        ...(kind === "Isolation" ? {} : { title: "Renamed" }),
      });
      expect(result.status).toBe(500);
      expect(result.body.json).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      expect(JSON.stringify(result.body)).not.toMatch(/private secret|private unique/);
    },
  );

  it("keeps authentication and cursor validation decisions intact", async () => {
    const f = pageRpcFixture();
    expect((await f.call("get", { pageId: row.id }, null)).status).toBe(401);
    expect(f.page.findFirst).not.toHaveBeenCalled();
    expect((await f.call("list", { cursor: "not-json" })).status).toBe(400);
    expect(f.page.findMany).not.toHaveBeenCalled();
  });
});
