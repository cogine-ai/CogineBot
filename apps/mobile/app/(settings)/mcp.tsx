import type { IntegrationSetupState, McpServer } from "@rakazo/contracts";
import { Stack, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, Linking, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { MenuPicker } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSwitch } from "../../components/native-switch";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import type { IntegrationsCacheScope } from "../../lib/integrations-cache";
import { integrationsCacheScope, isIntegrationsScopeCurrent } from "../../lib/integrations-cache";
import { native, useThemedStyles } from "../../lib/native";
import { errorText } from "../../lib/user-error";

export default function McpSettings() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [selected, setSelected] = useState<McpServer | null>(null);
  const [all, setAll] = useState(false);
  const [names, setNames] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const scope = useRef<IntegrationsCacheScope | null>(null);
  const active = useRef(false);
  function isCurrent() {
    return active.current && !!scope.current && isIntegrationsScopeCurrent(scope.current);
  }
  function select(server: McpServer) {
    setSelected(server);
    setAll(server.allowAllTools);
    setNames(server.allowedTools.join("\n"));
    setSaved(false);
    setError(null);
  }
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      let cancelled = false;
      setServers([]);
      setSelected(null);
      setError(null);
      setBusy(false);
      setSaved(false);
      void (async () => {
        try {
          const current = await integrationsCacheScope();
          if (cancelled || !isIntegrationsScopeCurrent(current)) return;
          scope.current = current;
          const rows = await rpc<McpServer[]>("mcp/servers/list");
          if (!cancelled && isCurrent()) setServers(rows);
        } catch (reason) {
          if (!cancelled && active.current)
            setError(errorText(reason, t("Could not load MCP servers")));
        }
      })();
      return () => {
        cancelled = true;
        active.current = false;
        scope.current = null;
      };
    }, []),
  );
  const changed =
    !!selected &&
    servers.find((server) => server.id === selected.id)?.revision !== selected.revision;
  async function save() {
    if (!selected || changed || !isCurrent()) return;
    const requestScope = scope.current;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await rpc<McpServer>("mcp/servers/setTools", {
        id: selected.id,
        revision: selected.revision,
        allowAllTools: all,
        allowedTools: all
          ? []
          : [
              ...new Set(
                names
                  .split(/\r?\n/)
                  .map((name) => name.trim())
                  .filter(Boolean),
              ),
            ],
      });
      if (!isCurrent() || scope.current !== requestScope) return;
      setServers((rows) => rows.map((server) => (server.id === next.id ? next : server)));
      select(next);
      setSaved(true);
    } catch (reason) {
      if (isCurrent() && scope.current === requestScope)
        setError(errorText(reason, t("Could not save tool access")));
    } finally {
      if (isCurrent() && scope.current === requestScope) setBusy(false);
    }
  }
  async function openWeb() {
    if (!isCurrent()) return;
    const requestScope = scope.current;
    try {
      const setup = await rpc<IntegrationSetupState>("integrationSetup/get");
      if (!isCurrent() || scope.current !== requestScope) return;
      if (setup.webUrl) await Linking.openURL(setup.webUrl);
      else
        Alert.alert(
          t("MCP servers"),
          t("Open the web app to manage server configuration and OAuth."),
        );
    } catch (reason) {
      if (isCurrent() && scope.current === requestScope)
        setError(errorText(reason, t("Could not load integrations")));
    }
  }
  async function reload() {
    if (!active.current) return;
    setError(null);
    try {
      const current = await integrationsCacheScope();
      if (!active.current || !isIntegrationsScopeCurrent(current)) return;
      scope.current = current;
      const requestScope = current;
      const rows = await rpc<McpServer[]>("mcp/servers/list");
      if (!isCurrent() || scope.current !== requestScope) return;
      setServers(rows);
      const server = rows.find((row) => row.id === selected?.id);
      if (server) select(server);
      else setSelected(null);
    } catch (reason) {
      if (active.current) setError(errorText(reason, t("Could not load MCP servers")));
    }
  }
  return (
    <>
      <Stack.Screen options={{ title: t("MCP servers") }} />
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {servers.length && !busy ? (
          <MenuPicker
            label={t("MCP server")}
            value={selected?.id ?? ""}
            choices={[
              { key: "", label: t("Choose a server") },
              ...servers.map((server) => ({ key: server.id, label: server.name })),
            ]}
            onChange={(id) => {
              const server = servers.find((row) => row.id === id);
              if (server) select(server);
              else setSelected(null);
            }}
          />
        ) : (
          <Text style={styles.secondary}>{busy ? selected?.name : t("No MCP servers yet.")}</Text>
        )}
        {selected ? (
          <View style={styles.card}>
            <Text style={styles.title}>{selected.name}</Text>
            <Text style={styles.secondary}>
              {selected.transport} · {selected.endpoint ?? selected.command ?? selected.slug}
            </Text>
            <Text style={styles.secondary}>
              {selected.oauthStatus === "connected"
                ? t("OAuth connected")
                : selected.oauthStatus === "reconnect"
                  ? t("OAuth expired")
                  : selected.hasSecret
                    ? t("Credential saved")
                    : t("No OAuth connection")}
            </Text>
            <View style={styles.switchRow}>
              <Text style={styles.grow}>{t("Share all tools with this space")}</Text>
              <NativeSwitch
                accessibilityLabel={t("Share all tools with this space")}
                value={all}
                disabled={busy}
                onValueChange={(value) => {
                  setAll(value);
                  setSaved(false);
                }}
              />
            </View>
            {!all ? (
              <>
                <Text style={styles.secondary}>{t("Tool names, one per line")}</Text>
                <TextInput
                  accessibilityLabel={t("Tool names, one per line")}
                  value={names}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  onChangeText={(value) => {
                    setNames(value);
                    setSaved(false);
                  }}
                  style={styles.input}
                />
              </>
            ) : null}
            {changed ? (
              <Text style={styles.error}>{t("Server changed. Reload settings to review it.")}</Text>
            ) : null}
            {saved ? <Text style={styles.secondary}>{t("Tool access saved.")}</Text> : null}
            <NativeActionButton
              label={t("Save tool access")}
              disabled={busy || changed}
              onPress={() => void save()}
            />
          </View>
        ) : null}
        <NativeActionButton
          label={t("Reload settings")}
          disabled={busy}
          prominence="secondary"
          onPress={() => void reload()}
        />
        <NativeActionButton
          label={t("Server configuration and OAuth")}
          disabled={busy}
          prominence="secondary"
          onPress={() => void openWeb()}
        />
      </ScrollView>
    </>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    content: { padding: 20, gap: 16, backgroundColor: native.page },
    card: { padding: 16, borderRadius: 16, gap: 14, backgroundColor: native.fill },
    title: { color: native.label, fontSize: 17, fontWeight: "600" },
    secondary: { color: native.secondaryLabel, fontSize: 14 },
    error: { color: tokens.destructive, fontSize: 14 },
    switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    grow: { flex: 1, color: native.label },
    input: {
      color: native.label,
      backgroundColor: native.fillPressed,
      minHeight: 120,
      padding: 12,
      borderRadius: 12,
      textAlignVertical: "top",
    },
  });
}
