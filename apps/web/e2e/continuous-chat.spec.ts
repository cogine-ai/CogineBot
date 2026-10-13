import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

type SendPayload = {
  botId?: string;
  groupId?: string;
  text?: string;
  clientNonce?: string;
  artifactIds?: string[];
  mentions?: Array<{ kind: string; id: string }>;
  replyToMessageId?: string;
  replyQuote?: string;
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
  expect.soft(errors, "continuous chat has no browser exceptions or console errors").toEqual([]);
});

async function openChat(page: Page, label: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signup(page, `${label}-${Date.now()}@rakazo.test`, "password12", "Chat Review");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  await expect(composer).toBeEditable();
  return { chiefId: activeBotId(page), composer };
}

async function switchBot(page: Page, botId: string, name: string) {
  await page.getByTestId("bots-sidebar").locator(`[data-roster-bot-id="${botId}"]`).click();
  const composer = page.getByRole("combobox", { name: `Message ${name}`, exact: true });
  await expect(composer).toBeEditable();
  return composer;
}

async function composerGeometry(composer: Locator) {
  return composer.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    const style = getComputedStyle(input);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const verticalChrome =
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom) +
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderBottomWidth);
    const height = input.getBoundingClientRect().height;
    return {
      rows: Math.round((height - verticalChrome) / lineHeight),
      height,
      lineHeight,
      verticalChrome,
      fontSize: Number.parseFloat(style.fontSize),
      clientHeight: input.clientHeight,
      scrollHeight: input.scrollHeight,
      scrollTop: input.scrollTop,
      clientWidth: input.clientWidth,
      scrollWidth: input.scrollWidth,
    };
  });
}

async function expectComposerRows(page: Page, composer: Locator, rows: number) {
  await expect.poll(async () => (await composerGeometry(composer)).rows).toBe(rows);
  const geometry = await composerGeometry(composer);
  expect(geometry.lineHeight).toBeGreaterThan(0);
  expect(geometry.fontSize).toBe(14);
  expect(geometry.height).toBeLessThanOrEqual(
    6 * geometry.lineHeight + geometry.verticalChrome + 1,
  );
  await expect
    .poll(async () =>
      Math.round((await page.getByTestId("composer-bar").boundingBox())?.height ?? 0),
    )
    .toBeGreaterThanOrEqual(48);
  await expect(composer).not.toHaveAttribute("wrap", "off");
}

async function expectSingleLine(page: Page, composer: Locator) {
  await expectComposerRows(page, composer, 1);
}

async function expectExpandedComposerLayout(page: Page, composer: Locator) {
  const bar = page.getByTestId("composer-bar");
  await expect(bar).toHaveAttribute("data-expanded", "true");
  const barBox = await bar.boundingBox();
  const inputBox = await composer.boundingBox();
  expect(barBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  const insets = await bar.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      left: Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth),
      right: Number.parseFloat(style.paddingRight) + Number.parseFloat(style.borderRightWidth),
    };
  });
  expect(Math.abs(inputBox!.x - barBox!.x - insets.left)).toBeLessThan(1);
  expect(
    Math.abs(inputBox!.x + inputBox!.width - barBox!.x - barBox!.width + insets.right),
  ).toBeLessThan(1);
  for (const name of ["Attach file", "Send"]) {
    const controlBox = await bar.getByRole("button", { name, exact: true }).boundingBox();
    expect(controlBox).not.toBeNull();
    expect(controlBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height - 1);
    expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(barBox!.y + barBox!.height);
  }
}

async function expectInlineComposerLayout(page: Page, composer: Locator) {
  const bar = page.getByTestId("composer-bar");
  await expect(bar).toHaveAttribute("data-expanded", "false");
  await expectSingleLine(page, composer);
  await expect.poll(async () => (await bar.boundingBox())?.height).toBe(48);
  const inputBox = await composer.boundingBox();
  expect(inputBox).not.toBeNull();
  for (const name of ["Attach file", "Send"]) {
    const controlBox = await bar.getByRole("button", { name, exact: true }).boundingBox();
    expect(controlBox).not.toBeNull();
    expect(
      Math.abs(controlBox!.y + controlBox!.height / 2 - inputBox!.y - inputBox!.height / 2),
    ).toBeLessThan(1);
  }
}

