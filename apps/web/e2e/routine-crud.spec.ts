import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, Routine } from "@rakazo/contracts";
import { formatRoutineTime, ONCE_ROUTINE_CRON } from "@rakazo/core";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function addScheduleTrigger(page: Page, freq: string) {
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: freq, exact: true }).click();
}

async function saveAndReturn(page: Page, procedure: "routines/create" | "routines/update") {
  const saved = page.waitForResponse(
    (response) => response.url().includes(`/rpc/${procedure}`) && response.ok(),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const response = await saved;
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
  return response.request().postDataJSON().json;
}

test("routine active switch keeps its thumb inside the track", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-toggle-${stamp}@rakazo.test`, "password12", "Routine Toggle");
  await completeOnboarding(page);
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();

  const toggle = page.getByRole("switch", { name: "Active" });
  const thumb = toggle.locator("span");
  async function expectThumbInsets(left: number, right: number) {
    await thumb.evaluate((element) =>
      Promise.all(element.getAnimations().map(({ finished }) => finished)),
    );
    const [trackBox, thumbBox] = await Promise.all([toggle.boundingBox(), thumb.boundingBox()]);
    expect(trackBox).not.toBeNull();
    expect(thumbBox).not.toBeNull();
    expect(thumbBox!.x - trackBox!.x).toBeCloseTo(left, 1);
    expect(trackBox!.x + trackBox!.width - thumbBox!.x - thumbBox!.width).toBeCloseTo(right, 1);
  }

  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expectThumbInsets(20, 2);
  await captureScreenshot(page, testInfo, "routine-toggle-desktop-active");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expectThumbInsets(2, 20);
  await captureScreenshot(page, testInfo, "routine-toggle-desktop-inactive");

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(await toggle.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    "none",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expectThumbInsets(20, 2);
  await captureScreenshot(page, testInfo, "routine-toggle-mobile-active");
  await toggle.click();
  await expectThumbInsets(2, 20);
  await captureScreenshot(page, testInfo, "routine-toggle-mobile-inactive");
});

test("routine editing updates in place, preserves timezone, and deletion persists", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-crud-${stamp}@rakazo.test`, "password12", "Routine CRUD");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  const created = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Tokyo check-in",
    prompt: "Send the original update",
    crons: ["0 9 * * *"],
    timezone: "Asia/Tokyo",
    active: true,
    notify: true,
  });
  expect(created.nextRunAt).not.toBeNull();
  expect(localSchedule(created.nextRunAt!, created.timezone)).toMatchObject({ hour: 9, minute: 0 });
  await page.reload();
  await page.getByTitle("Agent computer").click();

  await page.getByRole("button", { name: /Tokyo check-in/ }).click();
  await page.locator("label:has-text('Name') input").fill("Weekday check-in");
  await page.locator("label:has-text('Instruction') textarea").fill("Send the revised update");
  await page.getByLabel("How often").selectOption("Weekdays");
  const patch = await saveAndReturn(page, "routines/update");
  for (const column of ["modelProvider", "modelId", "thinkingLevel"])
    expect(patch).not.toHaveProperty(column);

  const updatedButton = page.getByRole("button", { name: /Weekday check-in/ });
  await expect(updatedButton).toHaveCount(1);
  await expect(updatedButton).toContainText("Weekdays at 9:00 AM");
  await expect(page.getByRole("button", { name: /Tokyo check-in/ })).toHaveCount(0);

  const [updated] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(updated).toMatchObject({
    name: "Weekday check-in",
    prompt: "Send the revised update",
    crons: ["0 9 * * 1-5"],
    timezone: "Asia/Tokyo",
  });
  expect(updated?.nextRunAt).not.toBeNull();
  expect(["Mon", "Tue", "Wed", "Thu", "Fri"]).toContain(
    localSchedule(updated!.nextRunAt!, updated!.timezone).weekday,
  );
  await captureScreenshot(page, testInfo, "routine-weekday-schedule");

  await updatedButton.click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Weekday check-in?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("label:has-text('Name') input")).toHaveValue("Weekday check-in");

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const removeResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/remove") && response.ok(),
  );
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await removeResponse;
  await expect(updatedButton).toHaveCount(0);
  expect(await rpc<Routine[]>(page, "routines/list", { botId })).toEqual([]);

  await page.reload();
  await page.getByTitle("Agent computer").click();
  await expect(updatedButton).toHaveCount(0);
});

