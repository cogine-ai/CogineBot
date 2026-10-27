// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, forwardRef, useEffect, useImperativeHandle } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ArtifactDetail from "../app/artifact";
import ArtifactsScreen from "../app/artifacts";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
  alert: vi.fn(),
  write: vi.fn(),
  share: vi.fn(),
  scrollTo: vi.fn(),
  dateLocaleForUi: vi.fn(() => "en-US"),
  params: { botId: "bot-1" } as Record<string, string>,
  scope: {
    apiBase: "https://api.example.test",
    apiGeneration: 0,
    sessionGeneration: 0,
    spaceId: "space-1" as string | null,
    spaceGeneration: 0,
    selectionSeq: 0,
  },
  listeners: new Set<() => void>(),
  ios26: true,
  focused: true,
  options: {} as {
    headerRight?: () => ReactNode;
    unstable_headerRightItems?: () => Array<{ label: string; onPress: () => void }>;
  },
}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async () => ({
    apiBase: state.scope.apiBase,
    sessionGeneration: state.scope.sessionGeneration,
    headers: { authorization: "Bearer captured-token", "x-rakazo-space-id": state.scope.spaceId },
  }),
}));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({ ...state.scope }),
  isMobileScopeCurrent: (scope: unknown) => JSON.stringify(scope) === JSON.stringify(state.scope),
  mobileScopeKey: () => JSON.stringify(state.scope),
  subscribeMobileScope: (fn: () => void) => {
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  },
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: state.push, back: state.back }),
  useLocalSearchParams: () => state.params,
  useNavigation: () => ({
    setOptions: (options: typeof state.options) => {
      state.options = options;
    },
  }),
  useFocusEffect: (effect: () => (() => void) | undefined) =>
    useEffect(() => (state.focused ? effect() : undefined), [effect, state.focused]),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const ScrollView = forwardRef(
    (
      {
        children,
        onLayout,
        onContentSizeChange,
      }: {
        children?: ReactNode;
        onLayout?: (event: unknown) => void;
        onContentSizeChange?: (width: number) => void;
      },
      ref,
    ) => {
      useImperativeHandle(ref, () => ({ scrollTo: state.scrollTo }), []);
      useEffect(() => {
        onLayout?.({ nativeEvent: { layout: { width: 200 } } });
        onContentSizeChange?.(1000);
      }, []);
      return <div>{children}</div>;
    },
  );
  return {
    View,
    ScrollView,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    ActivityIndicator: () => <progress />,
    Image: () => null,
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles },
    Alert: { alert: state.alert },
    RefreshControl: ({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) => (
      <button type="button" aria-label="Pull to refresh" aria-busy={refreshing} onClick={onRefresh}>
        Refresh
      </button>
    ),
    Pressable: ({
      children,
      onPress,
      onLongPress,
      accessibilityLabel,
      onLayout,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      onLongPress?: () => void;
      accessibilityLabel?: string;
      onLayout?: (event: unknown) => void;
      disabled?: boolean;
    }) => {
      useEffect(() => {
        onLayout?.({ nativeEvent: { layout: { x: 400, width: 100 } } });
      }, []);
      return (
        <button
          type="button"
          aria-label={accessibilityLabel}
          disabled={disabled}
          onClick={onPress}
          onContextMenu={(event) => {
            event.preventDefault();
            onLongPress?.();
          }}
        >
          {children}
        </button>
      );
    },
    FlatList: ({
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
      onEndReached,
      refreshControl,
    }: {
      data: unknown[];
      renderItem: (value: { item: never }) => ReactNode;
      ListHeaderComponent?: ReactNode;
      ListEmptyComponent?: ReactNode;
      onEndReached: () => void;
      refreshControl?: ReactNode;
    }) => (
      <div>
        {refreshControl}
        {ListHeaderComponent}
        {data.length
          ? data.map((item, i) => <div key={i}>{renderItem({ item: item as never })}</div>)
          : ListEmptyComponent}
        <button type="button" onClick={onEndReached}>
          Next page
        </button>
      </div>
    ),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native-controls", () => ({ iosAtLeast: () => state.ios26 }));
vi.mock("./floating-header", () => ({ useFloatingHeaderInset: () => 0 }));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, dateLocaleForUi: state.dateLocaleForUi, useI18n: () => ({ t }) };
});
vi.mock("./artifact-open", () => ({
  writeArtifactCacheFile: state.write,
  shareLocalFile: state.share,
}));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("@rakazo/chat-ui/native", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/sandboxed-html-preview", () => ({ SandboxedHtmlPreview: () => null }));

const artifact = {
  id: "file-1",
  botId: "bot-1",
  groupId: null,
  name: "Notes.md",
  mimeType: "text/markdown",
  description: null,
  version: 1,
  versionCount: 1,
  contentBase64: "ZmFrZQ==",
  createdAt: "2026-10-20T00:00:00Z",
};
let root: Root, headerRoot: Root, container: HTMLDivElement, header: HTMLDivElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function render(detail = false) {
  await act(async () => root.render(detail ? <ArtifactDetail /> : <ArtifactsScreen />));
}
async function changeScope(change: Partial<typeof state.scope>) {
  await act(async () => {
    Object.assign(state.scope, change);
    for (const listener of state.listeners) listener();
  });
}
function button(text: string, target = container) {
  const found = [...target.querySelectorAll("button")].find(
    (node) => node.textContent?.includes(text) || node.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`Missing ${text}: ${target.textContent}`);
  return found;
}
async function deleteHeader() {
  if (state.ios26)
    state.options
      .unstable_headerRightItems?.()
      .find((item) => item.label === "Delete")
      ?.onPress();
  else {
    await act(async () => headerRoot.render(state.options.headerRight?.()));
    await act(async () => button("Delete", header).click());
  }
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.params = { botId: "bot-1" };
  state.scope = {
    apiBase: "https://api.example.test",
    apiGeneration: 0,
    sessionGeneration: 0,
    spaceId: "space-1",
    spaceGeneration: 0,
    selectionSeq: 0,
  };
  state.ios26 = true;
  state.focused = true;
  state.options = {};
  state.rpc.mockReset().mockImplementation(async (p: string) => {
    if (p === "bots/list") return [{ id: "bot-1", name: "Assistant" }];
    if (p === "artifacts/listSpace") return { items: [artifact], nextCursor: null };
    if (p === "artifacts/listVersions")
      return [{ id: "file-1", version: 1, createdAt: artifact.createdAt }];
    if (p === "artifacts/getById") return artifact;
    if (p === "artifacts/remove") return {};
    throw new Error(p);
  });
  state.write
    .mockReset()
    .mockReturnValue({ text: async () => "Visible notes", uri: "file:///synthetic-notes.md" });
  for (const fn of [
    state.alert,
    state.push,
    state.back,
    state.share,
    state.scrollTo,
    state.dateLocaleForUi,
  ])
    fn.mockClear();
  container = document.createElement("div");
  header = document.createElement("div");
  document.body.append(container, header);
  root = createRoot(container);
  headerRoot = createRoot(header);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    headerRoot.unmount();
  });
  container.remove();
  header.remove();
  vi.unstubAllGlobals();
});

