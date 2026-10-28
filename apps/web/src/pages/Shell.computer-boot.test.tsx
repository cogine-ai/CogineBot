// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
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
import {
  mergeThreadSnapshot,
  prependThreadMessagePage,
  reconcileRefreshedThread,
  reduceThreadSnapshot,
} from "../lib/thread-events";

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

const testFileUrl = import.meta.url;
const shellSource = readFileSync(new URL("./Shell.tsx", testFileUrl), "utf8");
const olderStart = shellSource.indexOf("  async function loadOlderMessages()");
const olderHandler = `${stripTypeScriptTypes(shellSource.slice(olderStart, shellSource.indexOf("  useEffect(() => {", olderStart)))}\nreturn loadOlderMessages;`;

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
let pageVisibility: DocumentVisibilityState;
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
  pageVisibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => pageVisibility);
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
  vi.useRealTimers();
  vi.restoreAllMocks();
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
async function openPanelAndStartComputer() {
  await click(button("Agent computer"));
  if (currentComputer.state !== "running") {
    expect(bootCalls).toEqual([]);
    await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
  }
  expect(bootCalls).toEqual(["chief"]);
}

it.each(["stopped", "error", undefined] as const)(
  "keeps a %s computer passive when its side panel opens",
  async (state) => {
    const initial = { ...snapshot(status()), computer: state ? status("chief", state) : null };
    boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: initial });
    const otherwise = boundary.call.getMockImplementation()!;
    boundary.call.mockImplementation((path: string, ...args: unknown[]) =>
      path === "threads.get" ? Promise.resolve(initial) : otherwise(path, ...args),
    );
    await render();
    expect(bootCalls).toEqual([]);
    await click(button("Agent computer"));
    expect(container.querySelector('[data-testid="computer-preview-open"]')).toBeTruthy();
    expect.soft(bootCalls).toEqual([]);
    expect(document.body.textContent).not.toContain("Booting up");
    expect(boundary.call.mock.calls.filter(([path]) => path === "computer.recover")).toHaveLength(
      0,
    );
  },
);

it("restores a saved computer panel without booting an idle computer", async () => {
  window.localStorage.setItem(
    "rakazo:right-panel-state:user-1:space-1:bot:chief",
    JSON.stringify({ panel: "computer" }),
  );
  await render();
  expect(container.querySelector('[data-testid="computer-preview-open"]')).toBeTruthy();
  expect(bootCalls).toEqual([]);
  expect(document.body.textContent).not.toContain("Booting up");
});

it("keeps restored computer panels passive across bot switches", async () => {
  for (const botId of ["chief", "worker"])
    window.localStorage.setItem(
      `rakazo:right-panel-state:user-1:space-1:bot:${botId}`,
      JSON.stringify({ panel: "computer" }),
    );
  await render();
  await act(async () => navigate("/app/worker"));
  expect(container.querySelector('[data-testid="computer-preview"]')?.textContent).toContain(
    "Computer is stopped",
  );
  expect.soft(bootCalls).toEqual([]);
  expect(document.body.textContent).not.toContain("Booting up");
  await act(async () => navigate("/app/chief"));
  expect(bootCalls).toEqual([]);
  expect(document.body.textContent).not.toContain("Booting up");
});

it("refreshes a stale booting snapshot before deciding to leave the panel stopped", async () => {
  boundary.bootstrap.mockResolvedValue({
    ...bootstrap(),
    thread: snapshot(status("chief", "booting")),
  });
  await render();
  await click(button("Agent computer"));
  expect(container.querySelector('[data-testid="computer-preview"]')?.textContent).toContain(
    "Computer is stopped",
  );
  expect(bootCalls).toEqual([]);
  expect(document.body.textContent).not.toContain("Booting up");
});

it("reconnects a refreshed running computer without a screen through boot while watching", async () => {
  currentComputer = status("chief", "running");
  const otherwise = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path: string, ...args: unknown[]) =>
    path === "computer.screenUrl" ? Promise.resolve({ url: null }) : otherwise(path, ...args),
  );
  await render();
  await click(button("Agent computer"));
  expect(bootCalls).toEqual(["chief"]);
  expect(document.body.textContent).not.toContain("Booting up");
  expect(document.querySelector('[data-testid="computer-chrome"]')).toBeNull();
  expect(boundary.call.mock.calls.filter(([path]) => path === "computer.recover")).toHaveLength(0);
  expect(boundary.call.mock.calls.filter(([path]) => path === "computer.takeover")).toHaveLength(0);
  await act(async () => firstBoot.resolve(currentComputer));
  expect(bootCalls).toEqual(["chief"]);
});

it("watches a running computer with a screen without booting or taking control", async () => {
  currentComputer = status("chief", "running");
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: snapshot(currentComputer) });
  await render();
  await click(button("Agent computer"));
  expect(container.querySelector('iframe[title="Bot screen preview"]')?.getAttribute("src")).toBe(
    "http://localhost/screen",
  );
  expect(bootCalls).toEqual([]);
  expect(boundary.call.mock.calls.filter(([path]) => path === "computer.recover")).toHaveLength(0);
  expect(boundary.call.mock.calls.filter(([path]) => path === "computer.takeover")).toHaveLength(0);
});

