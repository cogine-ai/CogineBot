import type { LoadFailureKind } from "@rakazo/core";
import { Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

export function HomeErrorState({
  kind,
  cached,
  busy,
  onRetry,
  onSignIn,
}: {
  kind: LoadFailureKind;
  cached: boolean;
  busy: boolean;
  onRetry: () => void;
  onSignIn: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const message =
    kind === "offline"
      ? t("Could not reach the server")
      : kind === "auth"
        ? t("Sign in again")
        : kind === "space"
          ? t("This Space is unavailable")
          : kind === "server"
            ? t("The server could not complete the request")
            : t("Could not load chats");
  return (
    <View accessibilityLiveRegion="polite" style={{ gap: 8, paddingVertical: 12 }}>
      <Text style={{ color: tokens.destructive, fontSize: 15 }}>{message}</Text>
      {kind === "space" ? (
        <Text style={{ color: tokens.mutedForeground }}>
          {t("Contact your organization owner for an invitation")}
        </Text>
      ) : null}
      {cached ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("Showing saved chats.")}</Text>
      ) : null}
      <NativeActionButton
        label={kind === "auth" ? t("Sign in") : kind === "space" ? t("Switch Space") : t("Retry")}
        disabled={busy}
        fill={false}
        onPress={kind === "auth" ? onSignIn : onRetry}
      />
    </View>
  );
}
