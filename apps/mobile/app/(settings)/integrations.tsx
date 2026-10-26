import type {
  CapabilityInstall,
  Connection,
  ConnectionCatalogItem,
  NativeAppId,
  NativeBeginInput,
  OpenApiImportConfirmation,
  OpenApiImportPreview,
} from "@rakazo/contracts";
import { Id, NativeAppIdSchema } from "@rakazo/contracts";
import type { ConnectionApp, OpenApiImportReviewState } from "@rakazo/core";
import {
  abortableDelay,
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogAccounts,
  catalogUninstallAccounts,
  connectionAppSummary,
  connectionCatalogKey,
  connectionMatchesCatalog,
  connectionRemovalState,
  createOpenApiImportReview,
  EMPTY_PLUGIN_CATALOG_MESSAGE,
  filterConnectionApps,
  groupConnectionCatalog,
  humanizeToolName,
  preferredConnectionSource,
} from "@rakazo/core";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  BackHandler,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectorIcon } from "../../components/connector-icon";
import { MenuPicker } from "../../components/menu-picker";
import { NativeAccountConnect } from "../../components/native-account-connect";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import { OpenApiImportReview } from "../../components/openapi-import-review";
import { Chevron } from "../../components/row-accessories";
import type { ApiRequestContext } from "../../lib/api";
import { captureApiRequestContext, rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import type { IntegrationsCacheScope, IntegrationsSnapshot } from "../../lib/integrations-cache";
import {
  integrationsCacheScope,
  isIntegrationsScopeCurrent,
  persistedIntegrationsCacheScope,
  readIntegrationsCache,
  writeIntegrationsCache,
} from "../../lib/integrations-cache";
import { loadLastBotId } from "../../lib/last-bot";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  subscribeMobileScope,
} from "../../lib/mobile-scope";
import { native, useThemedStyles } from "../../lib/native";
import { errorText } from "../../lib/user-error";

type SourceKind = "treg" | "executor" | "mcp" | "api" | "graphql";
type ConnectionTool = { name: string; description: string };
type NativeAttempt = {
  controller: AbortController;
  connectionId: string | null;
  requestContext: ApiRequestContext;
  isCurrent: () => boolean;
};

const LOGO_SIZE = 32;

function itemKey(item: Pick<ConnectionCatalogItem, "connectorId" | "slug">) {
  return connectionCatalogKey(item);
}
function sourceLabel(item: Pick<ConnectionCatalogItem, "connectorId">) {
  const labels: Record<string, string> = {
    native: "Cogine",
    composio: "Composio",
    pipedream: "Pipedream",
  };
  return labels[item.connectorId] ?? item.connectorId;
}

