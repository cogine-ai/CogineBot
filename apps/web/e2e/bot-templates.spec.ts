import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, Me } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openNewBot,
  openNewSpace,
  rpc,
  signup,
} from "./helpers";

type CreatePayload = {
  name: string;
  title: string;
  description: string;
  instructions: string;
  notifyOnFinish: boolean;
  computerMode: "team" | "dedicated";
  spawnKey: string;
};
type SendPayload = { botId?: string; text?: string; clientNonce?: string };
type MessagePage = {
  messages: Array<{ role: string; blocks: Array<{ kind: string; text?: string }> }>;
};

const scenarios = [
  {
    id: "research-v1",
    name: "资料研究",
    title: "查证资料并给出来源",
    description: "围绕问题检索资料、核对关键事实，整理有出处的结论。",
    instructions:
      "先明确研究问题和时间范围。优先一手资料，区分事实、推断和未知；关键结论附来源与日期。需要账号或付费资源时沿产品确认流程，不自行发布。",
    example: "比较这三个方案的功能与限制，给出来源和需要验证的问题。",
  },
  {
    id: "documents-v1",
    name: "文档整理",
    title: "把材料整理成可交付文档",
    description: "整理用户提供的材料，保留原意、出处和待确认项。",
    instructions:
      "先盘点已提供材料与预期读者。保留关键事实和来源，缺失内容明确标注；先形成结构清楚的草稿。未经用户要求不覆盖原文件或对外分享。",
    example: "把这些材料整理成一份项目说明，列出决策、待办和缺失信息。",
  },
  {
    id: "email-draft-v1",
    name: "邮件草稿",
    title: "整理邮件并准备回复",
    description: "归纳邮件上下文，起草供用户审阅的回复。",
    instructions:
      "核对收件人、上下文和附件，给出简短、可编辑的邮件草稿。没有连接邮箱时请用户提供内容；不要声称已读取。发送、删除和批量修改仍走产品现有授权流程。",
    example: "根据这封邮件起草回复，先给我审阅，不要发送。",
  },
] as const;

