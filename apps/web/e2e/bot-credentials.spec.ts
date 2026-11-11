import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

// Fake values only: this spec proves the UI and API never echo a saved credential.
const SENTINEL = "fake-bot-credential-values-never-leak";
const REPLACEMENT = "fake-bot-credential-value-two";
const CREDENTIAL_NAME = "example_api";

test("bot credentials list, add, replace and remove without leaking values", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-credentials-${stamp}@rakazo.test`, "password12", "Bot Credentials");
  await completeOnboarding(page);
  const botName = `Credentials ${stamp}`;
  const botId = await createNamedBot(page, botName);

  await page.locator("main").getByRole("button", { name: botName, exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  // The Advanced <details> mounts the Credentials section on first open, not on render.
  await settings.getByTestId("bot-settings-advanced").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  const credentials = settings.getByTestId("bot-credentials");
  await expect(credentials).toBeVisible();
  await expect(credentials.getByTestId("bot-credentials-empty")).toBeVisible();

  // Add: a password field holds the value, which is cleared once the save starts.
  await credentials.getByTestId("credential-add").click();
  const addForm = credentials.getByTestId("credential-add-form");
  await addForm.getByTestId("credential-name").fill(CREDENTIAL_NAME);
  await addForm.getByTestId("credential-origin").fill("https://api.example.test");
  const valueInput = addForm.getByTestId("credential-value");
  await expect(valueInput).toHaveAttribute("type", "password");
  await expect(valueInput).toHaveAttribute("autocomplete", "new-password");
  await valueInput.fill(SENTINEL);
  await captureScreenshot(page, testInfo, "bot-credentials-add");
  await addForm.getByTestId("credential-add-save").click();

  const row = credentials.getByTestId("bot-credential-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(CREDENTIAL_NAME);
  await expect(row).toContainText("https://api.example.test");
  await expect(row).toContainText("Bearer token");
  await expect(addForm).toHaveCount(0);

  // The API returns metadata only, and no input still holds the value.
  const listed = await rpc<Array<Record<string, unknown>>>(page, "botSecrets/list", { botId });
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    name: CREDENTIAL_NAME,
    origin: "https://api.example.test",
    auth: { type: "bearer" },
  });
  expect(JSON.stringify(listed)).not.toContain(SENTINEL);
  expect(JSON.stringify(listed)).not.toContain("ciphertext");
  await expectNoLeakedInputValue(page, SENTINEL);

  // Replace: keeps the destination, writes a new value, leaves the old one gone.
  const replaced = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSecrets/putForEdit") && response.ok(),
  );
  await credentials.getByTestId(`credential-replace-${CREDENTIAL_NAME}`).click();
  await credentials.getByTestId("credential-replace-value").fill(REPLACEMENT);
  await credentials.getByTestId("credential-replace-save").click();
  await replaced;
  await expect(row).toHaveCount(1);
  await expect(credentials.getByTestId("credential-replace-value")).toHaveCount(0);
  await expectNoLeakedInputValue(page, SENTINEL);
  await expectNoLeakedInputValue(page, REPLACEMENT);
  await captureScreenshot(page, testInfo, "bot-credentials-replace");

  // Remove: needs an explicit confirm, then the empty state returns.
  await credentials.getByTestId(`credential-remove-${CREDENTIAL_NAME}`).click();
  await expect(credentials).toContainText(`Remove ${CREDENTIAL_NAME}?`);
  const removed = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSecrets/removeForEdit") && response.ok(),
  );
  await credentials.getByTestId(`credential-remove-confirm-${CREDENTIAL_NAME}`).click();
  await removed;
  await expect(row).toHaveCount(0);
  await expect(credentials.getByTestId("bot-credentials-empty")).toBeVisible();
  expect(await rpc<unknown[]>(page, "botSecrets/list", { botId })).toHaveLength(0);
  await captureScreenshot(page, testInfo, "bot-credentials-removed");
});

test("a named login can be removed but cannot be edited by the legacy form", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(
    page,
    `login-compatibility-${stamp}@example.test`,
    "password12",
    "Credential fixture",
  );
  await completeOnboarding(page);
  const botName = `Login compatibility ${stamp}`;
  const botId = await createNamedBot(page, botName);
  const name = "example_login";
  const saved = await rpc<{ revision: string }>(page, "botSecrets/putForEdit", {
    botId,
    destination: { name, origin: "https://login.example.test", auth: { type: "login" } },
    value: JSON.stringify({
      fields: [
        { label: "Account ID", value: "fixture-account", hidden: false },
        { label: "Access phrase", value: SENTINEL, hidden: true },
      ],
    }),
    expectedRevision: null,
  });
  await page.locator("main").getByRole("button", { name: botName, exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByTestId("bot-settings-advanced").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  const credentials = settings.getByTestId("bot-credentials");
  await expect(credentials).toContainText("This form can't edit named fields.");
  await expect(credentials.getByTestId(`credential-replace-${name}`)).toHaveCount(0);
  await expect(credentials.getByTestId(`credential-remove-${name}`)).toBeVisible();
  await expectNoLeakedInputValue(page, SENTINEL);
  expect(await rpc(page, "botSecrets/listForEdit", { botId })).toEqual([
    expect.objectContaining({ name, revision: saved.revision, namedLogin: true }),
  ]);
  const row = credentials.getByTestId("bot-credential-row");
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeInViewport({ ratio: 1 });
  await captureScreenshot(page, testInfo, "bot-credentials-named-login-protected");
  await credentials.getByTestId(`credential-remove-${name}`).click();
  await credentials.getByTestId(`credential-remove-confirm-${name}`).click();
  await expect(credentials.getByTestId("bot-credentials-empty")).toBeVisible();
});

/** Fail if any live input value still carries a protected value. */
async function expectNoLeakedInputValue(page: Page, value: string) {
  const leaked = await page.evaluate((needle) => {
    const inputs = Array.from(document.querySelectorAll("input, textarea"));
    return inputs.some((input) => {
      const field = input as HTMLInputElement | HTMLTextAreaElement;
      return field.value.includes(needle);
    });
  }, value);
  expect(leaked).toBe(false);
}

test("Space credentials preserve Bot identity and reveal only after confirmation", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const password = "password12";
  await signup(page, `space-credentials-${stamp}@example.test`, password, "Credential fixture");
  await completeOnboarding(page);
  const firstName = `First Bot ${stamp}`;
  const secondName = `Second Bot ${stamp}`;
  const first = await createNamedBot(page, firstName);
  const second = await createNamedBot(page, secondName);
  const name = "portal";
  const destination = { name, origin: "https://login.example.test", auth: { type: "login" } };
  for (const [botId, value] of [
    [first, SENTINEL],
    [second, REPLACEMENT],
  ] as const) {
    await rpc(page, "botSecrets/putForEdit", {
      botId,
      destination,
      expectedRevision: null,
      value: JSON.stringify({
        fields: [
          { label: "Account ID", value: "fixture-account", hidden: false },
          { label: "Access phrase", value, hidden: true },
        ],
      }),
    });
  }

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("settings-nav-credentials").click();
  const panel = settings.getByTestId("space-credentials");
  const rows = panel.getByTestId("bot-credential-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: firstName })).toContainText(destination.origin);
  await expect(rows.filter({ hasText: secondName })).toContainText(destination.origin);
  await expect(panel).not.toContainText(SENTINEL);
  await expect(panel).not.toContainText(REPLACEMENT);
  await captureScreenshot(page, testInfo, "space-credentials-list");
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows).toHaveCount(2);
  await captureScreenshot(page, testInfo, "space-credentials-narrow");
  await page.setViewportSize(viewport);

  const firstRow = rows.filter({ hasText: firstName });
  const secondRow = rows.filter({ hasText: secondName });
  await firstRow.getByRole("button", { name: "Show value" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(confirm.getByLabel("Password")).toBeVisible();
  await captureScreenshot(page, testInfo, "space-credentials-confirm");
  await confirm.getByLabel("Password").fill("incorrect-fixture-password");
  await confirm.getByRole("button", { name: "Continue" }).click();
  await expect(confirm.getByRole("alert")).toBeVisible();
  await expect(confirm.getByLabel("Password")).toHaveValue("");
  await expect(page.getByText(SENTINEL, { exact: true })).toHaveCount(0);
  const successfulReveal = page.waitForResponse(
    (response) => response.url().endsWith("/rpc/botSecrets/reveal") && response.ok(),
  );
  await confirm.getByLabel("Password").fill(password);
  await confirm.getByRole("button", { name: "Continue" }).click();
  expect((await successfulReveal).headers()["cache-control"]).toBe("no-store");
  const shown = page.getByRole("dialog", { name: destination.origin });
  await expect(shown).toContainText(SENTINEL);
  await expect(shown).not.toContainText(REPLACEMENT);
  await shown.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(SENTINEL, { exact: true })).toHaveCount(0);

  await secondRow.getByRole("button", { name: "Replace value" }).click();
  await expect(secondRow.getByLabel("Access phrase", { exact: true })).toHaveValue("");
  await expect(secondRow.getByLabel("Access phrase", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await secondRow.getByLabel("Account ID", { exact: true }).fill("updated-fixture-account");
  await secondRow.getByLabel("Access phrase", { exact: true }).fill("new-synthetic-access-phrase");
  await secondRow.getByRole("button", { name: "Save new value" }).click();
  await expect(secondRow.getByLabel("Access phrase", { exact: true })).toHaveCount(0);
  await secondRow.getByRole("button", { name: "Show value" }).click();
  await expect(shown).toContainText("new-synthetic-access-phrase");
  await expect(shown).not.toContainText(SENTINEL);
  await shown.getByRole("button", { name: "Done" }).click();

  await firstRow.getByRole("button", { name: "Remove", exact: true }).click();
  await firstRow.getByTestId("credential-remove-confirm-portal").click();
  await expect(firstRow).toHaveCount(0);
  await expect(secondRow).toBeVisible();
});