export default function Integrations() {
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useI18n();
  const { app, botId, accountOnly } = useLocalSearchParams<{
    app?: string | string[];
    botId?: string | string[];
    accountOnly?: string | string[];
  }>();
  const initialApp = useRef(typeof app === "string" ? app : null);
  const initialBotId = useRef(typeof botId === "string" ? botId : null);
  const initialAppConsumed = useRef(false);
  const sourceCard = useRef<{
    appId: NativeAppId;
    botId: string;
    scope: IntegrationsCacheScope;
  } | null>(null);
  const { width } = useWindowDimensions();
  const catalogColumns = width >= 480 ? 2 : 1;
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [query, setQuery] = useState("");
  const [catalogFilter, setCatalogFilter] = useState<"all" | "connected">("all");
  const [notice, setNotice] = useState<string | null>(null);
  const [unconfirmedRemovalId, setUnconfirmedRemovalId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [sources, setSources] = useState<CapabilityInstall[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [requiresAuth, setRequiresAuth] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceReview, setSourceReview] = useState<OpenApiImportReviewState | null>(null);
  const sourceFormGeneration = useRef(0);
  const sourceImport = useRef<ReturnType<typeof createOpenApiImportReview> | null>(null);
  const sourceAbort = useRef<AbortController | null>(null);
  const sourceInputsLocked =
    !!sourceReview && ["confirming", "pending", "unknown"].includes(sourceReview.phase);
  const [lastBotId, setLastBotId] = useState("");
  const [catalogReady, setCatalogReady] = useState(false);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [detailKey, setDetailKey] = useState<{ connectorId: string; slug: string } | null>(null);
  const [nativeAccount, setNativeAccount] = useState<{
    appId: NativeAppId;
    previous?: Connection;
  } | null>(null);
  const [tools, setTools] = useState<ConnectionTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(true);
  const [toolsTick, setToolsTick] = useState(0);
  const connectionAttempt = useRef<AbortController | null>(null);
  const nativeAttempt = useRef<NativeAttempt | null>(null);

  const cacheScope = useRef<IntegrationsCacheScope | null>(null);
  const snapshot = useRef<IntegrationsSnapshot>({ catalog: [], connections: [] });
  const mounted = useRef(false);
  const focusGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const sourcesGeneration = useRef(0);

  function invalidateSourceReview() {
    sourceFormGeneration.current += 1;
    sourceAbort.current?.abort();
    sourceImport.current = null;
    setSourceReview(null);
    setPending((current) => (current === "source" ? null : current));
  }

  useEffect(
    () =>
      subscribeMobileScope(() => {
        invalidateSourceReview();
        setCredential("");
        setSourceKind(null);
        setSourceError(null);
      }),
    [],
  );

  function applySnapshot(next: IntegrationsSnapshot) {
    snapshot.current = next;
    setCatalog(next.catalog);
    setConnections(next.connections);
    setCatalogReady(true);
    setLabelDrafts((current) =>
      Object.fromEntries(
        next.connections.map((row) => [row.id, current[row.id] ?? row.displayName]),
      ),
    );
  }

  function saveSnapshot(next: IntegrationsSnapshot) {
    const scope = cacheScope.current;
    if (!mounted.current || !scope || !isIntegrationsScopeCurrent(scope)) return;
    // A mutation invalidates any earlier background refresh.
    refreshGeneration.current += 1;
    applySnapshot(next);
    writeIntegrationsCache(scope, next);
  }

  function captureConnectionScope() {
    const scope = cacheScope.current;
    const focus = focusGeneration.current;
    return () => {
      const current = cacheScope.current;
      return (
        !!scope &&
        !!current &&
        mounted.current &&
        focus === focusGeneration.current &&
        isIntegrationsScopeCurrent(scope) &&
        scope.userId === current.userId &&
        scope.spaceId === current.spaceId
      );
    };
  }

  function updateAccount(row: Connection) {
    const connections = [
      ...snapshot.current.connections.filter((entry) => entry.id !== row.id),
      row,
    ];
    saveSnapshot({
      connections,
      catalog: snapshot.current.catalog.map((item) =>
        item.connectorId === row.connectorId && item.slug === row.provider
          ? {
              ...item,
              connected: connections.some(
                (entry) =>
                  entry.connectorId === item.connectorId &&
                  entry.provider === item.slug &&
                  entry.status === "connected",
              ),
            }
          : item,
      ),
    });
  }

  const apps = useMemo(() => groupConnectionCatalog(catalog), [catalog]);
  const catalogApps = filterConnectionApps(apps, query).filter(
    (app) => catalogFilter === "all" || connectionAppSummary(app, connections).isConnected,
  );
  const renderedApps = catalogApps.slice(0, visibleCount);

  const detailItem = useMemo(() => {
    if (!detailKey) return null;
    return (
      catalog.find(
        (entry) => entry.connectorId === detailKey.connectorId && entry.slug === detailKey.slug,
      ) ?? null
    );
  }, [catalog, detailKey]);
  const detailApp = apps.find((app) =>
    app.sources.some(
      (item) =>
        detailKey && item.connectorId === detailKey.connectorId && item.slug === detailKey.slug,
    ),
  );

  function clearStaleScope() {
    if (!cacheScope.current || isIntegrationsScopeCurrent(cacheScope.current)) return;
    invalidateSourceReview();
    cacheScope.current = null;
    setCredential("");
    setSourceKind(null);
    sourceCard.current = null;
    refreshGeneration.current += 1;
    sourcesGeneration.current += 1;
    applySnapshot({ catalog: [], connections: [] });
    setCatalogReady(false);
    setSources([]);
    setDetailKey(null);
    setNativeAccount(null);
    cancelNativeAttempt(false);
    setLabelDrafts({});
    setPending(null);
    setNotice(null);
    setCatalogError(null);
    setUnconfirmedRemovalId(null);
    setToolsError(null);
    connectionAttempt.current?.abort();
  }

  async function refresh() {
    const focus = focusGeneration.current;
    clearStaleScope();
    let scope: IntegrationsCacheScope;
    try {
      scope = await integrationsCacheScope();
    } catch (reason) {
      if (!mounted.current || focus !== focusGeneration.current) return;
      if (cacheScope.current && !isIntegrationsScopeCurrent(cacheScope.current)) {
        clearStaleScope();
        return refresh();
      }
      throw reason;
    }
    if (!mounted.current || focus !== focusGeneration.current) return;
    if (!isIntegrationsScopeCurrent(scope)) {
      clearStaleScope();
      return refresh();
    }
    const previous = cacheScope.current;
    if (previous && (previous.userId !== scope.userId || previous.spaceId !== scope.spaceId)) {
      invalidateSourceReview();
      sourceCard.current = null;
      setCredential("");
      setSourceKind(null);
      applySnapshot({ catalog: [], connections: [] });
      setCatalogReady(false);
      setSources([]);
      setDetailKey(null);
      setNativeAccount(null);
      cancelNativeAttempt(false);
      setLabelDrafts({});
      setNotice(null);
      setCatalogError(null);
      setUnconfirmedRemovalId(null);
    }
    cacheScope.current = scope;
    if (!previous || previous.userId !== scope.userId || previous.spaceId !== scope.spaceId) {
      const cached = readIntegrationsCache(scope);
      if (cached) applySnapshot(cached);
    }
    const generation = ++refreshGeneration.current;
    const sourceGeneration = ++sourcesGeneration.current;
    void rpc<CapabilityInstall[]>("capabilities/list")
      .then((installs) => {
        if (
          mounted.current &&
          isIntegrationsScopeCurrent(scope) &&
          sourceGeneration === sourcesGeneration.current
        ) {
          setSources(
            installs.filter(
              (item) => item.kind === "mcp" || item.kind === "api" || item.kind === "graphql",
            ),
          );
        }
      })
      .catch(() => undefined);
    let next: IntegrationsSnapshot;
    try {
      const [catalog, connections] = await Promise.all([
        rpc<ConnectionCatalogItem[]>("connections/catalog"),
        rpc<Connection[]>("connections/list"),
      ]);
      next = { catalog, connections };
    } catch (reason) {
      if (!mounted.current || focus !== focusGeneration.current) return;
      if (!isIntegrationsScopeCurrent(scope)) return refresh();
      if (generation === refreshGeneration.current) throw reason;
      return;
    }
    if (!mounted.current || focus !== focusGeneration.current) return;
    if (!isIntegrationsScopeCurrent(scope)) return refresh();
    if (generation !== refreshGeneration.current) return;
    applySnapshot(next);
    writeIntegrationsCache(scope, next);
    // A route hint selects only an app in this scope's first live catalog.
    // It never chooses credentials or starts an authorization attempt.
    if (!initialAppConsumed.current) {
      initialAppConsumed.current = true;
      const appId = NativeAppIdSchema.safeParse(initialApp.current);
      if (appId.success) {
        const item = next.catalog.find(
          (entry) => entry.connectorId === "native" && entry.slug === appId.data,
        );
        if (item) {
          const bot = Id.safeParse(initialBotId.current);
          if (bot.success) sourceCard.current = { appId: appId.data, botId: bot.data, scope };
          openDetail(item);
        }
      }
    }
  }

  async function retryRefresh() {
    const focus = focusGeneration.current;
    try {
      await refresh();
      if (mounted.current && focus === focusGeneration.current)
        setCatalogError(
          unconfirmedRemovalId &&
            connectionRemovalState(snapshot.current.connections, unconfirmedRemovalId) === "revoked"
            ? t("Local access stopped · Provider confirmation pending")
            : null,
        );
    } catch (reason) {
      if (
        mounted.current &&
        focus === focusGeneration.current &&
        (!cacheScope.current || isIntegrationsScopeCurrent(cacheScope.current))
      ) {
        setCatalogError(errorText(reason, t("Could not load integrations")));
      }
    }
  }

  useFocusEffect(
    useCallback(() => {
      mounted.current = true;
      focusGeneration.current += 1;
      let cancelled = false;
      clearStaleScope();
      void (async () => {
        const scope = await persistedIntegrationsCacheScope();
        if (cancelled) return;
        if (scope && isIntegrationsScopeCurrent(scope)) {
          cacheScope.current = scope;
          const cached = readIntegrationsCache(scope);
          if (cached) applySnapshot(cached);
        }
        await retryRefresh();
      })();
      void loadLastBotId().then((id) => {
        if (!cancelled) setLastBotId(id);
      });
      return () => {
        cancelled = true;
        invalidateSourceReview();
        mounted.current = false;
        sourceCard.current = null;
        focusGeneration.current += 1;
        refreshGeneration.current += 1;
        sourcesGeneration.current += 1;
        connectionAttempt.current?.abort();
        cancelNativeAttempt(false);
        setNativeAccount(null);
        setPending(null);
      };
    }, []),
  );

  useEffect(() => {
    if (!detailKey) {
      setTools([]);
      setToolsLoading(false);
      return;
    }
    let cancelled = false;
    setToolsLoading(true);
    setToolsError(null);
    void rpc<ConnectionTool[]>("connections/tools", {
      connectorId: detailKey.connectorId,
      provider: detailKey.slug,
    })
      .then((list) => {
        if (!cancelled) setTools(list);
      })
      .catch((reason) => {
        if (!cancelled) {
          setTools([]);
          setToolsError(errorText(reason, t("Could not load tools")));
        }
      })
      .finally(() => {
        if (!cancelled) setToolsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailKey, toolsTick]);

  function closeAdvanced() {
    invalidateSourceReview();
    setAdvancedOpen(false);
    setSourceKind(null);
    setSourceError(null);
    setName("");
    setUrl("");
    setCredential("");
    setRequiresAuth(true);
  }

  function openDetail(item: ConnectionCatalogItem) {
    initialAppConsumed.current = true;
    setNativeAccount(null);
    setCatalogError(null);
    setNotice(null);
    setToolsOpen(true);
    setDetailKey({ connectorId: item.connectorId, slug: item.slug });
  }

  function closeDetail() {
    if (nativeAccount) {
      connectionAttempt.current?.abort();
      cancelNativeAttempt();
      setPending(null);
      setNativeAccount(null);
      return;
    }
    setDetailKey(null);
    setTools([]);
  }

  function accountsFor(item: Pick<ConnectionCatalogItem, "connectorId" | "slug">) {
    return connections.filter(
      (row) =>
        connectionMatchesCatalog(row, item) &&
        (row.status === "connected" || row.status === "pending"),
    );
  }

  function openApp(app: ConnectionApp) {
    const item = preferredConnectionSource(app, connections);
    if (item) openDetail(item);
  }

  async function notifyAppConnected(item: ConnectionCatalogItem, isCurrent: () => boolean) {
    if (accountOnly === "1") return;
    const card = sourceCard.current;
    if (card && item.connectorId === "native" && item.slug === card.appId) {
      if (!isCurrent() || !isIntegrationsScopeCurrent(card.scope)) return;
      try {
        const requestContext = await captureApiRequestContext();
        if (!isCurrent() || !isIntegrationsScopeCurrent(card.scope)) return;
        await rpc(
          "onboarding/appConnected",
          {
            botId: card.botId,
            provider: item.slug,
            connectorId: item.connectorId,
          },
          { requestContext, skipSpaceAuthRecovery: true },
        );
      } catch {
        // A connection remains usable if its conversation card cannot be updated.
      }
      return;
    }
    const botId = lastBotId || (await loadLastBotId());
    if (!botId || !isCurrent()) return;
    if (botId !== lastBotId) setLastBotId(botId);
    void rpc("onboarding/appConnected", {
      botId,
      provider: item.slug,
      connectorId: item.connectorId,
    }).catch(() => undefined);
  }

  function revokeNativeAttempt(attempt: NativeAttempt, report: boolean) {
    const connectionId = attempt.connectionId;
    attempt.connectionId = null;
    if (!connectionId) return;
    // Revoke the new attempt in its captured API/user/Space, never the current selection.
    void rpc(
      "connections/revoke",
      { connectionId },
      { requestContext: attempt.requestContext, skipSpaceAuthRecovery: true },
    )
      .then(async () => {
        if (report && attempt.isCurrent()) await refresh();
      })
      .catch((reason: unknown) => {
        if (report && attempt.isCurrent())
          setCatalogError(
            errorText(reason, t("Could not confirm cancellation. Check the pending account.")),
          );
      });
  }

  function cancelNativeAttempt(report = true) {
    const attempt = nativeAttempt.current;
    if (!attempt) return;
    nativeAttempt.current = null;
    attempt.controller.abort();
    if (connectionAttempt.current === attempt.controller) {
      connectionAttempt.current = null;
      if (report && attempt.isCurrent()) setPending(null);
    }
    revokeNativeAttempt(attempt, report);
  }

  useEffect(() => {
    if (!nativeAccount) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      closeDetail();
      return true;
    });
    return () => subscription.remove();
  }, [nativeAccount]);

  async function connect(
    item: ConnectionCatalogItem,
    previous?: Connection,
    nativeInput?: NativeBeginInput,
  ) {
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    if (item.connectorId === "native" && !nativeInput) {
      const parsed = NativeAppIdSchema.safeParse(item.slug);
      if (!parsed.success) {
        setCatalogError(t("This application is not available for direct connection."));
        return;
      }
      openDetail(item);
      setNativeAccount({ appId: parsed.data, previous });
      return;
    }
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    let requestContext: ApiRequestContext | undefined;
    try {
      requestContext = nativeInput ? await captureApiRequestContext() : undefined;
    } catch (reason) {
      if (connectionAttempt.current === controller) connectionAttempt.current = null;
      if (controller.signal.aborted || !isCurrent()) return;
      throw reason;
    }
    if (!isCurrent() || controller.signal.aborted) {
      if (connectionAttempt.current === controller) connectionAttempt.current = null;
      return;
    }
    const native: NativeAttempt | null = requestContext
      ? { controller, connectionId: null, requestContext, isCurrent }
      : null;
    if (native) nativeAttempt.current = native;
    let nativeStarted = false;
    const key = itemKey(item);
    setPending(key);
    setCatalogError(null);
    setNotice(null);
    try {
      const started = nativeInput
        ? await rpc<{ connectionId: string; authorizationUrl: string | null }>(
            "nativeConnectors/begin",
            nativeInput,
            { requestContext, timeoutMs: 60_000, skipSpaceAuthRecovery: true },
          )
        : await rpc<{ connectionId: string; authorizationUrl: string | null }>(
            "connections/begin",
            {
              connectorId: item.connectorId,
              provider: item.slug,
              ...(previous ? { connectionId: previous.id } : {}),
              displayName: (() => {
                if (previous) return previous.displayName;
                const count = accountsFor(item).filter((row) => row.status === "connected").length;
                return count <= 0 ? item.name : `${item.name} ${count + 1}`;
              })(),
            },
          );
      if (native) {
        nativeStarted = true;
        native.connectionId = started.connectionId;
      }
      if (!isCurrent() || controller.signal.aborted) {
        if (native) revokeNativeAttempt(native, false);
        return;
      }
      const startedRows = await rpc<Connection[]>(
        "connections/list",
        {},
        native ? { requestContext: native.requestContext, skipSpaceAuthRecovery: true } : {},
      ).catch(() => null);
      if (!isCurrent() || controller.signal.aborted) {
        if (native) revokeNativeAttempt(native, false);
        return;
      }
      if (startedRows) saveSnapshot({ ...snapshot.current, connections: startedRows });
      if (started.authorizationUrl) {
        await Linking.openURL(started.authorizationUrl);
        if (native && isCurrent())
          setNotice(
            t("Finish authorization in the browser, then return here to check the result."),
          );
      }
      for (let attempt = 0; attempt < 45; attempt += 1) {
        if (controller.signal.aborted || !isCurrent()) return;
        const row = await (native
          ? rpc<Connection>(
              "connections/complete",
              { connectionId: started.connectionId },
              { requestContext: native.requestContext, skipSpaceAuthRecovery: true },
            )
          : rpc<Connection>("connections/complete", { connectionId: started.connectionId })
        ).catch(() => undefined);
        if (native && (controller.signal.aborted || !isCurrent())) return;
        if (row?.status === "connected") {
          if (controller.signal.aborted || !isCurrent()) return;
          if (native) {
            native.connectionId = null;
            setNativeAccount(null);
            setNotice(null);
          }
          updateAccount(row);
          void notifyAppConnected(item, isCurrent);
          await refresh();
          if (isCurrent()) setToolsTick((tick) => tick + 1);
          return;
        }
        if (row?.status === "error" || row?.status === "revoked") {
          if (native) {
            native.connectionId = null;
            setNativeAccount(null);
            setNotice(null);
          }
          updateAccount(row);
          setCatalogError(t("Authorization did not complete. You can authorize again."));
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (controller.signal.aborted || !isCurrent()) return;
      await refresh().catch(() => undefined);
      if (controller.signal.aborted || !isCurrent()) return;
      if (native) {
        native.connectionId = null;
        setNativeAccount(null);
      }
      Alert.alert(
        t("Connection pending"),
        t("Finish connecting in the browser, then refresh this page."),
      );
    } catch (reason) {
      if (controller.signal.aborted || !isCurrent()) return;
      if (native && !nativeStarted) throw reason;
      if (native) {
        setNativeAccount(null);
        await refresh().catch(() => undefined);
      }
      setCatalogError(errorText(reason, t("Could not connect")));
    } finally {
      if (nativeAttempt.current === native) nativeAttempt.current = null;
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        if (isCurrent()) setPending(null);
      }
    }
  }

  async function checkAccount(row: Connection, item: ConnectionCatalogItem) {
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    setPending(`check:${row.id}`);
    setCatalogError(null);
    setNotice(null);
    try {
      const next = await rpc<Connection>("connections/complete", { connectionId: row.id });
      if (!isCurrent()) return;
      updateAccount(next);
      if (next.status === "connected") void notifyAppConnected(item, isCurrent);
      if (next.status === "pending") setNotice(t("Authorization is still pending."));
      setToolsTick((value) => value + 1);
    } catch (reason) {
      if (isCurrent()) setCatalogError(errorText(reason, t("Could not check connection")));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  async function prepareRemoval(item: ConnectionCatalogItem, account?: Connection) {
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    setCatalogError(null);
    setNotice(null);
    try {
      const rows = await rpc<Connection[]>("connections/list");
      if (!isCurrent()) return;
      saveSnapshot({ ...snapshot.current, connections: rows });
      const targets = account
        ? rows.filter(
            (row) =>
              row.id === account.id &&
              connectionMatchesCatalog(row, item) &&
              row.status !== "revoked",
          )
        : catalogUninstallAccounts(rows, item);
      if (!targets.length) {
        setNotice(t("No connected or pending accounts remain for this source."));
        return;
      }
      const keptErrors =
        !account && catalogAccounts(rows, item).some((row) => row.status === "error");
      Alert.alert(
        account ? t("Disconnect this account?") : t("Uninstall this source?"),
        `${sourceLabel(item)} · ${item.slug}\n${targets.map((row) => row.displayName).join("\n")}${keptErrors ? `\n${t("Accounts that need attention are kept. Manage them individually.")}` : ""}`,
        [
          { text: t("Cancel"), style: "cancel" },
          {
            text: account ? t("Disconnect account") : t("Uninstall source"),
            style: "destructive",
            onPress: () => void runRemoval(item, targets, !!account, isCurrent),
          },
        ],
      );
    } catch (reason) {
      if (isCurrent()) setCatalogError(errorText(reason, t("Could not check connection")));
    }
  }

  async function runRemoval(
    item: ConnectionCatalogItem,
    expected: Connection[],
    single: boolean,
    isCurrent: () => boolean,
  ) {
    if (!isCurrent()) return;
    setPending("remove");
    setCatalogError(null);
    setNotice(null);
    let failedId: string | null = null;
    let failure: unknown;
    try {
      const rows = await rpc<Connection[]>("connections/list");
      if (!isCurrent()) return;
      const targets = single
        ? rows.filter(
            (row) =>
              row.id === expected[0]?.id &&
              connectionMatchesCatalog(row, item) &&
              row.status !== "revoked",
          )
        : catalogUninstallAccounts(rows, item);
      if (
        targets.length !== expected.length ||
        targets.some(
          (row) =>
            !expected.some(
              (old) =>
                old.id === row.id &&
                old.status === row.status &&
                old.remoteAccountId === row.remoteAccountId,
            ),
        )
      ) {
        saveSnapshot({ ...snapshot.current, connections: rows });
        setNotice(t("Accounts changed. Review them before disconnecting."));
        return;
      }
      for (const row of targets) {
        if (!isCurrent()) return;
        try {
          await rpc("connections/revoke", { connectionId: row.id });
        } catch (reason) {
          failedId = row.id;
          failure = reason;
          break;
        }
        if (!isCurrent()) return;
        updateAccount({ ...row, status: "revoked" });
      }
      const remaining = await rpc<Connection[]>("connections/list").catch(() => null);
      if (!isCurrent()) return;
      if (remaining)
        saveSnapshot({
          connections: remaining,
          catalog: snapshot.current.catalog.map((entry) =>
            itemKey(entry) === itemKey(item)
              ? {
                  ...entry,
                  connected: catalogAccounts(remaining, item).some(
                    (row) => row.status === "connected",
                  ),
                }
              : entry,
          ),
        });
      if (failedId) {
        const state = connectionRemovalState(remaining, failedId);
        if (state === "revoked") setUnconfirmedRemovalId(failedId);
        const stopped = expected.filter(
          (row) => connectionRemovalState(remaining, row.id) === "revoked",
        ).length;
        if (stopped)
          setNotice(
            stopped === 1
              ? t("1 account disconnected locally")
              : t("{count} accounts disconnected locally", { count: stopped }),
          );
        setCatalogError(
          state === "revoked"
            ? t("Local access stopped · Provider confirmation pending")
            : state === "unverified"
              ? t("Connection status unconfirmed. Refresh status.")
              : errorText(
                  failure,
                  t(
                    "Disconnect did not complete. Review the remaining accounts before trying again.",
                  ),
                ),
        );
      } else if (
        !remaining ||
        expected.some((row) => connectionRemovalState(remaining, row.id) !== "revoked")
      )
        setCatalogError(t("Connection status unconfirmed. Refresh status."));
      else setNotice(single ? t("Account disconnected.") : t("Source accounts disconnected."));
      setToolsTick((value) => value + 1);
    } catch (reason) {
      if (isCurrent()) setCatalogError(errorText(reason, t("Could not check connection")));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  async function renameAccount(row: Connection) {
    const displayName = (labelDrafts[row.id] ?? row.displayName).trim();
    if (!displayName || displayName === row.displayName) return;
    const isCurrent = captureConnectionScope();
    if (!isCurrent()) return;
    setPending(`rename:${row.id}`);
    setCatalogError(null);
    try {
      const updated = await rpc<Connection>("connections/rename", {
        connectionId: row.id,
        displayName,
      });
      if (!isCurrent()) return;
      updateAccount(updated);
      setLabelDrafts((current) => ({ ...current, [row.id]: updated.displayName }));
    } catch (reason) {
      if (!isCurrent()) return;
      setCatalogError(errorText(reason, t("Could not rename connection")));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  function beginSource(kind: SourceKind) {
    invalidateSourceReview();
    setSourceKind(kind);
    setSourceError(null);
    setName(kind === "treg" ? "Treg" : kind === "executor" ? "Executor" : "");
    setUrl(kind === "treg" ? "https://treg.to/mcp/" : "");
    setCredential("");
    setRequiresAuth(kind === "treg" || kind === "executor");
  }

  async function previewOpenApi() {
    invalidateSourceReview();
    const generation = sourceFormGeneration.current;
    const connectionCurrent = captureConnectionScope();
    const scope = captureMobileScope();
    const isCurrent = () =>
      generation === sourceFormGeneration.current &&
      connectionCurrent() &&
      isMobileScopeCurrent(scope);
    if (!isCurrent()) return;
    const controller = new AbortController();
    sourceAbort.current = controller;
    async function request<T>(procedure: string, input: unknown): Promise<T> {
      const context = await captureApiRequestContext(scope.spaceId);
      if (!isCurrent()) throw new Error("Import closed");
      return rpc<T>(procedure, input, { requestContext: context, signal: controller.signal });
    }
    const attempt = createOpenApiImportReview({
      preview: (input) => request<OpenApiImportPreview>("capabilities/previewOpenApi", input),
      confirm: (input) => request<OpenApiImportConfirmation>("capabilities/confirmOpenApi", input),
      receipt: (input) => request<OpenApiImportConfirmation>("capabilities/openApiReceipt", input),
      isCurrent,
      changed: setSourceReview,
      installed: (install) => {
        sourcesGeneration.current += 1;
        setSources((current) => [...current.filter((row) => row.id !== install.id), install]);
        setCredential("");
        setSourceKind(null);
        void refresh().catch(() => undefined);
      },
    });
    sourceImport.current = attempt;
    setSourceError(null);
    await attempt.preview({
      name: name.trim() || t("Custom connector"),
      source: url.trim(),
      credential: credential.trim() || undefined,
      config: { auth: { type: requiresAuth ? "bearer" : "none" } },
    });
  }

  async function addSource() {
    if (!sourceKind || sourceKind === "api") return;
    const generation = sourceFormGeneration.current;
    const connectionCurrent = captureConnectionScope();
    const scope = captureMobileScope();
    const isCurrent = () =>
      generation === sourceFormGeneration.current &&
      connectionCurrent() &&
      isMobileScopeCurrent(scope);
    if (!isCurrent()) return;
    setPending("source");
    setSourceError(null);
    try {
      const requestContext = await captureApiRequestContext(scope.spaceId);
      if (!isCurrent()) return;
      await rpc(
        "capabilities/install",
        {
          kind: sourceKind === "treg" || sourceKind === "executor" ? "mcp" : sourceKind,
          name:
            name.trim() ||
            (sourceKind === "treg"
              ? "Treg"
              : sourceKind === "executor"
                ? "Executor"
                : sourceKind === "graphql"
                  ? "GraphQL"
                  : t("Custom connector")),
          source: url.trim(),
          credential: credential.trim() || undefined,
          config:
            sourceKind === "treg"
              ? { preset: "treg", auth: { type: "bearer" } }
              : sourceKind === "graphql"
                ? { auth: { type: requiresAuth ? "bearer" : "none" } }
                : {
                    preset: "custom",
                    auth: { type: sourceKind === "executor" || requiresAuth ? "bearer" : "none" },
                  },
        },
        { requestContext },
      );
      if (!isCurrent()) return;
      setCredential("");
      setSourceKind(null);
      await refresh();
    } catch (reason) {
      if (isCurrent()) setSourceError(errorText(reason, t("Could not add source")));
    } finally {
      if (isCurrent()) setPending(null);
    }
  }

  async function removeSource(source: CapabilityInstall) {
    setPending(source.id);
    setSourceError(null);
    try {
      await rpc("capabilities/remove", { id: source.id });
      sourcesGeneration.current += 1;
      setSources((current) => current.filter((item) => item.id !== source.id));
    } catch (reason) {
      setSourceError(errorText(reason, t("Could not remove source")));
    } finally {
      setPending(null);
    }
  }

  function statusLabel(status: Connection["status"]) {
    return status === "connected"
      ? t("Connected")
      : status === "pending"
        ? t("Pending authorization")
        : status === "error"
          ? t("Needs attention")
          : t("Disconnected");
  }

  function renderCatalogTile(app: ConnectionApp) {
    const summary = connectionAppSummary(app, connections),
      waiting = summary.pending[0],
      old = summary.errors[0] ?? summary.revoked[0];
    const action = summary.isConnected
      ? t("Manage")
      : waiting
        ? t("Check status")
        : old
          ? t("Authorize again")
          : t("Add");
    return (
      <View key={app.id} style={[styles.row, catalogColumns === 2 ? styles.catalogCell : null]}>
        <Pressable
          accessibilityRole="button"
          onPress={() => openApp(app)}
          style={[styles.detailTitleRow, styles.grow]}
        >
          <ConnectorIcon logo={app.logo} name={app.name} size={LOGO_SIZE} />
          <View style={styles.grow}>
            <Text numberOfLines={1} style={styles.title}>
              {app.name}
            </Text>
            {summary.status ? (
              <Text style={styles.secondary}>
                {statusLabel(summary.status)}
                {summary.isConnected && summary.errors.length
                  ? ` · ${t("Needs attention")}: ${summary.errors.length}`
                  : ""}
                {summary.isConnected && summary.pending.length
                  ? ` · ${t("Pending authorization")}: ${summary.pending.length}`
                  : ""}
              </Text>
            ) : null}
          </View>
        </Pressable>
        <NativeActionButton
          label={action}
          disabled={pending !== null}
          fill={false}
          prominence="secondary"
          onPress={() => {
            if (summary.isConnected || app.sources.length > 1) {
              openApp(app);
              return;
            }
            const item = app.sources[0];
            if (!item) return;
            if (waiting) void checkAccount(waiting, item);
            else void connect(item, old);
          }}
        />
      </View>
    );
  }

  function renderAccount(row: Connection, item: ConnectionCatalogItem) {
    const editable = row.status === "connected" || row.status === "pending";
    return (
      <View key={row.id} style={styles.card}>
        <View style={styles.accountRow}>
          {editable ? (
            <TextInput
              value={labelDrafts[row.id] ?? row.displayName}
              editable={pending === null}
              onChangeText={(value) =>
                setLabelDrafts((current) => ({ ...current, [row.id]: value }))
              }
              onEndEditing={() => void renameAccount(row)}
              accessibilityLabel={t("Account label")}
              style={styles.accountLabel}
            />
          ) : (
            <Text style={[styles.title, styles.grow]}>{row.displayName}</Text>
          )}
          <Text style={row.status === "error" ? styles.error : styles.secondary}>
            {statusLabel(row.status)}
          </Text>
        </View>
        <Text style={styles.secondary}>{sourceLabel(item)}</Text>
        <View style={styles.accountActions}>
          {row.status === "pending" ? (
            <NativeActionButton
              label={t("Check status")}
              disabled={pending !== null}
              fill={false}
              prominence="secondary"
              onPress={() => void checkAccount(row, item)}
            />
          ) : null}
          {row.status === "error" || row.status === "revoked" ? (
            <NativeActionButton
              label={t("Authorize again")}
              disabled={pending !== null}
              fill={false}
              prominence="secondary"
              onPress={() => void connect(item, row)}
            />
          ) : null}
          {row.status !== "revoked" ? (
            <NativeActionButton
              label={row.status === "pending" ? t("Cancel connection") : t("Disconnect")}
              disabled={pending !== null}
              fill={false}
              prominence="destructive"
              onPress={() => void prepareRemoval(item, row)}
            />
          ) : null}
          {row.status === "connected" && row.remoteAccountId ? (
            <NativeActionButton
              label={t("Account details")}
              fill={false}
              prominence="quiet"
              onPress={() =>
                Alert.alert(t("Authorization record"), row.remoteAccountId ?? undefined)
              }
            />
          ) : null}
        </View>
      </View>
    );
  }

  function renderDetail(item: ConnectionCatalogItem) {
    const rows = catalogAccounts(connections, item),
      current = rows.filter((row) => row.status !== "revoked"),
      history = rows.filter((row) => row.status === "revoked");
    return (
      <View style={styles.detail}>
        <View style={styles.detailTitleRow}>
          <NativeActionButton
            label={t("Back")}
            fill={false}
            prominence="quiet"
            onPress={closeDetail}
          />
          <ConnectorIcon
            logo={detailApp?.logo ?? item.logo}
            name={detailApp?.name ?? item.name}
            size={LOGO_SIZE}
          />
          <Text style={styles.detailTitle}>{detailApp?.name ?? item.name}</Text>
        </View>
        {detailApp && detailApp.sources.length > 1 && !pending ? (
          <MenuPicker
            label={t("Connection source")}
            value={itemKey(item)}
            choices={detailApp.sources.map((source) => ({
              key: itemKey(source),
              label: `${sourceLabel(source)} · ${source.slug}`,
            }))}
            onChange={(key) => {
              const source = detailApp.sources.find((entry) => itemKey(entry) === key);
              if (source) openDetail(source);
            }}
          />
        ) : (
          <Text style={styles.secondary}>{sourceLabel(item)}</Text>
        )}
        <View style={styles.accountRow}>
          <Text style={[styles.section, styles.grow]}>{t("Accounts")}</Text>
          <NativeActionButton
            label={t("Add account")}
            disabled={pending !== null}
            fill={false}
            prominence="secondary"
            onPress={() => void connect(item)}
          />
        </View>
        {current.length ? (
          current.map((row) => renderAccount(row, item))
        ) : (
          <Text style={styles.secondary}>{t("No active accounts.")}</Text>
        )}
        {history.length ? (
          <View style={styles.card}>
            <Text style={styles.section}>{t("Disconnected accounts")}</Text>
            {history.map((row) => renderAccount(row, item))}
          </View>
        ) : null}
        <View style={styles.card}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: toolsOpen }}
            onPress={() => setToolsOpen((open) => !open)}
            style={styles.toolsToggle}
          >
            <Text style={styles.title}>
              {toolsLoading ? t("Tools") : t("{count} tools", { count: tools.length })}
            </Text>
            <Chevron expanded={toolsOpen} />
          </Pressable>
          {toolsOpen ? (
            <View style={styles.toolsBody}>
              {toolsLoading ? (
                <Text style={styles.secondary}>{t("Loading tools…")}</Text>
              ) : toolsError ? (
                <Text style={styles.error}>{toolsError}</Text>
              ) : tools.length ? (
                tools.map((tool) => (
                  <Text key={tool.name} style={styles.toolName}>
                    {humanizeToolName(tool.name)}
                  </Text>
                ))
              ) : (
                <Text style={styles.secondary}>{t("No tools available.")}</Text>
              )}
            </View>
          ) : null}
        </View>
        {catalogUninstallAccounts(connections, item).length ? (
          <NativeActionButton
            label={t("Uninstall source")}
            disabled={pending !== null}
            fill={false}
            prominence="destructive"
            onPress={() => void prepareRemoval(item)}
          />
        ) : null}
      </View>
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {!detailItem ? (
          <TextInput
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
            }}
            accessibilityLabel={t("Search apps")}
            placeholder={t("Search apps")}
            placeholderTextColor={native.tertiaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={styles.input}
          />
        ) : null}

        {catalogError ? (
          <View style={styles.catalogStack}>
            <Text style={styles.error}>{catalogError}</Text>
            <NativeActionButton
              label={t("Retry")}
              fill={false}
              onPress={() => void retryRefresh()}
              prominence="secondary"
            />
          </View>
        ) : null}

        {notice ? <Text style={styles.secondary}>{notice}</Text> : null}
        {detailItem ? (
          nativeAccount ? (
            <NativeAccountConnect
              key={`${itemKey(detailItem)}:${nativeAccount.previous?.id ?? "new"}`}
              appId={nativeAccount.appId}
              previousConnectionId={nativeAccount.previous?.id}
              onSubmit={(input) => connect(detailItem, nativeAccount.previous, input)}
              onCancel={closeDetail}
            />
          ) : (
            renderDetail(detailItem)
          )
        ) : (
          <>
            {!catalogReady && !catalogError ? (
              <View
                testID="integrations-loading"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={catalogColumns === 2 ? styles.catalogGrid : styles.catalogStack}
              >
                {Array.from({ length: 8 }, (_, index) => (
                  <View
                    key={index}
                    style={[styles.row, catalogColumns === 2 ? styles.catalogCell : null]}
                  >
                    <View style={styles.logoPlaceholder} />
                    <View style={styles.grow}>
                      <View style={styles.titlePlaceholder} />
                    </View>
                    <View style={styles.pillPlaceholder} />
                  </View>
                ))}
              </View>
            ) : null}

            {catalogReady && catalog.length === 0 ? (
              <Text style={styles.secondary}>{t(EMPTY_PLUGIN_CATALOG_MESSAGE)}</Text>
            ) : null}

            {catalogReady ? (
              <NativeSegmentedControl
                accessibilityLabel={t("Application filter")}
                value={catalogFilter}
                onChange={(value) => {
                  setCatalogFilter(value);
                  setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
                }}
                options={[
                  { value: "all", label: t("All apps") },
                  { value: "connected", label: t("Connected") },
                ]}
              />
            ) : null}
            {renderedApps.some((app) => app.firstParty) ? (
              <View style={styles.catalogStack}>
                <Text style={styles.section}>{t("By Cogine")}</Text>
                {renderedApps.filter((app) => app.firstParty).map(renderCatalogTile)}
              </View>
            ) : null}
            <View style={catalogColumns === 2 ? styles.catalogGrid : styles.catalogStack}>
              {renderedApps.filter((app) => !app.firstParty).map(renderCatalogTile)}
            </View>
            {catalogReady && catalog.length > 0 && !catalogApps.length ? (
              <Text style={styles.secondary}>
                {query.trim() ? t("No apps match your search.") : t("No connected apps.")}
              </Text>
            ) : null}
            {renderedApps.length < catalogApps.length ? (
              <NativeActionButton
                label={t("Show more")}
                onPress={() => setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)}
                prominence="secondary"
              />
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: advancedOpen }}
              testID="integrations-advanced"
              onPress={() => {
                if (advancedOpen) closeAdvanced();
                else setAdvancedOpen(true);
              }}
              style={styles.advancedToggle}
            >
              <Text style={styles.advancedLabel}>{t("Advanced")}</Text>
              <Chevron expanded={advancedOpen} />
            </Pressable>

            {advancedOpen ? (
              <View style={styles.advancedBody}>
                <NativeActionButton
                  label={t("MCP servers")}
                  prominence="secondary"
                  onPress={() => router.push("/(settings)/mcp")}
                />
                <View style={styles.accountActions}>
                  {(["mcp", "api", "graphql", "executor", "treg"] as const).map((kind) => (
                    <NativeActionButton
                      key={kind}
                      label={
                        kind === "treg"
                          ? t("Add Treg")
                          : kind === "executor"
                            ? t("Add Executor")
                            : kind === "mcp"
                              ? t("Add MCP server")
                              : kind === "graphql"
                                ? t("Add GraphQL")
                                : t("Add OpenAPI")
                      }
                      onPress={() => beginSource(kind)}
                      prominence="secondary"
                    />
                  ))}
                </View>

                {sourceError ? <Text style={styles.error}>{sourceError}</Text> : null}

                {sourceKind ? (
                  <View style={styles.card}>
                    <Text style={styles.title}>
                      {sourceKind === "treg"
                        ? t("Connect Treg")
                        : sourceKind === "executor"
                          ? t("Connect Executor")
                          : sourceKind === "mcp"
                            ? t("Remote MCP server")
                            : sourceKind === "graphql"
                              ? t("GraphQL endpoint")
                              : t("OpenAPI")}
                    </Text>
                    <TextInput
                      editable={!sourceInputsLocked}
                      value={name}
                      onChangeText={(value) => {
                        invalidateSourceReview();
                        setName(value);
                      }}
                      placeholder={t("Display name")}
                      placeholderTextColor={native.tertiaryLabel}
                      style={styles.input}
                    />
                    {sourceKind !== "treg" ? (
                      <TextInput
                        editable={!sourceInputsLocked}
                        value={url}
                        onChangeText={(value) => {
                          invalidateSourceReview();
                          setUrl(value);
                        }}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={
                          sourceKind === "mcp"
                            ? t("https://example.com/mcp")
                            : sourceKind === "executor"
                              ? t("https://executor.example/mcp")
                              : sourceKind === "graphql"
                                ? t("https://example.com/graphql")
                                : t("https://example.com/openapi.json")
                        }
                        placeholderTextColor={native.tertiaryLabel}
                        style={styles.input}
                      />
                    ) : null}
                    {sourceKind !== "treg" && sourceKind !== "executor" ? (
                      <Pressable
                        accessibilityRole="button"
                        disabled={sourceInputsLocked}
                        onPress={() => {
                          invalidateSourceReview();
                          setRequiresAuth((value) => !value);
                        }}
                        style={styles.authToggle}
                      >
                        <Text style={styles.secondary}>
                          {requiresAuth ? t("Bearer authentication") : t("No authentication")}
                        </Text>
                      </Pressable>
                    ) : null}
                    {sourceKind === "treg" || sourceKind === "executor" || requiresAuth ? (
                      <TextInput
                        editable={!sourceInputsLocked}
                        value={credential}
                        onChangeText={(value) => {
                          invalidateSourceReview();
                          setCredential(value);
                        }}
                        secureTextEntry
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={
                          sourceKind === "treg"
                            ? t("Treg token")
                            : sourceKind === "executor"
                              ? t("Executor token")
                              : t("Bearer token")
                        }
                        placeholderTextColor={native.tertiaryLabel}
                        style={styles.input}
                      />
                    ) : null}
                    {sourceKind === "api" && sourceReview ? (
                      <OpenApiImportReview
                        state={sourceReview}
                        onConfirm={() => void sourceImport.current?.confirm()}
                        onCheck={() => void sourceImport.current?.check()}
                        onPreview={() => void previewOpenApi()}
                      />
                    ) : null}
                    <View style={styles.accountActions}>
                      {sourceKind !== "api" || !sourceReview ? (
                        <NativeActionButton
                          busy={pending === "source"}
                          label={sourceKind === "api" ? t("Preview") : t("Verify and add")}
                          onPress={() =>
                            sourceKind === "api" ? void previewOpenApi() : void addSource()
                          }
                          prominence="secondary"
                        />
                      ) : null}
                      <NativeActionButton
                        label={
                          sourceReview &&
                          ["confirming", "pending", "unknown", "terminal"].includes(
                            sourceReview.phase,
                          )
                            ? t("Close")
                            : t("Cancel")
                        }
                        onPress={() => {
                          invalidateSourceReview();
                          setSourceKind(null);
                        }}
                        prominence="secondary"
                      />
                    </View>
                  </View>
                ) : null}

                <Text style={styles.section}>{t("Tool sources")}</Text>
                {sources.length === 0 ? (
                  <Text style={styles.secondary}>{t("No custom sources installed.")}</Text>
                ) : null}
                {sources.map((source) => (
                  <View key={source.id} style={styles.row}>
                    <View style={styles.grow}>
                      <Text style={styles.title}>{source.name}</Text>
                      <Text numberOfLines={1} style={styles.secondary}>
                        {source.kind.toUpperCase()} · {source.source}
                      </Text>
                    </View>
                    <NativeActionButton
                      fill={false}
                      label={pending === source.id ? t("Removing…") : t("Remove")}
                      onPress={() => void removeSource(source)}
                      prominence="destructive"
                    />
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createIntegrationsStyles() {
  const destructive = mobileTokens().destructive;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 14 },
    explanation: { color: native.secondaryLabel, fontSize: 14, lineHeight: 20 },
    section: { color: native.secondaryLabel, fontSize: 14, fontWeight: "600", marginTop: 2 },
    card: { padding: 16, borderRadius: 16, backgroundColor: native.fill, gap: 12 },
    input: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 14,
      fontSize: 15,
    },
    authToggle: { minHeight: 42, justifyContent: "center" },
    catalogGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    catalogStack: { gap: 8 },
    catalogCell: { flexGrow: 1, flexBasis: "47%", maxWidth: "49%" },
    row: {
      minHeight: 56,
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderRadius: 14,
      backgroundColor: native.fill,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    logoPlaceholder: {
      width: LOGO_SIZE,
      height: LOGO_SIZE,
      borderRadius: 10,
      backgroundColor: native.fillPressed,
    },
    titlePlaceholder: {
      width: "65%",
      height: 14,
      borderRadius: 4,
      backgroundColor: native.fillPressed,
    },
    pillPlaceholder: {
      width: 52,
      height: 30,
      borderRadius: 15,
      backgroundColor: native.fillPressed,
    },
    grow: { flex: 1, gap: 3, minWidth: 0 },
    title: { color: native.label, fontSize: 15, fontWeight: "600" },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    accountActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
    },
    accountRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    accountLabel: {
      flex: 1,
      minHeight: 36,
      borderRadius: 10,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 10,
      fontSize: 13,
    },
    link: { color: native.label, fontSize: 14, fontWeight: "600" },
    error: { color: destructive, fontSize: 14 },
    detail: { gap: 14 },
    detailHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    detailTitleRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 },
    backButton: { paddingVertical: 4 },
    detailTitle: { flex: 1, color: native.label, fontSize: 17, fontWeight: "600" },
    toolsToggle: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    toolsBody: { gap: 8, paddingTop: 4 },
    toolName: { color: native.label, fontSize: 14 },
    advancedToggle: {
      marginTop: 8,
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    advancedLabel: { color: native.secondaryLabel, fontSize: 14 },
    advancedBody: { gap: 14 },
  });
}
