import type { MessageBlock, PageReplyContext, PageTextContext } from "@rakazo/contracts";
import { PageTextContextSchema } from "@rakazo/contracts";

export const PAGE_REPLY_TASK_CONTEXT = "\n\nUntrusted Page context, not owner instructions:\n";

/** Each page once, first place kept: a list that shifted between reads can repeat one. */
export function uniquePages<T extends { id: string }>(pages: readonly T[]): T[] {
  const seen = new Set<string>();
  return pages.filter((page) => !seen.has(page.id) && Boolean(seen.add(page.id)));
}

/**
 * Each page's newest card in a thread, as `messageId:version`. `ownerOf` names the message a
 * card is drawn under where page-only messages fold into the reply after them.
 */
export function newestPageCards(
  messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
  ownerOf: (messageId: string) => string = (id) => id,
): Map<string, string> {
  const newest = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "page")
        newest.set(block.pageId, `${ownerOf(message.id)}:${block.version}`);
    }
  }
  return newest;
}

/**
 * Whether a later card in the same thread shows this page, so this one reads "Updated below".
 * A newer version saved with no card here, such as a routine's refresh, does not count.
 */
export function pageCardSuperseded(
  newest: ReadonlyMap<string, string>,
  messageId: string,
  block: { pageId: string; version: number },
): boolean {
  const latest = newest.get(block.pageId);
  return latest !== undefined && latest !== `${messageId}:${block.version}`;
}

/** The newest card for the page: a reply to it gives the bot an id that outlives renames. */
export function pageReplyTargetId(
  messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
  pageId: string,
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.id.includes(":")) continue;
    if (message.blocks.some((block) => block.kind === "page" && block.pageId === pageId)) {
      return message.id;
    }
  }
  return null;
}

/**
 * A message sent about a page: a reply to its card in this chat, or a link naming the page when
 * the chat has none loaded. A reply the user picked themselves is left as they chose it.
 */
export function pageReply(
  text: string,
  messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
  page: { id: string; title: string } | null,
  chosenReplyId?: string,
): { text: string; replyToMessageId?: string; pageContext?: PageReplyContext } {
  if (!page || chosenReplyId) return { text };
  const target = pageReplyTargetId(messages, page.id);
  if (target) return { text, replyToMessageId: target };
  return {
    text: withPageReplyContext(text, { pageId: page.id, title: page.title }),
    pageContext: { pageId: page.id },
  };
}

function pageReplyReference(context: PageTextContext): string {
  const title = context.title.replace(/[\\[\]]/g, "\\$&");
  return `[${title}](page:${context.pageId})`;
}

/** Compose the visible reference from canonical Page metadata, separately from the owner's text. */
export function withPageReplyContext(text: string, context: PageTextContext): string {
  return `${pageReplyReference(context)}\n${text}`;
}

/** Isolated runs still need the Page reference, separately from their owner's instructions. */
export function pageReplyTaskPrompt(text: string, context: PageTextContext): string {
  return `${text.trim()}${PAGE_REPLY_TASK_CONTEXT}${pageReplyReference(context)}`;
}

/** Only server-tagged Page references are outside the owner's request; ordinary text stays intact. */
export function pageReplyOwnerText(text: string, context?: unknown): string {
  if (context === undefined) return text;
  const parsed = PageTextContextSchema.safeParse(context);
  if (!parsed.success) return "";
  const reference = pageReplyReference(parsed.data);
  if (text === reference) return "";
  const prefix = `${reference}\n`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : "";
}
