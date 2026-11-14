import { MenuView } from "@expo/ui/community/menu";
import type { Bot, ScratchpadItem } from "@rakazo/contracts";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "../lib/mobile-scope";
import { native, useResolvedAppearance } from "../lib/native";
import { spaceRequestContext } from "../lib/space-request-context";

export default function OpenWorkScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId?: string }>();
  const key = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const scope = useMemo(captureMobileScope, [key]);
  return <OpenWork key={JSON.stringify([key, botId])} botId={botId} scope={scope} />;
}

function OpenWork({ botId, scope }: { botId: string; scope: MobileScope }) {
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const [items, setItems] = useState<ScratchpadItem[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const generation = useRef(0);
  const reading = useRef(0);
  const saving = useRef(false);
  const space = useRef<string | undefined>(undefined);
  const current = useCallback(() => focused.current && isMobileScopeCurrent(scope), [scope]);

  const refresh = useCallback(async () => {
    const epoch = generation.current;
    const request = ++reading.current;
    const eligible = () => current() && epoch === generation.current && request === reading.current;
    if (!eligible() || !botId || saving.current) return;
    setBusy(false);
    try {
      const requestContext = await spaceRequestContext(scope, eligible, space.current);
      if (!eligible()) return;
      const bot = await rpc<Bot>("bots/get", { botId }, { requestContext });
      if (!eligible()) return;
      if (bot.id !== botId || bot.spaceId !== requestContext.headers["x-rakazo-space-id"])
        throw new Error("Invalid bot scope");
      space.current = bot.spaceId;
      const rows = await rpc<ScratchpadItem[]>("scratchpad/list", { botId }, { requestContext });
      if (!eligible()) return;
      if (rows.some((item) => item.botId !== botId)) throw new Error("Invalid item scope");
      setItems(rows);
      setError(null);
    } catch {
      if (eligible()) setError(t("Could not load open work"));
    }
  }, [botId, current, scope, t]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      generation.current += 1;
      void refresh();
      return () => {
        focused.current = false;
        generation.current += 1;
        reading.current += 1;
      };
    }, [refresh]),
  );

  async function mutate(
    action: "add" | "remove" | ScratchpadItem["status"],
    item?: ScratchpadItem,
  ) {
    if (!current() || saving.current || !space.current || items === null) return;
    if (item && !items.some((row) => row.id === item.id && row.botId === botId)) return;
    const title = draft.trim();
    if (action === "add" && (!title || title.length > 200)) return;
    const epoch = generation.current;
    const eligible = () => current() && epoch === generation.current;
    saving.current = true;
    reading.current += 1;
    setBusy(true);
    setError(null);
    try {
      const requestContext = await spaceRequestContext(scope, eligible, space.current);
      if (!eligible()) return;
      if (action === "remove" && item) {
        await rpc("scratchpad/remove", { itemId: item.id }, { requestContext });
        if (eligible()) setItems((rows) => rows?.filter((row) => row.id !== item.id) ?? null);
      } else {
        const updated =
          action === "add"
            ? await rpc<ScratchpadItem>("scratchpad/create", { botId, title }, { requestContext })
            : await rpc<ScratchpadItem>(
                "scratchpad/update",
                { itemId: item?.id, status: action },
                { requestContext },
              );
        if (!eligible()) return;
        if (updated.botId !== botId || (item && updated.id !== item.id))
          throw new Error("Invalid item scope");
        setItems((rows) => {
          const rest = (rows ?? []).filter((row) => row.id !== updated.id);
          return updated.status === "done" ? rest : [updated, ...rest];
        });
        if (action === "add") setDraft("");
      }
    } catch {
      if (eligible()) setError(t("Could not save. Refresh before trying again."));
    } finally {
      saving.current = false;
      // Returning to this same screen while a write was pending must reconcile it.
      if (current()) {
        setBusy(false);
        if (!eligible()) void refresh();
      }
    }
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={glassHeaderOptions(t("Open work"))} />
      {items === null && !error ? <ActivityIndicator /> : null}
      <SettingsGroup label={t("Open work")}>
        {items?.length === 0 ? <SettingsRow title={t("None yet")} /> : null}
        {items?.map((item) => (
          <MenuView
            key={item.id}
            title={item.title}
            colorScheme={colorScheme}
            actions={[
              { id: "done", title: t("Complete"), attributes: { disabled: busy } },
              {
                id: item.status === "parked" ? "open" : "parked",
                title: item.status === "parked" ? t("Reopen") : t("Park"),
                attributes: { disabled: busy },
              },
              {
                id: "remove",
                title: t("Remove"),
                attributes: { disabled: busy, destructive: true },
              },
            ]}
            onPressAction={({ nativeEvent }) => {
              const action = nativeEvent.event;
              if (
                action === "done" ||
                action === "open" ||
                action === "parked" ||
                action === "remove"
              )
                void mutate(action, item);
            }}
          >
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel={item.title}
              accessibilityState={{ disabled: busy }}
            >
              <SettingsRow
                title={item.title}
                detail={item.notes || undefined}
                value={item.status === "parked" ? t("Parked") : undefined}
                chevron="down"
              />
            </View>
          </MenuView>
        ))}
      </SettingsGroup>
      {items !== null ? (
        <View style={styles.composer}>
          <TextInput
            accessibilityLabel={t("New open-work item")}
            placeholder={t("Add item")}
            placeholderTextColor={native.secondaryLabel}
            value={draft}
            onChangeText={setDraft}
            maxLength={200}
            editable={!busy}
            onSubmitEditing={() => void mutate("add")}
            style={styles.input}
          />
          <NativeActionButton
            label={t("Add")}
            disabled={busy || !draft.trim()}
            onPress={() => void mutate("add")}
          />
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <NativeActionButton
        label={t("Refresh")}
        prominence="plain"
        disabled={busy}
        onPress={() => void refresh()}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: native.groupedPage },
  content: { padding: 16, gap: 16 },
  composer: { gap: 8 },
  input: {
    minHeight: 48,
    padding: 12,
    borderRadius: 12,
    color: native.label,
    backgroundColor: native.groupedCell,
    fontSize: 17,
  },
  error: { color: native.secondaryLabel, fontSize: 15 },
});
