import type { PageSummary } from "@rakazo/contracts";
import { PAGE_LIST_MAX_LIMIT, PAGE_LIST_QUERY_MAX_LENGTH } from "@rakazo/contracts";
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
  | { status: "ready"; items: PageSummary[]; nextCursor: string | null; generation: number };
type PageBatch = { items: PageSummary[]; nextCursor: string | null };

/**
 * A bot's or group's pages, five at a time, read again each time the list comes back on screen
 * (after Share, or a page a routine changed), as many as were shown, as the web list does.
 * One "Show more" runs at a time, and a page of results that started before a reload (a pin,
 * rename or delete) is dropped.
 */
export function usePagedPages(owner: { botId?: string; groupId?: string }, search = "") {
  const { botId, groupId } = owner;
  const query = search
    .trim()
    .slice(0, PAGE_LIST_QUERY_MAX_LENGTH)
    .replace(/[\uD800-\uDBFF]$/u, "");
  const scope = useSyncExternalStore(subscribePageScope, pageScopeKey, pageScopeKey);
  const identity = JSON.stringify([scope, botId ?? null, groupId ?? null, query]);
  const [stored, setStored] = useState<{ identity: string; listed: PagedPages }>({
    identity,
    listed: { status: "loading" },
  });
  const listed: PagedPages = stored.identity === identity ? stored.listed : { status: "loading" };
  const committed = useRef<string | null>(null);
  const focused = useRef(false);
  const generation = useRef(0);
  const loadingMore = useRef(false);
  const readyCursor = useRef<string | null>(null);
  // Bind before the focus effect starts its load. Rendering only gates identity;
  // a discarded render must not invalidate the committed screen's requests.
  useLayoutEffect(() => {
    committed.current = identity;
    generation.current += 1;
    loadingMore.current = false;
    readyCursor.current = null;
    setStored({ identity, listed: { status: "loading" } });
    return () => {
      committed.current = null;
      generation.current += 1;
    };
  }, [identity]);
  const isCurrent = useCallback(
    (started?: number) =>
      committed.current === identity &&
      focused.current &&
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
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    [botId, groupId, query],
  );
  const load = useCallback(() => {
    if (!isCurrent()) return;
    const started = ++generation.current;
    loadingMore.current = false;
    readyCursor.current = null;
    if (Boolean(botId) === Boolean(groupId)) {
      setStored({
        identity,
        listed: { status: "error", error: new Error("Choose a Pages owner") },
      });
      return;
    }
    if (shown.current.owner !== identity) shown.current = { owner: identity, count: 0 };
    const reload = async () => {
      let remaining = Math.max(shown.current.count, PAGE_SIZE);
      let nextCursor: string | null = null;
      const items: PageSummary[] = [];
      do {
        if (!isCurrent(started)) return;
        const limit = Math.min(remaining, PAGE_LIST_MAX_LIMIT);
        const result: PageBatch = await privatePageRpc(
          "pages/list",
          input(nextCursor ?? undefined, limit),
        );
        items.push(...result.items);
        nextCursor = result.nextCursor;
        remaining -= limit;
      } while (nextCursor && remaining > 0);
      if (!isCurrent(started)) return;
      readyCursor.current = nextCursor;
      setStored({
        identity,
        listed: { status: "ready", items: uniquePages(items), nextCursor, generation: started },
      });
    };
    void reload().catch((error: unknown) => {
      if (isCurrent(started)) setStored({ identity, listed: { status: "error", error } });
    });
  }, [botId, groupId, input, identity, isCurrent]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      setStored((current) =>
        current.identity === identity && current.listed.status === "ready"
          ? current
          : { identity, listed: { status: "loading" } },
      );
      load();
      return () => {
        focused.current = false;
        generation.current += 1;
      };
    }, [load, identity]),
  );
  const showMore = useCallback(async () => {
    // Rows stay visible during a reload, but their old cursor cannot start another request.
    if (
      listed.status !== "ready" ||
      !isCurrent(listed.generation) ||
      !listed.nextCursor ||
      readyCursor.current !== listed.nextCursor ||
      loadingMore.current
    )
      return;
    loadingMore.current = true;
    const started = listed.generation;
    try {
      const result = await privatePageRpc<PageBatch>("pages/list", input(listed.nextCursor)).catch(
        (error: unknown) => {
          // A failure from before a reload is as stale as a success would be.
          if (isCurrent(started)) throw error;
          return null;
        },
      );
      if (!result || !isCurrent(started)) return;
      readyCursor.current = result.nextCursor;
      setStored((current) =>
        current.identity === identity &&
        current.listed.status === "ready" &&
        current.listed.generation === started
          ? {
              identity,
              listed: {
                ...current.listed,
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
