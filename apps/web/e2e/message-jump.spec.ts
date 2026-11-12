import type { Request } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ThreadSnapshot } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

test("history sources open the original chat and clear an archived source", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.VERIFY_DATABASE !== "1" ||
      !process.env.DATABASE_URL ||
      !process.env.VERIFY_ISOLATED_DATABASE,
    "Requires the isolated verification database",
  );
  await signup(page, `history-source-${Date.now()}@example.test`, "password12", "History Tester");
  await completeOnboarding(page);
  const activeBot = activeBotId(page);
  const pastBot = await createNamedBot(page, "Project planning");
  const original = await rpc<ThreadSnapshot>(page, "threads/get", { botId: pastBot });
  const current = await rpc<ThreadSnapshot>(page, "threads/get", { botId: activeBot });
  const connection = new URL(process.env.DATABASE_URL!);
  expect(process.env.SANDBOX_PROVIDER).toBe("fake");
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(connection.hostname);
  expect(Number(connection.port)).toBeGreaterThan(1024);
  expect(connection.port).not.toBe("5432");
  expect(connection.pathname).toBe(`/${process.env.VERIFY_ISOLATED_DATABASE}`);
  expect(connection.search).toBe("");
  const { createDb, createThreadMessageInTransaction } = await import(
    "../../../packages/db/src/index"
  );
  const db = createDb(connection.toString(), {
    poolMax: 1,
    applicationName: "history-browser-fixture",
  });
  let originalId: string;
  try {
    const [identity] = await db.prisma.$queryRaw<
      Array<{ name: string }>
    >`SELECT current_database() AS name`;
    expect(identity?.name).toBe(process.env.VERIFY_ISOLATED_DATABASE);
    originalId = await db.prisma.$transaction(async (tx) => {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: original.threadId,
        role: "user",
        blocks: [{ kind: "text", text: "The rollout starts with 37 units." }],
      });
      await createThreadMessageInTransaction(tx, {
        threadId: current.threadId,
        botId: activeBot,
        role: "bot",
        blocks: [
          { kind: "text", text: "I found the rollout decision." },
          {
            kind: "history_sources",
            references: [{ threadId: original.threadId, messageId: message.id }],
          },
        ],
      });
      return message.id;
    });
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }

  await page.goto(`/app/${activeBot}`);
  const transcript = page.getByTestId("transcript");
  const captureHistoryScreenshot = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    await transcript.screenshot({ animations: "disabled", caret: "hide", path });
    await testInfo.attach(name, { contentType: "image/png", path });
  };
  const open = transcript.getByRole("button", { name: "View original message" });
  await expect(open).toBeVisible();
  await expect(
    transcript.getByText("The rollout starts with 37 units.", { exact: true }),
  ).toBeVisible();
  await captureHistoryScreenshot("history-source-card");
  const sourceRequest = "**/rpc/threads/historySources";
  const stalledCheck = Promise.withResolvers<void>();
  await page.route(
    sourceRequest,
    async (route) => {
      await stalledCheck.promise;
      await route.abort("timedout").catch(() => undefined);
    },
    { times: 1 },
  );
  const loadError = transcript.getByText("Could not load history sources.");
  try {
    await open.click();
    await expect(open).toBeDisabled();
    await captureHistoryScreenshot("history-source-checking");
    await expect(loadError).toBeVisible();
  } finally {
    stalledCheck.resolve();
  }
  await expect(
    transcript.getByText("The rollout starts with 37 units.", { exact: true }),
  ).toBeVisible();
  await captureHistoryScreenshot("history-source-retry");
  await transcript.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(loadError).toHaveCount(0);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/app/${pastBot}(?:[?]|$)`));
  await expect(transcript.locator(`[data-message-id="${originalId}"]`)).toContainText("37 units");

  await page.goto(`/app/${activeBot}`);
  await expect(open).toBeVisible();
  await rpc(page, "bots/archive", { botId: pastBot });
  await open.click();
  await expect(transcript.getByText("This history source is no longer available.")).toBeVisible();
  await expect(
    transcript.getByText("The rollout starts with 37 units.", { exact: true }),
  ).toHaveCount(0);
  await expect(transcript.getByText(/^Project planning ·/)).toHaveCount(0);
  await page.reload();
  await expect(transcript.getByText("This history source is no longer available.")).toBeVisible();
  await captureHistoryScreenshot("history-source-unavailable");
});

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
  let aroundRequest: Request | undefined;
  const observeAround = (request: Request) => {
    const url = new URL(request.url());
    if (
      aroundRequest ||
      request.method() !== "POST" ||
      url.origin !== new URL(page.url()).origin ||
      url.pathname !== "/rpc/threads/messages"
    )
      return;
    const input = request.postDataJSON()?.json as
      | { botId?: string; around?: { messageId?: string } }
      | undefined;
    if (input?.botId === botId && input.around?.messageId === messageId) aroundRequest = request;
  };
  try {
    // Precondition: the stream is really committing — rows keep appearing.
    const rowsBefore = await rows.count();
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBeGreaterThan(rowsBefore);

    // The flood has pushed the target outside the viewport.
    await expect(targetRow).not.toBeInViewport({ timeout: 20_000 });
    const sentAtPush = sent;

    page.on("request", observeAround);
    await page.evaluate((id) => {
      history.pushState({}, "", `?m=${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, messageId);
    // The jump's finally strips this one-shot param as soon as the around-fetch
    // settles. toHaveURL only samples the current URL, so under load the first
    // poll can already miss ?m= and then retry a value that will not return.
    // Capture before dispatch so a fast request cannot be missed. Start the
    // observation window once the browser has executed the navigation action;
    // queued browser commands must not consume that window. This is a functional
    // streaming check, not a navigation-latency benchmark.
    // Read the response from the same Request rather than racing a response event.

    // The jump lands mid-stream: the around-page fetch succeeds while sends
    // keep landing, and the target scrolls back into view. (The transcript
    // unfollows the tail for a jump; before that, follow commits could cancel
    // the scroll — asserting the viewport also guards that path.)
    await expect.poll(() => Boolean(aroundRequest), { timeout: 15_000 }).toBe(true);
    const aroundResponse = await aroundRequest!.response();
    expect(aroundResponse?.status()).toBe(200);
    await expect.poll(() => sent, { timeout: 10_000 }).toBeGreaterThan(sentAtPush);
    await expect(targetRow).toBeInViewport({ timeout: 20_000 });

    // The one-shot param is stripped so a refresh does not re-jump.
    await expect(page).not.toHaveURL(/[?&]m=/, { timeout: 20_000 });
  } finally {
    page.off("request", observeAround);
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
