import { Trans, useLingui } from "@lingui/react/macro";
import { loadFailureKind } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";

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
        {cached ? (
          <p>
            <Trans>Showing saved chats.</Trans>
          </p>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={kind === "auth" ? onSignIn : kind === "space" ? onRecoverSpace : onRetry}
      >
        {kind === "auth" ? <Trans>Sign in</Trans> : <Trans>Retry</Trans>}
      </Button>
    </div>
  );
}
