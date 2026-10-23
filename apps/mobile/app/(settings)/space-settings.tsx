import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import type { MobileMe } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { useSpaceSettings, useSpaceSettingsKey } from "../../lib/space-settings";
import { errorText } from "../../lib/user-error";

export default function SpaceSettings() {
  const { spaceId, name } = useLocalSearchParams<{ spaceId?: string; name?: string }>();
  const target = typeof spaceId === "string" ? spaceId : undefined;
  const key = useSpaceSettingsKey(target);
  return (
    <SpaceSettingsForm
      key={key}
      spaceId={target}
      name={typeof name === "string" ? name : undefined}
    />
  );
}

function SpaceSettingsForm({ spaceId, name }: { spaceId?: string; name?: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const settings = useSpaceSettings(spaceId);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    setReady(false);
    if (!spaceId) {
      setError(t("Something went wrong. Try again."));
      return;
    }
    try {
      await settings.rpc<MobileMe>("me");
      if (settings.isCurrent()) setReady(true);
    } catch (error) {
      if (settings.isCurrent()) setError(errorText(error, t("Something went wrong. Try again.")));
    }
  }, [spaceId, settings.rpc, settings.isCurrent, t]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {error ? (
          <>
            <Text style={styles.error}>{error}</Text>
            <NativeActionButton label={t("Retry")} onPress={() => void load()} />
          </>
        ) : !ready ? (
          <ActivityIndicator color={native.secondaryLabel} />
        ) : null}
        {ready && spaceId ? (
          <SettingsGroup label={name}>
            <SettingsRow
              title={t("Models")}
              chevron="right"
              onPress={() => {
                if (settings.isCurrent())
                  router.push({
                    pathname: "/models",
                    params: { spaceId, ...(name ? { name } : {}) },
                  });
              }}
            />
            <SettingsRow
              title={t("Voice")}
              chevron="right"
              onPress={() => {
                if (settings.isCurrent())
                  router.push({
                    pathname: "/voice",
                    params: { spaceId, ...(name ? { name } : {}) },
                  });
              }}
            />
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 20, gap: 16 },
    error: { color: native.label },
  });
}
