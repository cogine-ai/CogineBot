// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SearchSheet from "../app/search";
import { selectSpace } from "./api";
import type { InboxSpace } from "./inbox-spaces";
import { captureMobileScope } from "./mobile-scope";
import { setSearchInbox } from "./search-inbox";
import { searchKindLabel } from "./search-sheet";

const state = vi.hoisted(() => ({
  search: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  addListener: vi.fn(),
  lifecycle: new Map<string, () => void>(),
  selectSpace: vi.fn(),
  selectionSeq: 0,
  spaceId: "space-a" as string | null,
  persistedSpaceId: "space-a",
  generation: 1,
  apiBase: "https://example.test",
  apiGeneration: 1,
  spaceGeneration: 1,
  scopeListeners: new Set<() => void>(),
  me: vi.fn(),
  capture: vi.fn(),
  dismiss: vi.fn(),
  alert: vi.fn(),
  platform: { OS: "ios" },
}));
const bot = {
  id: "bot-a",
  name: "Scout",
  title: "Research",
  preview: "Latest reply",
  spaceId: "space-a",
  color: "gray",
  status: "idle",
};
const group = {
  id: "group-a",
  name: "Team",
  preview: "Team reply",
  spaceId: "space-b",
  members: [],
};
const spaces = [{ id: "space-a", bots: [bot], groups: [group] }] as unknown as InboxSpace[];
const message = {
  kind: "message" as const,
  botId: "bot-a",
  botName: "Scout",
  title: "Found note",
  snippet: "A **matching** line",
  messageId: "message-a",
};
vi.mock("expo-router", () => ({
  useRouter: () => state,
  useNavigation: () => state,
  useFocusEffect: (effect: () => () => void) =>
    useEffect(() => {
      const cleanup = effect();
      state.lifecycle.set("blur", cleanup);
      return cleanup;
    }, [effect]),
}));
vi.mock("./api", () => ({
  selectSpace: (id: string, options?: { isCurrent?: () => boolean }) => {
    state.selectionSeq++;
    for (const listener of state.scopeListeners) listener();
    if (options?.isCurrent && !options.isCurrent()) return Promise.resolve(false);
    const previousGeneration = state.spaceGeneration;
    const result = state.selectSpace(id);
    const claim = () => {
      if (state.spaceId === (id || null) && state.spaceGeneration === previousGeneration)
        state.spaceGeneration++;
    };
    claim();
    return Promise.resolve(result).then((value) => {
      if (value) claim();
      return value;
    });
  },
  spaceSelectionSeq: () => state.selectionSeq,
  selectedSpaceId: () => state.spaceId,
  currentApiBase: () => state.apiBase,
  currentApiBaseGeneration: () => state.apiGeneration,
  currentSpaceSelectionGeneration: () => state.spaceGeneration,
  subscribeApiBase: (listener: () => void) => {
    state.scopeListeners.add(listener);
    return () => state.scopeListeners.delete(listener);
  },
  subscribeSelectedSpace: (listener: () => void) => {
    state.scopeListeners.add(listener);
    return () => state.scopeListeners.delete(listener);
  },
  captureApiRequestContext: () => state.capture(),
  rpc: (...args: unknown[]) => state.me(...args),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  subscribeSessionGeneration: (listener: () => void) => {
    state.scopeListeners.add(listener);
    return () => state.scopeListeners.delete(listener);
  },
}));
vi.mock("./search", () => ({ querySpaceSearch: state.search }));
vi.mock("./appearance", () => ({
  mobileTokens: () => ({}),
  resolveMobileAppearance: () => "dark",
}));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text, locale: "en" }),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: state.dismiss },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => <span>bot avatar</span> }));
vi.mock("../components/group-avatar", () => ({ GroupAvatar: () => <span>group avatar</span> }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/glass-icon-button", () => ({
  GlassIconButton: ({ testID, onPress }: { testID: string; onPress: () => void }) => (
    <button type="button" data-testid={testID} onClick={onPress}>
      Close
    </button>
  ),
}));
vi.mock("react-native", () => ({
  Platform: state.platform,
  Alert: { alert: state.alert },
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ width: 390 }),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    ref,
    value,
    onChangeText,
    testID,
    ...props
  }: {
    ref: React.Ref<HTMLInputElement>;
    value: string;
    onChangeText: (text: string) => void;
    testID: string;
  }) => (
    <input
      ref={ref}
      data-testid={testID}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      data-keyboard={JSON.stringify(props)}
    />
  ),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  FlatList: ({
    data,
    renderItem,
    ListEmptyComponent,
    ListHeaderComponent,
  }: {
    data: { key: string }[];
    renderItem: (info: { item: unknown }) => ReactNode;
    ListEmptyComponent: ReactNode;
    ListHeaderComponent?: ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.length
        ? data.map((item) => <div key={item.key}>{renderItem({ item })}</div>)
        : ListEmptyComponent}
    </div>
  ),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.lifecycle.clear();
  state.addListener.mockImplementation((event: string, listener: () => void) => {
    state.lifecycle.set(event, listener);
    return () => state.lifecycle.delete(event);
  });
  state.platform.OS = "ios";
  state.search.mockResolvedValue([]);
  state.me.mockResolvedValue({ userId: "user-a", spaceId: "space-default" });
  state.capture.mockImplementation(async () => ({
    apiBase: state.apiBase,
    sessionGeneration: state.generation,
    headers: {
      authorization: "Bearer fake-search-token",
      ...(state.spaceId ? { "x-rakazo-space-id": state.spaceId } : {}),
    },
  }));
  state.scopeListeners.clear();
  state.apiGeneration = 1;
  state.spaceGeneration = 1;
  state.spaceId = "space-a";
  state.selectionSeq = 0;
  state.persistedSpaceId = "space-a";
  state.generation = 1;
  state.apiBase = "https://example.test";
  state.selectSpace.mockImplementation(async (id: string) => {
    state.spaceId = id || null;
    state.persistedSpaceId = id;
    return true;
  });
  state.dismiss.mockResolvedValue(undefined);
  setSearchInbox(captureMobileScope(), spaces);
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(<SearchSheet />));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function row(label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
async function type(text: string) {
  await act(async () => {
    const field = container.querySelector("input")!;
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("renders inbox chats before typing and closes with the close button", async () => {
  expect(row("Scout, Bot").textContent).toContain("Latest reply");
  expect(row("Team, Group").textContent).toContain("Team reply");
  expect(state.search).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="search-sheet-close"]')!.click(),
  );
  expect(state.back).toHaveBeenCalledOnce();
});
it("debounces typing, renders server hits and preserves the message jump destination", async () => {
  state.search.mockResolvedValue([message, message]);
  await type("matching");
  expect(container.textContent).toContain("Searching…");
  await act(async () => vi.advanceTimersByTime(199));
  expect(state.search).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1));
  expect(state.search).toHaveBeenCalledWith(
    "matching",
    expect.objectContaining({
      requestContext: expect.objectContaining({
        headers: expect.objectContaining({ "x-rakazo-space-id": "space-a" }),
      }),
      signal: expect.any(AbortSignal),
    }),
  );
  expect(container.querySelectorAll('button[aria-label="Found note, Message"]')).toHaveLength(1);
  expect(row("Found note, Message").textContent).toContain("Scout · A matching line");
  await act(async () => row("Found note, Message").click());
  expect(state.selectSpace).toHaveBeenCalledWith("space-a");
  expect(state.dismiss).toHaveBeenCalledOnce();
  expect(state.replace).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { botId: "bot-a", name: "Scout", messageId: "message-a" },
  });
  expect(state.dismiss.mock.invocationCallOrder[0]).toBeLessThan(
    state.replace.mock.invocationCallOrder[0]!,
  );
});
it("keeps local name matching and does not duplicate conversation hits", async () => {
  state.search.mockResolvedValue([{ ...message, kind: "conversation", title: "Scout" }]);
  await type("Scout");
  await act(async () => vi.advanceTimersByTime(200));
  expect(container.querySelectorAll('button[aria-label="Scout, Bot"]')).toHaveLength(1);
  expect(row("Team, Group")).toBeNull();
});
it("opens a group after switching spaces and keeps the sheet on switch failure", async () => {
  state.selectSpace.mockResolvedValueOnce(false);
  await act(async () => row("Team, Group").click());
  expect(state.alert).toHaveBeenCalled();
  expect(state.replace).not.toHaveBeenCalled();
  act(() => setSearchInbox(captureMobileScope(), spaces));
  await act(async () => row("Team, Group").click());
  expect(state.selectSpace).toHaveBeenCalledWith("space-b");
  expect(state.replace).toHaveBeenCalledWith({
    pathname: "/group-thread",
    params: { groupId: "group-a", name: "Team" },
  });
});
it("ignores stale server responses and restores chats when cleared", async () => {
  let resolve!: (hits: (typeof message)[]) => void;
  state.search.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await type("first");
  await act(async () => vi.advanceTimersByTime(200));
  await type("second");
  await act(async () => vi.advanceTimersByTime(200));
  expect(container.textContent).toContain("No results");
  await act(async () => resolve([message]));
  expect(row("Found note, Message")).toBeNull();
  await type("");
  expect(row("Scout, Bot")).not.toBeNull();
});
it.each([
  ["conversation", "Bot"],
  ["message", "Message"],
  ["file", "File"],
  ["link", "Link"],
  ["routine", "Routine"],
] as const)("labels %s hits", (kind, label) => {
  expect(searchKindLabel({ ...message, kind })).toBe(label);
});

