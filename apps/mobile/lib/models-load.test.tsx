import type { NativeRoutineEventSpec } from "@rakazo/contracts";
// @vitest-environment jsdom

import { nativeEventApp } from "@rakazo/contracts";
import { modelOptionKey } from "@rakazo/core";
import { draftFromNativeRoutineTrigger } from "@rakazo/core/routine-native-events";
import type { ReactNode } from "react";
import { act, useEffect, useLayoutEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import triggerEdits from "../../../packages/testkit/src/routine-trigger-edits.json" with {
  type: "json",
};
import triggerFixtures from "../../../packages/testkit/src/routine-trigger-fixtures.json" with {
  type: "json",
};
import Models from "../app/(settings)/models";
import SpaceSettings from "../app/(settings)/space-settings";
import RoutineDetail from "../app/routine";
import { RoutineNativeEventFields } from "../components/routine-native-events";
import { resetI18nForTests } from "./i18n";
import { presentMessageActionSheet } from "./message-action-sheet";
import { useSpaceSettings } from "./space-settings";

function routineTriggerFixture(spec: NativeRoutineEventSpec) {
  return { ...triggerFixtures.trigger, spec };
}

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  createPress: undefined as undefined | (() => void),
  back: vi.fn(),
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
  useRouter: () => ({ back: state.back, push: state.push, replace: state.replace }),
  useLocalSearchParams: () => state.params,
  useFocusEffect: (effect: () => () => void) =>
    useEffect(() => {
      state.focus = effect;
      state.blur = effect();
      return state.blur;
    }, [effect]),
}));
vi.mock("../components/routine-run-time", () => ({
  RoutineRunTime: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <input aria-label="Run time" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));
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
  }) => {
    if (label === "Create") state.createPress = onPress;
    return (
      <button type="button" disabled={disabled} aria-label={accessibilityLabel} onClick={onPress}>
        {label}
      </button>
    );
  },
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
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    ActivityIndicator: () => <span data-testid="loading" />,
    StyleSheet: { create: (styles: unknown) => styles },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    Keyboard: { dismiss: vi.fn() },
    Linking: { openURL: vi.fn() },
    Alert: { alert: vi.fn() },
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
      multiline,
    }: {
      accessibilityLabel?: string;
      value: string;
      onChangeText: (value: string) => void;
      editable?: boolean;
      secureTextEntry?: boolean;
      multiline?: boolean;
    }) =>
      multiline && !["Prompt"].includes(accessibilityLabel ?? "") ? (
        <textarea
          aria-label={accessibilityLabel}
          value={value}
          disabled={editable === false}
          onChange={(event) => onChangeText(event.target.value)}
        />
      ) : (
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
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
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
  state.replace.mockReset();
  state.createPress = undefined;
  state.back.mockReset();
  vi.mocked(Alert.alert).mockReset();
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

function routineInput(label: string) {
  const input = container.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"], textarea[aria-label="${label}"]`,
  );
  if (!input) throw new Error(`Missing input: ${label}`);
  return input;
}

it("creates a routine with the account timezone and navigates to its saved identity", async () => {
  state.params = { botId: "bot-1", origin: "profile" };
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (p, input) => {
    if (p === "me") return { timezone: "Asia/Shanghai" };
    if (p === "routines/create") return { ...input, id: "new-routine" };
    return normal(p, input);
  });
  await act(async () => root.render(<RoutineDetail />));
  expect(container.textContent).toContain("Asia/Shanghai");
  await edit(routineInput("Name"), "Daily review");
  await edit(routineInput("Prompt"), "Review synthetic tasks");
  await act(async () => button("Create").click());
  expect(state.rpc.mock.calls.find(([p]) => p === "routines/create")?.[1]).toEqual({
    mutationId: expect.any(String),
    botId: "bot-1",
    name: "Daily review",
    prompt: "Review synthetic tasks",
    crons: ["0 9 * * *"],
    timezone: "Asia/Shanghai",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    nativeTriggers: [],
  });
  expect(state.replace).toHaveBeenCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({ routineId: "new-routine", botId: "bot-1" }),
    }),
  );
});

it("keeps ordinary edits and exact schedules on failure without sending model or trigger fields", async () => {
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (p, input) => {
    if (p === "routines/list")
      return [{ ...(await normal(p))[0], crons: ["0 0 9 * * MON-FRI"], webhookEnabled: true }];
    if (p === "routines/update") throw new Error("Save unavailable");
    return normal(p, input);
  });
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Edit").click());
  await edit(routineInput("Name"), "Changed");
  await act(async () => button("Save").click());
  expect(state.rpc.mock.calls.find(([p]) => p === "routines/update")?.[1]).toEqual({
    mutationId: expect.any(String),
    routineId: "routine-1",
    name: "Changed",
  });
  expect(routineInput("Name").value).toBe("Changed");
  expect(container.textContent).toContain("Save unavailable");
});

it("requires a future instant before enabling an imported one-shot", async () => {
  const normal = state.rpc.getMockImplementation()!;
  let routine = {
    ...(await normal("routines/list"))[0],
    active: false,
    crons: ["@once"],
    nextRunAt: null,
    lastRunAt: null,
  };
  state.rpc.mockImplementation(async (p, input) => {
    if (p === "routines/list") return [routine];
    if (p === "routines/update") {
      routine = { ...routine, ...input };
      return routine;
    }
    return normal(p, input);
  });
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Resume").click());
  expect(state.rpc.mock.calls.some(([p]) => p === "routines/update")).toBe(false);
  expect(container.textContent).toContain("Run time must be in the future.");
  await edit(routineInput("Run time"), "2099-01-01T12:00:00Z");
  await act(async () => button("Resume").click());
  expect(state.rpc.mock.calls.find(([p]) => p === "routines/update")?.[1]).toEqual({
    routineId: "routine-1",
    active: true,
    runAt: "2099-01-01T12:00:00.000Z",
  });
  expect(button("Pause")).toBeDefined();
});

