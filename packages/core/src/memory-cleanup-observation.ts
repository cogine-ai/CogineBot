export type MemoryCleanupObservation = {
  memoryCleanupCursor?: number;
  memoryCleanupPending?: boolean;
  memoryCleanupUnconfirmed?: true;
};

type ThreadWorkObservation = {
  threadId: string;
  cursor?: number;
  run: { id: string } | null;
  activeRuns?: Array<{ id: string }>;
};

/** A send receipt can introduce a Run before its first durable event arrives. */
export function hasNewThreadWork(
  current: ThreadWorkObservation,
  started: ThreadWorkObservation | null,
): boolean {
  if (
    !started ||
    current.threadId !== started.threadId ||
    (current.cursor ?? -1) > (started.cursor ?? -1)
  )
    return true;
  const previous = new Set([
    ...(started.activeRuns ?? []).map((run) => run.id),
    ...(started.run ? [started.run.id] : []),
  ]);
  return [...(current.activeRuns ?? []), ...(current.run ? [current.run] : [])].some(
    (run) => !previous.has(run.id),
  );
}

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
