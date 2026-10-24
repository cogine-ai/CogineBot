import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Me, Routine, RoutineHistory } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function account(page: Page, label: string) {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const name = `Recovery ${label}`;
  await signup(page, `${label}-${Date.now()}@example.test`, "password12", name);
  await completeOnboarding(page);
  return { botId: activeBotId(page), name };
}
async function settings(page: Page, name: string) {
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return page.getByTestId("user-settings");
}
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("failed and silent Routine rows expose cleaned diagnostics without an empty chat link", async ({
  page,
  context,
}, info) => {
  const { botId } = await account(page, "diagnostics");
  const routine = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Recovery history",
    prompt: "Check for changes",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: false,
    notify: false,
  });
  const rows: RoutineHistory = {
    nextCursor: null,
    runs: [
      {
        id: "failed-example",
        botId,
        groupId: null,
        status: "failed",
        messageId: null,
        error:
          '401: {"error":{"message":"invalid api key","metadata":{"token":"fake-private-token"}}}',
        createdAt: "2026-01-02T12:00:00Z",
        startedAt: "2026-01-02T12:00:00Z",
        completedAt: "2026-01-02T12:00:03Z",
      },
      {
        id: "silent-example",
        botId,
        groupId: null,
        status: "completed",
        messageId: null,
        error: null,
        createdAt: "2026-01-01T12:00:00Z",
        startedAt: "2026-01-01T12:00:00Z",
        completedAt: "2026-01-01T12:00:03Z",
      },
    ],
  };
  await page.route("**/rpc/routines/history", (route) => route.fulfill({ json: { json: rows } }));
  await page.reload();
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: new RegExp(routine.name) }).click();
  const history = page.getByTestId("routine-run-history");
  await expect(
    history.getByText("Your model provider rejected the API key. Check your connection settings."),
  ).toBeVisible();
  await history.getByRole("button", { name: "Run history", exact: true }).click();
  await expect(history.getByTestId("routine-run-row")).toHaveCount(2);
  await expect(history.getByRole("link", { name: "View chat" })).toHaveCount(0);
  await history.locator("summary").click();
  await expect(history.locator("pre")).toContainText("[Redacted]");
  await expect(history).not.toContainText("fake-private-token");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await history.getByRole("button", { name: "Copy diagnostics" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain(
    "fake-private-token",
  );
  await captureScreenshot(page, info, "b5-safe-run-diagnostics");
});

test("a recovery reload restores only the verified read-only settings location", async ({
  page,
}, info) => {
  const { name } = await account(page, "preload");
  const overlay = await settings(page, name);
  await overlay.getByRole("button", { name: "Models", exact: true }).click();
  await expect(overlay).toHaveAttribute("data-settings-section", "models");
  const loaded = page.waitForEvent("domcontentloaded");
  await page.evaluate(() => {
    window.setTimeout(
      () => window.dispatchEvent(new Event("vite:preloadError", { cancelable: true })),
      0,
    );
  });
  await loaded;
  await expect(page.getByTestId("user-settings")).toBeVisible();
  await expect(page.getByTestId("user-settings")).toHaveAttribute(
    "data-settings-section",
    "models",
  );
  expect(await page.evaluate(() => sessionStorage.getItem("rk:preload-recovery-state"))).toBeNull();
  await captureScreenshot(page, info, "b5-safe-panel-recovery");
});

