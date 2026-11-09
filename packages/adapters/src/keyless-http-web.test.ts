import type { AdapterContext, WebFetchProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { FakeWebProvider } from "./fake-web.js";
import {
  extractReadableText,
  KeylessHttpWebProvider,
  parseDuckDuckGoResults,
} from "./keyless-http-web.js";
import { serializeToolResult } from "./pi-runtime.js";
import { clampMaxChars, clampMaxResults, MAX_WEB_FETCH_OFFSET, pageWindow } from "./web-limits.js";
import { createWebProvider, resolveWebProviderKind } from "./web-provider-factory.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

describe("web provider factory", () => {
  it("defaults to keyless-http", () => {
    expect(resolveWebProviderKind({})).toBe("keyless-http");
    expect(createWebProvider().describe().id).toBe("keyless-http");
    expect(createWebProvider("fake").describe().id).toBe("fake");
  });
});

describe("keyless HTTP web provider", () => {
  it("searches via the HTML backend without a vendor API key", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fa">Alpha</a>
        <a class="result__snippet">Snippet A</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.test/b">Beta</a>
        <div class="result__snippet">Snippet B</div>
      </div>
    `;
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const results = await provider.search({ query: "alpha", maxResults: 5 }, ctx);
    expect(results).toEqual([
      { title: "Alpha", url: "https://example.test/a", snippet: "Snippet A" },
      { title: "Beta", url: "https://example.test/b", snippet: "Snippet B" },
    ]);
  });

  it("fetches readable page text with truncation", async () => {
    const long = "word ".repeat(100);
    const html = `<html><head><title>Doc</title></head><body><article><p>${long}</p></article></body></html>`;
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const result = await provider.fetch({ url: "https://example.test/doc", maxChars: 120 }, ctx);
    expect(result.title).toBeTruthy();
    expect(result.url).toBe("https://example.test/doc");
    expect(result.truncated).toBe(true);
    expect(result).toMatchObject({ offset: 0, nextOffset: 120 });
    const next = await provider.fetch(
      { url: result.url, offset: result.nextOffset, maxChars: 120 },
      ctx,
    );
    const full = await provider.fetch({ url: result.url }, ctx);
    expect(result.text + next.text).toBe(full.text.slice(0, 240));
  });

  it.each(["text/plain", "text/markdown"])(
    "reads %s literally and continues without gaps",
    async (mediaType) => {
      const content = `${"a".repeat(99)}😀\n## Heading\n\n  <em>literal</em>\n`;
      const fetch = vi.fn(
        async () =>
          new Response(content, { headers: { "Content-Type": `${mediaType}; charset=UTF-8` } }),
      );
      const provider = new KeylessHttpWebProvider({ fetch, resolveHostname: publicResolver });
      const url = "https://example.test/doc";
      const first = await provider.fetch({ url, maxChars: 100, offset: -3 }, ctx);
      expect(first).toMatchObject({
        text: content.slice(0, 99),
        offset: 0,
        nextOffset: 99,
        truncated: true,
      });
      const next = await provider.fetch({ url, maxChars: 100, offset: first.nextOffset }, ctx);
      expect(next.truncated).toBe(false);
      expect(next.nextOffset).toBeUndefined();
      expect(first.text + next.text).toBe(content);
      await expect(provider.fetch({ url, offset: 100 }, ctx)).rejects.toThrow("character boundary");
      await expect(provider.fetch({ url, offset: content.length }, ctx)).resolves.toMatchObject({
        text: "",
        truncated: false,
      });
    },
  );

  it("resumes at the prefix actually returned to the model for a large page request", async () => {
    const url = "https://example.test/doc";
    const content = '"\n😀 example'.repeat(2_000);
    const provider = new KeylessHttpWebProvider({
      fetch: async () => new Response(content, { headers: { "content-type": "text/plain" } }),
      resolveHostname: publicResolver,
    });
    const request = { url, maxChars: 50_000 };
    const gate = vi.fn();
    const raw = await webFetchFromTool(provider, ctx, request, gate);
    expect(raw).toMatchObject({ text: content, truncated: false });
    const view = JSON.parse(serializeToolResult(raw, "current", "web_fetch", request));
    const first = view.result;
    expect(first.text).toBe(content.slice(0, first.nextOffset));
    expect(first.nextOffset).toBeGreaterThan(0);
    expect(first.nextOffset).toBeLessThan(content.length);
    const next = await webFetchFromTool(
      provider,
      ctx,
      { ...request, offset: first.nextOffset },
      gate,
    );
    expect(next).toMatchObject({ text: content.slice(first.nextOffset), truncated: false });
  });

  it("rejects an excessive offset before network access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const resolveHostname = vi.fn(publicResolver);
    const provider = new KeylessHttpWebProvider({ fetch, resolveHostname });
    await expect(
      provider.fetch(
        {
          url: "https://example.test/doc",
          offset: MAX_WEB_FETCH_OFFSET + 1,
        },
        ctx,
      ),
    ).rejects.toThrow(String(MAX_WEB_FETCH_OFFSET));
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it("still checks the redirect destination during a continuation read", async () => {
    const url = "https://example.test/doc";
    const destination = "https://other.example.test/doc";
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: destination } }),
    );
    const resolveHostname = vi.fn(publicResolver);
    const assertRedirectAllowed = vi.fn(() => {
      throw new Error("needs approval");
    });
    const provider = new KeylessHttpWebProvider({ fetch, resolveHostname });
    await expect(
      webFetchFromTool(provider, ctx, { url, offset: 100 }, assertRedirectAllowed),
    ).resolves.toEqual({ error: "needs approval" });
    expect(assertRedirectAllowed).toHaveBeenCalledExactlyOnceWith(destination);
    expect(resolveHostname).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to HTML strip when Readability finds nothing", () => {
    const extracted = extractReadableText(
      "<html><title>Plain</title><body><div>just text here</div></body></html>",
      "https://example.test/",
    );
    expect(extracted.title).toBe("Plain");
    expect(extracted.text).toContain("just text here");
  });

  it("parses HTML search results with a cap", () => {
    const html = Array.from({ length: 12 }, (_, i) => {
      return `<div class="result"><a class="result__a" href="https://example.test/${i}">T${i}</a><div class="result__snippet">S${i}</div></div>`;
    }).join("");
    expect(parseDuckDuckGoResults(html, 3)).toHaveLength(3);
  });
});

