// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SpaceSettings from "../app/(settings)/space-settings";
import { resetI18nForTests } from "./i18n";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  params: { spaceId: "space-b", name: "Research" },
  selectedSpace: "space-a",
  sessionGeneration: 0,
  listeners: new Set<() => void>(),
}));

vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async () => ({
    apiBase: "https://api.example.test",
    sessionGeneration: state.sessionGeneration,
    headers: { "x-rakazo-space-id": state.selectedSpace },
  }),
  currentApiBase: () => "https://api.example.test",
  currentApiBaseGeneration: () => 0,
  currentSpaceSelectionGeneration: () => 0,
  selectedSpaceId: () => state.selectedSpace,
  spaceSelectionSeq: () => 0,
  subscribeApiBase: () => () => {},
  subscribeSelectedSpace: () => () => {},
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.sessionGeneration,
  subscribeSessionGeneration: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => state.params,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    View: view,
    ScrollView: view,
    Text: view,
    ActivityIndicator: () => createElement("span", { role: "progressbar" }),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 0.5 },
    useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
    Pressable: (props: {
      children?: ReactNode;
      accessibilityLabel?: string;
      disabled?: boolean;
      onPress?: () => void;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          "aria-label": props.accessibilityLabel,
          disabled: props.disabled,
          onClick: props.onPress,
        },
        props.children,
      ),
    Switch: (props: {
      accessibilityLabel?: string;
      accessibilityHint?: string;
      value: boolean;
      disabled?: boolean;
      onValueChange: (value: boolean) => void;
    }) =>
      createElement("input", {
        type: "checkbox",
        role: "switch",
        "aria-label": props.accessibilityLabel,
        "aria-description": props.accessibilityHint,
        checked: props.value,
        disabled: props.disabled,
        onChange: () => props.onValueChange(!props.value),
      }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: <T,>(factory: () => T) => factory(),
  useMobileTokens: () => ({}),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));

