import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import * as DbModule from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import type { RunWorkerHost } from "./run-wakeup.js";
import { drainRuns, RUN_DRAIN_MS, withRunWorker } from "./run-wakeup.js";

afterEach(() => vi.useRealTimers());

describe("a stopping process's runs", () => {
  it("claims nothing when collaboration authorization finishes after stopping", async () => {
    const stopping = new AbortController();
    const drain = drainRuns(stopping.signal);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorize = vi
      .spyOn(DbModule, "authorizeCollaborationRunStart")
      .mockImplementation(async () => {
        enter();
        await released;
        return { allowed: true, notices: [] };
      });
    const claim = vi.fn(async () => ({ count: 0 }));
    const run = {
      id: "run-1",
      botId: "bot-1",
      spaceId: "space-1",
      userId: "user-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "queued",
      trigger: "bot_message",
      origin: "bot_peer",
      quotaWait: null,
      checkpoint: null,
      leaseFence: 0,
    };
    const prisma = {
      run: { findUnique: vi.fn(async () => run), updateMany: claim },
      $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
    } as unknown as PrismaClient;
    const model = vi.fn();
    const executor = createRunExecutor({
      prisma,
      stoppingSignal: stopping.signal,
      shutdownSignal: drain.signal,
      runtime: { describe: () => ({ capabilities: { scripted: false } }), run: model },
      events: { notify: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const work = executor.continueRun(run.id, "leaving");
    void work.catch(() => undefined);
    try {
      await entered;
      stopping.abort();
      expect(drain.signal.aborted).toBe(false);
      release();
      await work;
      expect(claim).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
    } finally {
      release();
      await work.catch(() => undefined);
      authorize.mockRestore();
      drain.end();
    }
  });

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
