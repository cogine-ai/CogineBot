import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { messagingDeliverJob } from "@rakazo/adapter-kit";
import {
  applyRowSecurityPolicies,
  createDb,
  JOB_QUEUE_POLICY,
  provisionRuntimeRole,
  ROW_SECURITY_POLICIES,
  rlsBypassKey,
  verifyDatabaseRestore,
  verifyRealtimeDatabase,
  verifyRuntimeDatabase,
} from "@rakazo/db";
import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphileJobPublisher, GraphileJobWorkerHost, migrateJobQueue } from "./wakeup.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
const notReady =
  "The background job schema is not ready; run database migrations as the administrator";
const endpoints = ["publisher", "worker"] as const;

function handlers(received: string[] = []): BackgroundJobHandlers {
  const noop = async () => undefined;
  return {
    "native.source.poll": noop,
    "native.notion.signal": noop,
    "native.discord.signal": noop,
    "native.slack.signal": noop,
    "native.slack.lifecycle": noop,
    "run.continue": noop,
    "routine.wakeup": noop,
    "computer.update": noop,
    "computer.sleep": noop,
    "computer.control-expire": noop,
    "skill.teaching-expire": noop,
    "history.compact": noop,
    "messaging.deliver": async ({ runId }) => {
      received.push(runId!);
    },
    "cloud_agent.poll": noop,
  };
}

function schemaStatements(queries: string[]) {
  return queries.filter((sql) =>
    /(?:^|;)\s*(?:create|alter|drop|grant|revoke|truncate|comment)\b/i.test(
      sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\r\n]*/g, ""),
    ),
  );
}

function ledgerWrites(queries: string[]) {
  return queries.filter((sql) =>
    /\b(?:insert\s+into|update|delete\s+from)\s+"?graphile_worker"?\."?migrations"?\b/i.test(sql),
  );
}

