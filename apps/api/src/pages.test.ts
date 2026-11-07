import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { listPages, PageListCursorError } from "./pages.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  userId: "user-a",
  spaceId: "space-a",
  email: "user-a@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
const at = new Date("2026-01-02T10:00:00.000Z");
const row = {
  id: "page-a",
  title: "Plan",
  botId: "bot-a",
  groupId: null,
  currentVersion: 2,
  pinnedAt: null as Date | null,
  createdAt: at,
  updatedAt: at,
};
const owner = { userId: actor.userId, spaceId: actor.spaceId };
const ownedPage = { id: row.id, ...owner };

function knownError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("private database diagnostic", {
    code,
    clientVersion: "test",
  });
}

function pageRpcFixture() {
  let current = { ...row } as typeof row | null;
  const matches = (where: Prisma.PageWhereInput) =>
    current &&
    Object.entries(ownedPage).every(
      ([key, value]) => where[key as keyof typeof ownedPage] === value,
    );
  const page = {
    findFirst: vi.fn(async ({ where }: { where: Prisma.PageWhereInput }) =>
      matches(where) ? current : null,
    ),
    findMany: vi.fn(async (_query: Prisma.PageFindManyArgs): Promise<(typeof row)[]> => [row]),
    update: vi.fn(
      async ({ where, data }: { where: Prisma.PageWhereInput; data: Partial<typeof row> }) => {
        if (!matches(where)) throw knownError("P2025");
        current = { ...current!, ...data };
        return current;
      },
    ),
    updateManyAndReturn: vi.fn(
      async ({ where, data }: { where: Prisma.PageWhereInput; data: Partial<typeof row> }) => {
        if (!matches(where) || (current!.pinnedAt === null) !== (where.pinnedAt === null))
          return [];
        current = { ...current!, ...data };
        return [current];
      },
    ),
    delete: vi.fn(async ({ where }: { where: Prisma.PageWhereInput }) => {
      if (!matches(where)) throw knownError("P2025");
      current = null;
      return { id: row.id };
    }),
  };
  const pageVersion = { findUnique: vi.fn().mockResolvedValue({ code: "stored-code" }) };
  const user = { findUnique: vi.fn().mockResolvedValue({ name: "Owner", image: null }) };
  const prisma = { page, pageVersion, user } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({
      prisma,
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
    if (!response) throw new Error("The test RPC did not resolve");
    return { status: response.status, body: (await response.json()).json };
  }
  return { prisma, page, pageVersion, call };
}

describe("private Pages library", () => {
  it("uses owner scope with the selected Bot and group, while sorting by pin, update, and id", async () => {
    const f = pageRpcFixture();
    await listPages(f.prisma, actor, { botId: "bot-a", query: "plan" });
    expect(f.page.findMany.mock.lastCall?.[0]).toMatchObject({
      where: {
        ...owner,
        botId: "bot-a",
        groupId: null,
        title: { contains: "plan", mode: "insensitive" },
      },
      orderBy: [
        { pinnedAt: { sort: "desc", nulls: "last" } },
        { updatedAt: "desc" },
        { id: "desc" },
      ],
      take: 31,
    });
    await listPages(f.prisma, actor, { botId: "bot-a", groupId: "group-a" });
    expect(f.page.findMany.mock.lastCall?.[0].where).toEqual({
      ...owner,
      botId: "bot-a",
      groupId: "group-a",
    });
  });

  it.each([null, new Date("2026-01-01T10:00:00.000Z")])(
    "round-trips the stable cursor for pin timestamp %s",
    async (pinnedAt) => {
      const f = pageRpcFixture();
      f.page.findMany.mockResolvedValueOnce([
        { ...row, pinnedAt },
        { ...row, id: "older" },
      ]);
      const first = await listPages(f.prisma, actor, { limit: 1 });
      expect(first.items.map((item) => item.id)).toEqual([row.id]);
      const sameUpdate = {
        OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: row.id } }],
      };
      await listPages(f.prisma, actor, { cursor: first.nextCursor! });
      expect(f.page.findMany.mock.lastCall?.[0].where).toEqual({
        ...owner,
        AND: [
          pinnedAt
            ? {
                OR: [
                  { pinnedAt: null },
                  { pinnedAt: { lt: pinnedAt } },
                  { pinnedAt, ...sameUpdate },
                ],
              }
            : { pinnedAt: null, ...sameUpdate },
        ],
      });
    },
  );

  it.each([
    "",
    "not-json",
    Buffer.from(JSON.stringify({ id: row.id, updatedAt: 0, pinnedAt: null })).toString("base64url"),
    Buffer.from(JSON.stringify({ id: "", updatedAt: at.toISOString(), pinnedAt: null })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({ id: row.id, updatedAt: at.toISOString(), pinnedAt: "2026-01" }),
    ).toString("base64url"),
  ])("rejects an invalid cursor without querying the database (%s)", async (cursor) => {
    const f = pageRpcFixture();
    await expect(listPages(f.prisma, actor, { cursor })).rejects.toBeInstanceOf(
      PageListCursorError,
    );
    expect(f.page.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { id: "page\0a", updatedAt: at.toISOString(), pinnedAt: null },
    { id: row.id, updatedAt: "-100000-01-02T10:00:00.000Z", pinnedAt: null },
    { id: row.id, updatedAt: at.toISOString(), pinnedAt: "+010000-01-02T10:00:00.000Z" },
    { id: row.id, updatedAt: "0000-01-02T10:00:00.000Z", pinnedAt: null },
  ])(
    "rejects a cursor with unsupported text or dates ($id, $updatedAt, $pinnedAt)",
    async (input) => {
      const f = pageRpcFixture();
      const cursor = Buffer.from(JSON.stringify(input)).toString("base64url");
      expect(await f.call("list", { cursor })).toMatchObject({
        status: 400,
        body: { code: "BAD_REQUEST" },
      });
      expect(f.page.findMany).not.toHaveBeenCalled();
    },
  );

  it("escapes wildcard and escape characters in a literal title search", async () => {
    const f = pageRpcFixture();
    await listPages(f.prisma, actor, { query: "50%_\\review" });
    expect(f.page.findMany.mock.lastCall?.[0].where).toMatchObject({
      title: { contains: "50\\%\\_\\\\review", mode: "insensitive" },
    });
  });
});

