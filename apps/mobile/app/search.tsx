import { botColors } from "@rakazo/ui-tokens";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import { GlassIconButton } from "../components/glass-icon-button";
import { GroupAvatar } from "../components/group-avatar";
import { NativeSymbol } from "../components/native-symbol";
import {
  currentSpaceSelectionGeneration,
  selectedSpaceId,
  selectSpace,
  spaceSelectionSeq,
} from "../lib/api";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  isMobileSessionCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "../lib/mobile-scope";
import { native, useThemedStyles } from "../lib/native";
import { useSearchInbox } from "../lib/search-inbox";
import type { SearchSheetRow } from "../lib/search-sheet";
import { searchSheetRows } from "../lib/search-sheet";
import { useSearch } from "../lib/use-search";
import { errorText } from "../lib/user-error";

const kindIcons = {
  conversation: { ios: "bubble.left.and.bubble.right", android: "chatbubbles-outline" },
  message: { ios: "bubble.left", android: "chatbubble-outline" },
  file: { ios: "doc", android: "document-outline" },
  link: { ios: "link", android: "link-outline" },
  routine: { ios: "clock.arrow.circlepath", android: "time-outline" },
} as const;

function searchSessionKey() {
  const scope = captureMobileScope();
  return JSON.stringify([scope.apiBase, scope.apiGeneration, scope.sessionGeneration]);
}

export default function SearchSheet() {
  const key = useSyncExternalStore(subscribeMobileScope, searchSessionKey, searchSessionKey);
  return <SearchSheetSession key={key} />;
}

