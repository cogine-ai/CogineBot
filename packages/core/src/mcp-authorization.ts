import { MCP_NATIVE_REDIRECT_URI } from "@rakazo/contracts";

export type McpAuthorizationResult =
  | "connected"
  | "cancelled"
  | "expired"
  | "failed"
  | "disconnect_required"
  | "already_connected"
  | "authorization_not_requested";
type Begin =
  | { status: "authorization_required"; sessionId: string; authorizationUrl: string }
  | { status: "already_connected" | "authorization_not_requested" | "disconnect_required" };
/** The browser return is only a candidate. Bind it to this live attempt before sending a code once. */
export async function authorizeMcp(options: {
  serverId: string;
  request<T>(procedure: string, input: unknown, signal: AbortSignal): Promise<T>;
  open(
    url: string,
    redirectUri: string,
    signal: AbortSignal,
  ): Promise<{ type: string; url?: string }>;
  signal: AbortSignal;
  isCurrent(): boolean;
  now?: () => number;
}): Promise<McpAuthorizationResult> {
  const { signal, request } = options;
  const current = () => !signal.aborted && options.isCurrent();
  const now = options.now ?? Date.now;
  if (!current()) return "cancelled";
  const started = await request<Begin>(
    "mcp/oauth/begin",
    { serverId: options.serverId, redirectUri: MCP_NATIVE_REDIRECT_URI },
    signal,
  );
  if (!current()) return "cancelled";
  if (started.status !== "authorization_required") return started.status;
  const expires = now() + 5 * 60 * 1000;
  const authorization = new URL(started.authorizationUrl);
  if (
    !["https:", "http:"].includes(authorization.protocol) ||
    authorization.username ||
    authorization.password ||
    authorization.searchParams.get("state") !== started.sessionId
  )
    return "failed";
  const result = await options.open(started.authorizationUrl, MCP_NATIVE_REDIRECT_URI, signal);
  if (!current()) return "cancelled";
  if (now() >= expires) return "expired";
  if (result.type !== "success" || !result.url) return "cancelled";
  let callback: URL;
  try {
    callback = new URL(result.url);
  } catch {
    return "failed";
  }
  const target = new URL(MCP_NATIVE_REDIRECT_URI);
  if (
    callback.protocol !== target.protocol ||
    callback.host !== target.host ||
    callback.pathname !== target.pathname ||
    callback.hash ||
    callback.username ||
    callback.password
  )
    return "failed";
  if (
    callback.searchParams.getAll("state").length !== 1 ||
    callback.searchParams.get("state") !== started.sessionId
  )
    return "failed";
  if (callback.searchParams.has("error")) return "failed";
  const code = callback.searchParams.get("code");
  if (!code || callback.searchParams.getAll("code").length !== 1) return "failed";
  // Never retry a code, including after a lost completion response. Caller reads status instead.
  await request(
    "mcp/oauth/complete",
    { sessionId: started.sessionId, state: started.sessionId, code },
    signal,
  );
  return current() ? "connected" : "cancelled";
}
