import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { LayoutChangeEvent } from "react-native";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import { NativeSymbol } from "../components/native-symbol";
import { formatActivityRelativeTime } from "../lib/activity";
import type { MobileBot } from "../lib/api";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import type { MobileArtifactSummary } from "../lib/artifacts";
import {
  listSpaceArtifacts,
  matchesArtifactQuery,
  mimeBadgeLabel,
  removeArtifact,
} from "../lib/artifacts";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "../lib/mobile-scope";
import { native, useThemedStyles } from "../lib/native";
import { spaceRequestContext } from "../lib/space-request-context";
import { errorText } from "../lib/user-error";

const PAGE_SIZE = 30;

export default function ArtifactsScreen() {
  const { botId, readOnly } = useLocalSearchParams<{ botId?: string; readOnly?: string }>();
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const scope = useMemo(captureMobileScope, [scopeKey]);
  return (
    <Artifacts
      key={JSON.stringify([scopeKey, botId, readOnly])}
      scope={scope}
      initialBotId={botId}
      readOnly={readOnly === "1"}
    />
  );
}

function Artifacts({
  scope,
  initialBotId,
  readOnly,
}: {
  scope: MobileScope;
  initialBotId?: string;
  readOnly: boolean;
}) {
  const navigation = useNavigation();
  const router = useRouter();
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();

  const [bots, setBots] = useState<MobileBot[]>([]);
  const [activeBotId, setActiveBotId] = useState<string | null>(initialBotId || null);
  const mounted = useRef(true);
  const focused = useRef(true);
  const current = useCallback(
    () => mounted.current && focused.current && isMobileScopeCurrent(scope),
    [scope],
  );
  const chipsScrollRef = useRef<ScrollView>(null);
  const initialChipLayout = useRef({
    viewportWidth: 0,
    contentWidth: 0,
    chip: null as { x: number; width: number } | null,
    revealed: false,
  });
  function revealInitialChip() {
    const layout = initialChipLayout.current;
    if (layout.revealed || !layout.viewportWidth || !layout.chip || !current()) return;
    const right = layout.chip.x + layout.chip.width;
    if (layout.contentWidth < right) return;
    chipsScrollRef.current?.scrollTo({
      x: Math.max(0, right - layout.viewportWidth),
      animated: false,
    });
    layout.revealed = true;
  }
  const [items, setItems] = useState<MobileArtifactSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchPageFailed, setSearchPageFailed] = useState(false);
  const loadingMoreRef = useRef(false);
  const generationRef = useRef(0);
  const autoFetchedCursorRef = useRef<string | null>(null);
  const activeBotIdRef = useRef(activeBotId);
  const didFocusRef = useRef(false);
  activeBotIdRef.current = activeBotId;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: t("Search artifacts…"),
        hideWhenScrolling: false,
        autoCapitalize: "none",
        onChangeText: (event: { nativeEvent: { text: string } }) =>
          setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
        onClose: () => setQuery(""),
      },
    });
  }, [navigation, t]);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generationRef.current += 1;
    };
  }, []);

  const load = useCallback(
    async (botId: string | null, mode: "replace" | "refresh") => {
      if (!current()) return;
      const generation = ++generationRef.current;
      const eligible = () => current() && generation === generationRef.current;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      autoFetchedCursorRef.current = null;
      setSearchPageFailed(false);
      setLoadError(null);
      if (mode === "replace") {
        setRefreshing(false);
        setItems(null);
        setNextCursor(null);
      }
      try {
        const context = await spaceRequestContext(scope, eligible);
        if (!eligible()) return;
        const page = await listSpaceArtifacts(
          { botId: botId ?? undefined, limit: PAGE_SIZE },
          context,
        );
        if (!eligible()) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (!eligible()) return;
        if (mode === "replace") {
          setLoadError(errorText(error, t("Could not load artifacts.")));
        }
      }
    },
    [t, current, scope],
  );

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      let active = true;
      const eligible = () => active && current();
      void (async () => {
        const context = await spaceRequestContext(scope, eligible);
        if (!eligible()) return;
        const activeBots = await rpc<MobileBot[]>("bots/list", {}, { requestContext: context });
        if (!eligible()) return;
        if (readOnly && initialBotId && !activeBots.some((bot) => bot.id === initialBotId)) {
          const archived = await rpc<MobileBot[]>(
            "bots/listArchived",
            {},
            { requestContext: context },
          );
          if (!eligible()) return;
          const target = archived.find((bot) => bot.id === initialBotId);
          setBots(target ? [...activeBots, target] : activeBots);
        } else setBots(activeBots);
      })().catch(() => undefined);
      if (!didFocusRef.current) {
        didFocusRef.current = true;
      } else void load(activeBotIdRef.current, "refresh");
      return () => {
        active = false;
        focused.current = false;
        generationRef.current += 1;
      };
    }, [current, initialBotId, load, readOnly, scope]),
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current || !current()) return;
    const generation = generationRef.current;
    const eligible = () => current() && generation === generationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const context = await spaceRequestContext(scope, eligible);
      if (!eligible()) return;
      const page = await listSpaceArtifacts(
        {
          botId: activeBotId ?? undefined,
          cursor: nextCursor,
          limit: PAGE_SIZE,
        },
        context,
      );
      if (!eligible()) return;
      setItems((current) => (current ?? []).concat(page.items));
      setNextCursor(page.nextCursor);
      setSearchPageFailed(false);
    } catch {
      if (eligible()) setSearchPageFailed(true);
    } finally {
      if (eligible()) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [activeBotId, nextCursor, current, scope]);

  async function refresh() {
    if (!current()) return;
    setRefreshing(true);
    const pending = load(activeBotId, "refresh");
    const generation = generationRef.current;
    await pending;
    if (current() && generation === generationRef.current) setRefreshing(false);
  }

  function confirmDelete(item: MobileArtifactSummary) {
    if (readOnly || !current()) return;
    const generation = generationRef.current;
    const eligible = () => !readOnly && current() && generation === generationRef.current;
    Alert.alert(
      t('Delete "{name}"?', { name: item.name }),
      item.versionCount > 1
        ? t("This deletes all {count} versions of this artifact. This can't be undone.", {
            count: item.versionCount,
          })
        : t("This can't be undone."),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Delete"),
          style: "destructive",
          onPress: () => {
            if (!eligible()) return;
            void (async () => {
              const context = await spaceRequestContext(scope, eligible);
              if (!eligible()) return;
              await removeArtifact(item.id, context);
            })()
              .then(() => {
                if (eligible())
                  setItems((current) => current?.filter((row) => row.id !== item.id) ?? current);
              })
              .catch((error: unknown) => {
                if (eligible())
                  Alert.alert(
                    t("Could not delete this artifact"),
                    errorText(error, t("Try again.")),
                  );
              });
          },
        },
      ],
    );
  }

  const queryActive = query.trim().length > 0;
  const filtered = useMemo(() => {
    if (!items) return null;
    if (!queryActive) return items;
    return items.filter((item) => matchesArtifactQuery(item, query));
  }, [items, query, queryActive]);
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);

  useEffect(() => {
    autoFetchedCursorRef.current = null;
    setSearchPageFailed(false);
  }, [query, activeBotId]);

  useEffect(() => {
    if (searchPageFailed || !queryActive || !nextCursor || loadingMore || items === null) return;
    if (filtered && filtered.length > 0) return;
    if (autoFetchedCursorRef.current === nextCursor) return;
    autoFetchedCursorRef.current = nextCursor;
    void loadMore();
  }, [filtered, items, loadMore, loadingMore, nextCursor, queryActive, searchPageFailed]);

  useEffect(() => {
    void load(activeBotId, "replace");
  }, [activeBotId, load]);

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <FlatList<MobileArtifactSummary>
        ListHeaderComponent={
          <ScrollView
            ref={chipsScrollRef}
            onLayout={(event) => {
              initialChipLayout.current.viewportWidth = event.nativeEvent.layout.width;
              revealInitialChip();
            }}
            onContentSizeChange={(width) => {
              initialChipLayout.current.contentWidth = width;
              revealInitialChip();
            }}
            horizontal
            contentInsetAdjustmentBehavior="never"
            showsHorizontalScrollIndicator={false}
            style={styles.chipsScroll}
            contentContainerStyle={styles.chipsRow}
          >
            <Chip
              label={t("All bots")}
              active={activeBotId === null}
              onPress={() => {
                if (current()) setActiveBotId(null);
              }}
            />
            {bots.map((bot) => (
              <Chip
                key={bot.id}
                onLayout={
                  bot.id === initialBotId && activeBotId === initialBotId
                    ? (event) => {
                        initialChipLayout.current.chip = event.nativeEvent.layout;
                        revealInitialChip();
                      }
                    : undefined
                }
                label={bot.name}
                active={activeBotId === bot.id}
                onPress={() => {
                  if (current()) setActiveBotId(bot.id);
                }}
                avatar={<BotAvatar color={bot.color} identity={bot.id} size={16} />}
              />
            ))}
          </ScrollView>
        }
        style={styles.listView}
        contentInsetAdjustmentBehavior="automatic"
        data={filtered ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        indicatorStyle="default"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={native.secondaryLabel}
          />
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => void loadMore()}
        ListEmptyComponent={
          items === null ? (
            <View style={styles.centered}>
              {loadError ? (
                <Text style={styles.empty}>{loadError}</Text>
              ) : (
                <ActivityIndicator color={native.secondaryLabel} />
              )}
            </View>
          ) : queryActive && filtered?.length === 0 && nextCursor && searchPageFailed ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                autoFetchedCursorRef.current = null;
                setSearchPageFailed(false);
              }}
              style={styles.centered}
            >
              <Text style={styles.empty}>{t("Could not load artifacts.")}</Text>
              <Text style={styles.empty}>{t("Try again.")}</Text>
            </Pressable>
          ) : queryActive &&
            filtered?.length === 0 &&
            nextCursor &&
            (loadingMore || autoFetchedCursorRef.current !== nextCursor) ? (
            <View style={styles.centered}>
              <ActivityIndicator color={native.secondaryLabel} />
            </View>
          ) : (
            <Text style={styles.empty}>
              {queryActive ? t("No matching artifacts") : t("No artifacts yet")}
            </Text>
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator color={native.secondaryLabel} />
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <ArtifactRow
            item={item}
            bot={activeBotId === null && item.botId ? botsById.get(item.botId) : undefined}
            onPress={() => {
              if (current())
                router.push({
                  pathname: "/artifact",
                  params: { artifactId: item.id, ...(readOnly ? { readOnly: "1" } : {}) },
                });
            }}
            onLongPress={readOnly ? undefined : () => confirmDelete(item)}
          />
        )}
      />
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
  avatar,
  onLayout,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  avatar?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      onLayout={onLayout}
      style={[styles.chip, active && styles.chipActive]}
    >
      {avatar}
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function ArtifactRow({
  item,
  bot,
  onPress,
  onLongPress,
}: {
  item: MobileArtifactSummary;
  bot?: MobileBot;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const isCode = item.mimeType === "text/html";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={bot ? `${item.name}, ${bot.name}` : item.name}
      accessibilityHint={onLongPress ? t("Long press to delete") : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowIcon}>
        <NativeSymbol
          ios={isCode ? "chevron.left.forwardslash.chevron.right" : "doc.text"}
          android={isCode ? "code-slash-outline" : "document-text-outline"}
          size={16}
        />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName} numberOfLines={1}>
            {item.name}
          </Text>
          {item.versionCount > 1 ? <Text style={styles.badge}>{`v${item.version}`}</Text> : null}
          <Text style={styles.badge}>{mimeBadgeLabel(item.mimeType)}</Text>
        </View>
        {item.description ? (
          <Text style={styles.rowDescription} numberOfLines={1}>
            {item.description}
          </Text>
        ) : null}
        <View style={styles.rowFooter}>
          {bot ? (
            <>
              <BotAvatar color={bot.color} identity={bot.id} size={14} />
              <Text style={styles.rowBotName} numberOfLines={1}>
                {bot.name}
              </Text>
            </>
          ) : null}
          <Text style={styles.rowMeta}>{formatActivityRelativeTime(item.createdAt)}</Text>
        </View>
      </View>
    </Pressable>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    centered: { alignItems: "center", justifyContent: "center", paddingTop: 40 },
    chipsScroll: { flexGrow: 0, flexShrink: 0 },
    chipsRow: {
      flexDirection: "row",
      alignItems: "center",
      flexGrow: 0,
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      flexGrow: 0,
      flexShrink: 0,
      gap: 6,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 999,
      backgroundColor: native.fill,
    },
    chipActive: { backgroundColor: tokens.primary },
    chipLabel: { color: native.label, fontSize: 13, fontWeight: "600" },
    chipLabelActive: { color: tokens.primaryForeground },
    listView: { flex: 1 },
    list: { paddingBottom: 32 },
    empty: {
      color: native.secondaryLabel,
      fontSize: 15,
      textAlign: "center",
      paddingHorizontal: 24,
      paddingTop: 8,
    },
    footer: { paddingVertical: 20 },
    row: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
    rowPressed: { opacity: 0.6 },
    rowIcon: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: native.fill,
      alignItems: "center",
      justifyContent: "center",
    },
    rowBody: { flex: 1, minWidth: 0, gap: 3 },
    rowTop: { flexDirection: "row", alignItems: "center", gap: 6 },
    rowName: { flex: 1, minWidth: 0, color: native.label, fontSize: 15, fontWeight: "600" },
    badge: {
      color: native.secondaryLabel,
      fontSize: 10.5,
      fontWeight: "700",
      backgroundColor: native.fill,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
      overflow: "hidden",
    },
    rowDescription: { color: native.secondaryLabel, fontSize: 12.5 },
    rowFooter: { flexDirection: "row", alignItems: "center", gap: 6 },
    rowBotName: { flexShrink: 1, color: native.secondaryLabel, fontSize: 11.5 },
    rowMeta: { color: native.secondaryLabel, fontSize: 11.5 },
  });
}
