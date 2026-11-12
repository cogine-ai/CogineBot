import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  applyRowSecurityPolicies,
  createDb,
  provisionRuntimeRole,
  ROW_SECURITY_POLICIES,
  rlsBypassKey,
  runAsTenant,
  scramSha256Verifier,
  verifyRuntimeDatabase,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ownerUrl = process.env.DATABASE_URL;
const postgres =
  process.env.VERIFY_DATABASE === "1" &&
  process.env.VERIFY_ROW_SECURITY_POLICIES === "harness_isolated" &&
  ownerUrl
    ? describe.sequential
    : describe.skip;
const migration = "20261108000000_private_pages";
const shareMigration = "20261108010000_page_share_links";
const shareRevisionMigration = "20261108090000_page_share_revision";
const databasePackage = new URL("../../db/", import.meta.url);
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

function prismaCommand(...args: string[]) {
  return new Promise<{ code: number | string; output: string }>((resolve) => {
    execFile(
      "pnpm",
      ["exec", "prisma", "migrate", ...args],
      {
        cwd: fileURLToPath(databasePackage),
        env: { ...process.env, DATABASE_URL: ownerUrl, DATABASE_MIGRATION_URL: ownerUrl },
        timeout: 50_000,
        maxBuffer: 256 * 1024,
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: stdout + stderr }),
    );
  });
}

