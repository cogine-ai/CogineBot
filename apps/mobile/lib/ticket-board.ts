import type { Me } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { rpc } from "./api";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "./mobile-scope";
import { spaceRequestContext } from "./space-request-context";

/** Both the entry and direct route fail closed until the current backend confirms capability. */
export function useTicketBoardCapability(available = true) {
  const key = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const scope = useMemo(captureMobileScope, [key]);
  const [result, setResult] = useState<{ key: string; enabled?: boolean; failed?: boolean }>();
  const [retry, setRetry] = useState(0);
  useFocusEffect(
    useCallback(() => {
      if (!available) return;
      let active = true;
      let timer: ReturnType<typeof setTimeout>;
      const controller = new AbortController();
      const current = () => active && isMobileScopeCurrent(scope);
      setResult(undefined);
      async function check() {
        try {
          const requestContext = await spaceRequestContext(scope, current);
          const me = await rpc<Pick<Me, "ticketBoardEnabled">>(
            "me",
            {},
            {
              requestContext,
              signal: controller.signal,
            },
          );
          if (current()) setResult({ key, enabled: me.ticketBoardEnabled === true });
        } catch {
          // A transient background refresh must not discard an open editor's draft.
          // The backend still checks capability and authorization on every operation.
          if (current())
            setResult((previous) =>
              previous?.key === key && previous.enabled !== undefined
                ? previous
                : { key, failed: true },
            );
        } finally {
          if (current()) timer = setTimeout(() => void check(), 15_000);
        }
      }
      void check();
      return () => {
        active = false;
        clearTimeout(timer);
        controller.abort();
      };
    }, [key, scope, retry, available]),
  );
  return {
    key,
    scope,
    enabled: available && result?.key === key ? result.enabled : undefined,
    failed: result?.key === key && result.failed,
    retry: () => setRetry((value) => value + 1),
  };
}
