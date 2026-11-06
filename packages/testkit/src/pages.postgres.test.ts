import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { EncryptedSecretStore, LocalArtifactStore, migrateJobQueue } from "@rakazo/adapters";
import type { Actor, PageDetail, PageSummary, ThreadSnapshot } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import {
  applyRowSecurityPolicies,
  createDb,
  currentDbContext,
  deletePageShareSecrets,
  describeRowSecurityPolicies,
  migratePageRowSecurityPolicies,
  provisionRuntimeRole,
  ROW_SECURITY_POLICIES,
  rlsBypassKey,
  runAsSystem,
  runAsTenant,
  verifyRuntimeDatabase,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppHandles } from "../../../apps/api/src/app.js";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describePages = enabled ? describe.sequential : describe.skip;
const ownerUrl = process.env.DATABASE_URL!;
const suffix = randomBytes(8).toString("hex");
const login = `pages_runtime_${suffix}`;
const { Client, escapeIdentifier } = createRequire(
  new URL("../../db/package.json", import.meta.url),
)("pg") as {
  Client: new (options: {
    connectionString: string;
  }) => { host: string; port: number; database?: string };
  escapeIdentifier(value: string): string;
};
let owner: ReturnType<typeof createDb>;
let runtime: ReturnType<typeof createDb>;
let runtimeUrl: string;
let grantRole: string;
let groupOwned = false;
let loginOwned = false;
let harness: BotIntroHarness | undefined;
let handles: AppHandles | undefined;
let app: App;
let jobs: AppHandles["jobs"];
let directory: string | undefined;
let continueSpy: ReturnType<typeof vi.spyOn> | undefined;
const executions = new Map<string, Set<Promise<void>>>();
const deletedTokens: string[] = [];
const db = () => owner.prisma;
async function settleExecution(runId: string) {
  await Promise.allSettled([...(executions.get(runId) ?? [])]);
}
const page = (heading: string) =>
  `const App = () => (\n  <Page title="${heading}">\n    <Metrics metrics={[{ value: "42", label: "Users" }]} />\n  </Page>\n);\nexport default App;\n`;

const pageDefinitions = ROW_SECURITY_POLICIES.filter(
  ({ model }) => model === "Page" || model === "PageVersion",
);

async function pageTablesOff() {
  for (const { table } of pageDefinitions) {
    for (const name of [`${table}_tenant`, `${table}_system`])
      await owner.pool.query(
        `DROP POLICY IF EXISTS ${escapeIdentifier(name)} ON public.${escapeIdentifier(table)}`,
      );
    await owner.pool.query(
      `ALTER TABLE public.${escapeIdentifier(table)} DISABLE ROW LEVEL SECURITY`,
    );
  }
}
async function protectedStatus() {
  return describeRowSecurityPolicies(runtime.prisma);
}
async function pageCatalog() {
  return (
    await owner.pool.query(`SELECT c.relname AS name, c.relrowsecurity AS enabled,
    (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('pages','page_versions') ORDER BY c.relname`)
  ).rows;
}

