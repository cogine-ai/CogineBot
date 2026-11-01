import type { SpaceCollaborationPolicy } from "@rakazo/contracts";
import { SpaceCollaborationPolicySchema } from "@rakazo/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../../components/settings-group";
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
  const [policy, setPolicy] = useState<SpaceCollaborationPolicy | null>(null);
  const [draft, setDraft] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const operation = useRef(0);
  const busy = useRef(false);
  const readPolicy = useCallback(async () => {
    const navigation = await settings.rpc<{ spaces: { id: string }[] }>("spaces/list");
    const space = navigation.spaces.find((space) => space.id === spaceId);
    const result = SpaceCollaborationPolicySchema.safeParse({ ...space, spaceId: space?.id });
    if (!result.success || result.data.spaceId !== spaceId)
      throw new Error(t("Something went wrong. Try again."));
    return result.data;
  }, [spaceId, settings.rpc, t]);
  const load = useCallback(async () => {
    const request = ++operation.current;
    const current = () => settings.isCurrent() && request === operation.current;
    busy.current = true;
    setError(null);
    setReady(false);
    if (!spaceId) {
      setError(t("Something went wrong. Try again."));
      busy.current = false;
      return;
    }
    try {
      await settings.rpc<MobileMe>("me");
      if (!current()) return;
      setReady(true);
      const fresh = await readPolicy();
      if (!current()) return;
      setPolicy(fresh);
      setDraft(fresh.allowBotCollaboration);
      setNeedsRefresh(false);
    } catch (error) {
      if (current()) {
        setError(errorText(error, t("Something went wrong. Try again.")));
        setNeedsRefresh(true);
      }
    } finally {
      if (current()) busy.current = false;
    }
  }, [spaceId, settings.rpc, settings.isCurrent, readPolicy, t]);
  useEffect(() => {
    void load();
  }, [load]);
  const refresh = async () => {
    if (busy.current || !settings.isCurrent()) return;
    const request = ++operation.current;
    const current = () => settings.isCurrent() && request === operation.current;
    busy.current = true;
    setRefreshing(true);
    setError(null);
    try {
      const fresh = await readPolicy();
      if (!current()) return;
      setPolicy(fresh);
      if (!policy) setDraft(fresh.allowBotCollaboration);
      setNeedsRefresh(false);
    } catch (error) {
      if (current()) setError(errorText(error, t("Something went wrong. Try again.")));
    } finally {
      if (current()) {
        busy.current = false;
        setRefreshing(false);
      }
    }
  };
  const save = async (value: boolean) => {
    if (!policy?.canManageCollaboration || busy.current || needsRefresh || !settings.isCurrent())
      return;
    setDraft(value);
    if (value === policy.allowBotCollaboration) return;
    const request = ++operation.current;
    const current = () => settings.isCurrent() && request === operation.current;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const receipt = await settings.rpc("spaces/update", {
        spaceId,
        allowBotCollaboration: value,
        expectedCollaborationRevision: policy.collaborationRevision,
      });
      if (!current()) return;
      const result = SpaceCollaborationPolicySchema.safeParse(receipt);
      if (
        !result.success ||
        result.data.spaceId !== spaceId ||
        result.data.allowBotCollaboration !== value ||
        result.data.collaborationRevision <= policy.collaborationRevision
      )
        throw new Error(t("Something went wrong. Try again."));
      setPolicy(result.data);
    } catch (error) {
      if (current()) {
        setError(errorText(error, t("Something went wrong. Try again.")));
        setNeedsRefresh(true);
      }
    } finally {
      if (current()) {
        busy.current = false;
        setSaving(false);
      }
    }
  };
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {error ? (
          <>
            <Text style={styles.error}>{error}</Text>
            <NativeActionButton
              label={t("Refresh")}
              onPress={() => void (ready ? refresh() : load())}
              disabled={saving || refreshing}
            />
          </>
        ) : !ready ? (
          <ActivityIndicator color={native.secondaryLabel} />
        ) : null}
        {ready && spaceId ? (
          <SettingsGroup
            label={name}
            footer={
              saving && policy?.allowBotCollaboration && !draft
                ? t("Work already running may finish.")
                : policy && !policy.canManageCollaboration
                  ? t("Only the Space owner can change this.")
                  : undefined
            }
          >
            <SettingsSwitch
              label={t("Bot collaboration")}
              detail={t(
                "Allow Bots to message and assign work to other Bots and connected agents.",
              )}
              value={
                policy?.canManageCollaboration ? draft : (policy?.allowBotCollaboration ?? false)
              }
              disabled={!policy?.canManageCollaboration || saving || refreshing || needsRefresh}
              onChange={(value) => void save(value)}
            />
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
        {ready &&
        !needsRefresh &&
        !saving &&
        !refreshing &&
        policy?.canManageCollaboration &&
        draft !== policy.allowBotCollaboration ? (
          <NativeActionButton label={t("Save")} onPress={() => void save(draft)} />
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
