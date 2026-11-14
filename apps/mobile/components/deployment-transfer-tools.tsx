import type { DeploymentTransferStatus, DeploymentTransferStatusInput } from "@rakazo/contracts";
import type { DeploymentTransfer, DeploymentTransferState } from "@rakazo/core";
import { createDeploymentTransfer, initialDeploymentTransferState } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Linking, StyleSheet, Text, TextInput, View } from "react-native";
import type { MobileDeploymentTransferClient } from "../lib/deployment-transfer-client";
import { mobileDeploymentTransferClient } from "../lib/deployment-transfer-client";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import { captureMobileScope, mobileScopeKey, subscribeMobileScope } from "../lib/mobile-scope";
import { native } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

function TransferEditor({ botId, scope }: { botId: string; scope: MobileScope }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [sourceOrigin, setSourceOrigin] = useState("");
  const [state, setState] = useState<DeploymentTransferState>(initialDeploymentTransferState);
  const [client, setClient] = useState<MobileDeploymentTransferClient | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const manager = useRef<DeploymentTransfer | null>(null);
  const recovery = useRef<DeploymentTransferStatusInput | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      let controller: DeploymentTransfer | null = null;
      setClient(null);
      setFailed(false);
      void mobileDeploymentTransferClient(scope, () => active)
        .then((connection) => {
          if (!connection.isCurrent()) return;
          controller = createDeploymentTransfer({
            start: (input, signal) => connection.request("transfer/start", input, signal),
            preview: (input, signal) => connection.request("transfer/preview", input, signal),
            propose: (input, signal) => connection.request("transfer/propose", input, signal),
            approve: (input, signal) => connection.request("transfer/approve", input, signal),
            commit: (input, signal) => connection.request("transfer/commit", input, signal),
            status: (input, signal) => connection.request("transfer/status", input, signal),
            recent: (id, signal) => connection.request("transfer/recent", { botId: id }, signal),
            cancel: (input, signal) => connection.request("transfer/cancel", input, signal),
            newNonce: () =>
              globalThis.crypto?.randomUUID?.() ??
              `transfer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
            isCurrent: connection.isCurrent,
            changed(next) {
              if (!connection.isCurrent()) return;
              recovery.current = next.snapshot
                ? { transferId: next.snapshot.transferId }
                : next.recovery;
              setState(next);
            },
          });
          manager.current = controller;
          setClient(connection);
          if (recovery.current) void controller.restore(recovery.current);
          else setState({ ...initialDeploymentTransferState });
        })
        .catch(() => {
          if (active) setFailed(true);
        });
      return () => {
        active = false;
        controller?.dispose();
        manager.current = null;
        setClient(null);
      };
    }, [scope, reload]),
  );
  const snapshot = state.snapshot;
  const busy = ["saving", "checking", "loading"].includes(state.request);
  const pageUrl = client?.isCurrent() ? client.pageUrl(snapshot, state.recovery) : null;
  const phase = snapshot
    ? {
        created: t("Waiting for the source"),
        draft: t("Choose credentials"),
        proposed: t("Waiting for the target"),
        previewed: t("Review transfer"),
        approved: t("Waiting for the source"),
        grant_pending: t("Waiting for the source"),
        ready: t("Ready to copy"),
        transferring: t("Copying…"),
        unknown: t("Status not confirmed"),
        completed: t("Copied"),
        partial: t("Partially copied"),
        failed: t("Could not copy"),
        cancelled: t("Stopped"),
        expired: t("Expired"),
      }[snapshot.phase]
    : null;
  const itemLabel = (status: DeploymentTransferStatus["items"][number]["status"]) =>
    ({
      pending: t("Pending"),
      sending: t("Copying…"),
      unknown: t("Status not confirmed"),
      copied: t("Copied"),
      kept: t("Kept target"),
      conflict: t("Changed since review."),
      skipped: t("Skipped"),
      failed: t("Could not copy"),
      cancelled: t("Stopped"),
      expired: t("Expired"),
      removed: t("Removed"),
    })[status];
  async function continueInBrowser() {
    if (!client?.isCurrent() || !pageUrl) return;
    try {
      await Linking.openURL(pageUrl);
      if (client.isCurrent()) setFailed(false);
    } catch {
      if (client.isCurrent()) setFailed(true);
    }
  }
  function stop() {
    const expected = snapshot?.transferId;
    const opened = recovery.current;
    if (
      !client?.isCurrent() ||
      !expected ||
      !opened ||
      !("transferId" in opened) ||
      opened.transferId !== expected
    )
      return;
    Alert.alert(
      t("Stop transfer"),
      t("Only unsent items stop. Received items stay at the target."),
      [
        { text: t("Keep going"), style: "cancel" },
        {
          text: t("Stop unsent items"),
          style: "destructive",
          onPress: () => {
            const current = recovery.current;
            if (
              client.isCurrent() &&
              current &&
              "transferId" in current &&
              current.transferId === expected
            )
              void manager.current?.cancel();
          },
        },
      ],
    );
  }
  return (
    <View style={styles.section} testID="deployment-transfer-tools">
      <NativeActionButton
        label={t("Receive passwords and API keys")}
        prominence="secondary"
        disabled={open && busy}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <View style={styles.section}>
          {!snapshot && state.request === "idle" ? (
            <>
              <TextInput
                accessibilityLabel={t("Source deployment")}
                value={sourceOrigin}
                onChangeText={setSourceOrigin}
                placeholder="https://source.example.test"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              <NativeActionButton
                label={t("Create receiver")}
                disabled={!client || !sourceOrigin.trim()}
                onPress={() => void manager.current?.startReceive(botId, sourceOrigin)}
              />
            </>
          ) : null}
          {phase ? (
            <Text style={styles.text}>
              {state.request === "unknown" ? t("Status not confirmed") : phase}
            </Text>
          ) : null}
          {snapshot ? (
            <>
              {snapshot.writeRevokedReason === "restore" ? (
                <Text style={styles.text}>
                  {t("Write authorization expired. Existing results can still be checked.")}
                </Text>
              ) : null}
              {[snapshot.source, snapshot.target]
                .filter((identity) => identity !== null)
                .map((identity) => (
                  <View key={identity.origin}>
                    <Text style={styles.text}>{identity.origin}</Text>
                    <Text selectable style={styles.text}>
                      {identity.fingerprint}
                    </Text>
                  </View>
                ))}
              <Text style={styles.text}>
                {t("Expires")} {new Date(snapshot.expiresAt).toLocaleString(locale)}
              </Text>

              <Text style={styles.text}>
                {snapshot.side === "source"
                  ? snapshot.target.origin
                  : (snapshot.source?.origin ?? snapshot.target.origin)}
              </Text>
              {snapshot.items.map((item) => (
                <View key={item.itemKey}>
                  <Text style={styles.text}>
                    {item.name} · {itemLabel(item.status)}
                  </Text>
                  {item.status === "copied" && !item.targetState ? (
                    <Text style={styles.text}>{t("Target status not confirmed")}</Text>
                  ) : null}
                  {item.status === "copied" &&
                  "targetState" in item &&
                  item.targetState === "modified" ? (
                    <Text style={styles.text}>{t("Changed at target")}</Text>
                  ) : null}
                  {item.status === "copied" &&
                  "targetState" in item &&
                  item.targetState === "removed" ? (
                    <Text style={styles.text}>{t("Removed at target")}</Text>
                  ) : null}
                </View>
              ))}
            </>
          ) : null}
          {state.error ? (
            <Text accessibilityRole="alert" style={styles.text}>
              {state.error === "not_found"
                ? t("No receipt yet. Check status or reopen pairing from the receiving deployment.")
                : t("Could not confirm the result. Check status before continuing.")}
            </Text>
          ) : null}
          {pageUrl ? (
            <NativeActionButton
              label={t("Continue in browser")}
              prominence="secondary"
              onPress={() => void continueInBrowser()}
            />
          ) : null}
          {snapshot || state.recovery ? (
            <NativeActionButton
              label={t("Check status")}
              disabled={!client || busy}
              prominence="secondary"
              onPress={() => void manager.current?.checkStatus()}
            />
          ) : null}
          {snapshot &&
          snapshot.phase !== "completed" &&
          snapshot.writeRevokedReason !== "restore" &&
          (!["cancelled", "expired"].includes(snapshot.phase) ||
            snapshot.items.some((item) => item.status === "unknown")) ? (
            <NativeActionButton
              label={
                ["cancelled", "expired"].includes(snapshot.phase)
                  ? t("Retry stopping")
                  : t("Stop transfer")
              }
              prominence="secondary"
              onPress={stop}
            />
          ) : null}
          <NativeActionButton
            label={t("Recent transfers")}
            disabled={!client || state.recentLoading}
            prominence="secondary"
            onPress={() => void manager.current?.loadRecent(botId)}
          />
          {state.recent.map((entry) => (
            <NativeActionButton
              key={entry.transferId}
              label={
                entry.side === "source"
                  ? entry.target.origin
                  : (entry.source?.origin ?? entry.target.origin)
              }
              prominence="secondary"
              onPress={() => void manager.current?.restore({ transferId: entry.transferId })}
            />
          ))}
          {failed ? (
            <NativeActionButton
              label={t("Retry")}
              prominence="secondary"
              onPress={() => setReload((value) => value + 1)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
export function NativeDeploymentTransferTools({ botId }: { botId: string }) {
  const key = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const scope = useMemo(captureMobileScope, [key]);
  return <TransferEditor key={`${key}:${botId}`} botId={botId} scope={scope} />;
}
const styles = StyleSheet.create({
  section: { gap: 12, marginTop: 12 },
  text: { color: native.label, fontSize: 14 },
  input: {
    color: native.label,
    backgroundColor: native.fill,
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
  },
});
