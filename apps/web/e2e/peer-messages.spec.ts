import { expect, test } from "@playwright/test";
import type { RunsListOutput, ThreadMessagePage, ThreadSnapshot } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("peer sources open a live exchange inside the same chat shell", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  const stamp = Date.now();
  await signup(page, `peer-msg-${stamp}@rakazo.test`, "password12", "Peer Msg");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  await rpc(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("message the bot named Researcher saying peer-exchange-alpha");
  await composer.press("Enter");
  await expect(page.getByText("messaging that bot now.").first()).toBeVisible({
    timeout: 60_000,
  });

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
        }>(page, "threads/messages", { botId: chiefId, includePeerRuns: true });
        const peerTexts = history.messages.flatMap((message) =>
          message.blocks
            .filter(
              (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
            )
            .map((block) => block.text ?? ""),
        );
        return peerTexts.some((text) => text.includes("peer-exchange-alpha"));
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  const transcript = page.getByTestId("transcript");
  const chip = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "Researcher" })
    .first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip.getByText(/Messaged|Message from/)).toBeVisible();
  await expect(chip).toHaveAccessibleName(/Messaged Researcher|Message from Researcher/);
  await expect(chip.locator(".rakazo-bot-avatar")).toBeVisible();
  await expect(chip).not.toContainText("{peer}");
  // User bubble still contains the phrase; peer body must not appear outside the chip.
  await expect(chip).not.toContainText("peer-exchange-alpha");
  await expect(transcript.getByText("peer-exchange-alpha")).toHaveCount(1);
  const assertChipLeftAligned = async () => {
    const columnBox = await transcript.getByTestId("conversation-column").boundingBox();
    const chipBox = await chip.boundingBox();
    expect(columnBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    // Source events follow the left Bot bubble lane inside the centered chat column.
    expect(Math.abs(chipBox!.x - columnBox!.x - 32)).toBeLessThanOrEqual(2);
    expect(chipBox!.width).toBeLessThan(columnBox!.width * 0.75);
  };

  await assertChipLeftAligned();
  await expect(composer).toBeVisible();
  await captureScreenshot(page, testInfo, "peer-chip-desktop");

  // The automatic alpha return creates another Chief run. The scripted test
  // executor does not claim steering, so finish that exact exchange before
  // sending the tail/stop/beta sequence used to exercise the live peer view.
  await expect
    .poll(
      async () => {
        const history = await rpc<ThreadMessagePage>(page, "threads/messages", {
          botId: chiefId,
          includePeerRuns: true,
        });
        const outbound = history.messages.find((message) =>
          message.blocks.some(
            (block) =>
              block.kind === "bot_message_sent" &&
              block.toBotName === "Researcher" &&
              block.text === "peer-exchange-alpha",
          ),
        );
        const returned =
          outbound &&
          history.messages.find(
            (message) =>
              message.replyToMessageId === outbound.id &&
              message.blocks.some(
                (block) =>
                  block.kind === "bot_message_received" &&
                  block.fromBotName === "Researcher" &&
                  block.intent === "result",
              ),
          );
        if (!returned?.runId) return false;
        const [runs, snapshot] = await Promise.all([
          rpc<RunsListOutput>(page, "runs/list", { filter: "recent" }),
          rpc<ThreadSnapshot>(page, "threads/get", { botId: chiefId }),
        ]);
        return (
          runs.runs.some((run) => run.runId === returned.runId && run.status === "completed") &&
          !(snapshot.activeRuns ?? []).some((run) => run.botId === chiefId)
        );
      },
      { timeout: 60_000, message: "the exact alpha return must finish before another Chief input" },
    )
    .toBe(true);

  // Put the source event above a real stored tail so returning from peer chat
  // must restore a reading position, rather than trivially restoring scroll 0.
  const tailMarker = `peer-reading-tail-${stamp}`;
  await rpc(page, "threads/send", {
    botId: chiefId,
    text: `${tailMarker}\n${"Leave room for another quiet thought.\n".repeat(40)}`,
    clientNonce: tailMarker,
  });
  await rpc(page, "threads/stop", { botId: chiefId });
  await expect(
    transcript.getByTestId("message-user-bubble").filter({ hasText: tailMarker }),
  ).toBeVisible();
  await chip.scrollIntoViewIfNeeded();
  await chip.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) => element.scrollTop + element.clientHeight < element.scrollHeight - 40,
      ),
    )
    .toBe(true);
  await composer.fill("Keep this thought while I read their exchange.");
  const parentScrollTop = await transcript.evaluate((element) => element.scrollTop);
  await chip.click();
  const view = page.getByTestId("peer-conversation-view");
  await expect(view).toBeVisible();
  await expect(page.getByTestId("bots-sidebar")).toBeVisible();
  await expect(view.getByRole("heading", { name: /Chief.*Researcher/ })).toBeVisible();
  await expect(
    view.getByTestId("peer-conversation-header").locator(".rakazo-bot-avatar"),
  ).toHaveCount(2);
  await expect(view.getByRole("dialog")).toHaveCount(0);
  await expect(view.getByText("This chat is view-only")).toHaveCount(0);
  await expect(view.getByRole("button", { name: "Close chat", exact: true })).toHaveCount(1);
  await expect(composer).toBeHidden();
  await expect(view.getByText("peer-exchange-alpha").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(view.getByRole("textbox")).toHaveCount(0);
  await expect(view.getByText("Loading…", { exact: true })).toHaveCount(0);
  const peerTranscript = view.getByTestId("peer-conversation-transcript");
  await peerTranscript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      peerTranscript.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      ),
    )
    .toBe(true);
  // A real second peer run must appear through the existing live subscription,
  // without reopening this view or reloading the page.
  await rpc(page, "threads/send", {
    botId: chiefId,
    text: "message the bot named Researcher saying peer-exchange-beta",
    clientNonce: `peer-live-${stamp}`,
  });
  await expect(peerTranscript.getByText("peer-exchange-beta", { exact: true }).first()).toBeVisible(
    {
      timeout: 60_000,
    },
  );
  await expect(peerTranscript.locator(".rakazo-bot-avatar").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "peer-same-shell-live");

  await view.getByRole("button", { name: "Close chat", exact: true }).click();
  await expect(view).toHaveCount(0);
  await expect(composer).toHaveValue("Keep this thought while I read their exchange.");
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBe(parentScrollTop);
  await expect(page.getByTestId("bots-sidebar")).toBeVisible();
  await captureScreenshot(page, testInfo, "peer-return-keeps-draft");
  expect(browserErrors).toEqual([]);
});

