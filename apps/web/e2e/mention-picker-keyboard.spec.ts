import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

async function openMentionGroup(page: Page, label: string, name: string) {
  await signup(page, `${label}-${Date.now()}@rakazo.test`, "password12", "Mention Review");
  await completeOnboarding(page);
  const researcherId = await createNamedBot(page, "Researcher");
  const writerId = await createNamedBot(page, "Research Writer");
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name,
    botIds: [researcherId, writerId],
  });
  await page.goto(`/app/g/${group.id}`);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  const composer = page.getByRole("combobox", { name: `Message ${name}`, exact: true });
  await expect(composer).toBeVisible();
  return { composer, groupId: group.id, researcherId, writerId };
}

async function expectWithin(container: Locator, content: Locator) {
  const outer = await container.boundingBox();
  const inner = await content.boundingBox();
  expect(outer).not.toBeNull();
  expect(inner).not.toBeNull();
  expect(inner!.x).toBeGreaterThanOrEqual(outer!.x - 1);
  expect(inner!.y).toBeGreaterThanOrEqual(outer!.y - 1);
  expect(inner!.x + inner!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 1);
  expect(inner!.y + inner!.height).toBeLessThanOrEqual(outer!.y + outer!.height + 1);
}

async function expectMentionAvatar(mention: Locator) {
  const avatar = mention.locator(".rakazo-bot-avatar");
  await expect(avatar).toHaveCount(1);
  await expect(avatar).toBeVisible();
  const box = await avatar.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(12);
  expect(Math.abs(box!.width - box!.height)).toBeLessThan(1);
}

