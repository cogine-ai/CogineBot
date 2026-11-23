// @vitest-environment jsdom

import * as SecureStore from "expo-secure-store";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import VoiceSettings from "../app/(settings)/voice";
import { DEVICE_VOICE_KEY, loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } from "./device-voice";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  store: new Map<string, string>(),
  params: {} as Record<string, string>,
  generation: 0,
}));
const t = (text: string) => text;
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => state.params,
  useFocusEffect: (callback: () => void) => useEffect(callback, [callback]),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => 0,
  subscribeSessionGeneration: () => () => {},
}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "https://api.example.test",
  currentApiBaseGeneration: () => 0,
  currentSpaceSelectionGeneration: () => state.generation,
  selectedSpaceId: () => "space-a",
  spaceSelectionSeq: () => 0,
  subscribeApiBase: () => () => {},
  subscribeSelectedSpace: () => () => {},
  captureApiRequestContext: async () => ({
    apiBase: "https://api.example.test",
    headers: { "x-rakazo-space-id": "space-1" },
  }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => state.store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    state.store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    state.store.delete(key);
  }),
}));
vi.mock("./call-sounds", () => ({
  loadCallSoundsEnabled: async () => true,
  loadWaitSoundEnabled: async () => true,
  saveCallSoundsEnabled: vi.fn(),
  saveWaitSoundEnabled: vi.fn(),
  playCallCue: vi.fn(),
}));
vi.mock("./voice", () => ({ speakText: vi.fn(async () => true) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./i18n", () => ({ t: (text: string) => text, useI18n: () => ({ t }) }));
vi.mock("../components/row-accessories", () => ({
  Checkmark: () => <span data-testid="checkmark" />,
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({ label, onChange }: { label: string; onChange: (key: string) => void }) => (
    <button
      type="button"
      onClick={() => onChange(label === "My default voice" ? "voice:fish-audio-voice" : "true")}
    >
      {label}
    </button>
  ),
}));
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress, disabled }: ButtonProps & { label: string }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
type ButtonProps = {
  children?: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  accessibilityState?: { selected: boolean };
};
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    Alert: { alert: state.alert },
    ScrollView: View,
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    ActivityIndicator: () => null,
    StyleSheet: { create: (styles: unknown) => styles },
    Pressable: ({ children, onPress, disabled, accessibilityState }: ButtonProps) => (
      <button
        type="button"
        disabled={disabled}
        aria-pressed={accessibilityState?.selected}
        onClick={onPress}
      >
        {children}
      </button>
    ),
    TextInput: ({ accessibilityLabel, value }: { accessibilityLabel: string; value: string }) => (
      <input aria-label={accessibilityLabel} value={value} readOnly />
    ),
  };
});

