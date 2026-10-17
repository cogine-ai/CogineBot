import { expect, test } from "@playwright/test";
import type {
  NativeConfigStatus,
  NativeNotionHook,
  NativeNotionHookStatus,
  NativeSetupState,
} from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const integrationId = "00000000-0000-4000-8000-000000000001";
const callbackUri = "https://app.example.test/api/connectors/oauth/callback";
const verificationToken = "synthetic-notion-verification-token-only";
const config: NativeConfigStatus = {
  id: "owner-notion-application",
  revision: 1,
  appId: "notion",
  label: "Owner Notion application",
  ownership: "byo",
  credentialKind: "oauth",
  enabled: true,
  configured: true,
  callbackUri,
  executionLocation: "instance",
};
function pendingHook(id: string): NativeNotionHook {
  return {
    id,
    configId: config.id,
    configRevision: 1,
    revision: 1,
    phase: "waiting_for_challenge",
    integrationId: null,
    candidateIntegrationId: null,
    subscriptionId: null,
    configured: false,
    enabled: false,
    webhookUrl: `https://app.example.test/api/connectors/events/notion/${id}`,
    setupExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    ownerConfirmedAt: null,
    lastVerifiedAt: null,
  };
}

test("Notion owner setup keeps verification ephemeral and requires explicit identity, first signed event and local stop", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") pageErrors.push(message.text());
  });
  await signup(page, `notion-hook-owner-${Date.now()}@rakazo.test`, "password12", "Webhook owner");
  await completeOnboarding(page);
  const setup: NativeSetupState = { canConfigure: true, callbackUri, configurations: [config] };
  let hooks: NativeNotionHook[] = [];
  let beginCalls = 0;
  const reveals: unknown[] = [],
    confirms: Array<{ id: string; integrationId: string; verifiedInNotion: true }> = [],
    disabled: string[] = [];
  let holdReveal = false;
  let releaseReveal: (() => void) | undefined;
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
    route.fulfill({ json: { json: setup } }),
  );
  await page.route("**/rpc/nativeConnectors/notionWebhookStatus", (route) => {
    const status: NativeNotionHookStatus = {
      configId: config.id,
      publicHttpsAvailable: true,
      hooks,
    };
    return route.fulfill({ json: { json: status } });
  });
  await page.route("**/rpc/nativeConnectors/beginNotionWebhookSetup", (route) => {
    expect(route.request().postDataJSON().json).toEqual({ configId: config.id });
    const next = pendingHook(`owner-hook-${++beginCalls}`);
    hooks = [next, ...hooks];
    return route.fulfill({ json: { json: next } });
  });
  await page.route("**/rpc/nativeConnectors/revealNotionWebhookToken", async (route) => {
    const payload = route.request().postDataJSON().json;
    reveals.push(payload);
    const hook = hooks.find((entry) => entry.id === payload.id)!;
    expect(payload).toEqual({ configId: config.id, id: hook.id, expectedRevision: hook.revision });
    if (holdReveal)
      await new Promise<void>((resolve) => {
        releaseReveal = resolve;
      });
    await route.fulfill({ json: { json: { hook, verificationToken } } });
  });
  await page.route("**/rpc/nativeConnectors/confirmNotionWebhookSetup", (route) => {
    const payload = route.request().postDataJSON().json;
    confirms.push(payload);
    const hook = hooks.find((entry) => entry.id === payload.id)!;
    expect(payload).toEqual({
      configId: config.id,
      id: hook.id,
      expectedRevision: hook.revision,
      integrationId,
      verifiedInNotion: true,
    });
    expect(hooks.some((entry) => entry.id !== hook.id && entry.enabled)).toBe(false);
    const next: NativeNotionHook = {
      ...hook,
      revision: hook.revision + 1,
      integrationId,
      ownerConfirmedAt: new Date().toISOString(),
      configured: true,
      enabled: true,
      phase: "waiting_for_signed_identity",
    };
    hooks = hooks.map((entry) => (entry.id === next.id ? next : entry));
    return route.fulfill({ json: { json: next } });
  });
  await page.route("**/rpc/nativeConnectors/disableNotionWebhook", (route) => {
    const payload = route.request().postDataJSON().json;
    const hook = hooks.find((entry) => entry.id === payload.id)!;
    expect(payload).toEqual({ configId: config.id, id: hook.id, expectedRevision: hook.revision });
    disabled.push(hook.id);
    const next: NativeNotionHook = {
      ...hook,
      revision: hook.revision + 1,
      enabled: false,
      phase: "disabled",
    };
    hooks = hooks.map((entry) => (entry.id === next.id ? next : entry));
    return route.fulfill({ json: { json: next } });
  });
  await page.goto("/integrations/setup");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const section = page.getByRole("region", { name: "Notion webhooks", exact: true });
  await section.getByRole("button", { name: "Set up subscription", exact: true }).click();
  await expect(
    section.getByRole("heading", { name: "Waiting for Notion", exact: true }),
  ).toBeVisible();
  await expect(section.getByLabel("Webhook URL", { exact: true })).toHaveValue(
    hooks[0]!.webhookUrl!,
  );
  hooks = hooks.map((hook) => ({
    ...hook,
    phase: "waiting_for_owner",
    revision: 2,
    candidateIntegrationId: integrationId,
  }));
  await section.getByRole("button", { name: "Refresh", exact: true }).click();
  await section.getByRole("button", { name: "Show verification token", exact: true }).click();
  await expect(section.getByLabel("Verification token", { exact: true })).toHaveValue(
    verificationToken,
  );
  await section.getByRole("button", { name: "Back to applications", exact: true }).click();
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  await expect(section.getByLabel("Verification token", { exact: true })).toHaveCount(0);
  await expect(
    section.getByRole("button", { name: "Show verification token", exact: true }),
  ).toBeVisible();
  holdReveal = true;
  await section.getByRole("button", { name: "Show verification token", exact: true }).click();
  await expect.poll(() => reveals.length).toBe(2);
  await section.getByRole("button", { name: "Back to applications", exact: true }).click();
  holdReveal = false;
  releaseReveal?.();
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  await expect(section.getByLabel("Verification token", { exact: true })).toHaveCount(0);
  await expect(section.getByLabel("Integration ID in Notion", { exact: true })).toHaveValue("");
  const enable = section.getByRole("button", { name: "Enable events", exact: true });
  await expect(enable).toBeDisabled();
  await section.getByLabel("Integration ID in Notion", { exact: true }).fill(integrationId);
  await expect(enable).toBeDisabled();
  await section
    .getByRole("checkbox", { name: "I verified this subscription in Notion", exact: true })
    .check();
  await expect(enable).toBeEnabled();
  await enable.click();
  await expect(
    section.getByRole("heading", { name: "Waiting for first signed event", exact: true }),
  ).toBeVisible();
  await expect(section.getByRole("heading", { name: "Receiving events", exact: true })).toHaveCount(
    0,
  );
  await expect(section.getByLabel("Verification token", { exact: true })).toHaveCount(0);
  expect(confirms).toHaveLength(1);
  hooks = hooks.map((hook) => ({
    ...hook,
    phase: "active",
    revision: hook.revision + 1,
    subscriptionId: integrationId,
    lastVerifiedAt: new Date().toISOString(),
  }));
  await section.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    section.getByRole("heading", { name: "Receiving events", exact: true }),
  ).toBeVisible();
  await section.getByRole("button", { name: "Set up subscription", exact: true }).click();
  await expect.poll(() => beginCalls).toBe(2);
  await expect(
    section.getByRole("heading", { name: "Waiting for Notion", exact: true }),
  ).toBeVisible();
  hooks = hooks.map((hook) =>
    hook.id === "owner-hook-2" ? { ...hook, phase: "waiting_for_owner", revision: 2 } : hook,
  );
  await section.getByRole("button", { name: "Refresh", exact: true }).click();
  await section.getByLabel("Integration ID in Notion", { exact: true }).fill(integrationId);
  await section
    .getByRole("checkbox", { name: "I verified this subscription in Notion", exact: true })
    .check();
  await expect(enable).toBeDisabled();
  await expect(
    section.getByText("Stop the existing subscription here before enabling this one.", {
      exact: true,
    }),
  ).toBeVisible();
  const oldHeader = section
    .getByRole("heading", { name: "Receiving events", exact: true })
    .locator("..");
  await oldHeader.getByRole("button", { name: "Stop subscription", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Routines continue checking Notion for changes.");
  expect(disabled).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(disabled).toEqual([]);
  await oldHeader.getByRole("button", { name: "Stop subscription", exact: true }).click();
  await dialog.getByRole("button", { name: "Stop subscription", exact: true }).click();
  await expect.poll(() => disabled).toEqual(["owner-hook-1"]);
  await expect(section.getByRole("status")).toHaveText(
    "Webhook stopped here. Remove the subscription in Notion separately.",
  );
  await expect(enable).toBeEnabled();
  await enable.click();
  await expect.poll(() => confirms.length).toBe(2);
  await expect(
    section.getByRole("heading", { name: "Waiting for first signed event", exact: true }),
  ).toBeVisible();
  await expect(section.getByRole("heading", { name: "Receiving events", exact: true })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(
      (token) => Object.values(localStorage).some((value) => String(value).includes(token)),
      verificationToken,
    ),
  ).toBe(false);
  expect(pageErrors).toEqual([]);
  await captureScreenshot(page, testInfo, "notion-owner-explicit-stop-and-signed-identity");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await captureScreenshot(page, testInfo, "notion-owner-narrow");
  expect(pageErrors).toEqual([]);
});
