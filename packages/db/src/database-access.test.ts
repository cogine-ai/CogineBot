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
    unsafePrivileges: false,
  });
  return {
    ...actual,
    Client: class {
      user: string | undefined;
      password: string | undefined;
      constructor(config: { connectionString: string }) {
        const parsed = new actual.Client(config);
        this.user = parsed.user;
        this.password = parsed.password;
      }
      async connect() {}
      async end() {
        state.ownerClosed++;
      }
      async query(sql: string, values?: unknown[]) {
        state.sent.push({ sql, values });
        if (sql.includes("AS can"))
          return { rows: [{ can: state.canManage, superuser: state.canManage }], rowCount: 1 };
        if (sql.includes("AS member")) return { rows: [{ member: state.member }], rowCount: 1 };
        if (sql.includes("SELECT 1 FROM pg_roles")) return { rows: [{}], rowCount: 1 };
        if (sql.includes("FROM pg_catalog.pg_roles r")) {
          const name = values?.at(-1) as string;
          return {
            rows: name === "coginebot_app" || state.existing ? [privileges(name)] : [],
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
  Object.assign(state, {
    sent: [],
    ownerClosed: 0,
    poolClosed: 0,
    released: 0,
    existing: false,
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
    await expect(provisionRuntimeRole(owner, runtime)).resolves.toEqual({});
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
    expect(state.released).toBe(2);
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
    await expect(provisionRuntimeRole(owner, runtime)).resolves.toEqual({});
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
                role: RUNTIME_ROLE,
                sessionRole: RUNTIME_ROLE,
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
      role: RUNTIME_ROLE,
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
      role: RUNTIME_ROLE,
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
