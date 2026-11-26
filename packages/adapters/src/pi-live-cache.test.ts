import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogFetch } from "./pi-live-cache.js";
import { LiveCatalogCache } from "./pi-live-cache.js";

function cache(maxEntries: number) {
  return new LiveCatalogCache<string>({
    maxEntries,
    now: Date.now,
    ttlMs: 1000,
    failureTtlMs: 30,
    waitMs: 10,
    deadlineMs: 100,
    staleMaxAgeMs: 2000,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("live model catalog cache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shares active refreshes, sheds excess reads and bounds settled entries separately", async () => {
    const catalog = cache(2);
    const slow = deferred<CatalogFetch<string>>();
    const first = vi.fn(() => slow.promise);
    const second = vi.fn(() => slow.promise);
    const third = vi.fn(async () => ({ attempted: true as const, models: ["third"] }));
    const one = catalog.read("one", first);
    const joined = catalog.read("one", first);
    const two = catalog.read("two", second);
    expect(await catalog.read("three", third)).toBeUndefined();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();

    slow.resolve({ attempted: true, models: ["first result"] });
    expect(await Promise.all([one, joined, two])).toEqual([
      ["first result"],
      ["first result"],
      ["first result"],
    ]);
    expect(await catalog.read("three", third)).toEqual(["third"]);
    expect(third).toHaveBeenCalledTimes(1);
    expect(await catalog.read("one", first, { cacheOnly: true })).toBeUndefined();
    expect(await catalog.read("two", second, { cacheOnly: true })).toEqual(["first result"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels expired work and discards a late answer after a successful retry", async () => {
    const catalog = cache(1);
    const slow = deferred<CatalogFetch<string>>();
    const probe = vi
      .fn<(signal: AbortSignal) => Promise<CatalogFetch<string>>>()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({ attempted: true, models: ["current"] });

    const read = catalog.read("account", probe);
    const signal = probe.mock.calls[0]![0];
    await vi.advanceTimersByTimeAsync(10);
    expect(await read).toBeUndefined();
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(90);
    expect(signal.aborted).toBe(true);
    expect(await catalog.read("account", probe)).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31);
    expect(await catalog.read("account", probe)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(await catalog.read("account", probe, { cacheOnly: true })).toEqual(["current"]);

    slow.resolve({ attempted: true, models: ["obsolete"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(await catalog.read("account", probe, { cacheOnly: true })).toEqual(["current"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