it("retries focus after the sheet attaches and keeps the native search keyboard options", () => {
  const field = container.querySelector("input")!;
  const focus = vi.spyOn(field, "focus");
  act(() => vi.advanceTimersByTime(350));
  expect(focus).toHaveBeenCalledOnce();
  expect(JSON.parse(field.dataset.keyboard!)).toMatchObject({
    autoFocus: true,
    autoCorrect: false,
    autoCapitalize: "none",
    returnKeyType: "search",
    keyboardAppearance: "dark",
    clearButtonMode: "while-editing",
    placeholder: "Search",
  });
});

it("opens an inbox bot with the home thread destination", async () => {
  await act(async () => row("Scout, Bot").click());
  expect(state.selectSpace).toHaveBeenCalledWith("space-a");
  expect(state.replace).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { botId: "bot-a", name: "Scout" },
  });
});

it("clears the Android field and restores inbox chats", async () => {
  state.platform.OS = "android";
  await type("no match");
  await act(async () => row("Clear").click());
  expect(container.querySelector("input")!.value).toBe("");
  expect(row("Scout, Bot")).not.toBeNull();
});

it.each(["space switch", "keyboard dismiss"] as const)(
  "cancels navigation when closed during a pending %s",
  async (stage) => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    if (stage === "space switch") {
      state.selectSpace.mockImplementationOnce(async (id: string) => {
        state.spaceId = id;
        await pending;
        state.persistedSpaceId = id;
        return true;
      });
    } else {
      state.dismiss.mockReturnValueOnce(pending);
    }
    const focus = vi.spyOn(container.querySelector("input")!, "focus");
    await act(async () => row("Team, Group").click());
    // A fresh verified Home snapshot must not let another tap overlap this pending open.
    act(() => setSearchInbox(captureMobileScope(), spaces));
    await act(async () => row("Scout, Bot").click());
    expect(state.selectSpace).toHaveBeenCalledOnce();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="search-sheet-close"]')!.click(),
    );
    await act(async () => resolve());
    act(() => vi.advanceTimersByTime(350));
    expect(focus).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.spaceId).toBe("space-a");
    expect(state.persistedSpaceId).toBe("space-a");
    if (stage === "space switch") expect(state.dismiss).not.toHaveBeenCalled();
  },
);