postgres("private Pages migration (isolated PostgreSQL)", () => {
  const suffix = randomBytes(8).toString("hex");
  const login = `pages_migration_${suffix}`;
  const pageDefinitions = ROW_SECURITY_POLICIES.filter(({ model }) =>
    ["Page", "PageVersion"].includes(model),
  );
  const predecessorCount = ROW_SECURITY_POLICIES.length - pageDefinitions.length;
  let owner: ReturnType<typeof createDb> | undefined;
  let runtime: ReturnType<typeof createDb> | undefined;
  let runtimeUrl: string;
  let grantRole: string | undefined;
  let migrationSql: string;
  let ownRoles = false;
  const runtimeUrls = new Set<string>();

  const db = () => owner!.prisma;
  const catalog = async (schema: "public" | "cogine_pages") =>
    (
      await owner!.pool.query(
        `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relacl::text AS acl,
          p.polname AS policy, p.polcmd, p.polpermissive, p.polroles::text,
          pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qualifier,
          pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS write_check
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_policy p ON p.polrelid = c.oid
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
         ORDER BY c.relname, p.polname`,
        [schema],
      )
    ).rows;

  const namespace = async () =>
    (
      await owner!.pool.query<{ present: boolean }>(
        "SELECT to_regnamespace('cogine_pages') IS NOT NULL AS present",
      )
    ).rows[0]!.present;

  const verify = (allowPrePages = false) =>
    verifyRuntimeDatabase(runtime!.prisma, { allowPrePages });

  async function withPagesPredecessorCatalog<T>(work: () => Promise<T>): Promise<T> {
    // The fixture is cloned from the latest schema. Move the later Slack
    // tables out of the frozen public catalog only while replaying the old SQL.
    const held = identifier(`pages_fixture_later_tables_${suffix}`);
    const tables = [
      "messaging_install_sessions",
      "messaging_installations",
      "messaging_credential_cleanups",
    ];
    const pool = owner!.pool;
    await pool.query(
      [
        "BEGIN",
        `CREATE SCHEMA ${held}`,
        ...tables.map((table) => `ALTER TABLE public.${table} SET SCHEMA ${held}`),
        "COMMIT",
      ].join(";"),
    );
    try {
      return await work();
    } finally {
      await pool.query(
        [
          "BEGIN",
          ...tables.map((table) => `ALTER TABLE ${held}.${table} SET SCHEMA public`),
          `DROP SCHEMA ${held}`,
          "COMMIT",
        ].join(";"),
      );
    }
  }

  async function predecessor() {
    expect(await db().page.count()).toBe(0);
    await owner!.pool.query("DROP SCHEMA cogine_pages CASCADE");
    const removed = await owner!.pool.query(
      "DELETE FROM public._prisma_migrations WHERE migration_name = ANY($1::text[]) AND finished_at IS NOT NULL",
      [[migration, shareMigration, shareRevisionMigration]],
    );
    expect(removed.rowCount).toBe(3);
    expect(await namespace()).toBe(false);
  }

  async function deploy(prePages = false) {
    const result = prePages
      ? await withPagesPredecessorCatalog(() => prismaCommand("deploy"))
      : await prismaCommand("deploy");
    expect(result.code, result.output).toBe(0);
  }

  async function deployWithQuotedIdentifiers() {
    // Apply the setting to fresh sessions in this disposable fixture so that
    // Prisma's own connection starts with it as well.
    const database = identifier(new URL(ownerUrl!).pathname.slice(1));
    const admin = await owner!.pool.connect();
    try {
      await admin.query(`ALTER DATABASE ${database} SET quote_all_identifiers = on`);
      try {
        const fresh = createDb(ownerUrl!, { poolMax: 1 });
        try {
          const result = await fresh.pool.query("SHOW quote_all_identifiers");
          expect(result.rows).toEqual([{ quote_all_identifiers: "on" }]);
        } finally {
          await fresh.pool.end();
        }
        await deploy(true);
      } finally {
        await admin.query(`ALTER DATABASE ${database} RESET quote_all_identifiers`);
      }
    } finally {
      admin.release();
    }
  }

  async function runMigrationSql() {
    await withPagesPredecessorCatalog(async () => {
      const client = await owner!.pool.connect();
      try {
        await client.query(migrationSql);
      } finally {
        // A failed multi-statement migration leaves this connection inside an aborted transaction.
        await client.query("ROLLBACK");
        client.release();
      }
    });
  }

  async function prepareRuntime(name: string, password = randomBytes(24).toString("hex")) {
    const url = new URL(ownerUrl!);
    url.username = name;
    url.password = password;
    url.searchParams.delete("user");
    url.searchParams.delete("password");
    runtimeUrl = url.toString();
    runtimeUrls.add(runtimeUrl);
    await provisionRuntimeRole(ownerUrl!, runtimeUrl);
    runtime = createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
  }

  beforeAll(async () => {
    const url = new URL(ownerUrl!);
    const database = url.pathname.slice(1);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) <= 1024 ||
      !/^integration_(0|[1-9][0-9]*)$/.test(database) ||
      database !== process.env.VERIFY_ROW_SECURITY_POLICIES_DATABASE
    )
      throw new Error("Pages migration tests require an explicitly isolated harness database");
    owner = createDb(ownerUrl!, { poolMax: 3 });
    const identity = await owner.pool.query<{ name: string; grant: string }>(
      "SELECT datname AS name, 'coginebot_app_' || oid::text AS grant FROM pg_database WHERE datname = current_database()",
    );
    expect(identity.rows[0]?.name).toBe(database);
    grantRole = identity.rows[0]!.grant;
    const existing = await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname = ANY($1)", [
      [login, grantRole],
    ]);
    expect(existing.rowCount).toBe(0);
    ownRoles = true;
    await prepareRuntime(login);
    migrationSql = await readFile(
      new URL(`prisma/migrations/${migration}/migration.sql`, databasePackage),
      "utf8",
    );
    expect(pageDefinitions).toHaveLength(2);
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
        for (const url of runtimeUrls) {
          await clean(() =>
            owner!.pool.query(
              "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
              [rlsBypassKey(url)],
            ),
          );
        }
        for (const role of [login, grantRole!]) {
          await clean(async () => {
            const exists = await owner!.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
              role,
            ]);
            if (!exists.rowCount) return;
            await owner!.pool.query(`DROP OWNED BY ${identifier(role)}`);
            await owner!.pool.query(`DROP ROLE ${identifier(role)}`);
          });
        }
      }
      await clean(() => owner!.prisma.$disconnect());
      await clean(() => owner!.pool.end());
    }
    if (failures.length)
      throw new AggregateError(failures, "Pages migration fixture cleanup failed");
  });

  it("migrates the exact legacy catalog without enabling policies", async () => {
    await predecessor();
    const publicBefore = await catalog("public");
    expect(publicBefore.every((row) => !row.enabled && row.policy === null)).toBe(true);
    await expect(verify()).rejects.toThrow();
    await expect(verify(true)).resolves.toMatchObject({
      expectedTables: predecessorCount,
      connectionEnforced: false,
      guardValid: true,
    });

    await deploy(true);
    expect(await catalog("public")).toEqual(publicBefore);
    expect(await catalog("cogine_pages")).toMatchObject([
      { name: "page_versions", enabled: false, policy: null },
      { name: "pages", enabled: false, policy: null },
    ]);
    await expect(verify()).resolves.toMatchObject({
      expectedTables: predecessorCount + 2,
      connectionEnforced: false,
      guardValid: true,
    });
  }, 70_000);

  it("atomically extends a protected predecessor whose runtime logs in as its grant role", async () => {
    await runtime!.prisma.$disconnect();
    await runtime!.pool.end();
    runtime = undefined;
    const directRole = identifier(grantRole!);
    const password = randomBytes(24).toString("hex");
    await owner!.pool.query(`REVOKE ${directRole} FROM ${identifier(login)}`);
    await owner!.pool.query(
      `ALTER ROLE ${directRole} LOGIN PASSWORD '${scramSha256Verifier(password)}'`,
    );
    await prepareRuntime(grantRole!, password);
    expect(
      (await runtime!.pool.query("SELECT session_user AS login, current_user AS role")).rows[0],
    ).toEqual({ login: grantRole, role: grantRole });
    await expect(applyRowSecurityPolicies(ownerUrl!, runtimeUrl)).resolves.toMatchObject({
      connectionEnforced: true,
    });
    await predecessor();
    const publicBefore = await catalog("public");
    await expect(verify()).rejects.toThrow();
    await expect(verify(true)).resolves.toMatchObject({
      expectedTables: predecessorCount,
      connectionEnforced: true,
    });

    const bots = publicBefore.find(
      ({ name, policy }) => name === "bots" && policy === "bots_tenant",
    );
    expect(bots?.qualifier).toBeTypeOf("string");
    await owner!.pool.query("ALTER POLICY bots_tenant ON public.bots USING (true)");
    try {
      await expect(verify(true)).rejects.toThrow();
      await expect(runMigrationSql()).rejects.toThrow(
        "Private Pages requires an unprotected or fully protected predecessor",
      );
      expect(await namespace()).toBe(false);
    } finally {
      // The expression comes from the exact fixture catalog, not test or user input.
      await owner!.pool.query(`ALTER POLICY bots_tenant ON public.bots USING (${bots!.qualifier})`);
    }
    expect(await catalog("public")).toEqual(publicBefore);

    await owner!.pool.query(
      "CREATE SCHEMA cogine_pages; CREATE TABLE cogine_pages.pages (id text)",
    );
    try {
      await expect(verify()).rejects.toThrow();
      await expect(verify(true)).rejects.toThrow();
      await expect(runMigrationSql()).rejects.toThrow("The private Pages schema already exists");
      expect(await catalog("cogine_pages")).toMatchObject([
        { name: "pages", enabled: false, policy: null },
      ]);
    } finally {
      await owner!.pool.query("DROP SCHEMA cogine_pages CASCADE");
    }

    await rejectsForeignGrant(publicBefore, directRole);

    const gate = randomBytes(4).readUInt32BE() & 0x7fffffff;
    const trigger = identifier(`pages_policy_failure_${suffix}`);
    await owner!.pool.query(`
      CREATE FUNCTION public.${trigger}() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF to_regclass('cogine_pages.pages') IS NOT NULL
           AND to_regclass('cogine_pages.page_versions') IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock(${gate}::bigint);
          RAISE EXCEPTION 'isolated late Pages policy failure';
        END IF;
      END;
      $$;
      CREATE EVENT TRIGGER ${trigger} ON ddl_command_end WHEN TAG IN ('CREATE POLICY')
        EXECUTE FUNCTION public.${trigger}();
    `);
    const observer = await owner!.pool.connect();
    let failure: Awaited<ReturnType<typeof prismaCommand>> | undefined;
    try {
      await observer.query("SELECT pg_advisory_lock($1::bigint)", [gate]);
      const installing = withPagesPredecessorCatalog(() => prismaCommand("deploy"));
      try {
        await vi.waitFor(
          async () => {
            const waiting = await observer.query<{ blocked: boolean }>(
              `SELECT EXISTS (
                 SELECT 1 FROM pg_catalog.pg_locks
                 WHERE locktype = 'advisory' AND NOT granted
                   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                   AND classid = 0 AND objid = $1::oid AND objsubid = 1
               ) AS blocked`,
              [gate],
            );
            expect(waiting.rows[0]?.blocked).toBe(true);
          },
          { timeout: 20_000 },
        );
        expect(
          (await observer.query("SELECT to_regnamespace('cogine_pages') AS pages")).rows[0],
        ).toEqual({ pages: null });
      } finally {
        await observer.query("SELECT pg_advisory_unlock($1::bigint)", [gate]);
        failure = await installing;
      }
    } finally {
      observer.release();
      await owner!.pool.query(`DROP EVENT TRIGGER ${trigger}; DROP FUNCTION public.${trigger}()`);
    }
    // The engine can report the final aborted statement rather than the
    // trigger's exception. The blocked DDL and failed ledger row identify it.
    expect(failure?.code, failure?.output).not.toBe(0);
    expect(await namespace()).toBe(false);
    expect(await catalog("public")).toEqual(publicBefore);
    await expect(verify(true)).resolves.toMatchObject({ connectionEnforced: true });
    const failed = await owner!.pool.query(
      `SELECT finished_at, rolled_back_at FROM public._prisma_migrations
       WHERE migration_name = $1`,
      [migration],
    );
    expect(failed.rows).toEqual([{ finished_at: null, rolled_back_at: null }]);

    const rolledBack = await prismaCommand("resolve", "--rolled-back", migration);
    expect(rolledBack.code, rolledBack.output).toBe(0);
    await deployWithQuotedIdentifiers();
    expect(await catalog("public")).toEqual(publicBefore);
    await expect(verify()).resolves.toMatchObject({
      expectedTables: predecessorCount + 2,
      connectionEnforced: true,
    });
    await expect(verify(true)).resolves.toMatchObject({ expectedTables: predecessorCount + 2 });
    await verifyRestrictedPages();
  }, 150_000);

  it("adds dormant share fields atomically without changing a private Page or its access", async () => {
    const pool = owner!.pool;
    const userId = `share-owner-${suffix}`;
    const spaceId = `share-space-${suffix}`;
    const orgId = `share-org-${suffix}`;
    const pageId = `existing-private-page-${suffix}`;
    await applyRowSecurityPolicies(ownerUrl!, runtimeUrl);
    await db().user.create({ data: { id: userId, email: `${userId}@example.test`, name: userId } });
    await db().space.create({
      data: {
        id: spaceId,
        name: "Original Page Space",
        organization: {
          create: { id: orgId, slug: orgId, name: "Original Page Space", createdAt: new Date() },
        },
      },
    });
    await pool.query(
      `ALTER TABLE cogine_pages.pages
       DROP COLUMN "shareTokenHash", DROP COLUMN "shareSecretId", DROP COLUMN "shareRevision"`,
    );
    const removed = await pool.query(
      "DELETE FROM public._prisma_migrations WHERE migration_name = ANY($1::text[]) AND finished_at IS NOT NULL",
      [[shareMigration, shareRevisionMigration]],
    );
    expect(removed.rowCount).toBe(2);
    await pool.query(
      `INSERT INTO cogine_pages.pages (id,"spaceId","userId",title,"updatedAt")
       VALUES ($1,$2,$3,'Original private Page',CURRENT_TIMESTAMP)`,
      [pageId, spaceId, userId],
    );
    await pool.query(
      `INSERT INTO cogine_pages.page_versions (id,"pageId",version,title,source,code)
       VALUES ($1,$2,1,'Original private Page','Original source','Original code')`,
      [`version-${pageId}`, pageId],
    );
    const publicBefore = await catalog("public");
    const pagesBefore = await catalog("cogine_pages");
    const columns = async () =>
      (
        await pool.query(
          `SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_schema = 'cogine_pages' AND table_name = 'pages'
             AND column_name IN ('shareRevision', 'shareSecretId', 'shareTokenHash')
           ORDER BY column_name`,
        )
      ).rows;
    const readLegacyPage = async () =>
      (
        await pool.query(
          `SELECT p.title, p.visibility, p."currentVersion", v.source, v.code
           FROM cogine_pages.pages p JOIN cogine_pages.page_versions v
             ON v."pageId" = p.id AND v.version = p."currentVersion"
           WHERE p.id=$1`,
          [pageId],
        )
      ).rows;
    const original = await readLegacyPage();
    expect(original).toEqual([
      {
        title: "Original private Page",
        visibility: "private",
        currentVersion: 1,
        source: "Original source",
        code: "Original code",
      },
    ]);

    // Force the last CREATE INDEX to fail after the column and FK statements.
    await pool.query('CREATE INDEX "pages_shareSecretId_key" ON cogine_pages.pages (id)');
    try {
      const failed = await prismaCommand("deploy");
      expect(failed.code, failed.output).not.toBe(0);
      expect(failed.output).toContain(shareMigration);
      expect(await columns()).toEqual([]);
      expect(await readLegacyPage()).toEqual(original);
      expect(await catalog("public")).toEqual(publicBefore);
      expect(await catalog("cogine_pages")).toEqual(pagesBefore);
      await expect(verify()).resolves.toMatchObject({ connectionEnforced: true });
    } finally {
      await pool.query('DROP INDEX cogine_pages."pages_shareSecretId_key"');
    }
    const rollback = await prismaCommand("resolve", "--rolled-back", shareMigration);
    expect(rollback.code, rollback.output).toBe(0);
    await deploy();

    expect(await columns()).toEqual([
      { column_name: "shareRevision", is_nullable: "NO" },
      { column_name: "shareSecretId", is_nullable: "YES" },
      { column_name: "shareTokenHash", is_nullable: "YES" },
    ]);
    expect(await readLegacyPage()).toEqual(original);
    expect(await catalog("public")).toEqual(publicBefore);
    expect(await catalog("cogine_pages")).toEqual(pagesBefore);
    await expect(verify()).resolves.toMatchObject({ connectionEnforced: true });
    const select = {
      where: { id: pageId },
      select: { visibility: true, shareTokenHash: true, shareSecretId: true, shareRevision: true },
    } as const;
    await expect(runtime!.prisma.page.findFirst(select)).resolves.toBeNull();
    await expect(
      runAsTenant(
        { userId, spaceId, email: `${userId}@example.test`, isDeploymentOwner: false },
        () => runtime!.prisma.page.findFirst(select),
      ),
    ).resolves.toEqual({
      visibility: "private",
      shareTokenHash: null,
      shareSecretId: null,
      shareRevision: 0,
    });
  }, 150_000);

  async function rejectsForeignGrant(
    publicBefore: Awaited<ReturnType<typeof catalog>>,
    role: string,
  ) {
    const peerName = `pages_migration_peer_${suffix}`;
    const peer = identifier(peerName);
    const peerOwner = identifier(`pages_migration_peer_owner_${suffix}`);
    await owner!.pool.query(`CREATE ROLE ${peerOwner} NOLOGIN`);
    let peerCreated = false;
    try {
      await owner!.pool.query(`CREATE DATABASE ${peer} OWNER ${peerOwner}`);
      peerCreated = true;
      await owner!.pool.query(`REVOKE CONNECT ON DATABASE ${peer} FROM PUBLIC`);
      await owner!.pool.query(`GRANT CONNECT ON DATABASE ${peer} TO ${role}`);
      const grant = await owner!.pool.query(
        "SELECT has_database_privilege($1, $2, 'CONNECT') AS allowed",
        [grantRole, peerName],
      );
      expect(grant.rows).toEqual([{ allowed: true }]);
      await expect(runMigrationSql()).rejects.toThrow(
        "Private Pages requires the restricted database grant role",
      );
      expect(await namespace()).toBe(false);
      expect(await catalog("public")).toEqual(publicBefore);
    } finally {
      try {
        if (peerCreated) {
          try {
            await owner!.pool.query(`REVOKE CONNECT ON DATABASE ${peer} FROM ${role}`);
          } finally {
            await owner!.pool.query(`DROP DATABASE ${peer}`);
          }
        }
      } finally {
        await owner!.pool.query(`DROP ROLE ${peerOwner}`);
      }
    }
  }

  async function verifyRestrictedPages() {
    const acl = await runtime!.pool.query<{ name: string; privilege: string; allowed: boolean }>(
      `SELECT name, privilege, has_table_privilege(current_user, name, privilege) AS allowed
       FROM unnest(ARRAY['cogine_pages.pages', 'cogine_pages.page_versions']) AS name
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
         'REFERENCES', 'TRIGGER', 'SELECT WITH GRANT OPTION']) AS privilege`,
    );
    const allowed = new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]);
    expect(acl.rows).toHaveLength(16);
    expect(acl.rows.every((row) => row.allowed === allowed.has(row.privilege))).toBe(true);
    expect(
      (
        await runtime!.pool.query(
          `SELECT has_schema_privilege('cogine_pages', 'USAGE') AS usage,
          has_schema_privilege('cogine_pages', 'CREATE') AS create`,
        )
      ).rows[0],
    ).toEqual({ usage: true, create: false });
    const foreignKeys = await owner!.pool.query<{ target: string; on_delete: string }>(
      `SELECT n.nspname || '.' || t.relname AS target, k.confdeltype AS on_delete
       FROM pg_constraint k JOIN pg_class s ON s.oid = k.conrelid
       JOIN pg_class t ON t.oid = k.confrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE k.contype = 'f' AND s.relnamespace = 'cogine_pages'::regnamespace
       ORDER BY target`,
    );
    expect(foreignKeys.rows).toEqual([
      { target: "cogine_pages.pages", on_delete: "c" },
      { target: "public.bots", on_delete: "n" },
      { target: "public.chat_groups", on_delete: "c" },
      { target: "public.secrets", on_delete: "n" },
      { target: "public.spaces", on_delete: "c" },
      { target: "public.user", on_delete: "c" },
    ]);

    const userId = `pages-owner-${suffix}`;
    const foreignUserId = `pages-foreign-${suffix}`;
    const organizationId = `pages-org-${suffix}`;
    await db().user.createMany({
      data: [userId, foreignUserId].map((id) => ({ id, email: `${id}@example.test`, name: id })),
    });
    await db().organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        name: "Pages fixture",
        createdAt: new Date(),
      },
    });
    const space = await db().space.create({
      data: { id: `pages-space-${suffix}`, organizationId, name: "Pages space" },
    });
    const otherSpace = await db().space.create({
      data: { id: `pages-other-space-${suffix}`, organizationId, name: "Other space" },
    });
    const page = await db().page.create({
      data: {
        title: "Private result",
        userId,
        spaceId: space.id,
        versions: {
          create: { version: 1, title: "Private result", source: "source", code: "code" },
        },
      },
    });
    expect((await runtime!.pool.query("SELECT id FROM cogine_pages.pages")).rows).toEqual([]);
    expect((await runtime!.pool.query("SELECT id FROM cogine_pages.page_versions")).rows).toEqual(
      [],
    );
    await expect(
      runtime!.pool.query(
        `INSERT INTO cogine_pages.page_versions (id, "pageId", version, title, source, code)
         VALUES ('unscoped-write', $1, 2, 'Rejected', 'x', 'x')`,
        [page.id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    for (const actor of [
      { userId: foreignUserId, spaceId: space.id },
      { userId, spaceId: otherSpace.id },
    ]) {
      await runAsTenant(actor, async () => {
        expect(await runtime!.prisma.page.findUnique({ where: { id: page.id } })).toBeNull();
        expect(await runtime!.prisma.pageVersion.findMany({ where: { pageId: page.id } })).toEqual(
          [],
        );
        await expect(
          runtime!.prisma.pageVersion.create({
            data: { pageId: page.id, version: 2, title: "Foreign write", source: "x", code: "x" },
          }),
        ).rejects.toThrow();
      });
    }
    await runAsTenant({ userId, spaceId: space.id }, async () => {
      await expect(
        runtime!.prisma.page.findUnique({ where: { id: page.id } }),
      ).resolves.toMatchObject({ id: page.id });
      await expect(
        runtime!.prisma.pageVersion.findMany({ where: { pageId: page.id } }),
      ).resolves.toHaveLength(1);
      await expect(
        runtime!.prisma.pageVersion.create({
          data: { pageId: page.id, version: 2, title: "Owner write", source: "new", code: "new" },
        }),
      ).resolves.toMatchObject({ pageId: page.id, version: 2 });
    });
    await db().space.delete({ where: { id: space.id } });
    expect(await db().page.count({ where: { id: page.id } })).toBe(0);
    expect(await db().pageVersion.count({ where: { pageId: page.id } })).toBe(0);
  }
});
