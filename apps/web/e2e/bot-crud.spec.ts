import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, SpaceNavigation } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createBotFromPicker,
  openNewBot,
  rpc,
  signup,
} from "./helpers";

test("bot creation, editing, and deletion persist", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-crud-${stamp}@rakazo.test`, "password12", "Bot CRUD");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const botList = page.locator("aside").first();
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();

  let createFailed = false;
  let resolveCreateAborted!: () => void;
  const createAborted = new Promise<void>((resolve) => {
    resolveCreateAborted = resolve;
  });
  await page.route("**/rpc/bots/create", async (route) => {
    createFailed = true;
    await route.abort("failed");
    resolveCreateAborted();
  });
  await openNewBot(page);
  const form = page.getByTestId("create-bot-form");
  await form.locator("label:has-text('Name') input").fill("New Bot");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await createAborted;
  // Failed create keeps the form open on the current bot chat.
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "create");
  await expect(page.getByTestId("create-bot-error")).toBeVisible();
  expect(createFailed).toBe(true);
  await page.unroute("**/rpc/bots/create");
  await page.getByRole("button", { name: "Cancel new bot" }).click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");

  let failedPostCreateRefresh = false;
  await page.route("**/rpc/spaces/list", async (route) => {
    if (failedPostCreateRefresh) {
      await route.fallback();
      return;
    }
    failedPostCreateRefresh = true;
    await route.abort("failed");
  });
  await createBotFromPicker(page);
  await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
  await expect.poll(() => failedPostCreateRefresh).toBe(true);
  await page.unroute("**/rpc/spaces/list");
  await expect(botList.getByRole("button", { name: /^New Bot/ })).toBeVisible();
  await page.waitForURL(/\/app\/[^/]+$/);
  const deletedBotPath = new URL(page.url()).pathname;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname).toBe(deletedBotPath);
  await captureScreenshot(page, testInfo, "27-created-bot");

  await page.locator("main").getByRole("button", { name: "New Bot", exact: true }).click();
  await expect(page.getByText("Settings", { exact: true })).toBeVisible();
  const nameInput = page.locator("label:has-text('Name') input");
  const titleInput = page.locator("label:has-text('Title') input");
  const descriptionInput = page.locator("label:has-text('Description') textarea");
  const longTitle = `Market researcher ${"and source verifier ".repeat(9)}`;
  const normalizedLongTitle = longTitle.trim();
  expect(longTitle.length).toBeGreaterThan(160);
  await nameInput.fill("Researcher");
  await titleInput.fill(longTitle);
  await descriptionInput.fill("Finds reliable sources and turns them into concise briefs.");
  await page.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByTestId("avatar-studio-bot-tab")).toBeVisible();
  await studio.getByRole("button", { name: "triangle", exact: true }).click();
  await studio.getByRole("button", { name: "Color #E4C05D" }).click();
  await studio.press("Escape");
  await expect(studio).toBeHidden();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(botList.getByRole("button", { name: /^Researcher/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Researcher")).toBeVisible();

  await page.locator("main").getByRole("button", { name: "Researcher", exact: true }).click();
  await expect(nameInput).toHaveValue("Researcher");
  await expect(titleInput).toHaveValue(normalizedLongTitle);
  await expect(descriptionInput).toHaveValue(
    "Finds reliable sources and turns them into concise briefs.",
  );
  const settings = page.getByTestId("bot-settings");
  await settings.getByTestId("avatar-studio-trigger").click();
  await expect(studio).toBeVisible();
  await expect(studio.getByRole("button", { name: "triangle", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(studio.getByRole("button", { name: "Color #E4C05D" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await studio.press("Escape");
  const modelSelect = settings.locator("label:has-text('Model') select");
  const teamComputer = settings.getByRole("button", { name: "Team" });
  const openWork = settings.getByTestId("bot-scratchpad");
  await expect(teamComputer).toBeHidden();
  await expect(modelSelect).toBeHidden();
  await expect(openWork).toBeHidden();
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Reset computer" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Update computer" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "27a-settings-panel");
  await settings.getByText("Advanced", { exact: true }).click();
  const disabledTools = settings.getByLabel("Disabled tools");
  await expect(disabledTools).toBeVisible();
  await disabledTools.fill("not_a_tool");
  await disabledTools.press("Enter");
  await expect(settings.getByText("Unknown tool")).toBeVisible();
  await disabledTools.fill("web_search");
  await disabledTools.press("Enter");
  await expect(settings.getByRole("switch", { name: "web_search" })).toBeChecked();
  await captureScreenshot(page, testInfo, "27c-disabled-builtin-tools");
  await expect(teamComputer).toBeVisible();
  await expect(openWork).toBeVisible();
  await expect(modelSelect).toBeVisible();
  await expect(modelSelect).toContainText("Space default");
  await captureScreenshot(page, testInfo, "27a-bot-settings-model");
  await page.getByRole("button", { name: "Show computer" }).click();
  const sidePanel = page.getByTestId("side-panel");
  await expect(sidePanel).toHaveAttribute("data-panel", "computer");
  await expect(page.getByRole("button", { name: "Show settings" })).toBeVisible();
  // Overlay may flash during boot or never appear (already ready/asleep/stopped). Assert panel
  // chrome, then wait until any overlay has cleared — avoid Locator.or() strict-mode multi-hits.
  const bootOverlay = page.getByText(/Booting up .* computer/);
  await expect(sidePanel.getByTestId("computer-preview")).toBeVisible();
  await expect(bootOverlay).toBeHidden();
  await expect(sidePanel.getByText("Teach a task")).toHaveCount(0);
  await expect(sidePanel.getByTestId("teach-start-button")).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Reset computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Update computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Take control" })).toHaveCount(0);
  await expect(sidePanel.getByTestId("computer-more-button")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "27b-computer-panel");
  await page.getByRole("button", { name: "Show settings" }).click();

  await nameInput.fill("Atlas");
  await titleInput.fill("Research lead");
  await descriptionInput.fill("Builds durable, source-backed research briefs.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(botList.getByRole("button", { name: /^Atlas/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  await captureScreenshot(page, testInfo, "28-edited-bot-profile");

  await page.reload();
  await expect(botList.getByRole("button", { name: /^Atlas/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  await page.locator("main").getByRole("button", { name: "Atlas", exact: true }).click();
  await expect(nameInput).toHaveValue("Atlas");
  await expect(titleInput).toHaveValue("Research lead");
  await expect(descriptionInput).toHaveValue("Builds durable, source-backed research briefs.");
  await captureScreenshot(page, testInfo, "29-reloaded-bot-profile");

  // Wrap in the narrow dialog without pushing Delete below the Playwright viewport.
  const longUnbrokenName = "A".repeat(48);
  expect(longUnbrokenName.length).toBe(48);
  await nameInput.fill(longUnbrokenName);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const longNameBot = botList.getByRole("button", {
    name: new RegExp(`^${longUnbrokenName}`),
  });
  await expect(longNameBot).toBeVisible();
  await expect(page.getByPlaceholder(`Message ${longUnbrokenName}`)).toBeVisible();

  await longNameBot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("alertdialog", {
    name: `Delete ${longUnbrokenName}?`,
  });
  await expect(deleteDialog).toBeVisible();
  await captureScreenshot(page, testInfo, "30-delete-bot-confirmation");
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(botList.getByText(longUnbrokenName, { exact: true })).toHaveCount(0);
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await page.waitForURL((url) => url.pathname !== deletedBotPath);

  await page.goto(deletedBotPath);
  await page.waitForURL((url) => url.pathname !== deletedBotPath);
  await expect(botList.getByText(longUnbrokenName, { exact: true })).toHaveCount(0);
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await captureScreenshot(page, testInfo, "31-deleted-bot-fallback");
});

test("keeps the shared Bot notification setting across live updates and other saves", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `shared-notification-${stamp}@rakazo.test`, "password12", "Shared Setting");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);
  await expect.poll(async () => (await rpc<Bot>(page, "bots/get", { botId })).status).toBe("idle");
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  const notifications = settings.getByRole("switch", { name: "Notifications", exact: true });
  await expect(notifications).toBeChecked();
  const head = await rpc<{ cursor: number }>(page, "threads/head", { botId });

  const rosterPreference = (value: boolean) =>
    page.waitForResponse(async (response) => {
      if (!response.ok() || new URL(response.url()).pathname !== "/rpc/spaces/list") return false;
      const body = (await response.json()) as { json: SpaceNavigation };
      return body.json.current.bots.some((bot) => bot.id === botId && bot.notifyOnFinish === value);
    });
  const externalOff = rosterPreference(false);
  await rpc(page, "bots/update", { botId, notifyOnFinish: false });
  await externalOff;
  await expect(notifications).not.toBeChecked();
  const replayed = await replayNotificationUpdate(page, botId, head.cursor);
  expect(replayed).toMatchObject({ botId, type: "bot.updated" });
  expect(replayed.seq).toBeGreaterThan(head.cursor);

  await settings.getByText("Advanced", { exact: true }).click();
  const aloud = settings.getByRole("switch", { name: "Read replies aloud", exact: true });
  await aloud.click();
  const manualSaved = page.waitForResponse(
    (response) => response.ok() && new URL(response.url()).pathname === "/rpc/bots/update",
  );
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  const manualPatch = (await manualSaved).request().postDataJSON() as {
    json: Record<string, unknown>;
  };
  expect(manualPatch.json).toMatchObject({ botId, autoSpeak: true });
  expect(manualPatch.json).not.toHaveProperty("notifyOnFinish");
  expect((await rpc<Bot>(page, "bots/get", { botId })).notifyOnFinish).toBe(false);

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured!: () => void;
  const ownCaptured = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let ownPatch: unknown;
  await page.route("**/rpc/bots/update", async (route) => {
    ownPatch = route.request().postDataJSON();
    captured();
    await held;
    await route.continue();
  });
  try {
    await notifications.click();
    await ownCaptured;
    expect(ownPatch).toEqual({ json: { botId, notifyOnFinish: true } });
    await expect(notifications).toBeChecked();
    await expect(notifications).toBeDisabled();
    const externalOn = rosterPreference(true);
    await rpc(page, "bots/update", { botId, notifyOnFinish: true });
    await externalOn;
    const externalOffAgain = rosterPreference(false);
    await rpc(page, "bots/update", { botId, notifyOnFinish: false });
    await externalOffAgain;
    expect((await rpc<Bot>(page, "bots/get", { botId })).notifyOnFinish).toBe(false);
    await expect(notifications).toBeChecked();
    await expect(notifications).toBeDisabled();
    const ownSaved = page.waitForResponse(
      (response) => response.ok() && new URL(response.url()).pathname === "/rpc/bots/update",
    );
    const acceptedRoster = rosterPreference(true);
    release();
    await ownSaved;
    await acceptedRoster;
    await expect(notifications).toBeChecked();
    await expect(notifications).toBeEnabled();
    expect((await rpc<Bot>(page, "bots/get", { botId })).notifyOnFinish).toBe(true);
    await notifications.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "a3-shared-notification-setting");
  } finally {
    release();
    await page.unroute("**/rpc/bots/update");
  }
});

async function replayNotificationUpdate(page: Page, botId: string, cursor: number) {
  return page.evaluate(
    async ({ botId, cursor }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetch("/rpc/threads/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId, cursor } }),
          signal: controller.signal,
        });
        if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream"))
          throw new Error(`Thread replay failed: ${response.status}`);
        reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) throw new Error("Thread replay ended before the preference update");
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary === -1) break;
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame.split("\n").find((line) => line.startsWith("data: "));
            if (!data) continue;
            const event = (
              JSON.parse(data.slice(6)) as {
                json?: { type: string; botId: string; seq: number };
              }
            ).json;
            if (event?.type === "bot.updated" && event.botId === botId && event.seq > cursor)
              return event;
          }
        }
      } finally {
        clearTimeout(timeout);
        controller.abort();
        await reader?.cancel().catch(() => undefined);
      }
    },
    { botId, cursor },
  );
}
