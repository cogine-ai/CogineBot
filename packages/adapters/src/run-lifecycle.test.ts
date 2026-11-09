import { runContinueJob, runQuotaResumeJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor.js";
import { startNextWaitingRun } from "./run-lifecycle.js";

type Row = { id: string; status?: string; wakeAt?: Date; quotaWait?: unknown };

function deps(...rows: (Row | null)[]) {
  const findFirst = vi.fn(async () => rows.shift() ?? null);
  const enqueue = vi.fn(async () => undefined);
  return {
    deps: { prisma: { run: { findFirst } }, jobs: { enqueue } } as unknown as ExecutorDeps,
    findFirst,
    enqueue,
  };
}

describe("starting the next run waiting for a bot's computer", () => {
  it("starts the oldest other due run of the bot, leaving failure backoff alone", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z") });
    try {
      const f = deps({ id: "waiting", status: "queued" });
      await startNextWaitingRun(f.deps, "bot", "finished");
      expect(f.findFirst).toHaveBeenCalledWith({
        where: {
          botId: "bot",
          id: { not: "finished" },
          OR: [
            {
              status: "queued",
              OR: [{ wakeAt: null }, { wakeAt: { lte: new Date("2026-10-28T12:00:00Z") } }],
            },
            { status: "waiting_limit", wakeAt: { lte: new Date("2026-10-28T12:00:00Z") } },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, status: true, wakeAt: true, quotaWait: true },
      });
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("waiting"));
    } finally {
      vi.useRealTimers();
    }
  });

  const quotaWait = {
    beganAt: "2026-10-28T10:00:00.000Z",
    until: "2026-10-28T11:00:00.000Z",
    revision: 2,
    dispatchedFence: null,
    target: {
      provider: "synthetic",
      modelId: "synthetic-model",
      modelCredentialId: null,
      connectionRevision: null,
      endpointDigest: "a".repeat(64),
      costOwner: "deployment",
    },
  };

  it("wakes the quota revision without changing the durable deadline or schedule", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z") });
    try {
      const wakeAt = new Date("2026-10-28T11:59:59Z");
      const f = deps({ id: "waiting", status: "waiting_limit", wakeAt, quotaWait });
      await startNextWaitingRun(f.deps, "bot", "finished");
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runQuotaResumeJob("waiting", 2, wakeAt));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { ...quotaWait, dispatchedFence: 7 },
    { ...quotaWait, until: "2026-10-28T13:00:00.000Z" },
    {},
  ])("keeps a queued waiter eligible when a quota receipt cannot resume (%j)", async (state) => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z") });
    try {
      const wakeAt = new Date("2026-10-28T11:59:59Z");
      const f = deps(
        { id: "quota", status: "waiting_limit", wakeAt, quotaWait: state },
        { id: "queued" },
      );
      await startNextWaitingRun(f.deps, "bot", "finished");
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("queued"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when no run is waiting", async () => {
    const f = deps(null);
    await startNextWaitingRun(f.deps, "bot", "finished");
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
