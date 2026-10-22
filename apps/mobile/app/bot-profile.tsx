import type { Bot, Routine } from "@rakazo/contracts";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Alert, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { glassHeaderOptions } from "../components/glass-title";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSwitch,
  useStackedSettings,
} from "../components/settings-group";
import type { MobileBot } from "../lib/api";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { ChatNotifyPermissionStatus } from "../lib/live-notifications";
import { afterChatNotifyChange, readChatNotificationPermission } from "../lib/live-notifications";
import type { MobileScope } from "../lib/mobile-scope";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "../lib/mobile-scope";
import { native, useThemedStyles } from "../lib/native";
import type { NotificationSettingsReturn } from "../lib/notification-settings-return";
import { createNotificationSettingsReturn } from "../lib/notification-settings-return";
import { registerPushToken } from "../lib/push";
import { deviceTimeZone, routineRowDetail, sortRoutinesByNextRun } from "../lib/routine";
import { spaceRequestContext } from "../lib/space-request-context";
import { errorText } from "../lib/user-error";

type ProfileBot = MobileBot & Pick<Bot, "description" | "spaceId">;

export default function BotProfile() {
  const params = useLocalSearchParams<{ botId?: string; name?: string; readOnly?: string }>();
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const scope = useMemo(captureMobileScope, [scopeKey]);
  return (
    <Profile
      key={JSON.stringify([scopeKey, params.botId, params.readOnly])}
      scope={scope}
      botId={params.botId ?? ""}
      nameParam={params.name}
      readOnly={params.readOnly === "1"}
    />
  );
}

