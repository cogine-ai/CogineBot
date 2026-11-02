import { Trans, useLingui } from "@lingui/react/macro";
import type { PluginServerSetupState } from "@rakazo/core";
import { createPluginServerSetup, initialPluginServerSetup } from "@rakazo/core";
import { Badge, Button, Input } from "@rakazo/ui-web";
import { useLayoutEffect, useRef, useState } from "react";
import { authorizePluginMcp } from "../../lib/plugin-mcp-oauth";
import type { RpcRecoveryScope } from "../../lib/rpc";
import { createSpaceRpc, isRpcRecoveryScopeCurrent } from "../../lib/rpc";

export function PluginServerSetup({
  serverId,
  scope,
  onOpenMcp,
  disabled = false,
}: {
  serverId: string;
  scope: RpcRecoveryScope;
  onOpenMcp?: () => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<PluginServerSetupState>(initialPluginServerSetup);
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [editingHeaders, setEditingHeaders] = useState(false);
  const [addingHeader, setAddingHeader] = useState(false);
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const manager = useRef<ReturnType<typeof createPluginServerSetup> | null>(null);
  useLayoutEffect(() => {
    setHeaders({});
    setHeaderName("");
    setHeaderValue("");
    setAddingHeader(false);
    setEditingHeaders(false);
    setState(initialPluginServerSetup);
    let active = true;
    const isCurrent = () => active && isRpcRecoveryScopeCurrent(scope);
    const client = createSpaceRpc(scope.spaceId, isCurrent);
    const setup = createPluginServerSetup({
      serverId,
      list: (signal) => client.mcp.servers.list(undefined, { signal }),
      save: (input, signal) => client.mcp.servers.update(input, { signal }),
      authorize: (id, signal) =>
        authorizePluginMcp({
          serverId: id,
          signal,
          isCurrent,
          begin: (input, requestSignal) => client.mcp.oauth.begin(input, { signal: requestSignal }),
        }),
      isCurrent,
      changed: setState,
    });
    manager.current = setup;
    void setup.refresh();
    return () => {
      active = false;
      setup.dispose();
      manager.current = null;
    };
  }, [scope, serverId]);
  const server = state.server;
  const busy =
    state.phase === "loading" || state.phase === "saving" || state.phase === "authorizing";
  const locked =
    disabled || busy || state.phase === "unknown" || state.phase === "authorization_pending";
  async function save(enabled: boolean, includeHeaders = false) {
    const headerUpdates = Object.fromEntries(
      Object.entries(includeHeaders ? headers : {}).filter(([, value]) => value.length),
    );
    if (includeHeaders && headerName.trim() && headerValue)
      headerUpdates[headerName.trim()] = headerValue;
    setHeaders({});
    setHeaderName("");
    setHeaderValue("");
    setAddingHeader(false);
    setEditingHeaders(false);
    await manager.current?.saveConnection({
      enabled,
      ...(Object.keys(headerUpdates).length ? { headerUpdates } : {}),
    });
  }
  return (
    <section
      aria-label={server?.name ?? t`MCP connection`}
      className="space-y-3 rounded-lg border p-3"
      data-testid="plugin-server-setup"
    >
      {server ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h5 className="text-sm font-medium">{server.name}</h5>
            <Badge>{server.enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>}</Badge>
          </div>
          <p className="break-all text-xs text-muted-foreground">{server.endpoint}</p>
          {server.oauthStatus === "unknown" ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Connection status unavailable.</Trans>
            </p>
          ) : null}
          {server.oauthStatus === "connected" ? (
            <p className="text-sm">
              <Trans>Connected</Trans>
            </p>
          ) : server.oauthStatus === "reconnect" ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Sign-in required</Trans>
            </p>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={locked}
            onClick={() => {
              setEditingHeaders((value) => !value);
              setHeaders({});
              setHeaderName("");
              setHeaderValue("");
              setAddingHeader(!server.headerKeys.length);
            }}
          >
            {server.headerKeys.length ? <Trans>Edit credentials</Trans> : <Trans>Add header</Trans>}
          </Button>
          {editingHeaders ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save(server.enabled, true);
              }}
            >
              {server.headerKeys.map((name) => (
                <label
                  key={name}
                  htmlFor={`plugin-header-${server.id}-${name}`}
                  className="block space-y-1 text-sm"
                >
                  <span>{name}</span>
                  <Input
                    aria-label={name}
                    id={`plugin-header-${server.id}-${name}`}
                    type="password"
                    autoComplete="off"
                    value={headers[name] ?? ""}
                    disabled={locked}
                    maxLength={4096}
                    onChange={(event) =>
                      setHeaders((value) => ({ ...value, [name]: event.target.value }))
                    }
                  />
                </label>
              ))}
              {addingHeader ? (
                <div className="space-y-3">
                  <label
                    htmlFor={`plugin-header-name-${server.id}`}
                    className="block space-y-1 text-sm"
                  >
                    <span>
                      <Trans>Header name</Trans>
                    </span>
                    <Input
                      id={`plugin-header-name-${server.id}`}
                      aria-label={t`Header name`}
                      value={headerName}
                      maxLength={120}
                      disabled={locked}
                      autoComplete="off"
                      onChange={(event) => setHeaderName(event.target.value)}
                    />
                  </label>
                  <label
                    htmlFor={`plugin-header-value-${server.id}`}
                    className="block space-y-1 text-sm"
                  >
                    <span>
                      <Trans>Header value</Trans>
                    </span>
                    <Input
                      id={`plugin-header-value-${server.id}`}
                      aria-label={t`Header value`}
                      type="password"
                      value={headerValue}
                      maxLength={4096}
                      disabled={locked}
                      autoComplete="off"
                      onChange={(event) => setHeaderValue(event.target.value)}
                    />
                  </label>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={locked}
                  onClick={() => setAddingHeader(true)}
                >
                  <Trans>Add header</Trans>
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                <Trans>Leave blank to keep saved credentials.</Trans>
              </p>
              <Button
                variant="outline"
                size="sm"
                type="submit"
                disabled={
                  locked ||
                  (!Object.values(headers).some(Boolean) && !(headerName.trim() && headerValue))
                }
              >
                <Trans>Save credentials</Trans>
              </Button>
            </form>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={() => void save(!server.enabled)}
            >
              {server.enabled ? (
                <Trans>Disable connection</Trans>
              ) : (
                <Trans>Enable connection</Trans>
              )}
            </Button>
            {server.enabled &&
            server.oauthStatus !== "connected" &&
            server.oauthStatus !== "unknown" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={locked}
                onClick={() => void manager.current?.connectOAuth()}
              >
                {server.oauthStatus === "reconnect" ? (
                  <Trans>Reconnect</Trans>
                ) : (
                  <Trans>Sign in</Trans>
                )}
              </Button>
            ) : null}
            {onOpenMcp ? (
              <Button variant="ghost" size="sm" onClick={onOpenMcp}>
                <Trans>Tool access</Trans>
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {state.authorizationResult === "authorization_not_requested" ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Browser authorization was not requested.</Trans>
        </p>
      ) : null}
      {state.phase === "unknown" ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Could not confirm connection changes.</Trans>
        </p>
      ) : null}
      {state.phase === "authorization_pending" ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Could not confirm sign-in. Check status or try again.</Trans>
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not update this connection.</Trans>
        </p>
      ) : null}
      {state.phase === "authorizing" ? (
        <p role="status" className="text-sm">
          <Trans>Connecting…</Trans>
        </p>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || busy}
        onClick={() => void manager.current?.refresh()}
      >
        <Trans>Check status</Trans>
      </Button>
    </section>
  );
}
