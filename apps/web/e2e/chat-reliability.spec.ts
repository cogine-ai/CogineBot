import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type {
  AppBootstrap,
  Bot,
  Connection,
  Group,
  Me,
  ProductEvent,
  Space,
  SpaceNavigation,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  CreateBotInput,
  isBotCreationSpawnKey,
  normalizeCreateBotProfile,
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
async function internalReadFailure(route: Route) {
  return route.fulfill({
    status: 500,
    json: {
      json: {
        defined: false,
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
        message: "Temporary read failure",
      },
    },
  });
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
    groups: [] as Group[],
    sandboxProvider: "none",
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
    botListRequests: 0,
    archivedBotListRequests: 0,
    bootstrapRequests: 0,
    connectionRequests: 0,
    creations: [] as Array<{ input: CreateBotInput; spaceId: string }>,
    list: null as null | ((route: Route, snapshot: SpaceNavigation) => Promise<void>),
    bootstrap: null as null | ((route: Route, snapshot: AppBootstrap) => Promise<void>),
    create: null as null | ((route: Route, created: Bot) => Promise<void>),
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
    sandboxProvider: state.sandboxProvider,
    avatarStyle: "organic",
    billingEnabled: false,
  });
  const otherBots = [bot("other-chief", "Other Chief", "space-other")];
  const spaces = (): Space[] => [
    {
      id: "space-primary",
      name: "Primary Space",
      isDefault: true,
      hasContent: true,
      canRename: true,
      canDelete: false,
      bots: state.bots,
      groups: state.groups,
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
      bots: otherBots,
      groups: [],
      externalConversations: [],
      botSections: [],
    },
  ];
  const nav = (spaceId: string): SpaceNavigation => ({
    current: {
      id: spaceId,
      name: spaceId === "space-other" ? "Other Space" : "Primary Space",
      bots: spaceId === "space-other" ? otherBots : state.bots,
      groups: spaceId === "space-other" ? [] : state.groups,
      externalConversations: [],
      botSections: [],
    },
    spaces: spaces(),
  });
  const snapshot = (id: string, groupId?: string): ThreadSnapshot => ({
    threadId: `thread-${groupId ?? id}`,
    ...(groupId
      ? {
          groupId,
          groupName: state.groups.find((group) => group.id === groupId)?.name,
          members: state.groups.find((group) => group.id === groupId)?.members,
        }
      : { botId: id }),
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
        groups: current.current.groups,
        botSections: [],
        archivedBots: [],
        archivedGroups: [],
        thread: snapshot(input.botId ?? current.current.bots[0]!.id, input.groupId),
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
      const data = snapshot(input.botId ?? "chief", input.groupId);
      return state.thread ? state.thread(route, data) : json(route, data);
    }
    if (path === "threads/head")
      return json(route, {
        threadId: `thread-${input.groupId ?? input.botId ?? "chief"}`,
        cursor: -1,
      });
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
      const draft = CreateBotInput.parse(request.postDataJSON().json);
      state.creations.push({ input: draft, spaceId });
      const created: Bot = {
        ...bot("created-bot", draft.name, spaceId),
        ...normalizeCreateBotProfile(draft),
        notifyOnFinish: draft.notifyOnFinish,
        computerMode: draft.computerMode,
        color: draft.color ?? "#E4C05D",
        spawnKey: draft.spawnKey ?? null,
      };
      if (spaceId === "space-other") otherBots.unshift(created);
      else state.bots = [created, ...state.bots];
      return state.create ? state.create(route, created) : json(route, created);
    }
    if (path === "bots/list") {
      state.botListRequests += 1;
      const bots = spaceId === "space-other" ? otherBots : state.bots;
      return json(
        route,
        bots.filter((row) => row.archivedAt === null),
      );
    }
    if (path === "bots/listArchived") {
      state.archivedBotListRequests += 1;
      const bots = spaceId === "space-other" ? otherBots : state.bots;
      return json(
        route,
        bots.filter((row) => row.archivedAt !== null),
      );
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
    let events: Array<{ seq: number; [key: string]: unknown }> = [];
    const cursors: number[] = [];
    Object.defineProperty(window, "reliabilityStream", {
      value: {
        cursors,
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
        replay(value: typeof events) {
          events = value;
        },
        emit(event: (typeof events)[number]) {
          for (const controller of openStreams)
            controller.enqueue(
              new TextEncoder().encode(
                `event: message\ndata: ${JSON.stringify({ json: event })}\n\n`,
              ),
            );
        },
      },
    });
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url, window.location.href).pathname !== "/rpc/threads/subscribe")
        return nativeFetch(input, init);
      requests += 1;
      const request = new Request(input, init);
      const target = (await request.clone().json()).json as {
        botId?: string;
        groupId?: string;
        cursor: number;
      };
      cursors.push(target.cursor);
      if (typeof failed === "number") {
        const code =
          failed === 401 ? "UNAUTHORIZED" : failed === 403 ? "FORBIDDEN" : "INTERNAL_SERVER_ERROR";
        return Response.json(
          { json: { defined: false, code, status: failed, message: "Chat access interrupted" } },
          { status: failed },
        );
      }
      if (failed) throw new TypeError("Failed to fetch");
      let current: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          current = controller;
          openStreams.add(controller);
          for (const event of events) {
            if (event.seq > target.cursor)
              controller.enqueue(
                new TextEncoder().encode(
                  `event: message\ndata: ${JSON.stringify({ json: event })}\n\n`,
                ),
              );
          }
          const event = {
            id: "synthetic-heartbeat",
            spaceId: "space-primary",
            threadId: `thread-${target.groupId ?? target.botId ?? "chief"}`,
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
  const fail = (failed: boolean | number) =>
    page.evaluate(
      (value) =>
        (
          window as unknown as { reliabilityStream: { fail: (value: boolean | number) => void } }
        ).reliabilityStream.fail(value),
      failed,
    );
  return Object.assign(fail, {
    replay: (events: ProductEvent[]) =>
      page.evaluate(
        (value) =>
          (
            window as unknown as { reliabilityStream: { replay: (events: unknown[]) => void } }
          ).reliabilityStream.replay(value),
        events,
      ),
    emit: (event: ProductEvent) =>
      page.evaluate(
        (value) =>
          (
            window as unknown as { reliabilityStream: { emit: (event: unknown) => void } }
          ).reliabilityStream.emit(value),
        event,
      ),
    cursors: () =>
      page.evaluate(
        () =>
          (window as unknown as { reliabilityStream: { cursors: number[] } }).reliabilityStream
            .cursors,
      ),
  });
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
  state.bots = [state.bots[0]!, state.bots[2]!, state.bots[1]!];
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
  state.connections = [state.connections[1]!, state.connections[0]!];
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
  expect(state.sends[0]!.mentions).toEqual([
    { kind: "bot", id: "research-one" },
    { kind: "bot", id: "research-two" },
    { kind: "connector", id: "mail-secondary" },
  ]);
  expect(state.sends[0]!.text).toBe(
    `@Research One @${companionName} A message with two Bots and one account.\nThe second line stays intact.`,
  );
  expect(state.sends[0]!.artifactIds).toEqual(["synthetic-attachment"]);
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
  await expect(page.getByTestId("composer-error")).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const failure of ["network", 500] as const) {
  test(`bootstrap ${failure} failure followed by a rejected fallback refresh can recover`, async ({
    page,
  }, testInfo) => {
    const { state, errors, unknown } = await mockChat(page);
    state.bootstrap = (route) =>
      failure === 500 ? internalReadFailure(route) : route.abort("failed");
    state.list = (route) => route.abort("failed");
    await page.goto("/app/chief");
    await expect(page.getByTestId("bootstrap-status")).toContainText("Waiting for connection");
    await expect(
      page.locator('[data-testid="composer-bar"] [role="combobox"]:enabled'),
    ).toHaveCount(0);
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
    expect(state.sends[0]!.text).toContain("Recovered in the correct Space.");
    expect(state.sendSpaces).toEqual(["space-primary"]);
    expect(state.uploads[0]!.botId).toBe("chief");
    await expect(recovered).toHaveValue("");
    await expect(page.getByTestId("attachment-preview")).toHaveCount(0);
    await expect(page.getByTestId("composer-error")).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(unknown).toEqual([]);
  });
}

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
  const status = page.getByTestId("load-failure");
  await expect(status).toContainText("无法连接服务器");
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
    await expect(page.getByTestId("load-failure")).toContainText("Could not reach the server");
    const initialRequests = state.bootstrapRequests;
    state.bootstrap = null;
    // No focus event or manual Retry: initialization must not depend on a stuck roster read.
    await page.clock.fastForward(3_100);
    await expect.poll(() => state.bootstrapRequests).toBeGreaterThan(initialRequests);
    await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
    await expect(page.getByRole("combobox", { name: "Message Chief", exact: true })).toBeEnabled();
    await expect(page.getByTestId("load-failure")).toHaveCount(0);
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
  const liveInitialStarted = deferred();
  const releaseInitial = deferred();
  const deliveries: Array<Promise<void>> = [];
  let recovering = false;
  state.bootstrap = async (route, data) => {
    if (!recovering) {
      initialStarted.resolve();
      if (state.bootstrapRequests === 2) liveInitialStarted.resolve();
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
  // The development app primes one read; StrictMode's live mount starts a second.
  // Both held reads must enter the handler before measuring focus-triggered requests.
  await expect(
    page.getByTestId("bootstrap-status").getByRole("button", { name: "Retry" }),
  ).toBeDisabled();
  await liveInitialStarted.promise;
  const initialRequests = state.bootstrapRequests;
  expect(initialRequests).toBe(2);
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
  await expect(page.getByTestId("load-failure")).toBeVisible();
  await expect(page.getByTestId("load-failure")).toContainText("Could not reach the server");
  expect(state.sends).toHaveLength(0);
  expect(state.uploads).toHaveLength(0);
  state.bootstrap = null;
  await page
    .getByTestId("load-failure")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("load-failure")).toHaveCount(0);
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

for (const failure of ["network", 500] as const) {
  test(`an interrupted ${failure} stream preserves editing and sending while reconnecting, then clears its hint`, async ({
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
    await failStream(failure === "network" ? true : failure);
    await expect(page.getByTestId("connection-status")).toContainText("Reconnecting");
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue(
      "An existing draft remains editable.\nThe second line stays intact.",
    );
    await expect(page.getByRole("button", { name: "Remove stream-notes.txt" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      800,
    );
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
}

test("HTTP 500 snapshot and head reads recover automatically with the draft and attachment intact", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  const failStream = await controlledStream(page);
  await ready(page);
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  const text = "Keep this draft while chat reads fail.\nKeep its attachment too.";
  await composer.fill(text);
  await page
    .getByTestId("composer-bar")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "read-recovery.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("scoped attachment during read-only server failure"),
    });
  let unavailable = true;
  let headFailures = 0;
  const recoveredMessage: ThreadMessage = {
    id: "read-recovery-message",
    threadId: "thread-chief",
    botId: "chief",
    seq: 1,
    role: "bot",
    blocks: [{ kind: "text", text: "New reply completed while the chat was reconnecting." }],
    createdAt: stamp,
  };
  state.thread = (route, data) =>
    unavailable
      ? internalReadFailure(route)
      : json(route, { ...data, cursor: 5, messages: [recoveredMessage] });
  await page.route("**/rpc/threads/head", async (route) => {
    if (unavailable) {
      headFailures += 1;
      return internalReadFailure(route);
    }
    return json(route, { threadId: "thread-chief", cursor: 5 });
  });
  await failStream(500);
  await expect(page.getByTestId("connection-status")).toContainText("Reconnecting");
  // Restart the reader once to exercise both initial snapshot and head fallback failures.
  await page
    .getByTestId("connection-status")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect.poll(() => headFailures).toBeGreaterThanOrEqual(2);
  await expect(composer).toHaveValue(text);
  await expect(page.getByRole("button", { name: "Remove read-recovery.txt" })).toBeVisible();
  await expect(composer).toBeEnabled();
  expect(state.sends).toHaveLength(0);
  expect(state.uploads).toHaveLength(0);
  unavailable = false;
  await failStream(false);
  await expect(
    page.getByText("New reply completed while the chat was reconnecting.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  await expect(composer).toHaveValue(text);
  await expect(page.getByRole("button", { name: "Remove read-recovery.txt" })).toBeVisible();
  expect(state.sends).toHaveLength(0);
  expect(state.uploads).toHaveLength(0);
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
  await expect(page.getByTestId("load-failure")).toContainText("This Space is unavailable");
  const initialRequests = state.bootstrapRequests;
  await page.clock.fastForward(30_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(state.bootstrapRequests).toBe(initialRequests);
  expect(state.sends).toHaveLength(0);
  state.bootstrap = null;
  await page
    .getByTestId("load-failure")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("load-failure")).toHaveCount(0);
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

for (const scenario of [
  { group: false, clear: true, expanded: true, race: false },
  { group: true, clear: true, expanded: true, race: false },
  { group: false, clear: false, expanded: true, race: false },
  { group: true, clear: false, expanded: true, race: false },
  { group: false, clear: false, expanded: false, race: false },
  { group: false, clear: true, expanded: true, race: true },
]) {
  test(`manual retry resumes ${scenario.group ? "group" : "bot"} ${scenario.clear ? "clear" : "valid history"} with ${scenario.expanded ? "expanded" : "current page"} and all new messages${scenario.race ? " after an automatic fresh read" : ""}`, async ({
    page,
  }, testInfo) => {
    const { state, errors, unknown } = await mockChat(page);
    const stream = await controlledStream(page);
    const targetId = scenario.group ? "crew" : "chief";
    const threadId = `thread-${targetId}`;
    if (scenario.group)
      state.groups = [
        {
          id: targetId,
          spaceId: "space-primary",
          name: "Crew",
          pinned: false,
          sectionId: null,
          archivedAt: null,
          threadId,
          preview: "Ready",
          unread: false,
          members: state.bots
            .slice(0, 2)
            .map(({ id, name, color }) => ({ botId: id, name, color })),
          updatedAt: stamp,
          createdAt: stamp,
        },
      ];
    const old: ThreadMessage[] = Array.from({ length: 150 }, (_, seq) => ({
      id: `old-${seq}`,
      threadId,
      botId: "chief",
      seq,
      role: "bot",
      blocks: [{ kind: "text", text: `Earlier message ${seq}.` }],
      createdAt: stamp,
    }));
    const incoming: ThreadMessage[] = Array.from({ length: 120 }, (_, index) => ({
      ...old[0]!,
      id: `incoming-${index}`,
      seq: 150 + index,
      blocks: [{ kind: "text", text: `New message ${index}.` }],
    }));
    let recovered = false;
    let blocked = false;
    const snapshot = (data: ThreadSnapshot): ThreadSnapshot => ({
      ...data,
      cursor: recovered ? 270 : 149,
      messages: recovered ? incoming.slice(-100) : old.slice(50),
      olderCursor: recovered ? 170 : 50,
    });
    state.bootstrap = (route, data) => json(route, { ...data, thread: snapshot(data.thread!) });
    state.thread = (route, data) => (blocked ? route.abort("failed") : json(route, snapshot(data)));
    state.messages = (route) =>
      json(route, { threadId, messages: old.slice(0, 50), olderCursor: null });
    await page.route("**/rpc/threads/head", (route) =>
      json(route, { threadId, cursor: recovered ? 270 : 149 }),
    );
    if (scenario.group) {
      await page.goto(`/app/g/${targetId}`);
      await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
    } else await ready(page);
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
    if (scenario.expanded)
      await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
    const transcript = page.getByTestId("transcript");
    const anchor = transcript.locator(`[data-message-id="old-${scenario.expanded ? 7 : 60}"]`);
    await expect(anchor).toHaveCount(1);
    await anchor.scrollIntoViewIfNeeded();
    const composer = page.getByRole("combobox", {
      name: scenario.group ? "Message Crew" : "Message Chief",
      exact: true,
    });
    await composer.fill("@Research");
    await page.getByRole("option", { name: "@Research One", exact: true }).click();
    const draft = "This draft stays here.\nA second unsent line.";
    await composer.fill(draft);
    await page
      .getByTestId("composer-bar")
      .locator('input[type="file"]')
      .setInputFiles({
        name: "resume-notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic attachment"),
      });
    const readsBeforeOutage = state.threadReads.length;
    blocked = !scenario.race;
    if (scenario.race) recovered = true;
    await stream(scenario.race ? true : 403);
    if (scenario.race) {
      await expect.poll(() => state.threadReads.length).toBeGreaterThan(readsBeforeOutage);
      await expect(transcript.locator('[data-message-id^="incoming-"]')).toHaveCount(100);
      await expect(page.getByTestId("connection-status")).toContainText("Reconnecting");
    } else
      await expect(page.getByTestId("connection-status")).toContainText("Chat access interrupted");
    const anchorOffset = () =>
      anchor.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          element.closest('[data-testid="transcript"]')!.getBoundingClientRect().top,
      );
    const offsetBefore = await anchorOffset();
    recovered = true;
    const event = (
      seq: number,
      type: ProductEvent["type"],
      payload: Record<string, unknown>,
    ): ProductEvent => ({
      id: `event-${seq}`,
      threadId,
      botId: "chief",
      spaceId: "space-primary",
      seq,
      type,
      payload,
      createdAt: stamp,
    });
    await stream.replay([
      ...(scenario.clear ? [event(150, "thread.cleared", {})] : []),
      ...incoming.map((message, index) =>
        event(151 + index, index === 0 ? "thread.message.updated" : "thread.message.created", {
          messageId: message.id,
          messageSeq: message.seq,
          role: message.role,
          blocks: message.blocks,
        }),
      ),
    ]);
    blocked = false;
    const beforeRetry = (await stream.cursors()).length;
    if (!scenario.race) await stream(false);
    await page.getByTestId("connection-status").getByRole("button", { name: "Retry" }).click();
    if (scenario.race) {
      await expect.poll(async () => (await stream.cursors()).length).toBeGreaterThan(beforeRetry);
      expect((await stream.cursors()).at(-1)).toBe(149);
      await stream(false);
    }
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
    await expect(transcript.locator('[data-message-id^="old-"]')).toHaveCount(
      scenario.clear ? 0 : scenario.expanded ? 150 : 100,
    );
    const expectedIds = [
      ...(scenario.clear ? [] : old.slice(scenario.expanded ? 0 : 50)),
      ...incoming,
    ].map((message) => message.id);
    await expect
      .poll(() =>
        transcript
          .locator("[data-message-id]")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-message-id"))),
      )
      .toEqual(expectedIds);
    const readsBeforeRefresh = state.threadReads.length;
    await stream(true);
    await expect.poll(() => state.threadReads.length).toBeGreaterThan(readsBeforeRefresh);
    await stream(false);
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
    await expect
      .poll(() =>
        transcript
          .locator("[data-message-id]")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-message-id"))),
      )
      .toEqual(expectedIds);
    if (!scenario.clear)
      expect(Math.abs((await anchorOffset()) - offsetBefore)).toBeLessThanOrEqual(2);
    else await expect(anchor).toHaveCount(0);
    if (!scenario.expanded) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await stream(403);
        await expect(page.getByTestId("connection-status")).toContainText(
          "Chat access interrupted",
        );
        await stream(false);
        await page.getByTestId("connection-status").getByRole("button", { name: "Retry" }).click();
        await expect(page.getByTestId("connection-status")).toHaveCount(0);
        await expect
          .poll(() =>
            transcript
              .locator("[data-message-id]")
              .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-message-id"))),
          )
          .toEqual(expectedIds);
        expect(Math.abs((await anchorOffset()) - offsetBefore)).toBeLessThanOrEqual(2);
      }
    }
    const loadEarlier = page.getByRole("button", { name: "Load earlier messages", exact: true });
    await expect(loadEarlier).toHaveCount(scenario.clear || scenario.expanded ? 0 : 1);
    const cursors = await stream.cursors();
    expect(cursors).toContain(149);
    expect(cursors.at(-1)).toBe(270);
    await expect(composer).toHaveValue(draft);
    await expect(page.getByTestId("mention-chip")).toHaveText(["Research One"]);
    await expect(page.getByRole("button", { name: "Remove resume-notes.txt" })).toBeVisible();
    expect(state.sends).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(unknown).toEqual([]);
    await testInfo.attach("resume-observation", {
      body: JSON.stringify({
        scenario,
        cursorRequests: cursors,
        loadEarlierCount: await loadEarlier.count(),
        renderedIds: await transcript
          .locator("[data-message-id]")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-message-id"))),
        anchorOffsetBefore: offsetBefore,
        anchorOffsetAfter: scenario.clear ? null : await anchorOffset(),
        draftPreserved: (await composer.inputValue()) === draft,
        mentionCount: await page.getByTestId("mention-chip").count(),
        attachmentPreserved: await page
          .getByRole("button", { name: "Remove resume-notes.txt" })
          .isVisible(),
        sendCount: state.sends.length,
        uploadCount: state.uploads.length,
        errors,
        unknown,
      }),
      contentType: "application/json",
    });
    await page.screenshot({ path: testInfo.outputPath("manual-resume.png") });
  });
}

for (const manual of [false, true]) {
  test(`historical execution frames keep authoritative run state during ${manual ? "manual" : "automatic"} recovery`, async ({
    page,
  }) => {
    const { state, errors } = await mockChat(page);
    const stream = await controlledStream(page);
    await page.addInitScript(() => {
      const notifications: string[] = [];
      Object.defineProperty(window, "testNotifications", { value: notifications });
      Object.defineProperty(window, "Notification", {
        value: class {
          static permission = "granted";
          constructor(title: string) {
            notifications.push(title);
          }
          close() {}
        },
      });
      Object.defineProperty(document, "hasFocus", { value: () => false });
    });
    state.sandboxProvider = "docker";
    let recovered = false;
    const snapshot = (data: ThreadSnapshot): ThreadSnapshot => ({
      ...data,
      cursor: recovered ? 270 : 149,
      run: recovered
        ? {
            id: "new-run",
            botId: "chief",
            threadId: "thread-chief",
            taskId: "new-task",
            status: "completed",
            trigger: "user",
            routineId: null,
            modelProvider: null,
            modelId: null,
            error: null,
            startedAt: stamp,
            completedAt: stamp,
            createdAt: stamp,
          }
        : null,
      activeRuns: [],
      computer: {
        botId: "chief",
        mode: "team",
        kind: "fake",
        state: "suspended",
        controlHolder: "none",
        controlBotId: null,
        takeoverRequested: false,
        screenAvailable: false,
        screenWidth: 1024,
        screenHeight: 768,
        homeRevision: null,
        busyBotName: null,
        canUpdate: false,
        terminalAvailable: false,
      },
    });
    state.bootstrap = (route, data) => json(route, { ...data, thread: snapshot(data.thread!) });
    state.thread = (route, data) => json(route, snapshot(data));
    await page.route("**/rpc/threads/head", (route) =>
      json(route, { threadId: "thread-chief", cursor: recovered ? 270 : 149 }),
    );
    await ready(page);
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
    await page.getByTitle("Agent computer").click();
    const preview = page.getByTestId("computer-preview");
    await expect(preview).toContainText("Computer is asleep");
    recovered = true;
    const reads = state.threadReads.length;
    await stream(manual ? 403 : true);
    if (manual)
      await expect(page.getByTestId("connection-status")).toContainText("Chat access interrupted");
    else await expect.poll(() => state.threadReads.length).toBeGreaterThan(reads);
    await stream(false);
    if (manual)
      await page.getByTestId("connection-status").getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
    const stop = page
      .getByTestId("composer-bar")
      .getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toHaveCount(0);
    const event: ProductEvent = {
      id: "old-start",
      spaceId: "space-primary",
      threadId: "thread-chief",
      botId: "chief",
      runId: "old-run",
      seq: 150,
      type: "run.started",
      payload: { trigger: "user" },
      createdAt: stamp,
    };
    await stream.emit(event);
    await painted(page);
    await expect(stop).toHaveCount(0);
    await stream.emit({ ...event, id: "old-done", seq: 151, type: "run.completed" });
    await painted(page);
    await expect(stop).toHaveCount(0);
    await stream.emit({
      ...event,
      id: "old-computer",
      seq: 152,
      type: "computer.status",
      payload: { status: "stopped" },
    });
    await painted(page);
    await expect(preview).toContainText("Computer is asleep");
    await stream.emit(event); // Duplicate delivery cannot revive the completed run.
    await painted(page);
    await expect(stop).toHaveCount(0);
    const live: ProductEvent = {
      ...event,
      id: "live-reply",
      seq: 271,
      type: "thread.message.created",
      payload: {
        messageId: "live-reply",
        messageSeq: 270,
        role: "bot",
        blocks: [{ kind: "text", text: "One live reply" }],
      },
    };
    await stream.emit(live);
    await expect(
      page.getByTestId("transcript").locator('[data-message-id="live-reply"]'),
    ).toHaveCount(1);
    const notifications = () =>
      page.evaluate(() => (window as unknown as { testNotifications: string[] }).testNotifications);
    await expect.poll(notifications).toEqual(["Chief"]);
    await stream.emit(live);
    await painted(page);
    expect(await notifications()).toEqual(["Chief"]);
    expect(state.sends).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}

for (const pending of ["snapshot", "older page", "around page"] as const) {
  test(`clearing the conversation rejects a late ${pending} and its old reading anchor`, async ({
    page,
  }) => {
    const { state, errors } = await mockChat(page);
    const stream = await controlledStream(page);
    const old: ThreadMessage[] = Array.from({ length: 150 }, (_, seq) => ({
      id: `clear-old-${seq}`,
      threadId: "thread-chief",
      botId: "chief",
      seq,
      role: "bot",
      blocks: [{ kind: "text", text: `Old message ${seq}` }],
      createdAt: stamp,
    }));
    let cleared = false;
    const current = (data: ThreadSnapshot): ThreadSnapshot => ({
      ...data,
      cursor: cleared ? 150 : 149,
      messages: cleared ? [] : old.slice(50),
      olderCursor: cleared ? null : 50,
    });
    state.bootstrap = (route, data) => json(route, { ...data, thread: current(data.thread!) });
    state.thread = (route, data) => json(route, current(data));
    await page.route("**/rpc/threads/head", (route) =>
      json(route, { threadId: "thread-chief", cursor: cleared ? 150 : 149 }),
    );
    await page.route("**/rpc/threads/clear", (route) => {
      cleared = true;
      return json(route, { ok: true });
    });
    await ready(page);
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
    const transcript = page.getByTestId("transcript");
    const anchor = transcript.locator('[data-message-id="clear-old-60"]');
    await anchor.scrollIntoViewIfNeeded();
    const held = deferred();
    const release = deferred();
    if (pending === "snapshot") {
      let captured = false;
      state.thread = async (route, data) => {
        const stale = current(data);
        if (captured) return json(route, stale);
        captured = true;
        held.resolve();
        await release.promise;
        return json(route, stale);
      };
      await stream(true);
    } else {
      state.messages = async (route) => {
        held.resolve();
        await release.promise;
        return json(route, {
          threadId: "thread-chief",
          messages: old.slice(0, 50),
          olderCursor: null,
        });
      };
      if (pending === "older page")
        await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
      else
        await page.evaluate(() => {
          window.history.pushState({}, "", "/app/chief?m=clear-old-7");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
    }
    await held.promise;
    const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
    await composer.fill("Keep the unsent draft while clearing history");
    await page
      .getByTestId("bots-sidebar")
      .locator('[data-roster-bot-id="chief"]')
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Clear conversation", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(transcript.locator("[data-message-id]")).toHaveCount(0);
    release.resolve();
    await painted(page);
    await expect(transcript.locator("[data-message-id]")).toHaveCount(0);
    await expect(anchor).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Load earlier messages", exact: true }),
    ).toHaveCount(0);
    await expect(page).not.toHaveURL(/\?m=/);
    await expect(composer).toHaveValue("Keep the unsent draft while clearing history");
    expect(state.sends).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}

test("switching Space discards the old reader checkpoint and late snapshot", async ({ page }) => {
  const { state, errors } = await mockChat(page);
  const stream = await controlledStream(page);
  state.bootstrap = (route, data) =>
    json(route, {
      ...data,
      thread: { ...data.thread!, cursor: data.thread?.botId === "chief" ? 149 : -1 },
    });
  await page.route("**/rpc/threads/head", (route) => {
    const input = route.request().postDataJSON().json;
    return json(route, {
      threadId: `thread-${input.botId}`,
      cursor: input.botId === "chief" ? 149 : -1,
    });
  });
  await ready(page);
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  const held = deferred();
  const release = deferred();
  state.thread = async (route, data) => {
    if (data.botId !== "chief") return json(route, data);
    held.resolve();
    await release.promise;
    return json(route, {
      ...data,
      cursor: 999,
      messages: [
        {
          id: "foreign-late",
          threadId: data.threadId,
          botId: "chief",
          seq: 999,
          role: "bot",
          blocks: [{ kind: "text", text: "Must stay in the previous Space" }],
          createdAt: stamp,
        },
      ],
    });
  };
  await stream(true);
  await held.promise;
  await page.getByTestId("space-menu-trigger").click();
  await page
    .locator('[data-slot="popover-content"]')
    .filter({ has: page.getByTestId("create-new-space") })
    .getByRole("button", { name: "Other Space", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Message Other Chief", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  release.resolve();
  await painted(page);
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="foreign-late"]'),
  ).toHaveCount(0);
  expect((await stream.cursors()).at(-1)).toBe(-1);
  expect(state.sends).toHaveLength(0);
  expect(state.uploads).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("manual retry with no trusted initial checkpoint starts from the fresh authoritative view", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  const stream = await controlledStream(page);
  state.groups = [
    {
      id: "crew",
      spaceId: "space-primary",
      name: "Crew",
      pinned: false,
      sectionId: null,
      archivedAt: null,
      threadId: "thread-crew",
      preview: "Ready",
      unread: false,
      members: state.bots.slice(0, 2).map(({ id, name, color }) => ({ botId: id, name, color })),
      updatedAt: stamp,
      createdAt: stamp,
    },
  ];
  let recovered = false;
  state.bootstrap = (route, data) => json(route, { ...data, thread: null });
  state.thread = (route, data) =>
    recovered
      ? json(route, {
          ...data,
          cursor: 270,
          messages: [
            {
              id: "fresh-only",
              threadId: "thread-crew",
              botId: "chief",
              seq: 269,
              role: "bot",
              blocks: [{ kind: "text", text: "Only the current authoritative message" }],
              createdAt: stamp,
            },
          ],
        })
      : route.fulfill({
          status: 403,
          json: {
            json: {
              defined: false,
              code: "FORBIDDEN",
              status: 403,
              message: "Chat access interrupted",
            },
          },
        });
  await page.route("**/rpc/threads/head", (route) =>
    json(route, { threadId: "thread-crew", cursor: recovered ? 270 : 149 }),
  );
  await page.goto("/app/g/crew");
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "false");
  await expect(page.getByTestId("connection-status")).toContainText("Chat access interrupted");
  const composer = page.getByRole("combobox", { name: "Message Crew", exact: true });
  await composer.fill("Draft during the first rejected read");
  recovered = true;
  await page.getByTestId("connection-status").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("transcript").locator("[data-message-id]")).toHaveAttribute(
    "data-message-id",
    "fresh-only",
  );
  expect((await stream.cursors()).at(-1)).toBe(270);
  await expect(composer).toHaveValue("Draft during the first rejected read");
  expect(state.sends).toHaveLength(0);
  expect(state.uploads).toHaveLength(0);
  expect(errors).toEqual([]);
});

for (const groupTarget of [false, true]) {
  test(`a completed old clear cannot erase the ${groupTarget ? "group" : "bot"} reached through browser Back`, async ({
    page,
  }) => {
    const { state, errors } = await mockChat(page);
    await controlledStream(page);
    state.groups = [
      {
        id: "crew",
        spaceId: "space-primary",
        name: "Crew",
        pinned: false,
        sectionId: null,
        archivedAt: null,
        threadId: "thread-crew",
        preview: "Ready",
        unread: false,
        members: state.bots.slice(0, 2).map(({ id, name, color }) => ({ botId: id, name, color })),
        updatedAt: stamp,
        createdAt: stamp,
      },
    ];
    const withMessage = (data: ThreadSnapshot): ThreadSnapshot => ({
      ...data,
      cursor: 5,
      messages: [
        {
          id: `keep-${data.groupId ?? data.botId}`,
          threadId: data.threadId,
          botId: data.botId ?? "chief",
          seq: 5,
          role: "bot",
          blocks: [
            { kind: "text", text: `Conversation belonging to ${data.groupId ?? data.botId}` },
          ],
          createdAt: stamp,
        },
      ],
    });
    state.bootstrap = (route, data) => json(route, { ...data, thread: withMessage(data.thread!) });
    state.thread = (route, data) => json(route, withMessage(data));
    await page.route("**/rpc/threads/head", (route) => {
      const input = route.request().postDataJSON().json;
      return json(route, { threadId: `thread-${input.groupId ?? input.botId}`, cursor: 5 });
    });
    const started = deferred();
    const release = deferred();
    await page.route("**/rpc/threads/clear", async (route) => {
      started.resolve();
      await release.promise;
      return json(route, { ok: true });
    });
    await ready(page);
    const sidebar = page.getByTestId("bots-sidebar");
    await sidebar
      .locator(
        groupTarget ? '[data-roster-group-id="crew"]' : '[data-roster-bot-id="research-one"]',
      )
      .click();
    const draft = "The other conversation draft belongs here";
    await page
      .getByRole("combobox", {
        name: groupTarget ? "Message Crew" : "Message Research One",
        exact: true,
      })
      .fill(draft);
    await sidebar.locator('[data-roster-bot-id="chief"]').click();
    await expect(page.getByRole("combobox", { name: "Message Chief", exact: true })).toBeVisible();
    await sidebar.locator('[data-roster-bot-id="chief"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Clear conversation", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Clear", exact: true }).click();
    await started.promise;
    // The busy modal blocks sidebar clicks; browser history can still change the route.
    await page.goBack();
    const keep = page
      .getByTestId("transcript")
      .locator(`[data-message-id="keep-${groupTarget ? "crew" : "research-one"}"]`);
    await expect(keep).toHaveCount(1);
    release.resolve();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(keep).toHaveCount(1);
    await expect(
      page.getByRole("combobox", {
        name: groupTarget ? "Message Crew" : "Message Research One",
        exact: true,
      }),
    ).toHaveValue(draft);
    expect(state.sends).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}

test("a late clear receipt keeps messages already consumed after the clear event", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  const stream = await controlledStream(page);
  state.bootstrap = (route, data) =>
    json(route, { ...data, thread: { ...data.thread!, cursor: 149 } });
  await page.route("**/rpc/threads/head", (route) =>
    json(route, { threadId: "thread-chief", cursor: 149 }),
  );
  const started = deferred();
  const release = deferred();
  await page.route("**/rpc/threads/clear", async (route) => {
    started.resolve();
    await release.promise;
    return json(route, { ok: true });
  });
  await ready(page);
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  await page
    .getByTestId("bots-sidebar")
    .locator('[data-roster-bot-id="chief"]')
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Clear conversation", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Clear", exact: true }).click();
  await started.promise;
  const event: ProductEvent = {
    id: "clear-150",
    spaceId: "space-primary",
    threadId: "thread-chief",
    botId: "chief",
    seq: 150,
    type: "thread.cleared",
    payload: {},
    createdAt: stamp,
  };
  await stream.emit(event);
  await stream.emit({
    ...event,
    id: "after-clear-151",
    seq: 151,
    type: "thread.message.created",
    payload: {
      messageId: "valid-after-clear",
      messageSeq: 150,
      role: "bot",
      blocks: [{ kind: "text", text: "This reply was created after clearing history" }],
    },
  });
  const reply = page.getByTestId("transcript").locator('[data-message-id="valid-after-clear"]');
  await expect(reply).toHaveCount(1);
  release.resolve();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(reply).toHaveCount(1);
  expect(state.sends).toHaveLength(0);
  expect(state.uploads).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("a new conversation can load history while the previous page is still pending", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  await controlledStream(page);
  const messages = (id: string): ThreadMessage[] =>
    Array.from({ length: 20 }, (_, seq) => ({
      id: `${id}-${seq}`,
      threadId: `thread-${id}`,
      botId: id,
      seq,
      role: "bot",
      blocks: [{ kind: "text", text: `Conversation ${id} message ${seq}` }],
      createdAt: stamp,
    }));
  const latest = (data: ThreadSnapshot): ThreadSnapshot => ({
    ...data,
    cursor: 19,
    messages: messages(data.botId!).slice(10),
    olderCursor: 10,
  });
  state.bootstrap = (route, data) => json(route, { ...data, thread: latest(data.thread!) });
  state.thread = (route, data) => json(route, latest(data));
  await page.route("**/rpc/threads/head", (route) =>
    json(route, { threadId: `thread-${route.request().postDataJSON().json.botId}`, cursor: 19 }),
  );
  const aStarted = deferred();
  const aRelease = deferred();
  const bStarted = deferred();
  const bRelease = deferred();
  state.messages = async (route) => {
    const id = route.request().postDataJSON().json.botId;
    (id === "chief" ? aStarted : bStarted).resolve();
    await (id === "chief" ? aRelease : bRelease).promise;
    return json(route, {
      threadId: `thread-${id}`,
      messages: messages(id).slice(0, 10),
      olderCursor: null,
    });
  };
  await ready(page);
  const earlier = page.getByRole("button", { name: "Load earlier messages", exact: true });
  await earlier.click();
  await aStarted.promise;
  await page.getByTestId("bots-sidebar").locator('[data-roster-bot-id="research-one"]').click();
  await expect(
    page.getByRole("combobox", { name: "Message Research One", exact: true }),
  ).toBeVisible();
  await expect(earlier).toBeEnabled();
  await earlier.click();
  await bStarted.promise;
  const loading = page.getByRole("button", { name: "Loading…", exact: true });
  await expect(loading).toBeDisabled();
  const aResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/rpc/threads/messages") &&
      response.request().postDataJSON().json.botId === "chief",
  );
  aRelease.resolve();
  await aResponse;
  await painted(page);
  await expect(loading).toBeDisabled();
  await expect(page.getByTestId("transcript").locator('[data-message-id="chief-0"]')).toHaveCount(
    0,
  );
  bRelease.resolve();
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="research-one-0"]'),
  ).toHaveCount(1);
  await expect(loading).toHaveCount(0);
  expect(state.sends).toHaveLength(0);
  expect(state.uploads).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("a failed bootstrap fallback still applies live messages before draft initialization", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  const stream = await controlledStream(page);
  state.bootstrap = (route) =>
    route.fulfill({
      status: 403,
      json: {
        json: {
          defined: false,
          code: "FORBIDDEN",
          status: 403,
          message: "Bootstrap access interrupted",
        },
      },
    });
  state.thread = (route, data) => json(route, { ...data, cursor: 149 });
  await page.route("**/rpc/threads/head", (route) =>
    json(route, { threadId: `thread-${route.request().postDataJSON().json.botId}`, cursor: 149 }),
  );
  await page.goto("/app/chief");
  await expect(page.getByTestId("load-failure")).toContainText("This Space is unavailable");
  await expect.poll(stream.cursors).toContain(149);
  await expect(page.getByRole("combobox", { name: "Message Chief", exact: true })).toBeDisabled();
  const event: ProductEvent = {
    id: "fallback-live-chief",
    spaceId: "space-primary",
    threadId: "thread-chief",
    botId: "chief",
    seq: 150,
    type: "thread.message.created",
    payload: {
      messageId: "fallback-live-chief",
      messageSeq: 0,
      role: "bot",
      blocks: [{ kind: "text", text: "A real-time reply during unavailable bootstrap" }],
    },
    createdAt: stamp,
  };
  await stream.emit(event);
  const transcript = page.getByTestId("transcript");
  await expect(transcript.locator('[data-message-id="fallback-live-chief"]')).toContainText(
    "A real-time reply during unavailable bootstrap",
  );
  await page.getByTestId("bots-sidebar").locator('[data-roster-bot-id="research-one"]').click();
  await expect(
    page.getByRole("combobox", { name: "Message Research One", exact: true }),
  ).toBeDisabled();
  await expect(transcript.locator('[data-message-id="fallback-live-chief"]')).toHaveCount(0);
  const live = {
    ...event,
    id: "fallback-live-research",
    threadId: "thread-research-one",
    botId: "research-one",
    payload: { ...event.payload, messageId: "fallback-live-research" },
  };
  await expect
    .poll(() => state.threadReads.some((read) => read.botId === "research-one"))
    .toBe(true);
  // Without bootstrap context the first sidebar click establishes the Space and reloads.
  await expect.poll(stream.cursors).toContain(149);
  await stream.emit(live);
  await expect(transcript.locator('[data-message-id="fallback-live-research"]')).toHaveCount(1);
  await stream.emit({
    ...event,
    id: "late-chief",
    seq: 151,
    payload: { ...event.payload, messageId: "late-chief" },
  });
  await painted(page);
  await expect(transcript.locator('[data-message-id="late-chief"]')).toHaveCount(0);
  await expect(transcript.locator('[data-message-id="fallback-live-research"]')).toHaveCount(1);
  const requestsBeforeSoftSwitch = (await stream.cursors()).length;
  await page.getByTestId("bots-sidebar").locator('[data-roster-bot-id="research-two"]').click();
  await expect(
    page.getByRole("combobox", { name: "Message Research Two", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(async () => (await stream.cursors()).length)
    .toBeGreaterThan(requestsBeforeSoftSwitch);
  await stream.emit({
    ...live,
    id: "fallback-live-two",
    threadId: "thread-research-two",
    botId: "research-two",
    payload: { ...live.payload, messageId: "fallback-live-two" },
  });
  await expect(transcript.locator('[data-message-id="fallback-live-two"]')).toHaveCount(1);
  await stream.emit({
    ...live,
    id: "late-research-one",
    seq: 151,
    payload: { ...live.payload, messageId: "late-research-one" },
  });
  await painted(page);
  await expect(transcript.locator('[data-message-id="late-research-one"]')).toHaveCount(0);
  expect(state.sends).toHaveLength(0);
  expect(state.uploads).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("finishing bootstrap resets an older-page load from the uninitialized scope", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  const stream = await controlledStream(page);
  const history: ThreadMessage[] = Array.from({ length: 20 }, (_, seq) => ({
    id: `scope-history-${seq}`,
    threadId: "thread-chief",
    botId: "chief",
    seq,
    role: "bot",
    blocks: [{ kind: "text", text: `Known history ${seq}` }],
    createdAt: stamp,
  }));
  const latest = (data: ThreadSnapshot): ThreadSnapshot => ({
    ...data,
    cursor: 19,
    messages: history.slice(10),
    olderCursor: 10,
  });
  state.bootstrap = (route) =>
    route.fulfill({
      status: 403,
      json: {
        json: {
          defined: false,
          code: "FORBIDDEN",
          status: 403,
          message: "Bootstrap access interrupted",
        },
      },
    });
  state.thread = (route, data) => json(route, latest(data));
  await page.route("**/rpc/threads/head", (route) =>
    json(route, { threadId: "thread-chief", cursor: 19 }),
  );
  const started = deferred();
  const release = deferred();
  state.messages = async (route) => {
    started.resolve();
    await release.promise;
    return json(route, {
      threadId: "thread-chief",
      messages: history.slice(0, 10),
      olderCursor: null,
    });
  };
  await page.goto("/app/chief");
  await expect(page.getByTestId("load-failure")).toContainText("This Space is unavailable");
  await expect.poll(stream.cursors).toContain(19);
  const earlier = page.getByRole("button", { name: "Load earlier messages", exact: true });
  await earlier.click();
  await started.promise;
  state.bootstrap = (route, data) => json(route, { ...data, thread: latest(data.thread!) });
  await page.getByTestId("load-failure").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("load-failure")).toHaveCount(0);
  await expect(earlier).toBeEnabled();
  const response = page.waitForResponse((item) => item.url().endsWith("/rpc/threads/messages"));
  release.resolve();
  await response;
  await painted(page);
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="scope-history-0"]'),
  ).toHaveCount(0);
  state.messages = (route) =>
    json(route, { threadId: "thread-chief", messages: history.slice(0, 10), olderCursor: null });
  await earlier.click();
  await expect(
    page.getByTestId("transcript").locator('[data-message-id="scope-history-0"]'),
  ).toHaveCount(1);
  expect(state.sends).toHaveLength(0);
  expect(state.uploads).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("returning through an uninitialized chat does not reuse a previous conversation checkpoint", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  const stream = await controlledStream(page);
  const fresh: ThreadMessage[] = Array.from({ length: 120 }, (_, index) => ({
    id: `return-fresh-${index}`,
    threadId: "thread-chief",
    botId: "chief",
    seq: 150 + index,
    role: "bot",
    blocks: [{ kind: "text", text: `Current reply ${index}` }],
    createdAt: stamp,
  }));
  let returning = false;
  const current = (data: ThreadSnapshot): ThreadSnapshot => ({
    ...data,
    cursor: returning ? 270 : 149,
    messages: returning ? fresh.slice(-100) : [],
    olderCursor: returning ? 170 : null,
  });
  state.bootstrap = (route, data) => json(route, { ...data, thread: current(data.thread!) });
  state.thread = (route, data) =>
    data.botId === "research-one"
      ? route.fulfill({
          status: 403,
          json: {
            json: {
              defined: false,
              code: "FORBIDDEN",
              status: 403,
              message: "Chat access interrupted",
            },
          },
        })
      : json(route, current(data));
  await page.route("**/rpc/threads/head", (route) => {
    const id = route.request().postDataJSON().json.botId;
    return json(route, { threadId: `thread-${id}`, cursor: returning ? 270 : 149 });
  });
  await ready(page);
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  await expect.poll(stream.cursors).toContain(149);
  await page.getByTestId("bots-sidebar").locator('[data-roster-bot-id="research-one"]').click();
  await expect(page.getByTestId("connection-status")).toContainText("Chat access interrupted");
  // This chat committed but never established a snapshot/consumed checkpoint.
  expect((await stream.cursors()).length).toBe(1);
  returning = true;
  const event = (
    seq: number,
    type: ProductEvent["type"],
    payload: Record<string, unknown>,
  ): ProductEvent => ({
    id: `return-event-${seq}`,
    spaceId: "space-primary",
    threadId: "thread-chief",
    botId: "chief",
    seq,
    type,
    payload,
    createdAt: stamp,
  });
  await stream.replay([
    event(150, "thread.cleared", {}),
    ...fresh.map((message, index) =>
      event(151 + index, "thread.message.created", {
        messageId: message.id,
        messageSeq: message.seq,
        role: "bot",
        blocks: message.blocks,
      }),
    ),
  ]);
  await page.goBack();
  await expect(page.getByRole("combobox", { name: "Message Chief", exact: true })).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  expect((await stream.cursors()).at(-1)).toBe(270);
  await expect
    .poll(() =>
      page
        .getByTestId("transcript")
        .locator("[data-message-id]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-message-id"))),
    )
    .toEqual(fresh.slice(-100).map((message) => message.id));
  expect(state.sends).toHaveLength(0);
  expect(state.uploads).toHaveLength(0);
  expect(errors).toEqual([]);
});

for (const group of [false, true]) {
  test(`an event-triggered fresh read protects the ${group ? "group" : "bot"} state from delayed frames`, async ({
    page,
  }) => {
    const { state, errors } = await mockChat(page);
    const stream = await controlledStream(page);
    state.sandboxProvider = "docker";
    const threadId = group ? "thread-crew" : "thread-chief";
    if (group)
      state.groups = [
        {
          id: "crew",
          spaceId: "space-primary",
          name: "Crew",
          pinned: false,
          sectionId: null,
          archivedAt: null,
          threadId,
          preview: "Ready",
          unread: false,
          members: state.bots
            .slice(0, 2)
            .map(({ id, name, color }) => ({ botId: id, name, color })),
          updatedAt: stamp,
          createdAt: stamp,
        },
      ];
    let refreshed = false;
    const snapshot = (data: ThreadSnapshot): ThreadSnapshot => ({
      ...data,
      cursor: refreshed ? 270 : 149,
      messages: [
        {
          id: "refresh-marker",
          threadId,
          botId: "chief",
          seq: 0,
          role: "bot",
          blocks: [
            {
              kind: "text",
              text: refreshed ? "The authoritative read is committed" : "Initial result",
            },
          ],
          createdAt: stamp,
        },
      ],
      run: refreshed
        ? {
            id: "completed-run",
            botId: "chief",
            threadId,
            taskId: "completed-task",
            status: "completed",
            trigger: "user",
            routineId: null,
            modelProvider: null,
            modelId: null,
            error: null,
            startedAt: stamp,
            completedAt: stamp,
            createdAt: stamp,
          }
        : null,
      activeRuns: [],
      computer: {
        botId: "chief",
        mode: "team",
        kind: "fake",
        state: "suspended",
        controlHolder: "none",
        controlBotId: null,
        takeoverRequested: false,
        screenAvailable: false,
        screenWidth: 1024,
        screenHeight: 768,
        homeRevision: null,
        busyBotName: null,
        canUpdate: false,
        terminalAvailable: false,
      },
    });
    state.bootstrap = (route, data) => json(route, { ...data, thread: snapshot(data.thread!) });
    state.thread = (route, data) => json(route, snapshot(data));
    await page.route("**/rpc/threads/head", (route) =>
      json(route, { threadId, cursor: refreshed ? 270 : 149 }),
    );
    if (group) {
      await page.goto("/app/g/crew");
      await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
    } else await ready(page);
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
    const preview = page.getByTestId("computer-preview");
    if (!group) {
      await page.getByTitle("Agent computer").click();
      await expect(preview).toContainText("Computer is asleep");
    }
    refreshed = true;
    const event: ProductEvent = {
      id: "updated-150",
      spaceId: "space-primary",
      threadId,
      botId: "chief",
      seq: 150,
      type: "thread.message.updated",
      payload: {
        messageId: "refresh-marker",
        messageSeq: 0,
        role: "bot",
        blocks: [{ kind: "text", text: "The update triggers a snapshot read" }],
      },
      createdAt: stamp,
    };
    await stream.emit(event);
    await expect(
      page.getByTestId("transcript").locator('[data-message-id="refresh-marker"]'),
    ).toContainText("The authoritative read is committed");
    const stop = page
      .getByTestId("composer-bar")
      .getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toHaveCount(0);
    await stream.emit({
      ...event,
      id: "delayed-start-151",
      seq: 151,
      type: "run.started",
      runId: "older-run",
      payload: { trigger: "user" },
    });
    await painted(page);
    await expect(stop).toHaveCount(0);
    await stream.emit({
      ...event,
      id: "delayed-computer-152",
      seq: 152,
      type: "computer.status",
      payload: { status: "stopped" },
    });
    await painted(page);
    if (!group) await expect(preview).toContainText("Computer is asleep");
    expect(state.sends).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}

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
  test(`a creation receipt rejects an older roster and keeps its Bot when a later refresh ${refreshFails ? "fails" : "succeeds"}`, async ({
    page,
  }, testInfo) => {
    const { state, errors } = await mockChat(page);
    await ready(page);
    const listStarted = deferred();
    const listDelivered = deferred();
    const releaseList = deferred();
    const createCommitted = deferred();
    const releaseCreate = deferred();
    const refreshFinished = deferred();
    let refreshAttempts = 0;
    let captured = false;
    state.list = async (route, snapshot) => {
      if (!captured) {
        captured = true;
        expect(snapshot.current.bots.some((row) => row.id === "created-bot")).toBe(false);
        listStarted.resolve();
        await releaseList.promise;
        await json(route, snapshot);
        listDelivered.resolve();
        return;
      }
      refreshAttempts += 1;
      if (refreshFails) await route.abort("failed");
      else await json(route, snapshot);
      refreshFinished.resolve();
    };
    state.create = async (route, created) => {
      expect(state.bots.some((row) => row.id === created.id)).toBe(true);
      createCommitted.resolve();
      await releaseCreate.promise;
      await json(route, created);
    };
    try {
      await refresh(page, state, true);
      await listStarted.promise;
      await openNewBot(page);
      const form = page.getByTestId("create-bot-form");
      await form.locator("label:has-text('Name') input").fill("Created Companion");
      await form.getByRole("button", { name: "Create", exact: true }).click();
      await createCommitted.promise;
      expect(state.creations).toHaveLength(1);
      const creation = state.creations[0]!;
      expect(creation.spaceId).toBe("space-primary");
      expect(isBotCreationSpawnKey(creation.input.spawnKey)).toBe(true);
      await expect(page).toHaveURL(/\/app\/chief$/);
      releaseCreate.resolve();
      await expect(page).toHaveURL(/\/app\/created-bot$/, { timeout: 3000 });
      await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
      releaseList.resolve();
      await listDelivered.promise;
      await painted(page);
      await expect(page.locator('[data-roster-bot-id="created-bot"]')).toBeVisible({
        timeout: 3000,
      });
      await expect(page).toHaveURL(/\/app\/created-bot$/, { timeout: 3000 });

      // Creation publishes its receipt directly; a later focus refresh is a separate read.
      const readOutcome = refreshFails
        ? page
            .waitForEvent("requestfailed", {
              predicate: (request) => new URL(request.url()).pathname === "/rpc/spaces/list",
            })
            .then((request) => expect(request.failure()?.errorText).toBeTruthy())
        : page
            .waitForResponse((response) => new URL(response.url()).pathname === "/rpc/spaces/list")
            .then(async (response) => {
              expect(response.ok()).toBe(true);
              const snapshot = (await response.json()) as { json: SpaceNavigation };
              expect(snapshot.json.current.bots.some((row) => row.id === "created-bot")).toBe(true);
            });
      await refresh(page, state, true);
      await refreshFinished.promise;
      await readOutcome;
      await painted(page);
      expect(refreshAttempts).toBe(1);
      await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
      await expect(page.locator('[data-roster-bot-id="created-bot"]')).toBeVisible({
        timeout: 3000,
      });
      await expect(page).toHaveURL(/\/app\/created-bot$/, { timeout: 3000 });
      expect(state.botListRequests).toBe(0);
      expect(state.archivedBotListRequests).toBe(0);
      await captureScreenshot(
        page,
        testInfo,
        `created-bot-refresh-${refreshFails ? "failed" : "ok"}`,
      );
      expect(errors).toEqual([]);
    } finally {
      releaseCreate.resolve();
      releaseList.resolve();
    }
  });
}

test("a committed creation without its receipt leaves the other Space isolated after reload", async ({
  page,
}) => {
  const { state, errors } = await mockChat(page);
  await ready(page);
  const createCommitted = deferred();
  const releaseCreate = deferred();
  const createFinished = deferred();
  state.create = async (route, created) => {
    expect(created.spaceId).toBe("space-primary");
    expect(state.bots.some((row) => row.id === created.id)).toBe(true);
    createCommitted.resolve();
    await releaseCreate.promise;
    // Cross-Space navigation reloads the document and abandons its pending receipt.
    await route.abort("aborted");
    createFinished.resolve();
  };
  try {
    await openNewBot(page);
    const form = page.getByTestId("create-bot-form");
    await form.locator("label:has-text('Name') input").fill("Created Companion");
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await createCommitted.promise;
    expect(state.creations).toHaveLength(1);
    const creation = state.creations[0]!;
    expect(creation.spaceId).toBe("space-primary");
    expect(isBotCreationSpawnKey(creation.input.spawnKey)).toBe(true);
    await expect(page).toHaveURL(/\/app\/chief$/);
    await page.getByTestId("space-menu-trigger").click();
    const spaceMenu = page.locator('[data-slot="popover-content"]').filter({
      has: page.getByTestId("create-new-space"),
    });
    await spaceMenu.getByRole("button", { name: "Other Space", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/other-chief$/);
    await expect(page.getByTestId("sidebar-current-space")).toHaveText("Other Space");
    await expect(
      page.getByRole("combobox", { name: "Message Other Chief", exact: true }),
    ).toBeVisible();
    releaseCreate.resolve();
    await createFinished.promise;
    await painted(page);
    await expect(page).toHaveURL(/\/app\/other-chief$/);
    await expect(
      page.locator('[data-sidebar-group^="space:space-other:"] [data-roster-bot-id="created-bot"]'),
    ).toHaveCount(0);
    await expect(
      page.locator(
        '[data-sidebar-group^="space:space-primary:"] [data-roster-bot-id="created-bot"]',
      ),
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
    expect(state.botListRequests).toBe(0);
    expect(state.archivedBotListRequests).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    releaseCreate.resolve();
  }
});
