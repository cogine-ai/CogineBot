import type { Page, Request } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ActionApprovalRule, Me, ModelCredential, SpaceNavigation } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openNewSpace, rpc, signup } from "./helpers";

async function inSpace<T>(page: Page, spaceId: string, procedure: string): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, {
    headers: { "x-rakazo-space-id": spaceId },
    data: { json: {} },
  });
  expect(response.ok(), `${procedure}: ${response.status()}`).toBe(true);
  return ((await response.json()) as { json: T }).json;
}

async function fixture(page: Page) {
  await signup(page, `space-settings-${Date.now()}@coginebot.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  await openNewSpace(page);
  const create = page.getByRole("dialog", { name: "New space" });
  await create.getByLabel("Name").fill("Support");
  await create.getByRole("button", { name: "Create space", exact: true }).click();
  await completeOnboarding(page);
  await expect(page.getByTestId("sidebar-current-space")).toContainText("Support");
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  const { spaces } = await rpc<SpaceNavigation>(page, "spaces/list", {});
  const personal = spaces.find((space) => space.name === "Personal")!;
  const support = spaces.find((space) => space.name === "Support")!;
  expect(personal).toBeDefined();
  expect(support).toBeDefined();
  const chatUrl = page.url();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("rakazo:space-id")))
    .toBe(support.id);
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("Keep the current chat draft. 保留草稿。");
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: "Personal", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(
    settings.getByTestId("settings-space").locator('[data-slot="select-value"]'),
  ).toHaveText("Personal");
  return { personal, support, chatUrl, settings, composer };
}

test("editing another Space saves its models and confirmations without moving the chat", async ({
  page,
}, testInfo) => {
  const { personal, support, chatUrl, settings, composer } = await fixture(page);
  const spacePicker = settings.getByTestId("settings-space");
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await spacePicker.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(spacePicker).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(
      settings.getByRole("button", { name: "Close model settings", exact: true }),
    ).toBeFocused();
    await spacePicker.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: "Personal", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(spacePicker).toHaveAttribute("aria-expanded", "false");
    await expect(spacePicker).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: "Personal", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(spacePicker).toHaveAttribute("aria-expanded", "false");
    await expect(spacePicker).toBeFocused();
  }
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Personal", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(spacePicker).toHaveAttribute("aria-expanded", "false");
  await expect(spacePicker).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Personal", exact: true })).toBeFocused();
  const searchProviders = settings.getByPlaceholder("Search providers");
  await searchProviders.click();
  await expect(spacePicker).toHaveAttribute("aria-expanded", "false");
  await expect(searchProviders).toBeFocused();
  await expect(spacePicker.locator('[data-slot="select-value"]')).toHaveText("Personal");
  const originalModels = await inSpace<ModelCredential[]>(page, support.id, "models/credentials");
  const originalMe = await inSpace<Me>(page, support.id, "me");
  const originalRules = await inSpace<ActionApprovalRule[]>(page, support.id, "approvalRules/list");
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await settings.getByPlaceholder("Search providers").fill("openai-compatible");
  await settings.getByRole("button", { name: /OpenAI-compatible/ }).click();
  await settings.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8090/v1");
  await settings.getByLabel("Model id").fill("personal-target-model");
  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/rpc/models/connect") && response.ok(),
  );
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).request().headers()["x-rakazo-space-id"]).toBe(personal.id);
  await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
  const personalModels = await inSpace<ModelCredential[]>(page, personal.id, "models/credentials");
  expect(personalModels).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ modelId: "personal-target-model", isDefault: true }),
    ]),
  );
  // Connections belong to the account; their default-model preferences belong to a Space.
  const supportModels = await inSpace<ModelCredential[]>(page, support.id, "models/credentials");
  expect(
    supportModels.filter((row) => originalModels.some((original) => original.id === row.id)),
  ).toEqual(originalModels);
  expect(supportModels).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: personalModels.find((row) => row.modelId === "personal-target-model")?.id,
        isDefault: false,
      }),
    ]),
  );
  const supportMe = await inSpace<Me>(page, support.id, "me");
  expect({ provider: supportMe.defaultProvider, model: supportMe.defaultModel }).toEqual({
    provider: originalMe.defaultProvider,
    model: originalMe.defaultModel,
  });
  expect((await inSpace<Me>(page, personal.id, "me")).defaultModel).toBe("personal-target-model");

  await settings.getByTestId("settings-nav-confirmations").click();
  const ruleSaved = page.waitForResponse(
    (response) => response.url().endsWith("/rpc/approvalRules/set") && response.ok(),
  );
  await settings.getByRole("button", { name: "Ask before purchases", exact: true }).click();
  expect((await ruleSaved).request().headers()["x-rakazo-space-id"]).toBe(personal.id);
  expect(await inSpace<ActionApprovalRule[]>(page, personal.id, "approvalRules/list")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ matchKind: "category", matchValue: "purchase" }),
    ]),
  );
  expect(await inSpace<ActionApprovalRule[]>(page, support.id, "approvalRules/list")).toEqual(
    originalRules,
  );
  await captureScreenshot(page, testInfo, "space-confirmations-target-personal");

  for (const [section, procedure] of [
    ["memory", "memory/providerConfig"],
    ["voice", "voice/credentials"],
  ] as const) {
    const loaded = page.waitForRequest((request) => request.url().endsWith(`/rpc/${procedure}`));
    await settings.getByTestId(`settings-nav-${section}`).click();
    expect((await loaded).headers()["x-rakazo-space-id"]).toBe(personal.id);
    await expect(settings.getByTestId(`${section}-settings`)).toBeVisible();
  }
  await settings.getByTestId("settings-space").click();
  await page.getByRole("option", { name: "Support", exact: true }).click();
  await expect(
    settings.getByTestId("settings-space").locator('[data-slot="select-value"]'),
  ).toHaveText("Support");
  await captureScreenshot(page, testInfo, "space-settings-target-support-current-chat-retained");
  await settings.getByTestId("settings-nav-general").click();
  await expect(settings.getByTestId("settings-space")).toHaveCount(0);
  await expect(settings.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Close user settings", exact: true }).click();
  expect(page.url()).toBe(chatUrl);
  expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(support.id);
  await expect(composer).toHaveValue("Keep the current chat draft. 保留草稿。");
});

test("switching the settings target discards a late memory response", async ({
  page,
}, testInfo) => {
  const { personal, support, settings } = await fixture(page);
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let finished!: () => void;
  const settled = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const recordSettled = (request: Request) => {
    if (
      request.url().endsWith("/rpc/memory/providerConfig") &&
      request.headers()["x-rakazo-space-id"] === personal.id
    ) {
      finished();
    }
  };
  page.on("requestfinished", recordSettled);
  page.on("requestfailed", recordSettled);
  await page.route("**/rpc/memory/providerConfig", async (route) => {
    if (route.request().headers()["x-rakazo-space-id"] !== personal.id) {
      await route.continue();
      return;
    }
    arrived();
    await gate;
    await route.fulfill({
      json: {
        json: {
          provider: "serenity",
          settings: { brainLabel: "Late Personal memory", allowWrites: "false" },
          defaultMemoryScope: "isolated",
          updatedAt: "2026-10-20T00:00:00.000Z",
        },
      },
    });
  });
  try {
    await settings.getByTestId("settings-nav-memory").click();
    await received;
    await settings.getByTestId("settings-space").click();
    await page.getByRole("option", { name: "Support", exact: true }).click();
    await expect(
      settings.getByTestId("settings-space").locator('[data-slot="select-value"]'),
    ).toHaveText("Support");
    await expect(settings.getByTestId("memory-settings").getByLabel("Provider")).toBeVisible();
    release();
    await settled;
    await expect(settings.getByText(/Late Personal memory/)).toHaveCount(0);
    await expect(settings.getByTestId("memory-settings").getByLabel("Provider")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(support.id);
    await captureScreenshot(page, testInfo, "space-memory-late-response-discarded");
  } finally {
    release();
    page.off("requestfinished", recordSettled);
    page.off("requestfailed", recordSettled);
    await page.unroute("**/rpc/memory/providerConfig");
  }
});