function callsTo(path: string) {
  return boundary.call.mock.calls.filter(([name]) => name === path);
}
async function setPageVisibility(value: DocumentVisibilityState) {
  await act(async () => {
    pageVisibility = value;
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
async function showRunningComputer() {
  currentComputer = status("chief", "running");
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: snapshot(currentComputer) });
  await render();
  await click(button("Agent computer"));
}

it("does not attend or connect a computer while its page is hidden", async () => {
  pageVisibility = "hidden";
  await showRunningComputer();
  expect(callsTo("computer.heartbeat")).toHaveLength(0);
  expect(callsTo("computer.screenUrl")).toHaveLength(0);
  expect(bootCalls).toEqual([]);
});

it("reads current status before attending again and leaves a stopped computer stopped", async () => {
  await showRunningComputer();
  await setPageVisibility("hidden");
  const read = deferred<ComputerStatus>();
  const fallback = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path, input, options) =>
    path === "computer.status" ? read.promise : fallback(path, input, options),
  );
  const attended = callsTo("computer.heartbeat").length;
  const screens = callsTo("computer.screenUrl").length;
  await setPageVisibility("visible");
  expect(callsTo("computer.heartbeat")).toHaveLength(attended);
  expect(callsTo("computer.screenUrl")).toHaveLength(screens);
  await act(async () => read.resolve(status()));
  expect(callsTo("computer.heartbeat")).toHaveLength(attended);
  expect(callsTo("computer.screenUrl")).toHaveLength(screens);
  expect(container.querySelector('[data-testid="computer-preview"]')?.textContent).toContain(
    "Computer is stopped",
  );
  expect(bootCalls).toEqual([]);
  expect(callsTo("computer.takeover")).toHaveLength(0);
  expect(callsTo("computer.release")).toHaveLength(0);
});

it("attends visible watching without requiring window focus and stops when the panel closes", async () => {
  vi.useFakeTimers();
  await showRunningComputer();
  const attended = callsTo("computer.heartbeat").length;
  expect(attended).toBe(1);
  await act(async () => window.dispatchEvent(new Event("blur")));
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(callsTo("computer.heartbeat")).toHaveLength(attended + 1);
  await click(button("Close panel"));
  await act(async () => vi.advanceTimersByTimeAsync(180_000));
  expect(callsTo("computer.heartbeat")).toHaveLength(attended + 1);
  expect(callsTo("computer.release")).toHaveLength(0);
  expect(callsTo("computer.takeover")).toHaveLength(0);
});

it("waits for a pending attendance and never catches up hidden ticks", async () => {
  vi.useFakeTimers();
  const ping = deferred<unknown>();
  const fallback = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path, input, options) =>
    path === "computer.heartbeat" ? ping.promise : fallback(path, input, options),
  );
  await showRunningComputer();
  expect(callsTo("computer.heartbeat")).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(180_000));
  expect(callsTo("computer.heartbeat")).toHaveLength(1);
  await setPageVisibility("hidden");
  await act(async () => ping.resolve({ ok: true }));
  await act(async () => vi.advanceTimersByTimeAsync(180_000));
  expect(callsTo("computer.heartbeat")).toHaveLength(1);
  await setPageVisibility("visible");
  expect(callsTo("computer.heartbeat")).toHaveLength(2);
});

it("retries a failed status read on the next visible tick before sending attendance", async () => {
  vi.useFakeTimers();
  const fallback = boundary.call.getMockImplementation()!;
  let offline = true;
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "computer.status" && offline) return Promise.reject(new Error("offline"));
    return fallback(path, input, options);
  });
  await showRunningComputer();
  expect(callsTo("computer.heartbeat")).toHaveLength(0);
  offline = false;
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(callsTo("computer.heartbeat")).toHaveLength(1);
  expect(bootCalls).toEqual([]);
});

it("discards a status read that finishes after hiding the computer", async () => {
  await showRunningComputer();
  await setPageVisibility("hidden");
  const read = deferred<ComputerStatus>();
  const fallback = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path, input, options) =>
    path === "computer.status" ? read.promise : fallback(path, input, options),
  );
  const attended = callsTo("computer.heartbeat").length;
  const screens = callsTo("computer.screenUrl").length;
  await setPageVisibility("visible");
  await setPageVisibility("hidden");
  await act(async () => read.resolve(status("chief", "running")));
  expect(callsTo("computer.heartbeat")).toHaveLength(attended);
  expect(callsTo("computer.screenUrl")).toHaveLength(screens);
  expect(bootCalls).toEqual([]);
});

it("aborts pending screen reads and discards their results while hidden", async () => {
  const pending: Array<ReturnType<typeof deferred<{ url: string | null }>>> = [];
  const signals: AbortSignal[] = [];
  const fallback = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "computer.screenUrl") {
      const read = deferred<{ url: string | null }>();
      pending.push(read);
      signals.push(options!.signal!);
      return read.promise;
    }
    return fallback(path, input, options);
  });
  await showRunningComputer();
  expect(pending.length).toBeGreaterThan(0);
  await setPageVisibility("hidden");
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  await act(async () => {
    for (const read of pending) read.resolve({ url: "http://localhost/stale-hidden-screen" });
  });
  expect(container.querySelector('iframe[title="Bot screen preview"]')).toBeNull();
  expect(bootCalls).toEqual([]);
});

it("does not overwrite a stopped event with a pending running status read", async () => {
  currentComputer = status("chief", "running");
  const initial = { ...snapshot(currentComputer), cursor: 10 };
  const stopped = deferred<ProductEvent>();
  const read = deferred<ComputerStatus>();
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: initial });
  const fallback = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "threads.get") return Promise.resolve(initial);
    if (path === "computer.status") return read.promise;
    if (path === "threads.subscribe")
      return {
        async *[Symbol.asyncIterator]() {
          yield await stopped.promise;
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      };
    return fallback(path, input, options);
  });
  await render();
  await click(button("Agent computer"));
  await act(async () =>
    stopped.resolve({
      id: "heartbeat-stop-11",
      spaceId: "space-1",
      threadId: initial.threadId,
      botId: "chief",
      type: "computer.status",
      seq: 11,
      payload: { status: "stopped" },
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  await act(async () => read.resolve(status("chief", "running")));
  expect(callsTo("computer.heartbeat")).toHaveLength(0);
  expect(container.querySelector('[data-testid="computer-preview"]')?.textContent).toContain(
    "Computer is stopped",
  );
  expect(bootCalls).toEqual([]);
});

it.each(["space", "account", "session"] as const)(
  "discards an attendance status after its %s changes",
  async (scope) => {
    await showRunningComputer();
    await setPageVisibility("hidden");
    const read = deferred<ComputerStatus>();
    const fallback = boundary.call.getMockImplementation()!;
    let reads = 0;
    boundary.call.mockImplementation((path, input, options) =>
      path === "computer.status"
        ? ++reads === 1
          ? read.promise
          : Promise.resolve(status())
        : fallback(path, input, options),
    );
    const attended = callsTo("computer.heartbeat").length;
    await setPageVisibility("visible");
    const oldSignal = callsTo("computer.status").at(-1)![2]!.signal as AbortSignal;
    if (scope === "space") {
      boundary.space = "space-2";
      boundary.generation += 1;
    } else {
      if (scope === "account") boundary.session.data.user.id = "user-2";
      else boundary.session.data.session.id = "session-2";
      await act(async () => navigate("/app/chief"));
    }
    await act(async () => read.resolve(status("chief", "running")));
    expect(callsTo("computer.heartbeat")).toHaveLength(attended);
    if (scope !== "space") expect(oldSignal.aborted).toBe(true);
    expect(bootCalls).toEqual([]);
  },
);

it("discards the former bot's pending attendance after navigation", async () => {
  await showRunningComputer();
  await setPageVisibility("hidden");
  const read = deferred<ComputerStatus>();
  const fallback = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path, input, options) =>
    path === "computer.status" && input?.botId === "chief"
      ? read.promise
      : fallback(path, input, options),
  );
  const attended = callsTo("computer.heartbeat").filter(
    ([, input]) => input?.botId === "chief",
  ).length;
  await setPageVisibility("visible");
  await act(async () => navigate("/app/worker"));
  await act(async () => read.resolve(status("chief", "running")));
  expect(
    callsTo("computer.heartbeat").filter(([, input]) => input?.botId === "chief"),
  ).toHaveLength(attended);
  expect(bootCalls).toEqual([]);
});

