import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  canonicalConnectionAppId,
  catalogAccounts,
  catalogItemConnected,
  catalogUninstallAccounts,
  connectionAppSummary,
  connectionRemovalState,
  filterConnectionApps,
  groupConnectionCatalog,
  preferredConnectionSource,
} from "./connection-catalog.js";

const source = (connectorId: string, slug = "gmail", name = "Gmail"): ConnectionCatalogItem => ({
  connectorId,
  slug,
  name,
  connected: false,
  noAuth: false,
  logo: null,
});
const account = (
  connectorId: string,
  status: Connection["status"],
  provider = "gmail",
): Connection => ({
  id: `${connectorId}-${status}`,
  connectorId,
  provider,
  displayName: "Account",
  status,
  capabilities: [],
  createdAt: "2026-01-01",
});

describe("connection catalog presentation", () => {
  it.each(["composio", "pipedream"])(
    "chooses available %s when the first native source is unconfigured",
    (broker) => {
      const app = groupConnectionCatalog([
        { ...source("native"), connectable: false },
        source(broker),
      ])[0]!;
      expect(preferredConnectionSource(app, [])?.connectorId).toBe(broker);
      expect(app.sources[0]?.connectorId).toBe("native");
    },
  );
  it.each(["connected", "pending"] as const)(
    "keeps an existing %s native account ahead of another available source",
    (status) => {
      const app = groupConnectionCatalog([
        { ...source("native"), connectable: false },
        source("composio"),
      ])[0]!;
      expect(preferredConnectionSource(app, [account("native", status)])?.connectorId).toBe(
        "native",
      );
    },
  );
  it("keeps connected ahead of pending and still permits explicit unconfigured sources", () => {
    const native = { ...source("native"), connectable: false };
    const app = groupConnectionCatalog([native, source("composio")])[0]!;
    expect(
      preferredConnectionSource(app, [
        account("native", "pending"),
        account("composio", "connected"),
      ])?.connectorId,
    ).toBe("composio");
    const unavailable = groupConnectionCatalog([
      native,
      { ...source("composio"), connectable: false },
    ])[0]!;
    expect(preferredConnectionSource(unavailable, [])?.connectorId).toBe("native");
    expect(
      preferredConnectionSource(
        groupConnectionCatalog([{ ...native, connectable: true }, source("composio")])[0]!,
        [],
      )?.connectorId,
    ).toBe("native");
  });
  it("groups known app aliases without changing exact provider identities", () => {
    const apps = groupConnectionCatalog([
      source("composio", "GMAIL"),
      source("pipedream", "googlemail"),
      source("third", "gmail-other", "Another app"),
    ]);
    expect(apps).toHaveLength(2);
    expect(apps[0]?.sources.map((item) => [item.connectorId, item.slug])).toEqual([
      ["composio", "GMAIL"],
      ["pipedream", "googlemail"],
    ]);
    expect(
      catalogAccounts(
        [
          account("composio", "connected", "GMAIL"),
          account("pipedream", "connected", "googlemail"),
        ],
        apps[0]!.sources[0]!,
      ),
    ).toHaveLength(1);
  });
  it("does not merge unknown applications merely because their names match", () => {
    expect(
      groupConnectionCatalog([
        source("one", "first-app", "Example"),
        source("two", "first-app", "Example"),
      ]),
    ).toHaveLength(2);
  });
  it("exports only known aliases for cross-provider execution intent", () => {
    expect(canonicalConnectionAppId("Google Mail")).toBe("gmail");
    expect(canonicalConnectionAppId("google_calendar")).toBe("google-calendar");
    expect(canonicalConnectionAppId("slackbot")).toBe("slack");
    expect(canonicalConnectionAppId("CogineAtlas")).toBe("knowai");
    expect(canonicalConnectionAppId("custom_gmail_app")).toBeNull();
    for (const app of [
      "github",
      "linear",
      "jira",
      "confluence",
      "gitlab",
      "todoist",
      "trello",
      "asana",
      "clickup",
      "airtable",
    ])
      expect(canonicalConnectionAppId(app.toUpperCase())).toBe(app);
    expect(
      groupConnectionCatalog([
        source("one", "unknown", "Gmail"),
        source("two", "unknown", "Gmail"),
      ]),
    ).toHaveLength(2);
    expect(
      groupConnectionCatalog([
        source("one", "github", "GitHub"),
        source("two", "GITHUB", "GitHub"),
      ]),
    ).toHaveLength(1);
  });
  it("does not let broad remote status override a locally revoked, pending or error connection", () => {
    const item = { ...source("one"), connected: true };
    for (const status of ["revoked", "pending", "error"] as const) {
      expect(catalogItemConnected([account("one", status)], item)).toBe(false);
    }
    expect(catalogItemConnected([], item)).toBe(true);
    expect(
      connectionAppSummary(
        groupConnectionCatalog([item, { ...source("two"), connected: true }])[0]!,
        [account("one", "revoked")],
      ).isConnected,
    ).toBe(true);
  });
  it("only shows first-party apps actually returned by the catalog, without a fixed catalog limit", () => {
    expect(groupConnectionCatalog([])).toEqual([]);
    const apps = groupConnectionCatalog([
      source("mcp", "cogineatlas", "CogineAtlas"),
      ...Array.from({ length: 70 }, (_, i) => source("dynamic", `app-${i}`, `App ${i}`)),
    ]);
    expect(apps).toHaveLength(71);
    expect(apps.filter((app) => app.firstParty).map((app) => app.name)).toEqual(["Knowai"]);
    expect(filterConnectionApps(apps, "app-69")).toHaveLength(1);
  });
  it("keeps connected, waiting and error facts separate for mixed accounts", () => {
    const app = groupConnectionCatalog([source("one"), source("two")])[0]!;
    const summary = connectionAppSummary(app, [
      account("one", "connected"),
      account("two", "error"),
      account("two", "pending"),
    ]);
    expect(summary.status).toBe("connected");
    expect(summary.errors).toHaveLength(1);
    expect(summary.pending).toHaveLength(1);
    expect(connectionAppSummary(app, [account("one", "revoked")]).isConnected).toBe(false);
  });
  it("uninstalls only connected and pending accounts of the exact source", () => {
    const rows = [
      account("one", "connected"),
      account("one", "pending"),
      account("one", "error"),
      account("one", "revoked"),
      account("two", "connected"),
      account("one", "connected", "calendar"),
    ];
    expect(catalogUninstallAccounts(rows, source("one")).map((row) => row.status)).toEqual([
      "connected",
      "pending",
    ]);
  });
  it("distinguishes a locally revoked DELETE timeout from an active or unverified account", () => {
    const row = account("one", "revoked");
    expect(connectionRemovalState([row], row.id)).toBe("revoked");
    expect(connectionRemovalState([{ ...row, status: "connected" }], row.id)).toBe("active");
    expect(connectionRemovalState([], row.id)).toBe("unverified");
    expect(connectionRemovalState(null, row.id)).toBe("unverified");
  });
});
