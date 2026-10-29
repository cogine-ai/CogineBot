// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Computer from "../app/computer";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  params: { botId: "bot-a", name: "Test Bot" },
  focused: true,
  appState: "active" as string | null,
  appListeners: new Set<() => void>(),
  scope: "space-a:user-a:0",
  scopeListeners: new Set<() => void>(),
  navigation: { setOptions: vi.fn() },
  lockOrientation: vi.fn().mockResolvedValue(undefined),
  screenProps: null as null | {
    onRenderProcessGone: () => void;
    onContentProcessDidTerminate: () => void;
    onMessage?: (event: { nativeEvent: { data: string } }) => void;
  },
}));

vi.mock("./api", () => ({ rpc: state.rpc, currentApiBase: () => "https://api.example.test" }));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => state.scope,
  isMobileScopeCurrent: (scope: string) => scope === state.scope,
  mobileScopeKey: () => state.scope,
  subscribeMobileScope: (listener: () => void) => {
    state.scopeListeners.add(listener);
    return () => state.scopeListeners.delete(listener);
  },
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => state.params,
  useNavigation: () => state.navigation,
  useIsFocused: () => state.focused,
}));
vi.mock("expo-screen-orientation", () => ({
  lockAsync: state.lockOrientation,
  OrientationLock: { DEFAULT: "default", PORTRAIT_UP: "portrait" },
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Text: View,
    Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
      visible ? <section data-full>{children}</section> : null,
    Pressable: ({
      onPress,
      accessibilityLabel,
    }: {
      onPress: () => void;
      accessibilityLabel: string;
    }) => <button type="button" aria-label={accessibilityLabel} onClick={onPress} />,
    AppState: {
      get currentState() {
        return state.appState;
      },
      addEventListener: (_type: string, listener: () => void) => {
        state.appListeners.add(listener);
        return { remove: () => state.appListeners.delete(listener) };
      },
    },
  };
});
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { SafeAreaProvider: View, SafeAreaView: View, initialWindowMetrics: null };
});
vi.mock("react-native-webview", () => ({
  WebView: (props: {
    source: { uri: string };
    pointerEvents?: string;
    onRenderProcessGone: () => void;
    onContentProcessDidTerminate: () => void;
    onMessage?: (event: { nativeEvent: { data: string } }) => void;
  }) => {
    state.screenProps = props;
    return <div data-screen={props.source.uri} data-pointer={props.pointerEvents} />;
  },
}));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("../components/computer-keyboard-bar", () => ({ ComputerKeyboardBar: () => null }));
vi.mock("../components/computer-maintenance-actions", () => ({
  ComputerMaintenanceActions: () => null,
}));
vi.mock("../components/computer-mode-picker", () => ({ ComputerModePicker: () => null }));
vi.mock("../components/glass-icon-button", () => ({ GlassIconButton: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function status(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    botId: state.params.botId,
    mode: "team",
    kind: "fake",
    state: "running",
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: true,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: true,
    terminalAvailable: true,
    ...overrides,
  };
}

let root: Root;
let host: HTMLDivElement;
let currentStatus: ComputerStatus;
let statusError: Error | undefined;
let nextStatus: Promise<ComputerStatus> | undefined;
let nextScreen: Promise<{ url: string | null }> | undefined;
let nextHeartbeat: Promise<unknown> | undefined;
const calls = (proc: string) => state.rpc.mock.calls.filter(([name]) => name === proc);

async function render() {
  await act(async () =>
    root.render(
      <StrictMode>
        <Computer />
      </StrictMode>,
    ),
  );
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function appState(value: string | null) {
  await act(async () => {
    state.appState = value;
    for (const listener of state.appListeners) listener();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  state.rpc.mockReset();
  state.lockOrientation.mockClear();
  state.params = { botId: "bot-a", name: "Test Bot" };
  state.focused = true;
  state.appState = "active";
  state.scope = "space-a:user-a:0";
  currentStatus = status();
  state.screenProps = null;
  statusError = undefined;
  nextStatus = undefined;
  nextScreen = undefined;
  nextHeartbeat = undefined;
  state.rpc.mockImplementation(async (proc: string, body: { botId: string }) => {
    if (proc === "computer/status") {
      if (statusError) throw statusError;
      const pending = nextStatus;
      nextStatus = undefined;
      return pending ?? currentStatus;
    }
    if (proc === "computer/screenUrl") {
      const pending = nextScreen;
      nextScreen = undefined;
      return pending ?? { url: `https://screen.example.test/${body.botId}/embed` };
    }
    if (proc === "computer/heartbeat") {
      const pending = nextHeartbeat;
      nextHeartbeat = undefined;
      return pending ?? { ok: true };
    }
    return { ok: true };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  expect(state.appListeners.size).toBe(0);
  expect(state.scopeListeners.size).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["background", "inactive", null])(
  "does not read or heartbeat when mounted in %s",
  async (initial) => {
    state.appState = initial;
    await render();
    await advance(120_000);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(host.querySelector("[data-screen]")).toBeNull();
  },
);

it("requires route focus even when the app is active", async () => {
  state.focused = false;
  await render();
  await advance(120_000);
  expect(state.rpc).not.toHaveBeenCalled();
  state.focused = true;
  await render();
  expect(calls("computer/status").length).toBeGreaterThan(0);
  expect(calls("computer/heartbeat")).toHaveLength(1);
});

it("stops both passive loops and waits for fresh running status before resuming", async () => {
  await render();
  expect(calls("computer/heartbeat")).toHaveLength(1);
  expect(host.querySelector("[data-screen]")).not.toBeNull();
  const bootCount = calls("computer/boot").length;
  await appState("background");
  const before = state.rpc.mock.calls.length;
  await advance(120_000);
  expect(state.rpc).toHaveBeenCalledTimes(before);
  expect(host.querySelector("[data-screen]")).toBeNull();
  const fresh = deferred<ComputerStatus>();
  nextStatus = fresh.promise;
  await appState("active");
  expect(calls("computer/heartbeat")).toHaveLength(1);
  expect(host.querySelector("[data-screen]")).toBeNull();
  await act(async () => fresh.resolve(status({ state: "stopped", screenAvailable: false })));
  expect(calls("computer/heartbeat")).toHaveLength(1);
  expect(calls("computer/boot")).toHaveLength(bootCount);
  expect(host.querySelector("[data-screen]")).toBeNull();
  currentStatus = status();
  await advance(2000);
  expect(calls("computer/heartbeat")).toHaveLength(2);
  expect(host.querySelector("[data-screen]")).not.toBeNull();
});

it("pauses on navigation blur and does not release user control", async () => {
  currentStatus = status({ controlHolder: "user", controlBotId: "bot-a" });
  await render();
  const before = state.rpc.mock.calls.length;
  state.focused = false;
  await render();
  await advance(120_000);
  expect(state.rpc).toHaveBeenCalledTimes(before);
  expect(calls("computer/release")).toHaveLength(0);
  expect(calls("computer/takeover")).toHaveLength(0);
  expect(host.querySelector("[data-screen]")).toBeNull();
  state.focused = true;
  await render();
  expect(calls("computer/heartbeat")).toHaveLength(2);
  expect(calls("computer/release")).toHaveLength(0);
});

it.each(["route blur", "background"])(
  "hides the native full window and restores portrait during %s",
  async (transition) => {
    await render();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Open computer"]')?.click();
    });
    expect(host.querySelector("section[data-full]")).not.toBeNull();
    expect(state.lockOrientation).toHaveBeenLastCalledWith("default");
    if (transition === "route blur") {
      state.focused = false;
      await render();
    } else await appState("background");
    expect(host.querySelector("section[data-full]")).toBeNull();
    expect(state.lockOrientation).toHaveBeenLastCalledWith("portrait");
    if (transition === "route blur") {
      state.focused = true;
      await render();
    } else await appState("active");
    expect(host.querySelector("section[data-full] [data-screen]")).not.toBeNull();
    expect(state.lockOrientation).toHaveBeenLastCalledWith("default");
    expect(calls("computer/release")).toHaveLength(0);
  },
);

it.each([false, true])(
  "reopens a fresh visible stream after status confirmation (full window: %s)",
  async (fullWindow) => {
    await render();
    if (fullWindow) {
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button[aria-label="Open computer"]')?.click();
      });
    }
    expect(host.querySelectorAll("[data-screen]")).toHaveLength(1);
    await appState("background");
    expect(host.querySelector("[data-screen]")).toBeNull();
    const fresh = deferred<ComputerStatus>();
    nextStatus = fresh.promise;
    await appState("active");
    expect(host.querySelector("[data-screen]")).toBeNull();
    await act(async () => fresh.resolve(currentStatus));
    expect(host.querySelectorAll("[data-screen]")).toHaveLength(1);
    expect(Boolean(host.querySelector("section[data-full] [data-screen]"))).toBe(fullWindow);
  },
);

it("discards a late status after pause and does not connect its screen", async () => {
  await render();
  const old = deferred<ComputerStatus>();
  nextStatus = old.promise;
  await advance(2000);
  const latest = calls("computer/status").at(-1);
  await appState("inactive");
  expect(latest?.[2].signal.aborted).toBe(true);
  const screenCount = calls("computer/screenUrl").length;
  await act(async () => old.resolve(status({ state: "running", homeRevision: "old" })));
  await advance(120_000);
  expect(calls("computer/screenUrl")).toHaveLength(screenCount);
  expect(calls("computer/heartbeat")).toHaveLength(1);
});

it("cancels passive screen retries while preserving an explicit action across background", async () => {
  await render();
  const old = deferred<{ url: string | null }>();
  nextScreen = old.promise;
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="Open computer"]')?.click();
  });
  await appState("background");
  const before = calls("computer/screenUrl").length;
  await act(async () => old.resolve({ url: null }));
  await advance(60_000);
  expect(calls("computer/screenUrl")).toHaveLength(before);
  expect(calls("computer/release")).toHaveLength(0);
  expect(host.querySelector("[data-screen]")).toBeNull();
  await appState("active");
  expect(host.querySelector("[data-screen]")).not.toBeNull();
  expect(calls("computer/takeover")).toHaveLength(0);
});

