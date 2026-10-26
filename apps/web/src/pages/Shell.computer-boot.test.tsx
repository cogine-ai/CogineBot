// @vitest-environment jsdom
import type {
  AppBootstrap,
  Bot,
  ComputerStatus,
  ProductEvent,
  ThreadSnapshot,
} from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { NavigateFunction } from "react-router-dom";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  call: vi.fn(),
  bootstrap: vi.fn(),
  session: {
    data: {
      user: { id: "user-1", name: "Tester", email: "tester@example.test" },
      session: { id: "session-1" },
    },
  },
  space: "space-1" as string | null,
  generation: 0,
}));
vi.mock("../lib/rpc", () => {
  const client = (path: string[] = []): unknown =>
    new Proxy(() => {}, {
      get: (_target, key: string) => (key === "then" ? undefined : client([...path, key])),
      apply: (_target, _thisArg, args) => boundary.call(path.join("."), ...args),
    });
  return {
    rpc: client(),
    createSpaceRpc: () => client(),
    selectedSpaceId: () => boundary.space,
    currentSpaceSelectionGeneration: () => boundary.generation,
    selectSpace: (id: string) => {
      boundary.space = id;
      boundary.generation += 1;
      return true;
    },
    clearSpaceSelection: () => {
      boundary.space = null;
      boundary.generation += 1;
    },
  };
});
vi.mock("../lib/auth", () => ({ authClient: { useSession: () => boundary.session } }));
vi.mock("../lib/bootstrap", () => ({
  takeInitialBootstrap: boundary.bootstrap,
  isRecoverableReadError: () => false,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { ShellPage } from "./Shell";

const chief: Bot = {
  id: "chief",
  spaceId: "space-1",
  name: "Chief",
  title: "",
  description: "",
  instructions: "",
  color: "slate",
  notifyOnFinish: false,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "thread-chief",
  preview: "",
  status: "idle",
  runErrorId: null,
  computerMode: "team",
  updatedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
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
function status(botId = chief.id, state: ComputerStatus["state"] = "stopped"): ComputerStatus {
  return {
    botId,
    mode: "team",
    kind: "fake",
    state,
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: state === "running",
    screenWidth: 1280,
    screenHeight: 720,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
  };
}
function snapshot(computer: ComputerStatus): ThreadSnapshot {
  return {
    threadId: `thread-${computer.botId}`,
    botId: computer.botId,
    cursor: -1,
    messages: [],
    olderCursor: null,
    run: null,
    computer,
  };
}
function bootstrap(): AppBootstrap {
  return {
    me: {
      ticketBoardEnabled: false,
      userId: "user-1",
      email: "tester@example.test",
      name: "Tester",
      spaceId: "space-1",
      isDeploymentOwner: true,
      needsModel: false,
      defaultProvider: null,
      defaultModel: null,
      hostCredentialProvider: null,
      hostCredentialSource: null,
      computerHost: "docker",
      canChooseHostComputer: false,
      sandboxProvider: "emulator",
      avatarStyle: "robot",
      billingEnabled: false,
    },
    bots: [chief, { ...chief, id: "worker", name: "Worker", threadId: "thread-worker" }],
    groups: [
      {
        id: "ops",
        spaceId: "space-1",
        name: "Operations",
        pinned: false,
        sectionId: null,
        archivedAt: null,
        members: [
          { botId: "chief", name: "Chief", color: "slate" },
          { botId: "worker", name: "Worker", color: "slate" },
        ],
        threadId: "thread-ops",
        preview: "",
        unread: false,
        updatedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    botSections: [],
    archivedBots: [],
    archivedGroups: [],
    routines: [],
    spaces: [],
    thread: snapshot(status()),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: Root;
let container: HTMLDivElement;
let currentComputer: ComputerStatus;
let firstBoot: ReturnType<typeof deferred<ComputerStatus>>;
let bootCalls: string[];
let boots: Array<ReturnType<typeof deferred<ComputerStatus>>>;
let navigate: NavigateFunction;
function RoutedShell() {
  navigate = useNavigate();
  return <ShellPage />;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  window.localStorage.clear();
  boundary.session.data.user.id = "user-1";
  boundary.session.data.session.id = "session-1";
  boundary.space = "space-1";
  boundary.generation = 0;
  currentComputer = status();
  firstBoot = deferred<ComputerStatus>();
  bootCalls = [];
  boots = [firstBoot];
  boundary.bootstrap.mockResolvedValue(bootstrap());
  boundary.call.mockImplementation(
    async (
      path: string,
      input?: { botId?: string; groupId?: string },
      options?: { signal?: AbortSignal },
    ) => {
      if (path === "computer.boot") {
        bootCalls.push(input!.botId!);
        if (boots[bootCalls.length - 1]) return boots[bootCalls.length - 1]!.promise;
        throw new Error("Computer is busy");
      }
      if (path === "threads.get" && input?.groupId)
        return {
          ...snapshot(status()),
          botId: undefined,
          groupId: input.groupId,
          threadId: `thread-${input.groupId}`,
          members: bootstrap().groups[0]!.members,
        };
      if (path === "threads.get")
        return snapshot(
          input?.botId === currentComputer.botId ? currentComputer : status(input?.botId),
        );
      if (path === "threads.head") return { threadId: `thread-${input?.botId}`, cursor: -1 };
      if (path === "threads.subscribe")
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
          },
        };
      if (path === "computer.screenUrl") return { url: "http://localhost/screen" };
      if (path === "computer.status") return currentComputer;
      if (path === "computer.takeover") {
        currentComputer = {
          ...currentComputer,
          controlHolder: "user",
          controlBotId: input!.botId!,
        };
        return currentComputer;
      }
      if (path === "me") return bootstrap().me;
      if (path === "memory.providerConfig" || path === "voice.status") return null;
      if (path === "messaging.status") return { enabled: false, providers: [] };
      if (path === "usage.summary") return { runs: 0, inputTokens: 0, outputTokens: 0 };
      if (path === "spaces.list")
        return {
          current: {
            id: "space-1",
            name: "Space",
            bots: bootstrap().bots,
            groups: [],
            externalConversations: [],
            botSections: [],
          },
          spaces: [],
        };
      return [];
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(entry = "/app/chief") {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/app/:botId" element={<RoutedShell />} />
          <Route path="/app/g/:groupId" element={<RoutedShell />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
function button(name: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
    (item) =>
      item.getAttribute("aria-label") === name || item.textContent === name || item.title === name,
  );
  if (!found) throw new Error(`missing button: ${name}`);
  return found;
}
async function click(target: HTMLElement) {
  await act(async () => target.click());
}
async function openPanel() {
  await click(button("Agent computer"));
  expect(bootCalls).toEqual(["chief"]);
}

it("keeps the successful Chief auto-panel boot when the full computer opens before it finishes", async () => {
  await render();
  await openPanel();
  await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
  currentComputer = status("chief", "running");
  await act(async () => firstBoot.resolve(currentComputer));
  expect(button("Close computer")).toBeTruthy();
  const chrome = document.querySelector('[data-testid="computer-chrome"]')!;
  expect.soft(bootCalls).toEqual(["chief"]);
  expect.soft(chrome.textContent).toContain("Take control");
  expect(chrome.textContent).toContain("Watching");
  expect(boundary.call.mock.calls.filter(([path]) => path === "computer.takeover")).toHaveLength(0);
  await click(button("Take control", chrome));
  expect(chrome.textContent).toContain("You have control");
});

it("abandons a former bot's boot without letting its finally clear the new bot's attempt", async () => {
  const workerBoot = deferred<ComputerStatus>();
  boots.push(workerBoot);
  await render();
  await openPanel();
  await act(async () => navigate("/app/worker"));
  if (!container.querySelector('[data-testid="computer-preview-open"]'))
    await click(button("Agent computer"));
  await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
  expect(bootCalls).toEqual(["chief", "worker"]);
  await act(async () => firstBoot.resolve(status("chief", "running")));
  expect(document.body.textContent).toContain("Booting up Worker’s computer");
  await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
  expect(bootCalls).toEqual(["chief", "worker"]);
  currentComputer = status("worker", "running");
  await act(async () => workerBoot.resolve(currentComputer));
  expect(document.querySelector('[data-testid="computer-chrome"]')?.textContent).toContain(
    "Take control",
  );
  expect(boundary.call.mock.calls.filter(([path]) => path === "computer.takeover")).toHaveLength(0);
});

it.each(["actor", "session", "space"])(
  "does not reuse an earlier %s authority after leaving and returning",
  async (boundaryKind) => {
    const nextBoot = deferred<ComputerStatus>();
    boots.push(nextBoot);
    await render();
    await openPanel();
    if (boundaryKind === "actor") boundary.session.data.user.id = "user-2";
    else if (boundaryKind === "session") boundary.session.data.session.id = "session-2";
    else {
      boundary.space = "space-2";
      boundary.generation += 1;
    }
    await render();
    if (boundaryKind === "actor") boundary.session.data.user.id = "user-1";
    else if (boundaryKind === "session") boundary.session.data.session.id = "session-1";
    else {
      boundary.space = "space-1";
      boundary.generation += 1;
    }
    await render();
    await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
    expect(bootCalls).toEqual(["chief", "chief"]);
    await act(async () => firstBoot.resolve(status("chief", "running")));
    expect(document.body.textContent).toContain("Booting up Chief’s computer");
    await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
    expect(bootCalls).toEqual(["chief", "chief"]);
    currentComputer = status("chief", "running");
    await act(async () => nextBoot.resolve(currentComputer));
    expect(document.querySelector('[data-testid="computer-chrome"]')?.textContent).toContain(
      "Take control",
    );
  },
);

it("invalidates a screen recovery boot only when the confirmed reset dispatches", async () => {
  currentComputer = status("chief", "running");
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: snapshot(currentComputer) });
  const reset = deferred<void>();
  const otherwise = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path: string, ...args: unknown[]) => {
    if (path === "computer.screenUrl") return Promise.resolve({ url: null });
    if (path === "computer.reset") return reset.promise;
    return otherwise(path, ...args);
  });
  await render();
  await openPanel();
  await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
  await click(button("More computer actions"));
  await click(button("Reset computer"));
  await click(button("Cancel"));
  await click(button("Close computer"));
  await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
  expect(bootCalls).toEqual(["chief"]);
  await click(button("More computer actions"));
  await click(button("Reset computer"));
  await click(button("Reset"));
  expect(boundary.call.mock.calls.filter(([path]) => path === "computer.reset")).toHaveLength(1);
  await act(async () =>
    firstBoot.resolve({ ...currentComputer, controlHolder: "user", controlBotId: "chief" }),
  );
  expect(document.querySelector('[data-testid="computer-chrome"]')?.textContent).toContain(
    "Watching",
  );
  expect(document.body.textContent).not.toContain("You have control");
  currentComputer = status();
  await act(async () => reset.resolve());
  expect(document.querySelector('[data-testid="computer-chrome"]')?.textContent).not.toContain(
    "Take control",
  );
});

it("invalidates a screen recovery boot before changing the computer mode", async () => {
  currentComputer = status("chief", "running");
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: snapshot(currentComputer) });
  const changeMode = deferred<void>();
  const otherwise = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path: string, ...args: unknown[]) => {
    if (path === "computer.screenUrl") return Promise.resolve({ url: null });
    if (path === "bots.setComputer") return changeMode.promise;
    if (path === "bots.update") return Promise.resolve({ ...chief, computerMode: "dedicated" });
    return otherwise(path, ...args);
  });
  await render();
  await openPanel();
  await click(button("Show settings"));
  await click(button("Private"));
  await click(button("Save"));
  expect(boundary.call.mock.calls.filter(([path]) => path === "bots.setComputer")).toHaveLength(1);
  await act(async () =>
    firstBoot.resolve({ ...currentComputer, controlHolder: "user", controlBotId: "chief" }),
  );
  expect(document.body.textContent).not.toContain("You have control");
  const getsBeforeOpen = boundary.call.mock.calls.filter(([path]) => path === "threads.get").length;
  await act(async () => changeMode.resolve());
  expect(boundary.call.mock.calls.filter(([path]) => path === "threads.get")).toHaveLength(
    getsBeforeOpen,
  );
});

it("does not restore a boot observation after Stop dispatches", async () => {
  currentComputer = status("chief", "running");
  let run: ThreadSnapshot["run"] = {
    id: "run-1",
    botId: "chief",
    threadId: "thread-chief",
    taskId: "task-1",
    status: "running",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
  };
  boundary.bootstrap.mockResolvedValue({
    ...bootstrap(),
    thread: { ...snapshot(currentComputer), run },
  });
  const stop = deferred<void>();
  const otherwise = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path: string, ...args: unknown[]) => {
    if (path === "computer.screenUrl") return Promise.resolve({ url: null });
    if (path === "threads.get") return Promise.resolve({ ...snapshot(currentComputer), run });
    if (path === "threads.stop") return stop.promise;
    return otherwise(path, ...args);
  });
  await render();
  await openPanel();
  await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
  await click(button("Stop"));
  expect(boundary.call.mock.calls.filter(([path]) => path === "threads.stop")).toHaveLength(1);
  await act(async () =>
    firstBoot.resolve({ ...currentComputer, controlHolder: "user", controlBotId: "chief" }),
  );
  expect(document.body.textContent).not.toContain("You have control");
  run = null;
  currentComputer = status();
  await act(async () => stop.resolve());
  expect(document.querySelector('[data-testid="computer-chrome"]')?.textContent).not.toContain(
    "Take control",
  );
});

