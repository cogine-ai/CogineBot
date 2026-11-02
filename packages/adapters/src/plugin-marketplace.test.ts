import { PluginSearchResultSchema } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMarketplace,
  PluginMarketplaceCursorError,
  parsePluginMarketplace,
} from "./plugin-marketplace.js";

const registry = { name: "Cursor", repository: "https://github.com/example/plugins" };
const index = (plugins: unknown[]) => JSON.stringify({ name: "example", plugins });
const sha = "a".repeat(40);
const plugins = (count: number, prefix = "plugin") =>
  Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${String(i).padStart(3, "0")}`,
    source: `${prefix}-${i}`,
  }));
afterEach(() => vi.restoreAllMocks());

describe("public plugin index parsing", () => {
  it("maps relative directories and xAI URL pins into canonical import sources", () => {
    const result = parsePluginMarketplace(
      index([
        { name: "notes", source: "./notes", description: "Daily notes" },
        { name: "local", source: { type: "local", path: "./external_plugins/local" } },
        {
          name: "tasks",
          source: { source: "url", url: "https://github.com/Example/Tasks.git", sha },
          keywords: ["planning"],
        },
      ]),
      registry,
    );
    expect(result).toEqual({
      entries: [
        {
          id: "Cursor:https://github.com/example/plugins#notes",
          name: "notes",
          description: "Daily notes",
          keywords: [],
          registry: "Cursor",
          source: "https://github.com/example/plugins#notes",
          installedSource: "https://github.com/example/plugins#notes",
        },
        expect.objectContaining({
          source: "https://github.com/example/plugins#external_plugins/local",
        }),
        expect.objectContaining({
          source: `https://github.com/example/tasks@${sha}`,
          installedSource: "https://github.com/example/tasks",
          keywords: ["planning"],
        }),
      ],
      skipped: 0,
    });
  });

  it("deduplicates URL aliases while reporting unsafe or malformed sources", () => {
    const result = parsePluginMarketplace(
      index([
        { name: "valid", source: "https://github.com/example/valid/tree/main/subdir" },
        { name: "duplicate", source: "https://github.com/example/valid@main#subdir" },
        { name: "traversal", source: "../escape" },
        { name: "absolute", source: "/root" },
        { name: "private", source: "https://127.0.0.1/a/b" },
        { name: "credentials", source: "https://user:password@github.com/a/b" },
        { name: "encoded", source: "./%2e%2e/escape" },
        { name: "local-escape", source: { type: "local", path: "./../escape" } },
        { name: "pin", source: { source: "url", url: "https://github.com/a/b@other", sha } },
        {
          name: "invalid-pin",
          source: { source: "url", url: "https://github.com/a/b", sha: "main" },
        },
        { name: "bad-metadata", source: "fine", keywords: Array(51).fill("keyword") },
      ]),
      registry,
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source).toBe("https://github.com/example/valid@main#subdir");
    expect(result.skipped).toBe(10);
  });

  it("keeps distinct URL-object subdirectories in pinned sources and installed identity", () => {
    const result = parsePluginMarketplace(
      index([
        {
          name: "alpha",
          source: {
            source: "url",
            url: "https://github.com/Example/Bundle.git",
            sha,
            path: "plugins/alpha",
          },
        },
        {
          name: "beta",
          source: {
            source: "url",
            url: "https://github.com/example/bundle",
            sha,
            path: "plugins/beta",
          },
        },
        {
          name: "same-alpha",
          source: {
            source: "url",
            url: `https://github.com/example/bundle/tree/${sha}/plugins/alpha`,
            sha,
            path: "./plugins/alpha",
          },
        },
      ]),
      { name: "xAI", repository: registry.repository },
    );
    expect(
      result.entries.map(({ source, installedSource }) => ({ source, installedSource })),
    ).toEqual([
      {
        source: `https://github.com/example/bundle@${sha}#plugins/alpha`,
        installedSource: "https://github.com/example/bundle#plugins/alpha",
      },
      {
        source: `https://github.com/example/bundle@${sha}#plugins/beta`,
        installedSource: "https://github.com/example/bundle#plugins/beta",
      },
    ]);
    expect(new Set(result.entries.map(({ id }) => id)).size).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it("rejects conflicting URL subdirectories and unknown URL-object semantics", () => {
    const result = parsePluginMarketplace(
      index([
        {
          name: "hash-match",
          source: {
            source: "url",
            url: "https://github.com/example/bundle#plugins/alpha",
            sha,
            path: "plugins/alpha",
          },
        },
        {
          name: "hash-conflict",
          source: {
            source: "url",
            url: "https://github.com/example/bundle#plugins/alpha",
            sha,
            path: "plugins/beta",
          },
        },
        {
          name: "tree-conflict",
          source: {
            source: "url",
            url: `https://github.com/example/bundle/tree/${sha}/plugins/alpha`,
            sha,
            path: "plugins/beta",
          },
        },
        {
          name: "unknown",
          source: {
            source: "url",
            url: "https://github.com/example/bundle",
            sha,
            subpath: "plugins/beta",
          },
        },
      ]),
      registry,
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source).toBe(
      `https://github.com/example/bundle@${sha}#plugins/alpha`,
    );
    expect(result.skipped).toBe(3);
  });

  it.each([
    "",
    ".",
    "./",
    "../escape",
    "./../escape",
    "/absolute",
    "//absolute",
    "C:/absolute",
    "./C:/absolute",
    "file:outside",
    "plugins\\escape",
    "plugins/../escape",
    "plugins/./escape",
    "plugins//escape",
    "plugins/",
    "%2e%2e/escape",
    "plugins%2fescape",
    "plugins?query",
    "plugins#hash",
    "plugins/alpha\n",
    "\tplugins/alpha",
    "plugins/\u0000alpha",
    "a".repeat(2049),
    null,
    4,
  ])("rejects unsafe or non-string URL-object paths (%j)", (path) => {
    const result = parsePluginMarketplace(
      index([
        {
          name: "unsafe",
          source: { source: "url", url: "https://github.com/example/bundle", sha, path },
        },
      ]),
      registry,
    );
    expect(result).toEqual({ entries: [], skipped: 1 });
  });

  it("bounds the combined pinned source rather than only its individual fields", () => {
    const url = "https://github.com/example/bundle";
    const fitting = "a".repeat(2048 - url.length - sha.length - 2);
    const result = parsePluginMarketplace(
      index([
        { name: "fits", source: { source: "url", url, sha, path: fitting } },
        { name: "overflow", source: { source: "url", url, sha, path: `${fitting}a` } },
      ]),
      registry,
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source).toHaveLength(2048);
    expect(result.skipped).toBe(1);
  });

  it.each(["not-json", "null", "[]", '{"plugins":{}}', index(Array(1001).fill({}))])(
    "rejects malformed or oversized index structure",
    (raw) => expect(() => parsePluginMarketplace(raw, registry)).toThrow(),
  );

  it("accepts the 1000-entry bound and measures UTF-8 bytes rather than string length", () => {
    expect(parsePluginMarketplace(index(plugins(1000)), registry).entries).toHaveLength(1000);
    const oversized = index([{ name: "large", source: "large", unknown: "界".repeat(700_000) }]);
    expect(oversized.length).toBeLessThan(2_000_000);
    expect(() => parsePluginMarketplace(oversized, registry)).toThrow(/too large/);
  });
});

