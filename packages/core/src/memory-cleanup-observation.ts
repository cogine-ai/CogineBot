import type { RunStatus } from "@rakazo/contracts";
import { isActive } from "./run-state.js";

export type MemoryCleanupObservation = {
  memoryCleanupCursor?: number;
  memoryCleanupPending?: boolean;
  memoryCleanupUnconfirmed?: true;
};

export type ThreadWorkObservation = {
  threadId: string;
  cursor?: number;
  run: { id: string; status?: string } | null;
  activeRuns?: Array<{ id: string; status?: string }>;
};

/** Canonical clear frames identify the runs cancelled by that transaction. */
export function threadClearCancelledRunIds(
  payload: Record<string, unknown> | undefined,
): string[] | undefined {
  const ids = payload?.cancelledRunIds;
  return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : undefined;
}

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
  receipt: { clearEventSeq: number; cancelledRunIds?: string[]; cancelledRunIdsSeq?: number },
): T {
  const observed = snapshot.observedClearSeq ?? -1;
  // History is consumed once; cancellation IDs still apply to late receipts.
  const alreadyObserved = receipt.clearEventSeq <= observed;
  const cancelled = new Set(receipt.cancelledRunIds ?? []);
  const previous = new Set([
    ...(started?.activeRuns ?? []).map((run) => run.id),
    ...(started?.run ? [started.run.id] : []),
  ]);
  const keepRun = (run: { id: string; status?: string }) =>
    !cancelled.has(run.id) &&
    (alreadyObserved ||
      // An older buffered list cannot prove a later clear's cancellation set complete.
      (receipt.cancelledRunIds !== undefined &&
        (receipt.cancelledRunIdsSeq ?? receipt.clearEventSeq) >= receipt.clearEventSeq &&
        run.status !== undefined &&
        isActive(run.status as RunStatus)) ||
      (snapshot.cursor ?? -1) > receipt.clearEventSeq ||
      (started?.threadId === snapshot.threadId && !previous.has(run.id)));
  const remaining = snapshot.messages.filter(
    (message) =>
      (alreadyObserved ||
        (message.observedEventSeq ?? snapshot.cursor ?? -1) > receipt.clearEventSeq) &&
      (!message.runId || !cancelled.has(message.runId)),
  );
  const messages = remaining.length === snapshot.messages.length ? snapshot.messages : remaining;
  const run = snapshot.run && keepRun(snapshot.run) ? snapshot.run : null;
  const activeRuns = snapshot.activeRuns?.filter(keepRun);
  if (
    alreadyObserved &&
    run === snapshot.run &&
    messages === snapshot.messages &&
    activeRuns?.length === snapshot.activeRuns?.length
  )
    return snapshot;
  const preservesPage =
    messages.length > 0 &&
    messages.length === snapshot.messages.length &&
    (snapshot.cursor ?? -1) >= receipt.clearEventSeq;
  return {
    ...snapshot,
    cursor: Math.max(snapshot.cursor ?? -1, receipt.clearEventSeq),
    observedClearSeq: Math.max(observed, receipt.clearEventSeq),
    messages,
    olderCursor: alreadyObserved || preservesPage ? snapshot.olderCursor : null,
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
