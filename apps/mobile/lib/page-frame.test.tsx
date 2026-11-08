// @vitest-environment jsdom

import type { ComponentProps, Ref } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { GestureResponderEvent, ViewProps } from "react-native";
import type { WebViewProps } from "react-native-webview";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageFrame } from "../components/pages/page-frame";

const host = vi.hoisted(() => ({
  touch: undefined as ViewProps | undefined,
  frame: undefined as WebViewProps | undefined,
  focus: true,
  appState: "active",
  blur: undefined as (() => void) | undefined,
  appChanged: undefined as ((state: string) => void) | undefined,
  nextId: 0,
  inject: vi.fn<(code: string) => void>(),
  copy: vi.fn<(text: string) => Promise<boolean>>(),
  link: vi.fn(),
}));

vi.mock("expo-modules-core", () => ({
  uuid: { v4: () => `native-test-${++host.nextId}` },
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: host.copy }));
vi.mock("@rakazo/chat-ui/native", () => ({ useNativeLinkConfirm: () => host.link }));
vi.mock("expo-router", () => {
  const navigation = {
    isFocused: () => host.focus,
    addListener: (_event: string, fn: () => void) => {
      host.blur = fn;
      return () => {
        host.blur = undefined;
      };
    },
  };
  return { useNavigation: () => navigation };
});
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  StyleSheet: { create: (styles: unknown) => styles },
  AppState: {
    get currentState() {
      return host.appState;
    },
    addEventListener: (_event: string, fn: (state: string) => void) => {
      host.appChanged = fn;
      return {
        remove: () => {
          host.appChanged = undefined;
        },
      };
    },
  },
  View: (props: ViewProps) => {
    host.touch = props;
    return props.children;
  },
}));
vi.mock("react-native-webview", async () => {
  const { useImperativeHandle } = await import("react");
  return {
    WebView: ({
      ref,
      ...props
    }: WebViewProps & { ref: Ref<{ injectJavaScript: typeof host.inject }> }) => {
      host.frame = props;
      useImperativeHandle(ref, () => ({ injectJavaScript: host.inject }), []);
      return <div data-testid="native-page-frame" />;
    },
  };
});

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  host.nextId = 0;
  host.appState = "active";
  host.focus = true;
  host.inject.mockReset();
  host.copy.mockReset().mockResolvedValue(true);
  host.link.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const render = (options: Partial<ComponentProps<typeof PageFrame>> = {}) =>
  act(async () =>
    root.render(
      <PageFrame
        document="<!doctype html><p>Sample Page</p>"
        documentKey="scope:page:version-1"
        background="white"
        interactive
        {...options}
      />,
    ),
  );

function navigate(url = "about:blank") {
  const event = { nativeEvent: { url } } as Parameters<NonNullable<WebViewProps["onLoad"]>>[0];
  host.frame?.onLoadStart?.(event);
  host.frame?.onLoad?.(event);
}

function touch(
  name: "onTouchStart" | "onTouchMove" | "onTouchEnd" | "onTouchCancel",
  x = 0,
  n = 1,
) {
  host.touch?.[name]?.({
    nativeEvent: { identifier: "finger", pageX: x, pageY: 0, touches: Array(n).fill({}) },
  } as GestureResponderEvent);
}

function tap() {
  touch("onTouchStart");
  touch("onTouchEnd", 0, 0);
}

function receive(instance: string, message: object, handler = host.frame?.onMessage) {
  handler?.({
    nativeEvent: { data: JSON.stringify({ instance, message }) },
  } as Parameters<NonNullable<WebViewProps["onMessage"]>>[0]);
}

const reply = { type: "rakazo-page:reply", text: "Explain\nthis" };
const copy = { type: "rakazo-page:copy", id: "copy-1", text: "Page details" };

