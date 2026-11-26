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

  it("shares the bounded refresh with an explicit check and lets a user retry a known failure", async () => {
    const catalog = new LiveCatalogCache<string, "timeout">({
      maxEntries: 2,
      now: Date.now,
      ttlMs: 1000,
      failureTtlMs: 30,
      waitMs: 10,
      deadlineMs: 100,
      deadlineFailure: "timeout",
      staleMaxAgeMs: 2000,
    });
    const slow = deferred<CatalogFetch<string>>();
    const probe = vi
      .fn<(signal: AbortSignal) => Promise<CatalogFetch<string>>>()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({ attempted: true, models: ["current"] });
    const background = catalog.read("account", probe);
    const explicit = catalog.readObservation("account", probe, { waitForRefresh: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(await background).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90);
    expect((await explicit).failure).toBe("timeout");
    expect(await catalog.read("account", probe)).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await catalog.readObservation("account", probe, { waitForRefresh: true })).toMatchObject(
      { models: ["current"] },
    );
    expect(probe).toHaveBeenCalledTimes(2);
    slow.resolve({ attempted: true, models: ["obsolete"] });
    expect(await catalog.read("account", probe)).toEqual(["current"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps stale models for browsing while explicit checks shed excess refreshes", async () => {
    const catalog = new LiveCatalogCache<string, "auth">({
      maxEntries: 1,
      now: Date.now,
      ttlMs: 1000,
      failureTtlMs: 30,
      waitMs: 10,
      deadlineMs: 100,
      staleMaxAgeMs: 2000,
    });
    const probe = vi
      .fn<(signal: AbortSignal) => Promise<CatalogFetch<string, "auth">>>()
      .mockResolvedValueOnce({ attempted: true, models: ["old"] })
      .mockResolvedValueOnce({ attempted: true, failure: "auth" });
    expect(await catalog.read("one", probe)).toEqual(["old"]);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await catalog.read("one", probe)).toEqual(["old"]);
    await vi.advanceTimersByTimeAsync(0);

    const slow = deferred<CatalogFetch<string>>();
    const other = catalog.readObservation("two", () => slow.promise, { waitForRefresh: true });
    const rejected = await catalog.readObservation("one", probe, { waitForRefresh: true });
    expect(rejected).toEqual({});
    expect(await catalog.read("one", probe)).toEqual(["old"]);
    expect(probe).toHaveBeenCalledTimes(2);
    slow.resolve({ attempted: true, models: ["other"] });
    expect((await other).models).toEqual(["other"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
