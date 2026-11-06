import { describe, expect, it } from "vitest";
import { appContract } from "./index.js";
import {
  PAGE_SOURCE_MAX_BYTES,
  PAGE_TITLE_MAX_LENGTH,
  PageSourceSchema,
  PageSummarySchema,
  PageTextContextSchema,
  PageTitleSchema,
} from "./pages.js";

describe("PageTitleSchema", () => {
  it("folds line breaks and control characters into single spaces", () => {
    expect(PageTitleSchema.parse("  Q3\nplan\r\n\tdraft\u0000 \u2028end ")).toBe(
      "Q3 plan draft end",
    );
  });

  it("refuses titles that are empty or too long once folded", () => {
    expect(PageTitleSchema.safeParse("\n\t\u0007").success).toBe(false);
    expect(PageTitleSchema.safeParse("x".repeat(PAGE_TITLE_MAX_LENGTH)).success).toBe(true);
    expect(PageTitleSchema.safeParse("x".repeat(PAGE_TITLE_MAX_LENGTH + 1)).success).toBe(false);
  });
});

it("accepts only canonical server Page text metadata after JSON restoration", () => {
  const context = { pageId: "page-1", title: "Report https://title.example/private [draft]" };
  expect(PageTextContextSchema.parse(JSON.parse(JSON.stringify(context)))).toEqual(context);
  for (const title of ["", " Q3 plan", "Q3\nplan", "Q3\u0000plan", "x".repeat(201)]) {
    expect(PageTextContextSchema.safeParse({ ...context, title }).success).toBe(false);
  }
  expect(PageTextContextSchema.safeParse({ ...context, extra: true }).success).toBe(false);
});

it("bounds the titles pages send out by the cap a saved title has", () => {
  const at = "2026-11-02T10:00:00.000Z";
  const summary = (title: string) =>
    PageSummarySchema.safeParse({
      id: "page-1",
      title,
      botId: null,
      groupId: null,
      visibility: "private",
      currentVersion: 1,
      pinned: false,
      createdAt: at,
      updatedAt: at,
    }).success;
  const longest = "x".repeat(PAGE_TITLE_MAX_LENGTH);
  expect(summary(longest)).toBe(true);
  expect(summary(`${longest}x`)).toBe(false);
});

describe("PageSourceSchema", () => {
  it("measures source in UTF-8 bytes, as the save check does", () => {
    expect(PageSourceSchema.safeParse("x".repeat(PAGE_SOURCE_MAX_BYTES)).success).toBe(true);
    expect(PageSourceSchema.safeParse("x".repeat(PAGE_SOURCE_MAX_BYTES + 1)).success).toBe(false);
    // Fewer characters than the limit, more bytes.
    expect(PageSourceSchema.safeParse("é".repeat(PAGE_SOURCE_MAX_BYTES / 2)).success).toBe(true);
    expect(PageSourceSchema.safeParse(`${"é".repeat(PAGE_SOURCE_MAX_BYTES / 2)}x`).success).toBe(
      false,
    );
  });
});

it("lets a newer client's reply from a page reach an older server, which drops what it does not know", () => {
  const send = appContract.threads.send["~orpc"].inputSchema!;
  // An older server's thread send is this object without fromPage: an unknown key is dropped, not refused.
  expect(send.parse({ botId: "bot-1", text: "hi", fromPage: true, notYetKnown: true })).toEqual({
    botId: "bot-1",
    text: "hi",
    fromPage: true,
  });
});

it("keeps private page routes bounded and exposes no sharing command", () => {
  const list = appContract.pages.list["~orpc"].inputSchema!;
  expect(list.safeParse({ limit: 61 }).success).toBe(false);
  expect(list.safeParse({ query: " " }).success).toBe(false);
  expect(
    appContract.pages.get["~orpc"].inputSchema!.safeParse({ pageId: "page-1", link: true }).success,
  ).toBe(false);
  expect("setVisibility" in appContract.pages).toBe(false);
});
