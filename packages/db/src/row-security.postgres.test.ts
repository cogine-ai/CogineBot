import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { PrismaClient } from "./generated/prisma/client.js";
import {
  asSystem,
  currentDbContext,
  installDbContext,
  rlsBypassKey,
  runAsSystem,
  runAsSystemInTransaction,
  runAsTenant,
  withRowLevelSecurity,
} from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("database execution contexts (isolated PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;

  beforeAll(() => {
    db = createDb(databaseUrl!, { poolMax: 1, rowSecurity: true });
  });

  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("gives a tenant query its own identity and clears it on the next unscoped checkout", async () => {
    const read = () =>
      db.prisma.$queryRaw<
        Array<{ space: string | null; user: string | null; bypass: string | null }>
      >`
        SELECT current_setting('app.space_id', true) AS space,
          current_setting('app.user_id', true) AS "user",
          current_setting('app.rls_bypass', true) AS bypass`;
    const scoped = await runAsTenant({ spaceId: "scope-a", userId: "account-a" }, read);
    expect(scoped).toEqual([{ space: "scope-a", user: "account-a", bypass: "off" }]);
    expect(await read()).toEqual([{ space: "", user: "", bypass: "off" }]);
  });

  it("does not accept a plain system flag when no protected key has been registered", async () => {
    await db.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.rls_bypass', 'on', true)`;
      const result = await tx.$queryRaw<Array<{ allowed: boolean }>>`
        SELECT app_rls_bypass() AS allowed`;
      expect(result).toEqual([{ allowed: false }]);
    });
  });
});

