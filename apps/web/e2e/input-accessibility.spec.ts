import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("same-name attachments stay distinct and an external-link dialog restores its keyboard trigger", async ({
  page,
}, testInfo) => {
  await signup(page, `input-access-${Date.now()}@rakazo.test`, "password12", "Input Access");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  const filename = `${"同名报告👩‍👩‍👧‍👦".repeat(12)}.txt`;
  const files = page.getByTestId("composer-bar").locator('input[type="file"]');
  await files.setInputFiles([
    { name: filename, mimeType: "text/plain", buffer: Buffer.from("first") },
    { name: filename, mimeType: "text/plain", buffer: Buffer.from("other") },
  ]);
  const attachments = page.getByTestId("attachment-preview");
  await expect(attachments).toHaveCount(2);
  await expect(attachments.nth(0)).toContainText("1 · 5 B");
  await expect(attachments.nth(1)).toContainText("2 · 5 B");
  await expect(attachments.nth(0).getByRole("button")).toHaveAccessibleName(
    `Remove ${filename} · 1 · 5 B`,
  );
  await expect(attachments.nth(0).getByText("1 · 5 B", { exact: true })).toBeVisible();
  await expect(attachments.nth(1).getByText("2 · 5 B", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "same-name-attachments");
  await page.setViewportSize({ width: 1280, height: 900 });
  await attachments.nth(0).getByRole("button").click();
  await expect(attachments).toHaveCount(1);
  await files.setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from("again"),
  });
  await expect(attachments).toHaveCount(2);
  await attachments.nth(1).getByRole("button").click();
  await attachments.nth(0).getByRole("button").click();
  await composer.fill("中文 é 👩‍👩‍👧‍👦 https://example.test/keyboard-link");
  await composer.press("Enter");
  const link = page
    .getByTestId("message-user-bubble")
    .getByRole("link", { name: /example.test\/keyboard-link/ });
  await expect(link).toBeVisible();
  await link.focus();
  await link.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await captureScreenshot(page, testInfo, "keyboard-link-confirmation");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(link).toBeFocused();
});
