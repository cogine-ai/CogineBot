import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { rlsBypassKey, runAsSystemInTransaction, runAsTenant } from "./row-security.js";

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

  it("cannot read the protected key table or create schema objects", async () => {
    await expect(
      runtime!.prisma.$queryRaw`SELECT digest FROM cogine_private.rls_bypass_keys`,
    ).rejects.toThrow();
    await expect(
      runtime!.pool.query(`CREATE TABLE public."denied_${suffix}" (id integer)`),
    ).rejects.toThrow();
  });
});
