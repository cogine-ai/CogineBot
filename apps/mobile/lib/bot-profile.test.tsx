// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, StrictMode, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BotProfile from "../app/bot-profile";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  alert: vi.fn(),
  follow: vi.fn(),
  permission: vi.fn(),
  settings: vi.fn(),
  register: vi.fn(
    async (_options: {
      permission: "allowed";
      requestContext: unknown;
      isCurrent: () => boolean;
    }) => undefined,
  ),
  params: { botId: "bot-1", name: "Fallback" } as Record<string, string>,
  scope: {
    apiBase: "https://api.example.test",
    apiGeneration: 0,
    sessionGeneration: 0,
    spaceId: "space-1" as string | null,
    spaceGeneration: 0,
    selectionSeq: 0,
  },
  listeners: new Set<() => void>(),
  focus: new Set<() => (() => void) | undefined>(),
}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async () => ({
    apiBase: state.scope.apiBase,
    sessionGeneration: state.scope.sessionGeneration,
    headers: { authorization: "Bearer saved-token", "x-rakazo-space-id": state.scope.spaceId },
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
vi.mock("./live-notifications", () => ({
  afterChatNotifyChange: state.follow,
  readChatNotificationPermission: state.permission,
  openLiveNotificationSettings: state.settings,
}));
vi.mock("./push", () => ({ registerPushToken: state.register }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: state.push }),
  useLocalSearchParams: () => state.params,
  useFocusEffect: (effect: () => (() => void) | undefined) => {
    useEffect(effect, [effect]);
    useEffect(() => {
      state.focus.add(effect);
      return () => {
        state.focus.delete(effect);
      };
    }, [effect]);
  },
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Platform: { OS: "ios" },
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    useWindowDimensions: () => ({ fontScale: 1 }),
    Alert: { alert: state.alert },
    Pressable: ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={onPress}>
        {children}
      </button>
    ),
  };
});
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null }));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    value,
    disabled,
    onValueChange,
  }: {
    accessibilityLabel: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={accessibilityLabel}
      checked={value}
      disabled={disabled}
      onChange={() => onValueChange(!value)}
    />
  ),
}));

const bot = {
  id: "bot-1",
  spaceId: "space-1",
  name: "Assistant",
  title: "Research",
  description: "Collect useful references",
  color: "c",
  threadId: "dm-1",
  notifyOnFinish: false,
};
const routine = {
  id: "routine-1",
  botId: "bot-1",
  name: "Morning review",
  prompt: "Review",
  active: true,
  crons: ["0 6 * * *"],
  timezone: "UTC",
  nextRunAt: null,
  createdAt: "2026-01-01T00:00:00Z",
};
let container: HTMLDivElement;
let root: Root;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const render = async () => {
  await act(async () => root.render(<BotProfile />));
};
function button(text: string) {
  const match = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(text),
  );
  if (!match) throw new Error(`Missing ${text}: ${container.textContent}`);
  return match;
}
const toggle = () =>
  container.querySelector<HTMLInputElement>('input[aria-label="Notifications"]')!;