it("ignores a late post-boot refresh after the Space selection changes", async () => {
  await render();
  await openPanel();
  await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
  const refresh = deferred<ThreadSnapshot>();
  const otherwise = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path: string, ...args: unknown[]) =>
    path === "threads.get" ? refresh.promise : otherwise(path, ...args),
  );
  currentComputer = status("chief", "running");
  await act(async () => firstBoot.resolve(currentComputer));
  boundary.space = "space-2";
  boundary.generation += 1;
  await render();
  await act(async () =>
    refresh.resolve(snapshot({ ...currentComputer, controlHolder: "user", controlBotId: "chief" })),
  );
  expect(document.querySelector('[data-testid="computer-chrome"]')?.textContent).toContain(
    "Watching",
  );
  expect(document.body.textContent).not.toContain("You have control");
});

it("does not reuse a boot after visiting a group and returning to the bot", async () => {
  const nextBoot = deferred<ComputerStatus>();
  boots.push(nextBoot);
  await render();
  await openPanel();
  await act(async () => navigate("/app/g/ops"));
  await act(async () => navigate("/app/chief"));
  if (!container.querySelector('[data-testid="computer-preview-open"]'))
    await click(button("Agent computer"));
  await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
  expect(bootCalls).toEqual(["chief", "chief"]);
  await act(async () => firstBoot.resolve(status("chief", "running")));
  expect(document.body.textContent).toContain("Booting up Chief’s computer");
  currentComputer = status("chief", "running");
  await act(async () => nextBoot.resolve(currentComputer));
  expect(document.querySelector('[data-testid="computer-chrome"]')?.textContent).toContain(
    "Watching",
  );
  expect(boundary.call.mock.calls.filter(([path]) => path === "computer.takeover")).toHaveLength(0);
});