it("confirms removal and ignores a confirmation after changing Bot", async () => {
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Delete").click());
  const confirm = vi
    .mocked(Alert.alert)
    .mock.calls.at(-1)?.[2]
    ?.find((entry) => entry.style === "destructive")?.onPress;
  expect(confirm).toBeDefined();
  expect(state.rpc.mock.calls.some(([p]) => p === "routines/remove")).toBe(false);
  state.params = { botId: "bot-2", routineId: "routine-2" };
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => confirm?.());
  expect(state.rpc.mock.calls.some(([p]) => p === "routines/remove")).toBe(false);
  expect(state.back).not.toHaveBeenCalled();
});

it("discards a save response after switching Space and does not retry it on the new object", async () => {
  const saving = deferred<unknown>();
  const normal = state.rpc.getMockImplementation()!;
  const original = (await normal("routines/list"))[0];
  state.rpc.mockImplementation((p, input) =>
    p === "routines/update" ? saving.promise : normal(p, input),
  );
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Edit").click());
  await edit(routineInput("Name"), "Old scope draft");
  await act(async () => button("Save").click());
  state.spaceId = "space-2";
  state.spaceGeneration += 1;
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => saving.resolve({ ...original, prompt: "Obsolete response" }));
  expect(container.textContent).not.toContain("Obsolete response");
  const writes = state.rpc.mock.calls.filter(([p]) => p === "routines/update");
  expect(writes).toHaveLength(1);
  expect(writes[0]?.[2]?.requestContext.headers["x-rakazo-space-id"]).toBe("space-1");
});

it("refreshes history after an explicit test run and opens its result", async () => {
  const normal = state.rpc.getMockImplementation()!;
  let tested = false;
  state.rpc.mockImplementation(async (p, input) => {
    if (p === "routines/testRun") {
      tested = true;
      return { runId: "run-1" };
    }
    if (p === "routines/history")
      return {
        nextCursor: null,
        runs: tested
          ? [
              {
                id: "run-1",
                botId: "bot-1",
                status: "succeeded",
                createdAt: "2030-01-01T00:00:00Z",
                messageId: "result-1",
              },
            ]
          : [],
      };
    return normal(p, input);
  });
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Test run").click());
  await act(async () => button("View chat").click());
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { botId: "bot-1", messageId: "result-1" },
  });
  expect(state.rpc.mock.calls.some(([p]) => p === "routines/update")).toBe(false);
});

it.each([
  ["Every hour", "0 * * * *"],
  ["Every day", "0 9 * * *"],
  ["Weekdays", "0 9 * * 1-5"],
  ["Every week", "0 9 * * 1"],
  ["Every month", "0 9 1 * *"],
  ["Interval", "*/3 * * * *"],
  ["Advanced", "0 9 * * *"],
])("saves the shared %s preset", async (frequency, cron) => {
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (p, input) => {
    if (p === "routines/list") return [{ ...(await normal(p))[0], crons: ["0 9 * * *"] }];
    if (p === "routines/update") return { ...(await normal("routines/list"))[0], ...input };
    return normal(p, input);
  });
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Edit").click());
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="How often"]')!;
  await act(async () => {
    select.value = frequency;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Save").click());
  expect(state.rpc.mock.calls.find(([p]) => p === "routines/update")?.[1]).toEqual({
    mutationId: expect.any(String),
    routineId: "routine-1",
    ...(cron !== "0 9 * * *" ? { crons: [cron] } : {}),
  });
});

it("preserves multiple schedules when editing one advanced expression", async () => {
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (p, input) => {
    if (p === "routines/list")
      return [{ ...(await normal(p))[0], crons: ["0 9 * * *", "0 12 * * *"] }];
    if (p === "routines/update") return { ...(await normal("routines/list"))[0], ...input };
    return normal(p, input);
  });
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Edit").click());
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="How often"]')!;
  await act(async () => {
    select.value = "Advanced";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await edit(routineInput("Cron expression"), "0 10 * * 2");
  expect(select.value).toBe("Advanced");
  await act(async () => button("Save").click());
  expect(state.rpc.mock.calls.find(([p]) => p === "routines/update")?.[1].crons).toEqual([
    "0 10 * * 2",
    "0 12 * * *",
  ]);
});

it("pauses and resumes a recurring routine without modifying its other settings", async () => {
  const normal = state.rpc.getMockImplementation()!;
  let routine = { ...(await normal("routines/list"))[0], crons: ["0 9 * * *"] };
  state.rpc.mockImplementation(async (p, input) => {
    if (p === "routines/list") return [routine];
    if (p === "routines/update") {
      routine = { ...routine, ...input };
      return routine;
    }
    return normal(p, input);
  });
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Pause").click());
  await act(async () => button("Resume").click());
  expect(
    state.rpc.mock.calls.filter(([p]) => p === "routines/update").map(([, input]) => input),
  ).toEqual([
    { routineId: "routine-1", active: false },
    { routineId: "routine-1", active: true },
  ]);
});

it("deletes only after confirmation and returns after the server succeeds", async () => {
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((p, input) =>
    p === "routines/remove" ? { ok: true } : normal(p, input),
  );
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Delete").click());
  expect(state.back).not.toHaveBeenCalled();
  await act(async () =>
    vi
      .mocked(Alert.alert)
      .mock.calls.at(-1)?.[2]
      ?.find((entry) => entry.style === "destructive")
      ?.onPress?.(),
  );
  expect(state.rpc.mock.calls.find(([p]) => p === "routines/remove")?.[1]).toEqual({
    routineId: "routine-1",
  });
  expect(state.back).toHaveBeenCalledOnce();
});

