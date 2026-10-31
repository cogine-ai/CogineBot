import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  AgentSkillCatalogEntry,
  Bot,
  BotSection,
  ComputerReleaseReason,
  ComputerStatus,
  Connection,
  ConnectionCatalogItem,
  Group,
  Me,
  ProductEvent,
  RemovedBotSection,
  Routine,
  SearchHit,
  Space,
  SpaceMemoryConfig,
  TaughtSkill,
  ThreadMessage,
  ThreadSnapshot,
  VoiceStatus,
} from "@rakazo/contracts";
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  canReactToThreadMessage,
  MESSAGE_REACTIONS,
  type MessageReaction,
} from "@rakazo/contracts";
import type { AnnouncementEvent, BotCreationReceipt } from "@rakazo/core";
import {
  attachmentLabels,
  buildComposerMentionOptions,
  type ComposerMention,
  clampMentionHighlightIndex,
  createComputerHeartbeat,
  createGroupSettingsSave,
  cronFromPreset,
  formatMessageTime,
  groupVoiceChats,
  inferAttachmentMimeType,
  isActive,
  isApprovalAskBlock,
  isPeerReceiptBlocks,
  isRunTerminalEvent,
  isServerUnreachable,
  isToolActivityBlock,
  latestAnswerableAskMessageId,
  mentionChipKey,
  messageAttachmentLabels,
  messageBlocksForQuestionCards,
  nestRosterByParent,
  parseModelOptionKey,
  plainTextFromMarkdown,
  projectMessageReactions,
  reorderBotTo,
  replyAttachment,
  resolveComposerSendPlan,
  resolveMentionPickerKey,
  runThreadSubscription,
  SLASH_ACTIONS,
  type SlashActionId,
  searchHitThreadTarget,
  serializeComposerPrompt,
  speechFromBlocks,
  timeSeparatorIds,
  truncateSlashDescription,
  userVisibleMessages,
  withLiveStreamingProgress,
} from "@rakazo/core";
import {
  AccountAvatar,
  AttachmentPreview,
  BotAvatar,
  Button,
  CogineBotWordmark,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  GroupAvatar,
  type GroupAvatarMember,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  MessageInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Box,
  Check,
  ChevronDown,
  Copy,
  Gauge,
  Layers,
  LayoutGrid,
  LogOut,
  Maximize2,
  Menu,
  Mic,
  Monitor,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Reply,
  Search,
  Settings,
  Smile,
  Square,
  SquareKanban,
  TextQuote,
  Trash2,
  X,
} from "lucide-react";
import type { ClipboardEvent, DragEvent, MutableRefObject, ReactNode, RefObject } from "react";
import {
  Fragment,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArtifactFileCard } from "../components/ArtifactFileCard";
import { AskCard } from "../components/AskCard";
import { ActiveBotGlyph, CollaborationMarker } from "../components/ai/CollaborationMarker";
import { CloudAgentCard } from "../components/CloudAgentCard";
import { ComputerMaintenanceActions } from "../components/ComputerMaintenanceActions";
import {
  ComputersUnavailableHint,
  computersAreUnavailable,
} from "../components/ComputersUnavailableHint";
import { ComputerUpdateProgress } from "../components/ComputerUpdateProgress";
import { CallCard } from "../components/call/CallCard";
import { VoiceChatCard } from "../components/call/VoiceChatCard";
import { ComputerWorkspace } from "../components/computer/ComputerWorkspace";
import { lazyOverlay } from "../components/ErrorBoundary";
import { LoadFailureNotice } from "../components/LoadFailureNotice";
import { MessageHoverMetadata } from "../components/MessageHoverMetadata";
import { RunErrorDetails } from "../components/RunErrorDetails";
import {
  LIVE_TOOL_STEP_WINDOW,
  StandaloneToolActivity,
  ToolActivityDisclosure,
  ToolOnlyNarration,
  ToolSteps,
} from "../components/ToolActivityDisclosure";
import { SkillDraftCard } from "../components/teach/SkillDraftCard";
import { TeachCaptureOverlay } from "../components/teach/TeachCaptureOverlay";
import { TeachComputerOverlayControl } from "../components/teach/TeachComputerOverlay";
import { TeachRecordingChrome, TeachStopButton } from "../components/teach/TeachRecordingChrome";
import { readActivityMode, writeActivityMode } from "../lib/activity-mode";
import type { ArtifactTarget } from "../lib/artifact-open";
import { authClient } from "../lib/auth";
import { isRecoverableReadError, takeInitialBootstrap } from "../lib/bootstrap";
import { readBotsSidebarCollapsed, writeBotsSidebarCollapsed } from "../lib/bots-sidebar-pref";
import {
  deliverBrowserNotification as deliverNativeBrowserNotification,
  requestBrowserNotificationPermission,
  shouldNotifyBrowser,
} from "../lib/browser-notifications";
import { startCall, useCallSession } from "../lib/call-session";
import { newClientId } from "../lib/client-id";
import type {
  ComposerDraft,
  ComposerDraftChange,
  PendingComposerAttachment,
} from "../lib/composer-draft";
import {
  clearComposerDrafts,
  consumeSubmittedComposerDraft,
  insertEmptyComposerDraft,
  makeComposerDraftKey,
  moveComposerDraft,
  readComposerDraft,
} from "../lib/composer-draft";
import {
  cancelPreparedRejectedComposerDraft,
  discardRejectedComposerDraft,
  prepareRejectedComposerDraft,
  rememberVerifiedComposerRecoveryTarget,
  restoreRejectedComposerDraft,
} from "../lib/composer-rejected-draft";
import { composerSendAttempts, composerSendSignature } from "../lib/composer-send-attempt";
import {
  embeddableScreenUrl,
  loadComputerScreen,
  screenIframeSandbox,
} from "../lib/computer-screen";
import { publishComputerCommand } from "../lib/computer-workspace";
import { conversationMessages } from "../lib/conversation-messages";
import { desktopBridge } from "../lib/desktop";
import {
  calculateDesktopWorkspaceLayout,
  useDesktopWorkspaceLayout,
} from "../lib/desktop-workspace-layout";
import { syncSavedGroupSnapshot } from "../lib/group-settings-state";
import { localTimezone } from "../lib/local-timezone";
import { currentMentionAppearance } from "../lib/mention-display";
import { copyableMessageText } from "../lib/message-text";
import { messageProviderLabel } from "../lib/messaging";
import { groupCreationIntent, newChatDraft } from "../lib/new-chat";
import {
  isFileDrag,
  isFilePaste,
  readFileAsBase64,
  revokePendingAttachmentPreviews,
} from "../lib/pending-attachments";
import { markAfterPaint, markOnce } from "../lib/performance";
import {
  consumePreloadRecoverySnapshot,
  registerPreloadRecoverySnapshot,
} from "../lib/preload-recovery-state";
import { quoteDraftForSelection } from "../lib/quote-selection";
import { getResponseStreamingEnabled, subscribeResponseStreaming } from "../lib/response-streaming";
import type { Panel, RightPanelState } from "../lib/right-panel-state";
import {
  readRightPanelState,
  rightPanelStorageKey,
  writeRightPanelState,
} from "../lib/right-panel-state";
import {
  clearSpaceSelection,
  createSpaceRpc,
  currentRpcSessionGeneration,
  currentSpaceSelectionGeneration,
  rememberImplicitRpcSpace,
  rpc,
  selectedSpaceId,
  selectSpace,
} from "../lib/rpc";
import { readSeenRunErrorIds, rememberSeenRunErrorId } from "../lib/run-error-storage";
import { sharedInflight } from "../lib/shared-inflight";
import {
  activeThreadRuns,
  applyThreadSendReceipt,
  clearActiveThreadRuns,
  computerPanelNeedsMaintenance,
  computerPanelNeedsScreen,
  computerTakeoverBlocked,
  isComputerStatusEvent,
  isThreadSnapshotEvent,
  prependThreadMessagePage,
  protectThreadMessagePage,
  reconcileRefreshedThread,
  reduceComputerStatus,
  reduceThreadSnapshot,
  threadRunError,
  userHoldsComputerControl,
} from "../lib/thread-events";
import { readThreadSnapshot } from "../lib/thread-snapshot-request";
import { getToolActivityEnabled, subscribeToolActivity } from "../lib/tool-activity-preference";
import {
  isToolOnlyNarration,
  messageHasVisibleBlocks,
  renderableMessageBlocks,
  shouldRenderToolCard,
  toolStepCount,
} from "../lib/tool-activity-view";
import {
  transcriptCanSnapAfterFrame,
  transcriptIsNearEnd,
  transcriptMovedDown,
} from "../lib/transcript-scroll";
import { speaker } from "../lib/tts";
import { useAccountTimezone } from "../lib/use-account-timezone";
import { useBotCreation, useBotCreationEditor } from "../lib/use-bot-creation";
import { useComposerDraft } from "../lib/use-composer-draft";
import { useReplyAnnouncements } from "../lib/use-reply-announcements";
import { useSidebarAnnouncements } from "../lib/use-sidebar-announcements";
import { errorText } from "../lib/user-error";
import { ActivityList } from "./ActivityList";
import type { ContextMenuPosition } from "./BotContextMenu";
import { GroupSettings, memberName } from "./GroupPanel";
import { HostComputerPrompt } from "./HostComputerPrompt";
import { ResizableSidePanel } from "./ResizableSidePanel";
import {
  draftFromRoutine,
  emptyRoutineDraft,
  type RoutineDraftState,
  RoutineEditor,
  RoutineListHeader,
  RoutineListRow,
  routineNeedsOneShotArm,
} from "./RoutineEditor";
import { nativeRoutineTriggerInputs } from "./routine-native-events";
import type { SettingsSection } from "./SettingsOverlay";
import { SpaceSearchResults } from "./SpaceSearch";
import { BotSettings, CreateBotForm } from "./shell/bot-panel";
import { ComposerReplyPreview, ReplyLine, TimeSeparator } from "./shell/chat-context";
import { ChatRecipients } from "./shell/chat-recipients";
import { CommandPalette, isCommandPaletteHotkey } from "./shell/command-palette";
import { ConversationRow } from "./shell/conversation-row";
import {
  ClearConversationDialog,
  DeleteBotDialog,
  DeleteItemDialog,
  NewSpaceDialog,
  RenameSpaceDialog,
} from "./shell/dialogs";
import { GroupTitle } from "./shell/group-title";
import { InlineSectionName } from "./shell/inline-section-name";
import { MentionIdentity, SentMentionText, useBotIdentityTextColor } from "./shell/mention-display";
import {
  AppConnectCard,
  ArtifactImage,
  ChartBlockView,
  ChoiceCard,
  McpApprovalCard,
} from "./shell/message-cards";
import { SidebarSectionHeader } from "./shell/sidebar-section-header";
import {
  commitSpaceRename,
  restoreSidebarSectionOrder,
  sidebarGroupsForSpaces,
} from "./shell/space-sidebar";
import { useContextPress } from "./shell/use-context-press";
import { WindowChrome } from "./WindowChrome";

type SidebarChatTarget = {
  kind: "bot" | "group";
  chat: Pick<Bot, "id" | "spaceId" | "sectionId" | "pinned">;
};

const BotContextMenu = lazyOverlay(() =>
  import("./BotContextMenu").then((module) => module.BotContextMenu),
);
const MessagingSettingsOverlay = lazyOverlay(() =>
  import("./MessagingSettingsOverlay").then((module) => module.MessagingSettingsOverlay),
);
const SettingsOverlay = lazyOverlay(() =>
  import("./SettingsOverlay").then((module) => module.SettingsOverlay),
);
const PeerMessagesOverlay = lazyOverlay(() =>
  import("./PeerMessagesOverlay").then((module) => module.PeerMessagesOverlay),
);
const PluginsOverlay = lazyOverlay(() =>
  import("./PluginsOverlay").then((module) => module.PluginsOverlay),
);
const McpServersOverlay = lazyOverlay(() =>
  import("./McpServersOverlay").then((module) => module.McpServersOverlay),
);

type PendingAttachment = PendingComposerAttachment;

type PendingBrowserNotification = {
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "botId" | "payload">;
  botId: string;
  botName: string;
  groupNotification: boolean;
};

const ATTACHMENT_ACCEPT = ATTACHMENT_ALLOWED_MIME_TYPES.join(",");
/** Identity colour for bots the roster no longer knows about. */
const FALLBACK_BOT_COLOR = "#85858A";
/** Bound Settings leave so a hung voice status refresh cannot block dismissal. */
const VOICE_STATUS_REFRESH_TIMEOUT_MS = 10_000;
const MOBILE_SIDEBAR_SWIPE_EDGE_PX = 32;
const MOBILE_SIDEBAR_SWIPE_DISTANCE_PX = 56;
function voiceStatusRefreshTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    AbortSignal.timeout(VOICE_STATUS_REFRESH_TIMEOUT_MS).addEventListener("abort", () => {
      reject(new DOMException("Voice status refresh timed out", "TimeoutError"));
    });
  });
}

function collapsedSidebarSectionsStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `rakazo:collapsed-sidebar-sections:${userId}`;
}

function collapsedRosterParentsStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `rakazo:collapsed-roster-parents:${userId}`;
}

function readCollapsedIdSet(storageKey: string | null): Set<string> {
  if (!storageKey) return new Set();
  try {
    const value = window.localStorage.getItem(storageKey);
    const keys: unknown = value ? JSON.parse(value) : [];
    return new Set(
      Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function toggleCollapsedIdSet(
  previous: ReadonlySet<string>,
  id: string,
  storageKey: string | null,
): Set<string> {
  const next = new Set(previous);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  if (storageKey) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...next]));
    } catch {
      // Keep the UI usable when storage is unavailable.
    }
  }
  return next;
}

function readCollapsedSidebarSections(userId: string | null | undefined): Set<string> {
  return readCollapsedIdSet(collapsedSidebarSectionsStorageKey(userId));
}

function readCollapsedRosterParents(userId: string | null | undefined): Set<string> {
  return readCollapsedIdSet(collapsedRosterParentsStorageKey(userId));
}

