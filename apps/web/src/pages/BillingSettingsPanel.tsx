import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus } from "@rakazo/contracts";
import { Button, Skeleton } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { BILLING_REQUEST_TIMEOUT_MS, formatBillingDate, formatBillingPrice } from "../lib/billing";
import type { RpcClient } from "../lib/rpc";

export function BillingSettingsPanel({
  client,
  isCurrent,
}: {
  client: RpcClient;
  isCurrent: () => boolean;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentPanel = () => mounted.current && isCurrent();
  const { t, i18n } = useLingui();
  const locale = i18n.locale || "en";
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const recheck = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const current = () => active && isCurrent();
    const load = (refresh = false) => {
      if (inFlight || !current() || document.visibilityState === "hidden") return;
      inFlight = true;
      void client.billing
        .status(refresh ? { refresh: true } : undefined, {
          signal: AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS),
        })
        .then((next) => {
          if (current()) {
            setStatus(next);
            setError(null);
          }
        })
        .catch(() => {
          if (current()) setError(t`Could not load billing`);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    recheck.current = () => load(true);
    load();
    const visible = () => load(true);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      recheck.current = () => {};
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [client, isCurrent, t]);

  async function openPortal() {
    if (busy.current || !currentPanel()) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const { url } = await client.billing.portal(undefined, {
        signal: AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS),
      });
      if (currentPanel()) window.location.assign(url);
    } catch {
      if (currentPanel()) setError(t`Could not open billing`);
    } finally {
      // Desktop opens the URL in the system browser and this page stays, so re-enable.
      busy.current = false;
      if (currentPanel()) setPending(false);
    }
  }

  const stateLabel = status
    ? status.state === "trialing"
      ? t`Trial`
      : status.state === "active"
        ? t`Active`
        : status.state === "past_due"
          ? t`Past due`
          : status.state === "canceled"
            ? t`Canceled`
            : t`Inactive`
    : null;

  const date = status ? billingDate(status) : null;
  const day = date ? formatBillingDate(date.at, locale) : "";
  const dateLabel = date
    ? date.kind === "trial"
      ? t`Trial ends ${day}`
      : date.kind === "ends"
        ? t`Ends ${day}`
        : t`Renews ${day}`
    : null;

  const price = status?.price ? formatBillingPrice(status.price, locale) : null;
  const seats = status?.seats ?? 0;

  return (
    <div data-testid="billing-settings" className="rounded-xl border border-border px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {status ? (
            <h3 className="text-[15px] font-medium text-foreground">{stateLabel}</h3>
          ) : error ? null : (
            <Skeleton className="h-5 w-24" />
          )}
          {price ? (
            <p className="mt-3 text-[14px] text-foreground/75">
              {price}
              {seats > 1 ? (
                <>
                  {" · "}
                  <Plural value={seats} one="# seat" other="# seats" />
                </>
              ) : null}
            </p>
          ) : null}
          {dateLabel ? (
            <p className="mt-2 text-[12.5px] text-muted-foreground/80">{dateLabel}</p>
          ) : null}
        </div>
        {status?.canManage && status.hasCustomer ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => void openPortal()}
          >
            <Trans>Manage</Trans>
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" onClick={() => recheck.current()}>
            <Trans>Retry</Trans>
          </Button>
        </p>
      ) : null}
    </div>
  );
}

function billingDate(
  status: BillingStatus,
): { kind: "trial" | "ends" | "renews"; at: string } | null {
  if (status.state === "trialing" && status.trialEndsAt) {
    return { kind: "trial", at: status.trialEndsAt };
  }
  if (!status.currentPeriodEndsAt) return null;
  if (status.cancelAtPeriodEnd || status.state === "canceled") {
    return { kind: "ends", at: status.currentPeriodEndsAt };
  }
  return { kind: "renews", at: status.currentPeriodEndsAt };
}
