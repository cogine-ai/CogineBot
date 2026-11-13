import type {
  McpCreateReceipt,
  McpServer,
  McpServerConfigInput,
  McpTransport,
} from "@rakazo/contracts";
import {
  McpCreateReceiptSchema,
  McpCreateRequestSchema,
  McpServerConfigInput as McpInputSchema,
} from "@rakazo/contracts";
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
  error: "read" | "write" | "invalid" | "removed" | null;
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
/** Read generations own their locks. Uncertain creates retain their durable request identity until reconciled or fenced. */
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
  let submitted: { requestId: string; config: McpServerConfigInput; serverId?: string } | null =
    null;
  const current = () => !closed && options.isCurrent();
  function update(patch: Partial<McpManagementState>) {
    if (!current()) return;
    state = { ...state, ...patch };
    options.changed(state);
  }
  function verifyReceipt(value: McpCreateReceipt, intent: NonNullable<typeof submitted>) {
    const receipt = McpCreateReceiptSchema.parse(value);
    if (
      receipt.requestId !== intent.requestId ||
      (intent.serverId && receipt.serverId !== intent.serverId)
    )
      throw new Error("MCP creation identity mismatch");
    return receipt;
  }
  async function fence(signal: AbortSignal) {
    if (!submitted) return;
    const intent = submitted;
    const receipt = verifyReceipt(
      await options.request<McpCreateReceipt>(
        "mcp/servers/cancelCreate",
        { requestId: intent.requestId },
        signal,
      ),
      intent,
    );
    if (!current()) return;
    if (receipt.serverId) intent.serverId = receipt.serverId;
    else {
      submitted = null;
      update({ pendingCreate: false });
    }
  }
  async function refresh() {
    if (!current() || writing) return;
    const generation = ++readGeneration;
    reading?.abort();
    const controller = new AbortController();
    reading = controller;
    update({ loading: true, fresh: false, error: null });
    try {
      const intent = submitted;
      const receipt = intent
        ? await options.request<McpCreateReceipt | null>(
            "mcp/servers/creation",
            { requestId: intent.requestId },
            controller.signal,
          )
        : null;
      if (!current() || generation !== readGeneration) return;
      if (receipt) verifyReceipt(receipt, intent!);
      const servers = await options.request<McpServer[]>("mcp/servers/list", {}, controller.signal);
      if (!current() || generation !== readGeneration) return;
      let recovered: McpServer | null = null;
      let error: McpManagementState["error"] = null;
      if (receipt) {
        recovered = receipt.serverId
          ? (servers.find((server) => server.id === receipt.serverId) ?? null)
          : null;
        if (receipt.serverId && !recovered) error = "removed";
        submitted = null;
      }
      update({ servers, fresh: true, recovered, pendingCreate: !!submitted, error });
    } catch {
      if (generation === readGeneration) update({ error: "read", fresh: false });
    } finally {
      if (generation === readGeneration) {
        reading = null;
        update({ loading: false });
      }
    }
  }
  async function mutate<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    recovery = false,
  ): Promise<T | undefined> {
    if (!current() || writing || (!recovery && (!state.fresh || state.loading))) return;
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
        if (failed && !state.recovered && state.error === null) update({ error: "write" });
      }
    }
    return current() ? result : undefined;
  }
  return {
    refresh,
    async create(draft: McpServerDraft) {
      if (!current() || writing || !state.fresh || state.loading) return;
      const input = submitted?.config ?? mcpServerInput(draft);
      if (!McpInputSchema.safeParse(input).success) {
        update({ error: "invalid" });
        return;
      }
      return mutate(async (signal) => {
        if (!submitted) {
          const { requestId } = McpCreateRequestSchema.parse(
            await options.request("mcp/servers/newCreateRequest", {}, signal),
          );
          if (!current()) return;
          submitted = { requestId, config: input };
        }
        const intent = submitted;
        update({ pendingCreate: true });
        try {
          const receipt = verifyReceipt(
            await options.request<McpCreateReceipt>(
              "mcp/servers/createOnce",
              { requestId: intent.requestId, config: intent.config },
              signal,
            ),
            intent,
          );
          if (current() && receipt.serverId) intent.serverId = receipt.serverId;
        } catch (error) {
          const status =
            error && typeof error === "object" && "status" in error ? error.status : undefined;
          // A rejection only describes this invocation. Fence every older invocation
          // before releasing its identity, even when a successful list is empty.
          if ([400, 401, 403, 409, 422].includes(status as number)) await fence(signal);
          throw error;
        }
      });
    },
    async cancelCreate() {
      if (!submitted) return;
      return mutate(fence, true);
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
