import type {
  Bot,
  ExternalConversation,
  ExternalConversationPolicy,
  MessagingAgentConnection,
  MessagingChannelMembership,
  MessagingStatus,
} from "@rakazo/contracts";

/** Transport boundary shared by native and browser settings clients. */
export interface MessagingSettingsApi {
  status(): Promise<MessagingStatus>;
  channels(): Promise<MessagingChannelMembership[]>;
  connections(): Promise<MessagingAgentConnection[]>;
  bots(): Promise<Bot[]>;
  conversations(): Promise<ExternalConversation[]>;
  link(botId: string): Promise<{ code: string; expiresAt: string }>;
  mutate(procedure: string, input: unknown): Promise<unknown>;
}
export type MessagingSettingsState = {
  data: {
    status: MessagingStatus;
    channels: MessagingChannelMembership[];
    connections: MessagingAgentConnection[];
    bots: Bot[];
    conversations: ExternalConversation[];
  } | null;
  botId: string;
  link: { code: string; expiresAt: string } | null;
  busy: boolean;
  error: "load" | "update" | "expired" | "poll" | null;
};

/** A focus-scoped session. Disposing invalidates every pending completion and timer. */
export function createMessagingSettings(api: MessagingSettingsApi, current: () => boolean) {
  let state: MessagingSettingsState = {
    data: null,
    botId: "",
    link: null,
    busy: false,
    error: null,
  };
  let disposed = false;
  let revision = 0;
  let linkRevision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const valid = () => !disposed && current();
  function publish(patch: Partial<MessagingSettingsState>) {
    if (!valid()) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function clearLink() {
    linkRevision++;
    clearTimeout(timer);
    clearTimeout(deadline);
    publish({ link: null });
  }
  async function load() {
    const version = ++revision;
    const [status, channels, connections, bots, conversations] = await Promise.all([
      api.status(),
      api.channels(),
      api.connections(),
      api.bots(),
      api.conversations(),
    ]);
    if (valid() && version === revision)
      publish({ data: { status, channels, connections, bots, conversations } });
  }
  async function refresh() {
    if (!valid() || state.busy) return;
    publish({ busy: true, error: null });
    try {
      await load();
    } catch {
      publish({ data: null, error: "load" });
    } finally {
      publish({ busy: false });
    }
  }
  async function mutate(procedure: string, input: unknown) {
    if (!valid() || state.busy) return false;
    clearLink();
    publish({ busy: true, error: null });
    let success = false;
    try {
      await api.mutate(procedure, input);
      if (!valid()) return false;
      await load();
      success = valid();
    } catch {
      // Recover the current invitation version after a conflict; never retry a decision.
      try {
        if (valid()) await load();
      } catch {
        publish({ data: null });
      }
      publish({ error: "update" });
    } finally {
      publish({ busy: false });
    }
    return success;
  }
  async function startLink() {
    if (!valid() || state.busy || !state.botId || !state.data?.status.providers.length) return;
    clearLink();
    const version = linkRevision;
    const botId = state.botId;
    const identityIds = new Set(state.data.status.identities.map((identity) => identity.id));
    const active = () => valid() && version === linkRevision && state.botId === botId;
    publish({ busy: true, error: null });
    try {
      const link = await api.link(botId);
      if (!active()) return;
      const expires = Date.parse(link.expiresAt);
      const expire = () => {
        if (!active()) return;
        clearLink();
        publish({ error: "expired" });
      };
      if (!Number.isFinite(expires) || expires <= Date.now()) {
        expire();
        return;
      }
      publish({ link });
      deadline = setTimeout(expire, expires - Date.now());
      async function poll() {
        if (!active()) return;
        if (Date.now() >= expires) {
          expire();
          return;
        }
        try {
          const status = await api.status();
          if (!active() || Date.now() >= expires) return;
          if (
            status.identities.some(
              (identity) => identity.botId === botId && !identityIds.has(identity.id),
            )
          ) {
            await load();
            if (active() && Date.now() < expires) {
              clearLink();
              publish({ error: null });
            }
            return;
          }
          publish({ error: null });
        } catch {
          if (active()) publish({ error: "poll" });
        }
        if (active()) timer = setTimeout(() => void poll(), 3000);
      }
      timer = setTimeout(() => void poll(), 3000);
    } catch {
      if (active()) publish({ error: "update" });
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
    refresh,
    mutate,
    startLink,
    selectBot(botId: string) {
      clearLink();
      publish({ botId, error: null });
    },
    savePolicy(id: string, policy: ExternalConversationPolicy) {
      return mutate("externalConversations/updatePolicy", {
        externalConversationId: id,
        ...policy,
      });
    },
    dispose() {
      clearLink();
      disposed = true;
      revision++;
      listeners.clear();
    },
  };
}

export function validConnectionVersion(connection: MessagingAgentConnection): boolean {
  return (
    Number.isInteger(connection.requestVersion) &&
    connection.requestVersion > 0 &&
    connection.requestVersion <= 2_147_483_647
  );
}