const catalog = [
  { id: "fish-audio", name: "Fish Audio", transcribe: true },
  { id: "other", name: "Other provider", transcribe: false },
  { id: "new", name: "New provider", transcribe: false },
];
const credentials = [
  { id: "fish", provider: "fish-audio", voiceId: "fish-voice", speechModel: "speech-model" },
  { id: "other", provider: "other", voiceId: "other-voice" },
];
let activeProvider: string;
let root: Root;
let container: HTMLDivElement;
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function selected(label: string) {
  expect(button(label).getAttribute("aria-pressed")).toBe("true");
  expect(button(label).querySelector('[data-testid="checkmark"]')).not.toBeNull();
}
function unselected(label: string) {
  expect(button(label).getAttribute("aria-pressed")).toBe("false");
  expect(button(label).querySelector('[data-testid="checkmark"]')).toBeNull();
}
async function render() {
  await act(async () => root.render(<VoiceSettings />));
}
async function click(label: string) {
  await act(async () => button(label).click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activeProvider = "fish-audio";
  state.params = { spaceId: "space-b" };
  state.generation = 0;
  state.alert.mockClear();
  state.store.clear();
  state.store.set(DEVICE_VOICE_KEY, "1");
  vi.mocked(SecureStore.getItemAsync).mockClear();
  vi.mocked(SecureStore.setItemAsync)
    .mockClear()
    .mockImplementation(async (key, value) => {
      state.store.set(key, value);
    });
  vi.mocked(SecureStore.deleteItemAsync)
    .mockClear()
    .mockImplementation(async (key) => {
      state.store.delete(key);
    });
  state.rpc
    .mockReset()
    .mockImplementation(
      async (
        proc: string,
        args?: { provider: string },
        options?: { requestContext?: { headers: Record<string, string> } },
      ) => {
        if (proc === "me")
          return {
            userId: "user-1",
            spaceId: options?.requestContext?.headers["x-rakazo-space-id"] ?? "space-a",
          };
        if (proc === "preferences/readAloud" || proc === "preferences/updateReadAloud") {
          const writing = proc === "preferences/updateReadAloud";
          const settings = {
            account: { value: writing ? true : null, revision: writing ? 1 : 0 },
            space: { value: null, revision: 0 },
            effective: { enabled: writing, source: writing ? "account" : "system" },
            followingSpaces: [
              { id: options?.requestContext?.headers["x-rakazo-space-id"], name: "Support" },
            ],
          };
          return writing ? { status: "updated", settings } : settings;
        }
        if (proc === "voice/catalog") return catalog;
        if (proc === "voice/credentials") return credentials;
        if (proc === "voice/defaults")
          return {
            account: { value: null, revision: 0 },
            space: { value: false, revision: 0 },
            provider: activeProvider,
            followingSpaces: [
              { id: options?.requestContext?.headers["x-rakazo-space-id"], name: "Support" },
            ],
            effective: {
              choice: { provider: activeProvider, voiceId: "fish-audio-voice" },
              source: "system",
            },
          };
        if (proc === "voice/setVoice") activeProvider = args!.provider;
        if (proc === "voice/status" || proc === "voice/setVoice") {
          return {
            configured: true,
            ready: true,
            provider: activeProvider,
            voiceId: "saved-voice",
          };
        }
        if (proc === "voice/voices")
          return [{ id: `${args!.provider}-voice`, label: `${args!.provider} voice` }];
        throw new Error(`Unexpected RPC: ${proc}`);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("keeps provider actions locked during a confirmed hosted voice default save", async () => {
  state.store.set(DEVICE_VOICE_KEY, "0");
  const held = deferred<unknown>();
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string, input: unknown, options: unknown) =>
    name === "voice/updateDefaults" ? held.promise : normal(name, input, options),
  );
  await render();
  await click("My default voice");
  const confirm = state.alert.mock.lastCall?.[2]?.find(
    ({ text }: { text: string }) => text === "Confirm",
  ).onPress;
  expect(confirm).toBeTypeOf("function");
  await act(async () => {
    confirm();
    confirm();
  });
  const writes = state.rpc.mock.calls.filter(([name]) => name === "voice/updateDefaults");
  expect(writes).toHaveLength(1);
  expect(writes[0]?.[1]).toMatchObject({
    scope: "account",
    value: { provider: "fish-audio", voiceId: "fish-audio-voice" },
    expectedRevision: 0,
    followingSpaceIds: ["space-b"],
  });
  expect(writes[0]?.[2].requestContext.headers["x-rakazo-space-id"]).toBe("space-b");
  expect(button("Other provider").disabled).toBe(true);
  await act(async () =>
    held.resolve({
      status: "updated",
      settings: await normal(
        "voice/defaults",
        {},
        { requestContext: { headers: { "x-rakazo-space-id": "space-b" } } },
      ),
    }),
  );
  expect(button("Other provider").disabled).toBe(false);
});

it("does not compensate an old target over the new target's device preference", async () => {
  const activation = deferred<unknown>();
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string, input: unknown, options: unknown) =>
    name === "voice/setVoice" ? activation.promise : normal(name, input, options),
  );
  await render();
  await click("Other provider");
  expect(await loadDeviceVoiceEnabled()).toBe(false);
  state.params = { spaceId: "space-c" };
  await render();
  await click("This device");
  await click("This device");
  expect(await loadDeviceVoiceEnabled()).toBe(false);
  await act(async () => activation.reject(new Error("Old provider failed")));
  expect(await loadDeviceVoiceEnabled()).toBe(false);
  expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
  unselected("This device");
});

it("does not compensate an earlier target lifetime after B to C to B", async () => {
  const activation = deferred<unknown>();
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string, input: unknown, options: unknown) =>
    name === "voice/setVoice" ? activation.promise : normal(name, input, options),
  );
  await render();
  await click("Other provider");
  state.params = { spaceId: "space-c" };
  await render();
  state.params = { spaceId: "space-b" };
  await render();
  await click("This device");
  await click("This device");
  await act(async () => activation.reject(new Error("Old provider failed")));
  expect(await loadDeviceVoiceEnabled()).toBe(false);
  expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
  unselected("This device");
});

it("does not let an old compensation claim a newer device intent in the same form", async () => {
  const activation = deferred<unknown>();
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string, input: unknown, options: unknown) =>
    name === "voice/setVoice" ? activation.promise : normal(name, input, options),
  );
  await render();
  await click("Other provider");
  await saveDeviceVoiceEnabled(false);
  await act(async () => activation.reject(new Error("Old provider failed")));
  expect(await loadDeviceVoiceEnabled()).toBe(false);
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
});

it("still restores device voice when the same current intent fails to activate", async () => {
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string, input: unknown, options: unknown) =>
    name === "voice/setVoice"
      ? Promise.reject(new Error("Provider unavailable"))
      : normal(name, input, options),
  );
  await render();
  await click("Other provider");
  expect(await loadDeviceVoiceEnabled()).toBe(true);
  selected("This device");
  expect(container.textContent).toContain("Provider unavailable");
});

it("does not apply a read-aloud confirmation from an earlier Space visit", async () => {
  await render();
  await click("My default");
  const initial = state.alert.mock.calls.at(-1)!;
  expect(initial[1]).toContain("System default → On");
  expect(initial[1]).toContain("Support");
  const confirm = initial[2][1].onPress as () => void;
  state.params = { spaceId: "space-c" };
  await render();
  state.params = { spaceId: "space-b" };
  await render();
  await act(async () => confirm());
  const writes = () =>
    state.rpc.mock.calls.filter(([name]) => name === "preferences/updateReadAloud");
  expect(writes()).toHaveLength(0);

  await click("My default");
  const current = state.alert.mock.calls.at(-1)![2][1].onPress as () => void;
  await act(async () => current());
  expect(writes()).toHaveLength(1);
  expect(writes()[0]?.[1]).toMatchObject({
    scope: "account",
    value: true,
    expectedRevision: 0,
    followingSpaceIds: ["space-b"],
  });
});