test("composer grows to six rows, retains drafts and raw line breaks, and safely sends with Enter", async ({
  page,
  context,
}, testInfo) => {
  const pageErrors: string[] = [];
  const windowErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.exposeFunction("recordComposerWindowError", (message: string) => {
    windowErrors.push(message);
  });
  await page.addInitScript(() => {
    // Observe browser ErrorEvents directly. ResizeObserver delivery errors may
    // not become pageerror events.
    window.addEventListener(
      "error",
      (event: Event) => {
        const message =
          event instanceof ErrorEvent
            ? event.message
            : `${event.type}: ${(event.target as Element | null)?.tagName ?? "Window"}`;
        void (
          window as unknown as {
            recordComposerWindowError: (message: string) => Promise<void>;
          }
        ).recordComposerWindowError(message);
      },
      true,
    );
  });
  const { chiefId, composer } = await openChat(page, "one-line");
  const submissions: SendPayload[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/threads/send")) {
      submissions.push((request.postDataJSON() as { json: SendPayload }).json);
    }
  });
  await expectSingleLine(page, composer);

  await composer.dispatchEvent("compositionstart", { data: "陪" });
  await composer.fill("陪我聊一下");
  await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(composer).toHaveValue("陪我聊一下");
  expect(submissions).toEqual([]);
  await composer.dispatchEvent("compositionend", { data: "陪我聊一下" });

  await composer.fill("w");
  await expectInlineComposerLayout(page, composer);
  const threshold = await composer.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D text measurement is unavailable");
    context.font = style.font;
    const inlineContentWidth =
      element.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    let overflowing = "w";
    while (context.measureText(overflowing).width <= inlineContentWidth + 2) {
      overflowing += "w";
    }
    const fitting = overflowing.slice(0, -2);
    return {
      overflowing,
      fitting,
      inlineContentWidth,
      overflowWidth: context.measureText(overflowing).width,
      fittingWidth: context.measureText(fitting).width,
    };
  });
  expect(threshold.overflowWidth).toBeGreaterThan(threshold.inlineContentWidth);
  expect(threshold.fittingWidth).toBeLessThan(threshold.inlineContentWidth);
  await composer.fill(threshold.overflowing);
  // Borderline text wraps at the compact width, but fits on the expanded row.
  // The independent buttons row must stay open while the visible field has one line.
  await expectSingleLine(page, composer);
  await expectExpandedComposerLayout(page, composer);
  const stableFrames = await composer.evaluate(async (element) => {
    const input = element as HTMLTextAreaElement;
    const bar = input.closest('[data-testid="composer-bar"]');
    if (!bar) throw new Error("composer bar not found");
    const frames: Array<{ expanded: string | null; rows: number; text: string }> = [];
    for (let index = 0; index < 18; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const style = getComputedStyle(input);
      const chrome =
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom) +
        Number.parseFloat(style.borderTopWidth) +
        Number.parseFloat(style.borderBottomWidth);
      frames.push({
        expanded: bar.getAttribute("data-expanded"),
        rows: Math.round(
          (input.getBoundingClientRect().height - chrome) / Number.parseFloat(style.lineHeight),
        ),
        text: input.value,
      });
    }
    return frames;
  });
  expect(stableFrames).toEqual(
    Array.from({ length: 18 }, () => ({
      expanded: "true",
      rows: 1,
      text: threshold.overflowing,
    })),
  );
  await captureScreenshot(page, testInfo, "continuous-chat-stable-borderline-wrap");
  await composer.press("Backspace");
  await composer.press("Backspace");
  await expect(composer).toHaveValue(threshold.fitting);
  await expectInlineComposerLayout(page, composer);
  expect(submissions).toEqual([]);

  await composer.fill("First thought.");
  await expectInlineComposerLayout(page, composer);
  await composer.press("Shift+Enter");
  await composer.pressSequentially("Second thought.");
  await expect(composer).toHaveValue("First thought.\nSecond thought.");
  await expectComposerRows(page, composer, 2);
  await expectExpandedComposerLayout(page, composer);
  for (let row = 3; row <= 6; row += 1) {
    await composer.press("Shift+Enter");
    await composer.pressSequentially(`Thought ${row}.`);
    await expectComposerRows(page, composer, row);
  }
  const sixLineDraft = await composer.inputValue();
  const sixLineHeight = (await composerGeometry(composer)).height;
  await expectExpandedComposerLayout(page, composer);
  await captureScreenshot(page, testInfo, "continuous-chat-six-row-draft");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("Thought 7, inside the scroll area.");
  await expectComposerRows(page, composer, 6);
  await expect
    .poll(async () => {
      const geometry = await composerGeometry(composer);
      return geometry.scrollHeight - geometry.clientHeight;
    })
    .toBeGreaterThan(0);
  await expect.poll(async () => (await composerGeometry(composer)).scrollTop).toBeGreaterThan(0);
  expect(submissions).toEqual([]);
  await composer.evaluate((element, savedLength) => {
    const input = element as HTMLTextAreaElement;
    input.setSelectionRange(savedLength, input.value.length);
  }, sixLineDraft.length);
  await composer.press("Backspace");
  await expect(composer).toHaveValue(sixLineDraft);
  await expectComposerRows(page, composer, 6);
  await expect(composer).toHaveCSS("overflow-y", "hidden");
  expect((await composerGeometry(composer)).height).toBe(sixLineHeight);
  await expect
    .poll(async () => {
      const geometry = await composerGeometry(composer);
      return geometry.scrollHeight - geometry.clientHeight;
    })
    .toBeLessThanOrEqual(1);
  await composer.fill("");
  await expectInlineComposerLayout(page, composer);

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const text = "Let's keep this for later.\n\nconst place = 'a quiet cafe';\nTake our time.";
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await composer.fill("");
  await composer.click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(composer).toHaveValue(text);
  await expectComposerRows(page, composer, 4);
  await expectExpandedComposerLayout(page, composer);
  await captureScreenshot(page, testInfo, "continuous-chat-multiline-pasted-draft");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]?.text).toBe(text);
  await expect(composer).toHaveValue("");
  await expectInlineComposerLayout(page, composer);
  const history = await rpc<{
    messages: Array<{ role: string; blocks: Array<{ kind: string; text?: string }> }>;
  }>(page, "threads/messages", { botId: chiefId });
  expect(
    history.messages.some(
      (message) =>
        message.role === "user" &&
        message.blocks.some((block) => block.kind === "text" && block.text === text),
    ),
  ).toBe(true);

  // Size a plain sentence to the actual field width; soft wrapping is visual
  // and must never introduce newlines into the payload.
  const naturallyWrapped = await composer.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D text measurement is unavailable");
    context.font = `${style.fontSize} ${style.fontFamily}`;
    const contentWidth =
      element.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    let sentence = "A longer thought, with room to breathe. ";
    // Span enough of the wide row to add another row at the 800 px desktop,
    // accounting for the expanded field filling the former button columns.
    while (context.measureText(sentence).width < contentWidth * 1.6) {
      sentence += "A longer thought, with room to breathe. ";
    }
    return sentence;
  });
  expect(naturallyWrapped).not.toContain("\n");
  await composer.fill(naturallyWrapped);
  await expectComposerRows(page, composer, 2);
  await expectExpandedComposerLayout(page, composer);
  await expect(composer).toHaveValue(naturallyWrapped);
  await captureScreenshot(page, testInfo, "continuous-chat-natural-wrap");

  await page.setViewportSize({ width: 800, height: 700 });
  await expect.poll(async () => (await composerGeometry(composer)).rows).toBeGreaterThan(2);
  const narrowRows = (await composerGeometry(composer)).rows;
  await expectComposerRows(page, composer, narrowRows);
  await expectExpandedComposerLayout(page, composer);
  await expect(composer).toHaveValue(naturallyWrapped);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expectComposerRows(page, composer, 2);
  await expect(composer).toHaveValue(naturallyWrapped);
  await page.setViewportSize({ width: 800, height: 700 });
  await expectComposerRows(page, composer, narrowRows);
  await expect(composer).toHaveValue(naturallyWrapped);
  const composerBox = await composer.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(800);
  expect((await composerGeometry(composer)).scrollWidth).toBeLessThanOrEqual(
    (await composerGeometry(composer)).clientWidth + 1,
  );
  await captureScreenshot(page, testInfo, "continuous-chat-800-natural-wrap");

  const partner = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    notifyOnFinish: true,
  });
  await expect(
    page.getByTestId("bots-sidebar").locator(`[data-roster-bot-id="${partner.id}"]`),
  ).toBeVisible();
  const partnerComposer = await switchBot(page, partner.id, "Researcher");
  await expect(partnerComposer).toHaveValue("");
  await expectInlineComposerLayout(page, partnerComposer);
  await partnerComposer.fill("Researcher's own short draft.");
  await expectInlineComposerLayout(page, partnerComposer);
  await switchBot(page, chiefId, "Chief");
  await expect(composer).toHaveValue(naturallyWrapped);
  await expectComposerRows(page, composer, narrowRows);
  await expectExpandedComposerLayout(page, composer);
  await captureScreenshot(page, testInfo, "continuous-chat-restored-draft-height");
  await composer.fill("");
  await expectInlineComposerLayout(page, composer);
  await switchBot(page, partner.id, "Researcher");
  await expect(partnerComposer).toHaveValue("Researcher's own short draft.");
  expect(submissions).toHaveLength(1);
  // Let resize delivery and its scheduled follow-up paint settle before the
  // strict error check; every window error remains a regression, with no filter.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  expect(pageErrors, "composer growth has no uncaught page exceptions").toEqual([]);
  expect(windowErrors, "composer growth has no browser window errors").toEqual([]);
});