it.each(["routines/create", "routines/testRun"])(
  "revokes %s while consent waits across Bot and Space switches",
  async (procedure) => {
    for (const switchTarget of ["bot", "space"]) {
      state.params =
        procedure === "routines/create"
          ? { botId: "bot-1" }
          : { botId: "bot-1", routineId: "routine-1" };
      const normal = state.rpc.getMockImplementation()!;
      const consent = deferred<void>();
      const dispatched = vi.fn();
      state.rpc.mockImplementation(async (p, input, options) => {
        if (p === "me") return { timezone: "UTC" };
        if (p === procedure) {
          await consent.promise;
          if (options.requestContext.isCurrent?.() === false) throw new Error("Request canceled");
          dispatched(input);
          return { id: "obsolete-created", runId: "obsolete-run" };
        }
        return normal(p, input, options);
      });
      await act(async () => root.render(<RoutineDetail />));
      if (procedure === "routines/create") {
        await edit(routineInput("Name"), "Synthetic routine");
        await edit(routineInput("Prompt"), "Synthetic prompt");
      }
      await act(async () =>
        button(procedure === "routines/create" ? "Create" : "Test run").click(),
      );
      if (switchTarget === "bot") state.params = { botId: "bot-2", routineId: "routine-2" };
      else {
        state.spaceId = "space-2";
        state.spaceGeneration += 1;
      }
      await act(async () => root.render(<RoutineDetail />));
      await act(async () => consent.resolve());
      expect(dispatched).not.toHaveBeenCalled();
      expect(state.replace).not.toHaveBeenCalled();
      // Give the next scenario a distinct route owner without creating a new root.
      state.spaceId = "space-1";
      state.spaceGeneration += 1;
      state.rpc.mockImplementation(normal);
    }
  },
);

it.each(["before", "after"])(
  "reads committed routine after refocus when the earlier read resolves %s settlement",
  async (order) => {
    const normal = state.rpc.getMockImplementation()!;
    const original = (await normal("routines/list"))[0];
    const saving = deferred<unknown>();
    const focusRead = deferred<unknown>();
    let reads = 0;
    let committed = false;
    state.rpc.mockImplementation(async (p, input, options) => {
      if (p === "routines/list") {
        reads += 1;
        if (reads === 2) return focusRead.promise;
        return [{ ...original, active: !committed }];
      }
      if (p === "routines/update") return saving.promise;
      return normal(p, input, options);
    });
    await act(async () => root.render(<RoutineDetail />));
    await act(async () => button("Pause").click());
    await refocus();
    if (order === "before") await act(async () => focusRead.resolve([original]));
    committed = true;
    await act(async () => saving.resolve({ ...original, active: false }));
    if (order === "after") await act(async () => focusRead.resolve([original]));
    expect(reads).toBe(3);
    expect(button("Resume").disabled).toBe(false);
  },
);

it("preserves the same-object field draft when a pending save fails after refocus", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const saving = deferred<unknown>();
  state.rpc.mockImplementation((p, input, options) =>
    p === "routines/update" ? saving.promise : normal(p, input, options),
  );
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Edit").click());
  await edit(routineInput("Name"), "Keep this draft");
  await act(async () => button("Save").click());
  await refocus();
  await act(async () => saving.reject(new Error("Save failed")));
  expect(routineInput("Name").value).toBe("Keep this draft");
  expect(container.textContent).toContain("Save failed");
  expect(button("Save").disabled).toBe(false);
});

it("does not refresh another object or drop its draft when an old save settles", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const original = (await normal("routines/list"))[0];
  const saving = deferred<unknown>();
  let reads = 0;
  state.rpc.mockImplementation(async (p, input, options) => {
    if (p === "routines/list") {
      reads += 1;
      return [{ ...original, botId: state.params.botId, id: state.params.routineId }];
    }
    if (p === "routines/update") return saving.promise;
    return normal(p, input, options);
  });
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Pause").click());
  state.params = { botId: "bot-2", routineId: "routine-2" };
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => saving.resolve({ ...original, name: "Old object", active: false }));
  expect(reads).toBe(2);
  expect(container.textContent).not.toContain("Old object");
  await act(async () => button("Edit").click());
  await edit(routineInput("Name"), "New object draft");
  await refocus();
  expect(routineInput("Name").value).toBe("New object draft");
});

it.each([false, true])(
  "refreshes untouched model selection but retains an edited model draft on refocus (edited: %s)",
  async (edited) => {
    const normal = state.rpc.getMockImplementation()!;
    let refreshed = false;
    state.rpc.mockImplementation(async (p, input, options) => {
      if (p === "routines/list")
        return [{ ...(await normal(p))[0], modelId: refreshed ? "model-b" : "model-a" }];
      return normal(p, input, options);
    });
    await act(async () => root.render(<RoutineDetail />));
    if (edited) {
      await chooseRoutineModel("model-b");
      await chooseRoutineModel("model-a");
    }
    refreshed = true;
    await refocus();
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.value).toBe(
      modelOptionKey("openai-compatible", edited ? "model-a" : "model-b", "connection-a"),
    );
  },
);

it("ignores a focus read started before a save in the current focus scope", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const original = (await normal("routines/list"))[0];
  const focusRead = deferred<unknown>();
  let reads = 0;
  state.rpc.mockImplementation(async (p, input, options) => {
    if (p === "routines/list") return ++reads === 1 ? [original] : focusRead.promise;
    if (p === "routines/update") return { ...original, active: false };
    return normal(p, input, options);
  });
  await act(async () => root.render(<RoutineDetail />));
  await refocus();
  await act(async () => button("Pause").click());
  await act(async () => focusRead.resolve([original]));
  expect(button("Resume").disabled).toBe(false);
});

it("reads the committed state when the save settles while blurred before refocus", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const original = (await normal("routines/list"))[0];
  const saving = deferred<unknown>();
  let committed = false;
  let reads = 0;
  state.rpc.mockImplementation(async (p, input, options) => {
    if (p === "routines/list") {
      reads += 1;
      return [{ ...original, active: !committed }];
    }
    if (p === "routines/update") return saving.promise;
    return normal(p, input, options);
  });
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Pause").click());
  await act(async () => state.blur?.());
  committed = true;
  await act(async () => saving.resolve({ ...original, active: false }));
  expect(reads).toBe(1);
  await refocus();
  expect(reads).toBe(2);
  expect(button("Resume").disabled).toBe(false);
});

