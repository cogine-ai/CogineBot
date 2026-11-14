import { PrismaPg } from "@prisma/adapter-pg";
import { HistorySearchInputSchema } from "@rakazo/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { createDb, PrismaClient } from "./client.js";
import {
  listHistorySources,
  readHistory,
  searchHistory,
  withCrossChatHistoryBudget,
} from "./history-retrieval.js";

const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const postgres = enabled ? describe.sequential : describe.skip;
postgres("history retrieval (PostgreSQL)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const messageColumns =
    '(id, "threadId", seq, role, "runId", "replyToMessageId", "createdAt", blocks)';
  const runColumns =
    '(id, "spaceId", "userId", "threadId", "botId", "sourceMessageId", status, "createdAt", "completedAt", "taskId", trigger, "updatedAt")';
  const artifactColumns =
    '(id, "spaceId", "userId", "botId", "groupId", "runId", name, "mimeType", size, "createdAt", hash, "storageKey")';
  const scope = {
    spaceId: "synthetic-space",
    userId: "synthetic-user",
    threadId: "synthetic-thread",
    botId: "synthetic-bot",
  };
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    const database = url.pathname.slice(1);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) <= 1024 ||
      ["host", "port", "dbname", "database"].some((key) => url.searchParams.has(key)) ||
      !/^integration_(0|[1-9][0-9]*)$/.test(database) ||
      database !== process.env.VERIFY_ISOLATED_DATABASE
    )
      throw new Error("History retrieval tests require an explicitly isolated harness database");

    // Prisma resolves Run and Artifact to public. Keep synthetic rows and the
    // production full-text index in the same rollback-scoped connection.
    pool = new Pool({ connectionString: url.toString(), max: 1, idleTimeoutMillis: 0 });
    const identity = await pool.query<{ database: string }>(
      "SELECT current_database() AS database",
    );
    if (identity.rows[0]?.database !== database)
      throw new Error("History retrieval fixture connection did not reach its isolated database");
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    await pool.query(`
      BEGIN;
      SET LOCAL search_path = public, pg_catalog;
      SET LOCAL TIME ZONE 'UTC';
      INSERT INTO "user" (id, name, email, "updatedAt")
        VALUES ('synthetic-user', 'History owner', 'synthetic-history@example.test', now());
      INSERT INTO organization (id, name, slug, "createdAt")
        VALUES ('synthetic-org', 'History organization', 'synthetic-history', now());
      INSERT INTO spaces (id, "organizationId", name, "createdByUserId")
        VALUES ('synthetic-space', 'synthetic-org', 'History space', 'synthetic-user');
      INSERT INTO bots (id, "spaceId", "userId", name, color, "updatedAt")
        VALUES ('synthetic-bot', 'synthetic-space', 'synthetic-user', 'History bot', '#000000', now());
      INSERT INTO threads (id, "spaceId", "userId", "botId")
        VALUES ('synthetic-thread', 'synthetic-space', 'synthetic-user', 'synthetic-bot');
      INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "updatedAt")
        VALUES ('synthetic-task', 'synthetic-space', 'synthetic-bot', 'synthetic-thread',
          'synthetic-user', 'Synthetic history', 'completed', now());
      INSERT INTO messages ${messageColumns} SELECT 'm-' || n, 'synthetic-thread', n, 'user', NULL, NULL,
        '2026-01-01'::timestamptz + n * interval '1 minute',
        jsonb_build_array(jsonb_build_object('kind','text','text', CASE WHEN n = 100 THEN 'exports use batching' ELSE 'filler exchange ' || n END))
        FROM generate_series(1,10000) n;
      ANALYZE messages;
    `);
  });
  afterAll(async () => {
    try {
      await pool?.query("ROLLBACK");
    } finally {
      await prisma?.$disconnect();
      await pool?.end();
    }
  });
  it.each([false, true])(
    "ends an active scan and preserves later checkouts with RLS=%s",
    async (rowSecurity) => {
      const { prisma: isolated, pool: ownedPool } = createDb(process.env.DATABASE_URL!, {
        poolMax: 1,
        rowSecurity,
      });
      const stop = new AbortController();
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let cancelledPid: number | undefined;
      const backendId = async (db: Pick<PrismaClient, "$queryRaw">) =>
        (await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      try {
        await expect(
          withCrossChatHistoryBudget(isolated, stop.signal, async (db) => {
            cancelledPid = await backendId(db);
            const query = db.$queryRaw`SELECT 1 FROM pg_sleep(10)`;
            stopTimer = setTimeout(() => stop.abort(new Error("History lookup stopped")), 50);
            return query;
          }),
        ).rejects.toThrow("History lookup stopped");
        expect(cancelledPid).toBeDefined();
        await expect
          .poll(
            async () =>
              (
                await isolated.$queryRaw<{ pid: number }[]>`
            SELECT pid FROM pg_stat_activity WHERE pid = ${cancelledPid}`
              ).length,
          )
          .toBe(0);
        const read = vi.fn();
        await expect(withCrossChatHistoryBudget(isolated, stop.signal, read)).rejects.toThrow();
        expect(read).not.toHaveBeenCalled();
        const completed = new AbortController();
        const pid = await withCrossChatHistoryBudget(isolated, completed.signal, backendId);
        completed.abort();
        expect(await backendId(isolated)).toBe(pid);
        await expect(
          withCrossChatHistoryBudget(
            isolated,
            new AbortController().signal,
            (db) => db.$queryRaw`SELECT 1 FROM pg_sleep(10)`,
          ),
        ).rejects.toThrow(/statement timeout/i);
      } finally {
        clearTimeout(stopTimer);
        await isolated.$disconnect();
        await ownedPool.end();
      }
    },
  );
  it("finds a distant fact in 10,000 messages using the full text index", async () => {
    const querySpy = vi.spyOn(prisma, "$queryRaw");
    const results = await searchHistory(prisma, scope, { query: "exports batching" });
    const authorizedQuery = querySpy.mock.calls[0]![0] as Prisma.Sql;
    querySpy.mockRestore();
    expect(results.messages.map((message) => message.messageId)).toEqual(["m-100"]);
    const explained = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${authorizedQuery.text}`,
      authorizedQuery.values,
    );
    const plan = explained.rows[0]["QUERY PLAN"][0];
    expect(JSON.stringify(plan)).toContain("messages_history_search_idx");
    expect(plan.Plan["Actual Rows"]).toBe(1);
    expect(plan["Planning Time"]).toBeGreaterThanOrEqual(0);
    expect(plan["Execution Time"]).toBeGreaterThanOrEqual(0);
    process.stdout.write(
      `Synthetic authorized 10k history search ${JSON.stringify({
        messages: 10000,
        index: "messages_history_search_idx",
        returnedRows: plan.Plan["Actual Rows"],
        planningMs: plan["Planning Time"],
        executionMs: plan["Execution Time"],
      })}\n`,
    );
  });
  it("keeps query-specific continuation available after a narrower empty query in the 10k corpus", async () => {
    await pool.query(`INSERT INTO messages ${messageColumns} SELECT 'continuation-' || n, 'synthetic-thread', n, 'user', NULL, NULL,
      '2026-01-01T00:00:00Z'::timestamptz,
      jsonb_build_array(jsonb_build_object('kind','text','text',CASE WHEN n = 13001
        THEN 'continuation original ORBIT-731' ELSE 'continuation broad topic' END))
      FROM generate_series(13001,13008) n`);
    const historicalScope = { ...scope, searchBeforeSeq: 13008 };
    const broad = await searchHistory(prisma, historicalScope, {
      query: " continuation ",
      beforeSeq: 999999,
      limit: 20,
      after: "2026-01-01T00:00:00Z",
      before: "2026-01-02T00:00:00Z",
    });
    expect(broad.messages.map((message) => message.seq)).toEqual([
      13007, 13006, 13005, 13004, 13003,
    ]);
    expect(broad.coverage.status).toBe("partial");
    expect(broad.nextSearch).toEqual({
      query: "continuation",
      beforeSeq: 13003,
      limit: 5,
      after: "2026-01-01T00:00:00Z",
      before: "2026-01-02T00:00:00Z",
    });
    const narrow = await searchHistory(prisma, historicalScope, {
      query: "continuation identifier",
    });
    expect(narrow).toMatchObject({
      query: "continuation identifier",
      messages: [],
      coverage: {
        scope: "requested_query_and_range",
        status: "exhausted",
      },
      nextSearch: null,
    });
    const older = await searchHistory(prisma, historicalScope, broad.nextSearch!);
    expect(older.messages.map((message) => message.seq)).toEqual([13002, 13001]);
    expect(older.messages[1]!.text).toContain("ORBIT-731");
    expect(older.coverage.status).toBe("exhausted");
    expect(
      (
        await readHistory(prisma, historicalScope, {
          messageId: older.messages[1]!.messageId,
          limit: 1,
        })
      ).messages[0]!.text,
    ).toContain("ORBIT-731");
    expect(
      (
        await searchHistory(
          prisma,
          { ...historicalScope, userId: "foreign-user" },
          broad.nextSearch!,
        )
      ).messages,
    ).toEqual([]);
    for (const page of [broad, narrow, older])
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(10000);
  });
  it("enforces the server search boundary, preserves old pagination and keeps explicit reads available", async () => {
    const historicalScope = { ...scope, searchBeforeSeq: 10 };
    const page = await searchHistory(prisma, historicalScope, {
      query: "filler exchange",
      limit: 3,
      beforeSeq: 999999,
    });
    expect(page.messages.map((message) => message.seq)).toEqual([9, 8, 7]);
    expect(page.nextBeforeSeq).toBe(7);
    const older = await searchHistory(prisma, historicalScope, {
      query: "filler exchange",
      limit: 3,
      beforeSeq: page.nextBeforeSeq!,
    });
    expect(older.messages.map((message) => message.seq)).toEqual([6, 5, 4]);
    const dated = await searchHistory(prisma, historicalScope, {
      query: "filler exchange",
      after: "2026-01-01T00:05:00Z",
      before: "2026-01-01T00:10:00Z",
      limit: 5,
    });
    expect(dated.messages.map((message) => message.seq)).toEqual([9, 8, 7, 6, 5]);
    expect(
      (
        await searchHistory(
          prisma,
          { ...scope, searchBeforeSeq: 0 },
          { query: "filler exchange", beforeSeq: 999999 },
        )
      ).messages,
    ).toEqual([]);
    // The cutoff belongs only to search: live explicit evidence and linked outcomes remain readable.
    expect(
      (await readHistory(prisma, historicalScope, { messageId: "m-10", limit: 1 })).messages[0]!
        .messageId,
    ).toBe("m-10");
  });
  it("uses UTC day boundaries and preserves offset instants with inclusive after and exclusive before", async () => {
    const day = await searchHistory(
      prisma,
      scope,
      HistorySearchInputSchema.parse({
        query: "filler exchange",
        after: "2026-01-01",
        before: "2026-01-02",
        limit: 3,
      }),
    );
    expect(day.messages.map((message) => message.seq)).toEqual([1439, 1438, 1437]);
    expect(day.nextSearch).toMatchObject({
      after: "2026-01-01T00:00:00.000Z",
      before: "2026-01-02T00:00:00.000Z",
    });
    const offset = await searchHistory(
      prisma,
      scope,
      HistorySearchInputSchema.parse({
        query: "filler exchange",
        after: "2026-01-02T02:00:00+02:00",
        before: "2026-01-02T02:03:00+02:00",
        limit: 5,
      }),
    );
    expect(offset.messages.map((message) => message.seq)).toEqual([1442, 1441, 1440]);
    expect(offset.nextSearch).toBeNull();
  });
  it("does not index credential prompts or tool metadata", async () => {
    await pool.query(`INSERT INTO messages ${messageColumns} VALUES
      ('secret-metadata','synthetic-thread',11000,'system',NULL,NULL,now(),
        '[{"kind":"secret_prompt","text":"synthetic credential needle"},{"kind":"progress","text":"hidden trace needle"}]')`);
    expect((await searchHistory(prisma, scope, { query: "needle" })).messages).toEqual([]);
  });
  it("indexes persisted subagent conclusions and retrieves them as linked outcomes", async () => {
    await pool.query(`INSERT INTO messages ${messageColumns} VALUES ('subagent-result','synthetic-thread',11999,'bot',NULL,NULL,now(),
      '[{"kind":"subagent","agentId":"synthetic-agent","name":"Research","task":"Inspect exports","status":"completed","result":"ledger-indexer produced aurora-investigation.txt"}]');`);
    const result = await searchHistory(prisma, scope, { query: "ledger-indexer" });
    expect(result.messages[0]!.text).toContain("ledger-indexer");
    expect(result.messages[0]!.text).toContain("aurora-investigation.txt");
  });
  it("finds an open task-only background investigation through its original-backed snapshot topic", async () => {
    await pool.query(`INSERT INTO runs ${runColumns} VALUES ('task-only-run','synthetic-space','synthetic-user','synthetic-thread',
        'synthetic-bot',NULL,'running',now(),NULL,'synthetic-task','manual',now());
      INSERT INTO messages ${messageColumns} VALUES ('task-only-message','synthetic-thread',11998,'bot','task-only-run',NULL,now(),
        '[{"kind":"subagent","agentId":"synthetic-agent","name":"Research","task":"Inspect quartz routing congestion","status":"running","result":""}]');`);
    const search = await searchHistory(prisma, scope, { query: "quartz routing congestion" });
    expect(search.messages.map((message) => message.messageId)).toEqual(["task-only-message"]);
    const read = await readHistory(prisma, scope, {
      messageId: search.messages[0]!.messageId,
      limit: 1,
    });
    expect(read.messages[0]!.text).toBe("Inspect quartz routing congestion");
    expect(read.snapshots[0]).toMatchObject({
      anchorMessageId: "task-only-message",
      topic: "Inspect quartz routing congestion",
      openRunIds: ["task-only-run"],
    });
    expect(read.runs[0]!.status).toBe("running");
    expect(
      (
        await searchHistory(
          prisma,
          { ...scope, channelId: "channel-a" },
          { query: "quartz routing congestion" },
        )
      ).messages,
    ).toEqual([]);
    await pool.query("DELETE FROM messages WHERE id = 'task-only-message'");
    expect(
      (await searchHistory(prisma, scope, { query: "quartz routing congestion" })).messages,
    ).toEqual([]);
  });
  it("retrieves source-less background work only through a surviving private output", async () => {
    await pool.query(`INSERT INTO runs ${runColumns} VALUES
      ('background-run','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot',NULL,'completed',now(),now(),'synthetic-task','manual',now());
      INSERT INTO messages ${messageColumns} VALUES ('background-result','synthetic-thread',12000,'bot','background-run',NULL,now(),
        '[{"kind":"text","text":"Background investigation complete"}]');`);
    const result = await readHistory(prisma, scope, { messageId: "background-result", limit: 1 });
    expect(result.runs.map((run) => run.id)).toEqual(["background-run"]);
    expect(
      (
        await readHistory(
          prisma,
          { ...scope, channelId: "channel-a" },
          { messageId: "background-result" },
        )
      ).runs,
    ).toEqual([]);
    await pool.query("DELETE FROM messages WHERE id = 'background-result'");
    expect((await readHistory(prisma, scope, { messageId: "background-result" })).runs).toEqual([]);
  });
  it("reads native group history only for owned member bots and scopes group artifacts", async () => {
    await pool.query(`INSERT INTO bots (id, "spaceId", "userId", name, color, "updatedAt")
        VALUES ('synthetic-outsider','synthetic-space','synthetic-user','Outside bot','#000000',now());
      INSERT INTO chat_groups (id, "spaceId", "userId", name, "updatedAt")
        VALUES ('synthetic-group','synthetic-space','synthetic-user','History group',now());
      INSERT INTO chat_group_members (id, "groupId", "botId")
        VALUES ('synthetic-member','synthetic-group','synthetic-bot');
      INSERT INTO threads (id, "spaceId", "userId", "groupId")
        VALUES ('synthetic-group-thread','synthetic-space','synthetic-user','synthetic-group');
      INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "updatedAt")
        VALUES ('synthetic-group-task','synthetic-space','synthetic-bot','synthetic-group-thread',
          'synthetic-user','Synthetic group history','completed',now());
      INSERT INTO messages ${messageColumns} VALUES
        ('group-source','synthetic-group-thread',0,'user',NULL,NULL,now(),'[{"kind":"text","text":"group exports"}]'),
        ('group-outcome','synthetic-group-thread',1,'bot','group-run',NULL,now(),'[{"kind":"text","text":"group exports done"}]');
      INSERT INTO runs ${runColumns} VALUES ('group-run','synthetic-space','synthetic-user','synthetic-group-thread',
        'synthetic-bot','group-source','completed',now(),now(),'synthetic-group-task','manual',now());
      INSERT INTO artifacts ${artifactColumns} VALUES ('group-artifact','synthetic-space','synthetic-user','synthetic-bot',
        'synthetic-group','group-run','group-report.txt','text/plain',10,now(),'fixture-hash','synthetic-storage-key');`);
    const groupScope = { ...scope, threadId: "synthetic-group-thread" };
    expect(
      (await searchHistory(prisma, groupScope, { query: "group exports" })).messages,
    ).toHaveLength(2);
    expect(
      (await readHistory(prisma, groupScope, { messageId: "group-source" })).runs[0]!.artifacts[0]!
        .id,
    ).toBe("group-artifact");
    expect(
      (
        await readHistory(
          prisma,
          { ...groupScope, botId: "synthetic-outsider" },
          { messageId: "group-source" },
        )
      ).messages,
    ).toEqual([]);
    expect(
      (
        await readHistory(
          prisma,
          { ...groupScope, userId: "outsider-user" },
          { messageId: "group-source" },
        )
      ).messages,
    ).toEqual([]);
    await pool.query("DELETE FROM messages WHERE id IN ('group-source','group-outcome')");
    expect((await readHistory(prisma, groupScope, { messageId: "group-source" })).runs).toEqual([]);
  });
  it("keeps complete JSON and pages all 50 linked runs, 100 artifacts and long original text", async () => {
    const original = `Original evidence\n${"長い\n".repeat(4000)}`;
    await pool.query(
      `INSERT INTO messages ${messageColumns} VALUES ('paging-source','synthetic-thread',15000,'user',NULL,NULL,now(), $1::jsonb)`,
      [JSON.stringify([{ kind: "text", text: original }])],
    );
    await pool.query(`
      INSERT INTO runs ${runColumns} SELECT 'paging-run-' || lpad(n::text,2,'0'), 'synthetic-space','synthetic-user',
        'synthetic-thread','synthetic-bot','paging-source','completed',now(),now(),'synthetic-task','manual',now()
        FROM generate_series(0,49) n;
      INSERT INTO artifacts ${artifactColumns} SELECT 'paging-artifact-' || lpad(n::text,3,'0'), 'synthetic-space','synthetic-user',
        'synthetic-bot',NULL,'paging-run-00','report-' || n || '.txt','text/plain',10,now(),'fixture-hash','synthetic-storage-key'
        FROM generate_series(0,99) n;
      INSERT INTO messages ${messageColumns} SELECT 'paging-outcome-' || n,'synthetic-thread',15001+n,'bot','paging-run-00',NULL,now(),
        jsonb_build_array(jsonb_build_object('kind','text','text', repeat('outcome evidence ',200))) FROM generate_series(0,29) n;
    `);
    const assertBounded = (result: unknown) => {
      const serialized = JSON.stringify(result);
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(10000);
      expect(JSON.parse(serialized)).toMatchObject({ untrusted: true });
      expect(serialized).not.toContain("storageKey");
    };
    const runIds = new Set<string>();
    let runAfterId: string | undefined;
    do {
      const page = await readHistory(prisma, scope, {
        messageId: "paging-source",
        limit: 1,
        runAfterId,
      });
      assertBounded(page);
      for (const run of page.runs) runIds.add(run.id);
      runAfterId = page.nextRunId ?? undefined;
    } while (runAfterId);
    expect(runIds.size).toBe(50);
    const artifactIds = new Set<string>();
    let artifactAfterId: string | undefined;
    do {
      const page = await readHistory(prisma, scope, {
        messageId: "paging-source",
        limit: 1,
        linkedRunId: "paging-run-00",
        artifactAfterId,
      });
      assertBounded(page);
      for (const artifact of page.runs.flatMap((run) => run.artifacts))
        artifactIds.add(artifact.id);
      artifactAfterId = page.nextArtifactId ?? undefined;
    } while (artifactAfterId);
    expect(artifactIds.size).toBe(100);
    const outcomeIds = new Set<string>();
    let outcomeAfterSeq: number | undefined;
    do {
      const page = await readHistory(prisma, scope, {
        messageId: "paging-source",
        limit: 1,
        linkedRunId: "paging-run-00",
        outcomeAfterSeq,
      });
      assertBounded(page);
      for (const outcome of page.runs.flatMap((run) => run.outcomes))
        outcomeIds.add(outcome.messageId);
      outcomeAfterSeq = page.nextOutcomeSeq ?? undefined;
    } while (outcomeAfterSeq !== undefined);
    expect(outcomeIds.size).toBe(30);
    let collected = "";
    let textOffset: number | undefined = 0;
    do {
      const page = await readHistory(prisma, scope, {
        messageId: "paging-source",
        textOffset,
        linkedRunId: "paging-run-00",
      });
      assertBounded(page);
      collected += page.messages[0]!.text;
      const next = page.messages[0]!.nextTextOffset ?? undefined;
      if (next !== undefined) expect(next).toBeGreaterThan(textOffset!);
      textOffset = next;
    } while (textOffset !== undefined);
    expect(collected).toBe(original);
    expect(
      (await readHistory(prisma, scope, { messageId: "m-1", linkedRunId: "paging-run-00" })).runs,
    ).toEqual([]);
  });
  it("searches original-backed snapshots and pages from a short source to linked outcomes and open work", async () => {
    await pool.query(`INSERT INTO messages ${messageColumns} VALUES ('navigation-source','synthetic-thread',16000,'user',NULL,NULL,now(),
      '[{"kind":"text","text":"Inspect the navigation canary"}]');
      INSERT INTO runs ${runColumns} VALUES ('navigation-open-run','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot',
        'navigation-source','running',now(),NULL,'synthetic-task','manual',now()),
        ('navigation-complete-run','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot',
        'navigation-source','completed',now(),now(),'synthetic-task','manual',now());
      INSERT INTO messages ${messageColumns} VALUES ('navigation-result','synthetic-thread',16001,'bot','navigation-complete-run',NULL,now(),
        '[{"kind":"subagent","task":"Inspect navigation","result":"Navigation diagnostic final result: ledger-indexer"}]');`);
    const search = await searchHistory(prisma, scope, { query: "navigation canary", limit: 1 });
    expect(search.messages[0]!.messageId).toBe("navigation-source");
    const source = await readHistory(prisma, scope, {
      messageId: search.messages[0]!.messageId,
      limit: 1,
    });
    expect(source.snapshots[0]).toMatchObject({
      anchorMessageId: "navigation-source",
      fromSeq: 16000,
      toSeq: 16000,
      source: "original",
      topic: "Inspect the navigation canary",
      openRunIds: ["navigation-open-run"],
    });
    expect(source.snapshots[0]!.outcome).toContain("ledger-indexer");
    const newer = await readHistory(prisma, scope, {
      messageId: source.newerMessageId!,
      direction: "newer",
      limit: 1,
    });
    expect(newer.snapshots[0]!.anchorMessageId).toBe("navigation-result");
    expect(newer.messages[0]!.text).toContain("ledger-indexer");
    expect(newer.runs[0]!.id).toBe("navigation-complete-run");
    await pool.query("UPDATE runs SET status = 'completed' WHERE id = 'navigation-open-run'");
    expect(
      (await readHistory(prisma, scope, { messageId: "navigation-source", limit: 1 })).snapshots[0]!
        .openRunIds,
    ).toEqual([]);
    await pool.query("DELETE FROM messages WHERE id IN ('navigation-source','navigation-result')");
    expect((await searchHistory(prisma, scope, { query: "navigation canary" })).messages).toEqual(
      [],
    );
  });
  it("keeps completed, failed and cancelled work distinct at the original reference", async () => {
    await pool.query(`INSERT INTO messages ${messageColumns} VALUES
      ('verification-source','synthetic-thread',16100,'user',NULL,NULL,now(),
        '[{"kind":"text","text":"Run the export verification triad"}]'),
      ('verification-outcome','synthetic-thread',16101,'bot',NULL,NULL,now(),
        '[{"kind":"text","text":"Verified two sample records."}]');
      INSERT INTO runs ${runColumns} VALUES
        ('verification-complete','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot',
         'verification-source','completed',now(),now(),'synthetic-task','manual',now()),
        ('verification-failed','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot',
         'verification-source','failed',now(),now(),'synthetic-task','manual',now()),
        ('verification-stopped','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot',
         'verification-source','cancelled',now(),now(),'synthetic-task','manual',now());
      UPDATE messages SET "runId" = 'verification-complete' WHERE id = 'verification-outcome';`);
    const matches = await searchHistory(prisma, scope, { query: "verification triad", limit: 1 });
    expect(matches.messages[0]!.messageId).toBe("verification-source");
    const evidence = await readHistory(prisma, scope, {
      messageId: matches.messages[0]!.messageId,
      limit: 1,
    });
    expect(evidence.runs).toMatchObject([
      {
        id: "verification-complete",
        status: "completed",
        outcomes: [{ messageId: "verification-outcome", text: "Verified two sample records." }],
      },
      { id: "verification-failed", status: "failed", outcomes: [] },
      { id: "verification-stopped", status: "cancelled", outcomes: [] },
    ]);
    expect(evidence.snapshots[0]).toMatchObject({
      anchorMessageId: "verification-source",
      openRunIds: [],
    });
    const failed = await readHistory(prisma, scope, {
      messageId: matches.messages[0]!.messageId,
      linkedRunId: "verification-failed",
      limit: 1,
    });
    expect(failed.runs).toMatchObject([
      { id: "verification-failed", status: "failed", outcomes: [] },
    ]);
  });

  it("checks ownership and excludes private history from channel retrieval", async () => {
    await pool.query(`
      INSERT INTO messages ${messageColumns} VALUES
        ('channel-source','synthetic-thread',10001,'user',NULL,NULL,now(),'[{"kind":"channel_message","channelId":"channel-a","text":"exports approved"}]'),
        ('channel-result','synthetic-thread',10002,'bot','run-a',NULL,now(),'[{"kind":"text","text":"exports completed"}]'),
        ('private-source','synthetic-thread',10003,'user',NULL,NULL,now(),'[{"kind":"text","text":"exports private"}]'),
        ('private-result','synthetic-thread',10004,'bot','run-private',NULL,now(),'[{"kind":"text","text":"exports confidential"}]');
      INSERT INTO runs ${runColumns} VALUES
        ('run-a','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot','channel-source','completed',now(),now(),'synthetic-task','manual',now()),
        ('run-private','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot','private-source','completed',now(),now(),'synthetic-task','manual',now());
    `);
    const channelScope = { ...scope, channelId: "channel-a" };
    expect(
      (await searchHistory(prisma, channelScope, { query: "exports" })).messages.map(
        (message) => message.messageId,
      ),
    ).toEqual(["channel-result", "channel-source"]);
    const read = await readHistory(prisma, channelScope, { messageId: "channel-source" });
    expect(read.messages.map((message) => message.messageId)).toEqual([
      "channel-source",
      "channel-result",
    ]);
    expect(read.runs.map((run) => run.id)).toEqual(["run-a"]);
    expect(read.runs[0]!.outcomes[0]!.text).toBe("exports completed");
    expect(
      (await searchHistory(prisma, { ...scope, userId: "outsider" }, { query: "exports" }))
        .messages,
    ).toEqual([]);
    expect(
      (await readHistory(prisma, channelScope, { messageId: "private-source" })).messages,
    ).toEqual([]);
    await pool.query("DELETE FROM messages WHERE id = 'channel-source'");
    expect((await searchHistory(prisma, channelScope, { query: "exports" })).messages).toEqual([]);
    expect(
      (await readHistory(prisma, channelScope, { messageId: "channel-result" })).messages,
    ).toEqual([]);
  });

  it("pages only owned active chats and rechecks the exact anchor, linked run and source visibility", async () => {
    await pool.query(`
      INSERT INTO "user" (id, name, email, "updatedAt")
        VALUES ('cross-other-user', 'Other owner', 'cross-other@example.test', now());
      INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
        VALUES ('cross-member', 'synthetic-org', 'synthetic-user', 'owner', now());
      INSERT INTO space_members (id, "spaceId", "organizationId", "userId", "createdAt")
        VALUES ('cross-space-member', 'synthetic-space', 'synthetic-org', 'synthetic-user', now());
      INSERT INTO spaces (id, "organizationId", name, "createdByUserId")
        VALUES ('cross-other-space', 'synthetic-org', 'Other Space', 'synthetic-user');
      INSERT INTO bots (id, "spaceId", "userId", name, color, "updatedAt", "archivedAt") VALUES
        ('cross-bot', 'synthetic-space', 'synthetic-user', 'Past bot', '#000000', now(), NULL),
        ('cross-archived', 'synthetic-space', 'synthetic-user', 'Archived bot', '#000000', now(), now()),
        ('cross-foreign', 'synthetic-space', 'cross-other-user', 'Foreign owner', '#000000', now(), NULL),
        ('cross-other-space-bot', 'cross-other-space', 'synthetic-user', 'Foreign Space', '#000000', now(), NULL);
      INSERT INTO chat_groups (id, "spaceId", "userId", name, "updatedAt", "archivedAt") VALUES
        ('cross-group', 'synthetic-space', 'synthetic-user', 'Project group', now(), NULL),
        ('cross-archived-group', 'synthetic-space', 'synthetic-user', 'Archived group', now(), now());
      INSERT INTO chat_group_members (id, "groupId", "botId")
        VALUES ('cross-group-member', 'cross-group', 'cross-bot'),
               ('cross-group-other-member', 'cross-group', 'synthetic-bot');
      INSERT INTO threads (id, "spaceId", "userId", "botId", "groupId") VALUES
        ('cross-thread', 'synthetic-space', 'synthetic-user', 'cross-bot', NULL),
        ('cross-archived-thread', 'synthetic-space', 'synthetic-user', 'cross-archived', NULL),
        ('cross-foreign-thread', 'synthetic-space', 'cross-other-user', 'cross-foreign', NULL),
        ('cross-other-space-thread', 'cross-other-space', 'synthetic-user', 'cross-other-space-bot', NULL),
        ('cross-group-thread', 'synthetic-space', 'synthetic-user', NULL, 'cross-group'),
        ('cross-archived-group-thread', 'synthetic-space', 'synthetic-user', NULL, 'cross-archived-group');
      INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "updatedAt")
        VALUES ('cross-task', 'synthetic-space', 'cross-bot', 'cross-thread',
          'synthetic-user', 'History evidence', 'completed', now());
      INSERT INTO messages ${messageColumns} VALUES
        ('cross-direct-hit','cross-thread',0,'user',NULL,NULL,'2026-02-01','[{"kind":"text","text":"crosscanary solar lunar"}]'),
        ('cross-direct-reply','cross-thread',1,'bot','cross-run',NULL,'2026-02-01','[{"kind":"text","text":"The solar plan is 37 units."}]'),
        ('cross-hidden-hit','cross-thread',3,'user','cross-hidden',NULL,'2026-02-01','[{"kind":"text","text":"crosscanary solar hidden"}]'),
        ('cross-group-hit','cross-group-thread',0,'user',NULL,NULL,'2026-02-01','[{"kind":"text","text":"crosscanary solar group"}]'),
        ('cross-future','cross-thread',2,'user',NULL,NULL,'2026-02-03','[{"kind":"text","text":"crosscanary solar future"}]'),
        ('cross-archived-hit','cross-archived-thread',0,'user',NULL,NULL,'2026-02-01','[{"kind":"text","text":"crosscanary solar archived"}]'),
        ('cross-archived-group-hit','cross-archived-group-thread',0,'user',NULL,NULL,'2026-02-01','[{"kind":"text","text":"crosscanary solar archived group"}]'),
        ('cross-foreign-hit','cross-foreign-thread',0,'user',NULL,NULL,'2026-02-01','[{"kind":"text","text":"crosscanary solar foreign"}]'),
        ('cross-other-space-hit','cross-other-space-thread',0,'user',NULL,NULL,'2026-02-01','[{"kind":"text","text":"crosscanary solar foreign space"}]');
      INSERT INTO runs ${runColumns} VALUES
        ('cross-run','synthetic-space','synthetic-user','cross-thread',
          'cross-bot','cross-direct-hit','completed','2026-02-01','2026-02-01','cross-task','user',now()),
        ('cross-hidden','synthetic-space','synthetic-user','cross-thread',
          'cross-bot','cross-direct-hit','completed','2026-02-01','2026-02-01','cross-task','tickets',now());
    `);
    const crossScope = { ...scope, allowMyChats: true, searchAt: new Date("2026-02-02") };
    const thisChatScope = {
      ...crossScope,
      searchAt: new Date("2027-01-01"),
      searchBeforeSeq: 100,
    };
    const currentReference = { threadId: scope.threadId, messageId: "m-100" };
    await expect(readHistory(prisma, thisChatScope, currentReference)).rejects.toThrow(
      "no longer available",
    );
    expect(
      await readHistory(prisma, { ...thisChatScope, searchBeforeSeq: 101 }, currentReference),
    ).toMatchObject({ anchor: currentReference });
    expect(
      (await readHistory(prisma, thisChatScope, { messageId: "m-100", limit: 1 })).messages,
    ).toHaveLength(1);
    const search = {
      scope: "my_chats",
      queries: ["crosscanary solar", "lunar"],
      botId: "cross-bot",
      kinds: ["user_messages"],
      limit: 1,
    } as const;
    const query = HistorySearchInputSchema.parse(search);
    const first = await searchHistory(prisma, crossScope, query);
    expect(first.messages).toMatchObject([
      { messageId: "cross-group-hit", chatName: "Project group", matchedQueryIndexes: [0] },
    ]);
    expect(first.nextSearch).toMatchObject({ ...query, offset: 1 });
    const second = await searchHistory(prisma, crossScope, first.nextSearch!);
    expect(second.messages).toMatchObject([
      { messageId: "cross-direct-hit", chatName: "Past bot", matchedQueryIndexes: [0, 1] },
    ]);
    expect(second.coverage.status).toBe("exhausted");
    expect(
      (await searchHistory(prisma, crossScope, { ...query, botId: undefined, limit: 5 })).messages,
    ).toHaveLength(2);
    await expect(searchHistory(prisma, scope, query)).rejects.toThrow("no longer available");
    await expect(
      searchHistory(prisma, { ...crossScope, channelId: "channel" }, query),
    ).rejects.toThrow("no longer available");

    const reference = { threadId: "cross-thread", messageId: "cross-direct-hit" };
    const read = await readHistory(prisma, crossScope, { ...reference, linkedRunId: "cross-run" });
    expect(read.runs).toMatchObject([
      { id: "cross-run", outcomes: [{ text: "The solar plan is 37 units." }] },
    ]);
    expect(read.messages.map(({ messageId }) => messageId)).not.toContain("cross-future");
    expect(
      (await readHistory(prisma, crossScope, { ...reference, linkedRunId: "run-private" })).runs,
    ).toEqual([]);
    await expect(
      readHistory(prisma, crossScope, { ...reference, threadId: "cross-group-thread" }),
    ).rejects.toThrow("no longer available");
    await expect(
      readHistory(prisma, crossScope, { ...reference, messageId: "cross-future" }),
    ).rejects.toThrow("no longer available");
    expect(
      await listHistorySources(prisma, scope, [
        reference,
        {
          threadId: "cross-foreign-thread",
          messageId: "cross-foreign-hit",
        },
      ]),
    ).toMatchObject([{ ...reference, chatName: "Past bot" }]);

    await pool.query("UPDATE bots SET \"archivedAt\" = now() WHERE id = 'cross-bot'");
    expect(await listHistorySources(prisma, scope, [reference])).toEqual([]);
    expect(
      await listHistorySources(prisma, scope, [
        {
          threadId: "cross-group-thread",
          messageId: "cross-group-hit",
        },
      ]),
    ).toEqual([]);
    await expect(readHistory(prisma, crossScope, reference)).rejects.toThrow("no longer available");
    expect((await searchHistory(prisma, crossScope, first.nextSearch!)).messages).toEqual([]);
    await pool.query("DELETE FROM space_members WHERE id = 'cross-space-member'");
    expect(
      (await searchHistory(prisma, crossScope, { ...query, botId: undefined })).messages,
    ).toEqual([]);
  });
});