it.each([
  ["just before seven days", "2026-10-26T23:59:59.999Z", false],
  ["exactly seven days", "2026-10-27T00:00:00Z", true],
] as const)("renders an artifact date %s", async (_label, now, localized) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date(now));
    await render();
    expect(container.textContent).toContain("Notes.md");
    expect(state.dateLocaleForUi).toHaveBeenCalledTimes(localized ? 1 : 0);
    expect(container.textContent).toContain(
      localized
        ? new Date(artifact.createdAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })
        : "{count}d ago",
    );
  } finally {
    vi.useRealTimers();
  }
});

it("opens the profile Bot filter, reveals its chip and carries readonly through to preview", async () => {
  state.params.readOnly = "1";
  await render();
  expect(state.rpc.mock.calls.find(([p]) => p === "artifacts/listSpace")?.slice(1)).toMatchObject([
    { botId: "bot-1", limit: 30 },
    {
      requestContext: {
        headers: { "x-rakazo-space-id": "space-1", authorization: "Bearer captured-token" },
      },
    },
  ]);
  expect(state.scrollTo).toHaveBeenCalledWith({ x: 300, animated: false });
  await act(async () =>
    button("Notes.md").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
  );
  expect(state.alert).not.toHaveBeenCalled();
  await act(async () => button("Notes.md").click());
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/artifact",
    params: { artifactId: "file-1", readOnly: "1" },
  });
});

