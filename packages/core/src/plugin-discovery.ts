import type {
  PluginMarketplaceEntry,
  PluginSearchInput,
  PluginSearchResult,
} from "@rakazo/contracts";

export type PluginDiscoveryState = {
  query: string;
  entries: PluginMarketplaceEntry[];
  nextCursor: string | null;
  unavailableRegistries: string[];
  skippedEntries: number;
  phase: "idle" | "loading" | "ready" | "loading_more" | "error";
  error: unknown | null;
};

export const initialPluginDiscovery: PluginDiscoveryState = {
  query: "",
  entries: [],
  nextCursor: null,
  unavailableRegistries: [],
  skippedEntries: 0,
  phase: "idle",
  error: null,
};

type Deps = {
  search(input: PluginSearchInput, signal: AbortSignal): Promise<PluginSearchResult>;
  isCurrent(): boolean;
  changed(state: PluginDiscoveryState): void;
};

/** Discovery is read-only; choosing a result still requires the separate pinned preview. */
export function createPluginDiscovery(deps: Deps) {
  let state = initialPluginDiscovery;
  let disposed = false;
  let generation = 0;
  let pending: AbortController | null = null;
  const current = (version: number) => !disposed && version === generation && deps.isCurrent();
  function publish(next: PluginDiscoveryState) {
    state = next;
    deps.changed(state);
  }
  async function request(query: string, cursor?: string) {
    if (disposed || !deps.isCurrent()) return;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const version = ++generation;
    publish({
      ...(cursor ? state : initialPluginDiscovery),
      query,
      phase: cursor ? "loading_more" : "loading",
      error: null,
    });
    try {
      const result = await deps.search({ query, ...(cursor ? { cursor } : {}) }, controller.signal);
      if (!current(version)) return;
      publish({
        query,
        entries: cursor ? [...state.entries, ...result.entries] : result.entries,
        nextCursor: result.nextCursor,
        unavailableRegistries: result.unavailableRegistries,
        skippedEntries: result.skippedEntries,
        phase: "ready",
        error: null,
      });
    } catch (error) {
      if (current(version)) publish({ ...state, phase: "error", error });
    } finally {
      if (current(version)) pending = null;
    }
  }
  return {
    search(query: string) {
      return request(query.trim());
    },
    async loadMore() {
      if (!state.nextCursor || state.phase === "loading" || state.phase === "loading_more") return;
      await request(state.query, state.nextCursor);
    },
    dispose() {
      disposed = true;
      generation++;
      pending?.abort();
      pending = null;
    },
  };
}

export type PluginDiscovery = ReturnType<typeof createPluginDiscovery>;
