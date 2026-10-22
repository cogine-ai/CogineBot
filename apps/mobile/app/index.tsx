import { MenuView } from "@expo/ui/community/menu";
import type { RemovedBotSection, RunActivityRow, SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { normalizeCreateBotProfile } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { botColors } from "@rakazo/ui-tokens";
import { Redirect, useFocusEffect, useNavigation, useRouter } from "expo-router";
import type { ReactNode } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import { GroupAvatar } from "../components/group-avatar";
import { InboxContextMenu } from "../components/inbox-context-menu";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSymbol } from "../components/native-symbol";
import { SectionNamePrompt } from "../components/section-name-prompt";
import { WorkingIndicator } from "../components/WorkingIndicator";
import {
  activityStatusLabel,
  fetchSpaceActivity,
  formatActivityRelativeTime,
} from "../lib/activity";
import { loadActivityMode, saveActivityMode } from "../lib/activity-mode";
import type {
  ApiRequestContext,
  MobileBot,
  MobileBotSection,
  MobileGroup,
  MobileMe,
  MobileSpace,
  MobileSpaceNavigation,
} from "../lib/api";
import {
  currentApiBase,
  loadSessionToken,
  rpc,
  selectedSpaceId,
  selectInitialSpace,
  selectSpace,
} from "../lib/api";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { mobileBotAvatarPresentation } from "../lib/bot-avatar";
import { allowFocusPrompt, scheduleFocusPrompt } from "../lib/focus-prompt";
import { t, useI18n } from "../lib/i18n";
import { botTag, formatThreadTime, userInitials } from "../lib/inbox";
import type { InboxOrganizationChange, InboxOrganizationState } from "../lib/inbox-organization";
import {
  chatOrganizationActions,
  reconcileInboxOrganization,
  reorderedSectionIds,
  sectionOrganizationActions,
} from "../lib/inbox-organization";
import { retainInboxValue } from "../lib/inbox-retention";
import type { InboxSpace, InboxSpaceItem } from "../lib/inbox-spaces";
import {
  canDeleteInboxSpace,
  inboxNeedsCreateHint,
  removeInboxSpace,
  retryInboxSpaceFallback,
  selectInboxSpace,
  spaceInboxItems,
} from "../lib/inbox-spaces";
import type { ChatNotifyPermissionStatus } from "../lib/live-notifications";
import {
  afterChatNotifyChange,
  openLiveNotificationSettings,
  readChatNotificationPermission,
} from "../lib/live-notifications";
import type { MobileScope } from "../lib/mobile-scope";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  isMobileSessionCurrent,
  subscribeMobileScope,
} from "../lib/mobile-scope";
import { native, useThemedStyles } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { previewSnippet } from "../lib/preview";
import { registerPushToken } from "../lib/push";
import { readSavedInbox, savedChatsScope, saveInbox } from "../lib/saved-chats";
import { setSearchInbox } from "../lib/search-inbox";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  subscribeSessionGeneration,
} from "../lib/session";
import { spaceRequestContext } from "../lib/space-request-context";
import { errorText } from "../lib/user-error";

const FALLBACK_COLOR = botColors[3];

type InboxItem = InboxSpaceItem;
type SectionPrompt = {
  scope: string;
  spaceId: string;
} & (
  | { kind: "create"; targetKind: "bot" | "group"; targetId: string; wasPinned: boolean }
  | { kind: "rename"; section: MobileBotSection }
);

async function openMobileSpace(spaceId: string | undefined, open: () => void) {
  if (spaceId && !(await selectSpace(spaceId))) {
    Alert.alert(t("Could not switch spaces"), t("Try again."));
    return;
  }
  open();
}

export default function HomeSession() {
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const ready = useSyncExternalStore(subscribeSessionGeneration, currentReadySessionGeneration);
  return <Home key={`${generation}:${ready}`} />;
}

