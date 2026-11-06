// @vitest-environment jsdom
import type { MessageBlock, PageDetail } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Pages from "./pages";

const host = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  generation: 1,
  scopeListeners: new Set<() => void>(),
  resetCaches: new Set<() => void>(),
  compile: vi.fn(),
}));

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    onLayout,
  }: {
    children?: ReactNode;
    onPress(): void;
    disabled?: boolean;
    accessibilityLabel?: string;
    onLayout(event: { nativeEvent: { layout: { width: number } } }): void;
  }) => {
    useEffect(() => onLayout({ nativeEvent: { layout: { width: 300 } } }), []);
    return createElement(
      "button",
      { type: "button", onClick: onPress, disabled, "aria-label": accessibilityLabel },
      children,
    );
  },
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("react-native-svg", () => ({
  default: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("@rakazo/chat-ui/native", () => ({ PageIcon: () => null }));
vi.mock("expo-router", () => ({
  useFocusEffect: () => {},
  useRouter: () => ({ push: host.push }),
}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example",
  currentApiBaseGeneration: () => 1,
  currentSpaceSelectionGeneration: () => host.generation,
  selectedSpaceId: () => "space-1",
  subscribeApiBase: () => () => {},
  subscribeSelectedSpace: (listener: () => void) => {
    host.scopeListeners.add(listener);
    return () => host.scopeListeners.delete(listener);
  },
  captureApiRequestContext: async () => ({ apiBase: "https://app.example", headers: {} }),
  rpc: host.rpc,
}));
vi.mock("./session", () => ({
  registerSessionDiskCache: (reset: () => void) => host.resetCaches.add(reset),
  currentSessionGeneration: () => 1,
  subscribeSessionGeneration: () => () => {},
}));
vi.mock("./native", () => ({
  useMobileTokens: () => ({ foreground: "#000000", card: "#ffffff" }),
  useResolvedAppearance: () => "light",
}));
vi.mock("./i18n", () => ({
  getActiveUiLocale: () => "en",
  useI18n: () => ({
    locale: "en",
    t: (text: string, values?: { title: string }) => text.replace("{title}", values?.title ?? ""),
  }),
}));
vi.mock("./pages", async (original) => ({
  ...(await original<typeof Pages>()),
  pageDocument: host.compile,
}));
vi.mock("../components/sandboxed-html-preview", () => ({
  SandboxedHtmlPreview: ({ html }: { html: string }) => createElement("pre", {}, html),
}));

const { PageCard, NewestPageCards } = await import("../components/pages/page-card");
const { chatOnScreen } = await import("./pages");
type PageBlock = Extract<MessageBlock, { kind: "page" }>;
const block = (version: number): PageBlock => ({
  kind: "page",
  pageId: "page-1",
  version,
  title: `Saved ${version}`,
});
const page = (version: number, title = "Current title"): PageDetail => ({
  id: "page-1",
  title,
  botId: "bot-1",
  groupId: null,
  visibility: "private",
  currentVersion: 2,
  version,
  code: `code-${version}`,
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  owner: { name: "Owner", image: null },
  shareUrl: null,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const reset of host.resetCaches) reset();
  host.generation += 1;
  host.rpc.mockReset();
  host.push.mockReset();
  host.compile.mockReset().mockImplementation(async (_base, code: string) => `preview:${code}`);
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.unstubAllGlobals();
});
async function show(
  newest = new Map([["page-1", "message-2:2"]]),
  cards = [
    { key: "old", version: 1, messageId: "message-1" },
    { key: "new", version: 2, messageId: "message-2" },
  ],
) {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const render = async () =>
    act(async () =>
      root.render(
        createElement(
          NewestPageCards.Provider,
          { value: newest },
          cards.map((card) =>
            createElement(PageCard, {
              key: card.key,
              block: block(card.version),
              messageId: card.messageId,
            }),
          ),
        ),
      ),
    );
  await render();
  return { container, render, newest, cards };
}

it("keeps the old card's saved preview while the newest card and both opens use the current Page", async () => {
  host.rpc.mockImplementation(async (_proc, input: { version?: number }) =>
    page(input.version ?? 2),
  );
  const { container } = await show();
  const [oldCard, newCard] = [...container.querySelectorAll("button")];
  expect(oldCard!.textContent).toContain("preview:code-1");
  expect(oldCard!.textContent).toContain("Current titleUpdated below");
  expect(newCard!.textContent).toContain("preview:code-2");
  expect(newCard!.textContent).toContain("Current titlePage");
  expect(host.rpc.mock.calls.map(([proc, input]) => [proc, input])).toEqual([
    ["pages/get", { pageId: "page-1" }],
    ["pages/get", { pageId: "page-1", version: 1 }],
  ]);
  await act(async () => {
    oldCard!.click();
    newCard!.click();
  });
  expect(host.push.mock.calls).toEqual([
    [{ pathname: "/page", params: { pageId: "page-1" } }],
    [{ pathname: "/page", params: { pageId: "page-1" } }],
  ]);
});

it("shows a historical preview read failure without deleting or disabling the existing current Page", async () => {
  host.rpc.mockImplementation(async (_proc, input: { version?: number }) => {
    if (input.version) throw Object.assign(new Error("Version not found"), { code: "NOT_FOUND" });
    return page(2);
  });
  const { container } = await show();
  const [oldCard, newCard] = [...container.querySelectorAll("button")];
  expect(oldCard!.textContent).toContain("This page couldn't load");
  expect(oldCard!.textContent).toContain("Current titleUpdated below");
  expect(oldCard!.disabled).toBe(false);
  expect(newCard!.textContent).toContain("preview:code-2");
});

it("waits for current availability before showing an already-read historical preview", async () => {
  const current = deferred<PageDetail>();
  const saved = deferred<PageDetail>();
  host.rpc.mockImplementation((_proc, input: { version?: number }) =>
    input.version ? saved.promise : current.promise,
  );
  const { container } = await show();
  expect(container.querySelectorAll("pre")).toHaveLength(0);
  await act(async () => saved.resolve(page(1)));
  expect(container.querySelectorAll("pre")).toHaveLength(0);
  await act(async () => current.resolve(page(2)));
  expect([...container.querySelectorAll("pre")].map((node) => node.textContent)).toEqual([
    "preview:code-1",
    "preview:code-2",
  ]);
});

it.each(["NOT_FOUND", "NETWORK_ERROR"])(
  "gives a refreshed current Page's %s precedence over cached saved previews",
  async (code) => {
    const started = code === "NOT_FOUND" ? 20_000 : 22_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(started);
    try {
      host.rpc.mockImplementation(async (_proc, input: { version?: number }) =>
        page(input.version ?? 2),
      );
      const { container } = await show();
      expect(container.querySelectorAll("pre")).toHaveLength(2);
      host.rpc.mockRejectedValue(Object.assign(new Error("Current read failed"), { code }));
      now.mockReturnValue(started + 1_000);
      await act(async () => chatOnScreen.mark());
      const buttons = [...container.querySelectorAll("button")];
      expect(container.querySelectorAll("pre")).toHaveLength(0);
      expect(buttons.map((button) => button.disabled)).toEqual([
        code === "NOT_FOUND",
        code === "NOT_FOUND",
      ]);
      expect(container.textContent).toContain(
        code === "NOT_FOUND" ? "Deleted" : "This page couldn't load",
      );
      // Focus revalidates only current; immutable saved reads remain cached.
      expect(host.rpc.mock.calls.filter(([, input]) => input.version === 1)).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  },
);

it("keeps a newest card live when a routine saves another version without posting a newer card", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(30_000);
  try {
    let version = 3;
    host.rpc.mockImplementation(async () => ({ ...page(version), currentVersion: version }));
    const { container } = await show(new Map([["page-1", "message-1:1"]]), [
      { key: "only", version: 1, messageId: "message-1" },
    ]);
    expect(container.textContent).toContain("preview:code-3Current titlePage");
    version = 4;
    now.mockReturnValue(31_000);
    await act(async () => chatOnScreen.mark());
    expect(container.textContent).toContain("preview:code-4Current titlePage");
    expect(host.rpc.mock.calls.every(([, input]) => input.version === undefined)).toBe(true);
  } finally {
    now.mockRestore();
  }
});

it("hides the live preview immediately when its card becomes historical and ignores late live compilation", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(40_000);
  const saved = deferred<PageDetail>();
  const lateLive = deferred<string>();
  try {
    let version = 2;
    host.rpc.mockImplementation((_proc, input: { version?: number }) =>
      input.version
        ? saved.promise
        : Promise.resolve({ ...page(version), currentVersion: version }),
    );
    host.compile.mockImplementation(async (_base, code: string) =>
      code === "code-3" ? lateLive.promise : `preview:${code}`,
    );
    const { container, newest, render } = await show(new Map([["page-1", "message-1:1"]]), [
      { key: "only", version: 1, messageId: "message-1" },
    ]);
    expect(container.textContent).toContain("preview:code-2");
    version = 3;
    now.mockReturnValue(41_000);
    await act(async () => chatOnScreen.mark());
    expect(container.textContent).toContain("preview:code-2");
    newest.set("page-1", "message-2:2");
    await render();
    expect(container.querySelectorAll("pre")).toHaveLength(0);
    await act(async () => saved.resolve(page(1)));
    expect(container.textContent).toContain("preview:code-1");
    await act(async () => lateLive.resolve("preview:code-3"));
    expect(container.textContent).toContain("preview:code-1");
    expect(container.textContent).not.toContain("preview:code-3");
  } finally {
    now.mockRestore();
  }
});

