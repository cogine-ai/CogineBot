import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { MessageBlock } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  expectActivityMode,
  openActivityMenu,
  rpc,
  signup,
} from "./helpers";

const EXPIRED_TAKEOVER = "Stopped. This was still waiting for you on the screen.";
const EXPIRED_MESSAGE_ID = "msg-stuck-expired";

type ThreadCarrier = {
  threadId?: string;
  cursor?: number;
  messages?: unknown[];
  thread?: ThreadCarrier;
};

/** Rendering fixture; separate PostgreSQL and unit tests exercise actual settlement. */
function injectThreadMessage(
  body: { json?: ThreadCarrier },
  message: {
    id: string;
    role: "bot" | "system";
    blocks: MessageBlock[];
  },
) {
  const targets = [body.json, body.json?.thread].filter((target): target is ThreadCarrier =>
    Boolean(target?.threadId && Array.isArray(target.messages)),
  );
  for (const target of targets) {
    const messages = target.messages ?? [];
    const messageId = message.id;
    if (
      messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "id" in message &&
          message.id === messageId,
      )
    ) {
      continue;
    }
    const seq = Math.max(target.cursor ?? 0, 0) + 1;
    target.cursor = seq;
    messages.push({
      id: message.id,
      threadId: target.threadId,
      seq,
      role: message.role,
      blocks: message.blocks,
      createdAt: new Date().toISOString(),
    });
  }
}

function activityRow(page: Page, botName: string) {
  return page.locator("aside").getByRole("button", {
    name: new RegExp(`^${botName}, `),
  });
}

for (const [kind, text] of [
  ["retired", "Slack authorization changed. Send a new message to continue."],
  [
    "unconfirmed",
    "Slack reply delivery could not be confirmed. Check the channel before sending a new message.",
  ],
] as const) {
  test(`${kind === "retired" ? "a retired" : "an unconfirmed"} Slack reply leaves a readable instruction`, async ({
    page,
  }, testInfo) => {
    await signup(
      page,
      `slack-retired-${Date.now()}@example.test`,
      "password12",
      "Messaging Recovery",
    );
    await completeOnboarding(page);
    await page.goto("/app");
    await page.waitForURL(/\/app\/[^/]+$/);
    // Rendering fixture only; PostgreSQL tests exercise the actual retirement.
    const inject = async (route: Parameters<Parameters<typeof page.route>[1]>[0]) => {
      const response = await route.fetch();
      const body = (await response.json()) as { json?: ThreadCarrier };
      injectThreadMessage(body, {
        id: EXPIRED_MESSAGE_ID,
        role: "system",
        blocks: [{ kind: "meta", text }],
      });
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        body: JSON.stringify(body),
      });
    };
    await page.route("**/rpc/bootstrap", inject);
    await page.route("**/rpc/threads/get", inject);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("combobox", { name: /^Message/ })).toBeEnabled();
    // An empty thread becomes ready after its first server heartbeat.
    await expect(page.getByTestId("connection-status")).not.toBeVisible({ timeout: 30_000 });
    await captureScreenshot(page, testInfo, `slack-${kind}-grant-status`);
  });
}

test("a loop stop preserves completed tools without crediting unfinished calls", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.showToolActivity", "on"));
  await signup(page, `loop-stop-tools-${Date.now()}@example.test`, "password12", "Tool Results");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const stopText =
    "I got stuck calling Message user with the same result 25 times in a row without making progress, so I stopped early. Try rephrasing this, or ask me to try a different approach.";
  const blocks: MessageBlock[] = [
    {
      kind: "steps",
      steps: [
        { label: "Saved file", count: 1, outcomes: { succeeded: 1 } },
        { label: "Rejected request", count: 1, outcomes: { failed: 1 } },
        { label: "Interrupted command", count: 1, outcomes: { stopped: 1 } },
        { label: "Unconfirmed result", count: 1 },
      ],
    },
    { kind: "text", text: stopText },
  ];
  const inject = async (route: Parameters<Parameters<typeof page.route>[1]>[0]) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: ThreadCarrier };
    injectThreadMessage(body, { id: "loop-stop-tools-result", role: "bot", blocks });
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  };
  await page.route("**/rpc/bootstrap", inject);
  await page.route("**/rpc/threads/get", inject);
  for (const viewport of [
    { name: "desktop-1440x900", width: 1440, height: 900 },
    { name: "mobile-390x844", width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText(stopText, { exact: true })).toBeVisible();
    const card = page.getByTestId("tool-activity");
    await expect(card.locator("summary")).toHaveText("4 tools");
    await card.locator("summary").click();
    const rows = card.getByTestId("tool-rows");
    for (const status of ["Succeeded", "Failed", "Stopped", "Result unknown"])
      await expect(rows.getByText(status, { exact: true })).toHaveCount(1);
    await expect(rows).not.toContainText("Working…");
    await captureScreenshot(page, testInfo, `loop-stop-tools-${viewport.name}`);
  }
});

