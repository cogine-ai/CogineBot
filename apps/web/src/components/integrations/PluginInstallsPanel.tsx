import { Trans, useLingui } from "@lingui/react/macro";
import type { PluginInstallReceipt } from "@rakazo/contracts";
import type { PluginInstallReview, PluginInstallReviewState } from "@rakazo/core";
import { createPluginInstallReview, initialPluginInstallReview } from "@rakazo/core";
import { Badge, Button, Input } from "@rakazo/ui-web";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { newClientId } from "../../lib/client-id";
import type { RpcRecoveryScope } from "../../lib/rpc";
import {
  createSpaceRpc,
  currentRpcSessionGeneration,
  currentSpaceSelectionGeneration,
  isRpcRecoveryScopeCurrent,
  selectedSpaceId,
  subscribeSelectedSpace,
} from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

export function PluginInstallsPanel({
  ownerKey,
  spaceId,
  onClose,
}: {
  ownerKey: string | null;
  spaceId: string | null;
  onClose(): void;
}) {
  const [, updateSelection] = useState(0);
  useEffect(() => subscribeSelectedSpace(() => updateSelection((value) => value + 1)), []);
  const selected = spaceId ?? selectedSpaceId();
  const sessionGeneration = currentRpcSessionGeneration();
  const selectionGeneration = currentSpaceSelectionGeneration();
  const scope = useMemo<RpcRecoveryScope>(
    () => ({ spaceId: selected, sessionGeneration, selectionGeneration }),
    [selected, sessionGeneration, selectionGeneration],
  );
  if (!ownerKey || !spaceId) return null;
  return (
    <PluginInstallsEditor key={JSON.stringify([ownerKey, scope])} scope={scope} onClose={onClose} />
  );
}

