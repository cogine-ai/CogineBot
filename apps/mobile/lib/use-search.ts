import type { SearchHit } from "@rakazo/contracts";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { captureApiRequestContext, rpc } from "./api";
import { t } from "./i18n";
import type { MobileScope } from "./mobile-scope";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "./mobile-scope";
import { querySpaceSearch } from "./search";
import { errorText } from "./user-error";

const empty: SearchHit[] = [];
type SearchResult = {
  key: string;
  owner: MobileScope;
  hits: SearchHit[];
  loading: boolean;
  error: string | null;
  querySpaceId?: string;
};

export function useSearch(query: string) {
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const owner = useMemo(captureMobileScope, [scopeKey]);
  const trimmed = query.trim();
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [result, setResult] = useState<SearchResult | null>(null);
  const key = JSON.stringify([scopeKey, trimmed, retryAttempt]);
  useEffect(() => {
    const abort = new AbortController();
    const isCurrent = () => !abort.signal.aborted && isMobileScopeCurrent(owner);
    setResult({ key, owner, hits: empty, loading: Boolean(trimmed), error: null });
    if (!trimmed) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const captured = await captureApiRequestContext();
          if (!isCurrent()) return;
          let querySpaceId = owner.spaceId;
          if (!querySpaceId) {
            const me = await rpc<{ userId: string; spaceId: string }>(
              "me",
              {},
              {
                requestContext: captured,
                signal: abort.signal,
                skipSpaceAuthRecovery: true,
              },
            );
            if (!isCurrent()) return;
            if (
              typeof me.userId !== "string" ||
              !me.userId ||
              typeof me.spaceId !== "string" ||
              !me.spaceId
            )
              throw new Error(t("Could not search"));
            querySpaceId = me.spaceId;
          }
          const requestContext = {
            ...captured,
            headers: { ...captured.headers, "x-rakazo-space-id": querySpaceId },
          };
          const hits = await querySpaceSearch(trimmed, {
            requestContext,
            signal: abort.signal,
            skipSpaceAuthRecovery: true,
          });
          if (isCurrent())
            setResult({ key, owner, hits, querySpaceId, loading: false, error: null });
        } catch (error: unknown) {
          if (isCurrent())
            setResult({ key, owner, hits: empty, loading: false, error: errorText(error) });
        }
      })();
    }, 200);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [key, owner, trimmed]);
  const retry = useCallback(() => setRetryAttempt((value) => value + 1), []);
  const current = result?.key === key && isMobileScopeCurrent(result.owner) ? result : undefined;
  return {
    hits: current?.hits ?? empty,
    loading: current?.loading ?? Boolean(trimmed),
    error: current?.error ?? null,
    querySpaceId: current?.querySpaceId,
    retry,
  };
}
