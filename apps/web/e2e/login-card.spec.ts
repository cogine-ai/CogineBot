import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

for (const remember of [true, false]) {
  test(`provides a website login without echoing either value (save: ${remember})`, async ({
    page,
  }, testInfo) => {
    const stamp = Date.now();
    await signup(page, `login-card-${stamp}@example.test`, "password12", "Login Card");
    await completeOnboarding(page);

    const botId = activeBotId(page);
    await page.getByPlaceholder(/Message/).fill("show a login card");
    await page.keyboard.press("Enter");

    await expect
      .poll(
        async () => {
          const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
            botId,
          });
          return snapshot.run?.status ?? null;
        },
        { timeout: 60_000 },
      )
      .toBe("waiting_input");

    // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
    const card = page.getByTestId("secret-ask-card");
    if ((await card.count()) === 0) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
    }
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText("https://login.example.test", { exact: true })).toBeVisible();
    const usernameField = card.getByLabel("Username", { exact: true });
    const passwordField = card.getByLabel("Password", { exact: true });
    await expect(passwordField).toHaveAttribute("type", "password");
    const save = card.getByRole("button", { name: "Provide information", exact: true });
    const rememberSwitch = card.getByRole("switch", { name: "Save for this Bot", exact: true });
    await expect(rememberSwitch).toBeChecked();
    if (!remember) {
      await rememberSwitch.click();
      await expect(rememberSwitch).not.toBeChecked();
      await expect(card.getByText("For this task only", { exact: true })).toBeVisible();
      await card.getByRole("switch", { name: "Hide Username", exact: true }).click();
      await expect(usernameField).toHaveAttribute("type", "password");
    }
    await captureScreenshot(page, testInfo, remember ? "login-card" : "login-card-task-only");

    if (remember) {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(usernameField).toBeVisible();
      await expect(passwordField).toBeVisible();
      const close = card.getByRole("button", { name: "Close", exact: true });
      const [cardBox, closeBox] = await Promise.all([card.boundingBox(), close.boundingBox()]);
      expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
      await captureScreenshot(page, testInfo, "login-card-narrow");
      await page.setViewportSize({ width: 1280, height: 720 });
    }

    const username = `fake-user-${stamp}@example.test`;
    const password = `fake-password-${stamp}`;
    if (remember) {
      const escaped = '"'.repeat(4096);
      await usernameField.fill(escaped);
      await passwordField.fill(escaped);
      await expect(save).toBeDisabled();
      await expect(
        card.getByText("These login values are too long together. Shorten one or more fields."),
      ).toBeVisible();
      await usernameField.clear();
    }
    // Both fields are required before the login can be saved.
    await passwordField.fill(password);
    await expect(save).toBeDisabled();
    await usernameField.fill(username);
    await expect(save).toBeEnabled();

    // Saving clears both fields immediately, including when the save fails.
    await page.route("**/rpc/threads/answer", (route) =>
      route.fulfill({
        status: 400,
        json: { json: { defined: false, code: "BAD_REQUEST", status: 400, message: "fail" } },
      }),
    );
    await save.click();
    await expect(card.getByText("Could not submit this answer", { exact: true })).toBeVisible();
    await expect(passwordField).toHaveValue("");
    await expect(usernameField).toHaveValue("");
    await page.unroute("**/rpc/threads/answer");

    await usernameField.fill(username);
    await expect(card.getByText("Could not submit this answer", { exact: true })).toHaveCount(0);
    await passwordField.fill(password);
    let receiptChecked = false;
    if (!remember) {
      await page.route("**/rpc/threads/messages", async (route) => {
        const target = route.request().postDataJSON()?.json?.around;
        if (target?.messageId) receiptChecked = true;
        await route.continue();
      });
      await page.route(
        "**/rpc/threads/answer",
        async (route) => {
          const committed = await route.fetch();
          expect(committed.ok()).toBe(true);
          await route.abort();
        },
        { times: 1 },
      );
    }
    await save.click();
    await expect(card.getByText("Information provided", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(card.locator("input")).toHaveCount(0);
    if (!remember) await expect.poll(() => receiptChecked).toBe(true);

    await expect
      .poll(
        async () => {
          const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
            botId,
          });
          return snapshot.run?.status ?? "completed";
        },
        { timeout: 30_000 },
      )
      .toBe("completed");
    const history = JSON.stringify(await rpc(page, "threads/messages", { botId }));
    expect(history).not.toContain(username);
    expect(history).not.toContain(password);
    const listed = await rpc<{ name: string }[]>(page, "botSecrets/list", { botId });
    expect(listed.some((entry) => entry.name === "example_login")).toBe(remember);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(card.getByText("Information provided", { exact: true })).toBeVisible();
    await expect(page.getByText(username)).toHaveCount(0);
    await captureScreenshot(
      page,
      testInfo,
      remember ? "login-card-provided" : "login-card-task-provided",
    );
  });
}
