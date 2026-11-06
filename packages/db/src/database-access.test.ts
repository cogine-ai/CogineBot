import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  databaseUrls,
  describeRowSecurity,
  provisionRuntimeRole,
  RUNTIME_ROLE,
  scramSha256Verifier,
} from "./database-access.js";
import type { PrismaClient } from "./generated/prisma/client.js";

const state = vi.hoisted(() => ({
  sent: [] as Array<{ sql: string; values?: unknown[] }>,
  ownerClosed: 0,
  poolClosed: 0,
  released: 0,
  existing: false,
  groupExists: true,
  databaseOid: 42,
  foreignGroup: false,
  unsafePrivileges: false,
  privileged: false,
  member: true,
  canManage: true,
  authError: undefined as Error | undefined,
  registerError: undefined as Error | undefined,
}));
vi.mock("pg", async (importActual) => {
  const actual = await importActual<typeof import("pg")>();
  const privileges = (role: string) => ({
    role,
    sessionRole: role,
    hasRuntimeGrants: state.member,
    rolsuper: state.privileged,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    owns: false,
    unsafePrivileges: state.unsafePrivileges,
  });
  return {
    ...actual,
    Client: class {
      user: string | undefined;
      password: string | undefined;
      host: string;
      port: number;
      database: string | undefined;
      constructor(config: { connectionString: string }) {
        const parsed = new actual.Client(config);
        this.user = parsed.user;
        this.password = parsed.password;
        this.host = parsed.host;
        this.port = parsed.port;
        this.database = parsed.database;
      }
      async connect() {}
      async end() {
        state.ownerClosed++;
      }
      async query(sql: string, values?: unknown[]) {
        state.sent.push({ sql, values });
        if (sql.includes('AS "grantRole"'))
          return {
            rows: [
              { grantRole: `coginebot_app_${state.databaseOid}`, databaseOid: state.databaseOid },
            ],
          };
        if (sql.includes('AS "foreign"')) return { rows: [{ foreign: state.foreignGroup }] };
        if (sql.includes("AS can"))
          return { rows: [{ can: state.canManage, superuser: state.canManage }], rowCount: 1 };
        if (sql.includes("AS member")) return { rows: [{ member: state.member }], rowCount: 1 };
        if (sql.includes("SELECT 1 FROM pg_roles"))
          return { rows: state.groupExists ? [{}] : [], rowCount: state.groupExists ? 1 : 0 };
        if (/^CREATE ROLE "coginebot_app_\d+" NOLOGIN/.test(sql)) state.groupExists = true;
        if (sql.includes("FROM pg_catalog.pg_roles r")) {
          const name = values?.at(-1) as string;
          return {
            rows: (
              name === `coginebot_app_${state.databaseOid}`
                ? state.groupExists
                : state.existing
            )
              ? [privileges(name)]
              : [],
            rowCount: 1,
          };
        }
        if (sql.includes("INSERT INTO cogine_private") && state.registerError)
          throw state.registerError;
        return { rows: [], rowCount: 0 };
      }
    },
    Pool: class {
      options: object;
      private parsed: InstanceType<typeof actual.Client>;
      constructor(config: { connectionString: string }) {
        this.options = config;
        this.parsed = new actual.Client(config);
      }
      on() {
        return this;
      }
      async end() {
        state.poolClosed++;
      }
      async connect() {
        if (state.authError) throw state.authError;
        return {
          user: this.parsed.user,
          password: this.parsed.password,
          release() {
            state.released++;
          },
          async query(sql: string) {
            if (sql.includes("FROM pg_catalog.pg_roles r"))
              return { rows: [privileges("runtime")] };
            if (sql.includes("AS member")) return { rows: [{ member: state.member }] };
            return { rows: [] };
          },
        };
      }
    },
  };
});

