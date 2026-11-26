// @vitest-environment jsdom

import type { ModelDefaults, ThinkingDefaults, UpdateModelDefaultsInput } from "@rakazo/contracts";
import { defaultModelChoiceKey, MODEL_INFERENCE_PROBE_TIMEOUT_MS } from "@rakazo/contracts";
import { modelOptionKey } from "@rakazo/core";
import type { ReactNode } from "react";
import { act, useEffect, useLayoutEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Models from "../app/(settings)/models";
import SpaceSettings from "../app/(settings)/space-settings";
import RoutineDetail from "../app/routine";
import { resetI18nForTests } from "./i18n";
import { presentMessageActionSheet } from "./message-action-sheet";
import { useSpaceSettings } from "./space-settings";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  alert: vi.fn(),
  params: { botId: "bot-1", routineId: "routine-1" } as Record<string, string>,
  apiBase: "https://api.example.test",
  spaceGeneration: 0,
  sessionGeneration: 0,
  spaceId: "space-1" as string | null,
  focus: undefined as undefined | (() => (() => void) | undefined),
  blur: undefined as undefined | (() => void),
}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  currentApiBase: () => state.apiBase,
  currentSpaceSelectionGeneration: () => state.spaceGeneration,
  selectedSpaceId: () => state.spaceId,
  captureApiRequestContext: async () => ({
    apiBase: state.apiBase,
    spaceId: state.spaceId,
    headers: state.spaceId ? { "x-rakazo-space-id": state.spaceId } : {},
    sessionGeneration: state.sessionGeneration,
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => state.sessionGeneration }));
vi.mock("./mobile-scope", () => {
  const capture = () => ({
    apiBase: state.apiBase,
    apiGeneration: 0,
    sessionGeneration: state.sessionGeneration,
    spaceId: state.spaceId,
    spaceGeneration: state.spaceGeneration,
    selectionSeq: 0,
  });
  return {
    captureMobileScope: capture,
    isMobileScopeCurrent: (scope: Record<string, unknown>) =>
      Object.entries(capture()).every(([key, value]) => scope[key] === value),
    mobileScopeKey: () => JSON.stringify(capture()),
    subscribeMobileScope: () => () => {},
  };
});
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: vi.fn(), push: state.push }),
  useLocalSearchParams: () => state.params,
  useFocusEffect: (effect: () => () => void) =>
    useEffect(() => {
      state.focus = effect;
      state.blur = effect();
      return state.blur;
    }, [effect]),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock("@expo/ui/community/datetime-picker", () => ({
  default: ({
    mode,
    value,
    onValueChange,
  }: {
    mode: string;
    value: Date;
    onValueChange: (event: unknown, date: Date) => void;
  }) => (
    <button
      type="button"
      data-value={value.toISOString()}
      onClick={() =>
        onValueChange({}, new Date(value.getTime() + (mode === "time" ? 17 * 60_000 : 86_400_000)))
      }
    >
      {mode === "time" ? "Select time of day" : "Select first date"}
    </button>
  ),
}));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/row-accessories", () => ({ Checkmark: () => null, Chevron: () => null }));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children, label }: { children: ReactNode; label?: string }) => (
    <div>
      {label}
      {children}
    </div>
  ),
  SettingsRow: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {title}
    </button>
  ),
  SettingsSwitch: () => null,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => (
    <button type="button" disabled={disabled} aria-label={accessibilityLabel} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    value,
    onValueChange,
  }: {
    accessibilityLabel: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={accessibilityLabel}
      checked={value}
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
  }: {
    label: string;
    value: string;
    choices: Array<{ key: string; label: string }>;
    onChange: (key: string) => void;
  }) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  );
  return {
    View,
    Platform: { OS: "ios" },
    ScrollView: View,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    ActivityIndicator: () => <span data-testid="loading" />,
    StyleSheet: { create: (styles: unknown) => styles },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    Keyboard: { dismiss: vi.fn() },
    Linking: { openURL: vi.fn() },
    Alert: { alert: state.alert },
    Pressable: ({
      children,
      onPress,
      disabled,
      accessibilityLabel,
      accessibilityState,
    }: {
      children?: ReactNode;
      onPress: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
      accessibilityState?: { selected?: boolean };
    }) => (
      <button
        type="button"
        disabled={disabled}
        aria-label={accessibilityLabel}
        aria-pressed={accessibilityState?.selected}
        onClick={onPress}
      >
        {children}
      </button>
    ),
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      editable,
      secureTextEntry,
    }: {
      accessibilityLabel?: string;
      value: string;
      onChangeText: (value: string) => void;
      editable?: boolean;
      secureTextEntry?: boolean;
    }) => (
      <input
        type={secureTextEntry ? "password" : "text"}
        aria-label={accessibilityLabel}
        value={value}
        disabled={editable === false}
        onChange={(event) => onChangeText(event.target.value)}
      />
    ),
  };
});