it.each(
  ["beforeRemove", "blur", "unmount"].flatMap((event) =>
    ["space switch", "keyboard dismiss"].map((stage) => ({ event, stage })),
  ),
)("cancels pending $stage on $event and restores the space", async ({ event, stage }) => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  if (stage === "space switch") {
    state.selectSpace.mockImplementationOnce(async (id: string) => {
      state.spaceId = id;
      await pending;
      state.persistedSpaceId = id;
      return true;
    });
  } else {
    state.dismiss.mockReturnValueOnce(pending);
  }
  await act(async () => row("Team, Group").click());
  act(() => {
    if (event === "unmount") root.unmount();
    else state.lifecycle.get(event)!();
  });
  await act(async () => resolve());
  expect(state.replace).not.toHaveBeenCalled();
  expect(state.spaceId).toBe("space-a");
  expect(state.persistedSpaceId).toBe("space-a");
});

it("keeps the selected space when successful navigation removes the sheet", async () => {
  state.replace.mockImplementationOnce(() => state.lifecycle.get("beforeRemove")!());
  await act(async () => row("Team, Group").click());
  expect(state.replace).toHaveBeenCalledOnce();
  expect(state.spaceId).toBe("space-b");
  expect(state.persistedSpaceId).toBe("space-b");
});