const operations = [
  { proc: "get", input: { pageId: row.id } },
  { proc: "rename", input: { pageId: row.id, title: "Renamed" } },
  { proc: "pin", input: { pageId: row.id, pinned: true } },
  { proc: "remove", input: { pageId: row.id } },
];

describe("private Pages RPC", () => {
  it.each(
    operations.flatMap((op) =>
      ["missing", "user", "Space"].map((boundary) => ({ ...op, boundary })),
    ),
  )(
    "$proc returns the same unavailable response for $boundary",
    async ({ proc, input, boundary }) => {
      const f = pageRpcFixture();
      const target = boundary === "missing" ? { ...input, pageId: "missing-page" } : input;
      const caller = {
        ...actor,
        ...(boundary === "user" ? { userId: "foreign-user" } : {}),
        ...(boundary === "Space" ? { spaceId: "foreign-space" } : {}),
      };
      const result = await f.call(proc, target, caller);
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({
        code: "NOT_FOUND",
        message: "This page isn't available",
      });
      expect(JSON.stringify(result.body)).not.toMatch(
        /page-a|missing-page|foreign-user|foreign-space|Plan|stored-code|private database/,
      );
      expect(f.pageVersion.findUnique).not.toHaveBeenCalled();
      expect((await f.call("get", { pageId: row.id })).body).toMatchObject({
        title: row.title,
        pinned: false,
      });
    },
  );

  it("returns an owned historical version and keeps the persisted version lookup in the owner scope", async () => {
    const f = pageRpcFixture();
    expect(await f.call("get", { pageId: row.id, version: 1 })).toEqual({
      status: 200,
      body: {
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
      },
    });
    expect(f.pageVersion.findUnique).toHaveBeenCalledWith({
      where: { pageId_version: { pageId: row.id, version: 1 }, page: owner },
      select: { code: true },
    });
    f.pageVersion.findUnique.mockResolvedValueOnce(null);
    expect((await f.call("get", { pageId: row.id, version: 1 })).status).toBe(404);
  });

  it("normalizes rename, preserves content version, and scopes each mutation", async () => {
    const f = pageRpcFixture();
    const renamed = await f.call("rename", { pageId: row.id, title: " Renamed\npage " });
    expect(renamed.body).toMatchObject({ title: "Renamed page", currentVersion: 2, pinned: false });
    expect(f.page.update).toHaveBeenCalledWith(expect.objectContaining({ where: ownedPage }));
    expect((await f.call("pin", { pageId: row.id, pinned: true })).body).toMatchObject({
      pinned: true,
      title: "Renamed page",
      currentVersion: 2,
      updatedAt: renamed.body.updatedAt,
    });
    const pinQuery = f.page.updateManyAndReturn.mock.lastCall?.[0];
    expect(pinQuery).toMatchObject({
      where: { ...ownedPage, pinnedAt: null },
      data: { pinnedAt: expect.any(Date) },
    });
    expect((await f.call("pin", { pageId: row.id, pinned: true })).body.pinned).toBe(true);
    expect(f.page.findFirst).toHaveBeenCalledOnce();
    expect(await f.call("remove", { pageId: row.id })).toEqual({ status: 200, body: { ok: true } });
    expect(f.page.delete).toHaveBeenCalledWith({ where: ownedPage, select: { id: true } });
    expect((await f.call("remove", { pageId: row.id })).status).toBe(404);
  });

  it("rejects anonymous, malformed cursor, and out-of-range version before accessing rows", async () => {
    const f = pageRpcFixture();
    expect((await f.call("get", { pageId: row.id }, null)).status).toBe(401);
    expect((await f.call("get", { pageId: row.id, version: 2_147_483_648 })).status).toBe(400);
    expect((await f.call("list", { cursor: "not-json" })).status).toBe(400);
    expect(f.page.findFirst).not.toHaveBeenCalled();
    expect(f.page.findMany).not.toHaveBeenCalled();
    expect(f.pageVersion.findUnique).not.toHaveBeenCalled();
  });

  it("rejects NUL in Page filters and identifiers before accessing rows", async () => {
    const f = pageRpcFixture();
    for (const input of [{ botId: "bot\0a" }, { groupId: "group\0a" }, { query: "a\0b" }]) {
      expect(await f.call("list", input)).toMatchObject({
        status: 400,
        body: { code: "BAD_REQUEST" },
      });
    }
    for (const { proc, input } of operations) {
      expect(await f.call(proc, { ...input, pageId: "page\0a" })).toMatchObject({
        status: 400,
        body: { code: "BAD_REQUEST" },
      });
    }
    for (const method of Object.values(f.page)) expect(method).not.toHaveBeenCalled();
  });

  it.each([knownError("P2002"), new IsolationError("private database diagnostic")])(
    "does not disguise unexpected write failures as unavailable or expose diagnostics",
    async (error) => {
      const f = pageRpcFixture();
      f.page.delete.mockRejectedValueOnce(error);
      const result = await f.call("remove", { pageId: row.id });
      expect(result.status).toBe(500);
      expect(result.body).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      expect(JSON.stringify(result.body)).not.toContain("private database diagnostic");
    },
  );
});
