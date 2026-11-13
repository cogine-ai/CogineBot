import type { McpServer, McpTransport } from "@rakazo/contracts";
import type {
  McpAuthorizationResult,
  McpManagement,
  McpManagementState,
  McpServerDraft,
} from "@rakazo/core";
import {
  authorizeMcp,
  createMcpManagement,
  emptyMcpServerDraft,
  initialMcpManagementState,
} from "@rakazo/core";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { MenuPicker } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSwitch } from "../../components/native-switch";
import { captureApiRequestContext, rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { openMcpBrowser } from "../../lib/mcp-browser";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  subscribeMobileScope,
} from "../../lib/mobile-scope";
import { native, useThemedStyles } from "../../lib/native";

export default function McpSettings() {
  const { t } = useI18n();
  const { serverId } = useLocalSearchParams<{ serverId?: string }>();
  const styles = useThemedStyles(createStyles);
  const [state, setState] = useState<McpManagementState>(initialMcpManagementState);
  const [draft, setDraft] = useState(emptyMcpServerDraft);
  const [adding, setAdding] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [selected, setSelected] = useState<McpServer | null>(null);
  const [all, setAll] = useState(false);
  const [names, setNames] = useState("");
  const [verbatimResults, setVerbatimResults] = useState(false);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<McpAuthorizationResult | null>(null);
  const [retry, setRetry] = useState(0);
  const manager = useRef<McpManagement | null>(null);
  const selectedInitial = useRef(false);
  const authorize = useRef<((id: string) => Promise<void>) | null>(null);
  const select = useCallback((server: McpServer | null) => {
    setSelected(server);
    setAll(server?.allowAllTools ?? false);
    setNames(server?.allowedTools.join("\n") ?? "");
    setVerbatimResults(server?.verbatimResults ?? false);
    setSaved(false);
    setNotice(null);
  }, []);
  useFocusEffect(
    useCallback(() => {
      let focused = true;
      let closeOwner = () => {};
      function start() {
        closeOwner();
        const scope = captureMobileScope();
        let active = true;
        const isCurrent = () => focused && active && isMobileScopeCurrent(scope);
        let review: McpManagement | null = null;
        selectedInitial.current = false;
        setState(initialMcpManagementState());
        setDraft(emptyMcpServerDraft());
        setAdding(false);
        setAdvanced(false);
        select(null);
        closeOwner = () => {
          active = false;
          review?.dispose();
          if (manager.current === review) manager.current = null;
          authorize.current = null;
        };
        void captureApiRequestContext(scope.spaceId)
          .then(async (context) => {
            if (!isCurrent()) return;
            const me = await rpc<{ userId: string; spaceId: string }>(
              "me",
              {},
              { requestContext: { ...context, isCurrent }, skipSpaceAuthRecovery: true },
            );
            if (!isCurrent()) return;
            if (!me.userId || !me.spaceId) throw new Error("Missing scope");
            const requestContext = {
              ...context,
              isCurrent,
              headers: { ...context.headers, "x-rakazo-space-id": scope.spaceId || me.spaceId },
            };
            const request = <T,>(procedure: string, input: unknown, signal: AbortSignal) =>
              rpc<T>(procedure, input, {
                signal,
                timeoutMs: 35_000,
                requestContext,
                skipSpaceAuthRecovery: true,
              });
            review = createMcpManagement({ request, isCurrent, changed: setState });
            manager.current = review;
            authorize.current = async (id) => {
              setNotice(null);
              await review?.authorize(async (signal) => {
                const result = await authorizeMcp({
                  serverId: id,
                  request,
                  open: openMcpBrowser,
                  signal,
                  isCurrent,
                });
                if (isCurrent()) setNotice(result);
              });
            };
            await review.refresh();
          })
          .catch(() => {
            if (isCurrent()) setState((value) => ({ ...value, error: "read" }));
          });
      }
      start();
      const unsubscribe = subscribeMobileScope(start);
      return () => {
        focused = false;
        unsubscribe();
        closeOwner();
      };
    }, [retry, select]),
  );
  useEffect(() => {
    if (state.recovered) {
      select(state.recovered);
      setDraft(emptyMcpServerDraft());
      setAdding(false);
      setAdvanced(false);
    }
  }, [state.recovered, select]);
  useEffect(() => {
    if (state.fresh && !selectedInitial.current) {
      selectedInitial.current = true;
      if (serverId) select(state.servers.find((row) => row.id === serverId) ?? null);
    }
  }, [state.fresh, state.servers, serverId, select]);
  useEffect(() => {
    if (state.fresh && selected && !state.servers.some((row) => row.id === selected.id))
      select(null);
  }, [state.fresh, state.servers, selected, select]);
  const currentServer = state.servers.find((row) => row.id === selected?.id);
  const changed = !!selected && currentServer?.revision !== selected.revision;
  const locked = state.writing || state.loading || !state.fresh;
  const writeLocked = locked || state.pendingCreate;
  function field(key: keyof McpServerDraft, label: string, secret = false) {
    return (
      <TextInput
        accessibilityLabel={label}
        placeholder={label}
        value={String(draft[key])}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!locked && !state.pendingCreate}
        onChangeText={(value) => setDraft((previous) => ({ ...previous, [key]: value }))}
        style={styles.input}
      />
    );
  }
  function toggle(
    label: string,
    value: boolean,
    onValueChange: (value: boolean) => void,
    disabled: boolean,
  ) {
    return (
      <View style={styles.switchRow}>
        <Text style={styles.grow}>{label}</Text>
        <NativeSwitch
          accessibilityLabel={label}
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
        />
      </View>
    );
  }
  async function save() {
    const owner = manager.current;
    if (!owner || !selected || changed || writeLocked) return;
    setSaved(false);
    const result = await owner.write<McpServer>("mcp/servers/setTools", {
      id: selected.id,
      revision: selected.revision,
      allowAllTools: all,
      verbatimResults,
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
    if (result && manager.current === owner) {
      select(result);
      setSaved(true);
    }
  }
  function remove() {
    if (!selected || writeLocked) return;
    const server = selected;
    const owner = manager.current;
    Alert.alert(t("Remove MCP server?"), server.name, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Remove"),
        style: "destructive",
        onPress: () => {
          if (manager.current !== owner) return;
          void owner?.write("mcp/servers/remove", { id: server.id });
        },
      },
    ]);
  }
  const oauthServer = currentServer ?? selected;
  return (
    <>
      <Stack.Screen options={{ title: t("MCP servers") }} />
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {state.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {state.error === "read"
              ? t("Could not load MCP servers")
              : state.error === "invalid"
                ? t("Check the server fields.")
                : t("Could not update MCP server. Check status and retry.")}
          </Text>
        ) : null}
        {state.pendingCreate ? (
          <Text style={styles.secondary}>{t("Check status before retrying this server.")}</Text>
        ) : null}
        <NativeActionButton
          label={state.error || !state.fresh ? t("Retry") : t("Reload settings")}
          disabled={state.writing}
          prominence="secondary"
          onPress={() => {
            if (manager.current) void manager.current.refresh();
            else setRetry((value) => value + 1);
          }}
        />
        {state.servers.length ? (
          <MenuPicker
            label={t("MCP server")}
            value={selected?.id ?? ""}
            choices={[
              { key: "", label: t("Choose a server") },
              ...state.servers.map((server) => ({ key: server.id, label: server.name })),
            ]}
            onChange={(id) => {
              if (!writeLocked) select(state.servers.find((row) => row.id === id) ?? null);
            }}
          />
        ) : state.fresh ? (
          <Text style={styles.secondary}>{t("No MCP servers yet.")}</Text>
        ) : null}
        {selected ? (
          <View style={styles.card}>
            <Text style={styles.title}>{selected.name}</Text>
            <Text style={styles.secondary}>{selected.transport}</Text>
            <Text style={styles.secondary}>
              {oauthServer?.oauthStatus === "unknown"
                ? t("Connection status unavailable.")
                : oauthServer?.oauthStatus === "connected"
                  ? t("OAuth connected")
                  : oauthServer?.oauthStatus === "reconnect"
                    ? t("OAuth expired")
                    : oauthServer?.hasSecret
                      ? t("Credential saved")
                      : t("No OAuth connection")}
            </Text>
            {selected.allowedTools.map((name) => (
              <Text key={name} style={styles.secondary}>
                {name}
              </Text>
            ))}
            {toggle(
              t("Keep tool results whole"),
              verbatimResults,
              (value) => {
                setVerbatimResults(value);
                setSaved(false);
              },
              writeLocked,
            )}
            {toggle(
              t("Share all tools with this space"),
              all,
              (value) => {
                setAll(value);
                setSaved(false);
              },
              writeLocked,
            )}
            {!all ? (
              <TextInput
                accessibilityLabel={t("Tool names, one per line")}
                placeholder={t("Tool names, one per line")}
                value={names}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                editable={!writeLocked}
                onChangeText={(value) => {
                  setNames(value);
                  setSaved(false);
                }}
                style={[styles.input, styles.multiline]}
              />
            ) : null}
            {changed ? (
              <>
                <Text style={styles.error}>
                  {t("Server changed. Reload settings to review it.")}
                </Text>
                <NativeActionButton
                  label={t("Review tool access")}
                  disabled={writeLocked}
                  onPress={() => select(currentServer ?? null)}
                />
              </>
            ) : null}
            {saved ? <Text style={styles.secondary}>{t("Tool access saved.")}</Text> : null}
            <NativeActionButton
              label={t("Save tool access")}
              disabled={writeLocked || changed}
              onPress={() => void save()}
            />
            {selected.transport !== "stdio" ? (
              <>
                <NativeActionButton
                  label={
                    oauthServer?.oauthStatus === "unknown"
                      ? t("Check status")
                      : oauthServer?.oauthStatus === "none"
                        ? t("Connect OAuth")
                        : t("Reconnect OAuth")
                  }
                  disabled={writeLocked || !currentServer}
                  onPress={() => {
                    if (oauthServer?.oauthStatus === "unknown") void manager.current?.refresh();
                    else void authorize.current?.(selected.id);
                  }}
                />
                {oauthServer?.oauthStatus === "connected" ||
                oauthServer?.oauthStatus === "reconnect" ? (
                  <NativeActionButton
                    label={t("Disconnect")}
                    disabled={writeLocked}
                    prominence="secondary"
                    onPress={() => {
                      setNotice(null);
                      void manager.current?.write("mcp/oauth/disconnect", {
                        serverId: selected.id,
                      });
                    }}
                  />
                ) : null}
              </>
            ) : null}
            {notice && notice !== "connected" ? (
              <Text style={styles.secondary}>
                {notice === "disconnect_required"
                  ? t("Disconnect OAuth before authorizing from another app.")
                  : notice === "already_connected"
                    ? t("This server is already connected. Disconnect it first to authorize again.")
                    : notice === "authorization_not_requested"
                      ? t("This server did not request browser authorization.")
                      : notice === "expired"
                        ? t("Authorization expired. Try again.")
                        : notice === "cancelled"
                          ? t("Authorization cancelled.")
                          : t("Authorization failed. Try again.")}
              </Text>
            ) : null}
            <NativeActionButton
              label={t("Remove")}
              disabled={writeLocked || !currentServer}
              prominence="secondary"
              onPress={remove}
            />
          </View>
        ) : null}
        {!adding ? (
          <NativeActionButton
            label={t("Add server")}
            disabled={writeLocked}
            onPress={() => setAdding(true)}
          />
        ) : (
          <View style={styles.card}>
            {field("name", t("Server name"))}
            <MenuPicker
              label={t("Transport")}
              value={draft.transport}
              choices={[
                { key: "streamable_http", label: "HTTP" },
                { key: "sse", label: "SSE" },
                { key: "stdio", label: "STDIO" },
              ]}
              onChange={(value) => {
                if (!locked && !state.pendingCreate)
                  setDraft((previous) => ({ ...previous, transport: value as McpTransport }));
              }}
            />
            {draft.transport === "stdio" ? (
              <>
                <Text style={styles.secondary}>{t("Runs on the connected instance.")}</Text>
                {field("command", t("Command"))}
                {field("args", t("Arguments"))}
              </>
            ) : (
              field("endpoint", t("Server URL"))
            )}
            <NativeActionButton
              label={t("Advanced")}
              prominence="secondary"
              onPress={() => setAdvanced((value) => !value)}
            />
            {advanced ? (
              <>
                {toggle(
                  t("Keep tool results whole"),
                  draft.verbatimResults,
                  (value) => setDraft((previous) => ({ ...previous, verbatimResults: value })),
                  locked || state.pendingCreate,
                )}
                {field("secret", t("Access token (optional)"), true)}
                {draft.transport !== "stdio" ? (
                  <>
                    {field("headerName", t("Header name"))}
                    {field("headerValue", t("Header value"), true)}
                  </>
                ) : null}
              </>
            ) : null}
            <NativeActionButton
              label={state.pendingCreate ? t("Retry") : t("Add server")}
              disabled={locked}
              onPress={() => void manager.current?.create(draft)}
            />
          </View>
        )}
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
      minHeight: 48,
      padding: 12,
      borderRadius: 12,
    },
    multiline: { minHeight: 120, textAlignVertical: "top" },
  });
}
