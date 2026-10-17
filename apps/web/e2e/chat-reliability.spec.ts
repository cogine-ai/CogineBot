import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type {
  AppBootstrap,
  Bot,
  Connection,
  Me,
  Space,
  SpaceNavigation,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { captureScreenshot, openNewBot } from "./helpers";

// Exercise the real app with synthetic HTTP contracts; no API, database or model is contacted.
const stamp = "2026-10-17T00:00:00.000Z";
const unexpectedRequests = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => {
  expect(unexpectedRequests.get(page) ?? []).toEqual([]);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
});
function bot(id: string, name: string, spaceId = "space-primary"): Bot {
  return {
    id,
    spaceId,
    name,
    title: "",
    description: "",
    instructions: "",
    color: "#E4C05D",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: `thread-${id}`,
    preview: "Ready to chat",
    status: "idle",
    runErrorId: null,
    computerMode: "team",
    updatedAt: stamp,
    createdAt: stamp,
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    disabledBuiltinTools: [],
    webhookConfigured: false,
    spawnKey: null,
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function json(route: Route, value: unknown) {
  await route.fulfill({ json: { json: value } });
}
function account(id: string, name: string): Connection {
  return {
    id,
    displayName: name,
    provider: "mail",
    connectorId: "native",
    status: "connected",
    capabilities: [],
    createdAt: stamp,
  };
}
async function mockChat(page: Page) {
  const errors: string[] = [];
  const unknown: string[] = [];
  unexpectedRequests.set(page, unknown);
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:"))
      errors.push(`Console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const state = {
    bots: [
      bot("chief", "Chief"),
      bot("research-one", "Research One"),
      bot("research-two", "Research Two"),
    ],
    connections: [
      account("mail-primary", "Mail Primary"),
      account("mail-secondary", "Mail Secondary"),
    ],
    sends: [] as Array<Record<string, unknown>>,
    threadReads: [] as Array<{ botId: string; spaceId: string }>,
    listRequests: 0,
    bootstrapRequests: 0,
    connectionRequests: 0,
    list: null as null | ((route: Route, snapshot: SpaceNavigation) => Promise<void>),
    bootstrap: null as null | ((route: Route, snapshot: AppBootstrap) => Promise<void>),
    onboarding: null as null | ((route: Route) => Promise<void>),
    thread: null as null | ((route: Route, snapshot: ThreadSnapshot) => Promise<void>),
  };
  const me = (spaceId = "space-primary"): Me => ({
    ticketBoardEnabled: false,
    userId: "user-test",
    email: "reader@example.test",
    name: "Reader",
    spaceId,
    isDeploymentOwner: true,
    needsModel: false,
    defaultProvider: "openai",
    defaultModel: "test-model",
    hostCredentialProvider: null,
    hostCredentialSource: null,
    computerHost: null,
    canChooseHostComputer: false,
    sandboxProvider: "none",
    avatarStyle: "organic",
    billingEnabled: false,
  });
  const other = bot("other-chief", "Other Chief", "space-other");
  const spaces = (): Space[] => [
    {
      id: "space-primary",
      name: "Primary Space",
      isDefault: true,
      hasContent: true,
      canRename: true,
      canDelete: false,
      bots: state.bots,
      groups: [],
      externalConversations: [],
      botSections: [],
    },
    {
      id: "space-other",
      name: "Other Space",
      isDefault: false,
      hasContent: true,
      canRename: true,
      canDelete: true,
      bots: [other],
      groups: [],
      externalConversations: [],
      botSections: [],
    },
  ];
  const nav = (spaceId: string): SpaceNavigation => ({
    current: {
      id: spaceId,
      name: spaceId === "space-other" ? "Other Space" : "Primary Space",
      bots: spaceId === "space-other" ? [other] : state.bots,
      groups: [],
      externalConversations: [],
      botSections: [],
    },
    spaces: spaces(),
  });
  const snapshot = (id: string): ThreadSnapshot => ({
    threadId: `thread-${id}`,
    botId: id,
    cursor: -1,
    messages: [],
    olderCursor: null,
    run: null,
    activeRuns: [],
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/get-session") {
      await route.fulfill({
        json: {
          user: {
            id: "user-test",
            name: "Reader",
            email: "reader@example.test",
            emailVerified: true,
            createdAt: stamp,
            updatedAt: stamp,
          },
          session: {
            id: "synthetic-session",
            userId: "user-test",
            expiresAt: "2099-01-01T00:00:00.000Z",
            createdAt: stamp,
            updatedAt: stamp,
            token: "synthetic-only",
          },
        },
      });
    } else if (path === "/api/auth/capabilities") {
      await route.fulfill({
        json: {
          passwordAuth: true,
          sso: null,
          passwordReset: false,
          resetUrl: null,
          billing: false,
        },
      });
    } else {
      unknown.push(path);
      await route.fulfill({ status: 404, json: { error: "Unexpected synthetic auth request" } });
    }
  });
  await page.route("**/rpc/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice("/rpc/".length);
    const input = (request.postDataJSON()?.json ?? {}) as Record<string, string>;
    const spaceId = request.headers()["x-rakazo-space-id"] ?? "space-primary";
    if (path === "bootstrap") {
      state.bootstrapRequests += 1;
      const current = nav(spaceId);
      const data: AppBootstrap = {
        me: me(spaceId),
        bots: current.current.bots,
        groups: [],
        botSections: [],
        archivedBots: [],
        archivedGroups: [],
        thread: snapshot(input.botId ?? current.current.bots[0].id),
        routines: [],
        spaces: current.spaces,
      };
      if (state.bootstrap) return state.bootstrap(route, structuredClone(data));
      return json(route, data);
    }
    if (path === "spaces/list") {
      state.listRequests += 1;
      const data = structuredClone(nav(spaceId));
      if (state.list) return state.list(route, data);
      return json(route, data);
    }
    if (path === "me") return json(route, me(spaceId));
    if (path === "threads/get") {
      state.threadReads.push({ botId: input.botId ?? "chief", spaceId });
      const data = snapshot(input.botId ?? "chief");
      return state.thread ? state.thread(route, data) : json(route, data);
    }
    if (path === "threads/head")
      return json(route, { threadId: `thread-${input.botId ?? "chief"}`, cursor: -1 });
    if (path === "threads/subscribe")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path === "threads/send") {
      state.sends.push(request.postDataJSON().json);
      return json(route, { runId: "run-synthetic", taskId: "task-synthetic", seq: 0 });
    }
    if (path === "artifacts/create") return json(route, { id: "synthetic-attachment" });
    if (path === "bots/create") {
      const created = bot("created-bot", input.name);
      state.bots = [created, ...state.bots];
      return json(route, created);
    }
    if (path === "onboarding/start") {
      if (state.onboarding) return state.onboarding(route);
      return json(route, { started: true });
    }
    if (path === "connections/list") {
      state.connectionRequests += 1;
      return json(route, state.connections);
    }
    if (path === "messaging/status") return json(route, { enabled: false, providers: [] });
    if (path === "usage/summary") return json(route, { inputTokens: 0, outputTokens: 0, runs: 0 });
    if (path === "voice/status") return json(route, { ready: false });
    if (path === "memory/providerConfig") return json(route, null);
    if (path === "computer/screenUrl") return json(route, { url: null });
    const empty = [
      "bots/listArchived",
      "groups/listArchived",
      "agentSkills/catalog",
      "agentSkills/list",
      "routines/list",
      "skills/list",
      "connections/catalog",
      "memory/list",
      "voice/voices",
      "computer/updates",
    ];
    if (empty.includes(path)) return json(route, []);
    const acknowledgements = ["threads/markRead", "threads/markUnread"];
    if (acknowledgements.includes(path)) return json(route, { ok: true });
    unknown.push(path);
    return route.fulfill({ status: 404, json: { error: "Unexpected synthetic RPC request" } });
  });
  return { state, errors, unknown };
}
async function ready(page: Page) {
  await page.goto("/app/chief");
  await expect(page).toHaveTitle("CogineBot");
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(page.getByRole("combobox", { name: "Message Chief", exact: true })).toBeVisible();
}
async function painted(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function refresh(page: Page, state: { listRequests: number }, held = false) {
  const before = state.listRequests;
  const response = held
    ? null
    : page.waitForResponse((item) => new URL(item.url()).pathname === "/rpc/spaces/list");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.listRequests).toBeGreaterThan(before);
  if (response) {
    await response;
    await painted(page);
  }
}
async function highlighted(page: Page, name: string) {
  await expect(page.getByRole("option", { name: `@${name}`, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 3000 },
  );
}

test("mention highlight retains the same Bot across equivalent refresh and roster reorder", async ({
  page,
}, testInfo) => {
  const { state, errors, unknown } = await mockChat(page);
  await ready(page);
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  await composer.fill("@Research");
  await composer.press("ArrowDown");
  await highlighted(page, "Research Two");
  await refresh(page, state);
  await highlighted(page, "Research Two");
  state.bots = [state.bots[0], state.bots[2], state.bots[1]];
  await refresh(page, state);
  await highlighted(page, "Research Two");
  await composer.press("Enter");
  await expect(page.getByTestId("mention-chip")).toContainText("Research Two");
  await captureScreenshot(page, testInfo, "stable-bot-mention");
  expect(errors).toEqual([]);
  expect(unknown).toEqual([]);
});

test("deleted highlight falls back to a valid option and changing query resets selection", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  await ready(page);
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  await composer.fill("@Research");
  await composer.press("ArrowDown");
  await highlighted(page, "Research Two");
  await composer.fill("@Res");
  await highlighted(page, "Research One");
  await composer.press("ArrowDown");
  await highlighted(page, "Research Two");
  state.bots = state.bots.filter((row) => row.id !== "research-two");
  await refresh(page, state);
  await expect(page.getByRole("option", { name: "@Research Two", exact: true })).toHaveCount(0);
  await highlighted(page, "Research One");
  await composer.fill("@Chief");
  await highlighted(page, "Chief");
  expect(errors).toEqual([]);
});

test("connected account highlight survives refreshed candidates without altering selected Bot chips", async ({
  page,
}, testInfo) => {
  const { state, errors } = await mockChat(page);
  const companionName = "Research Two — Planning and source verification companion";
  const accountName = "Mail Secondary — Personal documents and research workspace";
  state.bots = state.bots.map((row) =>
    row.id === "research-two" ? { ...row, name: companionName } : row,
  );
  state.connections[1] = account("mail-secondary", accountName);
  await page.setViewportSize({ width: 800, height: 900 });
  await ready(page);
  await expect.poll(() => state.connectionRequests).toBeGreaterThan(0);
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  for (const name of ["Research One", companionName]) {
    await composer.fill(`@${name}`);
    await page.getByRole("option", { name: `@${name}`, exact: true }).click();
  }
  await composer.fill("@Mail");
  await composer.press("ArrowDown");
  await highlighted(page, accountName);
  state.bots = [...state.bots, bot("observer", "Observer")];
  state.connections = [state.connections[1], state.connections[0]];
  const before = state.connectionRequests;
  await refresh(page, state);
  await expect.poll(() => state.connectionRequests).toBeGreaterThan(before);
  await highlighted(page, accountName);
  await composer.press("Tab");
  await expect(page.getByTestId("mention-chip")).toHaveText([
    "Research One",
    companionName,
    accountName,
  ]);
  await composer.fill("A message with two Bots and one account.\nThe second line stays intact.");
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("synthetic attachment"),
    });
  await expect(page.getByTestId("attachment-preview")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800);
  await captureScreenshot(page, testInfo, "stable-account-and-two-bot-chips");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(1);
  expect(state.sends[0].mentions).toEqual([
    { kind: "bot", id: "research-one" },
    { kind: "bot", id: "research-two" },
    { kind: "connector", id: "mail-secondary" },
  ]);
  expect(state.sends[0].text).toBe(
    `@Research One @${companionName} A message with two Bots and one account.\nThe second line stays intact.`,
  );
  expect(state.sends[0].artifactIds).toEqual(["synthetic-attachment"]);
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
  await expect(page.getByTestId("composer-error")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("bootstrap failure followed by a rejected fallback refresh is handled and can recover", async ({
  page,
}) => {
  const { state, errors, unknown } = await mockChat(page);
  state.bootstrap = (route) => route.abort("failed");
  state.list = (route) => route.abort("failed");
  await page.goto("/app/chief");
  await expect.poll(() => state.listRequests).toBeGreaterThan(0);
  await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 0)));
  expect(errors).toEqual([]);
  state.bootstrap = null;
  state.list = null;
  await refresh(page, state);
  await expect(page.getByRole("combobox", { name: "Message Chief", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(unknown).toEqual([]);
});

for (const refreshFails of [false, true]) {
  test(`creating a Bot rejects an older roster during slow onboarding, refresh ${refreshFails ? "fails" : "succeeds"}`, async ({
    page,
  }, testInfo) => {
    const { state, errors } = await mockChat(page);
    await ready(page);
    const listStarted = deferred();
    const listDelivered = deferred();
    const releaseList = deferred();
    const onboardingStarted = deferred();
    const releaseOnboarding = deferred();
    let captured = false;
    state.list = async (route, snapshot) => {
      if (!captured) {
        captured = true;
        listStarted.resolve();
        await releaseList.promise;
        await json(route, snapshot);
        listDelivered.resolve();
        return;
      }
      if (refreshFails) return route.abort("failed");
      return json(route, snapshot);
    };
    state.onboarding = async (route) => {
      onboardingStarted.resolve();
      await releaseOnboarding.promise;
      return json(route, { started: true });
    };
    await refresh(page, state, true);
    await listStarted.promise;
    await openNewBot(page);
    const form = page.getByTestId("create-bot-form");
    await form.locator("label:has-text('Name') input").fill("Created Companion");
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await onboardingStarted.promise;
    await expect(page).toHaveURL(/\/app\/created-bot$/, { timeout: 3000 });
    releaseList.resolve();
    await listDelivered.promise;
    await painted(page);
    await expect(page.locator('[data-roster-bot-id="created-bot"]')).toBeVisible({ timeout: 3000 });
    await expect(page).toHaveURL(/\/app\/created-bot$/, { timeout: 3000 });
    releaseOnboarding.resolve();
    await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
    await expect(page.locator('[data-roster-bot-id="created-bot"]')).toBeVisible({ timeout: 3000 });
    await expect(page).toHaveURL(/\/app\/created-bot$/, { timeout: 3000 });
    await captureScreenshot(
      page,
      testInfo,
      `created-bot-refresh-${refreshFails ? "failed" : "ok"}`,
    );
    expect(errors).toEqual([]);
  });
}

test("a bootstrap started before creation cannot remove a subsequently created Bot", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  const bootstrapStarted = deferred();
  const releaseBootstrap = deferred();
  const releaseRefetch = deferred();
  const bootstrapResponses: Array<Promise<Error | null>> = [];
  let delivered = 0;
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/rpc/bootstrap")
      bootstrapResponses.push(response.finished());
  });
  state.bootstrap = async (route, snapshot) => {
    bootstrapStarted.resolve();
    await releaseBootstrap.promise;
    await json(route, snapshot);
    delivered += 1;
  };
  await page.goto("/app/chief");
  await bootstrapStarted.promise;
  await refresh(page, state);
  await expect(page.getByRole("combobox", { name: "Message Chief", exact: true })).toBeVisible();
  await openNewBot(page);
  const form = page.getByTestId("create-bot-form");
  await form.locator("label:has-text('Name') input").fill("Created Companion");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/created-bot$/, { timeout: 3000 });
  const input = page.getByRole("combobox", { name: "Message Created Companion", exact: true });
  await expect(input).toBeEnabled();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  // Stop subscription/poll recovery from hiding a late bootstrap's stale snapshot write.
  state.thread = async (route, snapshot) => {
    await releaseRefetch.promise;
    await json(route, snapshot);
  };
  state.list = async (route, snapshot) => {
    await releaseRefetch.promise;
    await json(route, snapshot);
  };
  releaseBootstrap.resolve();
  await expect.poll(() => delivered).toBe(state.bootstrapRequests);
  await expect.poll(() => bootstrapResponses.length).toBe(state.bootstrapRequests);
  await Promise.all(bootstrapResponses);
  await painted(page);
  try {
    expect(await page.getByTestId("shell-root").getAttribute("data-ready")).toBe("true");
    expect(await input.isEnabled()).toBe(true);
    expect(await page.locator('[data-roster-bot-id="created-bot"]').isVisible()).toBe(true);
    expect(new URL(page.url()).pathname).toBe("/app/created-bot");
    expect(errors).toEqual([]);
  } finally {
    releaseRefetch.resolve();
  }
});

test("switching Space during post-create onboarding leaves the other Space isolated", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  await ready(page);
  const onboardingStarted = deferred();
  const releaseOnboarding = deferred();
  state.onboarding = async (route) => {
    onboardingStarted.resolve();
    await releaseOnboarding.promise;
    return json(route, { started: true });
  };
  await openNewBot(page);
  const form = page.getByTestId("create-bot-form");
  await form.locator("label:has-text('Name') input").fill("Created Companion");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await onboardingStarted.promise;
  await page.getByTestId("space-menu-trigger").click();
  await page.getByRole("button", { name: "Other Space", exact: true }).click();
  releaseOnboarding.resolve();
  await expect(page).toHaveURL(/\/app\/other-chief$/);
  await expect(page.getByTestId("sidebar-current-space")).toHaveText("Other Space");
  await expect(
    page.getByRole("combobox", { name: "Message Other Chief", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-sidebar-group^="space:space-other:"] [data-roster-bot-id="created-bot"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-sidebar-group^="space:space-primary:"] [data-roster-bot-id="created-bot"]'),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      state.threadReads.some(
        (read) => read.botId === "other-chief" && read.spaceId === "space-other",
      ),
    )
    .toBe(true);
  const composer = page.getByRole("combobox", { name: "Message Other Chief", exact: true });
  await composer.fill("@Created");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  expect(errors).toEqual([]);
});
