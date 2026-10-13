import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("companion appearance lives in the Bot editor instead of an account style switch", async ({
  page,
}, testInfo) => {
  await signup(page, `avatar-style-${Date.now()}@rakazo.test`, "password12", "Avatar style QA");
  await completeOnboarding(page);
  await expect(
    page.locator('[data-testid="bots-sidebar"] .rakazo-gaze-avatar').first(),
  ).toBeVisible();
  const settings = await openUserSettings(page);
  await expect(settings.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
  await expect(settings.getByTestId("avatar-style-select")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "account-appearance");
});
