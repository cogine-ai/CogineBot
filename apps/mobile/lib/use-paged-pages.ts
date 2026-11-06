import type { PageSummary } from "@rakazo/contracts";
import { PAGE_LIST_MAX_LIMIT } from "@rakazo/contracts";
import { uniquePages } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  const [listed, setListed] = useState<PagedPages>({ status: "loading" });
  const generation = useRef(0);
  const loadingMore = useRef(false);
  // How many of whose pages are shown: another bot or group starts again from five.
  const shown = useRef({ owner: "", count: 0 });
  useEffect(() => {
    if (listed.status === "ready") shown.current.count = listed.items.length;
  }, [listed]);
  const input = useCallback(
    (cursor?: string, limit = PAGE_SIZE) => ({
      ...(botId ? { botId } : { groupId }),
      limit,
      ...(cursor ? { cursor } : {}),
    }),
    [botId, groupId],
  );
  const load = useCallback(() => {
    const started = ++generation.current;
    loadingMore.current = false;
    const owner = `${scope}:${botId ? `bot:${botId}` : `group:${groupId}`}`;
    if (shown.current.owner !== owner) shown.current = { owner, count: 0 };
    const limit = Math.min(Math.max(shown.current.count, PAGE_SIZE), PAGE_LIST_MAX_LIMIT);
    void privatePageRpc<{ items: PageSummary[]; nextCursor: string | null }>(
      "pages/list",
      input(undefined, limit),
    ).then(
      (result) => {
        if (started === generation.current) setListed({ status: "ready", ...result });
      },
      (error: unknown) => {
        if (started === generation.current) setListed({ status: "error", error });
      },
    );
  }, [input, botId, groupId, scope]);
  useFocusEffect(
    useCallback(() => {
      setListed({ status: "loading" });
      load();
      return () => {
        generation.current += 1;
      };
    }, [load]),
  );
  const showMore = useCallback(async () => {
    if (listed.status !== "ready" || !listed.nextCursor || loadingMore.current) return;
    loadingMore.current = true;
    const started = generation.current;
    try {
      const result = await privatePageRpc<{ items: PageSummary[]; nextCursor: string | null }>(
        "pages/list",
        input(listed.nextCursor),
      ).catch((error: unknown) => {
        // A failure from before a reload is as stale as a success would be.
        if (started === generation.current) throw error;
        return null;
      });
      if (!result || started !== generation.current) return;
      setListed((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              items: uniquePages([...current.items, ...result.items]),
              nextCursor: result.nextCursor,
            }
          : current,
      );
    } finally {
      if (started === generation.current) loadingMore.current = false;
    }
  }, [listed, input]);
  const bound = useRef(scope);
  if (bound.current !== scope) {
    bound.current = scope;
    generation.current += 1;
    setListed({ status: "loading" });
  }
  return { listed, showMore, refresh: load };
}