async function account(page: Page, label: string) {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await signup(page, `${label}-${Date.now()}@example.test`, "password12", "Template editor");
  await completeOnboarding(page);
  return activeBotId(page);
}
function requests(page: Page) {
  const creates: CreatePayload[] = [];
  const sends: SendPayload[] = [];
  const appConnections: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/onboarding/appConnected")) appConnections.push(request.url());
    if (request.url().endsWith("/rpc/bots/create"))
      creates.push((request.postDataJSON() as { json: CreatePayload }).json);
    if (request.url().endsWith("/rpc/threads/send"))
      sends.push((request.postDataJSON() as { json: SendPayload }).json);
  });
  return { creates, sends, appConnections };
}
async function choose(page: Page, scenario: (typeof scenarios)[number] = scenarios[0]) {
  const form = page.getByTestId("create-bot-form");
  await form
    .getByTestId("bot-template-choices")
    .getByRole("button", { name: new RegExp(`^${scenario.name}`) })
    .click();
  await expect(form.getByLabel("Name", { exact: true })).toHaveValue(scenario.name);
  await expect(form.getByLabel("Title", { exact: true })).toHaveValue(scenario.title);
  await expect(form.getByRole("textbox", { name: "Description", exact: true })).toHaveValue(
    scenario.description,
  );
  await expect(form.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue(
    scenario.instructions,
  );
  return form;
}
function composer(page: Page) {
  return page.getByTestId("composer-bar").getByRole("combobox");
}
function frame(page: Page) {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

// The official offline harness uses the scripted runtime. Its creation intro is
// skipped; SDK/intro Task and Run behavior is covered by separate integration tests.
for (const scenario of scenarios) {
  test(`template ${scenario.id} keeps the approved preview and edited rules through creation`, async ({
    page,
  }, testInfo) => {
    await account(page, `template-${scenario.id}`);
    const { creates, sends, appConnections } = requests(page);
    const before = await rpc<Bot[]>(page, "bots/list", {});
    await openNewBot(page);
    let form = await choose(page, scenario);
    expect(creates).toEqual([]);
    if (scenario.id === "research-v1") {
      await captureScreenshot(page, testInfo, "a6-template-preview");
      await form.getByRole("button", { name: "Cancel new bot", exact: true }).click();
      await expect(form).toHaveCount(0);
      expect(creates).toEqual([]);
      expect(await rpc<Bot[]>(page, "bots/list", {})).toHaveLength(before.length);
      await openNewBot(page);
      form = await choose(page, scenario);
    }
    if (scenario.id === "email-draft-v1") {
      await expect(form.getByText("Gmail or Outlook (optional)", { exact: true })).toBeVisible();
      await expect(
        form.getByRole("button", { name: "Connect an email account", exact: true }),
      ).toBeVisible();
    }
    const name = `Edited ${scenario.name}`;
    const rules = `  # ${scenario.id} private rules\n\nKeep these exact blank lines.\n\n`;
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByRole("textbox", { name: "Description", exact: true }).fill("Public team role");
    await form.getByRole("textbox", { name: "Instructions", exact: true }).fill(rules);
    const create = form.getByRole("button", { name: "Create", exact: true });
    await expect(create).toBeEnabled();
    if (scenario.id === "email-draft-v1") {
      await form.getByRole("button", { name: "Connect an email account", exact: true }).click();
      const integrations = page.getByRole("dialog", { name: "Integrations", exact: true });
      await expect(integrations).toBeVisible();
      await expect(
        integrations.getByRole("textbox", { name: "Search apps", exact: true }),
      ).toBeVisible();
      await integrations.getByRole("button", { name: "Close integrations", exact: true }).click();
      await expect(integrations).toHaveCount(0);
      await expect(form.getByLabel("Name", { exact: true })).toHaveValue(name);
      await expect(form.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue(
        rules,
      );
      expect(creates).toEqual([]);
      expect(appConnections).toEqual([]);
      await create.scrollIntoViewIfNeeded();
      await expect(create).toBeInViewport({ ratio: 1 });
      await captureScreenshot(page, testInfo, "a6-optional-email-preview");
    }
    await create.click();
    await expect(
      page.getByRole("combobox", { name: `Message ${name}`, exact: true }),
    ).toBeVisible();
    expect(creates).toHaveLength(1);
    expect(creates[0]).toEqual({
      name,
      title: scenario.title,
      description: "Public team role",
      instructions: rules,
      notifyOnFinish: true,
      computerMode: "team",
      spawnKey: expect.stringMatching(/^bot-create:.+/),
    });
    const botId = activeBotId(page);
    expect(await rpc<Bot>(page, "bots/get", { botId })).toMatchObject({
      name,
      description: "Public team role",
      instructions: rules,
    });
    const example = page.getByRole("button", { name: "Try example", exact: true });
    await expect(example).toBeEnabled();
    await expect(composer(page)).toHaveValue("");
    expect(sends).toEqual([]);
    expect(
      (await rpc<MessagePage>(page, "threads/messages", { botId })).messages.filter(
        (message) => message.role === "user",
      ),
    ).toEqual([]);
    await example.click();
    await expect(composer(page)).toHaveValue(scenario.example);
    await expect(example).toHaveCount(0);
    expect(sends).toEqual([]);
  });
}

test("an example preserves actual composer text, files, skills and reply context until an explicit empty insertion", async ({
  page,
}, testInfo) => {
  const chiefId = await account(page, "template-occupied");
  const { creates, sends } = requests(page);
  await openNewBot(page);
  const form = await choose(page, scenarios[1]);
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Message 文档整理", exact: true })).toBeVisible();
  const botId = activeBotId(page);
  const input = composer(page);
  const example = page.getByRole("button", { name: "Try example", exact: true });
  await expect(example).toBeEnabled();
  await input.fill("Keep my existing draft.");
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "retained-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Synthetic notes to keep."),
    });
  const file = page.getByRole("button", { name: "Remove retained-notes.txt", exact: true });
  await expect(file).toBeVisible();
  await example.click();
  await expect(input).toHaveValue("Keep my existing draft.");
  await expect(file).toBeVisible();
  expect(sends).toEqual([]);
  await captureScreenshot(page, testInfo, "a6-existing-composer-draft-kept");
  await input.fill("");
  await example.click();
  await expect(input).toHaveValue("");
  await expect(file).toBeVisible();
  await file.click();
  await input.fill("/Inter");
  await page
    .getByTestId("slash-picker")
    .getByRole("button", { name: "Skill Interrogate", exact: true })
    .click();
  await example.click();
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("skill-chip")).toContainText("Interrogate");
  await page.getByRole("button", { name: "Remove skill Interrogate", exact: true }).click();
  const parentText = "A parent message for a retained reply.";
  await input.fill(parentText);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const parent = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: parentText })
    .first();
  await expect(parent).toBeVisible();
  await expect(example).toBeEnabled();
  await parent.hover();
  await parent
    .getByTestId("message-hover-rail")
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(page.getByTestId("reply-chip")).toContainText(parentText);
  await example.click();
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("reply-chip")).toContainText(parentText);
  expect(sends).toHaveLength(1);
  await page.getByRole("button", { name: "Cancel reply", exact: true }).click();
  await example.click();
  await expect(input).toHaveValue(scenarios[1].example);
  await expect(example).toHaveCount(0);
  const edited = "My edited example, sent only after review.";
  await input.fill(edited);
  await frame(page);
  expect(sends).toHaveLength(1);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("transcript")).toContainText(edited);
  expect(sends).toHaveLength(2);
  expect(sends[1]).toMatchObject({ botId, text: edited, clientNonce: expect.any(String) });
  expect(sends[1]!.clientNonce).not.toBe(creates[0]!.spawnKey);
  expect(sends[1]!.clientNonce).not.toBe(sends[0]!.clientNonce);
  expect(sends[1]!.clientNonce).not.toMatch(/^bot-example:/);
  await page.getByTestId("bots-sidebar").locator(`[data-roster-bot-id="${chiefId}"]`).click();
  await page.getByTestId("bots-sidebar").locator(`[data-roster-bot-id="${botId}"]`).click();
  await expect(input).toHaveValue("");
  await expect(example).toHaveCount(0);
});

