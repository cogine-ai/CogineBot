// @vitest-environment jsdom

import type { PageDetail } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PageScreen from "../app/page";
import type { PageFrame } from "../components/pages/page-frame";
import { takePageReply, viewedPageShare } from "./pages";

const host = vi.hoisted(() => ({
  frame: undefined as ComponentProps<typeof PageFrame> | undefined,
  api: "https://pages.example.test",
  pageId: "page-1",
  space: "space-a",
  generation: 1,
  locale: "en",
  theme: "light" as "light" | "dark",
  appState: "active",
  listeners: new Set<() => void>(),
  routes: [] as { name: string; params?: object }[],
  rpc: vi.fn(),
  compile: vi.fn(),
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => <div data-testid="loading" />,
  AppState: {
    get currentState() {
      return host.appState;
    },
  },
  Platform: { OS: "android" },
  Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock("expo-modules-core", () => ({ uuid: { v4: () => "synthetic-native-view" } }));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ pageId: host.pageId }),
  useNavigation: () => ({
    isFocused: () => true,
    getState: () => ({ routes: [...host.routes, { name: "page" }], index: host.routes.length }),
  }),
  useRouter: () => ({
    back: host.back,
    canGoBack: () => true,
    push: host.push,
    replace: host.replace,
  }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    accessibilityLabel,
    onPress,
  }: {
    label?: string;
    accessibilityLabel?: string;
    onPress: () => void;
  }) => (
    <button type="button" aria-label={accessibilityLabel ?? label} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/pages/page-frame", () => ({
  // Deliver only an already-validated action from the current native frame.
  PageFrame: (props: ComponentProps<typeof PageFrame>) => {
    host.frame = props;
    return <div data-testid="page-frame" />;
  },
}));
vi.mock("./api", () => ({
  currentApiBase: () => host.api,
  currentApiBaseGeneration: () => 1,
  currentSpaceSelectionGeneration: () => host.generation,
  selectedSpaceId: () => host.space,
  subscribeApiBase: () => () => {},
  subscribeSelectedSpace: (listener: () => void) => {
    host.listeners.add(listener);
    return () => host.listeners.delete(listener);
  },
  captureApiRequestContext: async () => ({ apiBase: host.api, headers: {} }),
  rpc: host.rpc,
}));
vi.mock("./session", () => ({
  registerSessionDiskCache: () => undefined,
  currentSessionGeneration: () => 1,
  currentReadySessionGeneration: () => 1,
  subscribeSessionGeneration: () => () => {},
}));
vi.mock("./page-runtime", () => ({ pageDocument: host.compile }));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { useI18n: () => ({ t, locale: host.locale }) };
});
vi.mock("./native", () => ({
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => host.theme,
}));

function detail(overrides: Partial<PageDetail> = {}): PageDetail {
  return {
    id: "page-1",
    title: "Plan",
    code: "compiled page",
    botId: "bot-1",
    groupId: null,
    version: 1,
    currentVersion: 1,
    visibility: "private",
    pinned: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    owner: { name: "Owner", image: null },
    ...overrides,
  };
}

