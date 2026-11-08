// @vitest-environment jsdom

import type { PageShareState } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PageShareScreen from "../app/page-share";

type DialogButton = { text: string; onPress?: () => void };

const host = vi.hoisted(() => ({
  pageId: "page-1",
  version: 1 as number | undefined,
  viewId: "native-view" as string | undefined,
  space: "space-a",
  scope: 1,
  focused: true,
  appState: "active",
  os: "ios",
  scopeListeners: new Set<() => void>(),
  appListeners: new Set<(state: string) => void>(),
  navigationListeners: new Map<string, () => void>(),
  navigation: {
    addListener: (event: string, listener: () => void): (() => void) => {
      host.navigationListeners.set(event, listener);
      return () => host.navigationListeners.delete(event);
    },
    isFocused: (): boolean => host.focused,
  },
  alert: vi.fn<(title: string, message: string, buttons: DialogButton[]) => void>(),
  nativeShare: vi.fn(),
  copy: vi.fn(),
  openBrowser: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  getPage: vi.fn(),
  request: vi.fn(),
}));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ pageId: host.pageId, viewId: host.viewId }),
  useNavigation: () => host.navigation,
  useRouter: () => ({ back: host.back, replace: host.replace }),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => <div data-testid="loading" />,
  Alert: { alert: host.alert },
  AppState: {
    get currentState() {
      return host.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      host.appListeners.add(listener);
      return { remove: () => host.appListeners.delete(listener) };
    },
  },
  Platform: {
    get OS() {
      return host.os;
    },
  },
  Image: () => <div />,
  Share: { share: host.nativeShare },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: host.copy }));
vi.mock("expo-web-browser", () => ({ openBrowserAsync: host.openBrowser }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    accessibilityState,
    detail,
    disabled,
    title,
    onPress,
  }: {
    accessibilityState?: { checked?: boolean };
    detail?: string;
    disabled?: boolean;
    title: string;
    onPress?: () => void;
  }) => (
    <button
      type="button"
      data-checked={accessibilityState?.checked}
      aria-label={title}
      disabled={disabled}
      onClick={onPress}
    >
      {title}
      {detail ? <span>{detail}</span> : null}
    </button>
  ),
}));
vi.mock("../components/pages/page-load-failure", () => ({
  PageLoadFailure: ({ fallback, onRetry }: { fallback: string; onRetry: () => void }) => (
    <>
      <p>{fallback}</p>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </>
  ),
}));
vi.mock("./pages", () => ({
  clearPageShareView: vi.fn(),
  getLatestPage: host.getPage,
  viewedPageShareVersion: (pageId: string, viewId: string) =>
    pageId === host.pageId && viewId === "native-view" ? host.version : undefined,
  pageReadFailure: (error: { code?: string } | null) =>
    error?.code === "NOT_FOUND" || error?.code === "FORBIDDEN" ? "deleted" : "failed",
  privatePageRpc: host.request,
  pageScopeKey: () => `${host.space}:${host.scope}`,
  subscribePageScope: (listener: () => void) => {
    host.scopeListeners.add(listener);
    return () => host.scopeListeners.delete(listener);
  },
}));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string | number>) =>
    text.replace(/\{([^}]+)\}/g, (original, name: string) => String(values?.[name] ?? original));
  return { useI18n: () => ({ t }) };
});
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));

const currentUrl = `https://share.example.test/p/plan-${"a".repeat(43)}`;
const hidden: PageShareState = {
  visibility: "private",
  publishingEnabled: true,
  shareUrl: null,
  generation: null,
};
const linked: PageShareState = {
  visibility: "link",
  publishingEnabled: true,
  shareUrl: currentUrl,
  generation: "1".repeat(64),
};

let state: PageShareState;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.pageId = "page-1";
  host.version = 1;
  host.viewId = "native-view";
  host.space = "space-a";
  host.scope += 1;
  host.focused = true;
  host.appState = "active";
  host.os = "ios";
  state = hidden;
  host.alert.mockClear();
  host.nativeShare.mockReset().mockResolvedValue(undefined);
  host.copy.mockReset().mockResolvedValue(true);
  host.openBrowser.mockReset().mockResolvedValue(undefined);
  host.replace.mockClear();
  host.back.mockClear();
  host.getPage.mockReset().mockImplementation(async () => ({
    id: host.pageId,
    title: "Plan",
    owner: { name: "Owner", image: null },
    version: 1,
    currentVersion: 1,
  }));
  host.request.mockReset().mockImplementation(async (proc: string) => {
    if (proc === "pages/getShare") return state;
    if (proc === "pages/setShare") return linked;
    throw new Error(`Unexpected procedure ${proc}`);
  });
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const show = () => act(async () => root.render(<PageShareScreen />));
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const press = (label: string) => act(async () => button(label)!.click());

