import type { BillingStatus, Me, SpaceNavigation } from "@rakazo/contracts";
import type { AccessRecoveryState } from "@rakazo/core";
import { accessRecoveryState } from "@rakazo/core";
import { usePathname } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Linking, Modal, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  captureApiRequestContext,
  loadSessionToken,
  passwordResetCapabilities,
  rpc,
  selectSpace,
  signOut,
  subscribeSubscriptionRequired,
} from "../lib/api";
import { replaceWithSignIn } from "../lib/auth-routing";
import { formatBillingPrice } from "../lib/billing";
import { useI18n } from "../lib/i18n";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  isMobileSessionCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "../lib/mobile-scope";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { MenuPickerMenu } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";

type RecoveryView = {
  denied: boolean;
  status: BillingStatus | null;
  recovery: AccessRecoveryState | null;
  error: string | null;
  pending: boolean;
  spaces: { id: string; name: string }[];
};

/** Keep the navigator and its unsent editors mounted while access is recovered. */
export function BillingRecovery() {
  const scope = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const pathname = usePathname();
  const enabled = pathname !== "/sign-in" && pathname !== "/server";
  return <ScopedBillingRecovery key={scope} enabled={enabled} />;
}

function ScopedBillingRecovery({ enabled }: { enabled: boolean }) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const [owner] = useState(captureMobileScope);
  const alive = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const actionBusy = useRef(false);
  const actionRevision = useRef(0);
  const denied = useRef(false);
  const checked = useRef(false);
  const recheck = useRef(() => Promise.resolve());
  const [actionPending, setActionPending] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [view, setView] = useState<RecoveryView>({
    denied: false,
    status: null,
    recovery: null,
    error: null,
    pending: false,
    spaces: [],
  });
  const current = () => alive.current && isMobileScopeCurrent(owner);

  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    async function load() {
      if (!current()) return;
      if (inFlight.current) return inFlight.current;
      const initial = !checked.current;
      setView((previous) => ({ ...previous, pending: true }));
      const operation = async () => {
        try {
          if (!(await loadSessionToken()) || !current()) return;
          const capabilities = await passwordResetCapabilities();
          if (!current()) return;
          if (!capabilities.billing) {
            denied.current = false;
            actionRevision.current += 1;
            setView((previous) => ({ ...previous, denied: false, status: null, recovery: null }));
            return;
          }
          const requestContext = {
            ...(await captureApiRequestContext(owner.spaceId)),
            isCurrent: current,
          };
          if (!current()) return;
          const me = await rpc<Me>("me", {}, { requestContext });
          if (!current()) return;
          if (!me.billingEnabled || me.isDeploymentOwner) {
            denied.current = false;
            actionRevision.current += 1;
            setView((previous) => ({ ...previous, denied: false, status: null, recovery: null }));
            return;
          }
          const status = await rpc<BillingStatus>(
            "billing/status",
            initial ? {} : { refresh: true },
            { requestContext },
          );
          if (!current()) return;
          denied.current = !status.access;
          if (status.access) actionRevision.current += 1;
          setView((previous) => ({
            ...previous,
            denied: !status.access,
            status,
            recovery: status.access ? null : "subscription_required",
            error: null,
          }));
          if (!status.access) {
            const accountContext = {
              ...(await captureApiRequestContext(null)),
              isCurrent: current,
            };
            if (!current()) return;
            const navigation = await rpc<SpaceNavigation>(
              "spaces/list",
              {},
              {
                requestContext: accountContext,
              },
            ).catch(() => null);
            if (current() && navigation)
              setView((previous) => ({ ...previous, spaces: navigation.spaces }));
          }
        } catch (error) {
          if (!current()) return;
          let recovery = accessRecoveryState(error);
          if (recovery === "session_expired") {
            // The existing safe read distinguishes a lost Space from an expired session,
            // retains the rejected editor, and never replays the failed mutation.
            const me = await rpc<Me>("me").catch(() => null);
            if (!current()) return;
            if (me) recovery = "space_forbidden";
          }
          if (!initial && (recovery === "session_expired" || recovery === "space_forbidden"))
            denied.current = true;
          // A first lookup failure is not evidence of an unpaid subscription.
          // Later failures retain the last server denial and offer recovery.
          if (!initial || denied.current) {
            setView((previous) => ({
              ...previous,
              denied: denied.current,
              recovery: recovery ?? "billing_unavailable",
              error: errorText(error, t("Could not refresh billing")),
            }));
          }
        } finally {
          checked.current = true;
          if (current()) setView((previous) => ({ ...previous, pending: false }));
        }
      };
      const request = operation().finally(() => {
        if (inFlight.current === request) inFlight.current = null;
      });
      inFlight.current = request;
      return request;
    }
    recheck.current = load;
    void load();
    const unsubscribe = subscribeSubscriptionRequired(() => {
      if (!current()) return;
      denied.current = true;
      setDismissed(false);
      setView((previous) => ({
        ...previous,
        denied: true,
        recovery: "subscription_required",
        // A new server denial supersedes a previously active subscription snapshot.
        status: previous.status?.access === false ? previous.status : null,
      }));
      void load();
    });
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active" && denied.current) void load();
    });
    return () => {
      alive.current = false;
      actionRevision.current += 1;
      unsubscribe();
      foreground.remove();
    };
    // The keyed scope owns every request and native callback for its lifetime.
  }, [enabled, owner, t]);

  function dismiss() {
    actionRevision.current += 1;
    setDismissed(true);
  }

  async function open(target: "checkout" | "portal") {
    if (!current() || actionBusy.current || inFlight.current || !view.status?.canManage) return;
    if (target === "checkout" && !view.status.price) return;
    actionBusy.current = true;
    const revision = ++actionRevision.current;
    const actionCurrent = () => current() && denied.current && actionRevision.current === revision;
    setActionPending(true);
    setView((previous) => ({ ...previous, error: null }));
    try {
      const requestContext = {
        ...(await captureApiRequestContext(owner.spaceId)),
        isCurrent: actionCurrent,
      };
      if (!actionCurrent()) return;
      const result = await rpc<{ url: string }>(`billing/${target}`, {}, { requestContext });
      if (!actionCurrent()) return;
      const url = new URL(result.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw new Error(t("Could not open billing"));
      await Linking.openURL(url.href);
    } catch (error) {
      if (actionCurrent())
        setView((previous) => ({
          ...previous,
          error: errorText(error, t("Could not open billing")),
        }));
    } finally {
      actionBusy.current = false;
      if (current()) setActionPending(false);
    }
  }

  async function logOut() {
    if (!current() || actionBusy.current || inFlight.current) return;
    actionBusy.current = true;
    setActionPending(true);
    try {
      if (
        (await signOut()) &&
        isMobileSessionCurrent({ ...owner, sessionGeneration: owner.sessionGeneration + 1 })
      )
        replaceWithSignIn();
    } catch (error) {
      if (current())
        setView((previous) => ({ ...previous, error: errorText(error, t("Could not sign out")) }));
    } finally {
      actionBusy.current = false;
      if (current()) setActionPending(false);
    }
  }

  async function chooseSpace(id: string) {
    if (!current() || actionBusy.current || inFlight.current || id === owner.spaceId) return;
    actionBusy.current = true;
    setActionPending(true);
    try {
      if (!(await selectSpace(id)) && current())
        setView((previous) => ({ ...previous, error: t("Could not save the selected Space") }));
    } catch (error) {
      if (current())
        setView((previous) => ({
          ...previous,
          error: errorText(error, t("Could not save the selected Space")),
        }));
    } finally {
      actionBusy.current = false;
      if (current()) setActionPending(false);
    }
  }

  const busy = view.pending || actionPending;
  const status = view.status;
  const priceLabel = status?.price ? formatBillingPrice(status.price, locale) : null;
  const showManagement =
    view.recovery === "subscription_required" || view.recovery === "billing_unavailable";
  const showPortal = Boolean(
    status?.canManage &&
      status.hasCustomer &&
      ["past_due", "incomplete", "canceled"].includes(status.state),
  );
  const title =
    view.recovery === "session_expired"
      ? t("Sign in again")
      : view.recovery === "space_forbidden"
        ? t("This Space is unavailable")
        : t("Subscription required");

  return (
    <Modal
      visible={enabled && view.denied && !dismissed}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={dismiss}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, gap: 16 }}
        >
          <Text
            accessibilityRole="header"
            style={{ color: tokens.foreground, fontSize: 24, fontWeight: "600" }}
          >
            {title}
          </Text>
          {view.recovery === "space_forbidden" ? (
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Contact your organization owner for an invitation")}
            </Text>
          ) : null}
          {view.error ? (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {view.error}
            </Text>
          ) : null}
          {showManagement && status && !status.canManage ? (
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Contact your organization owner")}
            </Text>
          ) : null}
          {showManagement && priceLabel ? (
            <Text style={{ color: tokens.mutedForeground }}>{priceLabel}</Text>
          ) : null}
          {showManagement && status?.canManage && priceLabel ? (
            <NativeActionButton
              label={
                status.trialAvailable
                  ? t("Start {days}-day free trial", { days: status.trialDays })
                  : t("Subscribe")
              }
              disabled={busy}
              onPress={() => void open("checkout")}
            />
          ) : null}
          {showManagement && showPortal ? (
            <NativeActionButton
              label={t("Manage billing")}
              disabled={busy}
              onPress={() => void open("portal")}
            />
          ) : null}
          <NativeActionButton
            label={t("Retry")}
            disabled={busy}
            prominence="secondary"
            onPress={() => void recheck.current()}
          />
          {view.spaces.some((space) => space.id !== owner.spaceId) && !busy ? (
            <MenuPickerMenu
              label={t("Switch Space")}
              value={owner.spaceId ?? ""}
              choices={view.spaces.map((space) => ({ key: space.id, label: space.name }))}
              onChange={(id) => void chooseSpace(id)}
            >
              <View
                accessibilityRole="button"
                accessibilityLabel={t("Switch Space")}
                style={{ minHeight: 48, justifyContent: "center" }}
              >
                <Text style={{ color: tokens.foreground }}>{t("Switch Space")}</Text>
              </View>
            </MenuPickerMenu>
          ) : null}
          <NativeActionButton label={t("Back to chats")} prominence="quiet" onPress={dismiss} />
          <NativeActionButton
            label={t("Sign out")}
            disabled={busy}
            prominence="quiet"
            onPress={() => void logOut()}
          />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