describePages("private Pages with production row-security policies", () => {
  const stamp = Date.now();
  beforeAll(async () => {
    const target = new Client({ connectionString: ownerUrl });
    if (
      !["127.0.0.1", "localhost", "::1"].includes(target.host) ||
      target.port <= 1024 ||
      !target.database ||
      !/^integration_(0|[1-9][0-9]*)$/.test(target.database) ||
      process.env.VERIFY_ROW_SECURITY_POLICIES !== "harness_isolated" ||
      process.env.VERIFY_ROW_SECURITY_POLICIES_DATABASE !== target.database
    )
      throw new Error("Page policy tests require the explicitly isolated policy harness");
    owner = createDb(ownerUrl, { poolMax: 5 });
    expect(ROW_SECURITY_POLICIES).toHaveLength(86);
    const initial =
      await owner.pool.query(`SELECT p.polname FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`);
    expect(initial.rows).toEqual([]);
    await migrateJobQueue(ownerUrl);
    grantRole = (
      await owner.pool.query<{ role: string }>(
        "SELECT 'coginebot_app_' || oid::text AS role FROM pg_database WHERE datname=current_database()",
      )
    ).rows[0]!.role;
    groupOwned = !(await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [grantRole]))
      .rowCount;
    expect(
      (await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [login])).rowCount,
    ).toBe(0);
    loginOwned = true;
    const selected = new URL(ownerUrl);
    selected.username = login;
    selected.password = randomBytes(24).toString("hex");
    selected.searchParams.delete("user");
    selected.searchParams.delete("password");
    runtimeUrl = selected.toString();
    await provisionRuntimeRole(ownerUrl, runtimeUrl);
    runtime = createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
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
    continueSpy?.mockRestore();
    if (handles) await clean(() => handles!.stop());
    if (runtime) {
      await clean(() => runtime.prisma.$disconnect());
      await clean(() => runtime.pool.end());
    }
    if (owner) {
      for (const { table, tenantPredicate } of ROW_SECURITY_POLICIES) {
        for (const name of [...(tenantPredicate ? [`${table}_tenant`] : []), `${table}_system`])
          await clean(() =>
            owner.pool.query(
              `DROP POLICY IF EXISTS ${escapeIdentifier(name)} ON public.${escapeIdentifier(table)}`,
            ),
          );
        await clean(() =>
          owner.pool.query(
            `ALTER TABLE public.${escapeIdentifier(table)} DISABLE ROW LEVEL SECURITY`,
          ),
        );
      }
      if (loginOwned) {
        await clean(() => owner.pool.query(`DROP OWNED BY ${escapeIdentifier(login)}`));
        await clean(() => owner.pool.query(`DROP ROLE IF EXISTS ${escapeIdentifier(login)}`));
        await clean(() =>
          owner.pool.query(
            "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
            [rlsBypassKey(runtimeUrl)],
          ),
        );
      }
      if (groupOwned) {
        for (const table of [
          "_private_jobs",
          "_private_job_queues",
          "_private_tasks",
          "_private_known_crontabs",
        ])
          await clean(() =>
            owner.pool.query(
              `DROP POLICY IF EXISTS coginebot_app_queue ON graphile_worker.${escapeIdentifier(table)}`,
            ),
          );
        await clean(() => owner.pool.query(`DROP OWNED BY ${escapeIdentifier(grantRole)}`));
        await clean(() => owner.pool.query(`DROP ROLE IF EXISTS ${escapeIdentifier(grantRole)}`));
      }
      await clean(() => owner.prisma.$disconnect());
      await clean(() => owner.pool.end());
    }
    if (directory) await clean(() => rm(directory!, { recursive: true, force: true }));
    if (failures.length) throw new AggregateError(failures, "Page fixture cleanup failed");
  }, 60_000);

  it("keeps all-off installations all-off after Pages DDL", async () => {
    await migratePageRowSecurityPolicies(ownerUrl, runtimeUrl);
    expect(await pageCatalog()).toEqual([
      { name: "page_versions", enabled: false, policies: 0 },
      { name: "pages", enabled: false, policies: 0 },
    ]);
    expect(await verifyRuntimeDatabase(runtime.prisma)).toMatchObject({
      expectedTables: 86,
      connectionEnforced: false,
    });
    expect(
      (
        await owner.pool.query(`SELECT count(*)::int AS count FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`)
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("rejects partial and expected-name drift, then extends exact84 to full86", async () => {
    await owner.pool.query("CREATE POLICY pages_tenant ON public.pages USING (true)");
    try {
      await expect(migratePageRowSecurityPolicies(ownerUrl, runtimeUrl)).rejects.toThrow(
        "unprotected or fully protected",
      );
    } finally {
      await owner.pool.query("DROP POLICY pages_tenant ON public.pages");
    }
    await applyRowSecurityPolicies(ownerUrl, runtimeUrl);
    await pageTablesOff();
    await owner.pool.query("ALTER POLICY bots_tenant ON public.bots USING (true)");
    try {
      await expect(migratePageRowSecurityPolicies(ownerUrl, runtimeUrl)).rejects.toThrow(
        "unprotected or fully protected",
      );
      expect((await pageCatalog()).every((entry) => !entry.enabled && entry.policies === 0)).toBe(
        true,
      );
    } finally {
      await applyRowSecurityPolicies(ownerUrl, runtimeUrl);
    }
    await pageTablesOff();
    await migratePageRowSecurityPolicies(ownerUrl, runtimeUrl);
    expect(await protectedStatus()).toMatchObject({ expectedTables: 86, connectionEnforced: true });
  });

  it("does not replace an unknown policy while extending a protected installation", async () => {
    await pageTablesOff();
    await owner.pool.query("CREATE POLICY page_unreviewed ON public.pages USING (false)");
    try {
      await expect(migratePageRowSecurityPolicies(ownerUrl, runtimeUrl)).rejects.toThrow(
        "Unrecognized database policies",
      );
      expect((await pageCatalog()).every((entry) => !entry.enabled)).toBe(true);
      expect(
        (await owner.pool.query("SELECT polname FROM pg_policy WHERE polname='page_unreviewed'"))
          .rows,
      ).toHaveLength(1);
    } finally {
      await owner.pool.query("DROP POLICY page_unreviewed ON public.pages");
      await migratePageRowSecurityPolicies(ownerUrl, runtimeUrl);
    }
  });

  it("rolls back both Page policies if the later ENABLE fails", async () => {
    await pageTablesOff();
    const last = [...pageDefinitions].sort((a, b) => a.table.localeCompare(b.table)).at(-1)!.table;
    const fn = escapeIdentifier(`page_ddl_fail_${suffix}`);
    const trigger = escapeIdentifier(`page_ddl_fail_${suffix}`);
    await owner.pool.query(`CREATE FUNCTION public.${fn}() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE command record; BEGIN
      FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
        IF command.command_tag='ALTER TABLE' AND command.object_identity='public.${last}' THEN
          RAISE EXCEPTION 'page fixture late DDL failure';
        END IF;
      END LOOP; END; $$`);
    await owner.pool.query(
      `CREATE EVENT TRIGGER ${trigger} ON ddl_command_end EXECUTE FUNCTION public.${fn}()`,
    );
    try {
      await expect(migratePageRowSecurityPolicies(ownerUrl, runtimeUrl)).rejects.toThrow(
        "late DDL failure",
      );
    } finally {
      await owner.pool.query(`DROP EVENT TRIGGER ${trigger}`);
      await owner.pool.query(`DROP FUNCTION public.${fn}()`);
    }
    expect((await pageCatalog()).every((entry) => !entry.enabled && entry.policies === 0)).toBe(
      true,
    );
    await migratePageRowSecurityPolicies(ownerUrl, runtimeUrl);
    expect((await protectedStatus()).connectionEnforced).toBe(true);
  });

  it("performs no policy DDL on a matching full86 installation", async () => {
    const fn = escapeIdentifier(`page_no_ddl_${suffix}`);
    const trigger = escapeIdentifier(`page_no_ddl_${suffix}`);
    await owner.pool.query(`CREATE FUNCTION public.${fn}() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN IF TG_TAG IN ('ALTER TABLE','CREATE POLICY','ALTER POLICY','DROP POLICY') THEN
        RAISE EXCEPTION 'page fixture forbids redundant DDL'; END IF; END; $$`);
    await owner.pool.query(
      `CREATE EVENT TRIGGER ${trigger} ON ddl_command_start EXECUTE FUNCTION public.${fn}()`,
    );
    try {
      await migratePageRowSecurityPolicies(ownerUrl, runtimeUrl);
    } finally {
      await owner.pool.query(`DROP EVENT TRIGGER ${trigger}`);
      await owner.pool.query(`DROP FUNCTION public.${fn}()`);
    }
    expect((await protectedStatus()).connectionEnforced).toBe(true);
  });

  describe.sequential("private API and persisted save_page journeys", () => {
    beforeAll(async () => {
      // This subgroup must stay protected when only its affected journeys are selected.
      expect(await applyRowSecurityPolicies(ownerUrl, runtimeUrl)).toMatchObject({
        expectedTables: 86,
        connectionEnforced: true,
      });
      directory = await mkdtemp(path.join(tmpdir(), "private-pages-"));
      await owner.prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          signupsEnabled: true,
          signupAllowlist: "",
          signupPolicyInitialized: true,
        },
        update: { signupsEnabled: true, signupAllowlist: "", signupPolicyInitialized: true },
      });
      const { createApp } = await import("../../../apps/api/src/app.js");
      const secrets = new EncryptedSecretStore("synthetic-private-pages-key");
      const forget = secrets.delete.bind(secrets);
      vi.spyOn(secrets, "delete").mockImplementation(async (...args) => {
        deletedTokens.push(args[0]);
        return forget(...args);
      });
      handles = await createApp({
        databaseUrl: runtimeUrl,
        realtimeDatabaseUrl: runtimeUrl,
        dataDir: directory,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        wakeupDriver: "memory",
        defaultProvider: "fake",
        defaultModel: "fake",
        deploymentModelConfigured: false,
        secretStore: secrets,
        signupsEnabled: "true",
        passwordAuth: true,
      });
      app = handles.app;
      jobs = handles.jobs;
      harness = { ...handles, prisma: owner.prisma };
      const execute = handles.executor.continueRun.bind(handles.executor);
      continueSpy = vi.spyOn(handles.executor, "continueRun").mockImplementation((...args) => {
        const pending = execute(...args);
        const calls = executions.get(args[0]) ?? new Set<Promise<void>>();
        calls.add(pending);
        executions.set(args[0], calls);
        return pending;
      });
    }, 120_000);
    /**
     * Runs `during` while this test holds the page's row lock; `waitFor(n)` returns once n other
     * sessions are queued behind this transaction, directly or behind each other, so a race is
     * forced rather than left to timing. Waits elsewhere in the shared database never count.
     */
    async function holdingPageRow<T>(
      pageId: string,
      during: (
        waitFor: (count: number) => Promise<void>,
        tx: Prisma.TransactionClient,
      ) => Promise<T>,
    ): Promise<T> {
      return db().$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM pages WHERE id = ${pageId} FOR UPDATE`;
          const [held] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          const waitFor = async (count: number) => {
            for (let tries = 0; tries < 800; tries++) {
              const [row] = await db().$queryRaw<{ waiting: number }[]>`
              WITH RECURSIVE queued(pid) AS (
                SELECT pid FROM pg_stat_activity WHERE ${held!.pid}::int = ANY(pg_blocking_pids(pid))
                UNION
                SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
              )
              SELECT count(*)::int AS waiting FROM queued`;
              if ((row?.waiting ?? 0) >= count) return;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error(`${count} writers never queued behind the held page row`);
          };
          return during(waitFor, tx);
        },
        { timeout: 30_000 },
      );
    }
    const lastResult = async (botId: string) => {
      const effect = await db().externalEffect.findFirst({
        where: { kind: "save_page", run: { botId } },
        orderBy: { createdAt: "desc" },
        select: { result: true },
      });
      return effect?.result as Record<string, unknown> | undefined;
    };
    it("requires both the PageVersion parent's user and Space, including writes and forged bypass flags", async () => {
      const cookie = await signup(app, `pages-parent-${stamp}@example.test`, "Page parent");
      const own = await rpc<Actor>(app, cookie, "me");
      const memberCookie = await signup(app, `pages-member-${stamp}@example.test`, "Page member");
      const member = await rpc<Actor>(app, memberCookie, "me");
      const space = await db().space.findUniqueOrThrow({ where: { id: own.spaceId } });
      await db().member.create({
        data: {
          id: `pages-member-${suffix}`,
          userId: member.userId,
          organizationId: space.organizationId,
          role: "member",
          createdAt: new Date(),
        },
      });
      expect(
        await db().spaceMember.count({ where: { spaceId: own.spaceId, userId: member.userId } }),
      ).toBe(1);
      const otherSpace = await rpc<{ id: string }>(app, cookie, "spaces/create", {
        name: "Another Space",
      });
      const created = await db().page.create({
        data: {
          userId: own.userId,
          spaceId: own.spaceId,
          title: "Only mine",
          versions: {
            create: { version: 1, title: "Only mine", source: page("Mine"), code: "/* saved */" },
          },
        },
        include: { versions: true },
      });
      const version = created.versions[0]!;
      const foreign = await db().page.create({
        data: {
          userId: member.userId,
          spaceId: own.spaceId,
          title: "Member only",
          versions: {
            create: {
              version: 1,
              title: "Member only",
              source: page("Member"),
              code: "/* member */",
            },
          },
        },
      });
      const identities = [
        { ...own, userId: member.userId },
        { ...own, spaceId: otherSpace.id },
      ];
      for (const identity of identities) {
        await runAsTenant(identity, async () => {
          expect(
            await runtime.prisma.pageVersion.findUnique({
              where: { pageId_version: { pageId: created.id, version: 1 } },
            }),
          ).toBeNull();
          expect(
            await runtime.prisma.pageVersion.findMany({ where: { pageId: created.id } }),
          ).toEqual([]);
          await expect(
            runtime.prisma.pageVersion.create({
              data: {
                pageId: created.id,
                version: 2,
                title: "Taken",
                source: "canary",
                code: "canary",
              },
            }),
          ).rejects.toThrow();
        });
      }
      await runAsTenant(own, async () => {
        expect(
          await runtime.prisma.pageVersion.findUnique({
            where: { pageId_version: { pageId: created.id, version: 1 } },
          }),
        ).toMatchObject({ id: version.id });
        await expect(
          runtime.prisma.pageVersion.update({
            where: { id: version.id },
            data: { pageId: foreign.id },
          }),
        ).rejects.toThrow();
        await runtime.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.rls_bypass','on',true), set_config('app.rls_bypass_key','forged',true)`;
          expect(await tx.pageVersion.count({ where: { pageId: created.id } })).toBe(1);
          expect(await tx.page.count({ where: { userId: member.userId } })).toBe(0);
          expect(await tx.pageVersion.count({ where: { pageId: foreign.id } })).toBe(0);
        });
        expect(currentDbContext()).toMatchObject({
          kind: "tenant",
          userId: own.userId,
          spaceId: own.spaceId,
        });
      });
      for (const [as, selectedSpace, userId, expectedPageIds] of [
        [memberCookie, own.spaceId, member.userId, [foreign.id]],
        [cookie, otherSpace.id, own.userId, []],
      ] as const) {
        expect(await rpc<Actor>(app, as, "me", {}, selectedSpace)).toMatchObject({
          userId,
          spaceId: selectedSpace,
        });
        const library = await rpc<{ items: PageSummary[]; nextCursor: string | null }>(
          app,
          as,
          "pages/list",
          {},
          selectedSpace,
        );
        expect(library.items.map((item) => item.id)).toEqual(expectedPageIds);
        expect(library.nextCursor).toBeNull();
        for (const [method, input] of [
          ["pages/get", { pageId: created.id }],
          ["pages/rename", { pageId: created.id, title: "Taken" }],
          ["pages/pin", { pageId: created.id, pinned: true }],
          ["pages/remove", { pageId: created.id }],
        ] as const)
          expect((await raw(app, as!, method, input, selectedSpace)).status).toBeGreaterThanOrEqual(
            400,
          );
      }
      expect(await db().pageVersion.count({ where: { pageId: created.id } })).toBe(1);
      await expect(
        runAsSystem("verify Page parent fixture", () =>
          runtime.prisma.pageVersion.findUnique({
            where: { pageId_version: { pageId: created.id, version: 1 } },
          }),
        ),
      ).resolves.toMatchObject({ id: version.id });
    });

    it("lists, renames, pins and deletes private pages while keeping sharing unavailable", async () => {
      const cookie = await signup(app, `pages-library-${stamp}@example.test`, "Library");
      const bot = await createBot(app, cookie, "Librarian");
      const ids: string[] = [];
      for (const title of ["Oldest", "Middle", "Newest"]) {
        await sendAndWait(app, cookie, bot.id, {
          text: `call save_page with ${JSON.stringify({ title, source: page(title) })}`,
        });
        ids.push((await lastResult(bot.id))!.pageId as string);
      }
      const [oldest, middle] = ids;
      await rpc(app, cookie, "pages/pin", { pageId: oldest, pinned: true });
      const first = await rpc<{ items: PageSummary[]; nextCursor: string }>(
        app,
        cookie,
        "pages/list",
        { botId: bot.id, limit: 2 },
      );
      expect(first.items.map((item) => item.title)).toEqual(["Oldest", "Newest"]);
      expect(first.items.every((item) => item.visibility === "private")).toBe(true);
      const rest = await rpc<{ items: PageSummary[]; nextCursor: null }>(
        app,
        cookie,
        "pages/list",
        { botId: bot.id, limit: 2, cursor: first.nextCursor },
      );
      expect(rest.items.map((item) => item.title)).toEqual(["Middle"]);
      expect(rest.nextCursor).toBeNull();
      expect(
        await rpc(app, cookie, "pages/rename", { pageId: middle, title: "Q3\nplan" }),
      ).toMatchObject({ title: "Q3 plan" });
      expect(await rpc(app, cookie, "pages/get", { pageId: middle })).toMatchObject({
        shareUrl: null,
      });
      expect(
        (await raw(app, cookie, "pages/setVisibility", { pageId: middle, visibility: "link" }))
          .status,
      ).toBeGreaterThanOrEqual(400);
      expect((await app.request(`/api/v1/pages/shared/${"x".repeat(43)}`)).status).toBe(404);
      const deleting = await holdingPageRow(middle!, async (waitFor) => {
        const firstDelete = raw(app, cookie, "pages/remove", { pageId: middle });
        await waitFor(1);
        const secondDelete = raw(app, cookie, "pages/remove", { pageId: middle });
        await waitFor(2);
        return [firstDelete, secondDelete];
      });
      const statuses = (await Promise.all(deleting)).map((response) => response.status);
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses.filter((status) => status >= 400)).toHaveLength(1);
      expect(await db().pageVersion.count({ where: { pageId: middle } })).toBe(0);
    });

    it("saves, edits and guards pages through the bot's save_page", async () => {
      const cookie = await signup(app, `pages-${stamp}@rakazo.test`, "Page Owner");
      const bot = await createBot(app, cookie, "Reporter");
      const save = (args: unknown, botId = bot.id, as = cookie) =>
        sendAndWait(app, as, botId, { text: `call save_page with ${JSON.stringify(args)}` });

      await save({ help: true });
      expect((await lastResult(bot.id))?.guide).toContain("export default");

      // A page that fails the kit check is never stored; the bot gets line-numbered problems.
      await save({ title: "Broken", source: "const App = () => <Card />;\nexport default App;\n" });
      expect((await lastResult(bot.id))?.problems).toEqual([
        expect.stringMatching(/^line 1: <Card> is not a kit component/),
      ]);
      expect(await db().page.count({ where: { userId: (await me(app, cookie)).id } })).toBe(0);

      await save({ title: "Weekly KPIs", source: page("First") });
      const created = (await lastResult(bot.id)) as { pageId: string; version: number };
      expect(created).toMatchObject({ version: 1, title: "Weekly KPIs" });
      const { pageId } = created;

      // Edits apply together into one version, or not at all.
      await save({
        pageId,
        edits: [
          { find: 'title="First"', replace: 'title="Second"' },
          { find: 'value: "42"', replace: 'value: "43"' },
        ],
      });
      expect(await lastResult(bot.id)).toEqual({
        pageId,
        version: 2,
        title: "Weekly KPIs",
        mention: `Mention it in your reply as [Weekly KPIs](page:${pageId})`,
      });
      await save({
        pageId,
        edits: [
          { find: 'title="Second"', replace: 'title="Third"' },
          { find: "Page", replace: "Sheet" },
        ],
      });
      expect(await lastResult(bot.id)).toMatchObject({
        error: expect.stringMatching(/^Edit 2: find text occurs more than once/),
      });
      await save({ pageId, edits: [{ find: "not in the page", replace: "x" }] });
      expect(await lastResult(bot.id)).toMatchObject({ error: expect.stringMatching(/^Edit 1: /) });
      // Edits whose result fails the kit check write nothing either.
      await save({ pageId, edits: [{ find: "<Metrics", replace: "<Card" }] });
      expect((await lastResult(bot.id))?.problems).toBeDefined();

      // A later save may rename the page.
      await save({ pageId, title: "KPIs", source: page("Fourth") });
      expect(await lastResult(bot.id)).toEqual({
        pageId,
        version: 3,
        title: "KPIs",
        mention: `Mention it in your reply as [KPIs](page:${pageId})`,
      });
      // A page that saves but has a likely mistake carries the kit's warnings back to the bot.
      const helper = await createBot(app, cookie, "Helper");
      const scratch = `const note = "Q&amp;A";\n${page("Scratch")}`;
      await save({ title: "Scratch [draft]", source: scratch }, helper.id);
      const scratchResult = await lastResult(helper.id);
      expect(scratchResult?.mention).toBe(
        `Mention it in your reply as [Scratch \\[draft\\]](page:${scratchResult?.pageId})`,
      );
      expect(scratchResult).toMatchObject({
        version: 1,
        warnings: [expect.stringMatching(/^line 1: &amp;/)],
      });
      await save({ pageId });
      expect(await lastResult(bot.id)).toMatchObject({ version: 3, source: page("Fourth") });

      // Another account cannot read or write it by id.
      const otherCookie = await signup(app, `pages-other-${stamp}@rakazo.test`, "Other");
      const intruder = await createBot(app, otherCookie, "Intruder");
      await save({ pageId, source: page("Stolen") }, intruder.id, otherCookie);
      expect(await lastResult(intruder.id)).toMatchObject({ error: expect.any(String) });
      await save({ pageId }, intruder.id, otherCookie);
      expect(await lastResult(intruder.id)).not.toHaveProperty("source");

      // Every save is kept as its own version.
      expect(
        (
          await db().pageVersion.findMany({
            where: { pageId },
            orderBy: { version: "desc" },
            select: { version: true, title: true },
          })
        ).map((v) => [v.version, v.title]),
      ).toEqual([
        [3, "KPIs"],
        [2, "Weekly KPIs"],
        [1, "Weekly KPIs"],
      ]);
      const second = await rpc<PageDetail>(app, cookie, "pages/get", { pageId, version: 2 });
      // Read back compiled for the viewer.
      expect(second.code).toMatch(/React\.createElement\(Page, \{ title: "Second".*"43"/s);
      expect(second).toMatchObject({ version: 2, currentVersion: 3, title: "KPIs", botId: bot.id });

      // Each save posted a page block in the chat it was saved from, never a file.
      const blocks = async (botId: string) =>
        (await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId })).messages.flatMap(
          (message) => message.blocks.filter((b) => b.kind === "page" || b.kind === "file"),
        );
      expect(await blocks(bot.id)).toEqual([
        { kind: "page", pageId, version: 1, title: "Weekly KPIs" },
        { kind: "page", pageId, version: 2, title: "Weekly KPIs" },
        { kind: "page", pageId, version: 3, title: "KPIs" },
      ]);
      expect(await blocks(helper.id)).toEqual([
        { kind: "page", pageId: expect.any(String), version: 1, title: "Scratch [draft]" },
      ]);
      expect(await rpc(app, cookie, "artifacts/listSpace", {})).toMatchObject({ items: [] });

      // A message sent from the open page replies to its card: the bot reads the page's id and
      // version, never just its title as a quote.
      const cardMessage = (
        await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId: bot.id })
      ).messages.find((message) => message.blocks.some((block) => block.kind === "page"))!;
      await rpc(app, cookie, "threads/send", {
        botId: bot.id,
        text: "make the numbers bigger",
        replyToMessageId: cardMessage.id,
        fromPage: true,
      });
      // A reply picked on the card in the chat quotes it as any reply does.
      await rpc(app, cookie, "threads/send", {
        botId: bot.id,
        text: "what is this?",
        replyToMessageId: cardMessage.id,
      });
      const replies = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId: bot.id });
      const sent = (text: string) =>
        replies.messages.find((message) =>
          message.blocks.some((block) => block.kind === "text" && block.text === text),
        );
      expect(sent("make the numbers bigger")).toMatchObject({ replyPreview: { page: true } });
      expect(sent("make the numbers bigger")?.replyQuote).toBeUndefined();
      expect(sent("what is this?")).toMatchObject({
        replyPreview: { page: true },
        replyQuote: expect.stringContaining("KPIs"),
      });
    });

    it("keeps a page to the bot that made it, in any of its chats, and to its group", async () => {
      const cookie = await signup(app, `pages-scope-${stamp}@rakazo.test`, "Scope Owner");
      const maker = await createBot(app, cookie, "Maker");
      const other = await createBot(app, cookie, "Other");
      const save = (botId: string, args: unknown) =>
        sendAndWait(app, cookie, botId, { text: `call save_page with ${JSON.stringify(args)}` });
      await save(maker.id, { title: "Private plan", source: page("Mine") });
      const { pageId } = (await lastResult(maker.id)) as { pageId: string };
      const group = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
        name: "Desk",
        botIds: [maker.id, other.id],
      });
      const inGroup = async (bot: { id: string }, name: string, args: unknown) => {
        const before = await db().run.count({ where: { threadId: group.threadId, botId: bot.id } });
        await rpc(app, cookie, "threads/send", {
          groupId: group.id,
          text: `@${name} call save_page with ${JSON.stringify(args)}`,
          mentions: [{ kind: "bot", id: bot.id }],
        });
        await expect
          .poll(
            () =>
              db().run.count({
                where: {
                  threadId: group.threadId,
                  botId: bot.id,
                  status: { in: ["completed", "failed", "cancelled"] },
                },
              }),
            { timeout: 20_000, interval: 100 },
          )
          .toBe(before + 1);
        const terminal = await db().run.findFirstOrThrow({
          where: { threadId: group.threadId, botId: bot.id },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        await settleExecution(terminal.id);
        return lastResult(bot.id);
      };

      // Another bot of the same user is told the page does not exist, as for a made-up id, and
      // gets neither its source nor a new version in.
      await save(other.id, { pageId: "no-such-page" });
      const notFound = await lastResult(other.id);
      expect(notFound).toEqual({ error: expect.any(String) });
      await save(other.id, { pageId });
      expect(await lastResult(other.id)).toEqual(notFound);
      await save(other.id, { pageId, source: page("Stolen") });
      expect(await lastResult(other.id)).toEqual(notFound);
      expect(await inGroup(other, "Other", { pageId })).toEqual(notFound);

      // The bot that made it reaches it from another of its chats.
      expect(await inGroup(maker, "Maker", { pageId })).toMatchObject({
        version: 1,
        source: page("Mine"),
      });
      expect(
        await inGroup(maker, "Maker", { pageId, edits: [{ find: "Mine", replace: "Ours" }] }),
      ).toMatchObject({ pageId, version: 2 });

      // A page made in the group is the group's: its other bots reach it there, but not outside.
      const made = await inGroup(maker, "Maker", { title: "Group plan", source: page("Desk") });
      const groupPageId = made!.pageId as string;
      expect(await inGroup(other, "Other", { pageId: groupPageId })).toMatchObject({
        version: 1,
        source: page("Desk"),
      });
      await save(other.id, { pageId: groupPageId });
      expect(await lastResult(other.id)).toEqual(notFound);
      expect(await db().pageVersion.count({ where: { pageId } })).toBe(2);
    });

    it("shows a routine's new page once and refreshes it each run without a new card", async () => {
      const cookie = await signup(app, `pages-routine-${stamp}@rakazo.test`, "Routine Owner");
      const bot = await createBot(app, cookie, "Refresher");
      const clock = new Date();
      const hour = (clock.getUTCHours() + 6) % 24;
      const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
        botId: bot.id,
        name: "Hourly board",
        prompt: `call save_page with ${JSON.stringify({ title: "Hourly board", source: page("v1") })}`,
        crons: [`${clock.getUTCMinutes()} ${hour} * * *`],
        timezone: "UTC",
        notify: true,
        active: true,
      });
      const fired = new Set<string>();
      const fire = async () => {
        const dueAt = new Date(Date.now() - 1_000);
        await db().routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
        await jobs.enqueue({
          name: "routine.wakeup",
          payload: { routineId: routine.id, scheduledFor: dueAt.toISOString() },
        });
        for (let tries = 0; tries < 200; tries++) {
          const run = await db().run.findFirst({
            where: { routineId: routine.id, status: { in: ["completed", "failed", "cancelled"] } },
            orderBy: { createdAt: "desc" },
            select: { id: true, status: true },
          });
          if (run && !fired.has(run.id)) {
            fired.add(run.id);
            expect(run.status).toBe("completed");
            return db().message.findMany({ where: { runId: run.id }, select: { blocks: true } });
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("the routine never ran");
      };

      // The first save is news: the page's card arrives in the chat.
      const first = await fire();
      expect(JSON.stringify(first)).toContain('"kind":"page"');
      const { pageId } = (await lastResult(bot.id)) as { pageId: string };

      // Later runs edit it in place; one with nothing to report stays silent.
      await db().routine.update({
        where: { id: routine.id },
        data: {
          prompt: `call save_page with ${JSON.stringify({ pageId, edits: [{ find: 'title="v1"', replace: 'title="v2"' }] })}\nthen say NO_RESPONSE`,
        },
      });
      expect(await fire()).toEqual([]);
      expect(await lastResult(bot.id)).toMatchObject({ pageId, version: 2 });
      expect(
        await db().pageVersion.findFirst({
          where: { pageId, version: 2 },
          select: { source: true },
        }),
      ).toMatchObject({ source: expect.stringContaining('title="v2"') });
    });

    it("hands cleanup the link a swap commits while its pages' links are being deleted", async () => {
      const cookie = await signup(app, `pages-swap-delete-${stamp}@rakazo.test`, "Swap Owner");
      const owner = await rpc<{ userId: string; spaceId: string }>(app, cookie, "me");
      const sealed = (ciphertext: string) =>
        db().secret.create({
          data: { userId: owner.userId, spaceId: owner.spaceId, kind: "page_share", ciphertext },
        });
      const first = await sealed("sealed-first");
      const { id: pageId } = await db().page.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          title: "Swapped",
          visibility: "link",
          shareTokenHash: "first-hash",
          shareSecretId: first.id,
          versions: {
            create: {
              version: 1,
              title: "Swapped",
              source: page("S"),
              code: `/* stored ${"S"} */`,
            },
          },
        },
      });
      // A swap has moved the page to a new secret but not committed when the delete starts.
      const { deleting, nextId } = await holdingPageRow(pageId, async (waitFor, tx) => {
        const next = await tx.secret.create({
          data: {
            userId: owner.userId,
            spaceId: owner.spaceId,
            kind: "page_share",
            ciphertext: "sealed-next",
          },
        });
        await tx.page.update({
          where: { id: pageId },
          data: { shareSecretId: next.id, shareTokenHash: "next-hash" },
        });
        const deleting = db().$transaction((other) =>
          deletePageShareSecrets(other, { id: pageId }),
        );
        await waitFor(1);
        await tx.secret.delete({ where: { id: first.id } });
        return { deleting, nextId: next.id };
      });
      expect((await deleting).map((secret) => secret.ciphertext)).toEqual(["sealed-next"]);
      expect(await db().secret.count({ where: { id: { in: [first.id, nextId] } } })).toBe(0);
      expect(await db().page.findUniqueOrThrow({ where: { id: pageId } })).toMatchObject({
        visibility: "private",
        shareTokenHash: null,
        shareSecretId: null,
      });
    });

    it("deletes a group's Page versions and sealed token rows before cascading, then cleans remote material", async () => {
      const cookie = await signup(app, `pages-group-gone-${stamp}@example.test`, "Group owner");
      const identity = await rpc<Actor>(app, cookie, "me");
      const first = await createBot(app, cookie, "First");
      const second = await createBot(app, cookie, "Second");
      const group = await rpc<{ id: string }>(app, cookie, "groups/create", {
        name: "Page group",
        botIds: [first.id, second.id],
      });
      const ciphertext = `sealed-group-${suffix}`;
      const token = await db().secret.create({
        data: {
          userId: identity.userId,
          spaceId: identity.spaceId,
          kind: "page_share",
          ciphertext,
        },
      });
      const stored = await db().page.create({
        data: {
          userId: identity.userId,
          spaceId: identity.spaceId,
          botId: first.id,
          groupId: group.id,
          title: "Group page",
          visibility: "link",
          shareTokenHash: `group-${suffix}`,
          shareSecretId: token.id,
          versions: {
            create: {
              version: 1,
              title: "Group page",
              source: page("Group"),
              code: "/* stored */",
            },
          },
        },
      });
      const artifactKey = `page-cleanup-artifact-${suffix}`;
      await db().artifact.create({
        data: {
          spaceId: identity.spaceId,
          userId: identity.userId,
          botId: first.id,
          groupId: group.id,
          name: "Cleanup fixture",
          mimeType: "text/plain",
          size: 0,
          hash: "0".repeat(64),
          storageKey: artifactKey,
        },
      });
      const originalRemove = LocalArtifactStore.prototype.remove;
      const atArtifactRemoval: Array<{ pages: number; secrets: number; deletes: number }> = [];
      const removal = vi
        .spyOn(LocalArtifactStore.prototype, "remove")
        .mockImplementation(async function (this: LocalArtifactStore, key, context) {
          if (key !== artifactKey) return originalRemove.call(this, key, context);
          atArtifactRemoval.push({
            pages: await db().page.count({ where: { id: stored.id } }),
            secrets: await db().secret.count({ where: { id: token.id } }),
            deletes: deletedTokens.filter((ref) => ref === ciphertext).length,
          });
          throw new Error("Synthetic artifact cleanup failure after committed group deletion");
        });
      try {
        await rpc(app, cookie, "groups/remove", { groupId: group.id });
      } finally {
        removal.mockRestore();
      }
      expect(atArtifactRemoval).toEqual([{ pages: 0, secrets: 0, deletes: 1 }]);
      expect(await db().page.count({ where: { id: stored.id } })).toBe(0);
      expect(await db().pageVersion.count({ where: { pageId: stored.id } })).toBe(0);
      expect(await db().secret.count({ where: { id: token.id } })).toBe(0);
      expect(deletedTokens.filter((ref) => ref === ciphertext)).toHaveLength(1);
    });

    it("cleans Page tokens once and preserves an alias reference in a foreign account", async () => {
      const cookie = await signup(app, `pages-token-a-${stamp}@example.test`, "Token owner");
      const own = await rpc<Actor>(app, cookie, "me");
      const otherCookie = await signup(app, `pages-token-b-${stamp}@example.test`, "Alias owner");
      const other = await rpc<Actor>(app, otherCookie, "me");
      const onceRef = `sealed-page-once-${suffix}`;
      const single = await sealedPage(own, onceRef);
      await rpc(app, cookie, "pages/remove", { pageId: single.id });
      expect(await db().secret.count({ where: { id: single.shareSecretId! } })).toBe(0);
      expect(deletedTokens.filter((ref) => ref === onceRef)).toHaveLength(1);
      const sharedRef = `sealed-page-alias-${suffix}`;
      const first = await sealedPage(own, sharedRef);
      const alias = await sealedPage(other, sharedRef);
      await rpc(app, cookie, "pages/remove", { pageId: first.id });
      expect(await db().secret.count({ where: { id: alias.shareSecretId! } })).toBe(1);
      expect(deletedTokens.filter((ref) => ref === sharedRef)).toHaveLength(0);
      await rpc(app, otherCookie, "pages/remove", { pageId: alias.id });
      expect(
        await db().pageVersion.count({ where: { pageId: { in: [first.id, alias.id] } } }),
      ).toBe(0);
      expect(deletedTokens.filter((ref) => ref === sharedRef)).toHaveLength(1);
    });

    it("cleans a deleted bot's own Page tokens once and retains its surviving group's Page", async () => {
      const cookie = await signup(app, `pages-bot-cleanup-${stamp}@example.test`, "Bot cleanup");
      const identity = await rpc<Actor>(app, cookie, "me");
      const first = await createBot(app, cookie, "Leaving");
      const second = await createBot(app, cookie, "Staying");
      const third = await createBot(app, cookie, "Also staying");
      const group = await rpc<{ id: string }>(app, cookie, "groups/create", {
        name: "Surviving group",
        botIds: [first.id, second.id, third.id],
      });
      const ownRef = `sealed-bot-own-${suffix}`;
      const groupRef = `sealed-bot-group-${suffix}`;
      const own = await sealedPage(identity, ownRef, { botId: first.id });
      const kept = await sealedPage(identity, groupRef, { botId: first.id, groupId: group.id });
      await rpc(app, cookie, "bots/remove", { botId: first.id, deleteMemories: true });
      expect(await db().page.count({ where: { id: own.id } })).toBe(0);
      expect(await db().pageVersion.count({ where: { pageId: own.id } })).toBe(0);
      expect(await db().secret.count({ where: { id: own.shareSecretId! } })).toBe(0);
      expect(deletedTokens.filter((ref) => ref === ownRef)).toHaveLength(1);
      expect(await db().page.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({
        botId: null,
        groupId: group.id,
      });
      expect(await db().secret.count({ where: { id: kept.shareSecretId! } })).toBe(1);
      expect(deletedTokens.filter((ref) => ref === groupRef)).toHaveLength(0);
      await rpc(app, cookie, "groups/remove", { groupId: group.id });
      expect(deletedTokens.filter((ref) => ref === groupRef)).toHaveLength(1);
    });

    it("cleans an account's cascaded Page token exactly once through the real auth endpoint", async () => {
      const cookie = await signup(
        app,
        `pages-account-cleanup-${stamp}@example.test`,
        "Account cleanup",
      );
      const identity = await rpc<Actor>(app, cookie, "me");
      const ciphertext = `sealed-account-page-${suffix}`;
      const stored = await sealedPage(identity, ciphertext);
      const response = await app.request("/api/auth/delete-user", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ password: "test-password-123" }),
      });
      expect(response.status).toBe(200);
      expect(await db().page.count({ where: { id: stored.id } })).toBe(0);
      expect(await db().pageVersion.count({ where: { pageId: stored.id } })).toBe(0);
      expect(await db().secret.count({ where: { id: stored.shareSecretId! } })).toBe(0);
      expect(deletedTokens.filter((ref) => ref === ciphertext)).toHaveLength(1);
    });

    it("lets only one of two saves built on the same version through", async () => {
      const cookie = await signup(app, `pages-save-race-${stamp}@rakazo.test`, "Save Racer");
      const first = await createBot(app, cookie, "First");
      const second = await createBot(app, cookie, "Second");
      await sendAndWait(app, cookie, first.id, {
        text: `call save_page with ${JSON.stringify({ title: "Race", source: page("One") })}`,
      });
      const pageId = (await lastResult(first.id))!.pageId as string;
      // A page of both bots' group: its maker saves from its own chat, the other in the group.
      const group = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
        name: "Racers",
        botIds: [first.id, second.id],
      });
      await db().page.update({ where: { id: pageId }, data: { groupId: group.id } });
      const saveText = (heading: string) =>
        `call save_page with ${JSON.stringify({ pageId, source: page(heading) })}`;
      // Hold the page row until both saves have read version 1 and wait to write.
      await holdingPageRow(pageId, async (waitFor) => {
        await Promise.all([
          rpc(app, cookie, "threads/send", { botId: first.id, text: saveText("Two") }),
          rpc(app, cookie, "threads/send", {
            groupId: group.id,
            text: `@Second ${saveText("Three")}`,
            mentions: [{ kind: "bot", id: second.id }],
          }),
        ]);
        await waitFor(2);
      });
      await sendAndWait(app, cookie, first.id, { text: "hello" });
      await expect
        .poll(
          () =>
            db().run.count({
              where: {
                threadId: group.threadId,
                status: { in: ["completed", "failed", "cancelled"] },
              },
            }),
          { timeout: 20_000, interval: 100 },
        )
        .toBe(1);
      const results = await db().externalEffect.findMany({
        where: { kind: "save_page", run: { botId: { in: [first.id, second.id] } } },
        orderBy: { createdAt: "asc" },
        select: { result: true },
      });
      const outcomes = results.slice(1).map((effect) => effect.result as Record<string, unknown>);
      expect(outcomes).toHaveLength(2);
      expect(outcomes.filter((result) => result.version === 2)).toHaveLength(1);
      expect(outcomes.filter((result) => result.unchanged === true)).toEqual([
        { error: "The page changed while saving; read it again and retry.", unchanged: true },
      ]);
      expect(await db().pageVersion.count({ where: { pageId } })).toBe(2);
    });

    it("keeps a rename that lands while a bot's untitled save is in flight", async () => {
      const cookie = await signup(app, `pages-rename-race-${stamp}@rakazo.test`, "Rename Racer");
      const bot = await createBot(app, cookie, "Builder");
      await sendAndWait(app, cookie, bot.id, {
        text: `call save_page with ${JSON.stringify({ title: "Q3 plan", source: page("One") })}`,
      });
      const pageId = (await lastResult(bot.id))!.pageId as string;
      const edits = [{ find: 'title="One"', replace: 'title="Two"' }];
      // The save has read the page and waits to write; the user's rename commits first.
      await holdingPageRow(pageId, async (waitFor, tx) => {
        await rpc(app, cookie, "threads/send", {
          botId: bot.id,
          text: `call save_page with ${JSON.stringify({ pageId, edits })}`,
        });
        await waitFor(1);
        await tx.page.update({ where: { id: pageId }, data: { title: "Budget" } });
      });
      await sendAndWait(app, cookie, bot.id, { text: "hello" });
      expect(await lastResult(bot.id)).toMatchObject({ version: 2, title: "Budget" });
      const stored = await db().page.findUniqueOrThrow({
        where: { id: pageId },
        select: { title: true, versions: { where: { version: 2 }, select: { title: true } } },
      });
      expect(stored.title).toBe("Budget");
      expect(stored.versions).toEqual([{ title: "Budget" }]);
    });

    it("pages through pinned then unpinned pages one at a time with no gap or repeat, and finds titles", async () => {
      const cookie = await signup(app, `pages-walk-${stamp}@rakazo.test`, "Walker");
      const owner = await rpc<{ userId: string; spaceId: string }>(app, cookie, "me");
      const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute));
      const made = async (title: string, updatedAt: Date, pinnedAt: Date | null) =>
        (
          await db().page.create({
            data: {
              spaceId: owner.spaceId,
              userId: owner.userId,
              title,
              updatedAt,
              pinnedAt,
              versions: {
                create: { version: 1, title, source: page(title), code: `/* stored ${title} */` },
              },
            },
          })
        ).id;
      // Two pinned, then three unpinned of which two share one updatedAt.
      const order = [
        await made("Pinned later", at(1), at(9)),
        await made("Pinned first", at(8), at(5)),
        await made("Newest", at(7), null),
      ];
      const tied = [await made("Tie A", at(3), null), await made("Tie B", at(3), null)];
      order.push(...tied.sort().reverse(), await made("Zeta oldest", at(2), null));

      const walked: string[] = [];
      let cursor: string | null = null;
      do {
        const step: { items: { id: string }[]; nextCursor: string | null } = await rpc(
          app,
          cookie,
          "pages/list",
          { limit: 1, ...(cursor ? { cursor } : {}) },
        );
        walked.push(...step.items.map((item) => item.id));
        cursor = step.nextCursor;
      } while (cursor && walked.length < 20);
      expect(walked).toEqual(order);

      const found = await rpc<{ items: { title: string }[] }>(app, cookie, "pages/list", {
        query: "zETA",
      });
      expect(found.items.map((item) => item.title)).toEqual(["Zeta oldest"]);
    });
  });
});

