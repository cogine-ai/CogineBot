import type { ActionApprovalRule, ActionAutoReviewSettings } from "@rakazo/contracts";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../../components/settings-group";
import { useAppActive } from "../../lib/app-active";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { useSpaceSettings, useSpaceSettingsKey } from "../../lib/space-settings";
import { errorText } from "../../lib/user-error";

export default function ApprovalRules() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const target = typeof spaceId === "string" ? spaceId : undefined;
  const key = useSpaceSettingsKey(target);
  return <ApprovalRulesForm key={key} spaceId={target} />;
}

function ApprovalRulesForm({ spaceId }: { spaceId?: string }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const active = useAppActive();
  const { rpc, isCurrent } = useSpaceSettings(spaceId);
  const [rules, setRules] = useState<ActionApprovalRule[] | null>(null);
  const [review, setReview] = useState<ActionAutoReviewSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(0);
  const locked = useRef(false);
  const focused = useRef(false);
  const pendingWrite = useRef<Promise<void> | null>(null);
  const current = () => focused.current && isCurrent();
  const refresh = useCallback(async () => {
    if (!isCurrent() || !focused.current) return;
    if (!spaceId) {
      setError(t("Something went wrong. Try again."));
      return;
    }
    const request = ++operation.current;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      // A refocus must read after an already-dispatched write settles.
      await pendingWrite.current?.catch(() => undefined);
      if (!focused.current || !isCurrent() || request !== operation.current) return;
      const nextRules = await rpc<ActionApprovalRule[]>("approvalRules/list");
      if (!focused.current || !isCurrent() || request !== operation.current) return;
      const nextReview = await rpc<ActionAutoReviewSettings>("autoReview/get");
      if (!focused.current || !isCurrent() || request !== operation.current) return;
      setRules(nextRules);
      setReview(nextReview);
    } catch (err) {
      if (focused.current && isCurrent() && request === operation.current)
        setError(errorText(err, t("Something went wrong. Try again.")));
    } finally {
      if (focused.current && isCurrent() && request === operation.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }, [spaceId, rpc, isCurrent, t]);
  useFocusEffect(
    useCallback(() => {
      focused.current = active;
      if (active) void refresh();
      return () => {
        focused.current = false;
        operation.current++;
      };
    }, [active, refresh]),
  );

  async function mutate(action: () => Promise<void>) {
    if (!spaceId || !current() || locked.current || !rules || !review || error) return;
    locked.current = true;
    setBusy(true);
    const request = ++operation.current;
    try {
      const pending = action();
      pendingWrite.current = pending;
      try {
        await pending;
      } finally {
        if (pendingWrite.current === pending) pendingWrite.current = null;
      }
      if (!current() || request !== operation.current) return;
      await refresh();
    } catch (err) {
      if (current() && request === operation.current)
        setError(errorText(err, t("Something went wrong. Try again.")));
    } finally {
      if (current() && request === operation.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  const disabled = !active || !spaceId || busy || !rules || !review || !!error;
  const effects = {
    always_allow: t("Allowed"),
    deny: t("Blocked"),
    require_approval: t("Requires confirmation"),
  };
  const scopes = {
    tool: t("Action"),
    connector: t("Connector"),
    category: t("Category"),
    site: t("Site"),
  };
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {busy ? <ActivityIndicator color={native.secondaryLabel} /> : null}
        {error ? (
          <>
            <Text style={styles.error}>{error}</Text>
            <NativeActionButton
              label={t("Refresh")}
              disabled={busy}
              onPress={() => void refresh()}
            />
          </>
        ) : null}
        <SettingsGroup>
          {(["email", "purchase"] as const).map((category) => (
            <SettingsRow
              key={category}
              title={
                category === "email"
                  ? t("Ask before sending external email")
                  : t("Ask before purchases")
              }
              disabled={
                disabled ||
                !!rules?.some(
                  (rule) =>
                    rule.effect === "require_approval" &&
                    rule.matchKind === "category" &&
                    rule.matchValue === category,
                )
              }
              onPress={() =>
                void mutate(async () => {
                  await rpc("approvalRules/set", {
                    effect: "require_approval",
                    matchKind: "category",
                    matchValue: category,
                  });
                })
              }
            />
          ))}
          <SettingsSwitch
            label={t("Flag unexpected actions")}
            value={review?.enabled ?? false}
            disabled={disabled}
            detail={
              review?.enabled && !review.checkerAvailable
                ? t("Add a model in Settings to use this.")
                : undefined
            }
            onChange={(enabled) =>
              void mutate(async () => {
                await rpc("autoReview/set", { enabled });
              })
            }
          />
        </SettingsGroup>
        {rules?.length === 0 ? <Text style={styles.secondary}>{t("No saved rules")}</Text> : null}
        <SettingsGroup>
          {rules?.map((rule) => (
            <SettingsRow
              key={rule.id}
              title={`${effects[rule.effect]} · ${rule.matchValue}`}
              detail={scopes[rule.matchKind]}
              trailing={
                <NativeActionButton
                  label={t("Remove")}
                  accessibilityLabel={t("Remove {rule}", { rule: rule.matchValue })}
                  prominence="quiet"
                  disabled={disabled}
                  onPress={() =>
                    void mutate(async () => {
                      await rpc("approvalRules/remove", { id: rule.id });
                    })
                  }
                />
              }
            />
          ))}
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 20, gap: 16 },
    error: { color: native.label },
    secondary: { color: native.secondaryLabel },
  });
}