describe("web tool apply with fake provider", () => {
  it("returns injected search and fetch results", async () => {
    const fake = new FakeWebProvider();
    fake.searchHits = [
      { title: "One", url: "https://example.test/1", snippet: "s1" },
      { title: "Two", url: "https://example.test/2", snippet: "s2" },
    ];
    fake.fetchResult = {
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      truncated: false,
    };

    await expect(webSearchFromTool(fake, ctx, { query: "q", maxResults: 1 })).resolves.toEqual({
      results: [{ title: "One", url: "https://example.test/1", snippet: "s1" }],
    });
    expect(fake.lastSearch?.query).toBe("q");

    const assertRedirectAllowed = vi.fn();
    await expect(
      webFetchFromTool(
        fake,
        ctx,
        { url: "https://example.test/1", maxChars: 100 },
        assertRedirectAllowed,
      ),
    ).resolves.toEqual({
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      offset: 0,
      truncated: false,
    });
    await expect(
      webFetchFromTool(
        fake,
        ctx,
        {
          url: "https://example.test/1",
          offset: 5,
        },
        assertRedirectAllowed,
      ),
    ).resolves.toMatchObject({ text: "text", offset: 5, truncated: false });
    expect(fake.lastFetch?.offset).toBe(5);
    expect(fake.lastFetch?.assertRedirectAllowed).toBe(assertRedirectAllowed);
  });

  it("leaves earlier providers usable without silently replaying page one", async () => {
    const fetch = vi.fn(async () => ({
      url: "https://example.test/doc",
      title: "Legacy",
      text: "Body",
      truncated: false,
    }));
    const provider: WebFetchProvider = {
      describe: () => ({
        id: "fixture",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { fetch: true, readability: true },
      }),
      fetch,
    };
    const url = "https://example.test/doc";
    const check = vi.fn();
    await expect(webFetchFromTool(provider, ctx, { url }, check)).resolves.toMatchObject({
      text: "Body",
    });
    await expect(webFetchFromTool(provider, ctx, { url, offset: 10 }, check)).resolves.toEqual({
      error: "This web provider does not support page offsets.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces provider errors as tool errors", async () => {
    const fake = new FakeWebProvider();
    fake.searchError = new Error("boom");
    await expect(webSearchFromTool(fake, ctx, { query: "q" })).resolves.toEqual({
      error: "boom",
    });
  });
});

describe("web tool clamps", () => {
  it("offers a continuation only within the global and provider limits", () => {
    expect(pageWindow("abc", 2, MAX_WEB_FETCH_OFFSET - 2).nextOffset).toBe(MAX_WEB_FETCH_OFFSET);
    expect(pageWindow("abc", 2, MAX_WEB_FETCH_OFFSET - 1)).toEqual({
      text: "ab",
      truncated: true,
      offset: MAX_WEB_FETCH_OFFSET - 1,
    });
    expect(pageWindow("abc", 2, 1, 2).nextOffset).toBeUndefined();
  });

  it("clamps maxResults and maxChars", () => {
    expect(clampMaxResults(undefined)).toBe(5);
    expect(clampMaxResults(100)).toBe(10);
    expect(clampMaxResults(0)).toBe(1);
    expect(clampMaxChars(undefined)).toBe(8_000);
    expect(clampMaxChars(10)).toBe(100);
    expect(clampMaxChars(999_999)).toBe(50_000);
  });
});
