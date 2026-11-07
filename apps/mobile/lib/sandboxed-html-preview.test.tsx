// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  props: {} as {
    onLoadStart?: () => void;
    onMessage?: (event: { nativeEvent: { data: string } }) => void;
    onShouldStartLoadWithRequest?: (request: { url: string }) => boolean;
    allowsLinkPreview?: boolean;
    domStorageEnabled?: boolean;
    sharedCookiesEnabled?: boolean;
    allowFileAccess?: boolean;
  },
  inject: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("react-native-webview", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    WebView: forwardRef((props: typeof native.props, ref) => {
      native.props = props;
      useImperativeHandle(ref, () => ({ injectJavaScript: native.inject }));
      return null;
    }),
  };
});
const { SandboxedHtmlPreview } = await import("../components/sandboxed-html-preview");

it("forwards every native document loadstart and keeps long-press/navigation isolation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onLoadStart = vi.fn();
  const onMessage = vi.fn();
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      createElement(SandboxedHtmlPreview, {
        html: "<p>Private page</p>",
        onLoadStart,
        onMessage,
      }),
    ),
  );
  // The document can reload itself without changing React's html prop.
  native.props.onLoadStart?.();
  native.props.onLoadStart?.();
  expect(onLoadStart).toHaveBeenCalledTimes(2);
  expect(native.props.allowsLinkPreview).toBe(false);
  expect(native.props.domStorageEnabled).toBe(false);
  expect(native.props.sharedCookiesEnabled).toBe(false);
  expect(native.props.allowFileAccess).toBe(false);
  expect(native.props.onShouldStartLoadWithRequest?.({ url: "about:blank" })).toBe(true);
  expect(native.props.onShouldStartLoadWithRequest?.({ url: "about:blank/" })).toBe(true);
  for (const url of ["https://example.com/preview", "file:///secret", "javascript:alert(1)"]) {
    expect(native.props.onShouldStartLoadWithRequest?.({ url })).toBe(false);
  }
  native.props.onMessage?.({ nativeEvent: { data: '{"type":"rakazo-page:copy"}' } });
  expect(onMessage).toHaveBeenCalledWith('{"type":"rakazo-page:copy"}', expect.any(Function));
  onMessage.mock.calls[0]![1]({ type: "rakazo-page:copy-result", id: "copy-1", ok: true });
  expect(native.inject).toHaveBeenCalledWith(
    'window.postMessage({"type":"rakazo-page:copy-result","id":"copy-1","ok":true}, "*");true;',
  );
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
