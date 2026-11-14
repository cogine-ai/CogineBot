import type { Bot, SlackInstallationInputs, SlackInstallationOutputs } from "@rakazo/contracts";
import type { SlackWorkspace, SlackWorkspaceState } from "@rakazo/core";
import { createSlackWorkspaces } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, AppState, ScrollView, StyleSheet, Text, View } from "react-native";
import { MenuPicker } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { captureApiRequestContext, rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  subscribeMobileScope,
} from "../../lib/mobile-scope";
import { native, useThemedStyles } from "../../lib/native";

const empty: SlackWorkspaceState = {
  list: null,
  attempt: null,
  busy: false,
  readFailed: false,
  error: false,
  outcome: null,
};

export default function SlackWorkspaces() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [state, setState] = useState(empty);
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState("");
  const [botsFailed, setBotsFailed] = useState(false);
  const manager = useRef<ReturnType<typeof createSlackWorkspaces> | null>(null);
  const reload = useRef<() => Promise<void>>(async () => {});

  useFocusEffect(
    useCallback(() => {
      let live = true;
      let generation = 0;
      let stopScope: (() => void) | undefined;
      let active = AppState.currentState === "active";
      async function initialize() {
        const request = ++generation;
        manager.current?.dispose();
        manager.current = null;
        setState(empty);
        setBots([]);
        setBotId("");
        setBotsFailed(false);
        const scope = captureMobileScope();
        const current = () => live && request === generation && isMobileScopeCurrent(scope);
        try {
          const context = await captureApiRequestContext(scope.spaceId);
          if (!current()) return;
          const call = <K extends keyof SlackInstallationInputs>(
            name: K,
            input: SlackInstallationInputs[K],
          ) =>
            rpc<SlackInstallationOutputs[K]>(`messaging/installations/${name}`, input, {
              requestContext: { ...context, isCurrent: current },
              skipSpaceAuthRecovery: true,
            });
          const next = createSlackWorkspaces({
            api: {
              list: () => call("list", undefined),
              start: (input) => call("start", input),
              attempt: (input) => call("attempt", input),
              cancel: (input) => call("cancel", input),
              completeMobile: (input) => call("completeMobile", input),
              pause: (input) => call("pause", input),
              remove: (input) => call("remove", input),
            },
            current,
            changed: setState,
            openBrowser: async (url) => {
              // Load native browser code only when the user starts authorization.
              const { openAuthSessionAsync } = await import("expo-web-browser");
              if (!current()) return;
              const result = await openAuthSessionAsync(url, "coginebot://slack-workspaces");
              return result.type === "success" ? result.url : null;
            },
          });
          manager.current = next;
          let botRead = 0;
          const load = async () => {
            if (!current()) return;
            const read = ++botRead;
            await next.refresh();
            try {
              const rows = await rpc<Bot[]>(
                "bots/list",
                {},
                { requestContext: { ...context, isCurrent: current }, skipSpaceAuthRecovery: true },
              );
              if (!current() || read !== botRead) return;
              setBots(rows.filter((bot) => !bot.archivedAt));
              setBotId((id) => (rows.some((bot) => bot.id === id && !bot.archivedAt) ? id : ""));
              setBotsFailed(false);
            } catch {
              if (current() && read === botRead) setBotsFailed(true);
            }
          };
          reload.current = load;
          await load();
        } catch {
          if (current()) setState({ ...empty, readFailed: true });
        }
      }
      reload.current = initialize;
      void initialize();
      stopScope = subscribeMobileScope(() => {
        reload.current = initialize;
        void initialize();
      });
      const foreground = AppState.addEventListener("change", (value) => {
        active = value === "active";
        if (active) void reload.current();
      });
      // Poll only while this screen is focused, foregrounded and awaiting authorization.
      const timer = setInterval(() => {
        if (active && manager.current?.state().attempt) void manager.current.refresh();
      }, 2000);
      return () => {
        live = false;
        ++generation;
        stopScope?.();
        foreground.remove();
        clearInterval(timer);
        manager.current?.dispose();
        manager.current = null;
      };
    }, []),
  );

  const locked = state.busy || state.readFailed || !state.list || !!state.attempt;
  function disconnect(row: SlackWorkspace) {
    const owner = manager.current;
    Alert.alert(
      t("Disconnect Slack?"),
      t(
        "The bot will stop receiving and sending messages in this workspace. Conversation history stays in CogineBot.",
      ),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Disconnect"),
          style: "destructive",
          onPress: () => {
            if (manager.current === owner) void owner?.remove(row);
          },
        },
      ],
    );
  }
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      {state.list && !state.list.available ? (
        <Text style={styles.secondary}>{t("Slack installation is unavailable.")}</Text>
      ) : null}
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.secondary}>
          {t("Slack request unconfirmed")}
        </Text>
      ) : null}
      {state.outcome === "expired" ? (
        <Text style={styles.secondary}>{t("Slack authorization expired. Try again.")}</Text>
      ) : null}
      {state.outcome === "cancelled" ? (
        <Text style={styles.secondary}>{t("Slack authorization cancelled. Try again.")}</Text>
      ) : null}
      {state.readFailed || botsFailed ? (
        <View>
          <Text accessibilityRole="alert" style={styles.secondary}>
            {t("Couldn't load messaging settings")}
          </Text>
          <NativeActionButton
            label={t("Retry")}
            onPress={() => void reload.current()}
            disabled={state.busy}
            prominence="secondary"
          />
        </View>
      ) : null}
      {state.list?.workspaces.map((row) => (
        <View key={row.id} style={styles.card}>
          <Text style={styles.title}>{row.workspaceName}</Text>
          <Text style={styles.secondary}>
            {bots.find((bot) => bot.id === row.botId)?.name ?? t("Bot unavailable")}
          </Text>
          <Text style={styles.secondary}>
            {!state.list?.available
              ? t("Unavailable")
              : row.status === "active"
                ? t("Connected")
                : row.status === "paused"
                  ? t("Paused")
                  : row.status === "unavailable"
                    ? t("Bot unavailable")
                    : t("Reconnect required")}
          </Text>
          <NativeActionButton
            label={t("Reconnect")}
            disabled={locked || !state.list?.available || row.status === "unavailable"}
            prominence="secondary"
            onPress={() => void manager.current?.start(row.botId, row)}
          />
          {state.list?.available && (row.status === "active" || row.status === "paused") ? (
            <NativeActionButton
              label={row.status === "active" ? t("Pause") : t("Resume")}
              disabled={locked}
              prominence="secondary"
              onPress={() => void manager.current?.pause(row)}
            />
          ) : null}
          <NativeActionButton
            label={t("Disconnect")}
            disabled={locked}
            prominence="destructive"
            onPress={() => disconnect(row)}
          />
        </View>
      ))}
      {state.list?.available && !state.attempt ? (
        <View style={styles.card}>
          {!state.busy ? (
            <MenuPicker
              label={t("Bot for Slack")}
              value={botId}
              choices={[
                { key: "", label: t("Choose a bot…") },
                ...bots.map((bot) => ({ key: bot.id, label: bot.name })),
              ]}
              onChange={setBotId}
            />
          ) : null}
          <NativeActionButton
            label={t("Connect Slack")}
            disabled={locked || botsFailed || !bots.some((bot) => bot.id === botId)}
            onPress={() => void manager.current?.start(botId)}
          />
        </View>
      ) : null}
      {state.attempt ? (
        <View style={styles.card}>
          <Text style={styles.secondary}>{t("Waiting for Slack authorization")}</Text>
          <NativeActionButton
            label={t("Cancel")}
            disabled={state.busy}
            prominence="secondary"
            onPress={() => void manager.current?.cancel()}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 16 },
    card: { padding: 16, gap: 12, borderRadius: 16, backgroundColor: native.fill },
    title: { color: native.label, fontSize: 16, fontWeight: "600" },
    secondary: { color: native.secondaryLabel, fontSize: 14 },
  });
}
