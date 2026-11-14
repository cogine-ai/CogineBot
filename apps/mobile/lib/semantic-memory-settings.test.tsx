// @vitest-environment jsdom
import type { SpaceMemoryConfig } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MemorySettings from "../app/(settings)/memory";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  params: { spaceId: "space-a", botId: "bot-a" } as Record<string, string>,
  selected: "space-a",
  generation: 0,
  owner: true,
  listeners: new Set<() => void>(),
  config: null as SpaceMemoryConfig | null,
  botScope: null as "isolated" | "shared" | null,
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => state.params,
  useFocusEffect: (callback: () => void) => useEffect(callback, [callback]),
}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async () => ({ headers: { "x-rakazo-space-id": state.selected } }),
  currentApiBase: () => "https://api.example.test",
  currentApiBaseGeneration: () => 0,
  selectedSpaceId: () => state.selected,
  spaceSelectionSeq: () => 0,
  currentSpaceSelectionGeneration: () => state.generation,
  subscribeApiBase: () => () => {},
  subscribeSelectedSpace: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => 0,
  subscribeSessionGeneration: () => () => {},
}));
vi.mock("./i18n", () => ({ t: (s: string) => s, useI18n: () => ({ t: (s: string) => s }) }));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    Text: View,
    ScrollView: View,
    StyleSheet: { create: (s: unknown) => s },
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      secureTextEntry,
      editable,
    }: {
      accessibilityLabel: string;
      value: string;
      onChangeText: (v: string) => void;
      secureTextEntry: boolean;
      editable: boolean;
    }) => (
      <input
        aria-label={accessibilityLabel}
        type={secureTextEntry ? "password" : "text"}
        value={value}
        disabled={!editable}
        onChange={(event) => onChangeText(event.target.value)}
      />
    ),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    value,
    onValueChange,
    disabled,
  }: {
    accessibilityLabel: string;
    value: boolean;
    onValueChange: (v: boolean) => void;
    disabled: boolean;
  }) => (
    <input
      type="checkbox"
      aria-label={accessibilityLabel}
      checked={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    label,
    value,
    choices,
    onChange,
    disabled,
  }: {
    label: string;
    value: string;
    choices: { key: string; label: string }[];
    onChange: (v: string) => void;
    disabled: boolean;
  }) => (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {choices.map((c) => (
        <option key={c.key} value={c.key}>
          {c.label}
        </option>
      ))}
    </select>
  ),
}));

