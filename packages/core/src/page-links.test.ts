import type { MessageBlock } from "@rakazo/contracts";
import { PageTitleSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  newestPageCards,
  pageCardSuperseded,
  pageReply,
  pageReplyOwnerText,
  pageReplyTargetId,
  uniquePages,
  withPageReplyContext,
} from "./page-links.js";

describe("Page reply owner text", () => {
  it("keeps a manually typed Page link while excluding only the same text with server context", () => {
    const text = "[https://owner.example/report](page:manual)\nPlease read this.";
    expect(pageReplyOwnerText(text)).toBe(text);
    expect(
      pageReplyOwnerText(text, { pageId: "manual", title: "https://owner.example/report" }),
    ).toBe("Please read this.");
  });

  it("adds a Page context only for the fallback, keeping the composed display text", () => {
    expect(pageReply("Please read this.", [], { id: "page-1", title: "Report" })).toEqual({
      text: "[Report](page:page-1)\nPlease read this.",
      pageContext: { pageId: "page-1" },
    });
  });
  it.each(["", " \n "])(
    "excludes a reference-only reply after persisted-caption trimming: %j",
    (body) => {
      const context = { pageId: "page-1", title: "https://attacker.example/report" };
      const storedCaption = withPageReplyContext(body, context).trim();
      expect(pageReplyOwnerText(storedCaption, context)).toBe("");
    },
  );
  it.each([
    "Report https://attacker.example/report",
    "Report\nhttps://attacker.example/report\r\nother text",
    "[Nested] https://attacker.example/report",
    "\\](page:pretend)\nhttps://attacker.example/report",
    "](https://attacker.example/report) [another link",
  ])("excludes the generated title %j while keeping the stored message unchanged", (title) => {
    const body = "Please compare with https://owner.example/report";
    const outgoing = pageReply(body, [], { id: "page-1", title });
    const context = { pageId: "page-1", title: PageTitleSchema.parse(title) };
    const persisted = JSON.parse(
      JSON.stringify({ text: withPageReplyContext(body, context), pageContext: context }),
    );
    expect(pageReplyOwnerText(persisted.text, persisted.pageContext)).toBe(body);
    expect(outgoing.text).toBe(`[${title.replace(/[\\[\]]/g, "\\$&")}](page:page-1)\n${body}`);
  });

  it("leaves the owner's chosen reply, loaded-card reply and explicit body URLs intact", () => {
    const body = "Read https://owner.example/report";
    const page = { id: "page-1", title: "https://attacker.example" };
    const card = {
      id: "message-1",
      blocks: [{ kind: "page" as const, pageId: page.id, title: page.title, version: 1 }],
    };
    expect(pageReplyOwnerText(pageReply(body, [card], page).text)).toBe(body);
    expect(pageReplyOwnerText(pageReply(body, [], page, "chosen-message").text)).toBe(body);
    const manualLink = "[https://owner.example/report](page:manual)\nMy explicit link";
    expect(
      pageReplyOwnerText(pageReply(manualLink, [], page).text, {
        pageId: page.id,
        title: page.title,
      }),
    ).toBe(manualLink);
  });

  it.each([
    null,
    "context",
    {},
    { pageId: "page-1" },
    { pageId: 1, title: "Report" },
    { pageId: "page-1", title: "" },
    { pageId: "page-1", title: "Report\nnot canonical" },
    { pageId: "another-page", title: "Report" },
    { pageId: "page-1", title: "Different title" },
  ])("does not turn malformed or mismatched JSON context into owner authority: %j", (context) => {
    const stored = "[Report](page:page-1)\nRead https://owner.example/report";
    expect(pageReplyOwnerText(stored, JSON.parse(JSON.stringify(context)))).toBe("");
  });

  it("does not remove ordinary text or malformed links that the fallback cannot produce", () => {
    for (const body of [
      "Read https://owner.example/report",
      "Read [https://owner.example](page:page-1)\nnow",
      "[https://owner.example](https://owner.example)\nnow",
      "[https://owner.example](page:bad id)\nnow",
      "[unescaped[nested]](page:page-1)\nnow",
      "[https://owner.example](page:page-1) without a newline",
      `[${"\\[".repeat(50_000)}`,
    ])
      expect(pageReplyOwnerText(body)).toBe(body);
  });
});

describe("uniquePages", () => {
  it("lists a page once, where it first appeared, when the list shifted between two reads", () => {
    const page = (id: string, read: number) => ({ id, read });
    expect(uniquePages([page("a", 1), page("b", 1), page("b", 2), page("c", 2)])).toEqual([
      page("a", 1),
      page("b", 1),
      page("c", 2),
    ]);
  });
});

describe("pageCardSuperseded", () => {
  const card = (id: string, pageId: string, version: number) => ({
    id,
    blocks: [{ kind: "page" as const, pageId, version, title: "Plan" }],
  });

  it("marks a card older only when a later card in the thread shows the same page", () => {
    const thread = [card("m1", "p1", 1), card("m2", "p2", 1), card("m3", "p1", 2)];
    const newest = newestPageCards(thread);
    expect(pageCardSuperseded(newest, "m1", { pageId: "p1", version: 1 })).toBe(true);
    expect(pageCardSuperseded(newest, "m3", { pageId: "p1", version: 2 })).toBe(false);
    expect(pageCardSuperseded(newest, "m2", { pageId: "p2", version: 1 })).toBe(false);
    // A routine's refresh or another chat's edit saves a newer version with no card here.
    const alone = newestPageCards([card("m1", "p1", 1)]);
    expect(pageCardSuperseded(alone, "m1", { pageId: "p1", version: 1 })).toBe(false);
    // A card folded under the reply after it is that reply's card.
    const folded = newestPageCards(thread, (id) => (id === "m3" ? "m4" : id));
    expect(pageCardSuperseded(folded, "m4", { pageId: "p1", version: 2 })).toBe(false);
  });
});

describe("page replies", () => {
  const page = (pageId: string, version: number): MessageBlock => ({
    kind: "page",
    pageId,
    version,
    title: `Page ${pageId}`,
  });
  const text = (value: string): MessageBlock => ({ kind: "text", text: value });
  const messages = [
    { id: "m1", blocks: [page("p1", 1)] },
    { id: "m2", blocks: [page("p2", 1)] },
    { id: "m3", blocks: [text("hi"), page("p1", 2)] },
    { id: "progress:run-1", blocks: [page("p1", 3)] },
    { id: "m4", blocks: [text("later")] },
  ];

  it("picks the newest saved message holding the page, never a live one or another page", () => {
    expect(pageReplyTargetId(messages, "p1")).toBe("m3");
    expect(pageReplyTargetId(messages, "p2")).toBe("m2");
    expect(pageReplyTargetId(messages, "p9")).toBeNull();
  });

  it("replies to the page's card, else links the page, and keeps a reply the user picked", () => {
    expect(pageReply("B", messages, { id: "p2", title: "Older" })).toEqual({
      text: "B",
      replyToMessageId: "m2",
    });
    expect(pageReply("B", messages, { id: "p9", title: "Q3 [draft]" })).toEqual({
      text: "[Q3 \\[draft\\]](page:p9)\nB",
      pageContext: { pageId: "p9" },
    });
    expect(pageReply("B", messages, { id: "p1", title: "Plan" }, "m4")).toEqual({ text: "B" });
    expect(pageReply("B", messages, null)).toEqual({ text: "B" });
  });
});