it.each(["space-c", "space-b"])(
  "does not restore over a newer pending selection of %s after closing during keyboard dismissal",
  async (nextSpace) => {
    let dismiss!: () => void;
    state.dismiss.mockReturnValueOnce(new Promise<void>((resolve) => (dismiss = resolve)));
    await act(async () => row("Team, Group").click());
    expect(state.spaceId).toBe("space-b");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="search-sheet-close"]')!.click(),
    );

    let finishCleanup!: () => void;
    state.selectSpace.mockImplementationOnce(async (id: string) => {
      await new Promise<void>((resolve) => (finishCleanup = resolve));
      state.spaceId = id;
      state.persistedSpaceId = id;
      return true;
    });
    let homeSelection!: ReturnType<typeof selectSpace>;
    act(() => {
      homeSelection = selectSpace(nextSpace);
    });
    // Home has started selecting, but storage cleanup still leaves B in memory.
    expect(state.spaceId).toBe("space-b");
    await act(async () => dismiss());
    expect(state.selectSpace.mock.calls).toEqual([["space-b"], [nextSpace]]);
    expect(state.replace).not.toHaveBeenCalled();
    await act(async () => {
      finishCleanup();
      expect(await homeSelection).toBe(true);
    });
    expect(state.spaceId).toBe(nextSpace);
    expect(state.persistedSpaceId).toBe(nextSpace);
    expect(state.alert).not.toHaveBeenCalled();
  },
);

it.each(
  ["space switch", "keyboard dismiss"].flatMap((stage) =>
    ["space-c", "space-b"].map((nextSpace) => ({ stage, nextSpace })),
  ),
)(
  "skips stale navigation after a newer pending $nextSpace selection during $stage",
  async ({ stage, nextSpace }) => {
    let finishOpen!: () => void;
    const pending = new Promise<void>((resolve) => (finishOpen = resolve));
    if (stage === "space switch") {
      state.selectSpace.mockImplementationOnce(async (id: string) => {
        state.spaceId = id;
        await pending;
        state.persistedSpaceId = id;
        return true;
      });
    } else {
      state.dismiss.mockReturnValueOnce(pending);
    }
    await act(async () => row("Team, Group").click());

    let finishCleanup!: () => void;
    state.selectSpace.mockImplementationOnce(async (id: string) => {
      await new Promise<void>((resolve) => (finishCleanup = resolve));
      state.spaceId = id;
      state.persistedSpaceId = id;
      return true;
    });
    let homeSelection!: ReturnType<typeof selectSpace>;
    act(() => {
      homeSelection = selectSpace(nextSpace);
    });
    // The newer request owns the selection even while B remains active.
    expect(state.spaceId).toBe("space-b");
    await act(async () => finishOpen());
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.selectSpace.mock.calls).toEqual([["space-b"], [nextSpace]]);
    expect(state.alert).not.toHaveBeenCalled();
    if (stage === "space switch") expect(state.dismiss).not.toHaveBeenCalled();
    await act(async () => {
      finishCleanup();
      expect(await homeSelection).toBe(true);
    });
    expect(state.spaceId).toBe(nextSpace);
    expect(state.persistedSpaceId).toBe(nextSpace);

    // A newly verified Home snapshot lets the focused sheet accept a fresh row tap.
    act(() => setSearchInbox(captureMobileScope(), spaces));
    await act(async () => row("Team, Group").click());
    expect(state.replace).toHaveBeenCalledOnce();
    expect(state.selectSpace.mock.calls).toEqual([["space-b"], [nextSpace], ["space-b"]]);
  },
);

