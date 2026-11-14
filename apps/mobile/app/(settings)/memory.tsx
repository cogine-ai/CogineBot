import type { createSemanticMemorySettings, SemanticMemoryScope } from "@rakazo/core";
import { serenityConnectionDraft, supermemoryConnectionDraft } from "@rakazo/core";
import { useLocalSearchParams } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MenuPicker } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSwitch } from "../../components/native-switch";
import { useI18n } from "../../lib/i18n";
import { native, useMobileTokens, useThemedStyles } from "../../lib/native";
import { useSemanticMemorySession } from "../../lib/semantic-memory-settings";

type Session = ReturnType<typeof createSemanticMemorySettings>;

export default function MemorySettings() {
  const params = useLocalSearchParams<{ spaceId?: string; botId?: string }>();
  const bound = useSemanticMemorySession(
    typeof params.spaceId === "string" ? params.spaceId : undefined,
    typeof params.botId === "string" ? params.botId : undefined,
  );
  return bound ? <MemoryContent key={bound.id} session={bound.session} /> : null;
}

export function MemoryContent({ session }: { session: Session }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const data = state.data;
  const config = data?.config;
  const scopes = [
    { key: "isolated", label: t("Isolated") },
    { key: "shared", label: t("Shared") },
  ];
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {state.error ? (
          <View style={styles.card}>
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {t("Couldn't update memory settings. Reload to check the current state.")}
            </Text>
            <NativeActionButton
              label={t("Retry")}
              disabled={state.busy}
              onPress={() => void session.refresh()}
            />
          </View>
        ) : !data ? (
          <Text style={styles.text}>{t("Loading…")}</Text>
        ) : (
          <>
            <View style={styles.card}>
              {config ? (
                <>
                  <Text style={styles.text}>
                    {config.provider === "supermemory"
                      ? "Supermemory"
                      : config.provider === "serenity"
                        ? "Serenity"
                        : config.provider}
                  </Text>
                  <Text style={styles.secondary}>{t("Configured")}</Text>
                  <MenuPicker
                    label={t("Default scope")}
                    choices={scopes}
                    value={config.defaultMemoryScope}
                    disabled={state.busy || !data.canManage}
                    onChange={(value) => void session.setDefault(value as SemanticMemoryScope)}
                  />
                  {data.canManage ? (
                    <NativeActionButton
                      label={t("Disconnect")}
                      disabled={state.busy}
                      prominence="secondary"
                      onPress={() => void session.disconnect()}
                    />
                  ) : null}
                </>
              ) : data.canManage ? (
                <ConnectionForm session={session} busy={state.busy} />
              ) : (
                <Text style={styles.secondary}>{t("Not connected")}</Text>
              )}
            </View>
            {config && data.bot ? (
              <View style={styles.card}>
                <Text style={styles.text}>{data.bot.name}</Text>
                <MenuPicker
                  label={t("Memory scope")}
                  value={data.bot.memoryScope ?? "inherit"}
                  choices={[{ key: "inherit", label: t("Inherit default") }, ...scopes]}
                  disabled={state.busy}
                  onChange={(value) =>
                    void session.setBot(value === "inherit" ? null : (value as SemanticMemoryScope))
                  }
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ConnectionForm({ session, busy }: { session: Session; busy: boolean }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [provider, setProvider] = useState("supermemory");
  const [mode, setMode] = useState<"cloud" | "local">("cloud");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:6767");
  const [endpoint, setEndpoint] = useState("");
  const [brainLabel, setBrainLabel] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [scope, setScope] = useState<SemanticMemoryScope>("isolated");
  const input = (
    label: string,
    value: string,
    onChangeText: (value: string) => void,
    secure = false,
  ) => (
    <View style={styles.field}>
      <Text style={styles.secondary}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        editable={!busy}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        style={styles.input}
      />
    </View>
  );
  async function connect() {
    const draft =
      provider === "supermemory"
        ? supermemoryConnectionDraft({ mode, baseUrl, apiKey: secret })
        : serenityConnectionDraft({ endpoint, token: secret, brainLabel, allowWrites });
    if ("ok" in draft && !draft.ok) return;
    const connection = "ok" in draft ? draft.draft : draft;
    // Keep credentials only in the secure input and request; never display upstream errors.
    setSecret("");
    await session.connect({ provider, ...connection, defaultMemoryScope: scope });
  }
  return (
    <>
      <MenuPicker
        label={t("Provider")}
        value={provider}
        choices={[
          { key: "supermemory", label: "Supermemory" },
          { key: "serenity", label: "Serenity" },
        ]}
        disabled={busy}
        onChange={(value) => {
          setProvider(value);
          setSecret("");
        }}
      />
      <MenuPicker
        label={t("Default scope")}
        value={scope}
        choices={[
          { key: "isolated", label: t("Isolated") },
          { key: "shared", label: t("Shared") },
        ]}
        disabled={busy}
        onChange={(value) => setScope(value as SemanticMemoryScope)}
      />
      {provider === "supermemory" ? (
        <>
          <MenuPicker
            label={t("Connection")}
            value={mode}
            choices={[
              { key: "cloud", label: t("Cloud") },
              { key: "local", label: t("Local") },
            ]}
            disabled={busy}
            onChange={(value) => {
              setMode(value as "cloud" | "local");
              setSecret("");
            }}
          />
          {mode === "local" ? input(t("Base URL"), baseUrl, setBaseUrl) : null}
          {input(
            mode === "cloud" ? t("Organization API key") : t("Instance API key"),
            secret,
            setSecret,
            true,
          )}
        </>
      ) : (
        <>
          {input(t("MCP endpoint"), endpoint, setEndpoint)}
          {input(t("Bearer token"), secret, setSecret, true)}
          {input(t("Brain label"), brainLabel, setBrainLabel)}
          <View style={styles.row}>
            <Text style={styles.text}>{t("Allow writing")}</Text>
            <NativeSwitch
              accessibilityLabel={t("Allow writing")}
              value={allowWrites}
              onValueChange={setAllowWrites}
              disabled={busy}
            />
          </View>
        </>
      )}
      <NativeActionButton
        label={busy ? t("Connecting…") : t("Connect")}
        disabled={
          busy ||
          secret.trim().length < 8 ||
          (provider === "serenity" ? !endpoint.trim() : mode === "local" && !baseUrl.trim())
        }
        onPress={() => void connect()}
      />
    </>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 16 },
    card: { padding: 16, gap: 12, borderRadius: 16, backgroundColor: native.fill },
    field: { gap: 6 },
    text: { color: native.label, fontSize: 15 },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    input: {
      minHeight: 48,
      color: native.label,
      backgroundColor: native.fillPressed,
      borderRadius: 12,
      padding: 12,
      fontSize: 15,
    },
  });
}
