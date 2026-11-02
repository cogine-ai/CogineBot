import type { PluginSearchInput, PluginSearchResult } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPluginDiscovery, initialPluginDiscovery } from "./plugin-discovery.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function page(name: string, nextCursor: string | null = null): PluginSearchResult {
  return {
    entries: [
      {
        id: `Cursor:${name}`,
        name,
        description: name,
        keywords: [],
        registry: "Cursor",
        source: `https://github.com/example/${name}`,
        installedSource: `https://github.com/example/${name}`,
      },
    ],
    nextCursor,
    unavailableRegistries: [],
    skippedEntries: 0,
  };
}
function fixture(
  search = vi.fn(async (_input: PluginSearchInput, _signal: AbortSignal) => page("first")),
) {
  let current = true;
  let state = initialPluginDiscovery;
  const changed = vi.fn((next: typeof state) => {
    state = next;
  });
  const manager = createPluginDiscovery({ search, isCurrent: () => current, changed });
  return {
    manager,
    search,
    changed,
    state: () => state,
    leave: () => {
      current = false;
    },
  };
}

describe("plugin discovery request isolation", () => {
  it("retains partial-registry diagnostics and uses the query-bound cursor for another page", async () => {
    const first = {
      ...page("first", "first-page-cursor"),
      unavailableRegistries: ["xAI"],
      skippedEntries: 3,
    };
    const f = fixture(
      vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce({
          ...page("next"),
          unavailableRegistries: ["xAI"],
          skippedEntries: 3,
        }),
    );
    await f.manager.search("  research  ");
    await f.manager.loadMore();
    expect(f.search.mock.calls.map((call) => call[0])).toEqual([
      { query: "research" },
      { query: "research", cursor: "first-page-cursor" },
    ]);
    expect(f.state().entries.map((entry) => entry.name)).toEqual(["first", "next"]);
    expect(f.state()).toMatchObject({
      nextCursor: null,
      unavailableRegistries: ["xAI"],
      skippedEntries: 3,
    });
  });
  it("discards both an old success and an old failure across an A-B-A query change", async () => {
    const first = deferred<PluginSearchResult>();
    const second = deferred<PluginSearchResult>();
    const third = deferred<PluginSearchResult>();
    const f = fixture(
      vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockReturnValueOnce(third.promise),
    );
    const a = f.manager.search("A");
    const b = f.manager.search("B");
    const again = f.manager.search("A");
    third.resolve(page("latest"));
    await again;
    first.resolve(page("old"));
    second.reject(new Error("late failure"));
    await Promise.all([a, b]);
    expect(f.state().entries[0]?.name).toBe("latest");
    expect(f.state().error).toBeNull();
    expect(f.search.mock.calls.slice(0, 2).every((call) => call[1].aborted)).toBe(true);
  });
  it("does not merge a late page into a new query", async () => {
    const oldPage = deferred<PluginSearchResult>();
    const f = fixture(
      vi
        .fn()
        .mockResolvedValueOnce(page("first", "cursor"))
        .mockReturnValueOnce(oldPage.promise)
        .mockResolvedValueOnce(page("replacement")),
    );
    await f.manager.search("original");
    const more = f.manager.loadMore();
    await f.manager.search("replacement");
    oldPage.resolve(page("old-page"));
    await more;
    expect(f.state().entries.map((entry) => entry.name)).toEqual(["replacement"]);
  });
  it("keeps a rejected stale-catalog page visible as an error, without mixing new entries", async () => {
    const f = fixture(
      vi
        .fn()
        .mockResolvedValueOnce(page("first", "old-snapshot"))
        .mockRejectedValueOnce(new Error("catalog changed"))
        .mockResolvedValueOnce(page("fresh")),
    );
    await f.manager.search("same");
    await f.manager.loadMore();
    expect(f.state()).toMatchObject({ phase: "error", nextCursor: "old-snapshot" });
    expect(f.state().entries[0]?.name).toBe("first");
    await f.manager.search("same");
    expect(f.state()).toMatchObject({ phase: "ready", nextCursor: null });
    expect(f.state().entries[0]?.name).toBe("fresh");
  });
  it.each(["scope", "dispose"])(
    "ignores a fetch completing after %s ends the view",
    async (reason) => {
      const pending = deferred<PluginSearchResult>();
      const f = fixture(vi.fn().mockReturnValue(pending.promise));
      const task = f.manager.search("research");
      if (reason === "scope") f.leave();
      else f.manager.dispose();
      const notifications = f.changed.mock.calls.length;
      pending.resolve(page("late"));
      await task;
      await f.manager.loadMore();
      expect(f.changed).toHaveBeenCalledTimes(notifications);
      expect(f.search).toHaveBeenCalledTimes(1);
    },
  );
  it("admits only one page request at a time", async () => {
    const next = deferred<PluginSearchResult>();
    const f = fixture(
      vi.fn().mockResolvedValueOnce(page("first", "cursor")).mockReturnValueOnce(next.promise),
    );
    await f.manager.search("");
    const one = f.manager.loadMore();
    await f.manager.loadMore();
    expect(f.search).toHaveBeenCalledTimes(2);
    next.resolve(page("second"));
    await one;
  });
});
