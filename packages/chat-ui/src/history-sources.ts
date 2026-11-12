import type { HistorySource, HistorySourceReference } from "@rakazo/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

type HistorySourceClient<Scope> = {
  captureScope: () => Scope;
  isScopeCurrent: (scope: Scope) => boolean;
  scopeKey: () => string;
  subscribeScope: (listener: () => void) => () => void;
  load: (references: HistorySourceReference[], signal: AbortSignal) => Promise<HistorySource[]>;
};

function sourceAccessDenied(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (("status" in error && (error.status === 401 || error.status === 403)) ||
        ("code" in error && (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN"))),
  );
}

export function useHistorySources<Scope>(
  references: HistorySourceReference[],
  client: HistorySourceClient<Scope>,
  active = true,
) {
  const scopeKey = useSyncExternalStore(client.subscribeScope, client.scopeKey, client.scopeKey);
  const [view, setView] = useState<{
    references: HistorySourceReference[];
    scope: Scope;
    sources: HistorySource[];
    unavailable: boolean;
    requestFailed: boolean;
  }>();
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const binding = useRef<{
    controller: AbortController;
    scope: Scope;
    references: HistorySourceReference[];
    refreshing: boolean;
  } | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    if (!active) {
      setView(undefined);
      setRefreshing(false);
      return;
    }
    const controller = new AbortController();
    const scope = client.captureScope();
    const request = ++latestRequest.current;
    const current = { controller, scope, references, refreshing: true };
    binding.current = current;
    setRefreshing(true);
    const finishRefresh = () => {
      if (
        controller.signal.aborted ||
        latestRequest.current !== request ||
        !client.isScopeCurrent(scope)
      )
        return false;
      current.refreshing = false;
      setRefreshing(false);
      return true;
    };
    void client.load(references, controller.signal).then(
      (rows) => {
        if (!finishRefresh()) return;
        setView({
          references,
          scope,
          sources: rows,
          unavailable: rows.length < references.length,
          requestFailed: false,
        });
      },
      (error: unknown) => {
        if (!finishRefresh()) return;
        if (sourceAccessDenied(error)) {
          setView({ references, scope, sources: [], unavailable: true, requestFailed: false });
          return;
        }
        setView((previous) => {
          const cached =
            previous?.references === references && client.isScopeCurrent(previous.scope)
              ? previous
              : { references, scope, sources: [], unavailable: false };
          return { ...cached, requestFailed: true };
        });
      },
    );
    return () => controller.abort();
  }, [active, attempt, client, references, scopeKey]);

  async function revalidate({ threadId, messageId }: HistorySourceReference) {
    const current = binding.current;
    if (!active || !current || current.refreshing || current.references !== references) return;
    const { controller, scope } = current;
    const isCurrent = () => !controller.signal.aborted && client.isScopeCurrent(scope);
    if (!isCurrent()) return;
    const request = ++latestRequest.current;
    const rows = await client
      .load([{ threadId, messageId }], controller.signal)
      .catch((error: unknown) => (sourceAccessDenied(error) ? ("denied" as const) : undefined));
    if (!isCurrent() || latestRequest.current !== request) return;
    if (rows === "denied") {
      setView({ references, scope, sources: [], unavailable: true, requestFailed: false });
      return;
    }
    if (!rows) {
      setView((previous) => previous && { ...previous, requestFailed: true });
      return;
    }
    const row = rows.find((entry) => entry.threadId === threadId && entry.messageId === messageId);
    if (row?.groupId || row?.botId) {
      setView((previous) => previous && { ...previous, requestFailed: false });
      return row;
    }
    setView(
      (previous) =>
        previous && {
          ...previous,
          sources: previous.sources.filter((entry) => entry.messageId !== messageId),
          unavailable: true,
          requestFailed: false,
        },
    );
  }

  const visible = active && view?.references === references && client.isScopeCurrent(view.scope);
  return {
    sources: visible ? view.sources : [],
    unavailable: visible && view.unavailable,
    requestFailed: visible && view.requestFailed,
    refreshing,
    retry: () => {
      const current = binding.current;
      if (!current || current.refreshing) return;
      current.refreshing = true;
      setRefreshing(true);
      latestRequest.current++;
      setAttempt((previous) => previous + 1);
    },
    revalidate,
  };
}
