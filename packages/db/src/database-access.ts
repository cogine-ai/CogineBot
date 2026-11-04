import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { Client, escapeIdentifier, escapeLiteral } from "pg";
import { createPool } from "./client.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { Prisma } from "./generated/prisma/client.js";
import { databaseCredentials, installDbContext, runAsSystem } from "./row-security.js";

export const RUNTIME_ROLE = "coginebot_app";

export interface DatabaseUrls {
  url: string;
  migrationUrl: string;
  /** A configuration hint; actual role and key probes establish readiness. */
  separate: boolean;
}

export function databaseUrls(env: Record<string, string | undefined>): DatabaseUrls {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");
  const migrationUrl = env.DATABASE_MIGRATION_URL?.trim() || url;
  return {
    url,
    migrationUrl,
    separate: databaseCredentials(url).user !== databaseCredentials(migrationUrl).user,
  };
}

export const SINGLE_DATABASE_URL_WARNING =
  "The application and migrations share a database login. Row-level security is not enforced; use separate administrator and runtime logins before activation.";

type RolePrivileges = {
  role: string;
  sessionRole: string;
  hasRuntimeGrants: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  owns: boolean;
  unsafePrivileges: boolean;
};

function rolePrivileges(login?: string) {
  return Prisma.sql`SELECT r.rolname AS role, session_user AS "sessionRole", r.rolsuper, r.rolbypassrls,
    r.rolcreatedb, r.rolcreaterole, r.rolreplication,
    (EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'cogine_private', 'graphile_worker')
        AND pg_catalog.pg_has_role(r.oid, c.relowner, 'MEMBER'))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
        WHERE n.nspname IN ('public', 'cogine_private', 'graphile_worker')
          AND pg_catalog.pg_has_role(r.oid, n.nspowner, 'MEMBER'))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid = f.pronamespace
        WHERE n.nspname IN ('public', 'cogine_private', 'graphile_worker')
          AND pg_catalog.pg_has_role(r.oid, f.proowner, 'MEMBER'))) AS owns,
    EXISTS (SELECT 1 FROM pg_catalog.pg_roles p
      WHERE pg_catalog.pg_has_role(r.oid, p.oid, 'MEMBER') AND (
        p.rolsuper OR p.rolbypassrls OR p.rolcreatedb OR p.rolcreaterole OR p.rolreplication
        OR p.rolname IN ('pg_read_all_data', 'pg_write_all_data', 'pg_read_server_files',
          'pg_write_server_files', 'pg_execute_server_program')
        OR pg_catalog.has_database_privilege(p.oid, pg_catalog.current_database(), 'CREATE')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
          WHERE n.nspname IN ('public', 'cogine_private', 'graphile_worker') AND (
            pg_catalog.has_schema_privilege(p.oid, n.oid, 'CREATE')
            OR (n.nspname = 'cogine_private' AND pg_catalog.has_schema_privilege(p.oid, n.oid, 'USAGE'))))
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r','p','v','m','f')
            AND (n.nspname = 'cogine_private' OR (n.nspname = 'public' AND c.relname = '_prisma_migrations'))
            AND (pg_catalog.has_table_privilege(p.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              OR pg_catalog.has_any_column_privilege(p.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
      )) AS "unsafePrivileges",
    EXISTS (SELECT 1 FROM pg_catalog.pg_roles g WHERE g.rolname = ${RUNTIME_ROLE}
      AND pg_catalog.pg_has_role(r.oid, g.oid, 'USAGE')) AS "hasRuntimeGrants"
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = ${login === undefined ? Prisma.sql`current_user` : login}`;
}

function unsafeRole(role: RolePrivileges): string | undefined {
  if (role.rolsuper) return "is a superuser";
  if (role.rolbypassrls) return "has BYPASSRLS";
  if (role.rolcreatedb || role.rolcreaterole || role.rolreplication)
    return "has database or role administration privileges";
  if (role.owns) return "owns protected database objects or belongs to their owner role";
  if (role.unsafePrivileges) return "has inherited or additional protected database privileges";
  return undefined;
}