it.each(["session", "server", "selection"])(
  "does not restore a cancelled attempt over a newer %s",
  async (changed) => {
    let resolve!: () => void;
    state.dismiss.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    await act(async () => row("Team, Group").click());
    act(() => state.lifecycle.get("blur")!());
    if (changed === "session") state.generation++;
    else if (changed === "server") state.apiBase = "https://other.example.test";
    else state.spaceId = "space-c";
    await act(async () => resolve());
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.selectSpace).toHaveBeenCalledOnce();
  },
);

it("shows a failed remote search beside matching local rows and lets Retry recover", async () => {
  state.search.mockRejectedValueOnce(new Error("Synthetic search unavailable"));
  await type("Scout");
  await act(async () => vi.advanceTimersByTime(200));
  expect(row("Scout, Bot")).not.toBeNull();
  expect(container.textContent).toContain("Could not search");
  expect(container.textContent).not.toContain("No results");
  state.search.mockResolvedValueOnce([message]);
  await act(async () => row("Retry").click());
  await act(async () => vi.advanceTimersByTime(200));
  expect(state.search).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Could not search");
  expect(row("Found note, Message")).not.toBeNull();
});

function scopeChanged() {
  for (const listener of state.scopeListeners) listener();
}

it.each(["session", "server", "server ABA", "space ABA"] as const)(
  "never navigates an old hit after %s changes during keyboard dismissal",
  async (changed) => {
    let finish!: () => void;
    state.dismiss.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => row("Team, Group").click());
    act(() => {
      if (changed === "session") state.generation++;
      else if (changed === "server") {
        state.apiBase = "https://other.example.test";
        state.apiGeneration++;
      } else if (changed === "server ABA") state.apiGeneration += 2;
      else state.spaceGeneration += 2;
      scopeChanged();
    });
    await act(async () => finish());
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.selectSpace).toHaveBeenCalledOnce();
  },
);

it.each(["session", "server ABA"] as const)(
  "clears the private query immediately on a new %s owner",
  async (changed) => {
    await type("private note");
    act(() => {
      if (changed === "session") state.generation++;
      else state.apiGeneration += 2;
      scopeChanged();
    });
    expect(container.querySelector("input")!.value).toBe("");
    expect(row("Scout, Bot")).toBeNull();
  },
);

it("keeps a rejected keyboard dismissal recoverable and restores only its owned selection", async () => {
  state.dismiss.mockRejectedValueOnce(new Error("Synthetic keyboard failure"));
  await act(async () => row("Team, Group").click());
  expect(state.replace).not.toHaveBeenCalled();
  expect(state.alert).toHaveBeenCalledWith("Could not open result", expect.any(String));
  expect(state.spaceId).toBe("space-a");
  act(() => setSearchInbox(captureMobileScope(), spaces));
  await act(async () => row("Team, Group").click());
  expect(state.replace).toHaveBeenCalledOnce();
});

