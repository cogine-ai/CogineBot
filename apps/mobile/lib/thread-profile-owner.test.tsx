// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import React, {
  act,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import {
  threadRouteSpaceOnFocus,
  threadSpaceRequest,
  threadSpaceSwitchResult,
} from "./notification-open";

const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
const routeBody = source.slice(
  source.indexOf("export default function ThreadRoute()"),
  source.indexOf("function createThreadHeaderStyles()"),
);
const setupStart = source.indexOf('  const readOnly = readOnlyParam === "1";');
const profileSetup = source.slice(setupStart, source.indexOf("  const [restoring", setupStart));
const callbackStart = source.indexOf(
  "  const openBotProfile = useCallback(",
  source.indexOf("function Thread("),
);
const callbackBody =
  callbackStart < 0
    ? ""
    : source.slice(
        callbackStart,
        source.indexOf(
          "  useLayoutEffect(() => {\n    navigation.setOptions({\n      title: displayName",
          callbackStart,
        ),
      );
const hookStart = source.indexOf("function useThreadProfileNavigation(");
const hookBody =
  hookStart < 0 ? "" : source.slice(hookStart, source.indexOf("function Thread(", hookStart));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function harness(
  readOnly = false,
  options: {
    implicit?: boolean;
    initialSpace?: string | null;
    botSpaceId?: string;
    botGate?: Promise<{ id: string; spaceId: string }>;
    contextGate?: Promise<void>;
    failBot?: boolean;
  } = {},
) {
  const live = {
    apiBase: "https://api.example.test",
    apiGeneration: 1,
    sessionGeneration: 1,
    spaceId: options.initialSpace === undefined ? "space-a" : options.initialSpace,
    spaceGeneration: 1,
    selectionSeq: 1,
  };
  const state = {
    focused: true,
    ready: 1,
    pending: false,
    params: { botId: "bot-a", spaceId: "space-a", readOnly: readOnly ? "1" : "0" } as Record<
      string,
      string
    >,
    userId: "user-a",
    suspend: false,
    verifyGate: null as Promise<{ apiBase: string; userId: string }> | null,
    menus: [] as Array<() => void>,
    mounts: 0,
    serial: 0,
    push: vi.fn(),
    switchResult: deferred<boolean>(),
    defaultSpaceId: "space-a",
    botSpaceId: options.botSpaceId ?? "space-a",
    botGate: options.botGate ?? null,
    contextGate: options.contextGate ?? null,
    failBot: options.failBot ?? false,
  };
  if (options.implicit) delete state.params.spaceId;
  const scopeListeners = new Set<() => void>(),
    sessionListeners = new Set<() => void>(),
    pendingListeners = new Set<() => void>();
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const suspended = deferred<void>();
  const captureMobileScope = () => ({ ...live });
  const isMobileScopeCurrent = (scope: unknown) => JSON.stringify(scope) === JSON.stringify(live);
  const isMobileSessionCurrent = (scope: typeof live) =>
    scope.apiBase === live.apiBase &&
    scope.apiGeneration === live.apiGeneration &&
    scope.sessionGeneration === live.sessionGeneration;
  const router = { push: state.push, replace: vi.fn() };
  const navigation = { isFocused: () => state.focused };
  const scope = {
    useMessageSpeechAvailable: () => false,
    React,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    captureMobileScope,
    isMobileScopeCurrent,
    isMobileSessionCurrent,
    mobileScopeKey: () => JSON.stringify(live),
    subscribeMobileScope: subscribe(scopeListeners),
    currentSessionGeneration: () => live.sessionGeneration,
    currentReadySessionGeneration: () => state.ready,
    subscribeSessionGeneration: subscribe(sessionListeners),
    currentApiBase: () => live.apiBase,
    currentApiBaseGeneration: () => live.apiGeneration,
    selectedSpaceId: () => live.spaceId,
    isSpaceSelectionPending: () => state.pending,
    subscribeSpaceSelectionPending: subscribe(pendingListeners),
    integrationsCacheScope: async () => ({ ...live, userId: state.userId }),
    loadVerifiedIntegrationsScope: async () =>
      state.verifyGate ? state.verifyGate : { ...live, userId: state.userId },
    maybeSuspend: () => {
      if (state.suspend) throw suspended.promise;
    },
    useMobileTokens: () => ({ foreground: "black", background: "white" }),
    useI18n: () => ({ t: (text: string) => text }),
    useRouter: () => router,
    useNavigation: () => navigation,
    useIsFocused: () => state.focused,
    useLocalSearchParams: () => state.params,
    threadRouteSpaceOnFocus,
    threadSpaceRequest,
    threadSpaceSwitchResult,
    selectSpace: vi.fn(() => state.switchResult.promise),
    spaceRequestContext: vi.fn(async () => {
      if (state.contextGate) await state.contextGate;
      return {
        apiBase: live.apiBase,
        sessionGeneration: live.sessionGeneration,
        headers: { "x-rakazo-space-id": state.defaultSpaceId },
      };
    }),
    rpc: vi.fn(async (path: string) => {
      if (state.failBot) throw new Error("Unavailable");
      const bot = state.botGate
        ? await state.botGate
        : { id: state.params.botId, spaceId: state.botSpaceId };
      return path === "bots/listArchived" ? [bot] : bot;
    }),
    Alert: { alert: vi.fn() },
    t: (text: string) => text,
    errorText: (error: Error) => error.message,
    ActivityIndicator: () => React.createElement("progress"),
    Text: ({ children }: { children: ReactNode }) => React.createElement("span", null, children),
    Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) =>
      React.createElement("button", { type: "button", onClick: onPress }, children),
    View: ({ children, style }: { children: ReactNode; style?: React.CSSProperties }) =>
      React.createElement("div", { style }, children),
    Probe({ open }: { open: () => void }) {
      const [draft, setDraft] = useState("");
      const scroll = useRef(0);
      const instance = useRef(++state.serial);
      useEffect(() => {
        state.mounts++;
      }, []);
      useLayoutEffect(() => {
        state.menus.push(open);
      }, [open]);
      return React.createElement(
        "div",
        { "data-instance": instance.current },
        React.createElement("input", {
          "aria-label": "Draft",
          value: draft,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
        }),
        React.createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              scroll.current = 42;
              setDraft("Retained draft");
            },
          },
          "Edit draft",
        ),
        React.createElement("span", { "data-scroll": scroll.current }, "Composer"),
        React.createElement("button", { type: "button", onClick: open }, "Profile"),
      );
    },
  };
  const code = `${hookBody}\nfunction Thread({sessionEpoch, profileScope}) {\nconst {botId, groupId, readOnly:readOnlyParam}=useLocalSearchParams();\nconst inGroup=Boolean(groupId); const router=useRouter(); const navigation=useNavigation();\n${profileSetup}\n${callbackBody}\nmaybeSuspend();
return React.createElement(Probe, {open:openBotProfile});\n}\n${routeBody.replace("export default ", "")}\nreturn ThreadRoute;`;
  const Route = new Function(
    ...Object.keys(scope),
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText,
  )(...Object.values(scope));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const element = () =>
    React.createElement(
      React.Suspense,
      { fallback: React.createElement("progress") },
      React.createElement(Route),
    );
  async function render() {
    await act(async () => root.render(element()));
  }
  async function transition() {
    await act(async () => React.startTransition(() => root.render(element())));
  }
  async function update(change: Partial<typeof live> = {}, other: Partial<typeof state> = {}) {
    await act(async () => {
      Object.assign(live, change);
      Object.assign(state, other);
      for (const listener of [...scopeListeners, ...sessionListeners, ...pendingListeners])
        listener();
      root.render(element());
    });
  }
  const click = async (label: string) => {
    await act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === label)!.click(),
    );
  };
  await render();
  return {
    live,
    state,
    container,
    scope,
    render,
    update,
    click,
    transition,
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  "renews a retained route after covered Space A-B-A without replacing its composer (readonly=%s)",
  async (readOnly) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const h = await harness(readOnly);
    try {
      await h.click("Edit draft");
      const instance = h.container.querySelector("[data-instance]")!.getAttribute("data-instance");
      const oldMenu = h.state.menus.at(-1)!;
      await h.update({}, { focused: false });
      await h.update({ spaceId: "space-b", spaceGeneration: 2, selectionSeq: 2 });
      await h.update({ spaceId: "space-a", spaceGeneration: 3, selectionSeq: 3 });
      await h.update({}, { focused: true });
      await act(async () => oldMenu());
      expect(h.state.push).not.toHaveBeenCalled();
      await h.click("Profile");
      expect(h.state.push).toHaveBeenCalledExactlyOnceWith({
        pathname: "/bot-profile",
        params: { botId: "bot-a", ...(readOnly ? { readOnly: "1" } : {}) },
      });
      expect(h.state.mounts).toBe(1);
      expect(h.container.querySelector("[data-instance]")!.getAttribute("data-instance")).toBe(
        instance,
      );
      expect(h.container.querySelector<HTMLInputElement>("input")!.value).toBe("Retained draft");
      expect(h.container.querySelector("[data-scroll]")!.getAttribute("data-scroll")).toBe("42");
    } finally {
      await h.close();
    }
  },
);

