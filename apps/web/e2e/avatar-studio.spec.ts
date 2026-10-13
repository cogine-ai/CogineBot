import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("Bot settings open the compact companion editor and save shape and color immediately", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-studio-${stamp}@rakazo.test`, "password12", "Avatar Studio");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const settings = page.getByTestId("bot-settings");
  await page.getByTestId("bot-settings-trigger").waitFor({ state: "visible" });
  if (!(await settings.isVisible())) await page.getByTestId("bot-settings-trigger").click();
  await expect(settings).toBeVisible();
  await settings.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByRole("button", { name: "Bot", exact: true })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Upload", exact: true })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Generate", exact: true })).toHaveCount(0);
  await expect(studio.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
  await expect(studio.getByTestId("avatar-studio-bot-tab").locator("button")).toHaveCount(19);

  const shapeSave = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await studio.getByRole("button", { name: "arch", exact: true }).click();
  await shapeSave;
  await expect(studio.getByRole("button", { name: "arch", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const colorSave = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await studio.getByRole("button", { name: "Color #62A8EC", exact: true }).click();
  await colorSave;
  await expect(studio.getByRole("button", { name: "Color #62A8EC", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(studio.getByRole("button", { name: "arch", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await captureScreenshot(page, testInfo, "avatar-studio-bot-tab");

  await page.reload();
  await page.getByTestId("bot-settings-trigger").waitFor({ state: "visible" });
  if (!(await settings.isVisible())) await page.getByTestId("bot-settings-trigger").click();
  await settings.getByTestId("avatar-studio-trigger").click();
  await expect(studio.getByRole("button", { name: "arch", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(studio.getByRole("button", { name: "Color #62A8EC", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("a retained mention draft reflects current companion appearance without changing its recipient", async ({
  page,
}, testInfo) => {
  await signup(page, `avatar-mention-${Date.now()}@rakazo.test`, "password12", "Mention Avatar");
  await completeOnboarding(page);
  const chiefId = new URL(page.url()).pathname.split("/").at(-1)!;
  const companion = await rpc<{ id: string }>(page, "bots/create", {
    name: "Palette companion",
    color: "#F5A15D::shape_0",
    title: "",
    description: "",
    notifyOnFinish: false,
  });
  await page.goto(`/app/${chiefId}`);
  const input = page.getByTestId("composer-bar").locator('textarea[name="chat-message"]');
  await input.fill("@Palette companion");
  await page.getByRole("option", { name: "@Palette companion", exact: true }).click();
  const chip = page.getByTestId("mention-chip");
  await expect(chip.locator(".rakazo-gaze-avatar")).toHaveAttribute("data-shape", "circle");
  await input.fill("Keep this draft.");

  await page.locator(`[data-roster-bot-id="${companion.id}"]`).click();
  await page.getByTestId("bot-settings-trigger").click();
  await page.getByTestId("bot-settings").getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  const shapeSaved = page.waitForResponse(
    (response) => response.url().endsWith("/rpc/bots/update") && response.ok(),
  );
  await studio.getByRole("button", { name: "arch", exact: true }).click();
  await shapeSaved;
  const colorSaved = page.waitForResponse(
    (response) => response.url().endsWith("/rpc/bots/update") && response.ok(),
  );
  await studio.getByRole("button", { name: "Color #62A8EC", exact: true }).click();
  await colorSaved;
  await page.keyboard.press("Escape");
  await page.locator(`[data-roster-bot-id="${chiefId}"]`).click();
  await expect(input).toHaveValue("Keep this draft.");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".rakazo-bot-avatar")).toHaveAttribute(
    "data-avatar-identity",
    companion.id,
  );
  await expect(chip.locator(".rakazo-gaze-avatar")).toHaveAttribute("data-shape", "arch");
  await expect(chip.locator(".rakazo-gaze-avatar > path")).toHaveAttribute("fill", "#62A8EC");
  await captureScreenshot(page, testInfo, "retained-draft-current-companion-appearance");

  const sent = page.waitForRequest((request) => request.url().endsWith("/rpc/threads/send"));
  await input.press("Enter");
  const payload = (await sent).postDataJSON() as {
    json: { botId: string; text: string; mentions: unknown[] };
  };
  expect(payload.json.botId).toBe(chiefId);
  expect(payload.json.text).toBe("@Palette companion Keep this draft.");
  expect(payload.json.mentions).toEqual([{ kind: "bot", id: companion.id }]);
});
