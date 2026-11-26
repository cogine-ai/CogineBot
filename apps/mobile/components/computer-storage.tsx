import { useComputerStorage } from "@rakazo/chat-ui/computer-storage";
import { formatFileSize } from "@rakazo/core";
import { useIsFocused } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { Modal, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { captureApiRequestContext, rpc } from "../lib/api";
import { useAppActive } from "../lib/app-active";
import { useI18n } from "../lib/i18n";
import { mobileScopeKey, subscribeMobileScope } from "../lib/mobile-scope";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";
import { SettingsRow } from "./settings-group";

export function ComputerStorageRow({ botId }: { botId: string }) {
  const focused = useIsFocused();
  const active = useAppActive();
  const scope = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  if (!active || !focused) return null;
  return <StorageRow key={JSON.stringify([scope, botId])} botId={botId} scope={scope} />;
}

function StorageRow({ botId, scope }: { botId: string; scope: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsRow
        accessibilityRole="button"
        title={t("Storage")}
        chevron="right"
        onPress={() => {
          if (scope === mobileScopeKey()) setOpen(true);
        }}
      />
      <Modal visible={open} presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        {open ? <StorageSheet botId={botId} scope={scope} close={() => setOpen(false)} /> : null}
      </Modal>
    </>
  );
}

function StorageSheet({
  botId,
  scope,
  close,
}: {
  botId: string;
  scope: string;
  close: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const current = () => scope === mobileScopeKey();
  const { result, pending, failed, diagnose } = useComputerStorage(
    { botId },
    async (input, signal) => {
      const requestContext = await captureApiRequestContext();
      signal.throwIfAborted();
      if (!current()) throw new Error("Storage scope changed");
      return rpc("computer/diskUsage", input, {
        signal,
        requestContext,
        skipSpaceAuthRecovery: true,
      });
    },
    current,
  );
  const outcome = result?.outcome;
  let status = "";
  if (pending) status = t("Diagnosing…");
  else if (failed || outcome?.status === "timeout" || outcome?.status === "unavailable")
    status = t("Could not diagnose storage.");
  else if (outcome?.status === "not_running") status = t("Computer is not running.");
  else if (outcome?.status === "unsupported")
    status = t("Storage diagnostics are unavailable for this computer.");
  else if (outcome?.status === "changed") status = t("Computer changed. Open Storage again.");

  return (
    <SafeAreaView
      accessibilityViewIsModal
      style={{ flex: 1, backgroundColor: tokens.background, padding: 20 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text
          accessibilityRole="header"
          style={{ flex: 1, color: tokens.foreground, fontSize: 20 }}
        >
          {t("Storage")}
        </Text>
        <NativeActionButton label={t("Close")} prominence="secondary" onPress={close} />
      </View>
      <ScrollView contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>
        {status ? (
          <Text accessibilityLiveRegion="polite" style={{ color: tokens.mutedForeground }}>
            {status}
          </Text>
        ) : null}
        {!pending && outcome?.status === "available" ? (
          <>
            <Text accessibilityLiveRegion="polite" style={{ color: tokens.foreground }}>
              {t("{free} available of {total}", {
                free: formatFileSize(outcome.data.volume.availableBytes),
                total: formatFileSize(outcome.data.volume.totalBytes),
              })}
            </Text>
            {outcome.data.volume.availableInodes === 0 ? (
              <Text style={{ color: tokens.mutedForeground }}>{t("No free inodes.")}</Text>
            ) : null}
            {outcome.data.partial ? (
              <Text style={{ color: tokens.mutedForeground }}>{t("Partial results")}</Text>
            ) : null}
            {outcome.data.candidates.map(({ path, logicalBytes }) => (
              <View key={path} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Text style={{ flexGrow: 1, flexShrink: 1, color: tokens.foreground }}>{path}</Text>
                <Text style={{ color: tokens.mutedForeground }}>
                  {formatFileSize(logicalBytes)}
                </Text>
              </View>
            ))}
          </>
        ) : null}
        {outcome?.status !== "changed" ? (
          <NativeActionButton
            label={result || failed ? t("Retry") : t("Diagnose storage")}
            prominence="secondary"
            disabled={pending}
            onPress={() => void diagnose()}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
