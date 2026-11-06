import type { PageSummary } from "@rakazo/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePages } from "./pages";

type PageList = { items: PageSummary[]; nextCursor: string | null };

/** The current UI's scoped RPC owns list reads; no global query client is needed. */
export function usePrivatePageList(input: {
  botId?: string;
  groupId?: string;
  query: string;
  limit: number;
}) {
  const { store } = usePages()!;
  const revision = useSyncExternalStore(store.subscribe, store.revision);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    data?: PageList[];
    error: "refresh" | "more" | null;
    pending: boolean;
    more: boolean;
  }>({ error: null, pending: true, more: false });
  const generation = useRef(0);
  const fetching = useRef(false);
  const { botId, groupId, query, limit } = input;
  const request = useCallback(
    (cursor?: string) =>
      store.client.pages.list({
        ...(botId ? { botId } : { groupId }),
        limit,
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    [store, botId, groupId, query, limit],
  );
  const loaded = useRef({ request, count: 1 });
  useEffect(() => {
    const started = ++generation.current;
    fetching.current = true;
    // Refresh the batches already shown, using each newly read cursor. A different search
    // starts at its first batch while the last results remain visible until it arrives.
    const count = loaded.current.request === request ? loaded.current.count : 1;
    setState((previous) => ({
      data: previous.data,
      error: null,
      pending: previous.data === undefined,
      more: false,
    }));
    const read = async () => {
      const data: PageList[] = [];
      let cursor: string | undefined;
      for (let index = 0; index < count; index += 1) {
        if (started !== generation.current || !store.isCurrent()) return;
        const page = await request(cursor);
        data.push(page);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      if (started !== generation.current || !store.isCurrent()) return;
      loaded.current = { request, count: data.length };
      setState({ data, error: null, pending: false, more: false });
    };
    void read()
      .catch(() => {
        if (started === generation.current && store.isCurrent())
          setState((previous) => ({ ...previous, error: "refresh", pending: false, more: false }));
      })
      .finally(() => {
        if (started === generation.current) fetching.current = false;
      });
    return () => {
      generation.current += 1;
    };
  }, [store, request, revision, attempt]);
  const fetchNextPage = async () => {
    const cursor = state.data?.at(-1)?.nextCursor;
    if (!cursor || fetching.current || loaded.current.request !== request || !store.isCurrent())
      return;
    fetching.current = true;
    const started = generation.current;
    setState((previous) => ({ ...previous, more: true, error: null }));
    try {
      const next = await request(cursor);
      if (started !== generation.current || !store.isCurrent()) return;
      loaded.current = { request, count: (state.data?.length ?? 0) + 1 };
      setState((previous) => ({
        data: [...(previous.data ?? []), next],
        error: null,
        pending: false,
        more: false,
      }));
    } catch {
      if (started === generation.current && store.isCurrent())
        setState((previous) => ({ ...previous, more: false, error: "more" }));
    } finally {
      if (started === generation.current) fetching.current = false;
    }
  };
  return {
    data: state.data ? { pages: state.data } : undefined,
    isPending: state.pending,
    isError: state.error !== null,
    hasNextPage: loaded.current.request === request && state.data?.at(-1)?.nextCursor != null,
    isFetchingNextPage: state.more,
    isFetchNextPageError: state.error === "more",
    fetchNextPage,
    refetch: () => setAttempt((value) => value + 1),
  };
}

/** Both successful and lost mutation replies reconcile cards and their owner's list. */
export function usePrivatePageMutation<T>(call: (input: T) => Promise<unknown>, pageId?: string) {
  const pages = usePages()!;
  const [state, setState] = useState({ pending: false, error: false });
  const latest = useRef(0);
  const active = useRef(0);
  const handler = useRef(call);
  handler.current = call;
  const mutateAsync = async (input: T) => {
    if (!pages.store.isCurrent()) throw new DOMException("Page scope changed", "AbortError");
    const started = ++latest.current;
    active.current += 1;
    setState({ pending: true, error: false });
    let failed = false;
    try {
      return await handler.current(input);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const pending = --active.current > 0;
      if (pages.store.isCurrent()) {
        // Every call settles its cache; only the latest attempt owns the visible error.
        setState((previous) => ({
          pending,
          error: started === latest.current ? failed : previous.error,
        }));
        pages.store.invalidate(pageId);
      }
    }
  };
  return {
    isPending: state.pending,
    isError: state.error,
    mutateAsync,
    mutate: (input: T) => {
      void mutateAsync(input).catch(() => {});
    },
    reset: () => {
      latest.current += 1;
      setState({ pending: active.current > 0, error: false });
    },
  };
}
