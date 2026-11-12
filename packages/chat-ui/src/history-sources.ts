import type { HistorySource, HistorySourceReference } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";

type HistorySourceClient<Scope> = {
  captureScope: () => Scope;
  isScopeCurrent: (scope: Scope) => boolean;
  load: (references: HistorySourceReference[], signal: AbortSignal) => Promise<HistorySource[]>;
};

export function useHistorySources<Scope>(
  references: HistorySourceReference[],
  client: HistorySourceClient<Scope>,
  active = true,
) {
  const [view, setView] = useState<{
    references: HistorySourceReference[];
    scope: Scope;
    sources: HistorySource[];
    unavailable: boolean;
  }>();
  const binding = useRef<{
    controller: AbortController;
    scope: Scope;
    references: HistorySourceReference[];
  } | null>(null);
  const openRequest = useRef(0);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const scope = client.captureScope();
    binding.current = { controller, scope, references };
    setView(undefined);
    const isCurrent = () => !controller.signal.aborted && client.isScopeCurrent(scope);
    void client.load(references, controller.signal).then(
      (rows) => {
        if (!isCurrent()) return;
        setView({ references, scope, sources: rows, unavailable: rows.length < references.length });
      },
      () => {
        if (isCurrent()) setView({ references, scope, sources: [], unavailable: true });
      },
    );
    return () => controller.abort();
  }, [active, client, references]);

  async function revalidate({ threadId, messageId }: HistorySourceReference) {
    const current = binding.current;
    if (!active || !current || current.references !== references) return;
    const { controller, scope } = current;
    const isCurrent = () => !controller.signal.aborted && client.isScopeCurrent(scope);
    if (!isCurrent()) return;
    const request = ++openRequest.current;
    const rows = await client.load([{ threadId, messageId }], controller.signal).catch(() => []);
    if (!isCurrent() || openRequest.current !== request) return;
    const row = rows.find((entry) => entry.threadId === threadId && entry.messageId === messageId);
    if (row?.groupId || row?.botId) return row;
    setView(
      (previous) =>
        previous && {
          ...previous,
          sources: previous.sources.filter((entry) => entry.messageId !== messageId),
          unavailable: true,
        },
    );
  }

  const visible = active && view?.references === references && client.isScopeCurrent(view.scope);
  return {
    sources: visible ? view.sources : [],
    unavailable: visible && view.unavailable,
    revalidate,
  };
}
