import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const migration = await readFile(
  new URL("../prisma/migrations/20261101070000_space_collaboration/migration.sql", import.meta.url),
  "utf8",
);

describePostgres("Space collaboration migration on predecessor deliveries", () => {
  let client: Client;
  let schema: string;
  beforeEach(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    schema = `collaboration_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
    // Predecessor columns used by the actual migration; the harness also runs the complete chain.
    await client.query(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY);
      CREATE TABLE bots (id TEXT PRIMARY KEY, "spaceId" TEXT, "userId" TEXT, "parentBotId" TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, "runId" TEXT, "botId" TEXT, "threadId" TEXT,
        role TEXT, blocks JSONB, seq BIGINT);
      CREATE TABLE runs (id TEXT PRIMARY KEY, "botId" TEXT, "userId" TEXT, "spaceId" TEXT,
        trigger TEXT, status TEXT, "startedAt" TIMESTAMP(3), "sourceMessageId" TEXT);
      INSERT INTO spaces VALUES ('a'), ('b');
      INSERT INTO bots VALUES ('sender','a','owner',NULL),('target','a','owner',NULL),
        ('external','b','other',NULL),('child','a','owner','sender');
      INSERT INTO messages VALUES
        ('sent','parent','sender','sender-thread','bot','[]',1),
        ('received',NULL,NULL,'target-thread','user',
          '[{"kind":"bot_message_received","fromBotId":"sender","returnToMessageId":"sent"}]',1),
        ('external-received',NULL,NULL,'external-thread','user',
          '[{"kind":"bot_message_received","fromBotId":"sender"}]',1),
        ('handoff','parent','sender','group-thread','bot',
          '[{"kind":"handoff","fromBotId":"sender","toBotId":"target"}]',2),
        ('human',NULL,NULL,'group-thread','user',
          '[{"kind":"handoff","fromBotId":"sender","toBotId":"target"}]',3);
      INSERT INTO runs VALUES
        ('parent','sender','owner','a','user','running',CURRENT_TIMESTAMP,NULL),
        ('peer','target','owner','a','bot_message','queued',NULL,'received'),
        ('external-peer','external','other','b','bot_message','leased',NULL,'external-received'),
        ('group','target','owner','a','follow_up','queued',NULL,'handoff'),
        ('manual','target','owner','a','follow_up','queued',NULL,'human'),
        ('child-prompt','child','owner','a','spawn','queued',NULL,NULL),
        ('historic','target','owner','a','bot_message','completed',CURRENT_TIMESTAMP,'received'),
        ('started','target','owner','a','bot_message','waiting_input',CURRENT_TIMESTAMP,'received'),
        ('unverifiable','target','owner','a','bot_message','queued',NULL,NULL);
    `);
  });
  afterEach(async () => {
    if (!client) return;
    await client.query("ROLLBACK");
    await client.query(`SET search_path TO public; DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  it("classifies only unfinished trusted deliveries and leaves human and historical work untouched", async () => {
    await client.query(migration);
    const rows = (
      await client.query(`
      SELECT id, origin, "parentRunId", "collaborationSourceSpaceId", "collaborationSourceBotId",
        "collaborationRevision", "collaborationStatus" FROM runs ORDER BY id
    `)
    ).rows;
    expect(rows).toEqual([
      {
        id: "child-prompt",
        origin: "child_prompt",
        parentRunId: null,
        collaborationSourceSpaceId: "a",
        collaborationSourceBotId: "sender",
        collaborationRevision: 0,
        collaborationStatus: "waiting_peer",
      },
      {
        id: "external-peer",
        origin: "external_agent",
        parentRunId: null,
        collaborationSourceSpaceId: "a",
        collaborationSourceBotId: "sender",
        collaborationRevision: 0,
        collaborationStatus: "waiting_peer",
      },
      {
        id: "group",
        origin: "group_handoff",
        parentRunId: "parent",
        collaborationSourceSpaceId: "a",
        collaborationSourceBotId: "sender",
        collaborationRevision: 0,
        collaborationStatus: "waiting_peer",
      },
      {
        id: "historic",
        origin: "human",
        parentRunId: null,
        collaborationSourceSpaceId: null,
        collaborationSourceBotId: null,
        collaborationRevision: null,
        collaborationStatus: null,
      },
      {
        id: "manual",
        origin: "human",
        parentRunId: null,
        collaborationSourceSpaceId: null,
        collaborationSourceBotId: null,
        collaborationRevision: null,
        collaborationStatus: null,
      },
      {
        id: "parent",
        origin: "human",
        parentRunId: null,
        collaborationSourceSpaceId: null,
        collaborationSourceBotId: null,
        collaborationRevision: null,
        collaborationStatus: null,
      },
      {
        id: "peer",
        origin: "bot_peer",
        parentRunId: "parent",
        collaborationSourceSpaceId: "a",
        collaborationSourceBotId: "sender",
        collaborationRevision: 0,
        collaborationStatus: "waiting_peer",
      },
      {
        id: "started",
        origin: "human",
        parentRunId: null,
        collaborationSourceSpaceId: null,
        collaborationSourceBotId: null,
        collaborationRevision: null,
        collaborationStatus: null,
      },
      {
        id: "unverifiable",
        origin: "bot_peer",
        parentRunId: null,
        collaborationSourceSpaceId: null,
        collaborationSourceBotId: null,
        collaborationRevision: null,
        collaborationStatus: "waiting_peer",
      },
    ]);
    expect(
      (await client.query('SELECT "allowBotCollaboration", "collaborationRevision" FROM spaces'))
        .rows,
    ).toEqual([
      { allowBotCollaboration: true, collaborationRevision: 0 },
      { allowBotCollaboration: true, collaborationRevision: 0 },
    ]);
  });

  it("rejects invalid origins instead of accepting caller-defined dispatch classes", async () => {
    await client.query(migration);
    await expect(
      client.query("UPDATE runs SET origin = 'model_claimed_human' WHERE id = 'peer'"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls back schema and provenance together when the migration transaction fails", async () => {
    await expect(client.query(`BEGIN;\n${migration}\nSELECT 1 / 0;`)).rejects.toMatchObject({
      code: "22012",
    });
    await client.query("ROLLBACK");
    expect(
      (
        await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name IN ('origin','allowBotCollaboration')",
          [schema],
        )
      ).rows,
    ).toEqual([]);
    expect((await client.query("SELECT status FROM runs WHERE id = 'peer'")).rows).toEqual([
      { status: "queued" },
    ]);
  });
});