beforeEach(() => {
  vi.stubEnv("PGPASSWORD", "");
  vi.stubEnv("PGUSER", "test-user");
  vi.stubEnv("PGHOST", "unit-host");
  vi.stubEnv("PGPORT", "5432");
  vi.stubEnv("PGDATABASE", "");
  Object.assign(state, {
    sent: [],
    ownerClosed: 0,
    poolClosed: 0,
    released: 0,
    existing: false,
    groupExists: true,
    databaseOid: 42,
    foreignGroup: false,
    unsafePrivileges: false,
    privileged: false,
    member: true,
    canManage: true,
    authError: undefined,
    registerError: undefined,
  });
});
afterEach(() => vi.unstubAllEnvs());
const owner = "postgres://migration:owner-password@db/coginebot";
const runtime = "postgres://runtime:secret@db/coginebot";

describe("database URLs", () => {
  it.each(["schema=shadow", "schema=public&schema=shadow", "schema="])(
    "rejects a non-public migration schema (%s) before child execution",
    (query) => {
      expect(() =>
        databaseUrls({
          DATABASE_MIGRATION_URL: `${owner}?${query}`,
          DATABASE_URL: runtime,
        }),
      ).toThrow("public schema");
      expect(state.sent).toEqual([]);
    },
  );

  it.each(["schema=public", "schema=shadow&schema=public", "schema=%70ublic"])(
    "accepts the effective public migration schema (%s)",
    (query) => {
      expect(() =>
        databaseUrls({ DATABASE_MIGRATION_URL: `${owner}?${query}`, DATABASE_URL: runtime }),
      ).not.toThrow();
    },
  );

  it("keeps schema query handling limited to the migration CLI", async () => {
    await expect(provisionRuntimeRole(`${owner}?schema=shadow`, runtime)).resolves.toBeUndefined();
  });

  it("rejects a different runtime database before preparing the owner target", () => {
    expect(() =>
      databaseUrls({
        DATABASE_URL: "postgres://runtime:secret@db/runtime-b",
        DATABASE_MIGRATION_URL: "postgres://migration:owner-password@db/owner-a",
      }),
    ).toThrow("same host, port, and database");
  });

  it.each([
    [
      "host",
      "postgres://migration:pw@one:5432/coginebot",
      "postgres://runtime:pw@two:5432/coginebot",
    ],
    [
      "port",
      "postgres://migration:pw@db:5432/coginebot",
      "postgres://runtime:pw@db:5433/coginebot",
    ],
    [
      "Unix socket case",
      "postgres://migration:pw@db:5432/coginebot?host=/tmp/Socket",
      "postgres://runtime:pw@db:5432/coginebot?host=/tmp/socket",
    ],
    [
      "Unix socket port",
      "postgres://migration:pw@db:5432/coginebot?host=/tmp/socket",
      "postgres://runtime:pw@db:5433/coginebot?host=/tmp/socket",
    ],
    [
      "same login, different database",
      "postgres://migration:pw@db:5432/one",
      "postgres://migration:pw@db:5432/two",
    ],
    [
      "unproven hostname aliases",
      "postgres://migration:pw@localhost:5432/coginebot",
      "postgres://runtime:pw@127.0.0.1:5432/coginebot",
    ],
  ])(
    "rejects mismatched %s before migration configuration is returned",
    (_kind, migrationUrl, runtimeUrl) => {
      expect(() =>
        databaseUrls({ DATABASE_URL: runtimeUrl, DATABASE_MIGRATION_URL: migrationUrl }),
      ).toThrow("same host, port, and database");
    },
  );

  it("uses the driver's final query host and port instead of URL authority", () => {
    expect(() =>
      databaseUrls({
        DATABASE_MIGRATION_URL: "postgres://migration:pw@db:5432/coginebot",
        DATABASE_URL:
          "postgres://runtime:pw@ignored:1111/coginebot?host=first&host=db&port=1111&port=5432",
      }),
    ).not.toThrow();
  });

  it("keeps pg-only provisioning defaults while rejecting ambiguous migration-owner defaults", async () => {
    vi.stubEnv("PGHOST", "db");
    vi.stubEnv("PGPORT", "6543");
    vi.stubEnv("PGDATABASE", "shared");
    const env = {
      DATABASE_MIGRATION_URL: "postgres://migration:owner-password@/",
      DATABASE_URL: "postgres://runtime:pw@db:6543/shared",
    };
    await expect(
      provisionRuntimeRole(env.DATABASE_MIGRATION_URL, env.DATABASE_URL),
    ).resolves.toBeUndefined();
    expect(() => databaseUrls(env)).toThrow(
      "migration URL target must match both database clients",
    );
    vi.stubEnv("PGDATABASE", "");
    expect(() =>
      databaseUrls({
        DATABASE_MIGRATION_URL: "postgres://migration:pw@db",
        DATABASE_URL: "postgres://runtime:pw@db",
      }),
    ).toThrow("same host, port, and database");
  });

  it("does not invent a database query override ignored by this driver", () => {
    expect(() =>
      databaseUrls({
        DATABASE_MIGRATION_URL: "postgres://migration:pw@db/shared",
        DATABASE_URL: "postgres://runtime:pw@db/different?database=shared",
      }),
    ).toThrow("same host, port, and database");
  });

  it("requires a concrete valid resolved port", () => {
    vi.stubEnv("PGPORT", "not-a-port");
    expect(() => databaseUrls({ DATABASE_MIGRATION_URL: owner, DATABASE_URL: runtime })).toThrow(
      "same host, port, and database",
    );
  });

  it("accepts matching Unix socket paths and ports without normalizing path case", () => {
    expect(() =>
      databaseUrls({
        DATABASE_MIGRATION_URL: "postgres://migration:pw@db:5432/shared?host=/tmp/Exact",
        DATABASE_URL: "postgres://runtime:pw@db:5432/shared?host=/tmp/Exact",
      }),
    ).not.toThrow();
  });

  it("rejects a standalone target mismatch before the owner connects or mutates", async () => {
    await expect(
      provisionRuntimeRole("postgres://migration:pw@db/one", "postgres://runtime:pw@db/two"),
    ).rejects.toThrow("same host, port, and database");
    expect(state.sent).toEqual([]);
    expect(state.ownerClosed).toBe(0);
    expect(state.poolClosed).toBe(0);
  });

  it("rejects a migration port interpreted differently by Prisma before child execution", () => {
    expect(() =>
      databaseUrls({
        DATABASE_MIGRATION_URL: "postgres://migration:pw@db:5432/shared?port=5433",
        DATABASE_URL: "postgres://runtime:pw@db:5433/shared",
      }),
    ).toThrow("migration URL target must match both database clients");
  });

  it("rejects implicit owner port defaults that pg and Prisma resolve differently", () => {
    vi.stubEnv("PGPORT", "6543");
    expect(() =>
      databaseUrls({
        DATABASE_MIGRATION_URL: "postgres://migration:pw@db/shared",
        DATABASE_URL: "postgres://runtime:pw@db/shared",
      }),
    ).toThrow("migration URL target must match both database clients");
  });

  it("rejects multi-segment and empty owner database paths before migration", () => {
    expect(() =>
      databaseUrls({
        DATABASE_MIGRATION_URL: "postgres://migration:pw@db/shared/nested",
        DATABASE_URL: "postgres://runtime:pw@db/shared/nested",
      }),
    ).toThrow("migration URL target must match both database clients");
    vi.stubEnv("PGDATABASE", "shared");
    expect(() =>
      databaseUrls({
        DATABASE_MIGRATION_URL: "postgres://migration:pw@db/",
        DATABASE_URL: "postgres://runtime:pw@db/shared",
      }),
    ).toThrow("migration URL target must match both database clients");
  });

  it("preserves the empty host-query distinction between the two database clients", () => {
    expect(() =>
      databaseUrls({
        DATABASE_MIGRATION_URL: "postgres://migration:pw@db/shared?host=",
        DATABASE_URL: "postgres://runtime:pw@db/shared",
      }),
    ).toThrow("migration URL target must match both database clients");
  });

  it("uses the resolved pg user for the shared-login compatibility path", () => {
    vi.stubEnv("PGUSER", "migration");
    expect(
      databaseUrls({ DATABASE_MIGRATION_URL: owner, DATABASE_URL: "postgres://db/coginebot" })
        .separate,
    ).toBe(false);
  });

  it("rejects an opaque migration URL instead of inventing a path segment", () => {
    vi.stubEnv("PGHOST", "localhost");
    expect(() =>
      databaseUrls({
        DATABASE_MIGRATION_URL: "postgres:relative",
        DATABASE_URL: "postgres://runtime:pw@localhost:5432/elative",
      }),
    ).toThrow("migration URL target must match both database clients");
  });

  it("requires a runtime URL and preserves a separate migration owner", () => {
    expect(() => databaseUrls({})).toThrow("DATABASE_URL");
    expect(databaseUrls({ DATABASE_URL: runtime, DATABASE_MIGRATION_URL: owner })).toEqual({
      url: runtime,
      migrationUrl: owner,
      separate: true,
    });
    expect(databaseUrls({ DATABASE_URL: runtime })).toEqual({
      url: runtime,
      migrationUrl: runtime,
      separate: false,
    });
  });
  it("uses the final pg query login override for the configuration hint", () => {
    expect(
      databaseUrls({
        DATABASE_URL: `${runtime}?user=first&user=migration`,
        DATABASE_MIGRATION_URL: owner,
      }).separate,
    ).toBe(false);
  });
});

