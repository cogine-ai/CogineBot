import type { IntegrationSetupState } from "@rakazo/contracts";
import type { PluginDiscoveryState, PluginServerSetupState } from "@rakazo/core";
import {
  createPluginDiscovery,
  createPluginServerSetup,
  initialPluginDiscovery,
  initialPluginServerSetup,
} from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import { Linking, StyleSheet, Text, TextInput, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

export type PluginRequests = {
  request<T>(procedure: string, input: unknown, signal: AbortSignal): Promise<T>;
  isCurrent(): boolean;
};

export function PluginDiscovery({
  client,
  disabled,
  onPreview,
}: {
  client: PluginRequests;
  disabled: boolean;
  onPreview(source: string): void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<PluginDiscoveryState>(initialPluginDiscovery);
  const manager = useRef<ReturnType<typeof createPluginDiscovery> | null>(null);
  useEffect(() => {
    setQuery("");
    setState(initialPluginDiscovery);
    const discovery = createPluginDiscovery({
      search: (input, signal) => client.request("plugins/search", input, signal),
      isCurrent: client.isCurrent,
      changed: setState,
    });
    manager.current = discovery;
    return () => {
      discovery.dispose();
      manager.current = null;
    };
  }, [client]);
  const loading = state.phase === "loading" || state.phase === "loading_more";
  return (
    <View style={styles.section} testID="plugin-discovery">
      <Text style={styles.title}>{t("Discover plugins")}</Text>
      <TextInput
        accessibilityLabel={t("Search plugins")}
        placeholder={t("Search plugins")}
        value={query}
        onChangeText={setQuery}
        maxLength={200}
        editable={!disabled}
        autoCorrect={false}
        placeholderTextColor={native.tertiaryLabel}
        style={styles.input}
      />
      <NativeActionButton
        label={t("Search")}
        busy={loading}
        disabled={disabled}
        prominence="secondary"
        onPress={() => void manager.current?.search(query.trim())}
      />
      {state.error || state.unavailableRegistries.length ? (
        <>
          <Text accessibilityRole="alert" style={styles.secondary}>
            {t("Some registries are unavailable.")}
          </Text>
          <NativeActionButton
            label={t("Retry search")}
            disabled={disabled || loading}
            prominence="quiet"
            onPress={() => void manager.current?.search(state.query)}
          />
        </>
      ) : null}
      {state.phase === "ready" &&
      !state.entries.length &&
      state.unavailableRegistries.length === 0 &&
      state.error === null ? (
        <Text style={styles.secondary}>{t("No plugins found")}</Text>
      ) : null}
      {state.entries.length ? (
        <Text style={styles.secondary}>
          {t("Registry listings are discovery hints. Review the exact version before installing.")}
        </Text>
      ) : null}
      {state.entries.map((entry) => (
        <View key={entry.id} style={styles.card}>
          <Text style={styles.title}>{entry.name}</Text>
          <Text style={styles.secondary}>{entry.registry}</Text>
          <Text style={styles.secondary}>{entry.description}</Text>
          <Text selectable style={styles.metadata}>
            {entry.source}
          </Text>
          <NativeActionButton
            label={t("Preview {name}", { name: entry.name })}
            disabled={disabled}
            prominence="secondary"
            onPress={() => onPreview(entry.source)}
          />
        </View>
      ))}
      {state.nextCursor ? (
        <NativeActionButton
          label={t("Show more")}
          disabled={disabled || loading}
          prominence="quiet"
          onPress={() => void manager.current?.loadMore()}
        />
      ) : null}
    </View>
  );
}

export async function authorizeMobilePluginMcp(client: PluginRequests, signal: AbortSignal) {
  const setup = await client.request<IntegrationSetupState>("integrationSetup/get", {}, signal);
  if (signal.aborted || !client.isCurrent()) return "cancelled" as const;
  if (!setup.webUrl) throw new Error("Could not open sign-in.");
  const webUrl = new URL(setup.webUrl);
  if (!["https:", "http:"].includes(webUrl.protocol) || webUrl.username || webUrl.password)
    throw new Error("Could not open sign-in.");
  // The system browser has its own session. Start and finish authorization in the web app.
  await Linking.openURL(new URL("/app", webUrl).toString());
  if (signal.aborted || !client.isCurrent()) return "cancelled" as const;
  return "pending" as const;
}

export function PluginServerSetup({
  client,
  serverId,
  onToolAccess,
  disabled = false,
}: {
  client: PluginRequests;
  serverId: string;
  onToolAccess(): void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [state, setState] = useState<PluginServerSetupState>(initialPluginServerSetup);
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [editingHeaders, setEditingHeaders] = useState(false);
  const [addingHeader, setAddingHeader] = useState(false);
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const manager = useRef<ReturnType<typeof createPluginServerSetup> | null>(null);
  useEffect(() => {
    setHeaders({});
    setHeaderName("");
    setHeaderValue("");
    setAddingHeader(false);
    setEditingHeaders(false);
    setState(initialPluginServerSetup);
    const setup = createPluginServerSetup({
      serverId,
      list: (signal) => client.request("mcp/servers/list", {}, signal),
      save: (input, signal) => client.request("mcp/servers/update", input, signal),
      authorize: (_id, signal) => authorizeMobilePluginMcp(client, signal),
      isCurrent: client.isCurrent,
      changed: setState,
    });
    manager.current = setup;
    void setup.refresh();
    return () => {
      setup.dispose();
      manager.current = null;
    };
  }, [client, serverId]);
  const server = state.server;
  const busy =
    state.phase === "loading" || state.phase === "saving" || state.phase === "authorizing";
  const locked =
    disabled || busy || state.phase === "unknown" || state.phase === "authorization_pending";
  async function save(enabled: boolean, includeHeaders = false) {
    const headerUpdates = Object.fromEntries(
      Object.entries(includeHeaders ? headers : {}).filter(([, value]) => value.length),
    );
    if (includeHeaders && headerName.trim() && headerValue)
      headerUpdates[headerName.trim()] = headerValue;
    setHeaders({});
    setHeaderName("");
    setHeaderValue("");
    setAddingHeader(false);
    setEditingHeaders(false);
    await manager.current?.saveConnection({
      enabled,
      ...(Object.keys(headerUpdates).length ? { headerUpdates } : {}),
    });
  }
  return (
    <View testID="plugin-server-setup" style={styles.card}>
      {server ? (
        <>
          <Text style={styles.title}>{server.name}</Text>
          <Text selectable style={styles.metadata}>
            {server.endpoint}
          </Text>
          <Text style={styles.secondary}>{server.enabled ? t("Enabled") : t("Disabled")}</Text>
          {server.oauthStatus === "unknown" ? (
            <Text style={styles.secondary}>{t("Connection status unavailable.")}</Text>
          ) : null}
          {server.oauthStatus === "connected" ? (
            <Text style={styles.secondary}>{t("Connected")}</Text>
          ) : server.oauthStatus === "reconnect" ? (
            <Text style={styles.secondary}>{t("Sign-in required")}</Text>
          ) : null}
          <NativeActionButton
            label={server.headerKeys.length ? t("Edit credentials") : t("Add header")}
            disabled={locked}
            prominence="quiet"
            onPress={() => {
              setEditingHeaders((value) => !value);
              setHeaders({});
              setHeaderName("");
              setHeaderValue("");
              setAddingHeader(!server.headerKeys.length);
            }}
          />
          {editingHeaders ? (
            <View style={styles.section}>
              {server.headerKeys.map((name) => (
                <View key={name} style={styles.section}>
                  <Text style={styles.secondary}>{name}</Text>
                  <TextInput
                    accessibilityLabel={name}
                    value={headers[name] ?? ""}
                    onChangeText={(value) =>
                      setHeaders((current) => ({ ...current, [name]: value }))
                    }
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={4096}
                    editable={!locked}
                    style={styles.input}
                  />
                </View>
              ))}
              {addingHeader ? (
                <>
                  <Text style={styles.secondary}>{t("Header name")}</Text>
                  <TextInput
                    accessibilityLabel={t("Header name")}
                    value={headerName}
                    onChangeText={setHeaderName}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={120}
                    editable={!locked}
                    style={styles.input}
                  />
                  <Text style={styles.secondary}>{t("Header value")}</Text>
                  <TextInput
                    accessibilityLabel={t("Header value")}
                    value={headerValue}
                    onChangeText={setHeaderValue}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={4096}
                    editable={!locked}
                    style={styles.input}
                  />
                </>
              ) : (
                <NativeActionButton
                  label={t("Add header")}
                  disabled={locked}
                  prominence="quiet"
                  onPress={() => setAddingHeader(true)}
                />
              )}
              <Text style={styles.secondary}>{t("Leave blank to keep saved credentials.")}</Text>
              <NativeActionButton
                label={t("Save credentials")}
                disabled={
                  locked ||
                  (!Object.values(headers).some(Boolean) && !(headerName.trim() && headerValue))
                }
                prominence="secondary"
                onPress={() => void save(server.enabled, true)}
              />
            </View>
          ) : null}
          <NativeActionButton
            label={server.enabled ? t("Disable connection") : t("Enable connection")}
            disabled={locked}
            prominence="secondary"
            onPress={() => void save(!server.enabled)}
          />
          {server.enabled &&
          server.oauthStatus !== "connected" &&
          server.oauthStatus !== "unknown" ? (
            <>
              <Text style={styles.secondary}>{t("Finish MCP authorization in the web app.")}</Text>
              <NativeActionButton
                label={t("Open web app")}
                disabled={locked}
                prominence="secondary"
                onPress={() => void manager.current?.connectOAuth()}
              />
            </>
          ) : null}
          <NativeActionButton label={t("Tool access")} prominence="quiet" onPress={onToolAccess} />
        </>
      ) : null}
      {state.authorizationResult === "authorization_not_requested" ? (
        <Text style={styles.secondary}>{t("Browser authorization was not requested.")}</Text>
      ) : null}
      {state.phase === "unknown" ? (
        <Text style={styles.secondary}>{t("Could not confirm connection changes.")}</Text>
      ) : null}
      {state.phase === "authorization_pending" ? (
        <Text style={styles.secondary}>
          {t("Could not confirm sign-in. Check status or try again.")}
        </Text>
      ) : null}
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t("Could not update this connection.")}
        </Text>
      ) : null}
      <NativeActionButton
        label={t("Check status")}
        disabled={disabled || busy}
        prominence="quiet"
        onPress={() => void manager.current?.refresh()}
      />
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    section: { gap: 10 },
    card: { padding: 14, gap: 10, borderRadius: 14, backgroundColor: native.fill },
    title: { fontSize: 15, fontWeight: "600", color: native.label },
    secondary: { fontSize: 14, color: native.secondaryLabel },
    metadata: { fontSize: 12, color: native.secondaryLabel },
    error: { fontSize: 14, color: mobileTokens().destructive },
    input: {
      minHeight: 48,
      paddingHorizontal: 12,
      borderRadius: 10,
      backgroundColor: native.fillPressed,
      color: native.label,
      fontSize: 15,
    },
  });
}
