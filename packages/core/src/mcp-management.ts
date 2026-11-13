import type { McpServer, McpServerConfigInput, McpTransport } from "@rakazo/contracts";
import { McpServerConfigInput as McpInputSchema } from "@rakazo/contracts";
import { deriveMcpSlug } from "./mcp.js";

export type McpServerDraft = {
  name: string;
  transport: McpTransport;
  endpoint: string;
  command: string;
  args: string;
  secret: string;
  headerName: string;
  headerValue: string;
  verbatimResults: boolean;
};
export function emptyMcpServerDraft(): McpServerDraft {
  return {
    name: "",
    transport: "streamable_http",
    endpoint: "",
    command: "",
    args: "",
    secret: "",
    headerName: "Authorization",
    headerValue: "",
    verbatimResults: false,
  };
}
/** The same creation fields and argument splitting as the web form. Validation stays server-owned. */
export function mcpServerInput(
  draft: McpServerDraft,
  slug = deriveMcpSlug(draft.name),
): McpServerConfigInput {
  const base = {
    slug,
    name: draft.name.trim(),
    description: "",
    enabled: true,
    secret: draft.secret || undefined,
    verbatimResults: draft.verbatimResults,
  };
  return draft.transport === "stdio"
    ? {
        ...base,
        transport: "stdio",
        command: draft.command.trim(),
        args: draft.args.split(/\s+/).filter(Boolean),
        env: {},
      }
    : {
        ...base,
        transport: draft.transport,
        endpoint: draft.endpoint.trim(),
        headers: draft.headerValue.trim()
          ? { [draft.headerName.trim() || "Authorization"]: draft.headerValue.trim() }
          : {},
      };
}

export type McpManagementState = {
  servers: McpServer[];
  loading: boolean;
  writing: boolean;
  fresh: boolean;
  error: "read" | "write" | "invalid" | null;
  recovered: McpServer | null;
  pendingCreate: boolean;
};
export function initialMcpManagementState(): McpManagementState {
  return {
    servers: [],
    loading: false,
    writing: false,
    fresh: false,
    error: null,
    recovered: null,
    pendingCreate: false,
  };
}
/** Read generations own their locks. Uncertain creates retain their unique slug until reconciled. */
export function createMcpManagement(options: {
  request<T>(procedure: string, input: unknown, signal: AbortSignal): Promise<T>;
  isCurrent(): boolean;
  changed(state: McpManagementState): void;
}) {
  let state = initialMcpManagementState();
  let closed = false;
  let readGeneration = 0;
  let reading: AbortController | null = null;
  let writing: AbortController | null = null;
  let submitted: McpServerConfigInput | null = null;
  const current = () => !closed && options.isCurrent();
  function update(patch: Partial<McpManagementState>) {
    if (!current()) return;
    state = { ...state, ...patch };
    options.changed(state);
  }
  async function refresh() {
    if (!current() || writing) return;
    const generation = ++readGeneration;
    reading?.abort();
    const controller = new AbortController();
    reading = controller;
    update({ loading: true, fresh: false, error: null });
    try {
      const servers = await options.request<McpServer[]>("mcp/servers/list", {}, controller.signal);
      if (!current() || generation !== readGeneration) return;
      const recovered = submitted
        ? (servers.find((server) => server.slug === submitted?.slug) ?? null)
        : null;
      if (recovered) submitted = null;
      update({ servers, fresh: true, recovered, pendingCreate: !!submitted });
    } catch {
      if (generation === readGeneration) update({ error: "read", fresh: false });
    } finally {
      if (generation === readGeneration) {
        reading = null;
        update({ loading: false });
      }
    }
  }
  async function mutate<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (!current() || writing || !state.fresh || state.loading) return;
    const controller = new AbortController();
    writing = controller;
    // Invalidate any outstanding read before a write can start.
    ++readGeneration;
    reading?.abort();
    update({ writing: true, fresh: false, error: null, recovered: null });
    let result: T | undefined;
    let failed = false;
    try {
      result = await operation(controller.signal);
    } catch {
      failed = true;
    } finally {
      writing = null;
      if (current()) {
        update({ writing: false });
        await refresh();
        if (failed && !state.recovered && state.error !== "read") update({ error: "write" });
      }
    }
    return current() ? result : undefined;
  }
  return {
    refresh,
    async create(draft: McpServerDraft) {
      if (!current() || writing || !state.fresh || state.loading) return;
      const retrying = !!submitted;
      const input = submitted ?? mcpServerInput(draft);
      if (!McpInputSchema.safeParse(input).success) {
        update({ error: "invalid" });
        return;
      }
      // A pre-existing duplicate must go through backend validation, never masquerade as recovery.
      const preexisting = state.servers.some((server) => server.slug === input.slug);
      if (!preexisting) submitted = input;
      update({ pendingCreate: !!submitted });
      return mutate(async (signal) => {
        try {
          return await options.request<McpServer>("mcp/servers/create", input, signal);
        } catch (error) {
          const status =
            error && typeof error === "object" && "status" in error ? error.status : undefined;
          if (!retrying && (status === 400 || status === 401 || status === 403 || status === 422)) {
            submitted = null;
            update({ pendingCreate: false });
          }
          throw error;
        }
      });
    },
    async write<T>(procedure: string, input: unknown) {
      if (submitted) return;
      return mutate<T>((signal) => options.request<T>(procedure, input, signal));
    },
    async authorize(operation: (signal: AbortSignal) => Promise<void>) {
      if (submitted) return;
      return mutate(operation);
    },
    dispose() {
      closed = true;
      ++readGeneration;
      reading?.abort();
      writing?.abort();
      submitted = null;
    },
  };
}
export type McpManagement = ReturnType<typeof createMcpManagement>;