it("never overlaps a slow heartbeat or resumes it from an old visibility epoch", async () => {
  const pending = deferred<unknown>();
  nextHeartbeat = pending.promise;
  await render();
  await advance(180_000);
  expect(calls("computer/heartbeat")).toHaveLength(1);
  const signal = calls("computer/heartbeat")[0]?.[2].signal;
  await appState("background");
  expect(signal.aborted).toBe(true);
  await appState("active");
  expect(calls("computer/heartbeat")).toHaveLength(1);
  await act(async () => pending.resolve({ ok: true }));
  expect(calls("computer/heartbeat")).toHaveLength(2);
  await appState("background");
  await advance(180_000);
  expect(calls("computer/heartbeat")).toHaveLength(2);
});

it("invalidates late reads and timers on a Bot and actor/Space change", async () => {
  await render();
  const old = deferred<ComputerStatus>();
  nextStatus = old.promise;
  await advance(2000);
  state.params = { botId: "bot-b", name: "Other Bot" };
  currentStatus = status();
  await act(async () => {
    state.scope = "space-b:user-b:1";
    for (const listener of state.scopeListeners) listener();
  });
  expect(calls("computer/heartbeat").at(-1)?.[1]).toEqual({ botId: "bot-b" });
  await act(async () => old.resolve(status({ botId: "bot-a", state: "stopped" })));
  const before = calls("computer/heartbeat").length;
  await advance(60_000);
  expect(calls("computer/heartbeat")).toHaveLength(before + 1);
  expect(calls("computer/heartbeat").at(-1)?.[1]).toEqual({ botId: "bot-b" });
});