test("a repeat can start on a saved future date and keep it through pause and resume", async ({
  page,
}, testInfo) => {
  await signup(page, `first-run-${Date.now()}@example.test`, "password12", "Schedule Fixture");
  await completeOnboarding(page);
  await rpc(page, "preferences/update", { timezone: "Asia/Tokyo" });
  await page.reload();
  const botId = activeBotId(page);
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.getByLabel("Name").fill("Delayed review");
  await page.getByLabel("Instruction").fill("Summarize the project status");
  await addScheduleTrigger(page, "Every day");
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const first = `${day}T09:00`;
  await page.getByLabel("First run").fill(first);
  await saveAndReturn(page, "routines/create");
  const [created] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(created).toMatchObject({
    name: "Delayed review",
    timezone: "Asia/Tokyo",
    nextRunAt: `${day}T00:00:00.000Z`,
  });
  const item = page.getByRole("button", { name: /Delayed review/ });
  await item.click();
  await expect(page.getByLabel("First run")).toHaveValue(first);
  await expect(page.getByText(/Next run: .*GMT\+9/)).toBeVisible();
  const externalDay = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const nextDay = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
  await rpc(page, "routines/update", {
    routineId: created!.id,
    prompt: "Use the latest project status",
    startAt: `${externalDay}T09:00`,
  });
  const nextRun = formatRoutineTime(`${externalDay}T00:00:00Z`, "Asia/Tokyo", "en-US");
  await expect(page.getByText(`Next run: ${nextRun}`, { exact: true })).toBeVisible();
  await expect(page.getByLabel("Instruction")).toHaveValue("Summarize the project status");
  await page.getByLabel("First run").fill(`${nextDay}T09:00`);
  let releaseSave!: () => void;
  let requestReceived!: () => void;
  const saveReleased = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    requestReceived = resolve;
  });
  await page.route(
    "**/rpc/routines/update",
    async (route) => {
      requestReceived();
      await saveReleased;
      await route.continue();
    },
    { times: 1 },
  );
  const saving = saveAndReturn(page, "routines/update");
  try {
    await requestStarted;
    await expect(page.getByLabel("First run")).toBeDisabled();
    await expect(page.getByLabel("How often")).toBeDisabled();
    await expect(page.getByLabel("Instruction")).toBeDisabled();
    await expect(page.getByRole("switch", { name: "Active" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add trigger" })).toBeDisabled();
  } finally {
    releaseSave();
  }
  const timePatch = await saving;
  expect(timePatch).not.toHaveProperty("prompt");
  const [retimed] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(retimed).toMatchObject({
    id: created!.id,
    prompt: "Use the latest project status",
    nextRunAt: `${nextDay}T00:00:00.000Z`,
  });
  await item.click();
  await expect(page.getByLabel("First run")).toHaveValue(`${nextDay}T09:00`);
  await captureScreenshot(page, testInfo, "routine-first-run");

  await page.getByRole("switch", { name: "Active" }).click();
  await saveAndReturn(page, "routines/update");
  expect((await rpc<Routine[]>(page, "routines/list", { botId }))[0]).toMatchObject({
    id: created!.id,
    active: false,
    nextRunAt: null,
    startAt: retimed!.nextRunAt,
  });
  await item.click();
  await page.getByRole("switch", { name: "Active" }).click();
  await saveAndReturn(page, "routines/update");
  const [resumed] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(resumed).toMatchObject({ id: created!.id, active: true, nextRunAt: retimed!.nextRunAt });
});

test("an open editor keeps the first-run instant through an external timezone change", async ({
  page,
}) => {
  await signup(
    page,
    `routine-timezone-${Date.now()}@example.test`,
    "password12",
    "Schedule Fixture",
  );
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const initialDay = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const chosenDay = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const routine = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Timezone check",
    prompt: "Check the project",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: true,
    startAt: `${initialDay}T09:00`,
  });
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: /Timezone check/ }).click();
  const firstRun = page.getByLabel("First run");
  await rpc(page, "routines/update", { routineId: routine.id, timezone: "America/Phoenix" });
  await expect(page.getByText("America/Phoenix", { exact: true })).toBeVisible();
  await expect(firstRun).toHaveValue(`${initialDay}T09:00`);
  await firstRun.fill(`${chosenDay}T09:00`);
  await rpc(page, "routines/update", { routineId: routine.id, timezone: "UTC" });
  await expect(page.getByText("UTC", { exact: true })).toBeVisible();
  await expect(firstRun).toHaveValue(`${chosenDay}T16:00`);
  const patch = await saveAndReturn(page, "routines/update");
  const startAt = `${chosenDay}T16:00:00.000Z`;
  expect(patch).toMatchObject({ startAt });
  expect(patch).not.toHaveProperty("timezone");
  expect((await rpc<Routine[]>(page, "routines/list", { botId }))[0]).toMatchObject({
    id: routine.id,
    startAt,
    timezone: "UTC",
  });
});

