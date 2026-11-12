import { createHash } from "node:crypto";
import type {
  HistoryReadInput,
  HistorySearchInput,
  HistorySource,
  HistorySourceReference,
  MessageBlock,
} from "@rakazo/contracts";
import {
  GROUP_MEMBER_MIN,
  HISTORY_SOURCE_UNAVAILABLE,
  HistoryQueriesSchema,
  MAX_HISTORY_SEARCH_OFFSET,
} from "@rakazo/contracts";
import { shortenedTextLength, THREAD_HIDDEN_RUN_TRIGGERS, textBoundary } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma, withAbortableDatabaseCheckout } from "./client.js";

/** Only the executor supplies scope; tool arguments cannot widen it. */
export interface HistoryScope {
  spaceId: string;
  userId: string;
  threadId: string;
  botId: string;
  channelId?: string;
  /** A surviving direct human request has authorized cross-chat history for this call. */
  allowMyChats?: boolean;
  /** Exclude messages created after the Run was admitted, including across pages. */
  searchAt?: Date;
  signal?: AbortSignal;
  /** Server-captured history boundary. Search excludes the active request and later messages. */
  searchBeforeSeq?: number;
  /** Server-owned active run; permits its source-less results before an output exists. */
  activeRunId?: string;
  /** Page-bearing messages accepted directly by this run, without a steering claim. */
  acceptedPageMessageIds?: readonly string[];
  /** Server-only redaction of a full stored JSON value, before offsets are calculated. */
  transformToolResult?: (value: unknown) => unknown;
}
interface HistoryRow {
  id: string;
  seq: number;
  role: string;
  runId: string | null;
  replyToMessageId: string | null;
  createdAt: Date;
  blocks: Prisma.JsonValue;
  threadId: string;
  botId?: string | null;
  groupId?: string | null;
  chatName?: string | null;
  matchedQueryIndexes?: number[];
}
// Bound complete JSON pages, including cursors, below the final model result budget.
const MAX_RESPONSE_BYTES = 10_000;
const LINK_PAGE_SIZE = 5;
type HistoryDatabase = Pick<PrismaClient, "$queryRaw" | "run" | "artifact">;

/** Keep actual originals before linked outcomes when the latest read fills the card. */
export function mergeHistorySourceReferences(
  previous: HistorySourceReference[],
  sources: HistorySourceReference[],
): HistorySourceReference[] {
  const latest = new Map(sources.map((source) => [source.messageId, source]));
  const kept = new Set([...latest.keys()].slice(0, LINK_PAGE_SIZE));
  for (const source of previous.toReversed()) {
    if (kept.size === LINK_PAGE_SIZE) break;
    kept.add(source.messageId);
  }
  return [
    ...new Map(
      [...previous, ...latest.values()].map((source) => [source.messageId, source]),
    ).values(),
  ].filter((source) => kept.has(source.messageId));
}

type HistoryGrantRun = {
  id: string;
  spaceId: string;
  userId: string;
  threadId: string;
  sourceMessageId: string | null;
  leaseOwner: string;
  leaseFence: number;
};

export function historyGrantWhere(run: HistoryGrantRun): Prisma.RunWhereInput {
  return {
    ...run,
    receivedOutsideMessage: false,
    status: "running",
    thread: {
      externalConversationId: null,
      space: { memberships: { some: { userId: run.userId } } },
    },
  };
}

/** The same source and lease must authorize each retrieval and its final reply. */
export async function hasRunHistoryGrant(
  db: Pick<PrismaClient, "run">,
  run: HistoryGrantRun,
): Promise<boolean> {
  if (!run.sourceMessageId) return false;
  const current = await db.run.findFirst({
    where: historyGrantWhere(run),
    select: {
      origin: true,
      trigger: true,
      sourceMessage: {
        select: { threadId: true, role: true, authorUserId: true, blocks: true, clientNonce: true },
      },
    },
  });
  return (
    current?.sourceMessage?.threadId === run.threadId &&
    historyMyChatsAllowed({ ...current, userId: run.userId }, current.sourceMessage, false)
  );
}

export async function lockRunHistoryGrant(
  tx: Prisma.TransactionClient,
  run: HistoryGrantRun,
): Promise<boolean> {
  if (!run.sourceMessageId) return false;
  const [member] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM space_members
    WHERE "spaceId" = ${run.spaceId} AND "userId" = ${run.userId} FOR SHARE`;
  if (!member) return false;
  const [source] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM messages WHERE id = ${run.sourceMessageId}
      AND "threadId" = ${run.threadId} FOR SHARE`;
  return Boolean(source && (await hasRunHistoryGrant(tx, run)));
}

