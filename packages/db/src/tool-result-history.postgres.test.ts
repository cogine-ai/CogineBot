import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { escapeLiteral } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { eventsAfter } from "./events.js";
import type { HistoryScope } from "./history-retrieval.js";
import { readHistory } from "./history-retrieval.js";
import { storeToolResultHistory, TOOL_RESULT_HISTORY_MAX_BYTES } from "./tool-result-history.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled).sequential("tool result history (PostgreSQL)", () => {
  const suffix = randomUUID();
  const organizationId = `tool-result-org-${suffix}`;
  const sourceId = `tool-result-source-${suffix}`;
  const peerId = `tool-result-peer-${suffix}`;
  const groupId = `tool-result-group-${suffix}`;
  let pool: Pool;
  let prisma: PrismaClient;
  let seeded = false;
  const scope = {
    spaceId: `tool-result-space-${suffix}`,
    userId: `tool-result-owner-${suffix}`,
    threadId: `tool-result-thread-${suffix}`,
    botId: `tool-result-bot-${suffix}`,
    activeRunId: `tool-result-run-${suffix}`,
  };
  beforeAll(async () => {
    // Prisma addresses each model's schema explicitly. Use real tables in the
    // per-suite harness database and remove only the synthetic organization.
    const url = new URL(databaseUrl!);
    const database = url.pathname.slice(1);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) <= 1024 ||
      ["host", "port", "dbname", "database"].some((key) => url.searchParams.has(key)) ||
      !/^integration_(0|[1-9][0-9]*)$/.test(database) ||
      database !== process.env.VERIFY_ISOLATED_DATABASE
    )
      throw new Error("Tool result history tests require an isolated harness database");
    ({ pool, prisma } = createDb(databaseUrl!, { poolMax: 1 }));
    const identity = await pool.query<{ name: string }>("SELECT current_database() AS name");
    expect(identity.rows[0]?.name).toBe(database);
    await prisma.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: scope.userId,
          name: "Tool result fixture",
          email: `tool-result-${suffix}@example.test`,
        },
      });
      await tx.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          name: "Tool result fixture",
          createdAt: new Date(),
          spaces: { create: { id: scope.spaceId, name: "Tool result fixture" } },
        },
      });
      await tx.bot.createMany({
        data: [scope.botId, peerId].map((id) => ({
          id,
          spaceId: scope.spaceId,
          userId: scope.userId,
          name: "Tool result fixture",
          color: "ink",
        })),
      });
      await tx.thread.create({
        data: {
          id: scope.threadId,
          spaceId: scope.spaceId,
          userId: scope.userId,
          botId: scope.botId,
        },
      });
      await tx.message.create({
        data: {
          id: sourceId,
          threadId: scope.threadId,
          seq: 1,
          role: "user",
          blocks: [
            { kind: "channel_message", channelId: "channel-a", text: "Read synthetic items" },
          ],
        },
      });
      await createRun(tx, scope, sourceId);
    });
    seeded = true;
  });
  afterAll(async () => {
    try {
      if (seeded)
        await prisma.$transaction([
          prisma.organization.delete({ where: { id: organizationId } }),
          prisma.user.delete({ where: { id: scope.userId } }),
        ]);
    } finally {
      await prisma?.$disconnect();
      await pool?.end();
    }
  });
  async function createRun(
    db: Pick<PrismaClient, "task" | "run">,
    { activeRunId, spaceId, userId, threadId, botId }: typeof scope,
    sourceMessageId?: string,
  ) {
    const task = await db.task.create({
      data: { spaceId, userId, threadId, botId, prompt: "Tool result fixture", status: "running" },
    });
    await db.run.create({
      data: {
        id: activeRunId,
        spaceId,
        userId,
        threadId,
        botId,
        taskId: task.id,
        sourceMessageId,
        status: "running",
        trigger: "user",
        startedAt: new Date(),
      },
    });
  }
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
    expect(await store("{}", { ...scope, botId: peerId })).toBeUndefined();
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
      { ...scope, botId: peerId },
      { ...scope, channelId: "channel-b" },
    ])
      expect((await read(id, target)).toolResult).toBeNull();
    expect((await read(id, { ...scope, channelId: "channel-a" })).toolResult?.text).toContain(
      "scope-canary",
    );
    await prisma.bot.update({ where: { id: scope.botId }, data: { archivedAt: new Date() } });
    expect((await read(id)).toolResult).toBeNull();
    await prisma.bot.update({ where: { id: scope.botId }, data: { archivedAt: null } });
    await prisma.event.delete({ where: { id } });
    expect((await read(id)).toolResult).toBeNull();
  });
  it("rechecks group membership and never retrieves another bot's private result", async () => {
    const groupScope = {
      ...scope,
      threadId: `tool-result-group-thread-${suffix}`,
      activeRunId: `tool-result-group-run-${suffix}`,
    };
    await prisma.$transaction(async (tx) => {
      await tx.chatGroup.create({
        data: {
          id: groupId,
          spaceId: scope.spaceId,
          userId: scope.userId,
          name: "Tool result group",
          members: { create: [scope.botId, peerId].map((botId) => ({ botId })) },
        },
      });
      await tx.thread.create({
        data: { id: groupScope.threadId, spaceId: scope.spaceId, userId: scope.userId, groupId },
      });
      const source = await tx.message.create({
        data: {
          threadId: groupScope.threadId,
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: "group input" }],
        },
      });
      await createRun(tx, groupScope, source.id);
    });
    const id = (await store('{"value":"group-canary"}', groupScope))!.arguments.toolResultId;
    expect((await read(id, groupScope)).toolResult?.text).toContain("group-canary");
    expect((await read(id, { ...groupScope, botId: peerId })).toolResult).toBeNull();
    await prisma.chatGroupMember.delete({
      where: { groupId_botId: { groupId, botId: scope.botId } },
    });
    expect((await read(id, groupScope)).toolResult).toBeNull();
    await prisma.chatGroup.update({
      where: { id: groupId },
      data: { archivedAt: new Date(), members: { create: { botId: scope.botId } } },
    });
    expect((await read(id, groupScope)).toolResult).toBeNull();
  });
  it("requires a surviving background output except for the server-owned active run", async () => {
    const activeScope = { ...scope, activeRunId: `tool-result-background-${suffix}` };
    await createRun(prisma, activeScope);
    const id = (await store('{"value":"background-canary"}', activeScope))!.arguments.toolResultId;
    expect((await read(id, activeScope)).toolResult?.text).toContain("background-canary");
    expect((await read(id)).toolResult).toBeNull();
    expect((await read(id, { ...activeScope, channelId: "channel-a" })).toolResult).toBeNull();
    const output = await prisma.message.create({
      data: {
        threadId: scope.threadId,
        seq: 2,
        role: "bot",
        runId: activeScope.activeRunId,
        blocks: [{ kind: "text", text: "done" }],
      },
    });
    expect((await read(id)).toolResult?.text).toContain("background-canary");
    await prisma.message.delete({ where: { id: output.id } });
    expect((await read(id)).toolResult).toBeNull();
  });
  it("rolls back private results and event sequence on storage cancellation", async () => {
    const controller = new AbortController();
    const before = await pool.query('SELECT "nextEventSeq" FROM threads WHERE id = $1', [
      scope.threadId,
    ]);
    const aborting = prisma.$extends({
      query: {
        event: {
          async update({ args, query }) {
            const result = await query(args);
            controller.abort(new Error("storage cancelled"));
            return result;
          },
        },
      },
    });
    await expect(
      storeToolResultHistory(aborting as unknown as PrismaClient, scope, {
        name: "connector.read",
        executionId: "abort-private-write",
        text: '{"value":"must-roll-back"}',
        signal: controller.signal,
      }),
    ).rejects.toThrow("storage cancelled");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM events WHERE payload->>'executionId' = $1",
          ["abort-private-write"],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query('SELECT "nextEventSeq" FROM threads WHERE id = $1', [scope.threadId])).rows,
    ).toEqual(before.rows);
  });

  it("bounds slow SQL on the server and rolls back partial storage writes", async () => {
    const before = await pool.query('SELECT "nextEventSeq" FROM threads WHERE id = $1', [
      scope.threadId,
    ]);
    const slowWrite = `tool_result_slow_${suffix.replaceAll("-", "")}`;
    await pool.query(`
      CREATE FUNCTION public.${slowWrite}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$;
      CREATE TRIGGER ${slowWrite} BEFORE INSERT ON public.events FOR EACH ROW
        WHEN (NEW."threadId" = ${escapeLiteral(scope.threadId)})
        EXECUTE FUNCTION public.${slowWrite}();`);
    try {
      await expect(
        storeToolResultHistory(prisma, scope, {
          name: "connector.read",
          executionId: "slow-private-write",
          text: '{"value":"must-not-commit"}',
        }),
      ).rejects.toThrow();
    } finally {
      await pool.query(
        `DROP TRIGGER ${slowWrite} ON public.events; DROP FUNCTION public.${slowWrite}()`,
      );
    }
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM events WHERE payload->>'executionId' = $1",
          ["slow-private-write"],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query('SELECT "nextEventSeq" FROM threads WHERE id = $1', [scope.threadId])).rows,
    ).toEqual(before.rows);
  });

  it("does not read a historical result after its source message has been cleared", async () => {
    const id = (await store('{"value":"clear-canary"}'))!.arguments.toolResultId;
    const historicalScope = { ...scope, activeRunId: undefined };
    expect((await read(id, historicalScope)).toolResult?.text).toContain("clear-canary");
    await prisma.message.delete({ where: { id: sourceId } });
    expect(
      await prisma.run.findUnique({
        where: { id: scope.activeRunId },
        select: { sourceMessageId: true },
      }),
    ).toEqual({ sourceMessageId: null });
    expect((await read(id, historicalScope)).toolResult).toBeNull();
  });
});
