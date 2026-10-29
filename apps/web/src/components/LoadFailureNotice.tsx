import { Trans, useLingui } from "@lingui/react/macro";
import { accessRecoveryState, loadFailureKind } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef } from "react";
import { createSpaceRpc, currentSpaceSelectionGeneration, selectedSpaceId } from "../lib/rpc";

export function LoadFailureNotice({
  error,
  cached,
  pending,
  onRetry,
  onSignIn,
  onRecoverSpace,
}: {
  error: unknown;
  cached: boolean;
  pending: boolean;
  onRetry: () => void;
  onSignIn: () => void;
  onRecoverSpace: () => void;
}) {
  const { t } = useLingui();
  const kind = loadFailureKind(error, navigator.onLine);
  const active = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function recover() {
    if (busy.current) return;
    if (kind !== "auth") {
      if (kind === "space") onRecoverSpace();
      else onRetry();
      return;
    }
    busy.current = true;
    const generation = currentSpaceSelectionGeneration();
    const current = () => active.current && generation === currentSpaceSelectionGeneration();
    try {
      if (selectedSpaceId()) {
        try {
          // A missing selected membership also returns401. Probe a read only,
          // never replay the original write in a different Space.
          await createSpaceRpc(null, current).me();
          if (current()) onRecoverSpace();
          return;
        } catch (error) {
          if (!current()) return;
          if (accessRecoveryState(error) !== "session_expired") {
            onRetry();
            return;
          }
        }
      }
      if (current()) onSignIn();
    } finally {
      busy.current = false;
    }
  }
  const message =
    kind === "offline"
      ? t`Could not reach the server`
      : kind === "auth"
        ? t`Sign in again`
        : kind === "space"
          ? t`This Space is unavailable`
          : kind === "server"
            ? t`The server could not complete the request`
            : t`Could not load chats`;
  return (
    <div
      role="status"
      data-testid="load-failure"
      className="flex items-center justify-center gap-3 px-4 py-3 text-[13px] text-muted-foreground"
    >
      <div>
        <p>{message}</p>
        {kind === "space" ? (
          <p>
            <Trans>Contact your organization owner for an invitation</Trans>
          </p>
        ) : null}
        {cached ? (
          <p>
            <Trans>Showing saved chats.</Trans>
          </p>
        ) : null}
      </div>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => void recover()}>
        {kind === "auth" ? (
          <Trans>Sign in</Trans>
        ) : kind === "space" ? (
          <Trans>Switch Space</Trans>
        ) : (
          <Trans>Retry</Trans>
        )}
      </Button>
    </div>
  );
}
