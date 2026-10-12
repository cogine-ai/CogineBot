import type { MessageBlock } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, plainTextFromMarkdown, userVisibleMessages } from "@rakazo/core";
import type { PrismaClient } from "./client.js";

export const SIDEBAR_PREVIEW_MESSAGE_WINDOW = 16;

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];

export const activeRunSelection = {
  where: { status: { in: activeRunStatuses } },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { status: true },
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
  const peers = initialRunIds.length
    ? await prisma.run.findMany({
        where: { id: { in: initialRunIds }, trigger: "bot_message" },
        select: { id: true },
      })
    : [];
  const entries = await Promise.all(
    threads
      .filter((thread): thread is PreviewThread => thread !== null)
      .map(async (thread) => {
        const checkedRunIds = new Set(initialRunIds);
        const peerRunIds = new Set(peers.map((run) => run.id));
        let messages = thread.messages;
        for (let attempt = 0; attempt < 5; attempt++) {
          const runIds = [
            ...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : []))),
          ].filter((id) => !checkedRunIds.has(id));
          if (runIds.length) {
            const morePeers = await prisma.run.findMany({
              where: { id: { in: runIds }, trigger: "bot_message" },
              select: { id: true },
            });
            for (const run of morePeers) peerRunIds.add(run.id);
            for (const id of runIds) checkedRunIds.add(id);
          }
          const visible = userVisibleMessages(
            messages.map((message) => ({
              ...message,
              blocks: (Array.isArray(message.blocks) ? message.blocks : []) as MessageBlock[],
              runId: message.runId ?? undefined,
            })),
            { knownPeerRunIds: peerRunIds },
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
