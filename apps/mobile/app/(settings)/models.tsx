import type {
  ModelApiProtocol,
  ModelBackupChoice,
  ModelCredentialReference,
  ModelHeaderRow,
  ModelOAuthBegin,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  backupChoiceKey,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  canonicalPiProviderId,
  cloudflareGatewayRouting,
  connectedBackupOptions,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  MAX_MODEL_BACKUPS,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  ModelApiProtocolSchema,
  ModelHeaderRowsSchema,
  modelConnectionLabel,
  modelHeadersInput,
  moveBackupChoice,
  OPENAI_COMPATIBLE_BASE_URL_HINT,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  sameBackupChoices,
  sameOpenAiCompatibleBaseUrl,
} from "@rakazo/contracts";
import {
  CHATGPT_USAGE_SETTINGS_URL,
  canUseCompatibleModelAsDefault,
  clampCatalogThinkingLevel,
  compatibleConnectionReady,
  compatibleModelRows,
  compatibleThinkingLevels,
  connectionFormFields,
  connectionFormModelId,
  createModelProbe,
  featuredModelProviders,
  filterModelCatalog,
  initialModelProbeState,
  matchesSearchQuery,
  modelConnectRequest,
  savedCompatibleModelIds,
  toggleEnabledModelId,
} from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { HeaderRowsEditor } from "../../components/header-rows-editor";
import { MenuPicker } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSwitch } from "../../components/native-switch";
import { Checkmark, Chevron } from "../../components/row-accessories";
import type {
  ApiRequestContext,
  MobileMe,
  MobileModel,
  MobileModelCredential,
} from "../../lib/api";
import { currentApiBase, currentSpaceSelectionGeneration, selectedSpaceId } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { presentMessageActionSheet } from "../../lib/message-action-sheet";
import {
  cancelModelOAuthAttempt,
  finishModelOAuthAttempt,
  modelOAuthUnavailableReason,
  waitForModelOAuth,
} from "../../lib/model-auth";
import { mobileBackupScopeIsCurrent } from "../../lib/model-backups";
import { thinkingLevelLabel } from "../../lib/model-catalog";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { currentSessionGeneration } from "../../lib/session";
import { useSpaceSettings, useSpaceSettingsKey } from "../../lib/space-settings";
import { errorText } from "../../lib/user-error";

/** Providers with more models than this get a search field. */
const MODEL_SEARCH_THRESHOLD = 10;

type ModelSelection = {
  provider?: string;
  modelId?: string;
  connectionId?: string;
};

type FeedbackAnchor = "probe" | "model" | "connection";

export default function Models() {
  const { spaceId, name } = useLocalSearchParams<{ spaceId?: string; name?: string }>();
  const target = typeof spaceId === "string" ? spaceId : undefined;
  const key = useSpaceSettingsKey(target);
  return (
    <ModelsForm
      key={key}
      targetSpaceId={target}
      targetName={typeof name === "string" ? name : target}
    />
  );
}