/** Cross-chat authority comes from the authenticated message that started this app Run. */
export function historyMyChatsAllowed(
  run: { trigger: string; origin: string; userId: string },
  source: {
    role: string;
    authorUserId?: string | null;
    blocks: unknown;
    clientNonce?: string | null;
  } | null,
  externalThread: boolean,
): boolean {
  return (
    !externalThread &&
    run.origin === "human" &&
    (run.trigger === "user" || run.trigger === "follow_up") &&
    source?.role === "user" &&
    source.authorUserId === run.userId &&
    !source.clientNonce?.startsWith("messaging:") &&
    Array.isArray(source.blocks) &&
    !(source.blocks as MessageBlock[]).some((block) =>
      ["channel_message", "bot_message_received", "handoff"].includes(block.kind),
    )
  );
}

export async function withCrossChatHistoryBudget<T>(
  prisma: PrismaClient,
  signal: AbortSignal,
  read: (db: HistoryDatabase) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  try {
    return await withAbortableDatabaseCheckout(signal, () =>
      prisma.$transaction(
        async (tx) => {
          signal.throwIfAborted();
          // Detect an intentionally closed client socket while a scan is running.
          // The statement timeout also bounds a query through a remote pooler.
          await tx.$executeRaw`SELECT set_config('statement_timeout', '1000ms', true),
            set_config('client_connection_check_interval', '100ms', true)`;
          signal.throwIfAborted();
          return read(tx);
        },
        { maxWait: 500, timeout: 1_500 },
      ),
    );
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}

function bounded<T extends { messages: ReturnType<typeof reference>[] }>(response: T): T {
  const refs = [...response.messages];
  if ("runs" in response) {
    const runs = response.runs as Array<{
      outcomes: ReturnType<typeof reference>[];
    }>;
    refs.push(...runs.flatMap((run) => run.outcomes));
  }
  while (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_RESPONSE_BYTES) {
    const longest = refs.reduce<ReturnType<typeof reference> | undefined>(
      (best, ref) =>
        shortenedTextLength(ref.text) > 0 && (!best || ref.text.length > best.text.length)
          ? ref
          : best,
      undefined,
    );
    if (!longest) throw new Error("History metadata exceeds response budget");
    longest.text = longest.text.slice(0, shortenedTextLength(longest.text));
    longest.truncated = true;
    longest.nextTextOffset = longest.textOffset + longest.text.length;
  }
  return response;
}
const searchableText = Prisma.sql`jsonb_path_query_array(m.blocks,
  '$[*] ? (@.kind == "text" || @.kind == "channel_message" || @.kind == "bot_message_received" || @.kind == "bot_message_sent" || @.kind == "handoff").text')::text || jsonb_path_query_array(m.blocks, '$[*] ? (@.kind == "subagent").task')::text || jsonb_path_query_array(m.blocks, '$[*] ? (@.kind == "subagent").result')::text`;
const columns = Prisma.sql`m.id, m.seq, m.role, m."runId", m."replyToMessageId", m."createdAt", m.blocks, t.id AS "threadId", t."groupId", t."botId"`;
const chatName = Prisma.sql`COALESCE(
    (SELECT b.name FROM bots b WHERE b.id = t."botId"),
    (SELECT g.name FROM chat_groups g WHERE g.id = t."groupId")
  ) AS "chatName"`;

function visibleThread(scope: HistoryScope): Prisma.Sql {
  return Prisma.sql`
    t.id = ${scope.threadId} AND t."spaceId" = ${scope.spaceId}
    AND t."userId" = ${scope.userId}
    AND (t."botId" = ${scope.botId} OR (t."botId" IS NULL AND EXISTS (
      SELECT 1 FROM chat_groups g JOIN chat_group_members member ON member."groupId" = g.id
      WHERE g.id = t."groupId" AND g."spaceId" = ${scope.spaceId} AND g."userId" = ${scope.userId}
        AND g."archivedAt" IS NULL AND member."botId" = ${scope.botId}
    )))
    AND EXISTS (SELECT 1 FROM bots b WHERE b.id = ${scope.botId}
      AND b."spaceId" = ${scope.spaceId} AND b."userId" = ${scope.userId}
      AND b."archivedAt" IS NULL)
  `;
}
function visibleOwnedChat(
  scope: Pick<HistoryScope, "spaceId" | "userId">,
  threadId?: string,
): Prisma.Sql {
  return Prisma.sql`
    t."spaceId" = ${scope.spaceId} AND t."userId" = ${scope.userId}
    AND t."externalConversationId" IS NULL
    ${threadId ? Prisma.sql`AND t.id = ${threadId}` : Prisma.empty}
    AND EXISTS (
      SELECT 1 FROM space_members member
      WHERE member."spaceId" = t."spaceId" AND member."userId" = t."userId"
    )
    AND NOT EXISTS (
      SELECT 1 FROM runs hidden
      WHERE hidden.id = m."runId" AND hidden."threadId" = t.id
        AND hidden.trigger IN (${Prisma.join(THREAD_HIDDEN_RUN_TRIGGERS)})
    )
    AND ((t."groupId" IS NULL AND EXISTS (
      SELECT 1 FROM bots b WHERE b.id = t."botId" AND b."spaceId" = t."spaceId"
        AND b."userId" = t."userId" AND b."archivedAt" IS NULL
    )) OR (t."botId" IS NULL AND EXISTS (
      SELECT 1 FROM chat_groups g WHERE g.id = t."groupId" AND g."spaceId" = t."spaceId"
        AND g."userId" = t."userId" AND g."archivedAt" IS NULL
        AND (SELECT count(*) FROM chat_group_members member JOIN bots b ON b.id = member."botId"
          WHERE member."groupId" = g.id AND b."archivedAt" IS NULL
            AND b."spaceId" = g."spaceId" AND b."userId" = g."userId") >= ${GROUP_MEMBER_MIN}
    )))`;
}

function visible(scope: HistoryScope, myChats = false, threadId?: string): Prisma.Sql {
  const channel = scope.channelId;
  return Prisma.sql`
    ${myChats ? visibleOwnedChat(scope, threadId) : visibleThread(scope)}
    AND NOT (
      (
        jsonb_path_exists(m.blocks, '$[*] ? (@.kind == "text" && exists(@.pageContext))')
        OR EXISTS (
          SELECT 1 FROM messages parent
          WHERE parent.id = m."replyToMessageId" AND parent."threadId" = m."threadId"
            AND (
              (
                parent.blocks @> '[{"kind":"page"}]'::jsonb
                AND NOT jsonb_path_exists(parent.blocks, '$[*] ? (@.kind != "page")')
              )
              OR (
                NULLIF(btrim(m."replyQuote"), '') IS NULL
                AND jsonb_path_exists(parent.blocks, '$[*] ? (@.kind == "page" || (@.kind == "text" && exists(@.pageContext)))')
              )
            )
        )
      )
      ${scope.acceptedPageMessageIds?.length ? Prisma.sql`AND m.id NOT IN (${Prisma.join(scope.acceptedPageMessageIds)})` : Prisma.empty}
      AND EXISTS (
        SELECT 1 FROM steering_messages pending
        WHERE pending."messageId" = m.id AND (pending."runId" IS NULL OR pending."claimedAt" IS NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM steering_messages claimed
        WHERE claimed."messageId" = m.id AND claimed."botId" = ${myChats ? Prisma.sql`COALESCE(t."botId", ${scope.botId})` : scope.botId}
          AND claimed."runId" IS NOT NULL AND claimed."claimedAt" IS NOT NULL
      )
    )
    ${
      channel
        ? Prisma.sql`AND (
      (m.role = 'user' AND m.blocks @> ${JSON.stringify([{ kind: "channel_message", channelId: channel }])}::jsonb)
      OR (m.role = 'bot' AND EXISTS (
        SELECT 1 FROM runs r JOIN messages source ON source.id = r."sourceMessageId"
        WHERE r.id = m."runId" AND r."threadId" = t.id
          AND r."spaceId" = ${scope.spaceId} AND r."userId" = ${scope.userId}
          AND r."botId" = ${scope.botId} AND source."threadId" = t.id
          AND source.blocks @> ${JSON.stringify([{ kind: "channel_message", channelId: channel }])}::jsonb
      )))`
        : Prisma.empty
    }
  `;
}
function pageSize(value = 10): number {
  if (!Number.isInteger(value) || value < 1)
    throw new Error("History limit must be a positive integer");
  return Math.min(value, 20);
}
function date(value: string | undefined): Date | undefined {
  if (value === undefined) return;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid history date");
  return parsed;
}
/** Text only: progress, commands, secret prompts and tool traces are not retrieval content. */
export function historyMessageText(blocks: Prisma.JsonValue): string {
  if (!Array.isArray(blocks)) return "";
  return (
    blocks.filter(
      (block) => block && typeof block === "object" && !Array.isArray(block),
    ) as MessageBlock[]
  )
    .flatMap((block) => {
      if (block.kind === "subagent") return [block.task, block.result ?? ""].filter(Boolean);
      return [
        "text",
        "channel_message",
        "bot_message_received",
        "bot_message_sent",
        "handoff",
      ].includes(block.kind) &&
        "text" in block &&
        typeof block.text === "string"
        ? [block.text]
        : [];
    })
    .join("\n");
}
function reference(row: HistoryRow, query = "", maxLength = 800, textOffset = 0) {
  const text = historyMessageText(row.blocks);
  const matchedTerm =
    query && !text.toLowerCase().includes(query.toLowerCase())
      ? (query.split(/\s+/).find((term) => text.toLowerCase().includes(term.toLowerCase())) ??
        query)
      : query;
  if (query) textOffset = Math.max(0, text.toLowerCase().indexOf(matchedTerm.toLowerCase()) - 40);
  textOffset = textBoundary(text, textOffset);
  const excerpt = text.slice(textOffset, textBoundary(text, textOffset + maxLength));
  const nextTextOffset =
    textOffset + excerpt.length < text.length ? textOffset + excerpt.length : null;
  return {
    messageId: row.id,
    seq: row.seq,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    runId: row.runId,
    replyToMessageId: row.replyToMessageId,
    text: excerpt,
    textOffset,
    nextTextOffset,
    truncated: textOffset > 0 || nextTextOffset !== null,
  };
}

function canReadAcrossChats(scope: HistoryScope): boolean {
  return Boolean(scope.allowMyChats && !scope.channelId && scope.searchAt);
}

/** PostgreSQL full-text search, with a sequence cursor for the original single-chat search. */
export async function searchHistory(
  prisma: HistoryDatabase,
  scope: HistoryScope,
  input: HistorySearchInput,
) {
  scope.signal?.throwIfAborted();
  const queries =
    input.queries === undefined
      ? [input.query?.trim() ?? ""]
      : HistoryQueriesSchema.parse(input.queries);
  if (
    (input.query !== undefined) === (input.queries !== undefined) ||
    queries.some((query) => !query || query.length > 500)
  )
    throw new Error("History query must contain 1 to 500 characters");
  const query = queries[0]!;
  const myChats = input.scope === "my_chats";
  if (myChats && !canReadAcrossChats(scope)) throw new Error(HISTORY_SOURCE_UNAVAILABLE);
  const byOffset = myChats || input.queries !== undefined || input.offset !== undefined;
  const limit = Math.min(pageSize(input.limit), 5);
  const before = date(input.before);
  const after = date(input.after);
  if (
    input.beforeSeq !== undefined &&
    (!Number.isInteger(input.beforeSeq) || input.beforeSeq < 0)
  ) {
    throw new Error("Invalid history cursor");
  }
  if (
    scope.searchBeforeSeq !== undefined &&
    (!Number.isInteger(scope.searchBeforeSeq) || scope.searchBeforeSeq < 0)
  )
    throw new Error("Invalid history search boundary");
  const beforeSeq = Math.min(
    input.beforeSeq ?? Number.POSITIVE_INFINITY,
    scope.searchBeforeSeq ?? Number.POSITIVE_INFINITY,
  );
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_HISTORY_SEARCH_OFFSET)
    throw new Error("Invalid history offset");
  const matches = queries.map(
    (word) =>
      Prisma.sql`to_tsvector('simple', ${searchableText}) @@ plainto_tsquery('simple', ${word})`,
  );
  const kindFilter = input.kinds?.map((kind) =>
    kind === "bot_messages"
      ? Prisma.sql`jsonb_path_exists(m.blocks, '$[*] ? (@.kind == "bot_message_sent" || @.kind == "bot_message_received" || @.kind == "handoff")')`
      : kind === "user_messages"
        ? Prisma.sql`(m.role = 'user' AND jsonb_path_exists(m.blocks, '$[*] ? (@.kind == "text" || @.kind == "channel_message")'))`
        : Prisma.sql`(m.role = 'bot' AND jsonb_path_exists(m.blocks, '$[*] ? (@.kind == "text")'))`,
  );
  // The full-text index supplies exact matches in a single bounded page; there are no
  // blind-index candidates to verify in application code.
  const rows = await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT ${columns}
      ${
        byOffset
          ? Prisma.sql`, ${chatName}, array_remove(ARRAY[${Prisma.join(
              matches.map((match, index) => Prisma.sql`CASE WHEN ${match} THEN ${index}::int END`),
            )}], NULL::int) AS "matchedQueryIndexes"`
          : Prisma.empty
      }
    FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE ${visible(scope, myChats)}
      AND (${Prisma.join(matches, " OR ")})
      ${
        input.botId
          ? Prisma.sql`AND (t."botId" = ${input.botId} OR EXISTS (
        SELECT 1 FROM chat_group_members member JOIN bots b ON b.id = member."botId"
        WHERE member."groupId" = t."groupId" AND b.id = ${input.botId}
          AND b."spaceId" = t."spaceId" AND b."userId" = t."userId" AND b."archivedAt" IS NULL
      ))`
          : Prisma.empty
      }
      ${kindFilter?.length ? Prisma.sql`AND (${Prisma.join(kindFilter, " OR ")})` : Prisma.empty}
      ${before ? Prisma.sql`AND m."createdAt" < ${before}` : Prisma.empty}
      ${after ? Prisma.sql`AND m."createdAt" >= ${after}` : Prisma.empty}
      ${scope.searchAt ? Prisma.sql`AND m."createdAt" < ${scope.searchAt}` : Prisma.empty}
      ${Number.isFinite(beforeSeq) ? Prisma.sql`AND (m.seq < ${beforeSeq}${myChats ? Prisma.sql` OR t.id <> ${scope.threadId}` : Prisma.empty})` : Prisma.empty}
    ORDER BY ${byOffset ? Prisma.sql`m."createdAt" DESC, m.id DESC` : Prisma.sql`m.seq DESC`}
    LIMIT ${limit + 1} ${byOffset ? Prisma.sql`OFFSET ${offset}` : Prisma.empty}
  `);
  scope.signal?.throwIfAborted();
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const nextBeforeSeq = !byOffset && hasMore ? page.at(-1)!.seq : null;
  const nextOffset = offset + page.length;
  const capped = byOffset && hasMore && nextOffset > MAX_HISTORY_SEARCH_OFFSET;
  return bounded({
    untrusted: true as const,
    query: byOffset ? undefined : query,
    ...(byOffset ? { queries } : {}),
    coverage: {
      scope: "requested_query_and_range" as const,
      status: hasMore ? ("partial" as const) : ("exhausted" as const),
      ...(capped ? { capped: true } : {}),
    },
    messages: page.map((row) => ({
      ...reference(row, queries[row.matchedQueryIndexes?.[0] ?? 0]),
      ...(byOffset
        ? { ...historySource(row), matchedQueryIndexes: row.matchedQueryIndexes ?? [] }
        : {}),
    })),
    nextBeforeSeq,
    nextSearch:
      !hasMore || capped
        ? null
        : {
            ...(input.queries ? { queries } : { query }),
            ...(byOffset ? { offset: nextOffset } : { beforeSeq: nextBeforeSeq! }),
            ...(byOffset && input.beforeSeq !== undefined ? { beforeSeq: input.beforeSeq } : {}),
            ...(input.scope ? { scope: input.scope } : {}),
            ...(input.botId ? { botId: input.botId } : {}),
            ...(input.kinds ? { kinds: input.kinds } : {}),
            limit,
            ...(input.after !== undefined ? { after: input.after } : {}),
            ...(input.before !== undefined ? { before: input.before } : {}),
          },
  });
}

function historySource(row: HistoryRow) {
  return {
    threadId: row.threadId,
    botId: row.botId ?? null,
    groupId: row.groupId ?? null,
    chatName: row.chatName ? row.chatName.slice(0, textBoundary(row.chatName, 160)) : null,
  };
}

/** A citation is a locator. A signed-in reader still needs current access to its original. */
export async function listHistorySources(
  prisma: PrismaClient,
  actor: Pick<HistoryScope, "spaceId" | "userId">,
  references: readonly HistorySourceReference[],
): Promise<HistorySource[]> {
  if (references.length === 0) return [];
  const rows = await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT ${columns}, ${chatName}
    FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE ${visibleOwnedChat(actor)}
      AND (t.id, m.id) IN (${Prisma.join(references.map(({ threadId, messageId }) => Prisma.sql`(${threadId}, ${messageId})`))})
    LIMIT 5
  `);
  return references.flatMap(({ messageId, threadId }) => {
    const row = rows.find(
      (candidate) => candidate.id === messageId && candidate.threadId === threadId,
    );
    if (!row) return [];
    const source = historySource(row);
    return [
      {
        ...source,
        messageId,
        chatName: source.chatName ?? "",
        createdAt: row.createdAt.toISOString(),
        text: reference(row, "", 240).text,
      },
    ];
  });
}