it.each([true, false])(
  "readonly preview retains content and sharing but hides Delete (iOS26=%s)",
  async (ios26) => {
    state.ios26 = ios26;
    state.params = { artifactId: "file-1", readOnly: "1" };
    await render(true);
    expect(container.textContent).toContain("Visible notes");
    if (ios26)
      expect(state.options.unstable_headerRightItems?.().map((item) => item.label)).toEqual([
        "Share",
      ]);
    else {
      await act(async () => headerRoot.render(state.options.headerRight?.()));
      expect(header.querySelector('[aria-label="Delete"]')).toBeNull();
      expect(button("Share", header)).toBeTruthy();
    }
    expect(state.rpc.mock.calls.some(([p]) => p === "artifacts/remove")).toBe(false);
  },
);

it.each([true, false])(
  "rejects a retained Delete confirmation after preview becomes readonly (iOS26=%s)",
  async (ios26) => {
    state.ios26 = ios26;
    state.params = { artifactId: "file-1" };
    await render(true);
    await deleteHeader();
    const confirm = state.alert.mock.lastCall?.[2]?.find(
      (action: { text: string }) => action.text === "Delete",
    ).onPress;
    expect(confirm).toBeTypeOf("function");
    state.params = { artifactId: "file-1", readOnly: "1" };
    await render(true);
    await act(async () => confirm());
    expect(state.rpc.mock.calls.some(([p]) => p === "artifacts/remove")).toBe(false);
    expect(state.back).not.toHaveBeenCalled();
  },
);

it("does not write old preview bytes after a pending same-ID Space selection invalidates the owner", async () => {
  state.params = { artifactId: "file-1" };
  const downloaded = deferred<typeof artifact>();
  const normal = state.rpc.getMockImplementation()!;
  let first = true;
  state.rpc.mockImplementation((p: string) => {
    if (p === "artifacts/getById" && first) {
      first = false;
      return downloaded.promise;
    }
    return normal(p);
  });
  await render(true);
  await changeScope({ selectionSeq: 1 });
  state.write.mockClear();
  await act(async () => downloaded.resolve({ ...artifact, contentBase64: "b2xk" }));
  expect(state.write.mock.calls.some((call) => call[2] === "b2xk")).toBe(false);
});

it("keeps pagination bound to its Bot and drops an old page after the user changes the filter", async () => {
  const more = deferred<{ items: (typeof artifact)[]; nextCursor: string | null }>();
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((p: string, input: { botId?: string; cursor?: string }) => {
    if (p === "bots/list")
      return Promise.resolve([
        { id: "bot-1", name: "Assistant" },
        { id: "bot-2", name: "Other" },
      ]);
    if (p === "artifacts/listSpace") {
      if (input.cursor) return more.promise;
      return Promise.resolve(
        input.botId === "bot-2"
          ? {
              items: [{ ...artifact, id: "new-file", botId: "bot-2", name: "Other notes" }],
              nextCursor: null,
            }
          : { items: [artifact], nextCursor: "cursor-1" },
      );
    }
    return normal(p, input);
  });
  await render();
  await act(async () => button("Next page").click());
  expect(
    state.rpc.mock.calls.find(([p, input]) => p === "artifacts/listSpace" && input.cursor)?.[1],
  ).toEqual({ botId: "bot-1", cursor: "cursor-1", limit: 30 });
  await act(async () => button("Other").click());
  await act(async () =>
    more.resolve({ items: [{ ...artifact, id: "old-page", name: "Old page" }], nextCursor: null }),
  );
  expect(container.textContent).toContain("Other notes");
  expect(container.textContent).not.toContain("Old page");
});

