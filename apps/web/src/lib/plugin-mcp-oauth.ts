import { MCP_OAUTH_CHANNEL } from "./mcp-connect";

type Authorization =
  | { status: "authorization_required"; sessionId: string; authorizationUrl: string }
  | { status: "already_connected" | "authorization_not_requested" };

/** A completion message is a hint to read the server, never proof of a connection. */
export async function authorizePluginMcp(options: {
  serverId: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  begin(
    input: { serverId: string; redirectUri: string },
    signal: AbortSignal,
  ): Promise<Authorization>;
}): Promise<
  "returned" | "pending" | "cancelled" | "authorization_not_requested" | "already_connected"
> {
  const current = () => !options.signal.aborted && options.isCurrent();
  if (!current()) return "cancelled";
  const started = await options.begin(
    { serverId: options.serverId, redirectUri: `${window.location.origin}/mcp/oauth/callback` },
    options.signal,
  );
  if (!current()) return "cancelled";
  if (started.status !== "authorization_required") return started.status;
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    let popup: Window | null = null;
    let poll: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (result: "returned" | "pending" | "cancelled") => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      channel.close();
      resolve(result);
    };
    const abort = () => {
      popup?.close();
      finish("cancelled");
    };
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; sessionId?: string } | null;
      if (data?.type !== "mcp-oauth-complete" || data.sessionId !== started.sessionId) return;
      if (!current()) return abort();
      finish("returned");
    };
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      popup = window.open(
        started.authorizationUrl,
        `${MCP_OAUTH_CHANNEL}-${started.sessionId}`,
        "popup,width=560,height=720",
      );
    } catch {
      return finish("pending");
    }
    if (!popup) return finish("pending");
    poll = setInterval(() => {
      if (!current()) return abort();
      if (popup?.closed) finish("cancelled");
    }, 500);
    timeout = setTimeout(
      () => {
        popup?.close();
        finish("pending");
      },
      2 * 60 * 1000,
    );
  });
}
