import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type {
  AppBootstrap,
  Connection,
  NativeRoutineTrigger,
  NativeRoutineTriggerInput,
  NativeSetupState,
  Routine,
} from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "./helpers";

const pageId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  return errors;
}
// These cases author synthetic Routine records, whose run history is empty.
test.beforeEach(async ({ page }) => {
  await page.route("**/rpc/routines/history", (route) =>
    route.fulfill({ json: { json: { runs: [], nextCursor: null } } }),
  );
});
function connection(
  id: string,
  provider = "google-calendar",
  status: Connection["status"] = "connected",
): Connection {
  return {
    id,
    connectorId: "native",
    provider,
    displayName: id,
    status,
    capabilities: [],
    createdAt: "2026-01-01",
    remoteAccountId: null,
  };
}
function routine(botId: string, bindings: NativeRoutineTrigger[] = []): Routine {
  return {
    id: "authoring-routine",
    botId,
    name: "Event review",
    prompt: "Read the event.",
    crons: [],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-01-01",
    nativeTriggers: bindings,
  };
}
function savedBindings(inputs: NativeRoutineTriggerInput[]): NativeRoutineTrigger[] {
  return inputs.map((input, index) => ({
    id: input.id ?? `new-binding-${index}`,
    version: input.expectedVersion ?? 1,
    routineId: "authoring-routine",
    connectionId: input.connectionId,
    spec: input.spec,
    armedAt: "2026-10-18T00:00:00.000Z",
  }));
}

