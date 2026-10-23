// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileScope } from "./mobile-scope";

const fake = vi.hoisted(() => ({
  rpc: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  alert: vi.fn(),
  params: { groupId: "group-one" },
  scope: {
    apiBase: "https://example.test",
    apiGeneration: 1,
    sessionGeneration: 1,
    spaceId: "space-one" as string | null,
    spaceGeneration: 1,
    selectionSeq: 1,
  },
  listeners: new Set<() => void>(),
  selecting: false,
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(value: T) => value },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    placeholder,
    editable = true,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    accessibilityLabel?: string;
    placeholder?: string;
    editable?: boolean;
  }) => (
    <input
      aria-label={accessibilityLabel ?? placeholder}
      disabled={!editable}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
  Alert: { alert: fake.alert },
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => fake.params,
  useRouter: () => ({ replace: fake.replace, back: fake.back }),
}));
vi.mock("./api", () => ({
  rpc: fake.rpc,
  isSpaceSelectionPending: () => fake.selecting,
  subscribeSpaceSelectionPending: (listener: () => void) => {
    fake.listeners.add(listener);
    return () => fake.listeners.delete(listener);
  },
  captureApiRequestContext: async () => ({
    apiBase: fake.scope.apiBase,
    sessionGeneration: fake.scope.sessionGeneration,
    headers: { "x-rakazo-space-id": fake.scope.spaceId ?? undefined },
  }),
}));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({ ...fake.scope }),
  mobileScopeKey: () => JSON.stringify(fake.scope),
  subscribeMobileScope: (listener: () => void) => {
    fake.listeners.add(listener);
    return () => fake.listeners.delete(listener);
  },
  isMobileScopeCurrent: (scope: MobileScope) =>
    JSON.stringify(scope) === JSON.stringify(fake.scope),
}));
vi.mock("./native", () => ({
  native: { fill: "fill" },
  useMobileTokens: () => ({
    background: "background",
    foreground: "text",
    mutedForeground: "muted",
    border: "border",
    primary: "primary",
    primaryForeground: "background",
    destructive: "error",
  }),
}));
vi.mock("./i18n", () => {
  const t = (value: string, params?: Record<string, unknown>) =>
    value.replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? key));
  return { t, useI18n: () => ({ t }) };
});
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => <span /> }));
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
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
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    disabled,
    value,
    onValueChange,
  }: {
    accessibilityLabel: string;
    disabled?: boolean;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={accessibilityLabel}
      disabled={disabled}
      checked={value}
      onChange={() => onValueChange(!value)}
    />
  ),
}));

import GroupSettingsScreen from "../app/group-settings";
import NewGroup from "../app/new-group";

