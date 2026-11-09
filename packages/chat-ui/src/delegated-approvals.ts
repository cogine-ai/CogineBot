import type { DelegatedApproval, MessageBlock } from "@rakazo/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

/** Read the projection for displayed dispatches. An invalidation has no transcript cursor. */
export function useDelegatedApprovals(
  scope: string | undefined,
  messages: ReadonlyArray<{ id: string; blocks: readonly MessageBlock[] }>,
  read: (messageIds: string[], signal: AbortSignal) => Promise<DelegatedApproval[]>,
) {
  const key = useMemo(
    () =>
      JSON.stringify(
        scope
          ? messages
              .filter((message) =>
                message.blocks.some(
                  (block) =>
                    block.kind === "bot_message_sent" &&
                    (block.intent === "request" || block.intent === "question"),
                ),
              )
              .map((message) => message.id)
          : [],
      ),
    [scope, messages],
  );
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    cards: DelegatedApproval[];
  } | null>(null);
  const refresh = useCallback(() => {
    if (scope && key !== "[]") setRevision((value) => value + 1);
  }, [scope, key]);
  useEffect(() => {
    if (!scope || key === "[]") return;
    const ids = JSON.parse(key) as string[];
    const abort = new AbortController();
    const pages: Promise<DelegatedApproval[]>[] = [];
    for (let offset = 0; offset < ids.length; offset += 100)
      pages.push(read(ids.slice(offset, offset + 100), abort.signal));
    void Promise.all(pages).then(
      (groups) => {
        if (!abort.signal.aborted) setSnapshot({ scope, cards: groups.flat() });
      },
      () => {
        if (!abort.signal.aborted) setSnapshot(null);
      },
    );
    return () => abort.abort();
  }, [scope, key, read, revision]);

  const byDispatch = useMemo(() => {
    const grouped = new Map<string, DelegatedApproval[]>();
    if (!scope || snapshot?.scope !== scope) return grouped;
    const visible = new Set<string>(JSON.parse(key) as string[]);
    for (const card of snapshot.cards) {
      if (!visible.has(card.dispatchMessageId)) continue;
      const previous = grouped.get(card.dispatchMessageId);
      if (previous) previous.push(card);
      else grouped.set(card.dispatchMessageId, [card]);
    }
    return grouped;
  }, [scope, key, snapshot]);
  return { byDispatch, refresh };
}
