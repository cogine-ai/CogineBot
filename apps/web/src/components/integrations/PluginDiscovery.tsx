import { Trans, useLingui } from "@lingui/react/macro";
import type { PluginDiscoveryState } from "@rakazo/core";
import { createPluginDiscovery, initialPluginDiscovery } from "@rakazo/core";
import { Button, Input } from "@rakazo/ui-web";
import { useLayoutEffect, useRef, useState } from "react";
import type { RpcRecoveryScope } from "../../lib/rpc";
import { createSpaceRpc, isRpcRecoveryScopeCurrent } from "../../lib/rpc";

export function PluginDiscovery({
  scope,
  disabled,
  onPreview,
}: {
  scope: RpcRecoveryScope;
  disabled: boolean;
  onPreview(source: string): void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<PluginDiscoveryState>(initialPluginDiscovery);
  const manager = useRef<ReturnType<typeof createPluginDiscovery> | null>(null);
  useLayoutEffect(() => {
    let active = true;
    const isCurrent = () => active && isRpcRecoveryScopeCurrent(scope);
    const client = createSpaceRpc(scope.spaceId, isCurrent);
    const discovery = createPluginDiscovery({
      search: (input, signal) => client.plugins.search(input, { signal }),
      isCurrent,
      changed: setState,
    });
    manager.current = discovery;
    return () => {
      active = false;
      discovery.dispose();
      manager.current = null;
    };
  }, [scope]);
  const loading = state.phase === "loading" || state.phase === "loading_more";
  return (
    <section
      aria-label={t`Discover plugins`}
      data-testid="plugin-discovery"
      className="space-y-3 border-b pb-4"
    >
      <h3 className="text-sm font-medium">
        <Trans>Discover plugins</Trans>
      </h3>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void manager.current?.search(query.trim());
        }}
      >
        <Input
          aria-label={t`Search plugins`}
          placeholder={t`Search plugins`}
          value={query}
          maxLength={200}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 basis-56"
        />
        <Button type="submit" variant="outline" disabled={disabled || loading}>
          <Trans>Search</Trans>
        </Button>
      </form>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Searching…</Trans>
        </p>
      ) : null}
      {state.error || state.unavailableRegistries.length ? (
        <div role="alert" className="space-y-2 text-sm text-muted-foreground">
          <p>
            <Trans>Some registries are unavailable.</Trans>
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || loading}
            onClick={() => void manager.current?.search(state.query)}
          >
            <Trans>Retry search</Trans>
          </Button>
        </div>
      ) : null}
      {state.phase === "ready" &&
      !state.entries.length &&
      state.unavailableRegistries.length === 0 &&
      state.error === null ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No plugins found</Trans>
        </p>
      ) : null}
      {state.entries.length ? (
        <>
          <p className="text-xs text-muted-foreground">
            <Trans>
              Registry listings are discovery hints. Review the exact version before installing.
            </Trans>
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {state.entries.map((entry) => (
              <div key={entry.id} className="min-w-0 space-y-2 rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2">
                  <h4 className="break-words text-sm font-medium">{entry.name}</h4>
                  <span className="text-xs text-muted-foreground">{entry.registry}</span>
                </div>
                <p className="break-words text-sm text-muted-foreground">{entry.description}</p>
                <p className="break-all text-xs text-muted-foreground">{entry.source}</p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => onPreview(entry.source)}
                  aria-label={t`Preview ${entry.name}`}
                >
                  <Trans>Preview</Trans>
                </Button>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {state.nextCursor ? (
        <Button
          variant="ghost"
          disabled={disabled || loading}
          onClick={() => void manager.current?.loadMore()}
        >
          <Trans>Show more</Trans>
        </Button>
      ) : null}
    </section>
  );
}