function Profile({
  scope,
  botId,
  nameParam,
  readOnly,
}: {
  scope: MobileScope;
  botId: string;
  nameParam?: string;
  readOnly: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const stacked = useStackedSettings();
  const [bot, setBot] = useState<ProfileBot | null>(null);
  const [botError, setBotError] = useState<string | null>(null);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [routinesError, setRoutinesError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [permission, setPermission] = useState<ChatNotifyPermissionStatus | null>(null);
  const mounted = useRef(true);
  const focused = useRef(false);
  const lifetime = useRef(0);
  const botRequest = useRef(0);
  const routinesRequest = useRef(0);
  const notifySaves = useRef(0);
  const notifyOperation = useRef(0);
  const saveInFlight = useRef(false);
  const permissionRequest = useRef(0);
  const notificationEnabled = useRef(false);
  const settingsReturn = useRef<NotificationSettingsReturn | null>(null);
  const name = bot?.name.trim() || nameParam?.trim() || t("Bot");
  const timeZone = deviceTimeZone();
  const current = useCallback(
    () => mounted.current && focused.current && isMobileScopeCurrent(scope),
    [scope],
  );
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      settingsReturn.current?.cancel();
    };
  }, []);

  const loadBot = useCallback(async () => {
    const request = ++botRequest.current;
    const epoch = lifetime.current;
    const saves = notifySaves.current;
    const eligible = () =>
      current() && epoch === lifetime.current && request === botRequest.current;
    if (!eligible() || !botId) return;
    try {
      const requestContext = await spaceRequestContext(scope, eligible);
      if (!eligible()) return;
      const next = readOnly
        ? (await rpc<ProfileBot[]>("bots/listArchived", {}, { requestContext })).find(
            (row) => row.id === botId,
          )
        : await rpc<ProfileBot>("bots/get", { botId }, { requestContext });
      if (!eligible()) return;
      if (
        !next ||
        next.id !== botId ||
        next.spaceId !== requestContext.headers["x-rakazo-space-id"]
      )
        throw new Error(t("Could not load bot"));
      const overlapped = saves % 2 === 1 || saves !== notifySaves.current;
      if (!overlapped) {
        notificationEnabled.current = next.notifyOnFinish;
        if (!next.notifyOnFinish) settingsReturn.current?.cancel();
      }
      setBot((shown) =>
        overlapped && shown ? { ...next, notifyOnFinish: shown.notifyOnFinish } : next,
      );
      setBotError(null);
    } catch (error) {
      if (eligible()) setBotError(errorText(error, t("Could not load bot")));
    }
  }, [botId, current, readOnly, scope, t]);

  const loadRoutines = useCallback(async () => {
    const request = ++routinesRequest.current;
    const epoch = lifetime.current;
    const eligible = () =>
      current() && epoch === lifetime.current && request === routinesRequest.current;
    if (!eligible() || !botId) return;
    try {
      const requestContext = await spaceRequestContext(scope, eligible);
      if (!eligible()) return;
      const next = await rpc<Routine[]>("routines/list", { botId }, { requestContext });
      if (!eligible()) return;
      setRoutines(sortRoutinesByNextRun(next));
      setRoutinesError(null);
    } catch (error) {
      if (eligible()) setRoutinesError(errorText(error, t("Could not load routines")));
    }
  }, [botId, current, scope, t]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      lifetime.current += 1;
      void loadBot();
      void loadRoutines();
      settingsReturn.current?.focus();
      return () => {
        focused.current = false;
        settingsReturn.current?.blur();
        lifetime.current += 1;
        botRequest.current += 1;
        routinesRequest.current += 1;
      };
    }, [loadBot, loadRoutines]),
  );

  async function setNotifyOnFinish(notifyOnFinish: boolean) {
    if (!bot || readOnly || saveInFlight.current || !current()) return;
    const epoch = lifetime.current;
    const operation = ++notifyOperation.current;
    const eligible = () =>
      current() && epoch === lifetime.current && operation === notifyOperation.current;
    const previous = bot.notifyOnFinish;
    settingsReturn.current?.cancel();
    settingsReturn.current = null;
    notificationEnabled.current = notifyOnFinish;
    saveInFlight.current = true;
    setPending(true);
    notifySaves.current += 1;
    setBot({ ...bot, notifyOnFinish });
    setPermission(null);
    permissionRequest.current += 1;
    let saved = false;
    try {
      const context = await spaceRequestContext(scope, eligible, bot.spaceId);
      if (!eligible()) return;
      const spaceId = context.headers["x-rakazo-space-id"];
      if (spaceId !== bot.spaceId) throw new Error(t("Could not update notifications"));
      const requestContext = context;
      await rpc("bots/update", { botId, notifyOnFinish }, { requestContext });
      saved = true;
      if (!eligible()) return;
      const bearer = requestContext.headers.authorization;
      const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : "";
      const status = await afterChatNotifyChange({
        botId,
        threadId: bot.threadId,
        notifyOnFinish,
        apiBase: context.apiBase,
        token,
        spaceId: spaceId ?? "",
        isCurrent: eligible,
        onAllowed: () =>
          registerPushToken({ permission: "allowed", requestContext, isCurrent: eligible }),
      });
      if (eligible()) setPermission(status);
    } catch (error) {
      if (!eligible()) {
        if (!saved && current() && operation === notifyOperation.current) {
          notificationEnabled.current = previous;
          setBot((shown) => shown && { ...shown, notifyOnFinish: previous });
        }
        return;
      }
      if (saved) setPermission(notifyOnFinish ? "unknown" : null);
      else {
        notificationEnabled.current = previous;
        setBot((shown) => shown && { ...shown, notifyOnFinish: previous });
        Alert.alert(t("Could not update notifications"), errorText(error, t("Try again.")));
      }
    } finally {
      notifySaves.current += 1;
      saveInFlight.current = false;
      if (mounted.current && operation === notifyOperation.current) {
        setPending(false);
      }
    }
  }

  const shownNotifyOperation = notifyOperation.current;
  function permissionAction() {
    if (
      !current() ||
      readOnly ||
      pending ||
      !bot?.notifyOnFinish ||
      shownNotifyOperation !== notifyOperation.current
    )
      return;
    const epoch = lifetime.current;
    const request = ++permissionRequest.current;
    settingsReturn.current?.cancel();
    settingsReturn.current = null;
    const eligible = () =>
      current() &&
      epoch === lifetime.current &&
      request === permissionRequest.current &&
      !saveInFlight.current;
    if (permission === "denied") {
      const operation = notifyOperation.current;
      const ownerCurrent = () =>
        mounted.current &&
        isMobileScopeCurrent(scope) &&
        operation === notifyOperation.current &&
        request === permissionRequest.current &&
        notificationEnabled.current &&
        !readOnly &&
        !saveInFlight.current;
      const visit = createNotificationSettingsReturn({
        isCurrent: ownerCurrent,
        isFocused: () => focused.current,
        onPermission: setPermission,
        onAllowed: async (queryIsCurrent) => {
          const requestContext = await spaceRequestContext(scope, queryIsCurrent, bot.spaceId);
          if (!queryIsCurrent()) return;
          await registerPushToken({
            permission: "allowed",
            requestContext,
            isCurrent: queryIsCurrent,
          });
        },
      });
      settingsReturn.current = visit;
      void visit.open().catch((error) => {
        if (ownerCurrent() && focused.current)
          Alert.alert(t("Settings"), errorText(error, t("Try again.")));
      });
    } else {
      void readChatNotificationPermission(eligible)
        .then((status) => {
          if (eligible()) setPermission(status);
        })
        .catch(() => {
          if (eligible()) setPermission("unknown");
        });
    }
  }

  const history = readOnly ? { readOnly: "1" } : {};
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, stacked && styles.compactContent]}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen
        options={{
          ...glassHeaderOptions(name),
          ...(Platform.OS === "ios" ? { headerTitle: "" } : null),
        }}
      />
      <View style={styles.identity}>
        {bot ? (
          <BotAvatar color={bot.color} identity={bot.id} size={96} status={bot.status} />
        ) : (
          <View style={styles.avatarSpace} />
        )}
        <Text accessibilityRole="header" style={styles.name}>
          {name}
        </Text>
        {bot?.title ? <Text style={styles.title}>{bot.title}</Text> : null}
        {bot?.description ? <Text style={styles.title}>{bot.description}</Text> : null}
      </View>
      {botError ? (
        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            title={botError}
            detail={t("Try again.")}
            onPress={() => void loadBot()}
          />
        </SettingsGroup>
      ) : null}
      {bot ? (
        <SettingsGroup>
          {!readOnly ? (
            <SettingsRow
              accessibilityRole="button"
              title={t("Chat settings")}
              chevron="right"
              onPress={() => {
                if (current()) router.push({ pathname: "/bot-settings", params: { botId } });
              }}
            />
          ) : null}
          <SettingsRow
            accessibilityRole="button"
            title={t("Artifacts")}
            chevron="right"
            onPress={() => {
              if (current()) router.push({ pathname: "/artifacts", params: { botId, ...history } });
            }}
          />
          {!readOnly ? (
            <SettingsRow
              accessibilityRole="button"
              title={t("Computer")}
              chevron="right"
              onPress={() => {
                if (current()) router.push({ pathname: "/computer", params: { botId, name } });
              }}
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      <SettingsGroup label={t("Routines")}>
        {routinesError ? (
          <SettingsRow
            accessibilityRole="button"
            title={routinesError}
            detail={t("Try again.")}
            onPress={() => void loadRoutines()}
          />
        ) : (
          routines?.map((routine) => (
            <SettingsRow
              accessibilityRole="button"
              key={routine.id}
              title={routine.name}
              detail={routineRowDetail(routine, timeZone)}
              chevron="right"
              onPress={() => {
                if (current())
                  router.push({
                    pathname: "/routine",
                    params: {
                      botId,
                      botName: name,
                      routineId: routine.id,
                      origin: "profile",
                      ...history,
                    },
                  });
              }}
            />
          ))
        )}
      </SettingsGroup>
      {bot ? (
        <SettingsGroup footer={t("Get notified when this Bot finishes or needs input")}>
          <SettingsSwitch
            label={t("Notifications")}
            value={bot.notifyOnFinish}
            disabled={pending || readOnly}
            onChange={(value) => void setNotifyOnFinish(value)}
          />
          {!readOnly &&
          bot.notifyOnFinish &&
          (permission === "denied" || permission === "unknown") ? (
            <SettingsRow
              accessibilityRole="button"
              title={
                permission === "denied"
                  ? t("Notifications are blocked in system settings.")
                  : t("Could not check notification permission.")
              }
              detail={permission === "denied" ? t("Settings") : t("Retry")}
              disabled={pending}
              onPress={permissionAction}
            />
          ) : null}
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 28 },
    compactContent: { paddingHorizontal: 8 },
    identity: { alignItems: "center", gap: 8 },
    avatarSpace: { width: 96, height: 96 },
    name: { color: native.label, fontSize: 22, fontWeight: "600", textAlign: "center" },
    title: { color: native.secondaryLabel, fontSize: 15, textAlign: "center" },
  });
}