it("binds readonly file reads to verified Me when no global Space has been selected", async () => {
  state.scope.spaceId = null;
  state.params.readOnly = "1";
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((p: string, input: unknown) =>
    p === "me" ? Promise.resolve({ spaceId: "space-1" }) : normal(p, input),
  );
  await render();
  expect(
    state.rpc.mock.calls.find(([p]) => p === "artifacts/listSpace")?.[2]?.requestContext.headers[
      "x-rakazo-space-id"
    ],
  ).toBe("space-1");
  expect(state.scope.spaceId).toBeNull();
});

it.each(["versions", "content"])(
  "retries a preview %s read dropped while the route was unfocused",
  async (boundary) => {
    state.params = { artifactId: "file-1" };
    const pending = deferred<unknown>();
    const normal = state.rpc.getMockImplementation()!;
    let held = false;
    state.rpc.mockImplementation((p: string, input: unknown) => {
      if (
        !held &&
        p === (boundary === "versions" ? "artifacts/listVersions" : "artifacts/getById")
      ) {
        held = true;
        return pending.promise;
      }
      return normal(p, input);
    });
    await render(true);
    expect(held).toBe(true);
    state.focused = false;
    await render(true);
    await act(async () =>
      pending.resolve(
        boundary === "versions" ? [{ ...artifact, createdAt: artifact.createdAt }] : artifact,
      ),
    );
    state.focused = true;
    await render(true);
    expect(container.textContent).toContain("Visible notes");
    expect(
      state.rpc.mock.calls.filter(
        ([p]) => p === (boundary === "versions" ? "artifacts/listVersions" : "artifacts/getById"),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  },
);

it("resets an abandoned pull spinner on refocus while preserving newer refresh ownership and data", async () => {
  type Page = { items: (typeof artifact)[]; nextCursor: string | null };
  const abandoned = deferred<Page>();
  const focusLoad = deferred<Page>();
  const newerPull = deferred<Page>();
  const normal = state.rpc.getMockImplementation()!;
  let requests = 0;
  state.rpc.mockImplementation((p: string, input: { botId?: string; cursor?: string }) => {
    if (p !== "artifacts/listSpace") return normal(p, input);
    requests += 1;
    if (requests === 1) return Promise.resolve({ items: [artifact], nextCursor: "initial-cursor" });
    if (requests === 2) return abandoned.promise;
    if (requests === 3) return focusLoad.promise;
    if (requests === 4) return newerPull.promise;
    return Promise.resolve({ items: [], nextCursor: null });
  });
  const refreshControl = () => button("Pull to refresh");
  await render();
  await act(async () => refreshControl().click());
  expect(refreshControl().getAttribute("aria-busy")).toBe("true");
  state.focused = false;
  await render();
  state.focused = true;
  await render();
  expect(requests).toBe(3);
  expect(refreshControl().getAttribute("aria-busy")).toBe("false");
  expect(container.textContent).toContain("Notes.md");

  await act(async () => refreshControl().click());
  expect(requests).toBe(4);
  expect(refreshControl().getAttribute("aria-busy")).toBe("true");
  await act(async () =>
    abandoned.resolve({
      items: [{ ...artifact, name: "Abandoned notes" }],
      nextCursor: "abandoned-cursor",
    }),
  );
  await act(async () =>
    focusLoad.resolve({
      items: [{ ...artifact, name: "Superseded focus notes" }],
      nextCursor: "superseded-cursor",
    }),
  );
  expect(refreshControl().getAttribute("aria-busy")).toBe("true");
  expect(container.textContent).toContain("Notes.md");
  expect(container.textContent).not.toContain("Abandoned notes");
  expect(container.textContent).not.toContain("Superseded focus notes");
  await act(async () =>
    newerPull.resolve({
      items: [{ ...artifact, name: "Current notes" }],
      nextCursor: "current-cursor",
    }),
  );
  expect(refreshControl().getAttribute("aria-busy")).toBe("false");
  expect(container.textContent).toContain("Current notes");
  await act(async () => button("Next page").click());
  expect(state.rpc.mock.calls.findLast(([p]) => p === "artifacts/listSpace")?.[1]).toEqual({
    botId: "bot-1",
    cursor: "current-cursor",
    limit: 30,
  });
});
