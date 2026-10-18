import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type {
  AppBootstrap,
  Connection,
  ConnectionCatalogItem,
  NativeAppId,
  NativeConfigInput,
  NativeConfigStatus,
  NativeSetupState,
  NativeSlackHook,
  Routine,
} from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openIntegrations,
  rpc,
  signup,
} from "./helpers";

const callbackUri = "https://app.example.test/api/connectors/oauth/callback";
const prefix = "https://www.googleapis.com/auth/";
const addedApps = [
  ["gmail", "Gmail"],
  ["google-drive", "Google Drive"],
  ["google-docs", "Google Docs"],
  ["google-sheets", "Google Sheets"],
  ["google-slides", "Google Slides"],
  ["google-tasks", "Google Tasks"],
  ["github", "GitHub"],
  ["linear", "Linear"],
  ["slack", "Slack"],
] as const;
const defaultScope: Partial<Record<NativeAppId, string>> = {
  gmail: "gmail.readonly",
  "google-drive": "drive.file",
  "google-docs": "documents.readonly",
  "google-sheets": "spreadsheets.readonly",
  "google-slides": "presentations.readonly",
  "google-tasks": "tasks.readonly",
};
function source(appId: NativeAppId, extra: Partial<NativeConfigStatus> = {}): NativeConfigStatus {
  return {
    id: `e2e-${appId}`,
    appId,
    label: `Fixture ${appId}`,
    ownership: "byo",
    credentialKind: "oauth",
    actor: "user",
    configured: true,
    enabled: true,
    revision: 1,
    callbackUri,
    executionLocation: "instance",
    ...extra,
  };
}
async function start(page: Page, name: string) {
  await signup(
    page,
    `native-batch2-${name}-${Date.now()}@rakazo.test`,
    "password12",
    "Native batch two",
  );
  await completeOnboarding(page);
}
async function setupSurface(page: Page, setup: NativeSetupState) {
  await page.route("**/rpc/nativeConnectors/status", (route) =>
    route.fulfill({ json: { json: setup } }),
  );
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: setup.canConfigure,
          needsSetup: false,
          webUrl: "https://app.example.test/integrations/setup",
          providers: [],
        },
      },
    }),
  );
}

