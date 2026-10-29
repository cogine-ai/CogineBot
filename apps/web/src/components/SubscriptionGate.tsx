import { useLingui } from "@lingui/react/macro";
import { coverReplyAnnouncements } from "@rakazo/chat-ui/announcement-visibility";
import type { BillingStatus, Me } from "@rakazo/contracts";
import { accessRecoveryState } from "@rakazo/core";
import { Dialog, DialogContent } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { lazy, Suspense, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { BILLING_REQUEST_TIMEOUT_MS } from "../lib/billing";
import { peekInitialBootstrap } from "../lib/bootstrap";
import {
  createSpaceRpc,
  currentRpcSessionGeneration,
  currentSpaceSelectionGeneration,
  rememberImplicitRpcSpace,
  selectedSpaceId,
  subscribeSelectedSpace,
  subscribeSubscriptionRequired,
} from "../lib/rpc";

const PaywallPage = lazy(() =>
  import("../pages/Paywall").then((module) => ({ default: module.PaywallPage })),
);
const BillingUnavailablePage = lazy(() =>
  import("../pages/Paywall").then((module) => ({ default: module.BillingUnavailablePage })),
);

type GateState =
  | { kind: "loading" }
  | { kind: "open" }
  | { kind: "recovery"; failed: boolean }
  | { kind: "paywall"; status: BillingStatus };

function gateFor(status: BillingStatus): GateState {
  return status.access ? { kind: "open" } : { kind: "paywall", status };
}

/** Optional billing is a UI projection; the server admits new work. */
export function SubscriptionGate({
  children,
  fallback,
  userId,
}: {
  children: ReactNode;
  fallback: ReactNode;
  userId: string;
}) {
  const { t } = useLingui();
  const generation = useSyncExternalStore(
    subscribeSelectedSpace,
    currentSpaceSelectionGeneration,
    currentSpaceSelectionGeneration,
  );
  const [state, setState] = useState<GateState>({ kind: "loading" });
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [dismissed, setDismissed] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [recheck, setRecheck] = useState<(() => Promise<void>) | null>(null);
  const [client, setClient] = useState<ReturnType<typeof createSpaceRpc> | null>(null);
  const [isCurrent, setIsCurrent] = useState<(() => boolean) | null>(null);

  useEffect(() => {
    let active = true;
    let inFlight: Promise<void> | undefined;
    let bills: boolean | undefined;
    let denied = false;
    const spaceId = selectedSpaceId();
    const sessionGeneration = currentRpcSessionGeneration();
    const current = () =>
      active &&
      generation === currentSpaceSelectionGeneration() &&
      sessionGeneration === currentRpcSessionGeneration() &&
      spaceId === selectedSpaceId();
    const scoped = createSpaceRpc(spaceId, current);
    setClient(() => scoped);
    setIsCurrent(() => current);
    setState({ kind: "loading" });
    setRefreshError(null);
    setDismissed(false);
    setHasOpened(false);

    async function me(): Promise<Me> {
      const primed = peekInitialBootstrap();
      if (primed) {
        try {
          const { me } = await primed;
          if (me.userId === userId && (!spaceId || me.spaceId === spaceId)) return me;
        } catch {
          // The speculative read may belong to the preceding session or fail independently.
        }
      }
      return scoped.me(undefined, { signal: AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS) });
    }

    function refresh(initial = false): Promise<void> {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          if (bills === undefined) {
            const capabilities = await fetchAuthCapabilities();
            if (!current()) return;
            if (capabilities.billing) {
              const identity = await me();
              if (!current()) return;
              if (spaceId === null && identity.userId === userId)
                rememberImplicitRpcSpace(identity.spaceId, sessionGeneration, generation);
              bills = identity.billingEnabled;
            } else bills = false;
          }
          if (!current()) return;
          if (!bills) {
            setState({ kind: "open" });
            setHasOpened(true);
            return;
          }
          const status = await scoped.billing.status(initial ? undefined : { refresh: true }, {
            signal: AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS),
          });
          if (current()) {
            setRefreshError(null);
            denied = !status.access;
            if (status.access) setHasOpened(true);
            setState(gateFor(status));
          }
        } catch (error) {
          if (!current()) return;
          // Initial lookup failure still enters the app; API admission is authoritative.
          if (initial) {
            setState({ kind: "open" });
            setHasOpened(true);
          } else {
            setRefreshError(error);
            if (denied)
              setState((previous) =>
                previous.kind === "paywall" ? previous : { kind: "recovery", failed: true },
              );
          }
        }
      })().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    }
    setRecheck(() => () => refresh());
    void refresh(true);
    const recheckVisible = () => {
      if (denied && document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", recheckVisible);
    document.addEventListener("visibilitychange", recheckVisible);
    const stopDenied = subscribeSubscriptionRequired(() => {
      if (!current()) return;
      setDismissed(false);
      denied = true;
      setState((previous) =>
        previous.kind === "paywall" ? previous : { kind: "recovery", failed: false },
      );
      void refresh();
    });
    return () => {
      active = false;
      stopDenied();
      window.removeEventListener("focus", recheckVisible);
      document.removeEventListener("visibilitychange", recheckVisible);
    };
  }, [generation, userId]);

  const showPaywall =
    (state.kind === "paywall" || state.kind === "recovery") && !dismissed && client && isCurrent;
  const covered = Boolean(showPaywall);
  useLayoutEffect(() => (covered ? coverReplyAnnouncements() : undefined), [covered]);
  const dismiss = () => {
    setDismissed(true);
    setHasOpened(true);
  };
  const paywall = showPaywall ? (
    <Suspense fallback={fallback}>
      {state.kind === "paywall" ? (
        <PaywallPage
          status={state.status}
          client={client}
          isCurrent={isCurrent}
          onRetry={() => void recheck?.()}
          onDismiss={dismiss}
          recovery={accessRecoveryState(refreshError)}
          refreshFailed={refreshError !== null}
        />
      ) : state.failed ? (
        <BillingUnavailablePage
          isCurrent={isCurrent}
          onRetry={() => void recheck?.()}
          onDismiss={dismiss}
          recovery={accessRecoveryState(refreshError)}
        />
      ) : (
        fallback
      )}
    </Suspense>
  ) : null;
  if (!hasOpened) return paywall ?? fallback;
  return (
    <>
      {children}
      <Dialog
        open={Boolean(showPaywall)}
        onOpenChange={(open) => {
          if (!open) setDismissed(true);
        }}
      >
        <DialogContent
          aria-label={t`Billing`}
          aria-describedby={undefined}
          showCloseButton={false}
          className="h-full max-h-full w-full max-w-full rounded-none border-0 p-0 sm:max-w-full"
        >
          {paywall}
        </DialogContent>
      </Dialog>
    </>
  );
}
