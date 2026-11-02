import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { MCP_OAUTH_CHANNEL } from "../lib/mcp-connect";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

// Session-scoped window names survive providers that sever window.opener.
// The unsuffixed name remains supported for existing connection entry points.
const POPUP_NAME = MCP_OAUTH_CHANNEL;

export function McpOAuthCallbackPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const handledState = useRef<string | null>(null);
  const callbackSession = params.get("state");
  const isPopup =
    window.name === POPUP_NAME ||
    (Boolean(callbackSession) && window.name === `${POPUP_NAME}-${callbackSession}`);
  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setError(params.get("error_description") ?? t`OAuth authorization was cancelled.`);
      return;
    }
    if (handledState.current === state) return;
    handledState.current = state;
    void rpc.mcp.oauth
      .complete({ sessionId: state, code, state })
      .then(() => {
        const channel = new BroadcastChannel(POPUP_NAME);
        channel.postMessage({ type: "mcp-oauth-complete", sessionId: state });
        channel.close();
        if (isPopup) {
          setDone(true);
          window.close();
          return;
        }
        navigate("/app?mcp_oauth=connected", { replace: true });
      })
      .catch((err: unknown) => setError(errorText(err, t`Could not complete OAuth`)));
  }, [navigate, params, t, isPopup]);
  const showReturn = Boolean(error) && !isPopup;
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center">
      <div>
        <div className="text-lg text-foreground">
          {error ? (
            <Trans>OAuth connection failed</Trans>
          ) : done ? (
            <Trans>Connected</Trans>
          ) : (
            <Trans>Finishing MCP connection…</Trans>
          )}
        </div>
        {error ? <p className="mt-2 max-w-md text-sm text-muted-foreground">{error}</p> : null}
        {showReturn ? (
          <Button type="button" className="mt-5" onClick={() => navigate("/app")}>
            <Trans>Return to CogineBot</Trans>
          </Button>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {error || done ? (
              <Trans>You can close this window.</Trans>
            ) : (
              <Trans>You can close this tab if it does not redirect automatically.</Trans>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
