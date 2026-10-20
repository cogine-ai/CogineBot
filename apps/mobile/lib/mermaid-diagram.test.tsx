// @vitest-environment jsdom

import { darkTokens, lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { WebViewMessageEvent, WebViewProps } from "react-native-webview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidDiagram } from "../components/mermaid-diagram";
import { DIAGRAM_TIMEOUT_MS } from "./mermaid-webview";

const webviews = vi.hoisted(() => [] as WebViewProps[]);
const nativePlatform = vi.hoisted(() => ({ OS: "ios" }));
const endpoint = vi.hoisted(() => ({
  value: "https://server.example.test",
  listeners: new Set<() => void>(),
}));

vi.mock("react-native-webview", () => ({
  WebView(props: WebViewProps) {
    webviews.push(props);
    const style = Array.isArray(props.style) ? Object.assign({}, ...props.style) : props.style;
    return createElement("div", { "data-testid": "webview", style });
  },
}));

vi.mock("react-native", () => ({
  Platform: nativePlatform,
  View: ({ children, style: _style, ...props }: { children?: ReactNode; style?: unknown }) =>
    createElement("div", props, children),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
}));

vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));

vi.mock("./api", () => ({
  currentApiBase: () => endpoint.value,
  subscribeApiBase: (listener: () => void) => {
    endpoint.listeners.add(listener);
    return () => endpoint.listeners.delete(listener);
  },
}));

vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