test("sensitive, executable and cross-account panel snapshots are consumed without replay", async ({
  page,
}) => {
  await account(page, "snapshot-rejection");
  const me = await rpc<Me>(page, "me", {});
  for (const change of [
    { accountId: "different-owner" },
    { version: 2 },
    { overlayKind: "create" },
    { apiKey: "fake-never-store-key" },
  ]) {
    await page.evaluate(
      ({ me, change }) => {
        sessionStorage.setItem("rk:preload-recovery", "1");
        sessionStorage.setItem(
          "rk:preload-recovery-state",
          JSON.stringify({
            version: 1,
            apiOrigin: location.origin,
            accountId: me.userId,
            spaceId: me.spaceId,
            overlayKind: "settings",
            targetId: `space:${me.spaceId}`,
            section: "models",
            ...change,
          }),
        );
      },
      { me, change },
    );
    await page.reload();
    await expect(page.getByTestId("composer-bar")).toBeVisible();
    await expect(page.getByTestId("user-settings")).toHaveCount(0);
    expect(
      await page.evaluate(() => sessionStorage.getItem("rk:preload-recovery-state")),
    ).toBeNull();
  }
});

test("a server failure offers an explicit read retry and recovers the first screen", async ({
  page,
}, info) => {
  await account(page, "first-screen");
  let fail = true;
  await page.route("**/rpc/bootstrap", async (route) => {
    if (fail)
      await route.fulfill({
        status: 503,
        json: { json: { code: "SERVICE_UNAVAILABLE", status: 503, message: "synthetic outage" } },
      });
    else await route.continue();
  });
  await page.reload();
  const notice = page.getByTestId("load-failure");
  await expect(notice).toContainText("The server could not complete the request");
  await captureScreenshot(page, info, "b5-first-screen-retry");
  fail = false;
  await notice.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId("composer-bar")).toBeVisible();
});

test("a scoped 403 recovers through the default Space without changing chat content", async ({
  page,
}) => {
  await account(page, "space-recovery");
  await page.route("**/rpc/bootstrap", async (route) => {
    if (route.request().headers()["x-rakazo-space-id"] === "unavailable-space")
      await route.fulfill({
        status: 403,
        json: { json: { code: "FORBIDDEN", status: 403, message: "Space denied" } },
      });
    else await route.continue();
  });
  await page.evaluate(() => localStorage.setItem("rakazo:space-id", "unavailable-space"));
  await page.reload();
  const notice = page.getByTestId("load-failure");
  await expect(notice).toContainText("This Space is unavailable");
  await notice.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId("composer-bar")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBeNull();
});

test("an identity reassigned to the selected bot completes its original link code", async ({
  page,
}, info) => {
  let linked = false;
  let codes = 0;
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: true,
          providers: ["telegram"],
          openSignup: false,
          identities: linked
            ? [
                {
                  id: "identity-existing",
                  provider: "telegram",
                  address: "example",
                  botId: activeBotId(page),
                  botName: "Chief",
                },
              ]
            : [
                {
                  id: "identity-existing",
                  provider: "telegram",
                  address: "example",
                  botId: "previous-bot",
                  botName: "Previous",
                },
              ],
        },
      },
    }),
  );
  await page.route("**/rpc/messaging/channels/list", (route) =>
    route.fulfill({ json: { json: [] } }),
  );
  await page.route("**/rpc/messaging/connections/list", (route) =>
    route.fulfill({ json: { json: [] } }),
  );
  await page.route("**/rpc/messaging/link/start", (route) => {
    codes += 1;
    return route.fulfill({
      json: { json: { code: "ABCD-2345", expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    });
  });
  const { name, botId } = await account(page, "link-recovery");
  const overlay = await settings(page, name);
  await overlay.getByRole("button", { name: "Manage messaging settings" }).click();
  const messaging = page.getByTestId("messaging-settings");
  await messaging.getByLabel("Bot to link").selectOption(botId);
  await messaging.getByRole("button", { name: "Link a chat app" }).click();
  await expect(messaging.getByTestId("messaging-link-code")).toContainText("ABCD-2345");
  linked = true;
  await expect(messaging.getByTestId("messaging-link-code")).toHaveCount(0, { timeout: 10_000 });
  await expect(messaging).toContainText("→ Chief");
  expect(codes).toBe(1);
  await captureScreenshot(page, info, "b5-linked-identity-refreshed");
});
