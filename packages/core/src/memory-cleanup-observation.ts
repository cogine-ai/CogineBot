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

/** The clear commit is earlier than cleanup settlement and owns only pre-clear activity. */
export function applyThreadClearReceipt<
  T extends ThreadWorkObservation & {
    messages: Array<{ id: string; observedEventSeq?: number; runId?: string | null }>;
    olderCursor?: number | null;
    observedClearSeq?: number;
  },
>(
  snapshot: T,
  started: ThreadWorkObservation | null,
  receipt: { clearEventSeq: number; cancelledRunIds?: string[] },
): T {
  if (receipt.clearEventSeq < (snapshot.observedClearSeq ?? -1)) return snapshot;
  const cancelled = new Set(receipt.cancelledRunIds ?? []);
  const previous = new Set([
    ...(started?.activeRuns ?? []).map((run) => run.id),
    ...(started?.run ? [started.run.id] : []),
  ]);
  const keepRun = (run: { id: string }) =>
    !cancelled.has(run.id) &&
    ((snapshot.cursor ?? -1) > receipt.clearEventSeq ||
      (started !== null && !previous.has(run.id)));
  return {
    ...snapshot,
    cursor: Math.max(snapshot.cursor ?? -1, receipt.clearEventSeq),
    observedClearSeq: receipt.clearEventSeq,
    messages: snapshot.messages.filter(
      (message) =>
        (message.observedEventSeq ?? snapshot.cursor ?? -1) > receipt.clearEventSeq &&
        (!message.runId || !cancelled.has(message.runId)),
    ),
    olderCursor: null,
    run: snapshot.run && keepRun(snapshot.run) ? snapshot.run : null,
    activeRuns: snapshot.activeRuns?.filter(keepRun),
  };
}

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

/** Snapshot compatibility preserves an unresolved outcome until an explicit settlement arrives. */
export function mergeThreadMemoryCleanup<
  T extends MemoryCleanupObservation & { threadId: string; cursor?: number },
>(previous: T | null, incoming: T, snapshot: T): T {
  const sameThread = previous?.threadId === incoming.threadId;
  let merged =
    sameThread && previous.memoryCleanupUnconfirmed
      ? { ...snapshot, memoryCleanupUnconfirmed: true as const }
      : snapshot;
  const omitted = sameThread && incoming.memoryCleanupPending === undefined;
  const seq = omitted
    ? (previous.memoryCleanupCursor ?? previous.cursor ?? -1)
    : (incoming.memoryCleanupCursor ?? incoming.cursor ?? -1);
  if (omitted)
    merged = {
      ...merged,
      memoryCleanupPending: previous.memoryCleanupPending,
      memoryCleanupCursor: seq,
    };
  merged = observeMemoryCleanup(merged, incoming, seq);
  if (sameThread && (previous.memoryCleanupCursor ?? -1) > (merged.memoryCleanupCursor ?? -1))
    merged = observeMemoryCleanup(merged, previous, previous.memoryCleanupCursor!);
  return merged;
}