let root: Root | undefined;
let container: HTMLDivElement;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const ownerPolicy = {
  id: "space-b",
  allowBotCollaboration: true,
  collaborationRevision: 4,
  canManageCollaboration: true,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetI18nForTests("en");
  state.params = { spaceId: "space-b", name: "Research" };
  state.selectedSpace = "space-a";
  state.sessionGeneration = 0;
  state.rpc.mockReset().mockImplementation(async (name: string) => {
    if (name === "me") return { userId: "user-1", spaceId: state.params.spaceId };
    if (name === "spaces/list") return { spaces: [{ ...ownerPolicy }] };
    throw new Error(`Unexpected procedure: ${name}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root?.render(<SpaceSettings />));
}

function toggle() {
  const control = container.querySelector<HTMLInputElement>('[role="switch"]');
  expect(control, "Bot collaboration native switch").not.toBeNull();
  return control!;
}

function button(label: string) {
  const control = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
  expect(control, `${label} action`).toBeDefined();
  return control!;
}

it("lets the Space owner change fresh policy with its revision and shows the running-work hint only while disabling", async () => {
  const update = deferred<unknown>();
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string, ...args: unknown[]) =>
    name === "spaces/update" ? update.promise : normal(name, ...args),
  );
  await render();
  expect(toggle().checked).toBe(true);
  expect(toggle().disabled).toBe(false);
  expect(toggle().getAttribute("aria-label")).toBe("Bot collaboration");
  expect(container.textContent).not.toContain("Work already running may finish.");

  await act(async () => toggle().click());
  expect(toggle().checked).toBe(false);
  expect(toggle().disabled).toBe(true);
  expect(container.textContent).toContain("Work already running may finish.");
  const request = state.rpc.mock.calls.find(([name]) => name === "spaces/update");
  expect(request?.[1]).toEqual({
    spaceId: "space-b",
    allowBotCollaboration: false,
    expectedCollaborationRevision: 4,
  });
  expect(request?.[2].requestContext.headers["x-rakazo-space-id"]).toBe("space-b");

  await act(async () =>
    update.resolve({
      spaceId: "space-b",
      allowBotCollaboration: false,
      collaborationRevision: 5,
      canManageCollaboration: true,
    }),
  );
  expect(toggle().checked).toBe(false);
  expect(toggle().disabled).toBe(false);
  expect(container.textContent).not.toContain("Work already running may finish.");
  expect(container.textContent).not.toContain("Retry");
});

it("preserves the owner's intent after a conflict and requires fresh readback before a manual save", async () => {
  let revision = 4;
  let writes = 0;
  state.rpc.mockImplementation(async (name: string) => {
    if (name === "me") return { userId: "user-1", spaceId: "space-b" };
    if (name === "spaces/list")
      return { spaces: [{ ...ownerPolicy, collaborationRevision: revision }] };
    if (name === "spaces/update") {
      writes += 1;
      if (writes === 1) throw Object.assign(new Error("Conflict"), { code: "CONFLICT" });
      return {
        spaceId: "space-b",
        allowBotCollaboration: false,
        collaborationRevision: 8,
        canManageCollaboration: true,
      };
    }
    throw new Error(`Unexpected procedure: ${name}`);
  });
  await render();
  await act(async () => toggle().click());
  expect(toggle().checked).toBe(false);
  expect(toggle().disabled).toBe(true);

  revision = 7;
  await act(async () => button("Refresh").click());
  expect(toggle().checked).toBe(false);
  expect(writes).toBe(1);
  await act(async () => button("Save").click());
  expect(state.rpc.mock.calls.filter(([name]) => name === "spaces/update")[1]?.[1]).toEqual({
    spaceId: "space-b",
    allowBotCollaboration: false,
    expectedCollaborationRevision: 7,
  });
  expect(toggle().checked).toBe(false);
  expect(toggle().disabled).toBe(false);
  expect(container.textContent).not.toContain("Save");
});

it("shows members the current policy without letting deployment ownership authorize changes", async () => {
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string, ...args: unknown[]) => {
    if (name === "spaces/list")
      return { spaces: [{ ...ownerPolicy, canManageCollaboration: false, deploymentOwner: true }] };
    return normal(name, ...args);
  });
  await render();
  expect(toggle().checked).toBe(true);
  expect(toggle().disabled).toBe(true);
  expect(container.textContent).toContain("Only the Space owner can change this.");
  await act(async () => toggle().click());
  expect(state.rpc.mock.calls.filter(([name]) => name === "spaces/update")).toHaveLength(0);
});

it.each(["allowBotCollaboration", "collaborationRevision", "canManageCollaboration"])(
  "does not authorize a cached or old list missing %s",
  async (missing) => {
    const incomplete: Record<string, unknown> = { ...ownerPolicy, deploymentOwner: true };
    delete incomplete[missing];
    const normal = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((name: string, ...args: unknown[]) =>
      name === "spaces/list" ? { spaces: [incomplete] } : normal(name, ...args),
    );
    await render();
    expect(toggle().disabled).toBe(true);
    expect(button("Refresh")).toBeDefined();
    await act(async () => toggle().click());
    expect(state.rpc.mock.calls.filter(([name]) => name === "spaces/update")).toHaveLength(0);
  },
);

it.each([
  ["unknown", undefined],
  [
    "wrong Space",
    {
      spaceId: "space-c",
      allowBotCollaboration: false,
      collaborationRevision: 5,
      canManageCollaboration: true,
    },
  ],
  [
    "unchanged revision",
    {
      spaceId: "space-b",
      allowBotCollaboration: false,
      collaborationRevision: 4,
      canManageCollaboration: true,
    },
  ],
  [
    "different intent",
    {
      spaceId: "space-b",
      allowBotCollaboration: true,
      collaborationRevision: 5,
      canManageCollaboration: true,
    },
  ],
] as const)(
  "requires readback after an %s receipt without overwriting the draft",
  async (_kind, receipt) => {
    const normal = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((name: string, ...args: unknown[]) =>
      name === "spaces/update" ? receipt : normal(name, ...args),
    );
    await render();
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(true);
    expect(button("Refresh")).toBeDefined();
    expect(container.textContent).not.toContain("Save");
    await act(async () => button("Refresh").click());
    expect(toggle().checked).toBe(false);
    expect(button("Save")).toBeDefined();
    expect(state.rpc.mock.calls.filter(([name]) => name === "spaces/update")).toHaveLength(1);
  },
);

it("clears the recovery action after matching fresh readback without replaying an unknown save", async () => {
  let applied = false;
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string, ...args: unknown[]) => {
    if (name === "spaces/update") {
      applied = true;
      return undefined;
    }
    if (name === "spaces/list" && applied)
      return {
        spaces: [{ ...ownerPolicy, allowBotCollaboration: false, collaborationRevision: 5 }],
      };
    return normal(name, ...args);
  });
  await render();
  await act(async () => toggle().click());
  await act(async () => button("Refresh").click());
  expect(toggle().checked).toBe(false);
  expect(toggle().disabled).toBe(false);
  expect(container.textContent).not.toContain("Refresh");
  expect(container.textContent).not.toContain("Save");
  expect(state.rpc.mock.calls.filter(([name]) => name === "spaces/update")).toHaveLength(1);
});

it("shows fresh server policy when readback removes the owner's editing capability", async () => {
  let canManage = true;
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string, ...args: unknown[]) => {
    if (name === "spaces/update") {
      canManage = false;
      return undefined;
    }
    if (name === "spaces/list")
      return { spaces: [{ ...ownerPolicy, canManageCollaboration: canManage }] };
    return normal(name, ...args);
  });
  await render();
  await act(async () => toggle().click());
  expect(toggle().checked).toBe(false);
  await act(async () => button("Refresh").click());
  expect(toggle().checked).toBe(true);
  expect(toggle().disabled).toBe(true);
  expect(container.textContent).toContain("Only the Space owner can change this.");
  expect(container.textContent).not.toContain("Save");
  expect(state.rpc.mock.calls.filter(([name]) => name === "spaces/update")).toHaveLength(1);
});

it.each(["Space", "account"])("ignores a late save after the %s changes", async (change) => {
  const update = deferred<unknown>();
  let switched = false;
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string, ...args: unknown[]) => {
    if (name === "spaces/update") return update.promise;
    if (name === "spaces/list" && switched)
      return {
        spaces: [{ ...ownerPolicy, id: state.params.spaceId, collaborationRevision: 20 }],
      };
    return normal(name, ...args);
  });
  await render();
  await act(async () => toggle().click());
  switched = true;
  if (change === "Space") {
    state.params = { spaceId: "space-c", name: "Planning" };
    await render();
  } else {
    await act(async () => {
      state.sessionGeneration += 1;
      for (const listener of state.listeners) listener();
    });
  }
  expect(toggle().checked).toBe(true);
  await act(async () =>
    update.resolve({
      spaceId: "space-b",
      allowBotCollaboration: false,
      collaborationRevision: 5,
      canManageCollaboration: true,
    }),
  );
  expect(toggle().checked).toBe(true);
  expect(toggle().disabled).toBe(false);
  expect(container.textContent).not.toContain("Refresh");
});