it("keeps a current expanded menu usable across unrelated streaming renders", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const h = await harness();
  try {
    const menu = h.state.menus.at(-1)!;
    await h.render();
    await h.click("Edit draft");
    await act(async () => menu());
    expect(h.state.push).toHaveBeenCalledOnce();
    expect(h.state.mounts).toBe(1);
  } finally {
    await h.close();
  }
});

it("keeps the committed menu authority through a discarded bot render", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const h = await harness();
  try {
    await h.click("Edit draft");
    const menu = h.state.menus.at(-1)!;
    h.state.params.botId = "uncommitted-bot";
    h.state.suspend = true;
    await h.transition();
    await act(async () => menu());
    expect(h.state.push).toHaveBeenCalledExactlyOnceWith({
      pathname: "/bot-profile",
      params: { botId: "bot-a" },
    });
    h.state.params.botId = "bot-a";
    h.state.suspend = false;
    await h.render();
    expect(h.state.mounts).toBe(1);
    expect(h.container.querySelector<HTMLInputElement>("input")!.value).toBe("Retained draft");
  } finally {
    await h.close();
  }
});

it("does not renew through API ABA until the route verifies that API epoch", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const h = await harness();
  try {
    const old = h.state.menus.at(-1)!;
    const verification = deferred<{ apiBase: string; userId: string }>();
    h.state.verifyGate = verification.promise;
    await h.update({ apiGeneration: 2 });
    await h.update({ apiGeneration: 3 });
    await h.click("Profile");
    expect(h.state.push).not.toHaveBeenCalled();
    await act(async () =>
      verification.resolve({ apiBase: h.live.apiBase, userId: h.state.userId }),
    );
    await act(async () => old());
    expect(h.state.push).not.toHaveBeenCalled();
    await h.click("Profile");
    expect(h.state.push).toHaveBeenCalledOnce();
    expect(h.state.mounts).toBe(1);
  } finally {
    await h.close();
  }
});