describe("SCRAM verifier", () => {
  it("matches PostgreSQL's fixed salt verifier", () => {
    expect(
      scramSha256Verifier("app-password", Buffer.from("sTvbJ/EJNVLOgpmYdsR30Q==", "base64")),
    ).toBe(
      "SCRAM-SHA-256$4096:sTvbJ/EJNVLOgpmYdsR30Q==$KyaqWOivMwaMBR/m/ef/wkRtX2w6mPEhZg8xjgAKi/Y=:rGhNKb4nxeU9ipcVOm0JEOaPoHFJO2QHItj2UNOcVV4=",
    );
  });
  it("prepares Unicode before deriving the verifier", () => {
    expect(
      scramSha256Verifier("\uFB01\u00A0x", Buffer.from("n3PEXisxfO3xisw8EGkLvw==", "base64")),
    ).toBe(
      "SCRAM-SHA-256$4096:n3PEXisxfO3xisw8EGkLvw==$dHX8hzcpW/+6sZ5VFjapRaC+7GEk08wlDfKwwF0m+BU=:y2HSQo6LJdUG4Z+vmfVE1ItSGQ4qo4LeqKSY0Zn+mgM=",
    );
  });
});

describe("runtime role preparation", () => {
  it("registers only an authenticated effective key, preserving old digests and closing resources", async () => {
    await expect(provisionRuntimeRole(owner, runtime)).resolves.toBeUndefined();
    const insert = state.sent.find((entry) => entry.sql.includes("INSERT INTO cogine_private"));
    expect(insert?.values).toEqual([
      "e3ab53f78a8d87ee6f8476b690739dd5823af9545de951578b0c157049ce1cab",
    ]);
    expect(state.sent.some((entry) => /DELETE FROM .*rls_bypass_keys/.test(entry.sql))).toBe(false);
    expect(
      state.sent.find((entry) => entry.sql.startsWith('CREATE ROLE "runtime"'))?.sql,
    ).toContain("SCRAM-SHA-256$");
    expect(state.sent.map((entry) => entry.sql).join("\n")).not.toContain("PASSWORD 'secret'");
    expect(state.ownerClosed).toBe(1);
    expect(state.poolClosed).toBe(1);
    expect(state.released).toBe(3);
  });
  it("preserves an existing login's password when a different supplied credential fails authentication", async () => {
    state.existing = true;
    const failure = new Error("existing login password mismatch");
    state.authError = failure;
    await expect(provisionRuntimeRole(owner, runtime)).rejects.toBe(failure);
    expect(state.sent.some((entry) => /^\s*(?:CREATE|ALTER|GRANT|REVOKE)\b/m.test(entry.sql))).toBe(
      false,
    );
    expect(state.sent.some((entry) => /^ALTER ROLE .*PASSWORD/.test(entry.sql))).toBe(false);
    expect(state.sent.some((entry) => entry.sql.includes("INSERT INTO cogine_private"))).toBe(
      false,
    );
    expect(state.ownerClosed).toBe(1);
    expect(state.poolClosed).toBe(1);
  });

  it.each([false, true])(
    "rejects reuse of the administrator password before grants (existing=%s)",
    async (existing) => {
      state.existing = existing;
      await expect(
        provisionRuntimeRole(owner, "postgres://runtime:owner-password@db/coginebot"),
      ).rejects.toThrow("distinct passwords");
      expect(state.sent.some((entry) => /^(?:CREATE|ALTER|GRANT)\s/.test(entry.sql.trim()))).toBe(
        false,
      );
      expect(state.sent.some((entry) => entry.sql.includes("INSERT INTO cogine_private"))).toBe(
        false,
      );
      expect(state.ownerClosed).toBe(1);
    },
  );
  it("rejects an administrator password with an equivalent supported-client mapping", async () => {
    const equivalent = encodeURIComponent("\uff4fwner-password");
    await expect(
      provisionRuntimeRole(owner, `postgres://runtime:${equivalent}@db/coginebot`),
    ).rejects.toThrow("distinct passwords");
    expect(state.sent.some((entry) => /^(?:CREATE|ALTER|GRANT)\s/.test(entry.sql.trim()))).toBe(
      false,
    );
  });

  it("initializes the password when this invocation creates its grant role as the runtime login", async () => {
    state.groupExists = false;
    await expect(
      provisionRuntimeRole(owner, "postgres://coginebot_app_42:secret@db/coginebot"),
    ).resolves.toBeUndefined();
    expect(
      state.sent.some((entry) => entry.sql.startsWith('CREATE ROLE "coginebot_app_42" NOLOGIN')),
    ).toBe(true);
    expect(
      state.sent.find((entry) => entry.sql.startsWith('ALTER ROLE "coginebot_app_42"'))?.sql,
    ).toContain("PASSWORD 'SCRAM-SHA-256$");
  });

  it("does not recompute or replace an existing login verifier during successful preparation", async () => {
    state.existing = true;
    await expect(provisionRuntimeRole(owner, runtime)).resolves.toBeUndefined();
    expect(state.sent.some((entry) => entry.sql.startsWith('ALTER ROLE "runtime"'))).toBe(false);
    expect(state.sent.some((entry) => entry.sql.includes("INSERT INTO cogine_private"))).toBe(true);
  });

  it("does not register any digest when authentication fails", async () => {
    const failure = new Error("authentication failed");
    state.authError = failure;
    await expect(provisionRuntimeRole(owner, runtime)).rejects.toBe(failure);
    expect(state.sent.some((entry) => entry.sql.includes("INSERT INTO cogine_private"))).toBe(
      false,
    );
    expect(state.ownerClosed).toBe(1);
    expect(state.poolClosed).toBe(1);
  });
  it("rejects an empty effective credential instead of clearing the existing key store", async () => {
    state.existing = true;
    await expect(
      provisionRuntimeRole(owner, "postgres://runtime@db/coginebot?password="),
    ).rejects.toThrow("authenticated password");
    expect(
      state.sent.some((entry) => /(?:INSERT INTO|DELETE FROM) cogine_private/.test(entry.sql)),
    ).toBe(false);
    expect(state.ownerClosed).toBe(1);
    expect(state.poolClosed).toBe(1);
  });
  it("does not alter a privileged existing runtime login", async () => {
    state.existing = true;
    state.privileged = true;
    await expect(provisionRuntimeRole(owner, runtime)).rejects.toThrow("was not changed");
    expect(state.sent.some((entry) => /^(?:ALTER|CREATE) ROLE/.test(entry.sql))).toBe(false);
    expect(state.ownerClosed).toBe(1);
    expect(state.poolClosed).toBe(0);
  });
  it("cleans up after digest registration fails", async () => {
    const failure = new Error("registration denied");
    state.registerError = failure;
    await expect(provisionRuntimeRole(owner, runtime)).rejects.toBe(failure);
    expect(state.ownerClosed).toBe(1);
    expect(state.poolClosed).toBe(1);
  });
  it("keeps the managed precreated-role path without password mutation", async () => {
    state.existing = true;
    state.canManage = false;
    await expect(provisionRuntimeRole(owner, runtime)).resolves.toBeUndefined();
    expect(state.sent.some((entry) => entry.sql.startsWith('ALTER ROLE "runtime"'))).toBe(false);
    expect(state.sent.some((entry) => entry.sql.includes("INSERT INTO cogine_private"))).toBe(true);
  });
  it("blocks a managed login missing runtime grants", async () => {
    state.existing = true;
    state.canManage = false;
    state.member = false;
    await expect(provisionRuntimeRole(owner, runtime)).rejects.toThrow("Precreate");
    expect(state.sent.some((entry) => entry.sql.includes("INSERT INTO cogine_private"))).toBe(
      false,
    );
  });
});