const credential = {
  id: "connection-a",
  provider: "openai-compatible",
  label: "Server",
  hasKey: true,
  isDefault: true,
  modelId: "model-a",
  enabledModelIds: ["model-a", "model-b"],
  baseUrl: "https://models.example.test/v1",
  connectionRevision: 7,
  thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
};
const catalog = [
  {
    provider: "openai-compatible",
    providerName: "Model server",
    id: "custom",
    label: "Custom",
    billing: "",
    auth: "api-key",
    placeholder: true,
  },
];
let container: HTMLDivElement;
let root: Root;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === label || entry.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function baseUrl() {
  const field = container.querySelector<HTMLInputElement>(
    'input[aria-label="OpenAI-compatible server URL"]',
  );
  if (!field) throw new Error("Missing endpoint field");
  return field;
}
async function edit(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function refocus() {
  await act(async () => {
    state.blur?.();
    state.blur = state.focus?.();
    await Promise.resolve();
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetI18nForTests("en");
  state.push.mockReset();
  state.alert.mockReset();
  state.params = { botId: "bot-1", routineId: "routine-1" };
  state.apiBase = "https://api.example.test";
  state.spaceGeneration = 0;
  state.sessionGeneration = 0;
  state.spaceId = "space-1";
  state.focus = undefined;
  state.blur = undefined;
  state.rpc.mockReset().mockImplementation(async (procedure: string) => {
    if (procedure === "me")
      return {
        userId: "user-1",
        spaceId: "space-1",
        defaultProvider: "openai-compatible",
        defaultModel: "model-a",
      };
    if (procedure === "models/list") return catalog;
    if (procedure === "models/credentials") return [credential];
    if (procedure === "models/references") return { references: [] };
    if (procedure === "models/backups") return [];
    if (procedure === "routines/list")
      return [
        {
          id: "routine-1",
          botId: "bot-1",
          name: "Daily",
          prompt: "Review",
          crons: [],
          timezone: "UTC",
          active: true,
          modelProvider: "openai-compatible",
          modelId: "model-a",
          modelCredentialId: "connection-a",
          thinkingLevel: null,
        },
      ];
    if (procedure === "models/connect")
      throw Object.assign(new Error("Connection changed"), { code: "CONFLICT" });
    throw new Error(`Unexpected RPC ${procedure}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetI18nForTests("en");
  vi.unstubAllGlobals();
});

it("discards an old account model confirmation and saves only through the current Space", async () => {
  const choice = { provider: "openai-compatible", modelId: "model-a" };
  const snapshot: ModelDefaults = {
    account: { value: null, revision: 0 },
    space: { value: false, revision: 0 },
    effective: { choice, source: "space", unavailable: null },
    choices: [choice],
    followingSpaces: [{ id: "space-settings", name: "Settings Space" }],
  };
  const normal = state.rpc.getMockImplementation()!;
  let remoteRevision = credential.connectionRevision;
  state.rpc.mockImplementation(
    (
      procedure: string,
      input: UpdateModelDefaultsInput,
      options?: { requestContext?: { headers: Record<string, string> } },
    ) => {
      if (procedure === "me")
        return Promise.resolve({
          userId: "user-1",
          spaceId: options?.requestContext?.headers["x-rakazo-space-id"] ?? state.spaceId,
          defaultProvider: choice.provider,
          defaultModel: choice.modelId,
          defaultModelCredentialId: credential.id,
          defaultModelUnavailable: null,
        });
      if (procedure === "models/credentials")
        return Promise.resolve([{ ...credential, connectionRevision: remoteRevision }]);
      if (procedure === "models/defaults") return Promise.resolve(snapshot);
      if (procedure === "models/updateDefaults")
        return Promise.resolve({
          status: "updated",
          settings: {
            ...snapshot,
            account: { revision: 1, value: choice },
            effective: { ...snapshot.effective, source: "account" },
          },
        });
      return normal(procedure, input, options);
    },
  );
  const render = () => act(async () => root.render(<Models />));
  async function choose() {
    const control = container.querySelector<HTMLSelectElement>(
      'select[aria-label="My default model"]',
    );
    if (!control) throw new Error("Model default picker is missing");
    await act(async () => {
      control.value = defaultModelChoiceKey(choice);
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const [title, message, actions] = state.alert.mock.calls.at(-1)!;
    expect(title).toBe("Change my default model?");
    expect(message).toContain("Settings Space");
    return actions[1].onPress as () => void;
  }
  const writes = () => state.rpc.mock.calls.filter(([name]) => name === "models/updateDefaults");
  state.params.spaceId = "space-settings";
  await render();
  const oldConfirm = await choose();
  state.params.spaceId = "space-other";
  await render();
  state.params.spaceId = "space-settings";
  await render();
  await act(async () => oldConfirm());
  expect(writes()).toHaveLength(0);
  await edit(baseUrl(), "https://draft.example.test/v1");
  remoteRevision = credential.connectionRevision + 1;
  const confirm = await choose();
  await act(async () => {
    confirm();
    confirm();
  });
  expect(writes()).toHaveLength(1);
  expect(writes()[0]?.[1]).toMatchObject({
    scope: "account",
    value: choice,
    expectedRevision: 0,
    followingSpaceIds: ["space-settings"],
  });
  expect(writes()[0]?.[2].requestContext.headers["x-rakazo-space-id"]).toBe("space-settings");
  expect(container.textContent).toContain("My default");
  expect(baseUrl().value).toBe("https://draft.example.test/v1");
  await act(async () => button("Save").click());
  expect(state.rpc.mock.calls.find(([name]) => name === "models/connect")?.[1]).toMatchObject({
    baseUrl: "https://draft.example.test/v1",
    expectedRevision: credential.connectionRevision,
  });
});

it("ignores an earlier Space's thinking confirmation and writes only the current target", async () => {
  const model = { provider: "openai-compatible", modelId: "model-a" };
  const snapshot: ThinkingDefaults = {
    account: { value: null, revision: 0 },
    space: { value: null, revision: 0 },
    effective: { level: null, source: "system", unsupported: false },
    binding: {
      model,
      credentialId: credential.id,
      connectionRevision: credential.connectionRevision,
      modelAccountRevision: 0,
      modelSpaceRevision: 0,
    },
    levels: ["low", "high"],
    followsAccount: true,
    followingSpaces: [{ id: "space-settings", name: "Settings Space" }],
  };
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(
    (
      procedure: string,
      input: unknown,
      options?: {
        requestContext?: { headers: Record<string, string> };
      },
    ) => {
      if (procedure === "me")
        return Promise.resolve({
          userId: "user-1",
          spaceId: options?.requestContext?.headers["x-rakazo-space-id"] ?? state.spaceId,
          defaultProvider: model.provider,
          defaultModel: model.modelId,
          defaultModelCredentialId: credential.id,
          thinkingDefaultsAvailable: true,
        });
      if (procedure === "models/thinkingDefaults") return Promise.resolve(snapshot);
      if (procedure === "models/updateThinkingDefaults")
        return Promise.resolve({
          status: "updated",
          settings: {
            ...snapshot,
            account: { value: { model, level: "high" }, revision: 1 },
            effective: { level: "high", source: "account", unsupported: false },
          },
        });
      return normal(procedure, input, options);
    },
  );
  const render = () => act(async () => root.render(<Models />));
  async function choose() {
    const control = container.querySelector<HTMLSelectElement>(
      'select[aria-label="My default thinking"]',
    );
    if (!control) throw new Error("Thinking default picker is missing");
    await act(async () => {
      control.value = "high";
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const [title, message, actions] = state.alert.mock.calls.at(-1)!;
    expect(title).toBe("Change my default thinking?");
    expect(message).toContain("Settings Space");
    return actions[1].onPress as () => void;
  }
  const writes = () =>
    state.rpc.mock.calls.filter(([name]) => name === "models/updateThinkingDefaults");
  state.params.spaceId = "space-settings";
  await render();
  const local = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Thinking in this Space"]',
  );
  expect(local?.value).toBe("inherit");
  await act(async () => local?.dispatchEvent(new Event("change", { bubbles: true })));
  expect(writes()).toHaveLength(0);
  const earlier = await choose();
  state.params.spaceId = "space-other";
  await render();
  state.params.spaceId = "space-settings";
  await render();
  await act(async () => earlier());
  expect(writes()).toHaveLength(0);
  const active = await choose();
  await act(async () => {
    active();
    active();
  });
  expect(writes()).toHaveLength(1);
  expect(writes()[0]?.[1]).toMatchObject({
    scope: "account",
    level: "high",
    expectedRevision: 0,
    followingSpaceIds: ["space-settings"],
  });
  expect(writes()[0]?.[2].requestContext.headers["x-rakazo-space-id"]).toBe("space-settings");
  expect(container.textContent).toContain("My default");
});

it("finishes backup loading after refocus metadata arrives behind an endpoint draft edit", async () => {
  await act(async () => {
    root.render(<Models />);
  });
  expect(button("Add connected model").disabled).toBe(false);
  const gate = deferred<Array<typeof credential>>();
  state.rpc
    .mockImplementationOnce(async () => ({
      userId: "user-1",
      spaceId: "space-1",
      defaultProvider: "openai-compatible",
      defaultModel: "model-a",
    }))
    .mockImplementationOnce(async () => catalog)
    .mockImplementationOnce(() => gate.promise)
    .mockImplementationOnce(async () => ({ references: [] }));
  await refocus();
  await edit(baseUrl(), "https://draft.example.test/v1");
  await act(async () => {
    gate.resolve([{ ...credential, connectionRevision: 9 }]);
    await gate.promise;
  });
  expect(baseUrl().value).toBe("https://draft.example.test/v1");
  expect(button("Add connected model").disabled).toBe(false);
  expect(state.rpc.mock.calls.filter(([procedure]) => procedure === "models/backups")).toHaveLength(
    2,
  );
  await act(async () => {
    button("Save").click();
  });
  expect(
    state.rpc.mock.calls.find(([procedure]) => procedure === "models/connect")?.[1],
  ).toMatchObject({
    baseUrl: "https://draft.example.test/v1",
    credentialId: "connection-a",
    expectedRevision: 7,
  });
});

it("keeps a reordered backup draft usable after its connection is saved", async () => {
  const normal = state.rpc.getMockImplementation()!;
  let revision = 7;
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "models/credentials")
      return [
        { ...credential, connectionRevision: revision },
        {
          ...credential,
          id: "connection-b",
          label: "Other",
          isDefault: false,
          connectionRevision: revision === 7 ? 3 : 11,
        },
      ];
    if (procedure === "models/backups")
      return [
        { provider: "openai-compatible", modelId: "model-a", modelCredentialId: "connection-a" },
        { provider: "openai-compatible", modelId: "model-b", modelCredentialId: "connection-a" },
        { provider: "openai-compatible", modelId: "model-a", modelCredentialId: "connection-b" },
      ];
    if (procedure === "models/connect") {
      revision = 9;
      return { ...credential, connectionRevision: revision };
    }
    if (procedure === "models/setBackups") return input;
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  await act(async () =>
    button("Move Server · https://models.example.test/v1 · model-a down").click(),
  );
  await act(async () => button("Save").click());
  expect(state.rpc.mock.calls.filter(([name]) => name === "models/backups")).toHaveLength(1);
  await act(async () => button("Save backups").click());
  expect(state.rpc.mock.calls.find(([name]) => name === "models/setBackups")?.[1]).toEqual([
    {
      provider: "openai-compatible",
      modelId: "model-b",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
    {
      provider: "openai-compatible",
      modelId: "model-a",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
    {
      provider: "openai-compatible",
      modelId: "model-a",
      modelCredentialId: "connection-b",
      expectedRevision: 3,
    },
  ]);
});

it("uses its acknowledged connection revision when an earlier backup load finishes later", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const backupLoad = deferred<unknown[]>();
  let loads = 0;
  let revision = 7;
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "models/credentials")
      return [{ ...credential, connectionRevision: revision }];
    if (procedure === "models/backups") return ++loads === 1 ? [] : backupLoad.promise;
    if (procedure === "models/connect") {
      revision = 9;
      return { ...credential, connectionRevision: revision };
    }
    if (procedure === "models/setBackups") return input;
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  await refocus();
  await act(async () => button("Save").click());
  await act(async () =>
    backupLoad.resolve([
      { provider: "openai-compatible", modelId: "model-a", modelCredentialId: "connection-a" },
      { provider: "openai-compatible", modelId: "model-b", modelCredentialId: "connection-a" },
    ]),
  );
  await act(async () =>
    button("Move Server · https://models.example.test/v1 · model-a down").click(),
  );
  await act(async () => button("Save backups").click());
  expect(state.rpc.mock.calls.find(([name]) => name === "models/setBackups")?.[1]).toEqual([
    {
      provider: "openai-compatible",
      modelId: "model-b",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
    {
      provider: "openai-compatible",
      modelId: "model-a",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
  ]);
});

it("updates an open backup picker only from its own connection save receipt", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const saving = deferred<typeof credential>();
  let revision = 7;
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "models/credentials")
      return [{ ...credential, connectionRevision: revision }];
    if (procedure === "models/connect") return saving.promise;
    if (procedure === "models/setBackups") return input;
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  await act(async () => button("Save").click());
  await act(async () => button("Add connected model").click());
  const menu = vi.mocked(presentMessageActionSheet).mock.lastCall?.[0];
  if (!menu) throw new Error("Missing backup model picker");
  const choice = menu.actions.find((action) => action.text.endsWith(" · model-b"));
  if (!choice) throw new Error("Missing model-b option");
  revision = 9;
  await act(async () => saving.resolve({ ...credential, connectionRevision: revision }));
  await act(async () => choice.onPress());
  await act(async () => button("Save backups").click());
  expect(state.rpc.mock.calls.find(([name]) => name === "models/setBackups")?.[1]).toEqual([
    {
      provider: "openai-compatible",
      modelId: "model-b",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
  ]);
});

it.each(["space", "session", "api"] as const)(
  "ignores a captured backup picker after its %s owner changes",
  async (owner) => {
    await act(async () => root.render(<Models />));
    await act(async () => button("Add connected model").click());
    const menu = vi.mocked(presentMessageActionSheet).mock.lastCall?.[0];
    if (!menu) throw new Error("Missing backup model picker");
    if (owner === "space") state.spaceGeneration += 2;
    else if (owner === "session") state.sessionGeneration += 2;
    else state.apiBase = "https://replacement.example.test";
    await act(async () => menu.actions[0]!.onPress());
    expect(button("Save backups").disabled).toBe(true);
    expect(container.textContent).not.toContain("1. Server");
  },
);

it("shows a historical Routine without loading model credentials or exposing writes", async () => {
  state.params.readOnly = "1";
  state.params.origin = "profile";
  await act(async () => root.render(<RoutineDetail />));
  expect(container.textContent).toContain("Review");
  expect(container.textContent).not.toContain("Open conversation");
  expect(container.textContent).not.toContain("Pause");
  expect(container.querySelector('select[aria-label="Model"]')).toBeNull();
  expect(
    state.rpc.mock.calls.some(
      ([procedure]) =>
        procedure === "models/list" ||
        procedure === "models/credentials" ||
        procedure === "routines/update",
    ),
  ).toBe(false);
});

it("saves a repeat's first run through the mobile Routine editor, then pauses without reposting it", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const original = (await normal("routines/list"))[0];
  const nextRunAt = new Date(Date.now() + 6 * 86_400_000).toISOString();
  const routine = { ...original, crons: ["0 9 * * *"], timezone: "Asia/Taipei", nextRunAt };
  state.rpc.mockImplementation(async (procedure: string, input: Record<string, unknown>) => {
    if (procedure === "routines/list") return [routine];
    if (procedure === "routines/update") {
      return { ...routine, ...input, nextRunAt: input.active === false ? null : nextRunAt };
    }
    return normal(procedure, input);
  });
  await act(async () => root.render(<RoutineDetail />));
  expect(container.textContent).toContain("Next run:");
  await act(async () => button("Edit schedule").click());
  await act(async () => button("Set first run").click());
  await act(async () => button("Select first date").click());
  await act(async () => button("Save").click());
  const updates = () =>
    state.rpc.mock.calls.filter(([procedure]) => procedure === "routines/update");
  expect(updates()[0]?.[1]).toEqual({
    routineId: "routine-1",
    startAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/),
  });
  await act(async () => button("Edit schedule").click());
  await act(async () => button("Select time of day").click());
  await act(async () => button("Save").click());
  expect(updates()[1]?.[1]).toEqual({
    routineId: "routine-1",
    crons: ["17 9 * * *"],
    intervalBased: false,
  });
  await act(async () => button("Pause").click());
  expect(updates()[2]?.[1]).toEqual({ routineId: "routine-1", active: false });
  expect(container.textContent).not.toContain("Next run:");
  expect(button("Resume")).toBeTruthy();
});

it("keeps the submitted timing draft while a save is waiting for its receipt", async () => {
  const pending = deferred<unknown>();
  const normal = state.rpc.getMockImplementation()!;
  const original = (await normal("routines/list"))[0];
  const routine = { ...original, crons: ["0 9 * * *"], timezone: "UTC" };
  const writes: unknown[] = [];
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "routines/list") return [routine];
    if (procedure !== "routines/update") return normal(procedure, input);
    writes.push(input);
    return writes.length === 1 ? pending.promise : { ...routine, ...(input as object) };
  });
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Edit schedule").click());
  await act(async () => button("Set first run").click());
  await act(async () => button("Save").click());
  expect(button("Use next occurrence").disabled).toBe(true);
  await act(async () => button("Select first date").click());
  await act(async () => pending.reject(new Error("Fixture save failed")));
  await act(async () => button("Save").click());
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

it("preserves the selected first run after concurrent timezone and cadence changes", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const original = (await normal("routines/list"))[0];
  const routine = {
    ...original,
    crons: ["0 9 * * *"],
    timezone: "UTC",
    startAt: "2027-11-06T06:30:00.000Z",
  };
  state.rpc.mockImplementation(async (procedure: string, input: Record<string, unknown>) => {
    if (procedure === "routines/list") return [routine];
    if (procedure === "routines/update")
      return { ...routine, ...input, timezone: "America/New_York", crons: ["0 10 * * *"] };
    return normal(procedure, input);
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-11-06T00:00:00Z"));
  try {
    await act(async () => root.render(<RoutineDetail />));
    await act(async () => button("Edit schedule").click());
    await act(async () => button("Select first date").click());
    const selected = "2027-11-07T06:30:00.000Z";
    expect(button("Select first date").getAttribute("data-value")).toBe(selected);
    await chooseRoutineModel("model-b");
    await act(async () => button("Save model").click());
    expect(button("Select first date").getAttribute("data-value")).toBe(selected);
    await act(async () => button("Save").click());
    const updates = state.rpc.mock.calls.filter(([procedure]) => procedure === "routines/update");
    expect(updates[1]?.[1]).toEqual({ routineId: "routine-1", startAt: selected });
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the verified Routine Space when the server default changes before Save", async () => {
  state.spaceId = null;
  const normal = state.rpc.getMockImplementation()!;
  let defaultSpace = "space-1";
  state.rpc.mockImplementation(async (p: string, input: unknown) => {
    if (p === "me") return { spaceId: defaultSpace };
    if (p === "routines/update")
      return { ...(await normal("routines/list"))[0], ...(input as object) };
    return normal(p, input);
  });
  await act(async () => root.render(<RoutineDetail />));
  defaultSpace = "space-2";
  await chooseRoutineModel("model-b");
  await act(async () => button("Save model").click());
  const update = state.rpc.mock.calls.find(([p]) => p === "routines/update");
  expect(update?.[2]?.requestContext.headers["x-rakazo-space-id"]).toBe("space-1");
  expect(state.rpc.mock.calls.filter(([p]) => p === "me")).toHaveLength(1);
  expect(state.spaceId).toBeNull();
});

it("retains a pending write gate and fences a previous editable handler when the same Routine becomes readonly", async () => {
  const saving = deferred<unknown>();
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((p: string, input: unknown) =>
    p === "routines/update" ? saving.promise : normal(p, input),
  );
  await act(async () => root.render(<RoutineDetail />));
  await chooseRoutineModel("model-b");
  await act(async () => button("Save model").click());
  state.params = { ...state.params, readOnly: "1", origin: "profile" };
  await act(async () => root.render(<RoutineDetail />));
  await act(async () =>
    saving.resolve({ ...(await normal("routines/list"))[0], prompt: "Old saved prompt" }),
  );
  expect(container.textContent).toContain("Review");
  expect(container.textContent).not.toContain("Old saved prompt");
  expect(container.textContent).not.toContain("Save model");
  expect(state.rpc.mock.calls.filter(([p]) => p === "routines/update")).toHaveLength(1);
});

it("keeps an already dispatched backup write locked while acknowledging a connection save", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const saving = deferred<unknown>();
  let revision = 7;
  let writes = 0;
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "models/credentials")
      return [{ ...credential, connectionRevision: revision }];
    if (procedure === "models/backups")
      return [
        { provider: "openai-compatible", modelId: "model-a", modelCredentialId: "connection-a" },
        { provider: "openai-compatible", modelId: "model-b", modelCredentialId: "connection-a" },
      ];
    if (procedure === "models/connect") {
      revision = 9;
      return { ...credential, connectionRevision: revision };
    }
    if (procedure === "models/setBackups") return ++writes === 1 ? saving.promise : input;
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  await act(async () =>
    button("Move Server · https://models.example.test/v1 · model-a down").click(),
  );
  await act(async () => button("Save backups").click());
  const first = state.rpc.mock.calls.find(([name]) => name === "models/setBackups")?.[1];
  await act(async () => button("Save").click());
  expect(button("Save backups").disabled).toBe(true);
  expect(first).toEqual([
    {
      provider: "openai-compatible",
      modelId: "model-b",
      modelCredentialId: "connection-a",
      expectedRevision: 7,
    },
    {
      provider: "openai-compatible",
      modelId: "model-a",
      modelCredentialId: "connection-a",
      expectedRevision: 7,
    },
  ]);
  expect(writes).toBe(1);
  await act(async () => saving.resolve(first));
  await act(async () =>
    button("Move Server · https://models.example.test/v1 · model-b down").click(),
  );
  await act(async () => button("Save backups").click());
  expect(state.rpc.mock.calls.filter(([name]) => name === "models/setBackups")[1]?.[1]).toEqual([
    {
      provider: "openai-compatible",
      modelId: "model-a",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
    {
      provider: "openai-compatible",
      modelId: "model-b",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
  ]);
});

it("retains a staged unavailable backup and its captured revision after a connection save", async () => {
  const normal = state.rpc.getMockImplementation()!;
  let saved = false;
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    const connection = saved
      ? { ...credential, enabledModelIds: ["model-a"], connectionRevision: 9 }
      : credential;
    if (procedure === "models/credentials") return [connection];
    if (procedure === "models/backups")
      return [
        { provider: "openai-compatible", modelId: "model-a", modelCredentialId: "connection-a" },
      ];
    if (procedure === "models/connect") {
      saved = true;
      return { ...credential, enabledModelIds: ["model-a"], connectionRevision: 9 };
    }
    if (procedure === "models/setBackups") return input;
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  await act(async () => button("Add connected model").click());
  const menu = vi.mocked(presentMessageActionSheet).mock.lastCall?.[0];
  if (!menu) throw new Error("Missing backup model picker");
  await act(async () => menu.actions[0]!.onPress());
  const enabledModel = container.querySelector<HTMLInputElement>('input[aria-label="model-b"]');
  if (!enabledModel) throw new Error("Missing enabled model switch");
  await act(async () => enabledModel.click());
  await act(async () => button("Save").click());
  expect(container.textContent).toContain("Not connected");
  await act(async () => button("Save backups").click());
  expect(state.rpc.mock.calls.find(([name]) => name === "models/setBackups")?.[1]).toEqual([
    {
      provider: "openai-compatible",
      modelId: "model-a",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
    {
      provider: "openai-compatible",
      modelId: "model-b",
      modelCredentialId: "connection-a",
      expectedRevision: 7,
    },
  ]);
});

it("reconciles backups after this screen renews a subscription connection", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const entry = {
    provider: "subscription",
    providerName: "Subscription",
    id: "model-a",
    label: "Model A",
    billing: "",
    auth: "oauth",
    signIn: "device-code",
  };
  const connection = {
    ...credential,
    provider: "subscription",
    label: "Subscription",
    baseUrl: undefined,
  };
  let revision = 7;
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "me")
      return {
        userId: "user-1",
        spaceId: "space-1",
        defaultProvider: "subscription",
        defaultModel: "model-a",
      };
    if (procedure === "models/list") return [entry, { ...entry, id: "model-b", label: "Model B" }];
    if (procedure === "models/credentials")
      return [{ ...connection, connectionRevision: revision }];
    if (procedure === "models/backups")
      return [
        { provider: "subscription", modelId: "model-a", modelCredentialId: "connection-a" },
        { provider: "subscription", modelId: "model-b", modelCredentialId: "connection-a" },
      ];
    if (procedure === "models/beginOAuth")
      return {
        loginId: "login-a",
        mode: "device-code",
        verificationUri: "https://auth.example.test",
        userCode: "CODE",
        expiresInSeconds: 600,
      };
    if (procedure === "models/completeOAuth") return { status: "ready" };
    if (procedure === "models/finishOAuth") {
      revision = 9;
      return { ...connection, connectionRevision: revision };
    }
    if (procedure === "models/setBackups") return input;
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  await act(async () => button("Move Subscription · Model A down").click());
  await act(async () => button("Sign in again").click());
  await act(async () => button("Save backups").click());
  expect(state.rpc.mock.calls.find(([name]) => name === "models/setBackups")?.[1]).toEqual([
    {
      provider: "subscription",
      modelId: "model-b",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
    {
      provider: "subscription",
      modelId: "model-a",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
  ]);
});

it("keeps a newer revision captured by an explicit backup retry", async () => {
  const normal = state.rpc.getMockImplementation()!;
  let revision = 7;
  let retry = false;
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "models/credentials")
      return [{ ...credential, connectionRevision: revision }];
    if (procedure === "models/backups") {
      if (!retry) throw new Error("Backup service unavailable");
      return [
        { provider: "openai-compatible", modelId: "model-a", modelCredentialId: "connection-a" },
        { provider: "openai-compatible", modelId: "model-b", modelCredentialId: "connection-a" },
      ];
    }
    if (procedure === "models/connect") {
      revision = 8;
      return { ...credential, connectionRevision: revision };
    }
    if (procedure === "models/setDefault") {
      revision = 9;
      return undefined;
    }
    if (procedure === "models/setBackups") return input;
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  await act(async () => button("Save").click());
  await act(async () => button("model-b").click());
  await act(async () => button("Use this model").click());
  retry = true;
  await act(async () => button("Retry").click());
  await act(async () =>
    button("Move Server · https://models.example.test/v1 · model-a down").click(),
  );
  await act(async () => button("Save backups").click());
  expect(state.rpc.mock.calls.find(([name]) => name === "models/setBackups")?.[1]).toEqual([
    {
      provider: "openai-compatible",
      modelId: "model-b",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
    {
      provider: "openai-compatible",
      modelId: "model-a",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
  ]);
});

it("discards acknowledged backup revisions when another server becomes the owner", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const other = {
    ...credential,
    id: "connection-b",
    label: "Other",
    isDefault: false,
    connectionRevision: 5,
  };
  let savedFirst = false;
  let retry = false;
  state.rpc.mockImplementation(async (procedure: string, input: { credentialId?: string }) => {
    const replacement = state.apiBase === "https://replacement.example.test";
    if (procedure === "models/credentials")
      return [
        { ...credential, connectionRevision: replacement ? 3 : savedFirst ? 8 : 7 },
        { ...other, connectionRevision: replacement ? 6 : 5 },
      ];
    if (procedure === "models/backups") {
      if (!retry) throw new Error("Backup service unavailable");
      return [
        { provider: "openai-compatible", modelId: "model-a", modelCredentialId: "connection-a" },
        { provider: "openai-compatible", modelId: "model-b", modelCredentialId: "connection-a" },
      ];
    }
    if (procedure === "models/connect") {
      savedFirst = true;
      return input.credentialId === "connection-a"
        ? { ...credential, connectionRevision: 8 }
        : { ...other, connectionRevision: 6 };
    }
    if (procedure === "models/setBackups") return input;
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  await act(async () => button("Save").click());
  state.apiBase = "https://replacement.example.test";
  const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Connection"]');
  if (!picker) throw new Error("Missing connection picker");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
      picker,
      "connection-b",
    );
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Save").click());
  retry = true;
  await act(async () => button("Retry").click());
  await act(async () =>
    button("Move Server · https://models.example.test/v1 · model-a down").click(),
  );
  await act(async () => button("Save backups").click());
  expect(state.rpc.mock.calls.find(([name]) => name === "models/setBackups")?.[1]).toEqual([
    {
      provider: "openai-compatible",
      modelId: "model-b",
      modelCredentialId: "connection-a",
      expectedRevision: 3,
    },
    {
      provider: "openai-compatible",
      modelId: "model-a",
      modelCredentialId: "connection-a",
      expectedRevision: 3,
    },
  ]);
});

it.each(["space", "session"] as const)(
  "still ignores refocus metadata from an earlier %s epoch",
  async (scope) => {
    await act(async () => root.render(<Models />));
    const gate = deferred<Array<typeof credential>>();
    state.rpc
      .mockImplementationOnce(async () => ({
        userId: "user-1",
        spaceId: "space-1",
        defaultProvider: "openai-compatible",
        defaultModel: "model-a",
      }))
      .mockImplementationOnce(async () => catalog)
      .mockImplementationOnce(() => gate.promise)
      .mockImplementationOnce(async () => ({ references: [] }));
    await refocus();
    await edit(baseUrl(), "https://draft.example.test/v1");
    if (scope === "space") state.spaceGeneration += 2;
    else state.sessionGeneration += 2;
    await act(async () => {
      gate.resolve([
        { ...credential, baseUrl: "https://late.example.test/v1", connectionRevision: 9 },
      ]);
      await gate.promise;
    });
    expect(baseUrl().value).toBe("https://draft.example.test/v1");
    expect(
      state.rpc.mock.calls.filter(([procedure]) => procedure === "models/backups"),
    ).toHaveLength(1);
    await refocus();
    expect(button("Add connected model").disabled).toBe(false);
    expect(
      state.rpc.mock.calls.filter(([procedure]) => procedure === "models/backups"),
    ).toHaveLength(2);
  },
);

it.each([
  { locale: "en", labels: ["Minimal", "Low", "Medium", "High", "Extra high", "Max"] },
  { locale: "zh-CN", labels: ["最低", "低", "中", "高", "超高", "最高"] },
  {
    locale: "ru",
    labels: ["Минимальный", "Низкий", "Средний", "Высокий", "Очень высокий", "Макс"],
  },
  { locale: "de", labels: ["Minimal", "Niedrig", "Mittel", "Hoch", "Sehr hoch", "Max."] },
] as const)(
  "uses translated Routine thinking labels and preserves level keys in $locale",
  async ({ locale, labels }) => {
    resetI18nForTests(locale);
    await act(async () => {
      root.render(<RoutineDetail />);
    });
    const thinking = [...container.querySelectorAll("select")].find((entry) =>
      [...entry.options].some((option) => option.value === "xhigh"),
    );
    expect(thinking).toBeDefined();
    expect(
      [...thinking!.options].slice(1).map((option) => [option.value, option.textContent]),
    ).toEqual(
      ["minimal", "low", "medium", "high", "xhigh", "max"].map((key, index) => [
        key,
        labels[index],
      ]),
    );
  },
);

it.each(["models/list", "models/credentials"])(
  "keeps the Routine available when %s fails and retries only model metadata",
  async (failedProcedure) => {
    const normal = state.rpc.getMockImplementation()!;
    let unavailable = true;
    state.rpc.mockImplementation(async (procedure: string, input: Record<string, unknown>) => {
      if (procedure === failedProcedure && unavailable)
        throw Object.assign(new Error("Model service unavailable"), { status: 503 });
      if (procedure === "routines/update")
        return { ...(await normal("routines/list"))[0], ...input };
      return normal(procedure, input);
    });
    await act(async () => root.render(<RoutineDetail />));
    expect(container.textContent).toContain("Review");
    expect(container.textContent).toContain("Model service unavailable");
    expect(container.textContent).not.toContain("Could not load routine");
    await act(async () => button("Open conversation").click());
    expect(state.push).toHaveBeenCalledWith({
      pathname: "/thread",
      params: { botId: "bot-1", name: "Bot" },
    });
    unavailable = false;
    await act(async () => button("Retry").click());
    expect(
      state.rpc.mock.calls.filter(([procedure]) => procedure === "routines/list"),
    ).toHaveLength(1);
    const model = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
    if (!model) throw new Error("Missing Routine model picker");
    expect(model.value).toBe(modelOptionKey("openai-compatible", "model-a", "connection-a"));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        model,
        modelOptionKey("openai-compatible", "model-b", "connection-a"),
      );
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Save model").click());
    expect(
      state.rpc.mock.calls.find(([procedure]) => procedure === "routines/update")?.[1],
    ).toMatchObject({
      routineId: "routine-1",
      modelProvider: "openai-compatible",
      modelId: "model-b",
      modelCredentialId: "connection-a",
      expectedRevision: 7,
    });
  },
);

it("edits an explicit Space without changing the selected Space", async () => {
  state.params = { spaceId: "space-2" };
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(
    async (
      procedure: string,
      input: unknown,
      options: { requestContext?: { headers: Record<string, string> } },
    ) => {
      if (procedure === "me") return { ...(await normal(procedure, input)), spaceId: "space-2" };
      return normal(procedure, input, options);
    },
  );
  await act(async () => root.render(<Models />));
  await act(async () => button("Save").click());
  expect(state.spaceId).toBe("space-1");
  expect(
    state.rpc.mock.calls.filter(([name]) => name.startsWith("models/")).length,
  ).toBeGreaterThan(3);
  for (const [name, , options] of state.rpc.mock.calls) {
    if (name.startsWith("models/"))
      expect(options?.requestContext?.headers["x-rakazo-space-id"]).toBe("space-2");
  }
  expect(state.rpc.mock.calls.some(([name]) => name === "models/connect")).toBe(true);
});

it("revokes the previous settings client before the new target's layout callbacks", async () => {
  let oldClient: ReturnType<typeof useSpaceSettings> | undefined;
  let rejected: Promise<unknown> | undefined;
  function Probe({ target }: { target: string }) {
    const client = useSpaceSettings(target);
    useLayoutEffect(() => {
      if (target === "space-2") oldClient = client;
      else rejected = expect(oldClient!.rpc("models/connect")).rejects.toThrow();
    }, [client, target]);
    return null;
  }
  await act(async () => root.render(<Probe key="space-2" target="space-2" />));
  await act(async () => root.render(<Probe key="space-3" target="space-3" />));
  await rejected;
  expect(state.rpc).not.toHaveBeenCalled();
});

it("opens existing settings from the verified target summary without selecting it", async () => {
  state.params = { spaceId: "space-2", name: "Team space" };
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (name: string, input: unknown) =>
    name === "me" ? { ...(await normal(name, input)), spaceId: "space-2" } : normal(name, input),
  );
  await act(async () => root.render(<SpaceSettings />));
  expect(container.textContent).toContain("Team space");
  await act(async () => button("Models").click());
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/models",
    params: { spaceId: "space-2", name: "Team space" },
  });
  await act(async () => button("Voice").click());
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/voice",
    params: { spaceId: "space-2", name: "Team space" },
  });
  expect(state.spaceId).toBe("space-1");
});

it("does not expose settings when target membership is denied", async () => {
  state.params = { spaceId: "space-2" };
  state.rpc.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
  await act(async () => root.render(<SpaceSettings />));
  expect(container.textContent).toContain("Unauthorized");
  expect(container.textContent).not.toContain("Models");
  expect(container.textContent).not.toContain("Voice");
  expect(state.rpc.mock.calls.every(([name]) => name === "me")).toBe(true);
});

it("clears model drafts and ignores metadata from a previous target", async () => {
  const oldCredentials = deferred<Array<typeof credential>>();
  const normal = state.rpc.getMockImplementation()!;
  state.params = { spaceId: "space-2" };
  state.rpc.mockImplementation(
    async (
      name: string,
      input: unknown,
      options: { requestContext?: { headers: Record<string, string> } },
    ) => {
      const target = options?.requestContext?.headers["x-rakazo-space-id"];
      if (name === "me") return { ...(await normal(name, input)), spaceId: target };
      if (name === "models/credentials" && target === "space-2") return oldCredentials.promise;
      if (name === "models/credentials")
        return [{ ...credential, baseUrl: "https://current.example.test/v1" }];
      return normal(name, input);
    },
  );
  await act(async () => root.render(<Models />));
  state.params = { spaceId: "space-3" };
  await act(async () => root.render(<Models />));
  expect(baseUrl().value).toBe("https://current.example.test/v1");
  await edit(baseUrl(), "https://draft.example.test/v1");
  await act(async () =>
    oldCredentials.resolve([{ ...credential, baseUrl: "https://old.example.test/v1" }]),
  );
  expect(baseUrl().value).toBe("https://draft.example.test/v1");
  expect(container.textContent).not.toContain("Something went wrong");
  expect(state.spaceId).toBe("space-1");
});

it("cancels a late model sign-in on the target that began it", async () => {
  const late = deferred<{
    loginId: string;
    mode: string;
    verificationUri: string;
    userCode: string;
    expiresInSeconds: number;
  }>();
  const normal = state.rpc.getMockImplementation()!;
  state.params = { spaceId: "space-2" };
  state.rpc.mockImplementation(
    async (
      name: string,
      input: unknown,
      options: { requestContext?: { headers: Record<string, string> } },
    ) => {
      if (name === "me")
        return {
          ...(await normal(name, input)),
          spaceId: options?.requestContext?.headers["x-rakazo-space-id"],
          defaultProvider: "subscription",
          defaultModel: "model-a",
        };
      if (name === "models/list")
        return [
          {
            provider: "subscription",
            providerName: "Subscription",
            id: "model-a",
            label: "Model A",
            billing: "",
            auth: "oauth",
            signIn: "device-code",
          },
        ];
      if (name === "models/credentials") return [];
      if (name === "models/beginOAuth") return late.promise;
      if (name === "models/cancelOAuth") return undefined;
      return normal(name, input);
    },
  );
  await act(async () => root.render(<Models />));
  await act(async () => button("Sign in").click());
  state.params = { spaceId: "space-3" };
  await act(async () => root.render(<Models />));
  await act(async () =>
    late.resolve({
      loginId: "old-b-login",
      mode: "device-code",
      verificationUri: "https://auth.example.test",
      userCode: "CODE",
      expiresInSeconds: 600,
    }),
  );
  const canceled = state.rpc.mock.calls.find(([name]) => name === "models/cancelOAuth");
  expect(canceled?.[1]).toEqual({ loginId: "old-b-login" });
  expect(canceled?.[2].requestContext.headers["x-rakazo-space-id"]).toBe("space-2");
  expect(state.rpc.mock.calls.some(([name]) => name === "models/finishOAuth")).toBe(false);
});

async function chooseRoutineModel(modelId: string) {
  const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
  if (!picker) throw new Error("Missing Routine model picker");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
      picker,
      modelOptionKey("openai-compatible", modelId, "connection-a"),
    );
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it.each(["resolves", "rejects"])(
  "keeps saves serialized when an old Routine save %s after A to B to A",
  async (outcome) => {
    const normal = state.rpc.getMockImplementation()!;
    const template = (await normal("routines/list"))[0];
    const oldSave = deferred<typeof template>();
    const newSave = deferred<typeof template>();
    let returned = false;
    let saves = 0;
    state.rpc.mockImplementation(async (procedure: string, input: Record<string, unknown>) => {
      if (procedure === "routines/list")
        return [
          {
            ...template,
            id: state.params.routineId,
            botId: state.params.botId,
            prompt:
              state.params.botId === "bot-2" ? "Current B" : returned ? "Current A" : "Original A",
          },
        ];
      if (procedure === "models/credentials" && returned)
        return [{ ...credential, connectionRevision: 9 }];
      if (procedure === "routines/update") return ++saves === 1 ? oldSave.promise : newSave.promise;
      return normal(procedure, input);
    });
    await act(async () => root.render(<RoutineDetail />));
    await chooseRoutineModel("model-b");
    await act(async () => button("Save model").click());
    state.params = { botId: "bot-2", routineId: "routine-2" };
    await act(async () => root.render(<RoutineDetail />));
    returned = true;
    state.params = { botId: "bot-1", routineId: "routine-1" };
    await act(async () => root.render(<RoutineDetail />));
    expect(button("Saving…").disabled).toBe(true);
    expect(
      state.rpc.mock.calls.filter(([procedure]) => procedure === "routines/update"),
    ).toHaveLength(1);
    await act(async () => {
      if (outcome === "resolves")
        oldSave.resolve({ ...template, prompt: "Old A saved", modelId: "model-b" });
      else oldSave.reject(new Error("Old A failed"));
    });
    expect(container.textContent).toContain("Current A");
    expect(container.textContent).not.toContain("Old A saved");
    expect(container.textContent).not.toContain("Old A failed");
    await chooseRoutineModel("model-b");
    await act(async () => button("Save model").click());
    expect(
      state.rpc.mock.calls.filter(([procedure]) => procedure === "routines/update")[1]?.[1],
    ).toMatchObject({
      routineId: "routine-1",
      modelCredentialId: "connection-a",
      modelId: "model-b",
      expectedRevision: 9,
    });
    expect(button("Saving…").disabled).toBe(true);
    await act(async () =>
      newSave.resolve({ ...template, prompt: "Current A saved", modelId: "model-b" }),
    );
    expect(container.textContent).toContain("Current A saved");
  },
);

it.each(["models/list", "models/credentials"])(
  "preserves a new Routine model draft when an old %s retry fails late",
  async (procedure) => {
    const normal = state.rpc.getMockImplementation()!;
    const template = (await normal("routines/list"))[0];
    const retry = deferred<unknown[]>();
    let metadataRequests = 0;
    state.rpc.mockImplementation(async (name: string, input: Record<string, unknown>) => {
      if (name === procedure && state.params.botId === "bot-1") {
        if (++metadataRequests === 1) throw new Error("First metadata failure");
        return retry.promise;
      }
      if (name === "routines/list")
        return [
          {
            ...template,
            id: state.params.routineId,
            botId: state.params.botId,
            prompt: "Current routine",
          },
        ];
      if (name === "routines/update") return { ...template, ...input };
      return normal(name, input);
    });
    await act(async () => root.render(<RoutineDetail />));
    await act(async () => button("Retry").click());
    expect(button("Open conversation").disabled).toBe(false);
    state.params = { botId: "bot-2", routineId: "routine-2" };
    await act(async () => root.render(<RoutineDetail />));
    await chooseRoutineModel("model-b");
    await act(async () => retry.reject(new Error("Old metadata failed")));
    expect(container.textContent).toContain("Current routine");
    expect(container.textContent).not.toContain("Old metadata failed");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.value).toBe(
      modelOptionKey("openai-compatible", "model-b", "connection-a"),
    );
    await act(async () => button("Save model").click());
    expect(state.rpc.mock.calls.find(([name]) => name === "routines/update")?.[1]).toMatchObject({
      routineId: "routine-2",
      modelId: "model-b",
      modelCredentialId: "connection-a",
      expectedRevision: 7,
    });
  },
);

it.each(["space", "session", "api"] as const)(
  "ignores late optional model failure after the %s owner changes",
  async (owner) => {
    const normal = state.rpc.getMockImplementation()!;
    const metadata = deferred<unknown[]>();
    state.rpc.mockImplementation((procedure: string, input: unknown) =>
      procedure === "models/credentials" ? metadata.promise : normal(procedure, input),
    );
    await act(async () => root.render(<RoutineDetail />));
    expect(container.textContent).toContain("Review");
    if (owner === "space") state.spaceGeneration += 2;
    else if (owner === "session") state.sessionGeneration += 2;
    else state.apiBase = "https://replacement.example.test";
    await act(async () => metadata.reject(new Error("Old owner metadata failed")));
    expect(container.textContent).not.toContain("Old owner metadata failed");
    await act(async () => button("Open conversation").click());
    expect(state.push).not.toHaveBeenCalled();
  },
);

it("sends the native protocol choice and preserves entered header drafts after a conflict", async () => {
  await act(async () => root.render(<Models />));
  await act(async () => button("API protocol").click());
  const menu = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)?.[0];
  await act(async () =>
    menu?.actions.find((entry) => entry.text === "Anthropic Messages")?.onPress(),
  );
  expect(button("API protocol").textContent).toContain("Anthropic Messages");
  await act(async () => button("Custom headers").click());
  await act(async () => button("Add header").click());
  const header = (name: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
  await edit(header("Header name"), "X-Team");
  await edit(header("Header value"), "en");
  expect(header("Header value").type).toBe("password");
  await act(async () => button("Save").click());
  expect(
    state.rpc.mock.calls.find(([procedure]) => procedure === "models/connect")?.[1],
  ).toMatchObject({
    apiProtocol: "anthropic-messages",
    headers: { "X-Team": "en" },
    credentialId: "connection-a",
    expectedRevision: 7,
  });
  expect(header("Header value").value).toBe("en");
  expect(button("API protocol").textContent).toContain("Anthropic Messages");
  await act(async () => button("Save").click());
  expect(
    state.rpc.mock.calls
      .filter(([procedure]) => procedure === "models/connect")
      .map(([, input]) => input.expectedRevision),
  ).toEqual([7, 7]);
});

it("does not apply a queued native protocol callback while saving", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const saved = deferred<typeof credential>();
  state.rpc.mockImplementation((procedure: string, input: unknown) =>
    procedure === "models/connect" ? saved.promise : normal(procedure, input),
  );
  await act(async () => root.render(<Models />));
  await act(async () => button("API protocol").click());
  const action = vi
    .mocked(presentMessageActionSheet)
    .mock.calls.at(-1)?.[0]
    .actions.find((entry) => entry.text === "Responses");
  await act(async () => {
    button("Save").click();
  });
  expect(button("API protocol").disabled).toBe(true);
  await act(async () => action?.onPress());
  expect(button("API protocol").textContent).toContain("Chat Completions");
  await act(async () => {
    saved.resolve(credential);
    await saved.promise;
  });
});

it("does not silently select a default for an unknown stored native protocol", async () => {
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((procedure: string, input: unknown) =>
    procedure === "models/credentials"
      ? Promise.resolve([{ ...credential, apiProtocol: "future-protocol" }])
      : normal(procedure, input),
  );
  await act(async () => root.render(<Models />));
  expect(button("API protocol").textContent).toContain("Choose a protocol");
  expect(button("Save").disabled).toBe(true);
  expect(state.rpc.mock.calls.some(([procedure]) => procedure === "models/connect")).toBe(false);
});

it("keeps saved native header values absent and sends an explicit empty map to clear them", async () => {
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((procedure: string, input: unknown) =>
    procedure === "models/credentials"
      ? Promise.resolve([{ ...credential, apiProtocol: "responses", headerNames: ["X-Saved"] }])
      : normal(procedure, input),
  );
  await act(async () => root.render(<Models />));
  await act(async () => button("Custom headers").click());
  const value = container.querySelector<HTMLInputElement>('input[aria-label="Header value"]')!;
  expect(value.value).toBe("");
  expect(value.type).toBe("password");
  await act(async () => button("Save").click());
  expect(
    state.rpc.mock.calls.find(([procedure]) => procedure === "models/connect")?.[1].headers,
  ).toBeUndefined();
  await act(async () => button("Remove header").click());
  await act(async () => button("Save").click());
  expect(
    state.rpc.mock.calls.filter(([procedure]) => procedure === "models/connect").at(-1)?.[1],
  ).toMatchObject({
    apiProtocol: "responses",
    headers: {},
    credentialId: "connection-a",
    expectedRevision: 7,
  });
});

it.each(["https://models.example.test/v1", "https://models.example.test/"])(
  "restores untouched saved headers after returning from another native endpoint to %s",
  async (savedAlias) => {
    const normal = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((procedure: string, input: unknown) => {
      if (procedure === "models/credentials")
        return Promise.resolve([{ ...credential, headerNames: ["X-Saved"] }]);
      if (procedure === "models/probeOpenAiCompatible") return Promise.resolve({ models: [] });
      return normal(procedure, input);
    });
    await act(async () => root.render(<Models />));
    await act(async () => button("Custom headers").click());
    await edit(baseUrl(), "https://models.example.test/v1x");
    expect(container.querySelector('input[aria-label="Header name"]')).toBeNull();
    await act(async () => button("Find models").click());
    const probe = state.rpc.mock.calls
      .filter(([procedure]) => procedure === "models/probeOpenAiCompatible")
      .at(-1)?.[1];
    expect(probe.headers).toEqual({});
    expect(probe).not.toHaveProperty("credentialId");
    await edit(baseUrl(), savedAlias);
    await act(async () => button("Save").click());
    const saved = state.rpc.mock.calls
      .filter(([procedure]) => procedure === "models/connect")
      .at(-1)?.[1];
    expect(saved).toMatchObject({
      credentialId: "connection-a",
      expectedRevision: 7,
      baseUrl: savedAlias,
    });
    expect(saved.headers).toBeUndefined();
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Header name"]')?.value,
    ).toBe("X-Saved");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Header value"]')?.value,
    ).toBe("");
  },
);

it("keeps an explicit native saved-header clear when editing only a cosmetic endpoint alias", async () => {
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((procedure: string, input: unknown) =>
    procedure === "models/credentials"
      ? Promise.resolve([{ ...credential, headerNames: ["X-Saved"] }])
      : normal(procedure, input),
  );
  await act(async () => root.render(<Models />));
  await act(async () => button("Custom headers").click());
  await act(async () => button("Remove header").click());
  await edit(baseUrl(), "https://models.example.test/");
  await act(async () => button("Save").click());
  expect(
    state.rpc.mock.calls.filter(([procedure]) => procedure === "models/connect").at(-1)?.[1]
      .headers,
  ).toEqual({});
});

it("shows all native compatible rows for an empty search and preserves hidden enabled choices", async () => {
  const ids = ["model-a", "model-b", ...Array.from({ length: 9 }, (_, index) => `extra-${index}`)];
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((procedure: string, input: unknown) =>
    procedure === "models/credentials"
      ? Promise.resolve([{ ...credential, enabledModelIds: ids }])
      : normal(procedure, input),
  );
  await act(async () => root.render(<Models />));
  const checks = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(checks()).toHaveLength(11);
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
  await edit(search, "extra-8");
  expect(checks()).toHaveLength(1);
  expect(checks()[0]?.checked).toBe(true);
  await edit(search, "   ");
  expect(checks()).toHaveLength(11);
  await edit(search, "extra-8");
  await act(async () => checks()[0]?.click());
  await act(async () => button("Save").click());
  expect(
    state.rpc.mock.calls.filter(([procedure]) => procedure === "models/connect").at(-1)?.[1],
  ).toMatchObject({
    credentialId: "connection-a",
    expectedRevision: 7,
    modelId: "model-a",
    enabledModelIds: ids.filter((id) => id !== "model-a" && id !== "extra-8"),
  });
});

it("shows and selects a legacy Azure connection through the catalog alias while saving its original identity", async () => {
  const legacy = {
    id: "azure-legacy",
    provider: "azure-openai-responses",
    label: "Old Azure",
    hasKey: true,
    isDefault: true,
    modelId: "azure-model",
    connectionRevision: 7,
  };
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((procedure: string, input: unknown) => {
    if (procedure === "me")
      return Promise.resolve({
        userId: "user-1",
        spaceId: "space-1",
        defaultProvider: legacy.provider,
        defaultModel: legacy.modelId,
      });
    if (procedure === "models/list")
      return Promise.resolve([
        {
          provider: "azure",
          providerName: "Azure",
          id: "azure-model",
          label: "Azure model",
          auth: "api-key",
          billing: "API",
        },
      ]);
    if (procedure === "models/credentials") return Promise.resolve([legacy]);
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  const providerRow = button("AzureAzure model");
  expect(providerRow.previousElementSibling?.textContent).toBe("Connected");
  expect(providerRow.getAttribute("aria-pressed")).toBe("true");
  await act(async () => providerRow.click());
  expect(providerRow.getAttribute("aria-pressed")).toBe("true");
  const key = container.querySelector<HTMLInputElement>('input[aria-label="API key"]')!;
  await edit(key, "synthetic-azure-replacement");
  await act(async () => button("Replace API key").click());
  expect(
    state.rpc.mock.calls.filter(([procedure]) => procedure === "models/connect").at(-1)?.[1],
  ).toMatchObject({
    provider: legacy.provider,
    credentialId: legacy.id,
    expectedRevision: 7,
    modelId: "azure-model",
  });
});

function modelSettingsPanel() {
  const panel = container.querySelector<HTMLElement>('[data-testid="model-settings-panel"]');
  if (!panel) throw new Error("Missing model settings panel");
  return panel;
}
function modelSettingsButton(label: string) {
  const found = [...modelSettingsPanel().querySelectorAll("button")].find(
    (entry) => entry.textContent === label || entry.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing model settings action: ${label}`);
  return found;
}
function modelSettingsOutput() {
  const field = modelSettingsPanel().querySelector<HTMLInputElement>(
    'input[aria-label="Maximum output tokens"]',
  );
  if (!field) throw new Error("Missing model output field");
  return field;
}

it("keeps reordered backup drafts current after saving model settings", async () => {
  const normal = state.rpc.getMockImplementation()!;
  let revision = 7;
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "models/credentials")
      return [
        { ...credential, connectionRevision: revision },
        {
          ...credential,
          id: "connection-b",
          label: "Other",
          isDefault: false,
          connectionRevision: revision === 7 ? 3 : 11,
        },
      ];
    if (procedure === "models/backups")
      return [
        { provider: "openai-compatible", modelId: "model-a", modelCredentialId: "connection-a" },
        { provider: "openai-compatible", modelId: "model-b", modelCredentialId: "connection-a" },
        { provider: "openai-compatible", modelId: "model-a", modelCredentialId: "connection-b" },
      ];
    if (procedure === "models/saveModelSettings") {
      revision = 9;
      return { ok: true };
    }
    if (procedure === "models/setBackups") return input;
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  await act(async () =>
    button("Move Server · https://models.example.test/v1 · model-a down").click(),
  );
  await act(async () => modelSettingsButton("Advanced").click());
  await edit(modelSettingsOutput(), "2048");
  await act(async () => modelSettingsButton("Save").click());
  expect(modelSettingsPanel().textContent).toContain("Saved.");
  await act(async () => button("Save backups").click());
  expect(state.rpc.mock.calls.find(([name]) => name === "models/setBackups")?.[1]).toEqual([
    {
      provider: "openai-compatible",
      modelId: "model-b",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
    {
      provider: "openai-compatible",
      modelId: "model-a",
      modelCredentialId: "connection-a",
      expectedRevision: 9,
    },
    {
      provider: "openai-compatible",
      modelId: "model-a",
      modelCredentialId: "connection-b",
      expectedRevision: 3,
    },
  ]);
  expect(state.rpc.mock.calls.filter(([name]) => name === "models/backups")).toHaveLength(1);
});

it.each(["save", "reset"] as const)(
  "keeps the native non-default compatible model selected after settings %s",
  async (action) => {
    const normal = state.rpc.getMockImplementation()!;
    let saved: Record<string, Record<string, unknown>> = {
      "model-a": { maxTokens: 1024 },
      "model-b": { maxTokens: 512 },
    };
    state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
      if (procedure === "models/credentials") return [{ ...credential, modelSettings: saved }];
      if (procedure === "models/saveModelSettings") {
        const request = input as { modelId: string; settings: Record<string, unknown> };
        saved = { ...saved, [request.modelId]: request.settings };
        return { ok: true };
      }
      return normal(procedure, input);
    });
    await act(async () => root.render(<Models />));
    await act(async () => button("model-b").click());
    await act(async () => modelSettingsButton("Advanced").click());
    expect(modelSettingsOutput().value).toBe("512");
    if (action === "save") await edit(modelSettingsOutput(), "2048");
    await act(async () =>
      modelSettingsButton(action === "save" ? "Save" : "Reset to defaults").click(),
    );
    expect(button("model-b").getAttribute("aria-pressed")).toBe("true");
    expect(modelSettingsOutput().value).toBe(action === "save" ? "2048" : "");
    expect(modelSettingsPanel().textContent).toContain("Saved.");
    expect(saved["model-a"]).toEqual({ maxTokens: 1024 });
    expect(credential.modelId).toBe("model-a");
    expect(state.rpc.mock.calls.filter(([name]) => name === "models/connect")).toHaveLength(0);
    expect(state.rpc.mock.calls.filter(([name]) => name === "models/setDefault")).toHaveLength(0);
  },
);

it("keeps native per-model drafts on failure, reloads saved values, and resets only that model", async () => {
  const normal = state.rpc.getMockImplementation()!;
  let saved: Record<string, Record<string, unknown>> = { "model-b": { maxTokens: 512 } };
  let fail = true;
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "models/credentials")
      return [{ ...credential, modelSettings: saved, thinkingLevel: "low" }];
    if (procedure === "models/saveModelSettings") {
      if (fail) throw new Error("Synthetic settings failure");
      const request = input as { modelId: string; settings: Record<string, unknown> };
      saved = { ...saved, [request.modelId]: request.settings };
      return { ok: true };
    }
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  expect(modelSettingsPanel().textContent).toContain("Default");
  expect(modelSettingsPanel().querySelector("input")).toBeNull();
  await act(async () => modelSettingsButton("Advanced").click());
  await edit(
    modelSettingsPanel().querySelector<HTMLInputElement>('input[aria-label="Context limit"]')!,
    "64000",
  );
  await edit(modelSettingsOutput(), "2048");
  await act(async () => modelSettingsButton("Save").click());
  expect(modelSettingsPanel().textContent).toContain("Synthetic settings failure");
  expect(modelSettingsOutput().value).toBe("2048");
  fail = false;
  await act(async () => modelSettingsButton("Save").click());
  expect(modelSettingsPanel().textContent).toContain("Saved.");
  expect(modelSettingsOutput().value).toBe("2048");
  expect(modelSettingsPanel().textContent).toContain("Adjusted");
  const save = state.rpc.mock.calls.filter(([name]) => name === "models/saveModelSettings").at(-1);
  expect(save?.[1]).toMatchObject({
    credentialId: "connection-a",
    modelId: "model-a",
    settings: { contextWindow: 64000, maxTokens: 2048 },
  });
  expect(save?.[2]).toMatchObject({ requestContext: { spaceId: "space-1", sessionGeneration: 0 } });
  await act(async () => modelSettingsButton("Reset to defaults").click());
  expect(saved).toEqual({ "model-a": {}, "model-b": { maxTokens: 512 } });
  expect(modelSettingsOutput().value).toBe("");
  expect(state.rpc.mock.calls.filter(([name]) => name === "models/connect")).toHaveLength(0);
});

it("keeps the native draft when saved settings cannot be read back", async () => {
  const normal = state.rpc.getMockImplementation()!;
  let saved = false;
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "models/saveModelSettings") {
      saved = true;
      return { ok: true };
    }
    if (procedure === "models/credentials" && saved)
      throw new Error("Synthetic settings read failure");
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  await act(async () => modelSettingsButton("Advanced").click());
  await edit(modelSettingsOutput(), "2048");
  await act(async () => modelSettingsButton("Save").click());
  expect(modelSettingsPanel().textContent).not.toContain("Saved.");
  expect(modelSettingsOutput().value).toBe("2048");
  expect(container.textContent).toContain("Synthetic settings read failure");
});

function useCatalogConnection() {
  const normal = state.rpc.getMockImplementation()!;
  const connection = { ...credential, provider: "anthropic", maxTokens: 1024 };
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "me")
      return {
        userId: "user-1",
        spaceId: "space-1",
        defaultProvider: "anthropic",
        defaultModel: "model-a",
      };
    if (procedure === "models/list")
      return ["model-a", "model-b"].map((id) => ({
        provider: "anthropic",
        providerName: "Anthropic",
        id,
        label: id,
        billing: "API key",
        auth: "api-key",
        contextWindow: 64000,
        maxTokens: 4096,
      }));
    if (procedure === "models/credentials") return [connection];
    return normal(procedure, input);
  });
  return state.rpc.getMockImplementation()!;
}