it("restores a save failure recorded while blurred together with the same-object draft", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const saving = deferred<unknown>();
  state.rpc.mockImplementation((p, input, options) =>
    p === "routines/update" ? saving.promise : normal(p, input, options),
  );
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Edit").click());
  await edit(routineInput("Name"), "Keep failed draft");
  await act(async () => button("Save").click());
  await act(async () => state.blur?.());
  await act(async () => saving.reject(new Error("Background save failed")));
  await refocus();
  expect(routineInput("Name").value).toBe("Keep failed draft");
  expect(container.textContent).toContain("Background save failed");
  await refocus();
  expect(container.textContent).toContain("Background save failed");
  state.rpc.mockImplementation(async (p, input, options) =>
    p === "routines/update"
      ? { ...(await normal("routines/list"))[0], ...input }
      : normal(p, input, options),
  );
  await act(async () => button("Save").click());
  expect(container.textContent).not.toContain("Background save failed");
});

it.each(["before refocus", "after refocus"])(
  "restores the exact created identity when success arrives %s without permitting a second create",
  async (timing) => {
    state.params = { botId: "bot-1", botName: "Synthetic bot", origin: "profile" };
    const normal = state.rpc.getMockImplementation()!;
    const creating = deferred<unknown>();
    state.rpc.mockImplementation((p, input, options) =>
      p === "routines/create" ? creating.promise : normal(p, input, options),
    );
    await act(async () => root.render(<RoutineDetail />));
    await edit(routineInput("Name"), "Created once");
    await edit(routineInput("Prompt"), "Synthetic instruction");
    await act(async () => button("Create").click());
    expect(state.rpc.mock.calls.filter(([p]) => p === "routines/create")).toHaveLength(1);
    await act(async () => state.blur?.());
    if (timing === "after refocus") await refocus();
    const replayCreate = state.createPress;
    await act(async () => creating.resolve({ id: "created-once", botId: "bot-1" }));
    if (timing === "before refocus") {
      expect(state.replace).not.toHaveBeenCalled();
      await refocus();
    }
    expect(state.replace).toHaveBeenCalledWith({
      pathname: "/routine",
      params: {
        botId: "bot-1",
        botName: "Synthetic bot",
        origin: "profile",
        routineId: "created-once",
      },
    });
    // A native callback queued before navigation must not replay an acknowledged create.
    await act(async () => replayCreate?.());
    expect(state.rpc.mock.calls.filter(([p]) => p === "routines/create")).toHaveLength(1);
  },
);

it.each(["bot", "space", "routine", "away and back"])(
  "does not carry a blurred mutation failure into a different %s owner",
  async (target) => {
    const normal = state.rpc.getMockImplementation()!;
    const saving = deferred<unknown>();
    state.rpc.mockImplementation((p, input, options) =>
      p === "routines/update" ? saving.promise : normal(p, input, options),
    );
    await act(async () => root.render(<RoutineDetail />));
    await act(async () => button("Pause").click());
    await act(async () => state.blur?.());
    await act(async () => saving.reject(new Error("Private old-object failure")));
    if (target === "space") {
      state.spaceId = "space-2";
      state.spaceGeneration += 1;
    } else if (target === "routine") state.params = { botId: "bot-1", routineId: "routine-2" };
    else state.params = { botId: "bot-2", routineId: "routine-2" };
    await act(async () => root.render(<RoutineDetail />));
    if (target === "away and back") {
      state.params = { botId: "bot-1", routineId: "routine-1" };
      await act(async () => root.render(<RoutineDetail />));
    }
    expect(container.textContent).not.toContain("Private old-object failure");
  },
);

it.each(
  ["bot", "space", "routine", "away and back"].flatMap((target) =>
    ["before switch", "after switch"].map((timing) => [target, timing]),
  ),
)(
  "does not adopt an old creation result after switching %s (success: %s)",
  async (target, timing) => {
    state.params = { botId: "bot-1" };
    const normal = state.rpc.getMockImplementation()!;
    const creating = deferred<unknown>();
    state.rpc.mockImplementation((p, input, options) =>
      p === "routines/create" ? creating.promise : normal(p, input, options),
    );
    await act(async () => root.render(<RoutineDetail />));
    await edit(routineInput("Name"), "Old intent");
    await edit(routineInput("Prompt"), "Synthetic instruction");
    await act(async () => button("Create").click());
    await act(async () => state.blur?.());
    if (timing === "before switch")
      await act(async () => creating.resolve({ id: "old-created", botId: "bot-1" }));
    expect(state.replace).not.toHaveBeenCalled();
    if (target === "space") {
      state.spaceId = "space-2";
      state.spaceGeneration += 1;
    } else if (target === "routine") state.params = { botId: "bot-1", routineId: "routine-1" };
    else state.params = { botId: "bot-2" };
    await act(async () => root.render(<RoutineDetail />));
    if (target === "away and back") {
      state.params = { botId: "bot-1" };
      await act(async () => root.render(<RoutineDetail />));
    }
    if (timing === "after switch")
      await act(async () => creating.resolve({ id: "old-created", botId: "bot-1" }));
    await refocus();
    expect(state.replace).not.toHaveBeenCalled();
  },
);

