import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openIntegrations, rpc, signup } from "./helpers";

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

async function openAppCardFromChat(page: Page, app = "Google Mail", cardName = "Gmail") {
  await signup(page, `chat-app-${Date.now()}@example.test`, "password12", "Robin");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill(`Connect ${app} to this chat.`);
  const sent = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/rpc/threads/send",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await sent).ok()).toBe(true);
  return page.getByRole("group", { name: `${cardName} connection` });
}

test("a chat request opens one managed app card and keeps its verified status", async ({
  page,
}, testInfo) => {
  const card = await openAppCardFromChat(page);
  const authorize = card.getByRole("button", { name: "Authorize" });
  await expect(authorize).toBeVisible();
  await captureScreenshot(page, testInfo, "chat-app-connection-pending");

  await authorize.click();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const connections = await rpc<Array<{ provider: string; status: string }>>(
        page,
        "connections/list",
        {},
      );
      return connections.some(
        ({ provider, status }) => provider === "GMAIL" && status === "connected",
      );
    })
    .toBe(true);
  await captureScreenshot(page, testInfo, "chat-app-connection-connected");
  await page.reload();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await expect(card).toHaveCount(1);
  await openIntegrations(page);
  await expect(
    page.getByTestId("connection-tile-gmail").getByRole("button", { name: "Manage", exact: true }),
  ).toBeVisible();
});

test("a card recovers a completed authorization after the original update is interrupted", async ({
  page,
}) => {
  const readback = "**/rpc/onboarding/appConnected";
  const completion = "**/rpc/connections/complete";
  await page.route(readback, (route) => route.abort());
  const card = await openAppCardFromChat(page);
  let onCommitted!: (connectionId: string) => void;
  const committed = new Promise<string>((resolve) => {
    onCommitted = resolve;
  });
  await page.route(completion, async (route) => {
    const { connectionId } = route.request().postDataJSON().json;
    const response = await route.fetch({ postData: { json: { connectionId } } });
    expect((await response.json()).json).toMatchObject({ id: connectionId, status: "connected" });
    await route.abort();
    onCommitted(connectionId);
  });
  await card.getByRole("button", { name: "Authorize", exact: true }).click();
  const connectionId = await committed;
  await page.unroute(readback);
  await page.reload();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();

  const before = await rpc<Connection[]>(page, "connections/list", {});
  const account = before.find((row) => row.id === connectionId);
  if (!account) throw new Error("The verified connection is missing.");
  expect(account).toMatchObject({ status: "connected" });
  const reused = await rpc(page, "connections/begin", {
    connectorId: account.connectorId,
    provider: account.provider,
    displayName: account.displayName,
    reuseAppGrant: true,
  });
  expect(reused).toEqual({ connectionId, authorizationUrl: null });
  expect(await rpc(page, "connections/list", {})).toEqual(before);
});

async function startPendingAirtableCard(page: Page) {
  await page
    .context()
    .route("https://pipedream.example.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>Authorization fixture</p>" }),
    );
  const completion = "**/rpc/connections/complete";
  await page.route(completion, (route) => route.abort());
  const card = await openAppCardFromChat(page, "Airtable", "Airtable");
  const firstBegin = page.waitForResponse("**/rpc/connections/begin");
  await card.getByRole("button", { name: "Authorize", exact: true }).click();
  const { json: first } = await (await firstBegin).json();
  expect(first).toMatchObject({ authorizationUrl: expect.stringContaining("example.test") });
  const before = await rpc<Connection[]>(page, "connections/list", {});
  expect(before).toEqual([expect.objectContaining({ id: first.connectionId, status: "pending" })]);
  return { card, completion, connectionId: first.connectionId as string };
}

