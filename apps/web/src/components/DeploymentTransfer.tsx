import { Trans, useLingui } from "@lingui/react/macro";
import type { DeploymentTransferReason, DeploymentTransferStatus } from "@rakazo/contracts";
import type { DeploymentTransfer, DeploymentTransferState } from "@rakazo/core";
import { initialDeploymentTransferState } from "@rakazo/core";
import { Button, Input, Switch } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createWebDeploymentTransfer,
  rememberTransferAddress,
  sourceTransferPageUrl,
  transferStatusPath,
} from "../lib/deployment-transfer-client";

export function useTransferCopy() {
  const { t } = useLingui();
  return {
    phase: (phase: DeploymentTransferStatus["phase"]) =>
      ({
        created: t`Waiting for the source`,
        draft: t`Choose credentials`,
        proposed: t`Waiting for the target`,
        previewed: t`Review transfer`,
        approved: t`Waiting for the source`,
        grant_pending: t`Waiting for the source`,
        ready: t`Ready to copy`,
        transferring: t`Copying…`,
        unknown: t`Status not confirmed`,
        completed: t({ id: "deployment-transfer.copied", message: "Copied" }),
        partial: t`Partially copied`,
        failed: t`Could not copy`,
        cancelled: t({ id: "deployment-transfer.stopped", message: "Stopped" }),
        expired: t`Expired`,
      })[phase],
    reason: (reason: DeploymentTransferReason) => {
      switch (reason) {
        case "source_resource_shared":
        case "resource_unknown":
          return t`Target retained to protect the source.`;
        case "source_changed":
        case "target_changed":
        case "destination_conflict":
          return t`Changed since review.`;
        case "oauth_reauthorization":
          return t`Authorize again at the destination.`;
        case "login_password_only":
          return t`Extra sign-in methods stay at the source.`;
        case "unsupported_kind":
          return t`This credential type stays at the source.`;
        case "restore":
          return t`Write authorization expired. Existing results can still be checked.`;
        case "target_kept":
          return t`Kept target`;
        case "expired":
          return t`Expired`;
        case "cancelled":
          return t({ id: "deployment-transfer.stopped", message: "Stopped" });
        case "access_changed":
          return t`Access changed`;
        case "credential_limit":
          return t`Credential limit reached`;
        case "invalid_credential":
          return t`Unsupported credential`;
        case "removed":
          return t`Removed`;
        case "write_unknown":
        case "peer_unavailable":
          return t`Check status before continuing.`;
      }
    },
    item: (status: DeploymentTransferStatus["items"][number]["status"]) =>
      ({
        pending: t`Pending`,
        sending: t`Copying…`,
        unknown: t`Status not confirmed`,
        copied: t({ id: "deployment-transfer.copied", message: "Copied" }),
        kept: t`Kept target`,
        conflict: t`Changed since review.`,
        skipped: t`Skipped`,
        failed: t`Could not copy`,
        cancelled: t({ id: "deployment-transfer.stopped", message: "Stopped" }),
        expired: t`Expired`,
        removed: t`Removed`,
      })[status],
  };
}

function TransferIdentity({ snapshot }: { snapshot: DeploymentTransferStatus }) {
  return (
    <div className="space-y-3 text-sm" data-testid="transfer-identities">
      {(["source", "target"] as const).map((side) => {
        const identity = snapshot[side];
        if (!identity) return null;
        return (
          <div key={side} className="min-w-0 space-y-1">
            <p className="font-medium">
              {side === "source" ? <Trans>Source</Trans> : <Trans>Target</Trans>}
            </p>
            <p className="break-all">{identity.origin}</p>
            <p className="text-xs text-muted-foreground">
              <Trans>Fingerprint</Trans>
            </p>
            <code className="block break-all text-xs text-muted-foreground">
              {identity.fingerprint}
            </code>
          </div>
        );
      })}
      {snapshot.plan ? (
        <div className="space-y-2 rounded-lg border p-3" data-testid="transfer-owner-mapping">
          <p className="break-words">
            {snapshot.plan.sourceOwnerName} · {snapshot.plan.sourceSpaceName} ·{" "}
            {snapshot.plan.sourceBotName}
          </p>
          <p className="break-words">
            → {snapshot.plan.targetOwnerName} · {snapshot.plan.targetSpaceName} ·{" "}
            {snapshot.plan.targetBotName}
          </p>
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              <Trans>Account mapping</Trans>
            </summary>
            <code className="block break-all text-xs">
              {snapshot.plan.sourceScope.userId} · {snapshot.plan.sourceScope.spaceId}
              <br />→ {snapshot.plan.targetScope.userId} · {snapshot.plan.targetScope.spaceId}
            </code>
          </details>
        </div>
      ) : null}
    </div>
  );
}