it("mounts only the sandboxed local shell and never enables a native bridge for previews", async () => {
  await render({ interactive: false });
  expect(host.frame?.onMessage).toBeUndefined();
  expect(host.touch?.onTouchStart).toBeUndefined();
  expect(host.frame?.originWhitelist).toEqual(["*"]);
  expect(host.frame?.allowsLinkPreview).toBe(false);
  expect(host.frame?.allowFileAccess).toBe(false);
  expect(host.frame?.sharedCookiesEnabled).toBe(false);
  expect(host.frame?.source).toMatchObject({
    baseUrl: "about:blank",
    html: expect.stringContaining('sandbox="allow-scripts"'),
  });
  const allow = (url: string, isTopFrame: boolean) =>
    host.frame?.onShouldStartLoadWithRequest?.({
      url,
      isTopFrame,
    } as Parameters<NonNullable<WebViewProps["onShouldStartLoadWithRequest"]>>[0]);
  expect(allow("about:blank", true)).toBe(true);
  expect(allow("about:srcdoc", false)).toBe(true);
  expect(allow("about:srcdoc", true)).toBe(false);
  for (const url of ["https://external.example.test", "mailto:x@example.test", "about:blank#x"])
    expect(allow(url, false)).toBe(false);

  navigate("https://external.example.test");
  expect(host.inject).not.toHaveBeenCalled();
  navigate();
  expect(host.inject).toHaveBeenCalledOnce();
  expect(host.inject.mock.calls[0]?.[0]).toContain(", null);true;");
  expect(host.inject.mock.calls[0]?.[0]).not.toContain("rakazo-page:gesture");
});

it("accepts only one valid action for a real current tap and drops scrolling, multi-touch and cancel", async () => {
  const onReply = vi.fn();
  await render({ onReply });
  navigate();
  const instance = "native-test-1";
  receive(instance, reply);
  expect(onReply).not.toHaveBeenCalled();

  touch("onTouchStart");
  touch("onTouchMove", 30);
  touch("onTouchEnd", 0, 0);
  receive(instance, reply);
  touch("onTouchStart", 0, 2);
  touch("onTouchEnd", 0, 0);
  receive(instance, reply);
  touch("onTouchStart");
  touch("onTouchCancel");
  touch("onTouchEnd", 0, 0);
  receive(instance, reply);
  expect(onReply).not.toHaveBeenCalled();

  const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
  try {
    tap();
    clock.mockReturnValue(11_001);
    receive(instance, reply);
    expect(onReply).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }

  tap();
  receive("forged", reply);
  receive(instance, { type: "rakazo-page:open-link", url: "javascript:alert(1)" });
  receive(instance, reply);
  receive(instance, copy);
  expect(onReply).toHaveBeenCalledExactlyOnceWith("Explain this");
  expect(host.copy).not.toHaveBeenCalled();
  expect(host.link).not.toHaveBeenCalled();

  tap();
  receive(instance, { type: "rakazo-page:open-link", url: "https://external.example.test/page" });
  expect(host.link).toHaveBeenCalledExactlyOnceWith("https://external.example.test/page");
});

it("revokes old taps, callbacks and copy acknowledgments on reload, focus loss and scope change", async () => {
  const onReply = vi.fn();
  let current = true;
  const isCurrent = () => current;
  await render({ onReply, isCurrent });
  navigate();
  tap();
  navigate();
  receive("native-test-3", reply);
  tap();
  receive("native-test-1", reply);
  expect(onReply).not.toHaveBeenCalled();

  let settle: (ok: boolean) => void = () => undefined;
  host.copy.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
  receive("native-test-3", copy);
  expect(host.copy).toHaveBeenCalledExactlyOnceWith("Page details");
  host.focus = false;
  host.blur?.();
  host.focus = true;
  await act(async () => settle(true));
  expect(host.inject).toHaveBeenCalledTimes(2);

  tap();
  host.appState = "background";
  host.appChanged?.("background");
  host.appState = "active";
  receive("native-test-3", reply);
  tap();
  current = false;
  receive("native-test-3", reply);
  expect(onReply).not.toHaveBeenCalled();
  current = true;

  const obsolete = host.frame?.onMessage;
  await render({ documentKey: "scope:page:version-2", onReply, isCurrent });
  navigate();
  tap();
  receive("native-test-3", reply, obsolete);
  expect(onReply).not.toHaveBeenCalled();
  await act(async () => receive("native-test-5", copy));
  expect(host.inject.mock.lastCall?.[0]).toContain(
    'window.coginePage?.answer("native-test-5", {"type":"rakazo-page:copied","id":"copy-1","ok":true})',
  );
});
