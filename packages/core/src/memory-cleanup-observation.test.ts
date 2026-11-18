import { describe, expect, it } from "vitest";
import {
  applyThreadClearReceipt,
  hasNewThreadWork,
  observeMemoryCleanup,
} from "./memory-cleanup-observation.js";

describe("cleanup observation ordering", () => {
  it("recognizes a new send receipt before its event cursor advances", () => {
    const started = { threadId: "thread-one", cursor: 5, run: null };
    expect(hasNewThreadWork({ ...started, run: { id: "new-run" } }, started)).toBe(true);
    expect(hasNewThreadWork({ ...started, activeRuns: [{ id: "new-run" }] }, started)).toBe(true);
    expect(hasNewThreadWork({ ...started, run: null }, started)).toBe(false);
    expect(hasNewThreadWork({ ...started, threadId: "other" }, started)).toBe(true);
  });
  it("rejects stale pending metadata without consuming intervening messages", () => {
    const receipt = observeMemoryCleanup(
      { cursor: 5, memoryCleanupPending: true },
      { memoryCleanupPending: false },
      20,
    );
    expect(receipt).toMatchObject({
      cursor: 5,
      memoryCleanupPending: false,
      memoryCleanupCursor: 20,
    });
    expect(observeMemoryCleanup(receipt, { memoryCleanupPending: true }, 10)).toEqual(receipt);
  });
  it("applies an older cleanup observation after newer unrelated activity", () => {
    expect(
      observeMemoryCleanup(
        { cursor: 40, memoryCleanupCursor: 5, memoryCleanupPending: false },
        { memoryCleanupPending: true },
        10,
      ),
    ).toMatchObject({ cursor: 40, memoryCleanupPending: true, memoryCleanupCursor: 10 });
  });
  it("never clears an actual prior failure, including an older failure observation", () => {
    const state = { memoryCleanupCursor: 20, memoryCleanupPending: false };
    const failed = observeMemoryCleanup(state, { memoryCleanupUnconfirmed: true }, 10);
    expect(failed).toMatchObject({ memoryCleanupUnconfirmed: true, memoryCleanupCursor: 20 });
    expect(observeMemoryCleanup(failed, { memoryCleanupPending: false }, 21)).toMatchObject({
      memoryCleanupUnconfirmed: true,
    });
  });
});

describe("clear receipt boundaries", () => {
  it("removes pre-clear events while retaining post-clear messages and work", () => {
    const started = { threadId: "thread", cursor: 10, run: { id: "cancelled" } };
    const current = {
      ...started,
      cursor: 14,
      messages: [
        { id: "old", observedEventSeq: 10 },
        { id: "before-clear", observedEventSeq: 11 },
        { id: "after-clear", observedEventSeq: 13 },
      ],
      run: { id: "new" },
      activeRuns: [{ id: "cancelled" }, { id: "new" }],
      memoryCleanupCursor: 20,
    };
    const cleared = applyThreadClearReceipt(current, started, {
      clearEventSeq: 12,
      cancelledRunIds: ["cancelled"],
    });
    expect(cleared.messages.map((message) => message.id)).toEqual(["after-clear"]);
    expect(cleared.run?.id).toBe("new");
    expect(cleared.activeRuns).toEqual([{ id: "new" }]);
    expect(cleared.cursor).toBe(14);
    expect(cleared.memoryCleanupCursor).toBe(20);
  });
  it("retains an uncancelled send receipt at the original event cursor", () => {
    const started = { threadId: "thread", cursor: 10, run: null };
    const current = {
      ...started,
      run: { id: "new" },
      activeRuns: [{ id: "new" }],
      messages: [{ id: "old", observedEventSeq: 10 }],
    };
    const cleared = applyThreadClearReceipt(current, started, {
      clearEventSeq: 12,
      cancelledRunIds: [],
    });
    expect(cleared.messages).toEqual([]);
    expect(cleared.run?.id).toBe("new");
    expect(cleared.cursor).toBe(12);
  });
});