function switchSpace(space: string) {
  host.space = space;
  host.generation += 1;
  for (const listener of host.listeners) listener();
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.frame = undefined;
  host.pageId = "page-1";
  host.locale = "en";
  host.theme = "light";
  host.appState = "active";
  host.routes = [];
  switchSpace("space-a");
  host.rpc.mockReset().mockImplementation(async (proc: string) => {
    if (proc === "pages/get") return detail();
    if (proc === "bots/list") return [{ id: "bot-1" }];
    if (proc === "groups/list") return [{ id: "group-1" }];
    throw new Error(`Unexpected procedure ${proc}`);
  });
  // The render key must rotate even if the mocked runtime returns identical bytes.
  host.compile.mockReset().mockResolvedValue("<p>Page content</p>");
  host.back.mockReset();
  host.push.mockReset();
  host.replace.mockReset();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const show = () => act(async () => root.render(<PageScreen />));
const frame = () => host.frame!;
const rendered = () => container.querySelector('[data-testid="page-frame"]');
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

it("opens sharing with the actual title and version displayed by this viewer", async () => {
  host.rpc.mockImplementation(async (proc: string) => {
    if (proc === "pages/get")
      return detail({ title: "Original title", version: 7, currentVersion: 7 });
    if (proc === "bots/list") return [{ id: "bot-1" }];
    throw new Error(`Unexpected procedure ${proc}`);
  });
  await show();
  expect(button("Share")).toBeNull();
  await act(async () => frame().onDrawnChange?.(true));
  host.appState = "background";
  await act(async () => button("Share")!.click());
  expect(host.push).not.toHaveBeenCalled();
  host.appState = "active";
  await act(async () => button("Share")!.click());
  expect(host.push).toHaveBeenCalledExactlyOnceWith({
    pathname: "/page-share",
    params: { pageId: "page-1", viewId: "synthetic-native-view" },
  });
  expect(viewedPageShare("page-1", "synthetic-native-view")).toEqual({
    title: "Original title",
    version: 7,
  });
  expect(viewedPageShare("page-1", "external-view")).toBeUndefined();
});

it.each([
  {
    scenario: "the same writable bot chat",
    routes: [{ name: "thread", params: { botId: "bot-1" } }],
    groupId: null,
    target: { pathname: "/thread" as const, params: { botId: "bot-1" } },
    thread: "bot-1",
    back: true,
  },
  {
    scenario: "the same bot's archived read-only route",
    routes: [{ name: "thread", params: { botId: "bot-1", readOnly: "1" } }],
    groupId: null,
    target: { pathname: "/thread" as const, params: { botId: "bot-1" } },
    thread: "bot-1",
    back: false,
  },
  {
    scenario: "a different chat while the creating bot is archived",
    routes: [{ name: "thread", params: { botId: "bot-other" } }],
    groupId: "group-1",
    target: { pathname: "/group-thread" as const, params: { groupId: "group-1" } },
    thread: "group-1",
    back: false,
  },
])("offers an unsent reply to the original chat from $scenario", async (input) => {
  host.routes = input.routes;
  host.rpc.mockResolvedValueOnce(
    detail({ groupId: input.groupId, botId: input.groupId ? "archived-bot" : "bot-1" }),
  );
  await show();
  expect(host.rpc.mock.calls.map(([procedure]) => procedure)).toEqual([
    "pages/get",
    input.groupId ? "groups/list" : "bots/list",
  ]);
  await act(async () => frame().onReply?.("Clarify the plan"));
  if (input.back) {
    expect(host.back).toHaveBeenCalledOnce();
    expect(host.replace).not.toHaveBeenCalled();
  } else {
    expect(host.replace).toHaveBeenCalledExactlyOnceWith(input.target);
    expect(host.back).not.toHaveBeenCalled();
  }
  expect(takePageReply(input.target.pathname, "bot-other")).toBeNull();
  expect(takePageReply(input.target.pathname, input.thread)).toEqual({
    text: "Clarify the plan",
    page: { id: "page-1", title: "Plan" },
  });
  expect(takePageReply(input.target.pathname, input.thread)).toBeNull();
  expect(host.rpc.mock.calls.map(([procedure]) => procedure)).not.toContain("threads/send");
});

it("opens the Page without replies during origin lookup, then creates a new document for replies", async () => {
  let release!: (value: { id: string }[]) => void;
  const origin = new Promise<{ id: string }[]>((resolve) => {
    release = resolve;
  });
  host.rpc.mockResolvedValueOnce(detail()).mockReturnValueOnce(origin);
  await show();
  expect(rendered()).not.toBeNull();
  const previous = frame();
  expect(previous.onReply).toBeUndefined();
  await act(async () => previous.onDrawnChange?.(true));
  expect(button("Share")).not.toBeNull();
  expect(host.compile).toHaveBeenLastCalledWith(
    host.api,
    "compiled page",
    "light",
    "This page couldn't be shown.",
    { reply: false, lang: "en" },
  );
  await act(async () => release([{ id: "bot-1" }]));
  expect(frame().onReply).toBeTypeOf("function");
  expect(frame().document).toBe(previous.document);
  expect(frame().documentKey).not.toBe(previous.documentKey);
  expect(host.compile.mock.lastCall?.[4]).toEqual({ reply: true, lang: "en" });
  expect(button("Share")).toBeNull();
  await act(async () => previous.onDrawnChange?.(true));
  expect(button("Share")).toBeNull();
  await act(async () => frame().onDrawnChange?.(true));
  expect(button("Share")).not.toBeNull();
  await act(async () => frame().onDrawnChange?.(false));
  expect(button("Share")).toBeNull();
});

it("leaves a Page readable without replies if the origin is missing", async () => {
  host.rpc.mockResolvedValueOnce(detail()).mockResolvedValueOnce([]);
  await show();
  expect(rendered()).not.toBeNull();
  expect(frame().interactive).toBe(true);
  expect(frame().onReply).toBeUndefined();
  expect(host.compile).toHaveBeenCalledOnce();
  expect(host.compile.mock.lastCall?.[4]).toEqual({ reply: false, lang: "en" });
});

it("gives a localized and themed document a fresh identity even when the bytes match", async () => {
  await show();
  const previous = frame();
  host.theme = "dark";
  host.locale = "zh";
  await show();
  expect(frame().document).toBe(previous.document);
  expect(frame().documentKey).not.toBe(previous.documentKey);
  expect(host.compile).toHaveBeenLastCalledWith(
    host.api,
    "compiled page",
    "dark",
    "This page couldn't be shown.",
    { reply: true, lang: "zh" },
  );
});

it("rejects the old callback after a Space switch even when returning to the same Page and version", async () => {
  await show();
  const previous = frame();
  expect(previous.isCurrent?.()).toBe(true);
  await act(async () => {
    switchSpace("space-b");
    expect(previous.isCurrent?.()).toBe(false);
    previous.onReply?.("Stale reply");
    previous.onError?.();
  });
  expect(frame().documentKey).not.toBe(previous.documentKey);
  expect(rendered()).not.toBeNull();
  await act(async () => switchSpace("space-a"));
  expect(previous.isCurrent?.()).toBe(false);
  await act(async () => previous.onReply?.("Stale reply after return"));
  expect(host.replace).not.toHaveBeenCalled();
  expect(takePageReply("/thread", "bot-1")).toBeNull();
  await act(async () => frame().onReply?.("Current reply"));
  expect(takePageReply("/thread", "bot-1")?.text).toBe("Current reply");
});

it("drops an earlier Space's pending origin lookup", async () => {
  let release!: (value: { id: string }[]) => void;
  const origin = new Promise<{ id: string }[]>((resolve) => {
    release = resolve;
  });
  host.rpc
    .mockResolvedValueOnce(detail())
    .mockReturnValueOnce(origin)
    .mockResolvedValueOnce(detail())
    .mockResolvedValueOnce([]);
  await show();
  const earlier = frame();
  await act(async () => switchSpace("space-b"));
  const current = frame();
  expect(current.documentKey).not.toBe(earlier.documentKey);
  expect(current.onReply).toBeUndefined();
  await act(async () => release([{ id: "bot-1" }]));
  expect(frame()).toBe(current);
  expect(host.compile).toHaveBeenCalledTimes(2);
});

it("retries a native load failure using the actual latest Page version", async () => {
  await show();
  const initial = frame();
  expect(JSON.parse(initial.documentKey).slice(1, 3)).toEqual(["page-1", 1]);
  await act(async () => initial.onDrawnChange?.(true));
  expect(button("Share")).not.toBeNull();
  await act(async () => initial.onError?.());
  expect(button("Share")).toBeNull();
  expect(rendered()).toBeNull();
  expect(container.textContent).toContain("Could not load this page.");
  host.rpc.mockResolvedValueOnce(detail({ version: 2, currentVersion: 2 }));
  await act(async () => button("Try again")?.click());
  expect(rendered()).not.toBeNull();
  expect(frame().document).toBe(initial.document);
  expect(frame().documentKey).not.toBe(initial.documentKey);
  expect(JSON.parse(frame().documentKey).slice(1, 3)).toEqual(["page-1", 2]);
  await act(async () => initial.onDrawnChange?.(true));
  expect(button("Share")).toBeNull();
  await act(async () => frame().onDrawnChange?.(true));
  expect(button("Share")).not.toBeNull();
  expect(
    host.rpc.mock.calls.filter(([procedure]) => procedure === "pages/get").map(([, arg]) => arg),
  ).toEqual([{ pageId: "page-1" }, { pageId: "page-1" }]);
});

it("can retry a runtime failure, but does not offer to retry a forbidden Page", async () => {
  host.compile.mockRejectedValueOnce(new Error("Page runtime returned 503"));
  await show();
  expect(rendered()).toBeNull();
  expect(button("Try again")).not.toBeNull();
  await act(async () => button("Try again")?.click());
  expect(rendered()).not.toBeNull();

  host.pageId = "page-2";
  host.rpc.mockRejectedValueOnce({ code: "FORBIDDEN" });
  await show();
  expect(rendered()).toBeNull();
  expect(container.textContent).toContain("This page isn't available");
  expect(button("Try again")).toBeNull();
});
