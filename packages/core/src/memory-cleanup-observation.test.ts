import { describe, expect, it } from "vitest";
import {
  applyThreadClearReceipt,
  applyThreadRunCancellations,
  hasNewThreadWork,
  observeMemoryCleanup,
  shouldResetHistoryAfterClear,
  threadClearCancelledRunIds,
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
  it("applies cumulative cancellation evidence without changing admitted history boundaries", () => {
    const run = { id: "cancelled", status: "queued" };
    const fresh = { id: "fresh", status: "queued" };
    const anchor = { id: "anchor", observedEventSeq: 20, runId: fresh.id };
    const current = {
      threadId: "thread",
      cursor: 30,
      observedClearSeq: 24,
      olderCursor: 1,
      memoryCleanupCursor: 35,
      messages: [anchor, { id: "cancelled-row", runId: run.id }],
      run,
      activeRuns: [run, fresh],
    };
    const next = applyThreadRunCancellations(current, [run.id]);
    expect(next).toEqual({ ...current, run: null, activeRuns: [fresh], messages: [anchor] });
    expect(next.messages[0]).toBe(anchor);
  });
  it("keeps the same snapshot when cumulative cancellations have no matching work", () => {
    const current = {
      threadId: "thread",
      cursor: 30,
      olderCursor: null,
      messages: [{ id: "boundary", observedEventSeq: 24 }],
      run: { id: "fresh", status: "queued" },
    };
    expect(applyThreadRunCancellations(current, [])).toBe(current);
    expect(applyThreadRunCancellations(current, ["cancelled"])).toBe(current);
  });
  it.each([20, 18])(
    "applies cancellation IDs independently of the known clear boundary (%s)",
    (seq) => {
      const run = { id: "cancelled-run", status: "queued" };
      const fresh = { id: "fresh-run", status: "queued" };
      const current = {
        threadId: "thread",
        cursor: 20,
        observedClearSeq: 20,
        olderCursor: 1,
        messages: [{ id: "anchor", observedEventSeq: 20 }],
        run,
        activeRuns: [run, fresh],
      };
      const next = applyThreadClearReceipt(current, null, {
        clearEventSeq: seq,
        cancelledRunIds: [run.id],
      });
      expect(next.run).toBeNull();
      expect(next.activeRuns).toEqual([fresh]);
      expect(next.messages).toBe(current.messages);
      expect(next.olderCursor).toBe(1);
      expect(next.observedClearSeq).toBe(20);
    },
  );
  it("preserves an uncancelled active send receipt before its event advances the cursor", () => {
    const run = { id: "post-clear-run", status: "queued" };
    const current = {
      threadId: "thread",
      cursor: 15,
      messages: [{ id: "old", observedEventSeq: 15 }],
      run,
      activeRuns: [run],
    };
    const next = applyThreadClearReceipt(current, null, {
      clearEventSeq: 20,
      cancelledRunIds: ["old-run"],
    });
    expect(next.run).toBe(run);
    expect(next.activeRuns).toEqual([run]);
    expect(next.messages).toEqual([]);
  });
  it("does not treat cancellation IDs from an older clear as complete evidence for a later clear", () => {
    const run = { id: "unknown-later-run", status: "queued" };
    const current = { threadId: "thread", cursor: 15, messages: [], run, activeRuns: [run] };
    const next = applyThreadClearReceipt(current, null, {
      clearEventSeq: 20,
      cancelledRunIds: ["older-run"],
      cancelledRunIdsSeq: 12,
    });
    expect(next.run).toBeNull();
    expect(next.activeRuns).toEqual([]);
  });
  it("does not filter an admitted boundary page when the same receipt is applied again", () => {
    const current = {
      threadId: "thread",
      cursor: 20,
      observedClearSeq: 20,
      olderCursor: 1,
      messages: [{ id: "anchor", observedEventSeq: 20 }],
      run: null,
    };
    expect(applyThreadClearReceipt(current, null, { clearEventSeq: 20, cancelledRunIds: [] })).toBe(
      current,
    );
  });
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

describe("post-clear history windows", () => {
  it("retains a page and anchor loaded entirely after the clear", () => {
    const current = {
      threadId: "thread",
      cursor: 20,
      run: null,
      messages: [{ id: "anchor", observedEventSeq: 15 }],
      olderCursor: 7,
    };
    const next = applyThreadClearReceipt(current, null, { clearEventSeq: 12 });
    expect(next.olderCursor).toBe(7);
    expect(shouldResetHistoryAfterClear(current, next, "anchor")).toBe(false);
  });
  it("retains a valid anchor while dropping the old page prefix", () => {
    const current = {
      threadId: "thread",
      cursor: 20,
      run: null,
      messages: [
        { id: "old", observedEventSeq: 10 },
        { id: "anchor", observedEventSeq: 15 },
      ],
      olderCursor: 7,
    };
    const next = applyThreadClearReceipt(current, null, { clearEventSeq: 12 });
    expect(next.messages.map(({ id }) => id)).toEqual(["anchor"]);
    expect(next.olderCursor).toBeNull();
    expect(shouldResetHistoryAfterClear(current, next, "anchor")).toBe(false);
    expect(shouldResetHistoryAfterClear(current, next, "old")).toBe(true);
  });
  it("ignores an older clear receipt without resetting the current search window", () => {
    const current = {
      threadId: "thread",
      cursor: 30,
      observedClearSeq: 25,
      run: null,
      messages: [{ id: "anchor", observedEventSeq: 26 }],
      olderCursor: 7,
    };
    const next = applyThreadClearReceipt(current, null, { clearEventSeq: 12 });
    expect(next).toBe(current);
    expect(shouldResetHistoryAfterClear(current, next, "anchor")).toBe(false);
  });
  it("does not treat another thread's request snapshot as a new send receipt", () => {
    const current = {
      threadId: "thread",
      cursor: 10,
      run: { id: "old-completed-run" },
      messages: [{ id: "old", observedEventSeq: 10 }],
    };
    const next = applyThreadClearReceipt(
      current,
      { threadId: "other", cursor: 10, run: null },
      { clearEventSeq: 12, cancelledRunIds: [] },
    );
    expect(next.run).toBeNull();
    expect(next.messages).toEqual([]);
  });
});

describe("clear cancellation evidence", () => {
  it.each([undefined, {}, { cancelledRunIds: "run-one" }, { cancelledRunIds: [1] }])(
    "leaves absent or malformed cancellation evidence unknown (%j)",
    (payload) => {
      expect(threadClearCancelledRunIds(payload)).toBeUndefined();
    },
  );
  it("distinguishes a canonical empty cancellation list from missing evidence", () => {
    expect(threadClearCancelledRunIds({ cancelledRunIds: [] })).toEqual([]);
    expect(threadClearCancelledRunIds({ cancelledRunIds: ["run-one"] })).toEqual(["run-one"]);
  });
});