test("all nine added apps expose isolated defaults and explicit actors in application setup", async ({
  page,
}, testInfo) => {
  await start(page, "defaults");
  const setup: NativeSetupState = { canConfigure: true, callbackUri, configurations: [] };
  await setupSurface(page, setup);
  const saves: NativeConfigInput[] = [];
  await page.route("**/rpc/nativeConnectors/save", (route) => {
    const input = route.request().postDataJSON().json as NativeConfigInput;
    saves.push(input);
    return route.fulfill({
      json: {
        json: source(input.appId, {
          id: `saved-${input.appId}`,
          label: input.label,
          credentialKind: input.credentialKind,
          actor: input.actor,
        }),
      },
    });
  });
  await page.goto("/integrations/setup");
  const section = page.getByRole("region", { name: "Application credentials", exact: true });
  for (const [appId, name] of addedApps) {
    await section.getByRole("button", { name: "Add application", exact: true }).click();
    await expect(
      section.getByLabel("Application", { exact: true }).locator(`option[value="${appId}"]`),
    ).toHaveText(name);
    await section.getByLabel("Application", { exact: true }).selectOption(appId);
    await section.getByLabel("Connection method name", { exact: true }).fill(`Batch two ${name}`);
    if (defaultScope[appId]) {
      await section.getByLabel("Client ID", { exact: true }).fill(`e2e-native-${appId}`);
      await section.getByLabel("Client secret", { exact: true }).fill("synthetic-client-secret");
      await expect(section.getByLabel("Callback URL", { exact: true })).toHaveValue(callbackUri);
      if (appId === "gmail") {
        await section.getByText("Gmail push notifications", { exact: true }).click();
        await expect(
          section.getByRole("switch", { name: "Use Google Pub/Sub", exact: true }),
        ).toHaveAttribute("aria-checked", "false");
      }
    } else {
      await expect(section.getByLabel("Acts as", { exact: true })).toHaveValue(
        appId === "slack" ? "bot" : "user",
      );
      await expect(section.getByLabel("Acts as", { exact: true })).toBeDisabled();
    }
    await section.getByRole("button", { name: "Save application", exact: true }).click();
    await expect(
      section.getByRole("button", { name: "Add application", exact: true }),
    ).toBeVisible();
    const saved = saves.at(-1)!;
    expect(saved.appId).toBe(appId);
    expect(saved.capabilities).toEqual([]);
    expect(saved.scopes).toEqual(
      defaultScope[appId]
        ? ["openid", "email", prefix + defaultScope[appId]]
        : appId === "slack"
          ? ["channels:read"]
          : [],
    );
    expect(saved).not.toHaveProperty("googleWatch");
  }
  await section.getByRole("button", { name: "Add application", exact: true }).click();
  await section.getByLabel("Application", { exact: true }).selectOption("github");
  await section
    .getByLabel("Authorization", { exact: true })
    .selectOption("github_app_installation");
  await expect(section.getByLabel("Acts as", { exact: true })).toHaveValue("installation");
  await expect(section.getByLabel("GitHub App ID", { exact: true })).toBeVisible();
  await expect(section.getByLabel("Installation ID", { exact: true })).toBeVisible();
  await section.getByLabel("Application", { exact: true }).selectOption("linear");
  await section.getByLabel("Authorization", { exact: true }).selectOption("oauth");
  await section.getByLabel("Acts as", { exact: true }).selectOption("app");
  await expect(section.getByRole("switch", { name: "read", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(section.getByRole("switch", { name: "write", exact: true })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await section.getByLabel("Application", { exact: true }).selectOption("slack");
  await section.getByLabel("Authorization", { exact: true }).selectOption("oauth");
  await section.getByLabel("Acts as", { exact: true }).selectOption("user");
  await section.getByText("Advanced Slack data access", { exact: true }).click();
  await expect(
    section.getByRole("switch", { name: "Allow user data processing", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    section.getByText("Requires Slack platform eligibility and approved data handling.", {
      exact: true,
    }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "native-batch2-app-scopes-actor");
});

test("Slack owner setup keeps signing material write-only, names lifecycle events and returns to applications", async ({
  page,
}, testInfo) => {
  await start(page, "slack-owner");
  const config = source("slack", { credentialKind: "bot_token", actor: "bot" });
  await setupSurface(page, { canConfigure: true, callbackUri, configurations: [config] });
  let hooks: NativeSlackHook[] = [];
  const saves: Record<string, unknown>[] = [];
  await page.route("**/rpc/nativeConnectors/slackWebhookStatus", (route) =>
    route.fulfill({ json: { json: { configId: config.id, publicHttpsAvailable: true, hooks } } }),
  );
  await page.route("**/rpc/nativeConnectors/saveSlackWebhook", (route) => {
    const input = route.request().postDataJSON().json;
    saves.push(input);
    const hook: NativeSlackHook = {
      id: "fixture-slack-hook",
      configId: config.id,
      configRevision: 1,
      revision: 1,
      appId: input.appId,
      teamId: null,
      botEvents: input.botEvents,
      enabled: true,
      configured: true,
      verified: false,
      phase: "waiting_for_verification",
      webhookUrl: "https://app.example.test/api/connectors/events/slack/fixture-slack-hook",
      lastVerifiedAt: null,
    };
    hooks = [hook];
    return route.fulfill({ json: { json: hook } });
  });
  await page.goto("/integrations/setup");
  await page.getByRole("button", { name: "Events", exact: true }).click();
  const section = page.getByRole("region", { name: "Slack event subscriptions", exact: true });
  await section.getByLabel("Slack App ID", { exact: true }).fill("AE2ENATIVE");
  const secret = section.getByLabel("Signing secret", { exact: true });
  await expect(secret).toHaveAttribute("type", "password");
  await secret.fill("synthetic-slack-signing-secret");
  await section
    .getByRole("switch", { name: "app_mention · app_mentions:read", exact: true })
    .click();
  await section
    .getByRole("switch", { name: "app_uninstalled · Update connection status", exact: true })
    .click();
  await section
    .getByRole("switch", { name: "tokens_revoked · Update connection status", exact: true })
    .click();
  await expect(
    section.getByRole("button", { name: "Save event subscription", exact: true }),
  ).toBeDisabled();
  await section
    .getByRole("switch", { name: "I will enable these bot events in Slack", exact: true })
    .click();
  await section.getByRole("button", { name: "Save event subscription", exact: true }).click();
  await expect(secret).toHaveValue("");
  await expect(section.getByText("Verify the Request URL in Slack", { exact: true })).toBeVisible();
  await expect(section.getByLabel("Slack Request URL", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  expect(saves).toEqual([
    {
      configId: config.id,
      appId: "AE2ENATIVE",
      signingSecret: "synthetic-slack-signing-secret",
      botEvents: ["app_mention", "app_uninstalled", "tokens_revoked"],
      botSubscriptionsConfirmed: true,
    },
  ]);
  expect(await page.locator("body").innerText()).not.toContain("synthetic-slack-signing-secret");
  await captureScreenshot(page, testInfo, "native-batch2-slack-owner-events");
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain("synthetic-slack-signing-secret");
  await section.getByRole("button", { name: "Back to applications", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Application credentials", exact: true }),
  ).toBeVisible();
  await setupSurface(page, { canConfigure: false, callbackUri, configurations: [config] });
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Application credentials", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Events", exact: true })).toHaveCount(0);
});

test("Drive file selection is an independent new connection and never becomes reauthorization", async ({
  page,
}, testInfo) => {
  await start(page, "picker-entry");
  const config = source("google-drive", { driveFilePickerAvailable: true });
  await setupSurface(page, { canConfigure: false, callbackUri, configurations: [config] });
  const old: Connection = {
    id: "old-drive",
    connectorId: "native",
    provider: "google-drive",
    displayName: "Previous Drive",
    status: "error",
    capabilities: [],
    createdAt: "2026-01-01",
    remoteAccountId: null,
  };
  await page.route("**/rpc/connections/list", (route) => route.fulfill({ json: { json: [old] } }));
  await page.route("**/rpc/connections/catalog", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            connectorId: "native",
            slug: "google-drive",
            name: "Google Drive",
            logo: null,
            noAuth: false,
            connected: false,
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/connections/tools", (route) => route.fulfill({ json: { json: [] } }));
  const begins: unknown[] = [];
  await page.route("**/rpc/nativeConnectors/begin", (route) => {
    begins.push(route.request().postDataJSON().json);
    return route.fulfill({
      json: { json: { connectionId: "new-picked-drive", authorizationUrl: null } },
    });
  });
  await page.route("**/rpc/connections/complete", (route) =>
    route.fulfill({ json: { json: { ...old, id: "new-picked-drive", status: "pending" } } }),
  );
  await page.route("**/rpc/connections/revoke", (route) =>
    route.fulfill({ json: { json: { ok: true } } }),
  );
  await openIntegrations(page);
  await page
    .getByTestId("connection-tile-google-drive")
    .getByRole("button", { name: /Google Drive/ })
    .click();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const form = page
    .locator("form")
    .filter({ has: page.getByLabel("Connection method", { exact: true }) });
  await expect(
    form.getByRole("button", { name: "Choose accessible files", exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "native-batch2-drive-file-selection");
  await form.getByRole("button", { name: "Choose accessible files", exact: true }).click();
  await expect.poll(() => begins.length).toBe(1);
  expect(begins).toEqual([{ configId: config.id, authorizationFlow: "drive_picker" }]);
  await form.getByRole("button", { name: "Back", exact: true }).click();
  await page
    .getByTestId("connection-account-old-drive")
    .getByRole("button", { name: "Authorize again", exact: true })
    .click();
  await expect(
    form.getByRole("button", { name: "Choose accessible files", exact: true }),
  ).toHaveCount(0);
  await form.getByRole("button", { name: "Authorize account", exact: true }).click();
  await expect.poll(() => begins.length).toBe(2);
  expect(begins[1]).toEqual({ configId: config.id, previousConnectionId: "old-drive" });
});

for (const route of [
  { appId: "gmail", name: "Gmail", broker: "composio", brokerSlug: "GMAIL" },
  { appId: "linear", name: "Linear", broker: "pipedream", brokerSlug: "linear" },
] as const)
  test(`unconfigured native-first ${route.name} defaults to available ${route.broker} and keeps native selectable`, async ({
    page,
  }) => {
    await start(page, `source-${route.broker}`);
    await setupSurface(page, { canConfigure: false, callbackUri, configurations: [] });
    const catalog: ConnectionCatalogItem[] = [
      {
        connectorId: "native",
        slug: route.appId,
        name: route.name,
        logo: null,
        noAuth: false,
        connected: false,
        connectable: false,
      },
      {
        connectorId: route.broker,
        slug: route.brokerSlug,
        name: route.name,
        logo: null,
        noAuth: false,
        connected: false,
      },
    ];
    await page.route("**/rpc/connections/catalog", (request) =>
      request.fulfill({ json: { json: catalog } }),
    );
    await page.route("**/rpc/connections/list", (request) =>
      request.fulfill({ json: { json: [] } }),
    );
    await page.route("**/rpc/connections/tools", (request) =>
      request.fulfill({ json: { json: [] } }),
    );
    await openIntegrations(page);
    await page
      .getByTestId(`connection-tile-${route.appId}`)
      .getByRole("button", { name: "Add", exact: true })
      .click();
    const detail = page.getByTestId("connection-detail");
    const selected = detail.getByLabel("Connection source", { exact: true });
    await expect(selected).toHaveValue(JSON.stringify([route.broker, route.brokerSlug]));
    await selected.selectOption(JSON.stringify(["native", route.appId]));
    await expect(selected).toHaveValue(JSON.stringify(["native", route.appId]));
    await detail.getByRole("button", { name: "Add account", exact: true }).click();
    await expect(
      page.getByText("Ask your administrator to enable a connection method.", { exact: true }),
    ).toBeVisible();
    await page.locator("form").getByRole("button", { name: "Back", exact: true }).click();
    await expect(selected).toHaveValue(JSON.stringify(["native", route.appId]));
  });

/** Real instance RPC/OAuth persistence; only the remote HTTP authority is an emulator. */
async function nativeFixtureAccount(
  page: Page,
  appId: "gmail" | "google-drive" | "slack",
  testInfo: TestInfo,
): Promise<Connection> {
  const input: NativeConfigInput = {
    appId,
    label: `E2E ${appId} ${crypto.randomUUID()}`,
    ownership: "byo",
    credentialKind: appId === "slack" ? "bot_token" : "oauth",
    enabled: true,
    actor: appId === "slack" ? "bot" : "user",
    scopes:
      appId === "slack"
        ? ["channels:read", "app_mentions:read", "channels:history", "im:read", "im:history"]
        : [
            "openid",
            "email",
            prefix + (appId === "gmail" ? "gmail.readonly" : "drive.metadata.readonly"),
          ],
    capabilities: [],
    knowledgeBaseIds: [],
    ...(appId === "slack"
      ? {}
      : { clientId: `e2e-native-${appId}`, clientSecret: "synthetic-client-secret" }),
  };
  // Seed only the isolated harness's application prerequisite. Account grants,
  // resource verification and Routine persistence still cross the actual API.
  const denied = await page.request.post("/rpc/nativeConnectors/save", { data: { json: input } });
  expect(denied.status()).toBe(403);
  expect(process.env.DATABASE_URL).toBeTruthy();
  expect(process.env.ENCRYPTION_KEY).toBeTruthy();
  const [{ createDb }, { NativeConfigStore }, { EncryptedSecretStore }] = await Promise.all([
    import("../../../packages/db/src/index"),
    import("../../../packages/adapters/src/native-connectors/config"),
    import("../../../packages/adapters/src/secrets"),
  ]);
  const db = createDb(process.env.DATABASE_URL!, {
    poolMax: 2,
    applicationName: "native-batch2-browser-fixture",
  });
  const secrets = new EncryptedSecretStore(process.env.ENCRYPTION_KEY!);
  let config: NativeConfigStatus;
  try {
    const { me } = await rpc<AppBootstrap>(page, "bootstrap", { botId: activeBotId(page) });
    config = await new NativeConfigStore(db.prisma, secrets, process.env.API_URL!).save(
      input,
      {
        userId: me.userId,
        spaceId: me.spaceId,
        operationId: "native-batch2-browser-fixture",
        traceId: crypto.randomUUID(),
        signal: new AbortController().signal,
      },
      true,
    );
    await testInfo.attach("native-application-fixture", {
      contentType: "application/json",
      body: JSON.stringify({
        id: config.id,
        appId,
        label: config.label,
        kind: config.credentialKind,
        seededApplicationOnly: true,
      }),
    });
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
    await secrets.close();
  }
  const pending = await rpc<{ connectionId: string; authorizationUrl: string | null }>(
    page,
    "nativeConnectors/begin",
    {
      configId: config.id,
      ...(appId === "slack" ? { credential: "xoxb-e2e-native-batch2" } : {}),
    },
  );
  if (pending.authorizationUrl) {
    const launch = new URL(pending.authorizationUrl);
    const callback = new URL("/api/connectors/oauth/callback", launch);
    callback.searchParams.set("state", launch.searchParams.get("state")!);
    callback.searchParams.set("code", "e2e-native-read-only");
    const result = await page.request.get(callback.toString());
    expect(result.ok(), await result.text()).toBe(true);
  }
  const connected = await rpc<Connection>(page, "connections/complete", {
    connectionId: pending.connectionId,
  });
  expect(connected.status).toBe("connected");
  return connected;
}

for (const appId of ["gmail", "google-drive", "slack"] as const) {
  test(`${appId} event saves through real authorization and resource verification, then returns to the Routine list`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await start(page, `routine-${appId}`);
    const botId = activeBotId(page);
    const account = await nativeFixtureAccount(page, appId, testInfo);
    const catalog = await rpc<ConnectionCatalogItem[]>(page, "connections/catalog", {});
    for (const [id] of addedApps)
      expect(catalog.some((entry) => entry.connectorId === "native" && entry.slug === id)).toBe(
        true,
      );
    await page.getByTitle("Agent computer").click();
    await page.getByRole("button", { name: "Create Routine", exact: true }).click();
    await page.getByRole("switch", { name: "Active", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Active", exact: true })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.getByLabel("Name", { exact: true }).fill(`Native ${appId} review`);
    await page.getByLabel("Instruction", { exact: true }).fill("Read this configured event.");
    await page.getByRole("button", { name: "Add trigger", exact: true }).click();
    await page.getByRole("menuitem", { name: "Application event", exact: true }).click();
    await page.getByLabel("Account", { exact: true }).selectOption(account.id);
    const kind =
      appId === "gmail"
        ? "gmail.message_received"
        : appId === "google-drive"
          ? "drive.file_changed"
          : "slack.app_mention";
    await page.getByLabel("Event", { exact: true }).selectOption(kind);
    const field = page.getByLabel(
      appId === "gmail"
        ? "Label IDs (any match, one per line)"
        : appId === "google-drive"
          ? "File ID"
          : "Channel ID",
      { exact: true },
    );
    await field.fill("not-an-authorized-fixture-resource");
    await page.getByRole("button", { name: "Save event changes", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save event changes", exact: true }),
    ).toBeEnabled();
    await field.fill(
      appId === "gmail" ? "INBOX" : appId === "google-drive" ? "e2e-drive-file" : "CE2ENATIVE",
    );
    await page.getByRole("button", { name: "Connect an account", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Integrations", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close integrations", exact: true }).click();
    await expect(page.getByLabel("Account", { exact: true })).toHaveValue(account.id);
    await expect(field).toHaveValue(
      appId === "gmail" ? "INBOX" : appId === "google-drive" ? "e2e-drive-file" : "CE2ENATIVE",
    );
    await page.getByRole("button", { name: "Save event changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    const routines = await rpc<Routine[]>(page, "routines/list", { botId });
    const saved = routines.find((row) => row.name === `Native ${appId} review`)!;
    expect(saved.active).toBe(false);
    expect(saved.crons).toEqual([]);
    expect(saved.nativeTriggers).toHaveLength(1);
    expect(saved.nativeTriggers![0]).toMatchObject({ connectionId: account.id, spec: { kind } });
    await captureScreenshot(page, testInfo, `native-batch2-${appId}-routine`);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByText(`Native ${appId} review`, { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