it("keeps one attendance lifecycle while moving between preview and full window", async () => {
  await showRunningComputer();
  const attended = callsTo("computer.heartbeat").length;
  await click(container.querySelector<HTMLElement>('[data-testid="computer-preview-open"]')!);
  expect(button("Close computer")).toBeTruthy();
  expect(callsTo("computer.heartbeat")).toHaveLength(attended);
  await click(button("Close computer"));
  expect(callsTo("computer.heartbeat")).toHaveLength(attended);
  expect(container.querySelector('iframe[title="Bot screen preview"]')).not.toBeNull();
  expect(bootCalls).toEqual([]);
  expect(callsTo("computer.takeover")).toHaveLength(0);
  expect(callsTo("computer.release")).toHaveLength(0);
});

it("waits for fresh foreground status before remounting a cached screen", async () => {
  await showRunningComputer();
  expect(container.querySelector('iframe[title="Bot screen preview"]')).not.toBeNull();
  await setPageVisibility("hidden");
  expect(container.querySelector('iframe[title="Bot screen preview"]')).toBeNull();
  const read = deferred<ComputerStatus>();
  const fallback = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path, input, options) =>
    path === "computer.status" ? read.promise : fallback(path, input, options),
  );
  await setPageVisibility("visible");
  expect(container.querySelector('iframe[title="Bot screen preview"]')).toBeNull();
  await act(async () => read.resolve(status("chief", "running")));
  expect(container.querySelector('iframe[title="Bot screen preview"]')).not.toBeNull();
  expect(bootCalls).toEqual([]);
});

it("does not mount an explicit Open result that finishes after the page hides", async () => {
  await render();
  await openPanelAndStartComputer();
  await setPageVisibility("hidden");
  currentComputer = status("chief", "running");
  await act(async () => firstBoot.resolve(currentComputer));
  expect(document.querySelector('iframe[title="Bot screen"]')).toBeNull();
  expect(document.querySelector('iframe[title="Bot screen preview"]')).toBeNull();
  expect(callsTo("computer.takeover")).toHaveLength(0);
  expect(callsTo("computer.release")).toHaveLength(0);
  await setPageVisibility("visible");
  expect(document.querySelector('iframe[title="Bot screen"]')).not.toBeNull();
  expect(bootCalls).toEqual(["chief"]);
});

it("does not attend or schedule work after the computer surface unmounts", async () => {
  vi.useFakeTimers();
  await showRunningComputer();
  await setPageVisibility("hidden");
  const read = deferred<ComputerStatus>();
  const fallback = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path, input, options) =>
    path === "computer.status" ? read.promise : fallback(path, input, options),
  );
  const attended = callsTo("computer.heartbeat").length;
  await setPageVisibility("visible");
  const signal = callsTo("computer.status").at(-1)![2]!.signal as AbortSignal;
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  await act(async () => read.resolve(status("chief", "running")));
  await act(async () => vi.advanceTimersByTimeAsync(180_000));
  expect(callsTo("computer.heartbeat")).toHaveLength(attended);
});

it("does not connect a late thread snapshot before fresh foreground status completes", async () => {
  currentComputer = status("chief", "running");
  const initial = { ...snapshot(currentComputer), cursor: 10 };
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: initial });
  const thread = deferred<ThreadSnapshot>();
  const read = deferred<ComputerStatus>();
  const fallback = boundary.call.getMockImplementation()!;
  let returning = false;
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "threads.get") return thread.promise;
    if (path === "computer.status" && returning) return read.promise;
    return fallback(path, input, options);
  });
  await render();
  await click(button("Agent computer"));
  await setPageVisibility("hidden");
  returning = true;
  const attended = callsTo("computer.heartbeat").length;
  const screens = callsTo("computer.screenUrl").length;
  await setPageVisibility("visible");
  await act(async () => thread.resolve(initial));
  expect(callsTo("computer.screenUrl")).toHaveLength(screens);
  expect(document.querySelector('iframe[title="Bot screen preview"]')).toBeNull();
  await act(async () => read.resolve(status()));
  expect(callsTo("computer.screenUrl")).toHaveLength(screens);
  expect(callsTo("computer.heartbeat")).toHaveLength(attended);
  expect(bootCalls).toEqual([]);
});

it("shows a successful explicit Open immediately after a stopped foreground status", async () => {
  await render();
  await openPanelAndStartComputer();
  currentComputer = status("chief", "running");
  await act(async () => firstBoot.resolve(currentComputer));
  expect(document.querySelector('iframe[title="Bot screen"]')?.getAttribute("src")).toBe(
    "http://localhost/screen",
  );
  expect(bootCalls).toEqual(["chief"]);
  expect(callsTo("computer.takeover")).toHaveLength(0);
});

