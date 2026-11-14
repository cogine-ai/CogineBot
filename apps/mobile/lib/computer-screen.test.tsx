// @vitest-environment jsdom

import type { ComputerStatus, TaughtSkill } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, Fragment, forwardRef, useImperativeHandle } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Computer from "../app/computer";
import type { ComputerKeyboardCommand } from "./computer-keyboard";

const rpc = vi.hoisted(() => vi.fn());
const keyboard = vi.hoisted(() => ({
  command: null as null | ((command: ComputerKeyboardCommand) => void),
  screen: null as null | {
    injectedJavaScript?: string;
    onMessage?: (event: { nativeEvent: { data: string } }) => void;
  },
  inject: vi.fn(),
}));

const nativeFiles = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  deleteDirectory: vi.fn(),
  createFile: vi.fn(),
  writeFile: vi.fn(),
  share: vi.fn(async () => undefined),
}));

vi.mock("expo-file-system", () => ({
  Directory: class {
    exists = true;
    create = nativeFiles.createDirectory;
    delete = nativeFiles.deleteDirectory;
  },
  File: class {
    uri = "file:///synthetic/notes.txt";
    create = nativeFiles.createFile;
    write = nativeFiles.writeFile;
  },
  Paths: { cache: "file:///synthetic" },
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: async () => true,
  shareAsync: nativeFiles.share,
}));

vi.mock("react-native", () => {
  function MockView(props: { children?: ReactNode }) {
    return createElement("div", null, props.children);
  }

  function MockPressable(props: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) {
    return createElement(
      "button",
      {
        type: "button",
        role: props.accessibilityRole,
        "aria-label": props.accessibilityLabel,
        onClick: () => props.onPress?.(),
      },
      props.children,
    );
  }

  function MockModal(props: { children?: ReactNode; visible?: boolean }) {
    return props.visible ? createElement("section", null, props.children) : null;
  }

  return {
    AppState: {
      currentState: "active",
      addEventListener: () => ({ remove: () => undefined }),
    },
    StyleSheet: { absoluteFill: {} },
    TextInput: MockView,
    Modal: MockModal,
    Pressable: MockPressable,
    ScrollView: MockView,
    Text: MockView,
    View: MockView,
  };
});

vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
}));
vi.mock("../components/computer-keyboard-bar", () => ({
  ComputerKeyboardBar: ({
    onCommand,
  }: {
    onCommand: (command: ComputerKeyboardCommand) => void;
  }) => {
    keyboard.command = onCommand;
    return createElement("div", { "data-keyboard-bar": true });
  },
}));

vi.mock("react-native-webview", () => {
  return {
    WebView: forwardRef(
      (
        props: {
          accessibilityElementsHidden?: boolean;
          importantForAccessibility?: string;
          injectedJavaScript?: string;
          onMessage?: (event: { nativeEvent: { data: string } }) => void;
        },
        ref,
      ) => {
        keyboard.screen = props;
        useImperativeHandle(ref, () => ({ injectJavaScript: keyboard.inject }));
        return createElement("iframe", {
          title: "screen",
          "data-elements-hidden": String(Boolean(props.accessibilityElementsHidden)),
          "data-important": props.importantForAccessibility ?? "auto",
        });
      },
    ),
  };
});

vi.mock("react-native-safe-area-context", () => {
  const Passthrough = (props: { children?: ReactNode }) =>
    createElement(Fragment, null, props.children);
  return {
    initialWindowMetrics: null,
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
  };
});

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useIsFocused: () => true,
  useLocalSearchParams: () => ({ botId: "bot-1", name: "Basil" }),
  useNavigation: () => ({ setOptions: () => undefined }),
}));

vi.mock("expo-screen-orientation", () => ({
  OrientationLock: { DEFAULT: 0, PORTRAIT_UP: 1 },
  lockAsync: () => Promise.resolve(),
}));

vi.mock("../components/native-action-button", () => {
  return {
    NativeActionButton: (props: { label: string; onPress: () => void; prominence?: string }) =>
      createElement(
        "button",
        { type: "button", "data-prominence": props.prominence, onClick: props.onPress },
        props.label,
      ),
  };
});