async function changeScope(change: Partial<typeof state.scope>) {
  await act(async () => {
    Object.assign(state.scope, change);
    for (const listener of state.listeners) listener();
  });
}
async function refocus() {
  await act(async () => {
    for (const effect of state.focus) effect();
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.params = { botId: "bot-1", name: "Fallback" };
  state.scope = {
    apiBase: "https://api.example.test",
    apiGeneration: 0,
    sessionGeneration: 0,
    spaceId: "space-1",
    spaceGeneration: 0,
    selectionSeq: 0,
  };
  state.rpc.mockReset().mockImplementation(async (procedure: string) => {
    if (procedure === "bots/get") return bot;
    if (procedure === "bots/listArchived") return [{ ...bot, archivedAt: "2026-10-20T00:00:00Z" }];
    if (procedure === "routines/list") return [];
    if (procedure === "bots/update") return {};
    throw new Error(procedure);
  });
  state.follow.mockReset().mockResolvedValue("allowed");
  state.permission.mockReset().mockResolvedValue("allowed");
  state.settings.mockReset().mockResolvedValue(undefined);
  state.register.mockReset().mockResolvedValue(undefined);
  state.push.mockReset();
  state.alert.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows identity and description, hides empty Routines and opens native destinations", async () => {
  await render();
  expect(container.textContent).toContain("Collect useful references");
  expect(container.textContent).not.toContain("Routines");
  for (const label of ["Chat settings", "Artifacts", "Computer"])
    await act(async () => button(label).click());
  expect(state.push.mock.calls.map(([destination]) => destination)).toMatchObject([
    { pathname: "/bot-settings", params: { botId: "bot-1" } },
    { pathname: "/artifacts", params: { botId: "bot-1" } },
    { pathname: "/computer", params: { botId: "bot-1", name: "Assistant" } },
  ]);
});

it("loads archived identity with exact ID and keeps mutating destinations disabled", async () => {
  state.params.readOnly = "1";
  state.rpc.mockImplementation(async (procedure: string) =>
    procedure === "bots/listArchived" ? [{ ...bot, archivedAt: "2026-10-20" }] : [routine],
  );
  await render();
  expect(container.textContent).toContain("Collect useful references");
  expect(container.textContent).not.toContain("Chat settings");
  expect(container.textContent).not.toContain("Computer");
  expect(toggle()?.disabled).toBe(true);
  await act(async () => button("Morning review").click());
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/routine",
    params: {
      botId: "bot-1",
      botName: "Assistant",
      routineId: "routine-1",
      origin: "profile",
      readOnly: "1",
    },
  });
  await act(async () => button("Artifacts").click());
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/artifacts",
    params: { botId: "bot-1", readOnly: "1" },
  });
  expect(state.rpc.mock.calls.some(([p]) => p === "bots/get" || p === "bots/update")).toBe(false);
  expect(state.register).not.toHaveBeenCalled();
});

it("keeps successful preference enabled on OS denial and exposes an explicit settings action", async () => {
  state.follow.mockResolvedValue("denied");
  await render();
  await act(async () => toggle().click());
  expect(toggle().checked).toBe(true);
  expect(toggle().disabled).toBe(false);
  expect(container.textContent).toContain("Notifications are blocked in system settings.");
  expect(state.settings).not.toHaveBeenCalled();
  expect(state.follow.mock.calls[0]?.[0]).toMatchObject({
    botId: "bot-1",
    threadId: "dm-1",
    notifyOnFinish: true,
    apiBase: "https://api.example.test",
    token: "saved-token",
    spaceId: "space-1",
  });
  await act(async () => button("Settings").click());
  expect(state.settings).toHaveBeenCalledTimes(1);
});

it("keeps pending intent through overlapping focus reads and excludes a second switch save", async () => {
  const saved = deferred<unknown>();
  const read = deferred<typeof bot>();
  state.rpc.mockImplementation((procedure: string) =>
    procedure === "bots/update"
      ? saved.promise
      : procedure === "bots/get"
        ? Promise.resolve(bot)
        : Promise.resolve([]),
  );
  await render();
  await act(async () => toggle().click());
  expect(toggle().checked).toBe(true);
  expect(toggle().disabled).toBe(true);
  state.rpc.mockImplementation((procedure: string) =>
    procedure === "bots/get" ? read.promise : Promise.resolve([]),
  );
  await refocus();
  await act(async () => {
    toggle().click();
    read.resolve({ ...bot, title: "Refreshed" });
  });
  expect(toggle().checked).toBe(true);
  expect(container.textContent).toContain("Refreshed");
  await act(async () => saved.resolve({}));
  expect(toggle().checked).toBe(true);
  expect(state.rpc.mock.calls.filter(([p]) => p === "bots/update")).toHaveLength(1);
});