test("a live grouped failure stays working until its remaining call settles", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.showToolActivity", "on"));
  for (const viewport of [
    { name: "desktop-1440x900", width: 1440, height: 900 },
    { name: "mobile-390x844", width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/e2e/fixtures/tool-activity.html?view=thread&phase=grouped-live");
    const rows = page.getByTestId("tool-rows");
    await expect(rows.getByText("Check conflicts ×2", { exact: true })).toBeVisible();
    await expect(rows.getByRole("status").filter({ hasText: "Working…" })).toHaveCount(1);
    await expect(rows.getByText("Failed", { exact: true })).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `live-grouped-outcome-${viewport.name}`);
  }
});

async function captureActivitySidebar(
  page: Page,
  testInfo: Parameters<typeof captureScreenshot>[1],
  name: string,
) {
  const aside = page.locator("aside").first();
  const box = await aside.boundingBox();
  if (box) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      path: screenshotPath,
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.min(box.width + 24, 360),
        height: Math.min(Math.max(box.height, 420), 720),
      },
    });
    await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
    return;
  }
  await captureScreenshot(page, testInfo, name);
}

test("aged queued work is marked and an expired wait leaves a status line", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `stuck-${stamp}@rakazo.test`, "password12", "Stuck");
  await completeOnboarding(page);

  const agedAt = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
  await page.route("**/rpc/runs/list", async (route) => {
    const body = route.request().postDataJSON() as { json?: { filter?: string } } | null;
    const runs =
      body?.json?.filter === "active"
        ? [
            {
              runId: "run-aged",
              botId: "bot-aged",
              botName: "Chief",
              groupId: null,
              groupName: null,
              threadId: "thread-aged",
              status: "queued",
              trigger: "user",
              notificationsEnabled: true,
              promptSnippet: "finish the report",
              updatedAt: agedAt,
            },
          ]
        : [];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { runs } }),
    });
  });

  await (await openActivityMenu(page)).click();
  await page.reload();
  await expectActivityMode(page, true);
  await expect(page.getByText("Loading activity…")).toBeHidden({ timeout: 20_000 });
  const row = activityRow(page, "Chief");
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("2d ago");
  await expect(row.locator(".text-warning").filter({ hasText: "Queued" })).toBeVisible();
  await captureActivitySidebar(page, testInfo, "stuck-queued-activity");

  // A reload paints bootstrap.thread and skips threads/get when that thread is the open bot.
  const fulfillExpiredStatus = async (route: Parameters<Parameters<typeof page.route>[1]>[0]) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: ThreadCarrier };
    injectThreadMessage(body, {
      id: EXPIRED_MESSAGE_ID,
      role: "system",
      blocks: [{ kind: "meta", text: EXPIRED_TAKEOVER }],
    });
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  };
  await page.route("**/rpc/bootstrap", fulfillExpiredStatus);
  await page.route("**/rpc/threads/get", fulfillExpiredStatus);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("combobox", { name: /^Message/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(EXPIRED_TAKEOVER)).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, testInfo, "stuck-expired-status");
});

for (const width of [1440, 390]) {
  test(`a failed computer release can be retried from its preview at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await signup(
      page,
      `control-retry-${width}-${Date.now()}@example.test`,
      "password12",
      "Control Retry",
    );
    await completeOnboarding(page);
    const botId = activeBotId(page);
    await rpc(page, "computer/boot", { botId });
    await page.route("https://screen.example/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><p>Desktop connected</p>" }),
    );
    await page.route("**/rpc/computer/screenUrl", (route) =>
      route.fulfill({ json: { json: { url: "https://screen.example/vnc.html" } } }),
    );
    await page.getByTitle("Agent computer").click();
    const preview = page.getByTestId("computer-preview");
    await expect(preview.locator("iframe")).toBeVisible();
    await preview.hover();
    await preview.getByTestId("computer-preview-open").click();
    await page.getByTestId("computer-chrome").getByRole("button", { name: "Take control" }).click();
    await expect(page.getByRole("button", { name: "I’m done", exact: true })).toBeVisible();
    const releases: unknown[] = [];
    let failRelease = true;
    await page.route("**/rpc/computer/release", async (route) => {
      releases.push(route.request().postDataJSON());
      if (failRelease) {
        await route.fulfill({
          status: 500,
          json: {
            json: {
              defined: false,
              code: "INTERNAL_SERVER_ERROR",
              status: 500,
              message: "release unavailable",
            },
          },
        });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "I’m done", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Could not continue");
    await page.getByRole("button", { name: "Close computer" }).click();
    await expect(preview.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, "computer-release-retry");
    const failedRetryResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/rpc/computer/release") && response.request().method() === "POST",
    );
    await preview.getByRole("button", { name: "Retry", exact: true }).click();
    expect((await failedRetryResponse).status()).toBe(500);
    await expect(preview.getByRole("alert")).toContainText("Could not continue");
    await expect(preview.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    failRelease = false;
    const retryResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/rpc/computer/release") && response.request().method() === "POST",
    );
    await preview.getByRole("button", { name: "Retry", exact: true }).click();
    expect((await retryResponse).ok()).toBe(true);
    await expect(preview.getByRole("alert")).toHaveCount(0);
    await expect(preview.locator("iframe")).toBeVisible();
    expect(releases).toEqual([
      { json: { botId, reason: "done" } },
      { json: { botId, reason: "done" } },
      { json: { botId, reason: "done" } },
    ]);
    await captureScreenshot(page, testInfo, "computer-release-recovered");
  });
}
