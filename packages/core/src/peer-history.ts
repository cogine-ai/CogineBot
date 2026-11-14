/** Common wire fields used by web and native thread history. */
export type PeerHistoryMessage = {
  id: string;
  threadId?: string;
  seq?: number;
  createdAt?: string;
};

const PEER_HISTORY_PAGE_TIMEOUT_MS = 15_000;
const PEER_HISTORY_TOTAL_TIMEOUT_MS = 60_000;

type PeerHistoryPage<T> = {
  messages: T[];
  olderCursor: number | null;
};

/** A live update wins a slower historical copy; history and SSE can cover the same row. */
export function mergePeerHistory<T extends PeerHistoryMessage>(
  history: readonly T[],
  incoming: readonly T[],
): T[] {
  const messages = new Map<string, T>();
  for (const message of [...history, ...incoming]) {
    const key = `${message.threadId}:${message.id}`;
    const previous = messages.get(key);
    if (!previous || (message.seq ?? 0) >= (previous.seq ?? 0)) messages.set(key, message);
  }
  return [...messages.values()].sort(
    (a, b) =>
      (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
      (a.seq ?? 0) - (b.seq ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

function abortablePage<T>(
  loadPage: (signal: AbortSignal) => Promise<PeerHistoryPage<T>>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<PeerHistoryPage<T>> {
  // React Native's AbortSignal has no any(), timeout() or throwIfAborted().
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request canceled"));
  return new Promise((resolve, reject) => {
    const abort = new AbortController();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      abort.abort();
      reject(signal.reason ?? new Error("Request canceled"));
    };
    const timer = setTimeout(() => {
      finish();
      abort.abort();
      const error = new Error("Peer history timed out");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve()
      .then(() => loadPage(abort.signal))
      .then(
        (page) => {
          finish();
          if (signal.aborted) reject(signal.reason ?? new Error("Request canceled"));
          else resolve(page);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
  });
}

/** Load every peer-history page without allowing one request or the full scan to hang forever. */
export async function loadPeerHistory<T extends PeerHistoryMessage>({
  signal,
  loadPage,
  pageTimeoutMs = PEER_HISTORY_PAGE_TIMEOUT_MS,
  totalTimeoutMs = PEER_HISTORY_TOTAL_TIMEOUT_MS,
}: {
  signal: AbortSignal;
  loadPage: (before: number | undefined, signal: AbortSignal) => Promise<PeerHistoryPage<T>>;
  pageTimeoutMs?: number;
  totalTimeoutMs?: number;
}): Promise<T[]> {
  const deadline = Date.now() + totalTimeoutMs;
  let before: number | undefined;
  let collected: T[] = [];
  do {
    const page = await abortablePage(
      (pageSignal) => loadPage(before, pageSignal),
      signal,
      Math.max(0, Math.min(pageTimeoutMs, deadline - Date.now())),
    );
    if (before !== undefined && page.olderCursor !== null && page.olderCursor >= before) {
      throw new Error("Peer history cursor did not advance");
    }
    collected = mergePeerHistory(page.messages, collected);
    before = page.olderCursor ?? undefined;
  } while (before !== undefined);
  return collected;
}
