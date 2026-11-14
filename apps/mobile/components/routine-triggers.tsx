import type { Bot, Connection } from "@rakazo/contracts";
import {
  emptyNativeRoutineTriggerDraft,
  nativeEventAccounts,
} from "@rakazo/core/routine-native-events";
import type { RoutineTriggerDraft } from "@rakazo/core/routine-trigger-patch";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import type { ApiRequestContext } from "../lib/api";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import { native, useMobileTokens } from "../lib/native";
import { spaceRequestContext } from "../lib/space-request-context";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";
import { RoutineNativeEventFields } from "./routine-native-events";

export type RoutineTriggerAccess = {
  botId: string;
  scope: MobileScope;
  spaceId: string;
  isCurrent: () => boolean;
};

export function RoutineTriggers({
  value,
  onChange,
  disabled,
  access,
  onBusy,
}: {
  value: RoutineTriggerDraft;
  onChange: (value: RoutineTriggerDraft) => void;
  disabled: boolean;
  access: RoutineTriggerAccess;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const [rows, setRows] = useState<Connection[]>([]);
  const [slack, setSlack] = useState(false);
  const [bot, setBot] = useState<Bot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [secret, setSecret] = useState<string | null>(null);
  const busy = useRef(false);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const current = () => !cancelled && access.isCurrent();
    setLoading(true);
    setError(null);
    setRows([]);
    setSlack(false);
    setBot(null);
    void (async () => {
      const context = await spaceRequestContext(access.scope, current, access.spaceId);
      if (!current()) return;
      const requestContext = { ...context, isCurrent: current };
      const results = await Promise.allSettled([
        rpc<Connection[]>("connections/list", {}, { requestContext }),
        rpc<{ providers: string[] }>("messaging/status", {}, { requestContext }),
        rpc<{ available: boolean; workspaces: { botId: string; status: string }[] }>(
          "messaging/installations/list",
          {},
          { requestContext },
        ),
        rpc<Bot>("bots/get", { botId: access.botId }, { requestContext }),
      ]);
      if (!current()) return;
      const [connections, status, installations, botResult] = results;
      if (connections.status === "fulfilled") setRows(connections.value);
      setSlack(
        (status.status === "fulfilled" && status.value.providers.includes("slack")) ||
          (installations.status === "fulfilled" &&
            installations.value.available &&
            installations.value.workspaces.some(
              (row) => row.botId === access.botId && row.status === "active",
            )),
      );
      if (botResult.status === "fulfilled") setBot(botResult.value);
      if (results.some((result) => result.status === "rejected"))
        setError(t("Could not load trigger settings"));
    })()
      .catch(() => {
        if (current()) setError(t("Could not load trigger settings"));
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [access.scope, access.botId, access.spaceId, attempt]);

  async function rotate() {
    if (!mounted.current || disabledRef.current || busy.current || !access.isCurrent()) return;
    busy.current = true;
    onBusy(true);
    setError(null);
    const current = () => mounted.current && access.isCurrent();
    try {
      const context = await spaceRequestContext(access.scope, current, access.spaceId);
      if (!current()) return;
      const requestContext: ApiRequestContext = { ...context, isCurrent: current };
      const result = await rpc<{ secret: string }>(
        "bots/rotateWebhookSecret",
        { botId: access.botId },
        { requestContext },
      );
      if (current()) {
        setSecret(result.secret);
        setBot((previous) => (previous ? { ...previous, webhookConfigured: true } : previous));
      }
    } catch (cause) {
      if (current()) setError(errorText(cause, t("Could not save")));
    } finally {
      busy.current = false;
      if (mounted.current) onBusy(false);
    }
  }
  function toggle(key: "webhookEnabled" | "githubEnabled", label: string) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: native.label }}>{label}</Text>
        <NativeSwitch
          accessibilityLabel={label}
          value={value[key]}
          disabled={disabled}
          onValueChange={(enabled) => {
            if (!disabled && access.isCurrent()) onChange({ ...value, [key]: enabled });
          }}
        />
      </View>
    );
  }
  return (
    <View style={{ gap: 12 }}>
      {toggle("webhookEnabled", t("Webhook"))}
      {toggle("githubEnabled", t("Git event"))}
      {value.webhookEnabled || value.githubEnabled ? (
        <>
          {value.webhookEnabled ? (
            <Text
              selectable
              style={{ color: native.secondaryLabel }}
            >{`${access.scope.apiBase}/api/v1/bots/${encodeURIComponent(access.botId)}/webhook`}</Text>
          ) : null}
          {value.githubEnabled ? (
            <Text
              selectable
              style={{ color: native.secondaryLabel }}
            >{`${access.scope.apiBase}/api/v1/bots/${encodeURIComponent(access.botId)}/github`}</Text>
          ) : null}
          {secret ? (
            <Text
              selectable
              accessibilityLabel={t("Webhook secret")}
              style={{ color: native.label }}
            >
              {secret}
            </Text>
          ) : null}
          <NativeActionButton
            label={bot?.webhookConfigured ? t("Rotate secret") : t("Create secret")}
            disabled={disabled || !bot || loading}
            onPress={() => {
              if (bot?.webhookConfigured)
                Alert.alert(
                  t("Rotate secret?"),
                  t("Existing webhook and GitHub senders must use the new secret."),
                  [
                    { text: t("Cancel"), style: "cancel" },
                    {
                      text: t("Rotate secret"),
                      style: "destructive",
                      onPress: () => void rotate(),
                    },
                  ],
                );
              else void rotate();
            }}
          />
        </>
      ) : null}
      {value.messageProvider ? (
        <>
          <Text style={{ color: native.label }}>
            {value.messageProvider === "slack"
              ? t("Slack message")
              : value.messageProvider === "teams"
                ? t("Teams message")
                : t("Message event")}
          </Text>
          <NativeActionButton
            label={t("Remove message trigger")}
            prominence="quiet"
            disabled={disabled}
            onPress={() => {
              if (!disabled && access.isCurrent()) onChange({ ...value, messageProvider: null });
            }}
          />
        </>
      ) : null}
      {value.messageProvider !== "slack" ? (
        <NativeActionButton
          label={t("Slack message")}
          disabled={disabled || loading || !slack}
          onPress={() => {
            if (!disabled && access.isCurrent() && slack)
              onChange({ ...value, messageProvider: "slack" });
          }}
        />
      ) : null}
      {!loading && !slack ? (
        <Text style={{ color: native.secondaryLabel }}>{t("Slack not enabled")}</Text>
      ) : null}
      {loading ? <ActivityIndicator /> : null}
      {value.nativeTriggers.map((draft, index) => (
        <RoutineNativeEventFields
          key={draft.key}
          draft={draft}
          rows={rows}
          disabled={disabled || loading}
          onChange={(next) => {
            if (!disabled && access.isCurrent())
              onChange({
                ...value,
                nativeTriggers: value.nativeTriggers.map((item, i) => (i === index ? next : item)),
              });
          }}
          onRemove={() => {
            if (!disabled && access.isCurrent())
              onChange({
                ...value,
                nativeTriggers: value.nativeTriggers.filter((_, i) => i !== index),
              });
          }}
        />
      ))}
      <NativeActionButton
        label={t("Add application event")}
        disabled={
          disabled ||
          loading ||
          !nativeEventAccounts(rows).length ||
          value.nativeTriggers.length >= 20
        }
        onPress={() => {
          if (
            !disabled &&
            !loading &&
            value.nativeTriggers.length < 20 &&
            nativeEventAccounts(rows).length &&
            access.isCurrent()
          )
            onChange({
              ...value,
              nativeTriggers: [...value.nativeTriggers, emptyNativeRoutineTriggerDraft()],
            });
        }}
      />
      {!loading && !nativeEventAccounts(rows).length ? (
        <Text style={{ color: native.secondaryLabel }}>
          {t("No connected accounts for application events")}
        </Text>
      ) : null}
      <NativeActionButton
        label={t("Connect an account")}
        prominence="quiet"
        disabled={disabled}
        onPress={() => {
          if (access.isCurrent()) router.push("/plugins");
        }}
      />
      {error ? (
        <>
          <Text style={{ color: tokens.destructive }}>{error}</Text>
          <NativeActionButton
            label={t("Retry")}
            disabled={disabled || loading}
            onPress={() => setAttempt((value) => value + 1)}
          />
        </>
      ) : null}
    </View>
  );
}