describe("native diagram lifecycle", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    webviews.length = 0;
    endpoint.value = "https://server.example.test";
    nativePlatform.OS = "ios";
    endpoint.listeners.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function render(source = "graph TD; A-->B", dark = false) {
    act(() => {
      root.render(
        <StrictMode>
          <MermaidDiagram
            source={source}
            palette={dark ? darkTokens : lightTokens}
            colorScheme={dark ? "dark" : "light"}
            fallback={<pre>{source}</pre>}
          />
        </StrictMode>,
      );
    });
    return latest();
  }

  function latest() {
    const view = webviews.at(-1);
    if (!view) throw new Error("No WebView rendered");
    return view;
  }

  function requestId(view = latest()) {
    const id = /var requestId = "([^"]+)"/.exec(view.injectedJavaScript ?? "")?.[1];
    if (!id) throw new Error("No request id injected");
    return id;
  }

  function send(view: WebViewProps, message: Record<string, unknown>) {
    act(() => {
      view.onMessage?.({
        nativeEvent: { data: JSON.stringify({ requestId: requestId(view), ...message }) },
      } as WebViewMessageEvent);
    });
  }

  const drawn = { type: "drawn", width: 200, height: 120, alt: "A readable flow" };

  it("draws only the local document with no storage, cookie, file, window or navigation access", () => {
    const view = render();
    expect(view.source).toMatchObject({ baseUrl: "about:blank" });
    expect(view).toMatchObject({
      incognito: true,
      cacheEnabled: false,
      allowsLinkPreview: false,
      dataDetectorTypes: "none",
      javaScriptCanOpenWindowsAutomatically: false,
      domStorageEnabled: false,
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      setSupportMultipleWindows: false,
      thirdPartyCookiesEnabled: false,
      sharedCookiesEnabled: false,
      originWhitelist: ["*"],
    });
    const navigate = (url: string) =>
      view.onShouldStartLoadWithRequest?.({ url } as Parameters<
        NonNullable<WebViewProps["onShouldStartLoadWithRequest"]>
      >[0]);
    expect(navigate("about:blank")).toBe(true);
    expect(navigate("https://external.example.test/")).toBe(false);
    expect(navigate("file:///test")).toBe(false);
    expect(navigate("custom-app:open")).toBe(false);
    expect(container.querySelector("pre")).not.toBeNull();
  });

  it("does not clear the shared Android WebView cookie store to render a diagram", () => {
    nativePlatform.OS = "android";
    const view = render();
    expect(view.incognito).toBe(false);
    expect(view.sharedCookiesEnabled).toBe(false);
    expect(view.thirdPartyCookiesEnabled).toBe(false);
    expect(view.cacheEnabled).toBe(false);
    expect(view.source).toMatchObject({ baseUrl: "about:blank" });
  });

  it("replaces code with the accessible diagram and keeps its original source available", () => {
    render();
    send(latest(), drawn);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector('[accessibilitylabel="A readable flow"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="webview"]')?.getAttribute("style")).toContain(
      "height: 120px",
    );
    expect(container.querySelector("button")?.textContent).toBe("Show source");
    const originalId = requestId();
    act(() => container.querySelector("button")?.click());
    expect(container.querySelector("pre")?.textContent).toBe("graph TD; A-->B");
    expect(container.querySelector("button")?.textContent).toBe("Show diagram");
    act(() => container.querySelector("button")?.click());
    expect(container.querySelector("pre")).toBeNull();
    expect(requestId()).toBe(originalId);
    act(() => vi.advanceTimersByTime(DIAGRAM_TIMEOUT_MS));
    expect(container.querySelector('[data-testid="webview"]')).not.toBeNull();
  });

  it.each(["timeout", "message", "error", "http", "process", "window"] as const)(
    "makes %s failure terminal and unmounts the page before a late success",
    (reason) => {
      const view = render();
      if (reason === "timeout") act(() => vi.advanceTimersByTime(DIAGRAM_TIMEOUT_MS));
      if (reason === "message") send(view, { type: "failed" });
      if (reason === "error") act(() => (view.onError as () => void)?.());
      if (reason === "http") act(() => (view.onHttpError as () => void)?.());
      if (reason === "process") act(() => (view.onContentProcessDidTerminate as () => void)?.());
      if (reason === "window") act(() => (view.onOpenWindow as () => void)?.());
      expect(container.querySelector('[data-testid="webview"]')).toBeNull();
      send(view, drawn);
      expect(container.querySelector('[data-testid="webview"]')).toBeNull();
      expect(container.querySelector("pre")?.textContent).toBe("graph TD; A-->B");
      expect(container.querySelector("button")).toBeNull();
    },
  );

  it("rejects malformed and mismatched messages without prematurely revealing content", () => {
    const view = render();
    send(view, { ...drawn, requestId: "obsolete" });
    send(view, { ...drawn, height: "120" });
    send(view, { ...drawn, extra: true });
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
    send(view, { ...drawn, height: 10_001 });
    expect(container.querySelector('[data-testid="webview"]')).toBeNull();
  });

  it("uses a new page for source, theme and server changes and ignores old callbacks", () => {
    const first = render();
    const second = render("sequenceDiagram\nAlice->>Bob: Hi");
    expect(requestId(first)).not.toBe(requestId(second));
    send(first, drawn);
    act(() => (first.onError as () => void)?.());
    expect(container.querySelector("pre")).not.toBeNull();
    send(second, drawn);
    expect(container.querySelector("pre")).toBeNull();
    const dark = render("sequenceDiagram\nAlice->>Bob: Hi", true);
    expect(requestId(dark)).not.toBe(requestId(second));
    send(second, drawn);
    expect(container.querySelector("pre")).not.toBeNull();
    act(() => {
      endpoint.value = "https://other-server.example.test";
      for (const listener of endpoint.listeners) listener();
    });
    const moved = latest();
    expect(requestId(moved)).not.toBe(requestId(dark));
    expect(moved.source).toMatchObject({
      html: expect.stringContaining("https://other-server.example.test/api/v1/assets/mermaid.js"),
    });
    send(dark, drawn);
    expect(container.querySelector("pre")).not.toBeNull();
    send(moved, { ...drawn, alt: "" });
    expect(container.querySelector('[accessibilitylabel="Diagram"]')).not.toBeNull();
    const returned = render();
    send(first, drawn);
    expect(requestId(returned)).not.toBe(requestId(first));
    expect(container.querySelector("pre")).not.toBeNull();
    send(returned, drawn);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("keeps code when an API endpoint is invalid and ignores callbacks after unmount", () => {
    const view = render();
    act(() => {
      endpoint.value = "file:///invalid";
      for (const listener of endpoint.listeners) listener();
    });
    expect(container.querySelector('[data-testid="webview"]')).toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
    send(view, drawn);
    act(() => root.render(null));
    send(view, drawn);
    expect(container.innerHTML).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});