it("keeps a different verified user on the existing separate Thread ownership key", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const h = await harness();
  try {
    await h.click("Edit draft");
    const old = h.state.menus.at(-1)!;
    await h.update({ sessionGeneration: 2 }, { ready: 1, userId: "user-b" });
    await act(async () => old());
    expect(h.state.push).not.toHaveBeenCalled();
    await h.update({}, { ready: 2 });
    await act(async () => old());
    expect(h.state.push).not.toHaveBeenCalled();
    expect(h.state.mounts).toBe(2);
    expect(h.container.querySelector<HTMLInputElement>("input")!.value).toBe("");
  } finally {
    await h.close();
  }
});

it("blocks same-ID pending selection and renews only after settlement, preserving the composer", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const h = await harness();
  try {
    await h.click("Edit draft");
    const old = h.state.menus.at(-1)!;
    await h.update({ selectionSeq: 2 }, { pending: true });
    await h.click("Profile");
    expect(h.state.push).not.toHaveBeenCalled();
    await h.update({ spaceGeneration: 2 });
    await h.click("Profile");
    expect(h.state.push).not.toHaveBeenCalled();
    await h.update({}, { pending: false });
    await act(async () => old());
    expect(h.state.push).not.toHaveBeenCalled();
    await h.click("Profile");
    expect(h.state.push).toHaveBeenCalledOnce();
    expect(h.state.mounts).toBe(1);
    expect(h.container.querySelector<HTMLInputElement>("input")!.value).toBe("Retained draft");
  } finally {
    await h.close();
  }
});