it("resolves a null initial Space with one immutable context before querying and opening a remote hit", async () => {
  act(() => {
    state.spaceId = null;
    state.spaceGeneration++;
    scopeChanged();
    setSearchInbox(captureMobileScope(), spaces);
  });
  let resolveMe!: (me: { userId: string; spaceId: string }) => void;
  state.me.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveMe = resolve;
      }),
  );
  const remote = { ...message, botId: "absent-bot", botName: "Writer" };
  state.search.mockResolvedValueOnce([remote]);
  await type("matching");
  await act(async () => vi.advanceTimersByTime(200));
  expect(state.search).not.toHaveBeenCalled();
  expect(state.me).toHaveBeenCalledWith(
    "me",
    {},
    expect.objectContaining({
      requestContext: expect.objectContaining({
        apiBase: "https://example.test",
        headers: { authorization: "Bearer fake-search-token" },
      }),
      signal: expect.any(AbortSignal),
    }),
  );
  await act(async () => resolveMe({ userId: "user-a", spaceId: "verified-default" }));
  expect(state.search).toHaveBeenCalledWith(
    "matching",
    expect.objectContaining({
      requestContext: expect.objectContaining({
        apiBase: "https://example.test",
        headers: {
          authorization: "Bearer fake-search-token",
          "x-rakazo-space-id": "verified-default",
        },
      }),
    }),
  );
  expect(state.spaceId).toBeNull();
  await act(async () => row("Found note, Message").click());
  expect(state.selectSpace).toHaveBeenCalledWith("verified-default");
  expect(state.replace).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { botId: "absent-bot", name: "Writer", messageId: "message-a" },
  });
});

it("retries a failed initial Space resolution without hiding matching local rows", async () => {
  act(() => {
    state.spaceId = null;
    state.spaceGeneration++;
    scopeChanged();
    setSearchInbox(captureMobileScope(), spaces);
  });
  state.me.mockRejectedValueOnce(new Error("Synthetic bootstrap failure"));
  await type("Scout");
  await act(async () => vi.advanceTimersByTime(200));
  expect(state.search).not.toHaveBeenCalled();
  expect(row("Scout, Bot")).not.toBeNull();
  expect(container.textContent).toContain("Could not search");
  await act(async () => row("Retry").click());
  await act(async () => vi.advanceTimersByTime(200));
  expect(state.me).toHaveBeenCalledTimes(2);
  expect(state.search).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("Could not search");
});

it("ignores a null-scope resolution after a legitimate bootstrap selected another Space", async () => {
  act(() => {
    state.spaceId = null;
    state.spaceGeneration++;
    scopeChanged();
  });
  let resolveMe!: (me: { userId: string; spaceId: string }) => void;
  state.me.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveMe = resolve;
      }),
  );
  await type("matching");
  await act(async () => vi.advanceTimersByTime(200));
  act(() => {
    state.spaceId = "space-new";
    state.spaceGeneration++;
    state.selectionSeq++;
    scopeChanged();
  });
  await act(async () => resolveMe({ userId: "user-a", spaceId: "obsolete-default" }));
  expect(state.search).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(200));
  expect(state.search).toHaveBeenCalledWith(
    "matching",
    expect.objectContaining({
      requestContext: expect.objectContaining({
        headers: expect.objectContaining({ "x-rakazo-space-id": "space-new" }),
      }),
    }),
  );
});

it.each(["space ABA", "pending same Space", "session", "server ABA"] as const)(
  "aborts and hides old query results on %s",
  async (changed) => {
    let resolve!: (hits: (typeof message)[]) => void;
    state.search.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await type("matching");
    await act(async () => vi.advanceTimersByTime(200));
    const request = state.search.mock.calls[0]![1] as { signal: AbortSignal };
    act(() => {
      if (changed === "space ABA") state.spaceGeneration += 2;
      else if (changed === "pending same Space") state.selectionSeq++;
      else if (changed === "session") state.generation++;
      else state.apiGeneration += 2;
      scopeChanged();
    });
    expect(request.signal.aborted).toBe(true);
    await act(async () => resolve([message]));
    expect(row("Found note, Message")).toBeNull();
    if (changed === "session" || changed === "server ABA")
      expect(container.querySelector("input")!.value).toBe("");
  },
);

