export type MemoryCleanupObservation = {
  memoryCleanupCursor?: number;
  memoryCleanupPending?: boolean;
  memoryCleanupUnconfirmed?: true;
};

/** Cleanup receipts must not consume intervening message or Run events. */
export function observeMemoryCleanup<T extends MemoryCleanupObservation>(
  snapshot: T,
  incoming: { memoryCleanupPending?: unknown; memoryCleanupUnconfirmed?: unknown },
  seq: number,
  baseline = -1,
): T {
  const current = snapshot.memoryCleanupCursor ?? baseline;
  const next = {
    ...snapshot,
    ...(incoming.memoryCleanupUnconfirmed === true ? { memoryCleanupUnconfirmed: true } : {}),
    ...(seq >= current
      ? {
          memoryCleanupCursor: seq,
          ...(typeof incoming.memoryCleanupPending === "boolean"
            ? { memoryCleanupPending: incoming.memoryCleanupPending }
            : {}),
        }
      : {}),
  };
  return next.memoryCleanupCursor === snapshot.memoryCleanupCursor &&
    next.memoryCleanupPending === snapshot.memoryCleanupPending &&
    next.memoryCleanupUnconfirmed === snapshot.memoryCleanupUnconfirmed
    ? snapshot
    : next;
}