test("group peer sources combine stored group sends and live direct replies without losing the group draft", async ({
  page,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  const stamp = Date.now();
  await signup(page, `group-peer-${stamp}@rakazo.test`, "password12", "Group Peer");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const researcher = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    computerMode: "team",
    notifyOnFinish: true,
  });
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Companion group",
    botIds: [chiefId, researcher.id],
  });
  await page.goto(`/app/g/${group.id}`);
  const groupUrl = page.url();
  const composer = page.getByRole("combobox", { name: "Message Companion group" });
  await expect(composer).toBeVisible();

  type Receipt = { key: string; id: string; text: string; seq: number };
  const readReceipt = async (
    target: { botId: string } | { groupId: string },
    direction: "sent" | "received",
    text?: string,
    excludedIds: Set<string> = new Set(),
  ): Promise<Receipt | undefined> => {
    const history = await rpc<ThreadMessagePage>(page, "threads/messages", {
      ...target,
      includePeerRuns: true,
    });
    for (const message of history.messages) {
      if (excludedIds.has(message.id)) continue;
      for (const [index, block] of message.blocks.entries()) {
        const matches =
          direction === "sent"
            ? block.kind === "bot_message_sent" &&
              block.toBotId === researcher.id &&
              message.botId === chiefId
            : block.kind === "bot_message_received" && block.fromBotId === researcher.id;
        if (
          matches &&
          (block.kind === "bot_message_sent" || block.kind === "bot_message_received") &&
          (text === undefined || block.text === text)
        ) {
          return {
            key: `${message.threadId}:${message.id}:${index}`,
            id: message.id,
            text: block.text,
            seq: message.seq,
          };
        }
      }
    }
    return undefined;
  };
  const sendGroupRequest = (marker: string) =>
    rpc(page, "threads/send", {
      groupId: group.id,
      text: `message the bot named Researcher saying ${marker}`,
      mentions: [{ kind: "bot", id: chiefId }],
      clientNonce: marker,
    });
  const alpha = `group-peer-alpha-${stamp}`;
  await sendGroupRequest(alpha);
  let firstSend: Receipt | undefined;
  let firstReply: Receipt | undefined;
  await expect
    .poll(
      async () => {
        firstSend = await readReceipt({ groupId: group.id }, "sent", alpha);
        return Boolean(firstSend);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () => {
        firstReply = await readReceipt({ botId: chiefId }, "received");
        return Boolean(firstReply);
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  const transcript = page.getByTestId("transcript");
  const chip = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "Researcher" })
    .first();
  await expect(chip).toHaveAccessibleName("Messaged Researcher");
  await composer.fill("Keep this group thought while I read their exchange.");
  const originSubscription = page.waitForRequest(
    (request) =>
      request.url().includes("/rpc/threads/subscribe") &&
      Boolean(request.postData()?.includes(chiefId)),
  );
  await chip.click();
  await originSubscription;
  const view = page.getByTestId("peer-conversation-view");
  const peerTranscript = view.getByTestId("peer-conversation-transcript");
  await expect(view).toBeVisible();
  await expect(page).toHaveURL(groupUrl);
  await expect(page.getByTestId("bots-sidebar")).toBeVisible();
  await expect(view.getByRole("heading", { name: /Chief.*Researcher/ })).toBeVisible();
  await expect(
    view.getByTestId("peer-conversation-header").locator(".rakazo-bot-avatar"),
  ).toHaveCount(2);
  await expect(view.getByRole("dialog")).toHaveCount(0);
  await expect(view.getByRole("textbox")).toHaveCount(0);
  await expect(view.getByText("This chat is view-only")).toHaveCount(0);
  await expect(composer).toBeHidden();
  await expect(peerTranscript.locator(`[data-peer-message-id="${firstSend!.key}"]`)).toContainText(
    alpha,
  );
  await expect(peerTranscript.locator(`[data-peer-message-id="${firstReply!.key}"]`)).toContainText(
    firstReply!.text,
  );
  await captureScreenshot(page, testInfo, "group-peer-stored-history");

  // The next outbound is stored in the group, while its asynchronous return is
  // stored in Chief's direct thread. Both must update this already-open view.
  const beta = `group-peer-beta-${stamp}`;
  const previousReplyIds = new Set([firstReply!.id]);
  await sendGroupRequest(beta);
  let nextSend: Receipt | undefined;
  let nextReply: Receipt | undefined;
  await expect
    .poll(
      async () => {
        nextSend = await readReceipt({ groupId: group.id }, "sent", beta);
        return Boolean(nextSend);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () => {
        nextReply = await readReceipt({ botId: chiefId }, "received", undefined, previousReplyIds);
        return Boolean(nextReply);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect(peerTranscript.locator(`[data-peer-message-id="${nextSend!.key}"]`)).toHaveCount(1);
  await expect(peerTranscript.locator(`[data-peer-message-id="${nextSend!.key}"]`)).toContainText(
    beta,
  );
  await expect(peerTranscript.locator(`[data-peer-message-id="${nextReply!.key}"]`)).toHaveCount(1);
  await expect(peerTranscript.locator(`[data-peer-message-id="${nextReply!.key}"]`)).toContainText(
    nextReply!.text,
  );
  await expect(
    peerTranscript
      .locator(`[data-peer-message-id="${nextReply!.key}"]`)
      .getByText("Researcher", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(groupUrl);
  await captureScreenshot(page, testInfo, "group-peer-live-direct-return");

  await rpc(page, "threads/clear", { botId: chiefId });
  const cleared = await rpc<ThreadSnapshot>(page, "threads/get", { botId: chiefId });
  await expect(peerTranscript.locator(`[data-peer-message-id="${firstReply!.key}"]`)).toHaveCount(
    0,
  );
  await expect(peerTranscript.locator(`[data-peer-message-id="${nextReply!.key}"]`)).toHaveCount(0);
  await expect(peerTranscript.locator(`[data-peer-message-id="${firstSend!.key}"]`)).toContainText(
    alpha,
  );
  await expect(peerTranscript.locator(`[data-peer-message-id="${nextSend!.key}"]`)).toContainText(
    beta,
  );
  // Clearing one direct conversation leaves its group's requests in this view.
  // Current APIs keep message sequences independent from the clear event cursor.
  const gamma = `group-peer-after-clear-${stamp}`;
  await sendGroupRequest(gamma);
  let freshReply: Receipt | undefined;
  await expect
    .poll(
      async () => {
        freshReply = await readReceipt({ botId: chiefId }, "received");
        return Boolean(freshReply);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  expect(freshReply!.seq).toBeLessThan(cleared.cursor);
  await expect(peerTranscript.locator(`[data-peer-message-id="${freshReply!.key}"]`)).toContainText(
    freshReply!.text,
  );
  await expect(peerTranscript.locator(`[data-peer-message-id="${firstReply!.key}"]`)).toHaveCount(
    0,
  );
  await expect(peerTranscript.locator(`[data-peer-message-id="${nextReply!.key}"]`)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "group-peer-live-after-direct-clear");

  await view.getByRole("button", { name: "Close chat", exact: true }).click();
  await expect(view).toHaveCount(0);
  await expect(composer).toHaveValue("Keep this group thought while I read their exchange.");
  await expect(page.getByTestId("bots-sidebar")).toBeVisible();
  await captureScreenshot(page, testInfo, "group-peer-return-keeps-draft");
  expect(browserErrors).toEqual([]);
});