it.each(["session", "server ABA", "space ABA"] as const)(
  "rejects an old claimed selection receipt after %s changes",
  async (changed) => {
    let finish!: () => void;
    state.selectSpace.mockImplementationOnce(async (id: string) => {
      state.spaceId = id;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      state.persistedSpaceId = id;
      return true;
    });
    await act(async () => row("Team, Group").click());
    act(() => {
      if (changed === "session") state.generation++;
      else if (changed === "server ABA") state.apiGeneration += 2;
      else state.spaceGeneration += 2;
      scopeChanged();
    });
    await act(async () => finish());
    expect(state.dismiss).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.selectSpace).toHaveBeenCalledOnce();
    expect(state.alert).not.toHaveBeenCalled();
  },
);

it("handles a rejected Space switch without an unhandled rejection and accepts a later retry", async () => {
  state.selectSpace.mockRejectedValueOnce(new Error("Synthetic selection failure"));
  await act(async () => row("Team, Group").click());
  expect(state.alert).toHaveBeenCalledWith("Could not open result", expect.any(String));
  expect(state.replace).not.toHaveBeenCalled();
  act(() => setSearchInbox(captureMobileScope(), spaces));
  await act(async () => row("Team, Group").click());
  expect(state.replace).toHaveBeenCalledOnce();
});

it("restores an originally null Space only when the cancelled sheet still owns its claim", async () => {
  act(() => {
    state.spaceId = null;
    state.persistedSpaceId = "";
    state.spaceGeneration++;
    scopeChanged();
    setSearchInbox(captureMobileScope(), spaces);
  });
  let finish!: () => void;
  state.dismiss.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => row("Team, Group").click());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="search-sheet-close"]')!.click(),
  );
  await act(async () => finish());
  expect(state.replace).not.toHaveBeenCalled();
  expect(state.spaceId).toBeNull();
  expect(state.persistedSpaceId).toBe("");
});

it.each(["conversation", "file", "link", "routine"] as const)(
  "opens a %s result using its exact existing destination anchor",
  async (kind) => {
    const hit = {
      ...message,
      kind,
      ...(kind === "file" ? { artifactId: "file-a" } : {}),
      ...(kind === "link" ? { url: "https://example.test/note" } : {}),
      ...(kind === "routine" ? { routineId: "routine-a" } : {}),
    };
    state.search.mockResolvedValueOnce([hit]);
    await type("matching");
    await act(async () => vi.advanceTimersByTime(200));
    const label = kind === "conversation" ? "Bot" : kind[0]!.toUpperCase() + kind.slice(1);
    await act(async () => row(`Found note, ${label}`).click());
    expect(state.selectSpace).toHaveBeenCalledWith("space-a");
    expect(state.replace).toHaveBeenCalledWith(
      kind === "routine"
        ? {
            pathname: "/routine",
            params: { botId: "bot-a", botName: "Scout", routineId: "routine-a" },
          }
        : {
            pathname: "/thread",
            params: {
              botId: "bot-a",
              name: "Scout",
              ...(kind === "conversation" ? {} : { messageId: "message-a" }),
            },
          },
    );
  },
);

it("does not query an invented Space when bootstrap does not return a verified identity", async () => {
  act(() => {
    state.spaceId = null;
    state.spaceGeneration++;
    scopeChanged();
  });
  state.me.mockResolvedValueOnce({ spaceId: "unverified-space" });
  await type("matching");
  await act(async () => vi.advanceTimersByTime(200));
  expect(container.textContent).toContain("Could not search");
  expect(container.textContent).not.toContain("No results");
  expect(state.search).not.toHaveBeenCalled();
});

it("does not dispatch after an old credential-context read finishes on another server epoch", async () => {
  let finish!: (context: unknown) => void;
  state.capture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await type("matching");
  await act(async () => vi.advanceTimersByTime(200));
  act(() => {
    state.apiGeneration += 2;
    scopeChanged();
  });
  await act(async () =>
    finish({
      apiBase: "https://example.test",
      sessionGeneration: 1,
      headers: { authorization: "Bearer fake-search-token", "x-rakazo-space-id": "space-a" },
    }),
  );
  expect(state.search).not.toHaveBeenCalled();
  expect(state.me).not.toHaveBeenCalled();
  expect(container.querySelector("input")!.value).toBe("");
});
