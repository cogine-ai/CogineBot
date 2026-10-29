import { Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus, SpaceNavigation } from "@rakazo/contracts";
import type { AccessRecoveryState } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BILLING_REQUEST_TIMEOUT_MS, formatBillingPrice } from "../lib/billing";
import type { RpcClient } from "../lib/rpc";
import { clearSpaceSelection, createSpaceRpc, selectSpace } from "../lib/rpc";
import { useSignOut } from "../lib/sign-out";
import { AuthFrame, submitClass } from "./Auth";

export function PaywallPage({
  status,
  client,
  isCurrent,
  onRetry,
  onDismiss,
  recovery,
  refreshFailed,
}: {
  status: BillingStatus;
  client: RpcClient;
  isCurrent: () => boolean;
  onRetry: () => void;
  onDismiss: () => void;
  recovery: AccessRecoveryState | null;
  refreshFailed: boolean;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && isCurrent();
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [spaces, setSpaces] = useState<SpaceNavigation["spaces"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { signingOut, logOut } = useSignOut(
    () => {
      clearSpaceSelection();
      navigate("/sign-in", { replace: true });
    },
    setError,
    current,
  );
  const showPortal =
    status.canManage &&
    status.hasCustomer &&
    (status.state === "past_due" || status.state === "incomplete" || status.state === "canceled");

  async function open(target: "checkout" | "portal") {
    if (busy.current || signingOut || !current()) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const { url } = await (target === "checkout"
        ? client.billing.checkout(undefined, {
            signal: AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS),
          })
        : client.billing.portal(undefined, {
            signal: AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS),
          }));
      if (current()) window.location.assign(url);
    } catch {
      if (current()) setError(t`Could not open billing`);
    } finally {
      // Desktop opens the URL in the system browser and this page stays, so re-enable.
      busy.current = false;
      if (current()) setPending(false);
    }
  }

  function logout() {
    if (busy.current || !current()) return;
    busy.current = true;
    setPending(true);
    void logOut().finally(() => {
      busy.current = false;
      if (current()) setPending(false);
    });
  }

  const trialDays = status.trialDays;
  const included = [
    t`Bots with their own computer and browser`,
    t`Routines that run while you're away`,
    t`Any model, with your own key`,
    t`Web, desktop and mobile apps`,
  ];
  const title =
    status.canManage && status.price
      ? formatBillingPrice(status.price, i18n.locale || "en")
      : t`Subscription required`;

  return (
    <AuthFrame
      title={title}
      onSubmit={(event) => {
        event.preventDefault();
        if (status.canManage && status.price) void open("checkout");
      }}
    >
      <div data-testid="billing-paywall" className="flex w-full flex-col items-center">
        {refreshFailed ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {recovery === "space_forbidden" ? (
              <Trans>This Space is unavailable</Trans>
            ) : recovery === "session_expired" ? (
              <Trans>Sign in again</Trans>
            ) : (
              <Trans>Could not refresh billing</Trans>
            )}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mb-3 w-full text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {status.canManage ? (
          <ul className="mb-9 flex flex-col gap-3 text-base">
            {included.map((item) => (
              <li key={item} className="flex items-center gap-3">
                <Check aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                {item}
              </li>
            ))}
          </ul>
        ) : null}
        {status.canManage && status.price ? (
          <Button type="submit" size="lg" disabled={pending || signingOut} className={submitClass}>
            {status.trialAvailable ? (
              <Trans>Start {trialDays}-day free trial</Trans>
            ) : (
              <Trans>Subscribe</Trans>
            )}
          </Button>
        ) : null}
        {!status.canManage ? (
          <p className="mb-4 text-sm text-muted-foreground">
            <Trans>Contact your organization owner</Trans>
          </p>
        ) : null}
        {refreshFailed || (status.canManage && !status.price) ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending || signingOut}
            onClick={onRetry}
          >
            <Trans>Retry</Trans>
          </Button>
        ) : null}
        {recovery === "session_expired" ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending || signingOut}
            onClick={logout}
          >
            <Trans>Sign in</Trans>
          </Button>
        ) : null}
        {showPortal ? (
          <Button
            type="button"
            size="lg"
            variant="secondary"
            disabled={pending || signingOut}
            className={submitClass}
            onClick={() => void open("portal")}
          >
            <Trans>Manage billing</Trans>
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          disabled={pending || signingOut}
          onClick={() => {
            if (busy.current || !current()) return;
            busy.current = true;
            setPending(true);
            setError(null);
            void createSpaceRpc(null, current)
              .spaces.list(undefined, {
                signal: AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS),
              })
              .then((navigation) => {
                if (current()) setSpaces(navigation.spaces);
              })
              .catch(() => {
                if (current()) setError(t`Could not load Spaces`);
              })
              .finally(() => {
                busy.current = false;
                if (current()) setPending(false);
              });
          }}
        >
          <Trans>Switch Space</Trans>
        </Button>
        {spaces ? (
          <fieldset className="flex w-full flex-col gap-2" aria-label={t`Spaces`}>
            {spaces.map((space) => (
              <Button
                key={space.id}
                type="button"
                variant="secondary"
                disabled={pending || signingOut}
                onClick={() => {
                  if (current() && selectSpace(space.id)) window.location.assign("/app");
                }}
              >
                {space.name}
              </Button>
            ))}
          </fieldset>
        ) : null}
        <Button type="button" variant="ghost" disabled={pending || signingOut} onClick={onDismiss}>
          <Trans>Back to chats</Trans>
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="mt-6 text-muted-foreground"
          disabled={pending || signingOut}
          onClick={logout}
        >
          <Trans>Log out</Trans>
        </Button>
      </div>
    </AuthFrame>
  );
}

/** A failed post-denial lookup has no trustworthy owner, price or subscription snapshot. */
export function BillingUnavailablePage({
  isCurrent,
  onRetry,
  onDismiss,
  recovery,
}: {
  isCurrent: () => boolean;
  onRetry: () => void;
  onDismiss: () => void;
  recovery: AccessRecoveryState | null;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && isCurrent();
  const { t } = useLingui();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const { signingOut, logOut } = useSignOut(
    () => {
      clearSpaceSelection();
      navigate("/sign-in", { replace: true });
    },
    setError,
    current,
  );
  const title =
    recovery === "session_expired"
      ? t`Sign in again`
      : recovery === "space_forbidden"
        ? t`This Space is unavailable`
        : t`Could not refresh billing`;
  return (
    <AuthFrame
      title={title}
      onSubmit={(event) => {
        event.preventDefault();
        if (current()) onRetry();
      }}
    >
      <div data-testid="billing-unavailable" className="flex w-full flex-col gap-3">
        {recovery === "space_forbidden" ? (
          <p>
            <Trans>Contact your organization owner for an invitation</Trans>
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <Button type="submit" disabled={signingOut}>
          <Trans>Retry</Trans>
        </Button>
        {recovery === "session_expired" ? (
          <Button type="button" disabled={signingOut} onClick={() => void logOut()}>
            <Trans>Sign in</Trans>
          </Button>
        ) : null}
        {recovery === "space_forbidden" ? (
          <Button
            type="button"
            disabled={signingOut}
            onClick={() => {
              if (current()) {
                clearSpaceSelection();
                window.location.assign("/app");
              }
            }}
          >
            <Trans>Switch Space</Trans>
          </Button>
        ) : null}
        <Button type="button" variant="ghost" disabled={signingOut} onClick={onDismiss}>
          <Trans>Back to chats</Trans>
        </Button>
      </div>
    </AuthFrame>
  );
}