test("an open editor preserves external one-shot arm and pause when saving a name", async ({
  page,
}) => {
  await signup(page, `one-shot-${Date.now()}@example.test`, "password12", "Schedule Fixture");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const created = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "One-shot check",
    prompt: "Check the project",
    crons: [ONCE_ROUTINE_CRON],
    timezone: "UTC",
    active: false,
    notify: true,
  });
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: /One-shot check/ }).click();
  await expect(page.getByLabel("Run at")).toBeVisible();
  await page.getByLabel("Name").fill("Renamed one-shot check");
  const runAt = new Date(Date.now() + 86_400_000).toISOString();
  await rpc(page, "routines/update", { routineId: created.id, active: true, runAt });
  await expect(page.getByLabel("Run at")).toHaveCount(0);
  const patch = await saveAndReturn(page, "routines/update");
  expect(patch).not.toHaveProperty("runAt");
  expect(patch).not.toHaveProperty("active");
  expect((await rpc<Routine[]>(page, "routines/list", { botId }))[0]).toMatchObject({
    id: created.id,
    name: "Renamed one-shot check",
    active: true,
    nextRunAt: runAt,
  });

  await page.getByRole("button", { name: /Renamed one-shot check/ }).click();
  await expect(page.getByLabel("Run at")).toHaveCount(0);
  await page.getByLabel("Name").fill("Paused one-shot check");
  await rpc(page, "routines/update", { routineId: created.id, active: false });
  await expect(page.getByRole("switch", { name: "Active" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  const rename = await saveAndReturn(page, "routines/update");
  expect(rename).not.toHaveProperty("runAt");
  expect(rename).not.toHaveProperty("active");
  expect((await rpc<Routine[]>(page, "routines/list", { botId }))[0]).toMatchObject({
    id: created.id,
    name: "Paused one-shot check",
    active: false,
    nextRunAt: null,
  });

  await page.getByRole("button", { name: /Paused one-shot check/ }).click();
  await page.getByRole("switch", { name: "Active" }).click();
  const resumed = await saveAndReturn(page, "routines/update");
  expect(resumed).toMatchObject({ active: true, runAt: expect.any(String) });
});

test("keeps the distinction between a literal cron and an interval with the same expression", async ({
  page,
}) => {
  await signup(page, `cadence-fixture-${Date.now()}@example.test`, "password12", "Cadence Fixture");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const routine = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Calendar check",
    prompt: "Summarize the report",
    crons: ["*/7 * * * *"],
    timezone: "UTC",
    active: false,
  });
  await page.reload();
  await page.getByTitle("Agent computer").click();
  const item = page.getByRole("button", { name: /Calendar check/ });
  await item.click();
  const cadence = page.getByLabel("How often");
  await expect(cadence).toHaveValue("Advanced");
  await cadence.selectOption("Interval");
  expect(await saveAndReturn(page, "routines/update")).toMatchObject({ intervalBased: true });
  const [interval] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(interval).toMatchObject({ id: routine.id, intervalBased: true, crons: routine.crons });
  await item.click();
  await expect(cadence).toHaveValue("Interval");
  await cadence.selectOption("Advanced");
  expect(await saveAndReturn(page, "routines/update")).toMatchObject({ intervalBased: false });
  expect((await rpc<Routine[]>(page, "routines/list", { botId }))[0]).toMatchObject({
    id: routine.id,
    intervalBased: false,
    crons: routine.crons,
  });
});

