import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const migration = await readFile(
  new URL(
    "../prisma/migrations/20261021000000_model_connection_bindings/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describePostgres("model connection migration on predecessor rows", () => {
  let client: Client;
  let schema: string;
  beforeEach(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    schema = `binding_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
    // Only predecessor columns consumed by this migration are needed here.
    // The integration harness separately applies the complete migration chain.
    await client.query(`
      CREATE TABLE "user_model_credentials" ("id" TEXT PRIMARY KEY, "userId" TEXT, "provider" TEXT);
      CREATE TABLE "bots" ("id" TEXT, "userId" TEXT, "modelProvider" TEXT, "modelId" TEXT);
      CREATE TABLE "routines" (LIKE "bots");
      CREATE TABLE "steering_messages" (LIKE "bots");
      CREATE TABLE "runs" (LIKE "bots", "modelPinned" BOOLEAN);
      CREATE TABLE "usage_records" ("id" TEXT PRIMARY KEY, "provider" TEXT, "model" TEXT);
      CREATE TABLE "space_backup_models" ("spaceId" TEXT, "userId" TEXT, "provider" TEXT, "modelId" TEXT, "position" INT);
      CREATE UNIQUE INDEX "space_backup_models_spaceId_userId_provider_modelId_key"
        ON "space_backup_models" ("spaceId", "userId", "provider", "modelId");
      INSERT INTO "user_model_credentials" VALUES ('only', 'single', 'openai-compatible'), ('a', 'multiple', 'openai-compatible'), ('b', 'multiple', 'openai-compatible'), ('other', 'other-user', 'native');
      INSERT INTO "bots" VALUES ('unique', 'single', 'openai-compatible', 'same'), ('ambiguous', 'multiple', 'openai-compatible', 'same'), ('wrong-owner', 'single', 'native', 'same');
      INSERT INTO "routines" SELECT * FROM "bots";
      INSERT INTO "steering_messages" SELECT * FROM "bots";
      INSERT INTO "runs" SELECT *, TRUE FROM "bots";
      INSERT INTO "runs" VALUES ('unpinned', 'single', 'openai-compatible', 'same', FALSE);
      INSERT INTO "usage_records" VALUES ('legacy-call', 'openai-compatible', 'same');
      INSERT INTO "space_backup_models" VALUES ('space', 'multiple', 'openai-compatible', 'same', 0);
    `);
  });
  afterEach(async () => {
    if (!client) return;
    await client.query("ROLLBACK");
    await client.query(`SET search_path TO public; DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  it("binds only unique account/provider candidates and preserves ambiguous or unpinned rows", async () => {
    await client.query(migration);
    for (const table of ["bots", "routines", "steering_messages", "runs"]) {
      const result = await client.query(
        `SELECT "id", "modelCredentialId" FROM "${table}" ORDER BY "id"`,
      );
      expect(result.rows).toEqual([
        { id: "ambiguous", modelCredentialId: null },
        { id: "unique", modelCredentialId: "only" },
        ...(table === "runs" ? [{ id: "unpinned", modelCredentialId: null }] : []),
        { id: "wrong-owner", modelCredentialId: null },
      ]);
    }
    expect(
      (await client.query('SELECT DISTINCT "connectionRevision" FROM "user_model_credentials"'))
        .rows,
    ).toEqual([{ connectionRevision: 1 }]);
    expect((await client.query('SELECT * FROM "usage_records"')).rows).toEqual([
      { id: "legacy-call", provider: "openai-compatible", model: "same", modelCredentialId: null },
    ]);
  });

  it("permits the same backup model on different connections while rejecting the same binding twice", async () => {
    await client.query(migration);
    await client.query(
      `INSERT INTO "space_backup_models" VALUES ('space', 'multiple', 'openai-compatible', 'same', 1, 'a'), ('space', 'multiple', 'openai-compatible', 'same', 2, 'b')`,
    );
    await expect(
      client.query(
        `INSERT INTO "space_backup_models" VALUES ('space', 'multiple', 'openai-compatible', 'same', 3, 'a')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rolls back schema and backfill together if a later migration step fails", async () => {
    await expect(
      client.query(
        migration.replace(
          'DROP INDEX "space_backup_models_spaceId_userId_provider_modelId_key"',
          'DROP INDEX "missing_index"',
        ),
      ),
    ).rejects.toMatchObject({ code: "42704" });
    await client.query("ROLLBACK");
    const columns = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name IN ('modelCredentialId', 'connectionRevision')",
      [schema],
    );
    expect(columns.rows).toEqual([]);
    expect((await client.query('SELECT COUNT(*)::int AS count FROM "bots"')).rows).toEqual([
      { count: 3 },
    ]);
  });
});