it("publishes only after explicit confirmation and binds the version shown by the native viewer", async () => {
  await show();
  expect(button("Only you")?.getAttribute("data-checked")).toBe("true");
  await press("Anyone with the link");
  expect(host.alert).toHaveBeenCalledOnce();
  expect(host.request.mock.calls.map(([proc]) => proc)).toEqual(["pages/getShare"]);
  const confirm = host.alert.mock.calls[0]![2].find(({ text }) => text === "Share");
  expect(confirm?.onPress).toBeTypeOf("function");
  const response = deferred<PageShareState>();
  host.request.mockReturnValueOnce(response.promise);
  await act(async () => {
    confirm?.onPress?.();
    confirm?.onPress?.();
  });
  expect(host.request.mock.calls.filter(([proc]) => proc === "pages/setShare")).toHaveLength(1);
  await act(async () => response.resolve(linked));
  expect(host.request).toHaveBeenCalledWith(
    "pages/setShare",
    { pageId: "page-1", visibility: "link", expectedVersion: 1 },
    expect.any(Function),
  );
  expect(button("Copy link")).not.toBeNull();
  expect(container.textContent).not.toContain(currentUrl);
});

it.each(["ios", "android"])(
  "rechecks the current generation before each %s native action",
  async (os) => {
    host.os = os;
    state = linked;
    await show();

    await press("Copy link");
    await press("Share");
    await press("Open in browser");

    expect(host.copy).toHaveBeenCalledExactlyOnceWith(currentUrl);
    expect(host.nativeShare).toHaveBeenCalledExactlyOnceWith(
      os === "ios" ? { url: currentUrl } : { message: currentUrl },
    );
    expect(host.openBrowser).toHaveBeenCalledExactlyOnceWith(currentUrl);
    expect(host.request.mock.calls.map(([proc]) => proc)).toEqual(Array(4).fill("pages/getShare"));
  },
);

it("keeps a dormant link revocable without exposing it or requiring a rendered version", async () => {
  host.viewId = undefined;
  state = { ...linked, publishingEnabled: false, shareUrl: null, generation: null };
  host.request.mockImplementation(async (proc: string) =>
    proc === "pages/getShare" ? state : { ...hidden, publishingEnabled: false },
  );
  await show();
  expect(button("Anyone with the link")?.getAttribute("data-checked")).toBe("true");
  expect(button("Anyone with the link")?.disabled).toBe(true);
  expect(button("Copy link")).toBeNull();

  await press("Only you");
  expect(host.request).toHaveBeenCalledWith(
    "pages/setShare",
    { pageId: "page-1", visibility: "private" },
    expect.any(Function),
  );
  expect(button("Only you")?.getAttribute("data-checked")).toBe("true");
  expect(host.alert).not.toHaveBeenCalled();
});

it.each([
  { name: "a direct route", viewId: "external-route", version: 1 },
  { name: "an older version", viewId: "native-view", version: 2 },
])("requires an open current viewer before publishing from $name", async ({ viewId, version }) => {
  host.viewId = viewId;
  host.version = version;
  await show();
  expect(button("Anyone with the link")?.disabled).toBe(true);
  await press("Anyone with the link");
  expect(host.alert).not.toHaveBeenCalled();
  await press("Open current version");
  expect(host.replace).toHaveBeenCalledExactlyOnceWith({
    pathname: "/page",
    params: { pageId: "page-1" },
  });
});

it("rereads after a version conflict and requires reviewing the current version again", async () => {
  await show();
  await press("Anyone with the link");
  host.request.mockRejectedValueOnce({ code: "CONFLICT" });
  host.getPage.mockImplementationOnce(async () => ({
    title: "Updated plan",
    owner: { name: "Owner", image: null },
    version: 2,
    currentVersion: 2,
  }));
  const confirm = host.alert.mock.calls[0]![2].find(({ text }) => text === "Share");
  await act(async () => confirm?.onPress?.());

  expect(container.textContent).toContain("The page or its link changed.");
  expect(button("Anyone with the link")?.disabled).toBe(true);
  expect(button("Open current version")).not.toBeNull();
  expect(host.request.mock.calls.map(([proc]) => proc)).toEqual([
    "pages/getShare",
    "pages/setShare",
    "pages/getShare",
  ]);
});