it("does not apply the old Bot's status while the new Bot's first read is pending", async () => {
  await render();
  const old = deferred<ComputerStatus>();
  nextStatus = old.promise;
  await advance(2000);
  const fresh = deferred<ComputerStatus>();
  state.params = { botId: "bot-b", name: "Other Bot" };
  currentStatus = status();
  nextStatus = fresh.promise;
  await render();
  await act(async () => old.resolve(status({ botId: "bot-a" })));
  expect(host.querySelector("[data-screen]")).toBeNull();
  expect(calls("computer/heartbeat").filter(([, body]) => body.botId === "bot-b")).toHaveLength(0);
  await act(async () => fresh.resolve(currentStatus));
  expect(host.querySelector("[data-screen]")?.getAttribute("data-screen")).toContain("/bot-b/");
});

it.each(["onRenderProcessGone", "onContentProcessDidTerminate"] as const)(
  "%s rebuilds the same screen as Watching until an explicit takeover",
  async (event) => {
    currentStatus = status({ controlHolder: "user", controlBotId: "bot-a" });
    await render();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Open computer"]')?.click();
    });
    const oldScreen = host.querySelector("section[data-full] [data-screen]");
    expect(oldScreen?.getAttribute("data-pointer")).toBe("auto");
    const oldRenderer = state.screenProps;
    const boots = calls("computer/boot").length;
    const screens = calls("computer/screenUrl").length;
    await act(async () => oldRenderer?.[event]());
    const recovered = host.querySelector("section[data-full] [data-screen]");
    expect(recovered).not.toBeNull();
    expect(recovered).not.toBe(oldScreen);
    expect(recovered?.getAttribute("data-pointer")).toBe("none");
    expect(state.screenProps?.onMessage).toBeUndefined();
    expect(calls("computer/screenUrl")).toHaveLength(screens + 1);
    expect(calls("computer/boot")).toHaveLength(boots);
    expect(calls("computer/takeover")).toHaveLength(0);
    const afterRecovery = state.rpc.mock.calls.length;
    await act(async () => oldRenderer?.[event]());
    expect(state.rpc).toHaveBeenCalledTimes(afterRecovery);
    const takeControl = Array.from(host.querySelectorAll<HTMLButtonElement>("section button")).find(
      (button) => button.textContent === "Take control",
    );
    await act(async () => takeControl?.click());
    expect(calls("computer/takeover")).toHaveLength(1);
    expect(
      host.querySelector("section[data-full] [data-screen]")?.getAttribute("data-pointer"),
    ).toBe("auto");
  },
);

