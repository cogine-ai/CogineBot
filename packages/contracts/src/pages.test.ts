import { describe, expect, it } from "vitest";
import { appContract } from "./index.js";
import {
  PAGE_TITLE_MAX_LENGTH,
  PageSummarySchema,
  PageTextContextSchema,
  PageTitleSchema,
  pageShareUrl,
  parsePageShareUrl,
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

it("lets a newer client's reply from a page reach an older server, which drops what it does not know", () => {
  const send = appContract.threads.send["~orpc"].inputSchema!;
  // An older server's thread send is this object without fromPage: an unknown key is dropped, not refused.
  expect(send.parse({ botId: "bot-1", text: "hi", fromPage: true, notYetKnown: true })).toEqual({
    botId: "bot-1",
    text: "hi",
    fromPage: true,
  });
});

it("rejects an unusable fallback Page identifier before resolving its title", () => {
  const send = appContract.threads.send["~orpc"].inputSchema!;
  expect(
    send.safeParse({ botId: "bot-1", text: "hi", pageContext: { pageId: "page\0a" } }).success,
  ).toBe(false);
});

it("keeps private page routes bounded and exposes no sharing command", () => {
  const list = appContract.pages.list["~orpc"].inputSchema!;
  expect(list.safeParse({ limit: 61 }).success).toBe(false);
  expect(list.safeParse({ query: " " }).success).toBe(false);
  expect(
    appContract.pages.get["~orpc"].inputSchema!.safeParse({ pageId: "page-1", link: true }).success,
  ).toBe(false);
  const get = appContract.pages.get["~orpc"].inputSchema!;
  for (const version of [0, -1, 1.5, 2_147_483_648]) {
    expect(get.safeParse({ pageId: "page-1", version }).success).toBe(false);
  }
  expect(get.safeParse({ pageId: "page-1", version: 2_147_483_647 }).success).toBe(true);
  expect("setVisibility" in appContract.pages).toBe(false);
});

it("accepts normalized owner URLs with any slug the Page share producer emits", () => {
  const token = "a".repeat(43);
  for (const title of ["Quarterly plan – draft", "计划", `${"a".repeat(59)} B longer`]) {
    const value = pageShareUrl("https://APP.example.test:443", title, token);
    const parsed = parsePageShareUrl(value);
    expect(parsed?.href).toBe(value);
    expect(parsed?.origin).toBe("https://app.example.test");
  }
  const local = `http://127.0.0.1:5173/p/${token}`;
  expect(parsePageShareUrl(local)?.href).toBe(local);
});

it("rejects owner URLs with invalid schemes, URL metadata or ungenerated slugs", () => {
  const token = "a".repeat(43);
  const base = "https://app.example.test";
  const path = `/p/plan-${token}`;
  for (const invalid of [
    path,
    `ftp://app.example.test${path}`,
    `https://account:password@app.example.test${path}`,
    `${base}${path}?download=1`,
    `${base}${path}?`,
    `${base}${path}#section`,
    `${base}${path}#`,
    `${base}${path}/extra`,
    `${base}/p/Plan-${token}`,
    `${base}/p/double--dash-${token}`,
    `${base}/p/${"a".repeat(61)}-${token}`,
    `${base}/p/plan${token}`,
    `${base}/p/%70lan-${token}`,
    `${base}/p/plan-${token.slice(1)}`,
    `${base}/p/plan-${token.slice(1)}!`,
  ]) {
    expect(parsePageShareUrl(invalid), invalid).toBeNull();
  }
});
