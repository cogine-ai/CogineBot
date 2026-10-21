// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Models from "../app/(settings)/models";
import RoutineDetail from "../app/routine";
import { resetI18nForTests } from "./i18n";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  spaceGeneration: 0,
  sessionGeneration: 0,
  focus: undefined as undefined | (() => (() => void) | undefined),
  blur: undefined as undefined | (() => void),
}));
const apiBase = "https://api.example.test";
vi.mock("./api", () => ({
  rpc: state.rpc,
  currentApiBase: () => apiBase,
  currentSpaceSelectionGeneration: () => state.spaceGeneration,
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async () => ({
    apiBase,
    spaceId: "space-1",
    sessionGeneration: state.sessionGeneration,
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => state.sessionGeneration }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: vi.fn() }),
  useLocalSearchParams: () => ({ botId: "bot-1", routineId: "routine-1" }),
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
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
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
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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
