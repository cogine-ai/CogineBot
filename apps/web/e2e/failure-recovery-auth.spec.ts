import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("an explicit sign-in recovery keeps only the same owner's editable draft through the real anonymous session wipe", async ({
  page,
}, info) => {
  const email = `draft-recovery-${Date.now()}@example.test`;
  const password = "password12";
  await page.setViewportSize({ width: 1280, height: 1000 });
  await signup(page, email, password, "Draft Recovery");
  await completeOnboarding(page);
  const originalPath = new URL(page.url()).pathname;
  const composer = page.getByTestId("composer-bar").locator('textarea[name="chat-message"]');
  const text = "Private unsent notes.\nKeep both lines after signing in again.";
  await composer.fill(text);
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "unsent-recovery.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Original local file contents"),
    });
  const writes: string[] = [];
  page.on("request", (request) => {
    if (/\/(threads\/send|artifacts\/upload)$/.test(new URL(request.url()).pathname))
      writes.push(request.url());
  });
  await page.getByTestId("sidebar-files-trigger").click();
  await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
  await page.route("**/rpc/bootstrap", (route) =>
    route.fulfill({
      status: 401,
      json: { json: { code: "UNAUTHORIZED", status: 401, message: "synthetic expired session" } },
    }),
  );
  // SPA history preserves tab RAM; a reload here would erase the content being tested.
  await page.goBack();
  const notice = page.getByTestId("load-failure");
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to CogineBot" })).toBeVisible();
  await expect(page.getByTestId("composer-bar")).toHaveCount(0);
  await page.unroute("**/rpc/bootstrap");
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.waitForURL((url) => url.pathname === originalPath);
  await expect(composer).toHaveValue(text);
  await expect(page.getByRole("button", { name: "Remove unsent-recovery.txt" })).toBeVisible();
  expect(writes).toEqual([]);
  await captureScreenshot(page, info, "b5-auth-recovery-keeps-editable-draft");
  await composer.fill("Newer edit after recovery");
  await page.getByTestId("sidebar-files-trigger").click();
  await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
  await page.goBack();
  await expect(composer).toHaveValue("Newer edit after recovery");
  expect(writes).toEqual([]);
});