test("creates an explicit Calendar event and retains its draft across the existing account connection overlay", async ({
  page,
}, testInfo) => {
  const browserErrors = collectBrowserErrors(page);
  await signup(
    page,
    `native-event-create-${Date.now()}@rakazo.test`,
    "password12",
    "Event authoring",
  );
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let accounts = [connection("calendar-one")];
  const begins: unknown[] = [];
  const setup: NativeSetupState = {
    canConfigure: false,
    callbackUri: "https://app.example.test/api/connectors/oauth/callback",
    configurations: [
      {
        id: "calendar-source",
        appId: "google-calendar",
        label: "Calendar source",
        ownership: "byo",
        credentialKind: "oauth",
        enabled: true,
        configured: true,
        revision: 1,
        executionLocation: "instance",
        callbackUri: "https://app.example.test/api/connectors/oauth/callback",
      },
    ],
  };
  let routines: Routine[] = [];
  const creates: Array<{ nativeTriggers: NativeRoutineTriggerInput[]; crons: string[] }> = [];
  await page.route("**/rpc/connections/list", (route) =>
    route.fulfill({ json: { json: accounts } }),
  );
  await page.route("**/rpc/connections/catalog", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            connectorId: "native",
            slug: "google-calendar",
            name: "Google Calendar",
            logo: null,
            noAuth: false,
            connected: true,
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/nativeConnectors/status", (route) =>
    route.fulfill({ json: { json: setup } }),
  );
  await page.route("**/rpc/connections/tools", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/nativeConnectors/begin", (route) => {
    begins.push(route.request().postDataJSON().json);
    accounts = [...accounts, connection("calendar-two", "google-calendar", "pending")];
    return route.fulfill({
      json: { json: { connectionId: "calendar-two", authorizationUrl: null } },
    });
  });
  await page.route("**/rpc/connections/complete", (route) => {
    expect(route.request().postDataJSON().json.connectionId).toBe("calendar-two");
    accounts = accounts.map((row) =>
      row.id === "calendar-two" ? { ...row, status: "connected" } : row,
    );
    return route.fulfill({ json: { json: accounts.find((row) => row.id === "calendar-two") } });
  });
  await page.route("**/rpc/routines/list", (route) => route.fulfill({ json: { json: routines } }));
  await page.route("**/rpc/routines/create", (route) => {
    const payload = route.request().postDataJSON().json;
    creates.push(payload);
    routines = [
      { ...routine(botId), ...payload, nativeTriggers: savedBindings(payload.nativeTriggers) },
    ];
    return route.fulfill({ json: { json: routines[0] } });
  });
  await page.getByTitle("Agent computer").click();
  await page.getByRole("button", { name: "Create Routine", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Calendar reminder");
  await page.getByLabel("Instruction", { exact: true }).fill("Read this event.");
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await page.getByRole("menuitem", { name: "Application event", exact: true }).click();
  const account = page.getByLabel("Account", { exact: true });
  await expect(account).toBeEnabled();
  await expect(account).toHaveValue("");
  await expect(page.getByLabel("Event", { exact: true })).toBeDisabled();
  await account.selectOption("calendar-one");
  await page.getByLabel("Event", { exact: true }).selectOption("calendar.event_starting");
  await page.getByLabel("Calendar ID", { exact: true }).fill("real-calendar-id");
  await page.getByLabel("Calendar target", { exact: true }).selectOption("series");
  await page.getByLabel("Event ID", { exact: true }).fill("real-series-id");
  await page.getByLabel("Minutes before", { exact: true }).fill("30");
  await page.getByRole("button", { name: "Connect an account", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Integrations", exact: true })).toBeVisible();
  await page
    .getByTestId("connection-tile-google-calendar")
    .getByRole("button", { name: /Google Calendar/ })
    .click();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page.getByRole("button", { name: "Authorize account", exact: true }).click();
  await expect(page.getByTestId("connection-account-calendar-two")).toContainText("Connected");
  expect(begins).toEqual([{ configId: "calendar-source" }]);
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();
  await expect(account.locator('option[value="calendar-two"]')).toHaveCount(1);
  await expect(account).toHaveValue("calendar-one");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Calendar reminder");
  await expect(page.getByLabel("Calendar ID", { exact: true })).toHaveValue("real-calendar-id");
  await expect(page.getByLabel("Event ID", { exact: true })).toHaveValue("real-series-id");
  await captureScreenshot(page, testInfo, "native-event-calendar-authoring");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Save event changes", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await captureScreenshot(page, testInfo, "native-event-calendar-narrow");
  await page.getByRole("button", { name: "Save event changes", exact: true }).click();
  await expect.poll(() => creates.length).toBe(1);
  expect(creates[0]?.crons).toEqual([]);
  expect(creates[0]?.nativeTriggers).toEqual([
    {
      connectionId: "calendar-one",
      spec: {
        kind: "calendar.event_starting",
        calendarId: "real-calendar-id",
        target: { kind: "series", eventId: "real-series-id" },
        leadMinutes: 30,
      },
    },
  ]);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(browserErrors).toEqual([]);
});

test("preserves unavailable bindings on ordinary save and explicitly updates Notion discussion anchors without replacing siblings", async ({
  page,
}, testInfo) => {
  const browserErrors = collectBrowserErrors(page);
  await signup(
    page,
    `native-event-update-${Date.now()}@rakazo.test`,
    "password12",
    "Event editing",
  );
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const old: NativeRoutineTrigger = {
    id: "old-binding",
    version: 3,
    routineId: "authoring-routine",
    connectionId: "old-calendar",
    spec: {
      kind: "calendar.event_changed",
      calendarId: "old-resource",
      target: { kind: "calendar" },
    },
    armedAt: "2026-10-18T00:00:00.000Z",
  };
  const sibling: NativeRoutineTrigger = {
    id: "sibling-binding",
    version: 7,
    routineId: "authoring-routine",
    connectionId: "notion-one",
    spec: { kind: "notion.page_content_changed", target: { type: "page", pageId } },
    armedAt: "2026-10-18T00:00:00.000Z",
  };
  let saved = routine(botId, [old, sibling]);
  const updates: Array<{ nativeTriggers?: NativeRoutineTriggerInput[] }> = [];
  await page.route("**/rpc/connections/list", (route) =>
    route.fulfill({
      json: {
        json: [
          connection("old-calendar", "google-calendar", "revoked"),
          connection("new-calendar"),
          connection("notion-one", "notion"),
        ],
      },
    }),
  );
  await page.route("**/rpc/routines/list", (route) => route.fulfill({ json: { json: [saved] } }));
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: AppBootstrap };
    body.json.routines = [saved];
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/routines/update", (route) => {
    const payload = route.request().postDataJSON().json;
    updates.push(payload);
    saved = {
      ...saved,
      ...payload,
      nativeTriggers:
        payload.nativeTriggers === undefined
          ? saved.nativeTriggers
          : savedBindings(payload.nativeTriggers),
    };
    return route.fulfill({ json: { json: saved } });
  });
  await page.goto(`/app/${botId}?routine=${saved.id}`);
  const account = page.getByLabel("Account", { exact: true }).first();
  await expect(account).toHaveValue("old-calendar");
  await expect(account.locator('option[value="old-calendar"]')).toBeDisabled();
  await page.getByLabel("Name", { exact: true }).fill("Renamed event review");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => updates.length).toBe(1);
  expect(updates[0]).not.toHaveProperty("nativeTriggers");
  await expect(account).toHaveValue("old-calendar");
  await account.selectOption("notion-one");
  await page.getByLabel("Event", { exact: true }).first().selectOption("notion.comment_changed");
  await page.getByLabel("Notion target", { exact: true }).selectOption("discussion");
  await page.getByLabel("Page ID", { exact: true }).first().fill(pageId);
  await page.getByLabel("Discussion ID", { exact: true }).fill(otherId);
  await page.getByLabel("Anchor block ID", { exact: true }).fill(pageId);
  await captureScreenshot(page, testInfo, "native-event-notion-discussion-authoring");
  await page.getByRole("button", { name: "Save event changes", exact: true }).click();
  await expect.poll(() => updates.length).toBe(2);
  expect(updates[1]?.nativeTriggers).toEqual([
    {
      id: old.id,
      expectedVersion: 3,
      connectionId: "notion-one",
      spec: {
        kind: "notion.comment_changed",
        target: { type: "discussion", discussionId: otherId, anchorBlockId: pageId, pageId },
      },
    },
    { id: sibling.id, expectedVersion: 7, connectionId: "notion-one", spec: sibling.spec },
  ]);
  await page.getByRole("button", { name: "Remove application event", exact: true }).first().click();
  await page.getByRole("button", { name: "Remove application event", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save event changes", exact: true }),
  ).toBeDisabled();
  expect(updates).toHaveLength(2);
  expect(browserErrors).toEqual([]);
});