it("cannot turn a superseded panel read into boot during a rapid visibility return", async () => {
  currentComputer = status("chief", "running");
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: snapshot(currentComputer) });
  const firstStatus = deferred<ComputerStatus>();
  const fallback = boundary.call.getMockImplementation()!;
  let reads = 0;
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "computer.status" && ++reads === 1) return firstStatus.promise;
    if (path === "computer.screenUrl") return Promise.resolve({ url: null });
    return fallback(path, input, options);
  });
  await render();
  await click(button("Agent computer"));
  await act(async () => {
    pageVisibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    pageVisibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    firstStatus.resolve(status("chief", "running"));
  });
  expect(bootCalls).toEqual([]);
  expect(callsTo("computer.heartbeat")).toHaveLength(1);
});

function installComputerStatusStream() {
  const first = deferred<ProductEvent>();
  const second = deferred<ProductEvent>();
  const fallback = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "threads.subscribe")
      return {
        async *[Symbol.asyncIterator]() {
          yield await first.promise;
          if (options?.signal?.aborted) return;
          yield await second.promise;
          if (options?.signal?.aborted) return;
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      };
    return fallback(path, input, options);
  });
  const event = (seq: number, botId = "chief"): ProductEvent => ({
    id: `computer-running-${seq}`,
    spaceId: "space-1",
    threadId: "thread-chief",
    botId,
    type: "computer.status",
    seq,
    payload: { status: "running" },
    createdAt: "2026-01-01T00:00:00Z",
  });
  return { first, second, event };
}

it.each(["stopped", "suspended", "booting"] as const)(
  "refreshes a visible %s computer immediately after an accepted running event",
  async (initialState) => {
    vi.useFakeTimers();
    currentComputer = status("chief", initialState);
    boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: snapshot(currentComputer) });
    const stream = installComputerStatusStream();
    await render();
    await click(button("Agent computer"));
    expect(callsTo("computer.status")).toHaveLength(1);
    expect(callsTo("computer.heartbeat")).toHaveLength(0);
    expect(callsTo("computer.screenUrl")).toHaveLength(0);
    const fresh = deferred<ComputerStatus>();
    const fallback = boundary.call.getMockImplementation()!;
    boundary.call.mockImplementation((path, input, options) =>
      path === "computer.status" ? fresh.promise : fallback(path, input, options),
    );
    await act(async () => stream.first.resolve(stream.event(11)));
    expect(callsTo("computer.status")).toHaveLength(2);
    expect(callsTo("computer.heartbeat")).toHaveLength(0);
    expect(callsTo("computer.screenUrl")).toHaveLength(0);
    expect(container.querySelector('iframe[title="Bot screen preview"]')).toBeNull();
    await act(async () => fresh.resolve(status("chief", "running")));
    expect(callsTo("computer.heartbeat")).toHaveLength(1);
    expect(callsTo("computer.screenUrl")).toHaveLength(1);
    expect(container.querySelector('iframe[title="Bot screen preview"]')).not.toBeNull();
    expect(bootCalls).toEqual([]);
    expect(callsTo("computer.takeover")).toHaveLength(0);
    await act(async () => stream.second.resolve(stream.event(12)));
    expect(callsTo("computer.status")).toHaveLength(2);
    expect(callsTo("computer.heartbeat")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(callsTo("computer.heartbeat")).toHaveLength(2);
  },
);

it("queues one immediate recheck after a pending nonrunning status is superseded by running", async () => {
  currentComputer = status();
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: snapshot(currentComputer) });
  const stream = installComputerStatusStream();
  const stale = deferred<ComputerStatus>();
  const fresh = deferred<ComputerStatus>();
  const fallback = boundary.call.getMockImplementation()!;
  let reads = 0;
  let firstSignal: AbortSignal | undefined;
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "computer.status") {
      reads += 1;
      if (reads === 1) firstSignal = options?.signal;
      return reads === 1 ? stale.promise : fresh.promise;
    }
    return fallback(path, input, options);
  });
  await render();
  await click(button("Agent computer"));
  await act(async () => stream.first.resolve(stream.event(11)));
  await act(async () => stream.second.resolve(stream.event(12)));
  expect(firstSignal?.aborted).toBe(true);
  expect(reads).toBe(1);
  expect(callsTo("computer.screenUrl")).toHaveLength(0);
  await act(async () => stale.resolve(status()));
  expect(reads).toBe(2);
  expect(callsTo("computer.heartbeat")).toHaveLength(0);
  expect(bootCalls).toEqual([]);
  await act(async () => fresh.resolve(status("chief", "running")));
  expect(callsTo("computer.heartbeat")).toHaveLength(1);
  expect(callsTo("computer.screenUrl")).toHaveLength(1);
  expect(container.querySelector('iframe[title="Bot screen preview"]')).not.toBeNull();
  expect(bootCalls).toEqual([]);
  expect(callsTo("computer.takeover")).toHaveLength(0);
});

it.each(["hidden", "closed", "other bot", "other Space", "historical event"] as const)(
  "does not recheck a running event for a %s surface",
  async (excluded) => {
    currentComputer = status();
    const initial = { ...snapshot(currentComputer), cursor: 10 };
    boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: initial });
    const stream = installComputerStatusStream();
    await render();
    await click(button("Agent computer"));
    if (excluded === "hidden") await setPageVisibility("hidden");
    if (excluded === "closed") await click(button("Close panel"));
    if (excluded === "other bot") await act(async () => navigate("/app/worker"));
    if (excluded === "other Space") {
      boundary.space = "space-2";
      boundary.generation += 1;
    }
    const reads = callsTo("computer.status").length;
    await act(async () =>
      stream.first.resolve(stream.event(excluded === "historical event" ? 9 : 11)),
    );
    expect(callsTo("computer.status")).toHaveLength(reads);
    expect(callsTo("computer.heartbeat")).toHaveLength(0);
    expect(callsTo("computer.screenUrl")).toHaveLength(0);
    expect(bootCalls).toEqual([]);
    expect(callsTo("computer.takeover")).toHaveLength(0);
  },
);

