import { expect, test } from "@playwright/test";
import type {
  AppBootstrap,
  Connection,
  ConnectionCatalogItem,
  NativeConfigStatus,
  NativeSetupState,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openIntegrations,
  signup,
} from "./helpers";

const callbackUri = "https://app.example.test/api/connectors/oauth/callback";
function method(id: string, ownership: NativeConfigStatus["ownership"]): NativeConfigStatus {
  return {
    id,
    appId: "knowai",
    label: id,
    ownership,
    credentialKind: "machine_key",
    enabled: true,
    configured: true,
    revision: 1,
    callbackUri,
    executionLocation: "instance",
  };
}
const expired: Connection = {
  id: "old-account",
  connectorId: "native",
  provider: "knowai",
  displayName: "Previous account",
  status: "error",
  capabilities: [],
  createdAt: "2026-01-01",
  remoteAccountId: null,
};

test("native connection chooses a method and Back cancels only the late new attempt", async ({
  page,
}, testInfo) => {
  await signup(page, `native-ui-${Date.now()}@rakazo.test`, "password12", "Native accounts");
  await completeOnboarding(page);
  const setup: NativeSetupState = {
    canConfigure: false,
    callbackUri,
    configurations: [method("Company knowledge", "official"), method("Team knowledge", "byo")],
  };
  const begins: unknown[] = [],
    revoked: string[] = [],
    legacyBegins: unknown[] = [];
  let releaseBegin: (() => void) | undefined;
  await page.route("**/rpc/nativeConnectors/status", (route) =>
    route.fulfill({ json: { json: setup } }),
  );
  await page.route("**/rpc/connections/catalog", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            connectorId: "native",
            slug: "knowai",
            name: "Knowai",
            logo: null,
            noAuth: false,
            connected: false,
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/connections/list", (route) =>
    route.fulfill({ json: { json: [expired] } }),
  );
  await page.route("**/rpc/connections/tools", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/connections/begin", (route) => {
    legacyBegins.push(route.request().postDataJSON().json);
    return route.abort();
  });
  await page.route("**/rpc/nativeConnectors/begin", async (route) => {
    begins.push(route.request().postDataJSON().json);
    await new Promise<void>((resolve) => {
      releaseBegin = resolve;
    });
    await route.fulfill({
      json: { json: { connectionId: "new-attempt", authorizationUrl: null } },
    });
  });
  await page.route("**/rpc/connections/revoke", (route) => {
    revoked.push(route.request().postDataJSON().json.connectionId);
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await openIntegrations(page);
  await page
    .getByTestId("connection-tile-knowai")
    .getByRole("button", { name: /Knowai/ })
    .click();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect account", exact: true })).toBeVisible();
  const form = page
    .locator("form")
    .filter({ has: page.getByLabel("Connection method", { exact: true }) });
  await expect(form.getByLabel("Connection method", { exact: true })).toHaveValue("");
  await expect(form.getByRole("button", { name: "Connect account", exact: true })).toBeDisabled();
  await form.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Knowai", exact: true })).toHaveCount(1);
  await page
    .getByTestId("connection-account-old-account")
    .getByRole("button", { name: "Authorize again", exact: true })
    .click();
  await form.getByLabel("Connection method", { exact: true }).selectOption("Team knowledge");
  await expect(
    form.getByLabel("Connection method", { exact: true }).locator("option:checked"),
  ).toContainText("Your application");
  const key = form.getByLabel("Machine API key", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("synthetic-user-credential");
  await captureScreenshot(page, testInfo, "native-account-method");
  await form.getByRole("button", { name: "Connect machine", exact: true }).click();
  await expect.poll(() => begins.length).toBe(1);
  await form.getByRole("button", { name: "Back", exact: true }).click();
  releaseBegin?.();
  await expect.poll(() => revoked).toEqual(["new-attempt"]);
  expect(begins).toEqual([
    {
      configId: "Team knowledge",
      previousConnectionId: "old-account",
      credential: "synthetic-user-credential",
    },
  ]);
  expect(legacyBegins).toEqual([]);
  await expect(page.getByTestId("connection-account-old-account")).toBeVisible();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await form.getByLabel("Connection method", { exact: true }).selectOption("Team knowledge");
  await expect(form.getByLabel("Machine API key", { exact: true })).toHaveValue("");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "native-account-mobile");
  await form.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Knowai", exact: true })).toHaveCount(1);
});

test("application settings keep secrets write-only and return to the application list", async ({
  page,
}, testInfo) => {
  await signup(page, `native-setup-${Date.now()}@rakazo.test`, "password12", "Application setup");
  await completeOnboarding(page);
  const entry = {
    ...method("Calendar application", "byo"),
    appId: "google-calendar" as const,
    credentialKind: "oauth" as const,
  };
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: true,
          needsSetup: false,
          webUrl: "https://app.example.test/integrations/setup",
          providers: [],
        },
      },
    }),
  );
  await page.route("**/rpc/nativeConnectors/status", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: true,
          callbackUri,
          configurations: [entry],
        },
      },
    }),
  );
  await page.route("**/rpc/nativeConnectors/configuration", (route) =>
    route.fulfill({
      json: {
        json: {
          ...entry,
          clientId: "synthetic-client",
          hasClientSecret: true,
          scopes: ["openid", "email"],
          capabilities: [],
          knowledgeBaseIds: [],
        },
      },
    }),
  );
  const saved: Record<string, unknown>[] = [];
  await page.route("**/rpc/nativeConnectors/save", (route) => {
    saved.push(route.request().postDataJSON().json);
    return route.fulfill({ json: { json: { ...entry, label: "Updated calendar" } } });
  });
  await page.goto("/integrations/setup");
  const section = page.getByRole("region", { name: "Application credentials", exact: true });
  await section.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(section.getByLabel("Client secret", { exact: true })).toHaveValue("");
  await expect(section.getByLabel("Callback URL", { exact: true })).toHaveValue(callbackUri);
  await expect(section.getByLabel("Callback URL", { exact: true })).toHaveAttribute("readonly", "");
  await section.getByLabel("Connection method name", { exact: true }).fill("Updated calendar");
  await captureScreenshot(page, testInfo, "native-application-settings");
  await section.getByRole("button", { name: "Save application", exact: true }).click();
  await expect(section.getByRole("button", { name: "Add application", exact: true })).toBeVisible();
  expect(saved).toHaveLength(1);
  expect(saved[0]).not.toHaveProperty("clientSecret");
  expect(saved[0]).toMatchObject({ id: entry.id, expectedRevision: 1, label: "Updated calendar" });
  await expect(section.getByText("Updated calendar", { exact: true })).toBeVisible();
});

