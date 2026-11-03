import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { AppBootstrap, ThreadSnapshot } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openNewSpace,
  rpc,
  signup,
} from "./helpers";

function isPresented(error: Locator) {
  return error.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const topElement = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return topElement === element || (topElement !== null && element.contains(topElement));
  });
}

function seenRunErrorCount(page: Page) {
  return page.evaluate(() => {
    let count = 0;
    for (let index = 0; index < localStorage.length; index += 1) {
      if (localStorage.key(index)?.startsWith("rakazo:seen-run-error:")) count += 1;
    }
    return count;
  });
}

test("a failed run is visible once without returning after reload", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `run-failure-${stamp}@rakazo.test`, "password12", "Run Failure");
  await completeOnboarding(page);

  // "fail this run" makes the scripted runtime throw, so the run fails the same way a
  // real provider error would, without depending on how models are configured.
  await page.getByPlaceholder(/^Message /).fill("fail this run");
  await page.getByRole("button", { name: "Send" }).click();

  const error = page.getByTestId("composer-error");
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).toContainText("The model provider returned an error.");
  await error.getByText("Details", { exact: true }).click();
  await expect(error.locator("pre")).toContainText("Scripted run failure");
  await captureScreenshot(page, testInfo, "new-run-error-visible");

  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(
    page.getByTestId("transcript").getByText("fail this run", { exact: true }),
  ).toBeVisible();
  await expect(error).toBeHidden();
  await captureScreenshot(page, testInfo, "seen-run-error-hidden-after-reload");

  await page.getByPlaceholder(/^Message /).fill("fail this run");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).toContainText("The model provider returned an error.");

  const dismissError = page.getByTestId("composer-error-dismiss");
  await dismissError.focus();
  await expect(dismissError).toBeFocused();
  await dismissError.press("Enter");
  await expect(error).toBeHidden();
  await expect(page.getByPlaceholder(/^Message /)).toBeFocused();
});

for (const diagnostic of [
  { id: "computer-start", text: "The computer did not start. Try again." },
  { id: "computer-unreachable", text: "Box could not be reached" },
]) {
  test(`computer setup failures expose safe diagnostics in Details: ${diagnostic.id}`, async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 844 });
    await signup(
      page,
      `${diagnostic.id}-${Date.now()}@example.test`,
      "password12",
      "Computer Failure",
    );
    await completeOnboarding(page);
    await page.getByPlaceholder(/^Message /).fill("fail this run");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const error = page.getByTestId("composer-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    const snapshot = await rpc<ThreadSnapshot>(page, "threads/get", { botId: activeBotId(page) });
    const failedRun = snapshot.run;
    expect(failedRun).toMatchObject({ status: "failed", error: "Scripted run failure" });
    if (!failedRun) throw new Error("The scripted fixture must create a failed Run");
    await expect
      .poll(() =>
        page.evaluate((id) => localStorage.getItem(`rakazo:seen-run-error:${id}`), failedRun.id),
      )
      .not.toBeNull();

    let patchedSnapshots = 0;
    // Keep the real failed Run and response; substitute only its diagnostic for rendered acceptance.
    for (const procedure of ["bootstrap", "threads/get"]) {
      await page.route(`**/rpc/${procedure}`, async (route) => {
        const response = await route.fetch({ maxRetries: 0 });
        const body = (await response.json()) as { json?: AppBootstrap | ThreadSnapshot };
        const thread =
          procedure === "bootstrap"
            ? (body.json as AppBootstrap | undefined)?.thread
            : (body.json as ThreadSnapshot | undefined);
        if (thread?.run?.id === failedRun.id) {
          expect(thread.run.status).toBe("failed");
          expect(thread.run.error).toBe("Scripted run failure");
          thread.run.error = diagnostic.text;
          patchedSnapshots += 1;
        }
        await route.fulfill({ response, json: body });
      });
    }
    await page.evaluate(
      (id) => localStorage.removeItem(`rakazo:seen-run-error:${id}`),
      failedRun.id,
    );
    await page.reload();
    await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
    // An idle subscription becomes live on its first 20-second heartbeat.
    await expect(page.getByTestId("connection-status")).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => patchedSnapshots).toBeGreaterThan(0);
    const details = error.getByTestId("run-error-details");
    await expect(details.locator("p")).toHaveText("The model provider returned an error.");
    await expect(details.locator("pre")).toBeHidden();
    await details.getByText("Details", { exact: true }).click();
    await expect(details.locator("pre")).toHaveText(diagnostic.text);
    await expect(error).not.toContainText("Scripted run failure");
    await captureScreenshot(page, testInfo, `${diagnostic.id}-error-details`);
    expect(pageErrors).toEqual([]);
  });
}

