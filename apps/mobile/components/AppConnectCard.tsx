import type { AppConnectClient } from "@rakazo/chat-ui/app-connect";
import { useAppConnectCard } from "@rakazo/chat-ui/app-connect";
import type { MessageBlock } from "@rakazo/contracts";
import { NativeAppIdSchema } from "@rakazo/contracts";
import { router } from "expo-router";
import { useState } from "react";
import type { ViewProps } from "react-native";
import { Linking, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { appConnectPresentation } from "../lib/app-connect";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { useThreadReadOnly } from "../lib/thread-read-only";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

const appConnectClient: AppConnectClient = {
  readback: (input, signal) => rpc("onboarding/appConnected", input, { signal }),
  begin: (input, signal) => rpc("connections/begin", input, { signal }),
  complete: (input, signal) => rpc("connections/complete", input, { signal }),
  openAuthorization: async (url): Promise<"opened"> => {
    await Linking.openURL(url);
    return "opened";
  },
};

export function AppConnectCard({
  botId,
  messageId,
  block,
  accessibilityActions,
  onAccessibilityAction,
}: {
  botId: string;
  messageId: string;
  block: Extract<MessageBlock, { kind: "app_connect" }>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const readOnly = useThreadReadOnly();
  const tokens = useMobileTokens();
  const [nativeError, setNativeError] = useState<string | null>(null);
  const connection = useAppConnectCard({ botId, messageId, block, readOnly }, appConnectClient);
  const { status, busy, checkOnly, needsAttention } = connection;
  const view = appConnectPresentation({ ...block, status }, busy);
  const failure = connection.error;
  const error =
    nativeError ??
    (failure?.kind === "pending"
      ? t("Authorization is still pending.")
      : failure?.kind === "request"
        ? errorText(failure.cause, t("Could not authorize this app"))
        : failure && t("Could not authorize this app"));

  function authorize() {
    if (readOnly) return;
    if (block.connectorId !== "native") return connection.authorize();
    const appId = NativeAppIdSchema.safeParse(block.provider);
    if (!appId.success) {
      setNativeError(t("This app is not available."));
      return;
    }
    setNativeError(null);
    router.push({
      pathname: "/(settings)/integrations",
      params: { app: appId.data, botId },
    });
  }

  return (
    <View
      accessibilityLabel={t("{name} connection", { name: block.name })}
      style={{
        width: "90%",
        borderRadius: 18,
        backgroundColor: native.fill,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            backgroundColor: native.fillPressed,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>
            {block.name.slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}
          >
            {view.title}
          </Text>
          <Text style={{ color: tokens.mutedForeground, fontSize: 13.5 }} numberOfLines={2}>
            {view.description}
          </Text>
        </View>
        {view.showAuthorize && !readOnly ? (
          <NativeActionButton
            label={
              block.connectorId === "native"
                ? t("Connect")
                : checkOnly && !busy
                  ? t("Check status")
                  : view.actionLabel
            }
            accessibilityLabel={
              block.connectorId === "native"
                ? t("Connect {name}", { name: block.name })
                : checkOnly
                  ? t("Check status")
                  : t("Authorize {name}", { name: block.name })
            }
            fill={false}
            busy={busy}
            style={{ alignSelf: "center" }}
            onPress={() => void authorize()}
          />
        ) : !view.showAuthorize ? (
          <Text style={{ color: tokens.success, fontSize: 13.5, fontWeight: "600" }}>
            {view.actionLabel}
          </Text>
        ) : null}
      </View>
      {error ? <Text style={{ color: tokens.destructive, fontSize: 13 }}>{error}</Text> : null}
      {needsAttention && !readOnly ? (
        <NativeActionButton
          label={t("Manage")}
          fill={false}
          style={{ alignSelf: "flex-end" }}
          onPress={() => {
            connection.prepareToManage();
            router.push("/(settings)/integrations");
          }}
        />
      ) : null}
    </View>
  );
}
