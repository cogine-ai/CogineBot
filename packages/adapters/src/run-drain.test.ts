import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainRuns, RUN_DRAIN_MS, type RunWorkerHost, withRunWorker } from "./run-wakeup.js";

afterEach(() => vi.useRealTimers());

describe("a stopping process's runs", () => {
  it("interrupts active turns before a fatal scheduler startup waits for them", async () => {
    const stopping = new AbortController();
    const drain = drainRuns(stopping.signal);
    const failure = new Error("synthetic scheduler startup failure");
    const ended = new Promise<void>((resolve) =>
      drain.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    const runs = { start: vi.fn(async () => undefined), stop: vi.fn(() => ended) };
    const background = {
      start: vi.fn(async () => {
        throw failure;
      }),
      stop: vi.fn(async () => undefined),
    };
    const host = withRunWorker(runs as unknown as RunWorkerHost, background, () => {
      drain.end();
      stopping.abort();
    });
    const starting = host.start({} as BackgroundJobHandlers);
    void starting.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(drain.signal.aborted).toBe(true), { timeout: 250 });
      await expect(starting).rejects.toBe(failure);
      expect(stopping.signal.aborted).toBe(true);
      expect(runs.stop).toHaveBeenCalledOnce();
      expect(background.stop).toHaveBeenCalledOnce();
    } finally {
      drain.end();
      await starting.catch(() => undefined);
      await host.stop();
    }
  });

  it("gives the runs in flight the drain limit, counted from the stop", () => {
    vi.useFakeTimers();
    const stopping = new AbortController();
    const drain = drainRuns(stopping.signal);

    // Time before the stop is not part of the limit.
    vi.advanceTimersByTime(RUN_DRAIN_MS * 2);
    expect(drain.signal.aborted).toBe(false);

    stopping.abort();
    expect(drain.signal.aborted).toBe(false);
    vi.advanceTimersByTime(RUN_DRAIN_MS - 1);
    expect(drain.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(drain.signal.aborted).toBe(true);
    expect(drain.signal.reason).toBe(stopping.signal.reason);
  });

  it("counts the limit for a process that was already stopping", () => {
    vi.useFakeTimers();
    const stopping = new AbortController();
    stopping.abort();
    const drain = drainRuns(stopping.signal, 1_000);

    vi.advanceTimersByTime(999);
    expect(drain.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(drain.signal.aborted).toBe(true);
  });

  it("stops the runs with the process when it has no drain limit", () => {
    const stopping = new AbortController();
    const drain = drainRuns(stopping.signal, 0);

    expect(drain.signal.aborted).toBe(false);
    stopping.abort();
    expect(drain.signal.aborted).toBe(true);
  });

  it.each(["before the stop", "during the drain"])(
    "stops the runs at once when the drain is ended %s",
    (when) => {
      vi.useFakeTimers();
      const stopping = new AbortController();
      const drain = drainRuns(stopping.signal, 1_000);
      if (when === "during the drain") stopping.abort();

      drain.end();
      expect(drain.signal.aborted).toBe(true);

      stopping.abort();
      drain.end();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