it("rolls back exactly the old value only for a DB failure", async () => {
  state.rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "bots/get") return bot;
    if (procedure === "bots/update") throw new Error("offline");
    return [];
  });
  await render();
  await act(async () => toggle().click());
  expect(toggle().checked).toBe(false);
  expect(state.follow).not.toHaveBeenCalled();
  expect(state.alert).toHaveBeenCalled();
});

it("keeps a successful save when native follow-up fails and Retry only checks permission", async () => {
  state.follow.mockRejectedValue(new Error("Native unavailable"));
  await render();
  await act(async () => toggle().click());
  expect(toggle().checked).toBe(true);
  expect(container.textContent).toContain("Could not check notification permission.");
  await act(async () => button("Retry").click());
  expect(state.permission).toHaveBeenCalledTimes(1);
  expect(state.rpc.mock.calls.filter(([p]) => p === "bots/update")).toHaveLength(1);
  expect(state.follow).toHaveBeenCalledTimes(1);
  expect(state.register).not.toHaveBeenCalled();
});

it("registers an enabled saved preference with the exact save context and owner guard", async () => {
  state.follow.mockImplementation(async (change: { onAllowed?: () => Promise<void> }) => {
    await change.onAllowed?.();
    return "allowed";
  });
  await render();
  await act(async () => toggle().click());
  const savedContext = state.rpc.mock.calls.find(([p]) => p === "bots/update")?.[2]?.requestContext;
  expect(state.register).toHaveBeenCalledExactlyOnceWith({
    permission: "allowed",
    requestContext: savedContext,
    isCurrent: expect.any(Function),
  });
  expect(state.register.mock.calls[0]?.[0]?.requestContext).toBe(savedContext);
  expect(toggle().checked).toBe(true);
  const eligible = state.register.mock.calls[0]?.[0]?.isCurrent;
  if (!eligible) throw new Error("Missing saved notification owner guard");
  expect(eligible()).toBe(true);
  await changeScope({ selectionSeq: 1 });
  expect(eligible()).toBe(false);
});

it.each(["apiGeneration", "sessionGeneration", "spaceGeneration", "selectionSeq"] as const)(
  "drops a late save across %s ABA while the target IDs remain equal",
  async (field) => {
    const saved = deferred<unknown>();
    const normal = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((p: string) => (p === "bots/update" ? saved.promise : normal(p)));
    await render();
    await act(async () => toggle().click());
    await changeScope({ [field]: 2 });
    await act(async () => saved.reject(new Error("Old owner failed")));
    expect(state.follow).not.toHaveBeenCalled();
    expect(state.alert).not.toHaveBeenCalled();
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
  },
);

it("renders a Routine load failure independently and retries without reloading the Bot", async () => {
  let attempts = 0;
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((p: string) =>
    p === "routines/list"
      ? ++attempts === 1
        ? Promise.reject(new Error("Routine offline"))
        : Promise.resolve([routine])
      : normal(p),
  );
  await render();
  expect(container.textContent).toContain("Collect useful references");
  expect(container.textContent).toContain("Routine offline");
  await act(async () => button("Try again.").click());
  expect(container.textContent).toContain("Morning review");
  expect(state.rpc.mock.calls.filter(([p]) => p === "bots/get")).toHaveLength(1);
});

it("binds null-selection reads and notification save to the verified default Space without selecting it", async () => {
  state.scope.spaceId = null;
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((p: string) =>
    p === "me" ? Promise.resolve({ spaceId: "space-1" }) : normal(p),
  );
  await render();
  await act(async () => toggle().click());
  for (const [p, , options] of state.rpc.mock.calls) {
    if (p !== "me") expect(options?.requestContext?.headers["x-rakazo-space-id"]).toBe("space-1");
  }
  expect(state.scope.spaceId).toBeNull();
  expect(state.follow.mock.calls[0]?.[0]?.spaceId).toBe("space-1");
});