it("keeps user takeover unavailable while a Team bot is using the computer", async () => {
  currentComputer = { ...status("chief", "running"), busyBotName: "Chief" };
  const active: ThreadSnapshot = {
    ...snapshot(currentComputer),
    run: {
      id: "run-1",
      botId: "chief",
      threadId: "thread-chief",
      taskId: "task-1",
      status: "running",
      trigger: "user",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-01-01T00:00:00Z",
    },
  };
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: active });
  const otherwise = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path: string, ...args: unknown[]) =>
    path === "threads.get" ? Promise.resolve(active) : otherwise(path, ...args),
  );
  await render();
  await click(button("Agent computer"));
  await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
  const chrome = document.querySelector('[data-testid="computer-chrome"]')!;
  expect(chrome.textContent).toContain("Watching");
  expect(chrome.textContent).not.toContain("Take control");
  expect(bootCalls).toEqual([]);
  expect(boundary.call.mock.calls.filter(([path]) => path === "computer.takeover")).toHaveLength(0);
});

it("keeps a valid computer provision when only the same bot's conversation history changes", async () => {
  currentComputer = status("chief", "running");
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: snapshot(currentComputer) });
  const otherwise = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path: string, ...args: unknown[]) =>
    path === "computer.screenUrl" ? Promise.resolve({ url: null }) : otherwise(path, ...args),
  );
  await render();
  await openPanel();
  await click(button("Show settings"));
  await click(button("Clear conversation"));
  await click(button("Clear"));
  expect(boundary.call.mock.calls.filter(([path]) => path === "threads.clear")).toHaveLength(1);
  await click(button("Show computer"));
  await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
  expect(bootCalls).toEqual(["chief"]);
  await act(async () => firstBoot.resolve(currentComputer));
  const chrome = document.querySelector('[data-testid="computer-chrome"]')!;
  expect(chrome.textContent).toContain("Watching");
  expect(chrome.textContent).toContain("Take control");
  expect(boundary.call.mock.calls.filter(([path]) => path === "computer.takeover")).toHaveLength(0);
});