function SearchSheetSession() {
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const owner = useMemo(captureMobileScope, [scopeKey]);
  const { t, locale } = useI18n();
  const router = useRouter();
  const navigation = useNavigation();
  const styles = useThemedStyles(createStyles);
  const tokens = mobileTokens();
  const appearance = resolveMobileAppearance();
  const insets = useSafeAreaInsets();
  const gutter = Math.max(insets.left, insets.right);
  const field = useRef<TextInput>(null);
  const opening = useRef(false);
  const attempt = useRef(0);
  const focused = useRef(false);
  const [query, setQuery] = useState("");
  const spaces = useSearchInbox();
  const { hits, loading, error, retry, querySpaceId } = useSearch(query);
  const rows = useMemo(
    () => searchSheetRows(spaces, query, hits, querySpaceId),
    [spaces, query, hits, querySpaceId, locale],
  );

  const cancelOpen = useCallback(() => {
    attempt.current += 1;
    focused.current = false;
    opening.current = true;
  }, []);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      opening.current = false;
      const unsubscribe = navigation.addListener("beforeRemove", cancelOpen);
      return () => {
        cancelOpen();
        unsubscribe();
      };
    }, [navigation, cancelOpen]),
  );

  useEffect(() => {
    // Native formSheet may finish attaching after TextInput's autoFocus runs.
    const timer = setTimeout(() => {
      if (focused.current && !opening.current) field.current?.focus();
    }, 350);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  const open = async (row: SearchSheetRow, origin: MobileScope) => {
    if (!focused.current || opening.current || !isMobileScopeCurrent(origin) || !row.spaceId)
      return;
    opening.current = true;
    const currentAttempt = ++attempt.current;
    const isCurrent = () =>
      focused.current && attempt.current === currentAttempt && isMobileSessionCurrent(origin);
    const previousSpaceId = origin.spaceId;
    let selected = false;
    let selectionSeq = origin.selectionSeq;
    const claimGeneration = origin.spaceGeneration + 1;
    const ownsSelection = () =>
      isMobileSessionCurrent(origin) &&
      selectionSeq === spaceSelectionSeq() &&
      claimGeneration === currentSpaceSelectionGeneration() &&
      selectedSpaceId() === row.spaceId;
    let navigated = false;
    try {
      const selection = selectSpace(row.spaceId, { isCurrent });
      selectionSeq = spaceSelectionSeq();
      selected = await selection;
      if (!isCurrent() || selectionSeq !== spaceSelectionSeq()) return;
      if (!selected) {
        Alert.alert(t("Could not switch spaces"), t("Try again."));
        return;
      }
      if (!ownsSelection()) return;
      await KeyboardController.dismiss();
      if (!isCurrent() || !ownsSelection()) return;
      // Replace removes the sheet from history while preserving messageId search jumps.
      navigated = true;
      try {
        router.replace(row.destination);
      } catch (error) {
        navigated = false;
        throw error;
      }
    } catch (error: unknown) {
      if (isCurrent() && selectionSeq === spaceSelectionSeq() && (!selected || ownsSelection()))
        Alert.alert(t("Could not open result"), errorText(error, t("Try again.")));
    } finally {
      // Only this exact claim can be restored; a newer pending selection owns its own intent.
      if (!navigated && selected && previousSpaceId !== row.spaceId && ownsSelection()) {
        await selectSpace(previousSpaceId ?? "", {
          isCurrent: () => isMobileSessionCurrent(origin),
        }).catch(() => false);
      }
      if (focused.current && attempt.current === currentAttempt) opening.current = false;
    }
  };

  // Preserve this container so the native sheet does not stretch the list over the header.
  return (
    <View
      collapsable={false}
      style={[styles.screen, { paddingTop: Platform.OS === "ios" ? 16 : insets.top + 8 }]}
    >
      <View style={[styles.top, { marginHorizontal: 16 + gutter }]}>
        <GlassIconButton
          testID="search-sheet-close"
          accessibilityLabel={t("Close")}
          ios="xmark"
          android="close"
          size={44}
          color={tokens.foreground}
          fallbackStyle={{ backgroundColor: tokens.muted }}
          onPress={() => {
            cancelOpen();
            router.back();
          }}
        />
        <View style={styles.fieldPill}>
          <NativeSymbol
            ios="magnifyingglass"
            android="search"
            size={17}
            color={tokens.mutedForeground}
          />
          <TextInput
            ref={field}
            testID="search-sheet-field"
            accessibilityLabel={t("Search")}
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder={t("Search")}
            placeholderTextColor={tokens.mutedForeground}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            keyboardAppearance={appearance}
            clearButtonMode="while-editing"
            style={styles.field}
          />
          {Platform.OS === "android" && query ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Clear")}
              hitSlop={8}
              onPress={() => {
                setQuery("");
                field.current?.focus();
              }}
              style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
            >
              <NativeSymbol
                ios="xmark.circle.fill"
                android="close-circle"
                size={20}
                color={tokens.mutedForeground}
              />
            </Pressable>
          ) : null}
        </View>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: insets.bottom + 16 }}
        ListHeaderComponent={
          error ? (
            <View style={styles.failure}>
              <Text style={styles.failureText}>{t("Could not search")}</Text>
              {error !== t("Could not search") ? (
                <Text style={styles.failureText}>{error}</Text>
              ) : null}
              <Pressable accessibilityRole="button" accessibilityLabel={t("Retry")} onPress={retry}>
                <Text style={styles.retry}>{t("Retry")}</Text>
              </Pressable>
            </View>
          ) : null
        }
        ListEmptyComponent={
          !error ? (
            <Text style={styles.empty}>{loading ? t("Searching…") : t("No results")}</Text>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, ${item.label}`}
            onPress={() => void open(item, owner)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            {item.group ? (
              <GroupAvatar members={item.group.members} size={54} />
            ) : item.bot ? (
              <BotAvatar
                identity={item.bot.id}
                color={item.bot.color || botColors[3]}
                status={item.bot.status}
              />
            ) : (
              <View style={styles.neutralAvatar}>
                <NativeSymbol {...kindIcons[item.kind]} color={tokens.mutedForeground} size={24} />
              </View>
            )}
            <View style={styles.body}>
              <View style={styles.rowTop}>
                <Text numberOfLines={1} style={styles.name}>
                  {item.title}
                </Text>
                <Text style={styles.time}>{item.label}</Text>
              </View>
              <Text numberOfLines={1} style={styles.preview}>
                {item.preview}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    top: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 },
    fieldPill: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderRadius: 22,
      paddingHorizontal: 12,
      backgroundColor: tokens.muted,
    },
    field: {
      flex: 1,
      minHeight: 44,
      paddingVertical: 10,
      color: native.label,
      fontSize: 17,
      writingDirection: "auto",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 10,
      gap: 12,
    },
    pressed: { opacity: 0.55 },
    clear: { minWidth: 32, minHeight: 44, alignItems: "center", justifyContent: "center" },
    neutralAvatar: {
      width: 54,
      height: 54,
      borderRadius: 27,
      backgroundColor: tokens.muted,
      alignItems: "center",
      justifyContent: "center",
    },
    body: { flex: 1, minWidth: 0, gap: 2 },
    rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
    name: {
      flex: 1,
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
      writingDirection: "auto",
    },
    time: { color: native.secondaryLabel, fontSize: 15 },
    preview: {
      color: native.secondaryLabel,
      fontSize: 15,
      lineHeight: 20,
      writingDirection: "auto",
    },
    failure: { gap: 8, paddingHorizontal: 20, paddingVertical: 12 },
    failureText: { color: tokens.destructive, fontSize: 15 },
    retry: { color: native.label, fontSize: 16, fontWeight: "600", paddingVertical: 8 },
    empty: { color: native.secondaryLabel, fontSize: 16, paddingHorizontal: 20, paddingTop: 28 },
  });
}
