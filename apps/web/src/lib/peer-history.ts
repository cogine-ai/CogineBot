import type { ThreadMessage } from "@rakazo/contracts";

const PEER_HISTORY_PAGE_TIMEOUT_MS = 15_000;
const PEER_HISTORY_TOTAL_TIMEOUT_MS = 60_000;

type PeerHistoryPage = {
  messages: ThreadMessage[];
  olderCursor: number | null;
};

/** A live update wins a slower historical copy; history and SSE can cover the same row. */
export function mergePeerHistory(
  history: readonly ThreadMessage[],
  incoming: readonly ThreadMessage[],
): ThreadMessage[] {
  const messages = new Map<string, ThreadMessage>();
  for (const message of [...history, ...incoming]) {
    const key = `${message.threadId}:${message.id}`;
    const previous = messages.get(key);
    if (!previous || message.seq >= previous.seq) messages.set(key, message);
  }
  return [...messages.values()].sort(
    (a, b) =>
      (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
      a.seq - b.seq ||
      a.id.localeCompare(b.id),
  );
}

function abortablePage(
  loadPage: () => Promise<PeerHistoryPage>,
  signal: AbortSignal,
): Promise<PeerHistoryPage> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void loadPage().then(
      (page) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(signal.reason);
        else resolve(page);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Load every peer-history page without allowing one request or the full scan to hang forever. */
export async function loadPeerHistory({
  signal,
  loadPage,
  pageTimeoutMs = PEER_HISTORY_PAGE_TIMEOUT_MS,
  totalTimeoutMs = PEER_HISTORY_TOTAL_TIMEOUT_MS,
}: {
  signal: AbortSignal;
  loadPage: (before: number | undefined, signal: AbortSignal) => Promise<PeerHistoryPage>;
  pageTimeoutMs?: number;
  totalTimeoutMs?: number;
}): Promise<ThreadMessage[]> {
  const deadline = AbortSignal.timeout(totalTimeoutMs);
  let before: number | undefined;
  let collected: ThreadMessage[] = [];
  do {
    const pageSignal = AbortSignal.any([signal, deadline, AbortSignal.timeout(pageTimeoutMs)]);
    const page = await abortablePage(() => loadPage(before, pageSignal), pageSignal);
    if (before !== undefined && page.olderCursor !== null && page.olderCursor >= before) {
      throw new Error("Peer history cursor did not advance");
    }
    collected = mergePeerHistory(page.messages, collected);
    before = page.olderCursor ?? undefined;
  } while (before !== undefined);
  return collected;
}
