import type { PageSummary } from "@rakazo/contracts";
import { PAGE_LIST_MAX_LIMIT } from "@rakazo/contracts";
import { uniquePages } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { pageScopeKey, privatePageRpc, subscribePageScope } from "./pages";

const PAGE_SIZE = 5;

type PagedPages =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; items: PageSummary[]; nextCursor: string | null };

/**
 * A bot's or group's pages, five at a time, read again each time the list comes back on screen
 * (after Share, or a page a routine changed), as many as were shown, as the web list does.
 * One "Show more" runs at a time, and a page of results that started before a reload (a pin,
 * rename or delete) is dropped.
 */
export function usePagedPages(owner: { botId?: string; groupId?: string }) {
  const { botId, groupId } = owner;
  const scope = useSyncExternalStore(subscribePageScope, pageScopeKey, pageScopeKey);
  const identity = `${scope}:${botId ? `bot:${botId}` : `group:${groupId}`}`;
  const [stored, setStored] = useState<{ identity: string; listed: PagedPages }>({
    identity,
    listed: { status: "loading" },
  });
  const listed: PagedPages = stored.identity === identity ? stored.listed : { status: "loading" };
  const committed = useRef<string | null>(null);
  const generation = useRef(0);
  const loadingMore = useRef(false);
  // Bind before the focus effect starts its load. Rendering only gates identity;
  // a discarded render must not invalidate the committed screen's requests.
  useLayoutEffect(() => {
    committed.current = identity;
    generation.current += 1;
    loadingMore.current = false;
    setStored({ identity, listed: { status: "loading" } });
    return () => {
      committed.current = null;
      generation.current += 1;
    };
  }, [identity]);
  const isCurrent = useCallback(
    (started?: number) =>
      committed.current === identity &&
      pageScopeKey() === scope &&
      (started === undefined || started === generation.current),
    [identity, scope],
  );
  // How many of whose pages are shown: another bot or group starts again from five.
  const shown = useRef({ owner: "", count: 0 });
  useEffect(() => {
    if (listed.status === "ready" && isCurrent())
      shown.current = { owner: identity, count: listed.items.length };
  }, [listed, identity, isCurrent]);
  const input = useCallback(
    (cursor?: string, limit = PAGE_SIZE) => ({
      ...(botId ? { botId } : { groupId }),
      limit,
      ...(cursor ? { cursor } : {}),
    }),
    [botId, groupId],
  );
  const load = useCallback(() => {
    if (!isCurrent()) return;
    const started = ++generation.current;
    loadingMore.current = false;
    if (shown.current.owner !== identity) shown.current = { owner: identity, count: 0 };
    const limit = Math.min(Math.max(shown.current.count, PAGE_SIZE), PAGE_LIST_MAX_LIMIT);
    void privatePageRpc<{ items: PageSummary[]; nextCursor: string | null }>(
      "pages/list",
      input(undefined, limit),
    ).then(
      (result) => {
        if (isCurrent(started)) setStored({ identity, listed: { status: "ready", ...result } });
      },
      (error: unknown) => {
        if (isCurrent(started)) setStored({ identity, listed: { status: "error", error } });
      },
    );
  }, [input, identity, isCurrent]);
  useFocusEffect(
    useCallback(() => {
      setStored({ identity, listed: { status: "loading" } });
      load();
      return () => {
        generation.current += 1;
      };
    }, [load, identity]),
  );
  const showMore = useCallback(async () => {
    if (!isCurrent() || listed.status !== "ready" || !listed.nextCursor || loadingMore.current)
      return;
    loadingMore.current = true;
    const started = generation.current;
    try {
      const result = await privatePageRpc<{ items: PageSummary[]; nextCursor: string | null }>(
        "pages/list",
        input(listed.nextCursor),
      ).catch((error: unknown) => {
        // A failure from before a reload is as stale as a success would be.
        if (isCurrent(started)) throw error;
        return null;
      });
      if (!result || !isCurrent(started)) return;
      setStored((current) =>
        current.identity === identity && current.listed.status === "ready"
          ? {
              identity,
              listed: {
                status: "ready",
                items: uniquePages([...current.listed.items, ...result.items]),
                nextCursor: result.nextCursor,
              },
            }
          : current,
      );
    } finally {
      if (isCurrent(started)) loadingMore.current = false;
    }
  }, [listed, input, identity, isCurrent]);
  return { listed, showMore, refresh: load };
}
