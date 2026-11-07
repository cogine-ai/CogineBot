import { randomBytes, randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import {
  applyRowSecurityPolicies,
  createDb,
  type Prisma,
  type PrismaClient,
  provisionRuntimeRole,
  rlsBypassKey,
  runAsTenant,
  verifyRuntimeDatabase,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getPage,
  listPages,
  PageListCursorError,
  pinPage,
  removePage,
  renamePage,
} from "../../../apps/api/src/pages.js";
import {
  type PageToolContext,
  recoverSavedPageFromTool,
  savePageFromTool,
} from "../../adapters/src/page-tools.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres =
  process.env.VERIFY_DATABASE === "1" &&
  process.env.VERIFY_ROW_SECURITY_POLICIES === "harness_isolated" &&
  databaseUrl
    ? describe.sequential
    : describe.skip;
const source = (text: string) =>
  `export default function App() { return <Page title="Example"><Text>${text}</Text></Page>; }`;
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

function withTransaction(
  prisma: PrismaClient,
  wrap: (
    next: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown>,
    work: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => Promise<unknown>,
) {
  return new Proxy(prisma, {
    get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key, target);
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        wrap((next) => target.$transaction(next), work);
    },
  });
}

postgres("private Pages operations (isolated PostgreSQL)", () => {
  const login = `pages_runtime_${randomBytes(8).toString("hex")}`;
  let owner: ReturnType<typeof createDb> | undefined;
  let runtime: ReturnType<typeof createDb> | undefined;
  let grantRole: string | undefined;
  let runtimeUrl: string | undefined;
  let ownRoles = false;
  const admin = () => owner!.prisma;
  const client = () => runtime!.prisma;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const database = url.pathname.slice(1);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) <= 1024 ||
      !/^integration_(0|[1-9][0-9]*)$/.test(database) ||
      database !== process.env.VERIFY_ROW_SECURITY_POLICIES_DATABASE ||
      database !== process.env.VERIFY_ISOLATED_DATABASE ||
      ["host", "hostaddr", "port", "database", "dbname", "service"].some((key) =>
        url.searchParams.has(key),
      )
    ) {
      throw new Error("Pages tests require an explicitly isolated harness database");
    }
    owner = createDb(databaseUrl!, { poolMax: 4 });
    const identity = await owner.pool.query<{ name: string; grant: string }>(
      "SELECT datname AS name, 'coginebot_app_' || oid::text AS grant FROM pg_database WHERE datname=current_database()",
    );
    expect(identity.rows[0]?.name).toBe(database);
    grantRole = identity.rows[0]!.grant;
    expect(
      (
        await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname = ANY($1)", [
          [login, grantRole],
        ])
      ).rowCount,
    ).toBe(0);
    ownRoles = true;
    url.username = login;
    url.password = randomBytes(24).toString("hex");
    url.searchParams.delete("user");
    url.searchParams.delete("password");
    runtimeUrl = url.toString();
    await provisionRuntimeRole(databaseUrl!, runtimeUrl);
    await applyRowSecurityPolicies(databaseUrl!, runtimeUrl);
    runtime = createDb(runtimeUrl, { poolMax: 5, rowSecurity: true });
    await expect(verifyRuntimeDatabase(client())).resolves.toMatchObject({
      connectionEnforced: true,
    });
  }, 120_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const clean = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    if (runtime) {
      await clean(() => runtime!.prisma.$disconnect());
      await clean(() => runtime!.pool.end());
    }
    if (owner) {
      if (ownRoles) {
        if (runtimeUrl) {
          await clean(() =>
            owner!.pool.query(
              "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
              [rlsBypassKey(runtimeUrl!)],
            ),
          );
        }
        for (const role of [login, grantRole!]) {
          await clean(async () => {
            const exists = await owner!.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
              role,
            ]);
            if (!exists.rowCount) return;
            await owner!.pool.query(`DROP OWNED BY ${quoted(role)}`);
            await owner!.pool.query(`DROP ROLE ${quoted(role)}`);
          });
        }
      }
      await clean(() => owner!.prisma.$disconnect());
      await clean(() => owner!.pool.end());
    }
    if (failures.length) throw new AggregateError(failures, "Pages fixture cleanup failed");
  });

  async function setup(trigger = "user", groupChat = false) {
    const id = randomUUID();
    const actor: Actor = {
      userId: `user-${id}`,
      spaceId: `space-${id}`,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const { userId, spaceId, email } = actor;
    const scope = { userId, spaceId };
    const db = admin();
    await db.user.create({ data: { id: userId, email, name: "Pages fixture" } });
    await db.space.create({
      data: {
        id: spaceId,
        name: "Pages fixture",
        organization: {
          create: { id, name: "Pages fixture", slug: id, createdAt: new Date() },
        },
      },
    });
    const bot = await db.bot.create({
      data: { ...scope, name: "Pages fixture", color: "#3EC5A8" },
    });
    const botScope = { ...scope, botId: bot.id };
    const group = groupChat
      ? await db.chatGroup.create({ data: { ...scope, name: "Pages fixture group" } })
      : null;
    const thread = await db.thread.create({
      data: group ? { ...scope, groupId: group.id } : botScope,
    });
    const task = await db.task.create({
      data: { ...botScope, threadId: thread.id, status: "running", prompt: "Pages fixture" },
    });
    const lease = { owner: "page-worker", fence: 1 };
    const run = await db.run.create({
      data: {
        ...botScope,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger,
        leaseOwner: lease.owner,
        leaseFence: lease.fence,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const notify = vi.fn<NonNullable<PageToolContext["notify"]>>(async () => undefined);
    const state = { tainted: false };
    const context = (effect: { id: string }, prisma = client()): PageToolContext => ({
      deps: { prisma },
      run,
      bot,
      thread,
      effect,
      lease,
      state,
      secrets: [],
      notify,
    });
    const newEffect = (args: Prisma.InputJsonValue, status = "intended") =>
      db.externalEffect.create({
        data: {
          spaceId,
          runId: run.id,
          kind: "save_page",
          status,
          idempotencyKey: randomUUID(),
          request: args,
        },
      });
    const seed = (
      title: string,
      attrs?: Pick<Prisma.PageUncheckedCreateInput, "id" | "updatedAt">,
    ) =>
      db.page.create({
        data: {
          ...botScope,
          title,
          ...attrs,
          versions: { create: { version: 1, title, source: source("Original"), code: "v1" } },
        },
      });
    const tenant = <T>(work: () => Promise<T>) => runAsTenant(actor, work);
    const cardWhere = { runId: run.id, threadId: thread.id, type: "thread.message.created" };
    return {
      actor,
      bot,
      run,
      thread,
      group,
      context,
      notify,
      state,
      seed,
      newEffect,
      tenant,
      cardWhere,
    };
  }

  it.each(
    (["intended", "executing"] as const).flatMap((status) =>
      (["create", "source", "edits"] as const).map((mode) => ({ status, mode })),
    ),
  )("replays $status $mode after the commit reply is lost", async ({ status, mode }) => {
    const { bot, run, thread, context, notify, newEffect, seed, tenant, cardWhere } = await setup();
    const previous = mode === "create" ? undefined : await seed("Plan");
    const args =
      mode === "create"
        ? { title: "Plan", source: source("Original") }
        : mode === "source"
          ? { pageId: previous!.id, source: source("Updated") }
          : { pageId: previous!.id, edits: [{ find: "Original", replace: "Original updated" }] };
    const effect = await newEffect(args, status);
    const version = mode === "create" ? 1 : 2;
    let interrupted = false;
    const ctx = context(
      effect,
      withTransaction(client(), async (next, work) => {
        const value = await next(work);
        if (!interrupted) {
          interrupted = true;
          throw new Error("lost reply after PostgreSQL commit");
        }
        return value;
      }),
    );
    const resume = () =>
      status === "executing" ? recoverSavedPageFromTool(ctx, args) : savePageFromTool(ctx, args);
    if (status === "executing") await expect(tenant(resume)).resolves.toBeUndefined();
    await expect(tenant(() => savePageFromTool(ctx, args))).rejects.toThrow("lost reply");

    const row = await admin().page.findFirstOrThrow({ where: { botId: bot.id } });
    expect(row).toMatchObject({ currentVersion: version, visibility: "private" });
    const block = { kind: "page", pageId: row.id, title: "Plan", version };
    const message = await admin().message.findFirstOrThrow({
      where: { threadId: thread.id, clientNonce: `page-save:${effect.id}` },
    });
    expect(message.blocks).toEqual([block]);
    const event = await admin().event.findFirstOrThrow({ where: cardWhere });
    expect(event.payload).toMatchObject({
      messageId: message.id,
      messageSeq: message.seq,
      blocks: [block],
    });
    expect(
      await admin().externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
    ).toMatchObject({
      status,
      result: {
        kind: "page_save",
        cardEventSeq: event.seq,
        saved: { pageId: row.id, title: "Plan", version },
      },
    });
    expect(notify).not.toHaveBeenCalled();
    expect(
      (await admin().run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toEqual(event.createdAt);

    if (status === "executing") {
      for (const changed of [
        { ...ctx, effect: { id: "another-effect" } },
        { ...ctx, run: { ...ctx.run, id: "another-run" } },
        { ...ctx, run: { ...ctx.run, userId: "another-user" } },
        { ...ctx, run: { ...ctx.run, spaceId: "another-space" } },
        { ...ctx, run: { ...ctx.run, threadId: "another-thread" } },
        { ...ctx, bot: { id: "another-bot" } },
      ]) {
        await expect(
          tenant(() => recoverSavedPageFromTool(changed, args)),
        ).resolves.toBeUndefined();
      }
      await expect(
        tenant(() => recoverSavedPageFromTool(ctx, { ...args, title: "Changed request" })),
      ).resolves.toBeUndefined();
    }
    const result = await tenant(resume);
    expect(result).toMatchObject({ pageId: row.id, version });
    await expect(tenant(resume)).resolves.toEqual(result);
    expect(notify).toHaveBeenCalledWith(thread.id, event.seq, undefined);
    expect(await admin().pageVersion.count({ where: { pageId: row.id } })).toBe(version);
    expect(await admin().message.count({ where: { threadId: thread.id } })).toBe(1);
    expect(await admin().event.count({ where: cardWhere })).toBe(1);

    const next = context(await newEffect(args));
    await expect(tenant(() => savePageFromTool(next, args))).resolves.toMatchObject({
      version: mode === "create" ? 1 : version + 1,
    });
    expect(await admin().event.count({ where: cardWhere })).toBe(2);
    expect(notify.mock.lastCall?.[2]).toBeUndefined();
    expect(
      (await admin().run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toEqual(event.createdAt);
  });

  it("serializes same-effect callers before creating any duplicate Page, version or card", async () => {
    const { bot, run, context, notify, newEffect, tenant, cardWhere, thread } = await setup();
    const args = { title: "Race", source: source("Race") };
    const effect = await newEffect(args);
    let entrants = 0;
    const bothReady = Promise.withResolvers<void>();
    const ctx = context(
      effect,
      withTransaction(client(), async (next, work) => {
        if (++entrants === 2) bothReady.resolve();
        await bothReady.promise;
        return next(work);
      }),
    );
    const [first, second] = await Promise.all([
      tenant(() => savePageFromTool(ctx, args)),
      tenant(() => savePageFromTool(ctx, args)),
    ]);
    expect(entrants).toBe(2);
    expect(first).toMatchObject({ title: "Race", version: 1 });
    expect(second).toEqual(first);
    expect(await admin().page.count({ where: { botId: bot.id } })).toBe(1);
    expect(await admin().pageVersion.count({ where: { page: { botId: bot.id } } })).toBe(1);
    expect(await admin().message.count({ where: { threadId: thread.id } })).toBe(1);
    const events = await admin().event.findMany({ where: cardWhere });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(notify.mock.calls).toHaveLength(2);
    expect(notify).toHaveBeenCalledWith(thread.id, event.seq, run.id);
    expect(notify).toHaveBeenCalledWith(thread.id, event.seq, undefined);
    expect(
      (await admin().run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toEqual(event.createdAt);
  });

  it("rolls back the Page, version, card, sequence and receipt when event persistence fails", async () => {
    const { bot, context, newEffect, tenant, cardWhere, thread, notify } = await setup();
    const args = { title: "Rollback", source: source("Rollback") };
    const effect = await newEffect(args);
    const failed = context(
      effect,
      withTransaction(client(), (next, work) =>
        next((tx) =>
          work(
            new Proxy(tx, {
              get(target, key) {
                if (key === "event") {
                  return {
                    create: async () => {
                      throw new Error("injected event failure");
                    },
                  };
                }
                return Reflect.get(target, key, target);
              },
            }),
          ),
        ),
      ),
    );
    await expect(tenant(() => savePageFromTool(failed, args))).rejects.toThrow(
      "injected event failure",
    );
    expect(await admin().page.count({ where: { botId: bot.id } })).toBe(0);
    expect(await admin().pageVersion.count({ where: { page: { botId: bot.id } } })).toBe(0);
    expect(await admin().message.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await admin().event.count({ where: cardWhere })).toBe(0);
    expect(await admin().thread.findUniqueOrThrow({ where: { id: thread.id } })).toMatchObject({
      nextEventSeq: 0,
      nextMessageSeq: 0,
    });
    expect(
      await admin().externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
    ).toMatchObject({
      result: null,
    });
    expect(notify).not.toHaveBeenCalled();
    await expect(tenant(() => savePageFromTool(context(effect), args))).resolves.toMatchObject({
      version: 1,
    });
    expect(await admin().event.count({ where: cardWhere })).toBe(1);
  });

  it.each(["version", "rename"] as const)(
    "keeps a competing %s made after the content read",
    async (concurrent) => {
      const { actor, context, newEffect, seed, tenant, cardWhere } = await setup();
      const stored = await seed("Before");
      const args = { pageId: stored.id, source: source("Next") };
      const effect = await newEffect(args);
      const reachedWrite = Promise.withResolvers<void>();
      const competingWrite = Promise.withResolvers<void>();
      const ctx = context(
        effect,
        withTransaction(client(), async (next, work) => {
          reachedWrite.resolve();
          await competingWrite.promise;
          return next(work);
        }),
      );
      const writing = tenant(() => savePageFromTool(ctx, args));
      await Promise.race([reachedWrite.promise, writing]);
      try {
        if (concurrent === "version") {
          await admin().page.update({
            where: { id: stored.id },
            data: {
              currentVersion: 2,
              versions: {
                create: { version: 2, title: "Before", source: source("Winner"), code: "v2" },
              },
            },
          });
        } else {
          await tenant(() => renamePage(client(), actor, stored.id, "Renamed"));
        }
      } finally {
        competingWrite.resolve();
      }
      if (concurrent === "version") {
        await expect(writing).resolves.toMatchObject({ unchanged: true });
        expect(
          await admin().externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
        ).toMatchObject({
          result: null,
        });
        expect(await admin().event.count({ where: cardWhere })).toBe(0);
      } else {
        await expect(writing).resolves.toMatchObject({ title: "Renamed", version: 2 });
        expect(await admin().event.count({ where: cardWhere })).toBe(1);
      }
      const versions = await admin().pageVersion.findMany({
        where: { pageId: stored.id },
        orderBy: { version: "asc" },
      });
      expect(versions.map(({ title, source }) => ({ title, source }))).toEqual([
        { title: "Before", source: source("Original") },
        concurrent === "version"
          ? { title: "Before", source: source("Winner") }
          : { title: "Renamed", source: source("Next") },
      ]);
    },
  );

  it("requires a live lease for writes and taints a scoped source read without a write", async () => {
    const { context, newEffect, seed, tenant, cardWhere, state } = await setup();
    const stored = await seed("Read");
    const read = { pageId: stored.id };
    const args = { pageId: stored.id, source: source("Stale worker") };
    const ctx = context(await newEffect(args));
    await expect(
      tenant(() => savePageFromTool({ ...ctx, lease: { ...ctx.lease, fence: 0 } }, args)),
    ).rejects.toThrow();
    await expect(tenant(() => savePageFromTool(ctx, read))).resolves.toMatchObject({
      source: source("Original"),
      version: 1,
    });
    expect(state.tainted).toBe(true);
    expect(await admin().event.count({ where: cardWhere })).toBe(0);
    expect(await admin().pageVersion.count({ where: { pageId: stored.id } })).toBe(1);
  });

  it("restricts a group Page to its chat and admits another bot in that chat", async () => {
    const { actor, bot, group, context, newEffect, tenant, cardWhere } = await setup("user", true);
    const args = { title: "Group", source: source("New group page") };
    const ctx = context(await newEffect(args));
    const saved = await tenant(() => savePageFromTool(ctx, args));
    expect(saved).toMatchObject({ version: 1, title: "Group" });
    const row = await admin().page.findFirstOrThrow({ where: { botId: bot.id } });
    expect(row).toMatchObject({ groupId: group!.id, userId: actor.userId, visibility: "private" });
    const read = { pageId: row.id };
    for (const groupId of [null, "another-group"]) {
      await expect(
        tenant(() => savePageFromTool({ ...ctx, thread: { groupId } }, read)),
      ).resolves.toMatchObject({ error: expect.any(String) });
    }

    const { userId, spaceId } = actor;
    const peer = await admin().bot.create({
      data: { spaceId, userId, name: "Group peer", color: "#3EC5A8" },
    });
    await admin().chatGroupMember.createMany({
      data: [bot, peer].map(({ id }) => ({ groupId: group!.id, botId: id })),
    });
    await expect(
      tenant(() => savePageFromTool({ ...ctx, bot: peer }, read)),
    ).resolves.toMatchObject({
      pageId: row.id,
      version: 1,
      source: source("New group page"),
    });
    expect(await admin().event.count({ where: cardWhere })).toBe(1);
    const grouped = await tenant(() => listPages(client(), actor, { groupId: group!.id }));
    expect(grouped.items.map(({ id }) => id)).toEqual([row.id]);
    const personal = await tenant(() => listPages(client(), actor, { botId: bot.id }));
    expect(personal.items).toEqual([]);
  });

  it.each(["routine", "tickets"])("keeps a %s Page update silent", async (trigger) => {
    const { context, newEffect, tenant, cardWhere } = await setup(trigger);
    const args = { title: "Background", source: source("First") };
    const result = await tenant(async () => savePageFromTool(context(await newEffect(args)), args));
    expect(result).toMatchObject({ pageId: expect.any(String), version: 1 });
    if (!("pageId" in result) || !result.pageId) throw new Error("Missing saved Page");
    const update = { pageId: result.pageId, source: source("Second") };
    const effect = await newEffect(update);
    await expect(tenant(() => savePageFromTool(context(effect), update))).resolves.toMatchObject({
      version: 2,
    });
    expect(
      await admin().externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
    ).toMatchObject({ result: { cardEventSeq: null } });
    expect(await admin().event.count({ where: cardWhere })).toBe(trigger === "routine" ? 1 : 0);
  });

  it("uses literal title search for characters with SQL pattern meanings", async () => {
    const { actor, seed, tenant } = await setup();
    const percent = await seed("100% planned");
    const underscore = await seed("foo_bar");
    const backslash = await seed("path\\src");
    await seed("100 planned");
    await seed("fooxbar");
    await seed("pathsrc");
    for (const [query, wanted] of [
      ["100%", percent],
      ["foo_bar", underscore],
      ["path\\src", backslash],
    ] as const) {
      const results = await tenant(() => listPages(client(), actor, { query }));
      expect(results.items.map(({ id }) => id)).toEqual([wanted.id]);
    }
    await expect(
      tenant(() => listPages(client(), actor, { query: "a\u0000b" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a malformed cursor without passing unsupported values to PostgreSQL", async () => {
    const { actor, seed, tenant } = await setup();
    const stored = await seed("Cursor");
    const cursor = {
      id: stored.id,
      updatedAt: stored.updatedAt.toISOString(),
      pinnedAt: null,
    };
    for (const invalid of [
      { ...cursor, id: "a\u0000b" },
      { ...cursor, updatedAt: "-100000-01-02T10:00:00.000Z" },
      { ...cursor, pinnedAt: "0000-01-02T10:00:00.000Z" },
    ]) {
      const opaque = Buffer.from(JSON.stringify(invalid)).toString("base64url");
      await expect(
        tenant(() => listPages(client(), actor, { cursor: opaque })),
      ).rejects.toBeInstanceOf(PageListCursorError);
    }
  });

  it("isolates Page and version data and paginates pinned ties under the real runtime role", async () => {
    const { actor, bot, seed, tenant } = await setup();
    const stranger = await setup();
    const updatedAt = new Date("2026-01-01T12:00:00.123Z");
    const a = await seed("Report A", { id: `a-${randomUUID()}`, updatedAt });
    const b = await seed("Report B", { id: `b-${randomUUID()}`, updatedAt });
    const c = await seed("Draft", { id: `c-${randomUUID()}`, updatedAt });
    await stranger.seed("Report secret");
    const pin = () => tenant(() => pinPage(client(), actor, a.id, true));
    const pins = await Promise.all([pin(), pin()]);
    expect(pins).toEqual([pins[0], pins[0]]);
    expect(pins[0]).toMatchObject({
      currentVersion: 1,
      updatedAt: updatedAt.toISOString(),
      pinned: true,
    });
    const pinnedAt = (await admin().page.findUniqueOrThrow({ where: { id: a.id } })).pinnedAt;
    await pin();
    expect(pinnedAt).toBeInstanceOf(Date);
    expect((await admin().page.findUniqueOrThrow({ where: { id: a.id } })).pinnedAt).toEqual(
      pinnedAt,
    );

    const list = (cursor?: string) =>
      tenant(() => listPages(client(), actor, { botId: bot.id, limit: 1, cursor }));
    const first = await list();
    const second = await list(first.nextCursor!);
    const third = await list(second.nextCursor!);
    expect([first, second, third].map(({ items }) => items[0]?.id)).toEqual([a.id, c.id, b.id]);
    expect(third.nextCursor).toBeNull();
    const reports = await tenant(() => listPages(client(), actor, { query: "rEpOrT" }));
    expect(reports.items.map(({ id }) => id)).toEqual([a.id, b.id]);
    await expect(
      tenant(() => getPage(client(), actor, { pageId: a.id, version: 1 })),
    ).resolves.toMatchObject({ id: a.id, version: 1, code: "v1", visibility: "private" });
    await expect(
      tenant(() => getPage(client(), actor, { pageId: a.id, version: 2 })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      stranger.tenant(() => getPage(client(), stranger.actor, { pageId: a.id })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Even a forgotten Prisma filter cannot expose another user's Page or version.
    const foreignPages = { where: { id: a.id } };
    const foreignVersions = { where: { pageId: a.id } };
    await expect(stranger.tenant(() => client().page.count(foreignPages))).resolves.toBe(0);
    await expect(stranger.tenant(() => client().pageVersion.count(foreignVersions))).resolves.toBe(
      0,
    );
    await expect(
      runAsTenant({ ...actor, spaceId: stranger.actor.spaceId }, () =>
        client().page.count(foreignPages),
      ),
    ).resolves.toBe(0);
    const anonymous = await runtime!.pool.query("SELECT id FROM cogine_pages.pages WHERE id=$1", [
      a.id,
    ]);
    expect(anonymous.rows).toEqual([]);
    await expect(
      stranger.tenant(() => removePage(client(), stranger.actor, a.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(tenant(() => removePage(client(), actor, a.id))).resolves.toEqual({ ok: true });
    expect(await admin().pageVersion.count(foreignVersions)).toBe(0);
  });
});
