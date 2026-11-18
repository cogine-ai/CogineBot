import { describe, expect, it } from "vitest";
import { observeMemoryCleanup } from "./memory-cleanup-observation.js";

describe("cleanup observation ordering", () => {
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
