import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createBotFromPicker,
  openNewBot,
  rpc,
  signup,
} from "./helpers";

test("create opens the existing form and sidebar keeps a compact avatar rail", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `new-bot-ux-${stamp}@rakazo.test`, "password12", "New Bot UX");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTestId("create-menu-trigger").click();
  const picker = page.getByTestId("create-menu");
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId("create-new-bot")).toBeVisible();
  await expect(picker.getByTestId("create-new-group")).toBeVisible();
  await expect(picker.getByTestId("create-new-space")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "plus-picker-bots");

  await picker.getByTestId("create-new-bot").click();
  const form = page.getByTestId("create-bot-form");
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "create");
  await expect(form).toBeVisible();
  await expect(form.locator("label:has-text('Name') input")).toBeVisible();
  await expect(form.locator("label:has-text('Title') input")).toBeVisible();
  await expect(form.locator("label:has-text('Description') textarea")).toBeVisible();
  await expect(form.getByTestId("create-bot-computer")).toBeVisible();
  await expect(form.getByTestId("create-bot-team")).toBeVisible();
  await expect(form.getByTestId("create-bot-private")).toBeVisible();
  await captureScreenshot(page, testInfo, "create-bot-form");

  await form.locator("label:has-text('Name') input").fill("New Bot");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "create-chat-sidepanel-closed");

  await page.getByTestId("minimize-bots-sidebar").click();
  await expect(page.getByTestId("bots-sidebar")).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId("bots-sidebar")).toHaveCSS("width", "88px");
  const restore = page.getByTestId("restore-bots-sidebar");
  await expect(restore).toBeVisible();
  await expect(
    page.getByTestId("bots-sidebar").locator(".rakazo-bot-avatar").first(),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "bots-sidebar-collapsed");

  await page.reload();
  await expect(page.getByTestId("bots-sidebar")).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId("bots-sidebar")).toHaveCSS("width", "88px");
  await restore.click();
  await expect(page.getByTestId("bots-sidebar")).toHaveAttribute("data-collapsed", "false");
  await expect(page.getByTestId("bots-sidebar")).toHaveCSS("width", "280px");
  await expect(restore).toHaveCount(0);
  await captureScreenshot(page, testInfo, "bots-sidebar-expanded");
});

test("creation menu stays concise and Space creation remains in the Space menu", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `picker-info-${stamp}@rakazo.test`, "password12", "Picker Info");
  await completeOnboarding(page);

  await page.getByTestId("create-menu-trigger").click();
  const picker = page.getByTestId("create-menu");
  await expect(picker.getByTestId("create-new-bot")).toBeVisible();
  await expect(picker.getByTestId("create-new-group")).toBeVisible();
  await expect(picker.getByTestId("create-new-space")).toHaveCount(0);
  await expect(page.getByTestId("picker-info-dialog")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "concise-create-menu");
  await page.keyboard.press("Escape");

  await page.getByTestId("space-menu-trigger").click();
  await expect(page.getByTestId("create-new-space")).toBeVisible();
  await captureScreenshot(page, testInfo, "space-create-menu");
  await page.getByTestId("create-new-space").click();
  await expect(page.getByRole("dialog", { name: "New space" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("new companions start in chat without a delayed focus card", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `focus-delay-${stamp}@rakazo.test`, "password12", "Focus Delay");
  await completeOnboarding(page);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);

  await page.clock.install();
  await createBotFromPicker(page);
  await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);

  await page.clock.fastForward(9_000);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
  await page.clock.fastForward(1_500);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);

  await createBotFromPicker(page, { name: "Later Bot" });
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
  // Closing the create panel can precede the new thread loading; the previous
  // bot's composer must not receive this draft.
  const composer = page.getByRole("combobox", { name: "Message Later Bot", exact: true });
  await expect(composer).toBeEditable();
  await composer.fill("I'll set this up myself");
  // The existing intro run and a normal reply remain available; elapsed time
  // must never add a separate setup card above the ongoing conversation.
  const sent = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/send") && response.ok(),
  );
  await composer.press("Enter");
  await sent;
  // Scope to the user bubble: the assistant reply can echo this phrase as a substring.
  await expect(
    page
      .getByTestId("transcript")
      .getByTestId("message-user-bubble")
      .getByText("I'll set this up myself", { exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(12_000);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
});

test("plus picker can create a Private computer bot", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `new-bot-private-${stamp}@rakazo.test`, "password12", "New Bot Private");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await createBotFromPicker(page, { computerMode: "dedicated" });
  await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
  await captureScreenshot(page, testInfo, "create-private-computer-bot");

  const botId = page.url().split("/").pop()!;
  const bots = await rpc<Array<{ id: string; computerMode: string }>>(page, "bots/list", {});
  expect(bots.find((bot) => bot.id === botId)?.computerMode).toBe("dedicated");
});

test("second bot from plus opens create form before persist", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `second-bot-form-${stamp}@rakazo.test`, "password12", "Second Bot Form");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await openNewBot(page);
  const form = page.getByTestId("create-bot-form");
  await expect(form).toBeVisible();
  await form.locator("label:has-text('Name') input").fill("Researcher");
  await form.locator("label:has-text('Title') input").fill("Finds sources");
  await form.locator("label:has-text('Description') textarea").fill("Briefs from the web.");
  await captureScreenshot(page, testInfo, "second-bot-create-form");

  const create = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/create") && response.ok(),
  );
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await create;
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByPlaceholder("Message Researcher")).toBeVisible();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
  await captureScreenshot(page, testInfo, "second-bot-created");
});