it("keeps notification Save in the Bot Space actually read before the server default changes", async () => {
  state.scope.spaceId = null;
  let defaultSpace = "space-1";
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((p: string) =>
    p === "me" ? Promise.resolve({ spaceId: defaultSpace }) : normal(p),
  );
  await render();
  defaultSpace = "space-2";
  await act(async () => toggle().click());
  expect(
    state.rpc.mock.calls.find(([p]) => p === "bots/update")?.[2]?.requestContext.headers[
      "x-rakazo-space-id"
    ],
  ).toBe("space-1");
  expect(state.follow.mock.calls[0]?.[0]?.spaceId).toBe("space-1");
  expect(state.scope.spaceId).toBeNull();
});

it("does not expose a switch for a Bot DTO from another Space", async () => {
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((p: string) =>
    p === "bots/get" ? Promise.resolve({ ...bot, spaceId: "other-space" }) : normal(p),
  );
  await render();
  expect(container.textContent).toContain("Could not load bot");
  expect(toggle()).toBeNull();
});

it("does not issue downstream RPCs from a stale null-selection Me response", async () => {
  state.scope.spaceId = null;
  const gates: Array<ReturnType<typeof deferred<{ spaceId: string }>>> = [];
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((p: string) => {
    if (p !== "me") return normal(p);
    const gate = deferred<{ spaceId: string }>();
    gates.push(gate);
    return gate.promise;
  });
  await render();
  await changeScope({ selectionSeq: 1 });
  await act(async () => {
    gates[0]!.resolve({ spaceId: "space-1" });
    gates[1]!.resolve({ spaceId: "space-1" });
  });
  expect(state.rpc.mock.calls.some(([p]) => p !== "me")).toBe(false);
  await act(async () => {
    gates[2]!.resolve({ spaceId: "space-1" });
    gates[3]!.resolve({ spaceId: "space-1" });
  });
  expect(state.rpc.mock.calls.filter(([p]) => p === "bots/get")).toHaveLength(1);
  expect(state.rpc.mock.calls.filter(([p]) => p === "routines/list")).toHaveLength(1);
  expect(container.textContent).toContain("Collect useful references");
});

it("loads after a StrictMode effect remount", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <BotProfile />
      </StrictMode>,
    ),
  );
  expect(container.textContent).toContain("Collect useful references");
});

it.each(["before", "during"] as const)(
  "keeps saved notification intent when a focus read started %s the save returns late",
  async (when) => {
    const reads: Array<ReturnType<typeof deferred<typeof bot>>> = [];
    const save = deferred<unknown>();
    state.rpc.mockImplementation((p: string) => {
      if (p === "bots/get") {
        const read = deferred<typeof bot>();
        reads.push(read);
        return read.promise;
      }
      return p === "bots/update" ? save.promise : Promise.resolve([]);
    });
    await render();
    await act(async () => reads[0]!.resolve(bot));
    if (when === "before") await refocus();
    await act(async () => toggle().click());
    if (when === "during") await refocus();
    await act(async () => save.resolve({}));
    await act(async () => reads[1]!.resolve({ ...bot, title: "Updated identity" }));
    expect(toggle().checked).toBe(true);
    expect(container.textContent).toContain("Updated identity");
  },
);

it("retries a core Bot failure without throwing away independently loaded Routines", async () => {
  let fail = true;
  state.rpc.mockImplementation(async (p: string) => {
    if (p === "bots/get") {
      if (fail) throw new Error("Bot offline");
      return bot;
    }
    return [routine];
  });
  await render();
  expect(container.textContent).toContain("Morning review");
  expect(container.textContent).toContain("Bot offline");
  fail = false;
  await act(async () => button("Try again.").click());
  expect(container.textContent).toContain("Collect useful references");
  expect(state.rpc.mock.calls.filter(([p]) => p === "routines/list")).toHaveLength(1);
});

it("does not substitute another archived Bot for a missing historical profile", async () => {
  state.params.readOnly = "1";
  state.rpc.mockImplementation(async (p: string) =>
    p === "bots/listArchived" ? [{ ...bot, id: "foreign" }] : [],
  );
  await render();
  expect(container.textContent).toContain("Could not load bot");
  expect(toggle()).toBeNull();
});
