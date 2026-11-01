import type { PluginInstallReceipt } from "@rakazo/contracts";
import type { PluginInstallReview, PluginInstallReviewState } from "@rakazo/core";
import { createPluginInstallReview, initialPluginInstallReview } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { NativeActionButton } from "../../components/native-action-button";
import { captureApiRequestContext, rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  subscribeMobileScope,
} from "../../lib/mobile-scope";
import { native, useThemedStyles } from "../../lib/native";
import { errorText } from "../../lib/user-error";

export default function Plugins() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [state, setState] = useState<PluginInstallReviewState>(initialPluginInstallReview);
  const [removal, setRemoval] = useState<PluginInstallReceipt | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const manager = useRef<PluginInstallReview | null>(null);
  useFocusEffect(
    useCallback(() => {
      let focused = true;
      let closeOwner = () => {};
      function start() {
        closeOwner();
        const scope = captureMobileScope();
        let active = true;
        const isCurrent = () => focused && active && isMobileScopeCurrent(scope);
        setState(initialPluginInstallReview());
        setRemoval(null);
        setExpanded(new Set());
        setReady(false);
        let review: PluginInstallReview | null = null;
        closeOwner = () => {
          active = false;
          review?.dispose();
          if (manager.current === review) manager.current = null;
        };
        void captureApiRequestContext(scope.spaceId)
          .then(async (context) => {
            if (!isCurrent()) return;
            let targetSpaceId = scope.spaceId;
            if (!targetSpaceId) {
              const me = await rpc<{ userId: string; spaceId: string }>(
                "me",
                {},
                { requestContext: { ...context, isCurrent }, skipSpaceAuthRecovery: true },
              );
              if (!isCurrent()) return;
              if (
                typeof me.userId !== "string" ||
                !me.userId ||
                typeof me.spaceId !== "string" ||
                !me.spaceId
              )
                throw new Error("Could not load installed plugins.");
              targetSpaceId = me.spaceId;
            }
            const requestContext = {
              ...context,
              isCurrent,
              headers: { ...context.headers, "x-rakazo-space-id": targetSpaceId },
            };
            const request = <T,>(procedure: string, input: unknown, signal: AbortSignal) =>
              rpc<T>(procedure, input, {
                signal,
                timeoutMs: 35_000,
                requestContext,
                skipSpaceAuthRecovery: true,
              });
            review = createPluginInstallReview({
              preview: (input, signal) => request("plugins/preview", input, signal),
              install: (input, signal) => request("plugins/install", input, signal),
              list: (signal) => request("plugins/list", {}, signal),
              uninstall: (input, signal) => request("plugins/uninstall", input, signal),
              makeNonce: () =>
                globalThis.crypto?.randomUUID?.() ??
                `plugin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
              isCurrent,
              changed: setState,
            });
            manager.current = review;
            setReady(true);
            void review.refresh();
          })
          .catch((error) => {
            if (isCurrent()) setState((value) => ({ ...value, listError: error }));
          });
      }
      start();
      const unsubscribe = subscribeMobileScope(start);
      return () => {
        focused = false;
        unsubscribe();
        closeOwner();
      };
    }, [retry]),
  );
  const locked =
    state.phase === "installing" || state.phase === "unknown" || Boolean(state.removingId);
  const preview = state.preview;
  const rows = state.installations.filter((row) => row.status !== "removed");
  async function remove(row: PluginInstallReceipt) {
    setRemoval(null);
    await manager.current?.uninstall(row);
  }
  return (
    <ScrollView
      testID="github-plugin-installs"
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      style={styles.screen}
    >
      <View style={styles.card}>
        <TextInput
          accessibilityLabel={t("Plugin GitHub URL")}
          placeholder="https://github.com/owner/plugin"
          value={state.source}
          onChangeText={(value) => manager.current?.changeSource(value)}
          maxLength={2048}
          editable={ready && !locked}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholderTextColor={native.tertiaryLabel}
          style={styles.input}
        />
        <NativeActionButton
          label={state.phase === "previewing" ? t("Previewing…") : t("Preview")}
          busy={state.phase === "previewing"}
          disabled={!ready || locked || !state.source.trim()}
          onPress={() => void manager.current?.preview(state.source.trim())}
          prominence="secondary"
        />
      </View>
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorText(state.error, t("Could not complete this request."))}
        </Text>
      ) : null}
      {preview ? (
        <View testID="plugin-preview" style={styles.card}>
          <Text style={styles.heading}>{preview.name}</Text>
          <Text style={styles.secondary}>{preview.description}</Text>
          <Text selectable style={styles.metadata}>
            {preview.source}
          </Text>
          <Text selectable style={styles.metadata}>
            {preview.sourceSha}
          </Text>
          {preview.skills.length ? <Text style={styles.heading}>{t("Skills")}</Text> : null}
          {preview.skills.map((skill) => (
            <View key={skill.name} style={styles.section}>
              <Text style={styles.title}>{skill.name}</Text>
              <Text style={styles.secondary}>{skill.description}</Text>
              <NativeActionButton
                label={expanded.has(skill.name) ? t("Hide instructions") : t("View instructions")}
                prominence="quiet"
                onPress={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(skill.name)) next.delete(skill.name);
                    else next.add(skill.name);
                    return next;
                  })
                }
              />
              {expanded.has(skill.name) ? (
                <Text selectable style={styles.instructions}>
                  {skill.content}
                </Text>
              ) : null}
            </View>
          ))}
          {preview.mcpServers.length ? (
            <Text style={styles.heading}>{t("MCP servers")}</Text>
          ) : null}
          {preview.mcpServers.map((server) => (
            <View key={server.name} style={styles.section}>
              <Text style={styles.title}>{server.name}</Text>
              <Text selectable style={styles.metadata}>
                {server.endpoint}
              </Text>
              {server.headerKeys.length ? (
                <Text style={styles.metadata}>{server.headerKeys.join(", ")}</Text>
              ) : null}
            </View>
          ))}
          {preview.mcpServers.length ? (
            <Text style={styles.secondary}>{t("MCP tools require separate approval.")}</Text>
          ) : null}
          {preview.skipped.length ? (
            <View style={styles.section}>
              <Text style={styles.heading}>{t("Skipped components")}</Text>
              {preview.skipped.map((item, index) => (
                <View key={`${item.kind}:${item.name}:${index}`}>
                  <Text style={styles.title}>{item.name}</Text>
                  <Text style={styles.secondary}>{item.reason}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {state.phase === "review" ? (
            <>
              {preview.skills.length ? (
                <Text style={styles.secondary}>
                  {t("Skills are available to your Bots in this Space.")}
                </Text>
              ) : null}
              <NativeActionButton
                label={t("Install plugin")}
                disabled={!preview.skills.length && !preview.mcpServers.length}
                onPress={() => void manager.current?.install()}
              />
            </>
          ) : null}
        </View>
      ) : null}
      {state.phase === "installing" ? (
        <NativeActionButton busy label={t("Installing…")} onPress={() => {}} />
      ) : null}
      {state.phase === "unknown" ? (
        <View style={styles.card}>
          <Text style={styles.title}>
            {state.receipt?.status === "installing"
              ? t("Installation pending.")
              : t("Could not confirm installation.")}
          </Text>
          <NativeActionButton
            label={t("Check status")}
            disabled={state.loading}
            prominence="secondary"
            onPress={() => void manager.current?.check()}
          />
          {state.retryChecked ? (
            <NativeActionButton
              label={t("Retry")}
              prominence="secondary"
              onPress={() => void manager.current?.install()}
            />
          ) : null}
        </View>
      ) : null}
      {state.phase === "terminal" && state.receipt?.status === "removed" ? (
        <Text style={styles.title}>{t("This installation was removed.")}</Text>
      ) : null}
      {state.phase === "terminal" && state.receipt?.status === "failed" ? (
        <View style={styles.card}>
          <Text accessibilityRole="alert" style={styles.error}>
            {t("Installation failed.")}
          </Text>
          <NativeActionButton
            label={t("Preview again")}
            prominence="secondary"
            onPress={() => void manager.current?.preview(state.source.trim())}
          />
        </View>
      ) : null}
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.heading}>{t("Plugin installations")}</Text>
          <NativeActionButton
            label={t("Refresh")}
            prominence="quiet"
            disabled={state.loading || Boolean(state.removingId)}
            onPress={() =>
              ready ? void manager.current?.refresh() : setRetry((value) => value + 1)
            }
          />
        </View>
        {state.listError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {t("Could not load installed plugins.")}
          </Text>
        ) : null}
        {state.removalUnknownId ? (
          <Text style={styles.secondary}>
            {t("Could not confirm removal. Refresh before retrying.")}
          </Text>
        ) : null}
        {!state.loading && ready && !state.listError && !rows.length ? (
          <Text style={styles.secondary}>{t("No plugins installed")}</Text>
        ) : null}
        {rows.map((row) => (
          <View key={row.id} accessibilityLabel={row.name} style={styles.card}>
            <Text style={styles.heading}>{row.name}</Text>
            <Text style={styles.secondary}>
              {row.status === "cleanup_failed"
                ? t("Cleanup incomplete")
                : row.status === "uninstalling"
                  ? t("Removing…")
                  : row.status === "installing"
                    ? t("Installation pending.")
                    : row.status === "failed"
                      ? t("Installation failed.")
                      : t("Installed")}
            </Text>
            <Text selectable style={styles.metadata}>
              {row.source}
            </Text>
            {row.mcpServers.map((server) => (
              <Text key={server.id} selectable style={styles.metadata}>
                {server.name} · {server.endpoint}
              </Text>
            ))}
            <View style={styles.actions}>
              <NativeActionButton
                label={
                  state.removingId === row.id
                    ? t("Removing…")
                    : row.status === "cleanup_failed" || row.status === "uninstalling"
                      ? t("Retry cleanup")
                      : removal?.id === row.id
                        ? t("Confirm removal")
                        : t("Remove plugin")
                }
                disabled={!manager.current?.canUninstall(removal?.id === row.id ? removal : row)}
                prominence="destructive"
                fill={false}
                onPress={() =>
                  row.status === "cleanup_failed" ||
                  row.status === "uninstalling" ||
                  removal?.id === row.id
                    ? void remove(removal?.id === row.id ? removal : row)
                    : setRemoval(row)
                }
              />
              {removal?.id === row.id ? (
                <NativeActionButton
                  label={t("Cancel")}
                  prominence="quiet"
                  onPress={() => setRemoval(null)}
                />
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 16, gap: 16 },
    card: { padding: 16, gap: 12, borderRadius: 16, backgroundColor: native.fill },
    section: { gap: 10 },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    input: {
      minHeight: 48,
      paddingHorizontal: 12,
      borderRadius: 10,
      backgroundColor: native.fillPressed,
      color: native.label,
      fontSize: 15,
    },
    heading: { fontSize: 16, fontWeight: "600", color: native.label },
    title: { fontSize: 14, fontWeight: "500", color: native.label },
    secondary: { fontSize: 14, color: native.secondaryLabel },
    metadata: { fontSize: 12, color: native.secondaryLabel },
    instructions: { fontSize: 13, lineHeight: 20, color: native.label },
    error: { fontSize: 14, color: mobileTokens().destructive },
  });
}