export function ShellPage() {
  const { t } = useLingui();
  const { botId, groupId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Mirrors searchParams for effects that only need to read it once on run,
  // not re-run on every unrelated query-param change (e.g. the SSE subscribe
  // effect below, which should only restart when the active bot changes).
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const [groups, setGroups] = useState<Group[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const botOrderEpochRef = useRef(0);
  const pendingBotOrderRef = useRef<string[] | null>(null);
  const pendingBotOrderAnnouncement = useRef<((success: boolean) => void) | null>(null);
  const savingBotOrderRef = useRef(false);
  const [botOrderStatus, setBotOrderStatus] = useState<"saving" | "unconfirmed" | null>(null);
  const [botSections, setBotSections] = useState<BotSection[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [archivedBots, setArchivedBots] = useState<Bot[]>([]);
  const [archivedGroups, setArchivedGroups] = useState<Group[]>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState(() => new Set<string>());
  const [collapsedRosterParents, setCollapsedRosterParents] = useState(() => new Set<string>());

  useEffect(() => {
    setCollapsedSidebarSections(readCollapsedSidebarSections(userId));
    setCollapsedRosterParents(readCollapsedRosterParents(userId));
  }, [userId]);
  useEffect(() => {
    setBotsSidebarCollapsed(readBotsSidebarCollapsed(userId));
  }, [userId]);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);
  const streamResponses = useSyncExternalStore(
    subscribeResponseStreaming,
    getResponseStreamingEnabled,
    () => false,
  );
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;
  const showToolActivity = useSyncExternalStore(
    subscribeToolActivity,
    getToolActivityEnabled,
    () => true,
  );
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<{
    scopeKey: string;
    text: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [panel, setPanelState] = useState<Panel>(null);
  const [restoredPanelKey, setRestoredPanelKey] = useState<string | null>(null);
  const panelStorageKeyRef = useRef<string | null>(null);
  const observedPanelKey = useRef<string | null>(null);
  const explicitPanelTarget = useRef<string | null>(null);
  const pendingPanelRestore = useRef<RightPanelState | null>(null);
  const pendingExplicitPanel = useRef(false);
  const panelSearch = useRef({ searchParams, setSearchParams });
  panelSearch.current = { searchParams, setSearchParams };
  const setPanel = useCallback((next: Panel | ((current: Panel) => Panel)) => {
    // A user navigation wins over a saved routine still waiting for its list.
    pendingPanelRestore.current = null;
    pendingExplicitPanel.current = panelStorageKeyRef.current === null;
    setRestoredPanelKey(panelStorageKeyRef.current);
    setPanelState(next);
    const currentSearch = panelSearch.current;
    if (currentSearch.searchParams.has("routine")) {
      const params = new URLSearchParams(currentSearch.searchParams);
      params.delete("routine");
      currentSearch.setSearchParams(params, { replace: true });
    }
  }, []);
  const [peerConversation, setPeerConversation] = useState<{
    botId: string;
    peerBotId: string;
    peerBotName: string;
  } | null>(null);
  const peerConversationRef = useRef(peerConversation);
  peerConversationRef.current = peerConversation;
  const hadPeerConversation = useRef(false);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const [taughtSkills, setTaughtSkills] = useState<TaughtSkill[]>([]);
  const [taughtSkillsBotId, setTaughtSkillsBotId] = useState<string | null>(null);
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [mentionRoutines, setMentionRoutines] = useState<Array<Routine & { botName?: string }>>([]);
  const [mentionConnectors, setMentionConnectors] = useState<
    Array<{
      id: string;
      name: string;
      authStatus: "connected" | "needs_auth";
      connectionId?: string;
    }>
  >([]);
  const [teachBusy, setTeachBusy] = useState(false);
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const computerRef = useRef<ComputerStatus | null>(null);
  const threadRefreshEpoch = useRef(0);
  const groupRefreshEpoch = useRef(0);
  const savedGroupUpdates = useRef(new Map<string, Group>());
  const botsRefreshEpoch = useRef(0);
  const botsRefreshApplied = useRef(0);
  const archivedBotsRefreshEpoch = useRef(0);
  const botsRefreshInFlight = useRef(0);
  // A very fast run can finish over SSE while its threads.send response is still
  // returning. Do not let that late receipt resurrect terminal work as queued.
  const terminalRunReceipts = useRef(new Set<string>());
  const replyEventObserver = useRef<(event: AnnouncementEvent) => void>(() => {});
  // Last-known computer/screen per bot, so switching back to an already-seen
  // bot paints its computer pane instantly instead of blanking it while the
  // thread + screen RPCs round-trip again (see refreshThread / refreshComputerScreen).
  const computerCacheRef = useRef(
    new Map<string, { computer: ComputerStatus | null; screenUrl: string | null }>(),
  );
  // Caps computerCacheRef so a long session that opens many distinct bots
  // over time doesn't accumulate one entry per bot forever. Re-inserting on
  // every update keeps Map iteration order as least-recently-used first, so
  // eviction drops the bot that's been out of view longest.
  const COMPUTER_CACHE_LIMIT = 20;

  function cacheComputerFor(
    botId: string,
    patch: Partial<{ computer: ComputerStatus | null; screenUrl: string | null }>,
  ) {
    const cache = computerCacheRef.current;
    const prev = cache.get(botId) ?? { computer: null, screenUrl: null };
    cache.delete(botId);
    cache.set(botId, { ...prev, ...patch });
    if (cache.size > COMPUTER_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  function commitSnapshot(next: ThreadSnapshot | null) {
    snapshotRef.current = next;
    setSnapshot(withLiveStreamingProgress(next, streamResponsesRef.current));
  }

  useEffect(() => {
    setSnapshot(withLiveStreamingProgress(snapshotRef.current, streamResponses));
  }, [streamResponses]);

  function commitComputer(
    next: ComputerStatus | null,
    observation: "snapshot" | "running-event" | "attendance-read" = "snapshot",
  ) {
    const before = computerRef.current;
    computerRef.current = next;
    setComputer(next);
    const confirmed = screenReadiness.current?.confirmed;
    // An in-flight first read can confirm a snapshot; events invalidate a possibly older read.
    if (
      observation !== "attendance-read" &&
      (next !== before || observation === "running-event") &&
      next?.state === "running" &&
      (before?.state !== "running" || confirmed !== true) &&
      (observation === "running-event" || typeof confirmed === "boolean")
    )
      recheckComputerStatus.current?.(next.botId);
  }

  function commitComputerEvent(next: ComputerStatus | null, event: ProductEvent) {
    commitComputer(
      next,
      event.type === "computer.status" &&
        event.payload.status === "running" &&
        next?.botId === event.botId
        ? "running-event"
        : "snapshot",
    );
  }

  function updateSnapshot(update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) {
    commitSnapshot(update(snapshotRef.current));
  }
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [connectionsRevision, setConnectionsRevision] = useState(0);
  const connectionsChanged = useCallback(() => setConnectionsRevision((value) => value + 1), []);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsSpaceId, setSettingsSpaceId] = useState<string | null>(null);
  const [messagingSettingsOpen, setMessagingSettingsOpen] = useState(false);
  const [messagingSurfaceEnabled, setMessagingSurfaceEnabled] = useState(false);
  const [messagingProviders, setMessagingProviders] = useState<string[]>([]);
  const [memoryProviderConfig, setMemoryProviderConfig] = useState<
    SpaceMemoryConfig | null | undefined
  >(undefined);
  const memoryProviderConfigRevision = useRef(0);
  const call = useCallSession();
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [dismissedRunErrorIds, setDismissedRunErrorIds] =
    useState<ReadonlySet<string>>(readSeenRunErrorIds);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const mobileSidebarSwipeRef = useRef<{ startX: number; startY: number } | null>(null);
  const [draggedBotId, setDraggedBotId] = useState<string | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [pendingChat, setPendingChat] = useState(newChatDraft);
  const inNewChat = searchParams.has("new-chat");
  const pendingChatRef = useRef(pendingChat);
  pendingChatRef.current = pendingChat;
  const inNewChatRef = useRef(inNewChat);
  inNewChatRef.current = inNewChat;
  const [botsSidebarCollapsed, setBotsSidebarCollapsed] = useState(false);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [spacePickerOpen, setSpacePickerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const sidebarSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    function closeMobileSidebar() {
      if (desktop.matches) setMobileSidebarOpen(false);
    }
    closeMobileSidebar();
    desktop.addEventListener("change", closeMobileSidebar);
    return () => desktop.removeEventListener("change", closeMobileSidebar);
  }, []);
  const [activityMode, setActivityMode] = useState(readActivityMode);
  const toggleActivityMode = useCallback(() => {
    setActivityMode((on) => {
      const next = !on;
      writeActivityMode(next);
      return next;
    });
  }, []);
  const [botMenu, setBotMenu] = useState<{
    kind: "bot" | "group";
    id: string;
    position: ContextMenuPosition;
  } | null>(null);
  // The context menu anchors to the pointer, so return focus to the row that opened it.
  const botMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (botMenu || !botMenuAnchor.current) return;
    botMenuAnchor.current.focus();
    botMenuAnchor.current = null;
  }, [botMenu]);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);
  const [deleteSpaceTarget, setDeleteSpaceTarget] = useState<Space | null>(null);
  const [renameSpaceTarget, setRenameSpaceTarget] = useState<Space | null>(null);
  const [spaceMenu, setSpaceMenu] = useState<{
    id: string;
    position: ContextMenuPosition;
  } | null>(null);
  const spaceMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (spaceMenu || !spaceMenuAnchor.current) return;
    spaceMenuAnchor.current.focus();
    spaceMenuAnchor.current = null;
  }, [spaceMenu]);
  const closeSpaceMenu = useCallback(() => setSpaceMenu(null), []);
  const spaceMenuTarget = spaceMenu
    ? (spaces.find((space) => space.id === spaceMenu.id) ?? null)
    : null;
  const [clearTarget, setClearTarget] = useState<
    { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group } | null
  >(null);
  const [newSectionTarget, setNewSectionTarget] = useState<
    { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group } | null
  >(null);
  const [renameSectionTarget, setRenameSectionTarget] = useState<{
    section: BotSection;
    spaceId: string;
  } | null>(null);
  const [sectionMenu, setSectionMenu] = useState<{
    section: BotSection;
    spaceId: string;
    position: ContextMenuPosition;
  } | null>(null);
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  const [sidebarNotice, setSidebarNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!sidebarNotice) return;
    const timer = window.setTimeout(() => setSidebarNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [sidebarNotice]);
  const [deletedSection, setDeletedSection] = useState<{
    snapshot: RemovedBotSection;
    spaceId: string;
  } | null>(null);
  const organizationUndo = useRef<(() => Promise<void>) | null>(null);
  const deletionUndo = useRef<(() => Promise<void>) | null>(null);
  const organizationPending = useRef(false);
  const [draggedSection, setDraggedSection] = useState<{ id: string; spaceId: string } | null>(
    null,
  );
  const [draggedChat, setDraggedChat] = useState<SidebarChatTarget | null>(null);
  const sectionMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (sectionMenu || !sectionMenuAnchor.current) return;
    sectionMenuAnchor.current.focus();
    sectionMenuAnchor.current = null;
  }, [sectionMenu]);
  const closeSectionMenu = useCallback(() => setSectionMenu(null), []);
  const [booting, setBooting] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [initialBotsLoaded, setInitialBotsLoaded] = useState(false);
  const [bootstrapMe, setBootstrapMe] = useState<Me | null>();
  const [bootstrapLoad, setBootstrapLoad] = useState<{ pending: boolean; error: unknown }>({
    pending: true,
    error: null,
  });
  const retryBootstrap = useRef(() => {});
  const [threadRetry, setThreadRetry] = useState(0);
  const [threadConnection, setThreadConnection] = useState<{
    target: string;
    status: "loading" | "recovering" | "ready" | "failed";
    error?: string;
  } | null>(null);
  const observeThreadConnection = useCallback(
    (target: string, controller: AbortController) =>
      (status: "loading" | "recovering" | "ready", error?: unknown) => {
        if (controller.signal.aborted) return;
        if (error !== undefined && !isRecoverableReadError(error)) {
          setThreadConnection({
            target,
            status: "failed",
            error: errorText(error, t`Could not load this chat.`),
          });
          controller.abort();
          return;
        }
        setThreadConnection({ target, status });
      },
    [t],
  );
  const [keepComputerRecovery, setKeepComputerRecovery] = useState(false);
  const recoveryHoldTimer = useRef<number | undefined>(undefined);
  const showComputerRecoveryHint =
    computersAreUnavailable(bootstrapMe?.sandboxProvider) || keepComputerRecovery;
  const releaseComputerRecovery = useCallback(() => {
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = undefined;
    setKeepComputerRecovery(false);
  }, []);
  const holdComputerRecovery = useCallback(() => {
    setKeepComputerRecovery(true);
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = window.setTimeout(() => {
      recoveryHoldTimer.current = undefined;
      setKeepComputerRecovery(false);
    }, 4000);
  }, []);
  useEffect(() => {
    if (panel !== "computer") releaseComputerRecovery();
  }, [panel, releaseComputerRecovery]);
  useEffect(() => () => window.clearTimeout(recoveryHoldTimer.current), []);
  const [routineDraft, setRoutineDraft] = useState<RoutineDraftState>(emptyRoutineDraft());
  const [routineWebhookSecret, setRoutineWebhookSecret] = useState<string | null>(null);
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);
  const [deleteRoutineTarget, setDeleteRoutineTarget] = useState<Routine | null>(null);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [runningRoutine, setRunningRoutine] = useState(false);
  const [routineError, setRoutineError] = useState<string | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [visibleComputerScreen, setVisibleComputerScreen] = useState<{
    botId: string;
    ownerKey: string;
    spaceId: string | null;
    selection: number;
  } | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [takingComputerControl, setTakingComputerControl] = useState(false);
  const computerControlPending = useRef(false);
  const [computerBotId, setComputerBotId] = useState<string | undefined>();
  const computerOpenRef = useRef(false);
  const computerBotIdRef = useRef<string | undefined>(undefined);
  const computerBootEpoch = useRef(0);
  const computerBootObservation = useRef<(() => boolean) | null>(null);
  const computerBootAttempt = useRef<{
    botId: string;
    isCurrent: () => boolean;
    promise: Promise<ComputerStatus>;
  } | null>(null);
  function invalidateComputerBoot() {
    computerBootEpoch.current += 1;
    computerBootObservation.current = null;
    computerBootAttempt.current = null;
    setBooting(false);
  }
  const openComputerRef = useRef<(botId?: string) => Promise<boolean>>(async () => false);
  const [computerViewport, setComputerViewport] = useState<{
    height: number;
    offsetTop: number;
  } | null>(null);
  const [computerError, setComputerError] = useState<string | null>(null);
  // Screen-load failures can sit beside a still-valid embed URL; boot and
  // takeover failures must stay visible even when a URL remains.
  const [computerErrorFromScreen, setComputerErrorFromScreen] = useState(false);
  useEffect(() => {
    if (!computerOpen) {
      setComputerViewport(null);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      setComputerViewport({ height: viewport.height, offsetTop: viewport.offsetTop });
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, [computerOpen]);
  useEffect(() => {
    if (!session.data?.user) return;
    let cancelled = false;
    void rpc.messaging
      .status()
      .then((status) => {
        if (!cancelled) {
          setMessagingSurfaceEnabled(status.enabled);
          setMessagingProviders(status.providers);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.data?.user]);
  const [usage, setUsage] = useState<{
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens?: number | null;
    runs: number;
  } | null>(null);
  const refreshUsage = useCallback(() => {
    void rpc.usage
      .summary()
      .then(setUsage)
      .catch(() => undefined);
  }, []);
  const autoBooted = useRef<string | null>(null);
  const routineSavePending = useRef(false);
  const webhookSecretProvisionRef = useRef(new Map<string, Promise<string>>());
  const ensureWebhookSecret = (botId: string) =>
    sharedInflight(webhookSecretProvisionRef.current, botId, async () => {
      const result = await rpc.bots.rotateWebhookSecret({ botId });
      setRoutineWebhookSecret(result.secret);
      setBots((current) =>
        current.map((bot) => (bot.id === botId ? { ...bot, webhookConfigured: true } : bot)),
      );
      return result.secret;
    });
  const routineSaveRequest = useRef(0);
  const routineRunPending = useRef(false);
  const bootstrappedThread = useRef<ThreadSnapshot | null>(null);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const [scrollRequest, setScrollRequest] = useState<{
    messageId: string;
    nonce: number;
  } | null>(null);
  const clearScrollRequest = useCallback(() => setScrollRequest(null), []);
  const initiallyScrolledThread = useRef<string | null>(null);
  const messageScroll = useRef<HTMLDivElement>(null);
  const pinnedAroundRef = useRef<{
    botId?: string;
    groupId?: string;
    messageId: string;
    threadId: string;
    messages: ThreadMessage[];
    olderCursor: number | null;
  } | null>(null);
  const manuallyUnread = useRef(new Set<string>());
  const unreadRequests = useRef(new Map<string, Promise<unknown>>());
  const readVisibleGroups = useRef(new Set<string>());
  const notifiedBrowserEvents = useRef(new Set<string>());
  const pendingBrowserNotifications = useRef(new Map<string, PendingBrowserNotification>());
  const computerVisible = useRef(false);
  const computerSelection = currentSpaceSelectionGeneration();
  const watchingComputer = panel === "computer" || computerOpen;
  computerVisible.current = watchingComputer;
  const autoSpoken = useRef<string | null>(null);
  const autoSpokenBotId = useRef<string | null>(null);

  const inGroup = Boolean(groupId);
  const active = inGroup || inNewChat ? undefined : (bots.find((b) => b.id === botId) ?? bots[0]);
  const computerBot =
    (computerBotId ? bots.find((bot) => bot.id === computerBotId) : undefined) ?? active;
  computerOpenRef.current = computerOpen;
  computerBotIdRef.current = computerBotId ?? active?.id;
  const activeGroup = inNewChat ? undefined : groups.find((group) => group.id === groupId);
  const draftScopeKey =
    userId && bootstrapMe?.spaceId && (inNewChat || groupId || active?.id)
      ? makeComposerDraftKey({
          userId,
          spaceId: bootstrapMe.spaceId,
          targetKind: inNewChat ? "new-chat" : inGroup ? "group" : "bot",
          targetId: inNewChat ? pendingChat.id : inGroup ? groupId! : active!.id,
        })
      : null;
  const { draft: composerDraft, updateDraft: updateComposerDraft } =
    useComposerDraft(draftScopeKey);
  const draftScopeKeyRef = useRef(draftScopeKey);
  draftScopeKeyRef.current = draftScopeKey;
  const threadCheckpoint = useRef<{
    scope: string;
    threadId: string;
    cursor: number;
  } | null>(null);
  useEffect(() => {
    if (threadCheckpoint.current?.scope !== draftScopeKey) threadCheckpoint.current = null;
  }, [draftScopeKey]);
  const pendingAttachments = composerDraft.attachments;
  const activePendingAttachments = pendingAttachments;
  const replyTarget = composerDraft.replyTarget;
  const replyQuote = composerDraft.replyQuote;
  const setReplyTarget = (value: ThreadMessage | null) =>
    updateComposerDraft({ replyTarget: value });
  const setReplyQuote = (value: string | null) => updateComposerDraft({ replyQuote: value });
  const activeRoutines = !inGroup && routinesBotId === active?.id ? routines : [];
  const panelTarget = inGroup ? activeGroup?.id : active?.id;
  const panelStorageKey =
    userId && bootstrapMe?.spaceId && panelTarget
      ? rightPanelStorageKey(userId, bootstrapMe.spaceId, inGroup ? "group" : "bot", panelTarget)
      : null;
  panelStorageKeyRef.current = panelStorageKey;
  const activeTaughtSkills = taughtSkillsBotId === active?.id ? taughtSkills : [];
  const recordingSkill = activeTaughtSkills.find((skill) => skill.status === "recording") ?? null;
  const routeBotId = useRef<string | undefined>(botId);
  routeBotId.current = botId;
  const routeGroupId = useRef<string | undefined>(groupId);
  routeGroupId.current = groupId;
  const activeBotId = useRef<string | undefined>(inGroup ? undefined : active?.id);
  activeBotId.current = inGroup ? undefined : active?.id;
  const activeGroupId = useRef<string | undefined>(groupId);
  activeGroupId.current = inNewChat ? undefined : groupId;
  const settingsCurrentSpaceId = selectedSpaceId() ?? bootstrapMe?.spaceId ?? null;
  const settingsTargetId = settingsSpaceId ?? settingsCurrentSpaceId;
  const settingsSpace = spaces.find((entry) => entry.id === settingsTargetId) ?? null;
  const settingsOwnerKey = JSON.stringify([userId, session.data?.session.id]);
  const settingsOwner = useMemo(() => ({ key: settingsOwnerKey }), [settingsOwnerKey]);
  const sidebarAnnouncements = useSidebarAnnouncements(
    JSON.stringify([settingsOwnerKey, bootstrapMe?.spaceId, currentSpaceSelectionGeneration()]),
  );
  const creationSpaceId = userId && bootstrapMe?.userId === userId ? bootstrapMe.spaceId : null;
  const creationScope = useBotCreation({
    ownerKey: creationSpaceId ? settingsOwnerKey : null,
    spaceId: creationSpaceId,
  });
  const botCreationEditor = useBotCreationEditor({
    scope: creationScope,
    spaceId: creationSpaceId,
    enabled: panel === "create",
  });
  const [creationAppsEditor, setCreationAppsEditor] = useState<typeof botCreationEditor>(null);
  const [creationMcpEditor, setCreationMcpEditor] = useState<typeof botCreationEditor>(null);
  const [, refreshTemplateExample] = useState(0);

  const saveAccountTimezone = useAccountTimezone({
    ownerKey: userId ? settingsOwnerKey : null,
    userId: userId ?? null,
    timezone: bootstrapMe?.userId === userId ? bootstrapMe?.timezone : undefined,
    onTimezoneChanged: (timezone) => {
      setBootstrapMe((current) =>
        current && current.userId === userId ? { ...current, timezone } : current,
      );
    },
  });
  const committedSettingsOwner = useRef<typeof settingsOwner | null>(null);
  useLayoutEffect(() => {
    committedSettingsOwner.current = settingsOwner;
    return () => {
      if (committedSettingsOwner.current === settingsOwner) committedSettingsOwner.current = null;
    };
  }, [settingsOwner]);
  useLayoutEffect(() => {
    if (computerBootObservation.current && !computerBootObservation.current()) {
      invalidateComputerBoot();
    }
  }, [
    settingsOwner,
    settingsCurrentSpaceId,
    active?.id,
    groupId,
    computerBot?.id,
    computerBot?.computerMode,
  ]);
  useLayoutEffect(() => {
    if (!userId || !creationSpaceId) return;
    const scope = {
      apiOrigin: window.location.origin,
      accountId: userId,
      spaceId: creationSpaceId,
    };
    const targetId = groupId
      ? `group:${groupId}`
      : botId
        ? `bot:${botId}`
        : `space:${creationSpaceId}`;
    const saved = consumePreloadRecoverySnapshot(scope);
    if (saved && !peerConversation) {
      if (saved.overlayKind === "settings" && saved.targetId.startsWith("space:")) {
        const settingsTarget = saved.targetId.slice(6);
        if (spaces.some((space) => space.id === settingsTarget)) {
          setSettingsSpaceId(settingsTarget);
          setSettingsSection(saved.section ?? "general");
          setSettingsOpen(true);
        }
      } else if (saved.targetId === targetId) {
        if (saved.overlayKind === "messaging") setMessagingSettingsOpen(true);
        if (saved.overlayKind === "plugins") setPluginsOpen(true);
        if (saved.overlayKind === "mcp") setMcpOpen(true);
      }
    }
    const selection = selectedSpaceId();
    const generation = currentSpaceSelectionGeneration();
    const snapshot =
      peerConversation || panel === "create" || panel === "create-group"
        ? null
        : settingsOpen
          ? {
              ...scope,
              version: 1 as const,
              overlayKind: "settings" as const,
              targetId: `space:${settingsTargetId ?? creationSpaceId}`,
              section: settingsSection,
            }
          : messagingSettingsOpen || pluginsOpen || mcpOpen
            ? {
                ...scope,
                version: 1 as const,
                overlayKind: messagingSettingsOpen
                  ? ("messaging" as const)
                  : mcpOpen
                    ? ("mcp" as const)
                    : ("plugins" as const),
                targetId,
                section: null,
              }
            : null;
    return registerPreloadRecoverySnapshot(
      snapshot,
      () =>
        committedSettingsOwner.current === settingsOwner &&
        window.location.origin === scope.apiOrigin &&
        selectedSpaceId() === selection &&
        currentSpaceSelectionGeneration() === generation &&
        routeBotId.current === botId &&
        routeGroupId.current === groupId,
    );
  }, [
    userId,
    creationSpaceId,
    settingsOwner,
    botId,
    groupId,
    spaces,
    peerConversation,
    panel,
    settingsOpen,
    settingsSection,
    settingsTargetId,
    messagingSettingsOpen,
    pluginsOpen,
    mcpOpen,
  ]);
  const groupEditorBinding = useMemo(
    () => ({
      group: panel === "group-settings" ? activeGroup : undefined,
      userId,
      owner: settingsOwner,
      spaceId: bootstrapMe?.spaceId,
      originId: selectedSpaceId(),
      generation: currentSpaceSelectionGeneration(),
    }),
    [panel === "group-settings", activeGroup?.id, userId, bootstrapMe?.spaceId, settingsOwnerKey],
  );
  const committedGroupEditor = useRef<typeof groupEditorBinding | null>(null);
  useLayoutEffect(() => {
    committedGroupEditor.current = groupEditorBinding;
    return () => {
      if (committedGroupEditor.current === groupEditorBinding) committedGroupEditor.current = null;
    };
  }, [groupEditorBinding]);
  const saveGroupSettings = useMemo(() => {
    const binding = groupEditorBinding;
    if (!binding.group || !binding.spaceId) return null;
    const originCurrent = () =>
      binding.owner === committedSettingsOwner.current &&
      binding.userId === groupSettingsActor.current.userId &&
      binding.spaceId === groupSettingsActor.current.spaceId &&
      binding.originId === selectedSpaceId() &&
      binding.generation === currentSpaceSelectionGeneration();
    const isCurrent = () => committedGroupEditor.current === binding && originCurrent();
    const client = createSpaceRpc(binding.spaceId, isCurrent);
    const published = new WeakSet<Group>();
    const publish = (updated: Group) => {
      if (
        !originCurrent() ||
        updated?.id !== binding.group!.id ||
        updated.spaceId !== binding.spaceId ||
        typeof updated.name !== "string" ||
        typeof updated.updatedAt !== "string" ||
        !Array.isArray(updated.members) ||
        !updated.members.every((member) => typeof member?.botId === "string") ||
        published.has(updated)
      )
        return;
      published.add(updated);
      applySavedGroupUpdate(updated, { userId: binding.userId, spaceId: binding.spaceId });
    };
    const save = createGroupSettingsSave({
      group: binding.group,
      update: async (input) => {
        const updated = await client.groups.update({ groupId: binding.group!.id, ...input });
        // A committed write may update the roster after its editor closes, while
        // only the original editor may continue or acknowledge the save.
        publish(updated);
        return updated;
      },
      read: () => client.groups.get({ groupId: binding.group!.id }),
      isCurrent,
      isAmbiguous: (error) => {
        if (error instanceof DOMException && error.name === "AbortError") return false;
        const status =
          error && typeof error === "object" && "status" in error ? error.status : undefined;
        return typeof status !== "number";
      },
    });
    return { save, publish };
  }, [groupEditorBinding]);
  const groupSettingsActor = useRef({ userId, spaceId: bootstrapMe?.spaceId });
  groupSettingsActor.current = { userId, spaceId: bootstrapMe?.spaceId };
  const screenRequest = useRef(0);
  const recheckComputerStatus = useRef<((botId: string) => void) | null>(null);
  const computerVisibilityEpoch = useRef(0);
  const screenReadAbort = useRef<AbortController | null>(null);
  const screenReadiness = useRef<{
    botId: string;
    confirmed: boolean | null;
    wait: Promise<boolean>;
    settle: (running: boolean) => void;
  } | null>(null);
  const contextBot =
    botMenu?.kind === "bot" ? bots.find((bot) => bot.id === botMenu.id) : undefined;
  const contextGroup =
    botMenu?.kind === "group" ? groups.find((group) => group.id === botMenu.id) : undefined;
  const contextChat = contextBot ?? contextGroup;
  const closeBotMenu = useCallback(() => setBotMenu(null), []);
  const updateBotUnread = useCallback((id: string, unread: boolean) => {
    setBots((current) => {
      const bot = current.find((candidate) => candidate.id === id);
      if (!bot || bot.unread === unread) return current;
      return current.map((candidate) =>
        candidate.id === id ? { ...candidate, unread } : candidate,
      );
    });
  }, []);
  const setConversationUnread = useCallback(
    async (target: { botId: string } | { groupId: string }, unread: boolean) => {
      const id = "botId" in target ? target.botId : target.groupId;
      const actor = groupSettingsActor.current;
      const spaceId = selectedSpaceId() ?? actor.spaceId;
      const sameActor = () =>
        spaceId === actor.spaceId &&
        actor.userId === groupSettingsActor.current.userId &&
        actor.spaceId === groupSettingsActor.current.spaceId &&
        spaceId === (selectedSpaceId() ?? groupSettingsActor.current.spaceId);
      const wasManual = manuallyUnread.current.has(id);
      if (unread) manuallyUnread.current.add(id);
      else manuallyUnread.current.delete(id);
      // Preserve the user's last read/unread intent when an earlier request is still in flight.
      const previous = unreadRequests.current.get(id);
      const request = (previous ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => {
          if (!sameActor()) throw new DOMException("Conversation changed", "AbortError");
          return unread ? rpc.threads.markUnread(target) : rpc.threads.markRead(target);
        });
      unreadRequests.current.set(id, request);
      try {
        await request;
        if (!sameActor() || unreadRequests.current.get(id) !== request) return;
        if ("botId" in target) updateBotUnread(id, unread);
        else {
          setGroups((current) =>
            current.map((group) => (group.id === id ? { ...group, unread } : group)),
          );
        }
      } catch (err) {
        if (sameActor() && unreadRequests.current.get(id) === request) {
          if (wasManual) manuallyUnread.current.add(id);
          else manuallyUnread.current.delete(id);
        }
        throw err;
      } finally {
        if (unreadRequests.current.get(id) === request) unreadRequests.current.delete(id);
      }
    },
    [updateBotUnread],
  );
  const markBotRead = useCallback(
    (id: string) => setConversationUnread({ botId: id }, false),
    [setConversationUnread],
  );
  const markBotUnread = useCallback(
    (id: string) => setConversationUnread({ botId: id }, true),
    [setConversationUnread],
  );
  // A bot the user marked unread by hand stays unread until they open it again,
  // otherwise the auto-read below would undo the action on the next window focus.
  const markBotReadIfVisible = useCallback(
    (id: string) => {
      if (
        activeBotId.current !== id ||
        peerConversationRef.current ||
        manuallyUnread.current.has(id)
      )
        return;
      if (document.visibilityState === "visible" && document.hasFocus()) {
        void markBotRead(id).catch(() => undefined);
      }
    },
    [markBotRead],
  );
  const deliverBrowserNotification = useCallback((pending: PendingBrowserNotification): boolean => {
    const currentBot = botsRef.current.find((bot) => bot.id === pending.botId);
    if (!currentBot || typeof Notification === "undefined") return true;
    const result = deliverNativeBrowserNotification(
      pending.event,
      currentBot.name || pending.botName,
      {
        enabled: pending.groupNotification || currentBot.notifyOnFinish,
        pageVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
        permission: Notification.permission,
        notifiedEventIds: notifiedBrowserEvents.current,
        show: (title, body, tag) => new Notification(title, { body, tag }),
      },
    );
    return result !== "pending";
  }, []);
  const flushPendingBrowserNotifications = useCallback(() => {
    for (const [threadId, pending] of pendingBrowserNotifications.current) {
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(threadId);
      }
    }
  }, [deliverBrowserNotification]);
  const notifyBrowserForEvent = useCallback(
    (
      event: Pick<ProductEvent, "id" | "type" | "threadId" | "seq" | "botId" | "payload">,
      subscribedThreadId: string | undefined,
      initialCursor: number,
      streamReady: boolean,
      botName: string,
      enabled: boolean,
      groupNotification: boolean,
    ) => {
      const botId = event.botId;
      if (typeof botId !== "string") return;
      const eligible = shouldNotifyBrowser(event, {
        subscribedThreadId: subscribedThreadId ?? "",
        initialCursor,
        streamReady,
        pageVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
        permission: "granted",
        notifiedEventIds: notifiedBrowserEvents.current,
      });
      if (!eligible || !enabled) return;
      const pending = {
        event,
        botId,
        botName,
        groupNotification,
      } satisfies PendingBrowserNotification;
      if (typeof Notification === "undefined" || Notification.permission === "denied") return;
      if (Notification.permission === "default") {
        pendingBrowserNotifications.current.set(event.threadId, pending);
        return;
      }
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(event.threadId);
      } else {
        pendingBrowserNotifications.current.set(event.threadId, pending);
      }
    },
    [deliverBrowserNotification],
  );

  const refreshBots = useCallback(
    async (includeArchived = false, replaceBotOrder = false) => {
      markOnce("rk:renderer:bots-request-start");
      const request = ++botsRefreshEpoch.current;
      const botOrderEpoch = botOrderEpochRef.current;
      const preserveBotOrder = savingBotOrderRef.current || pendingBotOrderRef.current !== null;
      const archivedRequest = includeArchived ? ++archivedBotsRefreshEpoch.current : null;
      botsRefreshInFlight.current += 1;
      try {
        const [navigation, archived, archivedGroupList] = await Promise.all([
          rpc.spaces.list(),
          includeArchived ? rpc.bots.listArchived() : Promise.resolve(null),
          includeArchived ? rpc.groups.listArchived() : Promise.resolve(null),
        ]);
        const { bots: list, botSections: sections, groups: groupList } = navigation.current;
        markOnce("rk:renderer:bots-response");
        const botsFresh = request === botsRefreshEpoch.current;
        const archivedFresh =
          archivedRequest != null && archivedRequest === archivedBotsRefreshEpoch.current;
        // A newer non-archived refresh can win the bots epoch while an older
        // includeArchived request still owns archivedBotsRefreshEpoch — apply
        // whichever slices are still current.
        if (!botsFresh && !archivedFresh) return;
        if (archivedFresh && archived) setArchivedBots(archived);
        if (archivedFresh && archivedGroupList) setArchivedGroups(archivedGroupList);
        if (!botsFresh) return;
        if (
          botOrderEpoch === botOrderEpochRef.current &&
          (replaceBotOrder || (!preserveBotOrder && !savingBotOrderRef.current))
        ) {
          setBots(list);
          if (
            (replaceBotOrder || !savingBotOrderRef.current) &&
            pendingBotOrderRef.current === null
          )
            setBotOrderStatus(null);
        }
        setBotSections(sections);
        setGroups(groupList);
        setSpaces(navigation.spaces);
        setInitialBotsLoaded(true);
        botsRefreshApplied.current = request;
        if (
          includeArchived &&
          list.length === 0 &&
          archived?.length === 0 &&
          groupList.length === 0 &&
          archivedGroupList?.length === 0 &&
          !navigation.spaces.some((space) => space.hasContent)
        ) {
          // Only the very first bot everywhere needs onboarding. An empty
          // current space with content elsewhere stays in the app so the
          // space can be switched to or deleted instead of trapping the user.
          navigate("/onboarding", { replace: true });
          return;
        }
        const currentGroupId = routeGroupId.current;
        if (currentGroupId) {
          if (!groupList.some((group) => group.id === currentGroupId)) {
            navigate(firstThreadRoute(list, groupList), { replace: true });
          }
          return;
        }
        const currentBotId = routeBotId.current;
        if (!currentBotId || !list.some((bot) => bot.id === currentBotId)) {
          navigate(firstThreadRoute(list, groupList), { replace: true });
        }
      } finally {
        botsRefreshInFlight.current -= 1;
      }
    },
    [navigate],
  );

  function applySavedGroupUpdate(updated: Group, actor: typeof groupSettingsActor.current) {
    if (
      actor.userId !== groupSettingsActor.current.userId ||
      actor.spaceId !== groupSettingsActor.current.spaceId ||
      updated.spaceId !== actor.spaceId
    )
      return;
    const latest = savedGroupUpdates.current.get(updated.id);
    // Both inline renames and member saves return a complete roster. A response
    // captured by an earlier update must not restore members replaced later.
    if (latest && latest.updatedAt > updated.updatedAt) return;
    savedGroupUpdates.current.set(updated.id, updated);
    // Reads started before the save must not restore the previous roster.
    if (activeGroupId.current === updated.id) groupRefreshEpoch.current += 1;
    botsRefreshEpoch.current += 1;
    botsRefreshApplied.current = botsRefreshEpoch.current;
    setGroups((current) =>
      current.map((group) =>
        group.id === updated.id
          ? {
              ...group,
              name: updated.name,
              members: updated.members,
              updatedAt: group.updatedAt > updated.updatedAt ? group.updatedAt : updated.updatedAt,
            }
          : group,
      ),
    );
    updateSnapshot((current) => syncSavedGroupSnapshot(current, updated));
    void Promise.all([
      refreshBots(),
      activeGroupId.current === updated.id
        ? refreshGroupThreadRef.current(updated.id)
        : Promise.resolve(),
    ]).catch(() => undefined);
  }

  function snapTranscriptToEndAfterFrame() {
    const queuedElement = messageScroll.current;
    if (!queuedElement) return;
    const queuedScrollTop = queuedElement.scrollTop;
    window.requestAnimationFrame(() => {
      const element = messageScroll.current;
      if (transcriptCanSnapAfterFrame(element, queuedElement, queuedScrollTop)) {
        queuedElement.scrollTop = queuedElement.scrollHeight;
      }
    });
  }

  function invalidateHistoryRequests() {
    historyEpoch.current += 1;
    jumpGeneration.current += 1;
    setScrollRequest(null);
    setLoadingOlder(false);
    if (searchParamsRef.current.has("m")) {
      const next = new URLSearchParams(searchParamsRef.current);
      next.delete("m");
      next.delete("attention");
      setSearchParams(next, { replace: true });
    }
  }

  function clearHistoryWindow() {
    expandedHistoryThread.current = null;
    pinnedAroundRef.current = null;
    invalidateHistoryRequests();
  }

  function retryCurrentThread() {
    if (threadCheckpoint.current?.scope === draftScopeKey) invalidateHistoryRequests();
    else clearHistoryWindow();
    setThreadRetry((value) => value + 1);
  }

  function createThreadReader(
    abort: AbortController,
    commitReaderComputer: (
      next: ComputerStatus | null,
      event: ProductEvent,
    ) => void = commitComputerEvent,
  ) {
    const scope = draftScopeKey;
    const actor = groupSettingsActor.current;
    const spaceId = selectedSpaceId() ?? actor.spaceId;
    const targetBotId = activeBotId.current;
    const targetGroupId = activeGroupId.current;
    const checkpoint = threadCheckpoint.current;
    const resume = checkpoint?.scope === scope ? checkpoint : undefined;
    const ownsReader = () =>
      !abort.signal.aborted &&
      draftScopeKeyRef.current === scope &&
      actor.userId === groupSettingsActor.current.userId &&
      actor.spaceId === groupSettingsActor.current.spaceId &&
      activeBotId.current === targetBotId &&
      activeGroupId.current === targetGroupId &&
      (selectedSpaceId() ?? groupSettingsActor.current.spaceId) === spaceId;
    return {
      resume,
      ownsReader,
      onCursor: (next: { threadId: string; cursor: number }) => {
        if (scope !== null && ownsReader()) threadCheckpoint.current = { ...next, scope };
      },
      read: (request: Promise<ThreadSnapshot>) => {
        const consumed = threadCheckpoint.current;
        if (
          ownsReader() &&
          consumed?.scope === scope &&
          snapshotRef.current?.threadId === consumed.threadId &&
          snapshotRef.current.messages.length > 0
        )
          expandedHistoryThread.current = consumed.threadId;
        return request;
      },
      applyEvent: (event: ProductEvent) => {
        if (!ownsReader()) return;
        const current = snapshotRef.current;
        if (current?.threadId === event.threadId && event.seq <= current.cursor) {
          // The committed snapshot already owns run/computer/approval state.
          // Replay only durable history so old execution events cannot roll it back.
          if (
            event.type === "thread.cleared" ||
            event.type === "thread.message.created" ||
            event.type === "thread.message.updated" ||
            event.type === "thread.message.reaction"
          ) {
            const next = reduceThreadSnapshot(current, event);
            if (current && next) {
              const messageId = String(event.payload.messageId ?? event.id);
              if (
                next !== current &&
                (event.type === "thread.message.created" ||
                  event.type === "thread.message.updated") &&
                typeof event.payload.messageSeq === "number" &&
                !current.messages.some((message) => message.id === messageId) &&
                next.messages.some((message) => message.id === messageId)
              )
                expandedHistoryThread.current = event.threadId;
              commitSnapshot(next);
            }
          }
          return;
        }
        applyThreadEvent(
          event,
          commitSnapshot,
          (next) => commitReaderComputer(next, event),
          snapshotRef,
          computerRef,
        );
      },
    };
  }

  async function refreshGroupThread(id: string, signal?: AbortSignal) {
    const scrollElement = messageScroll.current;
    const stickToEnd = !scrollElement || transcriptIsNearEnd(scrollElement);
    markOnce("rk:renderer:thread-request-start");
    const epoch = historyEpoch.current;
    const spaceId = selectedSpaceId() ?? groupSettingsActor.current.spaceId;
    const request = ++groupRefreshEpoch.current;
    const snap = await rpc.threads.get({ groupId: id }, signal ? { signal } : undefined);
    markOnce("rk:renderer:thread-response");
    if (
      signal?.aborted ||
      (selectedSpaceId() ?? groupSettingsActor.current.spaceId) !== spaceId ||
      activeGroupId.current !== id ||
      epoch !== historyEpoch.current ||
      request !== groupRefreshEpoch.current
    )
      return snap;
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    commitSnapshot(reconciled.snapshot);
    if (!computerOpenRef.current) commitComputer(null);
    setRoutines([]);
    setRoutinesBotId(null);
    // Keep the search-jump viewport; expandedHistoryThread merge still accepts live messages.
    if (
      stickToEnd &&
      (!scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    return snap;
  }

  async function refreshThread(
    id: string,
    signal?: AbortSignal,
    isCurrent?: () => boolean,
    explicitScreen = false,
  ) {
    const scrollElement = messageScroll.current;
    const stickToEnd = !scrollElement || transcriptIsNearEnd(scrollElement);
    markOnce("rk:renderer:thread-request-start");
    const epoch = historyEpoch.current;
    const spaceId = selectedSpaceId() ?? groupSettingsActor.current.spaceId;
    const request = ++threadRefreshEpoch.current;
    // Apply threads.get as soon as it returns so stop/takeover status is not held behind
    // routines/skills/screen fetches (progress can advance the cursor meanwhile).
    const client = isCurrent ? createSpaceRpc(spaceId ?? null, isCurrent) : rpc;
    const snap = await client.threads.get({ botId: id }, signal ? { signal } : undefined);
    markOnce("rk:renderer:thread-response");
    if (
      isCurrent?.() === false ||
      signal?.aborted ||
      (selectedSpaceId() ?? groupSettingsActor.current.spaceId) !== spaceId ||
      activeBotId.current !== id ||
      epoch !== historyEpoch.current ||
      request !== threadRefreshEpoch.current
    ) {
      return snap;
    }
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    commitSnapshot(reconciled.snapshot);
    commitComputer(reconciled.computer);
    cacheComputerFor(id, { computer: reconciled.computer });
    if (
      stickToEnd &&
      (!scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    void Promise.all([
      rpc.routines.list({ botId: id }).catch(() => null),
      rpc.skills.list({ botId: id }).catch(() => null),
      refreshComputerScreen(id, isCurrent, explicitScreen).catch(() => null),
    ]).then(([routines, skills]) => {
      if (
        isCurrent?.() === false ||
        signal?.aborted ||
        (selectedSpaceId() ?? groupSettingsActor.current.spaceId) !== spaceId ||
        activeBotId.current !== id ||
        epoch !== historyEpoch.current ||
        request !== threadRefreshEpoch.current
      ) {
        return;
      }
      if (routines) {
        setRoutines(routines);
        setRoutinesBotId(id);
      }
      if (skills) {
        setTaughtSkills(skills);
        setTaughtSkillsBotId(id);
      }
    });
    return snap;
  }

  async function refreshComputerScreen(id: string, isCurrent?: () => boolean, explicit = false) {
    if (!computerVisible.current || document.visibilityState !== "visible") return null;
    const observation = screenReadiness.current;
    if (
      !explicit &&
      (!observation ||
        observation.botId !== id ||
        !(await observation.wait) ||
        screenReadiness.current !== observation)
    )
      return null;
    if (
      !computerVisible.current ||
      document.visibilityState !== "visible" ||
      isCurrent?.() === false
    )
      return null;
    const request = ++screenRequest.current;
    const actor = groupSettingsActor.current;
    const owner = committedSettingsOwner.current;
    const spaceId = selectedSpaceId() ?? actor.spaceId ?? null;
    const selection = currentSpaceSelectionGeneration();
    screenReadAbort.current?.abort();
    const abort = new AbortController();
    screenReadAbort.current = abort;
    const current = () =>
      !abort.signal.aborted &&
      isCurrent?.() !== false &&
      request === screenRequest.current &&
      (activeBotId.current === id || computerBotIdRef.current === id) &&
      computerVisible.current &&
      document.visibilityState === "visible" &&
      owner === committedSettingsOwner.current &&
      actor.userId === groupSettingsActor.current.userId &&
      actor.spaceId === groupSettingsActor.current.spaceId &&
      spaceId === (selectedSpaceId() ?? groupSettingsActor.current.spaceId ?? null) &&
      selection === currentSpaceSelectionGeneration();
    const client = createSpaceRpc(spaceId, current);
    try {
      return await loadComputerScreen({
        load: () => client.computer.screenUrl({ botId: id }, { signal: abort.signal }),
        isCurrent: current,
        commit: (screen) => {
          setScreenUrl(screen.url);
          setComputerError(screen.error);
          setComputerErrorFromScreen(Boolean(screen.error));
          cacheComputerFor(id, { screenUrl: screen.url });
        },
        fallbackError: t`Could not connect to the computer screen`,
      });
    } finally {
      if (screenReadAbort.current === abort) screenReadAbort.current = null;
    }
  }

  async function loadOlderMessages() {
    const targetBotId = inGroup ? undefined : active?.id;
    const targetGroupId = inGroup ? groupId : undefined;
    const snapshotMatchesTarget = targetGroupId
      ? snapshot?.groupId === targetGroupId
      : snapshot?.botId === targetBotId;
    if (
      (!targetBotId && !targetGroupId) ||
      !snapshotMatchesTarget ||
      snapshot?.olderCursor == null ||
      loadingOlder
    )
      return;
    pinnedAroundRef.current = null;
    const scrollElement = messageScroll.current;
    const previousHeight = scrollElement?.scrollHeight ?? 0;
    const epoch = historyEpoch.current;
    const spaceId = selectedSpaceId() ?? groupSettingsActor.current.spaceId;
    const before = snapshot.olderCursor;
    const requestCursor = snapshotRef.current?.cursor ?? -1;
    setLoadingOlder(true);
    try {
      const target = targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! };
      const [page, snap] = await Promise.all([
        rpc.threads.messages({ ...target, before }),
        rpc.threads.get(target),
      ]);
      if (
        epoch !== historyEpoch.current ||
        (selectedSpaceId() ?? groupSettingsActor.current.spaceId) !== spaceId ||
        activeBotId.current !== targetBotId ||
        activeGroupId.current !== targetGroupId
      )
        return;
      const current = reconcileRefreshedThread(
        snapshotRef.current,
        snap,
        computerRef.current,
        true,
      );
      const next = prependThreadMessagePage(current.snapshot, page, requestCursor);
      const admitted = current.snapshot.olderCursor !== null && next !== current.snapshot;
      if (admitted) expandedHistoryThread.current = page.threadId;
      commitSnapshot(next);
      if (!admitted) return;
      window.requestAnimationFrame(() => {
        const element = messageScroll.current;
        if (
          epoch === historyEpoch.current &&
          (selectedSpaceId() ?? groupSettingsActor.current.spaceId) === spaceId &&
          activeBotId.current === targetBotId &&
          activeGroupId.current === targetGroupId &&
          element &&
          element === scrollElement
        )
          element.scrollTop += element.scrollHeight - previousHeight;
      });
    } catch {
      // Leave the existing page and approval controls intact; the next load can retry.
    } finally {
      if (
        epoch === historyEpoch.current &&
        (selectedSpaceId() ?? groupSettingsActor.current.spaceId) === spaceId &&
        activeBotId.current === targetBotId &&
        activeGroupId.current === targetGroupId
      )
        setLoadingOlder(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const providerConfigRevision = memoryProviderConfigRevision.current;
    void rpc.memory
      .providerConfig()
      .then((providerConfig) => {
        if (!cancelled && memoryProviderConfigRevision.current === providerConfigRevision) {
          setMemoryProviderConfig(providerConfig);
        }
      })
      .catch(() => {
        if (!cancelled && memoryProviderConfigRevision.current === providerConfigRevision) {
          setMemoryProviderConfig(null);
        }
      });
    let bootstrapInFlight = false;
    let bootstrapReady = false;
    let bootstrapBlocked = false;
    let fallbackRequested = false;
    const initialize = async () => {
      if (cancelled || bootstrapInFlight || bootstrapReady) return;
      bootstrapInFlight = true;
      setBootstrapLoad((current) => ({ ...current, pending: true }));
      const appliedAtStart = botsRefreshApplied.current;
      const requestedBotId = routeBotId.current;
      const requestedGroupId = routeGroupId.current;
      const requestedSpaceId = selectedSpaceId();
      const requestedSessionGeneration = currentRpcSessionGeneration();
      const requestedSelectionGeneration = currentSpaceSelectionGeneration();
      try {
        const bootstrap = await takeInitialBootstrap(requestedBotId);
        if (cancelled || selectedSpaceId() !== requestedSpaceId) return;
        if (bootstrap.me.userId !== userId) throw new Error(t`Could not load this chat.`);
        bootstrapReady = true;
        bootstrapBlocked = false;
        if (requestedSpaceId === null)
          rememberImplicitRpcSpace(
            bootstrap.me.spaceId,
            requestedSessionGeneration,
            requestedSelectionGeneration,
          );
        setBootstrapMe(bootstrap.me);
        setBootstrapLoad({ pending: false, error: null });
        // List refreshes and saves own newer roster data. Context can still recover.
        if (appliedAtStart !== botsRefreshApplied.current) return;
        const groupList = bootstrap.groups;
        setBots(bootstrap.bots);
        setBotSections(bootstrap.botSections);
        setArchivedBots(bootstrap.archivedBots);
        setArchivedGroups(bootstrap.archivedGroups);
        setGroups(groupList);
        setSpaces(bootstrap.spaces);
        setInitialBotsLoaded(true);
        // A user can navigate while initialization is pending; never restore the old target.
        if (
          routeBotId.current !== requestedBotId ||
          routeGroupId.current !== requestedGroupId ||
          inNewChatRef.current
        )
          return;
        if (!requestedGroupId && bootstrap.thread) {
          bootstrappedThread.current = bootstrap.thread;
          commitSnapshot(bootstrap.thread);
          commitComputer(bootstrap.thread.computer ?? null);
          setRoutines(bootstrap.routines);
          setRoutinesBotId(bootstrap.thread.botId ?? null);
          markOnce("rk:renderer:bots-response");
          markOnce("rk:renderer:thread-response");
        }
        if (
          bootstrap.bots.length === 0 &&
          bootstrap.archivedBots.length === 0 &&
          groupList.length === 0 &&
          bootstrap.archivedGroups.length === 0 &&
          !bootstrap.spaces.some((space) => space.hasContent)
        ) {
          navigate("/onboarding", { replace: true });
          return;
        }
        if (requestedGroupId) {
          if (!groupList.some((group) => group.id === requestedGroupId)) {
            navigate(firstThreadRoute(bootstrap.bots, groupList), { replace: true });
          }
          return;
        }
        const selectedBotId = bootstrap.thread?.botId ?? bootstrap.bots[0]?.id;
        if (selectedBotId && selectedBotId !== requestedBotId) {
          navigate(`/app/${selectedBotId}`, { replace: true });
        }
      } catch (error) {
        if (cancelled || selectedSpaceId() !== requestedSpaceId) return;
        bootstrapBlocked = !isRecoverableReadError(error);
        setBootstrapLoad({ pending: false, error });
        if (!fallbackRequested) {
          fallbackRequested = true;
          void refreshBots(true).catch(() => undefined);
        }
      } finally {
        bootstrapInFlight = false;
      }
    };
    retryBootstrap.current = () => void initialize();
    void initialize();
    let refreshTimer: number | undefined;
    const refreshVisibleBots = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (!bootstrapReady) {
          if (!bootstrapBlocked) void initialize();
        } else {
          void refreshBots().catch(() => undefined);
        }
      }, 50);
    };
    window.addEventListener("focus", refreshVisibleBots);
    document.addEventListener("visibilitychange", refreshVisibleBots);
    // Poll skips while a refresh is in flight; focus/visibility and event-driven
    // callers still bump botsRefreshEpoch so only the latest response applies.
    const poll = window.setInterval(() => {
      if (bootstrapInFlight || (bootstrapReady && botsRefreshInFlight.current > 0)) return;
      refreshVisibleBots();
    }, 3_000);
    return () => {
      cancelled = true;
      retryBootstrap.current = () => {};
      window.clearTimeout(refreshTimer);
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshVisibleBots);
      document.removeEventListener("visibilitychange", refreshVisibleBots);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void rpc.agentSkills
      .list()
      .then((skills) => {
        if (!cancelled) setAgentSkills(skills);
      })
      .catch(() => {
        if (!cancelled) setAgentSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAgentSkills = useCallback(() => {
    void rpc.agentSkills
      .list()
      .then(setAgentSkills)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void rpc.voice
      .status()
      .then(setVoiceStatus)
      .catch(() => undefined);
    const unsubSpeech = speaker.subscribe((state) => {
      setSpeakingMessageId(state.status === "idle" ? null : (state.messageId ?? null));
    });
    return () => {
      unsubSpeech();
    };
  }, []);

  useEffect(() => {
    if (!active || !snapshot || snapshot.botId !== active.id) return;
    const lastBot = [...snapshot.messages].reverse().find((message) => message.role === "bot");
    if (autoSpokenBotId.current !== active.id) {
      autoSpokenBotId.current = active.id;
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (call?.botId === active.id || !active.autoSpeak) {
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (snapshot.run && ["running", "queued", "leased"].includes(snapshot.run.status)) return;
    if (!lastBot || lastBot.id === autoSpoken.current) return;
    const text = speechFromBlocks(lastBot.blocks);
    if (!text) return;
    autoSpoken.current = lastBot.id;
    void speaker.speak(text, { botId: active.id, messageId: lastBot.id });
  }, [
    snapshot?.messages,
    snapshot?.run?.status,
    snapshot?.botId,
    active?.autoSpeak,
    active?.id,
    call?.botId,
  ]);

  useEffect(() => {
    if (!active) return;
    // Opening a bot clears the manual unread flag so it can auto-read again.
    manuallyUnread.current.delete(active.id);
    const markVisibleBotRead = () => {
      markBotReadIfVisible(active.id);
    };
    markVisibleBotRead();
    window.addEventListener("focus", markVisibleBotRead);
    document.addEventListener("visibilitychange", markVisibleBotRead);
    return () => {
      window.removeEventListener("focus", markVisibleBotRead);
      document.removeEventListener("visibilitychange", markVisibleBotRead);
    };
  }, [active?.id, markBotReadIfVisible]);

  // Entering a conversation resets its history window; retrying the same reader does not.
  useEffect(() => {
    if (!active && !activeGroup) return;
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) pinnedAroundRef.current = null;
    if (active || !pendingJump) expandedHistoryThread.current = null;
    historyEpoch.current += 1;
    setLoadingOlder(false);
  }, [active?.id, activeGroup?.id, draftScopeKey]);

  useEffect(() => {
    if (!active) return;
    const pendingJump = searchParamsRef.current.get("m");
    screenRequest.current += 1;
    setComputerError(null);
    setComputerErrorFromScreen(false);
    const cached = computerCacheRef.current.get(active.id);
    if (cached) {
      // Paint the last-known computer instantly; refreshThread/refreshComputerScreen
      // below still run and reconcile with fresh data in the background.
      setScreenUrl(cached.screenUrl);
      commitComputer(cached.computer);
    } else {
      setScreenUrl(null);
    }
    const abort = new AbortController();
    const reader = createThreadReader(abort);
    void runThreadSubscription({
      signal: abort.signal,
      resume: reader.resume,
      onCursor: reader.onCursor,
      onStatus: observeThreadConnection(`bot:${active.id}`, abort),
      loadInitial: async () => {
        const primed = bootstrappedThread.current;
        bootstrappedThread.current = null;
        // Pending search jumps load the around-page separately; avoid replacing it with latest.
        return reader.read(
          primed?.botId === active.id
            ? Promise.resolve(primed)
            : pendingJump
              ? readThreadSnapshot(abort.signal, (signal) =>
                  rpc.threads.get({ botId: active.id }, { signal }),
                )
              : readThreadSnapshot(abort.signal, (signal) => refreshThread(active.id, signal)),
        );
      },
      loadHead: () =>
        readThreadSnapshot(abort.signal, (signal) =>
          rpc.threads.head({ botId: active.id }, { signal }),
        ),
      refresh: () =>
        reader.read(readThreadSnapshot(abort.signal, (signal) => refreshThread(active.id, signal))),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor) =>
        rpc.threads.subscribe({ botId: active.id, cursor }, { signal: abort.signal }),
      beforeEvent: (event) => {
        if (isRunTerminalEvent(event) && event.runId) {
          terminalRunReceipts.current.add(event.runId);
          if (terminalRunReceipts.current.size > 100) {
            const oldest = terminalRunReceipts.current.values().next().value;
            if (oldest !== undefined) terminalRunReceipts.current.delete(oldest);
          }
        }
      },
      applyEvent: reader.applyEvent,
      onEvent: (event, initial) => {
        if (!reader.ownsReader()) return;
        replyEventObserver.current(event);
        const currentBot = botsRef.current.find((bot) => bot.id === active.id);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          currentBot?.name ?? active.name,
          currentBot?.notifyOnFinish ?? false,
          false,
        );
        if (event.type === "thread.cleared" && event.seq >= (snapshotRef.current?.cursor ?? -1)) {
          setPeerConversation(null);
          clearHistoryWindow();
        }
        if (event.type === "bot.archived") {
          void refreshBots(true).catch(() => undefined);
        } else if (
          event.type === "bot.spawned" ||
          event.type === "bot.deleted" ||
          event.type === "bot.updated" ||
          event.type === "run.started" ||
          isRunTerminalEvent(event) ||
          event.type === "thread.cleared"
        ) {
          void refreshBots().catch(() => undefined);
        }
        if (event.type === "thread.message.created") {
          const blocks = (event.payload.blocks as Array<{ kind?: string }>) ?? [];
          if (blocks.some((block) => block.kind === "child_bot")) {
            void refreshBots().catch(() => undefined);
          }
          if (event.payload.role === "bot") markBotReadIfVisible(active.id);
        }
        const approvalUpdate =
          (event.type === "thread.message.created" || event.type === "thread.message.updated") &&
          Array.isArray(event.payload.blocks) &&
          event.payload.blocks.some(
            (block) => block.kind === "ask" || block.kind === "mcp_approval",
          );
        if (approvalUpdate || event.type === "run.waiting_input")
          void refreshBots().catch(() => undefined);
        if (
          isRunTerminalEvent(event) ||
          event.type === "run.waiting_input" ||
          event.type === "thread.message.updated" ||
          event.type === "skill.teaching.stopped"
        ) {
          // waiting_input: reconcile ask cards if a stale post-send refresh raced SSE.
          void refreshThread(active.id).catch(() => undefined);
        } else if (isComputerStatusEvent(event) && screenReadiness.current?.confirmed === true) {
          void refreshComputerScreen(active.id).catch(() => undefined);
        }
      },
    });
    return () => {
      abort.abort();
    };
  }, [
    active?.id,
    markBotReadIfVisible,
    notifyBrowserForEvent,
    observeThreadConnection,
    draftScopeKey,
    threadRetry,
  ]);

  useEffect(() => {
    if (!groupId || !activeGroup) return;
    manuallyUnread.current.delete(activeGroup.id);
    readVisibleGroups.current.delete(groupId);
    const markVisibleGroupRead = () => {
      if (
        activeGroupId.current !== groupId ||
        peerConversationRef.current ||
        manuallyUnread.current.has(groupId) ||
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        readVisibleGroups.current.has(groupId)
      )
        return;
      readVisibleGroups.current.add(groupId);
      void setConversationUnread({ groupId }, false).catch(() => {
        readVisibleGroups.current.delete(groupId);
      });
    };
    markVisibleGroupRead();
    window.addEventListener("focus", markVisibleGroupRead);
    document.addEventListener("visibilitychange", markVisibleGroupRead);
    const pendingJump = searchParamsRef.current.get("m");
    const abort = new AbortController();
    const reader = createThreadReader(abort, (next, event) => {
      if (isComputerStatusEvent(event) && event.botId !== computerBotIdRef.current) return;
      commitComputerEvent(next, event);
    });
    void runThreadSubscription({
      signal: abort.signal,
      resume: reader.resume,
      onCursor: reader.onCursor,
      onStatus: observeThreadConnection(`group:${groupId}`, abort),
      loadInitial: () =>
        reader.read(
          pendingJump
            ? readThreadSnapshot(abort.signal, (signal) => rpc.threads.get({ groupId }, { signal }))
            : readThreadSnapshot(abort.signal, (signal) => refreshGroupThread(groupId, signal)),
        ),
      loadHead: () =>
        readThreadSnapshot(abort.signal, (signal) => rpc.threads.head({ groupId }, { signal })),
      refresh: () =>
        reader.read(
          readThreadSnapshot(abort.signal, (signal) => refreshGroupThread(groupId, signal)),
        ),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor) => rpc.threads.subscribe({ groupId, cursor }, { signal: abort.signal }),
      applyEvent: reader.applyEvent,
      onEvent: (event, initial) => {
        if (!reader.ownsReader()) return;
        replyEventObserver.current(event);
        if (event.type === "thread.cleared" && event.seq >= (snapshotRef.current?.cursor ?? -1)) {
          setPeerConversation(null);
          clearHistoryWindow();
        }
        const eventBot = botsRef.current.find((bot) => bot.id === event.botId);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          eventBot?.name ?? activeGroup.name,
          true,
          true,
        );
        if (event.type === "thread.message.created" && event.payload.role === "bot") {
          readVisibleGroups.current.delete(groupId);
          markVisibleGroupRead();
        }
        if (
          event.type === "run.started" ||
          event.type === "bot.updated" ||
          isRunTerminalEvent(event) ||
          event.type === "run.waiting_input" ||
          ((event.type === "thread.message.created" || event.type === "thread.message.updated") &&
            Array.isArray(event.payload.blocks) &&
            event.payload.blocks.some(
              (block) => block.kind === "ask" || block.kind === "mcp_approval",
            ))
        ) {
          void refreshBots().catch(() => undefined);
        }
        if (
          isRunTerminalEvent(event) ||
          event.type === "run.waiting_input" ||
          event.type === "thread.message.updated"
        ) {
          // waiting_input: reconcile ask cards if a stale post-send refresh raced SSE.
          void refreshGroupThread(groupId).catch(() => undefined);
        }
      },
    });
    return () => {
      window.removeEventListener("focus", markVisibleGroupRead);
      document.removeEventListener("visibilitychange", markVisibleGroupRead);
      abort.abort();
    };
  }, [
    activeGroup?.id,
    groupId,
    notifyBrowserForEvent,
    setConversationUnread,
    observeThreadConnection,
    draftScopeKey,
    threadRetry,
  ]);

  useEffect(() => {
    const closed = hadPeerConversation.current && !peerConversation;
    hadPeerConversation.current = Boolean(peerConversation);
    if (!closed) return;
    if (activeGroupId.current) {
      const id = activeGroupId.current;
      manuallyUnread.current.delete(id);
      readVisibleGroups.current.delete(id);
      if (
        !manuallyUnread.current.has(id) &&
        document.visibilityState === "visible" &&
        document.hasFocus()
      )
        void setConversationUnread({ groupId: id }, false).catch(() => undefined);
    } else if (activeBotId.current) {
      manuallyUnread.current.delete(activeBotId.current);
      markBotReadIfVisible(activeBotId.current);
    }
  }, [peerConversation, markBotReadIfVisible, setConversationUnread]);

  const sidebarGroups = useMemo(() => {
    const sidebarSpaces =
      spaces.length > 0
        ? spaces.map((space) =>
            space.id === bootstrapMe?.spaceId ? { ...space, bots, groups, botSections } : space,
          )
        : bootstrapMe
          ? [
              {
                id: bootstrapMe.spaceId,
                name: "Personal",
                isDefault: true,
                hasContent: true,
                canRename: false,
                canDelete: false,
                bots,
                groups,
                botSections,
              },
            ]
          : [];
    return sidebarGroupsForSpaces(sidebarSpaces, query);
  }, [bootstrapMe, botSections, bots, groups, spaces, query]);

  const openSpaceChat = useCallback(
    (spaceId: string, path: string) => {
      setMobileSidebarOpen(false);
      const previousSpaceId = selectedSpaceId();
      const previousEffective = previousSpaceId ?? bootstrapMe?.spaceId;
      const currentPath = activeGroupId.current
        ? `/app/g/${activeGroupId.current}`
        : activeBotId.current
          ? `/app/${activeBotId.current}`
          : null;
      if (previousEffective === spaceId && path === currentPath) {
        navigate(path);
        return;
      }
      // Persist the active space (including primary) so voice/RPC headers match the chat.
      const selectionStored = selectSpace(spaceId);
      if (!selectionStored) return;
      const boundaryChanged = previousEffective !== spaceId;
      // Soft-navigate within the same space; reload only when the auth boundary changes
      // so bootstrapped bots/groups match the request header.
      if (boundaryChanged) {
        window.location.assign(path);
        return;
      }
      navigate(path);
    },
    [bootstrapMe?.spaceId, navigate],
  );
  const flushBotOrder = useCallback(async () => {
    if (savingBotOrderRef.current) return;
    savingBotOrderRef.current = true;
    setBotOrderStatus("saving");
    try {
      while (pendingBotOrderRef.current) {
        setBotOrderStatus("saving");
        const botIds = pendingBotOrderRef.current;
        pendingBotOrderRef.current = null;
        const settleAnnouncement = pendingBotOrderAnnouncement.current;
        pendingBotOrderAnnouncement.current = null;
        try {
          await rpc.bots.reorder({ botIds });
          settleAnnouncement?.(true);
          if (pendingBotOrderRef.current === null) setBotOrderStatus(null);
        } catch {
          settleAnnouncement?.(false);
          // Preserve newer user intent; otherwise read the authoritative order.
          if (pendingBotOrderRef.current === null) {
            setBotOrderStatus("unconfirmed");
            try {
              await refreshBots(false, true);
            } catch {
              // Retain unknown outcome until a later authoritative order is applied.
            }
          }
        }
      }
    } finally {
      savingBotOrderRef.current = false;
      // A reorder may have arrived while saving=true and returned early.
      if (pendingBotOrderRef.current) {
        void flushBotOrder();
      }
    }
  }, [refreshBots]);
  const reorderRosterBot = useCallback(
    (sourceId: string, targetId: string, groupBotIds: string[]) => {
      if (!bootstrapMe || !groupBotIds.includes(sourceId) || !groupBotIds.includes(targetId))
        return;
      const current = botsRef.current;
      const reordered = reorderBotTo(current, sourceId, targetId);
      if (reordered === current) return;
      const next = [...reordered];
      botOrderEpochRef.current += 1;
      botsRef.current = next;
      setBots(next);
      sidebarAnnouncements.start(current.find((bot) => bot.id === sourceId)?.name ?? sourceId);
      sidebarAnnouncements.target(current.find((bot) => bot.id === targetId)?.name ?? targetId);
      pendingBotOrderAnnouncement.current = sidebarAnnouncements.accept();
      pendingBotOrderRef.current = next.map((bot) => bot.id);
      void flushBotOrder();
    },
    [
      bootstrapMe,
      flushBotOrder,
      sidebarAnnouncements.start,
      sidebarAnnouncements.target,
      sidebarAnnouncements.accept,
    ],
  );
  const toggleSidebarSection = useCallback(
    (key: string) => {
      setCollapsedSidebarSections((previous) =>
        toggleCollapsedIdSet(previous, key, collapsedSidebarSectionsStorageKey(userId)),
      );
    },
    [userId],
  );
  const organizationState = useRef({ spaceId: bootstrapMe?.spaceId, botSections, spaces });
  organizationState.current = { spaceId: bootstrapMe?.spaceId, botSections, spaces };
  const sectionsForSpace = (spaceId: string) =>
    spaceId === organizationState.current.spaceId
      ? organizationState.current.botSections
      : (organizationState.current.spaces.find((space) => space.id === spaceId)?.botSections ?? []);
  const reportSidebarError = (error: unknown) =>
    setSidebarError(errorText(error, t`Could not update sidebar`));
  const applySections = (spaceId: string, sections: BotSection[]) => {
    botsRefreshEpoch.current += 1;
    if (spaceId === bootstrapMe?.spaceId) setBotSections(sections);
    setSpaces((current) =>
      current.map((space) => (space.id === spaceId ? { ...space, botSections: sections } : space)),
    );
  };
  const patchChatOrganization = (
    item: SidebarChatTarget,
    patch: Partial<Pick<Bot, "sectionId" | "pinned">>,
  ) => {
    botsRefreshEpoch.current += 1;
    if (item.chat.spaceId === bootstrapMe?.spaceId) {
      if (item.kind === "bot")
        setBots((current) =>
          current.map((chat) => (chat.id === item.chat.id ? { ...chat, ...patch } : chat)),
        );
      else
        setGroups((current) =>
          current.map((chat) => (chat.id === item.chat.id ? { ...chat, ...patch } : chat)),
        );
    }
    setSpaces((current) =>
      current.map((space) =>
        space.id !== item.chat.spaceId
          ? space
          : {
              ...space,
              bots:
                item.kind === "bot"
                  ? space.bots.map((chat) =>
                      chat.id === item.chat.id ? { ...chat, ...patch } : chat,
                    )
                  : space.bots,
              groups:
                item.kind === "group"
                  ? space.groups.map((chat) =>
                      chat.id === item.chat.id ? { ...chat, ...patch } : chat,
                    )
                  : space.groups,
            },
      ),
    );
  };
  const performOrganization = async (action: () => Promise<void>) => {
    if (organizationPending.current) throw new Error(t`Wait for the current change to finish`);
    organizationPending.current = true;
    setSidebarError(null);
    try {
      await action();
      // The confirmed write is already applied locally; a list refresh must not block Undo.
      void refreshBots(true).catch(() => undefined);
    } finally {
      organizationPending.current = false;
    }
  };
  const expandSection = (spaceId: string, sectionId: string | null) => {
    const key = `space:${spaceId}:${sectionId ? `section:${sectionId}` : "unassigned"}`;
    setCollapsedSidebarSections((current) =>
      current.has(key)
        ? toggleCollapsedIdSet(current, key, collapsedSidebarSectionsStorageKey(userId))
        : current,
    );
  };
  const saveChatOrganization = async (
    item: SidebarChatTarget,
    patch: Partial<Pick<Bot, "sectionId" | "pinned">>,
    remember = true,
  ) => {
    await performOrganization(async () => {
      const previous: typeof patch = {};
      if (patch.sectionId !== undefined) previous.sectionId = item.chat.sectionId;
      if (patch.pinned !== undefined) previous.pinned = item.chat.pinned;
      const context = { context: { spaceId: item.chat.spaceId } };
      if (item.kind === "bot") await rpc.bots.update({ botId: item.chat.id, ...patch }, context);
      else await rpc.groups.update({ groupId: item.chat.id, ...patch }, context);
      patchChatOrganization(item, patch);
      if (remember) organizationUndo.current = () => saveChatOrganization(item, previous, false);
    });
  };
  const moveChatToSection = async (item: SidebarChatTarget, sectionId: string | null) => {
    if (item.chat.sectionId === sectionId && !item.chat.pinned) return false;
    await saveChatOrganization(item, { sectionId, pinned: false });
    expandSection(item.chat.spaceId, sectionId);
    setSidebarNotice(item.chat.pinned ? t`Moved and unpinned` : null);
    return true;
  };
  const renameSection = async (
    section: BotSection,
    spaceId: string,
    name: string,
    remember = true,
  ) => {
    await performOrganization(async () => {
      const options = { context: { spaceId } };
      const updated = remember
        ? await rpc.botSections.update({ sectionId: section.id, name }, options)
        : await rpc.botSections.restoreName(
            { sectionId: section.id, name, expectedName: section.name },
            options,
          );
      applySections(
        spaceId,
        sectionsForSpace(spaceId).map((item) => (item.id === section.id ? updated : item)),
      );
      if (remember)
        organizationUndo.current = () => renameSection(updated, spaceId, section.name, false);
    });
  };
  const saveSectionOrder = async (spaceId: string, sectionIds: string[], remember = true) => {
    const previousIds = sectionsForSpace(spaceId).map((section) => section.id);
    await performOrganization(async () => {
      const updated = await rpc.botSections.reorder({ sectionIds }, { context: { spaceId } });
      applySections(spaceId, updated);
      if (remember)
        organizationUndo.current = () =>
          saveSectionOrder(
            spaceId,
            restoreSidebarSectionOrder(
              sectionsForSpace(spaceId).map((section) => section.id),
              previousIds,
            ),
            false,
          );
    });
  };
  const reorderSection = async (sourceId: string, targetId: string, spaceId: string) => {
    if (sourceId === targetId) return false;
    const ids = sectionsForSpace(spaceId).map((section) => section.id);
    const from = ids.indexOf(sourceId),
      to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return false;
    ids.splice(from, 1);
    ids.splice(to, 0, sourceId);
    await saveSectionOrder(spaceId, ids);
    return true;
  };
  const stepSection = async (id: string, spaceId: string, direction: number) => {
    const ids = sectionsForSpace(spaceId).map((section) => section.id);
    const targetId = ids[ids.indexOf(id) + direction];
    if (targetId) await reorderSection(id, targetId, spaceId);
  };
  const applyRemovedMemberships = (
    snapshot: RemovedBotSection,
    spaceId: string,
    restoreId: string | null,
  ) => {
    const botIds = new Set(snapshot.botIds),
      groupIds = new Set(snapshot.groupIds);
    const patchBot = <T extends { id: string; sectionId: string | null }>(chat: T): T =>
      botIds.has(chat.id) &&
      (restoreId ? chat.sectionId === null : chat.sectionId === snapshot.section.id)
        ? { ...chat, sectionId: restoreId }
        : chat;
    const patchGroup = <T extends { id: string; sectionId: string | null }>(chat: T): T =>
      groupIds.has(chat.id) &&
      (restoreId ? chat.sectionId === null : chat.sectionId === snapshot.section.id)
        ? { ...chat, sectionId: restoreId }
        : chat;
    if (spaceId === bootstrapMe?.spaceId) {
      setBots((current) => current.map(patchBot));
      setGroups((current) => current.map(patchGroup));
      setArchivedBots((current) => current.map(patchBot));
      setArchivedGroups((current) => current.map(patchGroup));
    }
    setSpaces((current) =>
      current.map((space) =>
        space.id !== spaceId
          ? space
          : { ...space, bots: space.bots.map(patchBot), groups: space.groups.map(patchGroup) },
      ),
    );
  };
  const restoreSection = async (deletion: { snapshot: RemovedBotSection; spaceId: string }) => {
    await performOrganization(async () => {
      const section = await rpc.botSections.restore(deletion.snapshot, {
        context: { spaceId: deletion.spaceId },
      });
      const sections = sectionsForSpace(deletion.spaceId);
      applySections(
        deletion.spaceId,
        sections.some((item) => item.id === section.id)
          ? sections.map((item) => (item.id === section.id ? section : item))
          : [
              ...sections.map((item) =>
                item.position >= section.position ? { ...item, position: item.position + 1 } : item,
              ),
              section,
            ].sort((a, b) => a.position - b.position),
      );
      applyRemovedMemberships(deletion.snapshot, deletion.spaceId, section.id);
      setDeletedSection((current) => (current === deletion ? null : current));
      if (organizationUndo.current === deletionUndo.current) organizationUndo.current = null;
      deletionUndo.current = null;
    });
  };
  const removeSection = async (section: BotSection, spaceId: string) => {
    await performOrganization(async () => {
      const snapshot = await rpc.botSections.remove(
        { sectionId: section.id },
        { context: { spaceId } },
      );
      applySections(
        spaceId,
        sectionsForSpace(spaceId).filter((item) => item.id !== section.id),
      );
      applyRemovedMemberships(snapshot, spaceId, null);
      expandSection(spaceId, null);
      const deletion = { snapshot, spaceId };
      setDeletedSection(deletion);
      const undo = () => restoreSection(deletion);
      deletionUndo.current = undo;
      organizationUndo.current = undo;
    });
  };
  const openSectionMenu = (
    sectionId: string,
    spaceId: string,
    element: HTMLElement,
    position: ContextMenuPosition,
  ) => {
    const section = sectionsForSpace(spaceId).find((item) => item.id === sectionId);
    if (!section) return;
    sectionMenuAnchor.current = element;
    setSectionMenu({ section, spaceId, position });
  };
  const sectionContextPress = useContextPress<HTMLButtonElement>((element, position) => {
    const { sectionId, sectionSpaceId } = element.dataset;
    if (sectionId && sectionSpaceId) openSectionMenu(sectionId, sectionSpaceId, element, position);
  });
  const rowContextPress = useContextPress<HTMLButtonElement>((element, position) => {
    if (element.dataset.rosterSpaceId !== bootstrapMe?.spaceId) return;
    const botId = element.dataset.rosterBotId,
      groupId = element.dataset.rosterGroupId;
    if (!botId && !groupId) return;
    botMenuAnchor.current = element;
    setBotMenu({ kind: botId ? "bot" : "group", id: botId ?? groupId!, position });
  });
  useEffect(() => {
    const undo = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest("input, textarea, [contenteditable=true]") || target.closest("[role=menu]"))
      )
        return;
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== "z" ||
        !organizationUndo.current ||
        organizationPending.current
      )
        return;
      event.preventDefault();
      const action = organizationUndo.current;
      organizationUndo.current = null;
      void action().catch((error) => {
        organizationUndo.current = action;
        setSidebarError(errorText(error, t`Could not update sidebar`));
      });
    };
    window.addEventListener("keydown", undo);
    return () => window.removeEventListener("keydown", undo);
  }, []);
  const renderNewSectionName = () =>
    newSectionTarget ? (
      <div className="pt-3 pb-0.5" data-sidebar-section-draft>
        <InlineSectionName
          key={`${newSectionTarget.chat.spaceId}:${newSectionTarget.kind}:${newSectionTarget.chat.id}`}
          existingNames={sectionsForSpace(newSectionTarget.chat.spaceId).map(
            (section) => section.name,
          )}
          onCancel={() => setNewSectionTarget(null)}
          onConfirm={async (name) => {
            const target = newSectionTarget;
            await performOrganization(async () => {
              const section = await rpc.botSections.create(
                target.kind === "bot"
                  ? { botId: target.chat.id, name }
                  : { groupId: target.chat.id, name },
                { context: { spaceId: target.chat.spaceId } },
              );
              applySections(target.chat.spaceId, [
                ...sectionsForSpace(target.chat.spaceId).filter((item) => item.id !== section.id),
                section,
              ]);
              patchChatOrganization(target, { sectionId: section.id, pinned: false });
              expandSection(target.chat.spaceId, section.id);
              setSidebarNotice(target.chat.pinned ? t`Moved and unpinned` : null);
              setNewSectionTarget((current) => (current === target ? null : current));
              organizationUndo.current = async () => {
                await removeSection(section, target.chat.spaceId);
                organizationUndo.current = null;
                setDeletedSection(null);
                await saveChatOrganization(
                  target,
                  { sectionId: target.chat.sectionId, pinned: target.chat.pinned },
                  false,
                );
              };
            });
          }}
        />
      </div>
    ) : null;
  const toggleRosterParent = useCallback(
    (botId: string) => {
      setCollapsedRosterParents((previous) =>
        toggleCollapsedIdSet(previous, botId, collapsedRosterParentsStorageKey(userId)),
      );
    },
    [userId],
  );
  const spaceQuery = query.trim();
  const showSpaceSearch = spaceQuery.length > 0;

  useEffect(() => {
    if (!showSpaceSearch) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      void rpc.search
        .query({ q: spaceQuery })
        .then((result) => {
          if (!abort.signal.aborted) setSearchHits(result.hits);
        })
        .catch(() => {
          if (!abort.signal.aborted) setSearchHits([]);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearchLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [showSpaceSearch, spaceQuery]);

  async function jumpToSearchHit(hit: SearchHit) {
    setQuery("");
    setSearchHits([]);
    const params = new URLSearchParams();
    if (hit.messageId) params.set("m", hit.messageId);
    if (hit.routineId) params.set("routine", hit.routineId);
    navigate({
      pathname: hit.groupId ? `/app/g/${hit.groupId}` : `/app/${hit.botId}`,
      search: params.toString() ? `?${params.toString()}` : undefined,
    });
  }

  async function jumpToMessage(target: {
    botId?: string;
    groupId?: string;
    messageId: string;
    attention?: boolean;
  }) {
    const threadTarget = searchHitThreadTarget(target);
    const savedGroupAtStart = target.groupId
      ? savedGroupUpdates.current.get(target.groupId)
      : undefined;
    const epoch = historyEpoch.current;
    const spaceId = selectedSpaceId() ?? groupSettingsActor.current.spaceId;
    jumpGeneration.current += 1;
    const jumpId = jumpGeneration.current;
    const snap = await rpc.threads.get(threadTarget);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch): applying
    // the fetched page would pin deleted messages that every later refresh keeps restoring.
    // jumpId drops an older jump that finished after a newer click.
    if (
      epoch !== historyEpoch.current ||
      jumpId !== jumpGeneration.current ||
      (selectedSpaceId() ?? groupSettingsActor.current.spaceId) !== spaceId
    )
      return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    const messageId = target.attention ? (snap.attentionMessageId ?? null) : target.messageId;
    const atDispatch = snapshotRef.current;
    const requestCursor = Math.max(
      snap.cursor,
      atDispatch?.threadId === snap.threadId ? atDispatch.cursor : -1,
    );
    // The page read must follow its target snapshot, including on a cold or cross-thread jump.
    const fetchedPage = await rpc.threads.messages({
      ...threadTarget,
      around: { messageId: messageId ?? target.messageId },
    });
    if (
      epoch !== historyEpoch.current ||
      jumpId !== jumpGeneration.current ||
      (selectedSpaceId() ?? groupSettingsActor.current.spaceId) !== spaceId
    )
      return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    const current = snapshotRef.current;
    if (target.attention && current?.threadId === snap.threadId && current.cursor > snap.cursor) {
      // Decisions can arrive while the around page is loading. Never restore stale approvals.
      if (target.groupId) await refreshGroupThread(target.groupId);
      else if (target.botId) await refreshThread(target.botId);
      return;
    }
    const savedGroup = target.groupId ? savedGroupUpdates.current.get(target.groupId) : undefined;
    const jumpSnapshot =
      savedGroup !== savedGroupAtStart ? (syncSavedGroupSnapshot(snap, savedGroup) ?? snap) : snap;
    const reconciled = reconcileRefreshedThread(current, jumpSnapshot, computerRef.current);
    const page = protectThreadMessagePage(reconciled.snapshot, fetchedPage, requestCursor);
    const targetInPage =
      page !== null &&
      messageId !== null &&
      userVisibleMessages(page.messages, { includePeerReceipts: true }).some(
        (message) => message.id === messageId,
      );
    const targetInSnapshot =
      page === null &&
      messageId !== null &&
      userVisibleMessages(reconciled.snapshot.messages, { includePeerReceipts: true }).some(
        (message) => message.id === messageId,
      );
    const targetLoaded = targetInPage || targetInSnapshot;
    expandedHistoryThread.current = targetLoaded ? reconciled.snapshot.threadId : null;
    pinnedAroundRef.current =
      targetInPage && page
        ? {
            ...threadTarget,
            messageId: messageId!,
            threadId: page.threadId,
            messages: page.messages,
            olderCursor: page.olderCursor,
          }
        : null;
    if (targetLoaded) initiallyScrolledThread.current = reconciled.snapshot.threadId;
    commitSnapshot({
      ...reconciled.snapshot,
      messages: targetInPage && page ? page.messages : reconciled.snapshot.messages,
      olderCursor: targetInPage && page ? page.olderCursor : reconciled.snapshot.olderCursor,
    });
    if (threadTarget.botId) {
      commitComputer(reconciled.computer);
      // Don't block parent-scroll on routines metadata; a list failure must not abort the jump.
      void rpc.routines
        .list({ botId: threadTarget.botId })
        .then((routines) => {
          if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
          if (activeBotId.current !== threadTarget.botId) return;
          setRoutines(routines);
          setRoutinesBotId(threadTarget.botId);
        })
        .catch(() => undefined);
    } else {
      commitComputer(null);
      setRoutines([]);
      setRoutinesBotId(null);
    }
    if (targetLoaded) {
      // The transcript owns the scroll: it retries until the pinned row is
      // mounted and unfollows the tail, so live commits cannot cancel it.
      setScrollRequest({ messageId: messageId!, nonce: jumpId });
    } else {
      window.requestAnimationFrame(() => {
        if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
        const element = messageScroll.current;
        if (element) {
          element.scrollTop = element.scrollHeight;
          initiallyScrolledThread.current = reconciled.snapshot.threadId;
        }
      });
    }
  }

  // The routine panel copies a routine's data into local draft state at click time
  // rather than deriving it from `active`, so it goes stale across a bot switch —
  // without this, Save on bot B could silently update bot A's routine.
  useEffect(() => {
    setEditingRoutine(null);
    setDeleteRoutineTarget(null);
    setPanelState((current) => (current === "routine" ? null : current));
  }, [active?.id]);

  useEffect(() => {
    const messageId = searchParams.get("m");
    const routineId = searchParams.get("routine");
    if (inGroup && groupId && messageId) {
      if (!activeGroup) return;
      void jumpToMessage({ groupId, messageId, attention: searchParams.get("attention") === "1" })
        .catch(() => undefined)
        .finally(() => {
          if (activeGroupId.current !== groupId || searchParamsRef.current.get("m") !== messageId)
            return;
          // Keep expandedHistoryThread; only strip the jump URL so refresh does not remount.
          const next = new URLSearchParams(searchParams);
          next.delete("m");
          next.delete("attention");
          setSearchParams(next, { replace: true });
        });
      return;
    }
    if (!active) return;
    if (routineId && routinesBotId === active.id) {
      const routine = routines.find((item) => item.id === routineId);
      if (routine) {
        setRoutineDraft(draftFromRoutine(routine));
        setRoutineWebhookSecret(null);
        setEditingRoutine(routine);
        setPanel("routine");
      } else {
        setPanel("computer");
      }
      const next = new URLSearchParams(searchParams);
      next.delete("routine");
      setSearchParams(next, { replace: true });
    }
    if (messageId) {
      void jumpToMessage({
        botId: active.id,
        messageId,
        attention: searchParams.get("attention") === "1",
      })
        .catch(() => undefined)
        .finally(() => {
          if (activeBotId.current !== active.id || searchParamsRef.current.get("m") !== messageId)
            return;
          const next = new URLSearchParams(searchParams);
          next.delete("m");
          next.delete("attention");
          setSearchParams(next, { replace: true });
        });
    }
  }, [
    active?.id,
    activeGroup?.id,
    groupId,
    inGroup,
    routines,
    routinesBotId,
    searchParams,
    setSearchParams,
  ]);
  const activeSnapshot = inNewChat
    ? null
    : inGroup
      ? snapshot?.groupId === groupId
        ? snapshot
        : null
      : snapshot?.botId === active?.id
        ? snapshot
        : null;
  const [replyAnnouncement, stopReplyAnnouncements, observeReplyEvent] = useReplyAnnouncements(
    JSON.stringify([
      settingsOwnerKey,
      bootstrapMe?.spaceId,
      currentSpaceSelectionGeneration(),
      activeSnapshot?.threadId,
    ]),
    activeSnapshot,
    Boolean(peerConversation) ||
      Boolean(call && call.botId === active?.id) ||
      mobileSidebarOpen ||
      bootstrapLoad.pending ||
      Boolean(bootstrapLoad.error),
  );
  useLayoutEffect(() => {
    replyEventObserver.current = observeReplyEvent;
    return () => {
      replyEventObserver.current = () => {};
    };
  }, [observeReplyEvent]);
  useLayoutEffect(() => {
    const sessionId = session.data?.session.id;
    const targetId = groupId ?? botId;
    if (
      !userId ||
      !sessionId ||
      !targetId ||
      !draftScopeKey ||
      !activeSnapshot ||
      bootstrapMe?.userId !== userId ||
      bootstrapLoad.pending ||
      bootstrapLoad.error ||
      inNewChat ||
      peerConversation ||
      (groupId ? activeSnapshot.groupId !== groupId : activeSnapshot.botId !== botId)
    )
      return;
    const selectionId = selectedSpaceId();
    const selectionGeneration = currentSpaceSelectionGeneration();
    if (selectionId && selectionId !== bootstrapMe.spaceId) return;
    const owner = settingsOwner;
    const target = {
      apiOrigin: window.location.origin,
      userId,
      sessionId,
      spaceId: bootstrapMe.spaceId,
      selectionId,
      selectionGeneration,
      targetKind: groupId ? ("group" as const) : ("bot" as const),
      targetId,
      threadId: activeSnapshot.threadId,
    };
    const isCurrent = () =>
      committedSettingsOwner.current === owner &&
      selectedSpaceId() === selectionId &&
      currentSpaceSelectionGeneration() === selectionGeneration &&
      routeBotId.current === botId &&
      routeGroupId.current === groupId &&
      snapshotRef.current?.threadId === target.threadId;
    const blocked = sendingRef.current || Boolean(call) || Boolean(recordingSkill);
    if (!isCurrent()) return;
    rememberVerifiedComposerRecoveryTarget(target, draftScopeKey, blocked);
    restoreRejectedComposerDraft(target, draftScopeKey, !blocked, isCurrent);
  }, [
    activeSnapshot,
    bootstrapMe,
    bootstrapLoad,
    session.data?.session.id,
    userId,
    draftScopeKey,
    botId,
    groupId,
    inNewChat,
    peerConversation,
    settingsOwner,
    sending,
    call,
    recordingSkill,
  ]);
  // Keep the armed reply even when its parent leaves the loaded page: the
  // server resolves a paged-out target and degrades a deleted one to a plain
  // reply instead of failing the send.
  const activeReplyTarget = replyTarget;
  const activeReplyQuote = replyTarget ? replyQuote : null;
  const clearReply = useCallback(() => {
    updateComposerDraft({ replyTarget: null, replyQuote: null });
  }, [updateComposerDraft]);
  const currentRuns = activeThreadRuns(activeSnapshot);
  const answerableAskMessageId = latestAnswerableAskMessageId(activeSnapshot);
  const answerableApprovalMessageIds = useMemo(
    () => new Set(activeSnapshot?.answerableApprovalMessageIds),
    [activeSnapshot?.answerableApprovalMessageIds],
  );
  const workingRuns = currentRuns.filter((run) =>
    ["running", "queued", "leased"].includes(run.status),
  );
  const transcriptRunning = workingRuns.length > 0;
  const composerRunning = currentRuns.some((run) => isActive(run.status));
  const exampleTarget = useMemo(
    () => ({
      scope: creationScope,
      key: draftScopeKey,
      botId: active?.id,
      blocked:
        inGroup ||
        inNewChat ||
        Boolean(peerConversation) ||
        Boolean(recordingSkill) ||
        composerRunning,
    }),
    [
      creationScope,
      draftScopeKey,
      active?.id,
      inGroup,
      inNewChat,
      peerConversation,
      recordingSkill,
      composerRunning,
    ],
  );
  const committedExampleTarget = useRef<typeof exampleTarget | null>(null);
  useLayoutEffect(() => {
    committedExampleTarget.current = exampleTarget;
    return () => {
      if (committedExampleTarget.current === exampleTarget) committedExampleTarget.current = null;
    };
  }, [exampleTarget]);
  const templateExample =
    active && !inGroup && !inNewChat
      ? creationScope.examples.read(creationScope.scopeKey, active.id)
      : null;
  function insertTemplateExample() {
    if (!templateExample) return;
    creationScope.examples.insert(
      creationScope.scopeKey,
      templateExample.botId,
      templateExample.exampleNonce,
      (text) =>
        insertEmptyComposerDraft(
          exampleTarget.key,
          text,
          () =>
            committedExampleTarget.current === exampleTarget &&
            exampleTarget.scope.scopeCurrent() &&
            exampleTarget.botId === templateExample.botId &&
            !exampleTarget.blocked &&
            !sendingRef.current,
        ),
    );
    refreshTemplateExample((value) => value + 1);
  }

  const runError = threadRunError(activeSnapshot, dismissedRunErrorIds);
  const displayedRunError = !sendError ? runError : null;
  const displayedRunErrorId = displayedRunError ? (activeSnapshot?.run?.id ?? null) : null;
  const handleRunErrorPresented = useCallback((runId: string) => {
    rememberSeenRunErrorId(runId);
  }, []);
  const transcriptMessages = useMemo(
    () =>
      conversationMessages(
        userVisibleMessages(activeSnapshot?.messages ?? [], { includePeerReceipts: true }),
      ),
    [activeSnapshot?.messages],
  );
  const transcriptArtifactTarget = useMemo<ArtifactTarget>(
    () => (inGroup ? { groupId: groupId ?? "" } : { botId: active?.id ?? "" }),
    [active?.id, groupId, inGroup],
  );
  const transcriptMembers = activeSnapshot?.members ?? activeGroup?.members;
  const resolveTranscriptBot = useCallback(
    (botId: string) => {
      const bot = bots.find((candidate) => candidate.id === botId);
      if (bot) return bot;
      return transcriptMembers?.find((member) => member.botId === botId);
    },
    [bots, transcriptMembers],
  );
  const workingBots: GroupAvatarMember[] = workingRuns.map((run) => {
    const bot = resolveTranscriptBot(run.botId);
    return {
      botId: run.botId,
      color: bot?.color ?? FALLBACK_BOT_COLOR,
      name: bot?.name,
      status: run.status,
    };
  });
  const resolveTranscriptMemberName = useCallback(
    (botId: string | undefined) => memberName(transcriptMembers, botId),
    [transcriptMembers],
  );
  const replyTargetName = activeReplyTarget
    ? activeReplyTarget.role === "user"
      ? t`You`
      : (resolveTranscriptMemberName(activeReplyTarget.botId) ?? active?.name ?? t`Bot`)
    : undefined;
  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup || (inNewChat && pendingChat.botIds.length > 1),
        currentGroupId: groupId,
        bots: bots.map((bot) => ({ id: bot.id, name: bot.name, color: bot.color })),
        groups: groups.map((group) => ({ id: group.id, name: group.name })),
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
      }),
    [
      bots,
      groupId,
      groups,
      inGroup,
      inNewChat,
      pendingChat.botIds.length,
      mentionConnectors,
      mentionRoutines,
    ],
  );
  const shellReady =
    Boolean(bootstrapMe) &&
    initialBotsLoaded &&
    (inNewChat ||
      (inGroup
        ? Boolean(activeGroup && activeSnapshot)
        : bots.length === 0 || Boolean(active && activeSnapshot)));
  const refreshThreadRef = useRef(refreshThread);
  refreshThreadRef.current = refreshThread;
  const refreshGroupThreadRef = useRef(refreshGroupThread);
  refreshGroupThreadRef.current = refreshGroupThread;
  const loadOlderMessagesRef = useRef(loadOlderMessages);
  loadOlderMessagesRef.current = loadOlderMessages;
  const jumpToMessageRef = useRef(jumpToMessage);
  jumpToMessageRef.current = jumpToMessage;

  const mentionBotsKey = useMemo(
    () => bots.map((bot) => `${bot.id}:${bot.name}`).join(","),
    [bots],
  );
  const botsForMentionsRef = useRef(bots);
  botsForMentionsRef.current = bots;

  useEffect(() => {
    const bots = botsForMentionsRef.current;
    if (!initialBotsLoaded || bots.length === 0) {
      setMentionRoutines([]);
      setMentionConnectors([]);
      return;
    }
    let cancelled = false;
    const botNameById = new Map(bots.map((bot) => [bot.id, bot.name]));
    void Promise.all(
      bots.map((bot) =>
        rpc.routines
          .list({ botId: bot.id })
          .then((rows) =>
            rows.map((routine) => ({
              ...routine,
              botName: botNameById.get(bot.id) ?? bot.name,
            })),
          )
          .catch(() => [] as Array<Routine & { botName?: string }>),
      ),
    ).then((lists) => {
      if (!cancelled) setMentionRoutines(lists.flat());
    });
    void Promise.all([
      rpc.connections.list().catch(() => [] as Connection[]),
      rpc.connections.catalog({}).catch(() => [] as ConnectionCatalogItem[]),
    ]).then(([connections, catalog]) => {
      if (cancelled) return;
      const connected = connections.filter((row) => row.status === "connected");
      const options: Array<{
        id: string;
        name: string;
        authStatus: "connected" | "needs_auth";
        connectionId?: string;
      }> = connected.map((row) => ({
        id: row.id,
        name: row.displayName,
        authStatus: "connected" as const,
        connectionId: row.id,
      }));
      for (const item of catalog) {
        if (item.connected || item.noAuth) continue;
        if (
          connected.some(
            (row) =>
              row.provider.toLowerCase() === item.slug.toLowerCase() ||
              row.displayName.toLowerCase() === item.name.toLowerCase(),
          )
        ) {
          continue;
        }
        options.push({
          id: `catalog:${item.connectorId}:${item.slug}`,
          name: item.name,
          authStatus: "needs_auth",
        });
      }
      setMentionConnectors(options);
    });
    return () => {
      cancelled = true;
    };
  }, [initialBotsLoaded, mentionBotsKey, pluginsOpen, connectionsRevision]);

  useLayoutEffect(() => {
    if (initialBotsLoaded) {
      markOnce("rk:renderer:bots-committed");
      markAfterPaint("rk:renderer:bots-painted");
    }
    if (active && snapshot?.botId === active.id) {
      markOnce("rk:renderer:thread-committed");
      markAfterPaint("rk:renderer:thread-painted");
    }
    if (shellReady) {
      markOnce("rk:renderer:shell-ready");
      markAfterPaint("rk:renderer:shell-painted");
    }
  }, [active, initialBotsLoaded, shellReady, snapshot?.botId]);

  useLayoutEffect(() => {
    const pin = pinnedAroundRef.current;
    if (inGroup) {
      if (!groupId || !snapshot || snapshot.groupId !== groupId) return;
      if (initiallyScrolledThread.current === snapshot.threadId) return;
      if (expandedHistoryThread.current === snapshot.threadId) return;
      if (pin?.groupId === groupId) return;
    } else {
      if (!active || !snapshot || snapshot.botId !== active.id) return;
      if (initiallyScrolledThread.current === snapshot.threadId) return;
      if (expandedHistoryThread.current === snapshot.threadId) return;
      if (pin?.botId === active.id) return;
    }
    const element = messageScroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    initiallyScrolledThread.current = snapshot.threadId;
  }, [active, groupId, inGroup, snapshot?.botId, snapshot?.groupId, snapshot?.threadId]);

  const openBot = useCallback((id: string) => navigate(`/app/${id}`), [navigate]);
  const loadOlder = useCallback(() => loadOlderMessagesRef.current(), []);
  const jumpToReplyMessage = useCallback((messageId: string) => {
    const existing = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (existing) {
      // Cancel any in-flight around-fetch so it cannot overwrite this scroll.
      jumpGeneration.current += 1;
      setScrollRequest({ messageId, nonce: jumpGeneration.current });
      return;
    }
    const groupId = activeGroupId.current;
    if (groupId) {
      void jumpToMessageRef.current({ groupId, messageId }).catch(() => undefined);
      return;
    }
    const botId = activeBotId.current;
    if (botId) void jumpToMessageRef.current({ botId, messageId }).catch(() => undefined);
  }, []);
  const answerMessage = useCallback(
    async (message: ThreadMessage, text: string, username?: string) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      await rpc.threads.answer({
        ...(groupId ? { groupId } : { botId: botId! }),
        runId: message.runId ?? "",
        messageId: message.id,
        answer: text,
        ...(username ? { username } : {}),
      });
      updateSnapshot((prev) =>
        prev?.threadId === message.threadId
          ? {
              ...prev,
              answerableApprovalMessageIds: prev.answerableApprovalMessageIds?.filter((id) =>
                prev.messages.some((row) => row.id === id && row.runId !== message.runId),
              ),
            }
          : prev,
      );
      if (groupId && activeGroupId.current === groupId) {
        await refreshGroupThreadRef.current(groupId);
      } else if (botId && activeBotId.current === botId) {
        await refreshThreadRef.current(botId);
      }
    },
    [],
  );
  const reactToMessage = useCallback(
    async (message: ThreadMessage, reaction: MessageReaction) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      try {
        await rpc.threads.react({
          ...(groupId ? { groupId } : { botId: botId! }),
          messageId: message.id,
          reaction,
          clientNonce: newClientNonce(),
        });
      } catch (error) {
        const stillHere = groupId
          ? activeGroupId.current === groupId
          : activeBotId.current === botId;
        if (!stillHere) return;
        setSendError(errorText(error, t`Could not update reaction`));
      }
    },
    [t],
  );
  const onAttachmentPick = useCallback(
    async (files: FileList | null) => {
      const threadKey = draftScopeKey;
      if (!threadKey || !files?.length) return;
      const existing = readComposerDraft(threadKey).attachments;
      const next: PendingAttachment[] = [];
      const skipped: string[] = [];
      let overLimit = 0;
      for (const file of Array.from(files)) {
        if (existing.length + next.length >= ATTACHMENT_MAX_COUNT) {
          overLimit += 1;
          continue;
        }
        if (file.size > ATTACHMENT_MAX_BYTES) {
          skipped.push(t`${file.name} (over 10 MiB)`);
          continue;
        }
        const mimeType = inferAttachmentMimeType(file.name, file.type);
        if (!mimeType) {
          skipped.push(file.name);
          continue;
        }
        next.push({
          id: newClientNonce(),
          threadKey,
          file,
          previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        });
      }
      if (next.length)
        updateComposerDraft((current) => ({ attachments: [...current.attachments, ...next] }));
      const notices = [
        ...(overLimit
          ? [t`Up to ${ATTACHMENT_MAX_COUNT} attachments. ${overLimit} not added.`]
          : []),
        ...(skipped.length ? [t`Skipped ${skipped.join(", ")}`] : []),
      ];
      setAttachmentNotice(notices.length ? { scopeKey: threadKey, text: notices.join(" ") } : null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [draftScopeKey, updateComposerDraft, t],
  );
  const removeAttachment = useCallback(
    (attachment: PendingAttachment) => {
      revokePendingAttachmentPreviews([attachment]);
      updateComposerDraft((current) => ({
        attachments: current.attachments.filter((item) => item.id !== attachment.id),
      }));
      setAttachmentNotice((current) =>
        current?.scopeKey === attachment.threadKey ? null : current,
      );
    },
    [updateComposerDraft],
  );
  const sendMessage = useCallback(
    async (
      text: string,
      mentions: ComposerMention[] = [],
      submittedVersion: number,
    ): Promise<boolean> => {
      const initialBotTarget = activeBotId.current;
      const initialGroupTarget = activeGroupId.current;
      const newChat = inNewChatRef.current ? pendingChatRef.current : null;
      const originThreadKey = draftScopeKey;
      if (
        (!initialBotTarget && !initialGroupTarget && !newChat?.botIds.length) ||
        !originThreadKey ||
        sendingRef.current
      )
        return false;
      const submitted = readComposerDraft(originThreadKey);
      if (submitted.version !== submittedVersion) return false;
      const attachments = submitted.attachments;
      const plan = resolveComposerSendPlan({
        text,
        mentions,
        hasAttachments: attachments.length > 0,
      });
      if (plan.isNoOp) return false;
      const reroutedToGroup = Boolean(
        plan.rerouteGroupId && plan.rerouteGroupId !== initialGroupTarget,
      );
      let groupTarget = plan.rerouteGroupId ?? initialGroupTarget;
      const botTarget = reroutedToGroup
        ? undefined
        : newChat?.botIds.length === 1
          ? newChat.botIds[0]
          : initialBotTarget;
      let target = groupTarget ? { groupId: groupTarget } : { botId: botTarget };
      const replyToMessageId = reroutedToGroup ? undefined : submitted.replyTarget?.id;
      const replyQuote = reroutedToGroup ? undefined : submitted.replyQuote;
      const attempt = composerSendAttempts.acquire(
        originThreadKey,
        composerSendSignature({
          text: plan.trimmed,
          target:
            newChat && newChat.botIds.length > 1 && !reroutedToGroup
              ? { groupId: `new-chat:${newChat.id}:${newChat.botIds.join(",")}` }
              : target,
          mentions: plan.mentionPayload,
          routineIds: plan.routineIds,
          attachments,
          replyToMessageId,
          replyQuote,
        }),
      );
      if (!attempt) return false;
      const context = { context: { spaceId: bootstrapMe?.spaceId } };
      const isCurrentAttempt = () => composerSendAttempts.isCurrent(originThreadKey, attempt);
      const stillHere = () =>
        draftScopeKeyRef.current === originThreadKey &&
        activeGroupId.current === initialGroupTarget &&
        activeBotId.current === initialBotTarget;
      if (
        plan.shouldSend &&
        (groupTarget || botsRef.current.find((bot) => bot.id === botTarget)?.notifyOnFinish)
      ) {
        const permissionRequest = requestBrowserNotificationPermission();
        if (permissionRequest) void permissionRequest.then(flushPendingBrowserNotifications);
      }
      sendingRef.current = true;
      setSending(true);
      setSendError(null);
      let succeeded = false;
      try {
        if (newChat && plan.shouldSend && !reroutedToGroup && newChat.botIds.length > 1) {
          const creation = groupCreationIntent(newChat, botsRef.current);
          setPendingChat((current) => (current.id === newChat.id ? { ...newChat } : current));
          if (!newChat.groupId) {
            const group = await rpc.groups.create(creation, context);
            newChat.groupId = group.id;
            setPendingChat((current) => (current.id === newChat.id ? { ...newChat } : current));
            setGroups((current) =>
              current.some((item) => item.id === group.id) ? current : [group, ...current],
            );
          }
          groupTarget = newChat.groupId;
          target = { groupId: groupTarget };
        }
        if (!isCurrentAttempt()) return false;
        if (plan.shouldRunRoutines) {
          const routineResults = await Promise.allSettled(
            plan.routineIds.map(async (routineId) => {
              if (!isCurrentAttempt()) return;
              if (attempt.completedRoutineIds.has(routineId)) return;
              await rpc.routines.testRun(
                { routineId, clientNonce: `routine-mention:${attempt.clientNonce}:${routineId}` },
                context,
              );
              attempt.completedRoutineIds.add(routineId);
            }),
          );
          for (const result of routineResults) {
            if (result.status === "rejected") throw result.reason;
          }
        }
        if (!isCurrentAttempt()) return false;
        if (plan.shouldSend) {
          const artifactIds: string[] = [];
          for (const pending of attachments) {
            if (!isCurrentAttempt()) return false;
            let artifactId = attempt.uploadedArtifactIds.get(pending.id);
            if (!artifactId) {
              const mimeType = inferAttachmentMimeType(pending.file.name, pending.file.type);
              if (!mimeType) throw new Error(t`Unsupported file type: ${pending.file.name}`);
              const contentBase64 = await readFileAsBase64(pending.file);
              if (!isCurrentAttempt()) return false;
              const artifact = await rpc.artifacts.create(
                {
                  ...target,
                  name: pending.file.name,
                  mimeType,
                  contentBase64,
                  clientNonce: `${attempt.clientNonce}:attachment:${pending.id}`,
                },
                context,
              );
              artifactId = artifact.id;
              attempt.uploadedArtifactIds.set(pending.id, artifactId);
            }
            artifactIds.push(artifactId);
          }
          if (!isCurrentAttempt()) return false;
          const sent = await rpc.threads.send(
            {
              ...target,
              clientNonce: attempt.clientNonce,
              text: plan.trimmed || undefined,
              mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
              artifactIds: artifactIds.length ? artifactIds : undefined,
              replyToMessageId,
              replyQuote: replyQuote ?? undefined,
            },
            context,
          );
          if (!isCurrentAttempt()) return false;
          if (!sent?.runId || !sent?.taskId) throw new Error(t`Failed to send message`);
          if (botTarget && stillHere()) {
            updateSnapshot((current) =>
              applyThreadSendReceipt(
                current,
                { botId: botTarget, runId: sent.runId, taskId: sent.taskId },
                terminalRunReceipts.current,
              ),
            );
          }
        }
        succeeded = true;
        consumeSubmittedComposerDraft(originThreadKey, submitted);
        if (stillHere()) setAttachmentNotice(null);
        void refreshBots().catch(() => undefined);
        if (newChat && (plan.shouldSend || reroutedToGroup)) {
          const targetId = groupTarget ?? botTarget!;
          const destinationKey = makeComposerDraftKey({
            userId: userId!,
            spaceId: bootstrapMe!.spaceId,
            targetKind: groupTarget ? "group" : "bot",
            targetId,
          });
          if (moveComposerDraft(originThreadKey, destinationKey)) {
            setPendingChat((current) => (current.id === newChat.id ? newChatDraft() : current));
          }
          // A pre-existing destination draft stays intact; any newer source edits
          // remain in the pending chat instead of replacing it.
          if (stillHere()) navigate(groupTarget ? `/app/g/${groupTarget}` : `/app/${targetId}`);
        } else if (reroutedToGroup && groupTarget && stillHere()) navigate(`/app/g/${groupTarget}`);
        if (groupTarget) void refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
        else if (botTarget) void refreshThreadRef.current(botTarget).catch(() => undefined);
        return true;
      } catch (error) {
        if (isCurrentAttempt() && stillHere())
          setSendError(
            isServerUnreachable(error)
              ? t`Send not confirmed. Your draft is kept.`
              : errorText(error, t`Failed to send message`),
          );
        return false;
      } finally {
        composerSendAttempts.finish(originThreadKey, attempt, succeeded);
        sendingRef.current = false;
        setSending(false);
      }
    },
    [draftScopeKey, bootstrapMe?.spaceId, userId, flushPendingBrowserNotifications, navigate, t],
  );
  const stopRun = useCallback(async () => {
    if (sending) return;
    stopReplyAnnouncements();
    invalidateComputerBoot();
    sendingRef.current = true;
    setSending(true);
    try {
      const botTarget = activeBotId.current;
      const groupTarget = activeGroupId.current;
      if (groupTarget) {
        setSendError(null);
        try {
          await rpc.threads.stop({ groupId: groupTarget });
        } catch (error) {
          if (activeGroupId.current === groupTarget) {
            setSendError(errorText(error, t`Failed to stop`));
          }
          return;
        }
        // Clear run UI ahead of the run.cancelled event so refresh races with in-flight gets.
        if (activeGroupId.current === groupTarget) {
          updateSnapshot((prev) =>
            prev && prev.groupId === groupTarget ? clearActiveThreadRuns(prev) : prev,
          );
        }
        await refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
        return;
      }
      if (!botTarget) return;
      setSendError(null);
      try {
        await rpc.threads.stop({ botId: botTarget });
      } catch (error) {
        if (activeBotId.current === botTarget) {
          setSendError(errorText(error, t`Failed to stop`));
        }
        return;
      }
      // Clear local run/busy immediately rather than waiting for run.cancelled so a
      // superseded in-flight refresh (older cursor) cannot leave Stop enabled / Take control
      // blocked while the API is already idle.
      if (activeBotId.current === botTarget) {
        updateSnapshot((prev) =>
          !prev || (prev.botId !== botTarget && prev.botId) ? prev : clearActiveThreadRuns(prev),
        );
        const currentComputer = computerRef.current;
        if (currentComputer?.busyBotName) {
          commitComputer({ ...currentComputer, busyBotName: null });
        }
      }
      await refreshThreadRef.current(botTarget).catch(() => undefined);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [stopReplyAnnouncements, sending, t]);
  const stopTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id || teachBusy) return;
    const recording = taughtSkills.find(
      (skill) => skill.status === "recording" && taughtSkillsBotId === id,
    );
    if (!recording) return;
    setTeachBusy(true);
    try {
      await rpc.skills.stop({ skillId: recording.id });
      await refreshThreadRef.current(id);
      setComputerOpen(false);
    } finally {
      setTeachBusy(false);
    }
  }, [teachBusy, taughtSkills, taughtSkillsBotId]);
  // Transcript and MessageView are memoized; these must stay referentially stable or every
  // Shell state change re-renders the whole transcript.
  const refreshActiveThread = useCallback(async () => {
    const groupId = activeGroupId.current;
    if (groupId) {
      await refreshGroupThreadRef.current(groupId);
      return;
    }
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
  }, []);
  // Teach chrome needs skills applied before this resolves — refreshThread only
  // kicks skills.list off in the background, so Stop teaching would never mount
  // if that background call failed or lagged behind local recovery.
  const refreshActiveTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
    const skills = await rpc.skills.list({ botId: id });
    if (activeBotId.current !== id) return;
    setTaughtSkills(skills);
    setTaughtSkillsBotId(id);
  }, []);
  const addSkillRoutine = useCallback((name: string, prompt: string) => {
    setRoutineDraft({ ...emptyRoutineDraft(), name, prompt });
    setRoutineWebhookSecret(null);
    setEditingRoutine(null);
    setPanel("routine");
  }, []);
  const speakingMessageIdRef = useRef(speakingMessageId);
  speakingMessageIdRef.current = speakingMessageId;
  const speakMessage = useCallback((message: ThreadMessage) => {
    if (speakingMessageIdRef.current === message.id) {
      speaker.stop();
      return;
    }
    const text = speechFromBlocks(message.blocks);
    const id = message.botId ?? activeBotId.current;
    if (text && id) void speaker.speak(text, { botId: id, messageId: message.id });
  }, []);

  function openNewChat() {
    setPanel(null);
    const params = new URLSearchParams(searchParams);
    params.delete("routine");
    params.delete("m");
    params.set("new-chat", "1");
    setSearchParams(params);
  }

  function closeNewChat() {
    const params = new URLSearchParams(searchParams);
    params.delete("new-chat");
    setSearchParams(params);
  }

  function resetPendingChatCreation(botIds: string[]) {
    const current = pendingChatRef.current;
    const next = {
      ...current,
      botIds,
      groupId: null,
      creation: null,
      creationNonce: newClientNonce(),
    };
    // Keep the draft key and files, but discard receipts for an invalid target.
    if (userId && bootstrapMe?.spaceId) {
      composerSendAttempts.clear(
        makeComposerDraftKey({
          userId,
          spaceId: bootstrapMe.spaceId,
          targetKind: "new-chat",
          targetId: current.id,
        }),
      );
    }
    pendingChatRef.current = next;
    setPendingChat((draft) => (draft.id === current.id ? next : draft));
  }

  function releaseDeletedPendingGroup(deletedGroupId: string) {
    const current = pendingChatRef.current;
    if (current.groupId === deletedGroupId) resetPendingChatCreation(current.botIds);
  }

  function removePendingRecipient(botId: string) {
    const current = pendingChatRef.current;
    if (current.botIds.includes(botId))
      resetPendingChatCreation(current.botIds.filter((id) => id !== botId));
  }

  function setBotsSidebarCollapsedPref(collapsed: boolean) {
    setBotsSidebarCollapsed(collapsed);
    writeBotsSidebarCollapsed(userId, collapsed);
  }

  function openSettings(section: SettingsSection = "general") {
    setSettingsSpaceId(null);
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  function publishCreatedBot(receipt: BotCreationReceipt) {
    if (!botCreationEditor?.isCurrent()) return;
    const bot = receipt.bot;
    botsRefreshEpoch.current += 1;
    botsRefreshApplied.current = botsRefreshEpoch.current;
    setBots((current) =>
      current.some((item) => item.id === bot.id) ? current : [bot, ...current],
    );
    if (receipt.submitted.template && receipt.exampleNonce) {
      creationScope.examples.remember({
        scopeKey: creationScope.scopeKey,
        botId: bot.id,
        selection: receipt.submitted.template,
        exampleNonce: receipt.exampleNonce,
      });
      refreshTemplateExample((value) => value + 1);
    }
  }
  function openCreatedBot(bot: Bot) {
    if (!botCreationEditor?.isCurrent() || bot.spaceId !== creationSpaceId) return;
    navigate(`/app/${bot.id}`);
    setPanel(null);
  }

  async function bootComputer({
    botId: targetBotId,
    takeControl,
    overlay,
    force = false,
  }: {
    botId: string;
    takeControl: boolean;
    overlay: boolean;
    force?: boolean;
  }) {
    const cached = computerCacheRef.current.get(targetBotId);
    const targetComputer = computer?.botId === targetBotId ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === targetBotId ? screenUrl : (cached?.screenUrl ?? null);
    const needsBoot = force || targetComputer?.state !== "running" || !targetScreen;
    const pending = computerBootAttempt.current;
    let provision = pending?.botId === targetBotId && pending.isCurrent() ? pending : null;
    let stillThisBoot = provision?.isCurrent;
    if (!stillThisBoot) {
      const epoch = ++computerBootEpoch.current;
      const owner = settingsOwner;
      const spaceId = selectedSpaceId() ?? groupSettingsActor.current.spaceId;
      const selectionGeneration = currentSpaceSelectionGeneration();
      const apiOrigin = window.location.origin;
      const activeId = activeBotId.current;
      const groupId = activeGroupId.current;
      const mode = botsRef.current.find((bot) => bot.id === targetBotId)?.computerMode;
      const isCurrent = () =>
        computerBootEpoch.current === epoch &&
        committedSettingsOwner.current === owner &&
        window.location.origin === apiOrigin &&
        currentSpaceSelectionGeneration() === selectionGeneration &&
        (selectedSpaceId() ?? groupSettingsActor.current.spaceId) === spaceId &&
        activeBotId.current === activeId &&
        activeGroupId.current === groupId &&
        computerBotIdRef.current === targetBotId &&
        botsRef.current.some(
          (bot) => bot.id === targetBotId && bot.spaceId === spaceId && bot.computerMode === mode,
        );
      stillThisBoot = isCurrent;
      if (needsBoot) {
        const client = createSpaceRpc(spaceId ?? null, isCurrent);
        // Claim the provision before dispatch so both views share only the in-flight boot.
        const promise = Promise.resolve().then(() => client.computer.boot({ botId: targetBotId }));
        const attempt = { botId: targetBotId, isCurrent, promise };
        provision = attempt;
        computerBootAttempt.current = attempt;
        const clear = () => {
          if (computerBootAttempt.current === attempt) computerBootAttempt.current = null;
        };
        void promise.then(clear, clear);
      }
    }
    computerBootObservation.current = stillThisBoot;
    if (overlay && needsBoot) setBooting(true);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    try {
      const status = provision ? await provision.promise : null;
      if (!stillThisBoot()) return;
      if (status) {
        commitComputer(status);
        cacheComputerFor(targetBotId, { computer: status });
      }
      if (takeControl) {
        await createSpaceRpc(
          selectedSpaceId() ?? groupSettingsActor.current.spaceId ?? null,
          stillThisBoot,
        ).computer.takeover({ botId: targetBotId });
        if (!stillThisBoot()) return;
      }
      await refreshComputerFor(targetBotId, stillThisBoot, true);
      if (
        stillThisBoot() &&
        document.visibilityState === "visible" &&
        computerVisible.current &&
        computerRef.current?.botId === targetBotId &&
        computerRef.current.state === "running"
      ) {
        // Explicit Open has completed its own scoped boot/status read.
        screenReadiness.current?.settle(false);
        screenReadiness.current = {
          botId: targetBotId,
          confirmed: true,
          wait: Promise.resolve(true),
          settle() {},
        };
        setVisibleComputerScreen({
          botId: targetBotId,
          ownerKey: settingsOwner.key,
          spaceId: selectedSpaceId() ?? groupSettingsActor.current.spaceId ?? null,
          selection: currentSpaceSelectionGeneration(),
        });
      }
    } catch (error) {
      if (!stillThisBoot()) return;
      setComputerError(errorText(error, t`Could not take control`));
      setComputerErrorFromScreen(false);
      throw error;
    } finally {
      if (stillThisBoot()) setBooting(false);
    }
  }

  async function refreshComputerFor(
    targetBotId: string,
    isCurrent?: () => boolean,
    explicitScreen = false,
  ) {
    if (isCurrent?.() === false) return;
    if (activeBotId.current === targetBotId) {
      await refreshThread(targetBotId, undefined, isCurrent, explicitScreen);
      return;
    }
    if (computerBotIdRef.current !== targetBotId) return;
    const client = isCurrent
      ? createSpaceRpc(selectedSpaceId() ?? groupSettingsActor.current.spaceId ?? null, isCurrent)
      : rpc;
    const status = await client.computer.status({ botId: targetBotId });
    if (isCurrent?.() === false || computerBotIdRef.current !== targetBotId) return;
    commitComputer(status);
    cacheComputerFor(targetBotId, { computer: status });
    await refreshComputerScreen(targetBotId, isCurrent, explicitScreen);
  }

  useEffect(() => {
    if (panel !== "computer") {
      autoBooted.current = null;
      return;
    }
    if (!active) return;
    const botId = active.id;
    const visibilityEpoch = computerVisibilityEpoch.current;
    let cancelled = false;
    void (async () => {
      // Refresh from the server first. A stale SSE "booting" snapshot used to
      // skip this effect, so an RPC takeover never showed "You have control".
      await refreshThread(botId).catch(() => null);
      if (
        cancelled ||
        activeBotId.current !== botId ||
        document.visibilityState !== "visible" ||
        visibilityEpoch !== computerVisibilityEpoch.current
      )
        return;
      // A newer committed snapshot can reject the refresh response as stale.
      const snap = snapshotRef.current;
      if (snap?.botId !== botId) return;
      // Status events update the computer independently of the thread snapshot.
      const observed = computerRef.current;
      const state = (observed?.botId === botId ? observed : snap.computer)?.state;
      const screen = state === "running" ? await refreshComputerScreen(botId) : null;
      if (
        cancelled ||
        activeBotId.current !== botId ||
        document.visibilityState !== "visible" ||
        visibilityEpoch !== computerVisibilityEpoch.current
      )
        return;
      const current = snapshotRef.current;
      const latest = computerRef.current;
      const currentComputer = latest?.botId === botId ? latest : current?.computer;
      const currentScreen = computerCacheRef.current.get(botId)?.screenUrl ?? screen;
      if (
        current?.botId !== botId ||
        !computerPanelNeedsScreen(currentComputer?.state, currentScreen) ||
        screenReadiness.current?.confirmed !== true ||
        autoBooted.current === botId
      )
        return;
      autoBooted.current = botId;
      await bootComputer({
        botId,
        takeControl: false,
        overlay: false,
        force: true,
      }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, active?.id]);

  useEffect(() => {
    setComputerOpen(false);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    setComputerBotId(active?.id);
  }, [active?.id]);

  useEffect(() => {
    if (!computer?.busyBotName) {
      setComputerError(null);
      setComputerErrorFromScreen(false);
    }
  }, [computer?.busyBotName]);

  useEffect(() => {
    if (panel !== "routine") {
      routineSaveRequest.current += 1;
      setRoutineError(null);
    }
  }, [panel]);

  useEffect(() => {
    if (!panelStorageKey) return;
    if (observedPanelKey.current !== panelStorageKey) {
      observedPanelKey.current = panelStorageKey;
      if (pendingExplicitPanel.current || explicitPanelTarget.current === panelStorageKey) {
        pendingExplicitPanel.current = false;
        explicitPanelTarget.current = null;
        pendingPanelRestore.current = null;
        setRestoredPanelKey(panelStorageKey);
        return;
      }
      explicitPanelTarget.current = null;
      // Reload starts with panel=null so storage restores. In-session chat switches used to
      // keep computer/settings open; only routine was cleared (handled above). Carry is
      // session-only — do not write the carried panel onto the destination's saved prefs.
      if (panel === "computer" || panel === "settings" || panel === "group-settings") {
        const carried = panel === "computer" ? "computer" : inGroup ? "group-settings" : "settings";
        pendingPanelRestore.current = null;
        if (carried !== panel) setPanelState(carried);
        setRestoredPanelKey(null);
        return;
      }
      pendingPanelRestore.current = readRightPanelState(panelStorageKey);
    }
    const saved = pendingPanelRestore.current;
    if (!saved) return;
    // Explicit routine links take precedence over a local layout preference.
    if (searchParams.has("routine")) {
      pendingPanelRestore.current = null;
      return;
    }
    if (saved.panel === "routine" && saved.routineId && routinesBotId !== active?.id) return;
    let next = saved.panel;
    if (next === "routine") {
      const routine = saved.routineId
        ? routines.find((item) => item.id === saved.routineId)
        : undefined;
      if (saved.routineId && !routine) next = "computer";
      setEditingRoutine(routine ?? null);
      setRoutineDraft(routine ? draftFromRoutine(routine) : emptyRoutineDraft());
      setRoutineWebhookSecret(null);
    }
    pendingPanelRestore.current = null;
    setPanelState(next);
    setRestoredPanelKey(panelStorageKey);
  }, [panelStorageKey, active?.id, inGroup, panel, routinesBotId, routines, searchParams]);

  useEffect(() => {
    // Do not gate writes on ?routine= staying in the URL — a stuck/failed routine
    // list would freeze layout prefs. Deep-link handling uses setPanelState for the
    // bot-switch close so restoredPanelKey stays unset until an intentional setPanel.
    if (!panelStorageKey || restoredPanelKey !== panelStorageKey || pendingPanelRestore.current)
      return;
    writeRightPanelState(panelStorageKey, panel, editingRoutine?.id);
  }, [panelStorageKey, restoredPanelKey, panel, editingRoutine?.id]);

  useEffect(() => {
    setPeerConversation(null);
    setAttachmentNotice(null);
    setSendError(null);
  }, [draftScopeKey]);

  useEffect(() => {
    if (!computerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setComputerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [computerOpen]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!isCommandPaletteHotkey(event)) return;
      event.preventDefault();
      setCommandPaletteOpen((open) => !open);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const heartbeatBotId = computerBot?.id ?? active?.id;
    if (!watchingComputer || !heartbeatBotId || !userId) return;
    const actor = groupSettingsActor.current;
    const owner = settingsOwner;
    const spaceId = selectedSpaceId() ?? actor.spaceId ?? null;
    const selection = currentSpaceSelectionGeneration();
    let disposed = false;
    let visibilityEpoch = 0;
    let refreshScreen = true;
    let recheckQueued = false;
    function prepareScreenRead() {
      screenReadiness.current?.settle(false);
      let resolve!: (running: boolean) => void;
      const observation = {
        botId: heartbeatBotId!,
        confirmed: null as boolean | null,
        wait: new Promise<boolean>((done) => {
          resolve = done;
        }),
        settle(running: boolean) {
          if (observation.confirmed !== null) return;
          observation.confirmed = running;
          resolve(running);
        },
      };
      screenReadiness.current = observation;
      return observation;
    }
    const presented = () =>
      !disposed &&
      document.visibilityState === "visible" &&
      computerVisible.current &&
      computerBotIdRef.current === heartbeatBotId &&
      spaceId === actor.spaceId &&
      owner === committedSettingsOwner.current &&
      actor.userId === groupSettingsActor.current.userId &&
      actor.spaceId === groupSettingsActor.current.spaceId &&
      spaceId === (selectedSpaceId() ?? groupSettingsActor.current.spaceId ?? null) &&
      selection === currentSpaceSelectionGeneration();
    const heartbeat = createComputerHeartbeat({
      ping: async (signal) => {
        const requestEpoch = visibilityEpoch;
        const current = () => !signal.aborted && requestEpoch === visibilityEpoch && presented();
        if (!current()) return;
        const observation =
          screenReadiness.current?.confirmed === false
            ? prepareScreenRead()
            : screenReadiness.current;
        const before = computerRef.current;
        const client = createSpaceRpc(spaceId, current);
        let status: ComputerStatus;
        try {
          status = await client.computer.status({ botId: heartbeatBotId }, { signal });
        } catch (error) {
          observation?.settle(false);
          if (current()) recheckQueued = false;
          throw error;
        }
        if (!current() || status.botId !== heartbeatBotId) {
          observation?.settle(false);
          return;
        }
        recheckQueued = false;
        // Status has no event cursor. Never overwrite an event received while the read waited.
        if (computerRef.current === before) {
          commitComputer(status, "attendance-read");
          cacheComputerFor(heartbeatBotId, { computer: status });
        }
        const latest = computerRef.current;
        if (
          status.state !== "running" ||
          latest?.botId !== heartbeatBotId ||
          latest.state !== "running"
        ) {
          observation?.settle(false);
          if (status.state !== "running" && latest?.state === "running" && latest !== before)
            recheckComputerStatus.current?.(heartbeatBotId);
          return;
        }
        observation?.settle(true);
        setVisibleComputerScreen({
          botId: heartbeatBotId,
          ownerKey: owner.key,
          spaceId,
          selection,
        });
        if (refreshScreen) {
          refreshScreen = false;
          void refreshComputerScreen(heartbeatBotId, current).catch(() => undefined);
        }
        await client.computer.heartbeat({ botId: heartbeatBotId }, { signal });
      },
    });
    const restartObservation = () => {
      visibilityEpoch += 1;
      computerVisibilityEpoch.current += 1;
      setVisibleComputerScreen(null);
      screenRequest.current += 1;
      screenReadAbort.current?.abort();
      heartbeat.setEnabled(false);
      refreshScreen = true;
      prepareScreenRead();
      heartbeat.setEnabled(presented());
    };
    const recheckRunningComputer = (botId: string) => {
      if (botId !== heartbeatBotId || !presented() || recheckQueued) return;
      recheckQueued = true;
      // An event invalidates the older observation; only a fresh status read can reconnect.
      restartObservation();
    };
    recheckComputerStatus.current = recheckRunningComputer;
    const attendVisibleComputer = () => {
      recheckQueued = false;
      restartObservation();
    };
    prepareScreenRead();
    heartbeat.setEnabled(presented());
    document.addEventListener("visibilitychange", attendVisibleComputer);
    window.addEventListener("online", attendVisibleComputer);
    return () => {
      disposed = true;
      if (recheckComputerStatus.current === recheckRunningComputer)
        recheckComputerStatus.current = null;
      visibilityEpoch += 1;
      computerVisibilityEpoch.current += 1;
      setVisibleComputerScreen(null);
      screenReadiness.current?.settle(false);
      screenReadiness.current = null;
      heartbeat.dispose();
      screenRequest.current += 1;
      screenReadAbort.current?.abort();
      document.removeEventListener("visibilitychange", attendVisibleComputer);
      window.removeEventListener("online", attendVisibleComputer);
    };
  }, [
    watchingComputer,
    computerBot?.id,
    active?.id,
    userId,
    settingsOwner,
    settingsCurrentSpaceId,
    computerSelection,
  ]);

  /** Opening only watches; an explicit Take control requests the control lease. */
  async function openComputer(botId?: string, takeControl = false) {
    const id = botId ?? active?.id;
    if (!id) return false;
    const bot = botsRef.current.find((candidate) => candidate.id === id);
    if (!bot) return false;
    if (computerBotIdRef.current !== id) invalidateComputerBoot();
    computerBotIdRef.current = id;
    setComputerBotId(id);
    const cached = computerCacheRef.current.get(id);
    const targetComputer = computer?.botId === id ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === id ? screenUrl : (cached?.screenUrl ?? null);
    if (computer?.botId !== id) {
      commitComputer(targetComputer);
      setScreenUrl(targetScreen);
    }
    setComputerOpen(true);
    computerVisible.current = true;
    const needsTakeover = takeControl && !userHoldsComputerControl(targetComputer, id);
    const blocked = computerTakeoverBlocked(targetComputer, snapshot?.run?.status);
    try {
      await bootComputer({
        botId: id,
        takeControl: needsTakeover && !blocked,
        overlay: (needsTakeover && !blocked) || targetComputer?.state !== "running",
        force: targetComputer?.state !== "running",
      });
      return true;
    } catch {
      // computerError already set in bootComputer
      return false;
    }
  }
  async function takeComputerControl(botId: string) {
    if (computerControlPending.current) return false;
    computerControlPending.current = true;
    setTakingComputerControl(true);
    try {
      return await openComputer(botId, true);
    } finally {
      computerControlPending.current = false;
      setTakingComputerControl(false);
    }
  }
  openComputerRef.current = openComputer;
  const onOpenComputer = useCallback((botId?: string) => {
    void openComputerRef.current(botId);
  }, []);

  const releaseComputer = useCallback(
    async (reason?: ComputerReleaseReason) => {
      const botId = computerBotIdRef.current ?? activeBotId.current;
      if (!botId) return;
      setComputerError(null);
      setComputerErrorFromScreen(false);
      try {
        await rpc.computer.release({ botId, reason });
        if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
        await refreshComputerFor(botId);
        await refreshComputerScreen(botId);
        const groupId = activeGroupId.current;
        if (groupId) {
          await refreshGroupThreadRef.current(groupId).catch(() => undefined);
        }
      } catch {
        if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
        setComputerError(t`Could not continue`);
        setComputerErrorFromScreen(false);
      }
    },
    [t],
  );

  function dismissComposerError() {
    // The strip shows one message at a time, so only dismiss the run failure when it is the
    // one on screen; otherwise a live run would be silenced before it has even failed.
    const failedRunId = displayedRunErrorId;
    setSendError(null);
    if (failedRunId) {
      rememberSeenRunErrorId(failedRunId);
      setDismissedRunErrorIds((current) => new Set(current).add(failedRunId));
    }
  }

  const screenPresented =
    document.visibilityState === "visible" &&
    visibleComputerScreen?.botId === computerBot?.id &&
    visibleComputerScreen?.ownerKey === settingsOwnerKey &&
    visibleComputerScreen?.spaceId === (selectedSpaceId() ?? bootstrapMe?.spaceId ?? null) &&
    visibleComputerScreen?.selection === currentSpaceSelectionGeneration();
  const embeddedScreenUrl = embeddableScreenUrl(screenUrl);
  const hasControl = userHoldsComputerControl(computer, computerBot?.id);
  const hideScreenLoadError = computerErrorFromScreen && Boolean(embeddedScreenUrl);
  const computerScreenError =
    computerError && !hideScreenLoadError ? (
      <div role="alert" className="flex flex-col items-center gap-3 px-6 text-center text-sm">
        <p className="text-destructive">{computerError}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => computerBot && void refreshComputerScreen(computerBot.id)}
        >
          <Trans>Retry screen</Trans>
        </Button>
      </div>
    ) : null;
  const computerPreviewScreen =
    !computerOpen &&
    computer?.kind !== "desktop" &&
    computer?.state === "running" &&
    Boolean(embeddedScreenUrl) &&
    !computerScreenError;
  const showingRecoveryHint =
    !computerOpen &&
    computer?.kind !== "desktop" &&
    !computerPreviewScreen &&
    !computerScreenError &&
    showComputerRecoveryHint;

  const userName = session.data?.user.name ?? t`You`;
  const panelVisible = Boolean(panel && (active || activeGroup || panel === "create"));
  const { layout, resizePanel, isDesktop } = useDesktopWorkspaceLayout({
    sidebarCollapsed: botsSidebarCollapsed,
    panelOpen: panelVisible,
  });
  const compactSidebar = isDesktop && layout.sidebarCollapsed;
  const currentSpace = spaces.find((space) => space.id === bootstrapMe?.spaceId);
  const currentSpaceName = currentSpace?.name ?? t`My space`;
  const currentThreadConnection =
    threadConnection?.target === (inGroup ? `group:${groupId}` : `bot:${active?.id}`)
      ? threadConnection
      : null;
  const expandSidebar = () => {
    if (
      compactSidebar &&
      panelVisible &&
      calculateDesktopWorkspaceLayout({
        viewportWidth: window.innerWidth,
        sidebarCollapsed: false,
        panelOpen: true,
      }).sidebarCollapsed
    )
      setPanel(null);
    setBotsSidebarCollapsedPref(false);
  };

  const shell = (
    <div
      data-testid="shell-root"
      data-ready={shellReady}
      className="relative flex h-full min-w-0 overflow-hidden bg-background text-foreground/90"
      onTouchStartCapture={(event) => {
        if (
          mobileSidebarOpen ||
          event.touches.length !== 1 ||
          window.matchMedia("(min-width: 768px)").matches
        ) {
          mobileSidebarSwipeRef.current = null;
          return;
        }
        const touch = event.touches[0];
        if (!touch) return;
        const rtl = document.documentElement.getAttribute("dir") === "rtl";
        const startsAtEdge = rtl
          ? touch.clientX >= window.innerWidth - MOBILE_SIDEBAR_SWIPE_EDGE_PX
          : touch.clientX <= MOBILE_SIDEBAR_SWIPE_EDGE_PX;
        mobileSidebarSwipeRef.current = startsAtEdge
          ? { startX: touch.clientX, startY: touch.clientY }
          : null;
      }}
      onTouchEndCapture={(event) => {
        const swipe = mobileSidebarSwipeRef.current;
        mobileSidebarSwipeRef.current = null;
        const touch = event.changedTouches[0];
        if (
          !swipe ||
          !touch ||
          mobileSidebarOpen ||
          window.matchMedia("(min-width: 768px)").matches
        ) {
          return;
        }
        const rtl = document.documentElement.getAttribute("dir") === "rtl";
        const horizontal = rtl ? swipe.startX - touch.clientX : touch.clientX - swipe.startX;
        const vertical = Math.abs(touch.clientY - swipe.startY);
        if (horizontal >= MOBILE_SIDEBAR_SWIPE_DISTANCE_PX && horizontal > vertical * 1.25) {
          setMobileSidebarOpen(true);
        }
      }}
      onTouchCancelCapture={() => {
        mobileSidebarSwipeRef.current = null;
      }}
    >
      <ComputerUpdateProgress
        onCompleted={() => {
          if (active) void refreshThread(active.id);
        }}
      />
      {bootstrapMe !== undefined ? (
        <HostComputerPrompt initialMe={bootstrapMe ?? undefined} onMeUpdated={setBootstrapMe} />
      ) : null}
      {mobileSidebarOpen ? (
        <button
          type="button"
          aria-label={t`Close navigation`}
          onClick={() => setMobileSidebarOpen(false)}
          className="absolute inset-y-0 end-0 start-[min(calc(100%-48px),316px)] z-30 bg-overlay md:hidden"
        />
      ) : null}
      <aside
        data-testid="bots-sidebar"
        data-collapsed={compactSidebar ? "true" : "false"}
        data-sidebar-compact={compactSidebar ? "true" : "false"}
        className={`absolute inset-y-0 start-0 z-40 flex w-[calc(100%-48px)] max-w-[316px] shrink-0 flex-col border-e border-sidebar-border bg-sidebar transition-[transform,width] md:static md:z-auto md:translate-x-0 md:max-w-none ${
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full"
        } ${compactSidebar ? "md:w-[88px]" : "md:w-[280px]"}`}
      >
        {desktopBridge() ? (
          <div className="app-drag flex h-9 shrink-0 items-center px-2">
            <WindowChrome />
          </div>
        ) : null}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
          data-testid="sidebar-announcement"
        >
          {sidebarAnnouncements.text}
        </div>
        <div
          className={`app-drag flex h-16 shrink-0 items-center ${compactSidebar ? "justify-center px-2" : "justify-between px-5"}`}
        >
          {!compactSidebar ? (
            <CogineBotWordmark className="h-auto max-h-6 w-32 text-foreground" />
          ) : null}
          <button
            type="button"
            className="app-no-drag hidden size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground md:inline-flex"
            aria-label={compactSidebar ? t`Show bots` : t`Minimize bots`}
            title={compactSidebar ? t`Show bots` : t`Minimize bots`}
            data-testid={compactSidebar ? "restore-bots-sidebar" : "minimize-bots-sidebar"}
            onClick={() => {
              if (compactSidebar) expandSidebar();
              else setBotsSidebarCollapsedPref(true);
            }}
          >
            {compactSidebar ? (
              <PanelLeftOpen size={16} strokeWidth={1.7} />
            ) : (
              <PanelLeftClose size={16} strokeWidth={1.7} />
            )}
          </button>
        </div>
        <div className={compactSidebar ? "px-5 pb-2" : "px-3 pb-2"}>
          <Popover open={spacePickerOpen} onOpenChange={setSpacePickerOpen}>
            <PopoverTrigger
              data-testid="space-menu-trigger"
              aria-label={t`Switch space`}
              title={currentSpaceName}
              className={`flex w-full items-center rounded-lg text-[12px] text-foreground hover:bg-sidebar-accent ${compactSidebar ? "h-9 justify-center" : "gap-3 px-2 py-2"}`}
              onContextMenu={(event) => {
                if (spaces.length !== 1 || !currentSpace) return;
                event.preventDefault();
                setSpacePickerOpen(false);
                spaceMenuAnchor.current = event.currentTarget;
                setSpaceMenu({
                  id: currentSpace.id,
                  position: { x: event.clientX, y: event.clientY },
                });
              }}
              onKeyDown={(event) => {
                if (
                  spaces.length !== 1 ||
                  !currentSpace ||
                  !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
                )
                  return;
                event.preventDefault();
                setSpacePickerOpen(false);
                const rect = event.currentTarget.getBoundingClientRect();
                spaceMenuAnchor.current = event.currentTarget;
                setSpaceMenu({
                  id: currentSpace.id,
                  position: { x: rect.left, y: rect.bottom },
                });
              }}
            >
              <Layers size={17} strokeWidth={1.6} className="shrink-0 text-muted-foreground" />
              {!compactSidebar ? (
                <>
                  <span
                    data-testid="sidebar-current-space"
                    className="min-w-0 flex-1 truncate text-start"
                  >
                    {currentSpaceName}
                  </span>
                  <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
                </>
              ) : null}
            </PopoverTrigger>
            {spacePickerOpen ? (
              <PopoverContent
                side="bottom"
                align="start"
                className="w-60 max-w-[calc(100vw-2rem)] gap-0 rounded-xl p-1.5 text-[12px] data-closed:animate-none"
              >
                {spaces.map((space) => (
                  <Button
                    key={space.id}
                    variant="ghost"
                    className="h-9 w-full justify-start gap-2 font-normal text-[12px]"
                    onClick={() => {
                      setSpacePickerOpen(false);
                      const firstBot = space.bots[0];
                      const firstGroup = space.groups[0];
                      openSpaceChat(
                        space.id,
                        firstBot
                          ? `/app/${firstBot.id}`
                          : firstGroup
                            ? `/app/g/${firstGroup.id}`
                            : "/onboarding",
                      );
                    }}
                  >
                    <Layers size={15} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-start">{space.name}</span>
                    {space.id === bootstrapMe?.spaceId ? (
                      <Check size={14} className="shrink-0 text-muted-foreground" />
                    ) : null}
                  </Button>
                ))}
                <div className="my-1 border-t border-border" />
                <Button
                  data-testid="create-new-space"
                  variant="ghost"
                  className="h-9 w-full justify-start gap-2 text-[12px] font-normal"
                  onClick={() => {
                    setSpacePickerOpen(false);
                    setNewSpaceOpen(true);
                  }}
                >
                  <Plus size={15} className="text-muted-foreground" />
                  <Trans>Create space</Trans>
                </Button>
                {currentSpace?.canRename ? (
                  <Button
                    variant="ghost"
                    className="h-9 w-full justify-start gap-2 text-[12px] font-normal"
                    onClick={() => {
                      setSpacePickerOpen(false);
                      setRenameSpaceTarget(currentSpace);
                    }}
                  >
                    <Pencil size={15} className="text-muted-foreground" />
                    <Trans>Rename</Trans>
                  </Button>
                ) : null}
                {currentSpace?.canDelete ? (
                  <Button
                    variant="ghost"
                    className="h-9 w-full justify-start gap-2 text-[12px] font-normal text-destructive"
                    onClick={() => {
                      setSpacePickerOpen(false);
                      setDeleteSpaceTarget(currentSpace);
                    }}
                  >
                    <Trash2 size={15} />
                    <Trans>Delete</Trans>
                  </Button>
                ) : null}
              </PopoverContent>
            ) : null}
          </Popover>
        </div>
        <div
          className={`flex shrink-0 gap-1 pb-3 ${compactSidebar ? "flex-col items-center px-3" : "items-center px-3"}`}
        >
          {compactSidebar ? (
            <button
              type="button"
              aria-label={t`Search`}
              data-testid="sidebar-search"
              title={t`Search`}
              onClick={() => {
                expandSidebar();
                requestAnimationFrame(() => sidebarSearchRef.current?.focus());
              }}
              className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent"
            >
              <Search size={17} strokeWidth={1.6} />
            </button>
          ) : (
            <InputGroup
              data-testid="sidebar-search"
              className="h-8 min-w-0 flex-1 rounded-lg border-border bg-transparent text-muted-foreground focus-within:border-ring"
            >
              <InputGroupAddon>
                <Search size={14} strokeWidth={1.7} />
              </InputGroupAddon>
              <InputGroupInput
                ref={sidebarSearchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t`Search`}
                autoComplete="off"
                name="sidebar-search"
                className="text-[12px]"
              />
              <InputGroupAddon align="inline-end">
                <span className="text-[10px] text-muted-foreground">
                  {navigator.platform.includes("Mac") ? "⌘ K" : "Ctrl K"}
                </span>
              </InputGroupAddon>
            </InputGroup>
          )}
          <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
            <PopoverTrigger
              className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              title={t`Create`}
              aria-label={t`Create`}
              data-testid="create-menu-trigger"
              disabled={!bootstrapMe}
            >
              <Plus size={19} strokeWidth={1.6} />
            </PopoverTrigger>
            {createMenuOpen ? (
              <PopoverContent
                data-testid="create-menu"
                align="end"
                className="w-48 gap-0 rounded-xl p-1.5 text-[12px] data-closed:animate-none"
              >
                <Button
                  variant="ghost"
                  data-testid="create-new-bot"
                  className="h-9 w-full justify-start gap-2 text-[12px] font-normal"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    setMobileSidebarOpen(false);
                    setPanel("create");
                  }}
                >
                  <Plus size={16} className="text-muted-foreground" />
                  <Trans>Create Bot</Trans>
                </Button>
                <Button
                  variant="ghost"
                  data-testid="create-new-group"
                  className="h-9 w-full justify-start gap-2 text-[12px] font-normal"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    setMobileSidebarOpen(false);
                    openNewChat();
                  }}
                >
                  <LayoutGrid size={16} className="text-muted-foreground" />
                  <Trans>Create group chat</Trans>
                </Button>
              </PopoverContent>
            ) : null}
          </Popover>
        </div>
        {botOrderStatus ? (
          <div
            role="status"
            data-testid="roster-order-status"
            className="px-3 pb-2 text-[11px] text-muted-foreground"
          >
            {botOrderStatus === "saving" ? t`Saving…` : t`Order not confirmed`}
          </div>
        ) : null}
        <div
          className={`rk-scroll flex flex-1 flex-col gap-0.5 overflow-y-auto pb-2.5 ${compactSidebar ? "px-3" : "px-2.5"}`}
        >
          {showSpaceSearch && !compactSidebar ? (
            <SpaceSearchResults
              hits={searchHits}
              loading={searchLoading}
              onSelect={(hit) => void jumpToSearchHit(hit)}
            />
          ) : (
            <>
              {activityMode && !compactSidebar ? (
                <ActivityList
                  onOpenRun={(run) => {
                    setMobileSidebarOpen(false);
                    if (run.groupId) navigate(`/app/g/${run.groupId}`);
                    else navigate(`/app/${run.botId}`);
                  }}
                />
              ) : null}
              {sidebarGroups.map((group, groupIndex) => {
                const pinnedSection = group.kind === "pinned";
                const firstInSpace =
                  groupIndex === 0 || sidebarGroups[groupIndex - 1]?.spaceId !== group.spaceId;
                const displayTitle =
                  group.kind === "unassigned" && group.baseTitle
                    ? t`Unassigned`
                    : pinnedSection
                      ? null
                      : group.baseTitle;
                const collapsible = !pinnedSection && Boolean(group.baseTitle);
                const collapsed =
                  !compactSidebar && collapsible && collapsedSidebarSections.has(group.collapseKey);
                const previousGroup = sidebarGroups[groupIndex - 1];
                const followsPinned =
                  previousGroup?.spaceId === group.spaceId &&
                  (previousGroup.key === "pinned" || previousGroup.key.endsWith(":pinned"));
                const groupBotIds = group.bots.flatMap((item) =>
                  item.kind === "bot" ? [item.chat.id] : [],
                );
                const nestedRows = nestRosterByParent(
                  group.bots,
                  compactSidebar ? new Set<string>() : collapsedRosterParents,
                );
                const treeActive = nestedRows.some((row) => row.depth > 0 || row.hasChildren);
                const rosterParent = new Map(
                  nestedRows.map((row) => [row.item.chat.id, row.parentId] as const),
                );
                // Reorder among visible siblings so keyboard and drag moves match the tree.
                const siblingBotIds = (parentId: string | null) =>
                  nestedRows.flatMap((row) =>
                    row.item.kind === "bot" && row.parentId === parentId ? [row.item.chat.id] : [],
                  );
                const hasSpaceActions = group.canOpenSpaceSettings;
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: Move and reorder menus provide keyboard alternatives to this drop target.
                  <div
                    key={group.key}
                    data-sidebar-group={group.key}
                    onDragOver={(event) => {
                      if (
                        (draggedSection &&
                          group.sectionId &&
                          draggedSection.spaceId === group.spaceId) ||
                        (draggedChat &&
                          draggedChat.chat.spaceId === group.spaceId &&
                          group.kind !== "pinned")
                      ) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        sidebarAnnouncements.target(displayTitle ?? t`Unassigned`);
                      }
                    }}
                    onDrop={(event) => {
                      if (
                        draggedSection &&
                        group.sectionId &&
                        draggedSection.spaceId === group.spaceId
                      ) {
                        event.preventDefault();
                        const settle = sidebarAnnouncements.accept();
                        void reorderSection(draggedSection.id, group.sectionId, group.spaceId).then(
                          (moved) => settle(moved ? true : "cancelled"),
                          (error) => {
                            settle(false);
                            reportSidebarError(error);
                          },
                        );
                      } else if (
                        draggedChat &&
                        draggedChat.chat.spaceId === group.spaceId &&
                        group.kind !== "pinned"
                      ) {
                        event.preventDefault();
                        const settle = sidebarAnnouncements.accept();
                        void moveChatToSection(draggedChat, group.sectionId).then(
                          (moved) => settle(moved ? true : "cancelled"),
                          (error) => {
                            settle(false);
                            reportSidebarError(error);
                          },
                        );
                      }
                      setDraggedChat(null);
                      setDraggedSection(null);
                      setDraggedBotId(null);
                    }}
                  >
                    {followsPinned ? (
                      <div
                        data-sidebar-pinned-separator
                        className={`my-3 border-t border-sidebar-border ${compactSidebar ? "mx-3" : "mx-2"}`}
                      />
                    ) : null}
                    {!compactSidebar && spaces.length > 1 && firstInSpace ? (
                      <div className="pt-3 pb-0.5">
                        <SidebarSectionHeader
                          title={group.spaceName}
                          count={0}
                          collapsed={false}
                          collapsible={false}
                          onToggle={() => {
                            if (group.emptySpaceId)
                              openSpaceChat(group.emptySpaceId, "/onboarding");
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            if (!hasSpaceActions) return;
                            spaceMenuAnchor.current = event.currentTarget;
                            setSpaceMenu({
                              id: group.spaceId,
                              position: { x: event.clientX, y: event.clientY },
                            });
                          }}
                          onKeyDown={(event) => {
                            if (
                              !hasSpaceActions ||
                              !(
                                event.key === "ContextMenu" ||
                                (event.shiftKey && event.key === "F10")
                              )
                            )
                              return;
                            event.preventDefault();
                            const rect = event.currentTarget.getBoundingClientRect();
                            spaceMenuAnchor.current = event.currentTarget;
                            setSpaceMenu({
                              id: group.spaceId,
                              position: { x: rect.left, y: rect.bottom },
                            });
                          }}
                        />
                      </div>
                    ) : null}
                    {!compactSidebar && displayTitle ? (
                      <div className="pt-3 pb-0.5">
                        {renameSectionTarget?.section.id === group.sectionId &&
                        renameSectionTarget.spaceId === group.spaceId ? (
                          <InlineSectionName
                            key={`${group.spaceId}:${group.sectionId}`}
                            defaultValue={renameSectionTarget.section.name}
                            existingNames={sectionsForSpace(group.spaceId)
                              .filter((section) => section.id !== group.sectionId)
                              .map((section) => section.name)}
                            onCancel={() => setRenameSectionTarget(null)}
                            onConfirm={async (name) => {
                              const target = renameSectionTarget;
                              await renameSection(target.section, group.spaceId, name);
                              setRenameSectionTarget((current) =>
                                current === target ? null : current,
                              );
                            }}
                          />
                        ) : (
                          <SidebarSectionHeader
                            {...sectionContextPress}
                            data-section-id={group.sectionId ?? undefined}
                            data-section-space-id={group.spaceId}
                            title={displayTitle}
                            count={group.bots.length}
                            collapsed={collapsed}
                            collapsible={collapsible}
                            aria-expanded={collapsible ? !collapsed : undefined}
                            aria-label={
                              collapsible
                                ? collapsed
                                  ? t`Expand ${displayTitle}, ${group.bots.length}`
                                  : t`Collapse ${displayTitle}`
                                : displayTitle
                            }
                            aria-controls={`sidebar-members-${group.collapseKey}`}
                            draggable={Boolean(group.sectionId)}
                            onDragStart={(event) => {
                              if (!group.sectionId) return;
                              event.stopPropagation();
                              sidebarAnnouncements.start(displayTitle);
                              setDraggedSection({ id: group.sectionId, spaceId: group.spaceId });
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData(
                                "application/x-coginebot-section",
                                group.sectionId,
                              );
                            }}
                            onDragEnd={() => {
                              sidebarAnnouncements.end();
                              setDraggedSection(null);
                            }}
                            onToggle={() => {
                              if (collapsible) toggleSidebarSection(group.collapseKey);
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              if (group.sectionId)
                                openSectionMenu(
                                  group.sectionId,
                                  group.spaceId,
                                  event.currentTarget,
                                  { x: event.clientX, y: event.clientY },
                                );
                              else if (group.kind !== "unassigned" && hasSpaceActions) {
                                spaceMenuAnchor.current = event.currentTarget;
                                setSpaceMenu({
                                  id: group.spaceId,
                                  position: { x: event.clientX, y: event.clientY },
                                });
                              }
                            }}
                            onKeyDown={(event) => {
                              if (
                                event.key === "ContextMenu" ||
                                (event.shiftKey && event.key === "F10")
                              ) {
                                event.preventDefault();
                                if (!group.sectionId) return;
                                const rect = event.currentTarget.getBoundingClientRect();
                                openSectionMenu(
                                  group.sectionId,
                                  group.spaceId,
                                  event.currentTarget,
                                  { x: rect.left, y: rect.bottom },
                                );
                              } else if (event.key === "F2" && group.sectionId) {
                                event.preventDefault();
                                const section = sectionsForSpace(group.spaceId).find(
                                  (section) => section.id === group.sectionId,
                                );
                                if (section)
                                  setRenameSectionTarget({ section, spaceId: group.spaceId });
                              }
                            }}
                          />
                        )}
                      </div>
                    ) : null}
                    <div id={`sidebar-members-${group.collapseKey}`} hidden={collapsed}>
                      {!collapsed &&
                        nestedRows.map(({ item, depth, hasChildren, parentId }) => {
                          const parentCollapsed =
                            hasChildren && collapsedRosterParents.has(item.chat.id);
                          const selected =
                            (item.kind === "bot" && !inGroup && active?.id === item.chat.id) ||
                            (item.kind === "group" && inGroup && activeGroup?.id === item.chat.id);
                          const rosterLine = item.chat.preview ?? "";
                          return (
                            <div
                              key={`${item.kind}:${item.chat.id}`}
                              className="group/row relative"
                              style={{
                                opacity:
                                  item.kind === "bot" && draggedBotId === item.chat.id ? 0.55 : 1,
                              }}
                            >
                              {hasChildren && !compactSidebar ? (
                                <span
                                  className="absolute inset-y-0 z-10 flex w-3.5 items-center justify-center"
                                  style={{ insetInlineStart: `${10 + depth * 14}px` }}
                                >
                                  <button
                                    type="button"
                                    aria-expanded={!parentCollapsed}
                                    aria-label={
                                      parentCollapsed
                                        ? t`Expand ${item.chat.name}`
                                        : t`Collapse ${item.chat.name}`
                                    }
                                    className="inline-flex size-3.5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                                    onClick={() => toggleRosterParent(item.chat.id)}
                                  >
                                    <ChevronDown
                                      size={12}
                                      strokeWidth={2}
                                      className={`transition-transform ${
                                        parentCollapsed ? "-rotate-90" : ""
                                      }`}
                                      aria-hidden="true"
                                    />
                                  </button>
                                </span>
                              ) : null}
                              <ConversationRow
                                {...rowContextPress}
                                data-roster-space-id={group.spaceId}
                                draggable
                                data-roster-bot-id={item.kind === "bot" ? item.chat.id : undefined}
                                data-roster-group-id={
                                  item.kind === "group" ? item.chat.id : undefined
                                }
                                data-roster-depth={
                                  item.kind === "bot" && treeActive ? depth : undefined
                                }
                                aria-keyshortcuts={
                                  item.kind === "bot" ? "Alt+ArrowUp Alt+ArrowDown" : undefined
                                }
                                onDragStart={(event) => {
                                  sidebarAnnouncements.start(item.chat.name);
                                  setDraggedChat(item);
                                  if (item.kind === "bot") setDraggedBotId(item.chat.id);
                                  event.dataTransfer.effectAllowed = "move";
                                  event.dataTransfer.setData("text/plain", item.chat.id);
                                }}
                                onDragOver={(event) => {
                                  if (
                                    item.kind === "bot" &&
                                    draggedBotId &&
                                    groupBotIds.includes(draggedBotId) &&
                                    rosterParent.get(draggedBotId) === parentId
                                  ) {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    event.dataTransfer.dropEffect = "move";
                                    sidebarAnnouncements.target(item.chat.name);
                                  }
                                }}
                                onDrop={(event) => {
                                  if (
                                    item.kind !== "bot" ||
                                    !draggedBotId ||
                                    rosterParent.get(draggedBotId) !== parentId
                                  )
                                    return;
                                  event.preventDefault();
                                  event.stopPropagation();
                                  reorderRosterBot(draggedBotId, item.chat.id, groupBotIds);
                                  setDraggedBotId(null);
                                  setDraggedChat(null);
                                }}
                                onDragEnd={() => {
                                  sidebarAnnouncements.end();
                                  setDraggedBotId(null);
                                  setDraggedChat(null);
                                }}
                                onKeyDown={(event) => {
                                  if (
                                    event.key === "ContextMenu" ||
                                    (event.shiftKey && event.key === "F10")
                                  ) {
                                    if (item.chat.spaceId !== bootstrapMe?.spaceId) return;
                                    event.preventDefault();
                                    botMenuAnchor.current = event.currentTarget;
                                    const rect = event.currentTarget.getBoundingClientRect();
                                    setBotMenu({
                                      kind: item.kind,
                                      id: item.chat.id,
                                      position: { x: rect.left, y: rect.bottom },
                                    });
                                    return;
                                  }
                                  if (
                                    item.kind !== "bot" ||
                                    !event.altKey ||
                                    (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                                  )
                                    return;
                                  const siblings = siblingBotIds(parentId);
                                  const index = siblings.indexOf(item.chat.id);
                                  const target =
                                    siblings[index + (event.key === "ArrowUp" ? -1 : 1)];
                                  if (!target) return;
                                  event.preventDefault();
                                  reorderRosterBot(item.chat.id, target, groupBotIds);
                                }}
                                onClick={() => {
                                  const target =
                                    item.kind === "bot"
                                      ? { botId: item.chat.id }
                                      : { groupId: item.chat.id };
                                  const path =
                                    item.kind === "bot"
                                      ? `/app/${item.chat.id}`
                                      : `/app/g/${item.chat.id}`;
                                  const messageId = item.chat.attentionMessageId;
                                  if (item.chat.spaceId === bootstrapMe?.spaceId) {
                                    setPeerConversation(null);
                                    manuallyUnread.current.delete(item.chat.id);
                                    readVisibleGroups.current.delete(item.chat.id);
                                    if (selected) {
                                      void setConversationUnread(target, false).catch(
                                        () => undefined,
                                      );
                                      if (messageId)
                                        void jumpToMessage({
                                          ...target,
                                          messageId,
                                          attention: true,
                                        }).catch(() => undefined);
                                      else openSpaceChat(item.chat.spaceId, path);
                                      return;
                                    }
                                  }
                                  openSpaceChat(
                                    item.chat.spaceId,
                                    messageId
                                      ? `${path}?m=${encodeURIComponent(messageId)}&attention=1`
                                      : path,
                                  );
                                }}
                                onContextMenu={(event) => {
                                  if (item.chat.spaceId !== bootstrapMe?.spaceId) return;
                                  event.preventDefault();
                                  botMenuAnchor.current = event.currentTarget;
                                  setBotMenu({
                                    kind: item.kind,
                                    id: item.chat.id,
                                    position: { x: event.clientX, y: event.clientY },
                                  });
                                }}
                                name={item.chat.name}
                                preview={rosterLine}
                                bot={item.kind === "bot"}
                                compact={compactSidebar}
                                selected={selected}
                                unread={item.chat.unread}
                                approvalPending={Boolean(item.chat.attentionMessageId)}
                                className={
                                  item.kind === "bot"
                                    ? "cursor-grab active:cursor-grabbing"
                                    : undefined
                                }
                                style={
                                  treeActive && !compactSidebar
                                    ? { paddingInlineStart: `${24 + depth * 14}px` }
                                    : undefined
                                }
                                avatar={
                                  item.kind === "bot" ? (
                                    <BotAvatar
                                      color={item.chat.color}
                                      identity={item.chat.id}
                                      size={38}
                                      status={item.chat.status}
                                    />
                                  ) : (
                                    <GroupAvatar
                                      members={
                                        item.chat.id === activeSnapshot?.groupId
                                          ? (activeSnapshot.members ?? item.chat.members)
                                          : item.chat.members
                                      }
                                      size={38}
                                    />
                                  )
                                }
                              />
                            </div>
                          );
                        })}
                    </div>
                    {!compactSidebar &&
                    newSectionTarget?.chat.spaceId === group.spaceId &&
                    sidebarGroups[groupIndex + 1]?.spaceId !== group.spaceId
                      ? renderNewSectionName()
                      : null}
                  </div>
                );
              })}
            </>
          )}
          {sidebarError && !compactSidebar ? (
            <p role="alert" className="px-2 py-1 text-xs text-destructive">
              {sidebarError}
            </p>
          ) : null}
          {sidebarNotice && !compactSidebar ? (
            <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
              {sidebarNotice}
            </p>
          ) : null}
          {deletedSection && !compactSidebar ? (
            <div
              role="status"
              className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground"
            >
              <span>
                <Trans>Section deleted</Trans>
              </span>
              <button
                type="button"
                className="rounded px-1 py-1 text-foreground hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void restoreSection(deletedSection).catch(reportSidebarError)}
              >
                <Trans>Undo</Trans>
              </button>
            </div>
          ) : null}
          {archivedBots.length + archivedGroups.length > 0 &&
          !showSpaceSearch &&
          !compactSidebar ? (
            <div className="mt-2 border-t border-border pt-2">
              <button
                type="button"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((open) => !open)}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[13.5px] text-muted-foreground hover:bg-sidebar-accent"
              >
                <span>
                  <Trans>Archived</Trans>
                </span>
                <span>{archivedBots.length + archivedGroups.length}</span>
              </button>
              {archivedOpen ? (
                <>
                  {archivedBots.map((bot) => (
                    <div key={bot.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2">
                      <BotAvatar
                        color={bot.color}
                        identity={bot.id}
                        size={28}
                        status={bot.status}
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-[14px] text-foreground/75"
                        dir="auto"
                      >
                        {bot.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          void rpc.bots.restore({ botId: bot.id }).then(() => refreshBots(true))
                        }
                      >
                        <Trans>Restore</Trans>
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        aria-label={t`Delete ${bot.name}`}
                        onClick={() => setDeleteTarget(bot)}
                      >
                        <Trans>Delete</Trans>
                      </Button>
                    </div>
                  ))}
                  {archivedGroups.map((group) => (
                    <div key={group.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2">
                      <GroupAvatar members={group.members} size={28} />
                      <span
                        className="min-w-0 flex-1 truncate text-[14px] text-foreground/75"
                        dir="auto"
                      >
                        {group.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          void rpc.groups
                            .restore({ groupId: group.id })
                            .then(() => refreshBots(true))
                        }
                      >
                        <Trans>Restore</Trans>
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        aria-label={t`Delete ${group.name}`}
                        onClick={() => setDeleteGroupTarget(group)}
                      >
                        <Trans>Delete</Trans>
                      </Button>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <div
          className={`mx-2.5 flex shrink-0 border-t border-sidebar-border py-2 ${compactSidebar ? "flex-col-reverse items-center gap-1" : "items-center justify-between"}`}
        >
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger
              data-testid="user-menu-trigger"
              aria-label={userName}
              title={userName}
              className="grid size-10 shrink-0 place-items-center rounded-full hover:bg-sidebar-accent"
            >
              <AccountAvatar size={32} />
            </PopoverTrigger>
            {menuOpen ? (
              <PopoverContent
                side="top"
                align="start"
                className="w-56 max-w-[calc(100vw-2rem)] gap-0 rounded-xl p-1.5 text-[12px] data-closed:animate-none"
              >
                <span className="block truncate px-2.5 py-2 text-[12px] font-medium text-foreground">
                  {userName}
                </span>
                <div className="mb-1 border-t border-border" />
                {bootstrapMe?.ticketBoardEnabled ? (
                  <Button
                    variant="ghost"
                    className="h-9 w-full justify-start gap-2 text-[12px] font-normal"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate("/app/board");
                    }}
                  >
                    <SquareKanban size={16} className="text-muted-foreground" />
                    <Trans>Board</Trans>
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  className="h-9 w-full justify-start gap-2 text-[12px] font-normal"
                  onClick={() => {
                    setMenuOpen(false);
                    openSettings("general");
                  }}
                  aria-label={t`Settings`}
                >
                  <Settings size={16} className="text-muted-foreground" />
                  <Trans>Settings</Trans>
                </Button>
                <Button
                  variant="ghost"
                  className="h-9 w-full justify-start gap-2 text-[12px] font-normal"
                  onClick={() => {
                    setMenuOpen(false);
                    openSettings("usage");
                  }}
                  aria-label={t`Usage`}
                >
                  <Gauge size={16} className="text-muted-foreground" />
                  <Trans>Usage</Trans>
                </Button>
                <Button
                  variant="ghost"
                  className="h-9 w-full justify-start gap-2 text-[12px] font-normal"
                  onClick={() => {
                    setMenuOpen(false);
                    setPluginsOpen(true);
                  }}
                >
                  <LayoutGrid size={16} className="text-muted-foreground" />
                  <Trans>Integrations</Trans>
                </Button>
                <Button
                  variant="ghost"
                  className="h-9 w-full justify-start gap-2 text-[12px] font-normal"
                  aria-pressed={activityMode}
                  data-activity-mode={activityMode ? "on" : "off"}
                  onClick={() => {
                    if (!activityMode) {
                      expandSidebar();
                      setQuery("");
                    }
                    toggleActivityMode();
                    setMenuOpen(false);
                  }}
                >
                  <Bell
                    size={16}
                    className="text-muted-foreground"
                    fill={activityMode ? "currentColor" : "none"}
                  />
                  <Trans>Activity</Trans>
                  {activityMode ? (
                    <Check size={14} className="ms-auto text-muted-foreground" />
                  ) : null}
                </Button>
                {archivedBots.length + archivedGroups.length > 0 ? (
                  <Button
                    variant="ghost"
                    className="h-9 w-full justify-start gap-2 text-[12px] font-normal"
                    onClick={() => {
                      setMenuOpen(false);
                      expandSidebar();
                      setQuery("");
                      setArchivedOpen(true);
                    }}
                  >
                    <Box size={16} className="text-muted-foreground" />
                    <Trans>Archived</Trans>
                  </Button>
                ) : null}
                <div className="my-1 border-t border-border" />
                <Button
                  variant="ghost"
                  className="h-9 w-full justify-start gap-2 text-[12px] font-normal"
                  onClick={() => {
                    discardRejectedComposerDraft();
                    clearComposerDrafts();
                    composerSendAttempts.clear();
                    void authClient.signOut().then(() => {
                      clearSpaceSelection();
                      navigate("/");
                    });
                  }}
                >
                  <LogOut size={16} className="text-muted-foreground" />
                  <Trans>Log out</Trans>
                </Button>
              </PopoverContent>
            ) : null}
          </Popover>
          <button
            type="button"
            data-testid="sidebar-files-trigger"
            aria-label={t`Files`}
            title={t`Files`}
            onClick={() => {
              setMobileSidebarOpen(false);
              navigate("/app/artifacts");
            }}
            className={`flex h-10 shrink-0 items-center justify-center rounded-lg text-[12px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground ${compactSidebar ? "w-10" : "gap-2 px-3"}`}
          >
            <Copy size={16} strokeWidth={1.6} />
            {!compactSidebar ? <Trans>Files</Trans> : null}
          </button>
        </div>
      </aside>

      {/* Keep the composer's z-index inside the chat so phone overlays like the side panel cover it. */}
      <main
        aria-hidden={mobileSidebarOpen || undefined}
        inert={mobileSidebarOpen}
        className="@container/conversation relative isolate flex min-w-0 flex-1 flex-col bg-background"
      >
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
          data-testid="reply-announcement"
        >
          {replyAnnouncement}
        </div>
        {/* Inside main so the composer and its menus stay above it. */}
        {!mobileSidebarOpen ? (
          <div
            data-testid="mobile-sidebar-swipe-edge"
            aria-hidden="true"
            className="absolute bottom-20 start-0 top-16 z-20 w-8 touch-none md:hidden"
          />
        ) : null}
        <div
          aria-hidden={Boolean(peerConversation) || undefined}
          inert={Boolean(peerConversation)}
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            peerConversation && "pointer-events-none invisible absolute inset-0",
          )}
        >
          <div className="app-drag flex items-center justify-between gap-3 border-b border-sidebar-border px-3 py-[17px] md:px-[22px]">
            {inNewChat ? (
              <>
                <ChatRecipients
                  bots={bots}
                  selectedBotIds={pendingChat.botIds}
                  disabled={!bootstrapMe || sending || Boolean(pendingChat.groupId)}
                  onSelectedBotIdsChange={(botIds) => {
                    setPendingChat((current) => ({
                      ...current,
                      botIds,
                      creation: null,
                      creationNonce: newClientNonce(),
                    }));
                    setSendError(null);
                  }}
                />
                <button
                  type="button"
                  data-testid="chat-close"
                  title={t`Close chat`}
                  aria-label={t`Close chat`}
                  onClick={closeNewChat}
                  className="app-no-drag grid size-8 shrink-0 self-start place-items-center rounded-lg text-muted-foreground hover:bg-accent"
                >
                  <X size={17} />
                </button>
              </>
            ) : (
              <>
                <div className="flex min-w-0 items-center gap-2">
                  <div className="app-no-drag flex min-w-0 items-center gap-3">
                    <button
                      type="button"
                      aria-label={t`Open navigation`}
                      onClick={() => setMobileSidebarOpen(true)}
                      className="app-no-drag grid h-8 w-8 shrink-0 place-items-center rounded-lg text-foreground/75 hover:bg-accent md:hidden"
                    >
                      <Menu size={19} strokeWidth={1.7} />
                    </button>
                    <button
                      type="button"
                      data-testid="bot-settings-trigger"
                      onClick={() => setPanel(inGroup ? "group-settings" : "settings")}
                      className="app-no-drag flex min-w-0 items-center gap-3"
                    >
                      {inGroup ? (
                        <GroupAvatar
                          members={activeSnapshot?.members ?? activeGroup?.members ?? []}
                          size={26}
                        />
                      ) : active ? (
                        <BotAvatar
                          color={active.color}
                          identity={active.id}
                          size={26}
                          status={active.status}
                        />
                      ) : null}
                      {!inGroup ? (
                        <span className="min-w-0">
                          <span
                            className="block truncate text-[16px] font-medium text-foreground"
                            dir="auto"
                          >
                            {inGroup
                              ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
                              : (active?.name ?? t`Select a bot`)}
                          </span>
                        </span>
                      ) : null}
                    </button>
                    {inGroup ? (
                      <GroupTitle
                        key={activeGroup?.id ?? groupId}
                        className="text-[16px]"
                        name={activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`}
                        onRename={async (name) => {
                          const actor = groupSettingsActor.current;
                          const updated = await rpc.groups.update({ groupId: groupId!, name });
                          if (!updated?.id || updated.id !== groupId)
                            throw new Error(t`Could not save group`);
                          applySavedGroupUpdate(updated, actor);
                        }}
                      />
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {!inGroup && active ? (
                    <button
                      type="button"
                      title={t`Agent computer`}
                      onClick={() => {
                        const next = panel === "computer" ? null : "computer";
                        setPanel(next);
                        if (next === "computer" && active) {
                          // Refresh run/computer so Take control isn't stuck on a stale busyBotName.
                          void refreshThread(active.id).catch(() => undefined);
                        }
                      }}
                      data-active={panel === "computer" ? "" : undefined}
                      className="app-no-drag grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-accent data-active:bg-accent"
                    >
                      <Monitor size={18} strokeWidth={1.6} className="text-foreground/75" />
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </div>
          {bootstrapLoad.error ? (
            <LoadFailureNotice
              error={bootstrapLoad.error}
              cached={Boolean(bootstrapMe)}
              pending={bootstrapLoad.pending}
              onRetry={() => retryBootstrap.current()}
              onRecoverSpace={() => {
                clearSpaceSelection();
                retryBootstrap.current();
              }}
              onSignIn={() => {
                const owner = settingsOwner;
                const sessionId = session.data?.session.id;
                const targetId = groupId ?? botId;
                if (userId && sessionId && targetId)
                  prepareRejectedComposerDraft(
                    {
                      apiOrigin: window.location.origin,
                      userId,
                      sessionId,
                      selectionId: selectedSpaceId(),
                      selectionGeneration: currentSpaceSelectionGeneration(),
                      targetKind: groupId ? "group" : "bot",
                      targetId,
                    },
                    previewMessageText,
                  );
                setBootstrapLoad((value) => ({ ...value, pending: true }));
                // The ordinary session wipe still runs; only verified editable content is held in RAM.
                void authClient
                  .signOut()
                  .then((result) => {
                    if (committedSettingsOwner.current !== owner) return;
                    if (result?.error) {
                      cancelPreparedRejectedComposerDraft();
                      setBootstrapLoad((value) => ({ ...value, pending: false }));
                      return;
                    }
                    navigate("/sign-in", { replace: true });
                  })
                  .catch(() => {
                    if (committedSettingsOwner.current === owner) {
                      cancelPreparedRejectedComposerDraft();
                      setBootstrapLoad((value) => ({ ...value, pending: false }));
                    }
                  });
              }}
            />
          ) : !bootstrapMe ? (
            <div
              role="status"
              data-testid="bootstrap-status"
              className="flex items-center justify-center gap-3 px-4 py-2 text-[12px] text-muted-foreground"
            >
              <span>
                {bootstrapLoad.error && !isRecoverableReadError(bootstrapLoad.error)
                  ? errorText(bootstrapLoad.error, t`Could not load this chat.`)
                  : t`Waiting for connection`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={bootstrapLoad.pending}
                onClick={() => retryBootstrap.current()}
              >
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : !inNewChat &&
            currentThreadConnection &&
            currentThreadConnection.status !== "ready" ? (
            <div
              role="status"
              data-testid="connection-status"
              className="flex items-center justify-center gap-3 px-4 py-2 text-[12px] text-muted-foreground"
            >
              <span>
                {currentThreadConnection.error ??
                  (activeSnapshot ? t`Reconnecting` : t`Waiting for connection`)}
              </span>
              <Button variant="ghost" size="sm" onClick={retryCurrentThread}>
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : null}
          {inNewChat ? (
            <div data-testid="pending-group-chat" className="min-h-0 flex-1" />
          ) : !active && !activeGroup && initialBotsLoaded ? (
            <div className="grid flex-1 place-items-center">
              <Button disabled={!bootstrapMe} onClick={() => setPanel("create")}>
                <Plus size={16} aria-hidden="true" />
                <Trans>Create new Bot</Trans>
              </Button>
            </div>
          ) : (
            <Transcript
              key={activeSnapshot?.threadId}
              scrollRef={messageScroll}
              paused={Boolean(peerConversation)}
              botName={active?.name}
              scrollRequest={scrollRequest}
              onScrollRequestHandled={clearScrollRequest}
              artifactTarget={transcriptArtifactTarget}
              messages={transcriptMessages}
              showToolActivity={showToolActivity}
              olderCursor={activeSnapshot?.olderCursor ?? null}
              loadingOlder={loadingOlder}
              answerableAskMessageId={answerableAskMessageId}
              answerableApprovalMessageIds={answerableApprovalMessageIds}
              running={transcriptRunning}
              workingBots={workingBots}
              onLoadOlder={loadOlder}
              onOpenBot={openBot}
              onAnswer={answerMessage}
              onReply={(message) => {
                setReplyTarget(message);
                setReplyQuote(null);
              }}
              onQuote={(message, quote) => {
                setReplyTarget(message);
                setReplyQuote(quote);
              }}
              onReact={reactToMessage}
              onJumpToMessage={jumpToReplyMessage}
              onOpenPeerMessages={(peer) => {
                const originBotId = peer.botId ?? active?.id;
                if (originBotId) setPeerConversation({ ...peer, botId: originBotId });
              }}
              memberName={resolveTranscriptMemberName}
              peerBot={resolveTranscriptBot}
              mentionTargets={composerMentionTargets}
              onRefresh={refreshActiveThread}
              onBotChanged={refreshBots}
              onConnectionsChanged={connectionsChanged}
              onAddRoutine={addSkillRoutine}
              voiceReady={Boolean(voiceStatus?.ready)}
              speakingMessageId={speakingMessageId}
              onSpeak={speakMessage}
              onOpenComputer={onOpenComputer}
            />
          )}
          {recordingSkill ? (
            <div className="px-6 pb-2 text-center text-[13px] text-destructive">
              <Trans>Teaching in progress. Stop teaching before sending a new message.</Trans>
            </div>
          ) : null}
          {templateExample ? (
            <div className="px-6 pb-2">
              <Button
                variant="outline"
                disabled={sending || exampleTarget.blocked}
                onClick={insertTemplateExample}
              >
                <Trans>Try example</Trans>
              </Button>
            </div>
          ) : null}
          {active || activeGroup || inNewChat ? (
            <Composer
              draftKey={draftScopeKey}
              key={draftScopeKey}
              active={!peerConversation}
              draftState={composerDraft}
              onDraftChange={updateComposerDraft}
              activeName={
                inNewChat
                  ? pendingChat.botIds
                      .map((id) => bots.find((bot) => bot.id === id)?.name)
                      .filter(Boolean)
                      .join(", ")
                  : inGroup
                    ? (activeGroup?.name ?? activeSnapshot?.groupName)
                    : active?.name
              }
              running={composerRunning}
              disabled={
                !draftScopeKey ||
                Boolean(recordingSkill) ||
                (inNewChat && pendingChat.botIds.length === 0)
              }
              pendingAttachments={activePendingAttachments}
              attachmentNotice={
                attachmentNotice?.scopeKey === draftScopeKey ? attachmentNotice.text : null
              }
              sendError={sendError}
              runError={displayedRunError}
              runErrorId={displayedRunErrorId}
              onRunErrorPresented={handleRunErrorPresented}
              onDismissError={dismissComposerError}
              sending={sending}
              fileInputRef={fileInputRef}
              onAttachmentPick={onAttachmentPick}
              onRemoveAttachment={removeAttachment}
              onSend={sendMessage}
              onStop={stopRun}
              onVoice={
                !inGroup && active
                  ? () => {
                      if (!voiceStatus?.ready) {
                        openSettings("voice");
                        return;
                      }
                      startCall({
                        botId: active.id,
                        botName: active.name,
                        botColor: active.color,
                        transcribe: voiceStatus ? Boolean(voiceStatus.transcribe) : undefined,
                      });
                    }
                  : undefined
              }
              artifactTarget={transcriptArtifactTarget}
              replyTarget={activeReplyTarget}
              replyQuote={activeReplyQuote}
              replyTargetName={replyTargetName}
              onClearReply={clearReply}
              mentionTargets={composerMentionTargets}
              agentSkills={agentSkills}
              onSlashOpen={refreshAgentSkills}
              onSlashAction={(action) => {
                if (action === "chat-settings") {
                  setPanel(inGroup ? "group-settings" : "settings");
                  return;
                }
                if (action === "settings-general") {
                  openSettings("general");
                  return;
                }
                if (action === "settings-usage") {
                  openSettings("usage");
                }
              }}
            />
          ) : null}
        </div>
        {peerConversation ? (
          <Suspense
            fallback={
              <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
                <Trans>Loading…</Trans>
              </div>
            }
          >
            <PeerMessagesOverlay
              key={`${bootstrapMe?.spaceId}:${activeSnapshot?.threadId}:${peerConversation.botId}:${peerConversation.peerBotId}`}
              botId={peerConversation.botId}
              botName={resolveTranscriptBot(peerConversation.botId)?.name ?? active?.name ?? t`Bot`}
              botColor={resolveTranscriptBot(peerConversation.botId)?.color ?? FALLBACK_BOT_COLOR}
              peerBotId={peerConversation.peerBotId}
              peerBotName={peerConversation.peerBotName}
              peerBotColor={
                resolveTranscriptBot(peerConversation.peerBotId)?.color ?? FALLBACK_BOT_COLOR
              }
              messages={activeSnapshot?.messages ?? []}
              threadId={activeSnapshot?.threadId}
              groupId={groupId}
              spaceId={bootstrapMe?.spaceId}
              onClose={() => setPeerConversation(null)}
            />
          </Suspense>
        ) : null}
      </main>

      <CallCard onSettings={() => openSettings("voice")} />

      <ResizableSidePanel
        layout={layout}
        onWidthChange={resizePanel}
        open={panelVisible}
        panel={panel ?? "closed"}
      >
        {panel && (active || activeGroup || panel === "create") ? (
          <div className="rk-scroll h-full w-full overflow-y-auto px-5 py-[17px]">
            {panel !== "routine" &&
            panel !== "create" &&
            panel !== "create-group" &&
            panel !== "group-settings" ? (
              <div className="mb-4 flex items-center justify-between">
                <span className="text-[13.5px] text-muted-foreground">
                  {panel === "settings" ? (
                    <Trans>Settings</Trans>
                  ) : active ? (
                    (computer?.state ?? active.status)
                  ) : (
                    <Trans>Group</Trans>
                  )}
                </span>
                <div className="flex gap-1">
                  {active &&
                  panel === "computer" &&
                  !computerOpen &&
                  computerPanelNeedsMaintenance(computer?.state, booting) ? (
                    <ComputerMaintenanceActions
                      botId={active.id}
                      computer={computer}
                      onChanging={invalidateComputerBoot}
                      onChanged={async () => {
                        await refreshThread(active.id);
                      }}
                    />
                  ) : null}
                  {active ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={panel === "settings" ? t`Show computer` : t`Show settings`}
                      onClick={() => setPanel(panel === "settings" ? "computer" : "settings")}
                      className={panel === "settings" ? "text-foreground" : "text-muted-foreground"}
                    >
                      <Settings size={16} strokeWidth={1.7} />
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Close panel`}
                    onClick={() => setPanel(null)}
                  >
                    <X size={16} strokeWidth={1.8} />
                  </Button>
                </div>
              </div>
            ) : null}
            {panel === "computer" && active ? (
              <div>
                <div
                  data-testid="computer-preview"
                  className={`group relative rounded-[14px] bg-background ${
                    showingRecoveryHint ? "" : "aspect-[16/10] overflow-hidden"
                  }`}
                >
                  {computerOpen ? (
                    <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
                      <Trans>Open in full window</Trans>
                    </div>
                  ) : computer?.kind === "desktop" ? (
                    <DesktopKindEmptyState className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80" />
                  ) : computer?.state === "running" &&
                    screenPresented &&
                    embeddedScreenUrl &&
                    !computerScreenError ? (
                    <iframe
                      title={t`Bot screen preview`}
                      src={embeddedScreenUrl}
                      sandbox={screenIframeSandbox(embeddedScreenUrl)}
                      className="h-full w-full border-0 bg-black"
                      allow="clipboard-read; clipboard-write"
                      style={{ pointerEvents: "none" }}
                    />
                  ) : (
                    <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80">
                      {computerScreenError ??
                        (showComputerRecoveryHint ? (
                          <ComputersUnavailableHint
                            sandboxProvider={bootstrapMe?.sandboxProvider}
                            onRecovered={(sandboxProvider) => {
                              setBootstrapMe((prev) =>
                                prev ? { ...prev, sandboxProvider } : prev,
                              );
                              holdComputerRecovery();
                            }}
                            onRecoveryDismissed={releaseComputerRecovery}
                            onOpenComputerSettings={
                              bootstrapMe?.isDeploymentOwner === true
                                ? () => openSettings("computer")
                                : undefined
                            }
                          />
                        ) : (
                          computerPlaceholder(
                            computer?.state,
                            booting,
                            computerLabel(computer?.mode, active.name),
                          )
                        ))}
                    </div>
                  )}
                  {!computerScreenError && !showingRecoveryHint ? (
                    <button
                      type="button"
                      data-testid="computer-preview-open"
                      className="absolute inset-0 flex cursor-pointer items-center justify-center bg-overlay/40 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={t`Open`}
                      onClick={() => void openComputer()}
                    >
                      <span className="inline-flex items-center gap-2 rounded-full bg-overlay px-3.5 py-2 text-[14px] text-foreground shadow-md">
                        <Maximize2 size={15} strokeWidth={1.9} aria-hidden />
                        <Trans>Open</Trans>
                      </span>
                    </button>
                  ) : null}
                </div>
                <p className="mt-2 truncate text-[13.5px] text-muted-foreground" dir="auto">
                  {t`${active.name}'s screen`}
                </p>
                <RoutineListHeader
                  onCreate={() => {
                    setRoutineDraft(emptyRoutineDraft());
                    setRoutineWebhookSecret(null);
                    setEditingRoutine(null);
                    setRoutineError(null);
                    setPanel("routine");
                  }}
                />
                {activeRoutines.map((routine) => {
                  const routineRunning =
                    snapshot?.run?.routineId === routine.id && isActive(snapshot.run.status);
                  return (
                    <RoutineListRow
                      key={routine.id}
                      routine={routine}
                      running={routineRunning}
                      onOpen={() => {
                        setRoutineDraft(draftFromRoutine(routine));
                        setRoutineWebhookSecret(null);
                        setEditingRoutine(routine);
                        setRoutineError(null);
                        setPanel("routine");
                      }}
                      onStop={() => void stopRun()}
                    />
                  );
                })}
              </div>
            ) : null}
            {panel === "group-settings" && activeGroup ? (
              <GroupSettings
                key={activeGroup.id}
                group={activeGroup}
                bots={bots}
                covered={computerOpen}
                onClose={() => setPanel(null)}
                onSave={async (input) => {
                  if (!saveGroupSettings) throw new Error("GROUP_SETTINGS_UNAVAILABLE");
                  const updated = await saveGroupSettings.save(input);
                  saveGroupSettings.publish(updated);
                }}
                onRemove={async () => {
                  await rpc.groups.remove({ groupId: activeGroup.id });
                  releaseDeletedPendingGroup(activeGroup.id);
                  const remainingGroups = groups.filter((group) => group.id !== activeGroup.id);
                  setGroups(remainingGroups);
                  setPanel(null);
                  navigate(firstThreadRoute(bots, remainingGroups), { replace: true });
                  await refreshBots().catch(() => undefined);
                }}
              />
            ) : null}
            {panel === "create" && botCreationEditor ? (
              <CreateBotForm
                key={creationScope.scopeKey}
                creation={botCreationEditor.creation}
                onCreated={publishCreatedBot}
                onOpen={openCreatedBot}
                onConnectEmail={() => setCreationAppsEditor(botCreationEditor)}
                onCancel={() => setPanel(null)}
              />
            ) : null}
            {panel === "settings" && active ? (
              <BotSettings
                key={active.id}
                bot={active}
                memoryProviderConfigured={memoryProviderConfig != null}
                onSkillsChange={setAgentSkills}
                onSave={async ({ computerMode, ...patch }) => {
                  if (computerMode !== undefined && computerMode !== active.computerMode) {
                    invalidateComputerBoot();
                    await rpc.bots.setComputer({
                      botId: active.id,
                      mode: computerMode,
                    });
                  }
                  const updated = await rpc.bots.update({ botId: active.id, ...patch });
                  setBots((current) =>
                    current.map((bot) => (bot.id === updated.id ? updated : bot)),
                  );
                  // Persistence succeeded; a failed navigation refresh must not undo the tool edit.
                  await refreshBots().catch(() => undefined);
                }}
                onExport={async () => {
                  const manifest = await rpc.export.bot({ botId: active.id });
                  const blob = new Blob([JSON.stringify(manifest, null, 2)], {
                    type: "application/json",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${active.name.toLowerCase().replace(/\s+/g, "-")}-export.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                onClear={() => setClearTarget({ kind: "bot", chat: active })}
              />
            ) : null}
            {panel === "routine" && active ? (
              <RoutineEditor
                draft={routineDraft}
                onChange={setRoutineDraft}
                editing={editingRoutine}
                timezone={editingRoutine?.timezone ?? bootstrapMe?.timezone ?? localTimezone()}
                webhook={{
                  path:
                    typeof window !== "undefined"
                      ? `${window.location.origin}/api/v1/bots/${active.id}/webhook`
                      : `/api/v1/bots/${active.id}/webhook`,
                  secret: routineWebhookSecret,
                  configured: active.webhookConfigured || Boolean(routineWebhookSecret),
                }}
                githubPath={
                  typeof window !== "undefined"
                    ? `${window.location.origin}/api/v1/bots/${active.id}/github`
                    : `/api/v1/bots/${active.id}/github`
                }
                messageProviders={messagingProviders}
                connectionsRevision={connectionsRevision}
                scopeKey={active.id}
                onOpenApplications={() => setPluginsOpen(true)}
                saving={savingRoutine}
                running={runningRoutine}
                error={routineError}
                onBack={() => setPanel("computer")}
                onClose={() => setPanel(null)}
                onEnsureWebhook={async () => {
                  await ensureWebhookSecret(active.id);
                }}
                onSave={async () => {
                  if (routineSavePending.current) return;
                  const targetBotId = active.id;
                  const targetRoutine = editingRoutine;
                  if (targetRoutine && targetRoutine.botId !== targetBotId) return;
                  if (
                    !routineDraft.schedules.length &&
                    !routineDraft.webhookEnabled &&
                    !routineDraft.githubEnabled &&
                    !routineDraft.messageProvider &&
                    !routineDraft.nativeTriggers.length
                  ) {
                    setRoutineError(
                      t`Add a schedule, application event, webhook, GitHub, or message trigger`,
                    );
                    return;
                  }
                  const saveRequest = ++routineSaveRequest.current;
                  routineSavePending.current = true;
                  setSavingRoutine(true);
                  setRoutineError(null);
                  try {
                    const nativeResult = routineDraft.nativeTriggersDirty
                      ? nativeRoutineTriggerInputs(routineDraft.nativeTriggers)
                      : undefined;
                    if (nativeResult && !nativeResult.success) {
                      setRoutineError(t`Check the application event accounts and fields.`);
                      return;
                    }
                    if (
                      (routineDraft.webhookEnabled || routineDraft.githubEnabled) &&
                      !active.webhookConfigured &&
                      !routineWebhookSecret
                    ) {
                      await ensureWebhookSecret(targetBotId);
                    }
                    const crons = routineDraft.schedules.map(cronFromPreset);
                    const chosenModel = routineDraft.modelKey
                      ? parseModelOptionKey(routineDraft.modelKey)
                      : null;
                    const modelPatch =
                      !targetRoutine || routineDraft.modelDirty
                        ? {
                            modelProvider: chosenModel?.provider ?? null,
                            modelId: chosenModel?.modelId ?? null,
                            modelCredentialId: chosenModel?.modelCredentialId ?? null,
                            thinkingLevel: (routineDraft.thinkingLevel ||
                              null) as Routine["thinkingLevel"],
                            expectedRevision: chosenModel ? routineDraft.modelRevision : undefined,
                          }
                        : {};
                    let saved: Routine;
                    if (targetRoutine) {
                      const armOneShot = routineNeedsOneShotArm(targetRoutine, crons);
                      let runAt: string | undefined;
                      if (armOneShot) {
                        if (!routineDraft.runAtLocal) {
                          setRoutineError(t`Add a run time for this one-shot.`);
                          return;
                        }
                        const parsed = new Date(routineDraft.runAtLocal);
                        if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
                          setRoutineError(t`Run time must be in the future.`);
                          return;
                        }
                        runAt = parsed.toISOString();
                      }
                      saved = await rpc.routines.update({
                        routineId: targetRoutine.id,
                        ...modelPatch,
                        ...(nativeResult?.success ? { nativeTriggers: nativeResult.data } : {}),
                        name: routineDraft.name || t`Routine`,
                        prompt: routineDraft.prompt || t`Check in.`,
                        crons,
                        active: armOneShot ? true : routineDraft.active,
                        webhookEnabled: routineDraft.webhookEnabled,
                        githubEnabled: routineDraft.githubEnabled,
                        messageProvider: routineDraft.messageProvider,
                        ...(runAt ? { runAt } : {}),
                      });
                    } else {
                      saved = await rpc.routines.create({
                        botId: targetBotId,
                        ...modelPatch,
                        ...(nativeResult?.success ? { nativeTriggers: nativeResult.data } : {}),
                        name: routineDraft.name || t`Routine`,
                        prompt: routineDraft.prompt || t`Check in.`,
                        crons,
                        timezone: bootstrapMe?.timezone ?? localTimezone(),
                        active: routineDraft.active,
                        notify: true,
                        webhookEnabled: routineDraft.webhookEnabled,
                        githubEnabled: routineDraft.githubEnabled,
                        messageProvider: routineDraft.messageProvider,
                      });
                    }
                    if (
                      routineSaveRequest.current === saveRequest &&
                      activeBotId.current === targetBotId
                    ) {
                      setEditingRoutine(saved);
                      setRoutineDraft(draftFromRoutine(saved));
                    }
                  } catch (error) {
                    if (
                      routineSaveRequest.current !== saveRequest ||
                      activeBotId.current !== targetBotId
                    ) {
                      return;
                    }
                    setRoutineError(errorText(error, t`Could not save routine`));
                    return;
                  } finally {
                    routineSavePending.current = false;
                    setSavingRoutine(false);
                  }
                  if (
                    routineSaveRequest.current !== saveRequest ||
                    activeBotId.current !== targetBotId
                  ) {
                    return;
                  }
                  await refreshThread(targetBotId).catch(() => undefined);
                }}
                onTestRun={async () => {
                  if (routineRunPending.current) return;
                  const targetBotId = active.id;
                  const targetRoutine = editingRoutine;
                  if (!targetRoutine) return;
                  routineRunPending.current = true;
                  setRunningRoutine(true);
                  setRoutineError(null);
                  try {
                    await rpc.routines.testRun({ routineId: targetRoutine.id });
                    await refreshThread(targetBotId);
                  } catch (error) {
                    if (activeBotId.current === targetBotId) {
                      setRoutineError(errorText(error, t`Could not run routine`));
                    }
                  } finally {
                    routineRunPending.current = false;
                    setRunningRoutine(false);
                  }
                }}
                onDelete={() => {
                  if (editingRoutine) {
                    setDeleteRoutineTarget(editingRoutine);
                    return;
                  }
                  setPanel("computer");
                }}
              />
            ) : null}
          </div>
        ) : null}
      </ResizableSidePanel>

      <Suspense fallback={null}>
        {contextChat && botMenu ? (
          <BotContextMenu
            bot={contextChat}
            position={botMenu.position}
            onClose={closeBotMenu}
            sections={botSections}
            onTogglePinned={() => {
              setBotMenu(null);
              const item = contextBot
                ? { kind: "bot" as const, chat: contextBot }
                : { kind: "group" as const, chat: contextGroup! };
              void saveChatOrganization(item, { pinned: !contextChat.pinned }).catch(
                reportSidebarError,
              );
            }}
            onToggleUnread={() => {
              const unread = !contextChat.unread;
              setBotMenu(null);
              if (contextBot) {
                const request = unread ? markBotUnread(contextBot.id) : markBotRead(contextBot.id);
                void request.catch(() => undefined);
              } else {
                void setConversationUnread({ groupId: contextGroup!.id }, unread).catch(
                  () => undefined,
                );
              }
            }}
            onMoveToSection={(sectionId) => {
              setBotMenu(null);
              void moveChatToSection(
                contextBot
                  ? { kind: "bot", chat: contextBot }
                  : { kind: "group", chat: contextGroup! },
                sectionId,
              ).catch(reportSidebarError);
            }}
            onCreateSection={() => {
              botMenuAnchor.current = null;
              expandSidebar();
              setQuery("");
              setRenameSectionTarget(null);
              setNewSectionTarget(
                contextBot
                  ? { kind: "bot", chat: contextBot }
                  : { kind: "group", chat: contextGroup! },
              );
              setBotMenu(null);
            }}
            onEdit={() => {
              const destKey =
                userId && bootstrapMe?.spaceId
                  ? rightPanelStorageKey(
                      userId,
                      bootstrapMe.spaceId,
                      contextBot ? "bot" : "group",
                      contextChat.id,
                    )
                  : null;
              explicitPanelTarget.current = destKey;
              pendingPanelRestore.current = null;
              navigate(contextBot ? `/app/${contextBot.id}` : `/app/g/${contextGroup!.id}`);
              // Mark the destination key restored so we do not write settings onto the source chat.
              setPanelState(contextBot ? "settings" : "group-settings");
              setRestoredPanelKey(destKey);
              setBotMenu(null);
            }}
            onDuplicate={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.duplicate({ botId: contextBot.id })
                : rpc.groups.duplicate({ groupId: contextGroup!.id });
              void request.then(async (chat) => {
                await refreshBots();
                navigate(contextBot ? `/app/${chat.id}` : `/app/g/${chat.id}`);
              });
            }}
            onClear={() => {
              setClearTarget(
                contextBot
                  ? { kind: "bot", chat: contextBot }
                  : { kind: "group", chat: contextGroup! },
              );
              setBotMenu(null);
            }}
            onArchive={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.archive({ botId: contextBot.id })
                : rpc.groups.archive({ groupId: contextGroup!.id });
              void request.then(() => {
                if (contextBot) removePendingRecipient(contextBot.id);
                else releaseDeletedPendingGroup(contextGroup!.id);
                return refreshBots(true);
              });
            }}
            onDelete={() => {
              if (contextBot) setDeleteTarget(contextBot);
              else setDeleteGroupTarget(contextGroup!);
              setBotMenu(null);
            }}
          />
        ) : null}

        {spaceMenu ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) closeSpaceMenu();
            }}
          >
            {/* Invisible anchor at the pointer position, mirroring the bot menu. */}
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="fixed size-0 p-0 opacity-0"
                  style={{ left: spaceMenu.position.x, top: spaceMenu.position.y }}
                />
              }
            />
            <DropdownMenuContent
              aria-label={t`Actions for space`}
              align="start"
              sideOffset={0}
              className="w-[220px]"
            >
              {spaceMenuTarget ? (
                <DropdownMenuItem
                  onClick={() => {
                    setSettingsSpaceId(spaceMenuTarget.id);
                    setSettingsSection("models");
                    setSettingsOpen(true);
                    setSpaceMenu(null);
                  }}
                >
                  <Settings />
                  {t`Settings`}
                </DropdownMenuItem>
              ) : null}
              {spaceMenuTarget?.canRename ? (
                <DropdownMenuItem
                  onClick={() => {
                    setRenameSpaceTarget(spaceMenuTarget);
                    setSpaceMenu(null);
                  }}
                >
                  <Pencil />
                  {t`Rename space`}
                </DropdownMenuItem>
              ) : null}
              {spaceMenuTarget?.canDelete ? (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    setDeleteSpaceTarget(spaceMenuTarget);
                    setSpaceMenu(null);
                  }}
                >
                  <Trash2 />
                  {t`Delete space`}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {deleteTarget ? (
          <DeleteBotDialog
            bot={deleteTarget}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={async (deleteMemories) => {
              await rpc.bots.remove({ botId: deleteTarget.id, deleteMemories });
              removePendingRecipient(deleteTarget.id);
              setDeleteTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {deleteGroupTarget ? (
          <DeleteItemDialog
            item={deleteGroupTarget}
            noun="group"
            onCancel={() => setDeleteGroupTarget(null)}
            onConfirm={async () => {
              await rpc.groups.remove({ groupId: deleteGroupTarget.id });
              releaseDeletedPendingGroup(deleteGroupTarget.id);
              setDeleteGroupTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {renameSpaceTarget ? (
          <RenameSpaceDialog
            space={renameSpaceTarget}
            onCancel={() => setRenameSpaceTarget(null)}
            onConfirm={async (name) => {
              const spaceId = renameSpaceTarget.id;
              await commitSpaceRename({
                rename: async () => {
                  await rpc.spaces.rename({ spaceId, name });
                },
                apply: () => {
                  setSpaces((current) =>
                    current.map((space) => (space.id === spaceId ? { ...space, name } : space)),
                  );
                },
                refresh: () => refreshBots(),
              });
              setRenameSpaceTarget(null);
            }}
          />
        ) : null}

        {deleteSpaceTarget ? (
          <DeleteItemDialog
            item={deleteSpaceTarget}
            noun="space"
            description={
              <Trans>Only empty spaces can be deleted. Delete its bots and groups first.</Trans>
            }
            onCancel={() => setDeleteSpaceTarget(null)}
            onConfirm={async () => {
              const targetId = deleteSpaceTarget.id;
              const result = await rpc.spaces.remove({ spaceId: targetId });
              setDeleteSpaceTarget(null);
              setPanel(null);
              const effectiveSpaceId = selectedSpaceId() ?? bootstrapMe?.spaceId;
              if (effectiveSpaceId === targetId) {
                // The auth boundary changed, so reload like a space switch.
                if (selectSpace(result.activeSpaceId)) {
                  window.location.assign("/app");
                  return;
                }
              }
              await refreshBots(true);
            }}
          />
        ) : null}

        {sectionMenu ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) closeSectionMenu();
            }}
          >
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="fixed size-0 p-0 opacity-0"
                  style={{ left: sectionMenu.position.x, top: sectionMenu.position.y }}
                />
              }
            />
            <DropdownMenuContent
              finalFocus={false}
              aria-label={t`Actions for ${sectionMenu.section.name}`}
              align="start"
              sideOffset={0}
              className="w-[220px]"
            >
              <DropdownMenuItem
                onClick={() => {
                  sectionMenuAnchor.current = null;
                  setRenameSectionTarget({
                    section: sectionMenu.section,
                    spaceId: sectionMenu.spaceId,
                  });
                  setSectionMenu(null);
                }}
              >
                <Pencil />
                {t`Rename section`}
              </DropdownMenuItem>
              {sectionsForSpace(sectionMenu.spaceId).findIndex(
                (section) => section.id === sectionMenu.section.id,
              ) > 0 ? (
                <DropdownMenuItem
                  onClick={() => {
                    const target = sectionMenu;
                    setSectionMenu(null);
                    void stepSection(target.section.id, target.spaceId, -1).catch(
                      reportSidebarError,
                    );
                  }}
                >
                  <ArrowUp />
                  {t`Move up`}
                </DropdownMenuItem>
              ) : null}
              {sectionsForSpace(sectionMenu.spaceId).findIndex(
                (section) => section.id === sectionMenu.section.id,
              ) <
              sectionsForSpace(sectionMenu.spaceId).length - 1 ? (
                <DropdownMenuItem
                  onClick={() => {
                    const target = sectionMenu;
                    setSectionMenu(null);
                    void stepSection(target.section.id, target.spaceId, 1).catch(
                      reportSidebarError,
                    );
                  }}
                >
                  <ArrowDown />
                  {t`Move down`}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => {
                  const target = sectionMenu;
                  setSectionMenu(null);
                  void removeSection(target.section, target.spaceId).catch(reportSidebarError);
                }}
              >
                <Trash2 />
                {t`Delete section`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        <CommandPalette
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          bots={bots}
          onSelectBot={(id) => {
            setMobileSidebarOpen(false);
            navigate(`/app/${id}`);
          }}
        />

        {newSpaceOpen ? (
          <NewSpaceDialog
            onCancel={() => setNewSpaceOpen(false)}
            onConfirm={async (name) => {
              const space = await rpc.spaces.create({ name });
              if (!selectSpace(space.id)) {
                setNewSpaceOpen(false);
                await refreshBots();
                return;
              }
              window.location.assign("/onboarding");
            }}
          />
        ) : null}

        {clearTarget ? (
          <ClearConversationDialog
            bot={clearTarget.chat}
            onCancel={() => setClearTarget(null)}
            onConfirm={async () => {
              const actor = groupSettingsActor.current;
              const spaceId = selectedSpaceId() ?? actor.spaceId;
              const epoch = historyEpoch.current;
              await rpc.threads.clear(
                clearTarget.kind === "bot"
                  ? { botId: clearTarget.chat.id }
                  : { groupId: clearTarget.chat.id },
              );
              if (
                epoch === historyEpoch.current &&
                actor.userId === groupSettingsActor.current.userId &&
                actor.spaceId === groupSettingsActor.current.spaceId &&
                spaceId === (selectedSpaceId() ?? groupSettingsActor.current.spaceId) &&
                ((clearTarget.kind === "bot" && activeBotId.current === clearTarget.chat.id) ||
                  (clearTarget.kind === "group" && activeGroupId.current === clearTarget.chat.id))
              ) {
                clearHistoryWindow();
                updateSnapshot((current) =>
                  current ? { ...current, messages: [], olderCursor: null, run: null } : current,
                );
              }
              setClearTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {deleteRoutineTarget ? (
          <DeleteItemDialog
            item={deleteRoutineTarget}
            noun="routine"
            onCancel={() => setDeleteRoutineTarget(null)}
            onConfirm={async () => {
              const target = deleteRoutineTarget;
              await rpc.routines.remove({ routineId: target.id });
              setDeleteRoutineTarget(null);
              setEditingRoutine((current) => (current?.id === target.id ? null : current));
              if (activeBotId.current !== target.botId) return;
              await refreshThread(target.botId);
              if (activeBotId.current === target.botId) setPanel("computer");
            }}
          />
        ) : null}

        {creationAppsEditor && creationAppsEditor === botCreationEditor && panel === "create" ? (
          <PluginsOverlay
            key={`${settingsOwnerKey}:${creationSpaceId}:${currentSpaceSelectionGeneration()}`}
            ownerKey={userId ? settingsOwnerKey : null}
            spaceId={creationSpaceId}
            onConnectionsChanged={connectionsChanged}
            onClose={() => setCreationAppsEditor(null)}
            onOpenMcp={() => {
              setCreationAppsEditor(null);
              setCreationMcpEditor(botCreationEditor);
            }}
          />
        ) : null}
        {creationMcpEditor && creationMcpEditor === botCreationEditor && panel === "create" ? (
          <McpServersOverlay onClose={() => setCreationMcpEditor(null)} />
        ) : null}
        {pluginsOpen ? (
          <PluginsOverlay
            key={`${settingsOwnerKey}:${creationSpaceId}:${currentSpaceSelectionGeneration()}`}
            ownerKey={userId ? settingsOwnerKey : null}
            spaceId={creationSpaceId}
            activeBotId={activeBotId.current}
            onConnectionsChanged={connectionsChanged}
            onClose={() => setPluginsOpen(false)}
            onOpenMcp={() => {
              setPluginsOpen(false);
              setMcpOpen(true);
            }}
          />
        ) : null}
        {mcpOpen ? <McpServersOverlay onClose={() => setMcpOpen(false)} /> : null}
        {messagingSettingsOpen ? (
          <MessagingSettingsOverlay
            key={`${settingsOwnerKey}:${creationSpaceId}:${currentSpaceSelectionGeneration()}`}
            ownerKey={userId ? settingsOwnerKey : null}
            spaceId={creationSpaceId}
            onClose={() => setMessagingSettingsOpen(false)}
          />
        ) : null}
      </Suspense>

      <Suspense fallback={null}>
        {settingsOpen ? (
          <SettingsOverlay
            space={settingsSpace}
            spaces={spaces}
            currentSpaceId={settingsCurrentSpaceId}
            ownerKey={settingsOwnerKey}
            onSpaceChange={setSettingsSpaceId}
            name={userName}
            email={session.data?.user.email}
            timezone={bootstrapMe?.timezone}
            onTimezoneChange={bootstrapMe?.timezone !== undefined ? saveAccountTimezone : undefined}
            usage={usage}
            onUsageOpen={refreshUsage}
            initialSection={settingsSection}
            onSectionChange={setSettingsSection}
            isDeploymentOwner={bootstrapMe?.isDeploymentOwner === true}
            billingEnabled={bootstrapMe?.billingEnabled === true}
            sandboxProvider={bootstrapMe?.sandboxProvider}
            onSandboxProviderChange={(sandboxProvider) =>
              setBootstrapMe((prev) => (prev ? { ...prev, sandboxProvider } : prev))
            }
            messagingEnabled={messagingSurfaceEnabled}
            onOpenMessaging={() => {
              setSettingsOpen(false);
              setMessagingSettingsOpen(true);
            }}
            memoryConfig={memoryProviderConfig}
            onMemoryConfigChange={(config) => {
              memoryProviderConfigRevision.current += 1;
              setMemoryProviderConfig(config);
            }}
            onVoiceStatusMaybeChanged={async () => {
              const owner = settingsOwner;
              const spaceId = settingsCurrentSpaceId;
              const generation = currentSpaceSelectionGeneration();
              const current = () =>
                owner === committedSettingsOwner.current &&
                generation === currentSpaceSelectionGeneration() &&
                (selectedSpaceId() ?? groupSettingsActor.current.spaceId ?? null) === spaceId;
              const client = createSpaceRpc(spaceId, current);
              try {
                const status = await Promise.race([
                  client.voice.status(),
                  voiceStatusRefreshTimeout(),
                ]);
                if (current()) setVoiceStatus(status);
              } catch {
                if (current()) setVoiceStatus(null);
              }
            }}
            onClose={() => {
              setSettingsOpen(false);
              setSettingsSection("general");
            }}
          />
        ) : null}
      </Suspense>

      {booting ? (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-[22px] bg-background/95">
          <div className="text-[19px] font-medium text-foreground">
            <Trans>Booting up {computerBot?.name ?? active?.name}’s computer</Trans>
          </div>
          <div className="h-[5px] w-[min(420px,70%)] overflow-hidden rounded-full bg-accent">
            <div className="h-full w-2/3 rounded-full bg-primary" />
          </div>
        </div>
      ) : computerOpen && computerBot ? (
        <div className="fixed inset-0 z-30 bg-background">
          <div
            data-testid="computer-viewport"
            className="fixed inset-x-0 top-0 flex flex-col bg-background"
            style={{
              height: computerViewport ? `${computerViewport.height}px` : "100dvh",
              top: computerViewport ? `${computerViewport.offsetTop}px` : undefined,
            }}
          >
            <div
              data-testid="computer-chrome"
              className="flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <BotAvatar
                  color={computerBot.color}
                  identity={computerBot.id}
                  size={28}
                  status={computerBot.status}
                />
                {recordingSkill ? (
                  <TeachRecordingChrome
                    recording={recordingSkill}
                    botId={computerBot.id}
                    busy={teachBusy}
                    onStop={stopTeaching}
                    variant="overlay"
                  />
                ) : (
                  <span className="truncate text-[15.5px] font-medium text-foreground" dir="auto">
                    {computerLabel(computer?.mode, computerBot.name)}
                  </span>
                )}
                {!recordingSkill && hasControl ? (
                  computer?.takeoverRequested ? (
                    <span className="rounded-full bg-warning/15 px-[11px] py-1 text-[13px] text-warning">
                      <Trans>Needs you</Trans>
                    </span>
                  ) : (
                    <span className="rounded-full bg-success/15 px-[11px] py-1 text-[13px] text-success">
                      <Trans>You have control</Trans>
                    </span>
                  )
                ) : !recordingSkill ? (
                  <span className="text-[13px] text-muted-foreground">
                    <Trans>Watching</Trans>
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                {composerRunning ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t`Stop`}
                    data-testid="computer-overlay-stop"
                    onClick={() => void stopRun()}
                    disabled={sending}
                  >
                    <Trans>Stop</Trans>
                  </Button>
                ) : null}
                {recordingSkill ? (
                  <TeachStopButton busy={teachBusy} onStop={stopTeaching} />
                ) : hasControl ? (
                  <ComputerReleaseActions
                    takeoverRequested={Boolean(computer?.takeoverRequested)}
                    onRelease={releaseComputer}
                  />
                ) : computer?.state === "running" &&
                  !computerTakeoverBlocked(computer, snapshot?.run?.status) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={takingComputerControl}
                    onClick={() => void takeComputerControl(computerBot.id)}
                  >
                    <Trans>Take control</Trans>
                  </Button>
                ) : null}
                {computerBot && !recordingSkill ? (
                  <TeachComputerOverlayControl
                    key={computerBot.id}
                    botId={computerBot.id}
                    computer={computer}
                    busy={teachBusy}
                    onRefresh={refreshActiveTeaching}
                  />
                ) : null}
                {computerBot && !recordingSkill ? (
                  <ComputerMaintenanceActions
                    botId={computerBot.id}
                    computer={computer}
                    onChanging={invalidateComputerBoot}
                    onChanged={async () => {
                      await refreshComputerFor(computerBot.id);
                    }}
                  />
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={t`Close computer`}
                  onClick={() => setComputerOpen(false)}
                >
                  <X size={16} strokeWidth={1.8} />
                </Button>
              </div>
            </div>
            {sendError ? (
              <div
                role="alert"
                className="border-b border-destructive/40 bg-destructive/10 px-[18px] py-2 text-[13px] text-destructive"
              >
                {sendError}
              </div>
            ) : null}
            <div className="relative min-h-0 flex-1 bg-background">
              <ComputerWorkspace
                botId={computerBot.id}
                computer={computer}
                hasControl={hasControl}
                dock={!recordingSkill}
                onTakeControl={
                  computer?.state === "running" &&
                  !hasControl &&
                  !computerTakeoverBlocked(computer, snapshot?.run?.status)
                    ? () => takeComputerControl(computerBot.id)
                    : undefined
                }
              >
                {computer?.kind === "desktop" ? (
                  <DesktopKindEmptyState className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground/80" />
                ) : computer?.state === "running" &&
                  screenPresented &&
                  embeddedScreenUrl &&
                  !computerScreenError ? (
                  <>
                    <iframe
                      title={t`Bot screen`}
                      src={embeddedScreenUrl}
                      sandbox={screenIframeSandbox(embeddedScreenUrl)}
                      className="h-full w-full border-0 bg-black"
                      allow="clipboard-read; clipboard-write; fullscreen"
                      style={{
                        pointerEvents: recordingSkill || !hasControl ? "none" : "auto",
                      }}
                    />
                    {computerBot ? (
                      <TeachCaptureOverlay
                        botId={computerBot.id}
                        skill={recordingSkill}
                        enabled={Boolean(recordingSkill)}
                        screenWidth={computer?.screenWidth}
                        screenHeight={computer?.screenHeight}
                      />
                    ) : null}
                  </>
                ) : (
                  <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
                    {computerScreenError ??
                      (computer?.state === "suspended"
                        ? t`Computer is asleep`
                        : computerLabel(computer?.mode, computerBot.name))}
                  </div>
                )}
              </ComputerWorkspace>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  return shell;
}

const Transcript = memo(function Transcript({
  paused,
  botName,
  scrollRef,
  scrollRequest,
  onScrollRequestHandled,
  artifactTarget,
  messages,
  showToolActivity,
  olderCursor,
  loadingOlder,
  answerableAskMessageId,
  answerableApprovalMessageIds,
  running,
  workingBots,
  onLoadOlder,
  onOpenBot,
  onAnswer,
  onReply,
  onQuote,
  onReact,
  onJumpToMessage,
  onOpenPeerMessages,
  memberName,
  peerBot,
  mentionTargets,
  onRefresh,
  onBotChanged,
  onConnectionsChanged,
  onAddRoutine,
  voiceReady,
  speakingMessageId,
  onSpeak,
  onOpenComputer,
}: {
  paused: boolean;
  botName?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollRequest: { messageId: string; nonce: number } | null;
  onScrollRequestHandled: () => void;
  artifactTarget: ArtifactTarget;
  messages: ThreadMessage[];
  showToolActivity: boolean;
  olderCursor: number | null;
  loadingOlder: boolean;
  answerableAskMessageId: string | null;
  answerableApprovalMessageIds: ReadonlySet<string>;
  running: boolean;
  workingBots: GroupAvatarMember[];
  onLoadOlder: () => void | Promise<void>;
  onOpenBot: (botId: string) => void;
  onAnswer: (message: ThreadMessage, text: string, username?: string) => Promise<void>;
  onReply: (message: ThreadMessage) => void;
  onQuote: (message: ThreadMessage, quote: string) => void;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
  onJumpToMessage: (messageId: string) => void;
  onOpenPeerMessages: (peer: { botId?: string; peerBotId: string; peerBotName: string }) => void;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (botId: string) => { name?: string; color: string; status?: string } | undefined;
  mentionTargets: readonly ComposerMention[];
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onConnectionsChanged: () => void;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speakingMessageId: string | null;
  onSpeak: (message: ThreadMessage) => void;
  onOpenComputer: (botId?: string) => void;
}) {
  const { t } = useLingui();
  const artifactDescriptions = useMemo(() => messageAttachmentLabels(messages), [messages]);
  const [atEnd, setAtEnd] = useState(true);
  const following = useRef(true);
  const autoScrolling = useRef(false);
  const lastScrollTop = useRef<number | null>(null);
  const autoScrollTimer = useRef<number | undefined>(undefined);
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const reactionView = useMemo(() => projectMessageReactions(messages), [messages]);
  const separatorIds = timeSeparatorIds(
    reactionView.visibleMessages.filter((message) =>
      messageHasVisibleBlocks(message.blocks, showToolActivity),
    ),
  );
  const workingBotName = workingBots.length === 1 ? workingBots[0]?.name : undefined;
  const workingLabel =
    workingBotName != null && workingBotName !== ""
      ? t`${workingBotName} is working`
      : t`Bots are working`;
  const [quoteDraft, setQuoteDraft] = useState<{
    message: ThreadMessage;
    text: string;
    range: Range;
  } | null>(null);
  const selectingWithMouse = useRef(false);

  const evaluateSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setQuoteDraft(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const contentOf = (node: Node) =>
      (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
        "[data-quote-message-id]",
      ) ?? null;
    const startContent = contentOf(range.startContainer);
    const endContent = contentOf(range.endContainer);
    // selection.toString() serializes the whole range (a Ctrl+A transcript is
    // unbounded), so it only runs once both endpoints sit in one message.
    const draft = quoteDraftForSelection(
      {
        startContent,
        endContent,
        text: startContent && startContent === endContent ? selection.toString() : "",
      },
      messageById,
    );
    setQuoteDraft((prev) => {
      if (!draft) return null;
      // Repeat firings for an unchanged selection reuse the draft so the
      // transcript isn't re-rendered by every unrelated selection event. A
      // moved selection (e.g. keyboard-selecting a second occurrence of the
      // same text) must carry its new Range — the pill anchors to it.
      if (
        prev &&
        prev.message === draft.message &&
        prev.text === draft.text &&
        prev.range.compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
        prev.range.compareBoundaryPoints(Range.END_TO_END, range) === 0
      ) {
        return prev;
      }
      return { ...draft, range };
    });
  }, [messageById]);

  // Keyboard and assistive-tech selections never reach a mouseup, so the pill
  // lifecycle listens on selectionchange; the mouse flag keeps it hidden while
  // a drag is still in flight.
  useEffect(() => {
    if (paused) {
      setQuoteDraft(null);
      return;
    }
    const onMouseDown = (event: MouseEvent) => {
      selectingWithMouse.current = true;
      if ((event.target as Element | null)?.closest?.("[data-quote-selection]")) return;
      setQuoteDraft(null);
    };
    const onMouseUp = () => {
      selectingWithMouse.current = false;
      evaluateSelection();
    };
    const onSelectionChange = () => {
      if (!selectingWithMouse.current) evaluateSelection();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuoteDraft(null);
    };
    // A drag that ends outside the window never fires document mouseup; reset
    // the flag on blur so keyboard selections keep working afterwards.
    const onWindowBlur = () => {
      selectingWithMouse.current = false;
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [evaluateSelection, paused]);
  const snapToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = true;
    autoScrolling.current = false;
    setAtEnd(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
  }, [scrollRef]);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    following.current = true;
    autoScrolling.current = !reducedMotion;
    setAtEnd(true);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
    window.clearTimeout(autoScrollTimer.current);
    // Fallback only: onScroll clears autoScrolling once near-end is reached.
    autoScrollTimer.current = window.setTimeout(
      () => {
        autoScrolling.current = false;
      },
      reducedMotion ? 0 : 2_000,
    );
  }, [scrollRef]);

  const scrolledJump = useRef<number | null>(null);
  const jumpScrolling = useRef(false);
  const jumpScrollTimer = useRef<number | undefined>(undefined);
  const endJumpScroll = useCallback(() => {
    jumpScrolling.current = false;
    window.clearTimeout(jumpScrollTimer.current);
    scrollRef.current?.removeEventListener("scrollend", endJumpScroll);
  }, [scrollRef]);
  // A jump scroll must win over follow-the-tail: unfollow inside the commit
  // that mounts the row so a live commit cannot cancel the animation, keep
  // retrying while the pinned window is still rendering, and suppress the
  // near-end follow re-arm only for the jump's own scroll events — scrollend
  // (or user input interrupting it, which also fires scrollend) ends the
  // suppression, with the timeout as fallback when no scroll happens.
  useLayoutEffect(() => {
    if (paused || !scrollRequest || scrolledJump.current === scrollRequest.nonce) return;
    const element = scrollRef.current;
    const row = element?.querySelector(
      `[data-message-id="${CSS.escape(scrollRequest.messageId)}"]`,
    );
    if (!element || !row) return;
    scrolledJump.current = scrollRequest.nonce;
    following.current = false;
    autoScrolling.current = false;
    jumpScrolling.current = true;
    element.addEventListener("scrollend", endJumpScroll, { once: true });
    window.clearTimeout(jumpScrollTimer.current);
    jumpScrollTimer.current = window.setTimeout(endJumpScroll, 2_000);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Center synchronously so streamed layout updates cannot interrupt the jump.
    row.scrollIntoView({ behavior: "auto", block: "center" });
    row.animate(
      reducedMotion
        ? [{ backgroundColor: "var(--muted)" }, { backgroundColor: "var(--muted)" }]
        : [
            { backgroundColor: "transparent" },
            { backgroundColor: "var(--muted)" },
            { backgroundColor: "transparent" },
          ],
      { duration: 1200 },
    );
    onScrollRequestHandled();
  }, [messages, paused, scrollRequest, scrollRef, endJumpScroll, onScrollRequestHandled]);

  useLayoutEffect(() => {
    if (paused) {
      following.current = false;
      return;
    }
    if (following.current) snapToEnd();
  }, [messages, running, snapToEnd, paused]);

  useLayoutEffect(() => {
    const button = jumpButtonRef.current;
    if (atEnd && button && document.activeElement === button) {
      button.blur();
    }
  }, [atEnd]);

  const loadOlder = useCallback(() => {
    const wasFollowing = following.current;
    // Prepend must not race the messages-driven snap-to-end follow path.
    following.current = false;
    autoScrolling.current = false;
    const pending = onLoadOlder();
    if (!pending) return;
    return Promise.resolve(pending).catch((error) => {
      const element = scrollRef.current;
      if (wasFollowing && element && transcriptIsNearEnd(element)) {
        following.current = true;
        setAtEnd(true);
      }
      throw error;
    });
  }, [onLoadOlder, scrollRef]);

  useEffect(
    () => () => {
      window.clearTimeout(autoScrollTimer.current);
      window.clearTimeout(jumpScrollTimer.current);
    },
    [],
  );

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-testid="transcript"
        onPointerDown={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onTouchStart={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) {
            lastScrollTop.current = event.currentTarget.scrollTop;
            autoScrolling.current = false;
            following.current = false;
          }
        }}
        onScroll={(event) => {
          const scrolledDown = transcriptMovedDown(
            lastScrollTop.current,
            event.currentTarget.scrollTop,
          );
          lastScrollTop.current = event.currentTarget.scrollTop;
          const nearEnd = transcriptIsNearEnd(event.currentTarget);
          setAtEnd(nearEnd);
          // A jump scroll owns the viewport until its animation settles; its
          // own near-end crossings must not re-arm tail-following.
          if (jumpScrolling.current) return;
          if (nearEnd) {
            if (scrolledDown) following.current = true;
            if (autoScrolling.current) {
              autoScrolling.current = false;
              window.clearTimeout(autoScrollTimer.current);
            }
          } else if (!autoScrolling.current) {
            following.current = false;
          }
        }}
        className="rk-scroll @container/chat min-h-0 flex-1 overflow-y-auto px-4 py-5 @[480px]/conversation:px-7 @[480px]/conversation:py-6"
      >
        <div
          data-testid="conversation-column"
          className="mx-auto flex w-full max-w-[764px] flex-col gap-5"
        >
          {olderCursor != null ? (
            <button
              type="button"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
              className="self-center rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground/75 disabled:opacity-50"
            >
              {loadingOlder ? t`Loading…` : t`Load earlier messages`}
            </button>
          ) : null}
          {groupVoiceChats(reactionView.visibleMessages).map((item) => {
            if (item.kind === "voiceChat") {
              return (
                <div key={item.key}>
                  {item.messages[0] && separatorIds.has(item.messages[0].id) ? (
                    <TimeSeparator
                      createdAt={item.messages[0].createdAt}
                      locale={i18n.locale || "en"}
                    />
                  ) : null}
                  <VoiceChatCard group={item} revealMessageId={scrollRequest?.messageId} />
                </div>
              );
            }
            const message = item.message;
            if (!messageHasVisibleBlocks(message.blocks, showToolActivity)) return null;
            const peerReceipt = isPeerReceiptBlocks(message.blocks);
            const messageReactions = reactionView.reactions.get(message.id);
            return (
              <Fragment key={message.id}>
                {separatorIds.has(message.id) ? (
                  <TimeSeparator createdAt={message.createdAt} locale={i18n.locale || "en"} />
                ) : null}
                <div
                  data-message-id={message.id}
                  className={peerReceipt ? "relative py-0.5" : "group/message relative hover:z-20"}
                >
                  <div
                    className={
                      peerReceipt
                        ? undefined
                        : `relative flex ${message.role === "user" ? "justify-end" : "justify-start"}`
                    }
                  >
                    <div
                      data-testid={peerReceipt ? undefined : "message-bubble-frame"}
                      className={
                        peerReceipt
                          ? undefined
                          : `relative w-fit min-w-0 ${
                              message.role === "user" ? "max-w-[85%]" : "max-w-[88%]"
                            }`
                      }
                    >
                      <MessageView
                        artifactDescriptions={artifactDescriptions}
                        artifactTarget={artifactTarget}
                        message={message}
                        canAnswer={
                          message.blocks.some(isApprovalAskBlock)
                            ? answerableApprovalMessageIds.has(message.id)
                            : message.id === answerableAskMessageId
                        }
                        onOpenBot={onOpenBot}
                        onOpenPeerMessages={onOpenPeerMessages}
                        onAnswer={onAnswer}
                        speakerName={
                          peerReceipt
                            ? undefined
                            : message.role === "bot"
                              ? (memberName?.(message.botId) ??
                                (message.botId ? peerBot(message.botId)?.name : undefined) ??
                                botName ??
                                t`Bot`)
                              : undefined
                        }
                        memberName={memberName}
                        peerBot={peerBot}
                        mentionTargets={mentionTargets}
                        replyParent={
                          message.replyToMessageId
                            ? messageById.get(message.replyToMessageId)
                            : undefined
                        }
                        onJumpToMessage={onJumpToMessage}
                        onRefresh={onRefresh}
                        onBotChanged={onBotChanged}
                        onConnectionsChanged={onConnectionsChanged}
                        onAddRoutine={onAddRoutine}
                        voiceReady={voiceReady}
                        speaking={speakingMessageId === message.id}
                        onSpeak={() => onSpeak(message)}
                        onOpenComputer={onOpenComputer}
                        showToolActivity={showToolActivity}
                        hoverActions={
                          peerReceipt ? undefined : (
                            <MessageHoverActions
                              message={message}
                              side={message.role === "user" ? "start" : "end"}
                              onReply={onReply}
                              onReact={onReact}
                            />
                          )
                        }
                      />
                    </div>
                  </div>
                  {!peerReceipt && message.role !== "bot" && !message.id.startsWith("progress:") ? (
                    <time
                      dateTime={message.createdAt}
                      data-testid="message-hover-time"
                      className={cn(
                        "pointer-events-none absolute top-1 z-10 text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 group-has-[[aria-expanded=true]]/message:opacity-100 [@media(hover:none)]:transition-none",
                        // Hover keeps the date in the side margin. Touch leaves that margin for the bubble and drops the revealed time under it.
                        message.role === "user"
                          ? "start-0 max-w-[max(8rem,16%)] text-start"
                          : "end-0 max-w-[max(8rem,12%)] text-end",
                        "[@media(hover:none)]:group-hover/message:static [@media(hover:none)]:group-focus-within/message:static [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:static",
                        "[@media(hover:none)]:group-hover/message:block [@media(hover:none)]:group-focus-within/message:block [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:block",
                        "[@media(hover:none)]:group-hover/message:mt-1 [@media(hover:none)]:group-focus-within/message:mt-1 [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:mt-1",
                        "[@media(hover:none)]:group-hover/message:w-full [@media(hover:none)]:group-focus-within/message:w-full [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:w-full",
                        "[@media(hover:none)]:group-hover/message:max-w-none [@media(hover:none)]:group-focus-within/message:max-w-none [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:max-w-none",
                        message.role === "user"
                          ? "[@media(hover:none)]:group-hover/message:text-end [@media(hover:none)]:group-focus-within/message:text-end [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:text-end"
                          : "[@media(hover:none)]:group-hover/message:text-start [@media(hover:none)]:group-focus-within/message:text-start [@media(hover:none)]:group-has-[[aria-expanded=true]]/message:text-start",
                      )}
                    >
                      {formatMessageTime(message.createdAt, i18n.locale || "en")}
                    </time>
                  ) : null}
                  {!peerReceipt && messageReactions ? (
                    <div
                      data-testid="message-reactions"
                      className={cn(
                        "mt-1 flex flex-wrap gap-1",
                        message.role === "user" && "justify-end",
                      )}
                    >
                      {[...messageReactions].map(([emoji, count]) => (
                        <span
                          key={emoji}
                          className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
                        >
                          {emoji}
                          {count > 1 ? ` ${count}` : ""}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </Fragment>
            );
          })}
          {running &&
          !messages.some(
            (message) =>
              message.id.startsWith("progress:") &&
              message.blocks.some(
                (block) =>
                  block.kind === "progress" && !isToolActivityBlock(block) && Boolean(block.text),
              ),
          ) ? (
            <ActiveBotGlyph bots={workingBots} label={workingLabel} />
          ) : null}
        </div>
      </div>
      {!paused && quoteDraft ? (
        <QuoteSelectionButton
          range={quoteDraft.range}
          onQuote={() => {
            onQuote(quoteDraft.message, quoteDraft.text);
            window.getSelection()?.removeAllRanges();
            setQuoteDraft(null);
          }}
        />
      ) : null}
      <button
        ref={jumpButtonRef}
        type="button"
        aria-label={t`Jump to latest`}
        aria-hidden={atEnd}
        tabIndex={atEnd ? -1 : 0}
        onClick={jumpToLatest}
        className={`absolute bottom-4 left-1/2 z-20 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-border bg-muted/95 text-foreground/75 shadow-md backdrop-blur transition-[opacity,transform,background-color] duration-200 ease-[cubic-bezier(.22,1,.36,1)] hover:bg-border motion-reduce:transition-none ${
          atEnd ? "pointer-events-none translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        <ArrowDown size={17} strokeWidth={1.8} />
      </button>
    </div>
  );
});

/**
 * Floating Quote action anchored to the selection's bounding rect. Measures
 * itself after mount so it can flip below the selection when there is no room
 * above and stay clamped inside the viewport; re-anchors on scroll/resize.
 */
const QuoteSelectionButton = memo(function QuoteSelectionButton({
  range,
  onQuote,
}: {
  range: Range;
  onQuote: () => void;
}) {
  const { t } = useLingui();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<{
    top: number;
    left: number;
    above: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      if (range.collapsed || !document.contains(range.commonAncestorContainer)) {
        setPlacement(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const width = buttonRef.current?.offsetWidth ?? 0;
      const height = buttonRef.current?.offsetHeight ?? 0;
      const above = rect.top >= height + 8;
      setPlacement({
        top: above ? rect.top - 8 : rect.bottom + 8,
        left: Math.min(
          Math.max(rect.left + rect.width / 2, width / 2 + 8),
          window.innerWidth - width / 2 - 8,
        ),
        above,
      });
    };
    update();
    window.addEventListener("resize", update);
    // Scroll doesn't bubble — listen on the capture phase to catch any scroller.
    window.addEventListener("scroll", update, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [range]);

  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      data-quote-selection
      data-testid="quote-selection"
      onMouseDown={(event) => {
        // Keep the highlight alive until the click commits the quote.
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={onQuote}
      style={placement ? { top: placement.top, left: placement.left } : { visibility: "hidden" }}
      className={cn(
        "fixed z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-foreground shadow-md hover:bg-muted",
        placement?.above === false ? "translate-y-0" : "-translate-y-full",
      )}
    >
      <TextQuote size={13} strokeWidth={2} />
      {t`Quote`}
    </button>,
    document.body,
  );
});

export const Composer = memo(function Composer({
  draftKey,
  active,
  draftState,
  onDraftChange,
  artifactTarget,
  activeName,
  running,
  disabled,
  pendingAttachments,
  attachmentNotice,
  sendError,
  runError,
  runErrorId,
  onRunErrorPresented,
  onDismissError,
  sending,
  fileInputRef,
  onAttachmentPick,
  onRemoveAttachment,
  onSend,
  onStop,
  onVoice,
  replyTarget,
  replyQuote,
  replyTargetName,
  onClearReply,
  mentionTargets,
  agentSkills,
  onSlashOpen,
  onSlashAction,
}: {
  draftKey: string | null;
  active: boolean;
  draftState: ComposerDraft;
  onDraftChange: (change: ComposerDraftChange) => void;
  activeName?: string;
  running: boolean;
  disabled?: boolean;
  pendingAttachments: PendingAttachment[];
  attachmentNotice: string | null;
  sendError: string | null;
  runError: string | null;
  runErrorId: string | null;
  onRunErrorPresented: (runId: string) => void;
  onDismissError: () => void;
  sending: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachmentPick: (files: FileList | null) => void | Promise<void>;
  onRemoveAttachment: (attachment: PendingAttachment) => void;
  onSend: (text: string, mentions: ComposerMention[], submittedVersion: number) => Promise<boolean>;
  onStop: () => Promise<void>;
  onVoice?: () => void;
  artifactTarget: ArtifactTarget;
  replyTarget?: ThreadMessage | null;
  replyQuote?: string | null;
  replyTargetName?: string;
  onClearReply?: () => void;
  mentionTargets?: ComposerMention[];
  agentSkills?: AgentSkillCatalogEntry[];
  onSlashOpen?: () => void;
  onSlashAction?: (action: SlashActionId) => void;
}) {
  const { t } = useLingui();
  const draft = draftState.text;
  const setDraft = (value: string | ((current: string) => string)) =>
    onDraftChange((current) => ({
      text: typeof value === "function" ? value(current.text) : value,
    }));
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionHighlightKey, setMentionHighlightKey] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const selectedSkill = draftState.selectedSkill;
  const selectedMentions = draftState.selectedMentions;
  const setSelectedSkill = (value: AgentSkillCatalogEntry | null) =>
    onDraftChange({ selectedSkill: value });
  const setSelectedMentions = (
    value: ComposerMention[] | ((current: ComposerMention[]) => ComposerMention[]),
  ) =>
    onDraftChange((current) => ({
      selectedMentions: typeof value === "function" ? value(current.selectedMentions) : value,
    }));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerBarRef = useRef<HTMLDivElement>(null);
  const composerActionsRef = useRef<HTMLDivElement>(null);
  const composerMentionsRef = useRef<HTMLDivElement>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [mentionsOverflow, setMentionsOverflow] = useState(false);
  useLayoutEffect(() => {
    const bar = composerBarRef.current;
    const mentions = composerMentionsRef.current;
    if (!bar || !mentions) {
      setMentionsOverflow(false);
      return;
    }
    function measureMentions() {
      if (!bar || !mentions) return;
      const middleWidth = Number.parseFloat(
        getComputedStyle(bar).gridTemplateColumns.split(" ")[1] ?? "0",
      );
      const compactWidth = middleWidth * 0.65;
      const gap = Number.parseFloat(getComputedStyle(mentions).columnGap) || 0;
      const chips = Array.from(mentions.children);
      // Compare against the compact row even while expanded, so wrapping cannot toggle the layout.
      const neededWidth = chips.reduce(
        (width, chip) => width + Math.min(chip.getBoundingClientRect().width, compactWidth),
        Math.max(0, chips.length - 1) * gap,
      );
      setMentionsOverflow(neededWidth > compactWidth + 1);
    }
    measureMentions();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measureMentions);
    });
    observer.observe(bar);
    observer.observe(mentions);
    for (const chip of mentions.children) observer.observe(chip);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [selectedMentions]);
  const getInlineWidth = useCallback(() => {
    const bar = composerBarRef.current;
    if (!bar) return 0;
    const columns = getComputedStyle(bar).gridTemplateColumns.split(" ");
    const middleWidth = Number.parseFloat(columns[1] ?? "0");
    const mentionsWidth = selectedMentions.length
      ? Math.min(composerMentionsRef.current?.scrollWidth ?? 0, middleWidth * 0.65)
      : 0;
    return Math.max(40, middleWidth - mentionsWidth - (mentionsWidth ? 8 : 0));
  }, [selectedMentions.length]);
  const [replyAnnouncement, setReplyAnnouncement] = useState("");
  // What the live region currently holds — a send disarming the reply clears
  // "reply" text, while an explicit cancel must keep "Reply cancelled".
  const replyAnnouncementKind = useRef<"reply" | "cancelled" | null>(null);
  const prevReplyTarget = useRef<ThreadMessage | null>(null);
  const runErrorRef = useRef<HTMLDivElement>(null);
  const presentedRunErrorIdRef = useRef<string | null>(null);
  const mentionListboxId = useId();
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const canSend =
    draft.trim().length > 0 ||
    selectedSkill !== null ||
    selectedMentions.length > 0 ||
    pendingAttachments.length > 0;

  useEffect(() => {
    if (!runError || !runErrorId) return;
    const currentRunErrorId = runErrorId;
    let frame = 0;
    function recordIfPresented() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = runErrorRef.current;
        if (!element || document.visibilityState !== "visible") return;
        const rect = element.getBoundingClientRect();
        const topElement = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        if (topElement && (topElement === element || element.contains(topElement))) {
          if (presentedRunErrorIdRef.current === currentRunErrorId) return;
          presentedRunErrorIdRef.current = currentRunErrorId;
          onRunErrorPresented(currentRunErrorId);
        }
      });
    }
    recordIfPresented();
    const observer = new MutationObserver(recordIfPresented);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("transitionend", recordIfPresented);
    document.addEventListener("visibilitychange", recordIfPresented);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("transitionend", recordIfPresented);
      document.removeEventListener("visibilitychange", recordIfPresented);
    };
  }, [onRunErrorPresented, runError, runErrorId]);

  const mentionQueryPattern = /(?:^|\s)@([^@\r\n]*)$/;

  function updateDraft(value: string) {
    setDraft(value);
    const mentionMatch = mentionQueryPattern.exec(value);
    setMentionQuery(mentionMatch ? (mentionMatch[1] ?? "") : null);
    // `/` only at the start of the draft so forced skills expand (`Use skill:` / `/Name` prefix).
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    const nextSlash = slashMatch ? (slashMatch[1] ?? "") : null;
    if (nextSlash !== null && slashQuery === null) onSlashOpen?.();
    setSlashQuery(nextSlash);
  }

  function focusComposer() {
    textareaRef.current?.focus();
  }

  function insertMention(mention: ComposerMention) {
    setDraft((current) =>
      current.replace(mentionQueryPattern, (match) => match.slice(0, match.lastIndexOf("@"))),
    );
    setMentionQuery(null);
    setMentionHighlightKey(null);
    setSelectedMentions((current) =>
      current.some((selected) => mentionChipKey(selected) === mentionChipKey(mention))
        ? current
        : [...current, mention],
    );
    focusComposer();
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    setSelectedSkill(skill);
    setDraft("");
    setSlashQuery(null);
  }

  function runSlashAction(action: SlashActionId) {
    setDraft("");
    setSlashQuery(null);
    onSlashAction?.(action);
  }

  function removeLastChip() {
    if (selectedMentions.length > 0) {
      setSelectedMentions((current) => current.slice(0, -1));
      return;
    }
    if (selectedSkill) setSelectedSkill(null);
  }

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !mentionTargets?.length) return [];
    const query = mentionQuery.trim().toLowerCase();
    return mentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [mentionQuery, mentionTargets]);

  useEffect(() => {
    setMentionHighlightKey(null);
  }, [mentionQuery]);

  const activeMentionIndex = clampMentionHighlightIndex(
    mentionOptions.findIndex((mention) => mentionChipKey(mention) === mentionHighlightKey),
    mentionOptions.length,
  );
  const mentionPickerOpen = mentionOptions.length > 0;
  const activeMentionOptionId = mentionPickerOpen
    ? `${mentionListboxId}-option-${activeMentionIndex}`
    : undefined;

  const slashSkillOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    const skills = agentSkills ?? [];
    return skills
      .filter((skill) => {
        if (!query) return true;
        return (
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query)
        );
      })
      .slice(0, 8);
  }, [agentSkills, slashQuery]);

  const slashActionOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    return SLASH_ACTIONS.filter((action) => !query || action.label.toLowerCase().includes(query));
  }, [slashQuery]);

  const showSlashPicker =
    slashQuery !== null &&
    mentionQuery === null &&
    (slashSkillOptions.length > 0 || slashActionOptions.length > 0);

  function send() {
    if (!canSend || sending || disabled) return;
    const text = serializeComposerPrompt(draft, selectedSkill, selectedMentions);
    void onSend(text, selectedMentions, draftState.version).then((succeeded) => {
      if (!succeeded || readComposerDraft(draftKey).version !== 0) return;
      setMentionQuery(null);
      setMentionHighlightKey(null);
      setSlashQuery(null);
    });
  }

  function handleDragEnter(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current += 1;
    setDraggingFiles(true);
  }

  function handleDragOver(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    setDraggingFiles(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFieldSetElement>) {
    if (!isFileDrag(event.dataTransfer)) return;
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFiles(false);
    if (!disabled) void onAttachmentPick(dataTransfer.files);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardData = event.clipboardData;
    // Only intercept real FileList pastes; leave text-only / empty-files native.
    if (disabled || !clipboardData || !isFilePaste(clipboardData)) return;
    event.preventDefault();
    void onAttachmentPick(clipboardData.files);
    const text = clipboardData.getData("text/plain");
    if (!text) return;
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    updateDraft(`${draft.slice(0, start)}${text}${draft.slice(end)}`);
    const caret = start + text.length;
    window.requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  const showComposerPlaceholder =
    draft.length === 0 && selectedSkill === null && selectedMentions.length === 0;
  const attachmentDescriptions = attachmentLabels(
    pendingAttachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.file.name,
      size: attachment.file.size,
    })),
  );
  const hasAttachmentContent = pendingAttachments.length > 0 || attachmentNotice !== null;
  const expandedLayout = composerExpanded || mentionsOverflow || hasAttachmentContent;
  const replyName = replyTarget ? (replyTargetName ?? previewMessageText(replyTarget)) : "";
  const replyNameRef = useRef(replyName);
  replyNameRef.current = replyName;
  const announceTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(announceTimer.current), []);

  // Arming or retargeting a reply unmounts the control that started it, so
  // focus would drop to <body>; announce on start and when the target changes.
  // The timer lives in a ref: a same-id rerender (e.g. the display name
  // resolving after arming) must not cancel the pending announcement.
  useEffect(() => {
    const prev = prevReplyTarget.current;
    prevReplyTarget.current = replyTarget ?? null;
    if (!replyTarget) {
      // Cancel (or send) within the delay must not let a stale "Replying to"
      // overwrite the cancel announcement — kill the pending timer.
      window.clearTimeout(announceTimer.current);
      // A send disarms the reply without touching the region — drop the stale
      // "Replying to" so it cannot linger or re-announce. An explicit cancel
      // sets "Reply cancelled" in the same event, so only clear "reply" text.
      if (replyAnnouncementKind.current === "reply") {
        replyAnnouncementKind.current = null;
        setReplyAnnouncement("");
      }
      return;
    }
    if (!prev || prev.id !== replyTarget.id) {
      textareaRef.current?.focus();
      // Clear-then-set so a switch between same-author targets re-announces —
      // identical live-region text would otherwise be a no-op.
      setReplyAnnouncement("");
      replyAnnouncementKind.current = null;
      window.clearTimeout(announceTimer.current);
      announceTimer.current = window.setTimeout(() => {
        replyAnnouncementKind.current = "reply";
        setReplyAnnouncement(t`Replying to ${replyNameRef.current}`);
      }, 50);
    }
  }, [replyTarget, replyName, t]);

  return (
    <fieldset
      aria-label={t`Message composer`}
      data-dragging={draggingFiles ? "files" : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative z-30 mx-auto w-full max-w-[820px] min-w-0 border-0 px-4 pb-[18px] pt-3 @[480px]/conversation:px-7 ${
        draggingFiles ? "rounded-[14px] ring-2 ring-inset ring-ring" : ""
      }`}
    >
      <div role="status" data-testid="composer-announcement" className="sr-only">
        {replyAnnouncement}
      </div>
      {sendError || runError ? (
        <div
          ref={runErrorRef}
          role="alert"
          data-testid="composer-error"
          className="mb-3 flex items-center gap-2 rounded-[14px] border border-destructive/40 bg-destructive/10 px-4 py-2 text-[13px] text-destructive"
        >
          {sendError ? (
            <span className="min-w-0 flex-1">{sendError}</span>
          ) : runError ? (
            <RunErrorDetails key={runError} error={runError} />
          ) : null}
          <button
            type="button"
            aria-label={t`Dismiss error`}
            data-testid="composer-error-dismiss"
            onClick={() => {
              onDismissError();
              window.requestAnimationFrame(() => textareaRef.current?.focus());
            }}
            className="shrink-0 text-destructive hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {replyTarget ? (
        <ComposerReplyPreview
          active={active}
          author={replyName}
          text={previewMessageText(replyTarget)}
          quote={replyQuote}
          attachment={replyAttachment(replyTarget.blocks)}
          target={artifactTarget}
          onDismiss={() => {
            replyAnnouncementKind.current = "cancelled";
            window.clearTimeout(announceTimer.current);
            onClearReply?.();
            setReplyAnnouncement(t`Reply cancelled`);
            textareaRef.current?.focus();
          }}
        />
      ) : null}
      <div className="relative">
        {mentionPickerOpen ? (
          <div
            id={mentionListboxId}
            role="listbox"
            aria-label={t`Mentions`}
            data-testid="mention-picker"
            className="rk-scroll absolute bottom-full left-0 z-50 mb-2 max-h-[320px] w-[360px] max-w-full overflow-y-auto rounded-[14px] border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
          >
            {mentionOptions.map((mention, index) => {
              const optionId = `${mentionListboxId}-option-${index}`;
              const highlighted = index === activeMentionIndex;
              const routineOwner =
                mention.kind === "routine"
                  ? mentionTargets?.find(
                      (target) => target.kind === "bot" && target.id === mention.botId,
                    )?.name
                  : undefined;
              return (
                <button
                  id={optionId}
                  key={mentionChipKey(mention)}
                  type="button"
                  role="option"
                  aria-selected={highlighted}
                  aria-label={t`@${mention.name}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertMention(mention)}
                  // Opening the list under a stationary pointer must not steal the keyboard highlight.
                  onMouseMove={() => setMentionHighlightKey(mentionChipKey(mention))}
                  className={`flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-start text-[13px] leading-5 hover:bg-accent ${
                    highlighted ? "bg-accent" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <MentionIdentity mention={mention} showAt={false} truncateName />
                  </span>
                  {(mention.kind === "connector" || mention.kind === "routine") &&
                  mention.subtitle ? (
                    <span
                      title={mention.subtitle}
                      className="max-w-[40%] min-w-0 truncate text-[12px] text-muted-foreground"
                    >
                      {mention.kind === "routine"
                        ? (routineOwner ?? mention.subtitle)
                        : mention.authStatus === "connected"
                          ? t`Connected`
                          : t`Needs auth`}
                    </span>
                  ) : null}
                  <span
                    data-testid="mention-kind-label"
                    className="ms-auto shrink-0 text-[12px] text-muted-foreground"
                  >
                    {mentionTypeLabel(mention)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        {showSlashPicker ? (
          <div
            data-testid="slash-picker"
            className="mb-2 overflow-hidden rounded-[14px] border border-border bg-muted"
          >
            {slashSkillOptions.map((skill) => (
              <button
                key={skill.id}
                type="button"
                aria-label={t`Skill ${skill.name}`}
                onClick={() => insertSkill(skill)}
                className="flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent"
              >
                <Box
                  size={16}
                  strokeWidth={1.7}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0">
                  <span dir="auto" className="block text-[14px] text-foreground">
                    {skill.name}
                  </span>
                  <span dir="auto" className="block truncate text-[12.5px] text-muted-foreground">
                    {truncateSlashDescription(skill.description)}
                  </span>
                </span>
              </button>
            ))}
            {slashActionOptions.map((action) => {
              const label = slashActionLabel(action.id);
              return (
                <button
                  key={action.id}
                  type="button"
                  aria-label={label}
                  onClick={() => runSlashAction(action.id)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent"
                >
                  <Settings
                    size={16}
                    strokeWidth={1.7}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="text-[14px] text-foreground">{label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {selectedSkill ? (
          <div data-testid="composer-context" className="mb-2 flex min-w-0 flex-wrap gap-1.5">
            {selectedSkill ? (
              <span
                data-testid="skill-chip"
                className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[13px] text-foreground"
              >
                <Box size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />
                <span dir="auto" className="truncate">
                  {selectedSkill.name}
                </span>
                <button
                  type="button"
                  aria-label={t`Remove skill ${selectedSkill.name}`}
                  onClick={() => setSelectedSkill(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </span>
            ) : null}
          </div>
        ) : null}
        <div
          ref={composerBarRef}
          data-testid="composer-bar"
          data-expanded={expandedLayout ? "true" : "false"}
          className={cn(
            "grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 border border-border bg-muted px-3 transition-colors focus-within:border-ring",
            expandedLayout ? "gap-y-2 pt-3 pb-2 rounded-[20px]" : "py-[7px] rounded-[26px]",
          )}
        >
          {hasAttachmentContent ? (
            <div
              data-testid="composer-attachments"
              className="col-span-3 col-start-1 row-start-1 min-w-0"
            >
              {attachmentNotice ? (
                <div
                  role="status"
                  data-testid="composer-attachment-notice"
                  className="mb-2 text-[12px] leading-4 text-muted-foreground"
                >
                  {attachmentNotice}
                </div>
              ) : null}
              {pendingAttachments.length ? (
                <div className="flex flex-wrap gap-2">
                  {pendingAttachments.map((attachment) => (
                    <AttachmentPreview
                      key={attachment.id}
                      name={attachment.file.name}
                      description={attachmentDescriptions.get(attachment.id)}
                      mimeType={
                        inferAttachmentMimeType(attachment.file.name, attachment.file.type) ?? ""
                      }
                      previewUrl={attachment.previewUrl}
                      removeLabel={`${t`Remove ${attachment.file.name}`}${attachmentDescriptions.has(attachment.id) ? ` · ${attachmentDescriptions.get(attachment.id)}` : ""}`}
                      onRemove={() => onRemoveAttachment(attachment)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="hidden"
            onChange={(event) => void onAttachmentPick(event.target.files)}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={t`Attach file`}
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "col-start-1 size-8 shrink-0 self-end rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              expandedLayout && (hasAttachmentContent ? "row-start-3" : "row-start-2"),
            )}
          >
            <Plus size={16} strokeWidth={2} />
          </Button>
          <div
            className={cn(
              "flex min-w-0 items-center gap-x-2 gap-y-1.5",
              expandedLayout && "flex-wrap",
              expandedLayout ? "col-span-3 col-start-1" : "col-start-2",
              hasAttachmentContent ? "row-start-2" : "row-start-1",
            )}
          >
            {selectedMentions.length > 0 ? (
              <div
                ref={composerMentionsRef}
                data-testid="composer-mentions"
                className={cn(
                  "flex w-max shrink-0 items-center gap-x-1.5 gap-y-1.5",
                  expandedLayout
                    ? "max-w-full flex-wrap"
                    : "max-w-[65%] overflow-x-auto [scrollbar-width:none]",
                )}
              >
                {selectedMentions.map((mention) => (
                  <span
                    key={mentionChipKey(mention)}
                    data-testid="mention-chip"
                    data-mention-kind={mention.kind}
                    className="group/mention inline-flex max-w-full shrink-0 items-center gap-0.5 text-[13px] leading-5"
                  >
                    <MentionIdentity
                      mention={currentMentionAppearance(mention, mentionTargets)}
                      showAt={false}
                      truncateName
                    />
                    <button
                      type="button"
                      aria-label={t`Remove mention ${mention.name}`}
                      onClick={() => {
                        setSelectedMentions((current) =>
                          current.filter(
                            (selected) => mentionChipKey(selected) !== mentionChipKey(mention),
                          ),
                        );
                        focusComposer();
                      }}
                      className="grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/mention:opacity-100 focus:opacity-100"
                    >
                      <X size={10} strokeWidth={2} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <MessageInput
              ref={textareaRef}
              onExpandedChange={setComposerExpanded}
              getInlineWidth={getInlineWidth}
              inlineActionsRef={composerActionsRef}
              value={draft}
              onChange={(event) => updateDraft(event.target.value)}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if (
                  event.key === "Backspace" &&
                  draft.length === 0 &&
                  (selectedSkill !== null || selectedMentions.length > 0)
                ) {
                  event.preventDefault();
                  removeLastChip();
                  return;
                }
                const action = resolveMentionPickerKey({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
                  optionCount: mentionOptions.length,
                  highlightedIndex: activeMentionIndex,
                });
                if (action.type === "complete") {
                  const mention = mentionOptions[action.index];
                  if (!mention) return;
                  event.preventDefault();
                  insertMention(mention);
                  return;
                }
                if (action.type === "move") {
                  event.preventDefault();
                  const mention = mentionOptions[action.index];
                  if (mention) setMentionHighlightKey(mentionChipKey(mention));
                  return;
                }
                if (action.type === "dismiss") {
                  event.preventDefault();
                  setMentionQuery(null);
                  setMentionHighlightKey(null);
                  return;
                }
                if (action.type === "send") {
                  event.preventDefault();
                  send();
                }
              }}
              disabled={disabled}
              placeholder={
                showComposerPlaceholder
                  ? activeName
                    ? t`Message ${activeName}`
                    : t`Message…`
                  : undefined
              }
              aria-label={activeName ? t`Message ${activeName}` : t`Message`}
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-expanded={mentionPickerOpen}
              aria-controls={mentionPickerOpen ? mentionListboxId : undefined}
              aria-activedescendant={activeMentionOptionId}
              name="chat-message"
              className={expandedLayout ? "basis-full" : undefined}
              autoComplete="off"
              dir="auto"
            />
          </div>
          <div
            ref={composerActionsRef}
            className={cn(
              "col-start-3 flex shrink-0 items-center gap-1.5 self-end justify-self-end",
              expandedLayout && (hasAttachmentContent ? "row-start-3" : "row-start-2"),
            )}
          >
            {onVoice && draft.trim().length === 0 ? (
              <Button
                variant="outline"
                size="icon"
                aria-label={t`Voice`}
                title={t`Voice`}
                disabled={disabled}
                onClick={onVoice}
                className="size-8 shrink-0 rounded-full text-foreground/75"
              >
                <Mic size={16} strokeWidth={1.8} />
              </Button>
            ) : null}
            {running ? (
              <>
                <Button
                  size="icon"
                  aria-label={t`Send`}
                  disabled={sending || !canSend || disabled}
                  onClick={send}
                  className="size-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm transition-transform active:scale-95"
                >
                  <ArrowUp size={16} strokeWidth={2.2} />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t`Stop`}
                  disabled={sending}
                  onClick={() => void onStop()}
                  className="size-8 rounded-full border border-border bg-muted text-foreground/80 shadow-sm transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Square size={11} strokeWidth={0} fill="currentColor" />
                </Button>
              </>
            ) : (
              <Button
                size="icon"
                aria-label={t`Send`}
                disabled={sending || !canSend || disabled}
                onClick={send}
                className="size-8 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm transition-transform active:scale-95 disabled:bg-accent disabled:text-muted-foreground/40 disabled:shadow-none"
              >
                <ArrowUp size={16} strokeWidth={2.2} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </fieldset>
  );
});

function slashActionLabel(id: SlashActionId) {
  switch (id) {
    case "chat-settings":
      return t`Chat Settings`;
    case "settings-general":
      return t`Settings: General`;
    case "settings-usage":
      return t`Settings: Usage`;
  }
}

function mentionTypeLabel(mention: ComposerMention) {
  switch (mention.kind) {
    case "bot":
    case "everyone":
      return t`Bot`;
    case "group":
      return t`Group`;
    case "routine":
      return t`Routine`;
    case "connector":
      return t`App`;
  }
}

function previewMessageText(message: ThreadMessage): string {
  const text = message.blocks
    .map((block) => {
      if (block.kind === "channel_message") return block.text;
      if (block.kind === "text") {
        // Bot text is Markdown; user text is already plain.
        return message.role === "bot" ? plainTextFromMarkdown(block.text) : block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
  if (text) return text;
  const attachment = replyAttachment(message.blocks);
  if (attachment) return attachment.kind === "image" ? t`Photo` : attachment.name || t`Attachment`;
  return t`Message`;
}

function MessageHoverActions({
  message,
  side,
  onReply,
  onReact,
}: {
  message: ThreadMessage;
  side: "start" | "end";
  onReply: (message: ThreadMessage) => void;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
}) {
  const { t } = useLingui();
  const [moreOpen, setMoreOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);

  // Streaming progress bubbles keep hover free for selection / stop clicks.
  if (message.id.startsWith("progress:")) return null;

  function copyMessage() {
    const text = copyableMessageText(message);
    if (!text || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }

  const iconButtonClass =
    "grid h-7 w-7 place-items-center text-muted-foreground transition-colors hover:text-foreground";

  return (
    <MessageHoverMetadata pinned={moreOpen || reactionsOpen} side={side}>
      <div data-testid="message-hover-actions" className="flex items-center gap-0.5">
        {canReactToThreadMessage(message) ? (
          <Popover open={reactionsOpen} onOpenChange={setReactionsOpen}>
            <PopoverTrigger
              aria-label={t`React`}
              className={cn(
                iconButtonClass,
                "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7",
              )}
            >
              <Smile size={15} strokeWidth={1.7} />
            </PopoverTrigger>
            <PopoverContent
              align={side === "end" ? "start" : "end"}
              className="w-auto flex-row gap-0 rounded-2xl p-1.5"
              aria-label={t`Reactions`}
            >
              {MESSAGE_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  className="grid h-11 w-11 place-items-center rounded-xl text-2xl hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    setReactionsOpen(false);
                    void onReact(message, emoji);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
        <button
          type="button"
          aria-label={t`Reply`}
          onClick={() => onReply(message)}
          className={cn(
            iconButtonClass,
            "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7",
          )}
        >
          <Reply size={15} strokeWidth={1.7} />
        </button>
        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
          <DropdownMenuTrigger
            aria-label={t`More`}
            className={cn(
              iconButtonClass,
              "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7",
            )}
          >
            <MoreHorizontal size={15} strokeWidth={1.7} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align={side === "end" ? "start" : "end"}>
            <DropdownMenuItem
              onClick={() => {
                setMoreOpen(false);
                onReply(message);
              }}
            >
              <Reply size={14} strokeWidth={1.7} />
              <Trans>Reply</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyMessage}>
              <Copy size={14} strokeWidth={1.7} />
              <Trans>Copy</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </MessageHoverMetadata>
  );
}

function firstThreadRoute(
  bots: readonly Pick<Bot, "id">[],
  groups: readonly Pick<Group, "id">[],
): string {
  if (bots[0]) return `/app/${bots[0].id}`;
  if (groups[0]) return `/app/g/${groups[0].id}`;
  return "/app";
}

function applyThreadEvent(
  event: ProductEvent,
  commitSnapshot: (next: ThreadSnapshot | null) => void,
  commitComputer: (next: ComputerStatus | null) => void,
  snapshotRef: MutableRefObject<ThreadSnapshot | null>,
  computerRef: MutableRefObject<ComputerStatus | null>,
) {
  publishComputerCommand(event);
  if (isThreadSnapshotEvent(event)) {
    const next = reduceThreadSnapshot(snapshotRef.current, event);
    const blocks = event.payload.blocks;
    const answeredApproval =
      event.type === "thread.message.updated" &&
      Array.isArray(blocks) &&
      blocks.some((block) => isApprovalAskBlock(block) && block.status === "answered");
    const invalidateRun =
      event.runId &&
      (isRunTerminalEvent(event) || event.type === "run.started" || answeredApproval);
    commitSnapshot(
      next && (invalidateRun || event.type === "thread.cleared")
        ? {
            ...next,
            answerableApprovalMessageIds:
              event.type === "thread.cleared"
                ? []
                : next.answerableApprovalMessageIds?.filter((id) =>
                    next.messages.some(
                      (message) => message.id === id && message.runId !== event.runId,
                    ),
                  ),
          }
        : next,
    );
  }
  if (isComputerStatusEvent(event)) {
    const next = reduceComputerStatus(computerRef.current, event);
    commitComputer(next);
  }
}

function ComputerReleaseActions({
  takeoverRequested,
  onRelease,
}: {
  takeoverRequested: boolean;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
}) {
  const [releasing, setReleasing] = useState(false);
  const pending = useRef(false);
  async function release(reason: ComputerReleaseReason) {
    if (pending.current) return;
    pending.current = true;
    setReleasing(true);
    try {
      await onRelease(reason);
    } finally {
      pending.current = false;
      setReleasing(false);
    }
  }
  return (
    <div className="flex items-center gap-2">
      {takeoverRequested ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={releasing}
          onClick={() => void release("skipped")}
        >
          <Trans>Skip</Trans>
        </Button>
      ) : null}
      <Button type="button" size="sm" disabled={releasing} onClick={() => void release("done")}>
        <Trans>I’m done</Trans>
      </Button>
    </div>
  );
}

const MessageView = memo(function MessageView({
  artifactDescriptions,
  artifactTarget,
  canAnswer,
  message,
  onAnswer,
  onOpenBot,
  onOpenPeerMessages,
  speakerName,
  memberName,
  peerBot,
  mentionTargets,
  replyParent,
  onJumpToMessage,
  onRefresh,
  onBotChanged,
  onConnectionsChanged,
  onAddRoutine,
  voiceReady,
  speaking,
  onSpeak,
  onOpenComputer,
  showToolActivity,
  hoverActions,
}: {
  artifactDescriptions: ReadonlyMap<string, string>;
  artifactTarget: ArtifactTarget;
  canAnswer: boolean;
  message: ThreadMessage;
  onAnswer: (message: ThreadMessage, text: string, username?: string) => Promise<void>;
  onOpenBot: (botId: string) => void;
  onOpenPeerMessages: (peer: { botId?: string; peerBotId: string; peerBotName: string }) => void;
  speakerName?: string;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (botId: string) => { name?: string; color: string; status?: string } | undefined;
  mentionTargets: readonly ComposerMention[];
  replyParent?: ThreadMessage;
  onJumpToMessage?: (messageId: string) => void;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onConnectionsChanged: () => void;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speaking: boolean;
  onSpeak: () => void;
  onOpenComputer: (botId?: string) => void;
  showToolActivity: boolean;
  hoverActions?: ReactNode;
}) {
  const { t } = useLingui();
  const isNarration =
    message.role === "bot" &&
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) => block.kind === "text" || block.kind === "progress" || block.kind === "steps",
    );
  const isLive = message.id.startsWith("progress:");
  const quoteMessageId = message.id.includes(":") ? undefined : message.id;
  const visibleNarrationBlocks = renderableMessageBlocks(message.blocks, showToolActivity);

  const replyBotId = message.replyPreview?.botId ?? replyParent?.botId;
  const speakerBot = message.botId ? peerBot?.(message.botId) : undefined;
  const speakerColor = useBotIdentityTextColor(speakerBot?.color);
  const messageContext = (
    <>
      {speakerName ? (
        <div
          className="mb-1.5 flex min-w-0 items-center gap-2 text-[11px] font-medium text-foreground"
          dir="auto"
        >
          <BotAvatar
            color={speakerBot?.color ?? FALLBACK_BOT_COLOR}
            identity={message.botId}
            size={24}
          />
          <span className="min-w-0 truncate" style={{ color: speakerColor }}>
            {speakerName}
          </span>
          {!isLive ? (
            <time
              dateTime={message.createdAt}
              className="shrink-0 text-[10px] font-normal text-muted-foreground"
            >
              {new Date(message.createdAt).toLocaleTimeString(i18n.locale || "en", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          ) : null}
        </div>
      ) : null}
      <ReplyLine
        target={artifactTarget}
        message={message}
        fallbackText={replyParent ? previewMessageText(replyParent) : undefined}
        author={
          (message.replyPreview?.role ?? replyParent?.role) === "user"
            ? t`You`
            : ((replyBotId ? peerBot(replyBotId)?.name : undefined) ??
              memberName?.(replyBotId) ??
              t`Bot`)
        }
        onJump={onJumpToMessage}
      />
    </>
  );
  if (isNarration) {
    if (visibleNarrationBlocks.length === 0) return null;
    if (isToolOnlyNarration(message.blocks, showToolActivity)) {
      return (
        <>
          {messageContext}
          <div className="relative w-fit max-w-full">
            <ToolOnlyNarration blocks={visibleNarrationBlocks} live={isLive} />
            {hoverActions}
          </div>
        </>
      );
    }
    return (
      <>
        {messageContext}
        <div className="relative w-fit max-w-full [@media(hover:none)]:w-full">
          <div
            data-testid="message-bot-bubble"
            className="ms-8 max-w-full space-y-2.5 rounded-[18px] rounded-ss-[5px] bg-muted px-[15px] py-2.5 text-[14px] leading-[1.7] text-foreground/90"
            dir="auto"
          >
            {visibleNarrationBlocks.map((block, i) => {
              if (block.kind === "steps") {
                return (
                  <ToolActivityDisclosure
                    key={i}
                    live={isLive}
                    stepCount={toolStepCount(block.steps)}
                    durationMs={block.durationMs}
                  >
                    <ToolSteps
                      steps={block.steps}
                      currentIndex={isLive ? block.steps.length - 1 : undefined}
                      limit={isLive ? LIVE_TOOL_STEP_WINDOW : undefined}
                    />
                  </ToolActivityDisclosure>
                );
              }
              if (block.kind === "text" || block.kind === "progress") {
                return (
                  <div
                    key={i}
                    data-quote-message-id={block.kind === "text" ? quoteMessageId : undefined}
                  >
                    <ChatMarkdown streaming={block.kind === "progress"}>{block.text}</ChatMarkdown>
                  </div>
                );
              }
              return null;
            })}
            {!isLive && voiceReady && message.blocks.some((block) => block.kind === "text") ? (
              <button
                type="button"
                aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                onClick={onSpeak}
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
              </button>
            ) : null}
          </div>
          {hoverActions}
        </div>
      </>
    );
  }
  return (
    <>
      {messageContext}
      <div className="relative">
        {messageBlocksForQuestionCards(
          message.blocks,
          Boolean("botId" in artifactTarget ? artifactTarget.botId : message.botId),
        ).map((block, i) => {
          if (block.kind === "steps" && shouldRenderToolCard(block, showToolActivity)) {
            return (
              <StandaloneToolActivity
                key={i}
                live={isLive}
                steps={block.steps}
                stepCount={toolStepCount(block.steps)}
                durationMs={block.durationMs}
              />
            );
          }
          if (isToolActivityBlock(block)) return null;
          if (block.kind === "handoff") {
            const from = memberName?.(block.fromBotId) ?? t`bot`;
            const to = memberName?.(block.toBotId) ?? t`bot`;
            return (
              <div
                key={i}
                className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
              >
                <span>
                  ↪ {to} ← {from}
                </span>
                <span>{block.text}</span>
              </div>
            );
          }
          if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
            const sent = block.kind === "bot_message_sent";
            const peer = sent ? block.toBotName : block.fromBotName;
            const peerBotId = sent ? block.toBotId : block.fromBotId;
            const label = sent ? t`Messaged ${peer}` : t`Message from ${peer}`;
            return (
              <CollaborationMarker
                key={i}
                ariaLabel={label}
                color={peerBot(peerBotId)?.color ?? FALLBACK_BOT_COLOR}
                identity={peerBotId}
                label={sent ? t`Messaged` : t`Message from`}
                peerName={peer}
                onClick={() =>
                  onOpenPeerMessages({ botId: message.botId, peerBotId, peerBotName: peer })
                }
              />
            );
          }
          if (block.kind === "channel_message") {
            return (
              <div
                key={i}
                className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
              >
                <span>
                  {messageProviderLabel(block.provider, block.transport)} · {block.fromLabel}:{" "}
                  {block.text}
                </span>
              </div>
            );
          }
          if (block.kind === "meta") {
            return (
              <div
                key={i}
                className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
              >
                <span className="text-warning">◷</span>
                <span>{block.text}</span>
              </div>
            );
          }
          if (block.kind === "progress") {
            return (
              <div
                key={i}
                className="flex w-fit max-w-full justify-start [@media(hover:none)]:w-full"
              >
                <div
                  data-testid="message-bot-bubble"
                  className="ms-8 max-w-full rounded-[18px] rounded-ss-[5px] bg-muted px-[15px] py-2.5 text-[14px] leading-[1.7] text-foreground/90"
                  dir="auto"
                >
                  <ChatMarkdown streaming>{block.text}</ChatMarkdown>
                </div>
              </div>
            );
          }
          if (block.kind === "subagent") {
            const running = block.status === "running";
            const failed = block.status === "failed";
            return (
              <div
                key={i}
                className="w-[min(420px,90%)] rounded-[18px] border border-border bg-muted px-[18px] py-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[15px] font-medium text-foreground" dir="auto">
                    {block.name}
                  </span>
                  <span
                    className={`rounded-full px-[11px] py-1 text-[13px] ${
                      failed
                        ? "bg-destructive/15 text-destructive"
                        : running
                          ? "bg-warning/15 text-warning"
                          : "bg-success/15 text-success"
                    }`}
                    style={{
                      animation: running ? "rkPulse 1.2s ease-in-out infinite" : undefined,
                    }}
                  >
                    {running ? <Trans>subagent</Trans> : block.status}
                  </span>
                </div>
                <div className="mt-2 text-[13.5px] text-muted-foreground">{block.task}</div>
                {block.progress || block.result ? (
                  <div className="mt-2.5 text-[14.5px] leading-[1.5] text-foreground/75">
                    <ChatMarkdown streaming={running}>
                      {block.result || block.progress || ""}
                    </ChatMarkdown>
                  </div>
                ) : null}
              </div>
            );
          }
          if (block.kind === "child_bot") {
            const removed = block.status === "deleted" || block.status === "archived";
            return (
              <button
                key={i}
                type="button"
                disabled={removed}
                onClick={() => onOpenBot(block.botId)}
                className="w-[min(340px,90%)] rounded-[18px] border border-border bg-muted px-[18px] py-4 text-start disabled:opacity-60"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-medium text-foreground" dir="auto">
                    {block.name}
                  </span>
                  <span
                    className={`rounded-full px-[11px] py-1 text-[13px] ${
                      removed ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success"
                    }`}
                  >
                    {block.status === "archived" ? (
                      <Trans>archived</Trans>
                    ) : block.status === "deleted" ? (
                      <Trans>deleted</Trans>
                    ) : (
                      <Trans>bot</Trans>
                    )}
                  </span>
                </div>
                <div className="mt-2 text-[14.5px] leading-[1.5] text-foreground/75" dir="auto">
                  {removed
                    ? block.status === "archived"
                      ? t`Archived. Chat, memory, and files kept.`
                      : t`Removed with chat, computer, and memory.`
                    : block.title || t`Opened its thread.`}
                </div>
              </button>
            );
          }
          if (block.kind === "choice") {
            const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
            if (!botId) return null;
            return <ChoiceCard key={i} botId={botId} block={block} onBotChanged={onBotChanged} />;
          }
          if (block.kind === "app_connect") {
            const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
            if (!botId) return null;
            return (
              <div key={i} className="flex justify-start py-1">
                <AppConnectCard
                  botId={botId}
                  block={block}
                  onConnectionsChanged={onConnectionsChanged}
                />
              </div>
            );
          }
          if (block.kind === "chart") {
            return (
              <div key={i} className="flex justify-start">
                <ChartBlockView name={block.name} spec={block.spec} data={block.data} />
              </div>
            );
          }
          if (block.kind === "mcp_approval") {
            const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
            if (!botId) return null;
            return (
              <div key={i} className="flex justify-start">
                <McpApprovalCard botId={botId} threadId={message.threadId} block={block} />
              </div>
            );
          }
          if (block.kind === "image") {
            return (
              <div
                key={i}
                className={`flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}
              >
                {artifactDescriptions.has(block.artifactId) ? (
                  <span className="max-w-full wrap-anywhere text-xs text-muted-foreground">
                    {block.name} · {artifactDescriptions.get(block.artifactId)}
                  </span>
                ) : null}
                <ArtifactImage
                  target={artifactTarget}
                  artifactId={block.artifactId}
                  name={block.name}
                />
              </div>
            );
          }
          if (block.kind === "file") {
            return (
              <div
                key={i}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <ArtifactFileCard
                  target={artifactTarget}
                  artifactId={block.artifactId}
                  name={block.name}
                  mimeType={block.mimeType}
                  size={block.size}
                  description={artifactDescriptions.get(block.artifactId)}
                />
              </div>
            );
          }
          if (block.kind === "text" && message.role === "user") {
            // User bubbles stay literal text on web and mobile. Only explicit URLs
            // and email addresses are links, so a sent address is tappable without
            // formatting bold or headings.
            return (
              <div
                key={i}
                className="flex w-fit max-w-full justify-end [@media(hover:none)]:w-full"
              >
                <div
                  data-testid="message-user-bubble"
                  data-quote-message-id={quoteMessageId}
                  className="max-w-full whitespace-pre-wrap wrap-anywhere rounded-[18px] bg-chat-user px-[15px] py-2.5 text-[14px] leading-[1.7] text-chat-user-foreground"
                  dir="auto"
                >
                  <SentMentionText text={block.text} targets={mentionTargets} />
                </div>
              </div>
            );
          }
          if (block.kind === "text") {
            return (
              <div
                key={i}
                className="flex w-fit max-w-full justify-start [@media(hover:none)]:w-full"
              >
                <div
                  data-testid="message-bot-bubble"
                  className="ms-8 max-w-full rounded-[18px] rounded-ss-[5px] bg-muted px-[15px] py-2.5 text-[14px] leading-[1.7] text-foreground/90"
                  dir="auto"
                >
                  <div data-quote-message-id={quoteMessageId}>
                    <ChatMarkdown>{block.text}</ChatMarkdown>
                  </div>
                  {voiceReady ? (
                    <button
                      type="button"
                      aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                      onClick={onSpeak}
                      className="mt-2 text-[12px] text-muted-foreground hover:text-foreground"
                    >
                      {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          }
          if (block.kind === "card") {
            return (
              <div key={i} className="flex justify-start">
                <div className="flex flex-col gap-2 rounded-[20px] bg-muted px-5 py-4">
                  {block.lines.map((line) => (
                    <div key={line.k} className="flex items-baseline gap-2.5 text-[15px]">
                      <span className="text-success">✓</span>
                      <span className="font-semibold text-white">{line.k}</span>
                      <span className="text-muted-foreground">→</span>
                      <span>{line.v}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          if (block.kind === "ask") {
            return (
              <AskCard
                key={i}
                block={block}
                canAnswer={canAnswer}
                onAnswer={(text, username) => onAnswer(message, text, username)}
              />
            );
          }
          if (block.kind === "cloud_agent") return <CloudAgentCard key={i} block={block} />;
          if (block.kind === "skill_draft") {
            return (
              <div key={i} className="flex justify-start">
                <SkillDraftCard block={block} onRefresh={onRefresh} onAddRoutine={onAddRoutine} />
              </div>
            );
          }
          if (block.kind === "computer") {
            return (
              <div
                key={i}
                data-testid="computer-card"
                className="w-[340px] rounded-[18px] border border-border bg-muted px-[18px] py-4"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-medium text-foreground">
                    <Trans>Computer</Trans>
                  </span>
                  <span
                    className={
                      block.state === "Needs you"
                        ? "rounded-full bg-warning/15 px-[11px] py-1 text-[13px] text-warning"
                        : "rounded-full bg-success/15 px-[11px] py-1 text-[13px] text-success"
                    }
                  >
                    {block.state}
                  </span>
                </div>
                <div className="my-2.5 text-[14.5px] leading-[1.5] text-foreground/75">
                  <ChatMarkdown>{block.text}</ChatMarkdown>
                </div>
                <Button
                  type="button"
                  size="sm"
                  data-testid="computer-card-open"
                  onClick={() => onOpenComputer(message.botId)}
                >
                  <Trans>Open</Trans>
                </Button>
              </div>
            );
          }
          return null;
        })}
        {hoverActions}
      </div>
    </>
  );
});

function DesktopKindEmptyState({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Trans>
        This bot runs on this computer, not a Linux desktop. Shell and files use your home folder.
      </Trans>
    </div>
  );
}

function computerPlaceholder(
  state: ComputerStatus["state"] | undefined,
  booting: boolean,
  label: string,
) {
  if (state === "booting" || booting) return t`Booting live desktop…`;
  if (state === "running") return label;
  if (state === "suspended") return t`Computer is asleep. Open it to wake.`;
  if (state === "error") return t`Computer failed to boot`;
  return t`Computer is stopped`;
}

function computerLabel(mode: ComputerStatus["mode"] | undefined, botName: string) {
  return mode === "dedicated" ? t`${botName}’s computer` : t`Team Computer`;
}

function newClientNonce(): string {
  return newClientId();
}