it("exposes only per-model advanced settings for a connected catalog model", async () => {
  useCatalogConnection();
  await act(async () => root.render(<Models />));
  expect(
    [...container.querySelectorAll("button")].filter((item) =>
      item.textContent?.startsWith("Advanced"),
    ),
  ).toHaveLength(1);
});

it.each(["save", "read"] as const)(
  "keeps a newer catalog model selection during an earlier settings %s",
  async (phase) => {
    const normal = useCatalogConnection();
    const saving = deferred<{ ok: true }>();
    const reading = deferred<unknown>();
    let submitted = false;
    state.rpc.mockImplementation((procedure: string, input: unknown) => {
      if (procedure === "models/saveModelSettings") {
        submitted = true;
        return phase === "save" ? saving.promise : Promise.resolve({ ok: true });
      }
      if (phase === "read" && submitted && procedure === "models/credentials")
        return reading.promise;
      return normal(procedure, input);
    });
    await act(async () => root.render(<Models />));
    await act(async () => modelSettingsButton("Advanced").click());
    await edit(modelSettingsOutput(), "2048");
    await act(async () => modelSettingsButton("Save").click());
    await act(async () => button("model-b").click());
    expect(button("model-b").getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      if (phase === "save") saving.resolve({ ok: true });
      else
        reading.resolve([
          {
            ...credential,
            provider: "anthropic",
            modelSettings: { "model-a": { maxTokens: 2048 } },
          },
        ]);
    });
    expect(button("model-b").getAttribute("aria-pressed")).toBe("true");
  },
);