/** Prepare runtime grants and register only a successfully authenticated key.
 * This administration step does not activate table policies or request contexts. */
export async function provisionRuntimeRole(
  migrationUrl: string,
  runtimeUrl: string,
): Promise<{ warning?: string }> {
  const owner = new Client({ connectionString: migrationUrl });
  let runtime: ReturnType<typeof createPool> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    await owner.connect();
    await owner.query(
      "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended(pg_catalog.current_database() || ':coginebot-runtime-role-provision', 0))",
    );
    await provisionWith(owner, runtimeUrl);
    runtime = createPool(runtimeUrl, { poolMax: 1, rowSecurity: true });
    const resolveKey = installDbContext(runtime);
    const key = await resolveKey();
    const connected = await runtime.connect();
    try {
      const statement = rolePrivileges();
      const {
        rows: [role],
      } = await connected.query<RolePrivileges>(statement.text, statement.values);
      if (!role?.sessionRole || unsafeRole(role))
        throw new Error("The authenticated runtime role is not restricted");
      let session = role;
      if (role.sessionRole !== role.role) {
        const sessionStatement = rolePrivileges(role.sessionRole);
        const result = await connected.query<RolePrivileges>(
          sessionStatement.text,
          sessionStatement.values,
        );
        if (!result.rows[0]) throw new Error("The authenticated session role is unavailable");
        session = result.rows[0];
      }
      if (unsafeRole(session)) throw new Error("The authenticated session role is not restricted");
      if (!role.hasRuntimeGrants || !session.hasRuntimeGrants)
        throw new Error(
          "The runtime execution and session roles must inherit their required runtime grants",
        );
    } finally {
      connected.release();
    }
    // Keep active pools valid during rollout; retiring an old digest requires
    // first draining the instances that still use it.
    await owner.query(
      `INSERT INTO cogine_private.rls_bypass_keys(digest)
       VALUES (sha256(convert_to($1, 'UTF8'))) ON CONFLICT (digest) DO NOTHING`,
      [key],
    );
  } catch (error) {
    failed = true;
    failure = error;
  }
  const closed = await Promise.allSettled([runtime?.end(), owner.end()]);
  for (const result of closed) {
    if (!failed && result.status === "rejected") {
      failed = true;
      failure = result.reason;
    }
  }
  if (failed) throw failure;
  return {};
}