test("native conversation card survives blocked popup and refreshes exact account mentions after connect and disconnect", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const expectedCapabilitiesConsole: string[] = [];
  let capabilitiesUrl = "";
  let failedCapabilitiesCalls = 0;
  let normalCapabilitiesCalls = 0;
  let failConnectedRefresh = false;
  const hydrationCalls: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    // Only this deliberate service failure is an expected browser resource error.
    if (
      failedCapabilitiesCalls > 0 &&
      message.location().url === capabilitiesUrl &&
      /^Failed to load resource: the server responded with a status of 503(?:\s|$)/.test(
        message.text(),
      )
    ) {
      expectedCapabilitiesConsole.push(message.text());
      return;
    }
    consoleErrors.push(message.text());
  });
  await signup(page, `native-card-${Date.now()}@rakazo.test`, "password12", "Native card");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  capabilitiesUrl = new URL("/rpc/capabilities/list", page.url()).toString();
  const connectionId = "native-calendar-card-account";
  const displayName = "Card calendar · Exact account";
  const messageId = "synthetic-native-calendar-card";
  const authorizationUrl = new URL(
    `/api/connectors/oauth/start?state=${"s".repeat(43)}`,
    page.url(),
  ).toString();
  const setup: NativeSetupState = {
    canConfigure: false,
    callbackUri,
    configurations: [
      {
        id: "card-calendar-source",
        appId: "google-calendar",
        label: "Calendar source",
        ownership: "byo",
        credentialKind: "oauth",
        enabled: true,
        configured: true,
        revision: 1,
        callbackUri,
        executionLocation: "instance",
      },
    ],
  };
  const account = (status: Connection["status"]): Connection => ({
    id: connectionId,
    connectorId: "native",
    provider: "google-calendar",
    displayName,
    status,
    capabilities: [],
    createdAt: "2026-01-01",
    remoteAccountId: status === "connected" ? "synthetic-calendar-grant" : null,
  });
  let rows: Connection[] = [];
  let finishAuthorization = false;
  let completeCalls = 0;
  let listCalls = 0;
  const begins: unknown[] = [],
    legacyBegins: unknown[] = [],
    revoked: string[] = [];
  const catalog = (): ConnectionCatalogItem[] => [
    {
      connectorId: "native",
      slug: "google-calendar",
      name: "Google Calendar",
      logo: null,
      noAuth: false,
      connected: rows.some((row) => row.status === "connected"),
    },
  ];
  await page.route(/\/rpc\/(bootstrap|threads\/get)(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    hydrationCalls.push(new URL(route.request().url()).pathname);
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { json: AppBootstrap | ThreadSnapshot };
    const snapshot = "thread" in body.json ? body.json.thread : body.json;
    if (snapshot) {
      const seq = Math.max(snapshot.cursor, ...snapshot.messages.map((message) => message.seq)) + 1;
      snapshot.messages = [
        ...snapshot.messages.filter((message) => message.id !== messageId),
        {
          id: messageId,
          threadId: snapshot.threadId,
          botId,
          seq,
          role: "bot",
          createdAt: "2026-10-18T00:00:00.000Z",
          blocks: [
            {
              kind: "app_connect",
              connectorId: "native",
              provider: "google-calendar",
              name: "Google Calendar",
              description: "Use your calendar account.",
              logo: null,
              status: "pending",
            },
          ],
        },
      ];
      snapshot.cursor = seq;
    }
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/capabilities/list", async (route) => {
    if (finishAuthorization && failConnectedRefresh) {
      failedCapabilitiesCalls++;
      return route.fulfill({
        status: 503,
        json: {
          json: {
            defined: false,
            code: "SERVICE_UNAVAILABLE",
            status: 503,
            message: "Synthetic capabilities refresh failure",
          },
        },
      });
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    normalCapabilitiesCalls++;
    return route.fulfill({ response });
  });
  await page.route("**/rpc/nativeConnectors/status", (route) =>
    route.fulfill({ json: { json: setup } }),
  );
  await page.route("**/rpc/connections/catalog", (route) =>
    route.fulfill({ json: { json: catalog() } }),
  );
  await page.route("**/rpc/connections/list", (route) => {
    listCalls++;
    return route.fulfill({ json: { json: rows } });
  });
  await page.route("**/rpc/connections/tools", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/connections/begin", (route) => {
    legacyBegins.push(route.request().postDataJSON().json);
    return route.abort();
  });
  await page.route("**/rpc/nativeConnectors/begin", (route) => {
    begins.push(route.request().postDataJSON().json);
    rows = [account("pending")];
    return route.fulfill({ json: { json: { connectionId, authorizationUrl } } });
  });
  await page.route("**/rpc/connections/complete", (route) => {
    expect(route.request().postDataJSON().json.connectionId).toBe(connectionId);
    completeCalls++;
    rows = [account(finishAuthorization ? "connected" : "pending")];
    return route.fulfill({ json: { json: rows[0] } });
  });
  await page.route("**/rpc/connections/revoke", (route) => {
    const id = route.request().postDataJSON().json.connectionId;
    revoked.push(id);
    rows = rows.map((row) =>
      row.id === id ? { ...row, status: "revoked", remoteAccountId: null } : row,
    );
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const card = page
    .locator(`[data-message-id="${messageId}"]`)
    .getByRole("group", { name: "Google Calendar connection", exact: true });
  await expect(card).toBeVisible();
  await expect(page).toHaveTitle(/CogineBot/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("@Card calendar");
  await expect(
    page.locator(`[data-testid="mention-picker"] [data-mention-id="${connectionId}"]`),
  ).toHaveCount(0);
  await composer.fill("");
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Google Calendar", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const form = page
    .locator("form")
    .filter({ has: page.getByLabel("Connection method", { exact: true }) });
  await form.getByRole("button", { name: "Authorize account", exact: true }).click();
  const continuation = form.getByRole("link", { name: "Continue authorization", exact: true });
  await expect(continuation).toBeVisible();
  await expect(continuation).toHaveAttribute("href", authorizationUrl);
  await expect(continuation).toHaveAttribute("target", "_blank");
  await expect(continuation).toHaveAttribute("rel", "noopener noreferrer");
  await expect.poll(() => completeCalls).toBeGreaterThan(0);
  expect(page.context().pages()).toHaveLength(1);
  await captureScreenshot(page, testInfo, "native-card-blocked-popup-continuation");
  expect(normalCapabilitiesCalls).toBeGreaterThan(0);
  expect(failedCapabilitiesCalls).toBe(0);
  failConnectedRefresh = true;
  finishAuthorization = true;
  await expect.poll(() => rows[0]?.status).toBe("connected");
  await expect.poll(() => failedCapabilitiesCalls).toBeGreaterThan(0);
  await expect(page.getByTestId(`connection-account-${connectionId}`)).toContainText("Connected");
  expect(begins).toEqual([{ configId: "card-calendar-source" }]);
  expect(legacyBegins).toEqual([]);
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await composer.fill("@Card calendar");
  const exactMention = page
    .getByTestId("mention-picker")
    .getByRole("option", { name: `@${displayName}`, exact: true });
  await expect(exactMention).toBeVisible();
  await expect(exactMention.locator("[data-mention-id]")).toHaveAttribute(
    "data-mention-id",
    connectionId,
  );
  await expect(exactMention).toContainText("Connected");
  await captureScreenshot(page, testInfo, "native-card-exact-account-mention");
  await composer.fill("");
  failConnectedRefresh = false;
  // Rehydrate the still-pending synthetic card with the now-connected account.
  // Reopen the card-owned overlay without opening Shell's global integrations overlay.
  await page.reload({ waitUntil: "domcontentloaded" });
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByTestId(`connection-account-${connectionId}`)
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect account", exact: true })
    .click();
  await expect.poll(() => revoked).toEqual([connectionId]);
  await expect(page.getByRole("status")).toContainText("Account disconnected.");
  const listsAfterDisconnect = listCalls;
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();
  await composer.fill("@Card calendar");
  await expect(
    page.locator(`[data-testid="mention-picker"] [data-mention-id="${connectionId}"]`),
  ).toHaveCount(0);
  await expect(page.getByRole("option", { name: `@${displayName}`, exact: true })).toHaveCount(0);
  expect(begins).toHaveLength(1);
  expect(legacyBegins).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(expectedCapabilitiesConsole.length).toBeLessThanOrEqual(failedCapabilitiesCalls);
  await captureScreenshot(page, testInfo, "native-card-disconnected-account-removed");
  await testInfo.attach("native-card-rpc-evidence", {
    contentType: "application/json",
    body: JSON.stringify(
      {
        begins,
        legacyBegins,
        revoked,
        completeCalls,
        listCalls,
        listsAfterDisconnect,
        connectionId,
        displayName,
        pageErrors,
        consoleErrors,
        expectedCapabilitiesConsole,
        failedCapabilitiesCalls,
        normalCapabilitiesCalls,
        hydrationCalls,
      },
      null,
      2,
    ),
  });
});