/** Anchor authorization and neighbor authorization use the same predicate. */
export async function readHistory(
  prisma: HistoryDatabase,
  scope: HistoryScope,
  input: HistoryReadInput,
) {
  scope.signal?.throwIfAborted();
  if (input.toolResultId) return readToolResult(prisma, scope, input);
  const targetThreadId = input.threadId ?? scope.threadId;
  const crossChat = targetThreadId !== scope.threadId;
  if (crossChat && !canReadAcrossChats(scope)) throw new Error(HISTORY_SOURCE_UNAVAILABLE);
  // Explicit references stay inside the Run's horizon, including a my_chats
  // hit in this chat. Existing reads without a threadId keep their behavior.
  const referenceSearchAt = input.threadId === undefined ? undefined : scope.searchAt;
  const referenceBeforeSeq =
    input.threadId !== undefined && !crossChat ? scope.searchBeforeSeq : undefined;
  const citedHistory = input.threadId !== undefined && canReadAcrossChats(scope);
  const authorized = Prisma.sql`${visible(scope, crossChat, targetThreadId)}
    ${citedHistory && !crossChat ? Prisma.sql`AND ${visibleOwnedChat(scope, targetThreadId)}` : Prisma.empty}
    ${referenceSearchAt ? Prisma.sql`AND m."createdAt" < ${referenceSearchAt}` : Prisma.empty}
    ${referenceBeforeSeq !== undefined ? Prisma.sql`AND m.seq < ${referenceBeforeSeq}` : Prisma.empty}`;
  const limit = Math.min(pageSize(input.limit), 5);
  const direction = input.direction ?? "around";
  if (
    input.textOffset !== undefined &&
    (!Number.isInteger(input.textOffset) || input.textOffset < 0)
  )
    throw new Error("Invalid history text offset");
  if (!["around", "older", "newer"].includes(direction))
    throw new Error("Invalid history direction");
  const anchors = await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT ${columns}${citedHistory ? Prisma.sql`, ${chatName}` : Prisma.empty}
    FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE ${authorized} AND m.id = ${input.messageId} LIMIT 1
  `);
  scope.signal?.throwIfAborted();
  const anchor = anchors[0];
  if (citedHistory && !anchor) throw new Error(HISTORY_SOURCE_UNAVAILABLE);
  if (!anchor)
    return {
      untrusted: true as const,
      messages: [],
      runs: [],
      snapshots: [],
      nextRunId: null,
      nextArtifactId: null,
      nextOutcomeSeq: null,
      olderMessageId: null,
      newerMessageId: null,
      toolResult: null,
      nextRead: null,
    };
  const bound =
    direction === "older"
      ? Prisma.sql`m.seq < ${anchor.seq}`
      : direction === "newer"
        ? Prisma.sql`m.seq > ${anchor.seq}`
        : Prisma.sql`m.seq >= ${Math.max(0, anchor.seq - Math.floor(limit / 2))}`;
  const rows =
    input.textOffset !== undefined
      ? [anchor]
      : await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT ${columns} FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE ${authorized} AND ${bound}
    ORDER BY m.seq ${direction === "older" ? Prisma.sql`DESC` : Prisma.sql`ASC`} LIMIT ${limit}
  `);
  rows.sort((a, b) => a.seq - b.seq);
  const linkedRows = citedHistory && input.linkedRunId ? [anchor] : rows;
  const linkedBotId = crossChat ? (anchor.botId ?? scope.botId) : scope.botId;
  const anchoredRunIds = linkedRows.flatMap((row) =>
    row.role === "bot" && row.runId ? [row.runId] : [],
  );
  // Source-less background runs require an authorized surviving output anchor.
  scope.signal?.throwIfAborted();
  const runRows = await prisma.run.findMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      threadId: targetThreadId,
      ...(anchor.groupId ? {} : { botId: linkedBotId }),
      ...(referenceSearchAt ? { createdAt: { lt: referenceSearchAt } } : {}),
      ...(citedHistory ? { trigger: { notIn: [...THREAD_HIDDEN_RUN_TRIGGERS] } } : {}),
      ...(input.linkedRunId
        ? { id: input.linkedRunId }
        : input.runAfterId
          ? { id: { gt: input.runAfterId } }
          : {}),
      ...(scope.channelId
        ? {
            sourceMessage: {
              threadId: targetThreadId,
              role: "user",
              blocks: {
                array_contains: [{ kind: "channel_message", channelId: scope.channelId }],
              },
            },
          }
        : {
            AND: [
              {
                OR: [
                  { sourceMessage: { threadId: targetThreadId } },
                  { sourceMessageId: null, id: { in: anchoredRunIds } },
                ],
              },
            ],
          }),
      OR: [
        { sourceMessageId: { in: linkedRows.map((row) => row.id) } },
        { id: { in: anchoredRunIds } },
      ],
    },
    select: {
      id: true,
      sourceMessageId: true,
      status: true,
      createdAt: true,
      completedAt: true,
    },
    orderBy: { id: "asc" },
    take: LINK_PAGE_SIZE + 1,
  });
  scope.signal?.throwIfAborted();
  const runs = runRows.slice(0, LINK_PAGE_SIZE);
  const readOutcomes = () =>
    runs.length
      ? prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT ${columns} FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE ${authorized} AND m.role = 'bot' AND m."runId" IN (${Prisma.join(runs.map((run) => run.id))})
      ${input.outcomeAfterSeq !== undefined ? Prisma.sql`AND m.seq > ${input.outcomeAfterSeq}` : Prisma.empty}
    ORDER BY m.seq ASC LIMIT ${LINK_PAGE_SIZE + 1}
  `)
      : Promise.resolve([]);
  const readArtifacts = () =>
    runs.length
      ? prisma.artifact.findMany({
          where: {
            spaceId: scope.spaceId,
            userId: scope.userId,
            ...(anchor.groupId
              ? { groupId: anchor.groupId }
              : { botId: linkedBotId, groupId: null }),
            ...(referenceSearchAt ? { createdAt: { lt: referenceSearchAt } } : {}),
            runId: { in: runs.map((run) => run.id) },
            ...(input.artifactAfterId ? { id: { gt: input.artifactAfterId } } : {}),
          },
          select: {
            id: true,
            runId: true,
            name: true,
            mimeType: true,
            size: true,
          },
          take: LINK_PAGE_SIZE + 1,
          orderBy: { id: "asc" },
        })
      : Promise.resolve([]);
  const outcomesRequest = readOutcomes();
  if (citedHistory) {
    await outcomesRequest;
    scope.signal?.throwIfAborted();
  }
  const [outcomeRows, artifactRows] = await Promise.all([outcomesRequest, readArtifacts()]);
  scope.signal?.throwIfAborted();
  if (citedHistory) {
    const [current] = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT m.id FROM messages m JOIN threads t ON t.id = m."threadId"
      WHERE ${authorized} AND m.id = ${anchor.id}
    `);
    scope.signal?.throwIfAborted();
    if (!current) throw new Error(HISTORY_SOURCE_UNAVAILABLE);
  }
  const outcomes = outcomeRows.slice(0, LINK_PAGE_SIZE);
  const artifacts = artifactRows.slice(0, LINK_PAGE_SIZE);
  return bounded({
    untrusted: true as const,
    ...(citedHistory ? { anchor: { ...historySource(anchor), messageId: anchor.id } } : {}),
    toolResult: null,
    nextRead: null,
    nextRunId: runRows.length > LINK_PAGE_SIZE ? runs.at(-1)!.id : null,
    nextArtifactId: artifactRows.length > LINK_PAGE_SIZE ? artifacts.at(-1)!.id : null,
    nextOutcomeSeq: outcomeRows.length > LINK_PAGE_SIZE ? outcomes.at(-1)!.seq : null,
    messages: rows.map((row) => ({
      ...reference(row, "", 2000, row.id === anchor.id ? (input.textOffset ?? 0) : 0),
      ...(citedHistory ? historySource({ ...row, chatName: anchor.chatName }) : {}),
    })),
    runs: runs.map((run) => ({
      ...run,
      outcomes: outcomes.filter((row) => row.runId === run.id).map((row) => reference(row)),
      artifacts: artifacts.filter((artifact) => artifact.runId === run.id),
    })),
    snapshots: rows.map((row) => {
      const linkedRuns = runs.filter(
        (run) => run.sourceMessageId === row.id || run.id === row.runId,
      );
      const outcome = outcomes.find((message) =>
        linkedRuns.some((run) => run.id === message.runId),
      );
      return {
        anchorMessageId: row.id,
        fromSeq: row.seq,
        toSeq: row.seq,
        createdAt: row.createdAt.toISOString(),
        version: createHash("sha256").update(JSON.stringify(row.blocks)).digest("hex"),
        topic: reference(row, "", 200).text,
        openRunIds: linkedRuns
          .filter((run) => !["completed", "failed", "cancelled"].includes(run.status))
          .map((run) => run.id),
        outcome: outcome ? reference(outcome, "", 200).text : null,
        source: "original" as const,
      };
    }),
    olderMessageId: rows[0]?.id ?? null,
    newerMessageId: rows.at(-1)?.id ?? null,
  });
}