const bots = [
  { id: "one", name: "Researcher", title: "Market analyst" },
  { id: "two", name: "Writer", title: "Editor" },
  { id: "three", name: "Planner", title: "Travel coordinator" },
].map((bot) => ({ ...bot, spaceId: "space-one", color: "blue", status: "idle", archivedAt: null }));
const group = {
  id: "group-one",
  spaceId: "space-one",
  name: "Review",
  members: [
    { botId: "one", name: "Researcher", color: "blue" },
    { botId: "two", name: "Writer", color: "blue" },
  ],
};
let root: Root;
let container: HTMLDivElement;
async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
function field(name: string) {
  const found = container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
function button(name: string) {
  const found = [...container.querySelectorAll("button")].find((row) => row.textContent === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function choose(name: string) {
  await act(async () => field(name).click());
}
async function fill(name: string, value: string) {
  await act(async () => {
    const input = field(name);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.rpc
    .mockReset()
    .mockImplementation(async (method: string) =>
      method === "bots/list" ? bots : method === "groups/list" ? [group] : undefined,
    );
  fake.replace.mockReset();
  fake.back.mockReset();
  fake.alert.mockReset();
  fake.listeners.clear();
  fake.scope = {
    apiBase: "https://example.test",
    apiGeneration: 1,
    sessionGeneration: 1,
    spaceId: "space-one",
    spaceGeneration: 1,
    selectionSeq: 1,
  };
  fake.params = { groupId: "group-one" };
  fake.selecting = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("starts creation with all members and locks names and choices while creating", async () => {
  const pending = deferred<{ id: string; name: string }>();
  fake.rpc.mockImplementation(async (method: string) =>
    method === "bots/list" ? bots : pending.promise,
  );
  await render(<NewGroup />);
  expect(field("Filter bots")).toBeDefined();
  await fill("Name this group", "Team");
  await choose("Researcher");
  await choose("Writer");
  await click("Create group");
  expect(field("Name this group").disabled).toBe(true);
  expect(field("Researcher").disabled).toBe(true);
  expect(button("Show selected").disabled).toBe(true);
  await act(async () => pending.resolve({ id: "created", name: "Team" }));
  expect(fake.replace).toHaveBeenCalledOnce();
});
it("mounts loaded edit members selected-first and confirms the original roster on save", async () => {
  const loading = deferred<(typeof group)[]>();
  const saving = deferred<typeof group>();
  fake.rpc.mockImplementation(async (method: string) =>
    method === "groups/list" ? loading.promise : method === "bots/list" ? bots : saving.promise,
  );
  await render(<GroupSettingsScreen />);
  expect(container.querySelector('[aria-label="Researcher"]')).toBeNull();
  await act(async () => loading.resolve([group]));
  expect(field("Researcher").checked).toBe(true);
  expect(container.querySelector('[aria-label="Planner"]')).toBeNull();
  await click("Show all");
  await choose("Writer");
  await choose("Planner");
  await click("Save");
  expect(fake.rpc).toHaveBeenCalledWith(
    "groups/update",
    { groupId: "group-one", botIds: ["one", "three"], expectedBotIds: ["one", "two"] },
    expect.anything(),
  );
  expect(field("Group name").disabled).toBe(true);
  expect(button("Delete group").disabled).toBe(true);
  await act(async () =>
    saving.resolve({
      ...group,
      members: [group.members[0]!, { botId: "three", name: "Planner", color: "blue" }],
    }),
  );
  expect(fake.back).toHaveBeenCalledOnce();
});
it("retries an unchanged creation with the same nonce and starts a new intent separately", async () => {
  const creates: Array<{ name: string; botIds: string[]; clientNonce?: string }> = [];
  fake.rpc.mockImplementation(
    async (method: string, input: { name: string; botIds: string[]; clientNonce?: string }) => {
      if (method === "bots/list") return bots;
      if (method === "groups/create") {
        creates.push(input);
        throw new Error("Receipt unavailable");
      }
      return undefined;
    },
  );
  await render(<NewGroup />);
  await fill("Name this group", "Team");
  await choose("Researcher");
  await choose("Writer");
  await click("Create group");
  await click("Create group");
  expect(creates).toHaveLength(2);
  expect(creates[0]?.clientNonce).toBeTruthy();
  expect(creates[1]).toEqual(creates[0]);
  await fill("Name this group", "Other team");
  await click("Create group");
  expect(creates[2]?.clientNonce).not.toBe(creates[0]?.clientNonce);
  expect(fake.replace).not.toHaveBeenCalled();
});
it("discards a creation receipt after the editor changes Space and clears the old form", async () => {
  const pending = deferred<{ id: string; name: string }>();
  fake.rpc.mockImplementation(async (method: string) =>
    method === "bots/list" ? bots : pending.promise,
  );
  await render(<NewGroup />);
  await fill("Name this group", "Team");
  await choose("Researcher");
  await choose("Writer");
  await click("Create group");
  await act(async () => {
    fake.scope = { ...fake.scope, spaceId: "space-two", spaceGeneration: 2, selectionSeq: 2 };
    for (const listener of fake.listeners) listener();
  });
  expect(field("Name this group").value).toBe("");
  await act(async () => pending.resolve({ id: "old-group", name: "Team" }));
  expect(fake.replace).not.toHaveBeenCalled();
});
it("confirms a lost member receipt once without replaying the saved roster", async () => {
  const saved = {
    ...group,
    members: [...group.members, { botId: "three", name: "Planner", color: "blue" }],
  };
  fake.rpc.mockImplementation(async (method: string) => {
    if (method === "groups/list") return [group];
    if (method === "bots/list") return bots;
    if (method === "groups/update") throw new TypeError("Network request failed");
    if (method === "groups/get") return saved;
    return undefined;
  });
  await render(<GroupSettingsScreen />);
  await click("Show all");
  await choose("Planner");
  await click("Save");
  expect(fake.back).toHaveBeenCalledOnce();
  expect(fake.rpc.mock.calls.filter(([method]) => method === "groups/update")).toHaveLength(1);
  expect(fake.rpc.mock.calls.filter(([method]) => method === "groups/get")).toHaveLength(1);
});
it("retries a failed confirmation read before issuing another member mutation", async () => {
  let reads = 0;
  const saved = {
    ...group,
    members: [...group.members, { botId: "three", name: "Planner", color: "blue" }],
  };
  fake.rpc.mockImplementation(async (method: string) => {
    if (method === "groups/list") return [group];
    if (method === "bots/list") return bots;
    if (method === "groups/update") throw new TypeError("Network request failed");
    if (method === "groups/get") {
      if (++reads === 1) throw new TypeError("Network request failed");
      return saved;
    }
    return undefined;
  });
  await render(<GroupSettingsScreen />);
  await click("Show all");
  await choose("Planner");
  await click("Save");
  expect(fake.back).not.toHaveBeenCalled();
  expect(field("Planner").checked).toBe(true);
  await click("Save");
  expect(fake.back).toHaveBeenCalledOnce();
  expect(reads).toBe(2);
  expect(fake.rpc.mock.calls.filter(([method]) => method === "groups/update")).toHaveLength(1);
});
it("keeps a definitive member conflict visible without confirming or rebasing it", async () => {
  fake.rpc.mockImplementation(async (method: string) => {
    if (method === "groups/list") return [group];
    if (method === "bots/list") return bots;
    if (method === "groups/update")
      throw Object.assign(new Error("Group members changed. Refresh and try again."), {
        status: 409,
      });
    throw new Error("No read after a definitive conflict");
  });
  await render(<GroupSettingsScreen />);
  await click("Show all");
  await choose("Planner");
  await click("Save");
  expect(container.textContent).toContain("Group members changed");
  expect(field("Planner").checked).toBe(true);
  expect(fake.back).not.toHaveBeenCalled();
  expect(fake.rpc.mock.calls.filter(([method]) => method === "groups/get")).toHaveLength(0);
  await click("Save");
  const writes = fake.rpc.mock.calls.filter(([method]) => method === "groups/update");
  expect(writes).toHaveLength(2);
  expect(writes[0]?.[1]).toEqual(writes[1]?.[1]);
  expect(writes[1]?.[1].expectedBotIds).toEqual(["one", "two"]);
});
it("refuses a different authoritative receipt on every retry without another write", async () => {
  fake.rpc.mockImplementation(async (method: string) => {
    if (method === "groups/list") return [group];
    if (method === "bots/list") return bots;
    if (method === "groups/update") throw new TypeError("Network request failed");
    if (method === "groups/get")
      return {
        ...group,
        members: [group.members[0]!, { botId: "three", name: "Planner", color: "blue" }],
      };
    return undefined;
  });
  await render(<GroupSettingsScreen />);
  await click("Show all");
  await choose("Planner");
  await click("Save");
  await click("Save");
  expect(fake.back).not.toHaveBeenCalled();
  expect(field("Writer").checked).toBe(true);
  expect(field("Planner").checked).toBe(true);
  expect(fake.rpc.mock.calls.filter(([method]) => method === "groups/update")).toHaveLength(1);
  expect(fake.rpc.mock.calls.filter(([method]) => method === "groups/get")).toHaveLength(1);
});
it("does not apply a saved receipt to a new editor after the Space changes", async () => {
  const confirmation = deferred<typeof group>();
  fake.rpc.mockImplementation(async (method: string) => {
    if (method === "groups/list") return fake.scope.spaceId === "space-one" ? [group] : [];
    if (method === "bots/list") return bots;
    if (method === "groups/update") throw new TypeError("Network request failed");
    if (method === "groups/get") return confirmation.promise;
    return undefined;
  });
  await render(<GroupSettingsScreen />);
  await click("Show all");
  await choose("Planner");
  await click("Save");
  expect(fake.rpc.mock.calls.filter(([method]) => method === "groups/get")).toHaveLength(1);
  await act(async () => {
    fake.scope = { ...fake.scope, spaceId: "space-two", spaceGeneration: 2, selectionSeq: 2 };
    for (const listener of fake.listeners) listener();
  });
  await act(async () =>
    confirmation.resolve({
      ...group,
      members: [...group.members, { botId: "three", name: "Planner", color: "blue" }],
    }),
  );
  expect(fake.back).not.toHaveBeenCalled();
  expect(fake.replace).not.toHaveBeenCalled();
  expect(field("Group name").value).toBe("");
});
it("drops an old group's delayed load when the route opens another group", async () => {
  const first = deferred<(typeof group)[]>();
  const second = {
    ...group,
    id: "group-two",
    name: "Other team",
    members: [group.members[0]!, { botId: "three", name: "Planner", color: "blue" }],
  };
  let groupReads = 0;
  fake.rpc.mockImplementation(async (method: string) =>
    method === "groups/list" ? (++groupReads === 1 ? first.promise : [second]) : bots,
  );
  await render(<GroupSettingsScreen />);
  fake.params = { groupId: "group-two" };
  await render(<GroupSettingsScreen />);
  expect(field("Group name").value).toBe("Other team");
  await act(async () => first.resolve([group]));
  expect(field("Group name").value).toBe("Other team");
  expect(container.querySelector('[aria-label="Writer"]')).toBeNull();
});
it("binds default-Space group operations to the verified target without selecting it globally", async () => {
  fake.scope = { ...fake.scope, spaceId: null };
  const saved = {
    ...group,
    members: [...group.members, { botId: "three", name: "Planner", color: "blue" }],
  };
  fake.rpc.mockImplementation(async (method: string) =>
    method === "me"
      ? { spaceId: "space-one" }
      : method === "groups/list"
        ? [group]
        : method === "bots/list"
          ? bots
          : saved,
  );
  await render(<GroupSettingsScreen />);
  await click("Show all");
  await choose("Planner");
  await click("Save");
  const write = fake.rpc.mock.calls.find(([method]) => method === "groups/update");
  expect(write?.[2].requestContext.headers["x-rakazo-space-id"]).toBe("space-one");
  expect(fake.scope.spaceId).toBeNull();
  expect(fake.back).toHaveBeenCalledOnce();
});

it("waits for a pending Space selection to settle before loading either group editor", async () => {
  fake.selecting = true;
  await render(<NewGroup />);
  expect(fake.rpc).not.toHaveBeenCalled();
  await act(async () => {
    fake.selecting = false;
    for (const listener of fake.listeners) listener();
  });
  expect(field("Researcher")).toBeDefined();
  await act(async () => root.render(<div />));
  fake.rpc.mockClear();
  fake.selecting = true;
  await render(<GroupSettingsScreen />);
  expect(fake.rpc).not.toHaveBeenCalled();
  await act(async () => {
    fake.selecting = false;
    for (const listener of fake.listeners) listener();
  });
  expect(field("Researcher").checked).toBe(true);
});
