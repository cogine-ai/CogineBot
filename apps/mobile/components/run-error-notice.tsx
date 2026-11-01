import { CHATGPT_USAGE_SETTINGS_URL, normalizeRunError } from "@rakazo/core";
import { useRouter } from "expo-router";
import { useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Linking, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";
import { SelectTextSheet } from "./select-text-sheet";

export function RunErrorNotice({ error, style }: { error: string; style?: StyleProp<ViewStyle> }) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const normalized = normalizeRunError(error, t, locale);
  return (
    <View style={[{ gap: 6 }, style]}>
      <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 14 }}>
        {normalized.summary}
      </Text>
      {normalized.action === "chatgpt-usage" ? (
        <NativeActionButton
          label={t("Manage usage")}
          fill={false}
          onPress={() => void Linking.openURL(CHATGPT_USAGE_SETTINGS_URL)}
        />
      ) : null}
      {normalized.action === "add_key" ? (
        <NativeActionButton
          label={t("Add API key")}
          fill={false}
          onPress={() => router.push("/(settings)/models")}
        />
      ) : null}
      <NativeActionButton
        label={t("Details")}
        fill={false}
        onPress={() => setSelectedError(error)}
      />
      <SelectTextSheet
        text={selectedError === error ? normalized.details : null}
        onClose={() => setSelectedError(null)}
      />
    </View>
  );
}
