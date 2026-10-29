import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

const price = { amount: 1200, currency: "usd", interval: "month", intervalCount: 1 };

function billingStatus(overrides: Record<string, unknown>) {
  return {
    access: false,
    canManage: true,
    trialAvailable: true,
    trialDays: 7,
    state: "none",
    price,
    seats: 1,
    trialEndsAt: null,
    currentPeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    hasCustomer: false,
    ...overrides,
  };
}

async function enableBilling(route: Route, path: "me" | "bootstrap") {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = path === "me" ? body.json : (body.json?.me as Record<string, unknown> | undefined);
  if (me) me.billingEnabled = true;
  await route.fulfill({ response, json: body });
}

test("billing paywall holds the app until the subscription is active", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `billing-${stamp}@rakazo.test`, "password12", `Billing ${stamp}`);
  await completeOnboarding(page);

  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  let status = billingStatus({});
  await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: status } }));
  await page.reload();

  const paywall = page.getByTestId("billing-paywall");
  await expect(paywall.getByRole("button", { name: "Start 7-day free trial" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "$12 / month" })).toBeVisible();
  await expect(paywall.getByRole("button", { name: "Log out" })).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-paywall");

  status = billingStatus({
    access: true,
    trialAvailable: false,
    state: "active",
    seats: 3,
    currentPeriodEndsAt: "2030-01-15T12:00:00.000Z",
    hasCustomer: true,
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Chief").first()).toBeVisible();

  const settings = await openUserSettings(page, "billing");
  await expect(settings).toHaveAttribute("data-settings-section", "billing");
  const billing = settings.getByTestId("billing-settings");
  await expect(billing.getByRole("heading", { name: "Active", exact: true })).toBeVisible();
  await expect(billing.getByText("$12 / month · 3 seats")).toBeVisible();
  await expect(billing.getByText(/^Renews /)).toBeVisible();
  await expect(billing.getByRole("button", { name: "Manage" })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-billing");
});

async function billedRecoveryPage(
  page: Page,
  read: () => Record<string, unknown>,
  unavailable: () => boolean,
) {
  await signup(
    page,
    `billing-recovery-${Date.now()}@rakazo.test`,
    "password12",
    "Billing Recovery",
  );
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  await page.route("**/rpc/billing/status", (route) =>
    unavailable()
      ? route.fulfill({
          status: 503,
          json: {
            json: {
              defined: false,
              status: 503,
              code: "SERVICE_UNAVAILABLE",
              message: "Could not refresh billing",
              data: { reason: "billing_unavailable" },
            },
          },
        })
      : route.fulfill({ json: { json: read() } }),
  );
  await page.reload();
}

test("billing recovery distinguishes members, missing prices and refresh failures", async ({
  page,
}, testInfo) => {
  let status = billingStatus({ canManage: false });
  let unavailable = false;
  await billedRecoveryPage(
    page,
    () => status,
    () => unavailable,
  );
  const paywall = page.getByTestId("billing-paywall");
  await expect(paywall.getByText("Contact your organization owner", { exact: true })).toBeVisible();
  await expect(paywall.getByRole("button", { name: "Switch Space", exact: true })).toBeVisible();
  await expect(
    paywall.getByRole("button", { name: /Subscribe|Start .*trial|Manage billing/ }),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "billing-member-recovery");
  status = billingStatus({ price: null });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(paywall.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(paywall.getByRole("button", { name: /Subscribe|Start .*trial/ })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Subscription required", exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-price-retry");
  unavailable = true;
  await paywall.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(paywall.getByRole("alert")).toHaveText("Could not refresh billing");
  await captureScreenshot(page, testInfo, "billing-refresh-unavailable");
  unavailable = false;
  status = billingStatus({ access: true, state: "active" });
  await paywall.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(paywall).toHaveCount(0);
  await expect(page.getByText("Chief").first()).toBeVisible();
});

test("a denied send preserves the mounted chat draft and keeps Stop recovery reachable", async ({
  page,
}, testInfo) => {
  const status = billingStatus({ canManage: false });
  await billedRecoveryPage(
    page,
    () => status,
    () => false,
  );
  const paywall = page.getByTestId("billing-paywall");
  await paywall.getByRole("button", { name: "Back to chats", exact: true }).click();
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toBeEnabled();
  const draft = "Keep this draft after subscription recovery.\nDo not replay the send.";
  await composer.fill(draft);
  let sends = 0;
  await page.route("**/rpc/threads/send", (route) => {
    sends += 1;
    return route.fulfill({
      status: 402,
      json: {
        json: {
          defined: false,
          status: 402,
          code: "PAYMENT_REQUIRED",
          message: "Subscription required",
          data: { reason: "subscription_required" },
        },
      },
    });
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(paywall).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-denied-send-recovery");
  await paywall.getByRole("button", { name: "Back to chats", exact: true }).click();
  await expect(composer).toHaveValue(draft);
  expect(sends).toBe(1);
  await captureScreenshot(page, testInfo, "billing-denied-send-draft-retained");
});
