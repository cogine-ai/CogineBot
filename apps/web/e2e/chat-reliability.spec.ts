import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type {
  AppBootstrap,
  Bot,
  Connection,
  Me,
  Space,
  SpaceNavigation,
  ThreadMessage,
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
    sendSpaces: [] as string[],
    uploads: [] as Array<Record<string, unknown>>,
    orders: [] as string[][],
    threadReads: [] as Array<{ botId: string; spaceId: string }>,
    listRequests: 0,
    bootstrapRequests: 0,
    connectionRequests: 0,
    list: null as null | ((route: Route, snapshot: SpaceNavigation) => Promise<void>),
    bootstrap: null as null | ((route: Route, snapshot: AppBootstrap) => Promise<void>),
    onboarding: null as null | ((route: Route) => Promise<void>),
    thread: null as null | ((route: Route, snapshot: ThreadSnapshot) => Promise<void>),
    send: null as null | ((route: Route, input: Record<string, unknown>) => Promise<void>),
    reorder: null as null | ((route: Route, botIds: string[]) => Promise<void>),
    messages: null as null | ((route: Route) => Promise<void>),
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
    if (path === "threads/messages") {
      if (state.messages) return state.messages(route);
      return json(route, {
        threadId: `thread-${input.botId ?? "chief"}`,
        messages: [],
        olderCursor: null,
      });
    }
    if (path === "threads/subscribe")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path === "threads/send") {
      const payload = request.postDataJSON().json as Record<string, unknown>;
      state.sends.push(payload);
      state.sendSpaces.push(spaceId);
      if (state.send) return state.send(route, payload);
      return json(route, { runId: "run-synthetic", taskId: "task-synthetic", seq: 0 });
    }
    if (path === "artifacts/create") {
      state.uploads.push(request.postDataJSON().json);
      return json(route, { id: "synthetic-attachment" });
    }
    if (path === "artifacts/listSpace") return json(route, { items: [], nextCursor: null });
    if (path === "bots/reorder") {
      const botIds = request.postDataJSON().json.botIds as string[];
      state.orders.push([...botIds]);
      if (state.reorder) return state.reorder(route, botIds);
      state.bots = botIds.map((id) => state.bots.find((row) => row.id === id)!);
      return json(route, { ok: true });
    }
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

/** Keep an actual ORPC-decoded SSE body open without a server, model or heartbeat sleeps. */
async function controlledStream(page: Page) {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const openStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    let failed: boolean | number = false;
    let requests = 0;
    Object.defineProperty(window, "reliabilityStream", {
      value: {
        get requests() {
          return requests;
        },
        fail(value: boolean | number) {
          failed = value;
          if (value) {
            for (const controller of openStreams)
              controller.error(new TypeError("Failed to fetch"));
            openStreams.clear();
          }
        },
      },
    });
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url, window.location.href).pathname !== "/rpc/threads/subscribe")
        return nativeFetch(input, init);
      requests += 1;
      if (typeof failed === "number") {
        const code = failed === 401 ? "UNAUTHORIZED" : "FORBIDDEN";
        return Response.json(
          { json: { defined: false, code, status: failed, message: "Chat access interrupted" } },
          { status: failed },
        );
      }
      if (failed) throw new TypeError("Failed to fetch");
      const request = new Request(input, init);
      const target = (await request.clone().json()).json as { botId?: string };
      let current: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          current = controller;
          openStreams.add(controller);
          const event = {
            id: "synthetic-heartbeat",
            spaceId: "space-primary",
            threadId: `thread-${target.botId ?? "chief"}`,
            botId: target.botId ?? "chief",
            seq: 0,
            type: "heartbeat",
            payload: {},
            createdAt: "2026-10-17T00:00:00.000Z",
          };
          controller.enqueue(
            new TextEncoder().encode(
              `event: message\ndata: ${JSON.stringify({ json: event })}\n\n`,
            ),
          );
          request.signal.addEventListener(
            "abort",
            () => {
              if (openStreams.delete(controller)) controller.error(request.signal.reason);
            },
            { once: true },
          );
        },
        cancel() {
          if (current) openStreams.delete(current);
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
  });
  return (failed: boolean | number) =>
    page.evaluate(
      (value) =>
        (
          window as unknown as { reliabilityStream: { fail: (value: boolean | number) => void } }
        ).reliabilityStream.fail(value),
      failed,
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
}, testInfo) => {
  const { state, errors, unknown } = await mockChat(page);
  state.bootstrap = (route) => route.abort("failed");
  state.list = (route) => route.abort("failed");
  await page.goto("/app/chief");
  await expect(page.getByTestId("bootstrap-status")).toContainText("Waiting for connection");
  await expect(page.locator('[data-testid="composer-bar"] [role="combobox"]:enabled')).toHaveCount(
    0,
  );
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "false");
  await captureScreenshot(page, testInfo, "initial-waiting-for-connection");
  expect(errors).toEqual([]);
  state.bootstrap = null;
  state.list = null;
  const attempts = state.bootstrapRequests;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.bootstrapRequests).toBeGreaterThan(attempts);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("bootstrap-status")).toHaveCount(0);
  const recovered = page.getByRole("combobox", { name: "Message Chief", exact: true });
  await expect(recovered).toBeEnabled();
  await recovered.fill("@Research");
  await page.getByRole("option", { name: "@Research Two", exact: true }).click();
  await recovered.fill("Recovered in the correct Space.\nThe attachment stays scoped.");
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "recovery-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("isolated recovery attachment"),
    });
  await expect(page.getByTestId("attachment-preview")).toHaveCount(1);
  await recovered.press("Enter");
  await expect.poll(() => state.sends.length).toBe(1);
  expect(state.sends[0]).toMatchObject({
    botId: "chief",
    mentions: [{ kind: "bot", id: "research-two" }],
    artifactIds: ["synthetic-attachment"],
  });
  expect(state.sends[0].text).toContain("Recovered in the correct Space.");
  expect(state.sendSpaces).toEqual(["space-primary"]);
  expect(state.uploads[0].botId).toBe("chief");
  await expect(recovered).toHaveValue("");
  await expect(page.getByTestId("attachment-preview")).toHaveCount(0);
  await expect(page.getByTestId("composer-error")).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(unknown).toEqual([]);
});