test("routine editing inherits the bot model through unrelated edits", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `routine-default-model-${Date.now()}@rakazo.test`,
    "password12",
    "Routine Model",
  );
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Model check");
  await page.locator("label:has-text('Instruction') textarea").fill("Check the inbox");
  await addScheduleTrigger(page, "Every day");
  await expect(page.getByRole("button", { name: "Advanced", exact: true })).toHaveCount(0);
  const model = page.locator('select[aria-label="Routine model"]');
  await expect(model).toHaveCount(1);
  await expect(model).toBeHidden();
  await expect(model).toHaveValue("");
  const createdInput = await saveAndReturn(page, "routines/create");
  expect(createdInput).toMatchObject({
    modelProvider: null,
    modelId: null,
    modelCredentialId: null,
    thinkingLevel: null,
  });
  expect(createdInput).not.toHaveProperty("expectedRevision");
  const [routine] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routine).toMatchObject({
    name: "Model check",
    modelProvider: null,
    modelId: null,
    modelCredentialId: null,
    thinkingLevel: null,
  });
  await page.getByRole("button", { name: /Model check/ }).click();
  await page.locator("label:has-text('Name') input").fill("Renamed model check");
  const patch = await saveAndReturn(page, "routines/update");
  for (const column of ["modelProvider", "modelId", "modelCredentialId", "thinkingLevel"])
    expect(patch).not.toHaveProperty(column);
  await expect(page.getByRole("button", { name: /Renamed model check/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "routine-default-model");
});

