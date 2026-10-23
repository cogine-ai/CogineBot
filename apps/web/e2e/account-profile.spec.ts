import { expect, test } from "@playwright/test";
import type { Bot, Me, Routine } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openNewBot,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test.use({ timezoneId: "Asia/Taipei" });

test("account timezone adopts once, survives reload and Space changes, and retains errors", async ({
  page,
}, testInfo) => {
  await signup(page, `account-timezone-${Date.now()}@example.test`, "password12", "Account clock");
  await completeOnboarding(page);
  await expect.poll(async () => (await rpc<Me>(page, "me", {})).timezone).toBe("Asia/Taipei");
  await openUserSettings(page);
  const timezone = page.getByTestId("timezone-select");
  await expect(timezone).toHaveValue("Asia/Taipei");
  await page.route("**/rpc/preferences/update", (route) => route.abort("failed"));
  await timezone.selectOption("UTC");
  await expect(page.getByRole("alert")).toContainText("Couldn't update your timezone");
  await expect(timezone).toHaveValue("Asia/Taipei");
  await page.unroute("**/rpc/preferences/update");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/preferences/update") && response.ok(),
  );
  await timezone.selectOption("UTC");
  expect((await saved).request().headers()).not.toHaveProperty("x-rakazo-space-id");
  await expect(timezone).toHaveValue("UTC");
  await timezone.scrollIntoViewIfNeeded();
  await expect(timezone).toBeVisible();
  await captureScreenshot(page, testInfo, "a5-account-timezone");
  await page.reload();
  await expect.poll(async () => (await rpc<Me>(page, "me", {})).timezone).toBe("UTC");
  await rpc(page, "spaces/create", { name: "Other clock Space" });
  await page.reload();
  await openUserSettings(page);
  await expect(timezone).toHaveValue("UTC");
  await timezone.selectOption("Asia/Taipei");
  await expect.poll(async () => (await rpc<Me>(page, "me", {})).timezone).toBe("Asia/Taipei");
});

test("bot description and raw rules save independently, with a visible stale-edit conflict", async ({
  page,
}, testInfo) => {
  await signup(page, `profile-rules-${Date.now()}@example.test`, "password12", "Profile editor");
  await completeOnboarding(page);
  await openNewBot(page);
  const form = page.getByTestId("create-bot-form");
  const original = "  # Private rules\n\nKeep every blank line.\n\n";
  await form.getByLabel("Name", { exact: true }).fill("Separate profile");
  await form.getByLabel("Description", { exact: true }).fill("Public division");
  await form.getByLabel("Instructions", { exact: true }).fill(original);
  await captureScreenshot(page, testInfo, "a5-create-independent-instructions");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByPlaceholder("Message Separate profile")).toBeVisible();
  const botId = activeBotId(page);
  expect(await rpc<Bot>(page, "bots/get", { botId })).toMatchObject({
    description: "Public division",
    instructions: original,
  });
  await page.locator("main").getByRole("button", { name: "Separate profile", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  const instructions = settings.getByRole("textbox", { name: "Instructions", exact: true });
  const description = settings.getByRole("textbox", { name: "Description", exact: true });
  await expect(instructions).toHaveValue(original);
  await description.fill("Updated public division");
  await description.press("Tab");
  await expect
    .poll(async () => (await rpc<Bot>(page, "bots/get", { botId })).description)
    .toBe("Updated public division");
  expect((await rpc<Bot>(page, "bots/get", { botId })).instructions).toBe(original);
  await rpc(page, "bots/update", {
    botId,
    instructions: "Collaborator rules",
    expectedInstructions: original,
  });
  const draft = "  My unsaved rules\n\n";
  await instructions.fill(draft);
  await instructions.press("Tab");
  await expect(
    settings.getByRole("button", { name: "Save other settings", exact: true }),
  ).toBeVisible();
  await expect(instructions).toHaveValue(draft);
  expect((await rpc<Bot>(page, "bots/get", { botId })).instructions).toBe("Collaborator rules");
  await captureScreenshot(page, testInfo, "a5-instructions-conflict");
  await description.fill("Safe other settings");
  await settings.getByRole("button", { name: "Save other settings", exact: true }).click();
  await expect
    .poll(async () => (await rpc<Bot>(page, "bots/get", { botId })).description)
    .toBe("Safe other settings");
  expect((await rpc<Bot>(page, "bots/get", { botId })).instructions).toBe("Collaborator rules");
  await page.reload();
  await page.locator("main").getByRole("button", { name: "Separate profile", exact: true }).click();
  await expect(instructions).toHaveValue("Collaborator rules");
  await instructions.fill("");
  await instructions.press("Tab");
  await expect
    .poll(async () => (await rpc<Bot>(page, "bots/get", { botId })).instructions)
    .toBe("");
  await page.reload();
  expect((await rpc<Bot>(page, "bots/get", { botId })).instructions).toBe("");
});

test("new routines use the account clock while saved routines retain their schedule", async ({
  page,
}, testInfo) => {
  await signup(page, `routine-account-${Date.now()}@example.test`, "password12", "Routine clock");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "preferences/update", { timezone: "Asia/Kolkata" });
  const routine = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Saved Tokyo schedule",
    prompt: "Keep this schedule",
    crons: ["0 9 * * *"],
    timezone: "Asia/Tokyo",
    active: true,
  });
  await page.reload();
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();
  await expect(page.getByText("Asia/Kolkata", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "a5-new-routine-account-clock");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: /Saved Tokyo schedule/ }).click();
  await expect(page.getByText("Asia/Tokyo", { exact: true })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Renamed Tokyo schedule");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/update") && response.ok(),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await saved;
  const updated = (await rpc<Routine[]>(page, "routines/list", { botId })).find(
    (item) => item.id === routine.id,
  );
  expect(updated).toMatchObject({
    timezone: routine.timezone,
    crons: routine.crons,
    nextRunAt: routine.nextRunAt,
  });
  await captureScreenshot(page, testInfo, "a5-existing-routine-clock");
});

test("oversized instructions stay intact and are rejected before profile writes", async ({
  page,
}, testInfo) => {
  await signup(page, `rules-limit-${Date.now()}@example.test`, "password12", "Rules limit");
  await completeOnboarding(page);
  await openNewBot(page);
  const form = page.getByTestId("create-bot-form");
  const rules = "R".repeat(20_001);
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Full rules draft");
  const createRules = form.getByRole("textbox", { name: "Instructions", exact: true });
  await createRules.fill(rules);
  await expect(createRules).toHaveValue(rules);
  let creates = 0;
  let updates = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/bots/create")) creates++;
    if (request.url().includes("/rpc/bots/update")) updates++;
  });
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    form.getByText("Instructions must be at most 20000 characters", { exact: true }),
  ).toBeVisible();
  await expect(createRules).toHaveValue(rules);
  expect(creates).toBe(0);
  await createRules.fill("Accepted rules");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByPlaceholder("Message Full rules draft")).toBeVisible();
  const botId = activeBotId(page);
  await page.locator("main").getByRole("button", { name: "Full rules draft", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  const editRules = settings.getByRole("textbox", { name: "Instructions", exact: true });
  await editRules.fill(rules);
  await editRules.press("Tab");
  await expect(
    settings.getByText("Instructions must be at most 20000 characters", { exact: true }),
  ).toBeVisible();
  await expect(editRules).toHaveValue(rules);
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  expect(updates).toBe(0);
  expect((await rpc<Bot>(page, "bots/get", { botId })).instructions).toBe("Accepted rules");
  await captureScreenshot(page, testInfo, "a5-instructions-limit-preserves-draft");
});