describe("bounded public plugin search", () => {
  it("uses only fixed registry paths and reports partial failures without exposing diagnostics", async () => {
    const read = vi.fn(async (url: string, maxBytes: number, signal?: AbortSignal) => {
      expect(maxBytes).toBe(2_000_000);
      expect(signal).toBeInstanceOf(AbortSignal);
      if (url.includes("xai-org")) throw new Error("private-provider-diagnostic");
      return index([{ name: "Notes", description: "Daily planning", source: "notes" }, {}]);
    });
    const result = await createPluginMarketplace(read).search({ query: "DAILY planning" });
    expect(result).toMatchObject({
      entries: [expect.objectContaining({ name: "Notes" })],
      nextCursor: null,
      unavailableRegistries: ["xAI"],
      skippedEntries: 1,
    });
    expect(JSON.stringify(result)).not.toContain("private-provider-diagnostic");
    expect(read.mock.calls.map(([url]) => url)).toEqual([
      "https://raw.githubusercontent.com/cursor/plugins/HEAD/.cursor-plugin/marketplace.json",
      "https://raw.githubusercontent.com/xai-org/plugin-marketplace/HEAD/.grok-plugin/marketplace.json",
    ]);
    expect(PluginSearchResultSchema.safeParse(result).success).toBe(true);
  });

  it("filters all metadata words, caches success for 60s and retries failed registries", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    let failed = true;
    const read = vi.fn(async (url: string) => {
      if (url.includes("xai-org")) {
        if (failed) throw new Error("unavailable");
        return index([{ name: "Tasks", source: "tasks", keywords: ["planning"] }]);
      }
      return index([{ name: "Notes", source: "notes", description: "Daily planning" }]);
    });
    const service = createPluginMarketplace(read);
    expect((await service.search({ query: "PLANNING daily" })).entries.map((e) => e.name)).toEqual([
      "Notes",
    ]);
    failed = false;
    expect((await service.search({ query: "planning" })).entries.map((e) => e.name)).toEqual([
      "Notes",
      "Tasks",
    ]);
    expect(read).toHaveBeenCalledTimes(3);
    expect((await service.search({ query: "xAI planning" })).entries[0]?.name).toBe("Tasks");
    expect((await service.search({ query: "no match" })).entries).toEqual([]);
    expect(read).toHaveBeenCalledTimes(3);
    now.mockReturnValue(61_000);
    await service.search({ query: "" });
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("does not cache invalid or oversized bodies and preserves both-registry unavailability", async () => {
    let invalid = true;
    const read = vi.fn(async (url: string) =>
      invalid
        ? url.includes("xai-org")
          ? "界".repeat(700_000)
          : "private malformed response"
        : index([]),
    );
    const service = createPluginMarketplace(read);
    expect(await service.search({ query: "" })).toEqual({
      entries: [],
      nextCursor: null,
      unavailableRegistries: ["Cursor", "xAI"],
      skippedEntries: 0,
    });
    invalid = false;
    expect((await service.search({ query: "" })).unavailableRegistries).toEqual([]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("shares fetches while one caller aborts without cancelling another or poisoning success", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(async () => gate);
    const service = createPluginMarketplace(read);
    const controller = new AbortController();
    const cancelled = service.search({ query: "" }, controller.signal);
    const kept = service.search({ query: "notes" });
    const rejected = expect(cancelled).rejects.toThrow("caller cancelled");
    controller.abort(new Error("caller cancelled"));
    await rejected;
    release(index([{ name: "Notes", source: "notes" }]));
    expect((await kept).entries).toHaveLength(2);
    await service.search({ query: "" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("enforces the independent 15s deadline even when a reader ignores abort", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    let stalled = true;
    const read = vi.fn(async () => (stalled ? gate : index([])));
    const service = createPluginMarketplace(read);
    const searching = service.search({ query: "" });
    deadline.abort(new Error("deadline"));
    expect((await searching).unavailableRegistries).toEqual(["Cursor", "xAI"]);
    expect(timeout.mock.calls).toEqual([[15_000], [15_000]]);
    release(index([{ name: "Late", source: "late" }]));
    stalled = false;
    timeout.mockRestore();
    expect((await service.search({ query: "" })).entries).toEqual([]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("does not fetch for an already-aborted caller", async () => {
    const read = vi.fn(async () => index([]));
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      createPluginMarketplace(read).search({ query: "" }, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("catalog-bound pagination", () => {
  it("keeps returned metadata from mutating the cached cursor authority", async () => {
    const service = createPluginMarketplace(async () =>
      index(plugins(51).map((entry) => ({ ...entry, keywords: ["original"] }))),
    );
    const first = await service.search({ query: "" });
    first.entries[0]!.name = "changed by a consumer";
    first.entries[0]!.keywords.push("changed");
    expect((await service.search({ query: "", cursor: first.nextCursor! })).entries).toHaveLength(
      50,
    );
    expect((await service.search({ query: "" })).entries[0]).toMatchObject({
      name: "plugin-000",
      keywords: ["original"],
    });
  });

  it("returns deterministic disjoint pages of 50 bound to the exact normalized query", async () => {
    const read = vi.fn(async (url: string) =>
      index(url.includes("xai-org") ? plugins(60, "second") : plugins(51, "first")),
    );
    const service = createPluginMarketplace(read);
    const first = await service.search({ query: " " });
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor!.length).toBeLessThanOrEqual(1024);
    const second = await service.search({ query: "", cursor: first.nextCursor! });
    const third = await service.search({ query: "", cursor: second.nextCursor! });
    expect(second.entries).toHaveLength(50);
    expect(third.entries).toHaveLength(11);
    expect(third.nextCursor).toBeNull();
    expect(
      new Set([...first.entries, ...second.entries, ...third.entries].map((e) => e.id)).size,
    ).toBe(111);
    expect(read).toHaveBeenCalledTimes(2);
    const matching = await service.search({ query: "  FIRST  " });
    expect(
      (await service.search({ query: "first", cursor: matching.nextCursor! })).entries,
    ).toHaveLength(1);
  });

  it("rejects malformed, mismatched-query, or out-of-range cursors before returning another page", async () => {
    const read = vi.fn(async () => index(plugins(51)));
    const service = createPluginMarketplace(read);
    for (const cursor of [
      "",
      "not+base64",
      "a".repeat(1025),
      Buffer.from("{}").toString("base64url"),
    ])
      await expect(service.search({ query: "", cursor })).rejects.toBeInstanceOf(
        PluginMarketplaceCursorError,
      );
    expect(read).not.toHaveBeenCalled();
    const first = await service.search({ query: "" });
    await expect(service.search({ query: "different", cursor: first.nextCursor! })).rejects.toThrow(
      "Invalid plugin search cursor. Start a new search.",
    );
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString());
    for (const patch of [{ offset: 0 }, { offset: 1 }, { offset: 2050 }, { extra: true }]) {
      const cursor = Buffer.from(JSON.stringify({ ...decoded, ...patch })).toString("base64url");
      await expect(service.search({ query: "", cursor })).rejects.toBeInstanceOf(
        PluginMarketplaceCursorError,
      );
    }
    const beyondEnd = Buffer.from(JSON.stringify({ ...decoded, offset: 150 })).toString(
      "base64url",
    );
    await expect(service.search({ query: "", cursor: beyondEnd })).rejects.toBeInstanceOf(
      PluginMarketplaceCursorError,
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(["metadata", "availability"] as const)(
    "rejects catalog drift after cache expiration (%s)",
    async (change) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1000);
      let changed = false;
      const read = vi.fn(async (url: string) => {
        if (changed && change === "availability" && url.includes("xai-org"))
          throw new Error("down");
        return index([
          ...plugins(51),
          { name: "metadata", source: "metadata", description: changed ? "new" : "old" },
        ]);
      });
      const service = createPluginMarketplace(read);
      const first = await service.search({ query: "" });
      changed = true;
      now.mockReturnValue(61_000);
      await expect(service.search({ query: "", cursor: first.nextCursor! })).rejects.toThrow(
        "The plugin catalog changed. Start a new search.",
      );
      expect(read).toHaveBeenCalledTimes(4);
    },
  );
});
