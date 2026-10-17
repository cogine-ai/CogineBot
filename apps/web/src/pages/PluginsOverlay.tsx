import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type {
  CapabilityInstall,
  Connection,
  ConnectionCatalogItem,
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
} from "@rakazo/contracts";
import type { ConnectionApp } from "@rakazo/core";
import {
  abortableDelay,
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogAccounts,
  catalogItemConnected,
  catalogUninstallAccounts,
  connectionAppSummary,
  connectionCatalogKey,
  connectionMatchesCatalog,
  connectionRemovalState,
  filterConnectionApps,
  groupConnectionCatalog,
  humanizeToolName,
} from "@rakazo/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { ChevronDown, ChevronLeft, ChevronUp, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import { optionalCatalogFeedProbe } from "../lib/optional-catalog-feed";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

type SourceKind = "treg" | "executor" | "mcp" | "api" | "graphql";

type ConnectionTool = { name: string; description: string };

function itemKey(item: Pick<ConnectionCatalogItem, "connectorId" | "slug">) {
  return connectionCatalogKey(item);
}

function markConnected(
  items: ConnectionCatalogItem[],
  connectorId: string,
  slug: string,
  connected: boolean,
) {
  return items.map((entry) =>
    entry.connectorId === connectorId && entry.slug === slug ? { ...entry, connected } : entry,
  );
}

function activeAccounts(
  connections: Connection[],
  item: Pick<ConnectionCatalogItem, "connectorId" | "slug">,
) {
  return connections.filter(
    (row) =>
      connectionMatchesCatalog(row, item) &&
      (row.status === "connected" || row.status === "pending"),
  );
}

function sourceLabel(item: Pick<ConnectionCatalogItem, "connectorId">) {
  const labels: Record<string, string> = { composio: "Composio", pipedream: "Pipedream" };
  return labels[item.connectorId] ?? item.connectorId;
}