it("retains the native draft if another connection edit skips the save readback", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const saving = deferred<{ ok: true }>();
  state.rpc.mockImplementation((procedure: string, input: unknown) =>
    procedure === "models/saveModelSettings" ? saving.promise : normal(procedure, input),
  );
  await act(async () => root.render(<Models />));
  await act(async () => modelSettingsButton("Advanced").click());
  await edit(modelSettingsOutput(), "2048");
  await act(async () => modelSettingsButton("Save").click());
  await edit(baseUrl(), "http://127.0.0.1:8099/v1");
  await act(async () => saving.resolve({ ok: true }));
  expect(modelSettingsPanel().textContent).not.toContain("Saved.");
  expect(modelSettingsOutput().value).toBe("2048");
});

it("retains the native draft when another refresh supersedes its readback", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const reading = deferred<unknown>();
  const replacing = deferred<unknown>();
  let saved = false;
  let reads = 0;
  state.rpc.mockImplementation((procedure: string, input: unknown) => {
    if (procedure === "models/saveModelSettings") {
      saved = true;
      return Promise.resolve({ ok: true });
    }
    if (procedure === "models/credentials")
      return saved
        ? ++reads === 1
          ? reading.promise
          : replacing.promise
        : Promise.resolve([{ ...credential, isDefault: false }]);
    if (procedure === "models/setDefault") return Promise.resolve(undefined);
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  await act(async () => modelSettingsButton("Advanced").click());
  await edit(modelSettingsOutput(), "2048");
  await act(async () => modelSettingsButton("Save").click());
  await act(async () => button("Use this model").click());
  expect(reads).toBe(2);
  await act(async () =>
    reading.resolve([{ ...credential, modelSettings: { "model-a": { maxTokens: 2048 } } }]),
  );
  await act(async () => replacing.reject(new Error("Synthetic replacement read failure")));
  expect(modelSettingsPanel().textContent).not.toContain("Saved.");
  expect(modelSettingsOutput().value).toBe("2048");
  expect(modelSettingsPanel().textContent).toContain("Could not load model settings");
});

it.each([false, true])(
  "saves native model-enabled effort (protocol change %s)",
  async (changeProtocol) => {
    const saved = {
      ...credential,
      reasoning: false,
      thinkingLevel: "low",
      modelSettings: { "model-a": { reasoning: true }, "model-b": { reasoning: false } },
    };
    const normal = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((procedure, input) =>
      procedure === "models/credentials" ? Promise.resolve([saved]) : normal(procedure, input),
    );
    await act(async () => root.render(<Models />));
    await act(async () => button("Reasoning effort").click());
    const menu = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)?.[0];
    await act(async () => menu?.actions.find((entry) => entry.text === "High")?.onPress());
    if (changeProtocol) {
      await act(async () => button("API protocol").click());
      const protocol = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)?.[0];
      await act(async () =>
        protocol?.actions.find((entry) => entry.text === "Responses")?.onPress(),
      );
      expect(button("API protocol").textContent).toContain("Responses");
    }
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) =>
        item.textContent === "Save" && !item.closest('[data-testid="model-settings-panel"]'),
    )!;
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(
      state.rpc.mock.calls.filter(([procedure]) => procedure === "models/connect").at(-1)?.[1],
    ).toMatchObject({ credentialId: "connection-a", reasoning: false, thinkingLevel: "high" });
    expect(saved.modelSettings["model-b"].reasoning).toBe(false);
  },
);