it("rereads a lost write once and lets an owner revoke when the outcome remains unknown", async () => {
  await show();
  await press("Anyone with the link");
  host.request.mockImplementationOnce(async () => {
    state = linked;
    throw new Error("Lost answer");
  });
  const confirm = host.alert.mock.calls[0]![2].find(({ text }) => text === "Share");
  await act(async () => confirm?.onPress?.());
  expect(button("Anyone with the link")?.getAttribute("data-checked")).toBe("true");
  expect(button("Copy link")).not.toBeNull();

  host.request
    .mockRejectedValueOnce(new Error("Lost answer"))
    .mockRejectedValueOnce(new Error("Offline"));
  await press("Only you");
  expect(button("Only you")?.getAttribute("data-checked")).toBe("false");
  expect(button("Only you")?.disabled).toBe(false);
  expect(button("Anyone with the link")?.getAttribute("data-checked")).toBe("false");
  expect(button("Copy link")).toBeNull();
  expect(host.request.mock.calls.map(([proc]) => proc)).toEqual([
    "pages/getShare",
    "pages/setShare",
    "pages/getShare",
    "pages/setShare",
    "pages/getShare",
  ]);
});

it.each([
  { action: "Copy link", next: { ...linked, generation: "2".repeat(64) } },
  { action: "Share", next: hidden },
  {
    action: "Open in browser",
    next: { ...linked, shareUrl: currentUrl.replace("share.example.test", "other.example.test") },
  },
])("refuses a stale native $action instead of using a changed link", async ({ action, next }) => {
  state = linked;
  await show();
  state = next;
  await press(action);
  expect(container.textContent).toContain("The page or its link changed.");
  expect(host.copy).not.toHaveBeenCalled();
  expect(host.nativeShare).not.toHaveBeenCalled();
  expect(host.openBrowser).not.toHaveBeenCalled();
  expect(host.request.mock.calls.map(([proc]) => proc)).toEqual([
    "pages/getShare",
    "pages/getShare",
  ]);
});

function setFocus(focused: boolean) {
  host.focused = focused;
  host.navigationListeners.get(focused ? "focus" : "blur")?.();
}

function setAppState(appState: string) {
  host.appState = appState;
  for (const listener of host.appListeners) listener(appState);
}

it.each(["scope", "focus", "foreground"])(
  "discards an outstanding link handoff after a same-value %s round trip",
  async (boundary) => {
    state = linked;
    await show();
    const delayed = deferred<PageShareState>();
    host.request.mockReturnValueOnce(delayed.promise);
    await press("Share");
    const guard = host.request.mock.calls.at(-1)?.[2] as (() => boolean) | undefined;
    expect(guard?.()).toBe(true);

    await act(async () => {
      if (boundary === "scope") {
        host.space = "space-b";
        host.scope += 1;
        for (const listener of host.scopeListeners) listener();
        host.space = "space-a";
        host.scope += 1;
        for (const listener of host.scopeListeners) listener();
      } else if (boundary === "focus") {
        setFocus(false);
        setFocus(true);
      } else {
        setAppState("background");
        setAppState("active");
      }
    });
    expect(guard?.()).toBe(false);
    await act(async () => delayed.resolve(linked));

    expect(host.nativeShare).not.toHaveBeenCalled();
    expect(button("Share")).not.toBeNull();
  },
);

it("rejects a stale confirmation after the sheet loses focus", async () => {
  await show();
  await press("Anyone with the link");
  const confirm = host.alert.mock.calls[0]![2].find(({ text }) => text === "Share");
  await act(async () => {
    setFocus(false);
    setFocus(true);
    confirm?.onPress?.();
  });
  expect(host.request.mock.calls.some(([proc]) => proc === "pages/setShare")).toBe(false);
});

it("never offers a link or mutation when owner access is denied", async () => {
  host.request.mockRejectedValue({ code: "FORBIDDEN" });
  await show();
  expect(button("Only you")).toBeNull();
  expect(button("Share")).toBeNull();
});