it.each(["space-1", null])(
  "keeps a visible recovery provision when reselecting the current chat with stored Space %s",
  async (storedSpace) => {
    boundary.space = storedSpace;
    currentComputer = status("chief", "running");
    boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: snapshot(currentComputer) });
    const otherwise = boundary.call.getMockImplementation()!;
    boundary.call.mockImplementation((path: string, ...args: unknown[]) =>
      path === "computer.screenUrl" ? Promise.resolve({ url: null }) : otherwise(path, ...args),
    );
    await render();
    await openPanel();
    expect(document.body.textContent).not.toContain("Booting up");
    const chiefRow = container.querySelector<HTMLElement>('[data-roster-bot-id="chief"]')!;
    expect(chiefRow.getAttribute("aria-current")).toBe("page");
    const generation = boundary.generation;
    await click(chiefRow);
    expect.soft(boundary.generation).toBe(generation);
    await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
    await act(async () => firstBoot.resolve(currentComputer));
    expect.soft(bootCalls).toEqual(["chief"]);
    expect.soft(document.body.textContent).not.toContain("Computer is busy");
    const chrome = document.querySelector('[data-testid="computer-chrome"]')!;
    expect(chrome.textContent).toContain("Watching");
    expect(chrome.textContent).toContain("Take control");
    expect(boundary.call.mock.calls.filter(([path]) => path === "computer.takeover")).toHaveLength(
      0,
    );
  },
);

