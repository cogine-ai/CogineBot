import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("companion sidebar keeps previews and uses the avatar rail without a separate density setting", async ({
  page,
}, testInfo) => {
  await signup(page, `sidebar-layout-${Date.now()}@rakazo.test`, "password12", "Sidebar Layout");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "threads/send", { botId, text: "Keep the last dialogue visible" });
  await rpc(page, "threads/stop", { botId });
  await page.reload();
  const sidebar = page.getByTestId("bots-sidebar");
  const row = page.locator(`[data-roster-bot-id="${botId}"]`);
  await expect(row.locator("[data-roster-preview]")).toBeVisible();
  await expect(row.locator("[data-roster-bot-name]")).toBeVisible();
  const settings = await openUserSettings(page);
  await expect(settings.getByTestId("bots-sidebar-density-select")).toHaveCount(0);
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await sidebar.getByRole("button", { name: "Minimize bots", exact: true }).click();
  await expect(row).toHaveAttribute("data-sidebar-compact", "true");
  await expect(row.locator("[data-roster-preview]")).toHaveCount(0);
  await expect(row.locator("[data-roster-bot-name]")).toHaveCount(0);
  await expect(row.locator("[data-avatar-identity]")).toBeVisible();
  await expect(sidebar).toBeVisible();
  await captureScreenshot(page, testInfo, "companion-sidebar-avatar-rail");
  await sidebar.getByRole("button", { name: "Show bots", exact: true }).click();
  await expect(row.locator("[data-roster-preview]")).toBeVisible();
});