it("foreground recovery does not revive the old control or accept an old renderer callback", async () => {
  currentStatus = status({ controlHolder: "user", controlBotId: "bot-a" });
  await render();
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="Open computer"]')?.click();
  });
  const oldRenderer = state.screenProps;
  await appState("background");
  await appState("active");
  expect(host.querySelector("section[data-full] [data-screen]")?.getAttribute("data-pointer")).toBe(
    "none",
  );
  expect(state.screenProps?.onMessage).toBeUndefined();
  expect(calls("computer/takeover")).toHaveLength(0);
  expect(calls("computer/release")).toHaveLength(0);
  const before = state.rpc.mock.calls.length;
  await act(async () => oldRenderer?.onRenderProcessGone());
  expect(state.rpc).toHaveBeenCalledTimes(before);
});

it("a dead renderer cannot refresh the new Bot's screen", async () => {
  await render();
  const oldRenderer = state.screenProps;
  state.params = { botId: "bot-b", name: "Other Bot" };
  currentStatus = status();
  await act(async () => {
    state.scope = "space-b:user-b:1";
    for (const listener of state.scopeListeners) listener();
  });
  const before = state.rpc.mock.calls.length;
  await act(async () => oldRenderer?.onContentProcessDidTerminate());
  expect(state.rpc).toHaveBeenCalledTimes(before);
  expect(host.querySelector("[data-screen]")?.getAttribute("data-screen")).toContain("bot-b");
});

it("a takeover returned after renderer loss cannot enable the replacement keyboard", async () => {
  await render();
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="Open computer"]')?.click();
  });
  const pending = deferred<{ ok: boolean }>();
  const respond = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string, body: { botId: string }) =>
    proc === "computer/takeover" ? pending.promise : respond(proc, body),
  );
  const takeControl = Array.from(host.querySelectorAll<HTMLButtonElement>("section button")).find(
    (button) => button.textContent === "Take control",
  );
  await act(async () => takeControl?.click());
  expect(calls("computer/takeover")).toHaveLength(1);
  currentStatus = status({ controlHolder: "user", controlBotId: "bot-a" });
  await act(async () => state.screenProps?.onRenderProcessGone());
  await act(async () => pending.resolve({ ok: true }));
  expect(host.querySelector("section[data-full] [data-screen]")?.getAttribute("data-pointer")).toBe(
    "none",
  );
  expect(state.screenProps?.onMessage).toBeUndefined();
});

it("does not dispatch a pending takeover after the app backgrounds during boot", async () => {
  currentStatus = status({ state: "suspended", screenAvailable: false });
  await render();
  const pending = deferred<{ ok: boolean }>();
  const respond = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string, body: { botId: string }) =>
    proc === "computer/boot" ? pending.promise : respond(proc, body),
  );
  const takeControl = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === "Take control",
  );
  await act(async () => takeControl?.click());
  expect(calls("computer/boot")).toHaveLength(1);
  await appState("background");
  await act(async () => pending.resolve({ ok: true }));
  expect(calls("computer/takeover")).toHaveLength(0);
});

it("does not retain an old Bot's stream after a late explicit screen refresh", async () => {
  await render();
  const old = deferred<{ url: string | null }>();
  nextScreen = old.promise;
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="Open computer"]')?.click();
  });
  state.params = { botId: "bot-b", name: "Other Bot" };
  currentStatus = status();
  await render();
  await act(async () => old.resolve({ url: "https://screen.example.test/bot-a/stale" }));
  expect(host.querySelectorAll("[data-screen]")).toHaveLength(1);
  expect(host.querySelector("[data-screen]")?.getAttribute("data-screen")).toContain("/bot-b/");
  expect(host.querySelector("section[data-full]")).toBeNull();
});

it("rechecks a retained Bot on an actor/Space change without replaying its entry boot", async () => {
  await render();
  const bootCount = calls("computer/boot").length;
  const fresh = deferred<ComputerStatus>();
  nextStatus = fresh.promise;
  await act(async () => {
    state.scope = "space-a:user-b:1";
    for (const listener of state.scopeListeners) listener();
  });
  expect(host.querySelector("[data-screen]")).toBeNull();
  const heartbeats = calls("computer/heartbeat").length;
  await advance(60_000);
  expect(calls("computer/heartbeat")).toHaveLength(heartbeats);
  await act(async () => fresh.resolve(status()));
  expect(calls("computer/heartbeat")).toHaveLength(heartbeats + 1);
  expect(calls("computer/boot")).toHaveLength(bootCount);
});

it("does not boot from a failed foreground status read", async () => {
  statusError = new Error("status failed");
  await render();
  expect(calls("computer/boot")).toHaveLength(0);
  expect(calls("computer/heartbeat")).toHaveLength(0);
});
