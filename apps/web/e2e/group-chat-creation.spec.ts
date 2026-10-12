import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openNewGroup,
  rpc,
  signup,
} from "./helpers";

type GroupRow = {
  id: string;
  name: string;
  threadId: string;
  preview: string;
  members: Array<{ botId: string }>;
};
type CreatePayload = { name: string; botIds: string[]; clientNonce?: string };
type SendPayload = {
  botId?: string;
  groupId?: string;
  text?: string;
  clientNonce?: string;
  artifactIds?: string[];
};
type MessagePage = {
  messages: Array<{ role: string; blocks: Array<{ kind: string; text?: string }> }>;
};

const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const errors = browserErrors.get(page) ?? [];
  if (errors.length > 0) {
    await testInfo.attach("browser-errors", {
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(errors, null, 2)),
    });
  }
  expect.soft(errors, "recipient chats have no browser exceptions or console errors").toEqual([]);
});

async function openCompanions(page: Page, label: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signup(page, `${label}-${Date.now()}@rakazo.test`, "password12", "Companion Review");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const partner = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    notifyOnFinish: true,
  });
  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  return { chiefId, partnerId: partner.id };
}

async function selectRecipients(page: Page, botIds: string[]) {
  await openNewGroup(page);
  await expect(page).toHaveURL(/\?new-chat(?:[=&]|$)/);
  await expect(page.getByTestId("pending-group-chat")).toBeVisible();
  return replaceRecipients(page, botIds);
}

async function replaceRecipients(page: Page, botIds: string[]) {
  const recipients = page.getByTestId("chat-recipients");
  const selected = recipients.locator('[data-testid^="recipient-chip-"]');
  while ((await selected.count()) > 0) {
    const remove = selected.first().getByRole("button");
    await expect(remove).toBeEnabled();
    await remove.click();
  }
  const search = recipients.getByTestId("recipient-search");
  await search.fill("");
  await search.click();
  for (const botId of botIds) {
    await page.getByTestId(`recipient-option-${botId}`).click();
    await expect(recipients.getByTestId(`recipient-chip-${botId}`)).toBeVisible();
  }
  const composer = page.getByTestId("composer-bar").getByRole("combobox");
  await composer.click();
  return composer;
}

async function addNotes(page: Page) {
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "companion-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("A quiet place for coffee. No hurry."),
    });
  await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toBeVisible();
}

async function groupRows(page: Page) {
  return rpc<GroupRow[]>(page, "groups/list", {});
}

async function expectOneFirstMessage(page: Page, groupId: string, text: string) {
  const history = await rpc<MessagePage>(page, "threads/messages", { groupId });
  expect(
    history.messages.filter(
      (message) =>
        message.role === "user" &&
        message.blocks.some((block) => block.kind === "text" && block.text === text),
    ),
  ).toHaveLength(1);
}