it("keeps a settled card when an ordinary same-thread search jump finishes after release", async () => {
  Element.prototype.animate = () => ({ cancel() {} }) as Animation;
  const initial: ThreadSnapshot = {
    ...snapshot(status()),
    cursor: 10,
    olderCursor: 1,
    run: {
      id: "run-1",
      botId: "chief",
      threadId: "thread-chief",
      taskId: "task-1",
      status: "waiting_takeover",
      trigger: "user",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-01-01T00:00:00Z",
    },
    messages: [
      {
        id: "card",
        seq: 1,
        threadId: "thread-chief",
        runId: "run-1",
        role: "bot",
        blocks: [{ kind: "computer", text: "Sign in", state: "Needs you" }],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  };
  const oldSnapshot = deferred<ThreadSnapshot>();
  const oldPage = deferred<{
    threadId: string;
    olderCursor: null;
    messages: ThreadSnapshot["messages"];
  }>();
  const pageStarted = deferred<void>();
  const updated = deferred<ProductEvent>();
  const released = deferred<ProductEvent>();
  let server = initial;
  let getReads = 0;
  let pageReads = 0;
  const fallback = boundary.call.getMockImplementation()!;
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: initial });
  boundary.call.mockImplementation(async (path, input, options) => {
    if (path === "threads.get") {
      getReads += 1;
      return getReads === 1 ? oldSnapshot.promise : server;
    }
    if (path === "threads.messages") {
      pageReads += 1;
      if (pageReads === 1) {
        pageStarted.resolve();
        return oldPage.promise;
      }
      return { threadId: server.threadId, olderCursor: null, messages: server.messages };
    }
    if (path === "threads.subscribe")
      return {
        async *[Symbol.asyncIterator]() {
          yield await updated.promise;
          yield await released.promise;
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      };
    return fallback(path, input, options);
  });
  await render();
  expect(container.querySelector('[data-testid="computer-card"]')?.textContent).toContain(
    "Needs you",
  );
  await act(async () => navigate("/app/chief?m=card"));
  await act(async () => oldSnapshot.resolve(initial));
  await pageStarted.promise;
  server = {
    ...initial,
    cursor: 11,
    messages: initial.messages.map((message) => ({
      ...message,
      blocks: [{ kind: "computer", text: "Sign in", state: "Done" }],
    })),
  };
  await act(async () =>
    updated.resolve({
      id: "event-11",
      spaceId: "space-1",
      type: "thread.message.updated",
      seq: 11,
      threadId: initial.threadId,
      botId: "chief",
      runId: "run-1",
      payload: {
        messageId: "card",
        messageSeq: 1,
        role: "bot",
        blocks: [{ kind: "computer", text: "Sign in", state: "Done" }],
      },
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  server = {
    ...server,
    cursor: 12,
    run: initial.run ? { ...initial.run, status: "queued" } : null,
  };
  await act(async () =>
    released.resolve({
      id: "event-12",
      spaceId: "space-1",
      type: "computer.takeover.released",
      seq: 12,
      threadId: initial.threadId,
      botId: "chief",
      runId: "run-1",
      payload: { holder: "none", reason: "done", leaseId: "lease-1" },
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  expect(container.querySelector('[data-testid="computer-card"]')?.textContent).toContain("Done");
  await act(async () =>
    oldPage.resolve({ threadId: initial.threadId, olderCursor: null, messages: initial.messages }),
  );
  expect(container.querySelector('[data-testid="computer-card"]')?.textContent).toContain("Done");
  expect(container.querySelector('[data-testid="computer-card"]')?.textContent).not.toContain(
    "Needs you",
  );
});

it.each(
  ["cold", "cross-low", "cross-equal", "cross-high", "same-thread"].flatMap((origin) =>
    ["bot", "group"].map((kind) => ({ origin, kind })),
  ),
)(
  "opens a $origin $kind message target only after reading its snapshot",
  async ({ origin, kind }) => {
    const targetBot = origin.startsWith("cross") ? "worker" : "chief";
    const target = jumpSnapshot(targetBot, 20, "Done");
    const targetRoute = kind === "group" ? "/app/g/ops" : `/app/${targetBot}`;
    if (kind === "group") {
      target.groupId = "ops";
      delete target.botId;
      target.threadId = "thread-ops";
      target.messages = target.messages.map((message) => ({
        ...message,
        threadId: target.threadId,
      }));
      target.members = bootstrap().groups[0]!.members;
    }
    const get = deferred<ThreadSnapshot>();
    let server: ThreadSnapshot = {
      ...target,
      cursor: 19,
      messages: target.messages.map((message) => ({
        ...message,
        blocks: [{ kind: "computer" as const, text: "Sign in", state: "Needs you" }],
      })),
    };
    let pageReads = 0;
    const scrolled: Array<string | null> = [];
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this.getAttribute("data-message-id"));
    };
    Element.prototype.animate = () => ({ cancel() {} }) as Animation;
    const priorCursor: Record<string, number> = {
      "cross-low": 5,
      "cross-equal": 20,
      "cross-high": 100,
      "same-thread": 10,
    };
    boundary.bootstrap.mockResolvedValue({
      ...bootstrap(),
      thread:
        origin === "cold"
          ? null
          : origin === "same-thread"
            ? { ...target, cursor: 10 }
            : jumpSnapshot("chief", priorCursor[origin]!, "Needs you"),
    });
    const fallback = boundary.call.getMockImplementation()!;
    boundary.call.mockImplementation(async (path, input, options) => {
      if (
        path === "threads.get" &&
        (kind === "group" ? input?.groupId === "ops" : input?.botId === targetBot)
      ) {
        const result = await get.promise;
        server = result;
        return result;
      }
      if (path === "threads.messages") {
        pageReads += 1;
        return {
          threadId: server.threadId,
          olderCursor: null,
          messages: structuredClone(server.messages),
        };
      }
      return fallback(path, input, options);
    });
    await render(
      origin === "cold"
        ? `${targetRoute}?m=card`
        : origin === "same-thread"
          ? targetRoute
          : "/app/chief",
    );
    if (origin !== "cold") await act(async () => navigate(`${targetRoute}?m=card`));
    expect.soft(pageReads).toBe(0);
    await act(async () => get.resolve(target));
    expect(pageReads).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="computer-card"]')?.textContent).toContain("Done");
    expect(scrolled).toContain("card");
  },
);

function jumpSnapshot(botId: string, cursor: number, state: string): ThreadSnapshot {
  return {
    ...snapshot(status(botId)),
    cursor,
    messages: [
      {
        id: "card",
        threadId: `thread-${botId}`,
        seq: 1,
        role: "bot",
        blocks: [{ kind: "computer", text: "Sign in", state }],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  };
}

it.each([false, true])(
  "keeps a cold receipt projection while rejecting a deleted target (deleted=%s)",
  async (deleted) => {
    const get = deferred<ThreadSnapshot>();
    const receipt: ThreadSnapshot["messages"][number] = {
      id: "receipt",
      threadId: "thread-chief",
      seq: 9,
      role: "bot",
      blocks: [{ kind: "bot_message_sent", toBotId: "peer", toBotName: "Peer", text: "Receipt" }],
      createdAt: "2026-01-01T00:00:00Z",
    };
    const target = {
      ...snapshot(status()),
      cursor: 20,
      messages: [
        { ...receipt, id: "base", seq: 1, blocks: [{ kind: "text" as const, text: "Earlier" }] },
      ],
    };
    let serverMessages = [receipt];
    const scrolled: Array<string | null> = [];
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this.getAttribute("data-message-id"));
    };
    Element.prototype.animate = () => ({ cancel() {} }) as Animation;
    boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: null });
    const fallback = boundary.call.getMockImplementation()!;
    boundary.call.mockImplementation(async (path, input, options) => {
      if (path === "threads.get") {
        const result = await get.promise;
        serverMessages = deleted ? [] : [receipt];
        return result;
      }
      if (path === "threads.messages")
        return {
          threadId: target.threadId,
          olderCursor: null,
          messages: structuredClone(serverMessages),
        };
      return fallback(path, input, options);
    });
    await render("/app/chief?m=receipt");
    await act(async () => get.resolve(target));
    expect(container.querySelector('[data-message-id="receipt"]') !== null).toBe(!deleted);
    expect(scrolled.includes("receipt")).toBe(!deleted);
  },
);

it.each(["cold", "cross-high"] as const)(
  "opens older paginated history from a %s route",
  async (origin) => {
    const botId = origin === "cold" ? "chief" : "worker";
    const get = deferred<ThreadSnapshot>();
    const target = {
      ...jumpSnapshot(botId, 20, "Done"),
      olderCursor: 50,
      messages: [
        {
          ...jumpSnapshot(botId, 20, "Done").messages[0]!,
          id: "tail",
          seq: 50,
          blocks: [{ kind: "text" as const, text: "Latest" }],
        },
      ],
    };
    const scrolled: Array<string | null> = [];
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this.getAttribute("data-message-id"));
    };
    Element.prototype.animate = () => ({ cancel() {} }) as Animation;
    boundary.bootstrap.mockResolvedValue({
      ...bootstrap(),
      thread: origin === "cold" ? null : jumpSnapshot("chief", 100, "Needs you"),
    });
    const fallback = boundary.call.getMockImplementation()!;
    boundary.call.mockImplementation(async (path, input, options) => {
      if (path === "threads.get" && input?.botId === botId) return get.promise;
      if (path === "threads.messages")
        return {
          threadId: target.threadId,
          olderCursor: null,
          messages: jumpSnapshot(botId, 20, "Done").messages,
        };
      return fallback(path, input, options);
    });
    await render(origin === "cold" ? "/app/chief?m=card" : "/app/chief");
    if (origin !== "cold") await act(async () => navigate("/app/worker?m=card"));
    await act(async () => get.resolve(target));
    expect(container.querySelector('[data-testid="computer-card"]')?.textContent).toContain("Done");
    expect(scrolled).toContain("card");
  },
);

