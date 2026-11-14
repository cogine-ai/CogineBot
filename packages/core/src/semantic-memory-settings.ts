import type { Bot, MemoryScopeValue, SpaceMemoryConfig } from "@rakazo/contracts";

export type SemanticMemoryScope = MemoryScopeValue;
export type MemoryConnectionDraft = {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
  defaultMemoryScope: SemanticMemoryScope;
};

/** Settings transport only; authorization and provider probing remain on the server. */
export interface SemanticMemorySettingsApi {
  read(): Promise<{
    config: SpaceMemoryConfig | null;
    canManage: boolean;
    bot: Pick<Bot, "id" | "name" | "memoryScope"> | null;
  }>;
  connect(input: MemoryConnectionDraft): Promise<unknown>;
  disconnect(): Promise<unknown>;
  setDefault(scope: SemanticMemoryScope): Promise<unknown>;
  setBot(botId: string, scope: SemanticMemoryScope | null): Promise<unknown>;
}

export function createSemanticMemorySettings(
  api: SemanticMemorySettingsApi,
  current: () => boolean,
) {
  type Data = Awaited<ReturnType<SemanticMemorySettingsApi["read"]>>;
  let state: { data: Data | null; busy: boolean; error: boolean } = {
    data: null,
    busy: false,
    error: false,
  };
  let disposed = false;
  const listeners = new Set<() => void>();
  const valid = () => !disposed && current();
  function publish(patch: Partial<typeof state>) {
    if (!valid()) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  async function run(write?: () => Promise<unknown>) {
    if (!valid() || state.busy) return false;
    publish({ busy: true, error: false });
    try {
      if (write) await write();
      if (!valid()) return false;
      const data = await api.read();
      if (!valid()) return false;
      publish({ data });
      return true;
    } catch {
      // Never retain authority or advertise a connection after an uncertain write/read.
      // Do not render upstream errors, which can contain credential-bearing URLs.
      publish({ data: null, error: true });
      return false;
    } finally {
      publish({ busy: false });
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => run(),
    connect: (draft: MemoryConnectionDraft) =>
      state.data?.canManage ? run(() => api.connect(draft)) : Promise.resolve(false),
    disconnect: () =>
      state.data?.canManage ? run(() => api.disconnect()) : Promise.resolve(false),
    setDefault: (scope: SemanticMemoryScope) =>
      state.data?.canManage && state.data.config
        ? run(() => api.setDefault(scope))
        : Promise.resolve(false),
    setBot: (scope: SemanticMemoryScope | null) => {
      const bot = state.data?.bot;
      return bot && state.data?.config
        ? run(() => api.setBot(bot.id, scope))
        : Promise.resolve(false);
    },
    dispose() {
      disposed = true;
      state = { data: null, busy: false, error: false };
      listeners.clear();
    },
  };
}