test("recipients become an existing Bot chat or a group only after the first message", async ({
  page,
}, testInfo) => {
  const { chiefId, partnerId } = await openCompanions(page, "recipient-first-message");
  const requests: CreatePayload[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/groups/create")) {
      requests.push((request.postDataJSON() as { json: CreatePayload }).json);
    }
  });

  const pendingComposer = await selectRecipients(page, [chiefId, partnerId]);
  await expect(page.getByTestId("group-title-input")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create group", exact: true })).toHaveCount(0);
  await pendingComposer.fill("A thought that has not been sent.");
  await expect.poll(() => groupRows(page)).toEqual([]);
  expect(requests).toEqual([]);
  await captureScreenshot(page, testInfo, "group-recipients-before-first-message");
  await page.getByTestId("chat-close").click();
  await expect(page.getByTestId("pending-group-chat")).toHaveCount(0);
  expect(await groupRows(page)).toEqual([]);

  await openNewGroup(page);
  await expect(page.getByTestId("pending-group-chat")).toBeVisible();
  await expect(pendingComposer).toHaveValue("A thought that has not been sent.");
  await expect(page.getByTestId(`recipient-chip-${chiefId}`)).toBeVisible();
  await expect(page.getByTestId(`recipient-chip-${partnerId}`)).toBeVisible();
  expect(await groupRows(page)).toEqual([]);
  const directComposer = await replaceRecipients(page, [partnerId]);
  await directComposer.fill("Let's keep this between us.");
  await directComposer.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/app/${partnerId}$`));
  await expect(page.getByTestId("transcript")).toContainText("Let's keep this between us.");
  expect(await groupRows(page)).toEqual([]);
  expect(requests).toEqual([]);

  const groupComposer = await selectRecipients(page, [chiefId, partnerId]);
  const firstMessage = "Let's find a place for coffee together.";
  await groupComposer.fill(firstMessage);
  await groupComposer.press("Enter");
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  await expect(page.getByTestId("transcript")).toContainText(firstMessage);
  const groups = await groupRows(page);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.name).toBe("Chief, Researcher");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ name: "Chief, Researcher", botIds: [chiefId, partnerId] });
  expect(requests[0]?.clientNonce).toBeTruthy();
  await expectOneFirstMessage(page, groups[0]!.id, firstMessage);

  const title = page.getByTestId("group-title");
  await expect(title).toHaveText("Chief, Researcher");
  await title.dblclick();
  const editor = page.getByTestId("group-title-input");
  await editor.fill("An unsaved group name");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(title).toHaveText("Chief, Researcher");
  expect((await groupRows(page))[0]?.name).toBe("Chief, Researcher");
  await title.dblclick();
  await editor.fill("Weekend companions");
  await captureScreenshot(page, testInfo, "group-title-inline-rename");
  await page.route("**/rpc/groups/update", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "" }),
  );
  await editor.press("Enter");
  await expect(editor).toHaveValue("Weekend companions");
  await expect(editor.locator("..").getByRole("alert")).toBeVisible();
  expect((await groupRows(page))[0]?.name).toBe("Chief, Researcher");
  await page.unroute("**/rpc/groups/update");
  await editor.press("Enter");
  await expect(title).toHaveText("Weekend companions");
  await expect.poll(async () => (await groupRows(page))[0]?.name).toBe("Weekend companions");
  await expect(
    page.getByTestId("bots-sidebar").getByRole("button", { name: /^Weekend companions/ }),
  ).toBeVisible();
  await page.reload();
  await expect(title).toHaveText("Weekend companions");
  await expect(page.getByRole("combobox", { name: "Message Weekend companions" })).toBeVisible();
  await captureScreenshot(page, testInfo, "group-created-with-continuous-chat");
});

test("a lost creation receipt keeps recipients and files, then retry opens the same group", async ({
  page,
}, testInfo) => {
  const { chiefId, partnerId } = await openCompanions(page, "group-create-receipt");
  const composer = await selectRecipients(page, [chiefId, partnerId]);
  const firstMessage = "Read these notes before we choose a place.";
  await composer.fill(firstMessage);
  await addNotes(page);
  const creates: CreatePayload[] = [];
  const sends: SendPayload[] = [];
  await page.route("**/rpc/groups/create", async (route) => {
    creates.push((route.request().postDataJSON() as { json: CreatePayload }).json);
    if (creates.length !== 1) {
      await route.continue();
      return;
    }
    // The transaction commits, but its acknowledgement is lost. Retrying must
    // replay that group's identity rather than create an indistinguishable copy.
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.fulfill({ status: 200, contentType: "application/json", body: "" });
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/threads/send")) {
      sends.push((request.postDataJSON() as { json: SendPayload }).json);
    }
  });
  await composer.press("Enter");
  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(page.getByTestId("pending-group-chat")).toBeVisible();
  await expect(composer).toHaveValue(firstMessage);
  await expect(page.getByTestId(`recipient-chip-${chiefId}`)).toBeVisible();
  await expect(page.getByTestId(`recipient-chip-${partnerId}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toBeVisible();
  const committedGroups = await groupRows(page);
  expect(committedGroups).toHaveLength(1);
  expect(sends).toEqual([]);
  await captureScreenshot(page, testInfo, "group-lost-create-receipt-keeps-draft");

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  expect(creates).toHaveLength(2);
  expect(creates[1]).toEqual(creates[0]);
  expect(creates[0]?.clientNonce).toBeTruthy();
  expect(await groupRows(page)).toHaveLength(1);
  await expect(page).toHaveURL(new RegExp(`/app/g/${committedGroups[0]!.id}$`));
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ groupId: committedGroups[0]!.id, text: firstMessage });
  expect(sends[0]?.artifactIds).toHaveLength(1);
  await expectOneFirstMessage(page, committedGroups[0]!.id, firstMessage);
  await expect(page.getByTestId("composer-error")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toHaveCount(0);
  await expect(page.getByTestId("composer-bar").getByRole("combobox")).toHaveValue("");
  await captureScreenshot(page, testInfo, "group-retried-create-one-conversation");
});