postgres("restricted service startup against the prepared queue schema", () => {
  const suffix = randomBytes(10).toString("hex");
  const login = `startup_runtime_${suffix}`;
  const savedSchema = `startup_saved_${suffix}`;
  let owner: ReturnType<typeof createDb> | undefined;
  let runtime: ReturnType<typeof createDb> | undefined;
  let runtimeUrl: string;
  let grantRole: string | undefined;
  let createdGroup = false;
  let highestMigration: number;
  let queries: string[];

  const activeRuntime = () => {
    if (!runtime) throw new Error("The isolated runtime fixture was not started");
    return runtime;
  };

  beforeAll(async () => {
    const target = new Client({ connectionString: databaseUrl! });
    if (
      !["127.0.0.1", "localhost", "::1"].includes(target.host) ||
      !Number.isInteger(target.port) ||
      target.port <= 1024 ||
      typeof target.database !== "string" ||
      !/^integration_(0|[1-9][0-9]*)$/.test(target.database)
    )
      throw new Error("Service startup tests require the explicitly isolated harness database");

    owner = createDb(databaseUrl!);
    grantRole = (
      await owner.pool.query<{ name: string }>(
        "SELECT 'coginebot_app_' || oid::text AS name FROM pg_database WHERE datname=current_database()",
      )
    ).rows[0]!.name;
    createdGroup = !(await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [grantRole]))
      .rowCount;
    await migrateJobQueue(databaseUrl!);
    highestMigration = Number(
      (await owner.pool.query("SELECT max(id) AS id FROM graphile_worker.migrations")).rows[0].id,
    );
    expect(highestMigration).toBeGreaterThan(0);
    const url = new URL(databaseUrl!);
    url.username = login;
    url.password = randomBytes(24).toString("hex");
    url.searchParams.delete("user");
    url.searchParams.delete("password");
    runtimeUrl = url.toString();
    await provisionRuntimeRole(databaseUrl!, runtimeUrl);
  }, 120_000);

  beforeEach(() => {
    queries = [];
    runtime = createDb(runtimeUrl, { poolMax: 6, rowSecurity: true });
    runtime.pool.on("connect", (client) => {
      client.query = new Proxy(client.query, {
        apply(query, receiver, args) {
          const first = args[0];
          const sql = typeof first === "string" ? first : first?.text;
          if (typeof sql === "string") queries.push(sql);
          return Reflect.apply(query, receiver, args);
        },
      });
    });
  });

  afterEach(async () => {
    if (!runtime) return;
    try {
      await runtime.prisma.$disconnect();
    } finally {
      await runtime.pool.end();
      runtime = undefined;
    }
  });

  afterAll(async () => {
    if (!owner) return;
    const failures: unknown[] = [];
    const cleanup = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(async () => {
      if ((await owner!.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [login])).rowCount) {
        await owner!.pool.query(`DROP OWNED BY ${escapeIdentifier(login)}`);
        await owner!.pool.query(`DROP ROLE ${escapeIdentifier(login)}`);
      }
    });
    await cleanup(async () => {
      if (!createdGroup || !grantRole) return;
      if (
        !(await owner!.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [grantRole])).rowCount
      )
        return;
      const policies = await owner!.pool.query<{
        schema: string;
        table: string;
        policy: string;
      }>(
        `SELECT n.nspname AS schema, c.relname AS table, p.polname AS policy
         FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE p.polname=$1 AND $2::regrole::oid=ANY(p.polroles)`,
        [JOB_QUEUE_POLICY, grantRole],
      );
      for (const row of policies.rows)
        await owner!.pool.query(
          `DROP POLICY ${escapeIdentifier(row.policy)} ON ${escapeIdentifier(row.schema)}.${escapeIdentifier(row.table)}`,
        );
      await owner!.pool.query(`DROP OWNED BY ${escapeIdentifier(grantRole)}`);
      await owner!.pool.query(`DROP ROLE ${escapeIdentifier(grantRole)}`);
    });
    await cleanup(() => owner!.prisma.$disconnect());
    await cleanup(() => owner!.pool.end());
    if (failures.length)
      throw new AggregateError(failures, "Service startup fixture cleanup failed");
  });

  async function roundTrip() {
    const pool = activeRuntime().pool;
    const publisher = new GraphileJobPublisher(pool);
    const host = new GraphileJobWorkerHost(pool, { concurrency: 1, pollInterval: 25 });
    const received: string[] = [];
    try {
      await host.start(handlers(received));
      await publisher.enqueue(messagingDeliverJob(`startup-${suffix}`));
      await vi.waitFor(() => expect(received).toEqual([`startup-${suffix}`]), {
        timeout: 10_000,
        interval: 25,
      });
    } finally {
      await host.stop();
      await publisher.close();
    }
    expect(schemaStatements(queries)).toEqual([]);
    expect(ledgerWrites(queries)).toEqual([]);
  }

  async function rejectedStartup(endpoint: (typeof endpoints)[number], message: string | RegExp) {
    const pool = activeRuntime().pool;
    const publisher = new GraphileJobPublisher(pool);
    const host = new GraphileJobWorkerHost(pool, { concurrency: 1, pollInterval: 25 });
    let failure: unknown;
    try {
      if (endpoint === "publisher") await publisher.enqueue(messagingDeliverJob("unavailable"));
      else await host.start(handlers());
    } catch (error) {
      failure = error;
    } finally {
      await host.stop();
      await publisher.close().catch((error: unknown) => {
        expect(error).toBe(failure);
      });
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toEqual(
      typeof message === "string" ? message : expect.stringMatching(message),
    );
    expect(schemaStatements(queries)).toEqual([]);
    expect(ledgerWrites(queries)).toEqual([]);
  }

  it("cold-starts the publisher and worker without schema or migration-ledger writes", async () => {
    expect(
      (
        await activeRuntime().pool.query(`
          SELECT r.rolsuper, r.rolbypassrls,
            has_database_privilege(current_user,current_database(),'CREATE') AS "databaseCreate",
            has_schema_privilege(current_user,'graphile_worker','CREATE') AS "schemaCreate"
          FROM pg_roles r WHERE r.rolname=current_user`)
      ).rows,
    ).toEqual([
      { rolsuper: false, rolbypassrls: false, databaseCreate: false, schemaCreate: false },
    ]);
    await roundTrip();
  }, 20_000);

  it.each(endpoints)("refuses %s bootstrap when the queue schema is absent", async (endpoint) => {
    await owner!.pool.query(
      `ALTER SCHEMA graphile_worker RENAME TO ${escapeIdentifier(savedSchema)}`,
    );
    try {
      await rejectedStartup(endpoint, notReady);
      expect(
        (await owner!.pool.query("SELECT to_regnamespace('graphile_worker') AS schema")).rows,
      ).toEqual([{ schema: null }]);
    } finally {
      await owner!.pool.query(
        `ALTER SCHEMA ${escapeIdentifier(savedSchema)} RENAME TO graphile_worker`,
      );
    }
  });

  it.each(endpoints)("refuses %s startup when the migration ledger is behind", async (endpoint) => {
    const removed = (
      await owner!.pool.query<{ id: number; ts: Date; breaking: boolean }>(
        "DELETE FROM graphile_worker.migrations WHERE id=$1 RETURNING id,ts,breaking",
        [highestMigration],
      )
    ).rows[0]!;
    expect(removed).toBeDefined();
    try {
      await rejectedStartup(endpoint, notReady);
      expect(
        (
          await owner!.pool.query("SELECT 1 FROM graphile_worker.migrations WHERE id=$1", [
            highestMigration,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await owner!.pool.query(
        `INSERT INTO graphile_worker.migrations(id,ts,breaking) VALUES($1,$2,$3)
         ON CONFLICT(id) DO UPDATE SET ts=excluded.ts,breaking=excluded.breaking`,
        [removed.id, removed.ts, removed.breaking],
      );
    }
  });

  it.each(endpoints)("preserves the native future-breaking rejection for %s", async (endpoint) => {
    const previousExitCode = process.exitCode;
    await owner!.pool.query("INSERT INTO graphile_worker.migrations(id,breaking) VALUES($1,true)", [
      highestMigration + 1,
    ]);
    try {
      await rejectedStartup(endpoint, /includes breaking migration.*unsafe to continue/s);
      expect(process.exitCode).toBe(57);
    } finally {
      process.exitCode = previousExitCode;
      await owner!.pool.query("DELETE FROM graphile_worker.migrations WHERE id=$1", [
        highestMigration + 1,
      ]);
    }
  });

  it("retains the native compatible future-revision startup", async () => {
    await owner!.pool.query(
      "INSERT INTO graphile_worker.migrations(id,breaking) VALUES($1,false)",
      [highestMigration + 1],
    );
    try {
      await roundTrip();
    } finally {
      await owner!.pool.query("DELETE FROM graphile_worker.migrations WHERE id=$1", [
        highestMigration + 1,
      ]);
    }
  }, 20_000);

  describe.sequential("service database readiness", () => {
    const listenerLogin = `startup_listener_${suffix}`;
    let listenerUrl: string;
    let listenerOwned = false;
    let policiesOwned = false;
    const managedPolicies = ROW_SECURITY_POLICIES.flatMap((definition) => [
      ...(definition.tenantPredicate ? [`${definition.table}_tenant`] : []).map((policy) => ({
        table: definition.table,
        policy,
      })),
      { table: definition.table, policy: `${definition.table}_system` },
    ]);
    const serviceNotReady = "The service database role, policies, or system guard are not ready";
    const listenerNotReady = "The realtime database role, policies, or system guard are not ready";

    async function assertLegacyCatalog() {
      expect(
        (
          await owner!.pool.query(
            `SELECT p.polname FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
             JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await owner!.pool.query(
            `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity`,
          )
        ).rows,
      ).toEqual([]);
    }

    async function removeManagedPolicies() {
      if (!policiesOwned) return;
      for (const { table, policy } of managedPolicies)
        await owner!.pool.query(
          `DROP POLICY IF EXISTS ${escapeIdentifier(policy)} ON public.${escapeIdentifier(table)}`,
        );
      for (const { table } of ROW_SECURITY_POLICIES)
        await owner!.pool.query(
          `ALTER TABLE public.${escapeIdentifier(table)} DISABLE ROW LEVEL SECURITY`,
        );
      policiesOwned = false;
      await assertLegacyCatalog();
    }

    beforeAll(async () => {
      const target = new Client({ connectionString: databaseUrl! });
      if (
        process.env.VERIFY_ROW_SECURITY_POLICIES !== "harness_isolated" ||
        process.env.VERIFY_ROW_SECURITY_POLICIES_DATABASE !== target.database
      )
        throw new Error("Service readiness tests require the isolated policy harness opt-in");
      await assertLegacyCatalog();
      expect(ROW_SECURITY_POLICIES).toHaveLength(84);
      const url = new URL(databaseUrl!);
      url.username = listenerLogin;
      url.password = randomBytes(24).toString("hex");
      url.searchParams.delete("user");
      url.searchParams.delete("password");
      listenerUrl = url.toString();
      expect(
        (await owner!.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [listenerLogin])).rows,
      ).toEqual([]);
      listenerOwned = true;
      await provisionRuntimeRole(databaseUrl!, listenerUrl);
      policiesOwned = true;
      expect(await applyRowSecurityPolicies(databaseUrl!, runtimeUrl)).toMatchObject({
        expectedTables: 84,
        connectionEnforced: true,
      });
    }, 120_000);

    afterAll(async () => {
      try {
        await removeManagedPolicies();
      } finally {
        if (listenerOwned) {
          await owner!.pool.query(`DROP OWNED BY ${escapeIdentifier(listenerLogin)}`);
          await owner!.pool.query(`DROP ROLE ${escapeIdentifier(listenerLogin)}`);
          await owner!.pool.query(
            "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
            [rlsBypassKey(listenerUrl)],
          );
        }
      }
    }, 60_000);

    it("accepts the protected runtime and an independently authenticated realtime listener", async () => {
      expect(await verifyRuntimeDatabase(activeRuntime().prisma)).toMatchObject({
        expectedTables: 84,
        connectionEnforced: true,
        problems: [],
      });
      expect(new Client({ connectionString: listenerUrl }).user).not.toBe(login);
      await expect(verifyRealtimeDatabase(listenerUrl, true)).resolves.toBeUndefined();
    }, 20_000);

    it("refuses owner fallback for the protected main and realtime connections", async () => {
      await expect(verifyRuntimeDatabase(owner!.prisma)).rejects.toThrow(serviceNotReady);
      await expect(verifyRealtimeDatabase(databaseUrl!, true)).rejects.toThrow(serviceNotReady);
    }, 20_000);

    it("refuses a partially disabled policy set for both protected connections", async () => {
      await owner!.pool.query("ALTER TABLE public.messages DISABLE ROW LEVEL SECURITY");
      try {
        await expect(verifyRuntimeDatabase(activeRuntime().prisma)).rejects.toThrow(
          serviceNotReady,
        );
        await expect(verifyRealtimeDatabase(listenerUrl, true)).rejects.toThrow(serviceNotReady);
      } finally {
        await owner!.pool.query("ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY");
      }
      expect(await verifyRuntimeDatabase(activeRuntime().prisma)).toMatchObject({
        connectionEnforced: true,
      });
    }, 20_000);

    it("permits the unprotected legacy owner while refusing a listener that requires protection", async () => {
      await removeManagedPolicies();
      expect(await verifyRuntimeDatabase(owner!.prisma)).toMatchObject({
        expectedTables: 84,
        connectionEnforced: false,
        guardValid: true,
        legacyPolicyCount: 0,
      });
      await expect(verifyRealtimeDatabase(databaseUrl!, false)).resolves.toBeUndefined();
      await expect(verifyRealtimeDatabase(listenerUrl, true)).rejects.toThrow(listenerNotReady);
    }, 20_000);

    it("requires a prepared alternate listener before row-security enforcement", async () => {
      await removeManagedPolicies();
      const main = await verifyRuntimeDatabase(activeRuntime().prisma);
      expect(main).toMatchObject({
        expectedTables: 84,
        connectionEnforced: false,
        guardValid: true,
      });
      expect(main.problems).not.toContain("runtime-not-prepared");
      await expect(verifyRealtimeDatabase(listenerUrl, false, true)).resolves.toBeUndefined();
      await expect(verifyRealtimeDatabase(databaseUrl!, false, true)).rejects.toThrow(
        listenerNotReady,
      );
    }, 20_000);

    describe.sequential("normal readiness CLI", () => {
      async function verifyCli(realtime = listenerUrl) {
        try {
          const result = await promisify(execFile)("pnpm", ["db:row-security", "verify"], {
            cwd: path.resolve(import.meta.dirname, "../../.."),
            env: {
              ...process.env,
              DATABASE_URL: runtimeUrl,
              DATABASE_MIGRATION_URL: databaseUrl,
              REALTIME_DATABASE_URL: realtime,
            },
            encoding: "utf8",
            timeout: 30_000,
          });
          return { code: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const result = error as { code?: unknown; stdout?: string; stderr?: string };
          if (typeof result.code !== "number") throw error;
          return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
        }
      }

      function redacted(result: { stdout: string; stderr: string }) {
        const output = result.stdout + result.stderr;
        for (const url of [runtimeUrl, listenerUrl, databaseUrl!]) {
          expect(output).not.toContain(url);
          const password = new URL(url).password;
          if (password) expect(output).not.toContain(password);
        }
      }

      beforeAll(async () => {
        policiesOwned = true;
        expect(await applyRowSecurityPolicies(databaseUrl!, runtimeUrl)).toMatchObject({
          expectedTables: 84,
          connectionEnforced: true,
        });
      }, 120_000);

      it.each([true, false])(
        "accepts retained credentials without adopting strict restore inventory (RLS=%s)",
        async (enforced) => {
          if (!enforced) await removeManagedPolicies();
          const previous = new URL(runtimeUrl);
          previous.password = randomBytes(24).toString("hex");
          const retainedKey = rlsBypassKey(previous.toString());
          await owner!.pool.query(
            "INSERT INTO cogine_private.rls_bypass_keys(digest) VALUES(sha256(convert_to($1,'UTF8')))",
            [retainedKey],
          );
          try {
            const result = await verifyCli();
            expect(result.code, result.stderr).toBe(0);
            expect(result.stdout).toContain(
              enforced
                ? "Runtime database validation: row-level isolation verified"
                : "Runtime database validation: role and system key ready; row-level isolation is not enabled",
            );
            redacted(result);
            const heldOwner = owner!;
            const heldRuntime = runtime;
            owner = undefined;
            runtime = undefined;
            try {
              try {
                if (heldRuntime)
                  try {
                    await heldRuntime.prisma.$disconnect();
                  } finally {
                    await heldRuntime.pool.end();
                  }
              } finally {
                try {
                  await heldOwner.prisma.$disconnect();
                } finally {
                  await heldOwner.pool.end();
                }
              }
              await expect(
                verifyDatabaseRestore(databaseUrl!, [runtimeUrl, listenerUrl]),
              ).rejects.toThrow(
                "The restored database contains system keys outside the selected credential inventory",
              );
            } finally {
              owner = createDb(databaseUrl!);
            }
            expect(
              (
                await owner.pool.query(
                  "SELECT count(*)::int AS count FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
                  [retainedKey],
                )
              ).rows,
            ).toEqual([{ count: 1 }]);
          } finally {
            await owner!.pool.query(
              "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
              [retainedKey],
            );
          }
        },
        45_000,
      );

      it("rejects a missing selected system key even before row-security enforcement", async () => {
        await removeManagedPolicies();
        const removed = await owner!.pool.query<{ digest: Buffer }>(
          "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8')) RETURNING digest",
          [rlsBypassKey(runtimeUrl)],
        );
        expect(removed.rows).toHaveLength(1);
        try {
          const result = await verifyCli();
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("Runtime role preparation failed");
          redacted(result);
          expect(
            (
              await owner!.pool.query(
                "SELECT 1 FROM cogine_private.rls_bypass_keys WHERE digest=$1",
                [removed.rows[0]!.digest],
              )
            ).rows,
          ).toEqual([]);
        } finally {
          await owner!.pool.query("INSERT INTO cogine_private.rls_bypass_keys(digest) VALUES($1)", [
            removed.rows[0]!.digest,
          ]);
        }
      }, 40_000);

      it("rejects an unprepared owner listener independently of the prepared main connection", async () => {
        await removeManagedPolicies();
        const result = await verifyCli(databaseUrl!);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Database preparation failed");
        redacted(result);
      }, 40_000);
    });
  });
});
