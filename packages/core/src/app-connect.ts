import type { ConnectionCatalogItem, MessageBlock } from "@rakazo/contracts";
import { canonicalConnectionAppId } from "./connection-catalog.js";

export type AppConnectBlock = Extract<MessageBlock, { kind: "app_connect" }>;

const APP_DESCRIPTIONS: Record<string, string> = {
  slack: "Search, read, and send messages.",
  gmail: "Search, read, draft, and send email.",
  "google-calendar": "Search events and schedule meetings.",
  notion: "Search and edit pages and databases.",
  googledocs: "Draft and edit documents.",
  hackernews: "Search stories and discussions.",
};

export function matchAppCatalog(catalog: readonly ConnectionCatalogItem[], app: string) {
  const query = app.trim().toLowerCase();
  const canonical = canonicalConnectionAppId(query);
  return (
    catalog.find(
      (entry) => entry.slug.toLowerCase() === query || entry.name.toLowerCase() === query,
    ) ??
    (canonical
      ? catalog.find((entry) => canonicalConnectionAppId(entry.slug) === canonical)
      : undefined)
  );
}

export function appConnectCard(entry: ConnectionCatalogItem): AppConnectBlock {
  const description =
    APP_DESCRIPTIONS[canonicalConnectionAppId(entry.slug) ?? entry.slug.toLowerCase()] ?? "";
  return {
    kind: "app_connect",
    connectorId: entry.connectorId,
    provider: entry.slug,
    name: entry.name,
    description,
    logo: entry.logo,
    status: entry.connected ? "connected" : "pending",
  };
}

/** Older onboarding cards without a connector belong to the original managed provider. */
export function matchesAppConnection(
  block: MessageBlock,
  connectorId: string,
  provider: string,
): block is AppConnectBlock {
  return (
    block.kind === "app_connect" &&
    (block.connectorId ?? "composio") === connectorId &&
    block.provider.toLowerCase() === provider.toLowerCase()
  );
}
