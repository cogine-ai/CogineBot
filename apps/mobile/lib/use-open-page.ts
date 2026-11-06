import { useRouter } from "expo-router";
import { useCallback, useSyncExternalStore } from "react";
import { pageScopeKey, subscribePageScope } from "./pages";

/** A link in a stale account or Space cannot open a page in the new scope. */
export function useOpenPrivatePage() {
  const router = useRouter();
  const scope = useSyncExternalStore(subscribePageScope, pageScopeKey, pageScopeKey);
  return useCallback(
    (pageId: string) => {
      if (scope === pageScopeKey()) router.push({ pathname: "/page", params: { pageId } });
    },
    [router, scope],
  );
}