test("a lost first-message receipt reuses its group, nonce and uploaded attachment", async ({
  page,
}, testInfo) => {
  const { chiefId, partnerId } = await openCompanions(page, "group-first-send-receipt");
  const composer = await selectRecipients(page, [chiefId, partnerId]);
  const firstMessage = "Keep our afternoon open for a quiet cafe.";
  await composer.fill(firstMessage);
  await addNotes(page);
  const creates: CreatePayload[] = [];
  const uploads: unknown[] = [];
  const sends: SendPayload[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/groups/create")) {
      creates.push((request.postDataJSON() as { json: CreatePayload }).json);
    }
    if (request.url().endsWith("/rpc/artifacts/create")) uploads.push(request.postDataJSON());
  });
  await page.route("**/rpc/threads/send", async (route) => {
    sends.push((route.request().postDataJSON() as { json: SendPayload }).json);
    if (sends.length !== 1) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.fulfill({ status: 200, contentType: "application/json", body: "" });
  });
  await composer.press("Enter");
  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(composer).toHaveValue(firstMessage);
  await expect(page.getByTestId(`recipient-chip-${chiefId}`)).toBeVisible();
  await expect(page.getByTestId(`recipient-chip-${partnerId}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toBeVisible();
  const groups = await groupRows(page);
  expect(groups).toHaveLength(1);
  await expectOneFirstMessage(page, groups[0]!.id, firstMessage);
  await captureScreenshot(page, testInfo, "group-lost-first-send-receipt-keeps-draft");

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  expect(creates).toHaveLength(1);
  expect(uploads).toHaveLength(1);
  expect(sends).toHaveLength(2);
  expect(sends[1]).toEqual(sends[0]);
  expect(sends[0]).toMatchObject({ groupId: groups[0]!.id, text: firstMessage });
  expect(sends[0]?.clientNonce).toBeTruthy();
  expect(sends[0]?.artifactIds).toHaveLength(1);
  expect(await groupRows(page)).toHaveLength(1);
  await expectOneFirstMessage(page, groups[0]!.id, firstMessage);
  await expect(page.getByTestId("composer-bar").getByRole("combobox")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "group-first-send-retried-once");
});

test("changing recipients after a single-Bot failure uploads attachments for the new group", async ({
  page,
}, testInfo) => {
  const { chiefId, partnerId } = await openCompanions(page, "recipient-change-after-failure");
  const composer = await selectRecipients(page, [partnerId]);
  const firstMessage = "Bring these notes to our conversation.";
  await composer.fill(firstMessage);
  await addNotes(page);
  const uploads: Array<{ botId?: string; groupId?: string }> = [];
  const sends: SendPayload[] = [];
  const creates: CreatePayload[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/artifacts/create")) {
      uploads.push((request.postDataJSON() as { json: { botId?: string; groupId?: string } }).json);
    }
    if (request.url().endsWith("/rpc/groups/create")) {
      creates.push((request.postDataJSON() as { json: CreatePayload }).json);
    }
  });
  await page.route("**/rpc/threads/send", async (route) => {
    sends.push((route.request().postDataJSON() as { json: SendPayload }).json);
    if (sends.length === 1) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "" });
      return;
    }
    await route.continue();
  });
  await composer.press("Enter");
  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(composer).toHaveValue(firstMessage);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toMatchObject({ botId: partnerId });
  expect(creates).toEqual([]);
  expect(sends[0]?.artifactIds).toHaveLength(1);

  await page.getByTestId(`recipient-chip-${partnerId}`).getByRole("button").click();
  await page.getByTestId("recipient-search").click();
  await page.getByTestId(`recipient-option-${chiefId}`).click();
  await page.getByTestId(`recipient-option-${partnerId}`).click();
  await composer.click();
  await expect(composer).toHaveValue(firstMessage);
  await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toBeVisible();
  await captureScreenshot(page, testInfo, "recipient-change-keeps-file-and-draft");
  await composer.press("Enter");
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  const groups = await groupRows(page);
  expect(groups).toHaveLength(1);
  expect(creates).toHaveLength(1);
  expect(uploads).toHaveLength(2);
  expect(uploads[1]).toMatchObject({ groupId: groups[0]!.id });
  expect(uploads[1]?.botId).toBeUndefined();
  expect(sends).toHaveLength(2);
  expect(sends[1]).toMatchObject({ groupId: groups[0]!.id, text: firstMessage });
  expect(sends[1]?.artifactIds).toHaveLength(1);
  expect(sends[1]?.artifactIds).not.toEqual(sends[0]?.artifactIds);
  expect(sends[1]?.clientNonce).not.toBe(sends[0]?.clientNonce);
  await expectOneFirstMessage(page, groups[0]!.id, firstMessage);
});

test("a late first-message success moves the remaining draft without changing the current chat", async ({
  page,
}, testInfo) => {
  const { chiefId, partnerId } = await openCompanions(page, "new-chat-late-success");
  const composer = await selectRecipients(page, [chiefId, partnerId]);
  const firstMessage = "First thought, already on its way.";
  await composer.fill(firstMessage);
  await addNotes(page);
  let releaseReceipt!: () => void;
  let receiptCommitted!: () => void;
  const committed = new Promise<void>((resolve) => {
    receiptCommitted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseReceipt = resolve;
  });
  await page.route("**/rpc/threads/send", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    receiptCommitted();
    await released;
    await route.fulfill({ response });
  });
  await composer.press("Enter");
  await committed;
  const followup = "Another thought to keep for this group.";
  await composer.fill(followup);
  await expect(composer).toHaveValue(followup);
  const sidebar = page.getByTestId("bots-sidebar");
  await sidebar.locator(`[data-roster-bot-id="${chiefId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/app/${chiefId}$`));
  const chiefComposer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  await chiefComposer.fill("Chief's separate unsent thought.");
  const delivered = page.waitForResponse(
    (response) => response.url().endsWith("/rpc/threads/send") && response.ok(),
  );
  releaseReceipt();
  await delivered;
  await page.unroute("**/rpc/threads/send");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`/app/${chiefId}$`));
  await expect(chiefComposer).toHaveValue("Chief's separate unsent thought.");

  await openNewGroup(page);
  await expect(page.getByTestId("pending-group-chat")).toBeVisible();
  await expect(
    page.getByTestId("chat-recipients").locator('[data-testid^="recipient-chip-"]'),
  ).toHaveCount(0);
  await expect(page.getByTestId("composer-bar").getByRole("combobox")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toHaveCount(0);
  await page.getByTestId("chat-close").click();
  await expect(chiefComposer).toHaveValue("Chief's separate unsent thought.");

  const groups = await groupRows(page);
  expect(groups).toHaveLength(1);
  await sidebar.getByRole("button", { name: /^Chief, Researcher/ }).click();
  await expect(page).toHaveURL(new RegExp(`/app/g/${groups[0]!.id}$`));
  await expect(
    page.getByRole("combobox", { name: "Message Chief, Researcher", exact: true }),
  ).toHaveValue(followup);
  await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toHaveCount(0);
  await expectOneFirstMessage(page, groups[0]!.id, firstMessage);
  await captureScreenshot(page, testInfo, "new-chat-late-success-moved-remaining-draft");
});