function ModelsForm({
  targetSpaceId,
  targetName,
}: {
  targetSpaceId?: string;
  targetName?: string;
}) {
  const settings = useSpaceSettings(targetSpaceId);
  const { rpc, captureApiRequestContext } = settings;
  const settingsCurrent = settings.isCurrent;
  const settingsSelectedSpaceId = () => targetSpaceId ?? selectedSpaceId();
  const styles = useThemedStyles(createModelsStyles);
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [provider, setProvider] = useState("");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [connectionRevision, setConnectionRevision] = useState<number | undefined>();
  const [savedBaseUrl, setSavedBaseUrl] = useState<string | undefined>();
  const [references, setReferences] = useState<ModelCredentialReference[]>([]);
  const backupOptionsSnapshotRef = useRef(new Map<string, ModelBackupChoice>());
  const savedBackupOptionsRef = useRef(new Map<string, Map<string, ModelBackupChoice>>());
  const savedBackupOwnerRef = useRef<{
    apiBase: string;
    spaceGeneration: number;
    sessionGeneration: number;
  } | null>(null);
  const clearStaleSavedBackupOptions = useCallback(() => {
    const owner = savedBackupOwnerRef.current;
    if (
      owner &&
      (owner.apiBase !== currentApiBase() ||
        owner.spaceGeneration !== currentSpaceSelectionGeneration() ||
        owner.sessionGeneration !== currentSessionGeneration())
    ) {
      savedBackupOptionsRef.current.clear();
      savedBackupOwnerRef.current = null;
    }
  }, []);
  const reconcileSavedBackupChoice = useCallback(
    (choice: ModelBackupChoice) => {
      clearStaleSavedBackupOptions();
      const saved = choice.modelCredentialId
        ? savedBackupOptionsRef.current.get(choice.modelCredentialId)?.get(backupChoiceKey(choice))
        : undefined;
      return saved?.expectedRevision === undefined ||
        saved.expectedRevision <= (choice.expectedRevision ?? 0)
        ? choice
        : { ...choice, expectedRevision: saved.expectedRevision };
    },
    [clearStaleSavedBackupOptions],
  );
  const modelRequestGenerationRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  // The provider whose optional personal-key form is open.
  const [ownKeyProvider, setOwnKeyProvider] = useState<string | null>(null);
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [modelId, setModelId] = useState("");
  const [enabledModelIds, setEnabledModelIds] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState({ provider: "", query: "" });
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol | "">("chat-completions");
  const [headerRows, setHeaderRows] = useState<ModelHeaderRow[] | null>(null);
  const [showHeaders, setShowHeaders] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MODEL_MAX_TOKENS));
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_MODEL_CONTEXT_WINDOW));
  const [supportsImages, setSupportsImages] = useState(false);
  const [maxImagesPerPrompt, setMaxImagesPerPrompt] = useState("");
  const [showEndpointHelp, setShowEndpointHelp] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const probeScopeRef = useRef<{
    spaceGeneration: number;
    sessionGeneration: number;
    apiBase: string;
  } | null>(null);
  const [modelProbe] = useState(() =>
    createModelProbe((next) => {
      const scope = probeScopeRef.current;
      setProbe(
        scope &&
          scope.spaceGeneration === currentSpaceSelectionGeneration() &&
          scope.sessionGeneration === currentSessionGeneration() &&
          scope.apiBase === currentApiBase()
          ? next
          : initialModelProbeState,
      );
    }),
  );
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const [oauth, setOauth] = useState<ModelOAuthBegin | null>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "default" | "disconnect" | null>(null);
  const busyRef = useRef(false);
  const pendingOwnerRef = useRef(0);
  function beginPending(next: "connect" | "default" | "disconnect") {
    const owner = ++pendingOwnerRef.current;
    setPending(next);
    return owner;
  }
  function finishPending(owner: number) {
    if (owner === pendingOwnerRef.current) setPending(null);
  }
  const [oauthPending, setOauthPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backupModels, setBackupModels] = useState<ModelBackupChoice[]>([]);
  const [savedBackupModels, setSavedBackupModels] = useState<ModelBackupChoice[]>([]);
  const [backupLoading, setBackupLoading] = useState(true);
  const [backupReady, setBackupReady] = useState(false);
  const [backupSaving, setBackupSaving] = useState(false);
  const backupReadyRef = useRef(false);
  const backupLoadingRef = useRef(true);
  const backupSavingRef = useRef(false);
  backupReadyRef.current = backupReady;
  backupLoadingRef.current = backupLoading;
  backupSavingRef.current = backupSaving;
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const backupRequestGenerationRef = useRef(0);
  const meRef = useRef<MobileMe | null>(null);
  meRef.current = me;
  const [feedbackAnchor, setFeedbackAnchor] = useState<FeedbackAnchor>("connection");
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthLoginIdRef = useRef<string | null>(null);
  const oauthCodeSubmittingRef = useRef(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const codeCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function publishFeedback(
    anchor: FeedbackAnchor,
    next: { error?: string | null; notice?: string | null },
  ) {
    const nextError = next.error ?? null;
    setFeedbackAnchor(anchor);
    setError(nextError);
    const message = nextError ?? next.notice ?? null;
    // VoiceOver keeps focus on the tapped button, so speak the result from here.
    // Success is spoken only: the selection already shows the active model.
    if (message) AccessibilityInfo.announceForAccessibility(message);
  }

  function clearFeedback() {
    setFeedbackAnchor("connection");
    setError(null);
  }

  function acceptSavedBackupConnection(saved: MobileModelCredential) {
    clearStaleSavedBackupOptions();
    savedBackupOwnerRef.current = {
      apiBase: currentApiBase(),
      spaceGeneration: currentSpaceSelectionGeneration(),
      sessionGeneration: currentSessionGeneration(),
    };
    savedBackupOptionsRef.current.set(
      saved.id,
      new Map(
        connectedBackupOptions(catalog, [saved]).map((option) => [backupChoiceKey(option), option]),
      ),
    );
    setBackupModels((current) => current.map(reconcileSavedBackupChoice));
    setSavedBackupModels((current) => current.map(reconcileSavedBackupChoice));
  }

  const copyOAuthCode = useCallback((code: string) => {
    void Clipboard.setStringAsync(code)
      .then(() => {
        setCodeCopied(true);
        if (codeCopiedTimerRef.current) clearTimeout(codeCopiedTimerRef.current);
        codeCopiedTimerRef.current = setTimeout(() => setCodeCopied(false), 1600);
      })
      .catch(() => undefined);
  }, []);

  const cancelOAuth = useCallback(() => {
    const loginId = oauthLoginIdRef.current;
    oauthLoginIdRef.current = null;
    cancelModelOAuthAttempt(oauthAbortRef, () => {
      setOauth(null);
      setOauthPending(false);
    });
    if (loginId) void settings.cancelOAuth(loginId).catch(() => undefined);
  }, [settings.cancelOAuth]);

  const load = useCallback(async (preferred: ModelSelection = {}) => {
    setError(null);
    const generation = ++modelRequestGenerationRef.current;
    const selectionRevision = selectionRevisionRef.current;
    const spaceGeneration = currentSpaceSelectionGeneration();
    const requestContext = await captureApiRequestContext();
    const [nextMe, nextCatalog, nextCredentials, nextReferences] = await Promise.all([
      rpc<MobileMe>("me", {}, { requestContext }),
      rpc<MobileModel[]>("models/list", {}, { requestContext }),
      rpc<MobileModelCredential[]>("models/credentials", {}, { requestContext }),
      rpc<{ references: ModelCredentialReference[] }>("models/references", {}, { requestContext }),
    ]);
    if (
      generation !== modelRequestGenerationRef.current ||
      spaceGeneration !== currentSpaceSelectionGeneration() ||
      requestContext.apiBase !== currentApiBase() ||
      requestContext.sessionGeneration !== currentSessionGeneration()
    )
      return;
    setReferences(nextReferences.references);
    backupOptionsSnapshotRef.current = new Map(
      connectedBackupOptions(nextCatalog, nextCredentials).map((option) => [
        backupChoiceKey(option),
        option,
      ]),
    );
    meRef.current = nextMe;
    setMe(nextMe);
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    if (selectionRevision !== selectionRevisionRef.current) return nextMe;
    const nextProvider =
      (preferred.provider &&
      nextCatalog.some(
        (entry) =>
          canonicalPiProviderId(entry.provider) === canonicalPiProviderId(preferred.provider ?? ""),
      )
        ? preferred.provider
        : nextMe.defaultProvider) ??
      nextCatalog[0]?.provider ??
      "";
    const nextCredential =
      nextCredentials.find(
        (entry) =>
          canonicalPiProviderId(entry.provider) === canonicalPiProviderId(nextProvider ?? "") &&
          entry.id === preferred.connectionId,
      ) ??
      nextCredentials.find(
        (entry) =>
          canonicalPiProviderId(entry.provider) === canonicalPiProviderId(nextProvider ?? "") &&
          entry.isDefault,
      ) ??
      nextCredentials.find(
        (entry) =>
          canonicalPiProviderId(entry.provider) === canonicalPiProviderId(nextProvider ?? ""),
      );
    const nextModel = connectionFormModelId({
      catalog: nextCatalog,
      provider: nextProvider,
      credential: nextCredential,
      defaults: nextMe,
      current: preferred.modelId,
    });
    resetOpenAiCompatibleProbe();
    setProvider(nextProvider);
    setConnectionId(nextCredential?.id ?? null);
    setConnectionRevision(nextCredential?.connectionRevision);
    setSavedBaseUrl(nextCredential?.baseUrl);
    setModelSearch((current) =>
      current.provider === nextProvider ? current : { provider: nextProvider, query: "" },
    );
    setModelId(nextModel);
    applyConnectionFields(
      connectionFormFields({
        catalog: nextCatalog,
        provider: nextProvider,
        modelId: nextModel,
        credential: nextCredential,
      }),
    );
    setHeaderRows(null);
    setShowHeaders(false);
    return nextMe;
  }, []);

  const loadBackupModels = useCallback(
    async (expectedMe: MobileMe) => {
      const requestGeneration = ++backupRequestGenerationRef.current;
      const optionSnapshot = backupOptionsSnapshotRef.current;
      const expected = { userId: expectedMe.userId, spaceId: expectedMe.spaceId };
      backupReadyRef.current = false;
      backupLoadingRef.current = true;
      setBackupReady(false);
      setBackupLoading(true);
      setBackupModels([]);
      setSavedBackupModels([]);
      setBackupError(null);
      setBackupNotice(null);
      try {
        const requestContext: ApiRequestContext = await captureApiRequestContext();
        const currentMe = await rpc<MobileMe>("me", {}, { requestContext });
        if (
          !mobileBackupScopeIsCurrent({
            expectedUserId: expected.userId,
            expectedSpaceId: expected.spaceId,
            currentUserId: currentMe.userId,
            currentSpaceId: currentMe.spaceId,
            selectedSpaceId: settingsSelectedSpaceId(),
            requestGeneration,
            currentGeneration: backupRequestGenerationRef.current,
          })
        ) {
          throw new Error(t("Space changed. Reload Models to refresh backup models."));
        }
        const saved = await rpc<ModelBackupChoice[]>("models/backups", {}, { requestContext });
        const liveMe = meRef.current;
        if (
          requestGeneration !== backupRequestGenerationRef.current ||
          !liveMe ||
          !mobileBackupScopeIsCurrent({
            expectedUserId: expected.userId,
            expectedSpaceId: expected.spaceId,
            currentUserId: liveMe.userId,
            currentSpaceId: liveMe.spaceId,
            selectedSpaceId: settingsSelectedSpaceId(),
            requestGeneration,
            currentGeneration: backupRequestGenerationRef.current,
          })
        ) {
          return;
        }
        const snapshot = saved.map((choice) => {
          const revision = choice.modelCredentialId
            ? optionSnapshot.get(backupChoiceKey(choice))?.expectedRevision
            : undefined;
          return reconcileSavedBackupChoice(
            revision === undefined ? { ...choice } : { ...choice, expectedRevision: revision },
          );
        });
        setSavedBackupModels(snapshot);
        setBackupModels(snapshot);
        backupReadyRef.current = true;
        setBackupReady(true);
      } catch (err) {
        if (requestGeneration !== backupRequestGenerationRef.current) return;
        backupReadyRef.current = false;
        setBackupReady(false);
        setBackupError(err instanceof Error ? err.message : t("Could not load backup models"));
      } finally {
        if (requestGeneration === backupRequestGenerationRef.current) {
          backupLoadingRef.current = false;
          setBackupLoading(false);
        }
      }
    },
    [reconcileSavedBackupChoice, t],
  );

  useFocusEffect(
    useCallback(() => {
      void load()
        .then((nextMe) => (nextMe ? loadBackupModels(nextMe) : undefined))
        .catch((err: unknown) =>
          publishFeedback("connection", {
            error: errorText(err, t("Could not load model settings")),
          }),
        )
        .finally(() => setLoading(false));
      return () => {
        modelRequestGenerationRef.current += 1;
        selectionRevisionRef.current += 1;
        backupRequestGenerationRef.current += 1;
        savedBackupOptionsRef.current.clear();
        savedBackupOwnerRef.current = null;
        backupReadyRef.current = false;
        backupLoadingRef.current = true;
        backupSavingRef.current = false;
        setBackupModels([]);
        setSavedBackupModels([]);
        setBackupReady(false);
        setBackupLoading(true);
        setBackupSaving(false);
        setBackupError(null);
        setBackupNotice(null);
        modelProbe.invalidate();
        cancelOAuth();
      };
    }, [cancelOAuth, load, loadBackupModels]),
  );

  const groups = useMemo(() => {
    const grouped = new Map<string, MobileModel[]>();
    for (const entry of catalog) {
      const entries = grouped.get(entry.provider) ?? [];
      entries.push(entry);
      grouped.set(entry.provider, entries);
    }
    return [...grouped].map(([id, entries]) => ({
      id,
      name: entries[0]?.providerName ?? id,
      entries,
    }));
  }, [catalog]);
  const featuredProviders = useMemo(
    () =>
      featuredModelProviders(
        groups.map((group) => group.entries[0]!),
        provider,
      ),
    [groups, provider],
  );
  const connectedProviderIds = useMemo(
    () => new Set(credentials.map((entry) => canonicalPiProviderId(entry.provider))),
    [credentials],
  );
  const credentialByProvider = useMemo(
    () => new Map(credentials.map((entry) => [canonicalPiProviderId(entry.provider), entry])),
    [credentials],
  );
  const backupOptions = useMemo(
    () => connectedBackupOptions(catalog, credentials),
    [catalog, credentials],
  );
  const backupOptionByKey = useMemo(
    () => new Map(backupOptions.map((option) => [backupChoiceKey(option), option])),
    [backupOptions],
  );
  const currentBackupKeys = new Set(backupModels.map(backupChoiceKey));
  const addableBackupOptions = backupOptions.filter(
    (option) => !currentBackupKeys.has(backupChoiceKey(option)),
  );
  const backupDirty = !sameBackupChoices(savedBackupModels, backupModels);
  const backupLocked = !backupReady || backupLoading || backupSaving;
  // Connected providers always get their own top section; the rest follow the
  // curated order (featured first, everything behind "Show more").
  const connectedGroups = useMemo(
    () => groups.filter((group) => connectedProviderIds.has(canonicalPiProviderId(group.id))),
    [groups, connectedProviderIds],
  );
  const otherGroups = useMemo(() => {
    const list = showAllProviders
      ? groups
      : (() => {
          const byId = new Map(groups.map((group) => [group.id, group]));
          return featuredProviders
            .map((entry) => byId.get(entry.provider))
            .filter((group): group is (typeof groups)[number] => group !== undefined);
        })();
    return list.filter((group) => !connectedProviderIds.has(canonicalPiProviderId(group.id)));
  }, [groups, featuredProviders, showAllProviders, connectedProviderIds]);
  const modelsForProvider = catalog.filter(
    (entry) => canonicalPiProviderId(entry.provider) === canonicalPiProviderId(provider ?? ""),
  );
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const showModelSearch = modelsForProvider.length > MODEL_SEARCH_THRESHOLD;
  // Hide a query typed for another provider until load()/chooseProvider clears it.
  const modelQuery = modelSearch.provider === provider ? modelSearch.query : "";
  const matchedModels = showModelSearch
    ? filterModelCatalog(modelsForProvider, modelQuery)
    : modelsForProvider;
  // Use and Save still apply to the staged model, so its radio stays visible.
  const stagedModelHidden =
    showModelSearch &&
    selected !== undefined &&
    modelQuery.trim().length > 0 &&
    !matchedModels.some((entry) => entry.id === selected.id);
  const visibleModels =
    stagedModelHidden && selected ? [selected, ...matchedModels] : matchedModels;
  const noModelMatches = showModelSearch && matchedModels.length === 0;

  // The search field keeps focus, so tell screen readers once when the results run out.
  useEffect(() => {
    if (noModelMatches) AccessibilityInfo.announceForAccessibility(t("No matching models"));
  }, [noModelMatches, t]);
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const isCloudflareGateway = provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
  const cloudflareRoutingReady =
    !isCloudflareGateway || cloudflareGatewayRouting({ accountId, gatewayId }) !== undefined;
  const credential = credentials.find(
    (entry) =>
      canonicalPiProviderId(entry.provider) === canonicalPiProviderId(provider ?? "") &&
      entry.id === connectionId,
  );
  const providerConnections = credentials.filter(
    (entry) => canonicalPiProviderId(entry.provider) === canonicalPiProviderId(provider ?? ""),
  );
  const connectionReferences = references.filter(
    (entry) => entry.modelCredentialId === connectionId,
  );
  const blockingConnectionReferences = connectionReferences.filter(
    (entry) => entry.kind !== "space-default",
  );
  const unresolvedReferences = references.filter((entry) => entry.unresolved);
  const currentEntry = catalog.find(
    (entry) =>
      canonicalPiProviderId(entry.provider) === canonicalPiProviderId(me?.defaultProvider ?? "") &&
      entry.id === me?.defaultModel,
  );
  const activeCredential = credentials.find((entry) => entry.isDefault);
  // The banner shows the effective effort — stored level or the runtime
  // default — only when the active model can actually think.
  const activeThinkingLabel =
    (currentEntry?.thinkingLevels ?? []).some((level) => level !== "off") ||
    activeCredential?.reasoning
      ? thinkingLevelLabel(activeCredential?.thinkingLevel ?? "medium", t)
      : null;
  const compatibleRows = compatibleModelRows(
    savedCompatibleModelIds(credential, baseUrl),
    enabledModelIds,
    probeModels,
  );
  const isActive =
    canonicalPiProviderId(me?.defaultProvider ?? "") ===
      canonicalPiProviderId(selected?.provider ?? "") &&
    me?.defaultModel === (isOpenAiCompatible ? modelId.trim() : selected?.id) &&
    (!isOpenAiCompatible || credential?.isDefault === true);
  // Space still bills the host while this provider matches; model id alone is not credentials.
  const usingServerCredentials =
    canonicalPiProviderId(provider) === canonicalPiProviderId(me?.hostCredentialProvider ?? "");
  const acceptsKey = selected?.auth !== "oauth";
  const subscriptionSignIn = selected?.signIn !== undefined;
  // Effort levels for the staged catalog model — "off" stays out, matching the
  // model settings and per-bot Thinking pickers.
  const catalogThinkingLevels =
    !isOpenAiCompatible && selected
      ? (selected.thinkingLevels ?? []).filter((level) => level !== "off")
      : [];
  const reasoningEffortValue = thinkingLevel ? thinkingLevelLabel(thinkingLevel, t) : t("Default");
  const catalogThinkingValue = thinkingLevel
    ? thinkingLevelLabel(thinkingLevel, t)
    : t("Default ({level})", { level: thinkingLevelLabel("medium", t) });
  const selectedStoredLevel =
    !isOpenAiCompatible && credential?.modelId === selected?.id
      ? (credential?.thinkingLevel ?? null)
      : null;
  const thinkingDirty = !isOpenAiCompatible && (thinkingLevel ?? null) !== selectedStoredLevel;
  const busy = pending !== null || oauthPending;
  busyRef.current = busy;
  const effectiveBaseUrl = baseUrl.trim();
  const openAiCompatibleReady = compatibleConnectionReady({
    baseUrl: effectiveBaseUrl,
    modelId,
    apiProtocol,
    headerRows,
  });
  const builtinLimitSave =
    !isOpenAiCompatible &&
    provider !== "chatgpt-plan" &&
    Boolean(credential) &&
    apiKey.trim().length === 0;

  function applyConnectionFields(fields: ReturnType<typeof connectionFormFields>) {
    setEnabledModelIds(fields.enabledModelIds);
    setBaseUrl(fields.baseUrl);
    setApiProtocol(fields.apiProtocol);
    setReasoning(fields.reasoning);
    setThinkingLevel(fields.thinkingLevel);
    setMaxTokens(fields.maxTokens);
    setContextWindow(fields.contextWindow);
    setSupportsImages(fields.supportsImages);
    setMaxImagesPerPrompt(fields.maxImagesPerPrompt);
    setAccountId(fields.accountId);
    setGatewayId(fields.gatewayId);
  }

  function updateApiProtocol(value: string) {
    if (busyRef.current) return;
    const parsed = ModelApiProtocolSchema.safeParse(value);
    const next = parsed.success ? parsed.data : "";
    selectionRevisionRef.current += 1;
    setApiProtocol(next);
    setThinkingLevel(
      (current) =>
        clampCatalogThinkingLevel(
          current,
          reasoning ? compatibleThinkingLevels(next) : [],
        ) as ThinkingLevel | null,
    );
    resetOpenAiCompatibleProbe();
    clearFeedback();
  }

  function updateHeaderRows(rows: ModelHeaderRow[]) {
    if (busyRef.current) return;
    selectionRevisionRef.current += 1;
    setHeaderRows(rows);
    resetOpenAiCompatibleProbe();
    clearFeedback();
  }

  function updateBaseUrl(nextBaseUrl: string) {
    selectionRevisionRef.current += 1;
    if (!sameOpenAiCompatibleBaseUrl(baseUrl, nextBaseUrl)) {
      setApiKey("");
      setHeaderRows([]);
      // A new endpoint starts with no ticks; the saved endpoint gets its saved list back.
      setEnabledModelIds(savedCompatibleModelIds(credential, nextBaseUrl));
    }
    setBaseUrl(nextBaseUrl);
    resetOpenAiCompatibleProbe();
    clearFeedback();
  }

  function updateApiKey(nextApiKey: string) {
    selectionRevisionRef.current += 1;
    setApiKey(nextApiKey);
    resetOpenAiCompatibleProbe();
  }

  function chooseProvider(nextProvider: string, nextConnectionId?: string | null) {
    selectionRevisionRef.current += 1;
    cancelOAuth();
    const nextCredential =
      nextConnectionId === null
        ? undefined
        : (credentials.find(
            (entry) =>
              canonicalPiProviderId(entry.provider) === canonicalPiProviderId(nextProvider ?? "") &&
              entry.id === nextConnectionId,
          ) ??
          credentials.find(
            (entry) =>
              canonicalPiProviderId(entry.provider) === canonicalPiProviderId(nextProvider ?? "") &&
              entry.isDefault,
          ) ??
          credentials.find(
            (entry) =>
              canonicalPiProviderId(entry.provider) === canonicalPiProviderId(nextProvider ?? ""),
          ));
    setConnectionId(nextCredential?.id ?? null);
    setConnectionRevision(nextCredential?.connectionRevision);
    setSavedBaseUrl(nextCredential?.baseUrl);
    const nextModelId = connectionFormModelId({
      catalog,
      provider: nextProvider,
      credential: nextCredential,
      defaults: me,
    });
    Keyboard.dismiss();
    setProvider(nextProvider);
    setModelSearch({ provider: nextProvider, query: "" });
    setModelId(nextModelId);
    applyConnectionFields(
      connectionFormFields({
        catalog,
        provider: nextProvider,
        modelId: nextModelId,
        credential: nextCredential,
      }),
    );
    setHeaderRows(null);
    setShowHeaders(false);
    setApiKey("");
    resetOpenAiCompatibleProbe();
    clearFeedback();
  }

  async function probeServerModels() {
    if (!baseUrl.trim()) return;
    if (!ModelApiProtocolSchema.safeParse(apiProtocol).success) {
      publishFeedback("probe", { error: t("Choose an API protocol.") });
      return;
    }
    if (headerRows !== null && !ModelHeaderRowsSchema.safeParse(headerRows).success) {
      publishFeedback("probe", { error: t("Check the custom headers.") });
      return;
    }
    const headers = modelHeadersInput(headerRows);
    const revision = selectionRevisionRef.current;
    const probeScope = {
      spaceGeneration: currentSpaceSelectionGeneration(),
      sessionGeneration: currentSessionGeneration(),
      apiBase: currentApiBase(),
    };
    probeScopeRef.current = probeScope;
    const isCurrent = () =>
      revision === selectionRevisionRef.current &&
      settingsCurrent() &&
      probeScope.spaceGeneration === currentSpaceSelectionGeneration() &&
      probeScope.sessionGeneration === currentSessionGeneration() &&
      probeScope.apiBase === currentApiBase();
    Keyboard.dismiss();
    clearFeedback();
    await modelProbe.probe({
      baseUrl,
      apiKey,
      request: async (input) => {
        const requestContext = await captureApiRequestContext();
        if (!isCurrent()) throw new Error("Model discovery cancelled");
        return rpc<{ models: string[] }>(
          "models/probeOpenAiCompatible",
          {
            ...input,
            apiProtocol: apiProtocol || undefined,
            headers,
            ...(connectionId && sameOpenAiCompatibleBaseUrl(baseUrl, savedBaseUrl)
              ? { credentialId: connectionId, expectedBaseUrl: savedBaseUrl }
              : {}),
          },
          { requestContext },
        );
      },
      onSuccess: (models) => {
        if (!isCurrent()) return;
        const next = modelId.trim() || models[0] || "";
        if (next !== modelId) stageCompatibleModelId(next);
        else setModelId(next);
        publishFeedback("probe", {
          notice:
            models.length === 0
              ? t("Server found. Enter a model name.")
              : models.length === 1
                ? t("Found {count} model.", { count: 1 })
                : t("Found {count} models.", { count: models.length }),
        });
      },
      onError: (err) => {
        if (!isCurrent()) return;
        publishFeedback("probe", {
          error: errorText(err, t("Could not reach this model server")),
        });
      },
    });
  }

  function operationCurrent(
    revision: number,
    scope: MobileMe | null,
    spaceGeneration: number,
    sessionGeneration: number,
    context?: ApiRequestContext,
  ): boolean {
    const liveMe = meRef.current;
    return (
      revision === selectionRevisionRef.current &&
      spaceGeneration === currentSpaceSelectionGeneration() &&
      sessionGeneration === currentSessionGeneration() &&
      liveMe?.userId === scope?.userId &&
      liveMe?.spaceId === scope?.spaceId &&
      settingsCurrent() &&
      (!settingsSelectedSpaceId() || settingsSelectedSpaceId() === scope?.spaceId) &&
      (!context || context.apiBase === currentApiBase())
    );
  }

  async function setModelDefault() {
    const revision = selectionRevisionRef.current;
    const scope = me;
    const spaceGeneration = currentSpaceSelectionGeneration();
    const sessionGeneration = currentSessionGeneration();
    if (!selected || !credential || connectionRevision === undefined) return;
    const activeModelId = isOpenAiCompatible ? modelId.trim() : selected.id;
    if (isOpenAiCompatible && !activeModelId) return;
    Keyboard.dismiss();
    clearFeedback();
    const pendingOwner = beginPending("default");
    try {
      const requestContext = await captureApiRequestContext();
      if (!operationCurrent(revision, scope, spaceGeneration, sessionGeneration, requestContext))
        return;
      await rpc(
        "models/setDefault",
        {
          provider: credential.provider,
          modelId: activeModelId,
          modelCredentialId: credential.id,
          expectedRevision: connectionRevision,
          // Catalog connections keep the space default effort on the preference;
          // openai-compatible still owns its level inside the stored endpoint config.
          ...(!isOpenAiCompatible
            ? {
                thinkingLevel: clampCatalogThinkingLevel(
                  thinkingLevel,
                  selected.thinkingLevels,
                ) as ThinkingLevel | null,
              }
            : {}),
        },
        { requestContext },
      );
      if (!operationCurrent(revision, scope, spaceGeneration, sessionGeneration, requestContext))
        return;
      await load({ provider, modelId: activeModelId, connectionId: connectionId ?? undefined });
      if (!operationCurrent(revision, scope, spaceGeneration, sessionGeneration, requestContext))
        return;
      publishFeedback("model", {
        notice: isOpenAiCompatible
          ? t("Model updated.")
          : t("Now using {label}.", { label: selected.label }),
      });
    } catch (err) {
      if (!operationCurrent(revision, scope, spaceGeneration, sessionGeneration)) return;
      publishFeedback("model", {
        error: errorText(err, t("Could not change the default model")),
      });
    } finally {
      finishPending(pendingOwner);
    }
  }

  async function disconnectCredential() {
    const revision = selectionRevisionRef.current;
    const scope = me;
    const spaceGeneration = currentSpaceSelectionGeneration();
    const sessionGeneration = currentSessionGeneration();
    if (!selected || !credential) return;
    cancelOAuth();
    clearFeedback();
    const pendingOwner = beginPending("disconnect");
    try {
      const requestContext = await captureApiRequestContext();
      if (!operationCurrent(revision, scope, spaceGeneration, sessionGeneration, requestContext))
        return;
      const result = await rpc<{ ok: true; remoteRevocationConfirmed?: boolean }>(
        "models/disconnect",
        {
          provider: credential.provider,
          credentialId: connectionId,
          expectedRevision: connectionRevision,
        },
        { requestContext },
      );
      if (!operationCurrent(revision, scope, spaceGeneration, sessionGeneration, requestContext))
        return;
      setApiKey("");
      setThinkingLevel(null);
      await load({ provider });
      if (!operationCurrent(revision, scope, spaceGeneration, sessionGeneration, requestContext))
        return;
      publishFeedback(
        "connection",
        result.remoteRevocationConfirmed === false
          ? {
              error: t(
                "Disconnected locally. Remote revocation was not confirmed; disconnect the app in ChatGPT settings.",
              ),
            }
          : {
              notice: t("Disconnected {provider}.", {
                provider: selected.providerName ?? selected.provider,
              }),
            },
      );
    } catch (err) {
      if (!operationCurrent(revision, scope, spaceGeneration, sessionGeneration)) return;
      publishFeedback("connection", {
        error: errorText(err, t("Could not disconnect this provider")),
      });
    } finally {
      finishPending(pendingOwner);
    }
  }

  function stageCompatibleModelId(nextModelId: string) {
    selectionRevisionRef.current += 1;
    setModelId(nextModelId);
    setThinkingLevel(
      clampCatalogThinkingLevel(
        credential?.modelId === nextModelId ? credential.thinkingLevel : null,
        reasoning ? compatibleThinkingLevels(apiProtocol) : [],
      ) as ThinkingLevel | null,
    );
  }

  async function connectKey() {
    const revision = selectionRevisionRef.current;
    const scope = me;
    const spaceGeneration = currentSpaceSelectionGeneration();
    const sessionGeneration = currentSessionGeneration();
    if (!selected) return;
    const request = modelConnectRequest({
      form: {
        apiKey,
        modelId,
        enabledModelIds,
        baseUrl,
        apiProtocol,
        headerRows,
        reasoning,
        thinkingLevel,
        maxTokens,
        contextWindow,
        supportsImages,
        maxImagesPerPrompt,
        accountId,
        gatewayId,
      },
      selected,
      credential,
      credentialId: connectionId,
      expectedRevision: connectionRevision,
    });
    if (request.status === "incomplete") return;
    Keyboard.dismiss();
    clearFeedback();
    if (request.status === "invalid") {
      publishFeedback("connection", {
        error:
          request.field === "maxTokens"
            ? t("Enter a whole number from 1 to {max} for maximum output tokens.", {
                max: MAX_MODEL_MAX_TOKENS,
              })
            : request.field === "contextWindow"
              ? t("Enter a whole number from 1 to {max} for the context limit.", {
                  max: MAX_MODEL_CONTEXT_WINDOW,
                })
              : request.field === "maxImagesPerPrompt"
                ? t("Enter a whole number from 1 to 1000 for the image limit.")
                : request.field === "outputRoom"
                  ? t("Maximum output tokens must be smaller than the context limit.")
                  : request.field === "apiProtocol"
                    ? t("Choose an API protocol.")
                    : request.field === "headers"
                      ? t("Check the custom headers.")
                      : t("Reload this connection before saving."),
      });
      return;
    }
    const { savingLimitOnly } = request;
    const pendingOwner = beginPending("connect");
    try {
      const requestContext = await captureApiRequestContext();
      if (!operationCurrent(revision, scope, spaceGeneration, sessionGeneration, requestContext))
        return;
      const savedConnection = await rpc<MobileModelCredential>("models/connect", request.input, {
        requestContext,
      });
      if (!operationCurrent(revision, scope, spaceGeneration, sessionGeneration, requestContext))
        return;
      acceptSavedBackupConnection(savedConnection);
      setApiKey("");
      setHeaderRows(null);
      await load({ provider, modelId, connectionId: savedConnection.id });
      if (!operationCurrent(revision, scope, spaceGeneration, sessionGeneration, requestContext))
        return;
      publishFeedback("connection", {
        notice:
          isOpenAiCompatible || savingLimitOnly
            ? t("Saved.")
            : t("Connected and using {label}.", { label: selected.label }),
      });
    } catch (err) {
      if (!operationCurrent(revision, scope, spaceGeneration, sessionGeneration)) return;
      publishFeedback("connection", {
        error: errorText(err, t("Could not connect this provider")),
      });
    } finally {
      finishPending(pendingOwner);
    }
  }

  async function finishSubscriptionSignIn(loginId: string, controller: AbortController) {
    const revision = selectionRevisionRef.current;
    const scope = meRef.current;
    const spaceGeneration = currentSpaceSelectionGeneration();
    const sessionGeneration = currentSessionGeneration();
    const apiBase = currentApiBase();
    const isCurrent = () =>
      !controller.signal.aborted &&
      apiBase === currentApiBase() &&
      operationCurrent(revision, scope, spaceGeneration, sessionGeneration);
    await waitForModelOAuth(loginId, controller.signal, rpc);
    if (!isCurrent()) return;
    const savedConnection = await rpc<MobileModelCredential>(
      "models/finishOAuth",
      { loginId },
      { signal: controller.signal },
    );
    if (!isCurrent()) return;
    oauthLoginIdRef.current = null;
    setOauth(null);
    acceptSavedBackupConnection(savedConnection);
    await load({ provider, modelId, connectionId: savedConnection.id });
    if (!isCurrent()) return;
    publishFeedback("connection", {
      notice: t("Connected and using {label}.", { label: selected?.label ?? t("this model") }),
    });
  }

  async function startSubscriptionSignIn() {
    if (!selected) return;
    const unavailable = modelOAuthUnavailableReason(selected.provider);
    if (unavailable) {
      publishFeedback("connection", { error: t(unavailable) });
      return;
    }
    clearFeedback();
    setOauthPending(true);
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    let waitingForCode = false;
    try {
      const started = await rpc<ModelOAuthBegin>(
        "models/beginOAuth",
        {
          provider: selected.provider,
          modelId: selected.id,
          thinkingLevel: clampCatalogThinkingLevel(
            thinkingLevel,
            selected.thinkingLevels,
          ) as ThinkingLevel | null,
          label: selected.providerName ?? selected.provider,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || !settingsCurrent()) {
        void settings.cancelOAuth(started.loginId).catch(() => undefined);
        return;
      }
      oauthLoginIdRef.current = started.loginId;
      setPasteCode("");
      setOauth(started);
      await Linking.openURL(started.verificationUri);
      waitingForCode = started.mode === "auth-url";
      if (!waitingForCode) await finishSubscriptionSignIn(started.loginId, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      const loginId = oauthLoginIdRef.current;
      oauthLoginIdRef.current = null;
      if (loginId) void settings.cancelOAuth(loginId).catch(() => undefined);
      publishFeedback("connection", {
        error: errorText(err, t("Could not start sign-in")),
      });
      setOauth(null);
    } finally {
      if (!waitingForCode) {
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
    }
  }

  async function submitOAuthCode() {
    if (oauth?.mode !== "auth-url" || oauthCodeSubmittingRef.current) return;
    const controller = oauthAbortRef.current;
    const code = pasteCode.trim();
    if (!controller || !code) return;
    oauthCodeSubmittingRef.current = true;
    setPasteCode("");
    clearFeedback();
    let submitted = false;
    let retryable = false;
    try {
      await rpc(
        "models/submitOAuthCode",
        { loginId: oauth.loginId, code },
        {
          signal: controller.signal,
        },
      );
      submitted = true;
      await finishSubscriptionSignIn(oauth.loginId, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (submitted) {
        oauthLoginIdRef.current = null;
        setOauth(null);
        void settings.cancelOAuth(oauth.loginId).catch(() => undefined);
      } else {
        retryable = true;
        setPasteCode(code);
      }
      publishFeedback("connection", {
        error: errorText(err, t("Could not finish sign-in")),
      });
    } finally {
      oauthCodeSubmittingRef.current = false;
      if (!retryable) {
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
    }
  }

  const feedback = error ? <Text style={styles.error}>{error}</Text> : null;

  function disclosureRow(label: string, expanded: boolean, onPress: () => void) {
    return (
      <View style={styles.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={onPress}
          style={({ pressed }) => [styles.modelRow, styles.singleRow, pressed && styles.pressed]}
        >
          <Text style={styles.modelLabel}>{label}</Text>
          <View style={styles.chevron}>
            <Chevron expanded={expanded} />
          </View>
        </Pressable>
      </View>
    );
  }

  function limitField(
    label: string,
    value: string,
    onChangeText: (next: string) => void,
    maxLength: number,
  ) {
    return (
      <View>
        <Text style={styles.sectionTitle}>{label}</Text>
        <TextInput
          accessibilityLabel={label}
          editable={!busy}
          keyboardType="number-pad"
          maxLength={maxLength}
          onChangeText={(next) => {
            selectionRevisionRef.current += 1;
            onChangeText(next);
          }}
          style={styles.keyInput}
          value={value}
        />
      </View>
    );
  }

  const compatConfig = isOpenAiCompatible ? (
    <>
      <MenuPicker
        label={t("Connection")}
        value={connectionId ?? ""}
        choices={[
          ...(connectionId && !providerConnections.some((entry) => entry.id === connectionId)
            ? [{ key: connectionId, label: t("Unavailable connection") }]
            : []),
          ...providerConnections.map((entry) => ({
            key: entry.id,
            label: modelConnectionLabel(entry),
          })),
          { key: "", label: t("New connection") },
        ]}
        onChange={(value) => chooseProvider(provider, value || null)}
      />
      {connectionReferences.length ? (
        <View style={{ gap: 4 }}>
          <Text style={styles.sectionTitle}>{t("Used by")}</Text>
          {connectionReferences.map((entry) => (
            <Text style={styles.secondary} key={`${entry.kind}:${entry.id}:${entry.spaceId}`}>
              {entry.name}
              {entry.modelId ? ` · ${entry.modelId}` : ""}
            </Text>
          ))}
        </View>
      ) : null}
      <Text style={styles.sectionTitle}>{t("Server URL")}</Text>
      <TextInput
        accessibilityLabel={t("OpenAI-compatible server URL")}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        onChangeText={updateBaseUrl}
        placeholder={t("http://127.0.0.1:8000/v1")}
        placeholderTextColor={native.tertiaryLabel}
        style={styles.keyInput}
        value={baseUrl}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("API protocol")}
        accessibilityValue={{
          text:
            apiProtocol === "chat-completions"
              ? "Chat Completions"
              : apiProtocol === "responses"
                ? "Responses"
                : apiProtocol === "anthropic-messages"
                  ? "Anthropic Messages"
                  : t("Choose a protocol"),
        }}
        disabled={busy}
        onPress={() => {
          if (busyRef.current) return;
          const revision = selectionRevisionRef.current;
          const scope = me;
          const spaceGeneration = currentSpaceSelectionGeneration();
          const sessionGeneration = currentSessionGeneration();
          const apiBase = currentApiBase();
          const choose = (protocol: ModelApiProtocol) => {
            if (
              apiBase === currentApiBase() &&
              operationCurrent(revision, scope, spaceGeneration, sessionGeneration)
            )
              updateApiProtocol(protocol);
          };
          presentMessageActionSheet({
            title: t("API protocol"),
            cancel: t("Cancel"),
            more: t("More"),
            colorScheme,
            actions: [
              { text: "Chat Completions", onPress: () => choose("chat-completions") },
              { text: "Responses", onPress: () => choose("responses") },
              {
                text: "Anthropic Messages",
                onPress: () => choose("anthropic-messages"),
              },
            ],
          });
        }}
        style={({ pressed }) => [
          styles.modelRow,
          busy && styles.disabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.modelLabel}>{t("API protocol")}</Text>
        <Text style={styles.rowValue}>
          {apiProtocol === "chat-completions"
            ? "Chat Completions"
            : apiProtocol === "responses"
              ? "Responses"
              : apiProtocol === "anthropic-messages"
                ? "Anthropic Messages"
                : t("Choose a protocol")}
        </Text>
      </Pressable>
      {renderCompatKeyFields()}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: showEndpointHelp }}
        onPress={() => setShowEndpointHelp((visible) => !visible)}
        style={({ pressed }) => [pressed && styles.pressed]}
      >
        <Text style={styles.textAction}>{t("Setup help")}</Text>
      </Pressable>
      {showEndpointHelp ? (
        <Text style={styles.hint}>{t(OPENAI_COMPATIBLE_BASE_URL_HINT)}</Text>
      ) : null}
      <NativeActionButton
        disabled={busy || probing || !effectiveBaseUrl}
        fill
        label={probing ? t("Finding…") : t("Find models")}
        onPress={() => void probeServerModels()}
        prominence="secondary"
        style={{ marginTop: 12 }}
      />
      {feedbackAnchor === "probe" ? feedback : null}
      <Text style={[styles.sectionTitle, { marginTop: 12 }]}>{t("Model")}</Text>
      {/* The switches stay visible while the default is "Other model…" or a typed id. */}
      {compatibleRows.length > MODEL_SEARCH_THRESHOLD ? (
        <TextInput
          accessibilityLabel={t("Search models")}
          autoCapitalize="none"
          autoCorrect={false}
          value={modelQuery}
          onChangeText={(query) => setModelSearch({ provider, query })}
          placeholder={t("Search models")}
          placeholderTextColor={native.tertiaryLabel}
          style={styles.keyInput}
        />
      ) : null}
      {compatibleRows.length ? (
        <View style={styles.card}>
          {compatibleRows
            .filter((entry) => !modelQuery.trim() || matchesSearchQuery(modelQuery, entry))
            .map((entry) => (
              // The switch sits beside the radio, not inside it: an accessible
              // Pressable would merge it into the row and hide it from VoiceOver.
              <View key={entry} style={styles.modelRow}>
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected: entry === modelId }}
                  disabled={probing}
                  onPress={() => stageCompatibleModelId(entry)}
                  style={({ pressed }) => [
                    styles.modelRowChoice,
                    probing && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.modelLabel}>{entry}</Text>
                  {entry === modelId ? <Checkmark /> : null}
                </Pressable>
                <NativeSwitch
                  accessibilityLabel={entry}
                  value={entry === modelId || enabledModelIds.includes(entry)}
                  onValueChange={(value) => {
                    selectionRevisionRef.current += 1;
                    setEnabledModelIds((current) => toggleEnabledModelId(current, entry, value));
                  }}
                  disabled={busy || entry === modelId}
                />
              </View>
            ))}
          {compatibleRows.includes(modelId) ? (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: false }}
              disabled={probing}
              onPress={() => stageCompatibleModelId("")}
              style={({ pressed }) => [
                styles.modelRow,
                probing && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.modelLabel}>{t("Other model…")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {compatibleRows.includes(modelId) ? null : (
        <>
          <TextInput
            accessibilityLabel={t("Model id")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy && !probing}
            onChangeText={stageCompatibleModelId}
            placeholder={t("exact-model-id")}
            placeholderTextColor={native.tertiaryLabel}
            style={styles.keyInput}
            value={modelId}
          />
          {probeModels.length ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => stageCompatibleModelId(probeModels[0] ?? "")}
              style={({ pressed }) => [pressed && styles.pressed]}
            >
              <Text style={styles.textAction}>{t("Use a found model")}</Text>
            </Pressable>
          ) : null}
        </>
      )}
      {disclosureRow(t("Advanced"), showAdvanced, () => setShowAdvanced((visible) => !visible))}
      {showAdvanced ? (
        <>
          <View style={styles.card}>
            <View style={styles.modelRow}>
              <Text style={styles.modelLabel}>{t("Supports thinking")}</Text>
              <NativeSwitch
                accessibilityLabel={t("Supports thinking")}
                value={reasoning}
                onValueChange={(value) => {
                  setReasoning(value);
                  if (!value) setThinkingLevel(null);
                }}
                disabled={busy}
              />
            </View>
            {reasoning ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Reasoning effort")}
                accessibilityValue={{ text: reasoningEffortValue }}
                disabled={busy}
                onPress={() => {
                  presentMessageActionSheet({
                    title: t("Reasoning effort"),
                    cancel: t("Cancel"),
                    more: t("More"),
                    colorScheme,
                    actions: [
                      {
                        text: t("Default"),
                        onPress: () => setThinkingLevel(null),
                      },
                      ...compatibleThinkingLevels(apiProtocol).map((level) => ({
                        text: thinkingLevelLabel(level, t),
                        onPress: () => setThinkingLevel(level),
                      })),
                    ],
                  });
                }}
                style={({ pressed }) => [styles.modelRow, pressed && styles.pressed]}
              >
                <Text style={styles.modelLabel}>{t("Reasoning effort")}</Text>
                <Text style={styles.rowValue}>{reasoningEffortValue}</Text>
              </Pressable>
            ) : null}
            <View style={[styles.modelRow, styles.singleRow]}>
              <Text style={styles.modelLabel}>{t("Supports images")}</Text>
              <NativeSwitch
                accessibilityLabel={t("Supports images")}
                value={supportsImages}
                onValueChange={setSupportsImages}
                disabled={busy}
              />
            </View>
          </View>
          {limitField(t("Context limit"), contextWindow, setContextWindow, 7)}
          {limitField(t("Maximum output tokens"), maxTokens, setMaxTokens, 6)}
          {supportsImages
            ? limitField(
                t("Maximum images per request"),
                maxImagesPerPrompt,
                setMaxImagesPerPrompt,
                4,
              )
            : null}
        </>
      ) : null}
    </>
  ) : null;

  const serverCredentialsNote = (
    <Text style={styles.secondary}>
      {t("Uses this server's own {source} credentials to access {provider}.", {
        source: me?.hostCredentialSource ?? "",
        provider: selected?.providerName ?? provider,
      })}
    </Text>
  );

  function renderCompatKeyFields() {
    return isOpenAiCompatible && acceptsKey ? (
      <View style={styles.keySection}>
        {disclosureRow(t("API key"), showApiKey, () => setShowApiKey((visible) => !visible))}
        {showApiKey ? (
          <TextInput
            accessibilityLabel={t("API key")}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={!busy}
            importantForAutofill="no"
            onChangeText={updateApiKey}
            placeholder={credential?.hasKey ? t("Paste a replacement key") : t("Optional")}
            placeholderTextColor={native.tertiaryLabel}
            secureTextEntry
            style={styles.keyInput}
            textContentType="none"
            value={apiKey}
          />
        ) : null}
        {disclosureRow(t("Custom headers"), showHeaders, () =>
          setShowHeaders((visible) => !visible),
        )}
        {showHeaders ? (
          <HeaderRowsEditor
            rows={headerRows}
            savedNames={
              sameOpenAiCompatibleBaseUrl(baseUrl, savedBaseUrl) ? credential?.headerNames : []
            }
            onChange={updateHeaderRows}
            disabled={busy}
          />
        ) : null}
      </View>
    ) : null;
  }

  const compatKeySection =
    isOpenAiCompatible && acceptsKey ? (
      <View style={styles.keySection}>
        <NativeActionButton
          disabled={
            busy || (isOpenAiCompatible ? !openAiCompatibleReady : apiKey.trim().length < 8)
          }
          label={
            pending === "connect"
              ? t("Saving…")
              : isOpenAiCompatible
                ? t("Save")
                : credential
                  ? t("Replace API key")
                  : t("Connect API key")
          }
          onPress={() => void connectKey()}
          style={{ marginTop: 12 }}
        />
      </View>
    ) : null;

  const catalogModelCard =
    !isOpenAiCompatible && selected && !(provider === "chatgpt-plan" && selected.placeholder) ? (
      <>
        {showModelSearch ? (
          <TextInput
            accessibilityLabel={t("Search models")}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(query) => setModelSearch({ provider, query })}
            placeholder={t("Search")}
            placeholderTextColor={native.tertiaryLabel}
            returnKeyType="search"
            style={styles.keyInput}
            value={modelQuery}
          />
        ) : null}
        <View style={styles.card}>
          {visibleModels.map((entry, index) => (
            <Fragment key={`${entry.provider}:${entry.id}`}>
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: entry.id === selected.id }}
                onPress={() => {
                  Keyboard.dismiss();
                  cancelOAuth();
                  setModelId(entry.id);
                  setThinkingLevel(
                    clampCatalogThinkingLevel(
                      entry.id === credential?.modelId ? credential?.thinkingLevel : null,
                      entry.thinkingLevels,
                    ) as ThinkingLevel | null,
                  );
                  clearFeedback();
                }}
                style={({ pressed }) => [styles.modelRow, pressed && styles.pressed]}
              >
                <Text style={styles.modelLabel}>{entry.label}</Text>
                {entry.id === selected.id ? <Checkmark /> : null}
              </Pressable>
              {stagedModelHidden && noModelMatches && index === 0 ? (
                <View style={styles.modelRow}>
                  <Text style={[styles.modelLabel, styles.mutedLabel]}>
                    {t("No matching models")}
                  </Text>
                </View>
              ) : null}
            </Fragment>
          ))}
          {!stagedModelHidden && noModelMatches ? (
            <View style={styles.modelRow}>
              <Text style={[styles.modelLabel, styles.mutedLabel]}>{t("No matching models")}</Text>
            </View>
          ) : null}
          {catalogThinkingLevels.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Thinking")}
              accessibilityValue={{ text: catalogThinkingValue }}
              disabled={busy}
              onPress={() => {
                presentMessageActionSheet({
                  title: t("Thinking"),
                  cancel: t("Cancel"),
                  more: t("More"),
                  colorScheme,
                  actions: [
                    {
                      text: t("Default ({level})", {
                        level: thinkingLevelLabel("medium", t),
                      }),
                      onPress: () => setThinkingLevel(null),
                    },
                    ...catalogThinkingLevels.map((level) => ({
                      text: thinkingLevelLabel(level, t),
                      onPress: () => setThinkingLevel(level),
                    })),
                  ],
                });
              }}
              style={({ pressed }) => [
                styles.modelRow,
                styles.singleRow,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.modelLabel}>{t("Thinking")}</Text>
              <Text style={styles.rowValue}>{catalogThinkingValue}</Text>
            </Pressable>
          ) : null}
        </View>
        {provider !== "chatgpt-plan"
          ? disclosureRow(t("Advanced"), showAdvanced, () => setShowAdvanced((visible) => !visible))
          : null}
        {showAdvanced && provider !== "chatgpt-plan"
          ? limitField(t("Maximum output tokens"), maxTokens, setMaxTokens, 6)
          : null}
      </>
    ) : null;

  const chatgptUsageControl =
    selected?.provider === "chatgpt-plan" ? (
      <NativeActionButton
        label={t("Manage usage")}
        fill={false}
        onPress={() => void Linking.openURL(CHATGPT_USAGE_SETTINGS_URL)}
      />
    ) : null;

  const catalogConnectionControls =
    !isOpenAiCompatible && selected ? (
      <>
        {chatgptUsageControl}
        {subscriptionSignIn && modelOAuthUnavailableReason(selected.provider) ? (
          <Text style={styles.secondary}>{t(modelOAuthUnavailableReason(selected.provider)!)}</Text>
        ) : subscriptionSignIn ? (
          oauth ? (
            <View style={styles.oauthCard}>
              {oauth.mode === "auth-url" ? (
                <>
                  <Text style={styles.secondary}>{t("Finish signing in in your browser:")}</Text>
                  <Pressable onPress={() => void Linking.openURL(oauth.verificationUri)}>
                    <Text style={styles.link}>{oauth.verificationUri}</Text>
                  </Pressable>
                  <Text style={styles.secondary}>
                    {t("The final page may not load. Paste its URL or code here.")}
                  </Text>
                  <TextInput
                    accessibilityLabel={t("Authorization code")}
                    value={pasteCode}
                    onChangeText={setPasteCode}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={t("http://localhost:53692/callback?code=…")}
                    placeholderTextColor={native.secondaryLabel}
                    style={[styles.keyInput, styles.nestedInput]}
                  />
                  <NativeActionButton
                    disabled={!pasteCode.trim()}
                    fill
                    label={t("Submit")}
                    onPress={() => void submitOAuthCode()}
                    prominence="secondary"
                    style={{ marginTop: 12 }}
                  />
                  <Text style={styles.secondary}>
                    {t("Waiting for sign-in — the link expires in about {minutes} minutes.", {
                      minutes: Math.ceil(oauth.expiresInSeconds / 60),
                    })}
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.secondary}>
                    {t("A sign-in page opened — enter this code there:")}
                  </Text>
                  <Pressable onPress={() => void Linking.openURL(oauth.verificationUri)}>
                    <Text style={styles.link}>{oauth.verificationUri}</Text>
                  </Pressable>
                  <Text style={styles.code}>{oauth.userCode}</Text>
                  <NativeActionButton
                    fill
                    label={codeCopied ? t("Copied") : t("Copy")}
                    onPress={() => copyOAuthCode(oauth.userCode)}
                    prominence="secondary"
                    style={{ marginTop: 12 }}
                  />
                  <Text style={styles.secondary}>
                    {t("Waiting for sign-in — the code expires in about {minutes} minutes.", {
                      minutes: Math.ceil(oauth.expiresInSeconds / 60),
                    })}
                  </Text>
                </>
              )}
              <NativeActionButton
                fill
                label={t("Cancel")}
                onPress={() => cancelOAuth()}
                prominence="secondary"
                style={{ marginTop: 12 }}
              />
            </View>
          ) : (
            <NativeActionButton
              disabled={busy}
              fill
              label={
                oauthPending
                  ? t("Starting…")
                  : credential
                    ? t("Sign in again")
                    : (selected.oauthLabel ?? t("Sign in"))
              }
              onPress={() => void startSubscriptionSignIn()}
              prominence="secondary"
              style={{ marginTop: 12 }}
            />
          )
        ) : null}
        {acceptsKey || builtinLimitSave ? (
          <View style={styles.keySection}>
            {isCloudflareGateway ? (
              <>
                <Text style={styles.sectionTitle}>{t("Account ID")}</Text>
                <TextInput
                  accessibilityLabel={t("Account ID")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  editable={!busy}
                  onChangeText={setAccountId}
                  style={styles.keyInput}
                  value={accountId}
                />
                <Text style={styles.sectionTitle}>{t("Gateway ID")}</Text>
                <TextInput
                  accessibilityLabel={t("Gateway ID")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  editable={!busy}
                  onChangeText={setGatewayId}
                  style={styles.keyInput}
                  value={gatewayId}
                />
              </>
            ) : null}
            {acceptsKey ? (
              <>
                <Text style={styles.sectionTitle}>
                  {credential
                    ? t("Replace API key")
                    : subscriptionSignIn
                      ? t("Or connect an API key")
                      : t("API key")}
                </Text>
                <TextInput
                  accessibilityLabel={t("API key")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  editable={!busy}
                  importantForAutofill="no"
                  onChangeText={updateApiKey}
                  placeholder={credential?.hasKey ? t("Paste a replacement key") : t("sk-…")}
                  placeholderTextColor={native.tertiaryLabel}
                  secureTextEntry
                  style={styles.keyInput}
                  textContentType="none"
                  value={apiKey}
                />
              </>
            ) : null}

            <NativeActionButton
              disabled={
                busy || !cloudflareRoutingReady || (!builtinLimitSave && apiKey.trim().length < 8)
              }
              label={
                pending === "connect"
                  ? t("Saving…")
                  : builtinLimitSave
                    ? t("Save limits")
                    : credential
                      ? t("Replace API key")
                      : t("Connect API key")
              }
              onPress={() => void connectKey()}
              style={{ marginTop: 12 }}
            />
          </View>
        ) : null}
        {selected.auth === "oauth" && !subscriptionSignIn ? (
          <Text style={styles.secondary}>
            {t(
              "This subscription sign-in is not available in CogineBot yet. Use a deployment credential or choose another provider.",
            )}
          </Text>
        ) : null}
      </>
    ) : null;

  function addBackupChoice(choice: ModelBackupChoice) {
    if (backupLoadingRef.current || !backupReadyRef.current || backupSavingRef.current) return;
    setBackupModels((current) => {
      if (
        backupLoadingRef.current ||
        !backupReadyRef.current ||
        backupSavingRef.current ||
        current.length >= MAX_MODEL_BACKUPS ||
        current.some((entry) => backupChoiceKey(entry) === backupChoiceKey(choice))
      ) {
        return current;
      }
      return [
        ...current,
        reconcileSavedBackupChoice({
          provider: choice.provider,
          modelId: choice.modelId,
          modelCredentialId: choice.modelCredentialId,
          expectedRevision: choice.expectedRevision,
        }),
      ];
    });
    setBackupError(null);
    setBackupNotice(null);
  }

  function openBackupModelPicker() {
    if (
      backupLoadingRef.current ||
      !backupReadyRef.current ||
      backupSavingRef.current ||
      backupModels.length >= MAX_MODEL_BACKUPS
    )
      return;
    const owner = meRef.current;
    const generation = backupRequestGenerationRef.current;
    const spaceGeneration = currentSpaceSelectionGeneration();
    const sessionGeneration = currentSessionGeneration();
    const apiBase = currentApiBase();
    presentMessageActionSheet({
      title: t("Add connected model"),
      actions: addableBackupOptions.map((option) => ({
        text: `${option.providerName} · ${option.label}`,
        onPress: () => {
          if (
            !owner ||
            generation !== backupRequestGenerationRef.current ||
            spaceGeneration !== currentSpaceSelectionGeneration() ||
            sessionGeneration !== currentSessionGeneration() ||
            apiBase !== currentApiBase() ||
            owner.userId !== meRef.current?.userId ||
            owner.spaceId !== meRef.current?.spaceId ||
            !settingsCurrent() ||
            (settingsSelectedSpaceId() !== null && settingsSelectedSpaceId() !== owner.spaceId)
          )
            return;
          addBackupChoice({
            provider: option.provider,
            modelId: option.modelId,
            modelCredentialId: option.modelCredentialId,
            expectedRevision: option.expectedRevision,
          });
        },
      })),
      colorScheme,
      cancel: t("Cancel"),
      more: t("More"),
    });
  }

  function backupRowLabel(choice: ModelBackupChoice) {
    const option = backupOptionByKey.get(backupChoiceKey(choice));
    const entry = catalog.find(
      (candidate) => candidate.provider === choice.provider && candidate.id === choice.modelId,
    );
    const providerName = option?.providerName ?? entry?.providerName ?? choice.provider;
    const label = option?.label ?? entry?.label ?? choice.modelId;
    return { label: `${providerName} · ${label}`, connected: Boolean(option) };
  }

  async function saveBackupModels() {
    if (
      !me ||
      !backupDirty ||
      backupLoadingRef.current ||
      !backupReadyRef.current ||
      backupSavingRef.current
    )
      return;
    const expected = { userId: me.userId, spaceId: me.spaceId };
    const requestGeneration = backupRequestGenerationRef.current;
    const choices = backupModels.map((choice) => ({ ...choice }));
    backupSavingRef.current = true;
    setBackupSaving(true);
    setBackupError(null);
    setBackupNotice(null);
    try {
      const requestContext: ApiRequestContext = await captureApiRequestContext();
      const currentMe = await rpc<MobileMe>("me", {}, { requestContext });
      if (
        !mobileBackupScopeIsCurrent({
          expectedUserId: expected.userId,
          expectedSpaceId: expected.spaceId,
          currentUserId: currentMe.userId,
          currentSpaceId: currentMe.spaceId,
          selectedSpaceId: settingsSelectedSpaceId(),
          requestGeneration,
          currentGeneration: backupRequestGenerationRef.current,
        })
      ) {
        throw new Error(t("Space changed. Reload Models before saving backups."));
      }
      await rpc("models/setBackups", choices, { requestContext });
      const liveMe = meRef.current;
      if (
        !liveMe ||
        !mobileBackupScopeIsCurrent({
          expectedUserId: expected.userId,
          expectedSpaceId: expected.spaceId,
          currentUserId: liveMe.userId,
          currentSpaceId: liveMe.spaceId,
          selectedSpaceId: settingsSelectedSpaceId(),
          requestGeneration,
          currentGeneration: backupRequestGenerationRef.current,
        })
      ) {
        return;
      }
      setSavedBackupModels(choices.map(reconcileSavedBackupChoice));
      setBackupNotice(t("Backup models saved."));
    } catch (err) {
      if (requestGeneration !== backupRequestGenerationRef.current) return;
      setBackupError(err instanceof Error ? err.message : t("Could not save backup models"));
    } finally {
      if (requestGeneration === backupRequestGenerationRef.current) {
        backupSavingRef.current = false;
        setBackupSaving(false);
      }
    }
  }

  const unresolvedModels = unresolvedReferences.length ? (
    <View style={{ gap: 4 }}>
      <Text style={styles.sectionTitle}>{t("Choose a connection for saved models")}</Text>
      {unresolvedReferences.map((entry) => (
        <Text style={styles.secondary} key={`${entry.kind}:${entry.id}:${entry.spaceId}`}>
          {entry.name}
          {entry.modelId ? ` · ${entry.modelId}` : ""}
        </Text>
      ))}
    </View>
  ) : null;

  const saveRow =
    credential && (!isActive || thinkingDirty || usingServerCredentials) ? (
      <NativeActionButton
        disabled={
          busy ||
          (isOpenAiCompatible &&
            (!modelId.trim() ||
              !canUseCompatibleModelAsDefault(credential.enabledModelIds, modelId.trim())))
        }
        label={
          pending === "default"
            ? t("Switching…")
            : isActive && !usingServerCredentials
              ? t("Save")
              : t("Use this model")
        }
        onPress={() => void setModelDefault()}
        style={{ marginTop: 12 }}
      />
    ) : null;

  const connectedStatusRow = credential ? (
    <View style={styles.statusRow}>
      <View style={styles.providerCopy}>
        <Text style={styles.providerName}>
          {t("Connected · {label}", { label: credential.label })}
        </Text>
      </View>
      <NativeActionButton
        disabled={busy}
        fill={false}
        label={pending === "disconnect" ? t("Disconnecting…") : t("Disconnect")}
        onPress={() => {
          const name = selected?.providerName ?? selected?.provider ?? "";
          Alert.alert(
            t("Disconnect {name}?", { name }),
            [
              t("This removes the connection from every space."),
              ...connectionReferences.map(
                (entry) => `${entry.name}${entry.modelId ? ` · ${entry.modelId}` : ""}`,
              ),
              ...(blockingConnectionReferences.length
                ? [t("Choose another model for these items before disconnecting.")]
                : []),
            ].join("\n"),
            [
              { text: t("Cancel"), style: "cancel" },
              ...(blockingConnectionReferences.length
                ? []
                : [
                    {
                      text: t("Disconnect"),
                      style: "destructive" as const,
                      onPress: () => void disconnectCredential(),
                    },
                  ]),
            ],
          );
        }}
        prominence="destructive"
      />
    </View>
  ) : null;
  if (loading && catalog.length === 0) {
    return (
      <SafeAreaView edges={["bottom"]} style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      {targetName ? <Stack.Screen options={{ title: `${targetName} · ${t("Models")}` }} /> : null}
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.activeCard}>
          <Text style={styles.eyebrow}>{t("Active model")}</Text>
          <Text style={styles.activeModel}>
            {currentEntry?.label ?? me?.defaultModel ?? t("Deployment default")}
          </Text>
          <Text style={styles.secondary}>
            {currentEntry?.providerName ?? me?.defaultProvider ?? t("Configured by deployment")}
            {activeThinkingLabel
              ? ` · ${t("Thinking: {level}", { level: activeThinkingLabel })}`
              : ""}
          </Text>
        </View>

        <Text style={styles.sectionTitle}>{t("Providers")}</Text>
        <View style={styles.card}>
          {connectedGroups.length ? (
            <>
              <Text style={styles.groupLabel}>{t("Connected")}</Text>
              {connectedGroups.map((group) => {
                const groupCredential = credentialByProvider.get(canonicalPiProviderId(group.id));
                const isSelected =
                  canonicalPiProviderId(group.id) === canonicalPiProviderId(provider ?? "");
                const savedModelLabel = groupCredential?.modelId
                  ? (group.entries.find((entry) => entry.id === groupCredential.modelId)?.label ??
                    groupCredential.modelId)
                  : null;
                return (
                  <Pressable
                    key={group.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => chooseProvider(group.id)}
                    style={({ pressed }) => [styles.providerRow, pressed && styles.pressed]}
                  >
                    <View style={styles.providerCopy}>
                      <Text style={styles.providerName}>{group.name}</Text>
                      {savedModelLabel ? (
                        <Text style={styles.secondary}>{savedModelLabel}</Text>
                      ) : null}
                    </View>
                    {isSelected ? <Checkmark /> : null}
                  </Pressable>
                );
              })}
              {otherGroups.length ? (
                <Text style={styles.groupLabel}>{t("All providers")}</Text>
              ) : null}
            </>
          ) : null}
          {otherGroups.map((group) => (
            <Pressable
              key={group.id}
              accessibilityRole="button"
              accessibilityState={{
                selected: canonicalPiProviderId(group.id) === canonicalPiProviderId(provider ?? ""),
              }}
              onPress={() => chooseProvider(group.id)}
              style={({ pressed }) => [styles.providerRow, pressed && styles.pressed]}
            >
              <View style={styles.providerCopy}>
                <Text style={styles.providerName}>{group.name}</Text>
              </View>
              {canonicalPiProviderId(group.id) === canonicalPiProviderId(provider ?? "") ? (
                <Checkmark />
              ) : null}
            </Pressable>
          ))}
          {groups.length > featuredProviders.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showAllProviders }}
              onPress={() => setShowAllProviders((value) => !value)}
              style={styles.providerRow}
            >
              <Text style={styles.providerName}>
                {showAllProviders ? t("Show less") : t("Show more")}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {selected ? (
          isOpenAiCompatible ? (
            <>
              {compatConfig}
              {unresolvedModels}
              {compatKeySection}
              {saveRow}
              {feedbackAnchor === "probe" ? null : feedback}
            </>
          ) : credential ? (
            <>
              {canonicalPiProviderId(provider) ===
              canonicalPiProviderId(me?.hostCredentialProvider ?? "")
                ? serverCredentialsNote
                : null}
              {connectedStatusRow}
              <Text style={styles.sectionTitle}>{t("Model")}</Text>
              {catalogModelCard}
              {saveRow}
              {feedbackAnchor === "model" ? feedback : null}
              <View style={styles.maintenanceSection}>{catalogConnectionControls}</View>
              {feedbackAnchor === "model" ? null : feedback}
            </>
          ) : canonicalPiProviderId(provider) ===
            canonicalPiProviderId(me?.hostCredentialProvider ?? "") ? (
            <>
              {serverCredentialsNote}
              {ownKeyProvider !== provider ? chatgptUsageControl : null}
              {disclosureRow(t("Use your own key"), ownKeyProvider === provider, () =>
                setOwnKeyProvider((current) => (current === provider ? null : provider)),
              )}
              {ownKeyProvider === provider ? (
                <>
                  {catalogConnectionControls}
                  {feedback}
                  <Text style={styles.sectionTitle}>{t("Model")}</Text>
                  {catalogModelCard}
                </>
              ) : null}
            </>
          ) : (
            <>
              {catalogConnectionControls}
              {feedback}
              <Text style={styles.sectionTitle}>{t("Model")}</Text>
              {catalogModelCard}
            </>
          )
        ) : (
          feedback
        )}

        <View style={styles.backupSection}>
          <Text style={styles.backupTitle}>{t("Backup models")}</Text>
          {backupLoading ? (
            <ActivityIndicator color={native.secondaryLabel} />
          ) : backupModels.length ? (
            <View style={styles.backupCard}>
              {backupModels.map((choice, index) => {
                const row = backupRowLabel(choice);
                const key = backupChoiceKey(choice);
                return (
                  <View key={key} style={styles.backupRow}>
                    <View style={styles.backupCopy}>
                      <Text style={styles.backupModelLabel}>
                        {index + 1}. {row.label}
                      </Text>
                      {!row.connected ? (
                        <Text style={styles.backupUnavailable}>{t("Not connected")}</Text>
                      ) : null}
                    </View>
                    <View style={styles.backupActions}>
                      <NativeActionButton
                        accessibilityLabel={t("Move {model} up", { model: row.label })}
                        disabled={index === 0 || backupLocked}
                        onPress={() => {
                          if (
                            backupLoadingRef.current ||
                            !backupReadyRef.current ||
                            backupSavingRef.current
                          )
                            return;
                          setBackupModels((current) =>
                            moveBackupChoice(
                              current,
                              current.findIndex((entry) => backupChoiceKey(entry) === key),
                              -1,
                            ),
                          );
                          setBackupError(null);
                          setBackupNotice(null);
                        }}
                        label="↑"
                        prominence="quiet"
                      />
                      <NativeActionButton
                        accessibilityLabel={t("Move {model} down", { model: row.label })}
                        disabled={index === backupModels.length - 1 || backupLocked}
                        onPress={() => {
                          if (
                            backupLoadingRef.current ||
                            !backupReadyRef.current ||
                            backupSavingRef.current
                          )
                            return;
                          setBackupModels((current) =>
                            moveBackupChoice(
                              current,
                              current.findIndex((entry) => backupChoiceKey(entry) === key),
                              1,
                            ),
                          );
                          setBackupError(null);
                          setBackupNotice(null);
                        }}
                        label="↓"
                        prominence="quiet"
                      />
                      <NativeActionButton
                        accessibilityLabel={t("Remove {model}", { model: row.label })}
                        disabled={backupLocked}
                        onPress={() => {
                          if (
                            backupLoadingRef.current ||
                            !backupReadyRef.current ||
                            backupSavingRef.current
                          )
                            return;
                          setBackupModels((current) =>
                            current.filter((entry) => backupChoiceKey(entry) !== key),
                          );
                          setBackupError(null);
                          setBackupNotice(null);
                        }}
                        label={t("Remove")}
                        prominence="quiet"
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          ) : (
            <Text style={styles.secondary}>
              {addableBackupOptions.length
                ? t("Add connected models to use them as backups.")
                : t("Connect a provider to add backups.")}
            </Text>
          )}
          {backupModels.length >= MAX_MODEL_BACKUPS ? (
            <Text style={styles.backupUnavailable}>{t("Maximum of 10 backup models.")}</Text>
          ) : null}
          <NativeActionButton
            accessibilityLabel={t("Add connected model")}
            disabled={
              backupLocked ||
              backupModels.length >= MAX_MODEL_BACKUPS ||
              addableBackupOptions.length === 0
            }
            onPress={openBackupModelPicker}
            label={t("Add connected model")}
            prominence="secondary"
          />
          <NativeActionButton
            accessibilityLabel={t("Save backups")}
            disabled={!backupDirty || backupLocked}
            onPress={() => void saveBackupModels()}
            label={backupSaving ? t("Saving…") : t("Save backups")}
            prominence="primary"
          />
          {backupError ? (
            <View style={{ gap: 8 }}>
              <Text accessibilityRole="alert" style={styles.error}>
                {backupError}
              </Text>
              {!backupReady && !backupLoading && me ? (
                <NativeActionButton
                  disabled={backupLoading || backupSaving}
                  onPress={() => void loadBackupModels(me)}
                  label={t("Retry")}
                  prominence="secondary"
                />
              ) : null}
            </View>
          ) : null}
          {backupNotice ? (
            <Text accessibilityRole="text" style={styles.secondary}>
              {backupNotice}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function createModelsStyles() {
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
    content: {
      width: "100%",
      padding: 20,
      gap: 12,
      paddingBottom: 40,
    },
    activeCard: {
      borderRadius: 16,
      backgroundColor: native.fill,
      padding: 18,
      marginBottom: 8,
    },
    eyebrow: {
      color: native.tertiaryLabel,
      fontSize: 12,
      textTransform: "uppercase",
      letterSpacing: 1,
    },
    activeModel: {
      color: native.label,
      fontSize: 19,
      fontWeight: "600",
      marginTop: 6,
    },
    secondary: {
      color: native.secondaryLabel,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 4,
    },
    sectionTitle: {
      color: native.secondaryLabel,
      fontSize: 14,
      marginTop: 8,
      marginBottom: 2,
    },
    card: {
      borderRadius: 14,
      backgroundColor: native.fill,
      overflow: "hidden",
    },
    backupSection: {
      gap: 12,
      marginTop: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.fillPressed,
      paddingTop: 14,
    },
    backupTitle: {
      color: native.label,
      fontSize: 16,
      fontWeight: "600",
    },
    backupCard: {
      marginTop: 10,
      borderRadius: 14,
      backgroundColor: native.fill,
      overflow: "hidden",
    },
    backupRow: {
      minHeight: 56,
      paddingHorizontal: 12,
      paddingVertical: 8,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: native.fillPressed,
    },
    backupCopy: {
      flex: 1,
      minWidth: 0,
    },
    backupModelLabel: {
      color: native.label,
      fontSize: 14,
    },
    backupUnavailable: {
      color: native.tertiaryLabel,
      fontSize: 12,
      marginTop: 2,
    },
    backupActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
    },
    providerRow: {
      minHeight: 62,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: native.fillPressed,
    },
    providerCopy: {
      flex: 1,
    },
    providerName: {
      color: native.label,
      fontSize: 16,
      fontWeight: "600",
    },
    groupLabel: {
      color: native.tertiaryLabel,
      fontSize: 12,
      textTransform: "uppercase",
      letterSpacing: 1,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 8,
    },
    statusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginTop: 8,
    },
    maintenanceSection: {
      marginTop: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.fillPressed,
      paddingTop: 8,
    },
    modelRow: {
      minHeight: 54,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: native.fillPressed,
    },
    modelRowChoice: {
      flex: 1,
      alignSelf: "stretch",
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    modelLabel: {
      flex: 1,
      color: native.label,
      fontSize: 15,
    },
    mutedLabel: {
      color: native.secondaryLabel,
    },
    singleRow: {
      borderBottomWidth: 0,
    },
    rowValue: {
      color: native.secondaryLabel,
      fontSize: 15,
    },
    hint: {
      color: native.secondaryLabel,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 4,
    },
    textAction: {
      color: native.secondaryLabel,
      fontSize: 15,
      marginTop: 8,
    },
    chevron: {
      width: 16,
      alignItems: "center",
    },
    oauthCard: {
      borderRadius: 14,
      backgroundColor: native.fill,
      padding: 16,
      marginTop: 8,
    },
    link: {
      color: native.label,
      fontSize: 14,
      textDecorationLine: "underline",
      marginTop: 6,
    },
    code: {
      color: native.label,
      fontFamily: "monospace",
      fontSize: 24,
      letterSpacing: 3,
      marginTop: 10,
      marginBottom: 2,
    },
    nestedInput: {
      // The OAuth card is already a fill; the page color keeps the field visible on it.
      backgroundColor: native.page,
    },
    keySection: {
      marginTop: 4,
    },
    keyInput: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginTop: 4,
      fontSize: 16,
    },
    error: {
      color: tokens.destructive,
      fontSize: 14,
      marginTop: 4,
    },
    disabled: {
      opacity: 0.45,
    },
    pressed: {
      opacity: 0.7,
    },
  });
}
