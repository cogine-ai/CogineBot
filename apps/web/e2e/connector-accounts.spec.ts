import { expect, test } from "@playwright/test";
import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openIntegrations, signup } from "./helpers";

const catalog: ConnectionCatalogItem[] = ["composio", "pipedream"].map((connectorId) => ({
  connectorId,
  slug: "gmail",
  name: "Gmail",
  logo: null,
  noAuth: false,
  connected: true,
}));
function account(id: string, status: Connection["status"], connectorId = "composio"): Connection {
  return {
    id,
    connectorId,
    provider: "gmail",
    displayName: id,
    status,
    capabilities: [],
    createdAt: "2026-01-01",
    remoteAccountId: status === "connected" ? `record-${id}` : null,
  };
}

test("groups sources, preserves four account states and checks pending without restarting authorization", async ({
  page,
}, testInfo) => {
  await signup(page, `account-ui-${Date.now()}@rakazo.test`, "password12", "Accounts");
  await completeOnboarding(page);
  let rows = [
    account("Work", "connected"),
    account("Waiting", "pending"),
    account("Expired", "error"),
    account("Old", "revoked"),
    account("Personal", "connected", "pipedream"),
  ];
  const begins: unknown[] = [];
  await page.route("**/rpc/connections/catalog", (route) =>
    route.fulfill({ json: { json: catalog } }),
  );
  await page.route("**/rpc/connections/list", (route) => route.fulfill({ json: { json: rows } }));
  await page.route("**/rpc/connections/tools", (route) =>
    route.fulfill({ json: { json: [{ name: "gmail-list-messages" }] } }),
  );
  await page.route("**/rpc/connections/begin", (route) => {
    begins.push(route.request().postDataJSON().json);
    rows = [...rows, account("New authorization", "connected")];
    return route.fulfill({
      json: { json: { connectionId: "New authorization", authorizationUrl: null } },
    });
  });
  await page.route("**/rpc/connections/complete", (route) => {
    const id = route.request().postDataJSON().json.connectionId;
    return route.fulfill({ json: { json: rows.find((row) => row.id === id) } });
  });
  await openIntegrations(page);
  await expect(page.getByTestId("connection-tile-gmail")).toHaveCount(1);
  await page
    .getByTestId("connection-tile-gmail")
    .getByRole("button", { name: "Manage", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Gmail", exact: true })).toHaveCount(1);
  await expect(page.getByTestId("connection-account-Expired")).toContainText("Needs attention");
  await page
    .getByTestId("connection-account-Waiting")
    .getByRole("button", { name: "Check status", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Authorization is still pending");
  expect(begins).toEqual([]);
  await expect(page.getByText("Authorization record: record-Work", { exact: true })).toBeHidden();
  await page.getByText("Account details", { exact: true }).click();
  await expect(page.getByText("Authorization record: record-Work", { exact: true })).toBeVisible();
  const accounts = page.getByTestId("connection-accounts");
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const title = await accounts.getByText("Accounts", { exact: true }).boundingBox();
    const add = await accounts
      .getByRole("button", { name: "Add account", exact: true })
      .boundingBox();
    expect(title).not.toBeNull();
    expect(add).not.toBeNull();
    expect(Math.abs(title!.y + title!.height / 2 - add!.y - add!.height / 2)).toBeLessThan(2);
    expect(await accounts.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    if (viewport.width === 390)
      await captureScreenshot(page, testInfo, "connector-accounts-mobile");
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await captureScreenshot(page, testInfo, "connector-accounts-four-states");
  await page
    .getByTestId("connection-account-Expired")
    .getByRole("button", { name: "Authorize again", exact: true })
    .click();
  await expect(page.getByTestId("connection-account-New authorization")).toBeVisible();
  expect(begins).toEqual([
    expect.objectContaining({
      connectorId: "composio",
      provider: "gmail",
      connectionId: "Expired",
      displayName: "Expired",
    }),
  ]);
  await expect(page.getByTestId("connection-account-Expired")).toBeVisible();
  await page
    .getByLabel("Connection source", { exact: true })
    .selectOption(JSON.stringify(["pipedream", "gmail"]));
  await expect(page.getByTestId("connection-account-Personal")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search apps", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "connector-accounts-back-to-catalog");
});

test("source removal stops at the first uncertain result and preserves the remaining source and accounts", async ({
  page,
}, testInfo) => {
  await signup(page, `account-remove-${Date.now()}@rakazo.test`, "password12", "Accounts");
  await completeOnboarding(page);
  let rows = [
    account("First", "connected"),
    account("Uncertain", "connected"),
    account("Remaining", "connected"),
    account("Expired", "error"),
    account("Other source", "connected", "pipedream"),
  ];
  const revoked: string[] = [];
  await page.route("**/rpc/connections/catalog", (route) =>
    route.fulfill({ json: { json: catalog } }),
  );
  await page.route("**/rpc/connections/list", (route) => route.fulfill({ json: { json: rows } }));
  await page.route("**/rpc/connections/tools", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/connections/revoke", (route) => {
    const id = route.request().postDataJSON().json.connectionId;
    revoked.push(id);
    rows = rows.map((row) =>
      row.id === id ? { ...row, status: "revoked", remoteAccountId: null } : row,
    );
    return id === "Uncertain"
      ? route.abort("failed")
      : route.fulfill({ json: { json: { ok: true } } });
  });
  await openIntegrations(page);
  await page
    .getByTestId("connection-tile-gmail")
    .getByRole("button", { name: "Manage", exact: true })
    .click();
  await page.getByRole("button", { name: "Uninstall source", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("First");
  await expect(confirmation).toContainText("Remaining");
  await confirmation.getByRole("button", { name: "Uninstall source", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Local access stopped · Provider confirmation pending",
  );
  expect(revoked).toEqual(["First", "Uncertain"]);
  await expect(page.getByTestId("connection-account-Remaining")).toBeVisible();
  await expect(page.getByTestId("connection-account-Expired")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("2 accounts disconnected locally");
  await captureScreenshot(page, testInfo, "connector-source-removal-partial");
  await page
    .getByLabel("Connection source", { exact: true })
    .selectOption(JSON.stringify(["pipedream", "gmail"]));
  await expect(page.getByTestId("connection-account-Other source")).toBeVisible();
});