test("mention picker completes with Enter and Tab", async ({ page }, testInfo) => {
  const { composer } = await openMentionGroup(page, "mention-keys", "Mention keys team");
  const bar = page.getByTestId("composer-bar");
  const compactHeight = (await bar.boundingBox())!.height;

  await composer.fill("@Res");
  const picker = page.getByTestId("mention-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(composer).toHaveAttribute("aria-expanded", "true");
  const barBox = (await bar.boundingBox())!;
  const pickerBox = (await picker.boundingBox())!;
  expect(barBox.height).toBe(compactHeight);
  expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(barBox.y);
  expect(barBox.y - pickerBox.y - pickerBox.height).toBeLessThanOrEqual(12);
  expect(pickerBox.x).toBeGreaterThanOrEqual(barBox.x - 1);
  expect(pickerBox.width).toBeLessThanOrEqual(Math.min(barBox.width, 384));
  expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(barBox.x + barBox.width + 1);
  for (const option of await picker.getByRole("option").all()) {
    const optionBox = (await option.boundingBox())!;
    expect(optionBox.height).toBeGreaterThanOrEqual(28);
    expect(optionBox.height).toBeLessThanOrEqual(40);
    expect(await option.innerText()).not.toContain("@");
    await expect(option.getByTestId("mention-kind-label")).toHaveText("Bot");
    await expectMentionAvatar(option);
  }
  await captureScreenshot(page, testInfo, "mention-picker-keyboard-open");

  await composer.press("ArrowDown");
  await expect(picker.getByRole("option", { name: "@Research Writer" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await composer.press("Enter");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  const writerChip = bar.getByTestId("mention-chip").filter({ hasText: "Research Writer" });
  await expect(writerChip).toBeVisible();
  await expectWithin(bar, writerChip);
  await expectMentionAvatar(writerChip);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await captureScreenshot(page, testInfo, "mention-picker-keyboard-completed");

  await page.getByRole("button", { name: "Remove mention Research Writer" }).click();
  await composer.fill("@Res");
  await expect(page.getByTestId("mention-picker")).toBeVisible();
  await composer.press("Tab");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  await expect(page.getByTestId("mention-chip").filter({ hasText: "Researcher" })).toBeVisible();
  await expect(composer).toBeFocused();

  await page.getByRole("button", { name: "Remove mention Researcher" }).click();
  await composer.fill("@Res");
  await expect(page.getByTestId("mention-picker")).toBeVisible();
  await composer.press("Escape");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  await expect(composer).toHaveValue("@Res");
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
  await expect(composer).toBeFocused();

  await composer.fill("hello without a picker");
  await composer.press("Enter");
  await expect(page.getByTestId("transcript")).toContainText("hello without a picker", {
    timeout: 60_000,
  });
});

test("two Bot mentions keep their send payload across multiline text and an attachment", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { composer, groupId, researcherId, writerId } = await openMentionGroup(
    page,
    "mention-inline",
    "Weekend companions",
  );
  const bar = page.getByTestId("composer-bar");
  const sends: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/threads/send")) sends.push(request.postDataJSON());
  });

  await composer.fill("@Res");
  await page.getByRole("option", { name: "@Researcher", exact: true }).click();
  await composer.fill("@Res");
  await page.getByRole("option", { name: "@Research Writer", exact: true }).click();
  const chips = bar.getByTestId("mention-chip");
  await expect(chips).toHaveCount(2);
  for (const chip of await chips.all()) {
    await expectWithin(bar, chip);
    await expectMentionAvatar(chip);
  }

  await composer.fill("A quiet plan.");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("One place is enough.");
  const body = "A quiet plan.\nOne place is enough.";
  await expect(composer).toHaveValue(body);
  expect(sends).toHaveLength(0);
  await expect(bar).toHaveAttribute("data-expanded", "true");
  const fileName = "weekend-notes.txt";
  await bar.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "text/plain",
    buffer: Buffer.from("One place. A walk and coffee."),
  });
  const attachments = bar.getByTestId("composer-attachments");
  await expect(attachments.getByTestId("attachment-preview")).toHaveCount(1);
  await expect(
    attachments.getByRole("button", { name: `Remove ${fileName}`, exact: true }),
  ).toBeVisible();

  for (const width of [1280, 800]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(composer).toHaveValue(body);
    await expect(bar).toHaveAttribute("data-expanded", "true");
    const inputBox = (await composer.boundingBox())!;
    const attachmentBox = (await attachments.boundingBox())!;
    const barBox = (await bar.boundingBox())!;
    expect(attachmentBox.y + attachmentBox.height).toBeLessThanOrEqual(inputBox.y);
    expect(inputBox.width).toBeGreaterThanOrEqual(barBox.width - 32);
    for (const name of ["Attach file", "Send"]) {
      const control = bar.getByRole("button", { name, exact: true });
      await expectWithin(bar, control);
      expect((await control.boundingBox())!.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
    }
    for (const chip of await chips.all()) await expectWithin(bar, chip);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await captureScreenshot(page, testInfo, `mention-composer-attachment-${width}`);
  }

  try {
    const [request] = await Promise.all([
      page.waitForRequest((request) => request.url().endsWith("/rpc/threads/send")),
      composer.press("Enter"),
    ]);
    const payload = (
      request.postDataJSON() as {
        json: { groupId: string; text: string; mentions: unknown[]; artifactIds: string[] };
      }
    ).json;
    expect(payload.groupId).toBe(groupId);
    expect(payload.mentions).toEqual([
      { kind: "bot", id: researcherId },
      { kind: "bot", id: writerId },
    ]);
    expect(payload.text).toBe(`@Researcher @Research Writer ${body}`);
    expect(payload.artifactIds).toHaveLength(1);
    await expect(composer).toHaveValue("");
    await expect(chips).toHaveCount(0);
    const bubble = page
      .getByTestId("message-user-bubble")
      .filter({ hasText: "One place is enough." });
    await expect(bubble).toBeVisible();
    const mentions = bubble.getByTestId("message-mention");
    await expect(mentions).toHaveCount(2);
    for (const [id, name] of [
      [researcherId, "Researcher"],
      [writerId, "Research Writer"],
    ]) {
      const inlineMention = bubble.locator(
        `[data-testid="message-mention"][data-mention-id="${id}"]`,
      );
      await expect(inlineMention).toHaveText(`@${name}`);
      await expectMentionAvatar(inlineMention);
      expect((await bubble.innerText()).split(`@${name}`).length - 1).toBe(1);
    }
    await expect(bubble).toHaveText(payload.text);
    await expect(page.getByTestId("transcript")).toContainText(fileName);
    const stored = await rpc<{
      messages: Array<{ role: string; blocks: Array<{ kind: string; text?: string }> }>;
    }>(page, "threads/messages", { groupId });
    expect(
      stored.messages.filter(
        (message) =>
          message.role === "user" &&
          message.blocks.some((block) => block.kind === "text" && block.text === payload.text),
      ),
    ).toHaveLength(1);
    await expect
      .poll(
        async () => {
          const history = await rpc<{
            messages: Array<{
              role: string;
              botId?: string;
              blocks: Array<{ kind: string; text?: string }>;
            }>;
          }>(page, "threads/messages", { groupId });
          return [
            ...new Set(
              history.messages
                .filter(
                  (message) =>
                    message.role === "bot" &&
                    message.blocks.some(
                      (block) => block.kind === "text" && Boolean(block.text?.trim()),
                    ),
                )
                .map((message) => message.botId),
            ),
          ].sort();
        },
        { timeout: 60_000 },
      )
      .toEqual([researcherId, writerId].sort());
    await captureScreenshot(page, testInfo, "mention-message-two-bots");
  } finally {
    await rpc(page, "threads/stop", { groupId }).catch(() => undefined);
  }
});