it("requires the event-triggered current read to report running before it connects", async () => {
  currentComputer = status();
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: snapshot(currentComputer) });
  const stream = installComputerStatusStream();
  await render();
  await click(button("Agent computer"));
  await act(async () => stream.first.resolve(stream.event(11)));
  expect(callsTo("computer.status")).toHaveLength(2);
  expect(callsTo("computer.heartbeat")).toHaveLength(0);
  expect(callsTo("computer.screenUrl")).toHaveLength(0);
  expect(container.querySelector('iframe[title="Bot screen preview"]')).toBeNull();
  currentComputer = status("chief", "running");
  await act(async () => stream.second.resolve(stream.event(12)));
  expect(callsTo("computer.status")).toHaveLength(3);
  expect(callsTo("computer.heartbeat")).toHaveLength(1);
  expect(callsTo("computer.screenUrl")).toHaveLength(1);
  expect(bootCalls).toEqual([]);
  expect(callsTo("computer.takeover")).toHaveLength(0);
});

it("revokes a previously verified frame and late screen read during a stopped-to-running recheck", async () => {
  const stream = installComputerStatusStream();
  await showRunningComputer();
  expect(container.querySelector('iframe[title="Bot screen preview"]')?.getAttribute("src")).toBe(
    "http://localhost/screen",
  );
  const oldScreen = deferred<{ url: string | null }>();
  const fresh = deferred<ComputerStatus>();
  const fallback = boundary.call.getMockImplementation()!;
  let pendingStatus = false;
  let useFreshScreen = false;
  const oldSignals: AbortSignal[] = [];
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "computer.status" && pendingStatus) return fresh.promise;
    if (path === "computer.screenUrl") {
      if (useFreshScreen) return Promise.resolve({ url: "http://localhost/new-running-screen" });
      oldSignals.push(options!.signal!);
      return oldScreen.promise;
    }
    return fallback(path, input, options);
  });
  await act(async () =>
    stream.first.resolve({
      ...stream.event(11),
      payload: { status: "stopped" },
    }),
  );
  expect(container.querySelector('iframe[title="Bot screen preview"]')).toBeNull();
  pendingStatus = true;
  await act(async () => stream.second.resolve(stream.event(12)));
  expect(callsTo("computer.status")).toHaveLength(2);
  expect(container.querySelector('iframe[title="Bot screen preview"]')).toBeNull();
  expect(oldSignals.every((signal) => signal.aborted)).toBe(true);
  await act(async () => oldScreen.resolve({ url: "http://localhost/stale-running-screen" }));
  expect(container.querySelector('iframe[title="Bot screen preview"]')).toBeNull();
  useFreshScreen = true;
  await act(async () => fresh.resolve(status("chief", "running")));
  expect(container.querySelector('iframe[title="Bot screen preview"]')?.getAttribute("src")).toBe(
    "http://localhost/new-running-screen",
  );
  expect(callsTo("computer.heartbeat")).toHaveLength(2);
  expect(bootCalls).toEqual([]);
  expect(callsTo("computer.takeover")).toHaveLength(0);
});

it("rechecks a running snapshot that commits before its historical running event", async () => {
  currentComputer = status();
  const initial = snapshot(currentComputer);
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: initial });
  const stream = installComputerStatusStream();
  const fresh = deferred<ComputerStatus>();
  const fallback = boundary.call.getMockImplementation()!;
  let authoritative = initial;
  let waitForCurrent = false;
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "threads.get") return Promise.resolve(authoritative);
    if (path === "computer.status" && waitForCurrent) return fresh.promise;
    return fallback(path, input, options);
  });
  await render();
  await click(button("Agent computer"));
  expect(callsTo("computer.status")).toHaveLength(1);
  currentComputer = status("chief", "running");
  authoritative = { ...snapshot(currentComputer), cursor: 20 };
  waitForCurrent = true;
  await act(async () =>
    stream.first.resolve({
      ...stream.event(11),
      type: "run.completed",
      runId: "source-run",
      payload: {},
    }),
  );
  expect(callsTo("computer.status")).toHaveLength(2);
  expect(callsTo("computer.heartbeat")).toHaveLength(0);
  expect(callsTo("computer.screenUrl")).toHaveLength(0);
  expect(container.querySelector('iframe[title="Bot screen preview"]')).toBeNull();
  await act(async () => fresh.resolve(currentComputer));
  expect(callsTo("computer.heartbeat")).toHaveLength(1);
  expect(container.querySelector('iframe[title="Bot screen preview"]')).not.toBeNull();
  await act(async () => stream.second.resolve(stream.event(12)));
  expect(callsTo("computer.status")).toHaveLength(2);
  expect(callsTo("computer.heartbeat")).toHaveLength(1);
  expect(bootCalls).toEqual([]);
  expect(callsTo("computer.takeover")).toHaveLength(0);
});

it("queues a fresh check when a running snapshot supersedes a pending nonrunning read", async () => {
  currentComputer = status();
  const initial = snapshot(currentComputer);
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: initial });
  const stream = installComputerStatusStream();
  const stale = deferred<ComputerStatus>();
  const fresh = deferred<ComputerStatus>();
  const fallback = boundary.call.getMockImplementation()!;
  let authoritative = initial;
  let reads = 0;
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "threads.get") return Promise.resolve(authoritative);
    if (path === "computer.status") return ++reads === 1 ? stale.promise : fresh.promise;
    return fallback(path, input, options);
  });
  await render();
  await click(button("Agent computer"));
  currentComputer = status("chief", "running");
  authoritative = { ...snapshot(currentComputer), cursor: 20 };
  await act(async () =>
    stream.first.resolve({
      ...stream.event(11),
      type: "run.completed",
      runId: "source-run",
      payload: {},
    }),
  );
  expect(reads).toBe(1);
  expect(callsTo("computer.screenUrl")).toHaveLength(0);
  await act(async () => stale.resolve(status()));
  expect(reads).toBe(2);
  expect(callsTo("computer.screenUrl")).toHaveLength(0);
  expect(callsTo("computer.heartbeat")).toHaveLength(0);
  expect(bootCalls).toEqual([]);
  await act(async () => fresh.resolve(currentComputer));
  expect(callsTo("computer.heartbeat")).toHaveLength(1);
  expect(container.querySelector('iframe[title="Bot screen preview"]')).not.toBeNull();
  expect(bootCalls).toEqual([]);
});

