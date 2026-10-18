import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { matchFeaturedConnectorId } from "./featured-connectors.js";

export type ConnectionApp = {
  id: string;
  name: string;
  logo: string | null;
  firstParty: boolean;
  sources: ConnectionCatalogItem[];
};

export function connectionCatalogKey(item: Pick<ConnectionCatalogItem, "connectorId" | "slug">) {
  return JSON.stringify([item.connectorId, item.slug]);
}

export function connectionMatchesCatalog(
  row: Connection,
  item: Pick<ConnectionCatalogItem, "connectorId" | "slug">,
) {
  return row.connectorId === item.connectorId && row.provider === item.slug;
}

export function catalogAccounts(rows: readonly Connection[], item: ConnectionCatalogItem) {
  return rows.filter((row) => connectionMatchesCatalog(row, item));
}

/** Keep mutation scope at the provider's exact catalog identity, including pending accounts. */
export function catalogUninstallAccounts(rows: readonly Connection[], item: ConnectionCatalogItem) {
  return catalogAccounts(rows, item).filter(
    (row) => row.status === "connected" || row.status === "pending",
  );
}

// Curated application aliases, shared by catalog grouping and explicit account routing.
// A display name is never sufficient to establish cross-provider identity.
const APP_LABELS: Record<string, string> = {
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
  "google-drive": "Google Drive",
  slack: "Slack",
  notion: "Notion",
  googledocs: "Google Docs",
  googlesheets: "Google Sheets",
  googleslides: "Google Slides",
  outlookmail: "Outlook Mail",
  outlookcalendar: "Outlook Calendar",
  onedrive: "OneDrive",
  microsofttodo: "Microsoft To Do",
  github: "GitHub",
  gitlab: "GitLab",
  linear: "Linear",
  jira: "Jira",
  confluence: "Confluence",
  todoist: "Todoist",
  trello: "Trello",
  asana: "Asana",
  clickup: "ClickUp",
  airtable: "Airtable",
  dropbox: "Dropbox",
  hubspot: "HubSpot",
  figma: "Figma",
  googletasks: "Google Tasks",
  sharepoint: "SharePoint",
  teams: "Microsoft Teams",
  excel: "Excel",
  planner: "Microsoft Planner",
  feishulark: "Feishu / Lark",
  dingtalk: "DingTalk",
  wecom: "WeCom",
  telegrambot: "Telegram Bot",
  discord: "Discord",
  coginex: "CogineX",
  knowai: "Knowai",
};
const APP_ALIASES: Record<string, string> = {
  jiraatlassian: "jira",
  jiracloud: "jira",
  confluencecloud: "confluence",
  microsoftteams: "teams",
  microsoftexcel: "excel",
  microsoftplanner: "planner",
  microsoftonedrive: "onedrive",
  feishu: "feishulark",
  lark: "feishulark",
  telegram: "telegrambot",
  cogineatlas: "knowai",
};

/** Only explicitly known provider slugs establish identity across different routes. */
export function canonicalConnectionAppId(value: string): string | null {
  const featured = matchFeaturedConnectorId(value);
  if (featured) return featured;
  const normalized = value.toLowerCase().replace(/[\s_-]/g, "");
  return APP_ALIASES[normalized] ?? (Object.hasOwn(APP_LABELS, normalized) ? normalized : null);
}

export function catalogItemConnected(rows: readonly Connection[], item: ConnectionCatalogItem) {
  const local = catalogAccounts(rows, item);
  return local.length ? local.some((row) => row.status === "connected") : item.connected;
}

/** Keep existing accounts first; an unconfigured source must not obscure an available one. */
export function preferredConnectionSource(app: ConnectionApp, rows: readonly Connection[]) {
  return (
    app.sources.find((source) => catalogItemConnected(rows, source)) ??
    app.sources.find((source) =>
      catalogAccounts(rows, source).some((row) => row.status === "pending"),
    ) ??
    app.sources.find((source) => source.connectable !== false) ??
    app.sources[0]
  );
}

function appIdentity(item: ConnectionCatalogItem) {
  const known = canonicalConnectionAppId(item.slug);
  if (known)
    return {
      id: known,
      name: APP_LABELS[known] ?? item.name,
      firstParty: known === "coginex" || known === "knowai",
    };
  // Unknown routes remain separate even when suppliers use the same slug and name.
  return { id: connectionCatalogKey(item), name: item.name, firstParty: false };
}

export function groupConnectionCatalog(items: readonly ConnectionCatalogItem[]): ConnectionApp[] {
  const groups = new Map<string, ConnectionApp>();
  for (const item of items) {
    const identity = appIdentity(item);
    const group = groups.get(identity.id);
    if (group) {
      if (
        !group.sources.some((source) => connectionCatalogKey(source) === connectionCatalogKey(item))
      ) {
        group.sources.push(item);
      }
      group.logo ??= item.logo;
    } else groups.set(identity.id, { ...identity, logo: item.logo, sources: [item] });
  }
  return [...groups.values()];
}

export function connectionAppAccounts(app: ConnectionApp, rows: readonly Connection[]) {
  return rows.filter((row) => app.sources.some((source) => connectionMatchesCatalog(row, source)));
}

export function connectionAppSummary(app: ConnectionApp, rows: readonly Connection[]) {
  const accounts = connectionAppAccounts(app, rows);
  const connected = accounts.filter((row) => row.status === "connected");
  const pending = accounts.filter((row) => row.status === "pending");
  const errors = accounts.filter((row) => row.status === "error");
  const revoked = accounts.filter((row) => row.status === "revoked");
  const isConnected = app.sources.some((source) => catalogItemConnected(rows, source));
  const status: Connection["status"] | null = isConnected
    ? "connected"
    : pending.length
      ? "pending"
      : errors.length
        ? "error"
        : revoked.length
          ? "revoked"
          : null;
  return { accounts, connected, pending, errors, revoked, isConnected, status };
}

export function filterConnectionApps(apps: readonly ConnectionApp[], query: string) {
  const needle = query.trim().toLowerCase();
  return apps.filter(
    (app) =>
      !needle ||
      [
        app.name,
        ...app.sources.flatMap((source) => [source.slug, source.connectorId, source.name]),
      ].some((value) => value.toLowerCase().includes(needle)),
  );
}

/** A failed DELETE may have stopped local access even when its remote result is unknown. */
export function connectionRemovalState(rows: readonly Connection[] | null, id: string) {
  if (rows === null) return "unverified";
  const row = rows.find((entry) => entry.id === id);
  if (!row) return "unverified";
  return row.status === "revoked" ? "revoked" : "active";
}