it.each([
  [false, "credentials first"],
  [false, "routine first"],
  [true, "credentials first"],
  [true, "routine first"],
] as const)(
  "refreshes only untouched model revisions before a Thinking-only save (dirty: %s, %s)",
  async (dirty, order) => {
    const normal = state.rpc.getMockImplementation()!;
    let routine = (await normal("routines/list"))[0];
    let revision = 7;
    let reloading = false;
    const credentialsRead = deferred<unknown>();
    const routineRead = deferred<unknown>();
    state.rpc.mockImplementation(async (p, input, options) => {
      if (p === "models/credentials")
        return reloading
          ? credentialsRead.promise
          : [{ ...credential, connectionRevision: revision }];
      if (p === "routines/list") return reloading ? routineRead.promise : [routine];
      if (p === "routines/update") {
        if (input.expectedRevision !== revision) throw new Error("Connection changed");
        routine = { ...routine, ...input };
        return routine;
      }
      return normal(p, input, options);
    });
    await act(async () => root.render(<RoutineDetail />));
    await chooseRoutineModel("model-b");
    if (!dirty) {
      await act(async () => button("Save model").click());
      expect(
        state.rpc.mock.calls.find(([p]) => p === "routines/update")?.[1].expectedRevision,
      ).toBe(7);
      expect(button("Save model").disabled).toBe(true);
    }
    revision = 9;
    reloading = true;
    await refocus();
    const completeCredentials = () =>
      credentialsRead.resolve([{ ...credential, connectionRevision: 9 }]);
    const completeRoutine = () => routineRead.resolve([routine]);
    await act(async () =>
      order === "credentials first" ? completeCredentials() : completeRoutine(),
    );
    await act(async () =>
      order === "credentials first" ? completeRoutine() : completeCredentials(),
    );
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.value).toBe(
      modelOptionKey("openai-compatible", "model-b", "connection-a"),
    );
    const thinking = container.querySelector<HTMLSelectElement>('select[aria-label="Thinking"]')!;
    await act(async () => {
      thinking.value = "high";
      thinking.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Save model").click());
    const update = state.rpc.mock.calls.filter(([p]) => p === "routines/update").at(-1)?.[1];
    expect(update).toMatchObject({
      modelId: "model-b",
      thinkingLevel: "high",
      expectedRevision: dirty ? 7 : 9,
    });
    if (dirty) expect(container.textContent).toContain("Connection changed");
    else expect(container.textContent).not.toContain("Connection changed");
  },
);

function triggerSettings(
  options: { slack?: boolean; configured?: boolean; accounts?: unknown[] } = {},
) {
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (p, input, context) => {
    if (p === "connections/list") return options.accounts ?? [];
    if (p === "messaging/status") return { providers: [] };
    if (p === "messaging/installations/list")
      return {
        available: true,
        workspaces: options.slack ? [{ botId: "bot-1", status: "active" }] : [],
      };
    if (p === "bots/get") return { id: "bot-1", webhookConfigured: options.configured ?? true };
    return normal(p, input, context);
  });
}
async function openTriggers() {
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => button("Edit").click());
  await act(async () => button("External triggers").click());
}

it.each(["Webhook", "Git event", "Slack message"])(
  "saves only the edited %s trigger and preserves other settings",
  async (label) => {
    const normal = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation(async (p, input, options) => {
      if (p === "routines/list")
        return [
          {
            ...(await normal(p))[0],
            active: false,
            crons: ["0 9 * * *"],
            webhookEnabled: false,
            githubEnabled: false,
            messageProvider: null,
          },
        ];
      if (p === "routines/update") return { ...(await state.rpc("routines/list"))[0], ...input };
      return normal(p, input, options);
    });
    triggerSettings({ slack: true });
    await openTriggers();
    await act(async () =>
      label === "Slack message" ? button(label).click() : routineInput(label).click(),
    );
    await act(async () => button("Save").click());
    const field =
      label === "Webhook"
        ? { webhookEnabled: true }
        : label === "Git event"
          ? { githubEnabled: true }
          : { messageProvider: "slack" };
    expect(state.rpc.mock.calls.find(([p]) => p === "routines/update")?.[1]).toEqual({
      mutationId: expect.any(String),
      routineId: "routine-1",
      ...field,
    });
    expect(container.textContent).toContain("Paused");
    await act(async () => button("Edit").click());
    await act(async () => button("External triggers").click());
    if (label !== "Slack message") expect(routineInput(label).checked).toBe(true);
    else expect(button("Remove message trigger")).toBeTruthy();
  },
);

it("creates a webhook-only routine after removing the default schedule", async () => {
  state.params = { botId: "bot-1" };
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (p, input, options) =>
    p === "routines/create" ? { ...input, id: "created-external" } : normal(p, input, options),
  );
  triggerSettings();
  await act(async () => root.render(<RoutineDetail />));
  await edit(routineInput("Name"), "External");
  await edit(routineInput("Prompt"), "Synthetic event");
  await act(async () => button("Remove schedule").click());
  await act(async () => button("External triggers").click());
  await act(async () => routineInput("Webhook").click());
  await act(async () => button("Create").click());
  expect(state.rpc.mock.calls.find(([p]) => p === "routines/create")?.[1]).toMatchObject({
    crons: [],
    webhookEnabled: true,
    githubEnabled: false,
    messageProvider: null,
    nativeTriggers: [],
  });
});

it("keeps a failed trigger draft and cancel restores the saved configuration", async () => {
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (p, input, options) => {
    if (p === "routines/update") throw new Error("Synthetic permission denial");
    if (p === "routines/list") return [{ ...(await normal(p))[0], webhookEnabled: false }];
    return normal(p, input, options);
  });
  triggerSettings();
  await openTriggers();
  await act(async () => routineInput("Webhook").click());
  await act(async () => button("Save").click());
  expect(routineInput("Webhook").checked).toBe(true);
  expect(container.textContent).toContain("Synthetic permission denial");
  await act(async () => button("Cancel").click());
  await act(async () => button("Edit").click());
  await act(async () => button("External triggers").click());
  expect(routineInput("Webhook").checked).toBe(false);
  expect(state.rpc.mock.calls.filter(([p]) => p === "routines/update")).toHaveLength(1);
});