let root: Root;
let host: HTMLDivElement;
const configured = (): SpaceMemoryConfig => ({
  provider: "supermemory",
  settings: { mode: "cloud" },
  defaultMemoryScope: "isolated",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.params = { spaceId: "space-a", botId: "bot-a" };
  state.selected = "space-a";
  state.generation = 0;
  state.owner = true;
  state.config = null;
  state.botScope = null;
  state.rpc
    .mockReset()
    .mockImplementation(
      async (
        procedure: string,
        input: Record<string, unknown>,
        options: { requestContext: { headers: Record<string, string> } },
      ) => {
        const target = options.requestContext.headers["x-rakazo-space-id"];
        if (procedure === "me") return { spaceId: target };
        if (procedure === "spaces/list")
          return { current: { id: target }, spaces: [{ id: target, canRename: state.owner }] };
        if (procedure === "memory/providerConfig") return state.config;
        if (procedure === "bots/get")
          return {
            id: input.botId,
            spaceId: target,
            name: "Example bot",
            memoryScope: state.botScope,
          };
        if (procedure === "memory/connectProvider") {
          state.config = { ...configured(), ...input };
          return state.config;
        }
        if (procedure === "memory/disconnectProvider") {
          state.config = null;
          return { ok: true };
        }
        if (procedure === "memory/setDefaultScope") {
          state.config = {
            ...state.config!,
            defaultMemoryScope: input.defaultMemoryScope as "isolated" | "shared",
          };
          return state.config;
        }
        if (procedure === "bots/update") {
          state.botScope = input.memoryScope as typeof state.botScope;
          return {};
        }
        throw new Error("Unexpected procedure");
      },
    );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => root.render(<MemorySettings />));
}
async function change(label: string, value: string) {
  const node = host.querySelector(`[aria-label="${label}"]`) as
    | HTMLInputElement
    | HTMLSelectElement;
  expect(node).toBeTruthy();
  await act(async () => {
    const prototype =
      node.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(
      new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  });
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}

it("connects both Web-registered forms through secure input, reads back and disconnects", async () => {
  await mount();
  expect(host.querySelector('[aria-label="Organization API key"]')?.getAttribute("type")).toBe(
    "password",
  );
  await change("Organization API key", "fake-api-key");
  await click("Connect");
  expect(state.rpc).toHaveBeenCalledWith(
    "memory/connectProvider",
    {
      provider: "supermemory",
      settings: { mode: "cloud" },
      credentials: { apiKey: "fake-api-key" },
      defaultMemoryScope: "isolated",
    },
    expect.anything(),
  );
  expect(host.textContent).toContain("Configured");
  expect(host.textContent).not.toContain("Connected");
  await click("Disconnect");
  await change("Provider", "serenity");
  await change("MCP endpoint", "https://memory.example.test/mcp");
  await change("Bearer token", "fake-token");
  await change("Brain label", "Example");
  await click("Connect");
  expect(state.rpc).toHaveBeenCalledWith(
    "memory/connectProvider",
    {
      provider: "serenity",
      settings: {
        endpoint: "https://memory.example.test/mcp",
        brainLabel: "Example",
        allowWrites: "false",
      },
      credentials: { token: "fake-token" },
      defaultMemoryScope: "isolated",
    },
    expect.anything(),
  );
  expect(host.querySelector('input[type="password"]')).toBeNull();
  await click("Disconnect");
  expect(host.textContent).not.toContain("Configured");
});
it("preserves null inheritance through default changes and explicit bot overrides", async () => {
  state.config = configured();
  await mount();
  await change("Default scope", "shared");
  expect(state.botScope).toBeNull();
  await change("Memory scope", "isolated");
  await change("Default scope", "isolated");
  expect(state.botScope).toBe("isolated");
  await change("Memory scope", "inherit");
  expect(state.rpc).toHaveBeenCalledWith(
    "bots/update",
    { botId: "bot-a", memoryScope: null },
    expect.anything(),
  );
});
it("does not show provider write controls to a non-owner", async () => {
  state.owner = false;
  state.config = configured();
  await mount();
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Disconnect")).toBe(
    false,
  );
  expect((host.querySelector('[aria-label="Default scope"]') as HTMLSelectElement).disabled).toBe(
    true,
  );
});
it("remounts on target changes, clears credentials, and never displays a late prior-space result", async () => {
  await mount();
  await change("Organization API key", "fake-api-key");
  let resolve!: (value: unknown) => void;
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((procedure, input, options) =>
    procedure === "memory/connectProvider"
      ? new Promise((r) => {
          resolve = r;
        })
      : original(procedure, input, options),
  );
  await click("Connect");
  await act(async () => {
    state.params = { spaceId: "space-b" };
    state.selected = "space-b";
    state.generation++;
    for (const listener of state.listeners) listener();
  });
  expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
  await act(async () => resolve(configured()));
  expect(host.textContent).not.toContain("Configured");
  expect(host.textContent).not.toContain("Example bot");
});
it("clears a failed connection and hides upstream errors that may contain credentials", async () => {
  await mount();
  await change("Organization API key", "fake-api-key");
  state.rpc.mockRejectedValueOnce(new Error("fake-secret-from-upstream"));
  await click("Connect");
  expect(host.textContent).toContain("Reload to check the current state");
  expect(host.textContent).not.toContain("fake-secret");
  expect(host.textContent).not.toContain("Configured");
  await click("Retry");
  expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
});

it("opens a cold settings deep link without an already selected Space", async () => {
  state.params = {};
  state.selected = "";
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((procedure, input, options) => {
    if (procedure === "me" && !options.requestContext.headers["x-rakazo-space-id"])
      return Promise.resolve({ spaceId: "space-a" });
    return original(procedure, input, options);
  });
  await mount();
  expect(host.querySelector('[aria-label="Organization API key"]')).not.toBeNull();
  expect(state.rpc).toHaveBeenCalledWith(
    "memory/providerConfig",
    {},
    expect.objectContaining({
      requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-a" } }),
    }),
  );
});