test("six long-named recipients fit the narrow desktop with a persistent compact rail", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `recipient-bounds-${Date.now()}@rakazo.test`,
    "password12",
    "Recipient Review",
  );
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const companions: Array<{ id: string; name: string }> = [];
  for (let index = 1; index <= 6; index += 1) {
    const name =
      `Companion ${index}: weekend plans, books, quiet walks and conversations about everyday life`
        .slice(0, 79)
        .concat(".");
    expect(name).toHaveLength(80);
    companions.push(
      await rpc<{ id: string; name: string }>(page, "bots/create", {
        name,
        title: "",
        description: "",
        notifyOnFinish: true,
      }),
    );
  }
  await page.setViewportSize({ width: 800, height: 800 });
  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await page.getByTestId("minimize-bots-sidebar").click();
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toHaveAttribute("data-sidebar-compact", "true");
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(88);
  const creates: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/groups/create")) creates.push(request.postDataJSON());
  });
  await selectRecipients(
    page,
    companions.map((bot) => bot.id),
  );
  const recipients = page.getByTestId("chat-recipients");
  const chips = recipients.locator('[data-testid^="recipient-chip-"]');
  const search = recipients.getByTestId("recipient-search");
  await expect(chips).toHaveCount(6);
  await expect(search).toBeDisabled();
  const recipientsBox = (await recipients.boundingBox())!;
  for (const bot of companions) {
    const chip = page.getByTestId(`recipient-chip-${bot.id}`);
    await expect(chip.getByText(bot.name, { exact: true })).toHaveAttribute("title", bot.name);
    const box = (await chip.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(recipientsBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(recipientsBox.x + recipientsBox.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
  }
  const avatarShapes = await page.locator(".rakazo-bot-avatar:visible").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: box.width,
        height: box.height,
        radius: Number.parseFloat(style.borderRadius),
      };
    }),
  );
  expect(avatarShapes.length).toBeGreaterThanOrEqual(13);
  for (const avatar of avatarShapes) {
    expect(Math.abs(avatar.width - avatar.height)).toBeLessThanOrEqual(1);
    expect(avatar.radius).toBeGreaterThanOrEqual(avatar.width / 2);
  }
  const close = (await page.getByTestId("chat-close").boundingBox())!;
  expect(close.x).toBeGreaterThanOrEqual(88);
  expect(close.x + close.width).toBeLessThanOrEqual(800);
  expect(close.y).toBeGreaterThanOrEqual(0);
  expect(close.y + close.height).toBeLessThanOrEqual(800);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(800);
  expect(creates).toEqual([]);
  expect(await groupRows(page)).toEqual([]);
  await captureScreenshot(page, testInfo, "group-six-long-recipients-800-compact-rail");

  await page.getByTestId(`recipient-chip-${companions[0]!.id}`).getByRole("button").click();
  await expect(chips).toHaveCount(5);
  await expect(search).toBeEnabled();
  await search.click();
  await page.getByTestId(`recipient-option-${chiefId}`).click();
  await expect(chips).toHaveCount(6);
  await expect(page.getByTestId(`recipient-chip-${chiefId}`)).toBeVisible();
  await expect(page.getByTestId(`recipient-chip-${companions[0]!.id}`)).toHaveCount(0);
  await expect(search).toBeDisabled();
  expect(creates).toEqual([]);
  expect(await groupRows(page)).toEqual([]);
});