function Home() {
  const tokens = mobileTokens();
  const appearance = resolveMobileAppearance();
  const styles = useThemedStyles(createHomeStyles);
  const { t, locale } = useI18n();
  const [day, setDay] = useState(() => new Date().setHours(0, 0, 0, 0));
  useFocusEffect(
    useCallback(() => {
      let timer: ReturnType<typeof setTimeout>;
      const refreshDay = () => {
        clearTimeout(timer);
        const now = new Date();
        setDay(new Date(now).setHours(0, 0, 0, 0));
        const midnight = new Date(now);
        midnight.setHours(24, 0, 0, 0);
        timer = setTimeout(refreshDay, midnight.getTime() - now.getTime());
      };
      refreshDay();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refreshDay();
      });
      return () => {
        clearTimeout(timer);
        subscription.remove();
      };
    }, []),
  );
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [groups, setGroups] = useState<MobileGroup[]>([]);
  const [botSections, setBotSections] = useState<MobileBotSection[]>([]);
  const [spaces, setSpaces] = useState<MobileSpace[]>([]);
  const [me, setMe] = useState<Pick<MobileMe, "userId" | "spaceId" | "name"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sectionPrompt, setSectionPrompt] = useState<SectionPrompt | null>(null);
  const [deletedSection, setDeletedSection] = useState<{
    scope: string;
    spaceId: string;
    snapshot: RemovedBotSection;
  } | null>(null);
  const notificationRevision = useRef(0);
  const organizationBusyRef = useRef(false);
  const [organizationBusy, setOrganizationBusy] = useState(false);
  const [organizationNotice, setOrganizationNotice] = useState<string | null>(null);
  const organizationScope = me
    ? `${currentApiBase()}:${currentSessionGeneration()}:${me.userId}:${me.spaceId}`
    : null;
  const organizationScopeRef = useRef(organizationScope);
  organizationScopeRef.current = organizationScope;
  const inboxState = useRef<InboxOrganizationState>({
    spaceId: me?.spaceId ?? null,
    bots,
    groups,
    botSections,
    spaces,
  });
  inboxState.current = { spaceId: me?.spaceId ?? null, bots, groups, botSections, spaces };
  const [activityMode, setActivityMode] = useState(false);
  const [activity, setActivity] = useState<{ active: RunActivityRow[]; recent: RunActivityRow[] }>({
    active: [],
    recent: [],
  });
  const activityRequestId = useRef(0);
  const inboxRequestId = useRef(0);
  const mounted = useRef(true);
  const bootstrap = useRef<{ scope: MobileScope; target: string } | null>(null);
  const publicationRevision = useRef(0);
  const verifiedInbox = useRef<{
    scope: MobileScope;
    me: Pick<MobileMe, "userId" | "spaceId" | "name">;
    rawInbox: {
      current: Pick<InboxOrganizationState, "bots" | "groups" | "botSections"> & { id: string };
      spaces: MobileSpace[];
    };
    publicationRevision: number;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inboxRequestId.current++;
    };
  }, []);
  const creatingBotRef = useRef(false);
  const spaceActionRef = useRef<{ busy: boolean; recoveryId: string | null }>({
    busy: false,
    recoveryId: null,
  });
  const [spaceBusy, setSpaceBusy] = useState(false);
  const [spaceRecoveryId, setSpaceRecoveryId] = useState<string | null>(null);
  const [collapsedRosterParents, setCollapsedRosterParents] = useState(() => new Set<string>());
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState(() => new Set<string>());
  useEffect(() => {
    setSectionPrompt(null);
    setDeletedSection(null);
    setOrganizationNotice(null);
  }, [organizationScope]);
  useEffect(() => {
    if (!organizationNotice) return;
    const timer = setTimeout(() => setOrganizationNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [organizationNotice]);
  const toggleSidebarSection = useCallback((key: string) => {
    setCollapsedSidebarSections((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const toggleRosterParent = useCallback((botId: string) => {
    setCollapsedRosterParents((previous) => {
      const next = new Set(previous);
      if (next.has(botId)) next.delete(botId);
      else next.add(botId);
      return next;
    });
  }, []);

  useEffect(() => {
    void loadActivityMode().then(setActivityMode);
  }, []);

  const toggleActivityMode = useCallback(() => {
    setActivityMode((on) => {
      const next = !on;
      void saveActivityMode(next);
      return next;
    });
  }, []);

  const loadBots = useCallback(async (duringOrganization = false) => {
    if (
      spaceActionRef.current.busy ||
      spaceActionRef.current.recoveryId ||
      (organizationBusyRef.current && !duringOrganization)
    )
      return;
    const requestId = ++inboxRequestId.current;
    let owner = captureMobileScope();
    const current = () =>
      mounted.current && requestId === inboxRequestId.current && isMobileScopeCurrent(owner);
    setError(null);
    try {
      const [navigation, nextMe] = await Promise.all([
        rpc<MobileSpaceNavigation>("spaces/list"),
        rpc<MobileMe>("me"),
      ]);
      if (
        !current() ||
        navigation.current.id !== nextMe.spaceId ||
        (owner.spaceId !== null && owner.spaceId !== nextMe.spaceId)
      )
        return;
      if (owner.spaceId === null) {
        const start = owner;
        const operationCurrent = () =>
          mounted.current && requestId === inboxRequestId.current && isMobileSessionCurrent(start);
        bootstrap.current = { scope: start, target: nextMe.spaceId };
        let selected: boolean;
        try {
          selected = await selectInitialSpace(nextMe.spaceId, { isCurrent: operationCurrent });
        } finally {
          bootstrap.current = null;
        }
        const claimed = captureMobileScope();
        if (!selected && operationCurrent() && claimed.selectionSeq === start.selectionSeq + 1) {
          setError(t("Could not save the default space"));
          return;
        }
        if (
          !selected ||
          !operationCurrent() ||
          claimed.spaceId !== nextMe.spaceId ||
          claimed.selectionSeq !== start.selectionSeq + 1 ||
          claimed.spaceGeneration !== start.spaceGeneration + 1
        )
          return;
        owner = claimed;
      }
      if (!current()) return;
      verifiedInbox.current = {
        scope: owner,
        me: nextMe,
        rawInbox: navigation,
        publicationRevision: ++publicationRevision.current,
      };
      setSearchInbox(owner, navigation.spaces);
      inboxState.current = {
        spaceId: nextMe.spaceId,
        bots: navigation.current.bots,
        groups: navigation.current.groups,
        botSections: navigation.current.botSections,
        spaces: navigation.spaces,
      };
      setBots((current) => retainInboxValue(current, navigation.current.bots));
      setBotSections((current) => retainInboxValue(current, navigation.current.botSections));
      setGroups((current) => retainInboxValue(current, navigation.current.groups));
      setSpaces((current) => retainInboxValue(current, navigation.spaces));
      setMe((current) => retainInboxValue(current, nextMe));
      saveInbox(
        {
          apiBase: owner.apiBase,
          userId: nextMe.userId,
          spaceId: navigation.current.id,
          sessionGeneration: owner.sessionGeneration,
          selectionId: owner.spaceId,
        },
        navigation,
        nextMe,
        current,
      );
    } catch (err) {
      if (!current()) return;
      setError(errorText(err, t("Could not load bots")));
    }
  }, []);

  const refreshBots = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadBots();
    } finally {
      setRefreshing(false);
    }
  }, [loadBots]);

  useEffect(() => {
    void loadSessionToken().then((token) => {
      setHasSession(Boolean(token));
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!hasSession) return;
    void registerPushToken().catch(() => undefined);
  }, [hasSession]);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    let refreshQueued = false;
    const refresh = () => {
      const own = bootstrap.current;
      const now = captureMobileScope();
      if (
        own &&
        isMobileSessionCurrent(own.scope) &&
        now.selectionSeq === own.scope.selectionSeq + 1 &&
        ((now.spaceId === null &&
          (now.spaceGeneration === own.scope.spaceGeneration ||
            now.spaceGeneration === own.scope.spaceGeneration + 2)) ||
          (now.spaceId === own.target && now.spaceGeneration === own.scope.spaceGeneration + 1))
      )
        return;
      if (refreshQueued) return;
      refreshQueued = true;
      queueMicrotask(() => {
        refreshQueued = false;
        if (!cancelled) void loadBots();
      });
    };
    const unsubscribe = subscribeMobileScope(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [hasSession, loadBots]);

  // A cache keeps its verified owner; a late read cannot replace a live publication.
  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    const load = async () => {
      const owner = captureMobileScope();
      const revision = publicationRevision.current;
      if (verifiedInbox.current && isMobileScopeCurrent(verifiedInbox.current.scope)) return;
      const cacheScope = await savedChatsScope();
      if (
        cancelled ||
        !mounted.current ||
        !cacheScope ||
        !isMobileScopeCurrent(owner) ||
        revision !== publicationRevision.current
      )
        return;
      const saved = readSavedInbox(cacheScope);
      if (
        !saved ||
        saved.me.userId !== cacheScope.userId ||
        saved.me.spaceId !== cacheScope.spaceId
      )
        return;
      const rawInbox = {
        current: {
          id: saved.me.spaceId,
          bots: saved.bots,
          groups: saved.groups,
          botSections: saved.botSections,
        },
        spaces: saved.spaces,
      };
      verifiedInbox.current = {
        scope: owner,
        me: saved.me,
        rawInbox,
        publicationRevision: ++publicationRevision.current,
      };
      setSearchInbox(owner, saved.spaces);
      inboxState.current = {
        spaceId: saved.me.spaceId,
        bots: saved.bots,
        groups: saved.groups,
        botSections: saved.botSections,
        spaces: saved.spaces,
      };
      setBots(saved.bots);
      setBotSections(saved.botSections);
      setGroups(saved.groups);
      setSpaces(saved.spaces);
      setMe(saved.me);
    };
    void load();
    const unsubscribe = subscribeMobileScope(() => {
      void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [hasSession]);

  useFocusEffect(
    useCallback(() => {
      if (!hasSession) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async () => {
        if (AppState.currentState === "active") await loadBots();
        if (!cancelled) timer = setTimeout(() => void tick(), 5_000);
      };
      void tick();
      return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [hasSession, loadBots]),
  );

  const loadActivity = useCallback(async () => {
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    if (!hasSession || !activityMode) {
      activityRequestId.current += 1;
      setActivity({ active: [], recent: [] });
      return;
    }
    const requestId = ++activityRequestId.current;
    try {
      const next = await fetchSpaceActivity();
      if (requestId !== activityRequestId.current) return;
      setActivity(next);
    } catch {
      // Keep the last good snapshot on transient RPC failures; only drop stale responses.
      if (requestId !== activityRequestId.current) return;
    }
  }, [activityMode, hasSession]);

  useFocusEffect(
    useCallback(() => {
      if (!hasSession || !activityMode) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const tick = async () => {
        await loadActivity();
        if (!cancelled) {
          timer = setTimeout(() => void tick(), 15_000);
        }
      };

      void tick();
      return () => {
        cancelled = true;
        activityRequestId.current += 1;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [activityMode, hasSession, loadActivity]),
  );

  const listData = useMemo((): InboxItem[] => {
    const sidebarSpaces =
      spaces.length > 0
        ? spaces
        : me
          ? [
              {
                id: me.spaceId,
                name: t("Personal"),
                isDefault: true,
                hasContent: true,
                bots,
                groups,
                botSections,
              },
            ]
          : [];
    return spaceInboxItems(sidebarSpaces, collapsedRosterParents, collapsedSidebarSections, false);
  }, [
    bots,
    groups,
    botSections,
    spaces,
    me,
    collapsedRosterParents,
    collapsedSidebarSections,
    locale,
  ]);
  const initials = userInitials(me?.name ?? "");
  const insets = useSafeAreaInsets();
  // Liquid Glass uses the native bar: glass bar items, a native menu, and bottom search.
  const nativeHeader = iosAtLeast(26);
  const navigation = useNavigation();
  const router = useRouter();

  const chooseInboxSpace = useCallback(
    async (spaceId: string) => {
      if (spaceActionRef.current.busy || organizationBusyRef.current) return;
      spaceActionRef.current.busy = true;
      setSpaceBusy(true);
      inboxRequestId.current += 1;
      activityRequestId.current += 1;
      setActivity({ active: [], recent: [] });
      try {
        const refresh = async () => {
          spaceActionRef.current.recoveryId = null;
          setSpaceRecoveryId(null);
          spaceActionRef.current.busy = false;
          await refreshBots();
          await loadActivity();
        };
        const selected =
          spaceActionRef.current.recoveryId === spaceId
            ? await retryInboxSpaceFallback(spaceId, refresh)
            : await selectInboxSpace(spaceId, refresh);
        if (!selected) throw new Error(t("Could not switch spaces"));
      } catch (err) {
        const message = errorText(err, t("Could not switch spaces"));
        setError(message);
        Alert.alert(message, t("Try again."));
      } finally {
        spaceActionRef.current.busy = false;
        setSpaceBusy(false);
      }
    },
    [refreshBots, loadActivity, t],
  );

  const deleteInboxSpace = useCallback(
    async (space: InboxSpace) => {
      if (
        !canDeleteInboxSpace(space) ||
        spaceActionRef.current.busy ||
        spaceActionRef.current.recoveryId
      )
        return;
      spaceActionRef.current.busy = true;
      setSpaceBusy(true);
      inboxRequestId.current += 1;
      activityRequestId.current += 1;
      try {
        const recoveryId = await removeInboxSpace(space.id, async () => {
          spaceActionRef.current.busy = false;
          setActivity({ active: [], recent: [] });
          await refreshBots();
          await loadActivity();
        });
        if (recoveryId) {
          spaceActionRef.current.recoveryId = recoveryId;
          setSpaceRecoveryId(recoveryId);
          setError(t("Could not switch spaces"));
        }
      } catch (err) {
        Alert.alert(t("Could not delete space"), errorText(err, t("Try again.")));
      } finally {
        spaceActionRef.current.busy = false;
        setSpaceBusy(false);
      }
    },
    [refreshBots, loadActivity, t],
  );

  const confirmDeleteSpace = useCallback(
    (space: InboxSpace) => {
      if (
        !canDeleteInboxSpace(space) ||
        spaceActionRef.current.busy ||
        spaceActionRef.current.recoveryId
      )
        return;
      Alert.alert(
        t("Delete {name}?", { name: space.name }),
        t("This removes the empty space for everyone."),
        [
          { text: t("Cancel"), style: "cancel" },
          {
            text: t("Delete"),
            style: "destructive",
            onPress: () => void deleteInboxSpace(space),
          },
        ],
      );
    },
    [deleteInboxSpace, t],
  );

  const createQuickBot = useCallback(async () => {
    if (creatingBotRef.current || spaceActionRef.current.busy || spaceActionRef.current.recoveryId)
      return;
    creatingBotRef.current = true;
    try {
      // Authoritative roster so a slow home fetch does not treat later bots as first.
      // A failed list is unknown — use the delayed path rather than assuming first.
      const existing = await rpc<MobileBot[]>("bots/list").catch(() => null);
      const isFirstBot = existing !== null && existing.length === 0;
      const bot = await rpc<MobileBot>("bots/create", {
        ...normalizeCreateBotProfile({ name: "New Bot", title: "", description: "" }),
        notifyOnFinish: true,
        computerMode: "team",
      });
      void refreshBots().catch(() => undefined);
      allowFocusPrompt(bot.id);
      router.push({ pathname: "/thread", params: { botId: bot.id, name: bot.name } });
      void (async () => {
        const started = await rpc("onboarding/start", { botId: bot.id })
          .then(() => true)
          .catch(() => false);
        if (!started) return;
        scheduleFocusPrompt(bot.id, isFirstBot);
      })();
    } catch (err) {
      setError(errorText(err, t("Could not create bot")));
    } finally {
      creatingBotRef.current = false;
    }
  }, [refreshBots, router, t]);

  const runCreateAction = useCallback(
    (action: "bot" | "group" | "space") => {
      if (
        spaceActionRef.current.busy ||
        spaceActionRef.current.recoveryId ||
        organizationBusyRef.current
      )
        return;
      if (action === "bot") void createQuickBot();
      else if (action === "group") router.push("/new-group");
      else router.push("/new-space");
    },
    [createQuickBot, router],
  );

  useLayoutEffect(() => {
    if (!nativeHeader) return;
    const signedIn = ready && hasSession;
    navigation.setOptions({
      headerShown: signedIn,
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      title: "",
      unstable_headerLeftItems: () => [
        {
          type: "button" as const,
          label: initials,
          labelStyle: { fontSize: 15, fontWeight: "600" },
          accessibilityLabel: t("Account"),
          onPress: () => router.push("/account"),
        },
      ],
      unstable_headerRightItems: () => [
        {
          type: "button" as const,
          accessibilityLabel: t("Activity"),
          icon: { type: "sfSymbol" as const, name: activityMode ? "bell.fill" : "bell" },
          selected: activityMode,
          onPress: toggleActivityMode,
        },
        {
          type: "button" as const,
          accessibilityLabel: t("Search"),
          identifier: "home-search-button",
          icon: { type: "sfSymbol" as const, name: "magnifyingglass" },
          onPress: () => router.push("/search"),
        },
        {
          type: "button" as const,
          accessibilityLabel: t("Artifacts"),
          icon: { type: "sfSymbol" as const, name: "square.stack.3d.up" },
          onPress: () => router.push("/artifacts"),
        },
        {
          type: "menu" as const,
          accessibilityLabel: t("Create"),
          icon: { type: "sfSymbol" as const, name: "plus" },
          menu: {
            items: [
              {
                type: "action" as const,
                label: t("New bot"),
                icon: { type: "sfSymbol" as const, name: "person.crop.circle.badge.plus" },
                onPress: () => runCreateAction("bot"),
              },
              {
                type: "action" as const,
                label: t("New group"),
                icon: { type: "sfSymbol" as const, name: "person.2" },
                onPress: () => runCreateAction("group"),
              },
              {
                type: "action" as const,
                label: t("New space"),
                icon: { type: "sfSymbol" as const, name: "square.grid.2x2" },
                onPress: () => runCreateAction("space"),
              },
            ],
          },
        },
      ],
    });
  }, [
    nativeHeader,
    navigation,
    ready,
    hasSession,
    initials,
    activityMode,
    toggleActivityMode,
    runCreateAction,
    router,
    t,
    locale,
  ]);

  const openBot = useCallback(
    (bot: MobileBot | SpaceBot) => {
      if (
        spaceActionRef.current.busy ||
        spaceActionRef.current.recoveryId ||
        organizationBusyRef.current
      )
        return;
      void openMobileSpace(bot.spaceId, () =>
        router.push({ pathname: "/thread", params: { botId: bot.id, name: bot.name } }),
      );
    },
    [router],
  );
  const openGroup = useCallback(
    (group: MobileGroup | SpaceGroup) => {
      if (
        spaceActionRef.current.busy ||
        spaceActionRef.current.recoveryId ||
        organizationBusyRef.current
      )
        return;
      void openMobileSpace(group.spaceId, () =>
        router.push({ pathname: "/group-thread", params: { groupId: group.id, name: group.name } }),
      );
    },
    [router],
  );
  const applyOrganization = useCallback(
    (change: InboxOrganizationChange) => {
      const verified = verifiedInbox.current;
      if (!me || !verified || !isMobileScopeCurrent(verified.scope)) return;
      const next = reconcileInboxOrganization(inboxState.current, change);
      const rawInbox = {
        ...verified.rawInbox,
        current: {
          ...verified.rawInbox.current,
          bots: next.bots,
          groups: next.groups,
          botSections: next.botSections,
        },
        spaces: next.spaces,
      };
      verifiedInbox.current = {
        ...verified,
        rawInbox,
        publicationRevision: ++publicationRevision.current,
      };
      inboxState.current = next;
      setBots(next.bots);
      setGroups(next.groups);
      setBotSections(next.botSections);
      setSpaces(next.spaces);
      setSearchInbox(verified.scope, next.spaces);
      saveInbox(
        {
          apiBase: verified.scope.apiBase,
          userId: verified.me.userId,
          spaceId: verified.me.spaceId,
          sessionGeneration: verified.scope.sessionGeneration,
          selectionId: verified.scope.spaceId,
        },
        rawInbox,
        verified.me,
        () => mounted.current && isMobileScopeCurrent(verified.scope),
      );
    },
    [me],
  );
  const saveOrganization = useCallback(
    async <T,>(
      scope: string,
      spaceId: string,
      request: () => Promise<T>,
      confirmed: (result: T) => void | Promise<void>,
    ) => {
      const owner = captureMobileScope();
      const current = () =>
        mounted.current &&
        isMobileScopeCurrent(owner) &&
        !!verifiedInbox.current &&
        isMobileScopeCurrent(verifiedInbox.current.scope) &&
        organizationScopeRef.current === scope &&
        scope ===
          `${currentApiBase()}:${currentSessionGeneration()}:${me?.userId}:${me?.spaceId}` &&
        (selectedSpaceId() ?? me?.spaceId) === spaceId;
      if (
        organizationBusyRef.current ||
        spaceActionRef.current.busy ||
        spaceActionRef.current.recoveryId ||
        !current()
      )
        throw new Error(t("Could not update chat"));
      organizationBusyRef.current = true;
      inboxRequestId.current += 1;
      setOrganizationBusy(true);
      try {
        const result = await request();
        if (!current()) return;
        inboxRequestId.current += 1;
        await confirmed(result);
        if (!current()) return;
        await loadBots(true);
      } catch (cause) {
        if (current()) throw cause;
      } finally {
        organizationBusyRef.current = false;
        setOrganizationBusy(false);
      }
    },
    [loadBots, me, t],
  );
  const reportOrganizationError = useCallback(
    (cause: unknown) => {
      Alert.alert(t("Could not update chat"), errorText(cause, t("Try again.")));
    },
    [t],
  );
  const showNotificationPermission = useCallback(
    (status: ChatNotifyPermissionStatus | null, isCurrent: () => boolean) => {
      if (!isCurrent() || status === null || status === "allowed") return;
      if (status === "denied") {
        Alert.alert(t("Notifications"), t("Notifications are blocked in system settings."), [
          { text: t("Cancel"), style: "cancel" },
          {
            text: t("Settings"),
            onPress: () => {
              void openLiveNotificationSettings(isCurrent).catch(() => undefined);
            },
          },
        ]);
      } else {
        Alert.alert(t("Notifications"), t("Could not check notification permission."), [
          { text: t("Cancel"), style: "cancel" },
          {
            text: t("Retry"),
            onPress: () => {
              if (!isCurrent()) return;
              void readChatNotificationPermission(isCurrent).then((next) => {
                if (!isCurrent() || next === null || next === "allowed") return;
                if (next === "denied")
                  Alert.alert(
                    t("Notifications"),
                    t("Notifications are blocked in system settings."),
                    [
                      { text: t("Cancel"), style: "cancel" },
                      {
                        text: t("Settings"),
                        onPress: () => {
                          void openLiveNotificationSettings(isCurrent).catch(() => undefined);
                        },
                      },
                    ],
                  );
                else Alert.alert(t("Notifications"), t("Could not check notification permission."));
              });
            },
          },
        ]);
      }
    },
    [t],
  );
  const handleChatAction = useCallback(
    (
      kind: "bot" | "group",
      chat: MobileBot | SpaceBot | MobileGroup | SpaceGroup,
      action: string,
    ) => {
      if (!organizationScope || !me) return;
      const spaceId = chat.spaceId ?? me.spaceId;
      if (action === "create-section") {
        setSectionPrompt({
          kind: "create",
          targetKind: kind,
          targetId: chat.id,
          wasPinned: chat.pinned,
          spaceId,
          scope: organizationScope,
        });
        return;
      }
      if (action === "unread") {
        void saveOrganization(
          organizationScope,
          spaceId,
          () =>
            rpc(`threads/${chat.unread ? "markRead" : "markUnread"}`, { [`${kind}Id`]: chat.id }),
          () =>
            applyOrganization({
              type: "chat",
              spaceId,
              kind,
              id: chat.id,
              patch: { unread: !chat.unread },
            }),
        ).catch(reportOrganizationError);
        return;
      }
      const update =
        action === "pin"
          ? { pinned: !chat.pinned }
          : action === "notifications" && "notifyOnFinish" in chat
            ? { notifyOnFinish: !chat.notifyOnFinish }
            : action === "unassigned" || action.startsWith("section:")
              ? {
                  sectionId: action === "unassigned" ? null : action.slice("section:".length),
                  pinned: false,
                }
              : null;
      if (!update) return;
      const owner = captureMobileScope();
      const revision =
        "notifyOnFinish" in update ? ++notificationRevision.current : notificationRevision.current;
      const isCurrent = () =>
        mounted.current && isMobileScopeCurrent(owner) && revision === notificationRevision.current;
      let requestContext: ApiRequestContext | undefined;
      void saveOrganization(
        organizationScope,
        spaceId,
        async () => {
          if ("notifyOnFinish" in update) {
            requestContext = await spaceRequestContext(owner, isCurrent);
            if (!isCurrent() || requestContext.headers["x-rakazo-space-id"] !== spaceId)
              throw new Error(t("Could not update chat"));
          }
          return rpc<MobileBot | MobileGroup>(
            `${kind}s/update`,
            { [`${kind}Id`]: chat.id, ...update },
            requestContext ? { requestContext } : {},
          );
        },
        async (updated) => {
          applyOrganization({
            type: "chat",
            spaceId,
            kind,
            id: chat.id,
            patch: {
              pinned: updated.pinned,
              sectionId: updated.sectionId,
              unread: updated.unread,
              updatedAt: updated.updatedAt,
              ...("notifyOnFinish" in updated ? { notifyOnFinish: updated.notifyOnFinish } : {}),
            },
          });
          if (chat.pinned && !updated.pinned && "sectionId" in update)
            setOrganizationNotice(t("Unpinned"));
          if (kind === "bot" && "notifyOnFinish" in update && requestContext) {
            // The shared preference is already committed; device maintenance cannot undo it.
            try {
              const status = await afterChatNotifyChange({
                botId: chat.id,
                threadId: "threadId" in chat ? chat.threadId : undefined,
                notifyOnFinish: "notifyOnFinish" in updated && updated.notifyOnFinish,
                apiBase: requestContext.apiBase,
                token: requestContext.headers.authorization?.replace(/^Bearer /, "") ?? "",
                spaceId,
                isCurrent,
              });
              showNotificationPermission(status, isCurrent);
            } catch {
              /* Keep the confirmed preference when the device is unavailable. */
            }
          }
        },
      ).catch(reportOrganizationError);
    },
    [
      applyOrganization,
      me,
      organizationScope,
      reportOrganizationError,
      saveOrganization,
      showNotificationPermission,
      t,
    ],
  );
  const handleSectionAction = useCallback(
    (section: MobileBotSection, action: string) => {
      if (!organizationScope || !me) return;
      if (action === "rename") {
        setSectionPrompt({
          kind: "rename",
          section,
          spaceId: me.spaceId,
          scope: organizationScope,
        });
        return;
      }
      if (action === "delete") {
        void saveOrganization(
          organizationScope,
          me.spaceId,
          () => rpc<RemovedBotSection>("botSections/remove", { sectionId: section.id }),
          (snapshot) => {
            applyOrganization({ type: "remove", spaceId: me.spaceId, snapshot });
            setDeletedSection({ scope: organizationScope, spaceId: me.spaceId, snapshot });
          },
        ).catch(reportOrganizationError);
      } else if (action === "up" || action === "down") {
        const sectionIds = reorderedSectionIds(botSections, section.id, action);
        if (sectionIds)
          void saveOrganization(
            organizationScope,
            me.spaceId,
            () => rpc<MobileBotSection[]>("botSections/reorder", { sectionIds }),
            (sections) => applyOrganization({ type: "sections", spaceId: me.spaceId, sections }),
          ).catch(reportOrganizationError);
      }
    },
    [
      applyOrganization,
      botSections,
      me,
      organizationScope,
      reportOrganizationError,
      saveOrganization,
    ],
  );

  const renderItem = useCallback(
    ({ item }: { item: InboxItem }) =>
      item.type === "heading" ? (
        item.space ? (
          <InboxContextMenu
            enabled={canDeleteInboxSpace(item.space)}
            actions={[
              {
                id: "delete",
                title: t("Delete space"),
                image: "trash",
                attributes: {
                  destructive: true,
                  disabled: spaceBusy || !!spaceRecoveryId || organizationBusy,
                },
              },
            ]}
            onAction={() => {
              if (item.space) confirmDeleteSpace(item.space);
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.title}
              accessibilityState={{
                selected: item.space.id === me?.spaceId,
                disabled: spaceBusy,
              }}
              disabled={spaceBusy}
              onPress={() => {
                if (item.space) void chooseInboxSpace(item.space.id);
              }}
              style={({ pressed }) => [styles.spaceSelect, pressed && styles.rowPressed]}
            >
              <Text style={styles.spaceTitle}>{item.title}</Text>
            </Pressable>
          </InboxContextMenu>
        ) : (
          <InboxContextMenu
            enabled={!!item.section && item.spaceId === me?.spaceId && !organizationBusy}
            actions={item.section ? sectionOrganizationActions(item.section.id, botSections) : []}
            onAction={(action) => {
              if (item.section) handleSectionAction(item.section, action);
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.collapsed ? `${item.title}, ${item.count}` : item.title}
              accessibilityState={{ expanded: !item.collapsed }}
              onPress={() => toggleSidebarSection(item.key)}
              style={({ pressed }) => [styles.sectionToggle, pressed && styles.rowPressed]}
            >
              <Text style={styles.sectionTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <View style={styles.sectionIndicator}>
                {item.collapsed ? <Text style={styles.sectionCount}>{item.count}</Text> : null}
              </View>
            </Pressable>
          </InboxContextMenu>
        )
      ) : item.type === "group" ? (
        <InboxContextMenu
          enabled={(item.group.spaceId ?? me?.spaceId) === me?.spaceId && !organizationBusy}
          actions={chatOrganizationActions(item.group, botSections)}
          onAction={(action) => handleChatAction("group", item.group, action)}
        >
          <GroupRow group={item.group} day={day} onPress={openGroup} />
        </InboxContextMenu>
      ) : (
        <InboxContextMenu
          enabled={(item.bot.spaceId ?? me?.spaceId) === me?.spaceId && !organizationBusy}
          actions={chatOrganizationActions(item.bot, botSections)}
          onAction={(action) => handleChatAction("bot", item.bot, action)}
        >
          <BotRow
            bot={item.bot}
            day={day}
            depth={item.depth}
            hasChildren={item.hasChildren}
            collapsed={collapsedRosterParents.has(item.bot.id)}
            onToggleChildren={toggleRosterParent}
            onPress={openBot}
          />
        </InboxContextMenu>
      ),
    [
      botSections,
      chooseInboxSpace,
      collapsedRosterParents,
      confirmDeleteSpace,
      day,
      me?.spaceId,
      organizationBusy,
      openBot,
      openGroup,
      handleChatAction,
      handleSectionAction,
      spaceBusy,
      spaceRecoveryId,
      styles,
      t,
      toggleRosterParent,
      toggleSidebarSection,
    ],
  );

  if (!ready) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </View>
    );
  }
  if (!hasSession) return <Redirect href="/sign-in" />;

  return (
    <View style={styles.screen}>
      {nativeHeader ? null : (
        <View style={[styles.header, { paddingTop: Math.max(insets.top, 20) + 8 }]}>
          <View style={styles.circleButton}>
            <HeaderButton accessibilityLabel={t("Account")} onPress={() => router.push("/account")}>
              <Text style={styles.profileInitials}>{initials}</Text>
            </HeaderButton>
          </View>
          <View style={styles.headerActions}>
            <HeaderButton
              accessibilityLabel={t("Activity")}
              active={activityMode}
              accent
              onPress={toggleActivityMode}
            >
              <NativeSymbol
                ios={activityMode ? "bell.fill" : "bell"}
                android={activityMode ? "notifications" : "notifications-outline"}
                size={17}
                color={activityMode ? tokens.primaryForeground : tokens.foreground}
              />
            </HeaderButton>
            <HeaderButton
              accessibilityLabel={t("Search")}
              onPress={() => router.push("/search")}
              testID="home-search-button"
            >
              <NativeSymbol ios="magnifyingglass" android="search" size={17} />
            </HeaderButton>
            <HeaderButton
              accessibilityLabel={t("Artifacts")}
              onPress={() => router.push("/artifacts")}
            >
              <NativeSymbol ios="square.stack.3d.up" android="layers-outline" size={17} />
            </HeaderButton>
            <MenuView
              actions={[
                { id: "bot", title: t("New bot"), image: "person.crop.circle.badge.plus" },
                { id: "group", title: t("New group"), image: "person.2" },
                { id: "space", title: t("New space"), image: "square.grid.2x2" },
              ]}
              colorScheme={appearance}
              onPressAction={({ nativeEvent }) => {
                const action = nativeEvent.event;
                if (action === "bot" || action === "group" || action === "space") {
                  runCreateAction(action);
                }
              }}
            >
              <View
                accessibilityLabel={t("Create")}
                accessibilityRole="button"
                style={styles.headerButton}
              >
                <NativeSymbol ios="plus" android="add" size={18} />
              </View>
            </MenuView>
          </View>
        </View>
      )}

      <FlatList<InboxItem>
        style={{ flex: 1 }}
        data={listData}
        keyExtractor={(item) => {
          if (item.type === "heading") return `heading-${item.key}`;
          if (item.type === "bot") return item.bot.id;
          if (item.type === "group") return `group-${item.group.id}`;
          return "";
        }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        indicatorStyle={appearance === "dark" ? "white" : "black"}
        contentContainerStyle={styles.list}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void refreshBots();
              void loadActivity();
            }}
            tintColor={native.secondaryLabel}
            colors={[tokens.mutedForeground]}
            progressBackgroundColor={tokens.muted}
          />
        }
        ListHeaderComponent={
          <>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {spaceRecoveryId ? (
              <Pressable
                accessibilityRole="button"
                disabled={spaceBusy}
                onPress={() => void chooseInboxSpace(spaceRecoveryId)}
                style={styles.recoveryAction}
              >
                <Text style={styles.spaceTitle}>{t("Try again.")}</Text>
              </Pressable>
            ) : null}
            {activityMode && (activity.active.length > 0 || activity.recent.length > 0) ? (
              <ActivitySection activity={activity} bots={bots} />
            ) : null}
          </>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>{me ? t("Tap + to create a bot") : null}</Text>
        }
        ListFooterComponent={
          inboxNeedsCreateHint(listData) ? (
            <Text style={styles.empty}>{t("Tap + to create a bot")}</Text>
          ) : null
        }
        renderItem={renderItem}
      />
      {organizationNotice ? (
        <Text accessibilityLiveRegion="polite" style={styles.organizationNotice}>
          {organizationNotice}
        </Text>
      ) : null}
      {deletedSection?.scope === organizationScope && deletedSection ? (
        <View style={[styles.deletionFeedback, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <Text accessibilityLiveRegion="polite" style={styles.sectionTitle}>
            {t("Section deleted")}
          </Text>
          <NativeActionButton
            label={t("Undo")}
            prominence="quiet"
            size="compact"
            disabled={organizationBusy}
            onPress={() => {
              const deleted = deletedSection;
              void saveOrganization(
                deleted.scope,
                deleted.spaceId,
                () => rpc<MobileBotSection>("botSections/restore", deleted.snapshot),
                (section) => {
                  applyOrganization({
                    type: "restore",
                    spaceId: deleted.spaceId,
                    snapshot: deleted.snapshot,
                    section,
                  });
                  setDeletedSection((current) => (current === deleted ? null : current));
                },
              ).catch(reportOrganizationError);
            }}
          />
        </View>
      ) : null}
      {sectionPrompt ? (
        <SectionNamePrompt
          key={sectionPrompt.kind === "rename" ? sectionPrompt.section.id : sectionPrompt.targetId}
          title={sectionPrompt.kind === "rename" ? t("Rename section") : t("Create section")}
          initialName={sectionPrompt.kind === "rename" ? sectionPrompt.section.name : undefined}
          onClose={() =>
            setSectionPrompt((current) => (current === sectionPrompt ? null : current))
          }
          onSave={async (name) => {
            if (sectionPrompt.kind === "rename" && name === sectionPrompt.section.name.trim())
              return;
            const target = sectionPrompt;
            await saveOrganization(
              target.scope,
              target.spaceId,
              () =>
                target.kind === "rename"
                  ? rpc<MobileBotSection>("botSections/update", {
                      sectionId: target.section.id,
                      name,
                    })
                  : rpc<MobileBotSection>("botSections/create", {
                      [`${target.targetKind}Id`]: target.targetId,
                      name,
                    }),
              (section) => {
                applyOrganization({
                  type: "section",
                  spaceId: target.spaceId,
                  section,
                  target:
                    target.kind === "create"
                      ? { kind: target.targetKind, id: target.targetId }
                      : undefined,
                });
                if (target.kind === "create" && target.wasPinned)
                  setOrganizationNotice(t("Unpinned"));
                setSectionPrompt((current) => (current === target ? null : current));
              },
            );
          }}
        />
      ) : null}
    </View>
  );
}

function ActivitySection({
  activity,
  bots,
}: {
  activity: { active: RunActivityRow[]; recent: RunActivityRow[] };
  bots: MobileBot[];
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const router = useRouter();
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const openRun = (run: RunActivityRow) => {
    if (run.groupId) {
      router.push({
        pathname: "/group-thread",
        params: { groupId: run.groupId, name: run.groupName ?? t("Group") },
      });
      return;
    }
    router.push({ pathname: "/thread", params: { botId: run.botId, name: run.botName } });
  };

  return (
    <View style={styles.activitySection}>
      {activity.active.length > 0 ? (
        <>
          <Text style={styles.sectionHeading}>{t("Now")}</Text>
          {activity.active.map((run) => (
            <ActivityRow
              key={run.runId}
              run={run}
              bot={botsById.get(run.botId)}
              onPress={() => openRun(run)}
            />
          ))}
        </>
      ) : null}
      {activity.recent.length > 0 ? (
        <>
          <Text style={[styles.sectionHeading, activity.active.length > 0 && styles.activityGap]}>
            {t("Recent")}
          </Text>
          {activity.recent.map((run) => (
            <ActivityRow
              key={run.runId}
              run={run}
              bot={botsById.get(run.botId)}
              onPress={() => openRun(run)}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}

function ActivityRow({
  run,
  bot,
  onPress,
}: {
  run: RunActivityRow;
  bot?: MobileBot;
  onPress: () => void;
}) {
  const title = run.groupName ? `${run.botName} · ${run.groupName}` : run.botName;
  const status = activityStatusLabel(run.status);
  const preview = run.promptSnippet ? `${run.promptSnippet} · ${status}` : status;
  return (
    <ConversationRow
      title={title}
      preview={preview}
      time={formatActivityRelativeTime(run.updatedAt)}
      accessibilityLabel={`${title}, ${status}`}
      onPress={onPress}
      avatar={
        <BotAvatar identity={run.botId} color={bot?.color ?? FALLBACK_COLOR} status={run.status} />
      }
    />
  );
}

function ConversationRow({
  title,
  preview,
  time,
  avatar,
  indicator,
  tag,
  unread,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleChildren,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
}: {
  title: string;
  preview: string;
  time: string;
  avatar: ReactNode;
  indicator?: ReactNode;
  tag?: string | null;
  unread?: boolean;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleChildren?: () => void;
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const toggleLabel = collapsed
    ? t("Expand {name}", { name: title })
    : t("Collapse {name}", { name: title });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      // Screen readers treat the row as one element, so the chevron is offered as a row action.
      accessibilityState={hasChildren ? { expanded: !collapsed } : undefined}
      accessibilityActions={
        hasChildren ? [{ name: "toggleChildren", label: toggleLabel }] : undefined
      }
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "toggleChildren") onToggleChildren?.();
      }}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        depth > 0 ? { paddingInlineStart: 16 + depth * 16 } : null,
        pressed && styles.rowPressed,
      ]}
    >
      {hasChildren ? (
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          hitSlop={8}
          onPress={onToggleChildren}
          style={styles.treeToggle}
        >
          <NativeSymbol
            ios={collapsed ? "chevron.right" : "chevron.down"}
            android={collapsed ? "chevron-forward" : "chevron-down"}
            size={14}
          />
        </Pressable>
      ) : null}
      {avatar}
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <View style={styles.titleRow}>
            <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
              {title}
            </Text>
            {tag ? (
              <View style={styles.tag}>
                <Text style={styles.tagLabel} numberOfLines={1}>
                  {tag}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={styles.rowMeta}>
            {indicator}
            {time ? <Text style={styles.time}>{time}</Text> : null}
            {unread ? <View accessibilityElementsHidden style={styles.unreadDot} /> : null}
          </View>
        </View>
        <Text style={[styles.preview, unread && styles.unreadPreview]} numberOfLines={1}>
          {preview}
        </Text>
      </View>
    </Pressable>
  );
}

function HeaderButton({
  children,
  onPress,
  accessibilityLabel,
  testID,
  active = false,
  accent = false,
}: {
  children: ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
  active?: boolean;
  accent?: boolean;
}) {
  const styles = useThemedStyles(createHomeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.headerButton,
        accent && active
          ? styles.headerButtonAccent
          : (active || pressed) && styles.headerButtonActive,
      ]}
    >
      {children}
    </Pressable>
  );
}

const BotRow = memo(function BotRow({
  bot,
  day,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleChildren,
  onPress,
  onLongPress,
}: {
  bot: MobileBot | SpaceBot;
  day: number;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleChildren?: (botId: string) => void;
  onPress: (bot: MobileBot | SpaceBot) => void;
  onLongPress?: (bot: MobileBot | SpaceBot) => void;
}) {
  const { t } = useI18n();
  const preview = previewSnippet(bot.preview, 40) || bot.title || t("No messages yet");
  const time = bot.updatedAt ? formatThreadTime(bot.updatedAt, new Date(day)) : "";
  const tag = botTag(bot.title, bot.name);
  const working = ACTIVE_RUN_STATUSES.some((status) => status === bot.status);
  // Only flat avatars carry a usable color; image avatars fall back to the muted dot.
  const presentation = mobileBotAvatarPresentation(bot.color || FALLBACK_COLOR);
  const tint =
    presentation.kind === "shape" || presentation.kind === "color" ? presentation.color : undefined;
  // Spelled out because an explicit label replaces the one built from the row's children.
  const label = [
    bot.name,
    tag,
    working ? t("Working…") : null,
    bot.notifyOnFinish === false ? t("notifications silenced") : null,
    bot.unread ? t("unread") : null,
    time,
    preview,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <ConversationRow
      title={bot.name}
      preview={preview}
      time={time}
      tag={tag}
      unread={bot.unread}
      depth={depth}
      hasChildren={hasChildren}
      collapsed={collapsed}
      onToggleChildren={onToggleChildren ? () => onToggleChildren(bot.id) : undefined}
      accessibilityLabel={label}
      accessibilityHint={
        onLongPress ? t("Long press to pin, move, or silence notifications") : undefined
      }
      onPress={() => onPress(bot)}
      onLongPress={onLongPress ? () => onLongPress(bot) : undefined}
      indicator={working ? <WorkingIndicator compact tint={tint} /> : null}
      avatar={
        <BotAvatar
          color={bot.color || FALLBACK_COLOR}
          identity={bot.id}
          status={bot.status}
          muted={bot.notifyOnFinish === false}
        />
      }
    />
  );
});

const GroupRow = memo(function GroupRow({
  group,
  day,
  onPress,
  onLongPress,
}: {
  group: MobileGroup | SpaceGroup;
  day: number;
  onPress: (group: MobileGroup | SpaceGroup) => void;
  onLongPress?: (group: MobileGroup | SpaceGroup) => void;
}) {
  const { t } = useI18n();
  const preview =
    previewSnippet(group.preview, 40) || group.members.map((member) => member.name).join(", ");
  const time = group.updatedAt ? formatThreadTime(group.updatedAt, new Date(day)) : "";
  return (
    <ConversationRow
      title={group.name}
      preview={preview}
      time={time}
      unread={group.unread}
      accessibilityLabel={[group.name, group.unread ? t("unread") : null, time, preview]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={onLongPress ? t("Long press to pin or move to a section") : undefined}
      onPress={() => onPress(group)}
      onLongPress={onLongPress ? () => onLongPress(group) : undefined}
      avatar={<GroupAvatar members={group.members} size={54} />}
    />
  );
});

function createHomeStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.page,
    },
    centered: {
      alignItems: "center",
      justifyContent: "center",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 10,
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      padding: 2,
      borderRadius: 22,
      backgroundColor: native.fillPressed,
    },
    circleButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: native.fillPressed,
    },
    headerButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    headerButtonActive: {
      backgroundColor: native.fill,
    },
    headerButtonAccent: {
      backgroundColor: tokens.primary,
    },
    profileInitials: {
      color: native.label,
      fontSize: 15,
      fontWeight: "600",
    },

    error: {
      color: native.secondaryLabel,
      paddingHorizontal: 20,
      paddingBottom: 8,
    },
    list: {
      flexGrow: 1,
      paddingBottom: 32,
    },
    empty: {
      color: native.secondaryLabel,
      fontSize: 16,
      paddingHorizontal: 20,
      paddingTop: 28,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 10,
      gap: 12,
    },
    treeToggle: {
      width: 20,
      height: 20,
      alignItems: "center",
      justifyContent: "center",
      marginRight: -4,
    },
    rowPressed: {
      opacity: 0.55,
    },
    rowBody: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    rowTop: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    titleRow: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    rowMeta: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
    },
    name: {
      flexShrink: 1,
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
      writingDirection: "auto",
    },
    tag: {
      flexShrink: 1,
      borderRadius: 999,
      backgroundColor: native.fill,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    tagLabel: {
      color: native.secondaryLabel,
      fontSize: 11,
      fontWeight: "500",
      writingDirection: "auto",
    },
    time: {
      color: native.secondaryLabel,
      fontSize: 15,
    },
    preview: {
      color: native.secondaryLabel,
      fontSize: 15,
      lineHeight: 20,
      writingDirection: "auto",
    },
    unreadPreview: {
      color: native.label,
      fontWeight: "600",
    },
    unreadDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: tokens.foreground,
    },
    spaceSelect: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    spaceTitle: {
      color: native.label,
      fontSize: 14,
      fontWeight: "600",
      writingDirection: "auto",
    },
    recoveryAction: {
      minHeight: 44,
      paddingHorizontal: 20,
      justifyContent: "center",
    },
    sectionHeading: {
      color: native.secondaryLabel,
      fontSize: 14,
      fontWeight: "600",
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    sectionToggle: {
      minHeight: 44,
      paddingHorizontal: 16,
      paddingTop: 8,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    sectionTitle: {
      flex: 1,
      color: native.secondaryLabel,
      fontSize: 14,
      fontWeight: "600",
      writingDirection: "auto",
    },
    sectionIndicator: { width: 28, alignItems: "flex-end" },
    sectionCount: {
      color: native.secondaryLabel,
      fontSize: 13,
      fontVariant: ["tabular-nums"],
    },
    deletionFeedback: {
      minHeight: 48,
      paddingHorizontal: 16,
      paddingTop: 8,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.fillPressed,
    },
    organizationNotice: {
      color: native.secondaryLabel,
      fontSize: 13,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    activitySection: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: native.fillPressed,
      marginBottom: 4,
      paddingBottom: 4,
    },
    activityGap: {
      paddingTop: 16,
    },
    groupAvatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: native.fill,
      alignItems: "center",
      justifyContent: "center",
    },
    groupAvatarLabel: {
      color: native.secondaryLabel,
      fontSize: 16,
      fontWeight: "600",
    },
  });
}