it.each(["card", null])(
  "resolves the current attention target from its snapshot (%s)",
  async (attentionMessageId) => {
    const get = deferred<ThreadSnapshot>();
    const calls: Array<string | undefined> = [];
    const target = { ...jumpSnapshot("chief", 20, "Done"), attentionMessageId };
    const scrolled: Array<string | null> = [];
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this.getAttribute("data-message-id"));
    };
    Element.prototype.animate = () => ({ cancel() {} }) as Animation;
    const fallback = boundary.call.getMockImplementation()!;
    boundary.call.mockImplementation(async (path, input, options) => {
      if (path === "threads.get") return get.promise;
      if (path === "threads.messages") {
        calls.push(input?.around?.messageId);
        return { threadId: target.threadId, olderCursor: null, messages: target.messages };
      }
      return fallback(path, input, options);
    });
    await render();
    await act(async () => navigate("/app/chief?m=obsolete&attention=1"));
    expect(calls).toEqual([]);
    await act(async () => get.resolve(target));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((id) => id === (attentionMessageId ?? "obsolete"))).toBe(true);
    expect(scrolled.includes("card")).toBe(attentionMessageId !== null);
  },
);

it.each([false, true])(
  "scrolls only to a still-loaded authoritative target after a rejected page (deleted=%s)",
  async (deleted) => {
    const initial = jumpSnapshot("chief", 20, "Needs you");
    const ready = jumpSnapshot("chief", 21, "Done");
    if (deleted) ready.messages = [];
    const oldPage = deferred<{
      threadId: string;
      olderCursor: number;
      messages: ThreadSnapshot["messages"];
    }>();
    const pageStarted = deferred<void>();
    const streamEnded = deferred<void>();
    const stableRoutines: AppBootstrap["routines"] = [];
    let server = initial;
    const scrolled: Array<string | null> = [];
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this.getAttribute("data-message-id"));
    };
    Element.prototype.animate = () => ({ cancel() {} }) as Animation;
    boundary.bootstrap.mockResolvedValue({
      ...bootstrap(),
      thread: initial,
      routines: stableRoutines,
    });
    const fallback = boundary.call.getMockImplementation()!;
    boundary.call.mockImplementation(async (path, input, options) => {
      if (path === "threads.get") return server;
      if (path === "routines.list") return stableRoutines;
      if (path === "threads.messages") {
        pageStarted.resolve();
        return oldPage.promise;
      }
      if (path === "threads.subscribe")
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                await streamEnded.promise;
                return { done: true, value: undefined };
              },
            };
          },
        };
      return fallback(path, input, options);
    });
    await render();
    await act(async () => navigate("/app/chief?m=card"));
    await pageStarted.promise;
    server = ready;
    await act(async () => streamEnded.resolve());
    expect(container.querySelector('[data-testid="computer-card"]') !== null).toBe(!deleted);
    if (!deleted)
      expect(container.querySelector('[data-testid="computer-card"]')?.textContent).toContain(
        "Done",
      );
    await act(async () =>
      oldPage.resolve({ threadId: initial.threadId, olderCursor: 1, messages: initial.messages }),
    );
    expect(scrolled.includes("card")).toBe(!deleted);
    expect(container.querySelector('[data-testid="computer-card"]') !== null).toBe(!deleted);
    expect(container.textContent).not.toContain("Load earlier messages");
  },
);