describe("role and key status", () => {
  it("reports prepared role/key without claiming full production enforcement", async () => {
    const prisma = {
      $queryRaw: vi.fn(async (statement: { text: string }) =>
        statement.text.includes("pg_roles")
          ? [
              {
                role: `${RUNTIME_ROLE}_42`,
                sessionRole: `${RUNTIME_ROLE}_42`,
                hasRuntimeGrants: true,
                rolsuper: false,
                rolbypassrls: false,
                rolcreatedb: false,
                rolcreaterole: false,
                rolreplication: false,
                owns: false,
                unsafePrivileges: false,
              },
            ]
          : [{ ok: true }],
      ),
    } as unknown as PrismaClient;
    await expect(describeRowSecurity(prisma)).resolves.toMatchObject({
      prepared: true,
      enforced: false,
      role: `${RUNTIME_ROLE}_42`,
    });
  });
  it("does not report a registered-key login ready without inherited runtime grants", async () => {
    const prisma = {
      $queryRaw: vi.fn(async (statement: { text: string }) =>
        statement.text.includes("pg_roles")
          ? [
              {
                role: "nonmember",
                sessionRole: "nonmember",
                rolsuper: false,
                rolbypassrls: false,
                rolcreatedb: false,
                rolcreaterole: false,
                rolreplication: false,
                owns: false,
                unsafePrivileges: false,
                hasRuntimeGrants: false,
              },
            ]
          : [{ ok: true }],
      ),
    } as unknown as PrismaClient;
    await expect(describeRowSecurity(prisma)).resolves.toMatchObject({
      prepared: false,
      enforced: false,
      reason: "the execution role does not inherit runtime grants",
    });
  });

  it("does not hide a privileged authenticated session behind a restricted execution role", async () => {
    const restricted = {
      role: `${RUNTIME_ROLE}_42`,
      sessionRole: "administrator",
      hasRuntimeGrants: true,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      owns: false,
      unsafePrivileges: false,
    };
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([restricted])
        .mockResolvedValueOnce([{ ...restricted, role: "administrator", rolsuper: true }]),
    } as unknown as PrismaClient;
    await expect(describeRowSecurity(prisma)).resolves.toMatchObject({
      prepared: false,
      enforced: false,
      reason: "is a superuser",
    });
  });
});
