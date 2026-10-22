// @vitest-environment jsdom

import { modelOptionKey } from "@rakazo/core";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Models from "../app/(settings)/models";
import RoutineDetail from "../app/routine";
import { resetI18nForTests } from "./i18n";
import { presentMessageActionSheet } from "./message-action-sheet";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  params: { botId: "bot-1", routineId: "routine-1" },
  apiBase: "https://api.example.test",
  spaceGeneration: 0,
  sessionGeneration: 0,
  focus: undefined as undefined | (() => (() => void) | undefined),
  blur: undefined as undefined | (() => void),
}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  currentApiBase: () => state.apiBase,
  currentSpaceSelectionGeneration: () => state.spaceGeneration,
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async () => ({
    apiBase: state.apiBase,
    spaceId: "space-1",
    sessionGeneration: state.sessionGeneration,
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => state.sessionGeneration }));
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
    }: {
      children?: ReactNode;
      onPress: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
    }) => (
      <button type="button" disabled={disabled} aria-label={accessibilityLabel} onClick={onPress}>
        {children}
      </button>
    ),
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      editable,
    }: {
      accessibilityLabel?: string;
      value: string;
      onChangeText: (value: string) => void;
      editable?: boolean;
    }) => (
      <input
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
  state.params = { botId: "bot-1", routineId: "routine-1" };
  state.apiBase = "https://api.example.test";
  state.spaceGeneration = 0;
  state.sessionGeneration = 0;
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
