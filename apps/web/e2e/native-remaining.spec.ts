import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type {
  NativeAppId,
  NativeConfigEditable,
  NativeConfigInput,
  NativeConfigStatus,
  NativeSetupState,
} from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const callbackUri = "https://app.example.test/api/connectors/oauth/callback";
const remainingApps = [
  "outlook-mail",
  "outlook-calendar",
  "onedrive",
  "microsoft-todo",
  "sharepoint",
  "excel",
  "planner",
  "teams",
  "gitlab",
  "jira",
  "confluence",
  "todoist",
  "trello",
  "asana",
  "clickup",
  "airtable",
  "dropbox",
  "hubspot",
  "figma",
  "feishu-lark",
  "dingtalk",
  "wecom",
  "telegram-bot",
  "discord",
] as const;

function source(appId: NativeAppId, extra: Partial<NativeConfigStatus> = {}): NativeConfigStatus {
  return {
    id: `fixture-${appId}`,
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

async function start(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach("verification-boundary", {
    body: "Real application signup, onboarding and setup screen; scripted connector RPCs with synthetic data. These screenshots verify UI behavior, not supplier authorization or API execution.",
    contentType: "text/plain",
  });
  await signup(
    page,
    `native-remaining-${name}-${Date.now()}@rakazo.test`,
    "password12",
    "Remaining application setup",
  );
  await completeOnboarding(page);
}

async function setupSurface(page: Page, configurations: NativeConfigStatus[] = []) {
  const setup: NativeSetupState = { canConfigure: true, callbackUri, configurations };
  await page.route("**/rpc/nativeConnectors/status", (route) =>
    route.fulfill({ json: { json: setup } }),
  );
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
}

test("37 native applications include the remaining 24 and distinguish enterprise credentials and actors", async ({
  page,
}, testInfo) => {
  await start(page, testInfo, "enterprise");
  await setupSurface(page);
  const saves: NativeConfigInput[] = [];
  await page.route("**/rpc/nativeConnectors/save", (route) => {
    const input = route.request().postDataJSON().json as NativeConfigInput;
    saves.push(input);
    return route.fulfill({
      json: {
        json: source(input.appId, {
          id: `saved-${saves.length}`,
          label: input.label,
          ownership: input.ownership,
          credentialKind: input.credentialKind,
          actor: input.actor,
        }),
      },
    });
  });
  await page.goto("/integrations/setup");
  const section = page.getByRole("region", { name: "Application credentials", exact: true });
  const add = section.getByRole("button", { name: "Add application", exact: true });
  await add.click();
  const application = section.getByLabel("Application", { exact: true });
  await expect(application.locator("option")).toHaveCount(37);
  for (const appId of remainingApps) {
    await expect(application.locator(`option[value="${appId}"]`)).toHaveCount(1);
  }
  await application.selectOption("wecom");
  await expect(section.getByLabel("Authorization", { exact: true })).toHaveValue("machine_key");
  await expect(section.getByLabel("Corp ID", { exact: true })).toHaveAttribute("required", "");
  await expect(section.getByLabel("Agent ID", { exact: true })).toHaveAttribute("required", "");
  await expect(section.getByLabel("Suite ID", { exact: true })).toHaveCount(0);
  await expect(section.getByLabel("Client ID", { exact: true })).toHaveCount(0);
  await section.getByLabel("Connection method name", { exact: true }).fill("Team WeCom app");
  await section.getByLabel("Corp ID", { exact: true }).fill("fixture-corporation");
  await section.getByLabel("Agent ID", { exact: true }).fill("1000001");
  await section.getByLabel("App secret", { exact: true }).fill("synthetic-wecom-app-secret");
  await expect(
    section.getByText("This application is bound to the current space.", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "native-remaining-wecom-corp-agent");
  await section.getByRole("button", { name: "Save application", exact: true }).click();
  await expect(add).toBeVisible();
  expect(saves[0]).toMatchObject({
    appId: "wecom",
    credentialKind: "machine_key",
    actor: "app",
    tenantId: "fixture-corporation",
    agentId: "1000001",
  });
  expect(saves[0]).not.toHaveProperty("clientId");

  await add.click();
  await application.selectOption("wecom");
  await section.getByLabel("Authorization", { exact: true }).selectOption("oauth");
  await expect(section.getByLabel("Suite ID", { exact: true })).toHaveAttribute("required", "");
  await expect(section.getByLabel("Corp ID (optional)", { exact: true })).not.toHaveAttribute(
    "required",
    "",
  );
  await expect(section.getByLabel("Corp ID", { exact: true })).toHaveCount(0);
  await section.getByLabel("Connection method name", { exact: true }).fill("WeCom suite install");
  await section.getByLabel("Suite ID", { exact: true }).fill("fixture-suite");
  await section.getByLabel("Agent ID", { exact: true }).fill("1000002");
  await section.getByLabel("Client secret", { exact: true }).fill("synthetic-suite-secret");
  await expect(section.getByLabel("Callback URL", { exact: true })).toHaveValue(callbackUri);
  await captureScreenshot(page, testInfo, "native-remaining-wecom-suite");
  await section.getByRole("button", { name: "Save application", exact: true }).click();
  await expect(add).toBeVisible();
  expect(saves[1]).toMatchObject({
    appId: "wecom",
    credentialKind: "oauth",
    actor: "app",
    clientId: "fixture-suite",
    agentId: "1000002",
  });
  expect(saves[1]).not.toHaveProperty("tenantId");

  await add.click();
  await application.selectOption("feishu-lark");
  await expect(section.getByLabel("Platform", { exact: true })).toHaveValue("feishu");
  await section.getByLabel("Platform", { exact: true }).selectOption("lark");
  await section.getByLabel("Application owner", { exact: true }).selectOption("official");
  await expect(section.getByLabel("Authorization", { exact: true })).toHaveCount(0);
  await expect(section.getByLabel("App secret", { exact: true })).toHaveCount(0);
  await expect(section.getByLabel("Client secret", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await section.getByLabel("Connection method name", { exact: true }).fill("Official Lark login");
  await section.getByLabel("App ID", { exact: true }).fill("fixture-lark-app");
  await section.getByLabel("Client secret", { exact: true }).fill("synthetic-lark-client-secret");
  await captureScreenshot(page, testInfo, "native-remaining-feishu-official-region");
  await section.getByRole("button", { name: "Save application", exact: true }).click();
  await expect(add).toBeVisible();
  expect(saves).toHaveLength(3);
  expect(saves[2]).toMatchObject({
    appId: "feishu-lark",
    ownership: "official",
    credentialKind: "oauth",
    actor: "user",
    region: "lark",
    clientId: "fixture-lark-app",
  });
});

test("incomplete WeCom setup can edit and copy its event callback while blank secrets remain omitted", async ({
  page,
}, testInfo) => {
  await start(page, testInfo, "wecom-callback");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const entry = source("wecom", {
    id: "fixture-wecom-suite",
    label: "WeCom awaiting ticket",
    ownership: "official",
    actor: "app",
    configured: false,
    revision: 2,
  });
  const eventCallbackUri = "https://app.example.test/api/connectors/enterprise/fixture-wecom-suite";
  const editable: NativeConfigEditable = {
    id: entry.id,
    appId: "wecom",
    label: entry.label,
    ownership: "official",
    credentialKind: "oauth",
    actor: "app",
    enabled: true,
    revision: 2,
    callbackUri,
    enterpriseCallbackUri: eventCallbackUri,
    clientId: "fixture-wecom-suite-id",
    agentId: "1000001",
    scopes: [],
    capabilities: [],
    knowledgeBaseIds: [],
    hasClientSecret: true,
    hasVerificationToken: true,
    hasEncryptionKey: true,
  };
  await setupSurface(page, [entry]);
  await page.route("**/rpc/nativeConnectors/configuration", (route) => {
    expect(route.request().postDataJSON().json).toEqual({ id: entry.id });
    return route.fulfill({ json: { json: editable } });
  });
  const saves: NativeConfigInput[] = [];
  await page.route("**/rpc/nativeConnectors/save", (route) => {
    const input = route.request().postDataJSON().json as NativeConfigInput;
    saves.push(input);
    return route.fulfill({ json: { json: { ...entry, label: input.label, revision: 3 } } });
  });
  await page.goto("/integrations/setup");
  const section = page.getByRole("region", { name: "Application credentials", exact: true });
  await expect(section.getByText(/Setup incomplete/)).toBeVisible();
  await section.getByRole("button", { name: "Edit", exact: true }).click();
  const callback = section.getByLabel("Event callback URL", { exact: true });
  await expect(callback).toHaveValue(eventCallbackUri);
  await expect(callback).toHaveAttribute("readonly", "");
  await expect(section.getByLabel("Callback URL", { exact: true })).toHaveValue(callbackUri);
  expect(eventCallbackUri).not.toBe(callbackUri);
  await callback.focus();
  await page.keyboard.press("ControlOrMeta+C");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(eventCallbackUri);
  await section.getByText("Authorization callbacks", { exact: true }).click();
  for (const label of ["Client secret", "Verification token", "Encryption key"]) {
    const secret = section.getByLabel(label, { exact: true });
    await expect(secret).toHaveAttribute("type", "password");
    await expect(secret).toHaveValue("");
  }
  await expect(
    section.getByText("Leave blank to keep the saved secret.", { exact: true }),
  ).toHaveCount(3);
  await section
    .getByLabel("Connection method name", { exact: true })
    .fill("WeCom suite callbacks ready");
  await captureScreenshot(page, testInfo, "native-remaining-wecom-incomplete-callback");
  await section.getByRole("button", { name: "Save application", exact: true }).click();
  await expect(section.getByRole("button", { name: "Add application", exact: true })).toBeVisible();
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({
    id: entry.id,
    expectedRevision: 2,
    label: "WeCom suite callbacks ready",
    credentialKind: "oauth",
    actor: "app",
    clientId: "fixture-wecom-suite-id",
  });
  for (const field of ["clientSecret", "verificationToken", "encryptionKey"]) {
    expect(saves[0]).not.toHaveProperty(field);
  }
  await expect(section.getByText(/Setup incomplete/)).toBeVisible();
});

test("Discord owner setup binds its server and allowed channels to the current space and keeps its token write-only", async ({
  page,
}, testInfo) => {
  await start(page, testInfo, "discord-owner");
  await setupSurface(page);
  const entry = source("discord", {
    id: "fixture-discord-bot",
    label: "Team Discord bot",
    ownership: "official",
    credentialKind: "bot_token",
    actor: "bot",
    usesConfiguredCredential: true,
  });
  const serverId = "123456789012345678";
  const targetIds = ["223456789012345678", "323456789012345678"];
  const saves: NativeConfigInput[] = [];
  await page.route("**/rpc/nativeConnectors/save", (route) => {
    saves.push(route.request().postDataJSON().json as NativeConfigInput);
    return route.fulfill({ json: { json: entry } });
  });
  const editable: NativeConfigEditable = {
    id: entry.id,
    appId: "discord",
    label: entry.label,
    ownership: "official",
    credentialKind: "bot_token",
    actor: "bot",
    enabled: true,
    revision: 1,
    callbackUri,
    hasClientSecret: true,
    tenantId: serverId,
    targetIds,
    scopes: [],
    capabilities: ["read"],
    knowledgeBaseIds: [],
  };
  await page.route("**/rpc/nativeConnectors/configuration", (route) =>
    route.fulfill({ json: { json: editable } }),
  );
  await page.goto("/integrations/setup");
  const section = page.getByRole("region", { name: "Application credentials", exact: true });
  await section.getByRole("button", { name: "Add application", exact: true }).click();
  await section.getByLabel("Application", { exact: true }).selectOption("discord");
  await expect(section.getByLabel("Discord bot token", { exact: true })).toHaveCount(0);
  await section.getByLabel("Application owner", { exact: true }).selectOption("official");
  await section.getByLabel("Connection method name", { exact: true }).fill(entry.label);
  await section.getByLabel("Server ID", { exact: true }).fill(serverId);
  await section.getByLabel("Allowed channel IDs", { exact: true }).fill(targetIds.join(", "));
  const token = section.getByLabel("Discord bot token", { exact: true });
  await expect(token).toHaveAttribute("type", "password");
  await token.fill("synthetic-discord-owner-token");
  await expect(section.getByLabel("Server ID", { exact: true })).toHaveAttribute("required", "");
  await expect(section.getByLabel("Allowed channel IDs", { exact: true })).toHaveAttribute(
    "required",
    "",
  );
  await expect(
    section.getByText("This server is bound to the current space.", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "native-remaining-discord-space-targets");
  await section.getByRole("button", { name: "Save application", exact: true }).click();
  await expect(section.getByRole("button", { name: "Add application", exact: true })).toBeVisible();
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({
    appId: "discord",
    ownership: "official",
    credentialKind: "bot_token",
    actor: "bot",
    clientSecret: "synthetic-discord-owner-token",
    tenantId: serverId,
    targetIds,
    scopes: [],
    capabilities: ["read"],
  });
  await section.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(token).toHaveValue("");
  await expect(token).not.toHaveAttribute("required", "");
  await expect(section.getByLabel("Server ID", { exact: true })).toHaveValue(serverId);
  await expect(section.getByLabel("Allowed channel IDs", { exact: true })).toHaveValue(
    targetIds.join(", "),
  );
  await captureScreenshot(page, testInfo, "native-remaining-discord-write-only-edit");
});