it("does not advertise unavailable message providers or disconnected accounts", async () => {
  triggerSettings({
    accounts: [{ id: "old", connectorId: "native", provider: "gmail", status: "disconnected" }],
  });
  await openTriggers();
  expect(button("Slack message").disabled).toBe(true);
  expect(button("Add application event").disabled).toBe(true);
  expect(
    [...container.querySelectorAll("button")].some((node) => node.textContent === "Teams message"),
  ).toBe(false);
});

it.each(["space", "session", "endpoint", "route"])(
  "ignores trigger capability responses after a %s change",
  async (change) => {
    const delayed = deferred<unknown>();
    triggerSettings();
    const normal = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((p, input, options) =>
      p === "messaging/installations/list" ? delayed.promise : normal(p, input, options),
    );
    await openTriggers();
    if (change === "space") state.spaceId = "space-2";
    if (change === "session") state.sessionGeneration++;
    if (change === "endpoint") state.apiBase = "https://other.example.test";
    if (change === "route") state.params = { botId: "bot-2", routineId: "routine-2" };
    await act(async () => root.render(<RoutineDetail />));
    await act(async () =>
      delayed.resolve({ available: true, workspaces: [{ botId: "bot-1", status: "active" }] }),
    );
    expect(container.querySelector('input[aria-label="Webhook"]')).toBeNull();
    expect(state.rpc.mock.calls.some(([p]) => p === "routines/update")).toBe(false);
  },
);

for (const c of triggerEdits) {
  const spec = c.spec as NativeRoutineEventSpec;
  it(`edits and reads back application fields ${JSON.stringify(spec)}`, async () => {
    const normal = state.rpc.getMockImplementation()!;
    let saved = {
      ...(await normal("routines/list"))[0],
      nativeTriggers: [routineTriggerFixture(spec)],
    };
    state.rpc.mockImplementation(async (p, input, options) => {
      if (p === "routines/list") return [saved];
      if (p === "routines/update") {
        saved = {
          ...saved,
          nativeTriggers: input.nativeTriggers.map((entry: Record<string, unknown>) => ({
            ...entry,
            version: 5,
          })),
        };
        return saved;
      }
      return normal(p, input, options);
    });
    triggerSettings({
      accounts: [
        {
          id: "fixture-connection",
          connectorId: "native",
          provider: nativeEventApp(spec),
          status: "connected",
          displayName: "Synthetic account",
        },
      ],
    });
    await openTriggers();
    const fields = [
      ...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], textarea',
      ),
    ].filter((node) => !["Name", "Prompt"].includes(node.getAttribute("aria-label") ?? ""));
    expect(fields.map((node) => node.getAttribute("aria-label")).sort()).toEqual(
      Object.keys(c.fields).sort(),
    );
    for (const [label, value] of Object.entries(c.fields)) {
      const field = fields.find((node) => node.getAttribute("aria-label") === label)!;
      await edit(field as HTMLInputElement, value!);
    }
    await act(async () => button("Save").click());
    const update = state.rpc.mock.calls.find(([p]) => p === "routines/update")?.[1];
    expect(update).toEqual({
      routineId: "routine-1",
      mutationId: expect.any(String),
      nativeTriggerBaseline: [{ id: "fixture-trigger", version: 4 }],
      nativeTriggers: [
        {
          id: "fixture-trigger",
          expectedVersion: 4,
          connectionId: "fixture-connection",
          spec: c.expected,
        },
      ],
    });
    await act(async () => button("Edit").click());
    await act(async () => button("External triggers").click());
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Event"]')?.value).toBe(
      spec.kind,
    );
    expect(saved.nativeTriggers[0].spec).toEqual(c.expected);
    for (const [label, value] of Object.entries(c.fields))
      expect(
        container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)?.value,
        label,
      ).toBe(value);
  });
}

it("opens the existing application settings route and preserves the draft on return", async () => {
  triggerSettings();
  await openTriggers();
  await act(async () => routineInput("Webhook").click());
  await act(async () => button("Connect an account").click());
  expect(state.push).toHaveBeenCalledWith("/plugins");
  await refocus();
  expect(routineInput("Webhook").checked).toBe(true);
});