for (const entry of ["sidebar", "settings", "archive"] as const) {
  const action = entry === "archive" ? "archiving" : "deleting";
  test(`${action} a group through ${entry} after its first send fails preserves a recoverable draft`, async ({
    page,
  }, testInfo) => {
    const { chiefId, partnerId } = await openCompanions(page, `group-delete-recovery-${entry}`);
    const composer = await selectRecipients(page, [chiefId, partnerId]);
    const firstMessage = "Bring these notes when we choose a quiet place together.";
    await composer.fill(firstMessage);
    await addNotes(page);
    const creates: CreatePayload[] = [];
    const uploads: Array<{ groupId?: string }> = [];
    const sends: SendPayload[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/rpc/groups/create")) {
        creates.push((request.postDataJSON() as { json: CreatePayload }).json);
      }
      if (request.url().endsWith("/rpc/artifacts/create")) {
        uploads.push((request.postDataJSON() as { json: { groupId?: string } }).json);
      }
    });
    await page.route("**/rpc/threads/send", async (route) => {
      sends.push((route.request().postDataJSON() as { json: SendPayload }).json);
      if (sends.length === 1) {
        // Do not forward the first send. Unlike a lost successful receipt,
        // this leaves the newly created group with no committed user message.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ json: null }),
        });
        return;
      }
      await route.continue();
    });
    await composer.press("Enter");
    await expect(page.getByTestId("composer-error")).toBeVisible();
    await expect(composer).toHaveValue(firstMessage);
    await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toBeVisible();
    const beforeDeletion = await groupRows(page);
    expect(beforeDeletion).toHaveLength(1);
    const deletedGroup = beforeDeletion[0]!;
    const unsentHistory = await rpc<MessagePage>(page, "threads/messages", {
      groupId: deletedGroup.id,
    });
    expect(unsentHistory.messages.filter((message) => message.role === "user")).toEqual([]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ groupId: deletedGroup.id });

    const sidebar = page.getByTestId("bots-sidebar");
    await sidebar.locator(`[data-roster-bot-id="${chiefId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/app/${chiefId}$`));
    const groupRow = sidebar.getByRole("button", { name: /^Chief, Researcher/ });
    if (entry === "archive") {
      await groupRow.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    } else if (entry === "sidebar") {
      await groupRow.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
      const confirmation = page.getByRole("alertdialog", { name: "Delete Chief, Researcher?" });
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(confirmation).toHaveCount(0);
    } else {
      await groupRow.click();
      await expect(page).toHaveURL(new RegExp(`/app/g/${deletedGroup.id}$`));
      await page.getByTestId("bot-settings-trigger").click();
      const settings = page.getByTestId("side-panel");
      await expect(settings).toHaveAttribute("data-panel", "group-settings");
      await settings.getByRole("button", { name: "Delete group", exact: true }).click();
      await expect(settings).toHaveAttribute("data-panel", "closed");
    }
    await expect(groupRow).toHaveCount(0);
    await expect.poll(() => groupRows(page)).toEqual([]);
    if (entry === "archive") {
      const archived = await rpc<Array<{ id: string; archivedAt: string | null }>>(
        page,
        "groups/listArchived",
        {},
      );
      expect(archived.find((group) => group.id === deletedGroup.id)?.archivedAt).toBeTruthy();
    }
    await openNewGroup(page);
    await expect(page.getByTestId("pending-group-chat")).toBeVisible();
    await expect(page.getByTestId("recipient-search")).toBeEnabled();
    await expect(page.getByTestId(`recipient-chip-${chiefId}`)).toBeVisible();
    await expect(page.getByTestId(`recipient-chip-${partnerId}`)).toBeVisible();
    await expect(composer).toHaveValue(firstMessage);
    await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toBeVisible();
    await captureScreenshot(page, testInfo, `group-deleted-${entry}-keeps-recoverable-draft`);

    await composer.press("Enter");
    await page.waitForURL(/\/app\/g\/[^/]+$/);
    const recovered = await groupRows(page);
    expect(recovered).toHaveLength(1);
    const newGroup = recovered[0]!;
    expect(newGroup.id).not.toBe(deletedGroup.id);
    expect(newGroup.threadId).not.toBe(deletedGroup.threadId);
    expect(creates).toHaveLength(2);
    expect(creates[1]?.clientNonce).toBeTruthy();
    expect(creates[1]?.clientNonce).not.toBe(creates[0]?.clientNonce);
    expect(uploads).toHaveLength(2);
    expect(uploads[1]).toMatchObject({ groupId: newGroup.id });
    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ groupId: newGroup.id, text: firstMessage });
    expect(sends[1]?.artifactIds).toHaveLength(1);
    expect(sends[1]?.artifactIds).not.toEqual(sends[0]?.artifactIds);
    expect(sends[1]?.clientNonce).not.toBe(sends[0]?.clientNonce);
    const artifact = await rpc<{ id: string; groupId: string | null; name: string }>(
      page,
      "artifacts/get",
      { groupId: newGroup.id, artifactId: sends[1]!.artifactIds![0] },
    );
    expect(artifact).toMatchObject({ groupId: newGroup.id, name: "companion-notes.txt" });
    await expectOneFirstMessage(page, newGroup.id, firstMessage);
    await expect(page.getByTestId("composer-bar").getByRole("combobox")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toHaveCount(0);
    await captureScreenshot(page, testInfo, `group-deleted-${entry}-recovered-once`);
  });
}

