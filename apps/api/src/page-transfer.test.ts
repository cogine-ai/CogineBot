import { PAGE_SOURCE_MAX_BYTES, PageTransferRecordSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { remapTransferredPageLinks } from "./page-transfer.js";

const date = "2026-10-20T12:34:56.123Z";
const version = {
  type: "page_version",
  id: "old-version",
  pageId: "old-page",
  version: 1,
  title: "Report",
  source: "source text",
  createdAt: date,
};

describe("Page transfer records", () => {
  it("preserves valid source and enforces the UTF-8 size limit and PostgreSQL text domain", () => {
    const source = "🙂".repeat(PAGE_SOURCE_MAX_BYTES / 4);
    expect(PageTransferRecordSchema.parse({ ...version, source })).toMatchObject({ source });
    for (const invalid of [`${source}a`, "nul\0byte", "lone\uD800surrogate"]) {
      expect(PageTransferRecordSchema.safeParse({ ...version, source: invalid }).success).toBe(
        false,
      );
    }
  });

  it.each([
    { code: "precompiled content" },
    { ownerId: "other-owner" },
    { shareTokenHash: "token" },
    { shareSecretId: "secret" },
    { version: 0 },
    { version: 2_147_483_648 },
    { createdAt: "2026-02-30T00:00:00Z" },
    { pageId: "wrong\uD800id" },
  ])("rejects invalid metadata and nonportable fields (%j)", (fields) => {
    expect(PageTransferRecordSchema.safeParse({ ...version, ...fields }).success).toBe(false);
  });

  it("changes actual Page link targets and leaves escaped labels and other text intact", () => {
    const before = [
      String.raw`[Label\]](page:old-page) [Other](page:retained) [Again](page:old-page)`,
      "`[Example](page:old-page)` [Unmapped](page:outside) bare (page:old-page)",
      String.raw`\[Escaped](page:old-page)`,
      "```text\n[Literal](page:old-page)\n```",
    ].join("\n");
    const mapped = new Map([
      ["old-page", "new-page"],
      ["retained", "new-other"],
    ]);
    expect(remapTransferredPageLinks(before, mapped)).toBe(
      before.replace(
        String.raw`[Label\]](page:old-page) [Other](page:retained) [Again](page:old-page)`,
        String.raw`[Label\]](page:new-page) [Other](page:new-other) [Again](page:new-page)`,
      ),
    );
  });
});