it.each(["save", "reset"] as const)(
  "preserves native retained effort when model settings %s hides thinking before the connection save",
  async (action) => {
    let saved = {
      ...credential,
      reasoning: true,
      thinkingLevel: "high",
      modelSettings: { "model-a": { reasoning: true } as Record<string, unknown> },
    };
    const normal = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation(async (procedure, input) => {
      if (procedure === "models/credentials") return [saved];
      if (procedure === "models/saveModelSettings") {
        const request = input as { settings: Record<string, unknown> };
        saved = { ...saved, modelSettings: { "model-a": request.settings } };
        return { ok: true };
      }
      return normal(procedure, input);
    });
    await act(async () => root.render(<Models />));
    expect(button("Reasoning effort")).toBeDefined();
    await act(async () => modelSettingsButton("Advanced").click());
    if (action === "save")
      await act(async () =>
        modelSettingsPanel()
          .querySelector<HTMLInputElement>('input[aria-label="Supports thinking"]')!
          .click(),
      );
    await act(async () =>
      modelSettingsButton(action === "save" ? "Save" : "Reset to defaults").click(),
    );
    expect(modelSettingsPanel().textContent).toContain("Saved.");
    expect(container.querySelector('button[aria-label="Reasoning effort"]')).toBeNull();
    expect(container.textContent).not.toContain("Thinking: High");
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) =>
        item.textContent === "Save" && !item.closest('[data-testid="model-settings-panel"]'),
    )!;
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    const request = state.rpc.mock.calls
      .filter(([procedure]) => procedure === "models/connect")
      .at(-1)?.[1];
    expect(request).toMatchObject({ credentialId: "connection-a", modelId: "model-a" });
    expect(Object.hasOwn(request as object, "thinkingLevel")).toBe(false);
  },
);

