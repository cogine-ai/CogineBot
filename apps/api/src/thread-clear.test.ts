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
  let sticky = false;
  const cleanup = {
    token: "clear:4",
    kind: "clear" as const,
    generations: [2, 3],
    connectionId: "connection-one",
  };
  const clearThread = vi.fn<ThreadEvents["clearThread"]>(async (scope) => {
    const config = scope.groupId ? null : await saved();
    phases.push("local commit");
    return {
      cancelledRunIds: ["run-one"],
      historyCompactionGeneration: 3,
      ...(sticky ? { memoryCleanupUnconfirmed: true as const } : {}),
      ...(config
        ? { cleanup: { ...cleanup, connectionId: config?.secretId }, memoryCleanupPending: true }
        : { memoryCleanupPending: false }),
      event: {
        ...input,
        id: "clear-event",
        seq: 1,
        type: "thread.cleared",
        createdAt: new Date(0).toISOString(),
        payload: {},
      },
    };
  });
  const settleMemoryCleanup = vi.fn<ThreadEvents["settleMemoryCleanup"]>(
    async ({ unconfirmed }) => {
      phases.push("settlement commit");
      sticky ||= unconfirmed;
      return { ...(sticky ? { memoryCleanupUnconfirmed: true } : {}), memoryCleanupPending: false };
    },
  );
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
    connectionId: "connection-one",
  }));
  const saved = vi.fn(async () => ({ secretId: "connection-one" }) as { secretId: string } | null);
  const cancel = vi.fn(async () => false);
  const deps = {
    prisma: { spaceMemoryConfig: { findUnique: saved } },
    events: { clearThread, settleMemoryCleanup },
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
    phases,
    clearThread,
    settleMemoryCleanup,
    purgeHistory,
    resolve,
    saved,
    cancel,
    setSticky: () => {
      sticky = true;
    },
  };
}

describe("clear conversation cleanup outcome", () => {
  it("registers cleanup in the local clear before network work and settles only its actual generation scope", async () => {
    const f = fixture();
    await expect(f.execute()).resolves.toEqual({
      ok: true,
      threadId: input.threadId,
      memoryCleanupCursor: 1,
      memoryCleanupPending: false,
    });
    expect(f.phases).toEqual(["local commit", "external purge", "settlement commit"]);
    expect(f.clearThread).toHaveBeenCalledExactlyOnceWith({
      ...input,
    });
    expect(f.purgeHistory).toHaveBeenCalledExactlyOnceWith(
      { botId: input.botId, generations: [2, 3] },
      context,
    );
    expect(f.settleMemoryCleanup).toHaveBeenCalledExactlyOnceWith({
      ...input,
      token: "clear:4",
      unconfirmed: false,
    });
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(runJobKey("run-one"));
  });
  it.each(["denied", "throws", "resolution fails", "disabled"])(
    "retains an unconfirmed cleanup when %s",
    async (mode) => {
      const f = fixture();
      if (mode === "denied")
        f.purgeHistory.mockResolvedValue({ ok: false, error: "synthetic private error" });
      if (mode === "throws") f.purgeHistory.mockRejectedValue(new Error("synthetic private error"));
      if (mode === "resolution fails")
        f.resolve.mockRejectedValue(new Error("synthetic private error"));
      if (mode === "disabled") f.resolve.mockResolvedValue(null);
      await expect(f.execute()).resolves.toEqual({
        ok: true,
        threadId: input.threadId,
        memoryCleanupCursor: 1,
        memoryCleanupUnconfirmed: true,
        memoryCleanupPending: false,
      });
      expect(f.settleMemoryCleanup).toHaveBeenCalledExactlyOnceWith({
        ...input,
        token: "clear:4",
        unconfirmed: true,
      });
    },
  );
  it("retains a prior failure after another cleanup succeeds", async () => {
    const f = fixture();
    f.setSticky();
    await expect(f.execute()).resolves.toMatchObject({
      ok: true,
      memoryCleanupUnconfirmed: true,
      memoryCleanupPending: false,
    });
  });
  it("does not create cleanup work when no provider is configured", async () => {
    const f = fixture();
    f.saved.mockResolvedValue(null);
    await expect(f.execute()).resolves.toEqual({
      ok: true,
      threadId: input.threadId,
      memoryCleanupCursor: 1,
      memoryCleanupPending: false,
    });
    expect(f.clearThread).toHaveBeenCalledExactlyOnceWith(input);
    expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.settleMemoryCleanup).not.toHaveBeenCalled();
  });
  it("does not probe or clear external history for a group", async () => {
    const f = fixture();
    await expect(f.execute({ ...input, groupId: "group-one" })).resolves.toMatchObject({
      ok: true,
      memoryCleanupPending: false,
    });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.saved).not.toHaveBeenCalled();
    expect(f.purgeHistory).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "returns the committed local clear when settlement fails (purge failed: %s)",
    async (failed) => {
      const f = fixture();
      if (failed) f.purgeHistory.mockResolvedValue({ ok: false, error: "denied" });
      f.settleMemoryCleanup.mockRejectedValue(new Error("state transaction failed"));
      await expect(f.execute()).resolves.toEqual({
        ok: true,
        threadId: input.threadId,
        memoryCleanupCursor: 1,
        memoryCleanupPending: true,
      });
      expect(f.purgeHistory).toHaveBeenCalledOnce();
    },
  );
  it("does not call a provider if registering the destructive clear fails", async () => {
    const f = fixture();
    f.clearThread.mockRejectedValue(new Error("transaction failed"));
    await expect(f.execute()).rejects.toThrow("transaction failed");
    expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.purgeHistory).not.toHaveBeenCalled();
  });
  it("does not let a replacement connection settle the original responsibility", async () => {
    const f = fixture();
    f.saved.mockResolvedValue({ secretId: "replacement-connection" });
    await expect(f.execute()).resolves.toMatchObject({ memoryCleanupUnconfirmed: true });
    expect(f.purgeHistory).not.toHaveBeenCalled();
    expect(f.resolve).toHaveBeenCalledOnce();
  });
  it("pins the resolved connection instead of loading a replacement after commit", async () => {
    const f = fixture();
    await f.execute();
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(input.spaceId);
    expect(f.purgeHistory).toHaveBeenCalledOnce();
    expect(f.clearThread).toHaveBeenCalledExactlyOnceWith(input);
  });
});