describePostgres("staged transaction context compatibility (isolated PostgreSQL)", () => {
  it("binds default-mode transactions without changing ordinary queries or connection settings", async () => {
    const db = createDb(databaseUrl!, { poolMax: 1 });
    const tenant = { spaceId: "binding-space", userId: "binding-user" };
    type Settings = {
      pid: number;
      space: string | null;
      bypass: string | null;
      key: string | null;
    };
    try {
      await runAsTenant(tenant, () =>
        db.prisma.$transaction(async (tx) => {
          const read = () => tx.$queryRaw<Settings[]>`
            SELECT pg_backend_pid() AS pid, current_setting('app.space_id', true) AS space,
              current_setting('app.rls_bypass', true) AS bypass,
              current_setting('app.rls_bypass_key', true) AS key`;
          const before = await read();
          await runAsSystemInTransaction(
            tx,
            "read deployment metadata in compatible mode",
            async () => {
              expect(currentDbContext()).toEqual({
                kind: "system",
                reason: "read deployment metadata in compatible mode",
              });
              expect(await read()).toEqual(before);
            },
          );
          expect(currentDbContext()).toEqual({ kind: "tenant", ...tenant });
          expect(await read()).toEqual(before);
          await expect(
            runAsSystemInTransaction(tx, "failed compatible metadata read", async () => {
              throw new Error("Synthetic metadata failure");
            }),
          ).rejects.toThrow("Synthetic metadata failure");
          expect(currentDbContext()).toEqual({ kind: "tenant", ...tenant });
          expect(await read()).toEqual(before);
        }),
      );
      expect(
        await runAsTenant(tenant, () =>
          db.prisma.$transaction([
            db.prisma.$queryRaw`SELECT 1 AS value`,
            db.prisma.$queryRaw`SELECT 2 AS value`,
          ]),
        ),
      ).toEqual([[{ value: 1 }], [{ value: 2 }]]);
      expect(db.pool.waitingCount).toBe(0);
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});

describePostgres("nonowner database context enforcement (isolated PostgreSQL)", () => {
  const suffix = randomBytes(10).toString("hex");
  const role = `cogine_context_${suffix}`;
  const password = randomBytes(24).toString("hex");
  const organizationId = `rls-org-${suffix}`;
  const userA = `rls-user-a-${suffix}`;
  const userB = `rls-user-b-${suffix}`;
  const spaceA = `rls-space-a-${suffix}`;
  const spaceB = `rls-space-b-${suffix}`;
  const documentA = `rls-document-a-${suffix}`;
  const documentB = `rls-document-b-${suffix}`;
  const policies = {
    documentTenant: `context_document_tenant_${suffix}`,
    documentSystem: `context_document_system_${suffix}`,
    revisionTenant: `context_revision_tenant_${suffix}`,
    revisionSystem: `context_revision_system_${suffix}`,
  };
  let owner: ReturnType<typeof createDb>;
  let runtime: ReturnType<typeof createDb> | undefined;
  let runtimeUrl: string;
  let roleCreated = false;
  const previousRls = new Map<string, boolean>();
  const tenantA = { spaceId: spaceA, userId: userA };
  const tenantB = { spaceId: spaceB, userId: userB };

  function environment(values: Record<string, string | undefined>) {
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    const apply = (entries: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(entries)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    apply(values);
    return () => apply(previous);
  }

  async function systemConsumers(client: ReturnType<typeof createDb>) {
    // Start with a unique read: its local settings must use the same credential
    // as checkout, including the first authentication with a one-client pool.
    expect(
      await runAsSystem("fixture external-auth unique read", () =>
        client.prisma.memoryDocument.findUnique({ where: { id: documentB } }),
      ),
    ).toMatchObject({ id: documentB });
    expect(
      await runAsSystem(
        "fixture external-auth raw read",
        () => client.prisma.$queryRaw`SELECT id FROM memory_documents ORDER BY id`,
      ),
    ).toHaveLength(2);
    await runAsTenant(tenantA, () =>
      client.prisma.$transaction(async (tx) => {
        expect(await tx.memoryDocument.count()).toBe(1);
        await runAsSystemInTransaction(tx, "fixture external-auth transaction", async () => {
          expect(await tx.memoryDocument.count()).toBe(2);
        });
        expect(await tx.memoryDocument.count()).toBe(1);
      }),
    );
  }

  async function close(client: ReturnType<typeof createDb>) {
    await client.prisma.$disconnect();
    await client.pool.end();
  }

  beforeAll(async () => {
    owner = createDb(databaseUrl!);
    runtimeUrl = (() => {
      const url = new URL(databaseUrl!);
      url.username = role;
      url.password = password;
      url.searchParams.delete("user");
      url.searchParams.delete("password");
      return url.toString();
    })();
    await owner.pool.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD '${password}'`,
    );
    roleCreated = true;
    const database = await owner.pool.query<{ name: string }>("SELECT current_database() AS name");
    await owner.pool.query(
      `GRANT CONNECT ON DATABASE "${database.rows[0]!.name.replaceAll('"', '""')}" TO "${role}"`,
    );
    await owner.pool.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await owner.pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON memory_documents, memory_revisions TO "${role}"`,
    );
    await owner.pool.query(
      "INSERT INTO cogine_private.rls_bypass_keys (digest) VALUES (sha256(convert_to($1, 'UTF8'))) ON CONFLICT DO NOTHING",
      [rlsBypassKey(runtimeUrl)],
    );
    const flags = await owner.pool.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE oid IN ('memory_documents'::regclass, 'memory_revisions'::regclass)",
    );
    for (const row of flags.rows) previousRls.set(row.relname, row.relrowsecurity);
    await owner.pool.query("ALTER TABLE memory_documents ENABLE ROW LEVEL SECURITY");
    await owner.pool.query("ALTER TABLE memory_revisions ENABLE ROW LEVEL SECURITY");
    await owner.pool.query(
      `CREATE POLICY "${policies.documentTenant}" ON memory_documents USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))`,
    );
    await owner.pool.query(
      `CREATE POLICY "${policies.documentSystem}" ON memory_documents USING ((SELECT app_rls_bypass()))`,
    );
    await owner.pool.query(
      `CREATE POLICY "${policies.revisionTenant}" ON memory_revisions USING (EXISTS (SELECT 1 FROM memory_documents d WHERE d.id = memory_revisions."documentId" AND d."spaceId" = NULLIF(current_setting('app.space_id', true), '')))`,
    );
    await owner.pool.query(
      `CREATE POLICY "${policies.revisionSystem}" ON memory_revisions USING ((SELECT app_rls_bypass()))`,
    );
    await owner.prisma.user.createMany({
      data: [
        { id: userA, name: "RLS A", email: `${userA}@example.test` },
        { id: userB, name: "RLS B", email: `${userB}@example.test` },
      ],
    });
    await owner.prisma.organization.create({
      data: {
        id: organizationId,
        name: "RLS fixture",
        slug: organizationId,
        createdAt: new Date(),
        spaces: {
          create: [
            { id: spaceA, name: "A" },
            { id: spaceB, name: "B" },
          ],
        },
      },
    });
    for (const [id, spaceId, userId] of [
      [documentA, spaceA, userA],
      [documentB, spaceB, userB],
    ]) {
      await owner.prisma.memoryDocument.create({
        data: {
          id: id!,
          spaceId: spaceId!,
          userId: userId!,
          scope: "isolated",
          path: "MEMORY.md",
          content: id!,
          revisions: { create: { revision: 1, content: id! } },
        },
      });
    }
    runtime = createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(async () => runtime?.prisma.$disconnect());
    await cleanup(async () => runtime?.pool.end());
    if (owner) {
      await cleanup(() => owner.prisma.organization.deleteMany({ where: { id: organizationId } }));
      await cleanup(() => owner.prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } }));
      for (const [table, names] of [
        ["memory_documents", [policies.documentTenant, policies.documentSystem]],
        ["memory_revisions", [policies.revisionTenant, policies.revisionSystem]],
      ] as const) {
        for (const name of names) {
          await cleanup(() => owner.pool.query(`DROP POLICY IF EXISTS "${name}" ON "${table}"`));
        }
        if (previousRls.get(table) === false) {
          await cleanup(() =>
            owner.pool.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`),
          );
        }
      }
      if (runtimeUrl)
        await cleanup(() =>
          owner.pool.query(
            "DELETE FROM cogine_private.rls_bypass_keys WHERE digest = sha256(convert_to($1, 'UTF8'))",
            [rlsBypassKey(runtimeUrl)],
          ),
        );
      if (roleCreated) {
        await cleanup(() => owner.pool.query(`DROP OWNED BY "${role}"`));
        await cleanup(() => owner.pool.query(`DROP ROLE "${role}"`));
      }
      await cleanup(() => owner.prisma.$disconnect());
      await cleanup(() => owner.pool.end());
    }
    if (failures.length) throw new AggregateError(failures, "RLS fixture cleanup failed");
  });

  it("uses an independent nonowner login with no role-creation or bypass privilege", async () => {
    const rows = await runtime!.prisma.$queryRaw<
      Array<{ name: string; superuser: boolean; bypass: boolean; createRole: boolean }>
    >`
      SELECT rolname AS name, rolsuper AS superuser, rolbypassrls AS bypass, rolcreaterole AS "createRole"
      FROM pg_roles WHERE rolname = current_user`;
    expect(rows).toEqual([{ name: role, superuser: false, bypass: false, createRole: false }]);
  });

  it("keeps synchronous system extensions and fluent queries usable", async () => {
    const system = asSystem(runtime!.prisma, "fixture system extension");
    const extended = system.$extends({ name: "synchronous-system-fixture" });
    expect(await extended.memoryDocument.findUnique({ where: { id: documentB } })).toMatchObject({
      id: documentB,
    });
    const revisions = await extended.memoryDocument
      .findUnique({ where: { id: documentB } })
      .revisions();
    expect(revisions?.map((revision) => revision.documentId)).toEqual([documentB]);
    await extended.$transaction(async (tx) => {
      expect(await tx.memoryDocument.count()).toBe(2);
    });
  });

  it("uses PGPASSWORD consistently for checkout, unique reads and transaction system access", async () => {
    const url = new URL(runtimeUrl);
    url.password = "";
    const restore = environment({ PGPASSWORD: password });
    const client = createDb(url.toString(), { poolMax: 1, rowSecurity: true });
    try {
      await systemConsumers(client);
    } finally {
      await close(client);
      restore();
    }
  });

  it("uses an isolated password file without requiring a URL password", async () => {
    const url = new URL(runtimeUrl);
    url.password = "";
    const folder = await mkdtemp(path.join(tmpdir(), "db-context-pass-"));
    const file = path.join(folder, "pgpass");
    const escapePassField = (value: string) =>
      value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
    await writeFile(
      file,
      `${[url.hostname, url.port, url.pathname.slice(1), role, password].map(escapePassField).join(":")}\n`,
      { mode: 0o600 },
    );
    const restore = environment({ PGPASSWORD: undefined, PGPASSFILE: file });
    const client = createDb(url.toString(), { poolMax: 1, rowSecurity: true });
    try {
      await systemConsumers(client);
    } finally {
      await close(client);
      restore();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("follows the driver's last query credential and URL priority over the environment", async () => {
    const url = new URL(runtimeUrl);
    url.username = "unused_fixture_login";
    url.password = "unused-fixture-password";
    url.searchParams.append("user", "first-unused-fixture-login");
    url.searchParams.append("user", role);
    url.searchParams.append("password", "first-unused-fixture-password");
    url.searchParams.append("password", password);
    const restore = environment({ PGPASSWORD: "unused-environment-password" });
    const client = createDb(url.toString(), { poolMax: 1, rowSecurity: true });
    try {
      await systemConsumers(client);
    } finally {
      await close(client);
      restore();
    }
  });

  it("can retry external authentication after an initial failure", async () => {
    const url = new URL(runtimeUrl);
    url.password = "";
    const restore = environment({ PGPASSWORD: "initial-invalid-fixture-password" });
    const client = createDb(url.toString(), { poolMax: 1, rowSecurity: true });
    try {
      await expect(
        runAsSystem("fixture failed authentication", () =>
          client.prisma.memoryDocument.findUnique({ where: { id: documentB } }),
        ),
      ).rejects.toThrow();
      process.env.PGPASSWORD = password;
      await systemConsumers(client);
    } finally {
      await close(client);
      restore();
    }
  });

  it("uses an authenticated password callback for every system consumer", async () => {
    const url = new URL(runtimeUrl);
    const pool = new Pool({
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.slice(1),
      user: role,
      password: async () => password,
      max: 1,
      connectionTimeoutMillis: 10_000,
    });
    const key = installDbContext(pool);
    const prisma = withRowLevelSecurity(new PrismaClient({ adapter: new PrismaPg(pool) }), key);
    try {
      await systemConsumers({ prisma, pool });
    } finally {
      await close({ prisma, pool });
    }
  });

  it("rejects newly authenticated connections after a pool credential rotation", async () => {
    const url = new URL(runtimeUrl);
    let activePassword = password;
    const pool = new Pool({
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.slice(1),
      user: role,
      password: async () => activePassword,
      max: 2,
      connectionTimeoutMillis: 10_000,
    });
    installDbContext(pool);
    let held: PoolClient | undefined;
    try {
      held = await runAsTenant(tenantA, () => pool.connect());
      activePassword = randomBytes(24).toString("hex");
      await owner.pool.query(`ALTER ROLE "${role}" PASSWORD '${activePassword}'`);
      await expect(pool.connect()).rejects.toThrow("Database authentication changed");
      expect((await held.query("SELECT id FROM memory_documents")).rows).toEqual([
        { id: documentA },
      ]);
    } finally {
      await owner.pool.query(`ALTER ROLE "${role}" PASSWORD '${password}'`);
      held?.release();
      await pool.end();
    }
  });

  it("isolates same-tick unique reads, compound revision reads and fluent relations", async () => {
    const prisma = runtime!.prisma;
    const rows = await Promise.all([
      runAsTenant(tenantA, () => prisma.memoryDocument.findUnique({ where: { id: documentA } })),
      runAsTenant(tenantB, () => prisma.memoryDocument.findUnique({ where: { id: documentB } })),
      runAsTenant(tenantA, () => prisma.memoryDocument.findUnique({ where: { id: documentB } })),
    ]);
    expect(rows.map((row) => row?.id ?? null)).toEqual([documentA, documentB, null]);
    const compound = (documentId: string) =>
      prisma.memoryRevision.findUnique({
        where: { documentId_revision: { documentId, revision: 1 } },
      });
    expect(await runAsTenant(tenantA, () => compound(documentA))).toMatchObject({
      documentId: documentA,
    });
    expect(await runAsTenant(tenantA, () => compound(documentB))).toBeNull();
    const revisions = await runAsTenant(tenantA, () =>
      prisma.memoryDocument.findUnique({ where: { id: documentA } }).revisions(),
    );
    expect(revisions?.map((row) => row.documentId)).toEqual([documentA]);
  });

  it.each([
    ["empty", {}],
    ["undefined", { id: undefined }],
    ["null", { id: null }],
    ["nonunique only", { spaceId: spaceA }],
    ["scalar filter instead of unique value", { id: { in: [documentA] } }],
    ["unknown compound", { invented: { id: documentA } }],
  ])("preserves invalid unique selector rejection: %s", async (_name, where) => {
    await expect(
      runAsTenant(tenantA, () =>
        runtime!.prisma.memoryDocument.findUnique({ where: where as never }),
      ),
    ).rejects.toThrow();
    await expect(
      runAsTenant(tenantA, () =>
        runtime!.prisma.memoryDocument.findUniqueOrThrow({ where: where as never }),
      ),
    ).rejects.toThrow();
  });

  it("keeps transaction system access bound to its own client when another login configuration exists", async () => {
    const otherUrl = new URL(runtimeUrl);
    otherUrl.password = "different-unused-fixture-password";
    const unused = createDb(otherUrl.toString(), { poolMax: 1, rowSecurity: true });
    try {
      await runAsTenant(tenantA, () =>
        runtime!.prisma.$transaction(async (tx) => {
          await runAsSystemInTransaction(tx, "RLS fixture client-bound system count", async () => {
            expect(await tx.memoryDocument.count()).toBe(2);
          });
          expect(await tx.memoryDocument.count()).toBe(1);
        }),
      );
      const extended = runtime!.prisma.$extends({ name: "context-fixture-extension" });
      await runAsTenant(tenantA, () =>
        extended.$transaction(async (tx) => {
          await runAsSystemInTransaction(
            tx,
            "RLS fixture extended-client system count",
            async () => {
              expect(await tx.memoryDocument.count()).toBe(2);
            },
          );
          expect(await tx.memoryDocument.count()).toBe(1);
        }),
      );
    } finally {
      await unused.prisma.$disconnect();
      await unused.pool.end();
      await runtime!.prisma.$disconnect();
      await runtime!.pool.end();
      runtime = createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
    }
  });

  it("rejects array transactions inside a tenant scope", async () => {
    await expect(
      runAsTenant(tenantA, () =>
        runtime!.prisma.$transaction([runtime!.prisma.memoryDocument.count()]),
      ),
    ).rejects.toThrow("Batch $transaction");
  });

  it("denies foreign raw reads and foreign writes and exposes no rows without context", async () => {
    const prisma = runtime!.prisma;
    expect(
      await runAsTenant(
        tenantA,
        () => prisma.$queryRaw`SELECT id FROM memory_documents WHERE id = ${documentB}`,
      ),
    ).toEqual([]);
    await expect(
      runAsTenant(tenantA, () =>
        prisma.memoryDocument.create({
          data: {
            spaceId: spaceB,
            userId: userB,
            scope: "isolated",
            path: "denied.md",
            content: "not saved",
          },
        }),
      ),
    ).rejects.toThrow();
    expect(await prisma.$queryRaw`SELECT id FROM memory_documents`).toEqual([]);
  });

  it("captures a queued tenant checkout and resets the next unscoped checkout", async () => {
    const pool = runtime!.pool;
    const held = await runAsTenant(tenantA, () => pool.connect());
    let queued!: Promise<PoolClient>;
    await runAsTenant(tenantB, () => {
      queued = pool.connect();
    });
    held.release();
    const client = await queued;
    try {
      const rows = await client.query(
        "SELECT current_setting('app.space_id', true) AS space, current_setting('app.user_id', true) AS account",
      );
      expect(rows.rows).toEqual([{ space: spaceB, account: userB }]);
    } finally {
      client.release();
    }
    const unscoped = await pool.connect();
    try {
      expect(
        (
          await unscoped.query(
            "SELECT current_setting('app.space_id', true) AS space, current_setting('app.rls_bypass_key', true) AS key",
          )
        ).rows,
      ).toEqual([{ space: "", key: "" }]);
    } finally {
      unscoped.release();
    }
  });

  it("restores a tenant transaction after successful and thrown system steps", async () => {
    await runAsTenant(tenantA, () =>
      runtime!.prisma.$transaction(async (tx) => {
        expect(await tx.memoryDocument.count()).toBe(1);
        await runAsSystemInTransaction(tx, "RLS fixture cross-space count", async () => {
          expect(await tx.memoryDocument.count()).toBe(2);
        });
        expect(await tx.memoryDocument.count()).toBe(1);
        const original = new Error("fixture step stopped");
        await expect(
          runAsSystemInTransaction(tx, "RLS fixture failing count", async () => {
            expect(await tx.memoryDocument.count()).toBe(2);
            throw original;
          }),
        ).rejects.toBe(original);
        expect(await tx.memoryDocument.count()).toBe(1);
      }),
    );
  });

  it("rejects a plain bypass flag and a forged key", async () => {
    await runAsTenant(tenantA, () =>
      runtime!.prisma.$transaction(async (tx) => {
        for (const key of ["", "forged-key"]) {
          await tx.$queryRaw`SELECT set_config('app.rls_bypass', 'on', true), set_config('app.rls_bypass_key', ${key}, true)`;
          expect(await tx.$queryRaw`SELECT app_rls_bypass() AS allowed`).toEqual([
            { allowed: false },
          ]);
          expect(await tx.memoryDocument.findMany({ where: { id: documentB } })).toEqual([]);
        }
      }),
    );
  });

  it("rejects overlapping system steps and restores the tenant after out-of-order completion", async () => {
    const barrier = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    await runAsTenant(tenantA, () =>
      runtime!.prisma.$transaction(async (tx) => {
        const firstEntered = barrier();
        const secondEntered = barrier();
        const releaseFirst = barrier();
        const releaseSecond = barrier();
        let second: Promise<unknown> | undefined;
        let secondCallbackEntered = false;
        const first = runAsSystemInTransaction(tx, "fixture first overlapping step", async () => {
          firstEntered.resolve();
          await releaseFirst.promise;
          expect(await tx.memoryDocument.count()).toBe(2);
        });
        try {
          await firstEntered.promise;
          second = runAsSystemInTransaction(tx, "fixture second overlapping step", async () => {
            secondCallbackEntered = true;
            secondEntered.resolve();
            await releaseSecond.promise;
          });
          const outcome = second.then(
            () => undefined,
            (error: unknown) => error,
          );
          await Promise.race([secondEntered.promise, outcome]);
          releaseFirst.resolve();
          await first;
          releaseSecond.resolve();
          const error = await outcome;
          expect(
            await tx.$queryRaw`SELECT current_setting('app.rls_bypass', true) AS bypass, current_setting('app.rls_bypass_key', true) AS key`,
          ).toEqual([{ bypass: "off", key: "" }]);
          expect(await tx.memoryDocument.count()).toBe(1);
          expect(error).toBeInstanceOf(Error);
          expect(secondCallbackEntered).toBe(false);
        } finally {
          releaseFirst.resolve();
          releaseSecond.resolve();
          await Promise.allSettled([first, ...(second ? [second] : [])]);
        }
      }),
    );
  });

  it("rejects tenant sibling model and raw work while a system step owns the transaction", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await runAsTenant(tenantA, () =>
      runtime!.prisma.$transaction(async (tx) => {
        const pendingSibling = tx.memoryDocument.findMany({ where: { id: documentB } });
        const system = runAsSystemInTransaction(tx, "fixture held system step", async () => {
          expect(await tx.memoryDocument.count()).toBe(2);
          entered();
          await gate;
        });
        try {
          await started;
          await expect(pendingSibling).rejects.toThrow();
          await expect(
            tx.$queryRaw`SELECT id FROM memory_documents WHERE id = ${documentB}`,
          ).rejects.toThrow();
          await expect(
            tx.memoryDocument.updateMany({
              where: { id: documentB },
              data: { content: "denied sibling write" },
            }),
          ).rejects.toThrow();
        } finally {
          release();
          await system;
        }
        expect(await tx.memoryDocument.count()).toBe(1);
      }),
    );
  });

  it("rejects reentrant system and downgraded tenant work without blocking an independent transaction", async () => {
    const independent = createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
    try {
      await runAsTenant(tenantA, () =>
        runtime!.prisma.$transaction(async (tx) => {
          await runAsSystemInTransaction(tx, "fixture owner scope", async () => {
            await expect(
              runAsSystemInTransaction(tx, "fixture nested system", async () => undefined),
            ).rejects.toThrow();
            await runAsTenant(tenantA, async () => {
              await expect(tx.memoryDocument.count()).rejects.toThrow();
              await expect(tx.$queryRaw`SELECT id FROM memory_documents`).rejects.toThrow();
              expect(
                await independent.prisma.$transaction((other) => other.memoryDocument.count()),
              ).toBe(1);
            });
            expect(await tx.memoryDocument.count()).toBe(2);
          });
          expect(await tx.memoryDocument.count()).toBe(1);
        }),
      );
    } finally {
      await close(independent);
    }
  });

  it("keeps nested SDK transaction scopes bound to the same physical ownership state", async () => {
    await runAsTenant(tenantA, () =>
      runtime!.prisma.$transaction(async (tx) => {
        const nested = Reflect.get(tx, "$transaction") as (
          callback: (child: typeof tx) => Promise<void>,
        ) => Promise<void>;
        await Reflect.apply(nested, tx, [
          async (child: typeof tx) => {
            expect(await child.memoryDocument.count()).toBe(1);
            await runAsSystemInTransaction(child, "fixture nested SDK transaction", async () => {
              expect(await child.memoryDocument.count()).toBe(2);
              expect(await tx.memoryDocument.count()).toBe(2);
            });
            expect(await child.memoryDocument.count()).toBe(1);
          },
        ]);
        expect(await tx.memoryDocument.count()).toBe(1);
      }),
    );
  });

  it("rejects system entry while a tenant query is paused in a later client extension", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const extended = runtime!.prisma.$extends({
      query: {
        memoryDocument: {
          async count({ args, query }) {
            entered();
            await gate;
            return query(args);
          },
        },
      },
    });
    await runAsTenant(tenantA, () =>
      extended.$transaction(async (tx) => {
        const tenantQuery = tx.memoryDocument.count().then((count) => count);
        try {
          await started;
          await expect(
            runAsSystemInTransaction(
              tx,
              "fixture overlapping an in-flight query",
              async () => undefined,
            ),
          ).rejects.toThrow();
        } finally {
          release();
        }
        expect(await tenantQuery).toBe(1);
        await runAsSystemInTransaction(tx, "fixture after the tenant query settles", async () => {
          expect(await tx.memoryDocument.count()).toBe(2);
        });
        expect(await tx.memoryDocument.count()).toBe(1);
      }),
    );
  });

  it("rejects transaction continuation after a system SQL failure", async () => {
    const rollback = new Error("fixture rollback after aborted system SQL");
    await expect(
      runAsTenant(tenantA, () =>
        runtime!.prisma.$transaction(async (tx) => {
          await expect(
            runAsSystemInTransaction(tx, "fixture aborted system statement", async () => {
              await tx.$queryRaw`SELECT 1 / 0`;
            }),
          ).rejects.toThrow();
          await expect(tx.memoryDocument.count()).rejects.toThrow();
          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);
    expect(await runAsTenant(tenantA, () => runtime!.prisma.memoryDocument.count())).toBe(1);
  });

  it("cannot read the protected key table or create schema objects", async () => {
    await expect(
      runtime!.prisma.$queryRaw`SELECT digest FROM cogine_private.rls_bypass_keys`,
    ).rejects.toThrow();
    await expect(
      runtime!.pool.query(`CREATE TABLE public."denied_${suffix}" (id integer)`),
    ).rejects.toThrow();
  });
});
