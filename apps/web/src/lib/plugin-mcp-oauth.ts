import { newClientId } from "./client-id";
import { MCP_OAUTH_CHANNEL } from "./mcp-connect";

type Authorization =
  | { status: "authorization_required"; sessionId: string; authorizationUrl: string }
  | { status: "already_connected" | "authorization_not_requested" };
type Result =
  | "returned"
  | "pending"
  | "cancelled"
  | "authorization_not_requested"
  | "already_connected";

/** A completion message is a hint to read the server, never proof of a connection. */
export function authorizePluginMcp(options: {
  serverId: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  begin(
    input: { serverId: string; redirectUri: string },
    signal: AbortSignal,
  ): Promise<Authorization>;
}): Promise<Result> {
  const current = () => !options.signal.aborted && options.isCurrent();
  if (!current()) return Promise.resolve("cancelled");
  // Open during the click's transient activation. A delayed RPC must only navigate this handle.
  let popup: Window | null;
  try {
    popup = window.open(
      "about:blank",
      `${MCP_OAUTH_CHANNEL}-pending-${newClientId()}`,
      "popup,width=560,height=720",
    );
  } catch {
    return Promise.resolve("pending");
  }
  if (!popup) return Promise.resolve("pending");
  const ownedPopup = popup;
  return new Promise<Result>((resolve, reject) => {
    let channel: BroadcastChannel | null = null;
    let settled = false;
    let scopeTimer: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    function closeOwnedPopup() {
      try {
        ownedPopup.close();
      } catch {
        /* The provider may have severed the window proxy. */
      }
    }
    function cleanup() {
      clearInterval(scopeTimer);
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      channel?.close();
    }
    function finish(result: Result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }
    function abort() {
      closeOwnedPopup();
      finish("cancelled");
    }
    options.signal.addEventListener("abort", abort, { once: true });
    scopeTimer = setInterval(() => {
      if (!current()) abort();
    }, 500);
    timeout = setTimeout(
      () => {
        closeOwnedPopup();
        finish("pending");
      },
      2 * 60 * 1000,
    );
    void (async () => {
      try {
        const started = await options.begin(
          {
            serverId: options.serverId,
            redirectUri: `${window.location.origin}/mcp/oauth/callback`,
          },
          options.signal,
        );
        if (settled) return;
        if (!current()) return abort();
        if (started.status !== "authorization_required") {
          closeOwnedPopup();
          finish(started.status);
          return;
        }
        ownedPopup.name = `${MCP_OAUTH_CHANNEL}-${started.sessionId}`;
        channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
        channel.onmessage = (event: MessageEvent) => {
          const data = event.data as { type?: string; sessionId?: string } | null;
          if (data?.type !== "mcp-oauth-complete" || data.sessionId !== started.sessionId) return;
          if (!current()) return abort();
          finish("returned");
        };
        // Completion uses the correlated channel; the provider must not control this app window.
        ownedPopup.opener = null;
        ownedPopup.location.replace(started.authorizationUrl);
        // COOP can report closed while the provider window is still open. Only a correlated
        // completion, explicit scope cancellation, or timeout ends this wait.
      } catch (error) {
        if (settled) return;
        closeOwnedPopup();
        settled = true;
        cleanup();
        reject(error);
      }
    })();
  });
}
