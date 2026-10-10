import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, Group } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openNewBot,
  openNewGroup,
  rpc,
  signup,
} from "./helpers";

const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const errors = browserErrors.get(page) ?? [];
  if (errors.length > 0) {
    await testInfo.attach("browser-errors", {
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(errors, null, 2)),
    });
  }
  expect.soft(errors, "desktop shell has no browser exceptions or console errors").toEqual([]);
});

async function expectWidth(element: Locator, width: number) {
  await expect.poll(async () => Math.round((await element.boundingBox())?.width ?? 0)).toBe(width);
}

async function expectSquareAvatar(row: Locator) {
  const avatar = row.locator(".rakazo-bot-avatar").first();
  await expect(avatar).toBeVisible();
  const box = await avatar.boundingBox();
  expect(box).toBeTruthy();
  expect(Math.abs(box!.width - box!.height)).toBeLessThanOrEqual(1);
  expect(box!.width).toBeGreaterThanOrEqual(30);
}

async function expectWithinViewport(element: Locator, page: Page) {
  const box = await element.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test("desktop shell uses persistent Bot and group lists and keeps existing entry points", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signup(page, `desktop-shell-${Date.now()}@rakazo.test`, "password12", "Shell Review");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const partner = await rpc<Bot>(page, "bots/create", {
    name: "A companion with a deliberately long display name",
    title: "This profile title belongs in profile details",
    description: "",
    computerMode: "team",
  });
  const group = await rpc<Group>(page, "groups/create", {
    name: "A weekend group with a deliberately long name",
    botIds: [chiefId, partner.id],
  });
  await rpc(page, "bots/update", { botId: chiefId, pinned: true });
  await rpc(page, "groups/update", { groupId: group.id, pinned: true });
  try {
    await rpc(page, "threads/send", {
      botId: partner.id,
      text: "A little walk and coffee; keep working until I stop you",
    });
    await rpc(page, "threads/stop", { botId: partner.id });
    await rpc(page, "threads/send", {
      groupId: group.id,
      text: "Let's leave room for a quiet weekend.",
    });
    await rpc(page, "threads/stop", { groupId: group.id });
    await page.reload();

    const sidebar = page.getByTestId("bots-sidebar");
    await expectWidth(sidebar, 280);
    await expect(sidebar).toHaveAttribute("data-sidebar-compact", "false");
    await expect(page.getByTestId("sidebar-current-space")).toBeVisible();
    await expect(sidebar.locator("[data-sidebar-pinned-separator]")).toHaveCount(1);
    await expect(sidebar.getByText("Pinned", { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText("Unassigned", { exact: true })).toHaveCount(0);

    const botRow = sidebar.locator(`[data-roster-bot-id="${partner.id}"]`);
    const groupRow = sidebar.getByRole("button", { name: new RegExp(`^${group.name}`) });
    const bots = await rpc<Bot[]>(page, "bots/list", {});
    const groups = await rpc<Group[]>(page, "groups/list", {});
    const botPreview = bots.find((bot) => bot.id === partner.id)!.preview;
    const groupPreview = groups.find((chat) => chat.id === group.id)!.preview;
    expect(botPreview).not.toBe("");
    expect(groupPreview).not.toBe("");
    await expect(botRow).toContainText(botPreview);
    await expect(groupRow).toContainText(groupPreview);
    await expect(botRow).not.toContainText(partner.title);
    await expectSquareAvatar(botRow);

    await groupRow.click();
    await expect(page).toHaveURL(new RegExp(`/app/g/${group.id}$`));
    await expect(page.getByRole("combobox", { name: `Message ${group.name}` })).toBeVisible();
    await expect(
      page
        .getByTestId("transcript")
        .getByTestId("message-user-bubble")
        .getByText("Let's leave room for a quiet weekend.", { exact: true }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "desktop-shell-expanded-group");

    await page.getByTestId("create-menu-trigger").click();
    await expect(page.getByTestId("create-new-bot")).toBeVisible();
    await expect(page.getByTestId("create-new-group")).toBeVisible();
    await expect(page.getByTestId("create-new-space")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "desktop-shell-create-menu");
    await page.keyboard.press("Escape");
    await openNewBot(page);
    await expect(page.getByTestId("create-bot-form")).toBeVisible();
    await page.getByRole("button", { name: "Cancel new bot", exact: true }).click();
    await openNewGroup(page);
    await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "create-group");
    await page.getByRole("button", { name: "Cancel new group", exact: true }).click();

    const footerAvatar = page.getByTestId("user-menu-trigger");
    const files = page.getByTestId("sidebar-files-trigger");
    const avatarBox = (await footerAvatar.boundingBox())!;
    const filesBox = (await files.boundingBox())!;
    expect(
      Math.abs(avatarBox.y + avatarBox.height / 2 - filesBox.y - filesBox.height / 2),
    ).toBeLessThanOrEqual(1);
    await footerAvatar.click();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, "desktop-shell-account-menu");
    await page.keyboard.press("Escape");

    await page.getByTestId("minimize-bots-sidebar").click();
    await expectWidth(sidebar, 88);
    await expect(sidebar).toHaveAttribute("data-sidebar-compact", "true");
    await expect(botRow.locator("[data-roster-bot-name]")).not.toBeVisible();
    await expectSquareAvatar(botRow);
    expect((await files.boundingBox())!.y).toBeLessThan((await footerAvatar.boundingBox())!.y);
    await expect(sidebar.locator("[data-sidebar-pinned-separator]")).toHaveCount(1);
    await captureScreenshot(page, testInfo, "desktop-shell-compact");
    await page.reload();
    await expectWidth(sidebar, 88);
    await expect(page.getByTestId("restore-bots-sidebar")).toBeVisible();
    await page.getByTestId("restore-bots-sidebar").click();
    await expectWidth(sidebar, 280);

    await rpc(page, "bots/update", { botId: chiefId, pinned: false });
    await rpc(page, "groups/update", { groupId: group.id, pinned: false });
    await page.reload();
    await expect(sidebar.locator("[data-sidebar-pinned-separator]")).toHaveCount(0);

    await rpc(page, "artifacts/create", {
      botId: chiefId,
      name: "weekend-note.md",
      mimeType: "text/markdown",
      contentBase64: Buffer.from("# A quiet weekend").toString("base64"),
    });
    await files.click();
    await expect(page).toHaveURL(/\/app\/artifacts$/);
    await expect(page.getByText("weekend-note.md")).toBeVisible();
  } finally {
    await rpc(page, "threads/stop", { botId: partner.id }).catch(() => undefined);
    await rpc(page, "threads/stop", { groupId: group.id }).catch(() => undefined);
  }
});

test("narrow desktop keeps the avatar rail and restores the user's layout in English and Chinese", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signup(page, `desktop-layout-${Date.now()}@rakazo.test`, "password12", "Layout Review");
  await completeOnboarding(page);
  const sidebar = page.getByTestId("bots-sidebar");
  await expectWidth(sidebar, 280);
  await page.getByTestId("bot-settings-trigger").click();
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveAttribute("data-panel", "settings");
  await page.setViewportSize({ width: 800, height: 720 });
  await expectWidth(sidebar, 88);
  await expect(sidebar).toHaveAttribute("data-sidebar-compact", "true");
  const composer = page.getByTestId("composer-bar");
  expect((await page.locator("main").boundingBox())!.width).toBeGreaterThanOrEqual(320);
  expect((await composer.boundingBox())!.width).toBeGreaterThanOrEqual(280);
  await expectWithinViewport(composer, page);
  await expectWithinViewport(page.getByRole("combobox", { name: /^Message/ }), page);
  await expectWithinViewport(panel, page);
  await expectWithinViewport(page.getByRole("button", { name: "Close panel", exact: true }), page);
  await captureScreenshot(page, testInfo, "desktop-shell-800-panel");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expectWidth(sidebar, 280);
  await page.setViewportSize({ width: 800, height: 720 });
  await expectWidth(sidebar, 88);
  await page.getByTestId("restore-bots-sidebar").click();
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await expectWidth(sidebar, 280);

  await page.getByTestId("minimize-bots-sidebar").click();
  await page.getByTestId("bot-settings-trigger").click();
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expectWidth(sidebar, 88);
  await page.getByTestId("restore-bots-sidebar").click();

  for (const locale of ["en", "zh-CN"] as const) {
    await page.evaluate((language) => localStorage.setItem("rakazo.uiLocale", language), locale);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
    await expect(sidebar.locator("[data-roster-bot-id]")).toHaveCount(1);
    await expect(page.getByRole("combobox", { name: /^Message |^给 .+ 发消息$/ })).toBeVisible();
    await expectWidth(sidebar, 280);
    await page.getByTestId("create-menu-trigger").click();
    for (const entry of ["create-new-bot", "create-new-group"]) {
      await expectWithinViewport(page.getByTestId(entry), page);
    }
    await captureScreenshot(page, testInfo, `desktop-shell-800-create-${locale}`);
    await page.keyboard.press("Escape");
    await page.getByTestId("space-menu-trigger").click();
    await expectWithinViewport(page.getByTestId("create-new-space"), page);
    await captureScreenshot(page, testInfo, `desktop-shell-800-spaces-${locale}`);
    await page.keyboard.press("Escape");
    await page.getByTestId("user-menu-trigger").click();
    const settings = page.getByRole("button", {
      name: locale === "en" ? "Settings" : "设置",
      exact: true,
    });
    await expectWithinViewport(settings, page);
    await captureScreenshot(page, testInfo, `desktop-shell-800-account-${locale}`);
    await page.keyboard.press("Escape");
  }
  await page.evaluate(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(sidebar.locator("[data-roster-bot-id]")).toHaveCount(1);
  await expectWidth(sidebar, 280);
  await captureScreenshot(page, testInfo, "desktop-shell-800-chinese-dark");
  await page.getByTestId("minimize-bots-sidebar").click();
  await expectWidth(sidebar, 88);
  await captureScreenshot(page, testInfo, "desktop-shell-800-chinese-dark-compact");
});

test("compact Search and Activity open usable expanded views", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signup(page, `desktop-search-${Date.now()}@rakazo.test`, "password12", "Search Review");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  await rpc<Bot>(page, "bots/create", {
    name: "Search partner",
    description: "A synthetic companion for navigation checks",
    computerMode: "team",
  });
  try {
    await rpc(page, "threads/send", {
      botId: chiefId,
      text: "A quiet weekend; keep working until I stop you",
    });
    await rpc(page, "threads/stop", { botId: chiefId });
    await page.reload();

    const sidebar = page.getByTestId("bots-sidebar");
    const search = sidebar.getByPlaceholder("Search", { exact: true });
    await search.fill("Search partner");
    const result = sidebar.getByRole("button").filter({ hasText: "Search partner" }).first();
    await expect(result).toBeVisible();
    await captureScreenshot(page, testInfo, "desktop-shell-expanded-search");
    await page.getByTestId("minimize-bots-sidebar").click();
    await expectWidth(sidebar, 88);
    await expect(sidebar.getByText("Search partner", { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText("Searching…", { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText("No results", { exact: true })).toHaveCount(0);

    await sidebar.getByTestId("sidebar-search").click();
    await expectWidth(sidebar, 280);
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("Search partner");
    await expect(result).toBeVisible();
    await expect(page.getByTestId("command-palette-search")).toHaveCount(0);

    await page.getByTestId("minimize-bots-sidebar").click();
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expectWidth(sidebar, 280);
    await expect(search).toHaveValue("");
    const activity = page.getByTestId("activity-list");
    await expect(activity).toBeVisible();
    await expect(activity.getByRole("button", { name: /^Chief, / }).first()).toBeVisible();
    await captureScreenshot(page, testInfo, "desktop-shell-expanded-activity");
  } finally {
    await rpc(page, "threads/stop", { botId: chiefId }).catch(() => undefined);
  }
});