test("Chinese initial connection feedback fits the 800px desktop layout", async ({
  page,
}, testInfo) => {
  const { state, errors } = await mockChat(page);
  await page.addInitScript(() => localStorage.setItem("rakazo.uiLocale", "zh-CN"));
  await page.setViewportSize({ width: 800, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  state.bootstrap = (route) => route.abort("internetdisconnected");
  state.list = (route) => route.abort("internetdisconnected");
  await page.goto("/app/chief");
  const status = page.getByTestId("bootstrap-status");
  await expect(status).toContainText("等待连接");
  await expect(status.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800);
  await captureScreenshot(page, testInfo, "initial-waiting-zh-CN-light-800");
  expect(state.sends).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("initialization retries on its timer even while the fallback roster request is hanging", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  await page.clock.install();
  const listStarted = deferred();
  const releaseList = deferred();
  state.bootstrap = (route) => route.abort("internetdisconnected");
  state.list = async (route, data) => {
    listStarted.resolve();
    await releaseList.promise;
    await json(route, data);
  };
  try {
    await page.goto("/app/chief");
    await listStarted.promise;
    await expect(page.getByTestId("bootstrap-status")).toContainText("Waiting for connection");
    const initialRequests = state.bootstrapRequests;
    state.bootstrap = null;
    // No focus event or manual Retry: initialization must not depend on a stuck roster read.
    await page.clock.fastForward(3_100);
    await expect.poll(() => state.bootstrapRequests).toBeGreaterThan(initialRequests);
    await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
    await expect(page.getByRole("combobox", { name: "Message Chief", exact: true })).toBeEnabled();
    await expect(page.getByTestId("bootstrap-status")).toHaveCount(0);
    expect(state.sends).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    releaseList.resolve();
  }
});

test("a hanging initialization times out, retries once and ignores its late snapshot", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  await page.clock.install();
  const initialStarted = deferred();
  const releaseInitial = deferred();
  const deliveries: Array<Promise<void>> = [];
  let recovering = false;
  state.bootstrap = async (route, data) => {
    if (!recovering) {
      initialStarted.resolve();
      const delivered = deferred();
      deliveries.push(delivered.promise);
      await releaseInitial.promise;
      try {
        await json(route, { ...data, me: { ...data.me, spaceId: "space-obsolete" } });
      } catch {
        // A request genuinely cancelled at timeout cannot deliver its late response.
      } finally {
        delivered.resolve();
      }
      return;
    }
    return json(route, data);
  };
  await page.goto("/app/chief");
  await initialStarted.promise;
  await expect(page.locator('[data-testid="composer-bar"] [role="combobox"]:enabled')).toHaveCount(
    0,
  );
  // Development StrictMode may consume a primed request in its first effect mount.
  // The live mount must remain single-flight while every initial read is held.
  await expect(
    page.getByTestId("bootstrap-status").getByRole("button", { name: "Retry" }),
  ).toBeDisabled();
  const initialRequests = state.bootstrapRequests;
  for (let attempt = 0; attempt < 3; attempt += 1)
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.clock.fastForward(100);
  expect(state.bootstrapRequests).toBe(initialRequests);
  recovering = true;
  await page.clock.fastForward(15_001);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.bootstrapRequests).toBe(initialRequests + 1);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  releaseInitial.resolve();
  await Promise.all(deliveries);
  await painted(page);
  await expect(page.getByTestId("sidebar-current-space")).toHaveText("Primary Space");
  await expect(page.getByRole("combobox", { name: "Message Chief", exact: true })).toBeEnabled();
  await page.clock.fastForward(30_000);
  expect(state.bootstrapRequests).toBe(initialRequests + 1);
  expect(errors).toEqual([]);
});

test("returning from Files preserves scoped text, Bot mentions and attachments through initialization failure", async ({
  page,
}, testInfo) => {
  const { state, errors } = await mockChat(page);
  await controlledStream(page);
  await ready(page);
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  await composer.fill("@Research");
  await page.getByRole("option", { name: "@Research One", exact: true }).click();
  const text = "Unsent notes before Files.\nKeep both lines and the attachment.";
  await composer.fill(text);
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "unsent-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("keep this File across a Shell remount"),
    });
  await page.getByTestId("sidebar-files-trigger").click();
  await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
  await expect(page.getByText("No artifacts found.")).toBeVisible();
  const attempts = state.bootstrapRequests;
  state.bootstrap = (route) => route.abort("internetdisconnected");
  await page.goBack();
  await expect.poll(() => state.bootstrapRequests).toBeGreaterThan(attempts);
  await expect(page.getByTestId("bootstrap-status")).toBeVisible();
  expect(state.sends).toHaveLength(0);
  expect(state.uploads).toHaveLength(0);
  state.bootstrap = null;
  await page
    .getByTestId("bootstrap-status")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(composer).toHaveValue(text);
  await expect(page.getByTestId("mention-chip")).toHaveText(["Research One"]);
  await expect(page.getByRole("button", { name: "Remove unsent-notes.txt" })).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "recovered-files-return-keeps-draft");
  expect(state.sends).toHaveLength(0);
  expect(state.uploads).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("a lost send receipt is never replayed automatically, and manual retry retains newer edits", async ({
  page,
}, testInfo) => {
  const { state, errors } = await mockChat(page);
  await controlledStream(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.clock.install();
  const accepted = new Map<string, { runId: string; taskId: string; seq: number }>();
  const retryStarted = deferred();
  const releaseRetry = deferred();
  state.send = async (route, payload) => {
    const nonce = payload.clientNonce as string;
    const receipt = accepted.get(nonce) ?? {
      runId: `run-${accepted.size}`,
      taskId: `task-${accepted.size}`,
      seq: 0,
    };
    accepted.set(nonce, receipt);
    if (state.sends.length === 1) return route.abort("internetdisconnected");
    retryStarted.resolve();
    await releaseRetry.promise;
    return json(route, receipt);
  };
  await ready(page);
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  await composer.fill("A sent message whose receipt was lost.\nDo not enqueue a second send.");
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "submitted.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("an uploaded attachment with a confirmed receipt"),
    });
  await composer.press("Enter");
  await expect(page.getByTestId("composer-error")).toHaveText(
    "Send not confirmed. Your draft is kept.",
  );
  await expect(composer).toHaveValue(
    "A sent message whose receipt was lost.\nDo not enqueue a second send.",
  );
  await expect(page.getByRole("button", { name: "Remove submitted.txt" })).toBeVisible();
  await page.clock.fastForward(60_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await refresh(page, state);
  expect(state.sends).toHaveLength(1);
  expect(state.uploads).toHaveLength(1);
  await page.getByTestId("minimize-bots-sidebar").click();
  await expect(page.getByTestId("bots-sidebar")).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "send-unconfirmed-preserves-text-and-attachment");
  await composer.press("Enter");
  await retryStarted.promise;
  expect(state.sends).toHaveLength(2);
  expect(state.sends[1]).toEqual(state.sends[0]);
  expect(state.uploads).toHaveLength(1);
  expect(accepted.size).toBe(1);
  await composer.fill("A newer unsent draft stays here after the old receipt returns.");
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "newer.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("a newer unsent attachment"),
    });
  releaseRetry.resolve();
  await expect(page.getByTestId("composer-error")).toHaveCount(0);
  await expect(composer).toHaveValue(
    "A newer unsent draft stays here after the old receipt returns.",
  );
  await expect(page.getByRole("button", { name: "Remove submitted.txt" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove newer.txt" })).toBeVisible();
  expect(state.sends).toHaveLength(2);
  expect(state.uploads).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("an interrupted stream preserves editing and sending while reconnecting, then clears its hint", async ({
  page,
}, testInfo) => {
  const { state, errors } = await mockChat(page);
  const failStream = await controlledStream(page);
  await page.setViewportSize({ width: 800, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await ready(page);
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  await composer.fill("An existing draft remains editable.\nThe second line stays intact.");
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "stream-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("keep while the separate reading channel reconnects"),
    });
  await failStream(true);
  await expect(page.getByTestId("connection-status")).toContainText("Reconnecting");
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue(
    "An existing draft remains editable.\nThe second line stays intact.",
  );
  await expect(page.getByRole("button", { name: "Remove stream-notes.txt" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800);
  await captureScreenshot(page, testInfo, "stream-reconnecting-light-800-keeps-editing");
  await composer.press("Enter");
  await expect.poll(() => state.sends.length).toBe(1);
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("composer-error")).toHaveCount(0);
  await failStream(false);
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  expect(state.sends).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("an explicit initialization permission error waits for user retry without an automatic retry loop", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  await page.clock.install();
  state.bootstrap = (route) =>
    route.fulfill({
      status: 403,
      json: { json: { defined: false, code: "FORBIDDEN", status: 403, message: "Access denied" } },
    });
  await page.goto("/app/chief");
  await expect(page.getByTestId("bootstrap-status")).toContainText("Access denied");
  const initialRequests = state.bootstrapRequests;
  await page.clock.fastForward(30_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(state.bootstrapRequests).toBe(initialRequests);
  expect(state.sends).toHaveLength(0);
  state.bootstrap = null;
  await page
    .getByTestId("bootstrap-status")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  expect(state.bootstrapRequests).toBe(initialRequests + 1);
  expect(errors).toEqual([]);
});

for (const status of [401, 403]) {
  test(`a ${status} chat read stops its retry loop, keeps the draft and restarts only on explicit retry`, async ({
    page,
  }) => {
    const { state, errors } = await mockChat(page);
    const failStream = await controlledStream(page);
    await page.clock.install();
    await ready(page);
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
    const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
    await composer.fill("Keep this draft when only this chat read is rejected.");
    await failStream(status);
    await expect(page.getByTestId("connection-status")).toContainText("Chat access interrupted");
    const attempts = () =>
      page.evaluate(
        () =>
          (window as unknown as { reliabilityStream: { requests: number } }).reliabilityStream
            .requests,
      );
    const stoppedAt = await attempts();
    await page.clock.fastForward(30_000);
    expect(await attempts()).toBe(stoppedAt);
    await expect(composer).toHaveValue("Keep this draft when only this chat read is rejected.");
    await expect(composer).toBeEnabled();
    await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
    expect(state.sends).toHaveLength(0);
    await failStream(false);
    await page
      .getByTestId("connection-status")
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
    await expect(composer).toHaveValue("Keep this draft when only this chat read is rejected.");
    expect(await attempts()).toBeGreaterThan(stoppedAt);
    expect(errors).toEqual([]);
  });
}

test("retrying the same chat connection preserves loaded earlier messages and reading position", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  const failStream = await controlledStream(page);
  const history: ThreadMessage[] = Array.from({ length: 46 }, (_, index) => ({
    id: `history-${index}`,
    threadId: "thread-chief",
    botId: "chief",
    seq: index,
    role: "bot",
    blocks: [
      { kind: "text", text: `Earlier conversation message ${index}: keep this reading position.` },
    ],
    createdAt: stamp,
  }));
  const latest = (data: ThreadSnapshot): ThreadSnapshot => ({
    ...data,
    cursor: 45,
    messages: history.slice(20),
    olderCursor: 20,
  });
  state.bootstrap = (route, data) => json(route, { ...data, thread: latest(data.thread!) });
  state.thread = (route, data) => json(route, latest(data));
  state.messages = (route) =>
    json(route, { threadId: "thread-chief", messages: history.slice(0, 20), olderCursor: null });
  await ready(page);
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  const transcript = page.getByTestId("transcript");
  const earlier = transcript.locator('[data-message-id="history-7"]');
  await expect(earlier).toHaveCount(1);
  await earlier.scrollIntoViewIfNeeded();
  await failStream(403);
  await expect(page.getByTestId("connection-status")).toContainText("Chat access interrupted");
  const before = await transcript.evaluate((element) => element.scrollTop);
  const offsetBefore = await earlier.evaluate((element) => {
    const transcript = element.closest('[data-testid="transcript"]')!;
    return element.getBoundingClientRect().top - transcript.getBoundingClientRect().top;
  });
  await failStream(false);
  await page
    .getByTestId("connection-status")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  await expect(earlier).toHaveCount(1);
  const offsetAfter = await earlier.evaluate((element) => {
    const transcript = element.closest('[data-testid="transcript"]')!;
    return element.getBoundingClientRect().top - transcript.getBoundingClientRect().top;
  });
  expect(
    Math.abs((await transcript.evaluate((element) => element.scrollTop)) - before),
  ).toBeLessThanOrEqual(2);
  expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThanOrEqual(2);
  expect(state.sends).toHaveLength(0);
  expect(errors).toEqual([]);
});

for (const readbackFails of [false, true]) {
  test(`a failed order save ${readbackFails ? "and readback remain visibly unconfirmed" : "reads the authoritative order"} without replay`, async ({
    page,
  }, testInfo) => {
    const { state, errors } = await mockChat(page);
    await page.clock.install();
    await ready(page);
    const sidebar = page.getByTestId("bots-sidebar");
    const rows = sidebar.locator(
      '[data-sidebar-group^="space:space-primary:"] [data-roster-bot-id]',
    );
    const order = () =>
      rows.evaluateAll((items) => items.map((row) => row.getAttribute("data-roster-bot-id")));
    await expect.poll(order).toEqual(["chief", "research-one", "research-two"]);
    const saveStarted = deferred();
    const releaseSave = deferred();
    state.reorder = async (route) => {
      saveStarted.resolve();
      await releaseSave.promise;
      return route.abort("internetdisconnected");
    };
    state.list = readbackFails ? (route) => route.abort("internetdisconnected") : null;
    await sidebar.locator('[data-roster-bot-id="research-two"]').focus();
    await page.keyboard.press("Alt+ArrowUp");
    await saveStarted.promise;
    await expect.poll(order).toEqual(["chief", "research-two", "research-one"]);
    await expect(page.getByTestId("roster-order-status")).toContainText("Saving");
    const before = state.listRequests;
    releaseSave.resolve();
    await expect.poll(() => state.listRequests).toBeGreaterThan(before);
    if (readbackFails) {
      await expect(page.getByTestId("roster-order-status")).toContainText("Order not confirmed");
      await expect.poll(order).toEqual(["chief", "research-two", "research-one"]);
      await captureScreenshot(page, testInfo, "order-save-and-readback-unconfirmed");
    } else {
      await expect.poll(order).toEqual(["chief", "research-one", "research-two"]);
      await expect(page.getByTestId("roster-order-status")).toHaveCount(0);
    }
    state.list = null;
    await page.clock.fastForward(12_000);
    await refresh(page, state);
    await expect.poll(order).toEqual(["chief", "research-one", "research-two"]);
    await expect(page.getByTestId("roster-order-status")).toHaveCount(0);
    expect(state.orders).toEqual([["chief", "research-two", "research-one"]]);
    expect(errors).toEqual([]);
  });
}

test("a newer explicit order is saved after an older order fails without reapplying the old order", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  await ready(page);
  const sidebar = page.getByTestId("bots-sidebar");
  const rows = sidebar.locator('[data-sidebar-group^="space:space-primary:"] [data-roster-bot-id]');
  const order = () =>
    rows.evaluateAll((items) => items.map((row) => row.getAttribute("data-roster-bot-id")));
  const firstStarted = deferred();
  const releaseFirst = deferred();
  state.reorder = async (route, ids) => {
    if (state.orders.length === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
      return route.abort("internetdisconnected");
    }
    state.bots = ids.map((id) => state.bots.find((row) => row.id === id)!);
    return json(route, { ok: true });
  };
  const moving = sidebar.locator('[data-roster-bot-id="research-two"]');
  await moving.focus();
  await page.keyboard.press("Alt+ArrowUp");
  await firstStarted.promise;
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(order).toEqual(["research-two", "chief", "research-one"]);
  releaseFirst.resolve();
  await expect.poll(() => state.orders.length).toBe(2);
  await expect(page.getByTestId("roster-order-status")).toHaveCount(0);
  await refresh(page, state);
  await expect.poll(order).toEqual(["research-two", "chief", "research-one"]);
  expect(state.orders).toEqual([
    ["chief", "research-two", "research-one"],
    ["research-two", "chief", "research-one"],
  ]);
  expect(errors).toEqual([]);
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