function nextAccountLabel(itemName: string, existingCount: number) {
  return existingCount <= 0 ? itemName : `${itemName} ${existingCount + 1}`;
}
export function PluginsOverlay({
  onClose,
  onOpenMcp,
  activeBotId,
}: {
  onClose: () => void;
  onOpenMcp?: () => void;
  activeBotId?: string;
}) {
  const { t } = useLingui();
  const [setupOpen, setSetupOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<CapabilityInstall[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [authType, setAuthType] = useState<"none" | "bearer" | "header">("bearer");
  const [authName, setAuthName] = useState("x-api-key");
  const [pending, setPending] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceHint, setSourceHint] = useState<string | null>(null);
  const [catalogFeedEnabled, setCatalogFeedEnabled] = useState(false);
  const [catalogFeedQuery, setCatalogFeedQuery] = useState("");
  const [catalogFeedResults, setCatalogFeedResults] = useState<IntegrationCatalogResult[]>([]);
  const [catalogFeedError, setCatalogFeedError] = useState<string | null>(null);
  const [catalogFeedPending, setCatalogFeedPending] = useState(false);
  const [catalogFeedSearched, setCatalogFeedSearched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [catalogFilter, setCatalogFilter] = useState<"all" | "connected">("all");
  const [notice, setNotice] = useState<string | null>(null);
  const [unconfirmedRemovalId, setUnconfirmedRemovalId] = useState<string | null>(null);
  const [removal, setRemoval] = useState<{
    item: ConnectionCatalogItem;
    targets: Connection[];
    account: boolean;
  } | null>(null);
  const [detailKey, setDetailKey] = useState<{ connectorId: string; slug: string } | null>(null);
  const [tools, setTools] = useState<ConnectionTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(true);
  const [toolsTick, setToolsTick] = useState(0);
  const connectionAttempt = useRef<AbortController | null>(null);

  async function refresh() {
    const [items, installs, rows, catalogFeed] = await Promise.all([
      rpc.connections.catalog({}),
      rpc.capabilities.list(),
      rpc.connections.list(),
      optionalCatalogFeedProbe(rpc.capabilities.catalogSearch({ query: "" })),
    ]);
    setCatalog(items);
    setConnections(rows);
    setLabelDrafts((current) => {
      const next: Record<string, string> = {};
      for (const row of rows) {
        next[row.id] = current[row.id] ?? row.displayName;
      }
      return next;
    });
    setSources(
      installs.filter(
        (install) => install.kind === "mcp" || install.kind === "api" || install.kind === "graphql",
      ),
    );
    setCatalogFeedEnabled(catalogFeed.enabled);
    return { items, rows };
  }

  useEffect(() => {
    void refresh()
      .catch((err: unknown) => setCatalogError(errorText(err, t`Could not load integrations`)))
      .finally(() => setLoading(false));
    return () => connectionAttempt.current?.abort();
  }, []);

  const detailItem = useMemo(() => {
    if (!detailKey) return null;
    return (
      catalog.find(
        (entry) => entry.connectorId === detailKey.connectorId && entry.slug === detailKey.slug,
      ) ?? null
    );
  }, [catalog, detailKey]);

  useEffect(() => {
    if (!detailKey) {
      setTools([]);
      setToolsLoading(false);
      return;
    }
    let cancelled = false;
    setToolsLoading(true);
    setToolsError(null);
    void rpc.connections
      .tools({ connectorId: detailKey.connectorId, provider: detailKey.slug })
      .then((list) => {
        if (!cancelled) setTools(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setTools([]);
          setToolsError(errorText(err, t`Could not load tools`));
        }
      })
      .finally(() => {
        if (!cancelled) setToolsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailKey, toolsTick]);

  const apps = useMemo(() => groupConnectionCatalog(catalog), [catalog]);
  const detailApp = apps.find((app) =>
    app.sources.some(
      (item) =>
        detailKey && item.connectorId === detailKey.connectorId && item.slug === detailKey.slug,
    ),
  );
  const visible = filterConnectionApps(apps, query).filter(
    (app) => catalogFilter === "all" || connectionAppSummary(app, connections).isConnected,
  );
  const rendered = visible.slice(0, visibleCount);

  function openDetail(item: ConnectionCatalogItem) {
    setCatalogError(null);
    setNotice(null);
    setToolsOpen(true);
    setDetailKey({ connectorId: item.connectorId, slug: item.slug });
  }

  function closeDetail() {
    setDetailKey(null);
    setTools([]);
  }

  function itemConnected(item: ConnectionCatalogItem) {
    return catalogItemConnected(connections, item);
  }

  function openApp(app: ConnectionApp) {
    const preferred =
      app.sources.find((item) => itemConnected(item)) ??
      app.sources.find((item) =>
        catalogAccounts(connections, item).some((row) => row.status === "pending"),
      ) ??
      app.sources[0];
    if (preferred) openDetail(preferred);
  }

  async function notifyAppConnected(item: ConnectionCatalogItem) {
    if (!activeBotId) return;
    await rpc.onboarding
      .appConnected({ botId: activeBotId, provider: item.slug, connectorId: item.connectorId })
      .catch(() => undefined);
  }

  function setItemConnected(item: ConnectionCatalogItem, connected: boolean) {
    setCatalog((prev) => markConnected(prev, item.connectorId, item.slug, connected));
  }

  async function connect(item: ConnectionCatalogItem, previous?: Connection) {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setCatalogError(null);
    setNotice(null);
    const key = itemKey(item);
    setPending(key);
    try {
      const existing = activeAccounts(connections, item).filter(
        (row) => row.status === "connected",
      );
      const started = await rpc.connections.begin({
        connectorId: item.connectorId,
        provider: item.slug,
        displayName: previous?.displayName ?? nextAccountLabel(item.name, existing.length),
        ...(previous ? { connectionId: previous.id } : {}),
      });
      if (started.authorizationUrl)
        window.open(started.authorizationUrl, "rakazo-plugin-connect", "noopener,noreferrer");
      if (item.noAuth && !started.authorizationUrl) {
        if (controller.signal.aborted) return;
        setItemConnected(item, true);
        void notifyAppConnected(item);
        await refresh().catch(() => undefined);
        setToolsTick((tick) => tick + 1);
        return;
      }
      for (let i = 0; i < 45; i += 1) {
        if (controller.signal.aborted) return;
        const row = await rpc.connections
          .complete({ connectionId: started.connectionId })
          .catch(() => undefined);
        if (row?.status === "connected") {
          if (controller.signal.aborted) return;
          setItemConnected(item, true);
          void notifyAppConnected(item);
          await refresh().catch(() => undefined);
          setToolsTick((tick) => tick + 1);
          return;
        }
        if (row?.status === "error" || row?.status === "revoked") {
          await refresh();
          setCatalogError(t`Authorization did not complete. You can authorize again.`);
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (controller.signal.aborted) return;
      setCatalogError(
        t`Connection to ${item.name} is still pending. You can close this and check again.`,
      );
      await refresh().catch(() => undefined);
    } catch (err) {
      if (controller.signal.aborted) return;
      setCatalogError(errorText(err, t`Could not connect`));
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setPending(null);
      }
    }
  }

  async function checkAccount(row: Connection, item: ConnectionCatalogItem) {
    setPending(`check:${row.id}`);
    setCatalogError(null);
    setNotice(null);
    try {
      const updated = await rpc.connections.complete({ connectionId: row.id });
      setConnections((rows) => rows.map((entry) => (entry.id === updated.id ? updated : entry)));
      if (updated.status === "connected") {
        setItemConnected(item, true);
        void notifyAppConnected(item);
      }
      await refresh();
      if (updated.status === "pending") setNotice(t`Authorization is still pending.`);
      setToolsTick((tick) => tick + 1);
    } catch (err) {
      setCatalogError(errorText(err, t`Could not check connection`));
    } finally {
      setPending(null);
    }
  }

  async function prepareRemoval(item: ConnectionCatalogItem, row?: Connection) {
    setCatalogError(null);
    setNotice(null);
    try {
      const rows = await rpc.connections.list();
      setConnections(rows);
      const targets = row
        ? rows.filter(
            (entry) =>
              entry.id === row.id &&
              connectionMatchesCatalog(entry, item) &&
              entry.status !== "revoked",
          )
        : catalogUninstallAccounts(rows, item);
      if (!targets.length) {
        setNotice(t`No connected or pending accounts remain for this source.`);
        return;
      }
      setRemoval({ item, targets, account: !!row });
    } catch (err) {
      setCatalogError(errorText(err, t`Could not check connection`));
    }
  }

  async function runRemoval() {
    if (!removal) return;
    const operation = removal;
    setPending("remove");
    setCatalogError(null);
    let failedId: string | null = null;
    let failure: unknown;
    try {
      const current = await rpc.connections.list();
      const targets = operation.account
        ? current.filter(
            (entry) =>
              entry.id === operation.targets[0]?.id &&
              connectionMatchesCatalog(entry, operation.item) &&
              entry.status !== "revoked",
          )
        : catalogUninstallAccounts(current, operation.item);
      if (
        targets.length !== operation.targets.length ||
        targets.some(
          (row) =>
            !operation.targets.some(
              (original) =>
                original.id === row.id &&
                original.status === row.status &&
                original.remoteAccountId === row.remoteAccountId,
            ),
        )
      ) {
        setConnections(current);
        setNotice(t`Accounts changed. Review them before disconnecting.`);
        return;
      }
      for (const row of targets) {
        try {
          await rpc.connections.revoke({ connectionId: row.id });
          setConnections((rows) =>
            rows.map((entry) =>
              entry.id === row.id ? { ...entry, status: "revoked", remoteAccountId: null } : entry,
            ),
          );
        } catch (err) {
          failedId = row.id;
          failure = err;
          break;
        }
      }
      const remaining = await rpc.connections.list().catch(() => null);
      if (remaining) {
        setConnections(remaining);
        setItemConnected(
          operation.item,
          catalogAccounts(remaining, operation.item).some((row) => row.status === "connected"),
        );
      }
      if (failedId) {
        const state = connectionRemovalState(remaining, failedId);
        if (state === "revoked") setUnconfirmedRemovalId(failedId);
        const stopped = operation.targets.filter(
          (row) => connectionRemovalState(remaining, row.id) === "revoked",
        ).length;
        if (stopped)
          setNotice(
            stopped === 1
              ? t`1 account disconnected locally`
              : t`${stopped} accounts disconnected locally`,
          );
        setCatalogError(
          state === "revoked"
            ? t`Local access stopped · Provider confirmation pending`
            : state === "unverified"
              ? t`Connection status unconfirmed. Refresh status.`
              : errorText(
                  failure,
                  t`Disconnect did not complete. Review the remaining accounts before trying again.`,
                ),
        );
      } else if (
        !remaining ||
        operation.targets.some((row) => connectionRemovalState(remaining, row.id) !== "revoked")
      ) {
        setCatalogError(t`Connection status unconfirmed. Refresh status.`);
      } else
        setNotice(operation.account ? t`Account disconnected.` : t`Source accounts disconnected.`);
      setToolsTick((tick) => tick + 1);
    } catch (err) {
      setCatalogError(errorText(err, t`Could not check connection`));
    } finally {
      setRemoval(null);
      setPending(null);
    }
  }

  async function refreshStatus() {
    try {
      const { rows } = await refresh();
      setCatalogError(
        unconfirmedRemovalId && connectionRemovalState(rows, unconfirmedRemovalId) === "revoked"
          ? t`Local access stopped · Provider confirmation pending`
          : null,
      );
    } catch (err) {
      setCatalogError(errorText(err, t`Could not load integrations`));
    }
  }

  async function renameAccount(row: Connection) {
    const displayName = (labelDrafts[row.id] ?? row.displayName).trim();
    if (!displayName || displayName === row.displayName) return;
    setPending(`rename:${row.id}`);
    setCatalogError(null);
    try {
      const updated = await rpc.connections.rename({ connectionId: row.id, displayName });
      setConnections((current) =>
        current.map((entry) =>
          entry.id === row.id ? { ...entry, displayName: updated.displayName } : entry,
        ),
      );
      setLabelDrafts((current) => ({ ...current, [row.id]: updated.displayName }));
    } catch (err) {
      setCatalogError(errorText(err, t`Could not rename connection`));
    } finally {
      setPending(null);
    }
  }

  function beginSource(kind: SourceKind) {
    setSourceKind(kind);
    setSourceError(null);
    setSourceHint(null);
    setSourceName(kind === "treg" ? "Treg" : kind === "executor" ? "Executor" : "");
    setSourceUrl(kind === "treg" ? "https://treg.to/mcp/" : "");
    setCredential("");
    setAuthType(kind === "treg" || kind === "executor" ? "bearer" : "none");
    setAuthName("x-api-key");
  }

  async function searchCatalogFeed() {
    setCatalogFeedError(null);
    setCatalogFeedPending(true);
    setCatalogFeedSearched(false);
    setCatalogFeedResults([]);
    try {
      const response = await rpc.capabilities.catalogSearch({ query: catalogFeedQuery });
      setCatalogFeedResults(response.results);
      setCatalogFeedSearched(true);
    } catch (err) {
      setCatalogFeedError(errorText(err, t`Could not search catalog`));
    } finally {
      setCatalogFeedPending(false);
    }
  }

  function beginCatalogSurface(
    result: IntegrationCatalogResult,
    surface: IntegrationCatalogSurface,
  ) {
    if (!surface.source || (surface.kind !== "mcp" && surface.kind !== "openapi")) return;
    setSourceKind(surface.kind === "mcp" ? "mcp" : "api");
    setSourceName(result.name);
    setSourceUrl(surface.source);
    setCredential("");
    setAuthType(surface.auth?.type ?? "none");
    setAuthName(surface.auth?.headerName ?? "x-api-key");
    setSourceHint(surface.auth?.note ?? null);
    setSourceError(null);
  }

  async function installSource() {
    if (!sourceKind) return;
    setSourceError(null);
    setPending("install-source");
    try {
      const auth = {
        type: authType,
        ...(authType === "header" ? { name: authName.trim() } : {}),
      };
      await rpc.capabilities.install({
        kind: sourceKind === "treg" || sourceKind === "executor" ? "mcp" : sourceKind,
        name:
          sourceName.trim() ||
          (sourceKind === "treg"
            ? "Treg"
            : sourceKind === "executor"
              ? "Executor"
              : sourceKind === "graphql"
                ? "GraphQL"
                : "Custom connector"),
        source: sourceUrl.trim(),
        credential: credential.trim() || undefined,
        config:
          sourceKind === "treg"
            ? { preset: "treg", auth: { type: "bearer" } }
            : sourceKind === "api"
              ? { openApi: true, auth }
              : sourceKind === "graphql"
                ? { auth }
                : {
                    preset: "custom",
                    auth: sourceKind === "executor" ? { type: "bearer" } : auth,
                  },
      });
      setCredential("");
      setSourceKind(null);
      await refresh();
    } catch (err) {
      setSourceError(errorText(err, t`Could not install connector`));
    } finally {
      setPending(null);
    }
  }

  async function removeSource(install: CapabilityInstall) {
    setPending(install.id);
    setSourceError(null);
    try {
      await rpc.capabilities.remove({ id: install.id });
      setSources((current) => current.filter((source) => source.id !== install.id));
    } catch (err) {
      setSourceError(errorText(err, t`Could not remove connector`));
    } finally {
      setPending(null);
    }
  }

  function statusLabel(status: Connection["status"]) {
    return status === "connected"
      ? t`Connected`
      : status === "pending"
        ? t`Pending authorization`
        : status === "error"
          ? t`Needs attention`
          : t`Disconnected`;
  }

  function renderCatalogTile(app: ConnectionApp) {
    const summary = connectionAppSummary(app, connections);
    const waiting = summary.pending[0];
    const old = summary.errors[0] ?? summary.revoked[0];
    const label = summary.isConnected
      ? t`Manage`
      : waiting
        ? t`Check status`
        : old
          ? t`Authorize again`
          : t`Add`;
    function act() {
      if (summary.isConnected || app.sources.length > 1) {
        openApp(app);
        return;
      }
      const item = app.sources[0];
      if (!item) return;
      if (waiting) void checkAccount(waiting, item);
      else void connect(item, old);
    }
    return (
      <div
        key={app.id}
        data-testid={`connection-tile-${app.sources[0]?.slug.toLowerCase()}`}
        className="flex min-w-0 items-center gap-3 rounded-xl border border-border p-4"
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-start"
          onClick={() => openApp(app)}
        >
          {app.logo ? (
            <img
              src={app.logo}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-9 shrink-0 rounded-xl bg-accent object-contain"
            />
          ) : (
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent font-semibold">
              {app.name[0]}
            </span>
          )}
          <span className="flex min-w-0 flex-col gap-1">
            <span className="truncate font-medium">{app.name}</span>
            {summary.status ? (
              <span className="text-xs text-muted-foreground">
                {statusLabel(summary.status)}
                {summary.isConnected && summary.errors.length ? (
                  <>
                    {" "}
                    · <Trans>{summary.errors.length} need attention</Trans>
                  </>
                ) : null}
                {summary.isConnected && summary.pending.length ? (
                  <>
                    {" "}
                    · <Trans>{summary.pending.length} pending</Trans>
                  </>
                ) : null}
              </span>
            ) : null}
          </span>
        </button>
        <Button variant="secondary" size="sm" disabled={pending !== null} onClick={act}>
          {label}
        </Button>
      </div>
    );
  }

  function renderAccount(row: Connection, item: ConnectionCatalogItem) {
    const editable = row.status === "connected" || row.status === "pending";
    return (
      <div
        key={row.id}
        data-testid={`connection-account-${row.id}`}
        className="flex flex-col gap-2 rounded-xl border border-border p-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          {editable ? (
            <Input
              value={labelDrafts[row.id] ?? row.displayName}
              aria-label={t`Account label`}
              className="min-w-0 flex-1"
              disabled={pending !== null}
              onChange={(event) =>
                setLabelDrafts((current) => ({ ...current, [row.id]: event.target.value }))
              }
              onBlur={() => void renameAccount(row)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate font-medium">{row.displayName}</span>
          )}
          <Badge variant={row.status === "error" ? "destructive" : "secondary"}>
            {statusLabel(row.status)}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{sourceLabel(item)}</span>
          <div className="flex flex-wrap gap-2">
            {row.status === "pending" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending !== null}
                onClick={() => void checkAccount(row, item)}
              >
                <Trans>Check status</Trans>
              </Button>
            ) : null}
            {row.status === "error" || row.status === "revoked" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending !== null}
                onClick={() => void connect(item, row)}
              >
                <Trans>Authorize again</Trans>
              </Button>
            ) : null}
            {row.status !== "revoked" ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending !== null}
                onClick={() => void prepareRemoval(item, row)}
              >
                {row.status === "pending" ? (
                  <Trans>Cancel connection</Trans>
                ) : (
                  <Trans>Disconnect</Trans>
                )}
              </Button>
            ) : null}
          </div>
        </div>
        {row.status === "connected" && row.remoteAccountId ? (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              <Trans>Account details</Trans>
            </summary>
            <p className="mt-2 break-all">
              <Trans>Authorization record: {row.remoteAccountId}</Trans>
            </p>
          </details>
        ) : null}
      </div>
    );
  }

  function renderDetail(item: ConnectionCatalogItem) {
    const accounts = catalogAccounts(connections, item);
    const current = accounts.filter((row) => row.status !== "revoked");
    const history = accounts.filter((row) => row.status === "revoked");
    const uninstallable = catalogUninstallAccounts(connections, item);
    return (
      <div data-testid="connection-detail" className="flex flex-col gap-5">
        {detailApp && detailApp.sources.length > 1 ? (
          <div className="flex flex-col gap-2">
            <label htmlFor="connection-source" className="text-sm font-medium">
              <Trans>Connection source</Trans>
            </label>
            <NativeSelect
              id="connection-source"
              value={itemKey(item)}
              disabled={pending !== null}
              onChange={(event) => {
                const source = detailApp.sources.find(
                  (entry) => itemKey(entry) === event.target.value,
                );
                if (source) openDetail(source);
              }}
            >
              {detailApp.sources.map((source) => (
                <NativeSelectOption key={itemKey(source)} value={itemKey(source)}>
                  {sourceLabel(source)} · {source.slug}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{sourceLabel(item)}</p>
        )}
        <Card data-testid="connection-accounts">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
            <CardTitle>
              <Trans>Accounts</Trans>
            </CardTitle>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending !== null}
              onClick={() => void connect(item)}
            >
              <Trans>Add account</Trans>
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {current.length ? (
              current.map((row) => renderAccount(row, item))
            ) : (
              <p className="text-sm text-muted-foreground">
                <Trans>No active accounts.</Trans>
              </p>
            )}
            {history.length ? (
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  <Trans>Disconnected accounts ({history.length})</Trans>
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  {history.map((row) => renderAccount(row, item))}
                </div>
              </details>
            ) : null}
          </CardContent>
        </Card>
        <Card data-testid="connection-tools">
          <CardHeader>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 text-left"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen((open) => !open)}
            >
              <CardTitle>
                {toolsLoading ? (
                  <Trans>Tools</Trans>
                ) : (
                  <Plural value={tools.length} one="# tool" other="# tools" />
                )}
              </CardTitle>
              {toolsOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </button>
          </CardHeader>
          {toolsOpen ? (
            <CardContent>
              {toolsLoading ? (
                <p className="text-sm text-muted-foreground">
                  <Trans>Loading tools…</Trans>
                </p>
              ) : toolsError ? (
                <p role="alert" className="text-sm text-destructive">
                  {toolsError}
                </p>
              ) : tools.length ? (
                <ul className="flex flex-col gap-2">
                  {tools.map((tool) => (
                    <li key={tool.name} className="text-sm">
                      {humanizeToolName(tool.name)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  <Trans>No tools available.</Trans>
                </p>
              )}
            </CardContent>
          ) : null}
        </Card>
        {uninstallable.length ? (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={pending !== null}
              onClick={() => void prepareRemoval(item)}
            >
              <Trans>Uninstall source</Trans>
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[760px] max-h-[calc(100%-2rem)] w-[1080px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[1080px]"
      >
        <DialogHeader className="flex-row items-center justify-between px-6 pt-6 sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            {detailItem ? (
              <Button variant="ghost" size="icon-sm" aria-label={t`Back`} onClick={closeDetail}>
                <ChevronLeft />
              </Button>
            ) : null}
            {detailApp?.logo ? (
              <img src={detailApp.logo} alt="" className="size-9 rounded-xl object-contain" />
            ) : null}
            <DialogTitle className="truncate">
              {detailApp ? detailApp.name : <Trans>Integrations</Trans>}
            </DialogTitle>
          </div>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close integrations`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>

        {!detailItem ? (
          <div className="px-8 pt-4">
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
              }}
              aria-label={t`Search apps`}
              placeholder={t`Search apps`}
              className="h-11 rounded-xl px-4 md:text-[15px]"
            />
          </div>
        ) : null}

        <div id="integration-list" className="rk-scroll flex-1 overflow-y-auto px-8 py-6">
          {!detailItem ? (
            <Button
              variant="outline"
              className="mb-4"
              onClick={() => setSetupOpen((current) => !current)}
            >
              <Trans>Browse MCP servers</Trans>
            </Button>
          ) : null}
          {setupOpen && !detailItem ? (
            <div className="mb-6">
              <IntegrationSetup
                botId={activeBotId}
                onDone={() => {
                  setSetupOpen(false);
                  void refresh().catch((err: unknown) =>
                    setCatalogError(errorText(err, t`Could not load integrations`)),
                  );
                }}
              />
            </div>
          ) : null}
          {catalogError ? (
            <div className="mb-4 flex flex-col gap-2">
              <p role="alert" className="text-sm text-destructive">
                {catalogError}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={pending !== null}
                onClick={() => void refreshStatus()}
              >
                <Trans>Refresh status</Trans>
              </Button>
            </div>
          ) : null}
          {notice ? (
            <p role="status" className="mb-4 text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}

          {detailItem ? (
            renderDetail(detailItem)
          ) : (
            <>
              <Tabs
                value={catalogFilter}
                onValueChange={(value) => {
                  setCatalogFilter(value as "all" | "connected");
                  setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
                }}
              >
                <TabsList aria-label={t`Application filter`}>
                  <TabsTrigger value="all">
                    <Trans>All apps</Trans> · {apps.length}
                  </TabsTrigger>
                  <TabsTrigger value="connected">
                    <Trans>Connected</Trans> ·{" "}
                    {
                      apps.filter((app) => connectionAppSummary(app, connections).isConnected)
                        .length
                    }
                  </TabsTrigger>
                </TabsList>
                <TabsContent value={catalogFilter} className="mt-5 flex flex-col gap-5">
                  {loading ? (
                    <p className="text-muted-foreground">
                      <Trans>Loading integrations…</Trans>
                    </p>
                  ) : null}
                  {!loading && !catalog.length ? (
                    <p className="text-muted-foreground">
                      <Trans>Configure a plugin catalog on the server to connect apps.</Trans>
                    </p>
                  ) : null}
                  {!loading && catalog.length > 0 && !visible.length ? (
                    <p className="text-muted-foreground">
                      {query.trim() ? (
                        <Trans>No apps match your search.</Trans>
                      ) : (
                        <Trans>No connected apps.</Trans>
                      )}
                    </p>
                  ) : null}
                  {rendered.some((app) => app.firstParty) ? (
                    <section className="flex flex-col gap-3">
                      <h2 className="text-sm font-medium text-muted-foreground">
                        <Trans>By Cogine</Trans>
                      </h2>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {rendered.filter((app) => app.firstParty).map(renderCatalogTile)}
                      </div>
                    </section>
                  ) : null}
                  <div
                    data-testid="featured-connectors"
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    {rendered.filter((app) => !app.firstParty).map(renderCatalogTile)}
                  </div>
                  {rendered.length < visible.length ? (
                    <div className="flex justify-center">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)
                        }
                      >
                        <Trans>Show more</Trans>
                      </Button>
                    </div>
                  ) : null}
                </TabsContent>
              </Tabs>

              <details
                data-testid="integrations-advanced"
                className="group mt-8"
                onToggle={(event) => {
                  if (!(event.currentTarget as HTMLDetailsElement).open) {
                    setSourceKind(null);
                    setSourceError(null);
                    setSourceHint(null);
                    setSourceName("");
                    setSourceUrl("");
                    setCredential("");
                    setAuthType("none");
                    setAuthName("x-api-key");
                  }
                }}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
                  <span className="text-muted-foreground">
                    <Trans>Advanced</Trans>
                  </span>
                  <span aria-hidden="true" className="transition-transform group-open:rotate-90">
                    ›
                  </span>
                </summary>

                <div className="mt-4 space-y-4">
                  {catalogFeedEnabled ? (
                    <Card data-testid="integrations-catalog-feed">
                      <CardHeader>
                        <CardTitle>
                          <Trans>Search by domain</Trans>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <form
                          className="flex gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void searchCatalogFeed();
                          }}
                        >
                          <Input
                            value={catalogFeedQuery}
                            disabled={catalogFeedPending}
                            onChange={(event) => {
                              setCatalogFeedQuery(event.target.value);
                              setCatalogFeedResults([]);
                              setCatalogFeedError(null);
                              setCatalogFeedSearched(false);
                            }}
                            placeholder="github.com"
                            aria-label={t`Integration domain`}
                          />
                          <Button
                            type="submit"
                            variant="secondary"
                            className="rounded-full"
                            size="sm"
                            disabled={!catalogFeedQuery.trim() || catalogFeedPending}
                          >
                            {catalogFeedPending ? <Trans>Searching…</Trans> : <Trans>Search</Trans>}
                          </Button>
                        </form>
                        {catalogFeedError ? (
                          <p className="text-sm text-destructive">{catalogFeedError}</p>
                        ) : null}
                        {catalogFeedSearched &&
                        !catalogFeedPending &&
                        catalogFeedResults.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            <Trans>No results</Trans>
                          </p>
                        ) : null}
                        {catalogFeedResults.map((result) => (
                          <div
                            key={`${result.domain}:${result.name}:${result.pageUrl ?? ""}`}
                            className="rounded-xl border border-border/70 p-3"
                          >
                            <div className="font-medium text-foreground">
                              {result.pageUrl ? (
                                <a
                                  href={result.pageUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="hover:underline"
                                >
                                  {result.name}
                                </a>
                              ) : (
                                result.name
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">{result.domain}</div>
                            {result.description ? (
                              <p className="mt-2 text-sm leading-5 text-muted-foreground">
                                {result.description}
                              </p>
                            ) : null}
                            <div className="mt-3 flex flex-wrap gap-2">
                              {result.surfaces.map((surface) => {
                                const canAdd =
                                  Boolean(surface.source) &&
                                  (surface.kind === "mcp" || surface.kind === "openapi");
                                return (
                                  <Button
                                    key={`${result.domain}:${surface.slug}`}
                                    type="button"
                                    variant="secondary"
                                    className="rounded-full"
                                    size="sm"
                                    disabled={!canAdd}
                                    title={canAdd ? undefined : t`Manual setup required`}
                                    onClick={() => beginCatalogSurface(result, surface)}
                                  >
                                    {surface.kind.toUpperCase()} · {canAdd ? t`Add` : t`Manual`}
                                  </Button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  ) : null}

                  <div data-testid="integrations-advanced-add" className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      onClick={() => beginSource("mcp")}
                    >
                      <Trans>Add MCP server</Trans>
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      onClick={() => beginSource("api")}
                    >
                      <Trans>Add OpenAPI</Trans>
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      onClick={() => beginSource("graphql")}
                    >
                      <Trans>Add GraphQL</Trans>
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      onClick={() => beginSource("executor")}
                    >
                      <Trans>Add Executor</Trans>
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      onClick={() => beginSource("treg")}
                    >
                      <Trans>Add Treg</Trans>
                    </Button>
                  </div>

                  {sourceError ? <p className="text-sm text-destructive">{sourceError}</p> : null}

                  {sourceKind ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>
                          {sourceKind === "treg" ? (
                            <Trans>Connect Treg</Trans>
                          ) : sourceKind === "executor" ? (
                            <Trans>Connect Executor</Trans>
                          ) : sourceKind === "mcp" ? (
                            <Trans>Add remote MCP server</Trans>
                          ) : sourceKind === "graphql" ? (
                            <Trans>Add GraphQL endpoint</Trans>
                          ) : (
                            <Trans>Import OpenAPI JSON</Trans>
                          )}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <Input
                          value={sourceName}
                          onChange={(event) => setSourceName(event.target.value)}
                          placeholder={t`Display name`}
                        />
                        {sourceKind !== "treg" ? (
                          <Input
                            value={sourceUrl}
                            onChange={(event) => setSourceUrl(event.target.value)}
                            placeholder={
                              sourceKind === "mcp"
                                ? "https://example.com/mcp"
                                : sourceKind === "executor"
                                  ? "https://executor.example/mcp"
                                  : sourceKind === "graphql"
                                    ? "https://example.com/graphql"
                                    : "https://example.com/openapi.json"
                            }
                          />
                        ) : null}
                        {sourceKind !== "treg" && sourceKind !== "executor" ? (
                          <NativeSelect
                            className="w-full"
                            value={authType}
                            onChange={(event) => setAuthType(event.target.value as typeof authType)}
                          >
                            <NativeSelectOption value="none">
                              <Trans>No authentication</Trans>
                            </NativeSelectOption>
                            <NativeSelectOption value="bearer">
                              <Trans>Bearer token</Trans>
                            </NativeSelectOption>
                            <NativeSelectOption value="header">
                              <Trans>API key header</Trans>
                            </NativeSelectOption>
                          </NativeSelect>
                        ) : null}
                        {authType === "header" &&
                        sourceKind !== "treg" &&
                        sourceKind !== "executor" ? (
                          <Input
                            value={authName}
                            onChange={(event) => setAuthName(event.target.value)}
                            placeholder={t`Header name`}
                          />
                        ) : null}
                        {sourceKind === "treg" ||
                        sourceKind === "executor" ||
                        authType !== "none" ? (
                          <Input
                            type="password"
                            autoComplete="new-password"
                            value={credential}
                            onChange={(event) => setCredential(event.target.value)}
                            placeholder={
                              sourceKind === "treg"
                                ? t`Treg token`
                                : sourceKind === "executor"
                                  ? t`Executor token`
                                  : t`Credential`
                            }
                          />
                        ) : null}
                        <p className="text-xs leading-5 text-muted-foreground">
                          <Trans>Credentials are encrypted and never sent to the model.</Trans>
                        </p>
                        {sourceHint ? (
                          <p className="text-xs leading-5 text-muted-foreground">{sourceHint}</p>
                        ) : null}
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            className="rounded-full"
                            size="sm"
                            disabled={pending === "install-source"}
                            onClick={() => void installSource()}
                          >
                            {pending === "install-source" ? (
                              <Trans>Verifying…</Trans>
                            ) : (
                              <Trans>Verify and add</Trans>
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            className="rounded-full"
                            size="sm"
                            onClick={() => setSourceKind(null)}
                          >
                            <Trans>Cancel</Trans>
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ) : null}

                  <div>
                    <div className="mb-3 text-sm font-medium text-foreground/75">
                      <Trans>Tool sources</Trans>
                    </div>
                    {sources.length === 0 && !sourceKind ? (
                      <p className="text-muted-foreground/80">
                        <Trans>No MCP or API tool sources installed yet.</Trans>
                      </p>
                    ) : null}
                    {sources.map((source) => (
                      <div
                        key={source.id}
                        className="flex items-center gap-4 rounded-xl px-3 py-2.5"
                      >
                        <div className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-accent font-semibold uppercase text-foreground">
                          {source.kind === "mcp" ? "M" : source.kind === "graphql" ? "G" : "A"}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[15.5px] font-medium text-foreground">
                            {source.name}
                          </div>
                          <div className="truncate text-[13.5px] text-muted-foreground/70">
                            {source.kind.toUpperCase()} · {source.source} ·{" "}
                            {source.secretConfigured ? (
                              <Trans>credential saved</Trans>
                            ) : (
                              <Trans>no auth</Trans>
                            )}
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          className="rounded-full"
                          size="sm"
                          disabled={pending === source.id}
                          onClick={() => void removeSource(source)}
                        >
                          {pending === source.id ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
                        </Button>
                      </div>
                    ))}
                    {onOpenMcp ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="mt-2 px-0 text-muted-foreground"
                        onClick={onOpenMcp}
                      >
                        <Trans>Manage MCP servers</Trans>
                      </Button>
                    ) : null}
                  </div>
                </div>
              </details>
            </>
          )}
        </div>
      </DialogContent>
      <AlertDialog
        open={removal !== null}
        onOpenChange={(open) => {
          if (!open && pending !== "remove") setRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removal?.account ? (
                <Trans>Disconnect this account?</Trans>
              ) : (
                <Trans>Uninstall this source?</Trans>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removal ? (
                <>
                  {removal.item.name} · {sourceLabel(removal.item)} · {removal.item.slug}
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="flex flex-col gap-2 text-sm">
            {removal?.targets.map((row) => (
              <li key={row.id}>{row.displayName}</li>
            ))}
          </ul>
          {!removal?.account &&
          removal &&
          catalogAccounts(connections, removal.item).some((row) => row.status === "error") ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Accounts that need attention are kept. Manage them individually.</Trans>
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            <Trans>Other sources stay connected. Operations already sent may still finish.</Trans>
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending === "remove"}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending === "remove"}
              onClick={() => void runRemoval()}
            >
              {pending === "remove" ? (
                <Trans>Disconnecting…</Trans>
              ) : removal?.account ? (
                <Trans>Disconnect account</Trans>
              ) : (
                <Trans>Uninstall source</Trans>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
