import type { ProductEvent } from "@rakazo/contracts";
import { abortableDelay } from "./async.js";

type ThreadHead = { threadId: string; cursor: number };

/** No frame at all for this long means the stream is half-open; the server beats far faster. */
export const IDLE_TIMEOUT_MS = 45_000;

/** Recover a durable event stream while its caller owns snapshot commits and UI effects. */
export async function runThreadSubscription(options: {
  signal: AbortSignal;
  loadInitial: () => Promise<ThreadHead | null>;
  loadHead: () => Promise<ThreadHead | null>;
  refresh: () => Promise<unknown>;
  currentSnapshot: () => ThreadHead | null;
  subscribe: (cursor: number) => Promise<AsyncIterable<ProductEvent>>;
  beforeEvent?: (event: ProductEvent) => void;
  applyEvent: (event: ProductEvent) => void;
  onEvent: (event: ProductEvent, initial: ThreadHead) => void;
  onStatus?: (status: "loading" | "recovering" | "ready", error?: unknown) => void;
  /** An explicit reader retry keeps its consumed event cursor, even after a newer GET. */
  resume?: ThreadHead;
  /** Successfully consumed events, or the first trusted snapshot when there is no resume. */
  onCursor?: (checkpoint: ThreadHead) => void;
}): Promise<void> {
  const { signal } = options;
  let lastStatus: "loading" | "recovering" | "ready" | undefined;
  const notify = (status: "loading" | "recovering" | "ready", error?: unknown) => {
    if (signal.aborted || (lastStatus === status && error === undefined)) return;
    lastStatus = status;
    try {
      if (error === undefined) options.onStatus?.(status);
      else options.onStatus?.(status, error);
    } catch {
      // Rendering connection feedback must not interrupt recovery.
    }
  };
  const wait = async (ms: number) => {
    await abortableDelay(ms, signal);
    return !signal.aborted;
  };
  if (signal.aborted) return;
  notify("loading");
  if (signal.aborted) return;
  let initial = await options.loadInitial().catch((error) => {
    notify("recovering", error);
    return null;
  });
  if (signal.aborted) return;
  let headRetryMs = 250;
  while (!initial && !signal.aborted) {
    initial = await options.loadHead().catch((error) => {
      notify("recovering", error);
      return null;
    });
    if (initial) break;
    if (!(await wait(headRetryMs))) return;
    headRetryMs = Math.min(headRetryMs * 2, 5_000);
  }
  if (!initial || signal.aborted) return;
  const head = initial;
  const initialSnapshot = options.currentSnapshot();
  const resume = options.resume?.threadId === head.threadId ? options.resume : undefined;
  // Another refresh may have committed beyond the head while its request was pending.
  let cursor =
    resume?.cursor ??
    (initialSnapshot?.threadId === head.threadId
      ? Math.max(head.cursor, initialSnapshot.cursor)
      : head.cursor);
  // A retained reader can be older than a successful head fallback. Until a snapshot
  // covers that cursor, keep recovering rather than skip the gap and trust a heartbeat.
  const coversHead = (snapshot: ThreadHead | null) =>
    snapshot?.threadId === head.threadId && snapshot.cursor >= head.cursor;
  const tracksCursor = Boolean(resume || options.onCursor);
  let consumedCursor = resume?.cursor;
  let receivedEvent = false;
  const consume = (next: number) => {
    if (signal.aborted || !tracksCursor || (consumedCursor !== undefined && next <= consumedCursor))
      return;
    options.onCursor?.({ threadId: head.threadId, cursor: next });
    consumedCursor = next;
  };
  const seedSnapshot = (snapshot: ThreadHead | null) => {
    if (
      !resume &&
      !receivedEvent &&
      consumedCursor === undefined &&
      snapshot &&
      coversHead(snapshot)
    ) {
      consume(snapshot.cursor);
    }
  };
  let snapshotReady = coversHead(initialSnapshot);
  let snapshotHealthy = snapshotReady;
  seedSnapshot(initialSnapshot);
  if (signal.aborted) return;
  let streamReady = false;
  const reportReady = () => {
    if (snapshotHealthy && streamReady && coversHead(options.currentSnapshot())) {
      notify("ready");
    }
  };
  let snapshotRefresh: Promise<void> | undefined;
  const refreshSnapshot = () => {
    if (options.onStatus && snapshotRefresh) return snapshotRefresh;
    snapshotRefresh = (async () => {
      try {
        await options.refresh();
        if (signal.aborted) return;
        snapshotHealthy = coversHead(options.currentSnapshot());
        reportReady();
      } catch (error) {
        snapshotHealthy = false;
        notify("recovering", error);
      }
      if (options.onStatus && !snapshotHealthy) startSnapshotRecovery();
    })().finally(() => {
      snapshotRefresh = undefined;
    });
    return snapshotRefresh;
  };
  const pendingSnapshotEvents: ProductEvent[] = [];
  let recoveringSnapshot = false;
  const startSnapshotRecovery = () => {
    if (recoveringSnapshot || signal.aborted) return;
    recoveringSnapshot = true;
    void (async () => {
      let snapshotRetryMs = 250;
      try {
        while ((!snapshotReady || (options.onStatus && !snapshotHealthy)) && !signal.aborted) {
          if (!(await wait(snapshotRetryMs))) return;
          await refreshSnapshot();
          if (signal.aborted) return;
          const committed = options.currentSnapshot();
          if (!snapshotReady && committed && coversHead(committed)) {
            let consumedEvents = 0;
            try {
              seedSnapshot(committed);
              for (const event of pendingSnapshotEvents) {
                if (signal.aborted) return;
                if (resume || event.seq > committed.cursor) options.applyEvent(event);
                if (signal.aborted) return;
                // onEvent already succeeded before the event entered this buffer.
                consume(event.seq);
                consumedEvents += 1;
              }
              if (signal.aborted) return;
              snapshotReady = true;
            } catch (error) {
              snapshotHealthy = false;
              notify("recovering", error);
            } finally {
              pendingSnapshotEvents.splice(0, consumedEvents);
            }
          }
          snapshotRetryMs = Math.min(snapshotRetryMs * 2, 5_000);
        }
      } finally {
        recoveringSnapshot = false;
      }
    })();
  };
  if (!snapshotReady) startSnapshotRecovery();
  let retryMs = 250;
  while (!signal.aborted) {
    try {
      const events = await options.subscribe(cursor);
      const iterator = events[Symbol.asyncIterator]();
      try {
        let pending: Promise<IteratorResult<ProductEvent>> | undefined;
        while (!signal.aborted) {
          pending ??= iterator.next();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const next = await Promise.race([
            pending,
            new Promise<"idle">((resolve) => {
              timer = setTimeout(() => resolve("idle"), IDLE_TIMEOUT_MS);
            }),
          ]).finally(() => clearTimeout(timer));
          if (signal.aborted) return;
          // Abandon the iterator, not the caller's signal, so the loop below re-subscribes.
          if (next === "idle" || next.done) {
            streamReady = false;
            notify("recovering");
            break;
          }
          pending = undefined;
          const event = next.value;
          retryMs = 250;
          streamReady = true;
          reportReady();
          if (signal.aborted) return;
          // Heartbeats only prove the socket is alive; they carry no state and no cursor.
          if (event.type === "heartbeat") continue;
          if (
            tracksCursor &&
            (event.threadId !== head.threadId ||
              (consumedCursor !== undefined && event.seq <= consumedCursor) ||
              pendingSnapshotEvents.some((pendingEvent) => pendingEvent.seq === event.seq))
          )
            continue;
          receivedEvent = true;
          options.beforeEvent?.(event);
          if (signal.aborted) return;
          let applied = false;
          if (snapshotReady && options.currentSnapshot()?.threadId === event.threadId) {
            options.applyEvent(event);
            if (signal.aborted) return;
            applied = true;
          }
          options.onEvent(event, head);
          if (signal.aborted) return;
          cursor = Math.max(cursor, event.seq);
          if (applied) consume(event.seq);
          else if (!snapshotReady) pendingSnapshotEvents.push(event);
        }
      } finally {
        // Not awaited: a half-open iterator can take as long to close as it took to go quiet.
        void iterator.return?.(undefined).catch(() => {});
      }
    } catch (error) {
      streamReady = false;
      notify("recovering", error);
      // Reconnect from the last durable event after a transient transport failure.
    }
    if (signal.aborted) return;
    await refreshSnapshot();
    if (!(await wait(retryMs))) return;
    retryMs = Math.min(retryMs * 2, 5_000);
  }
}
