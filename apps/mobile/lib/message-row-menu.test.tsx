// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageMenuEntry } from "./message-context-menu";
import { buildMessageContextMenu, messageMenuReaction } from "./message-context-menu";
import { useMessageSpeechAvailable } from "./use-message-speech";

const state = vi.hoisted(() => ({
  generation: 1,
  focused: true,
  active: true,
  listeners: new Set<() => void>(),
  device: vi.fn(),
  speech: vi.fn(),
  rpc: vi.fn(),
  context: vi.fn(),
}));
vi.mock("expo-router", () => ({ useIsFocused: () => state.focused }));
vi.mock("./app-active", () => ({ useAppActive: () => state.active }));
vi.mock("./device-voice", () => ({ loadDeviceVoiceEnabled: state.device }));
vi.mock("./voice", () => ({ deviceSpeechAvailable: state.speech }));
vi.mock("./api", () => ({ rpc: state.rpc, captureApiRequestContext: state.context }));
vi.mock("./mobile-scope", () => ({
  mobileScopeKey: () => String(state.generation),
  captureMobileScope: () => ({ generation: state.generation }),
  isMobileScopeCurrent: (scope: { generation: number }) => scope.generation === state.generation,
  subscribeMobileScope: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));

type Action = { name: string; label: string };
type Sheet = { isCurrent: () => boolean; actions: Array<{ text: string; onPress: () => void }> };
type Menu = {
  menu: MessageMenuEntry[];
  onMenuAction: (id: string) => void;
  actionProps: {
    accessibilityActions: Action[];
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => void;
    onLongPress: (event: { nativeEvent: { pageX: number; pageY: number } }) => void;
  };
};
const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
const start = source.indexOf("    const menuOwner = captureMobileScope();");
const end = source.indexOf("\n  }, [", start);
if (start < 0 || end < 0) throw new Error("MessageRow menu callback factory not found");
const factory =
  stripTypeScriptTypes(`function createMenu() {\n${source.slice(start, end)}\n}`) +
  "; return createMenu();";
function row(canSpeak: boolean) {
  const version = {},
    current = { current: version },
    active = { current: true };
  let sheet: Sheet | undefined;
  let overlay: { groups: Array<Array<{ name: string; onPress: () => void }>> } | undefined;
  const actions = Object.fromEntries(
    ["reply", "quote", "select", "react", "speak"].map((name) => [name, vi.fn()]),
  );
  const clipboard = vi.fn(async () => {});
  const env = {
    captureMobileScope: () => state.generation,
    isMobileScopeCurrent: (scope: number) => scope === state.generation,
    menuVersion: version,
    currentMenuVersion: current,
    menuActive: active,
    AppState: { currentState: "active" },
    message: { id: "message", role: "bot", blocks: [{ kind: "text", text: "Original" }] },
    readOnly: false,
    onCall: false,
    canSpeak,
    canReactToThreadMessage: () => true,
    selectableMobileMessageText: () => "Original",
    quotableMessageSegments: () => ["Original"],
    blockText: () => "Original",
    copyableMobileMessageText: () => "Original",
    selectableTextFromMarkdown: (text: string) => text,
    actions,
    t: (text: string) => text,
    MESSAGE_REACTIONS: ["👍"],
    presentMessageActionSheet: (value: Sheet) => {
      sheet = value;
    },
    colorScheme: "light",
    buildMessageContextMenu,
    messageMenuReaction,
    Platform: { OS: "android" },
    closeMenu: { current: null },
    presentMessageMenu: (value: typeof overlay) => {
      overlay = value;
      return () => {};
    },
    Clipboard: { setStringAsync: clipboard },
  };
  const menu = new Function(...Object.keys(env), factory)(...Object.values(env)) as Menu;
  return {
    menu,
    actions,
    clipboard,
    env,
    current,
    active,
    sheet: () => sheet!,
    overlay: () => overlay!,
  };
}
function names(entries: MessageMenuEntry[]): string[] {
  return entries.flatMap((entry) => [entry.id, ...names(entry.subactions ?? [])]);
}
let cleanup = async () => {};
beforeEach(() => {
  state.generation = 1;
  state.focused = true;
  state.active = true;
  state.device.mockReset().mockResolvedValue(false);
  state.speech.mockReset().mockResolvedValue(true);
  state.rpc.mockReset().mockResolvedValue({ ready: false });
  state.context.mockReset().mockResolvedValue({ apiBase: "https://api.example.test", headers: {} });
});
afterEach(async () => {
  await cleanup();
  state.listeners.clear();
});

async function screen() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  function Screen() {
    const canSpeak = useMessageSpeechAvailable();
    const value = row(canSpeak);
    return (
      <div
        data-native={names(value.menu.menu).join(",")}
        data-accessibility={value.menu.actionProps.accessibilityActions
          .map((action) => action.name)
          .join(",")}
      />
    );
  }
  const render = async () => {
    await act(async () => root.render(<Screen />));
  };
  cleanup = async () => {
    await act(async () => root.unmount());
  };
  await render();
  return {
    element,
    render,
    hasSpeak: () =>
      element.firstElementChild?.getAttribute("data-native")?.split(",").includes("speak") === true,
    accessibleSpeak: () =>
      element.firstElementChild
        ?.getAttribute("data-accessibility")
        ?.split(",")
        .includes("speak") === true,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("actual MessageRow callback lifetime", () => {
  it.each(["current", "account-ABA", "message-version", "route-blur", "background"])(
    "rechecks %s at the final native reaction callback",
    (kind) => {
      const value = row(true);
      value.menu.actionProps.onAccessibilityAction({ nativeEvent: { actionName: "react" } });
      const sheet = value.sheet();
      expect(sheet.actions).toHaveLength(1);
      if (kind === "account-ABA") state.generation = 3;
      if (kind === "message-version") value.current.current = {};
      if (kind === "route-blur") value.active.current = false;
      if (kind === "background") value.env.AppState.currentState = "background";
      sheet.actions[0]!.onPress();
      expect(value.actions.react).toHaveBeenCalledTimes(kind === "current" ? 1 : 0);
    },
  );
  it("fences retained actions and stale long presses after capability invalidation", () => {
    const value = row(true);
    value.menu.actionProps.onLongPress({ nativeEvent: { pageX: 10, pageY: 20 } });
    const retained = value.overlay().groups.flat();
    value.current.current = {};
    for (const action of retained) action.onPress();
    value.menu.onMenuAction("speak");
    value.menu.actionProps.onAccessibilityAction({ nativeEvent: { actionName: "copy" } });
    expect(Object.values(value.actions).every((action) => action.mock.calls.length === 0)).toBe(
      true,
    );
    expect(value.clipboard).not.toHaveBeenCalled();
  });
});

describe("capability-owned Speak in both native and accessibility menus", () => {
  it("hides Speak by default without device voice or a ready provider", async () => {
    const view = await screen();
    expect(view.hasSpeak()).toBe(false);
    expect(view.accessibleSpeak()).toBe(false);
  });
  it("shows OS-default speech without enumerating voices or querying a provider", async () => {
    state.device.mockResolvedValue(true);
    const view = await screen();
    expect(view.hasSpeak()).toBe(true);
    expect(view.accessibleSpeak()).toBe(true);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("shows Speak when the current provider is ready", async () => {
    state.rpc.mockResolvedValue({ ready: true });
    const view = await screen();
    expect(view.hasSpeak()).toBe(true);
    expect(view.accessibleSpeak()).toBe(true);
  });
  it.each(["preference", "device", "provider"])(
    "hides unknown/failed %s capability without switching voice paths",
    async (kind) => {
      if (kind === "preference") state.device.mockRejectedValue(new Error("locked"));
      if (kind === "device") {
        state.device.mockResolvedValue(true);
        state.speech.mockRejectedValue(new Error("unsupported"));
      }
      if (kind === "provider") state.rpc.mockRejectedValue(new Error("offline"));
      const view = await screen();
      expect(view.hasSpeak()).toBe(false);
      expect(view.accessibleSpeak()).toBe(false);
      if (kind !== "provider") expect(state.rpc).not.toHaveBeenCalled();
    },
  );
  it.each(["device", "provider"])(
    "ignores a late %s ready result after same-Space account ABA",
    async (kind) => {
      const old = deferred<boolean | { ready: boolean }>();
      if (kind === "device") {
        state.device.mockResolvedValue(true);
        state.speech.mockImplementationOnce(() => old.promise).mockResolvedValue(false);
      } else
        state.rpc.mockImplementationOnce(() => old.promise).mockResolvedValue({ ready: false });
      const view = await screen();
      expect(view.hasSpeak()).toBe(false);
      await act(async () => {
        state.generation = 3;
        for (const listener of state.listeners) listener();
      });
      await act(async () => old.resolve(kind === "device" ? true : { ready: true }));
      expect(view.hasSpeak()).toBe(false);
      expect(view.accessibleSpeak()).toBe(false);
    },
  );
  it("invalidates menu readiness on blur and rechecks when Voice settings return", async () => {
    state.rpc.mockResolvedValueOnce({ ready: true }).mockResolvedValue({ ready: false });
    const view = await screen();
    expect(view.hasSpeak()).toBe(true);
    state.focused = false;
    await view.render();
    expect(view.hasSpeak()).toBe(false);
    state.focused = true;
    await view.render();
    expect(view.hasSpeak()).toBe(false);
    expect(view.accessibleSpeak()).toBe(false);
  });
});