async function provisionWith(owner: Client, runtimeUrl: string): Promise<void> {
  const parsed = databaseCredentials(runtimeUrl);
  const configured = new Client({ connectionString: runtimeUrl });
  const login = configured.user;
  if (!login) throw new Error("DATABASE_URL must name the runtime login");
  const runtimeStatement = rolePrivileges(login);
  let {
    rows: [role],
  } = await owner.query<RolePrivileges>(runtimeStatement.text, runtimeStatement.values);
  if (role && unsafeRole(role))
    throw new Error(
      "The configured runtime role is privileged or owns application data; it was not changed",
    );
  const group = await owner.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [RUNTIME_ROLE]);
  if (!group.rowCount) {
    await owner
      .query(
        `CREATE ROLE ${RUNTIME_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
      )
      .catch((error: unknown) => {
        throw new Error(
          `Could not create ${RUNTIME_ROLE}; precreate a restricted runtime grant role or use a migration role with CREATEROLE`,
          { cause: error },
        );
      });
  }
  const grantStatement = rolePrivileges(RUNTIME_ROLE);
  const {
    rows: [grantRole],
  } = await owner.query<RolePrivileges>(grantStatement.text, grantStatement.values);
  if (!grantRole || unsafeRole(grantRole))
    throw new Error("The runtime grant role is not restricted");
  if (!role && login === RUNTIME_ROLE) role = grantRole;
  await owner.query(`
    GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE};
    DO $$ BEGIN
      IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
        REVOKE ALL ON TABLE public."_prisma_migrations" FROM ${RUNTIME_ROLE};
      END IF;
      IF to_regclass('public.security_events') IS NOT NULL THEN
        REVOKE UPDATE ON TABLE public."security_events" FROM ${RUNTIME_ROLE};
      END IF;
      IF to_regclass('public.audit_events') IS NOT NULL THEN
        REVOKE UPDATE ON TABLE public."audit_events" FROM ${RUNTIME_ROLE};
      END IF;
    END $$;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${RUNTIME_ROLE};
  `);
  await owner.query(
    `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${RUNTIME_ROLE}', current_database()); END $$`,
  );
  await grantJobQueue(owner);
  const {
    rows: [admin],
  } = await owner.query<{ can: boolean; superuser: boolean }>(
    "SELECT rolsuper OR rolcreaterole AS can, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
  );
  const provisioned =
    Boolean(role) &&
    (
      await owner.query<{ member: boolean }>("SELECT pg_has_role($1, $2, 'USAGE') AS member", [
        login,
        RUNTIME_ROLE,
      ])
    ).rows[0]?.member === true;
  const cannotChange = () =>
    new Error(
      `The migration role cannot create or change the runtime login. Precreate a LOGIN NOBYPASSRLS role and grant ${RUNTIME_ROLE}, then retry.`,
    );
  if (!admin?.can) {
    if (provisioned) return;
    throw cannotChange();
  }
  const password =
    parsed.password ||
    (!role && typeof configured.password === "string" ? configured.password : "");
  if (!role && !password)
    throw new Error(
      "A new runtime login requires an explicit password; precreate it when using external credential resolution",
    );
  const secret = password ? `PASSWORD ${escapeLiteral(scramSha256Verifier(password))}` : "";
  const limits = admin.superuser
    ? "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION"
    : "";
  const name = escapeIdentifier(login);
  try {
    if (!role) await owner.query(`CREATE ROLE ${name} LOGIN ${secret} ${limits}`);
    else await owner.query(`ALTER ROLE ${name} LOGIN ${secret} ${limits}`);
    if (login !== RUNTIME_ROLE) await owner.query(`GRANT ${RUNTIME_ROLE} TO ${name}`);
  } catch (error) {
    const denied = (error as { code?: string }).code === "42501";
    if (denied && provisioned) return;
    if (denied) throw Object.assign(cannotChange(), { cause: error });
    throw error;
  }
}

/**
 * The SCRAM-SHA-256 verifier PostgreSQL would store for `password`. Sending it
 * instead of the password keeps the plaintext out of server logs and audit trails.
 */