test("archiving a recipient keeps the draft and creates the group with its current companions", async ({
  page,
}, testInfo) => {
  const { chiefId, partnerId } = await openCompanions(page, "archived-recipient-draft");
  const composer = await selectRecipients(page, [chiefId, partnerId]);
  const firstMessage = "Let's keep these notes for our next conversation.";
  await composer.fill(firstMessage);
  await addNotes(page);
  const creates: CreatePayload[] = [];
  const sends: SendPayload[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/groups/create")) {
      creates.push((request.postDataJSON() as { json: CreatePayload }).json);
    }
    if (request.url().endsWith("/rpc/threads/send")) {
      sends.push((request.postDataJSON() as { json: SendPayload }).json);
    }
  });
  expect(await groupRows(page)).toEqual([]);
  const sidebar = page.getByTestId("bots-sidebar");
  await sidebar.locator(`[data-roster-bot-id="${chiefId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/app/${chiefId}$`));
  const retiringRecipient = sidebar.locator(`[data-roster-bot-id="${partnerId}"]`);
  await retiringRecipient.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(retiringRecipient).toHaveCount(0);
  const activeBots = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  expect(activeBots.some((bot) => bot.id === partnerId)).toBe(false);
  const archivedBots = await rpc<Array<{ id: string; archivedAt: string | null }>>(
    page,
    "bots/listArchived",
    {},
  );
  expect(archivedBots.find((bot) => bot.id === partnerId)?.archivedAt).toBeTruthy();

  await openNewGroup(page);
  await expect(page.getByTestId("pending-group-chat")).toBeVisible();
  const recipients = page.getByTestId("chat-recipients");
  const chips = recipients.locator('[data-testid^="recipient-chip-"]');
  await expect(chips).toHaveCount(1);
  await expect(recipients.getByTestId(`recipient-chip-${chiefId}`)).toBeVisible();
  await expect(recipients.getByTestId(`recipient-chip-${partnerId}`)).toHaveCount(0);
  await expect(recipients.getByTestId("recipient-search")).toBeEnabled();
  await expect(composer).toHaveValue(firstMessage);
  await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toBeVisible();
  expect(creates).toEqual([]);
  expect(sends).toEqual([]);

  const replacement = await rpc<{ id: string }>(page, "bots/create", {
    name: "Cafe companion",
    title: "",
    description: "",
    notifyOnFinish: true,
  });
  await expect(sidebar.locator(`[data-roster-bot-id="${replacement.id}"]`)).toBeVisible();
  await recipients.getByTestId("recipient-search").click();
  await page.getByTestId(`recipient-option-${replacement.id}`).click();
  await expect(chips).toHaveCount(2);
  await expect(recipients.getByTestId(`recipient-chip-${replacement.id}`)).toBeVisible();
  await composer.click();
  await captureScreenshot(page, testInfo, "archived-recipient-preserves-draft-and-current-members");
  await composer.press("Enter");
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  const groups = await groupRows(page);
  expect(groups).toHaveLength(1);
  const group = groups[0]!;
  expect(creates).toHaveLength(1);
  expect(creates[0]?.botIds).toEqual([chiefId, replacement.id]);
  expect(group.members.map((member) => member.botId).sort()).toEqual(
    [chiefId, replacement.id].sort(),
  );
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ groupId: group.id, text: firstMessage });
  expect(sends[0]?.artifactIds).toHaveLength(1);
  const artifact = await rpc<{ groupId: string | null; name: string }>(page, "artifacts/get", {
    groupId: group.id,
    artifactId: sends[0]!.artifactIds![0],
  });
  expect(artifact).toMatchObject({ groupId: group.id, name: "companion-notes.txt" });
  await expectOneFirstMessage(page, group.id, firstMessage);
  await expect(page.getByTestId("composer-bar").getByRole("combobox")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove companion-notes.txt" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "archived-recipient-group-current-members-only");
});