test("invalid advanced cron is rejected without creating a routine", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-invalid-${stamp}@rakazo.test`, "password12", "Invalid Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Broken schedule");
  await page.locator("label:has-text('Instruction') textarea").fill("This should never run");
  await addScheduleTrigger(page, "Advanced...");
  await page.getByLabel("Cron expression").fill("61 25 * * *");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("Enter a valid cron expression.");
  expect(await rpc<Routine[]>(page, "routines/list", { botId })).toEqual([]);
  await captureScreenshot(page, testInfo, "invalid-cron-rejected");
});

test("a successful routine create is not reported as failed when refresh fails", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `routine-refresh-${stamp}@rakazo.test`, "password12", "Routine Refresh");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Persisted routine");
  await page.locator("label:has-text('Instruction') textarea").fill("Run once each morning");
  await addScheduleTrigger(page, "Every day");

  await page.route(
    "**/rpc/routines/list",
    (route) => route.fulfill({ status: 500, body: "refresh failed" }),
    { times: 1 },
  );
  const createResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  const failedRefresh = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/list") && response.status() === 500,
  );

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await createResponse;
  await failedRefresh;
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "routine");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.unroute("**/rpc/routines/list");
  const routines = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routines).toHaveLength(1);
  expect(routines[0]?.name).toBe("Persisted routine");
});

test("switching bots while a routine save is pending does not reopen stale state", async ({
  page,
}) => {
  const stamp = Date.now();
  await signup(page, `routine-switch-${stamp}@rakazo.test`, "password12", "Routine Switch");
  await completeOnboarding(page);
  const firstBotId = activeBotId(page);
  const secondBot = await rpc<Bot>(page, "bots/create", {
    name: "Second",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await Promise.all([
    rpc<Routine>(page, "routines/create", {
      botId: firstBotId,
      name: "First routine",
      prompt: "First prompt",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
      notify: true,
    }),
    rpc<Routine>(page, "routines/create", {
      botId: secondBot.id,
      name: "Second routine",
      prompt: "Second prompt",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
      notify: true,
    }),
  ]);
  await page.reload();

  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: /First routine/ }).click();
  await page.locator("label:has-text('Name') input").fill("First routine updated");

  let releaseUpdate!: () => void;
  let sawUpdate!: () => void;
  const updateReleased = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const updateIntercepted = new Promise<void>((resolve) => {
    sawUpdate = resolve;
  });
  await page.route(
    "**/rpc/routines/update",
    async (route) => {
      sawUpdate();
      await updateReleased;
      await route.fulfill({ status: 500, body: "save failed" });
    },
    { times: 1 },
  );
  const updateResponse = page.waitForResponse((response) =>
    response.url().includes("/rpc/routines/update"),
  );

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await updateIntercepted;
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Second/ })
    .click();
  await page.waitForURL(new RegExp(`/app/${secondBot.id}$`));
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");

  releaseUpdate();
  await updateResponse;
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.getByTitle("Agent computer").click();
  await expect(page.getByRole("button", { name: /Second routine/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /First routine/ })).toHaveCount(0);

  let releaseStaleList!: () => void;
  let sawStaleList!: () => void;
  const staleListReleased = new Promise<void>((resolve) => {
    releaseStaleList = resolve;
  });
  const staleListIntercepted = new Promise<void>((resolve) => {
    sawStaleList = resolve;
  });
  await page.route("**/rpc/routines/list", async (route) => {
    if (route.request().postData()?.includes(firstBotId) !== true) {
      await route.continue();
      return;
    }
    sawStaleList();
    await staleListReleased;
    await route.continue();
  });
  const staleListResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/routines/list") &&
      response.request().postData()?.includes(firstBotId) === true,
  );

  const botList = page.locator("aside").first();
  await botList.getByRole("button", { name: /^Chief/ }).click();
  await staleListIntercepted;
  await botList.getByRole("button", { name: /^Second/ }).click();
  await page.waitForURL(new RegExp(`/app/${secondBot.id}$`));
  releaseStaleList();
  await staleListResponse;
  await page.unroute("**/rpc/routines/list");

  await expect(page.getByRole("button", { name: /Second routine/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /First routine/ })).toHaveCount(0);
});

function localSchedule(iso: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: value("weekday"),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
  };
}

test("a late save receipt does not replace another routine opened from search", async ({
  page,
}) => {
  await signup(
    page,
    `routine-receipt-${Date.now()}@example.test`,
    "password12",
    "Schedule Fixture",
  );
  await completeOnboarding(page);
  const botId = activeBotId(page);
  for (const name of ["Pending review", "Separate routine"]) {
    await rpc(page, "routines/create", {
      botId,
      name,
      prompt: "Check the project",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
      notify: true,
    });
  }
  await page.reload();
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: /Pending review/ }).click();
  await page.getByLabel("Name").fill("Saved pending review");

  let releaseSave!: () => void;
  let requestReceived!: () => void;
  const saveReleased = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    requestReceived = resolve;
  });
  await page.route(
    "**/rpc/routines/update",
    async (route) => {
      requestReceived();
      await saveReleased;
      await route.continue();
    },
    { times: 1 },
  );
  const response = page.waitForResponse(
    (res) => res.url().includes("/rpc/routines/update") && res.ok(),
  );
  try {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await requestStarted;
    const sidebar = page.locator("aside").first();
    await sidebar.getByPlaceholder("Search", { exact: true }).fill("Separate routine");
    await sidebar.getByRole("button", { name: /Separate routine/ }).click();
    await expect(page.getByLabel("Name")).toHaveValue("Separate routine");
  } finally {
    releaseSave();
  }
  await response;
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Name")).toHaveValue("Separate routine");
  expect(
    (await rpc<Routine[]>(page, "routines/list", { botId })).map(({ name }) => name),
  ).toContain("Saved pending review");
});

test("interval schedule only offers amounts the unit can run", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-interval-${stamp}@rakazo.test`, "password12", "Interval Routine");
  await completeOnboarding(page);

  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine" }).click();
  await addScheduleTrigger(page, "Interval");

  const amount = page.getByRole("combobox", { name: "Interval amount" });
  const unit = page.getByRole("combobox", { name: "Interval unit" });
  await amount.selectOption("45");
  await unit.selectOption("hours");
  await expect(amount).toHaveValue("15");
  await expect(amount.locator("option[value='45']")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "routine-interval-hours");

  await unit.selectOption("days");
  await expect(amount.locator("option[value='30']")).toHaveCount(1);
  await expect(amount.locator("option[value='45']")).toHaveCount(0);
});
