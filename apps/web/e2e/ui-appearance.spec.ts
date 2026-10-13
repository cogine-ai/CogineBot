import { expect, type Page, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

async function backgroundToken(page: Page, token: "--sidebar-accent" | "--muted") {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, token);
}

async function captureSidebarSearchSelected(
  page: Page,
  testInfo: Parameters<typeof captureScreenshot>[1],
  name: string,
) {
  const aside = page.locator("aside").first();
  const search = aside.getByTestId("sidebar-search");
  const selected = aside.getByRole("button", { name: /^Chief/ }).first();
  await expect(search).toBeVisible();
  await expect(selected).toBeVisible();
  await search.scrollIntoViewIfNeeded();

  const searchBox = (await search.boundingBox())!;
  const createBox = (await page.getByTestId("create-menu-trigger").boundingBox())!;
  const sidebarBox = (await aside.boundingBox())!;
  const inputBox = (await search.locator("input").boundingBox())!;
  const selectedBox = (await selected.boundingBox())!;
  expect(searchBox.x).toBeGreaterThanOrEqual(sidebarBox.x);
  expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(createBox.x);
  expect(createBox.x + createBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width);
  expect(inputBox.width).toBeGreaterThanOrEqual(100);
  expect(selectedBox.x).toBeGreaterThanOrEqual(sidebarBox.x);
  expect(selectedBox.x + selectedBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width);

  const box = await aside.boundingBox();
  if (box) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      path: screenshotPath,
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.min(box.width + 24, 360),
        height: Math.min(Math.max(box.height * 0.45, 280), 420),
      },
    });
    await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
    return;
  }
  await captureScreenshot(page, testInfo, name);
}

test("account settings appearance control switches to light mode", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-appearance-${stamp}@rakazo.test`, "password12", "Appearance QA");
  await completeOnboarding(page, testInfo);

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-appearance-select");
  await expect(picker).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-appearance-control");

  await settings.getByTestId("ui-appearance-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(settings.getByTestId("ui-appearance-light")).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "ui-appearance-light-settings");

  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await captureScreenshot(page, testInfo, "ui-appearance-light-shell");
  await captureSidebarSearchSelected(page, testInfo, "sidebar-search-selected-light");

  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("Please review `shared/PROJECT_CHECKPOINT_WRAPUP.md`.");
  await composer.press("Enter");
  const assistantReply = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ hasText: "done. i handled:" });
  const inlinePath = assistantReply
    .locator("code")
    .filter({ hasText: "shared/PROJECT_CHECKPOINT_WRAPUP.md" });
  await expect(inlinePath).toBeVisible({ timeout: 30_000 });
  await expect(inlinePath).toHaveCSS("color", "rgb(26, 26, 26)");
  await captureScreenshot(page, testInfo, "inline-code-light");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureSidebarSearchSelected(page, testInfo, "sidebar-search-selected-dark");
});

test("Bot and group navigation share a hover tone and account menu items are consistent", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-hover-${stamp}@rakazo.test`, "password12", "Hover QA");
  await completeOnboarding(page, testInfo);
  const chiefId = activeBotId(page);
  const secondId = await createNamedBot(page, "Second Bot");
  await rpc(page, "groups/create", { name: "Weekend companions", botIds: [chiefId, secondId] });
  await page.reload();

  const sidebar = page.locator("aside").first();
  const chief = sidebar.getByRole("button", { name: /^Chief/ }).first();
  await expect(chief).toBeVisible();
  const readChiefBg = () => chief.evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect.poll(readChiefBg).toBe("rgba(0, 0, 0, 0)");

  const sidebarAccent = await backgroundToken(page, "--sidebar-accent");
  await chief.hover();
  // Wait for the shared hover token, not an intermediate transition alpha.
  await expect.poll(readChiefBg).toBe(sidebarAccent);
  const chiefBg = await readChiefBg();
  await captureScreenshot(page, testInfo, "sidebar-row-hover");

  const group = sidebar.getByRole("button", { name: /^Weekend companions/ });
  await group.hover();
  await expect
    .poll(() => group.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(chiefBg);
  await captureScreenshot(page, testInfo, "sidebar-group-hover");

  await page.getByTestId("user-menu-trigger").click();
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const integrations = page.getByRole("button", { name: "Integrations", exact: true });
  const mutedBg = await backgroundToken(page, "--muted");
  const readSettingsBg = () => settings.evaluate((el) => getComputedStyle(el).backgroundColor);
  await settings.hover();
  await expect.poll(readSettingsBg).toBe(mutedBg);
  const menuBg = await readSettingsBg();
  expect(menuBg).not.toBe("rgba(0, 0, 0, 0)");
  await integrations.hover();
  await expect
    .poll(() => integrations.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(menuBg);
  await captureScreenshot(page, testInfo, "account-menu-hover");
});