vi.mock("../components/glass-icon-button", () => {
  return {
    GlassIconButton: (props: { accessibilityLabel: string; onPress: () => void }) =>
      createElement("button", {
        type: "button",
        "aria-label": props.accessibilityLabel,
        onClick: props.onPress,
      }),
  };
});

vi.mock("../components/computer-maintenance-actions", () => ({
  ComputerMaintenanceActions: () => null,
}));

vi.mock("../components/computer-mode-picker", () => ({ ComputerModePicker: () => null }));

vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({ apiBase: "https://api.example.test" }),
  currentApiBase: () => "https://api.example.test",
  rpc,
}));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => "test-scope",
  isMobileScopeCurrent: () => true,
  mobileScopeKey: () => "test-scope",
  subscribeMobileScope: () => () => undefined,
}));

vi.mock("./space-request-context", () => ({
  spaceRequestContext: async (_scope: unknown, isCurrent: () => boolean) => {
    if (!isCurrent()) throw new Error("Stale synthetic scope");
    return {
      apiBase: "https://api.example.test",
      headers: { "x-rakazo-space-id": "space-1" },
      isCurrent,
    };
  },
}));

vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key);
  return { t, useI18n: () => ({ t }) };
});

vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({
    background: "background",
    border: "border",
    card: "card",
    foreground: "foreground",
    muted: "muted",
    mutedForeground: "muted-foreground",
    primary: "primary",
    success: "success",
  }),
}));

vi.mock("./native-controls", () => ({ iosAtLeast: () => false }));

const botWorking: ComputerStatus = {
  botId: "bot-1",
  mode: "team",
  kind: "docker",
  state: "running",
  controlHolder: "none",
  controlBotId: null,
  takeoverRequested: false,
  screenAvailable: true,
  screenWidth: 1280,
  screenHeight: 800,
  homeRevision: null,
  busyBotName: "Basil",
  canUpdate: false,
  terminalAvailable: false,
};

function respond(status: ComputerStatus) {
  rpc.mockImplementation(async (method: string) => {
    if (method === "skills/list") return [];
    if (method === "computer/status") return status;
    if (method === "computer/screenUrl") return { url: "https://screen.example.test/embed" };
    return {};
  });
}

function calls(method: string) {
  return rpc.mock.calls.filter(([called]) => called === method);
}

