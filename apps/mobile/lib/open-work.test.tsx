// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OpenWork from "../app/open-work";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  params: { botId: "bot-1" },
  focused: true,
  scope: {
    apiBase: "https://api.example.test",
    apiGeneration: 0,
    sessionGeneration: 0,
    spaceId: "space-1" as string | null,
    spaceGeneration: 0,
    selectionSeq: 0,
  },
  listeners: new Set<() => void>(),
}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async () => ({
    apiBase: state.scope.apiBase,
    sessionGeneration: state.scope.sessionGeneration,
    headers: {},
  }),
}));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({ ...state.scope }),
  isMobileScopeCurrent: (scope: unknown) => JSON.stringify(scope) === JSON.stringify(state.scope),
  mobileScopeKey: () => JSON.stringify(state.scope),
  subscribeMobileScope: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => state.params,
  useFocusEffect: (effect: () => () => void) =>
    useEffect(() => (state.focused ? effect() : undefined), [effect, state.focused]),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Text: View,
    ActivityIndicator: () => <span>Loading</span>,
    StyleSheet: { create: (value: unknown) => value },
    TextInput: ({
      value,
      onChangeText,
      editable,
    }: {
      value: string;
      onChangeText: (value: string) => void;
      editable: boolean;
    }) => (
      <input
        aria-label="Draft"
        value={value}
        disabled={!editable}
        onChange={(event) => onChangeText(event.target.value)}
      />
    ),
  };
});
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ title, value }: { title: string; value?: string }) => (
    <span>
      {title} {value}
    </span>
  ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    children,
    actions,
    onPressAction,
  }: {
    children: ReactNode;
    actions: { id: string; title: string; attributes: { disabled: boolean } }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <div>
      {children}
      {actions.map((a) => (
        <button
          type="button"
          key={a.id}
          disabled={a.attributes.disabled}
          onClick={() => onPressAction({ nativeEvent: { event: a.id } })}
        >
          {a.title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("./native", () => ({ native: {}, useResolvedAppearance: () => "light" }));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});
const item = {
  id: "item-1",
  botId: "bot-1",
  title: "Synthetic task",
  status: "open",
  notes: "",
  createdAt: "",
  updatedAt: "",
};
let rows: (typeof item)[];
let root: Root;
let container: HTMLDivElement;
const render = async () => {
  await act(async () => root.render(<OpenWork />));
};
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
const click = async (label: string) => {
  await act(async () => button(label).click());
};
async function draft(text: string) {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.scope = {
    apiBase: "https://api.example.test",
    apiGeneration: 0,
    sessionGeneration: 0,
    spaceId: "space-1",
    spaceGeneration: 0,
    selectionSeq: 0,
  };
  state.params = { botId: "bot-1" };
  state.focused = true;
  rows = [];
  state.rpc.mockReset().mockImplementation(async (path: string, input: Record<string, string>) => {
    if (path === "me") return { spaceId: "space-1" };
    if (path === "bots/get") return { id: state.params.botId, spaceId: "space-1" };
    if (path === "scratchpad/list") return rows.filter((row) => row.status !== "done");
    if (path === "scratchpad/create") {
      rows = [{ ...item, title: input.title! }];
      return rows[0];
    }
    if (path === "scratchpad/update") {
      rows = rows.map((row) => ({ ...row, status: input.status! }));
      return rows[0];
    }
    if (path === "scratchpad/remove") {
      rows = [];
      return { ok: true };
    }
    throw new Error(path);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("adds, parks, reopens, completes and removes through the shared RPC with pinned Space", async () => {
  await render();
  await draft("Synthetic task");
  await click("Add");
  expect(container.textContent).toContain("Synthetic task");
  expect(container.querySelector("input")!.value).toBe("");
  await click("Park");
  expect(container.textContent).toContain("Parked");
  await click("Reopen");
  expect(rows[0]!.status).toBe("open");
  await click("Complete");
  expect(container.textContent).not.toContain("Synthetic task");
  expect(rows[0]!.status).toBe("done");
  await draft("Second task");
  await click("Add");
  await click("Remove");
  expect(rows).toEqual([]);
  for (const [, , options] of state.rpc.mock.calls)
    expect(options.requestContext.headers["x-rakazo-space-id"]).toBe("space-1");
});
it("preserves draft and confirmed rows on rejected writes, then reconciles on refresh", async () => {
  rows = [item];
  await render();
  await draft("Keep draft");
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((path, ...args) =>
    path === "scratchpad/create" || path === "scratchpad/update" || path === "scratchpad/remove"
      ? Promise.reject(new Error("denied"))
      : normal(path, ...args),
  );
  await click("Add");
  expect(container.querySelector("input")!.value).toBe("Keep draft");
  await click("Park");
  await click("Remove");
  expect(container.textContent).toContain("Synthetic task");
  expect(container.textContent).not.toContain("Parked");
  rows = [{ ...item, status: "parked" }];
  await click("Refresh");
  expect(container.textContent).toContain("Parked");
});
it.each(["apiGeneration", "sessionGeneration", "spaceGeneration", "selectionSeq"] as const)(
  "ignores a late mutation after %s ABA",
  async (field) => {
    await render();
    await draft("Old draft");
    const pending = deferred<typeof item>();
    const normal = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((path, ...args) =>
      path === "scratchpad/create" ? pending.promise : normal(path, ...args),
    );
    await click("Add");
    await act(async () => {
      state.scope[field] += 2;
      for (const listener of state.listeners) listener();
    });
    await act(async () => pending.resolve(item));
    expect(container.textContent).not.toContain("Synthetic task");
    expect(container.querySelector("input")!.value).toBe("");
  },
);
it("ignores a late list after switching Bot", async () => {
  const pending = deferred<(typeof item)[]>();
  state.rpc.mockImplementation(async (path) =>
    path === "bots/get"
      ? { id: state.params.botId, spaceId: "space-1" }
      : state.params.botId === "bot-1"
        ? pending.promise
        : [],
  );
  await render();
  state.params = { botId: "bot-2" };
  await render();
  await act(async () => pending.resolve([item]));
  expect(container.textContent).not.toContain("Synthetic task");
});
it("pins the default Space and does not mutate after an invalid Bot response", async () => {
  state.scope.spaceId = null;
  await render();
  await draft("Default space");
  await click("Add");
  expect(
    state.rpc.mock.calls.find(([path]) => path === "scratchpad/create")?.[2].requestContext.headers[
      "x-rakazo-space-id"
    ],
  ).toBe("space-1");
  state.params = { botId: "bot-2" };
  state.rpc.mockResolvedValue({ id: "bot-2", spaceId: "space-2" });
  await render();
  expect(container.textContent).toContain("Could not load open work");
  expect(container.querySelector("input")).toBeNull();
});
it.each([true, false])(
  "reconciles a pending write on focus return (settles before return: %s)",
  async (before) => {
    rows = [item];
    await render();
    const pending = deferred<typeof item>();
    const normal = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((path, ...args) =>
      path === "scratchpad/update" ? pending.promise : normal(path, ...args),
    );
    await click("Park");
    state.focused = false;
    await render();
    rows = [{ ...item, status: "parked" }];
    if (before) await act(async () => pending.resolve(rows[0]!));
    state.focused = true;
    await render();
    if (!before) await act(async () => pending.resolve(rows[0]!));
    expect(container.textContent).toContain("Parked");
    expect(button("Reopen").disabled).toBe(false);
  },
);

it("does not let an earlier refresh overwrite a confirmed mutation", async () => {
  rows = [item];
  await render();
  const pending = deferred<(typeof item)[]>();
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((path, ...args) =>
    path === "scratchpad/list" ? pending.promise : normal(path, ...args),
  );
  await click("Refresh");
  await click("Park");
  await act(async () => pending.resolve([item]));
  expect(container.textContent).toContain("Parked");
});
it("retains rows and draft on list failure and recovers without duplicate writes", async () => {
  rows = [item];
  await render();
  await draft("Keep me");
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((path, ...args) =>
    path === "scratchpad/list" ? Promise.reject(new Error("offline")) : normal(path, ...args),
  );
  await click("Refresh");
  expect(container.textContent).toContain("Could not load open work");
  expect(container.textContent).toContain("Synthetic task");
  expect(container.querySelector("input")!.value).toBe("Keep me");
  state.rpc.mockImplementation(normal);
  await click("Refresh");
  expect(container.textContent).not.toContain("Could not load open work");
  expect(state.rpc.mock.calls.some(([path]) => path === "scratchpad/create")).toBe(false);
});
