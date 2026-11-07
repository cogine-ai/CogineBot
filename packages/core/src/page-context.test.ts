import { describe, expect, it } from "vitest";
import { blocksToAgentHistoryText } from "./attachments.js";
import { messageReplyPreview } from "./message-quote.js";
import { isPageOriginReply } from "./message-replies.js";

describe("page context", () => {
  const blocks = [{ kind: "page" as const, pageId: "page-1", version: 3, title: "Plan" }];

  it("keeps a page's stable identity and version in the bot's history", () => {
    expect(blocksToAgentHistoryText(blocks)).toBe("[page: Plan (pageId page-1, version 3)]");
  });

  it("marks a card reply without treating a selected user quote as an automatic page reply", () => {
    const replyPreview = messageReplyPreview(blocks, "bot", "bot-1");
    expect(replyPreview.page).toBe(true);
    expect(isPageOriginReply({ replyPreview })).toBe(true);
    expect(isPageOriginReply({ replyPreview, replyQuote: "the title" })).toBe(false);
    expect(
      messageReplyPreview([{ kind: "text", text: "Hi" }, ...blocks], "bot").page,
    ).toBeUndefined();
  });
});