test("Bot and group drafts retain attachments, mentions and reply when a receipt is lost", async ({
  page,
}, testInfo) => {
  const { chiefId } = await openChat(page, "chat-draft");
  const partner = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    notifyOnFinish: true,
  });
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Weekend companions",
    botIds: [chiefId, partner.id],
  });
  await rpc(page, "threads/send", {
    groupId: group.id,
    text: "Keep the afternoon free for coffee.",
    clientNonce: `draft-parent-${Date.now()}`,
  });
  await rpc(page, "threads/stop", { groupId: group.id });
  await page.goto(`/app/g/${group.id}`);
  const composer = page.getByRole("combobox", { name: "Message Weekend companions", exact: true });
  await expect(composer).toBeEditable();
  const parent = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: "Keep the afternoon free for coffee." })
    .first();
  await expect(parent).toBeVisible();
  const parentId = await parent.getAttribute("data-message-id");
  await parent.getByTestId("message-user-bubble").evaluate((element) => {
    const excerpt = "free for coffee";
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const index = node.textContent?.indexOf(excerpt) ?? -1;
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + excerpt.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      node = walker.nextNode();
    }
    throw new Error("quote excerpt not found");
  });
  const parentBox = await parent.boundingBox();
  expect(parentBox).not.toBeNull();
  await page.mouse.move(parentBox!.x + parentBox!.width / 2, parentBox!.y + parentBox!.height / 2);
  await page.mouse.up();
  await page.getByTestId("quote-selection").click();
  await expect(page.getByTestId("reply-chip")).toBeVisible();
  await expect(page.getByTestId("reply-chip")).toContainText("free for coffee");
  await composer.fill("@Res");
  await page.getByRole("option", { name: "@Researcher", exact: true }).click();
  await composer.fill("Bring these notes when we pick a place.");
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "weekend-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("One place, no hurry."),
    });
  await expect(page.getByRole("button", { name: "Remove weekend-notes.txt" })).toBeVisible();
  await expectSingleLine(page, composer);

  const chiefComposer = await switchBot(page, chiefId, "Chief");
  await expect(chiefComposer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove weekend-notes.txt" })).toHaveCount(0);
  await chiefComposer.fill("A separate thought for Chief.");
  await page
    .getByTestId("bots-sidebar")
    .getByRole("button", { name: /^Weekend companions/ })
    .click();
  await expect(composer).toHaveValue("Bring these notes when we pick a place.");
  await expect(page.getByRole("button", { name: "Remove weekend-notes.txt" })).toBeVisible();
  await expect(page.getByTestId("mention-chip").filter({ hasText: "Researcher" })).toBeVisible();
  await expect(page.getByTestId("reply-chip")).toBeVisible();
  await captureScreenshot(page, testInfo, "continuous-chat-group-restored-draft");

  const submissions: SendPayload[] = [];
  await page.route("**/rpc/threads/send", async (route) => {
    submissions.push((route.request().postDataJSON() as { json: SendPayload }).json);
    if (submissions.length !== 1) {
      await route.continue();
      return;
    }
    // Commit through the real API, then lose its acknowledgement. A successful
    // HTTP response with no RPC receipt exercises decoding failure without
    // introducing expected browser network errors into this regression.
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.fulfill({ status: 200, contentType: "application/json", body: "" });
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(composer).toHaveValue("Bring these notes when we pick a place.");
  await expect(page.getByRole("button", { name: "Remove weekend-notes.txt" })).toBeVisible();
  await expect(page.getByTestId("mention-chip")).toBeVisible();
  await expect(page.getByTestId("reply-chip")).toBeVisible();
  await captureScreenshot(page, testInfo, "continuous-chat-lost-receipt-keeps-payload");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("composer-error")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove weekend-notes.txt" })).toHaveCount(0);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[0]).toMatchObject({
    groupId: group.id,
    replyToMessageId: parentId,
    replyQuote: "free for coffee",
    mentions: [{ kind: "bot", id: partner.id }],
  });
  expect(submissions[0]?.clientNonce).toBeTruthy();
  expect(submissions[0]?.artifactIds).toHaveLength(1);
  const history = await rpc<{
    messages: Array<{ role: string; blocks: Array<{ kind: string; text?: string }> }>;
  }>(page, "threads/messages", { groupId: group.id });
  expect(
    history.messages.filter(
      (message) =>
        message.role === "user" &&
        message.blocks.some(
          (block) =>
            block.kind === "text" &&
            block.text?.includes("Bring these notes when we pick a place."),
        ),
    ),
  ).toHaveLength(1);
  await switchBot(page, chiefId, "Chief");
  await expect(chiefComposer).toHaveValue("A separate thought for Chief.");
});