describe("computer screen", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockReset();
    keyboard.command = null;
    keyboard.screen = null;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
  });

  async function settle() {
    await act(async () => {
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    });
  }

  async function render() {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(<Computer />);
    });
    await settle();
    return container;
  }

  function preview(view: HTMLElement) {
    const element = view.querySelector<HTMLElement>('[aria-label="Open computer"]');
    if (!element) throw new Error("missing preview");
    return element;
  }

  function takeControlButtons(view: HTMLElement) {
    return Array.from(view.querySelectorAll("button")).filter(
      (button) => button.textContent === "Take control",
    );
  }

  it("opens the full window from the preview without taking control from the bot", async () => {
    respond(botWorking);
    const view = await render();
    expect(view.querySelector("section")).toBeNull();

    await act(async () => preview(view).click());
    await settle();

    const fullWindow = view.querySelector("section");
    expect(fullWindow?.querySelector('[aria-label="Close computer"]')).not.toBeNull();
    expect(calls("computer/takeover")).toEqual([]);
    expect(view.querySelector("[data-keyboard-bar]")).toBeNull();
    const screens = view.querySelectorAll("iframe");
    expect(screens).toHaveLength(1);
    expect(fullWindow?.contains(screens[0] ?? null)).toBe(true);
    expect(screens[0]?.getAttribute("data-elements-hidden")).toBe("true");
    expect(screens[0]?.getAttribute("data-important")).toBe("no-hide-descendants");
    const buttons = takeControlButtons(view);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.dataset.prominence).toBe("secondary");

    const headerTakeControl = buttons.find((button) => fullWindow?.contains(button));
    expect(headerTakeControl).toBeDefined();
    respond({ ...botWorking, controlHolder: "user", controlBotId: "bot-1", busyBotName: null });
    await act(async () => headerTakeControl?.click());
    await settle();

    expect(calls("computer/takeover")).toEqual([["computer/takeover", { botId: "bot-1" }]]);
    expect(fullWindow?.querySelector("iframe")?.getAttribute("data-elements-hidden")).toBe("false");
    expect(fullWindow?.querySelector("iframe")?.getAttribute("data-important")).toBe("auto");
    expect(fullWindow?.querySelector("[data-keyboard-bar]")).not.toBeNull();
  });

  it("does not boot or offer controls on a server with computers disabled", async () => {
    let resolveStatus: (status: ComputerStatus) => void = () => undefined;
    const status = new Promise<ComputerStatus>((resolve) => {
      resolveStatus = resolve;
    });
    rpc.mockImplementation(async (method: string) => (method === "computer/status" ? status : {}));
    const view = await render();
    expect(view.querySelector('[aria-label="Open computer"]')).toBeNull();
    expect(takeControlButtons(view)).toHaveLength(0);
    await act(async () => {
      resolveStatus({
        ...botWorking,
        kind: "none",
        providerDisabled: true,
        state: "stopped",
        screenAvailable: false,
        homeRevision: "empty",
        busyBotName: null,
      });
    });
    await settle();
    expect(view.textContent).toContain("Computers are disabled on this server.");
    expect(view.querySelector('[aria-label="Open computer"]')).toBeNull();
    expect(takeControlButtons(view)).toHaveLength(0);
    expect(calls("computer/boot")).toEqual([]);
    expect(calls("computer/screenUrl")).toEqual([]);
  });

  it("boots an old disabled record once a computer provider is configured", async () => {
    respond({
      ...botWorking,
      kind: "none",
      state: "stopped",
      screenAvailable: false,
      homeRevision: "empty",
      busyBotName: null,
    });
    const view = await render();
    expect(view.textContent).not.toContain("Computers are disabled on this server.");
    expect(calls("computer/boot")).toHaveLength(1);
  });

  it("wakes a sleeping computer from the preview without taking control", async () => {
    respond({ ...botWorking, state: "suspended", busyBotName: null });
    const view = await render();
    expect(calls("computer/boot")).toEqual([]);

    await act(async () => preview(view).click());
    await settle();

    expect(calls("computer/boot")).toHaveLength(1);
    expect(calls("computer/takeover")).toEqual([]);
    expect(view.querySelector("[data-keyboard-bar]")).toBeNull();
  });

  it("explains a runtime-limit pause and resumes without taking control", async () => {
    respond({
      ...botWorking,
      state: "suspended",
      suspensionReason: "active_limit",
      busyBotName: null,
    });
    const view = await render();
    expect(view.textContent).toContain("Computer paused at its runtime limit.");
    expect(view.textContent).toContain("Background tasks may have stopped.");
    expect(calls("computer/boot")).toEqual([]);
    const resume = Array.from(view.querySelectorAll("button")).find(
      (button) => button.textContent === "Continue using computer",
    );
    expect(resume).toBeDefined();
    await act(async () => resume?.click());
    await settle();
    expect(calls("computer/boot")).toHaveLength(1);
    expect(calls("computer/takeover")).toEqual([]);
  });

  it("shows the workspace failure reason and opens the live files for inspection", async () => {
    rpc.mockImplementation(async (method: string) => {
      if (method === "skills/list") return [];
      if (method === "computer/status") {
        return { ...botWorking, workspaceSaveFailure: "too_many_files" };
      }
      if (method === "computer/files") return [{ path: "report.txt", kind: "file" }];
      return {};
    });
    const view = await render();
    expect(view.textContent).toContain("Computer still running. Workspace not saved.");
    expect(view.textContent).toContain("The computer has too many files to save.");
    const files = Array.from(view.querySelectorAll("button")).find(
      (button) => button.textContent === "View files",
    );
    expect(files).toBeDefined();
    await act(async () => files?.click());
    await settle();
    expect(calls("computer/files")).toEqual([
      ["computer/files", { botId: "bot-1", path: "", source: undefined }, expect.anything()],
    ]);
    expect(view.textContent).toContain("report.txt");
  });

  it("shows the saved bytes and completed files during the stopping state", async () => {
    respond({
      ...botWorking,
      state: "error",
      powerState: "stopping",
      screenAvailable: false,
      workspaceSaveProgress: { files: 5, bytes: 2048 },
    });
    const view = await render();
    expect(view.textContent).toContain("Saving workspace…");
    expect(view.textContent).toContain("5 files processed · 2 KB");
    expect(calls("computer/boot")).toEqual([]);
  });

  it("still boots a new computer with the empty revision and omits saved Files", async () => {
    respond({
      ...botWorking,
      state: "stopped",
      screenAvailable: false,
      homeRevision: "empty",
    });
    const view = await render();
    expect(calls("computer/boot")).toHaveLength(1);
    expect(
      Array.from(view.querySelectorAll("button")).some((button) => button.textContent === "Files"),
    ).toBe(false);
  });

  it.each([
    { state: "error", powerState: "quarantined", homeRevision: null },
    { state: "stopped", homeRevision: "last-saved-revision" },
  ] as const)(
    "downloads saved files from a $state computer without starting it",
    async (status) => {
      rpc.mockImplementation(async (method: string) => {
        if (method === "skills/list") return [];
        if (method === "computer/status") {
          return {
            ...botWorking,
            ...status,
            screenAvailable: false,
            busyBotName: null,
          };
        }
        if (method === "computer/files") return [{ path: "notes.txt", kind: "file" }];
        if (method === "computer/downloadFile") return { contentBase64: "c2F2ZWQ=" };
        return {};
      });
      const view = await render();
      function button(label: string) {
        const match = Array.from(view.querySelectorAll("button")).find(
          (candidate) => candidate.textContent === label,
        );
        if (!match) throw new Error(`Missing ${label} button`);
        return match;
      }
      await act(async () => button("Files").click());
      await settle();
      expect(calls("computer/files")).toEqual([
        [
          "computer/files",
          { botId: "bot-1", path: "", source: "saved" },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ],
      ]);
      await act(async () => {
        const file = button("notes.txt");
        file.click();
        file.click();
      });
      await settle();
      expect(calls("computer/downloadFile")).toEqual([
        [
          "computer/downloadFile",
          { botId: "bot-1", path: "notes.txt", source: "saved" },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ],
      ]);
      expect(nativeFiles.writeFile).toHaveBeenCalledExactlyOnceWith("c2F2ZWQ=", {
        encoding: "base64",
      });
      expect(nativeFiles.share).toHaveBeenCalledExactlyOnceWith("file:///synthetic/notes.txt", {
        mimeType: "application/octet-stream",
      });
      expect(nativeFiles.deleteDirectory).toHaveBeenCalledOnce();
      expect(calls("computer/boot")).toEqual([]);
      if (status.state === "stopped") {
        respond(botWorking);
        await act(async () => preview(view).click());
        await settle();
        expect(calls("computer/boot")).toHaveLength(1);
      }
    },
  );

  it("takes control only from the Take control button", async () => {
    respond(botWorking);
    const view = await render();

    await act(async () => takeControlButtons(view)[0]?.click());
    await settle();

    expect(calls("computer/takeover")).toEqual([["computer/takeover", { botId: "bot-1" }]]);
  });

  it("names the preview as a button", async () => {
    respond(botWorking);
    const view = await render();

    expect(preview(view).getAttribute("role")).toBe("button");
  });

  it("keeps the view-only screen out of the accessibility tree", async () => {
    respond(botWorking);
    const view = await render();

    const screen = view.querySelector("iframe");
    expect(screen?.getAttribute("data-elements-hidden")).toBe("true");
    expect(screen?.getAttribute("data-important")).toBe("no-hide-descendants");
  });

  it("keeps the screen accessible in the full window while the user has control", async () => {
    respond({ ...botWorking, controlHolder: "user", controlBotId: "bot-1", busyBotName: null });
    const view = await render();

    await act(async () => preview(view).click());
    await settle();

    const screens = view.querySelectorAll("iframe");
    expect(screens).toHaveLength(1);
    expect(screens[0]?.getAttribute("data-elements-hidden")).toBe("false");
    expect(screens[0]?.getAttribute("data-important")).toBe("auto");
  });
  it.each([false, true])(
    "drains recording keyboard input before stop when WebView ready is %s",
    async (ready) => {
      let skill: TaughtSkill = {
        id: "skill-1",
        botId: "bot-1",
        name: "Synthetic export",
        goal: "Export a synthetic list",
        status: "recording",
        playbook: {
          whenToUse: "Weekly",
          inputs: [],
          steps: ["Export"],
          howToCheck: "File exists",
          whatToReturn: "File",
          approvalBoundaries: "Ask",
          failureHandling: "Stop",
        },
        recording: { events: [], snapshots: [] },
        startedAt: null,
        stoppedAt: null,
        expiresAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      let resolveInput!: () => void;
      const input = new Promise<void>((resolve) => {
        resolveInput = resolve;
      });
      respond({ ...botWorking, controlHolder: "user", controlBotId: "bot-1", busyBotName: null });
      const original = rpc.getMockImplementation()!;
      rpc.mockImplementation((method: string, ...args: unknown[]) => {
        if (method === "skills/list") return Promise.resolve([skill]);
        if (method === "computer/input") return input;
        if (method === "skills/stop") {
          skill = { ...skill, status: "draft" };
          return Promise.resolve(skill);
        }
        return original(method, ...args);
      });
      const view = await render();
      await act(async () => preview(view).click());
      await settle();
      const screen = keyboard.screen!;
      const data = screen.injectedJavaScript!.match(/rakazo-computer-keyboard-ready:\d+/)![0];
      if (ready) await act(async () => screen.onMessage?.({ nativeEvent: { data } }));
      expect(keyboard.command).not.toBeNull();
      await act(async () => keyboard.command!({ type: "text", text: "synthetic input" }));
      await act(async () =>
        view.querySelector<HTMLButtonElement>('[aria-label="Close computer"]')!.click(),
      );
      await settle();
      const stop = [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Stop teaching",
      )!;
      await act(async () => stop.click());
      await settle();
      try {
        expect(calls("computer/input")).toHaveLength(1);
        expect(calls("computer/input")[0]?.[1]).toEqual({
          botId: "bot-1",
          kind: "clipboard",
          payload: { text: "synthetic input" },
        });
        expect(calls("skills/stop")).toHaveLength(0);
      } finally {
        await act(async () => resolveInput());
        await settle();
      }
      expect(calls("skills/stop")).toHaveLength(1);
      expect(view.textContent).toContain("Synthetic export");
      await act(async () => screen.onMessage?.({ nativeEvent: { data } }));
      expect(calls("computer/input")).toHaveLength(1);
    },
  );
  it("keeps non-recording keyboard input owned by the WebView ready gate", async () => {
    respond({ ...botWorking, controlHolder: "user", controlBotId: "bot-1", busyBotName: null });
    const view = await render();
    await act(async () => preview(view).click());
    await settle();
    const screen = keyboard.screen!;
    const data = screen.injectedJavaScript!.match(/rakazo-computer-keyboard-ready:\d+/)![0];
    const injectedCommands = () =>
      keyboard.inject.mock.calls.filter(([script]) =>
        script.includes("rakazoComputerKeyboard?.run"),
      );
    await act(async () => keyboard.command!({ type: "text", text: "ordinary input" }));
    expect(injectedCommands()).toHaveLength(0);
    expect(calls("computer/input")).toHaveLength(0);
    await act(async () => screen.onMessage?.({ nativeEvent: { data } }));
    expect(injectedCommands()).toHaveLength(1);
    expect(injectedCommands()[0]?.[0]).toContain("ordinary input");
    expect(calls("computer/input")).toHaveLength(0);
    await act(async () => screen.onMessage?.({ nativeEvent: { data } }));
    expect(injectedCommands()).toHaveLength(1);
  });
});
