export type MemoryCleanupObservation = {
  memoryCleanupCursor?: number;
  memoryCleanupPending?: boolean;
  memoryCleanupUnconfirmed?: true;
};

export type ThreadWorkObservation = {
  threadId: string;
  cursor?: number;
  run: { id: string; observedEventSeq?: number } | null;
  activeRuns?: Array<{ id: string; observedEventSeq?: number }>;
};

/** Keep a Run's snapshot observation separate from later unrelated event cursors. */
export function observeThreadRuns<T extends ThreadWorkObservation>(
  snapshot: T,
  authoritative = false,
): T {
  const cursor = snapshot.cursor;
  if (cursor === undefined) return snapshot;
  let changed = false;
  const observe = <R extends { id: string; observedEventSeq?: number }>(run: R): R => {
    const seq = Math.max(run.observedEventSeq ?? -1, cursor);
    if ((!authoritative && run.observedEventSeq !== undefined) || run.observedEventSeq === seq)
      return run;
    changed = true;
    return { ...run, observedEventSeq: seq };
  };
  const run = snapshot.run ? observe(snapshot.run) : null;
  const activeRuns = snapshot.activeRuns?.map(observe);
  return changed ? { ...snapshot, run, ...(activeRuns ? { activeRuns } : {}) } : snapshot;
}

/** Canonical clear frames identify the runs cancelled by that transaction. */
export function threadClearCancelledRunIds(
  payload: Record<string, unknown> | undefined,
): string[] | undefined {
  const ids = payload?.cancelledRunIds;
  return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : undefined;
}

/** Cancellation evidence does not consume history or change its clear boundary. */
export function applyThreadRunCancellations<
  T extends ThreadWorkObservation & { messages: Array<{ id: string; runId?: string | null }> },
>(snapshot: T, cancelledRunIds: readonly string[]): T {
  if (!cancelledRunIds.length) return snapshot;
  const cancelled = new Set(cancelledRunIds);
  const run = snapshot.run && !cancelled.has(snapshot.run.id) ? snapshot.run : null;
  const activeRuns = snapshot.activeRuns?.filter((run) => !cancelled.has(run.id));
  const remaining = snapshot.messages.filter(
    (message) => !message.runId || !cancelled.has(message.runId),
  );
  if (
    run === snapshot.run &&
    activeRuns?.length === snapshot.activeRuns?.length &&
    remaining.length === snapshot.messages.length
  )
    return snapshot;
  return {
    ...snapshot,
    run,
    activeRuns,
    messages: remaining.length === snapshot.messages.length ? snapshot.messages : remaining,
  };
}

/** The clear commit is earlier than cleanup settlement and owns only pre-clear activity. */
export function applyThreadClearReceipt<
  T extends ThreadWorkObservation & {
    messages: Array<{ id: string; observedEventSeq?: number; runId?: string | null }>;
    olderCursor?: number | null;
    observedClearSeq?: number;
  },
>(snapshot: T, receipt: { clearEventSeq: number; cancelledRunIds?: string[] }): T {
  const observed = snapshot.observedClearSeq ?? -1;
  // History is consumed once; cancellation IDs still apply to late receipts.
  if (receipt.clearEventSeq <= observed)
    return applyThreadRunCancellations(snapshot, receipt.cancelledRunIds ?? []);
  const cancelled = new Set(receipt.cancelledRunIds ?? []);
  const keepRun = (run: { id: string; observedEventSeq?: number }) =>
    !cancelled.has(run.id) &&
    (run.observedEventSeq ?? snapshot.cursor ?? -1) > receipt.clearEventSeq;
  const remaining = snapshot.messages.filter(
    (message) =>
      (message.observedEventSeq ?? snapshot.cursor ?? -1) > receipt.clearEventSeq &&
      (!message.runId || !cancelled.has(message.runId)),
  );
  const messages = remaining.length === snapshot.messages.length ? snapshot.messages : remaining;
  const run = snapshot.run && keepRun(snapshot.run) ? snapshot.run : null;
  const activeRuns = snapshot.activeRuns?.filter(keepRun);
  const preservesPage =
    messages.length > 0 &&
    messages.length === snapshot.messages.length &&
    (snapshot.cursor ?? -1) >= receipt.clearEventSeq;
  return {
    ...snapshot,
    cursor: Math.max(snapshot.cursor ?? -1, receipt.clearEventSeq),
    observedClearSeq: Math.max(observed, receipt.clearEventSeq),
    messages,
    olderCursor: preservesPage ? snapshot.olderCursor : null,
    run,
    activeRuns,
  };
}

/** A retained post-clear anchor remains valid even when an older prefix was removed. */
export function shouldResetHistoryAfterClear(
  previous: { cursor?: number; messages: Array<{ id: string }>; olderCursor?: number | null },
  next: {
    observedClearSeq?: number;
    cursor?: number;
    messages: Array<{ id: string }>;
    olderCursor?: number | null;
  },
  anchorMessageId?: string | null,
): boolean {
  if (
    previous === next ||
    (anchorMessageId && next.messages.some((message) => message.id === anchorMessageId))
  )
    return false;
  return !(
    (previous.cursor ?? -1) >= (next.observedClearSeq ?? next.cursor ?? Number.POSITIVE_INFINITY) &&
    previous.messages.length === next.messages.length &&
    previous.olderCursor === next.olderCursor
  );
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
      ...(previous.memoryCleanupPending !== undefined
        ? { memoryCleanupPending: previous.memoryCleanupPending }
        : {}),
      memoryCleanupCursor: seq,
    };
  merged = observeMemoryCleanup(merged, incoming, seq);
  if (sameThread && (previous.memoryCleanupCursor ?? -1) > (merged.memoryCleanupCursor ?? -1))
    merged = observeMemoryCleanup(merged, previous, previous.memoryCleanupCursor!);
  return merged;
}
