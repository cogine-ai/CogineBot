// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { WebViewMessageEvent, WebViewProps } from "react-native-webview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartCard } from "../components/chart-card";
import { CHART_TIMEOUT_MS } from "./chart-webview";

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
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Modal: ({ children }: { children?: ReactNode }) =>
    createElement("section", { role: "dialog" }, children),
  ActivityIndicator: () => createElement("span", null, "loading"),
  useWindowDimensions: () => ({ width: 390, height: 844 }),
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

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24 }),
}));
vi.mock("./native", () => ({ useResolvedAppearance: () => "light" }));
vi.mock("./appearance", () => ({ mobileTokens: () => lightTokens }));

const block: Extract<MessageBlock, { kind: "chart" }> = {
  kind: "chart",
  name: "Sales",
  spec: { title: "Sales", marks: [{ type: "dot" }] },
  data: [1, 2],
};

describe("chart card native lifecycle (substitute evidence)", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    webviews.length = 0;
    nativePlatform.OS = "ios";
    endpoint.value = "https://server.example.test";
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
  function render(value = block) {
    act(() =>
      root.render(
        <StrictMode>
          <ChartCard block={value} />
        </StrictMode>,
      ),
    );
    return webviews.at(-1)!;
  }
  function id(view: WebViewProps) {
    return /"requestId":"([^"]+)"/.exec(view.injectedJavaScript!)![1];
  }
  function send(view: WebViewProps, type = "drawn") {
    act(() =>
      view.onMessage?.({
        nativeEvent: { data: JSON.stringify({ requestId: id(view), type, height: 300 }) },
      } as WebViewMessageEvent),
    );
  }
  function click(label: string) {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    )!;
    act(() => button.click());
  }

  it.each(["ios", "android"])(
    "expands and closes on %s while retaining the inline WebView",
    (platform) => {
      nativePlatform.OS = platform;
      const inline = render();
      send(inline);
      const inlineElement = container.querySelector('[data-testid="webview"]');
      click("Expand chart");
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.querySelectorAll('[data-testid="webview"]')).toHaveLength(2);
      send(webviews.at(-1)!);
      click("Close chart");
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(container.querySelectorAll('[data-testid="webview"]')).toHaveLength(1);
      expect(container.querySelector('[data-testid="webview"]')).toBe(inlineElement);
      expect(inline.incognito).toBe(platform === "ios");
      act(() => vi.advanceTimersByTime(CHART_TIMEOUT_MS));
      expect(container.textContent).not.toContain("Chart unavailable");
    },
  );

  it("keeps one document for an unchanged history value and replaces changed data", () => {
    const first = render();
    send(first);
    expect(id(render(structuredClone(block)))).toBe(id(first));
    const updated = render({ ...block, data: [3, 4] });
    expect(id(updated)).not.toBe(id(first));
    send(first, "failed");
    expect(container.textContent).not.toContain("Chart unavailable");
    send(updated);
  });

  it("fails locally on timeout and cannot be revived by a late ready message", () => {
    const first = render();
    act(() => vi.advanceTimersByTime(CHART_TIMEOUT_MS));
    expect(container.textContent).toContain("Chart unavailable");
    send(first);
    expect(container.querySelector('[data-testid="webview"]')).toBeNull();
  });

  it("rejects navigation and isolates storage/file/window access", () => {
    const view = render();
    for (const url of ["https://example.test", "file:///tmp/data", "javascript:alert(1)"]) {
      expect(view.onShouldStartLoadWithRequest?.({ url } as never)).toBe(false);
    }
    expect(view).toMatchObject({
      allowFileAccess: false,
      domStorageEnabled: false,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
      javaScriptCanOpenWindowsAutomatically: false,
    });
    act(() => view.onError?.({} as never));
    expect(container.textContent).toContain("Chart unavailable");
  });

  it("creates an isolated document after an endpoint switch", () => {
    const old = render();
    act(() => {
      endpoint.value = "https://other.example.test";
      for (const listener of endpoint.listeners) listener();
    });
    const current = webviews.at(-1)!;
    expect(id(current)).not.toBe(id(old));
    expect(current.source).toMatchObject({
      html: expect.stringContaining("https://other.example.test/api/v1/assets/chart.js"),
    });
    send(old, "failed");
    send(current);
    expect(container.textContent).not.toContain("Chart unavailable");
  });
});
