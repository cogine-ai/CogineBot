import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

test("a ?m= deep link jumps while the thread is streaming", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `jump-${stamp}@rakazo.test`, "password12", "Jump Tester");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /Message/ });
  const rows = transcript.locator("[data-message-id]");

  const targetText = `jump-target-${stamp}`;
  await composer.fill(targetText);
  await composer.press("Enter");
  const targetRow = rows
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: targetText })
    .first();
  await expect(targetRow).toBeVisible({ timeout: 20_000 });
  const messageId = await targetRow.getAttribute("data-message-id");
  if (!messageId) throw new Error("missing data-message-id");

  // Flood the thread: every successful send steers the run, so SSE events keep
  // committing urgent updates — the churn that previously starved the router's
  // navigation transition. Only completed sends count; a flood that cannot
  // land makes the streaming precondition below fail instead of passing
  // vacuously.
  let flooding = true;
  let sent = 0;
  const flood = Promise.all(
    Array.from({ length: 3 }, async (_, lane) => {
      let i = 0;
      while (flooding) {
        const nonce = `jf-${stamp}-${lane}-${i++}`;
        try {
          await rpc(page, "threads/send", {
            botId,
            text: `jump-flood-${stamp}-${lane}-${i}`,
            clientNonce: nonce,
          });
          sent++;
        } catch {
          // A rejected send contributes no churn; keep flooding and let the
          // precondition decide whether enough landed.
        }
      }
    }),
  );
  try {
    // Precondition: the stream is really committing — rows keep appearing.
    const rowsBefore = await rows.count();
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBeGreaterThan(rowsBefore);

    // The flood has pushed the target outside the viewport.
    await expect(targetRow).not.toBeInViewport({ timeout: 20_000 });
    const sentAtPush = sent;

    const aroundJump = page.waitForRequest(
      (request) => {
        if (new URL(request.url()).pathname !== "/rpc/threads/messages") return false;
        const input = request.postDataJSON()?.json as
          | { botId?: string; around?: { messageId?: string } }
          | undefined;
        return input?.botId === botId && input.around?.messageId === messageId;
      },
      { timeout: 15_000 },
    );
    await page.evaluate((id) => {
      history.pushState({}, "", `?m=${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, messageId);
    // The jump's finally strips this one-shot param as soon as the around-fetch
    // settles. toHaveURL only samples the current URL, so under load the first
    // poll can already miss ?m= and then retry a value that will not return.
    // The matching request proves the router observed this exact target. Read its
    // response from the same Request rather than racing a separate response event.

    // The jump lands mid-stream: the around-page fetch succeeds while sends
    // keep landing, and the target scrolls back into view. (The transcript
    // unfollows the tail for a jump; before that, follow commits could cancel
    // the scroll — asserting the viewport also guards that path.)
    const aroundRequest = await aroundJump;
    const aroundResponse = await aroundRequest.response();
    expect(aroundResponse?.status()).toBe(200);
    await expect.poll(() => sent, { timeout: 10_000 }).toBeGreaterThan(sentAtPush);
    await expect(targetRow).toBeInViewport({ timeout: 20_000 });

    // The one-shot param is stripped so a refresh does not re-jump.
    await expect(page).not.toHaveURL(/[?&]m=/, { timeout: 20_000 });
  } finally {
    flooding = false;
    await flood;
    await rpc(page, "threads/stop", { botId }).catch(() => {});
  }
});

test("cold and cross-thread deep links scroll to a target in complete history", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `jump-complete-${stamp}@rakazo.test`, "password12", "History Jump");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const targetText = `complete-jump-target-${stamp}`;
  await rpc(page, "threads/send", { botId, text: targetText, clientNonce: `target-${stamp}` });
  for (let index = 0; index < 14; index += 1) {
    await rpc(page, "threads/send", {
      botId,
      text: `complete-jump-filler-${index}-${stamp} ${"A later message keeps the earlier target outside the visible reading area. ".repeat(6)}`,
      clientNonce: `complete-${stamp}-${index}`,
    });
  }
  await rpc(page, "threads/stop", { botId });
  const target = await rpc<{
    threadId: string;
    cursor: number;
    olderCursor: number | null;
    messages: Array<{ id: string; role: string; blocks: Array<{ kind: string; text?: string }> }>;
  }>(page, "threads/get", { botId });
  expect(target.olderCursor).toBeNull();
  const messageId = target.messages.find(
    (message) =>
      message.role === "user" && message.blocks.some((block) => block.text === targetText),
  )?.id;
  if (!messageId) throw new Error("missing complete-history target");
  const row = page.getByTestId("transcript").locator(`[data-message-id="${messageId}"]`);
  await expect(page.getByTestId("transcript")).toContainText(`complete-jump-filler-13-${stamp}`);
  await expect(row).toHaveCount(1);
  await expect(row).not.toBeInViewport();

  await page.goto(`/app/${botId}?m=${messageId}`);
  await expect(row).toBeInViewport();
  await expect(page).not.toHaveURL(/[?&]m=/);
  // An idle thread sends its first heartbeat after 20s; allow startup overhead.
  await expect(page.getByTestId("connection-status")).toHaveCount(0, { timeout: 30_000 });
  await captureScreenshot(page, testInfo, "b31-jump-cold");

  const otherId = await createNamedBot(page, "Other jump");
  const other = await rpc<{ threadId: string; cursor: number }>(page, "threads/get", {
    botId: otherId,
  });
  expect(other.threadId).not.toBe(target.threadId);
  expect(other.cursor).toBeLessThan(target.cursor);
  await page.evaluate((url) => {
    history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/app/${botId}?m=${messageId}`);
  await expect(row).toBeInViewport();
  await expect(page).not.toHaveURL(/[?&]m=/);
  await expect(page.getByTestId("connection-status")).toHaveCount(0, { timeout: 30_000 });
  await captureScreenshot(page, testInfo, "b31-jump-cross");
});
