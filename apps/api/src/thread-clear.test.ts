import type { AdapterContext, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import { runJobKey } from "@rakazo/adapter-kit";
import type { MemoryProviderResolver } from "@rakazo/adapters";
import type { ClearThreadInput, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { clearThreadConversation } from "./thread-clear.js";

const input = { spaceId: "space-one", botId: "bot-one", threadId: "thread-one" };
const context: AdapterContext = {
  ...input,
  userId: "user-one",
  operationId: "clear-one",
  traceId: "trace-one",
  signal: new AbortController().signal,
};
function fixture() {
  const phases: string[] = [];
  const receipt = {
    cancelledRunIds: ["run-one"],
    historyCompactionGeneration: 3,
    memoryCleanupUnconfirmed: undefined as true | undefined,
    event: {
      ...input,
      id: "clear-event",
      seq: 1,
      type: "thread.cleared" as const,
      createdAt: new Date(0).toISOString(),
      payload: {},
    },
  };
  const clearThread = vi.fn<ThreadEvents["clearThread"]>(async () => {
    phases.push("local commit");
    return receipt;
  });
  const markMemoryCleanupUnconfirmed = vi.fn(async () => {
    phases.push("uncertainty commit");
  });
  const purgeHistory = vi.fn<SemanticMemoryProvider["purgeHistory"]>(async () => {
    phases.push("external purge");
    return { ok: true, value: undefined };
  });
  const resolve = vi.fn<MemoryProviderResolver["resolve"]>(async () => ({
    provider: {
      describe: () => ({
        id: "fixture",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true },
      }),
      recall: async () => ({ ok: true, value: [] }),
      save: async () => ({ ok: true, value: undefined }),
      purgeHistory,
    },
    defaultScope: "isolated",
  }));
  const saved = vi.fn(async () => null as { spaceId: string } | null);
  const cancel = vi.fn(async () => false);
  const deps = {
    prisma: { spaceMemoryConfig: { findUnique: saved } },
    events: { clearThread, markMemoryCleanupUnconfirmed },
    jobs: { cancel },
    memoryProviders: { resolve },
  };
  const execute = (scope: ClearThreadInput = input) =>
    clearThreadConversation(
      deps as unknown as Parameters<typeof clearThreadConversation>[0],
      scope,
      context,
    );
  return {
    execute,
    receipt,
    phases,
    clearThread,
    markMemoryCleanupUnconfirmed,
    purgeHistory,
    resolve,
    saved,
    cancel,
  };
}

describe("clear conversation cleanup outcome", () => {
  it("commits the local clear before network cleanup and keeps the actual generation scope", async () => {
    const f = fixture();
    await expect(f.execute()).resolves.toEqual({ ok: true });
    expect(f.phases).toEqual(["local commit", "external purge"]);
    expect(f.purgeHistory).toHaveBeenCalledWith(
      { botId: input.botId, generations: [2, 3] },
      context,
    );
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(runJobKey("run-one"));
    expect(f.markMemoryCleanupUnconfirmed).not.toHaveBeenCalled();
  });
  it.each(["denied", "throws", "resolution fails", "disabled", "config lookup fails"])(
    "exposes an unconfirmed cleanup when %s",
    async (mode) => {
      const f = fixture();
      if (mode === "denied")
        f.purgeHistory.mockResolvedValue({
          ok: false,
          error: "synthetic secret must not be returned",
        });
      if (mode === "throws")
        f.purgeHistory.mockRejectedValue(new Error("synthetic secret must not be returned"));
      if (mode === "resolution fails")
        f.resolve.mockRejectedValue(new Error("synthetic secret must not be returned"));
      if (mode === "disabled" || mode === "config lookup fails") f.resolve.mockResolvedValue(null);
      if (mode === "disabled") f.saved.mockResolvedValue({ spaceId: input.spaceId });
      if (mode === "config lookup fails")
        f.saved.mockRejectedValue(new Error("configuration unavailable"));
      await expect(f.execute()).resolves.toEqual({ ok: true, memoryCleanupUnconfirmed: true });
      expect(f.markMemoryCleanupUnconfirmed).toHaveBeenCalledExactlyOnceWith(input);
      expect(f.phases.at(-1)).toBe("uncertainty commit");
    },
  );
  it("keeps a prior uncertainty when the requested newer generations now succeed", async () => {
    const f = fixture();
    f.clearThread.mockResolvedValue({
      ...f.receipt,
      cancelledRunIds: [],
      historyCompactionGeneration: 5,
      memoryCleanupUnconfirmed: true,
    });
    await expect(f.execute()).resolves.toEqual({ ok: true, memoryCleanupUnconfirmed: true });
    expect(f.purgeHistory).toHaveBeenCalledOnce();
    expect(f.markMemoryCleanupUnconfirmed).toHaveBeenCalledOnce();
  });
  it("does not invent a failure when no provider is configured", async () => {
    const f = fixture();
    f.resolve.mockResolvedValue(null);
    await expect(f.execute()).resolves.toEqual({ ok: true });
    expect(f.saved).toHaveBeenCalledExactlyOnceWith({
      where: { spaceId: input.spaceId },
      select: { spaceId: true },
    });
    expect(f.markMemoryCleanupUnconfirmed).not.toHaveBeenCalled();
  });
  it("does not probe or clear external history for a group", async () => {
    const f = fixture();
    await expect(f.execute({ ...input, groupId: "group-one" })).resolves.toEqual({
      ok: true,
    });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.saved).not.toHaveBeenCalled();
    expect(f.purgeHistory).not.toHaveBeenCalled();
  });
  it("does not report a recorded failure when its persistence transaction fails", async () => {
    const f = fixture();
    f.purgeHistory.mockRejectedValue(new Error("denied"));
    f.markMemoryCleanupUnconfirmed.mockRejectedValue(new Error("state transaction failed"));
    await expect(f.execute()).rejects.toThrow("state transaction failed");
  });
});