test("a lost creation acknowledgement keeps newer preview edits and requires an explicit new intent", async ({
  page,
}, testInfo) => {
  await account(page, "template-recovery");
  const { creates, sends } = requests(page);
  await openNewBot(page);
  const form = await choose(page);
  let release!: () => void;
  let committed!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const written = new Promise<void>((resolve) => {
    committed = resolve;
  });
  let saved: Bot | undefined;
  await page.route("**/rpc/bots/create", async (route) => {
    if (saved) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    saved = ((await response.json()) as { json: Bot }).json;
    committed();
    await released;
    await route.abort("failed");
  });
  try {
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await written;
    const keptRules = "  Newer unsent rules\n\nKeep this draft.  ";
    await form.getByLabel("Name", { exact: true }).fill("Retained edited bot");
    await form.getByRole("textbox", { name: "Instructions", exact: true }).fill(keptRules);
    release();
    await expect(
      form.getByText("Bot created. Your edits are kept.", { exact: true }),
    ).toBeVisible();
    await expect(form.getByLabel("Name", { exact: true })).toHaveValue("Retained edited bot");
    await expect(form.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue(
      keptRules,
    );
    await expect(form.getByRole("button", { name: "Open bot", exact: true })).toBeVisible();
    const another = form.getByRole("button", { name: "Create another bot", exact: true });
    await expect(another).toBeVisible();
    expect(creates).toHaveLength(1);
    expect(sends).toEqual([]);
    expect(
      (await rpc<Bot[]>(page, "bots/list", {})).filter(
        (bot) => bot.spawnKey === creates[0]!.spawnKey,
      ),
    ).toHaveLength(1);
    expect(await rpc<Bot>(page, "bots/get", { botId: saved!.id })).toMatchObject({
      name: scenarios[0].name,
      instructions: scenarios[0].instructions,
    });
    await another.scrollIntoViewIfNeeded();
    await expect(another).toBeInViewport({ ratio: 1 });
    await captureScreenshot(page, testInfo, "a6-recovered-preview-edits-kept");
    await another.click();
    expect(creates).toHaveLength(1);
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "Message Retained edited bot", exact: true }),
    ).toBeVisible();
    expect(creates).toHaveLength(2);
    expect(creates[1]!.spawnKey).not.toBe(creates[0]!.spawnKey);
    expect(activeBotId(page)).not.toBe(saved!.id);
    expect(await rpc<Bot>(page, "bots/get", { botId: activeBotId(page) })).toMatchObject({
      instructions: keptRules,
    });
    expect(sends).toEqual([]);
  } finally {
    release();
  }
});