test("a covered run error is not remembered until it is presented", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `covered-run-failure-${stamp}@rakazo.test`, "password12", "Covered Failure");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByPlaceholder(/^Message /).fill("fail this run");
  const sendButton = await page.getByRole("button", { name: "Send" }).elementHandle();
  if (!sendButton) throw new Error("Send button not found");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("main")).toHaveJSProperty("inert", true);
  await sendButton.evaluate((button) => (button as HTMLButtonElement).click());

  const error = page.getByTestId("composer-error");
  await expect(error).toContainText("The model provider returned an error.", { timeout: 30_000 });
  expect(await isPresented(error)).toBe(false);
  await captureScreenshot(page, testInfo, "run-error-covered-by-mobile-navigation");
  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(error).toBeVisible();
  expect(await isPresented(error)).toBe(true);
  await captureScreenshot(page, testInfo, "covered-run-error-presented-after-reload");

  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(error).toBeHidden();

  const recordedErrorCount = await seenRunErrorCount(page);
  await page.getByPlaceholder(/^Message /).fill("fail this run");
  const nextSendButton = await page.getByRole("button", { name: "Send" }).elementHandle();
  if (!nextSendButton) throw new Error("Send button not found");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await nextSendButton.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(error).toContainText("The model provider returned an error.", { timeout: 30_000 });

  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect.poll(() => isPresented(error)).toBe(true);
  await expect.poll(() => seenRunErrorCount(page)).toBe(recordedErrorCount + 1);
  await captureScreenshot(page, testInfo, "covered-run-error-presented-after-drawer-close");

  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(error).toBeHidden();

  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.locator("main")).toHaveJSProperty("inert", true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator("main")).not.toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("main")).toHaveJSProperty("inert", false);
  await page.getByPlaceholder(/^Message /).fill("fail this run");
  const modalSendButton = await page.getByRole("button", { name: "Send" }).elementHandle();
  if (!modalSendButton) throw new Error("Send button not found");
  await openNewSpace(page);
  const newSpaceDialog = page.getByRole("dialog", { name: "New space" });
  await expect(newSpaceDialog).toBeVisible();
  await modalSendButton.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(error).toContainText("The model provider returned an error.", { timeout: 30_000 });
  expect(await isPresented(error)).toBe(false);
  await expect.poll(() => seenRunErrorCount(page)).toBe(recordedErrorCount + 1);

  await newSpaceDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(newSpaceDialog).toHaveCount(0);
  await expect.poll(() => isPresented(error)).toBe(true);
  await expect.poll(() => seenRunErrorCount(page)).toBe(recordedErrorCount + 2);
  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(error).toBeHidden();
});

for (const width of [1280, 390]) {
  test(`policy recovery opens Models and retains the refused draft at ${width}px`, async ({
    page,
  }, testInfo) => {
    await signup(
      page,
      `model-policy-${width}-${Date.now()}@rakazo.test`,
      "password12",
      "Model Policy",
    );
    await completeOnboarding(page);
    await page.setViewportSize({ width, height: 844 });
    let sends = 0;
    // A controlled transport refusal exercises recovery; backend grants are tested separately.
    await page.route("**/rpc/threads/send", async (route) => {
      sends += 1;
      await route.fulfill({
        status: 403,
        json: {
          json: {
            defined: false,
            code: "FORBIDDEN",
            status: 403,
            message: "platform_model_forbidden",
          },
        },
      });
    });
    const composer = page.getByRole("combobox", { name: /^Message / });
    await composer.fill("Keep my rejected message");
    await page.locator('input[type="file"]').setInputFiles({
      name: "policy-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Retain this attachment"),
    });
    const attachment = page.getByRole("button", { name: /^Remove policy-note\.txt/ });
    await expect(attachment).toBeVisible();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const error = page.getByTestId("composer-error");
    await expect(error).toContainText("Add your own API key to continue.");
    await expect(composer).toHaveValue("Keep my rejected message");
    await expect(attachment).toBeVisible();
    expect(sends).toBe(1);
    await captureScreenshot(page, testInfo, `model-policy-recovery-${width}`);
    await error.getByRole("button", { name: "Add API key", exact: true }).click();
    const settings = page.getByTestId("user-settings");
    await expect(settings).toHaveAttribute("data-settings-section", "models");
    expect(sends).toBe(1);
    await captureScreenshot(page, testInfo, `model-policy-settings-${width}`);
    await settings.getByRole("button", { name: "Close model settings", exact: true }).click();
    await expect(settings).toBeHidden();
    await expect(composer).toHaveValue("Keep my rejected message");
    await expect(attachment).toBeVisible();
    expect(sends).toBe(1);
  });
}