it("allows a later accepted running event to retry a failed status recheck", async () => {
  currentComputer = status();
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: snapshot(currentComputer) });
  const stream = installComputerStatusStream();
  await render();
  await click(button("Agent computer"));
  const fallback = boundary.call.getMockImplementation()!;
  let offline = true;
  boundary.call.mockImplementation((path, input, options) =>
    path === "computer.status" && offline
      ? Promise.reject(new Error("offline"))
      : fallback(path, input, options),
  );
  await act(async () => stream.first.resolve(stream.event(11)));
  expect(callsTo("computer.status")).toHaveLength(2);
  expect(callsTo("computer.heartbeat")).toHaveLength(0);
  offline = false;
  currentComputer = status("chief", "running");
  await act(async () => stream.second.resolve(stream.event(12)));
  expect(callsTo("computer.status")).toHaveLength(3);
  expect(callsTo("computer.heartbeat")).toHaveLength(1);
  expect(container.querySelector('iframe[title="Bot screen preview"]')).not.toBeNull();
  expect(bootCalls).toEqual([]);
});

it("keeps a committed stopped computer passive when an older running snapshot returns", async () => {
  const committed = { ...snapshot(status()), cursor: 20 };
  const older = { ...snapshot(status("chief", "running")), cursor: 10 };
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: committed });
  const otherwise = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path: string, ...args: unknown[]) => {
    if (path === "threads.get") return Promise.resolve(older);
    if (path === "computer.screenUrl") return Promise.resolve({ url: null });
    return otherwise(path, ...args);
  });
  await render();
  await click(button("Agent computer"));
  expect(container.querySelector('[data-testid="computer-preview"]')?.textContent).toContain(
    "Computer is stopped",
  );
  expect(bootCalls).toEqual([]);
  expect(boundary.call.mock.calls.filter(([path]) => path === "computer.recover")).toHaveLength(0);
});