it("preserves native dormant effort when saving a reasoning-disabled connection", async () => {
  const saved = {
    ...credential,
    reasoning: true,
    thinkingLevel: "low",
    modelSettings: { "model-a": { reasoning: false } },
  };
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((procedure, input) =>
    procedure === "models/credentials" ? Promise.resolve([saved]) : normal(procedure, input),
  );
  await act(async () => root.render(<Models />));
  const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === "Save" && !item.closest('[data-testid="model-settings-panel"]'),
  )!;
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  const request = state.rpc.mock.calls
    .filter(([procedure]) => procedure === "models/connect")
    .at(-1)?.[1];
  expect(request).toMatchObject({ credentialId: "connection-a" });
  expect(Object.hasOwn(request as object, "thinkingLevel")).toBe(false);
  expect(saved.thinkingLevel).toBe("low");
});

it.each([false, true])(
  "reveals the native retained effort after enabling reasoning (protocol change %s)",
  async (changeProtocol) => {
    let saved = {
      ...credential,
      thinkingLevel: "high",
      modelSettings: { "model-a": { reasoning: false } as Record<string, unknown> },
    };
    const normal = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation(async (procedure, input) => {
      if (procedure === "models/credentials") return [saved];
      if (procedure === "models/saveModelSettings") {
        saved = {
          ...saved,
          modelSettings: { "model-a": (input as { settings: Record<string, unknown> }).settings },
        };
        return { ok: true };
      }
      return normal(procedure, input);
    });
    await act(async () => root.render(<Models />));
    if (changeProtocol) {
      await act(async () => button("API protocol").click());
      const menu = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)?.[0];
      await act(async () => menu?.actions.find((entry) => entry.text === "Responses")?.onPress());
    }
    await act(async () => modelSettingsButton("Advanced").click());
    await act(async () =>
      modelSettingsPanel()
        .querySelector<HTMLInputElement>('input[aria-label="Supports thinking"]')!
        .click(),
    );
    await act(async () => modelSettingsButton("Save").click());
    expect(button("Reasoning effort").textContent).toContain("High");
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) =>
        item.textContent === "Save" && !item.closest('[data-testid="model-settings-panel"]'),
    )!;
    await act(async () => save.click());
    expect(
      state.rpc.mock.calls.filter(([name]) => name === "models/connect").at(-1)?.[1],
    ).toMatchObject({ thinkingLevel: "high" });
  },
);

