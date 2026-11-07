import { PageTitleSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  PAGE_REPLY_TASK_CONTEXT,
  pageReplyOwnerText,
  pageReplyTaskPrompt,
  withPageReplyContext,
} from "./page-links.js";

describe("server-owned Page provenance", () => {
  it("keeps model context after owner words", () => {
    expect(pageReplyTaskPrompt(" Compare ", { pageId: "page-1", title: "Q3 [draft]" })).toBe(
      `Compare${PAGE_REPLY_TASK_CONTEXT}[Q3 \\[draft\\]](page:page-1)`,
    );
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
    const context = { pageId: "page-1", title: PageTitleSchema.parse(title) };
    const persisted = JSON.parse(
      JSON.stringify({ text: withPageReplyContext(body, context), pageContext: context }),
    );
    expect(pageReplyOwnerText(persisted.text, persisted.pageContext)).toBe(body);
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
