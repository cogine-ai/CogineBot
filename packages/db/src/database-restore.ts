import { createHash } from "node:crypto";
import { Client, escapeLiteral } from "pg";
import { createDb } from "./client.js";
import { databaseUrls, RUNTIME_ROLE } from "./database-access.js";
import { Prisma } from "./generated/prisma/client.js";
import { installDbContext } from "./row-security.js";
import type { RowSecurityPolicyStatus } from "./row-security-policies.js";
import { describeRowSecurityPolicies } from "./row-security-policies.js";

async function withRestoreOwner<T>(
  migrationUrl: string,
  work: (owner: Client) => Promise<T>,
): Promise<T> {
  const urls = databaseUrls({ DATABASE_URL: migrationUrl });
  const owner = new Client({
    connectionString: urls.migrationUrl,
    connectionTimeoutMillis: 10_000,
  });
  let failed = false;
  let failure: unknown;
  let result: T | undefined;
  try {
    await owner.connect();
    await owner.query("SET lock_timeout = '10s'");
    await owner.query(
      "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended(pg_catalog.current_database() || ':coginebot-runtime-role-provision', 0))",
    );
    result = await work(owner);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await owner.end();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
  return result as T;
}

async function assertStoppedWriters(owner: Client): Promise<void> {
  const { rows } = await owner.query<{ busy: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_stat_activity
    WHERE datname = pg_catalog.current_database()
      AND backend_type = 'client backend' AND pid <> pg_catalog.pg_backend_pid()
  ) AS busy`);
  if (rows[0]?.busy !== false)
    throw new Error("Stop database writers before verifying the restored database");
}

function authorityFence(roles: readonly string[]): string {
  const selected = roles.map((role) => escapeLiteral(role)).join(", ");
  const body = `DECLARE
  selected text[] := ARRAY[${selected}]::text[];
  administrators text[] := ARRAY[current_user, session_user, 'pg_database_owner',
    (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())];
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_shdepend d
    JOIN pg_catalog.pg_roles r ON r.oid = d.refobjid
    WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND (d.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
        OR (d.dbid = 0 AND d.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
          AND d.objid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())))
      AND NOT (r.rolname = ANY(selected))
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(CASE WHEN pg_catalog.cardinality(c.relacl) > 0 THEN c.relacl END) a
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT COALESCE(r.rolname = ANY(administrators), false)
      AND (a.grantee = 0 OR NOT COALESCE(r.rolname = ANY(selected), false)
        OR a.is_grantable OR n.nspname = 'cogine_private'
        OR (c.relkind <> 'S' AND a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
        OR (c.relkind = 'S' AND a.privilege_type NOT IN ('USAGE', 'SELECT')
          AND NOT (n.nspname = 'graphile_worker' AND a.privilege_type = 'UPDATE')))
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute col
    JOIN pg_catalog.pg_class c ON c.oid = col.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(CASE WHEN pg_catalog.cardinality(col.attacl) > 0 THEN col.attacl END) a
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND col.attnum > 0 AND NOT col.attisdropped
      AND NOT COALESCE(r.rolname = ANY(administrators), false)
      AND (a.grantee = 0 OR NOT COALESCE(r.rolname = ANY(selected), false)
        OR a.is_grantable OR n.nspname = 'cogine_private'
        OR a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE'))
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(CASE WHEN pg_catalog.cardinality(n.nspacl) > 0 THEN n.nspacl END) a
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND NOT COALESCE(r.rolname = ANY(administrators), false)
      AND (a.is_grantable OR (a.privilege_type = 'CREATE' AND a.grantee = 0)
        OR (a.grantee <> 0 AND (NOT COALESCE(r.rolname = ANY(selected), false)
          OR a.privilege_type <> 'USAGE' OR n.nspname = 'cogine_private')))
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_database d
    CROSS JOIN LATERAL pg_catalog.aclexplode(CASE WHEN pg_catalog.cardinality(d.datacl) > 0 THEN d.datacl END) a
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE d.datname = pg_catalog.current_database()
      AND NOT COALESCE(r.rolname = ANY(administrators), false)
      AND (a.is_grantable OR a.privilege_type = 'CREATE'
        OR (a.grantee <> 0 AND NOT COALESCE(r.rolname = ANY(selected), false)))
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_default_acl d
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      CASE WHEN pg_catalog.cardinality(d.defaclacl) > 0 THEN d.defaclacl END) a
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE a.grantee <> d.defaclrole
      AND (d.defaclnamespace = 0 OR (n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') OR n.nspname = 'pg_catalog')
      AND NOT COALESCE(r.rolname = ANY(administrators), false)
      AND (a.is_grantable OR NOT (
        (d.defaclobjtype = 'f' AND a.privilege_type = 'EXECUTE')
        OR (d.defaclobjtype = 'T' AND a.privilege_type = 'USAGE')
        OR (a.grantee <> 0 AND r.rolname = ANY(selected) AND (
          (d.defaclobjtype = 'r' AND n.nspname IN ('public', 'graphile_worker')
            AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
          OR (d.defaclobjtype = 'S' AND n.nspname IN ('public', 'graphile_worker')
            AND (a.privilege_type IN ('USAGE', 'SELECT')
              OR (n.nspname = 'graphile_worker' AND a.privilege_type = 'UPDATE')))))))
  ) THEN
    RAISE EXCEPTION 'The restored database has authority outside the selected owner and runtime roles';
  END IF;
END;`;
  let suffix = 0;
  let delimiter = "$restore_authority_fence$";
  while (body.includes(delimiter)) delimiter = `$restore_authority_fence_${++suffix}$`;
  return `DO ${delimiter}\n${body}\n${delimiter};`;
}

async function selectedRestoreRoles(
  owner: Client,
  runtimeUrls: readonly string[],
): Promise<string[]> {
  const {
    rows: [identity],
  } = await owner.query<{
    current: string;
    session: string;
    databaseOwner: string;
    grantRole: string;
  }>(
    `SELECT current_user AS current, session_user AS session,
      pg_catalog.pg_get_userbyid(d.datdba) AS "databaseOwner",
      $1 || '_' || d.oid::text AS "grantRole"
      FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()`,
    [RUNTIME_ROLE],
  );
  if (!identity) throw new Error("Could not resolve the database runtime grant role");
  const roles = new Set([
    identity.current,
    identity.session,
    identity.databaseOwner,
    identity.grantRole,
    "pg_database_owner",
  ]);
  for (const url of new Set(runtimeUrls)) {
    const runtime = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
    if (!runtime.user) throw new Error("DATABASE_URL must name the runtime login");
    const { rows } = await owner.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [
      runtime.user,
    ]);
    if (rows.length === 0) {
      roles.add(runtime.user);
      continue;
    }
    try {
      await runtime.connect();
      const {
        rows: [actual],
      } = await runtime.query<{ current: string; session: string }>(
        "SELECT current_user AS current, session_user AS session",
      );
      if (!actual) throw new Error("The authenticated session role is unavailable");
      roles.add(actual.current);
      roles.add(actual.session);
    } finally {
      await runtime.end();
    }
  }
  return [...roles];
}

/** Native catalog check appended after restored SQL, within the same restore transaction. */
export async function databaseRestoreFence(
  migrationUrl: string,
  runtimeUrls: readonly string[] = [],
): Promise<string> {
  for (const url of runtimeUrls)
    databaseUrls({ DATABASE_URL: url, DATABASE_MIGRATION_URL: migrationUrl });
  return withRestoreOwner(migrationUrl, async (owner) => {
    await assertStoppedWriters(owner);
    const roles = await selectedRestoreRoles(owner, runtimeUrls);
    await assertStoppedWriters(owner);
    return authorityFence(roles);
  });
}

/** Create only the inert current-database grant role needed by same-role SQL restores. */
export async function prepareDatabaseRestore(
  migrationUrl: string,
  runtimeUrls: readonly string[] = [],
): Promise<void> {
  for (const url of runtimeUrls)
    databaseUrls({ DATABASE_URL: url, DATABASE_MIGRATION_URL: migrationUrl });
  await withRestoreOwner(migrationUrl, async (owner) => {
    await assertStoppedWriters(owner);
    const roles = await selectedRestoreRoles(owner, runtimeUrls);
    await owner.query(authorityFence(roles));
    await assertStoppedWriters(owner);
    const statement = Prisma.sql`SELECT ${RUNTIME_ROLE} || '_' || oid::text AS role
      FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()`;
    const { rows } = await owner.query<{ role: string }>(statement.text, statement.values);
    const role = rows[0]?.role;
    if (!role) throw new Error("Could not resolve the database runtime grant role");
    const existing = await owner.query<{ safe: boolean }>(
      `SELECT
      NOT (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb
        OR r.rolcreaterole OR r.rolreplication)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
        WHERE m.member = r.oid OR (m.roleid = r.oid AND m.member NOT IN (
          SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (current_user, session_user))))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend d
        WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
          AND d.refobjid = r.oid
          AND d.classid <> 'pg_catalog.pg_auth_members'::pg_catalog.regclass) AS safe
      FROM pg_catalog.pg_roles r WHERE r.rolname = $1`,
      [role],
    );
    if (existing.rows.length > 0) {
      if (existing.rows[0]?.safe !== true)
        throw new Error("The restore runtime grant role must be an unused restricted NOLOGIN role");
      return;
    }
    await owner.query(
      `CREATE ROLE ${owner.escapeIdentifier(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
  });
}

/** Verify restored role/key inventories and either exact RLS or a wholly unprotected legacy state. */
export async function verifyDatabaseRestore(
  migrationUrl: string,
  runtimeUrls: readonly string[],
): Promise<RowSecurityPolicyStatus> {
  if (runtimeUrls.length === 0) throw new Error("A selected runtime credential is required");
  for (const url of runtimeUrls)
    databaseUrls({ DATABASE_URL: url, DATABASE_MIGRATION_URL: migrationUrl });
  return withRestoreOwner(migrationUrl, async (owner) => {
    await assertStoppedWriters(owner);
    const { rows: identities } = await owner.query<{
      current: string;
      session: string;
      databaseOwner: string;
      grantRole: string;
    }>(
      `SELECT current_user AS current, session_user AS session,
      pg_catalog.pg_get_userbyid(d.datdba) AS "databaseOwner",
      $1 || '_' || d.oid::text AS "grantRole"
      FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()`,
      [RUNTIME_ROLE],
    );
    const identity = identities[0];
    if (!identity) throw new Error("Could not resolve the database runtime grant role");
    const selectedRoles = new Set([
      identity.current,
      identity.session,
      identity.databaseOwner,
      identity.grantRole,
      "pg_database_owner",
    ]);
    const selectedDigests = new Set<string>();
    let result: RowSecurityPolicyStatus | undefined;
    const { rows: policyCounts } = await owner.query<{
      count: number;
    }>(`SELECT count(*)::int AS count
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'cogine_pages', 'cogine_model_auth')`);
    for (const url of new Set(runtimeUrls)) {
      const { prisma, pool } = createDb(url, { poolMax: 1, rowSecurity: true });
      try {
        const key = await installDbContext(pool)();
        selectedDigests.add(createHash("sha256").update(key).digest("hex"));
        const [role] = await prisma.$queryRaw<Array<{ current: string; session: string }>>(
          Prisma.sql`SELECT current_user AS current, session_user AS session`,
        );
        if (!role) throw new Error("The authenticated session role is unavailable");
        selectedRoles.add(role.current);
        selectedRoles.add(role.session);
        const status = await describeRowSecurityPolicies(prisma);
        const legacy =
          policyCounts[0]?.count === 0 &&
          status.guardValid &&
          status.legacyPolicyCount === 0 &&
          status.problems.length === 0 &&
          status.tables.every((table) => table.present && !table.enabled);
        if (!status.connectionEnforced && !legacy)
          throw new Error("The restored database role, policies, or system guard are not ready");
        result ??= status;
      } finally {
        try {
          await prisma.$disconnect();
        } finally {
          await pool.end();
        }
      }
    }
    await owner.query(authorityFence([...selectedRoles]));
    const { rows: foreignRoles } = await owner.query<{ role: string }>(
      `SELECT DISTINCT r.rolname AS role
      FROM pg_catalog.pg_shdepend d JOIN pg_catalog.pg_roles r ON r.oid = d.refobjid
      WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND (d.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
          OR (d.dbid = 0 AND d.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
            AND d.objid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())))
        AND NOT (r.rolname = ANY($1::text[]))`,
      [[...selectedRoles]],
    );
    if (foreignRoles.length > 0)
      throw new Error(
        "The restored database has authority outside the selected owner and runtime roles",
      );
    const { rows: keys } = await owner.query<{ digest: string }>(
      "SELECT pg_catalog.encode(digest, 'hex') AS digest FROM cogine_private.rls_bypass_keys",
    );
    if (
      keys.length !== selectedDigests.size ||
      keys.some((key) => !selectedDigests.has(key.digest))
    )
      throw new Error(
        "The restored database contains system keys outside the selected credential inventory",
      );
    await assertStoppedWriters(owner);
    if (!result) throw new Error("A selected runtime credential is required");
    return result;
  });
}