it("keeps disconnected events byte-for-byte while editing a different event", async () => {
  const normal = state.rpc.getMockImplementation()!;
  const untouched = routineTriggerFixture({ kind: "gmail.message_received", labelIds: ["Z", "A"] });
  state.rpc.mockImplementation(async (p, input, options) => {
    if (p === "routines/list") return [{ ...(await normal(p))[0], nativeTriggers: [untouched] }];
    if (p === "routines/update") throw new Error("Synthetic permission denial");
    return normal(p, input, options);
  });
  triggerSettings({
    accounts: [
      {
        id: "planner-account",
        provider: "planner",
        connectorId: "native",
        status: "connected",
        displayName: "Synthetic planner",
      },
    ],
  });
  await openTriggers();
  expect(routineInput("Label IDs (any match, one per line)").disabled).toBe(true);
  await act(async () => button("Add application event").click());
  const selects = (label: string) => [
    ...container.querySelectorAll<HTMLSelectElement>(`select[aria-label="${label}"]`),
  ];
  await act(async () => {
    const account = selects("Account")[1]!;
    account.value = "planner-account";
    account.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    const event = selects("Event")[1]!;
    event.value = "planner.task.changed";
    event.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await edit(routineInput("Plan ID"), "synthetic-plan");
  await act(async () => button("Save").click());
  const update = state.rpc.mock.calls.find(([p]) => p === "routines/update")?.[1];
  expect(update.nativeTriggers).toEqual([
    {
      id: untouched.id,
      expectedVersion: 4,
      connectionId: untouched.connectionId,
      spec: untouched.spec,
    },
    {
      connectionId: "planner-account",
      spec: { kind: "planner.task.changed", planId: "synthetic-plan" },
    },
  ]);
  expect(routineInput("Plan ID").value).toBe("synthetic-plan");
  expect(selects("Event")).toHaveLength(2);
});

it("does not provision or save an invalid application draft", async () => {
  triggerSettings({
    configured: false,
    accounts: [
      {
        id: "planner",
        provider: "planner",
        connectorId: "native",
        status: "connected",
        displayName: "Planner",
      },
    ],
  });
  await openTriggers();
  await act(async () => routineInput("Webhook").click());
  await act(async () => button("Add application event").click());
  await act(async () => button("Save").click());
  expect(container.textContent).toContain("Check application event fields");
  expect(
    state.rpc.mock.calls.some(([p]) => p === "bots/rotateWebhookSecret" || p === "routines/update"),
  ).toBe(false);
});

it("does not save after a webhook provisioning response arrives in a different scope", async () => {
  triggerSettings({ configured: false });
  const delayed = deferred<unknown>();
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((p, input, options) =>
    p === "bots/rotateWebhookSecret" ? delayed.promise : normal(p, input, options),
  );
  await openTriggers();
  await act(async () => routineInput("Webhook").click());
  await act(async () => button("Save").click());
  state.spaceId = "space-2";
  await act(async () => root.render(<RoutineDetail />));
  await act(async () => delayed.resolve({ secret: "synthetic-secret" }));
  expect(state.rpc.mock.calls.some(([p]) => p === "routines/update")).toBe(false);
  expect(container.textContent).not.toContain("synthetic-secret");
});

it.each(["Webhook", "Git event", "Remove message trigger", "Remove application event"])(
  "removes only %s from a scheduled routine",
  async (label) => {
    const normal = state.rpc.getMockImplementation()!;
    const native = routineTriggerFixture({ kind: "planner.task.changed", planId: "fixture-plan" });
    state.rpc.mockImplementation(async (p, input, options) => {
      if (p === "routines/list")
        return [
          {
            ...(await normal(p))[0],
            crons: ["0 9 * * *"],
            webhookEnabled: true,
            githubEnabled: true,
            messageProvider: "slack",
            nativeTriggers: [native],
          },
        ];
      if (p === "routines/update") return { ...(await state.rpc("routines/list"))[0], ...input };
      return normal(p, input, options);
    });
    triggerSettings();
    await openTriggers();
    await act(async () =>
      label.startsWith("Remove") ? button(label).click() : routineInput(label).click(),
    );
    await act(async () => button("Save").click());
    const patch =
      label === "Webhook"
        ? { webhookEnabled: false }
        : label === "Git event"
          ? { githubEnabled: false }
          : label === "Remove message trigger"
            ? { messageProvider: null }
            : {
                nativeTriggers: [],
                nativeTriggerBaseline: [{ id: "fixture-trigger", version: 4 }],
              };
    expect(state.rpc.mock.calls.find(([p]) => p === "routines/update")?.[1]).toEqual({
      mutationId: expect.any(String),
      routineId: "routine-1",
      ...patch,
    });
  },
);

it.each(["Account", "Event", "Calendar target", "Notion target"])(
  "same %s selection preserves every draft field and identity",
  async (label) => {
    const spec: NativeRoutineEventSpec =
      label === "Notion target"
        ? {
            kind: "notion.comment_changed",
            target: {
              type: "discussion",
              pageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              discussionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              anchorBlockId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            },
          }
        : {
            kind: "calendar.event_starting",
            calendarId: "calendar",
            target: { kind: "single", eventId: "event" },
            leadMinutes: 23,
          };
    const draft = draftFromNativeRoutineTrigger(routineTriggerFixture(spec));
    const change = vi.fn();
    await act(async () =>
      root.render(
        <RoutineNativeEventFields
          draft={draft}
          rows={[
            {
              id: "fixture-connection",
              connectorId: "native",
              provider: nativeEventApp(spec),
              status: "connected",
              displayName: "Synthetic",
            } as never,
            {
              id: "fixture-second",
              connectorId: "native",
              provider: nativeEventApp(spec),
              status: "connected",
              displayName: "Second synthetic",
            } as never,
          ]}
          disabled={false}
          onChange={change}
          onRemove={() => {}}
        />,
      ),
    );
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    await act(async () => select.dispatchEvent(new Event("change", { bubbles: true })));
    expect(change).not.toHaveBeenCalled();
    // A genuine selection still resets dependent fields and retains saved identity.
    const next = [...select.options].find((o) => o.value && o.value !== select.value);
    if (next) {
      await act(async () => {
        select.value = next.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(change).toHaveBeenCalledWith(
        expect.objectContaining({
          id: draft.id,
          expectedVersion: draft.expectedVersion,
          key: draft.key,
          ...(label === "Notion target"
            ? { pageId: "", discussionId: "", anchorBlockId: "" }
            : { eventId: "" }),
        }),
      );
    }
  },
);
it("retries an ambiguous create with the same stable intent", async () => {
  state.params = { botId: "bot-1" };
  const normal = state.rpc.getMockImplementation()!;
  const identities = new Map<string, string>();
  let dropped = false;
  state.rpc.mockImplementation(async (p, input, options) => {
    if (p !== "routines/create") return normal(p, input, options);
    expect(input.mutationId).toEqual(expect.any(String));
    if (!identities.has(input.mutationId))
      identities.set(input.mutationId, `created-${identities.size}`);
    if (!dropped) {
      dropped = true;
      throw new Error("Response lost after commit");
    }
    return { ...input, id: identities.get(input.mutationId) };
  });
  await act(async () => root.render(<RoutineDetail />));
  await edit(routineInput("Name"), "Retry");
  await edit(routineInput("Prompt"), "Synthetic");
  await act(async () => button("Create").click());
  expect(container.textContent).toContain("Response lost after commit");
  await act(async () => button("Create").click());
  expect(identities.size).toBe(1);
});

it("retries a lost native-add update with one intent across refocus", async () => {
  const normal = state.rpc.getMockImplementation()!;
  let first: Record<string, unknown> | undefined;
  let dropped = false;
  triggerSettings({
    accounts: [
      {
        id: "fixture-connection",
        connectorId: "native",
        provider: "google-calendar",
        status: "connected",
        displayName: "Synthetic",
      },
    ],
  });
  const connected = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (p, input, options) => {
    if (p !== "routines/update") return connected(p, input, options);
    if (!first) first = input;
    else expect(input).toEqual(first);
    if (!dropped) {
      dropped = true;
      throw new Error("Response lost after commit");
    }
    return { ...(await normal("routines/list"))[0], nativeTriggers: [] };
  });
  await openTriggers();
  await act(async () => button("Add application event").click());
  const account = container.querySelector<HTMLSelectElement>('select[aria-label="Account"]')!;
  await act(async () => {
    account.value = "fixture-connection";
    account.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const event = container.querySelector<HTMLSelectElement>('select[aria-label="Event"]')!;
  await act(async () => {
    event.value = "calendar.event_changed";
    event.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await edit(routineInput("Calendar ID"), "synthetic-calendar");
  await act(async () => button("Save").click());
  expect(container.textContent).toContain("Response lost after commit");
  await refocus();
  expect(routineInput("Calendar ID").value).toBe("synthetic-calendar");
  await act(async () => button("Save").click());
  expect(first?.mutationId).toEqual(expect.any(String));
  expect(first?.nativeTriggerBaseline).toEqual([]);
});

it.each(["account", "space", "server"])(
  "does not reuse an uncertain create intent across %s scope",
  async (target) => {
    state.params = { botId: "bot-1" };
    const normal = state.rpc.getMockImplementation()!;
    const attempts: string[] = [];
    state.rpc.mockImplementation(async (p, input, options) => {
      if (p !== "routines/create") return normal(p, input, options);
      attempts.push(input.mutationId);
      throw new Error("Response lost after commit");
    });
    await act(async () => root.render(<RoutineDetail />));
    await edit(routineInput("Name"), "First");
    await edit(routineInput("Prompt"), "Synthetic");
    await act(async () => button("Create").click());
    await act(async () => {
      if (target === "account") state.sessionGeneration++;
      else if (target === "space") {
        state.spaceId = "space-2";
        state.spaceGeneration++;
      } else state.apiBase = "https://other.example.test";
      root.render(<RoutineDetail />);
    });
    await edit(routineInput("Name"), "Second");
    await edit(routineInput("Prompt"), "Synthetic");
    await act(async () => button("Create").click());
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts).size).toBe(2);
  },
);

it.each(["create", "update", "cancel"])(
  "recovers submitted %s before saving a later draft",
  async (mode) => {
    if (mode === "create") state.params = { botId: "bot-1" };
    const normal = state.rpc.getMockImplementation()!;
    const receipts = new Map<string, { input: string; result: Record<string, unknown> }>();
    const calls: Array<{ path: string; input: Record<string, unknown> }> = [];
    let lost = false;
    state.rpc.mockImplementation(async (path, input, options) => {
      if (path !== "routines/create" && path !== "routines/update")
        return normal(path, input, options);
      calls.push({ path, input: JSON.parse(JSON.stringify(input)) });
      const prior = receipts.get(input.mutationId);
      if (prior) {
        if (prior.input !== JSON.stringify(input)) throw new Error("CONFLICT");
        return prior.result;
      }
      const result = { ...(await normal("routines/list"))[0], ...input, id: "routine-1" };
      receipts.set(input.mutationId, { input: JSON.stringify(input), result });
      if (!lost) {
        lost = true;
        throw new Error("Response lost after commit");
      }
      return result;
    });
    await act(async () => root.render(<RoutineDetail />));
    if (mode !== "create") await act(async () => button("Edit").click());
    await edit(routineInput("Name"), "First save");
    await edit(routineInput("Prompt"), "First prompt");
    await act(async () => button(mode === "create" ? "Create" : "Save").click());
    if (mode === "cancel") {
      await act(async () => button("Cancel").click());
      await act(async () => button("Edit").click());
    }
    await edit(routineInput("Name"), "Later draft");
    await edit(routineInput("Prompt"), "Later prompt");
    await act(async () => button(mode === "create" ? "Create" : "Save").click());
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]!.path).toBe("routines/update");
    expect(calls[2]!.input).toMatchObject({
      routineId: "routine-1",
      name: "Later draft",
      prompt: "Later prompt",
    });
    expect(calls[2]!.input.mutationId).not.toBe(calls[0]!.input.mutationId);
    expect(receipts.size).toBe(2);
    expect(container.textContent).not.toContain("CONFLICT");
  },
);

it("keeps an uncertain create through authorization refusal and restored access", async () => {
  state.params = { botId: "bot-1" };
  const normal = state.rpc.getMockImplementation()!;
  let denied = false;
  const receipts = new Map<string, Record<string, unknown>>();
  const creates: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  state.rpc.mockImplementation(async (path, input, options) => {
    if (path === "routines/create") {
      if (denied) throw { code: "FORBIDDEN", message: "Permission revoked" };
      const previous = receipts.get(input.mutationId);
      if (previous) return previous;
      const saved = { ...input, id: `created-${creates.length}` };
      creates.push(saved);
      receipts.set(input.mutationId, saved);
      if (creates.length === 1) throw new Error("Lost response");
      return saved;
    }
    if (path === "routines/update") {
      updates.push(input);
      return { ...creates[0], ...input };
    }
    return normal(path, input, options);
  });
  await act(async () => root.render(<RoutineDetail />));
  await edit(routineInput("Name"), "First");
  await edit(routineInput("Prompt"), "First prompt");
  await act(async () => button("Create").click());
  denied = true;
  await act(async () => button("Create").click());
  expect(routineInput("Name").value).toBe("First");
  denied = false;
  await edit(routineInput("Name"), "Later");
  await edit(routineInput("Prompt"), "Later prompt");
  await act(async () => button("Create").click());
  expect(creates).toHaveLength(1);
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    routineId: creates[0]!.id,
    name: "Later",
    prompt: "Later prompt",
  });
});