test("a committed creation without its receipt cannot carry a preview or example across real Space reloads", async ({
  page,
}) => {
  const chiefA = await account(page, "template-space-aba");
  const meA = await rpc<Me>(page, "me", {});
  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  await dialog.getByLabel("Name").fill("Template second Space");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("rakazo:space-id")))
    .not.toBeNull();
  const spaceB = (await page.evaluate(() => localStorage.getItem("rakazo:space-id")))!;
  expect(spaceB).not.toBe(meA.spaceId);
  await completeOnboarding(page);
  const chiefB = activeBotId(page);
  const sidebar = page.getByTestId("bots-sidebar");
  async function switchTo(botId: string, spaceId: string) {
    await sidebar.locator(`[data-roster-bot-id="${botId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/app/${botId}$`));
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("rakazo:space-id")))
      .toBe(spaceId);
  }
  await switchTo(chiefA, meA.spaceId);
  await openNewBot(page);
  const form = await choose(page);
  let release!: () => void;
  let finishRoute!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const routeFinished = new Promise<void>((resolve) => {
    finishRoute = resolve;
  });
  let saved: Bot | undefined;
  await page.route("**/rpc/bots/create", async (route) => {
    expect(route.request().headers()["x-rakazo-space-id"]).toBe(meA.spaceId);
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    saved = ((await response.json()) as { json: Bot }).json;
    await released;
    // A real cross-Space navigation reloads the document and abandons its request.
    await route.abort("aborted");
    finishRoute();
  });
  try {
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(() => saved?.id).toBeTruthy();
    await switchTo(chiefB, spaceB!);
    await switchTo(chiefA, meA.spaceId);
    if (await form.isVisible())
      await form.getByRole("button", { name: "Cancel new bot", exact: true }).click();
    await openNewBot(page);
    const fresh = page.getByTestId("create-bot-form");
    await fresh.getByLabel("Name", { exact: true }).fill("Fresh editor after return");
    await fresh
      .getByRole("textbox", { name: "Instructions", exact: true })
      .fill("Keep current owner draft");
    release();
    await routeFinished;
    await frame(page);
    await expect(page).toHaveURL(new RegExp(`/app/${chiefA}$`));
    await expect(fresh.getByLabel("Name", { exact: true })).toHaveValue(
      "Fresh editor after return",
    );
    await expect(fresh.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue(
      "Keep current owner draft",
    );
    await fresh.getByRole("button", { name: "Cancel new bot", exact: true }).click();
    await sidebar.locator(`[data-roster-bot-id="${saved!.id}"]`).click();
    await expect(composer(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Try example", exact: true })).toHaveCount(0);
    expect(saved!.spaceId).toBe(meA.spaceId);
  } finally {
    release();
  }
});
