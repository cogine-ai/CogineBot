import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "./client.js";
import { eventsAfter } from "./events.js";
import type { HistoryScope } from "./history-retrieval.js";
import { readHistory } from "./history-retrieval.js";
import { storeToolResultHistory, TOOL_RESULT_HISTORY_MAX_BYTES } from "./tool-result-history.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled).sequential("tool result history (PostgreSQL)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const scope = {
    spaceId: "space",
    userId: "owner",
    threadId: "thread",
    botId: "bot",
    activeRunId: "run",
  };
  beforeAll(async () => {
    // Temporary synthetic tables shadow product tables; no existing data is inspected.
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: "pg_temp" }) });
    await pool.query(`
      CREATE TEMP TABLE bots (id text PRIMARY KEY, "spaceId" text, "userId" text, "archivedAt" timestamptz);
      CREATE TEMP TABLE threads (id text PRIMARY KEY, "spaceId" text, "userId" text, "botId" text, "groupId" text, "nextEventSeq" integer DEFAULT 0);
      CREATE TEMP TABLE chat_groups (id text PRIMARY KEY, "spaceId" text, "userId" text, "archivedAt" timestamptz);
      CREATE TEMP TABLE chat_group_members ("groupId" text, "botId" text);
      CREATE TEMP TABLE messages (id text PRIMARY KEY, "threadId" text, seq integer, role text, "runId" text, blocks jsonb);
      CREATE TEMP TABLE runs (id text PRIMARY KEY, "spaceId" text, "userId" text, "threadId" text, "botId" text, "sourceMessageId" text, status text, "startedAt" timestamptz);
      CREATE TEMP TABLE events (id text PRIMARY KEY, "spaceId" text, "threadId" text, "botId" text, seq integer, type text, payload jsonb, "toolResult" jsonb, "runId" text, "createdAt" timestamptz DEFAULT now());
      INSERT INTO bots VALUES ('bot','space','owner',NULL), ('peer','space','owner',NULL);
      INSERT INTO threads (id,"spaceId","userId","botId") VALUES ('thread','space','owner','bot');
      INSERT INTO messages VALUES ('source','thread',1,'user',NULL,'[{"kind":"channel_message","channelId":"channel-a","text":"Read synthetic items"}]');
      INSERT INTO runs VALUES ('run','space','owner','thread','bot','source','running',now());
    `);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });
  const store = (text: string, target = scope) =>
    storeToolResultHistory(prisma, target, { name: "connector.read", executionId: "call", text });
  async function read(
    toolResultId: string,
    target: HistoryScope = scope,
    textOffset = 0,
    viewHash?: string,
  ) {
    const page = await readHistory(prisma, target, { toolResultId, textOffset, viewHash });
    if (!("toolResult" in page)) throw new Error("Expected a result page");
    return page;
  }
  it("stores a complete large result privately and reconstructs bounded JSON pages", async () => {
    const original = JSON.stringify({
      id: "exact-id",
      nextCursor: 'cursor\\"value',
      content: 'line\n"quoted" 🧭'.repeat(3000),
    });
    const ref = await store(original);
    expect(ref?.tool).toBe("read_history");
    const id = ref!.arguments.toolResultId;
    let text = "";
    let offset = 0;
    let viewHash: string | undefined;
    for (;;) {
      const page = await read(id, scope, offset, viewHash);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(10_000);
      expect(page.toolResult).toMatchObject({
        toolResultId: id,
        storageTruncated: false,
        storedBytes: Buffer.byteLength(original),
        textOffset: offset,
      });
      text += page.toolResult!.text;
      if (!page.nextRead) break;
      expect(page.nextRead.textOffset).toBeGreaterThan(offset);
      offset = page.nextRead.textOffset;
      viewHash = page.nextRead.viewHash;
    }
    expect(text).toBe(original);
    expect(JSON.parse(text)).toEqual(JSON.parse(original));
    const events = await eventsAfter(prisma, scope.threadId, -1);
    expect(events.find((event) => event.id === id)).not.toHaveProperty("toolResult");
    expect(JSON.stringify(events)).not.toContain("exact-id");
    expect(events.find((event) => event.id === id)?.payload).toMatchObject({
      name: "connector.read",
      executionId: "call",
    });
  });
  it("does not issue a reference for over-cap results or mismatched run ownership", async () => {
    expect(await store(JSON.stringify("x".repeat(TOOL_RESULT_HISTORY_MAX_BYTES)))).toBeUndefined();
    expect(await store("{}", { ...scope, userId: "foreign" })).toBeUndefined();
    expect(await store("{}", { ...scope, botId: "peer" })).toBeUndefined();
  });
  it("rejects missing or changed view hashes before returning a continuation body", async () => {
    const id = (await store(JSON.stringify({ body: "source ".repeat(1000) })))!.arguments
      .toolResultId;
    const first = await read(id);
    expect(first.toolResult!.viewHash).toMatch(/^[a-f0-9]{64}$/);
    const missing = await read(id, scope, first.nextRead!.textOffset);
    expect(missing).toMatchObject({
      error: "cursor_conflict",
      toolResult: null,
      retry: { toolResultId: id, textOffset: 0 },
    });
    const stale = await read(id, scope, first.nextRead!.textOffset, "0".repeat(64));
    expect(stale).toMatchObject({ error: "cursor_conflict", toolResult: null, nextRead: null });
    expect(Buffer.byteLength(JSON.stringify(stale))).toBeLessThanOrEqual(10000);
  });
  it("fences owner, space, thread, bot, archived bot, channel and deleted references", async () => {
    const ref = (await store(JSON.stringify({ value: "scope-canary" })))!;
    const id = ref.arguments.toolResultId;
    for (const target of [
      { ...scope, userId: "foreign" },
      { ...scope, spaceId: "foreign" },
      { ...scope, threadId: "foreign" },
      { ...scope, botId: "peer" },
      { ...scope, channelId: "channel-b" },
    ])
      expect((await read(id, target)).toolResult).toBeNull();
    expect((await read(id, { ...scope, channelId: "channel-a" })).toolResult?.text).toContain(
      "scope-canary",
    );
    await pool.query(`UPDATE bots SET "archivedAt" = now() WHERE id = 'bot'`);
    expect((await read(id)).toolResult).toBeNull();
    await pool.query(`UPDATE bots SET "archivedAt" = NULL WHERE id = 'bot'`);
    await pool.query(`DELETE FROM events WHERE id = $1`, [id]);
    expect((await read(id)).toolResult).toBeNull();
  });
  it("rechecks group membership and never retrieves another bot's private result", async () => {
    await pool.query(`INSERT INTO chat_groups VALUES ('group','space','owner',NULL);
      INSERT INTO chat_group_members VALUES ('group','bot'), ('group','peer');
      INSERT INTO threads (id,"spaceId","userId","groupId") VALUES ('group-thread','space','owner','group');
      INSERT INTO messages VALUES ('group-source','group-thread',1,'user',NULL,'[{"kind":"text","text":"group input"}]');
      INSERT INTO runs VALUES ('group-run','space','owner','group-thread','bot','group-source','running',now());`);
    const groupScope = { ...scope, threadId: "group-thread", activeRunId: "group-run" };
    const id = (await store('{"value":"group-canary"}', groupScope))!.arguments.toolResultId;
    expect((await read(id, groupScope)).toolResult?.text).toContain("group-canary");
    expect((await read(id, { ...groupScope, botId: "peer" })).toolResult).toBeNull();
    await pool.query(
      `DELETE FROM chat_group_members WHERE "groupId" = 'group' AND "botId" = 'bot'`,
    );
    expect((await read(id, groupScope)).toolResult).toBeNull();
    await pool.query(
      `INSERT INTO chat_group_members VALUES ('group','bot'); UPDATE chat_groups SET "archivedAt" = now() WHERE id = 'group'`,
    );
    expect((await read(id, groupScope)).toolResult).toBeNull();
  });
  it("requires a surviving background output except for the server-owned active run", async () => {
    await pool.query(
      `INSERT INTO runs VALUES ('background','space','owner','thread','bot',NULL,'running',now());`,
    );
    const activeScope = { ...scope, activeRunId: "background" };
    const id = (await store('{"value":"background-canary"}', activeScope))!.arguments.toolResultId;
    expect((await read(id, activeScope)).toolResult?.text).toContain("background-canary");
    expect((await read(id)).toolResult).toBeNull();
    expect((await read(id, { ...activeScope, channelId: "channel-a" })).toolResult).toBeNull();
    await pool.query(
      `INSERT INTO messages VALUES ('background-output','thread',2,'bot','background','[{"kind":"text","text":"done"}]')`,
    );
    expect((await read(id)).toolResult?.text).toContain("background-canary");
    await pool.query(`DELETE FROM messages WHERE id = 'background-output'`);
    expect((await read(id)).toolResult).toBeNull();
  });
  it("does not read a result after its source message has been cleared", async () => {
    const id = (await store('{"value":"clear-canary"}'))!.arguments.toolResultId;
    await pool.query(`DELETE FROM messages WHERE id = 'source'`);
    expect((await read(id)).toolResult).toBeNull();
  });
});