/** Opaque historical refs exercise cleanup ownership, not token issuance or public sharing. */
async function sealedPage(
  actor: Actor,
  ciphertext: string,
  scope: { botId?: string; groupId?: string } = {},
) {
  const secret = await db().secret.create({
    data: { userId: actor.userId, spaceId: actor.spaceId, kind: "page_share", ciphertext },
  });
  return db().page.create({
    data: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      ...scope,
      title: "Cleanup fixture",
      visibility: "link",
      shareTokenHash: randomBytes(32).toString("hex"),
      shareSecretId: secret.id,
      versions: {
        create: {
          version: 1,
          title: "Cleanup fixture",
          source: page("Cleanup"),
          code: "/* stored */",
        },
      },
    },
  });
}

async function createBot(app: App, cookie: string, name: string) {
  return rpc<{ id: string }>(app, cookie, "bots/create", {
    name,
    title: name,
    description: "tests pages",
    instructions: "",
    notifyOnFinish: true,
  });
}

async function me(app: App, cookie: string) {
  const response = await app.request("/api/auth/get-session", { headers: { cookie } });
  return ((await response.json()) as { user: { id: string } }).user;
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(
  app: App,
  cookie: string,
  proc: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const res = await raw(app, cookie, proc, body, spaceId);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  const result = await discardBotIntroFromCreate(harness, cookie, proc, parsed.json as T);
  if (proc === "bots/create")
    await Promise.allSettled([...executions.values()].flatMap((pending) => [...pending]));
  return result;
}

async function raw(app: App, cookie: string, proc: string, body: unknown, spaceId?: string) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
    body: JSON.stringify({ json: body }),
  });
}

async function sendAndWait(
  app: App,
  cookie: string,
  botId: string,
  input: { text: string },
  spaceId?: string,
) {
  const sent = await rpc<{ runId: string }>(
    app,
    cookie,
    "threads/send",
    { botId, ...input },
    spaceId,
  );
  await vi.waitFor(
    async () => {
      const run = await db().run.findUniqueOrThrow({
        where: { id: sent.runId },
        select: { status: true },
      });
      expect(["completed", "failed", "cancelled"]).toContain(run.status);
    },
    { timeout: 20_000, interval: 25 },
  );
  await settleExecution(sent.runId);
}