it("does not let a late saved version replace the newer historical preview for the same card", async () => {
  const first = deferred<PageDetail>();
  const second = deferred<PageDetail>();
  host.rpc.mockImplementation((_proc, input: { version?: number }) =>
    input.version === 1
      ? first.promise
      : input.version === 2
        ? second.promise
        : Promise.resolve(page(3)),
  );
  const { container, cards, render } = await show(new Map([["page-1", "message-3:3"]]), [
    { key: "only", version: 1, messageId: "message-1" },
  ]);
  cards[0]!.version = 2;
  await render();
  await act(async () => second.resolve(page(2)));
  expect(container.textContent).toContain("preview:code-2");
  await act(async () => first.resolve(page(1)));
  expect(container.textContent).toContain("preview:code-2");
  expect(container.textContent).not.toContain("preview:code-1");
});

it("drops late live and historical results after a Space generation change", async () => {
  const current = deferred<PageDetail>();
  const saved = deferred<PageDetail>();
  host.rpc.mockImplementation((_proc, input: { version?: number }) =>
    input.version ? saved.promise : current.promise,
  );
  const { container } = await show();
  host.rpc.mockImplementation(async (_proc, input: { version?: number }) => ({
    ...page(input.version ?? 2, "New owner title"),
    code: `new-owner-${input.version ?? 2}`,
  }));
  await act(async () => {
    host.generation += 1;
    for (const listener of host.scopeListeners) listener();
  });
  expect(container.textContent).toContain("New owner title");
  await act(async () => {
    current.resolve(page(2, "Old owner title"));
    saved.resolve(page(1, "Old owner title"));
  });
  expect(container.textContent).toContain("New owner title");
  expect(container.textContent).not.toContain("Old owner title");
  expect(container.textContent).not.toContain("preview:code-");
});
