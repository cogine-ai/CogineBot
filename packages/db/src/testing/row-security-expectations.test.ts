import { Client } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { ROW_SECURITY_POLICIES } from "../row-security-policies.js";
import {
  expectExactPolicyCatalog,
  expectPhysicalPolicyTables,
  expectRegisteredPolicyTables,
  isolatedDatabaseUrl,
  schemaPolicyTables,
} from "./row-security-expectations.js";

it("detects missing, extra and count-preserving replacement registrations and tables", () => {
  expectRegisteredPolicyTables(ROW_SECURITY_POLICIES);
  expectPhysicalPolicyTables(schemaPolicyTables);
  for (const rows of [
    schemaPolicyTables.slice(1),
    [...schemaPolicyTables, { model: "Unknown", table: "unknown", schema: "public" }],
    [{ model: "Unknown", table: "unknown", schema: "public" }, ...schemaPolicyTables.slice(1)],
  ]) {
    expect(() => expectRegisteredPolicyTables(rows)).toThrow();
    expect(() => expectPhysicalPolicyTables(rows)).toThrow();
  }
});
it("rejects missing, extra and count-preserving replacement policies", () => {
  const rows = ROW_SECURITY_POLICIES.flatMap((p) => [
    { schema: p.schema ?? "public", relname: p.table, polname: `${p.table}_system` },
    ...(p.tenantPredicate
      ? [{ schema: p.schema ?? "public", relname: p.table, polname: `${p.table}_tenant` }]
      : []),
  ]);
  expectExactPolicyCatalog(rows);
  const extra = { schema: "public", relname: "routine_mutations", polname: "unexpected" };
  for (const changed of [rows.slice(1), [...rows, extra], [extra, ...rows.slice(1)]])
    expect(() => expectExactPolicyCatalog(changed)).toThrow();
});

afterEach(() => vi.unstubAllEnvs());
it("uses the locked pg parser offline to demonstrate authority overrides", () => {
  const client = new Client({
    connectionString:
      "postgres://localhost:5433/integration_1?host=remote.invalid&port=6543&database=other",
  }) as unknown as { host: string; port: number; database: string };
  expect(client.host).toBe("remote.invalid");
  expect(client.port).toBe(6543);
  // This locked parser overwrites query database from the path; do not claim otherwise.
  expect(client.database).toBe("integration_1");
});
it.each([
  "host=remote.invalid",
  "port=5432",
  "database=other",
  "dbname=other",
  "hostaddr=192.0.2.1",
  "service=other",
  "%68ost=remote.invalid",
  "host=localhost&host=remote.invalid",
  "port=5433&%70ort=6543",
  "host=%2Ftmp%2Fsynthetic",
  "database=integration_1&database=other",
  "HOST=remote.invalid",
  "host%2561ddr=192.0.2.1",
])("rejects query target ambiguity before any connect: %s", (query) => {
  vi.stubEnv("VERIFY_ISOLATED_DATABASE", "integration_1");
  vi.stubEnv("DATABASE_URL", `postgres://localhost:5433/integration_1?${query}`);
  const connect = vi.spyOn(Client.prototype, "connect");
  try {
    expect(() => isolatedDatabaseUrl()).toThrow("isolated harness");
    expect(connect).not.toHaveBeenCalled();
  } finally {
    connect.mockRestore();
  }
});
it.each(["localhost", "127.0.0.1", "[::1]"])(
  "accepts the plain official harness URL on %s",
  (host) => {
    const url = `postgres://fixture:synthetic@${host}:5433/integration_1`;
    vi.stubEnv("VERIFY_ISOLATED_DATABASE", "integration_1");
    vi.stubEnv("DATABASE_URL", url);
    expect(isolatedDatabaseUrl()).toBe(url);
  },
);