test("retrying a blocked app popup opens the original grant", async ({ page }) => {
  await page.addInitScript(() => {
    const open = window.open.bind(window);
    let blocked = false;
    window.open = (...args) => {
      if (!blocked && String(args[0]).startsWith("https://pipedream.example.test/")) {
        blocked = true;
        return null;
      }
      return open(...args);
    };
  });
  const { card, completion, connectionId } = await startPendingAirtableCard(page);
  await expect(card.getByText("Could not authorize this app", { exact: true })).toBeVisible();
  const reopened = page.waitForEvent("popup");
  await page.unroute(completion);
  await card.getByRole("button", { name: "Authorize", exact: true }).click();
  await reopened;
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  expect(await rpc(page, "connections/list", {})).toEqual([
    expect.objectContaining({ id: connectionId, status: "connected" }),
  ]);
});

test("a chat card resumes the same pending grant after reload", async ({ page }) => {
  const { card, completion, connectionId } = await startPendingAirtableCard(page);
  await page.reload();
  await expect(card.getByRole("button", { name: "Check status", exact: true })).toBeVisible();
  const reused = await rpc(page, "connections/begin", {
    connectorId: "pipedream",
    provider: "AIRTABLE",
    displayName: "Airtable",
    reuseAppGrant: true,
  });
  expect(reused).toEqual({ connectionId, authorizationUrl: null });
  const newRequests: unknown[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/rpc/connections/begin")
      newRequests.push(request.postDataJSON());
  });
  await card.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(card.getByText("Authorization is still pending.")).toBeVisible();
  await card.getByRole("button", { name: "Manage", exact: true }).click();
  const integrations = page.getByRole("dialog", { name: "Integrations", exact: true });
  await expect(integrations).toBeVisible();
  await expect(integrations.getByTestId("connection-tile-airtable")).toBeVisible();
  await integrations.getByRole("button", { name: "Close integrations" }).click();
  await page.unroute(completion);
  await card.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  expect(await rpc(page, "connections/list", {})).toEqual([
    expect.objectContaining({ id: connectionId, status: "connected" }),
  ]);
  expect(newRequests).toEqual([]);
});

test("checking a cancelled chat grant does not start another authorization", async ({ page }) => {
  const { card, completion, connectionId } = await startPendingAirtableCard(page);
  await page.reload();
  await card.getByRole("button", { name: "Check status", exact: true }).click();
  await card.getByRole("button", { name: "Manage", exact: true }).click();
  await page
    .getByTestId("connection-tile-airtable")
    .getByRole("button", { name: /Airtable/ })
    .click();
  await page.getByRole("button", { name: "Cancel connection", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect account" }).click();
  await expect
    .poll(async () => {
      const rows = await rpc<Connection[]>(page, "connections/list", {});
      return rows.find(({ id }) => id === connectionId)?.status;
    })
    .toBe("revoked");
  await page.getByRole("button", { name: "Close integrations" }).click();
  await page.unroute(completion);

  await card.getByRole("button", { name: "Check status", exact: true }).click();
  const authorize = card.getByRole("button", { name: "Authorize", exact: true });
  await expect(authorize).toBeVisible();
  expect(await rpc(page, "connections/list", {})).toEqual([
    expect.objectContaining({ id: connectionId, status: "revoked" }),
  ]);

  const next = page.waitForResponse("**/rpc/connections/begin");
  await authorize.click();
  const { json: restarted } = await (await next).json();
  expect(restarted.connectionId).not.toBe(connectionId);
});

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
  await expect(
    page.getByRole("dialog", { name: "Gmail", exact: true }).getByRole("status"),
  ).toContainText("Authorization is still pending");
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
  await expect(
    page.getByRole("dialog", { name: "Gmail", exact: true }).getByRole("status"),
  ).toContainText("2 accounts disconnected locally");
  await captureScreenshot(page, testInfo, "connector-source-removal-partial");
  await page
    .getByLabel("Connection source", { exact: true })
    .selectOption(JSON.stringify(["pipedream", "gmail"]));
  await expect(page.getByTestId("connection-account-Other source")).toBeVisible();
});
