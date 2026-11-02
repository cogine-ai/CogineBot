import type { McpServer, PluginServerConnectionInput } from "@rakazo/contracts";

export type PluginServerAuthorizationResult =
  | "returned"
  | "pending"
  | "cancelled"
  | "authorization_not_requested"
  | "already_connected";

export type PluginServerSetupState = {
  server: McpServer | null;
  phase:
    | "idle"
    | "loading"
    | "ready"
    | "saving"
    | "unknown"
    | "authorizing"
    | "authorization_pending"
    | "error";
  authorizationResult: PluginServerAuthorizationResult | null;
  error: unknown | null;
};

export const initialPluginServerSetup: PluginServerSetupState = {
  server: null,
  phase: "idle",
  authorizationResult: null,
  error: null,
};

type Deps = {
  serverId: string;
  list(signal: AbortSignal): Promise<McpServer[]>;
  save(input: PluginServerConnectionInput, signal: AbortSignal): Promise<McpServer>;
  authorize(serverId: string, signal: AbortSignal): Promise<PluginServerAuthorizationResult>;
  isCurrent(): boolean;
  changed(state: PluginServerSetupState): void;
};

/** Configure an existing owned child; transport completion never proves OAuth connection. */
export function createPluginServerSetup(deps: Deps) {
  let state = initialPluginServerSetup;
  let disposed = false;
  let generation = 0;
  let pending: AbortController | null = null;
  const current = (version: number) => !disposed && version === generation && deps.isCurrent();
  function publish(next: PluginServerSetupState) {
    state = next;
    deps.changed(state);
  }
  function begin(phase: PluginServerSetupState["phase"]) {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const version = ++generation;
    publish({ ...state, phase, error: null, authorizationResult: null });
    return { controller, version };
  }
  async function read(signal: AbortSignal) {
    const server = (await deps.list(signal)).find((row) => row.id === deps.serverId);
    if (!server) throw new Error("This server is no longer available. Reload its installation.");
    return server;
  }
  return {
    async refresh() {
      if (disposed || !deps.isCurrent()) return;
      const { controller, version } = begin("loading");
      try {
        const server = await read(controller.signal);
        if (current(version))
          publish({ server, phase: "ready", authorizationResult: null, error: null });
      } catch (error) {
        if (current(version))
          publish({ server: null, phase: "error", authorizationResult: null, error });
      } finally {
        if (current(version)) pending = null;
      }
    },
    async saveConnection(input: { enabled: boolean; headerUpdates?: Record<string, string> }) {
      const server = state.server;
      if (disposed || !deps.isCurrent() || !server || state.phase !== "ready") return;
      const { controller, version } = begin("saving");
      try {
        const next = await deps.save(
          {
            id: deps.serverId,
            connection: { revision: server.revision, ...input },
          },
          controller.signal,
        );
        if (!current(version)) return;
        if (next.id !== deps.serverId) throw new Error("Could not confirm server settings.");
        publish({ server: next, phase: "ready", authorizationResult: null, error: null });
        if (next.oauthStatus === "unknown") {
          try {
            const confirmed = await read(controller.signal);
            if (current(version) && confirmed.revision >= next.revision)
              publish({
                server: confirmed,
                phase: "ready",
                authorizationResult: null,
                error: null,
              });
          } catch {
            // The write is confirmed. A status outage must not undo that fact or prevent disabling.
          }
        }
      } catch (error) {
        // A lost response cannot prove whether the server committed the update. Read before retry.
        if (current(version)) publish({ ...state, phase: "unknown", error });
      } finally {
        if (current(version)) pending = null;
      }
    },
    async connectOAuth() {
      const server = state.server;
      if (
        disposed ||
        !deps.isCurrent() ||
        !server?.enabled ||
        server.oauthStatus === "unknown" ||
        state.phase !== "ready"
      )
        return;
      const { controller, version } = begin("authorizing");
      let result: PluginServerAuthorizationResult | null = null;
      try {
        result = await deps.authorize(deps.serverId, controller.signal);
        if (!current(version)) return;
        const next = await read(controller.signal);
        if (!current(version)) return;
        publish({
          server: next,
          phase:
            next.oauthStatus === "connected" || result === "authorization_not_requested"
              ? "ready"
              : "authorization_pending",
          authorizationResult: result,
          error: null,
        });
      } catch (error) {
        if (current(version))
          publish({ ...state, phase: "authorization_pending", authorizationResult: result, error });
      } finally {
        if (current(version)) pending = null;
      }
    },
    dispose() {
      disposed = true;
      generation++;
      pending?.abort();
      pending = null;
      // No credential draft is retained in shared state.
    },
  };
}

export type PluginServerSetup = ReturnType<typeof createPluginServerSetup>;