function PluginInstallsEditor({ scope, onClose }: { scope: RpcRecoveryScope; onClose(): void }) {
  const { t } = useLingui();
  const [state, setState] = useState<PluginInstallReviewState>(initialPluginInstallReview);
  const [removal, setRemoval] = useState<PluginInstallReceipt | null>(null);
  const manager = useRef<PluginInstallReview | null>(null);
  useLayoutEffect(() => {
    let active = true;
    const isCurrent = () => active && isRpcRecoveryScopeCurrent(scope);
    const client = createSpaceRpc(scope.spaceId, isCurrent);
    const review = createPluginInstallReview({
      preview: (input, signal) => client.plugins.preview(input, { signal }),
      install: (input, signal) => client.plugins.install(input, { signal }),
      list: (signal) => client.plugins.list(undefined, { signal }),
      uninstall: (input, signal) => client.plugins.uninstall(input, { signal }),
      makeNonce: newClientId,
      isCurrent,
      changed: setState,
    });
    manager.current = review;
    void review.refresh();
    return () => {
      active = false;
      review.dispose();
      if (manager.current === review) manager.current = null;
    };
  }, [scope]);
  const locked =
    state.phase === "installing" || state.phase === "unknown" || Boolean(state.removingId);
  const preview = state.preview;
  const rows = state.installations.filter((row) => row.status !== "removed");
  async function remove(row: PluginInstallReceipt) {
    setRemoval(null);
    await manager.current?.uninstall(row);
  }
  return (
    <section
      data-testid="github-plugin-installs"
      aria-label={t`GitHub plugins`}
      className="space-y-5 rounded-xl border p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">
          <Trans>GitHub plugins</Trans>
        </h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <Trans>Close</Trans>
        </Button>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void manager.current?.preview(state.source.trim());
        }}
      >
        <Input
          className="min-w-0 flex-1 basis-56"
          aria-label={t`Plugin GitHub URL`}
          placeholder="https://github.com/owner/plugin"
          value={state.source}
          maxLength={2048}
          disabled={locked}
          onChange={(event) => manager.current?.changeSource(event.target.value)}
          required
        />
        <Button
          type="submit"
          variant="outline"
          disabled={locked || state.phase === "previewing" || !state.source.trim()}
        >
          {state.phase === "previewing" ? <Trans>Previewing…</Trans> : <Trans>Preview</Trans>}
        </Button>
      </form>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(state.error, t`Could not complete this request.`)}
        </p>
      ) : null}
      {preview ? (
        <section data-testid="plugin-preview" className="space-y-4">
          <div>
            <h3 className="break-words font-semibold">{preview.name}</h3>
            <p className="text-sm text-muted-foreground">{preview.description}</p>
          </div>
          <p className="break-all text-xs text-muted-foreground">{preview.source}</p>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              <Trans>Version details</Trans>
            </summary>
            <p className="mt-2 break-all font-mono">{preview.sourceSha}</p>
            <p className="break-all font-mono">{preview.digest}</p>
          </details>
          {preview.skills.length ? (
            <section className="space-y-2">
              <h4 className="text-sm font-medium">
                <Trans>Skills</Trans>
              </h4>
              {preview.skills.map((skill) => (
                <div key={skill.name} className="min-w-0">
                  <p className="break-words text-sm font-medium">{skill.name}</p>
                  <p className="text-sm text-muted-foreground">{skill.description}</p>
                  <details className="mt-1 text-sm">
                    <summary className="cursor-pointer text-muted-foreground">
                      <Trans>View instructions</Trans>
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
                      {skill.content}
                    </pre>
                  </details>
                </div>
              ))}
            </section>
          ) : null}
          {preview.mcpServers.length ? (
            <section className="space-y-2">
              <h4 className="text-sm font-medium">
                <Trans>MCP servers</Trans>
              </h4>
              {preview.mcpServers.map((server) => (
                <div key={server.name}>
                  <p className="text-sm font-medium">{server.name}</p>
                  <p className="break-all text-xs text-muted-foreground">{server.endpoint}</p>
                  {server.headerKeys.length ? (
                    <p className="break-all text-xs text-muted-foreground">
                      {server.headerKeys.join(", ")}
                    </p>
                  ) : null}
                </div>
              ))}
              <p className="text-sm text-muted-foreground">
                <Trans>MCP tools require separate approval.</Trans>
              </p>
            </section>
          ) : null}
          {preview.skipped.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                <Trans>Skipped components</Trans> ({preview.skipped.length})
              </summary>
              <ul className="mt-2 space-y-2">
                {preview.skipped.map((item, index) => (
                  <li key={`${item.kind}:${item.name}:${index}`} className="break-words">
                    <span className="font-medium">{item.name}</span>: {item.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {state.phase === "review" ? (
            <div className="space-y-3 border-t pt-3">
              {preview.skills.length ? (
                <p className="text-sm text-muted-foreground">
                  <Trans>Skills are available to your Bots in this Space.</Trans>
                </p>
              ) : null}
              <Button
                onClick={() => void manager.current?.install()}
                disabled={!preview.skills.length && !preview.mcpServers.length}
              >
                <Trans>Install plugin</Trans>
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
      {state.phase === "installing" ? (
        <p role="status" className="text-sm">
          <Trans>Installing…</Trans>
        </p>
      ) : null}
      {state.phase === "unknown" ? (
        <div className="space-y-2">
          <p role="status" className="text-sm">
            {state.receipt?.status === "installing" ? (
              <Trans>Installation pending.</Trans>
            ) : (
              <Trans>Could not confirm installation.</Trans>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void manager.current?.check()}
              disabled={state.loading}
            >
              <Trans>Check status</Trans>
            </Button>
            {state.retryChecked ? (
              <Button variant="outline" onClick={() => void manager.current?.install()}>
                <Trans>Retry</Trans>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {state.phase === "terminal" && state.receipt?.status === "removed" ? (
        <p role="status" className="text-sm">
          <Trans>This installation was removed.</Trans>
        </p>
      ) : null}
      {state.phase === "terminal" && state.receipt?.status === "failed" ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            <Trans>Installation failed.</Trans>
          </p>
          <Button
            variant="outline"
            onClick={() => void manager.current?.preview(state.source.trim())}
          >
            <Trans>Preview again</Trans>
          </Button>
        </div>
      ) : null}
      <section className="space-y-3 border-t pt-4" aria-label={t`Plugin installations`}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">
            <Trans>Plugin installations</Trans>
          </h3>
          <Button
            variant="ghost"
            size="sm"
            disabled={state.loading || Boolean(state.removingId)}
            onClick={() => void manager.current?.refresh()}
          >
            <Trans>Refresh</Trans>
          </Button>
        </div>
        {state.listError ? (
          <p role="alert" className="text-sm text-destructive">
            <Trans>Could not load installed plugins.</Trans>
          </p>
        ) : null}
        {state.removalUnknownId ? (
          <p role="status" className="text-sm">
            <Trans>Could not confirm removal. Refresh before retrying.</Trans>
          </p>
        ) : null}
        {!state.loading && !state.listError && !rows.length ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No plugins installed</Trans>
          </p>
        ) : null}
        {rows.map((row) => (
          <article
            key={row.id}
            className="min-w-0 space-y-2 rounded-lg border p-3"
            aria-label={row.name}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-medium">{row.name}</h4>
              <Badge>
                {row.status === "cleanup_failed" ? (
                  <Trans>Cleanup incomplete</Trans>
                ) : row.status === "uninstalling" ? (
                  <Trans>Removing…</Trans>
                ) : row.status === "installing" ? (
                  <Trans>Installation pending.</Trans>
                ) : row.status === "failed" ? (
                  <Trans>Installation failed.</Trans>
                ) : (
                  <Trans>Installed</Trans>
                )}
              </Badge>
            </div>
            {Object.hasOwn(state.installationOwners, row.id) ? (
              <PluginInstallationOwner ownerName={state.installationOwners[row.id] ?? null} />
            ) : null}
            <p className="break-all text-xs text-muted-foreground">{row.source}</p>
            {row.mcpServers.map((server) => (
              <p key={server.id} className="break-all text-xs text-muted-foreground">
                {server.name} · {server.endpoint}
              </p>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!manager.current?.canUninstall(removal?.id === row.id ? removal : row)}
                onClick={() =>
                  row.status === "cleanup_failed" ||
                  row.status === "uninstalling" ||
                  removal?.id === row.id
                    ? void remove(removal?.id === row.id ? removal : row)
                    : setRemoval(row)
                }
              >
                {state.removingId === row.id ? (
                  <Trans>Removing…</Trans>
                ) : row.status === "cleanup_failed" || row.status === "uninstalling" ? (
                  <Trans>Retry cleanup</Trans>
                ) : removal?.id === row.id ? (
                  <Trans>Confirm removal</Trans>
                ) : (
                  <Trans>Remove plugin</Trans>
                )}
              </Button>
              {removal?.id === row.id ? (
                <Button variant="ghost" size="sm" onClick={() => setRemoval(null)}>
                  <Trans>Cancel</Trans>
                </Button>
              ) : null}
            </div>
          </article>
        ))}
      </section>
    </section>
  );
}

function PluginInstallationOwner({ ownerName }: { ownerName: string | null }) {
  const { t } = useLingui();
  const name = ownerName ?? t`Another member`;
  return (
    <p className="break-words text-xs text-muted-foreground">
      <Trans>Installed by {name}</Trans>
    </p>
  );
}