it("keeps the native committed revision when a settings readback supersedes the connection readback", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const reading = deferred<(typeof credential)[]>();
  let reads = 0;
  state.rpc.mockImplementation(async (procedure, input) => {
    if (procedure === "models/credentials") {
      reads++;
      if (reads === 2) return reading.promise;
      return [{ ...credential, connectionRevision: reads === 1 ? 7 : 8 }];
    }
    if (procedure === "models/connect") return { ...credential, connectionRevision: 8 };
    if (procedure === "models/saveModelSettings") return { ok: true };
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  const save = () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) =>
        item.textContent === "Save" && !item.closest('[data-testid="model-settings-panel"]'),
    )!;
  await act(async () => save().click());
  expect(reads).toBe(2);
  expect(
    state.rpc.mock.calls.filter(([name]) => name === "models/connect").at(-1)?.[1],
  ).toMatchObject({ expectedRevision: 7 });
  await act(async () => modelSettingsButton("Advanced").click());
  await edit(modelSettingsOutput(), "2048");
  await act(async () => modelSettingsButton("Save").click());
  expect(reads).toBe(3);
  expect(modelSettingsPanel().textContent).toContain("Saved.");
  await act(async () => reading.resolve([{ ...credential, connectionRevision: 8 }]));
  await act(async () => save().click());
  expect(state.rpc.mock.calls.filter(([name]) => name === "models/connect")).toHaveLength(2);
  expect(
    state.rpc.mock.calls.filter(([name]) => name === "models/connect").at(-1)?.[1],
  ).toMatchObject({ expectedRevision: 8 });
});