it("keeps a computer stopped when its status changes during a pending panel screen refresh", async () => {
  currentComputer = status("chief", "running");
  const initial = { ...snapshot(currentComputer), cursor: 10 };
  const stopped = deferred<ProductEvent>();
  const screens: Array<ReturnType<typeof deferred<{ url: string | null }>>> = [];
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: initial });
  const fallback = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "threads.get") return Promise.resolve(initial);
    if (path === "computer.screenUrl") {
      const screen = deferred<{ url: string | null }>();
      screens.push(screen);
      return screen.promise;
    }
    if (path === "threads.subscribe")
      return {
        async *[Symbol.asyncIterator]() {
          yield await stopped.promise;
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      };
    return fallback(path, input, options);
  });
  await render();
  await click(button("Agent computer"));
  expect(screens.length).toBeGreaterThan(0);
  expect(bootCalls).toEqual([]);
  await act(async () =>
    stopped.resolve({
      id: "computer-stopped-11",
      spaceId: "space-1",
      threadId: initial.threadId,
      botId: "chief",
      type: "computer.status",
      seq: 11,
      payload: { status: "stopped" },
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  expect(container.querySelector('[data-testid="computer-preview"]')?.textContent).toContain(
    "Computer is stopped",
  );
  await act(async () => {
    for (const screen of screens) screen.resolve({ url: null });
  });
  expect(bootCalls).toEqual([]);
  expect(document.body.textContent).not.toContain("Booting up");
});

it("uses the latest stopped status before requesting the panel screen after an older snapshot", async () => {
  currentComputer = status("chief", "running");
  const initial = { ...snapshot(currentComputer), cursor: 10 };
  const refresh = deferred<ThreadSnapshot>();
  const stopped = deferred<ProductEvent>();
  let screenReads = 0;
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: initial });
  const fallback = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "threads.get") return refresh.promise;
    if (path === "computer.screenUrl") {
      screenReads += 1;
      return Promise.resolve({ url: null });
    }
    if (path === "threads.subscribe")
      return {
        async *[Symbol.asyncIterator]() {
          yield await stopped.promise;
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      };
    return fallback(path, input, options);
  });
  await render();
  await click(button("Agent computer"));
  await act(async () =>
    stopped.resolve({
      id: "computer-stopped-11",
      spaceId: "space-1",
      threadId: initial.threadId,
      botId: "chief",
      type: "computer.status",
      seq: 11,
      payload: { status: "stopped" },
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  expect(container.querySelector('[data-testid="computer-preview"]')?.textContent).toContain(
    "Computer is stopped",
  );
  const readsBeforeSnapshot = screenReads;
  await act(async () => refresh.resolve({ ...initial, cursor: 9 }));
  // The thread refresh loads its screen; the stopped panel must not request another one.
  expect(screenReads - readsBeforeSnapshot).toBe(1);
  expect(bootCalls).toEqual([]);
});

it("keeps a newer committed screen when an older panel screen refresh is superseded", async () => {
  currentComputer = status("chief", "running");
  const initial = { ...snapshot(currentComputer), cursor: 10 };
  const updated = deferred<ProductEvent>();
  const pending: Array<ReturnType<typeof deferred<{ url: string | null }>>> = [];
  const latestUrl = "http://localhost/current-screen";
  let latestScreen = false;
  boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: initial });
  const fallback = boundary.call.getMockImplementation()!;
  boundary.call.mockImplementation((path, input, options) => {
    if (path === "threads.get") return Promise.resolve(initial);
    if (path === "computer.screenUrl") {
      if (latestScreen) return Promise.resolve({ url: latestUrl });
      const screen = deferred<{ url: string | null }>();
      pending.push(screen);
      return screen.promise;
    }
    if (path === "threads.subscribe")
      return {
        async *[Symbol.asyncIterator]() {
          yield await updated.promise;
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      };
    return fallback(path, input, options);
  });
  await render();
  await click(button("Agent computer"));
  expect(pending.length).toBeGreaterThan(0);
  latestScreen = true;
  await act(async () =>
    updated.resolve({
      id: "computer-running-11",
      spaceId: "space-1",
      threadId: initial.threadId,
      botId: "chief",
      type: "computer.status",
      seq: 11,
      payload: { status: "running" },
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  expect(container.querySelector('iframe[title="Bot screen preview"]')?.getAttribute("src")).toBe(
    latestUrl,
  );
  await act(async () => {
    for (const screen of pending) screen.resolve({ url: null });
  });
  expect(bootCalls).toEqual([]);
  expect(container.querySelector('iframe[title="Bot screen preview"]')?.getAttribute("src")).toBe(
    latestUrl,
  );
});

it("keeps the successful Chief Open boot when the full computer opens again before it finishes", async () => {
  await render();
  await openPanelAndStartComputer();
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
  await openPanelAndStartComputer();
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
    await openPanelAndStartComputer();
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
  await openPanelAndStartComputer();
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
  await openPanelAndStartComputer();
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
  await openPanelAndStartComputer();
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
  await openPanelAndStartComputer();
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
  await openPanelAndStartComputer();
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
  await openPanelAndStartComputer();
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
    await openPanelAndStartComputer();
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

it.each(
  (["thread.message.created", "thread.message.updated"] as const).flatMap((type) =>
    ["pre-clear", "known-fallback", "admitted"].flatMap((scenario) =>
      [false, true].map((inGroup) => ({ type, scenario, inGroup })),
    ),
  ),
)(
  "retains history only after admitted $type replay ($scenario, group=$inGroup)",
  async ({ type, scenario, inGroup }) => {
    const initial: ThreadSnapshot = {
      ...jumpSnapshot("chief", 5, "Done"),
      olderCursor: 1,
      ...(inGroup ? { botId: undefined, groupId: "ops", threadId: "thread-ops" } : {}),
      messages: [
        {
          ...jumpSnapshot("chief", 5, "Done").messages[0]!,
          id: "anchor",
          threadId: inGroup ? "thread-ops" : "thread-chief",
          blocks: [{ kind: "text", text: "Initial anchor" }],
        },
      ],
    };
    const prepare = deferred<ProductEvent>();
    const replay = deferred<ProductEvent>();
    const refresh = deferred<ProductEvent>();
    const stableRoutines: AppBootstrap["routines"] = [];
    let server = initial;
    boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: inGroup ? null : initial });
    const fallback = boundary.call.getMockImplementation()!;
    boundary.call.mockImplementation(async (path, input, options) => {
      if (path === "threads.get") return server;
      if (path === "routines.list") return stableRoutines;
      if (path === "threads.subscribe")
        return {
          async *[Symbol.asyncIterator]() {
            yield await prepare.promise;
            yield await replay.promise;
            yield await refresh.promise;
            await new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
          },
        };
      return fallback(path, input, options);
    });
    const frame = (seq: number, messageId: string, text: string): ProductEvent => ({
      id: `event-${seq}`,
      spaceId: "space-1",
      threadId: initial.threadId,
      botId: "chief",
      seq,
      type: "thread.message.updated",
      payload: { messageId, messageSeq: 1, role: "user", blocks: [{ kind: "text", text }] },
      createdAt: "2026-01-01T00:00:00Z",
    });
    await render(inGroup ? "/app/g/ops" : "/app/chief");
    server = {
      ...initial,
      cursor: 20,
      olderCursor: scenario === "pre-clear" ? null : 1,
      messages: initial.messages.map((message) => ({
        ...message,
        blocks: [{ kind: "text", text: "Authoritative anchor" }],
      })),
    };
    // Consume 7 before a direct GET commits 20, leaving replay 11 ahead of the reader cursor.
    await act(async () => prepare.resolve(frame(7, "anchor", "Before refresh")));
    expect(container.querySelector('[data-message-id="anchor"]')?.textContent).toContain(
      "Authoritative anchor",
    );
    const historical = frame(11, "historical", "Recovered history");
    historical.type = type;
    historical.payload.messageSeq = 0;
    if (scenario === "known-fallback") {
      historical.id = "anchor";
      delete historical.payload.messageId;
    }
    await act(async () => replay.resolve(historical));
    expect(container.querySelector('[data-message-id="historical"]') !== null).toBe(
      scenario === "admitted",
    );
    server = {
      ...initial,
      cursor: 21,
      messages: [
        {
          ...initial.messages[0]!,
          id: "tail",
          seq: 5,
          blocks: [{ kind: "text", text: "New latest page" }],
        },
      ],
    };
    await act(async () => refresh.resolve(frame(12, "anchor", "Obsolete payload")));
    expect(container.querySelector('[data-message-id="tail"]')?.textContent).toContain(
      "New latest page",
    );
    expect(container.querySelector('[data-message-id="anchor"]') !== null).toBe(
      scenario === "admitted",
    );
    expect(container.querySelector('[data-message-id="historical"]') !== null).toBe(
      scenario === "admitted",
    );
  },
);

it.each(["Space", "actor", "target"])(
  "ignores a late durable replay after changing the reader %s",
  async (scopeChange) => {
    const initial = { ...jumpSnapshot("chief", 5, "Done"), olderCursor: 1 };
    const prepare = deferred<ProductEvent>();
    const replay = deferred<ProductEvent>();
    let server = initial;
    boundary.bootstrap.mockResolvedValue({ ...bootstrap(), thread: initial });
    const fallback = boundary.call.getMockImplementation()!;
    boundary.call.mockImplementation(async (path, input, options) => {
      if (path === "threads.get")
        return input?.botId === "worker" ? jumpSnapshot("worker", 30, "Done") : server;
      if (path === "threads.subscribe")
        return {
          async *[Symbol.asyncIterator]() {
            yield await prepare.promise;
            yield await replay.promise;
            await new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
          },
        };
      return fallback(path, input, options);
    });
    await render();
    server = { ...initial, cursor: 20 };
    const event: ProductEvent = {
      id: "updated-7",
      spaceId: "space-1",
      threadId: initial.threadId,
      botId: "chief",
      seq: 7,
      type: "thread.message.updated",
      payload: {
        messageId: "card",
        messageSeq: 1,
        role: "bot",
        blocks: [{ kind: "computer", state: "Done", text: "Sign in" }],
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    await act(async () => prepare.resolve(event));
    if (scopeChange === "Space") {
      boundary.space = "space-2";
      boundary.generation += 1;
    } else if (scopeChange === "actor") {
      boundary.session.data.user.id = "user-2";
    }
    await act(async () =>
      navigate(scopeChange === "target" ? "/app/worker" : "/app/chief?scope=changed"),
    );
    const reads = boundary.call.mock.calls.filter(([path]) => path === "threads.get").length;
    await act(async () =>
      replay.resolve({
        ...event,
        id: "replay-11",
        type: "thread.message.created",
        seq: 11,
        payload: {
          messageId: "historical",
          messageSeq: 0,
          role: "user",
          blocks: [{ kind: "text", text: "Old reader history" }],
        },
      }),
    );
    expect(container.querySelector('[data-message-id="historical"]')).toBeNull();
    expect(boundary.call.mock.calls.filter(([path]) => path === "threads.get")).toHaveLength(reads);
    expect(container.querySelector('[data-testid="computer-card"]')?.textContent).toContain("Done");
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

it.each(
  [
    "complete-refresh",
    "covered-clear",
    "already-expanded",
    "metadata-only-complete",
    "accepted",
  ].flatMap((scenario) => [false, true].map((inGroup) => ({ scenario, inGroup }))),
)(
  "admits older history side effects after $scenario (group=$inGroup)",
  async ({ scenario, inGroup }) => {
    const initial = mergeThreadSnapshot(null, {
      ...jumpSnapshot("chief", 10, "Needs you"),
      olderCursor: 1,
      ...(inGroup ? { botId: undefined, groupId: "ops" } : {}),
    });
    const page = deferred<unknown>();
    const get = deferred<ThreadSnapshot>();
    let height = 100;
    const scrollElement = document.createElement("div");
    Object.defineProperty(scrollElement, "scrollHeight", { get: () => height });
    scrollElement.scrollTop = 25;
    const snapshotRef = { current: initial };
    const expandedHistoryThread = {
      current: scenario === "already-expanded" ? initial.threadId : null,
    };
    const commitSnapshot = vi.fn((next: ThreadSnapshot) => {
      snapshotRef.current = next;
    });
    const scope = {
      inGroup,
      active: chief,
      groupId: inGroup ? "ops" : undefined,
      snapshot: initial,
      loadingOlder: false,
      pinnedAroundRef: { current: null },
      messageScroll: { current: scrollElement },
      historyEpoch: { current: 0 },
      selectedSpaceId: () => "space-1",
      groupSettingsActor: { current: { spaceId: "space-1" } },
      snapshotRef,
      setLoadingOlder: vi.fn(),
      rpc: { threads: { messages: () => page.promise, get: () => get.promise } },
      activeBotId: { current: inGroup ? undefined : chief.id },
      activeGroupId: { current: inGroup ? "ops" : undefined },
      expandedHistoryThread,
      computerRef: { current: null },
      reconcileRefreshedThread,
      prependThreadMessagePage,
      commitSnapshot,
    };
    const loadOlder = new Function(...Object.keys(scope), olderHandler)(...Object.values(scope));
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
    try {
      const loading = loadOlder();
      const accepted = scenario === "accepted";
      const coveredClear = scenario === "covered-clear";
      const metadataOnly = scenario === "metadata-only-complete";
      const fresh = mergeThreadSnapshot(null, {
        ...initial,
        cursor: accepted ? 10 : coveredClear ? 30 : 20,
        olderCursor: accepted || coveredClear ? 1 : null,
        messages: jumpSnapshot("chief", 20, "Done").messages,
      });
      if (coveredClear) {
        snapshotRef.current = reduceThreadSnapshot(fresh, {
          id: "clear-20",
          spaceId: "space-1",
          type: "thread.cleared",
          seq: 20,
          threadId: initial.threadId,
          botId: "chief",
          payload: {},
          createdAt: "2026-01-01T00:00:00Z",
        })!;
      }
      if (metadataOnly) {
        snapshotRef.current = {
          ...initial,
          olderCursor: null,
          messages: jumpSnapshot("chief", 10, "Done").messages,
        };
      }
      get.resolve(metadataOnly ? { ...initial, cursor: 9 } : coveredClear ? initial : fresh);
      height = 150;
      page.resolve({
        threadId: initial.threadId,
        olderCursor: null,
        messages: [
          {
            ...initial.messages[0],
            id: "earlier",
            seq: 0,
            role: "user",
            blocks: [{ kind: "text", text: "Earlier" }],
          },
        ],
      });
      await loading;
      expect(commitSnapshot).toHaveBeenCalledTimes(1);
      expect(snapshotRef.current.cursor).toBe(
        accepted || metadataOnly ? 10 : coveredClear ? 30 : 20,
      );
      expect(snapshotRef.current.messages[0]?.blocks).toEqual(
        accepted
          ? [{ kind: "text", text: "Earlier" }]
          : [{ kind: "computer", text: "Sign in", state: "Done" }],
      );
      expect(expandedHistoryThread.current).toBe(
        accepted || scenario === "already-expanded" ? initial.threadId : null,
      );
      expect(frame).toHaveBeenCalledTimes(accepted ? 1 : 0);
      if (accepted) frame.mock.calls[0]![0](0);
      expect(scrollElement.scrollTop).toBe(accepted ? 75 : 25);
      expect(scope.setLoadingOlder.mock.calls).toEqual([[true], [false]]);
    } finally {
      frame.mockRestore();
    }
  },
);
