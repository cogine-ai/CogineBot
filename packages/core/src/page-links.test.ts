import { PageTitleSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  PAGE_REPLY_TASK_CONTEXT,
  pageLinksAsTitles,
  pageReplyOwnerText,
  pageReplyTaskPrompt,
  projectExternalPageMessages,
  withoutPrivatePageTargets,
  withPageReplyContext,
} from "./page-links.js";

describe("external Page text projection", () => {
  it("converts actual Page links and identifies their IDs without changing other Markdown", () => {
    const links: Array<[string, string]> = [];
    expect(
      pageLinksAsTitles(
        "Use `[example](page:code)` or \\[escaped](page:literal). Read [Q3 \\[draft\\]](page:page-1) and [the docs](https://example.test).",
        (pageId, title) => links.push([pageId, title]),
      ),
    ).toBe(
      "Use `[example](page:code)` or \\[escaped](page:literal). Read Q3 [draft] and [the docs](https://example.test).",
    );
    expect(links).toEqual([["page-1", "Q3 [draft]"]]);
  });

  it.each(["```", "~~~"])("leaves %s code fences alone while converting the next link", (fence) => {
    expect(
      pageLinksAsTitles(`${fence}md\r\n[example](page:code)\r\n${fence} \r\n[Plan](page:live)`),
    ).toBe(`${fence}md\r\n[example](page:code)\r\n${fence} \r\nPlan`);
  });

  it.each([
    { slashes: 1, opener: 2, closer: 1, code: true },
    { slashes: 3, opener: 3, closer: 2, code: true },
    { slashes: 2, opener: 2, closer: 2, code: true },
    { slashes: 1, opener: 1, closer: 1, code: false },
    { slashes: 2, opener: 2, closer: 1, code: false },
    { slashes: 1, opener: 2, closer: 2, code: false },
  ])(
    "handles $slashes escape characters before $opener ticks and $closer closing ticks",
    ({ slashes, opener, closer, code }) => {
      const start = "\\".repeat(slashes) + "`".repeat(opener);
      const end = "`".repeat(closer);
      const reference = "[Plan](page:live)";
      expect(pageLinksAsTitles(`${start}${reference}${end}`)).toBe(
        `${start}${code ? reference : "Plan"}${end}`,
      );
    },
  );

  it("keeps backslashes literal inside a code span and matches only the full closing run", () => {
    const source = "`[Code](page:inside) \\`` still code \\` then [Plan](page:live)";
    expect(pageLinksAsTitles(source)).toBe("`[Code](page:inside) \\`` still code \\` then Plan");
    expect(pageLinksAsTitles("`[Plan](page:live) \\`")).toBe("`[Plan](page:live) \\`");
  });

  it.each(["\n\n`close", "\r\n  \r\n`close", "\r\r`close"])(
    "leaves an escaped-run opener unmatched across an empty paragraph line",
    (ending) => {
      const start = "\\``";
      expect(pageLinksAsTitles(`${start}[Plan](page:live)${ending}`)).toBe(`${start}Plan${ending}`);
    },
  );

  it.each(["```", "~~~"])("does not pair an escaped-run opener with a %s fence", (fence) => {
    const start = "\\````";
    expect(pageLinksAsTitles(`${start}[Plan](page:live)\n${fence}\n`)).toBe(
      `${start}Plan\n${fence}\n`,
    );
  });

  it.each(["# heading", "> quote", "- list", "1. list"])(
    "does not pair an escaped-run opener with a closer inside %s",
    (block) => {
      const start = "\\``";
      const ending = `\n${block} \``;
      expect(pageLinksAsTitles(`${start}[Plan](page:live)${ending}`)).toBe(`${start}Plan${ending}`);
    },
  );

  it("keeps an external Page title when the other reference is only escaped-run code", () => {
    const [reply] = projectExternalPageMessages([
      {
        blocks: [
          { kind: "text", text: "\\``[Plan](page:live)` then \\`[Next](page:next)" },
          { kind: "page", pageId: "live", title: "Plan" },
          { kind: "page", pageId: "next", title: "Next" },
        ],
      },
    ]);
    expect(reply?.text).toBe("\\``[Plan](private page)` then \\`Next\nPlan");
  });

  it("handles many unmatched escaped-run suffixes without losing real Page links", () => {
    const example = "\\``[Plan](page:live) ";
    expect(pageLinksAsTitles(example.repeat(20_000))).toBe("\\``Plan ".repeat(20_000));
  });

  it("accepts a long malformed label without swallowing the next valid link", () => {
    const malformed = "[".repeat(100_000);
    expect(pageLinksAsTitles(`${malformed}[Plan](page:live)`)).toBe(`${malformed}Plan`);
  });

  it("strips reserved targets and known IDs without changing unrelated text", () => {
    expect(
      withoutPrivatePageTargets(
        "`[example](page:private-code)` bare page:other-id, p1, p10, and https://example.test.",
        new Set(["p1"]),
      ),
    ).toBe(
      "`[example](private page)` bare private page, private page, p10, and https://example.test.",
    );
  });

  it("recognizes an ID introduced by a bare Page target throughout the same outgoing result", () => {
    const [reply] = projectExternalPageMessages([
      {
        blocks: [
          { kind: "text", text: "The old reference was private-draft; unrelated draft remains." },
          { kind: "text", text: "See page:private-draft or private-draft-later." },
        ],
      },
    ]);
    expect(reply?.text).toBe(
      "The old reference was private page; unrelated draft remains.\nSee private page or private-draft-later.",
    );
  });
});

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