/** Explicit references only. Ordinary message search never indexes connector bodies. */
async function readToolResult(
  prisma: HistoryDatabase,
  scope: HistoryScope,
  input: HistoryReadInput,
) {
  const textOffset = input.textOffset ?? 0;
  if (!Number.isInteger(textOffset) || textOffset < 0)
    throw new Error("Invalid history text offset");
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      runId: string;
      createdAt: Date;
      payload: { name: string; executionId: string };
      toolResult: { text: string; storedBytes: number };
    }>
  >(Prisma.sql`
    SELECT e.id, e."runId", e."createdAt", e.payload, e."toolResult"
    FROM events e JOIN runs r ON r.id = e."runId"
    JOIN threads t ON t.id = e."threadId"
    WHERE ${visibleThread(scope)} AND e.id = ${input.toolResultId}
      AND e.type = 'agent.tool.result.stored' AND e."toolResult" IS NOT NULL
      AND e."spaceId" = ${scope.spaceId} AND e."botId" = ${scope.botId}
      AND r."threadId" = t.id AND r."spaceId" = ${scope.spaceId}
      AND r."userId" = ${scope.userId} AND r."botId" = ${scope.botId}
      AND (
        EXISTS (SELECT 1 FROM messages source WHERE source.id = r."sourceMessageId"
          AND source."threadId" = t.id AND source.role = 'user'
          ${scope.channelId ? Prisma.sql`AND source.blocks @> ${JSON.stringify([{ kind: "channel_message", channelId: scope.channelId }])}::jsonb` : Prisma.empty})
        ${
          scope.channelId
            ? Prisma.empty
            : Prisma.sql`OR (r."sourceMessageId" IS NULL AND (
          r.id = ${scope.activeRunId ?? ""} OR EXISTS (
            SELECT 1 FROM messages output WHERE output."threadId" = t.id
              AND output.role = 'bot' AND output."runId" = r.id
          )))`
        }
      )
    LIMIT 1
  `);
  scope.signal?.throwIfAborted();
  const row = rows[0];
  const text =
    row && scope.transformToolResult
      ? JSON.stringify(scope.transformToolResult(JSON.parse(row.toolResult.text)))
      : row?.toolResult.text;
  const viewHash = text === undefined ? null : createHash("sha256").update(text).digest("hex");
  const cursorConflict = Boolean(
    row && ((textOffset > 0 && !input.viewHash) || (input.viewHash && input.viewHash !== viewHash)),
  );
  const response = {
    untrusted: true as const,
    messages: [],
    runs: [],
    snapshots: [],
    nextRunId: null,
    nextArtifactId: null,
    nextOutcomeSeq: null,
    olderMessageId: null,
    newerMessageId: null,
    error: cursorConflict ? ("cursor_conflict" as const) : null,
    retry: cursorConflict ? { toolResultId: row!.id, textOffset: 0 } : null,
    toolResult:
      row && !cursorConflict && text !== undefined
        ? {
            toolResultId: row.id,
            runId: row.runId,
            name: scope.transformToolResult
              ? scope.transformToolResult(row.payload.name)
              : row.payload.name,
            executionId: scope.transformToolResult
              ? scope.transformToolResult(row.payload.executionId)
              : row.payload.executionId,
            createdAt: row.createdAt.toISOString(),
            text: text.slice(textOffset, textOffset + 2_000),
            viewHash,
            textOffset,
            nextTextOffset: null as number | null,
            storedBytes: row.toolResult.storedBytes,
            // Complete relative to the executor result; earlier provider transport caps still apply.
            storageTruncated: false,
          }
        : null,
    nextRead: null as { toolResultId: string; textOffset: number; viewHash: string } | null,
  };
  if (!row || !response.toolResult) return response;
  for (;;) {
    const nextOffset = textOffset + response.toolResult.text.length;
    response.toolResult.nextTextOffset = nextOffset < text!.length ? nextOffset : null;
    response.nextRead =
      response.toolResult.nextTextOffset === null
        ? null
        : { toolResultId: row.id, textOffset: nextOffset, viewHash: viewHash! };
    if (Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_RESPONSE_BYTES) break;
    if (response.toolResult.text.length < 2)
      throw new Error("History metadata exceeds response budget");
    response.toolResult.text = response.toolResult.text.slice(
      0,
      Math.floor(response.toolResult.text.length / 2),
    );
  }
  return response;
}
