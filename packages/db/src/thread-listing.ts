import type { MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_RUN_TRIGGERS,
  isApprovalAskBlock,
  isBackgroundRunTrigger,
  plainTextFromMarkdown,
  userVisibleMessages,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";

/** Callers supply thread ids already resolved through their owned conversation lists/target. */
export async function loadThreadAttention(
  prisma: PrismaClient | Prisma.TransactionClient,
  scopedThreadIds: readonly string[],
): Promise<
  Map<string, { attentionMessageId: string | null; answerableApprovalMessageIds: string[] }>
> {
  const result = new Map<
    string,
    { attentionMessageId: string | null; answerableApprovalMessageIds: string[] }
  >();
  if (!scopedThreadIds.length) return result;
  const threads = await prisma.thread.findMany({
    where: { id: { in: [...new Set(scopedThreadIds)] } },
    select: { id: true, spaceId: true, userId: true },
  });
  for (const thread of threads) {
    result.set(thread.id, { attentionMessageId: null, answerableApprovalMessageIds: [] });
  }
  if (!threads.length) return result;
  const scope = new Map(threads.map((thread) => [thread.id, thread]));
  const waitingRuns = await prisma.run.findMany({
    where: {
      status: "waiting_input",
      OR: threads.map((thread) => ({
        threadId: thread.id,
        spaceId: thread.spaceId,
        userId: thread.userId,
        bot: { spaceId: thread.spaceId, userId: thread.userId },
      })),
    },
    select: { id: true, threadId: true, spaceId: true, userId: true, botId: true },
  });
  const runs = new Map(waitingRuns.map((run) => [run.id, run]));
  const messages = await prisma.message.findMany({
    where: {
      threadId: { in: threads.map((thread) => thread.id) },
      role: "bot",
      OR: [
        {
          runId: { in: waitingRuns.map((run) => run.id) },
          blocks: { array_contains: [{ kind: "ask" }] },
        },
        { blocks: { array_contains: [{ kind: "mcp_approval", status: "pending" }] } },
      ],
    },
    select: { id: true, threadId: true, seq: true, botId: true, runId: true, blocks: true },
    orderBy: [{ seq: "asc" }, { id: "asc" }],
  });
  const candidates = messages.flatMap((message) => {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    return parsed.success ? [{ ...message, blocks: parsed.data }] : [];
  });
  const asks = candidates.flatMap((message) => {
    const block = message.blocks.find(
      (candidate) => candidate.kind === "ask" && candidate.status !== "answered",
    );
    const run = message.runId ? runs.get(message.runId) : undefined;
    const thread = scope.get(message.threadId);
    if (
      block?.kind !== "ask" ||
      !isApprovalAskBlock(block) ||
      !run ||
      !thread ||
      run.threadId !== thread.id ||
      run.spaceId !== thread.spaceId ||
      run.userId !== thread.userId
    )
      return [];
    return [{ message, run, effectId: block.approvalEffectId! }];
  });
  const effects = asks.length
    ? await prisma.externalEffect.findMany({
        where: {
          id: { in: [...new Set(asks.map((ask) => ask.effectId))] },
          status: "intended",
          OR: asks.map((ask) => ({ runId: ask.run.id, spaceId: ask.run.spaceId })),
        },
        select: { id: true, runId: true, spaceId: true },
      })
    : [];
  const effectsById = new Map(effects.map((effect) => [effect.id, effect]));
  const validAsks = new Set(
    asks
      .filter((ask) => {
        const effect = effectsById.get(ask.effectId);
        return effect?.runId === ask.run.id && effect.spaceId === ask.run.spaceId;
      })
      .map((ask) => ask.message.id),
  );
  const mcp = candidates.flatMap((message) =>
    message.blocks.flatMap((block) =>
      block.kind === "mcp_approval" && block.status === "pending" && message.botId
        ? [{ message, serverId: block.serverId, botId: message.botId }]
        : [],
    ),
  );
  const [bots, servers] = mcp.length
    ? await Promise.all([
        prisma.bot.findMany({
          where: { id: { in: [...new Set(mcp.map((card) => card.botId))] } },
          select: { id: true, spaceId: true, userId: true },
        }),
        prisma.mcpServer.findMany({
          where: { id: { in: [...new Set(mcp.map((card) => card.serverId))] }, enabled: true },
          select: {
            id: true,
            spaceId: true,
            userId: true,
            allowAllTools: true,
            allowedTools: true,
          },
        }),
      ])
    : [[], []];
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  const serversById = new Map(servers.map((server) => [server.id, server]));
  const validMcp = new Set(
    mcp
      .filter((card) => {
        const thread = scope.get(card.message.threadId);
        const bot = botsById.get(card.botId);
        const server = serversById.get(card.serverId);
        return (
          thread &&
          bot?.spaceId === thread.spaceId &&
          bot.userId === thread.userId &&
          server?.spaceId === thread.spaceId &&
          server.userId === thread.userId &&
          !server.allowAllTools &&
          !(
            Array.isArray(server.allowedTools) &&
            server.allowedTools.some((name) => typeof name === "string")
          )
        );
      })
      .map((card) => card.message.id),
  );
  for (const message of candidates) {
    const attention = result.get(message.threadId);
    if (!attention) continue;
    if (validAsks.has(message.id)) attention.answerableApprovalMessageIds.push(message.id);
    if (
      (validAsks.has(message.id) || validMcp.has(message.id)) &&
      attention.attentionMessageId === null
    ) {
      attention.attentionMessageId = message.id;
    }
  }
  return result;
}

export const SIDEBAR_PREVIEW_MESSAGE_WINDOW = 16;

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];
const backgroundRunTriggers = [...BACKGROUND_RUN_TRIGGERS];
const userVisibleBotRunTriggers = ["bot_message", ...BACKGROUND_RUN_TRIGGERS];
const latestBotRunOrderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/**
 * The newest conversational/foreground run for a bot's sidebar status. Background
 * ticket runs keep working silently, so they must not make the avatar spin.
 */
