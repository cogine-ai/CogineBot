// @vitest-environment jsdom
import type { AppBootstrap, Bot, ComputerStatus, ThreadSnapshot } from "@rakazo/contracts";
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
async function render() {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/app/chief"]}>
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
