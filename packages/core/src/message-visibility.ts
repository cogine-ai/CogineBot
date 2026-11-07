import type { MessageBlock } from "@rakazo/contracts";

export const LEGACY_PAGE_CARD_FALLBACK =
  "Page saved. Open this chat in a newer version to view it.";

type PresentableMessage = {
  runId?: string;
  blocks: readonly MessageBlock[];
};

export type UserVisibleMessagesOptions = {
  /**
   * Keep `bot_message_sent` / `bot_message_received` rows as compact chips
   * (web CollaborationMarker; mobile AgentEventLabel). Peer bodies stay hidden.
   */
  includePeerReceipts?: boolean;
  /** Peer-run ids from `run.trigger === "bot_message"` when receipts may be out of window. */
  knownPeerRunIds?: Iterable<string>;
  /**
   * Run ids for background triggers (e.g. `tickets`). Their messages are hidden
   * except cards that need user input.
   */
  backgroundRunIds?: Iterable<string>;
  /**
   * Surface a peer-run's own `text` reply (e.g. a delegating bot's summary to the user)
   * alongside `ask` cards. Defaults to true for chat-thread rendering; set false for
   * contexts like sidebar previews that should stay ask-only and never echo peer chatter.
   */
  includeDelegatedReplyText?: boolean;
};

export function isPeerReceiptBlocks(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
}

/** Newly reachable MCP-only peer rows expose their approval blocks, not hidden activity. */
export function peerVisibleMessageBlocks(
  blocks: readonly MessageBlock[],
  includeText = true,
): readonly MessageBlock[] | null {
  if (
    isPeerReceiptBlocks(blocks) ||
    blocks.some((block) => block.kind === "ask" || (includeText && block.kind === "text"))
  )
    return blocks;
  const approvals = blocks.filter((block) => block.kind === "mcp_approval");
  return approvals.length ? approvals : null;
}

/** User-input cards remain visible when their run otherwise stays in the background. */
export function isBackgroundInputBlock(block: unknown): boolean {
  return (
    !!block &&
    typeof block === "object" &&
    "kind" in block &&
    (block.kind === "ask" || block.kind === "computer" || block.kind === "mcp_approval")
  );
}

/** The companion stays visible if its actual card is missing. */
export function withoutLegacyPageCardFallbacks(
  blocks: readonly MessageBlock[],
): readonly MessageBlock[] {
  const hasCompanion = blocks.some(
    (block) => block.kind === "text" && block.pageCardFallbackFor !== undefined,
  );
  if (!hasCompanion) return blocks;
  const visible = blocks.filter((block) => {
    if (block.kind !== "text" || block.text !== LEGACY_PAGE_CARD_FALLBACK) return true;
    const target = block.pageCardFallbackFor;
    return (
      !target ||
      !blocks.some(
        (card) =>
          card.kind === "page" && card.pageId === target.pageId && card.version === target.version,
      )
    );
  });
  return visible.length === blocks.length ? blocks : visible;
}

/** Drop peer-run activity/replies; optionally keep sent/received receipt rows. */
export function userVisibleMessages<T extends PresentableMessage>(
  messages: readonly T[],
  options: UserVisibleMessagesOptions = {},
): T[] {
  const peerRunIds = new Set([
    ...(options.knownPeerRunIds ?? []),
    ...messages
      .filter((message) => message.blocks.some((block) => block.kind === "bot_message_received"))
      .flatMap((message) => (message.runId ? [message.runId] : [])),
  ]);
  const includePeerReceipts = options.includePeerReceipts === true;
  const backgroundRunIds = new Set(options.backgroundRunIds ?? []);

  return messages.flatMap((original) => {
    const displayed = withoutLegacyPageCardFallbacks(original.blocks);
    const message = displayed === original.blocks ? original : { ...original, blocks: displayed };
    if (message.runId && backgroundRunIds.has(message.runId)) {
      return message.blocks.some(isBackgroundInputBlock) ? [message] : [];
    }
    if (isPeerReceiptBlocks(message.blocks)) return includePeerReceipts ? [message] : [];
    if (!message.runId || !peerRunIds.has(message.runId)) return [message];
    const blocks = peerVisibleMessageBlocks(
      message.blocks,
      options.includeDelegatedReplyText !== false,
    );
    return blocks ? [blocks === message.blocks ? message : { ...message, blocks }] : [];
  });
}