export const activeRunSelection = {
  where: {
    status: { in: activeRunStatuses },
    trigger: { notIn: backgroundRunTriggers },
  },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { status: true },
} as const;

/** Latest user-visible run for a bot roster error signal; later success clears an older failure. */
export const latestBotRunSelection = {
  where: { trigger: { notIn: userVisibleBotRunTriggers } },
  orderBy: latestBotRunOrderBy,
  take: 1,
  select: { id: true, status: true },
} as const;

export function previewFromBlocks(blocks: unknown): string {
  const rows = Array.isArray(blocks) ? blocks : [];
  for (const block of rows) {
    if (
      block &&
      typeof block === "object" &&
      "kind" in block &&
      block.kind === "text" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return plainTextFromMarkdown((block as { text: string }).text);
    }
  }
  for (const block of rows) {
    if (
      block &&
      typeof block === "object" &&
      "kind" in block &&
      (block.kind === "file" || block.kind === "image") &&
      "name" in block &&
      typeof block.name === "string" &&
      block.name.trim()
    ) {
      return block.name.trim();
    }
  }
  return "";
}

type PreviewMessage = { blocks: unknown; runId?: string | null; seq?: number };
type PreviewThread = { id: string; messages: PreviewMessage[] };

/** Share the timeline's peer visibility rules across Bot and group sidebar rows. */
export async function loadThreadPreviews(
  prisma: PrismaClient,
  threads: readonly (PreviewThread | null)[],
): Promise<Map<string, string>> {
  const initialRunIds = [
    ...new Set(
      threads.flatMap((thread) =>
        (thread?.messages ?? []).flatMap((message) => (message.runId ? [message.runId] : [])),
      ),
    ),
  ];
  const runs = initialRunIds.length
    ? await prisma.run.findMany({
        where: {
          id: { in: initialRunIds },
          trigger: { in: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] },
        },
        select: { id: true, trigger: true },
      })
    : [];
  const entries = await Promise.all(
    threads
      .filter((thread): thread is PreviewThread => thread !== null)
      .map(async (thread) => {
        const checkedRunIds = new Set(initialRunIds);
        const backgroundRunIds = new Set(
          runs.filter((run) => isBackgroundRunTrigger(run.trigger)).map((run) => run.id),
        );
        const peerRunIds = new Set(
          runs.filter((run) => !backgroundRunIds.has(run.id)).map((run) => run.id),
        );
        let messages = thread.messages;
        for (let attempt = 0; attempt < 5; attempt++) {
          const runIds = [
            ...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : []))),
          ].filter((id) => !checkedRunIds.has(id));
          if (runIds.length) {
            const morePeers = await prisma.run.findMany({
              where: {
                id: { in: runIds },
                trigger: { in: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] },
              },
              select: { id: true, trigger: true },
            });
            for (const run of morePeers) {
              if (isBackgroundRunTrigger(run.trigger)) backgroundRunIds.add(run.id);
              else peerRunIds.add(run.id);
            }
            for (const id of runIds) checkedRunIds.add(id);
          }
          const visible = userVisibleMessages(
            messages.map((message) => ({
              ...message,
              blocks: (Array.isArray(message.blocks) ? message.blocks : []) as MessageBlock[],
              runId: message.runId ?? undefined,
            })),
            { knownPeerRunIds: peerRunIds, backgroundRunIds },
          );
          // A progress/choice-only row must not hide a real sentence in the same page.
          const preview = visible.map((message) => previewFromBlocks(message.blocks)).find(Boolean);
          if (preview) return [thread.id, preview] as const;
          const oldest = messages[messages.length - 1];
          if (!oldest || oldest.seq === undefined || attempt === 4) break;
          messages = await prisma.message.findMany({
            where: { threadId: thread.id, seq: { lt: oldest.seq } },
            orderBy: { seq: "desc" },
            take: SIDEBAR_PREVIEW_MESSAGE_WINDOW,
          });
        }
        return [thread.id, ""] as const;
      }),
  );
  return new Map(entries);
}