test("late success clears only the submitted draft across a conversation switch", async ({
  page,
}, testInfo) => {
  const { chiefId, composer } = await openChat(page, "chat-late-success");
  const partner = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    notifyOnFinish: true,
  });
  await page.reload();
  await expect(composer).toBeEditable();
  let releaseResponse!: () => void;
  let responseCommitted!: () => void;
  const responseHeld = new Promise<void>((resolve) => {
    responseCommitted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route("**/rpc/threads/send", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    responseCommitted();
    await released;
    await route.fulfill({ response });
  });
  await composer.fill("First thought, already sent.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await responseHeld;
  await composer.fill("Another thought typed while the receipt is pending.");
  const partnerComposer = await switchBot(page, partner.id, "Researcher");
  await expect(partnerComposer).toHaveValue("");
  await partnerComposer.fill("Researcher's own unsent thought.");
  const delivered = page.waitForResponse(
    (response) => response.url().endsWith("/rpc/threads/send") && response.ok(),
  );
  releaseResponse();
  await delivered;
  await page.unroute("**/rpc/threads/send");
  await expect(partnerComposer).toHaveValue("Researcher's own unsent thought.");
  await switchBot(page, chiefId, "Chief");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(composer).toHaveValue("Another thought typed while the receipt is pending.");
  await expect(
    page
      .getByTestId("transcript")
      .getByTestId("message-user-bubble")
      .getByText("First thought, already sent.", { exact: true }),
  ).toBeVisible();
  await expectSingleLine(page, composer);
  await captureScreenshot(page, testInfo, "continuous-chat-late-success-preserves-new-draft");
});