it("checks a saved API key without exposing it to the editor", async () => {
  const saved = {
    id: "owned-key",
    provider: "openai",
    label: "OpenAI",
    hasKey: true,
    isDefault: true,
    authKind: "api_key",
    modelId: "fixture-chat",
    connectionRevision: 7,
    providerListedModelIds: ["fixture-listed-chat"],
  };
  let readback: Promise<(typeof saved)[]> | undefined;
  let probe: Promise<{ models: string[]; catalogUpdated?: true }> | undefined;
  let connectionChanged = false;
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (procedure: string, input: unknown) => {
    if (procedure === "me")
      return {
        userId: "user-1",
        spaceId: "space-1",
        defaultProvider: saved.provider,
        defaultModel: saved.modelId,
      };
    if (procedure === "models/list")
      return [
        {
          provider: saved.provider,
          providerName: "OpenAI",
          id: saved.modelId,
          label: "Example Chat",
          auth: "api-key",
          billing: "API",
          catalogProbe: true,
          savedCatalogProbe: true,
          inferenceProbe: true,
        },
        {
          provider: saved.provider,
          providerName: "OpenAI",
          id: "fixture-listed-chat",
          label: "Listed Chat",
          auth: "api-key",
          billing: "API",
          catalogProbe: true,
          savedCatalogProbe: true,
        },
      ];
    if (procedure === "models/credentials") {
      const credentials = await (readback ?? [saved]);
      if ((input as { includeProviderCatalog?: boolean }).includeProviderCatalog)
        return credentials;
      return credentials.map(({ providerListedModelIds: _listed, ...rest }) => rest);
    }
    if (procedure === "models/probeCatalog") return probe ?? { models: [saved.modelId] };
    if (procedure === "models/probeInference") {
      if (connectionChanged) throw new Error("Model connection changed. Reload and try again.");
      return { status: Object.hasOwn(input as object, "apiKey") ? "auth" : "accepted" };
    }
    return normal(procedure, input);
  });
  await act(async () => root.render(<Models />));
  expect(
    button("Listed Chat").compareDocumentPosition(button("Example Chat")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(button("Example Chat").getAttribute("aria-pressed")).toBe("true");
  const key = container.querySelector<HTMLInputElement>('input[aria-label="API key"]');
  expect(key?.value).toBe("");
  const check = button("Check models");
  expect(check.disabled).toBe(false);
  await act(async () => check.click());
  expect(
    state.rpc.mock.calls.find(([procedure]) => procedure === "models/probeCatalog")?.[1],
  ).toEqual({
    provider: "openai",
    credentialId: saved.id,
    expectedRevision: 7,
  });
  expect(container.textContent).toContain("Model listed by the provider.");
  expect(key?.value).toBe("");

  saved.connectionRevision++;
  await act(async () => {
    state.blur?.();
    state.blur = state.focus?.();
  });
  expect(container.textContent).not.toContain("Model listed by the provider.");
  await act(async () => button("Check models").click());
  expect(
    state.rpc.mock.calls.filter(([procedure]) => procedure === "models/probeCatalog").at(-1)?.[1],
  ).toMatchObject({ expectedRevision: 8 });

  const nextConnection = deferred<(typeof saved)[]>();
  const lateResult = deferred<{ models: string[] }>();
  readback = nextConnection.promise;
  probe = lateResult.promise;
  await act(async () => {
    state.blur?.();
    state.blur = state.focus?.();
  });
  await act(async () => button("Check models").click());
  const checks = state.rpc.mock.calls.filter(([procedure]) => procedure === "models/probeCatalog");
  expect(checks).toHaveLength(3);
  expect(checks.at(-1)?.[1]).toMatchObject({ expectedRevision: 8 });
  await act(async () => nextConnection.resolve([{ ...saved, connectionRevision: 9 }]));
  await act(async () => lateResult.reject(new Error("Old connection changed")));
  expect(container.textContent).not.toContain("Old connection changed");
  expect(container.textContent).not.toContain("Model listed by the provider.");

  const obsoleteReadback = deferred<(typeof saved)[]>();
  readback = obsoleteReadback.promise;
  await act(async () => {
    state.blur?.();
    state.blur = state.focus?.();
  });
  readback = Promise.resolve([{ ...saved, connectionRevision: 9 }]);
  await act(async () => {
    state.blur?.();
    state.blur = state.focus?.();
  });
  const currentProbe = deferred<{ models: string[]; catalogUpdated?: true }>();
  probe = currentProbe.promise;
  await act(async () => button("Check models").click());
  expect(
    state.rpc.mock.calls.filter(([procedure]) => procedure === "models/probeCatalog").at(-1)?.[1],
  ).toMatchObject({ expectedRevision: 9 });
  await act(async () => obsoleteReadback.reject(new Error("Superseded refresh failed")));
  await act(async () => currentProbe.resolve({ models: [saved.modelId], catalogUpdated: true }));
  expect(container.textContent).not.toContain("Superseded refresh failed");
  expect(container.textContent).toContain("Model listed by the provider.");

  const failedReadback = deferred<(typeof saved)[]>();
  readback = failedReadback.promise;
  await act(async () => button("Check models").click());
  await act(async () => failedReadback.reject(new Error("Connection read failed")));
  expect(container.textContent).toContain("Could not load model settings");
  expect(container.textContent).not.toContain("Model listed by the provider.");
  expect(container.textContent).not.toContain("Model connection changed. Check models again.");

  const rotatedConnection = deferred<(typeof saved)[]>();
  readback = rotatedConnection.promise;
  probe = Promise.resolve({ models: [saved.modelId], catalogUpdated: true });
  await act(async () => button("Check models").click());
  expect(button("Testing…").disabled).toBe(true);
  await act(async () => rotatedConnection.resolve([{ ...saved, connectionRevision: 10 }]));
  expect(container.textContent).not.toContain("Model listed by the provider.");
  expect(container.textContent).toContain("Model connection changed. Check models again.");
  await act(async () => button("Check models").click());
  expect(
    state.rpc.mock.calls.filter(([procedure]) => procedure === "models/probeCatalog").at(-1)?.[1],
  ).toMatchObject({ credentialId: saved.id, expectedRevision: 10 });
  expect(container.textContent).toContain("Model listed by the provider.");
  expect(container.textContent).not.toContain("Model connection changed. Check models again.");

  expect(
    state.rpc.mock.calls.filter(([procedure]) => procedure === "models/probeInference"),
  ).toEqual([]);
  await act(async () => button("Test model").click());
  expect(container.textContent).toContain("The model accepted the test request.");
  const savedInference = state.rpc.mock.calls.find(([name]) => name === "models/probeInference");
  expect(savedInference?.[1]).toEqual({
    provider: saved.provider,
    modelId: saved.modelId,
    credentialId: saved.id,
    expectedRevision: 10,
  });
  expect(savedInference?.[2]).toMatchObject({
    timeoutMs: MODEL_INFERENCE_PROBE_TIMEOUT_MS + 5_000,
  });

  connectionChanged = true;
  await act(async () => resetI18nForTests("zh-CN"));
  await act(async () => button("测试模型").click());
  expect(container.textContent).toContain("模型连接已更改，请重新加载后重试。");
  expect(container.textContent).not.toContain("The model accepted the test request.");
  connectionChanged = false;
  await act(async () => resetI18nForTests("en"));

  await edit(key!, "fixture-draft-inference-key");
  await act(async () => button("Test model").click());
  expect(container.textContent).toContain("rejected the API key");
  expect(key?.value).toBe("fixture-draft-inference-key");
  expect(
    state.rpc.mock.calls.filter(([procedure]) => procedure === "models/probeInference").at(-1)?.[1],
  ).toEqual({
    provider: saved.provider,
    modelId: saved.modelId,
    apiKey: "fixture-draft-inference-key",
  });
});
