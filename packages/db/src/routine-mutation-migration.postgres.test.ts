import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isolatedDatabaseUrl } from "@rakazo/db/testing/row-security-expectations";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROW_SECURITY_POLICIES } from "./row-security-policies.js";

const enabled = process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL;
const migration = readFileSync(
  new URL("../prisma/migrations/20261114000000_routine_mutations/migration.sql", import.meta.url),
  "utf8",
);
(enabled ? describe : describe.skip)("Routine receipt protected upgrade", () => {
  let db: Client;
  let schema: string;
  let role: string;
  let sql: string;
  beforeEach(async () => {
    db = new Client({ connectionString: isolatedDatabaseUrl() });
    await db.connect();
    expect((await db.query("SELECT current_database() AS name")).rows[0].name).toBe(
      process.env.VERIFY_ISOLATED_DATABASE,
    );
    const suffix = randomUUID().replaceAll("-", "");
    schema = `routine_upgrade_${suffix}`;
    role = `routine_runtime_${suffix}`;
    await db.query(
      `CREATE SCHEMA "${schema}"; CREATE ROLE "${role}"; GRANT USAGE ON SCHEMA "${schema}" TO "${role}"; ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${role}"; CREATE TABLE "${schema}".routines(id TEXT); INSERT INTO "${schema}".routines VALUES ('historical'); CREATE FUNCTION "${schema}".app_rls_bypass() RETURNS boolean LANGUAGE sql AS 'SELECT false'; ALTER TABLE "${schema}".routines ENABLE ROW LEVEL SECURITY; ALTER TABLE "${schema}".routines FORCE ROW LEVEL SECURITY;`,
    );
    sql = migration.replaceAll("public.", `"${schema}".`);
  });
  afterEach(async () => {
    if (!db) return;
    await db.query("ROLLBACK; RESET ROLE");
    if (schema && role)
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP ROLE IF EXISTS "${role}"`);
    await db.end();
  });
  it("installs exact user/Space policies atomically even with default runtime grants", async () => {
    await db.query(sql);
    const status = await db.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='routine_mutations'",
      [schema],
    );
    expect(status.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await db.query(
      "SELECT policyname, qual FROM pg_policies WHERE schemaname=$1 AND tablename='routine_mutations' ORDER BY policyname",
      [schema],
    );
    expect(policies.rows.map((r) => r.policyname)).toEqual([
      "routine_mutations_system",
      "routine_mutations_tenant",
    ]);
    const definition = ROW_SECURITY_POLICIES.find((p) => p.model === "RoutineMutation")!;
    // Compare PostgreSQL's canonical expressions, rather than whitespace in DDL.
    await db.query(
      `CREATE POLICY expected ON "${schema}".routine_mutations USING (${definition.tenantPredicate})`,
    );
    const expected = await db.query(
      "SELECT qual FROM pg_policies WHERE schemaname=$1 AND policyname='expected'",
      [schema],
    );
    expect(policies.rows[1].qual).toBe(expected.rows[0].qual);
    await db.query(`DROP POLICY expected ON "${schema}".routine_mutations`);
    await db.query(
      `INSERT INTO "${schema}".routine_mutations(id,"userId","spaceId","requestHash") VALUES ('a','owner','space-a','hash'),('b','other','space-a','hash'),('c','owner','space-b','hash')`,
    );
    await db.query(`SET ROLE "${role}"`);
    expect((await db.query(`SELECT id FROM "${schema}".routine_mutations`)).rows).toEqual([]);
    await db.query(
      "SELECT set_config('app.user_id','owner',false),set_config('app.space_id','space-a',false)",
    );
    expect((await db.query(`SELECT id FROM "${schema}".routine_mutations`)).rows).toEqual([
      { id: "a" },
    ]);
    await expect(
      db.query(
        `INSERT INTO "${schema}".routine_mutations(id,"userId","spaceId","requestHash") VALUES ('foreign','other','space-a','hash')`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await db.query(
      `INSERT INTO "${schema}".routine_mutations(id,"userId","spaceId","requestHash") VALUES ('own','owner','space-a','hash')`,
    );
    await db.query("RESET ROLE");
    expect((await db.query(`SELECT * FROM "${schema}".routines`)).rows).toEqual([
      { id: "historical" },
    ]);
  });
  it("rolls creation, policy installation and grants back on upgrade failure", async () => {
    await expect(
      db.query(sql.replace("COMMIT;", "SELECT no_such_upgrade_function(); COMMIT;")),
    ).rejects.toMatchObject({ code: "42883" });
    await db.query("ROLLBACK");
    expect(
      (await db.query("SELECT to_regclass($1) AS relation", [`${schema}.routine_mutations`])).rows,
    ).toEqual([{ relation: null }]);
    expect((await db.query(`SELECT * FROM "${schema}".routines`)).rows).toEqual([
      { id: "historical" },
    ]);
  });
});