test("long and Chinese Bot mentions remain usable through a narrow desktop send", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 800, height: 800 });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await signup(page, `mention-long-${Date.now()}@rakazo.test`, "password12", "Mention Review");
  await completeOnboarding(page);
  const names = ["Weekend Planning Companion ".padEnd(80, "W"), "周末 旅行 伙伴".repeat(5)];
  const botIds: string[] = [];
  for (const name of names) {
    const bot = await rpc<{ id: string }>(page, "bots/create", {
      name,
      title: "",
      description: "",
      notifyOnFinish: true,
    });
    botIds.push(bot.id);
  }
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Long name companions",
    botIds,
  });
  await page.goto(`/app/g/${group.id}`);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  const composer = page.getByRole("combobox", {
    name: "Message Long name companions",
    exact: true,
  });
  const bar = page.getByTestId("composer-bar");
  for (const [index, query] of ["@Weekend Planning", "@周末 旅行"].entries()) {
    await composer.fill(query);
    const picker = page.getByTestId("mention-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("option")).toHaveCount(1);
    await picker.getByRole("option", { name: `@${names[index]}`, exact: true }).click();
    await expect(composer).toHaveValue("");
  }
  await expect(bar).toHaveAttribute("data-expanded", "true");
  const prefix = bar.getByTestId("composer-mentions");
  const chips = prefix.getByTestId("mention-chip");
  await expect(chips).toHaveCount(2);
  for (const chip of await chips.all()) {
    await expectWithin(prefix, chip);
    await expectMentionAvatar(chip);
    await chip.hover();
    const remove = chip.getByRole("button");
    await expect(remove).toBeVisible();
    await expectWithin(prefix, remove);
  }
  await captureScreenshot(page, testInfo, "mention-long-empty-auto-expanded-800");

  await composer.fill("A quiet afternoon.");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("请一起慢慢安排。");
  const body = "A quiet afternoon.\n请一起慢慢安排。";
  const fileName = `${"周末慢慢走 Weekend shared plans 旅行记录 ".padEnd(60, "W")}.pdf`;
  await bar.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
  });
  await expect(bar.getByTestId("attachment-preview")).toHaveCount(1);
  await expect(composer).toHaveValue(body);
  await captureScreenshot(page, testInfo, "mention-long-multiline-file-800");

  try {
    const [request] = await Promise.all([
      page.waitForRequest((request) => request.url().endsWith("/rpc/threads/send")),
      composer.press("Enter"),
    ]);
    const payload = (
      request.postDataJSON() as {
        json: {
          groupId: string;
          botId?: string;
          text: string;
          mentions: unknown[];
          artifactIds: string[];
        };
      }
    ).json;
    expect(payload.groupId).toBe(group.id);
    expect(payload.botId).toBeUndefined();
    expect(payload.mentions).toEqual(botIds.map((id) => ({ kind: "bot", id })));
    expect(payload.text).toBe(`${names.map((name) => `@${name}`).join(" ")} ${body}`);
    expect(payload.artifactIds).toHaveLength(1);
    await expect(composer).toHaveValue("");
    const transcript = page.getByTestId("transcript");
    const bubble = transcript.getByTestId("message-user-bubble").filter({ hasText: body });
    await expect(bubble).toHaveText(payload.text);
    for (const [index, id] of botIds.entries()) {
      const mention = bubble.locator(`[data-testid="message-mention"][data-mention-id="${id}"]`);
      await expect(mention).toHaveText(`@${names[index]}`);
      await expectMentionAvatar(mention);
    }
    await expect
      .poll(
        async () => {
          const history = await rpc<{
            messages: Array<{
              role: string;
              botId?: string;
              blocks: Array<{ kind: string; text?: string }>;
            }>;
          }>(page, "threads/messages", { groupId: group.id });
          return [
            ...new Set(
              history.messages
                .filter(
                  (message) =>
                    message.role === "bot" &&
                    message.blocks.some((block) => block.kind === "text" && block.text?.trim()),
                )
                .map((message) => message.botId),
            ),
          ].sort();
        },
        { timeout: 60_000 },
      )
      .toEqual([...botIds].sort());
    const stored = await rpc<{
      messages: Array<{
        id: string;
        role: string;
        botId?: string;
        blocks: Array<{ kind: string; text?: string; name?: string; artifactId?: string }>;
      }>;
    }>(page, "threads/messages", { groupId: group.id });
    const userMessages = stored.messages.filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "text", text: payload.text }),
        expect.objectContaining({
          kind: "file",
          name: fileName,
          artifactId: payload.artifactIds[0],
        }),
      ]),
    );
    const preview = transcript.getByRole("button", { name: `Preview ${fileName}`, exact: true });
    await preview.scrollIntoViewIfNeeded();
    await expect(preview.getByText(fileName, { exact: true })).toHaveAttribute("title", fileName);
    await expectWithin(transcript, preview.locator(".."));
    await expectWithin(
      transcript,
      transcript.getByRole("button", { name: `Download ${fileName}`, exact: true }),
    );
    await captureScreenshot(page, testInfo, "mention-long-sent-file-contained-800");

    const reply = stored.messages.find(
      (message) =>
        message.role === "bot" &&
        message.botId === botIds[0] &&
        message.blocks.some((block) => block.kind === "text" && block.text?.trim()),
    )!;
    const replyRow = transcript.locator(`[data-message-id="${reply.id}"]`);
    await replyRow.hover();
    await expect
      .poll(() =>
        replyRow.locator("time").evaluateAll(
          (times) =>
            times.filter((time) => {
              if (!time.getBoundingClientRect().width) return false;
              for (let element: Element | null = time; element; element = element.parentElement) {
                const style = getComputedStyle(element);
                if (
                  style.opacity === "0" ||
                  style.display === "none" ||
                  style.visibility === "hidden"
                )
                  return false;
              }
              return true;
            }).length,
        ),
      )
      .toBe(1);
    const actions = replyRow.getByTestId("message-hover-actions");
    await expect(actions).toBeVisible();
    await expectWithin(transcript, actions);
    await captureScreenshot(page, testInfo, "mention-long-bot-hover-contained-800");
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await rpc(page, "threads/stop", { groupId: group.id }).catch(() => undefined);
  }
});