export function scramSha256Verifier(password: string, salt = randomBytes(16), iterations = 4096) {
  // SASLprep's mappings (RFC 4013), as PostgreSQL and pg apply them.
  const prepared = password
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(
      /\u00AD|\u034F|\u1806|[\u180B-\u180D]|\u200C|\u200D|\u2060|[\uFE00-\uFE0F]|\uFEFF/g,
      "",
    )
    .normalize("NFKC");
  const salted = pbkdf2Sync(prepared, salt, iterations, 32, "sha256");
  const hmac = (text: string) => createHmac("sha256", salted).update(text).digest();
  const storedKey = createHash("sha256").update(hmac("Client Key")).digest("base64");
  const serverKey = hmac("Server Key").toString("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

/** Policy on each graphile-worker table that lets the runtime role use the job queue. */
export const JOB_QUEUE_POLICY = "coginebot_app_queue";

/**
 * graphile-worker's schema is installed by the job queue migration that runs
 * just before this, so its grants cannot live in a Prisma migration.
 *
 * graphile-worker enables row-level security with no policies on its
 * `_private_*` tables. Their owner (the migration role) bypasses that; the
 * runtime role would see no jobs and could not add any. Queue access is an explicit
 * cross-tenant service capability; payloads can include normalized event content.
 * The policy is recreated on each run, for every table with
 * RLS on, so tables a graphile-worker upgrade adds or rebuilds are covered and a
 * hand-made policy of the same name is replaced by this definition.
 */
async function grantJobQueue(owner: Client): Promise<void> {
  await owner.query(`
    DO $$
    DECLARE
      queue_table regclass;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'graphile_worker') THEN
        RETURN;
      END IF;
      GRANT USAGE ON SCHEMA graphile_worker TO ${RUNTIME_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO ${RUNTIME_ROLE};
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA graphile_worker TO ${RUNTIME_ROLE};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO ${RUNTIME_ROLE};
      -- Skip tables that already have exactly this policy, so a deploy does not
      -- take the lock DROP and CREATE POLICY need on a busy queue.
      FOR queue_table IN
        SELECT c.oid FROM pg_class c
        WHERE c.relnamespace = 'graphile_worker'::regnamespace
          AND c.relkind IN ('r', 'p') AND c.relrowsecurity
          AND NOT EXISTS (
            SELECT 1 FROM pg_policy p
            WHERE p.polrelid = c.oid AND p.polname = '${JOB_QUEUE_POLICY}'
              AND p.polcmd = '*' AND p.polpermissive
              AND p.polroles = ARRAY['${RUNTIME_ROLE}'::regrole::oid]
              AND pg_get_expr(p.polqual, p.polrelid) = 'true'
              AND pg_get_expr(p.polwithcheck, p.polrelid) = 'true'
          )
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS ${JOB_QUEUE_POLICY} ON %s', queue_table);
        EXECUTE format(
          'CREATE POLICY ${JOB_QUEUE_POLICY} ON %s FOR ALL TO ${RUNTIME_ROLE} USING (true) WITH CHECK (true)',
          queue_table
        );
      END LOOP;
    END $$;
  `);
}

export interface RowSecurityStatus {
  /** Full production policy and entry activation is a later rollout stage. */
  enforced: boolean;
  prepared: boolean;
  role: string;
  reason?: string;
  systemBlocked?: boolean;
}

export async function describeRowSecurity(prisma: PrismaClient): Promise<RowSecurityStatus> {
  const [role] = await prisma.$queryRaw<RolePrivileges[]>(rolePrivileges());
  if (!role)
    return {
      enforced: false,
      prepared: false,
      role: "unknown",
      reason: "could not read the runtime role",
    };
  let reason = unsafeRole(role);
  if (!reason && !role.hasRuntimeGrants)
    reason = "the execution role does not inherit runtime grants";
  if (!reason && !role.sessionRole) reason = "could not read the authenticated session role";
  if (!reason && role.sessionRole !== role.role) {
    const [session] = await prisma.$queryRaw<RolePrivileges[]>(rolePrivileges(role.sessionRole));
    reason = !session
      ? "could not read the authenticated session role"
      : unsafeRole(session) ||
        (!session.hasRuntimeGrants
          ? "the session role does not inherit runtime grants"
          : undefined);
  }
  if (reason) return { enforced: false, prepared: false, role: role.role, reason };
  const [system] = await runAsSystem("check the registered database system key", () =>
    prisma.$queryRaw<Array<{ ok: boolean }>>(Prisma.sql`SELECT public.app_rls_bypass() AS ok`),
  );
  return {
    enforced: false,
    prepared: system?.ok === true,
    role: role.role,
    ...(system?.ok
      ? {
          reason:
            "role and key are ready; table policies and application contexts are not activated",
        }
      : { systemBlocked: true, reason: "the system key is not registered" }),
  };
}

export function rowSecurityWarning(status: RowSecurityStatus): string | undefined {
  if (status.enforced) return undefined;
  return `Row-level security is not enforced: ${status.reason ?? "runtime role preparation is incomplete"}.`;
}