export function DeploymentTransferReview({
  state,
  manager,
}: {
  state: DeploymentTransferState;
  manager: DeploymentTransfer | null;
}) {
  const { t } = useLingui();
  const copy = useTransferCopy();
  const ids = useId();
  const [stopping, setStopping] = useState<string | null>(null);
  const snapshot = state.snapshot;
  const current = useRef({ snapshot, manager });
  current.current = { snapshot, manager };
  const busy = ["saving", "loading", "checking"].includes(state.request);
  const locked = busy || state.request === "unknown";
  const sourcePage = snapshot ? sourceTransferPageUrl(snapshot) : null;
  const canStop =
    snapshot &&
    snapshot.phase !== "completed" &&
    snapshot.writeRevokedReason !== "restore" &&
    (!["cancelled", "expired"].includes(snapshot.phase) ||
      snapshot.items.some((item) => item.status === "unknown"));
  return (
    <section className="min-w-0 space-y-4" data-testid="deployment-transfer-review">
      {state.error === "not_found" ? (
        <p role="alert">
          <Trans>
            No receipt yet. Check status or reopen pairing from the receiving deployment.
          </Trans>
        </p>
      ) : state.error === "invalid_origin" ? (
        <p role="alert">
          <Trans>Choose an HTTPS deployment origin.</Trans>
        </p>
      ) : state.error ? (
        <p role="alert">
          <Trans>Could not confirm the result. Check status before continuing.</Trans>
        </p>
      ) : null}
      {snapshot ? (
        <>
          <h2 className="font-medium">
            {state.request === "unknown" ? t`Status not confirmed` : copy.phase(snapshot.phase)}
          </h2>
          {snapshot.writeRevokedReason === "restore" ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Write authorization expired. Existing results can still be checked.</Trans>
            </p>
          ) : null}
          <TransferIdentity snapshot={snapshot} />
          <p className="text-xs text-muted-foreground">
            <Trans>Expires</Trans>{" "}
            <time dateTime={snapshot.expiresAt}>
              {new Date(snapshot.expiresAt).toLocaleString()}
            </time>
          </p>
          {sourcePage && snapshot.phase === "created" ? (
            <div className="space-y-1">
              <p className="break-all text-sm">{new URL(sourcePage).origin}</p>
              <a
                className="inline-block break-all underline"
                href={sourcePage}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Trans>Open source deployment</Trans>
              </a>
            </div>
          ) : null}
          {snapshot.side === "source" && snapshot.phase === "draft" ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                <Trans>
                  OAuth needs authorization at the target. TOTP and 1Password tokens stay at the
                  source.
                </Trans>
              </p>
              {snapshot.candidates.map((item, index) => (
                <label
                  key={item.itemKey}
                  htmlFor={`${ids}-select-${index}`}
                  className="flex min-w-0 items-center justify-between gap-3"
                >
                  <span className="min-w-0">
                    <span className="block break-words">{item.name}</span>
                    <span className="block break-all text-xs text-muted-foreground">
                      {item.origin}
                    </span>
                  </span>
                  <Switch
                    id={`${ids}-select-${index}`}
                    aria-label={t`Select ${item.name}`}
                    checked={state.selected.includes(item.itemKey)}
                    disabled={locked}
                    onCheckedChange={(checked) => manager?.select(item.itemKey, checked)}
                  />
                </label>
              ))}
              <Button
                disabled={locked || !state.selected.length}
                onClick={() => void manager?.propose()}
              >
                <Trans>Send selection for approval</Trans>
              </Button>
            </div>
          ) : null}
          {snapshot.plan ? (
            <div className="space-y-3" data-testid="transfer-plan">
              <p className="text-sm">
                <Trans>To copy</Trans>:{" "}
                {snapshot.plan.items.filter((item) => item.action !== "keep").length} ·{" "}
                <Trans>Kept target</Trans>:{" "}
                {snapshot.plan.items.filter((item) => item.action === "keep").length}
              </p>
              {snapshot.plan.items.map((item, index) => (
                <div key={item.source.itemKey} className="min-w-0 space-y-1 rounded-lg border p-3">
                  <p className="break-words font-medium">{item.source.name}</p>
                  <p className="break-all text-xs text-muted-foreground">{item.source.origin}</p>
                  {item.source.auth.type === "basic" ? (
                    <p className="break-all text-xs">{item.source.auth.username}</p>
                  ) : null}
                  {snapshot.side === "target" &&
                  snapshot.phase === "previewed" &&
                  item.canOverwrite ? (
                    <label
                      htmlFor={`${ids}-replace-${index}`}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span>
                        <Trans>Replace target</Trans>
                      </span>
                      <Switch
                        id={`${ids}-replace-${index}`}
                        aria-label={t`Replace ${item.source.name}`}
                        checked={state.decisions[item.source.itemKey] === "overwrite"}
                        disabled={locked}
                        onCheckedChange={(checked) =>
                          manager?.decide(item.source.itemKey, checked ? "overwrite" : "keep")
                        }
                      />
                    </label>
                  ) : (
                    <p className="text-sm">
                      {item.action === "keep"
                        ? t`Kept target`
                        : item.action === "overwrite"
                          ? t`Replace target`
                          : t`Copy`}
                    </p>
                  )}
                  {item.reason ? (
                    <p className="text-xs text-muted-foreground">{copy.reason(item.reason)}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {snapshot.side === "target" && ["proposed", "previewed"].includes(snapshot.phase) ? (
            <Button
              variant="secondary"
              disabled={locked}
              onClick={() => void manager?.previewTarget()}
            >
              {state.dirty ? <Trans>Update review</Trans> : <Trans>Review selection</Trans>}
            </Button>
          ) : null}
          {snapshot.side === "target" && snapshot.canApprove ? (
            <Button disabled={locked || state.dirty} onClick={() => void manager?.approve()}>
              <Trans>Approve this transfer</Trans>
            </Button>
          ) : null}
          {snapshot.side === "source" && (snapshot.canCommit || snapshot.canRecover) ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                <Trans>Source credentials stay in place. Received items cannot be recalled.</Trans>
              </p>
              <Button disabled={locked} onClick={() => void manager?.confirmCopy()}>
                {snapshot.canRecover ? (
                  <Trans>Continue this transfer</Trans>
                ) : (
                  <Trans>Copy approved credentials</Trans>
                )}
              </Button>
            </div>
          ) : null}
          {snapshot.items.length ? (
            <ul className="space-y-2" data-testid="transfer-receipts">
              {snapshot.items.map((item) => (
                <li key={item.itemKey} className="min-w-0 rounded-lg border p-3">
                  <p className="break-words">
                    {item.name} · {copy.item(item.status)}
                  </p>
                  {item.reason ? (
                    <p className="text-xs text-muted-foreground">{copy.reason(item.reason)}</p>
                  ) : null}
                  {item.status === "copied" && !item.targetState ? (
                    <p className="text-xs text-muted-foreground">
                      <Trans>Target status not confirmed</Trans>
                    </p>
                  ) : null}
                  {item.status === "copied" &&
                  "targetState" in item &&
                  item.targetState === "modified" ? (
                    <p className="text-xs text-muted-foreground">
                      <Trans>Changed at target</Trans>
                    </p>
                  ) : null}
                  {item.status === "copied" &&
                  "targetState" in item &&
                  item.targetState === "removed" ? (
                    <p className="text-xs text-muted-foreground">
                      <Trans>Removed at target</Trans>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {snapshot.leftOut.length ? (
            <ul className="space-y-2 text-sm" data-testid="transfer-left-out">
              {snapshot.leftOut.map((item, index) => (
                <li key={`${item.name}:${index}`} className="break-words">
                  {item.name} · {copy.reason(item.reason)}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {snapshot || state.recovery ? (
        <Button variant="secondary" disabled={busy} onClick={() => void manager?.checkStatus()}>
          <Trans>Check status</Trans>
        </Button>
      ) : null}
      {canStop ? (
        <div className="space-y-2">
          {stopping === snapshot?.transferId ? (
            <>
              <p className="text-sm text-muted-foreground">
                <Trans>Only unsent items stop. Received items stay at the target.</Trans>
              </p>
              <Button
                variant="destructive"
                onClick={() => {
                  const expected = stopping;
                  setStopping(null);
                  if (expected && current.current.snapshot?.transferId === expected)
                    void current.current.manager?.cancel();
                }}
              >
                <Trans>Stop unsent items</Trans>
              </Button>
              <Button variant="ghost" onClick={() => setStopping(null)}>
                <Trans>Keep going</Trans>
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              onClick={() => {
                if (current.current.snapshot?.transferId === snapshot?.transferId)
                  setStopping(snapshot!.transferId);
              }}
            >
              {snapshot && ["cancelled", "expired"].includes(snapshot.phase) ? (
                <Trans>Retry stopping</Trans>
              ) : (
                <Trans>Stop transfer</Trans>
              )}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function DeploymentTransferTools({
  botId,
  spaceId,
  isCurrent,
}: {
  botId: string;
  spaceId: string;
  isCurrent(): boolean;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [sourceOrigin, setSourceOrigin] = useState("");
  const [state, setState] = useState(initialDeploymentTransferState);
  const manager = useRef<DeploymentTransfer | null>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const connection = createWebDeploymentTransfer({
      spaceId,
      side: "target",
      isCurrent: () => active && isCurrent(),
      changed(next) {
        if (!active) return;
        setState(next);
        const path = rememberTransferAddress(next);
        if (path && next.request !== "saving") navigate(path, { replace: true });
      },
    });
    manager.current = connection.manager;
    setState({ ...initialDeploymentTransferState });
    return () => {
      active = false;
      connection.manager.dispose();
      manager.current = null;
    };
  }, [open, spaceId, isCurrent, navigate]);
  return (
    <section className="mt-4 space-y-3" data-testid="deployment-transfer-tools">
      <Button
        variant="outline"
        disabled={open && state.request === "saving"}
        onClick={() => setOpen(!open)}
      >
        <Trans>Receive passwords and API keys</Trans>
      </Button>
      {open ? (
        <div className="space-y-3">
          <Input
            aria-label={t`Source deployment`}
            placeholder="https://source.example.test"
            value={sourceOrigin}
            onChange={(event) => setSourceOrigin(event.target.value)}
            disabled={state.request !== "idle"}
          />
          <Button
            disabled={!sourceOrigin.trim() || state.request !== "idle" || !manager.current}
            onClick={() => void manager.current?.startReceive(botId, sourceOrigin)}
          >
            <Trans>Create receiver</Trans>
          </Button>
          <DeploymentTransferReview state={state} manager={manager.current} />
          <details
            onToggle={(event) => {
              if (event.currentTarget.open) void manager.current?.loadRecent(botId);
            }}
          >
            <summary className="cursor-pointer text-sm">
              <Trans>Recent transfers</Trans>
            </summary>
            {state.recent.map((entry) => (
              <Button
                key={entry.transferId}
                variant="ghost"
                onClick={() =>
                  navigate(transferStatusPath(entry.side, { transferId: entry.transferId }))
                }
              >
                {entry.side === "source"
                  ? entry.target.origin
                  : (entry.source?.origin ?? entry.target.origin)}
              </Button>
            ))}
          </details>
        </div>
      ) : null}
    </section>
  );
}