it("blocks an explicit Space switch that is pending or failed without calling it a retained composer case", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const h = await harness();
  try {
    const old = h.state.menus.at(-1)!;
    await h.update({}, { focused: false });
    await h.update({ spaceId: "space-b", spaceGeneration: 2, selectionSeq: 2 });
    await h.update({}, { focused: true });
    expect(h.container.textContent).not.toContain("Composer");
    await act(async () => old());
    expect(h.state.push).not.toHaveBeenCalled();
    await act(async () => h.state.switchResult.resolve(false));
    expect(h.container.textContent).toContain("Could not switch spaces");
    await act(async () => old());
    expect(h.state.push).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

it.each(["bot", "readonly", "blur", "session"])(
  "does not revive a retained menu after %s ownership changes",
  async (edge) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const h = await harness();
    try {
      const old = h.state.menus.at(-1)!;
      if (edge === "bot") h.state.params.botId = "bot-next";
      else if (edge === "readonly") h.state.params.readOnly = "1";
      else if (edge === "blur") {
        await h.update({}, { focused: false });
      } else {
        await h.update({ sessionGeneration: 2 }, { ready: 1 });
        await act(async () => old());
        expect(h.state.push).not.toHaveBeenCalled();
        await h.update({}, { ready: 2 });
      }
      await h.update({}, { focused: true });
      await act(async () => old());
      expect(h.state.push).not.toHaveBeenCalled();
      await h.click("Profile");
      expect(h.state.push).toHaveBeenCalledOnce();
      expect(h.state.mounts).toBe(1);
    } finally {
      await h.close();
    }
  },
);

it("does not rebind an implicit Bot A route to foreign live Space B on refocus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const h = await harness(false, { implicit: true });
  try {
    await h.click("Edit draft");
    const old = h.state.menus.at(-1)!;
    await h.update({}, { focused: false });
    await h.update({ spaceId: "space-b", spaceGeneration: 2, selectionSeq: 2 });
    await h.update({}, { focused: true });
    await h.click("Profile");
    await act(async () => old());
    expect(h.state.push).not.toHaveBeenCalled();
    expect(h.state.mounts).toBe(1);
    expect(h.container.querySelector<HTMLInputElement>("input")!.value).toBe("Retained draft");
    await h.update({}, { focused: false });
    await h.update({ spaceId: "space-a", spaceGeneration: 3, selectionSeq: 3 });
    await h.update({}, { focused: true });
    await h.click("Profile");
    expect(h.state.push).toHaveBeenCalledExactlyOnceWith({
      pathname: "/bot-profile",
      params: { botId: "bot-a" },
    });
    expect(h.scope.selectSpace).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

it.each([false, true])(
  "verifies an implicit default Space without selecting it (readonly=%s)",
  async (readOnly) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const h = await harness(readOnly, { implicit: true, initialSpace: null });
    try {
      expect(h.scope.spaceRequestContext).toHaveBeenCalledOnce();
      expect(h.scope.rpc).toHaveBeenCalledExactlyOnceWith(
        readOnly ? "bots/listArchived" : "bots/get",
        readOnly ? {} : { botId: "bot-a" },
        {
          requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-a" } }),
        },
      );
      expect(h.live.spaceId).toBeNull();
      expect(h.scope.selectSpace).not.toHaveBeenCalled();
      await h.click("Profile");
      expect(h.state.push).toHaveBeenCalledExactlyOnceWith({
        pathname: "/bot-profile",
        params: { botId: "bot-a", ...(readOnly ? { readOnly: "1" } : {}) },
      });
    } finally {
      await h.close();
    }
  },
);

it.each(["wrong-space", "failed-read"])(
  "withholds default-Space authority after %s and can verify again on refocus",
  async (edge) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const h = await harness(false, {
      implicit: true,
      initialSpace: null,
      botSpaceId: edge === "wrong-space" ? "space-b" : "space-a",
      failBot: edge === "failed-read",
    });
    try {
      await h.click("Edit draft");
      await h.click("Profile");
      expect(h.state.push).not.toHaveBeenCalled();
      await h.update({}, { focused: false, botSpaceId: "space-a", failBot: false });
      await h.update({}, { focused: true });
      await h.click("Profile");
      expect(h.state.push).toHaveBeenCalledOnce();
      expect(h.state.mounts).toBe(1);
      expect(h.container.querySelector<HTMLInputElement>("input")!.value).toBe("Retained draft");
      expect(h.scope.selectSpace).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  },
);

it.each(["context", "bot"])(
  "rejects a late default-Space %s response after Space ownership changes",
  async (edge) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const context = deferred<void>();
    const bot = deferred<{ id: string; spaceId: string }>();
    const h = await harness(false, {
      implicit: true,
      initialSpace: null,
      contextGate: edge === "context" ? context.promise : undefined,
      botGate: edge === "bot" ? bot.promise : undefined,
    });
    try {
      await h.click("Profile");
      expect(h.state.push).not.toHaveBeenCalled();
      await h.update({}, { focused: false });
      await h.update({ spaceId: "space-b", spaceGeneration: 2, selectionSeq: 2 });
      await h.update({}, { focused: true });
      await act(async () => {
        context.resolve();
        bot.resolve({ id: "bot-a", spaceId: "space-a" });
      });
      if (edge === "context") expect(h.scope.rpc).not.toHaveBeenCalled();
      await h.click("Profile");
      expect(h.state.push).not.toHaveBeenCalled();
      expect(h.scope.selectSpace).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  },
);

it("invalidates a null-Space proof through selection ABA without adopting a new server default", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const h = await harness(false, { implicit: true, initialSpace: null });
  try {
    const old = h.state.menus.at(-1)!;
    await h.click("Profile");
    expect(h.state.push).toHaveBeenCalledOnce();
    h.state.push.mockClear();
    await h.update({}, { focused: false, defaultSpaceId: "space-b", botSpaceId: "space-b" });
    await h.update({ spaceGeneration: 2, selectionSeq: 2 });
    await h.update({}, { focused: true });
    await act(async () => old());
    await h.click("Profile");
    expect(h.state.push).not.toHaveBeenCalled();
    await h.update({}, { focused: false, defaultSpaceId: "space-a", botSpaceId: "space-a" });
    await h.update({}, { focused: true });
    await h.click("Profile");
    expect(h.state.push).toHaveBeenCalledOnce();
    expect(h.live.spaceId).toBeNull();
    expect(h.scope.selectSpace).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
