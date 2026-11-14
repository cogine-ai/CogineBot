// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Board from "../app/board";
import { useTicketBoardCapability } from "./ticket-board";

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
  Redirect: () => <span>Home redirect</span>,
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
      accessibilityLabel,
    }: {
      value: string;
      onChangeText: (value: string) => void;
      editable: boolean;
      accessibilityLabel: string;
    }) => (
      <input
        aria-label={accessibilityLabel}
        value={value}
        disabled={!editable}
        onChange={(event) => onChangeText(event.target.value)}
      />
    ),
  };
});
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    title,
    value,
    onPress,
  }: {
    title: string;
    value?: string;
    onPress?: () => void;
  }) =>
    onPress ? (
      <button type="button" onClick={onPress}>
        {title}
      </button>
    ) : (
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
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("./native", () => ({ native: {}, useResolvedAppearance: () => "light" }));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    label,
    choices,
    value,
    onChange,
    disabled,
  }: {
    label: string;
    choices: { key: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
    disabled: boolean;
  }) => (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.label}
        </option>
      ))}
    </select>
  ),
}));
const initial = {
  id: "ticket-1",
  spaceId: "space-1",
  boardId: "board-1",
  ref: "WORK-1",
  number: 1,
  title: "Synthetic task",
  description: "Draft details",
  priority: "normal",
  status: "todo",
  assigneeBotId: "bot-1",
  createdByBotId: null,
  createdByUserId: "user-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  completedAt: null,
};
let tickets: (typeof initial)[];
let comments: { id: string; ticketId: string; body: string; authorName: string }[];
let enabled: boolean;
let root: Root;
let container: HTMLDivElement;
function Entry() {
  const capability = useTicketBoardCapability();
  return capability.enabled === true ? <button type="button">Board entry</button> : null;
}
const render = async (entry = false) => {
  await act(async () => root.render(entry ? <Entry /> : <Board />));
};
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
const click = async (label: string) => {
  await act(async () => button(label).click());
};
async function input(label: string, value: string) {
  await act(async () => {
    const node = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(label: string, value: string) {
  await act(async () => {
    const node = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
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
async function switchSpace() {
  await act(async () => {
    state.scope = {
      ...state.scope,
      spaceId: "space-2",
      spaceGeneration: state.scope.spaceGeneration + 1,
    };
    state.listeners.forEach((listener) => {
      listener();
    });
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  state.scope = {
    apiBase: "https://api.example.test",
    apiGeneration: 0,
    sessionGeneration: 0,
    spaceId: "space-1",
    spaceGeneration: 0,
    selectionSeq: 0,
  };
  state.focused = true;
  enabled = true;
  tickets = [{ ...initial }];
  comments = [];
  state.rpc
    .mockReset()
    .mockImplementation(
      async (
        path: string,
        data: Record<string, string>,
        options: { requestContext: { headers: Record<string, string> } },
      ) => {
        const spaceId = options.requestContext.headers["x-rakazo-space-id"] ?? "space-1";
        if (path === "me") return { spaceId: spaceId ?? "space-1", ticketBoardEnabled: enabled };
        if (path === "bots/list")
          return [
            { id: "bot-1", name: "Planner", spaceId },
            { id: "bot-2", name: "Reviewer", spaceId },
          ];
        if (path === "tickets/list")
          return { tickets: tickets.filter((row) => row.spaceId === spaceId) };
        if (path === "tickets/comments") return comments;
        if (path === "tickets/create") {
          const row = { ...initial, ...data, spaceId, id: "ticket-new" };
          tickets.push(row);
          return row;
        }
        if (path === "tickets/update") {
          tickets = tickets.map((row) => (row.id === data.id ? { ...row, ...data } : row));
          return tickets.find((row) => row.id === data.id);
        }
        if (path === "tickets/comment") {
          const row = {
            id: "comment-1",
            ticketId: data.ticketId!,
            body: data.body!,
            authorName: "Test author",
          };
          comments.push(row);
          return row;
        }
        throw new Error(`Unexpected ${path}`);
      },
    );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([false, true])("gates entry with the backend capability (%s)", async (value) => {
  enabled = value;
  await render(true);
  expect(Boolean(button("Board entry"))).toBe(value);
});
it("blocks disabled direct links without loading tickets", async () => {
  enabled = false;
  await render();
  expect(container.textContent).toContain("Home redirect");
  expect(state.rpc.mock.calls.some(([path]) => path.startsWith("tickets/"))).toBe(false);
});
it("fails closed on capability failure and supports retry", async () => {
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await render();
  expect(button("New ticket")).toBeUndefined();
  await click("Try again.");
  expect(button("New ticket")).toBeDefined();
});
it("creates, reopens, edits every field and posts a comment through shared routes", async () => {
  await render();
  await click("New ticket");
  expect(button("Create").disabled).toBe(true);
  await input("Title", "New synthetic ticket");
  await input("Description", "Synthetic description");
  await select("Owner", "bot-2");
  await select("Priority", "high");
  await click("Create");
  await click("New synthetic ticket");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Description"]')!.value).toBe(
    "Synthetic description",
  );
  await input("Title", "Edited synthetic ticket");
  await input("Description", "Updated description");
  await select("Owner", "bot-1");
  await select("Priority", "urgent");
  await select("Status", "review");
  await click("Save");
  expect(tickets.find((row) => row.id === "ticket-new")).toMatchObject({
    title: "Edited synthetic ticket",
    description: "Updated description",
    priority: "urgent",
    status: "review",
    assigneeBotId: "bot-1",
  });
  await click("Edited synthetic ticket");
  expect(button("Comment").disabled).toBe(true);
  await input("Comment", "Synthetic comment");
  await click("Comment");
  expect(container.textContent).toContain("Synthetic comment");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Comment"]')!.value).toBe("");
  await click("Cancel");
  await act(async () => root.render(null));
  await render();
  await click("Edited synthetic ticket");
  expect(container.textContent).toContain("Synthetic comment");
  for (const [path, , options] of state.rpc.mock.calls) {
    if (path.startsWith("tickets/"))
      expect(options.requestContext.headers["x-rakazo-space-id"]).toBe("space-1");
  }
});
it.each(["Create", "Save", "Comment"])(
  "retains input after %s fails and allows retry",
  async (action) => {
    await render();
    await click(action === "Create" ? "New ticket" : "Synthetic task");
    const label = action === "Comment" ? "Comment" : "Title";
    await input(label, "   ");
    expect(button(action).disabled).toBe(true);
    await input(label, "Retained draft");
    state.rpc.mockRejectedValueOnce(new Error("Save failed"));
    await click(action);
    expect(container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.value).toBe(
      "Retained draft",
    );
    expect(button(action).disabled).toBe(false);
    await click(action);
    expect(container.textContent).toContain("Retained draft");
  },
);
it("clears old data and ignores pending list responses after changing Space", async () => {
  await render();
  const pending = deferred<{ tickets: typeof tickets }>();
  state.rpc.mockImplementationOnce(() => pending.promise);
  await click("Refresh");
  await switchSpace();
  expect(container.textContent).not.toContain("Synthetic task");
  await act(async () => pending.resolve({ tickets: [{ ...initial, title: "Late old Space" }] }));
  expect(container.textContent).not.toContain("Late old Space");
  await click("New ticket");
  await input("Title", "Space two");
  await click("Create");
  expect(tickets.find((row) => row.title === "Space two")?.spaceId).toBe("space-2");
});
it.each(["Save", "Comment"])(
  "ignores a pending %s response after a Space switch",
  async (action) => {
    await render();
    await click("Synthetic task");
    await input(action === "Save" ? "Title" : "Comment", "Old draft");
    const pending = deferred<unknown>();
    state.rpc.mockImplementationOnce(() => pending.promise);
    await click(action);
    await switchSpace();
    await act(async () =>
      pending.resolve(
        action === "Save"
          ? { ...initial, title: "Late old write" }
          : { id: "late", ticketId: initial.id, body: "Late old write" },
      ),
    );
    expect(container.textContent).not.toContain("Late old write");
    expect(container.textContent).not.toContain("Old draft");
  },
);
it("refreshes comments from another client without replacing a local draft", async () => {
  await render();
  await click("Synthetic task");
  await input("Title", "Local draft");
  comments.push({
    id: "external",
    ticketId: initial.id,
    body: "External comment",
    authorName: "Bot",
  });
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(container.textContent).toContain("External comment");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Title"]')!.value).toBe(
    "Local draft",
  );
});
it("ignores a late capability response from the previous Space", async () => {
  const pending = deferred<unknown>();
  state.rpc.mockImplementationOnce(() => pending.promise);
  await render(true);
  enabled = false;
  await switchSpace();
  await act(async () => pending.resolve({ ticketBoardEnabled: true }));
  expect(button("Board entry")).toBeUndefined();
});
it("rechecks capability on focus and hides a previously enabled route", async () => {
  await render();
  state.focused = false;
  await render();
  enabled = false;
  state.focused = true;
  await render();
  expect(container.textContent).toContain("Home redirect");
  expect(button("New ticket")).toBeUndefined();
});

it("keeps drafts during a transient background capability failure", async () => {
  await render();
  await click("Synthetic task");
  await input("Title", "Unsaved draft");
  const implementation = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((path, ...args) =>
    path === "me" ? Promise.reject(new Error("offline")) : implementation(path, ...args),
  );
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Title"]')!.value).toBe(
    "Unsaved draft",
  );
});
it("rejects a wrong-Space response even if it arrives for the current request", async () => {
  const implementation = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((path, ...args) =>
    path === "tickets/list"
      ? Promise.resolve({ tickets: [{ ...initial, spaceId: "other-space" }] })
      : implementation(path, ...args),
  );
  await render();
  expect(container.textContent).not.toContain("Synthetic task");
  expect(button("New ticket").disabled).toBe(true);
});
it("does not submit unchanged fields over concurrent bot updates", async () => {
  await render();
  await click("Synthetic task");
  await input("Title", "User title");
  tickets = [{ ...initial, status: "doing", priority: "urgent" }];
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  await click("Save");
  expect(state.rpc.mock.calls.find(([path]) => path === "tickets/update")?.[1]).toEqual({
    id: initial.id,
    title: "User title",
  });
  expect(tickets[0]).toMatchObject({ title: "User title", status: "doing", priority: "urgent" });
});

it("stops polling and aborts outstanding requests on blur", async () => {
  await render();
  state.focused = false;
  await render();
  const count = state.rpc.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(state.rpc).toHaveBeenCalledTimes(count);
  const list = state.rpc.mock.calls.find(([path]) => path === "tickets/list")!;
  expect(list[2].signal.aborted).toBe(true);
});
it("removes an open board when capability is explicitly turned off", async () => {
  await render();
  await click("Synthetic task");
  enabled = false;
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(container.textContent).toContain("Home redirect");
  expect(container.querySelector("input")).toBeNull();
});
it("ignores old comment loads after changing Space", async () => {
  await render();
  const pending = deferred<unknown>();
  state.rpc.mockImplementationOnce(() => pending.promise);
  await click("Synthetic task");
  await switchSpace();
  await act(async () =>
    pending.resolve([{ id: "old", ticketId: initial.id, body: "Old comments" }]),
  );
  expect(container.textContent).not.toContain("Old comments");
});
