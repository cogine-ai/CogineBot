// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const library = vi.hoisted(() => ({ read: vi.fn(() => "fixed library") }));
vi.mock("mermaid/LICENSE?raw", () => ({ default: "MIT license notice" }));

const SVG = '<svg viewBox="0 0 120 80"><title>Order flow</title></svg>';
let appended: ReturnType<typeof vi.spyOn>;

function framesCreated() {
  return appended.mock.calls.filter((call: unknown[]) => call[0] instanceof HTMLIFrameElement)
    .length;
}

async function flush() {
  for (let count = 0; count < 12; count++) await Promise.resolve();
}

function message(frame: HTMLIFrameElement, data: unknown, source = frame.contentWindow) {
  window.dispatchEvent(new MessageEvent("message", { source, data }));
}

async function activeFrame() {
  await vi.dynamicImportSettled();
  await flush();
  const frame = document.querySelector("iframe");
  expect(frame).not.toBeNull();
  return frame as HTMLIFrameElement;
}

function start(frame: HTMLIFrameElement) {
  const post = vi.spyOn(frame.contentWindow as Window, "postMessage");
  message(frame, { type: "ready" });
  expect(post).toHaveBeenCalledOnce();
  return post.mock.calls[0]?.[0] as { type: string; id: string; source: string; config: unknown };
}

async function finish(frame: HTMLIFrameElement, svg = SVG) {
  const request = start(frame);
  message(frame, { type: "drawn", id: request.id, svg });
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  library.read.mockReset().mockReturnValue("fixed library");
  vi.doMock("mermaid/dist/mermaid.min.js?raw", () => ({
    get default() {
      return library.read();
    },
  }));
  appended = vi.spyOn(document.body, "appendChild");
  document.documentElement.dataset.theme = "dark";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("isolated diagram drawing", () => {
  it("loads only on demand, isolates permissions, and passes source as data", async () => {
    const { renderMermaidSvg } = await import("./mermaid.web");
    expect(library.read).not.toHaveBeenCalled();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const cancelled = vi.spyOn(globalThis, "clearTimeout");
    const source = 'graph TD; A["</script><script>private source</script>"] --> B';
    const result = renderMermaidSvg(source, "dark");
    const frame = await activeFrame();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.referrerPolicy).toBe("no-referrer");
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(frame.srcdoc).toContain("img-src data:");
    expect(frame.srcdoc).toContain("connect-src 'none'");
    expect(frame.srcdoc).not.toContain("private source");
    expect(frame.srcdoc).toContain(
      `data:text/javascript;charset=utf-8,${encodeURIComponent("/*! Mermaid\nMIT license notice\n*/\nfixed library")}`,
    );
    expect(frame.hidden).toBe(false);
    expect(frame.style.visibility).toBe("hidden");
    expect(frame.style.width).toBe("1024px");
    const request = start(frame);
    expect(request.source).toBe(source);
    expect(request.config).toMatchObject({ securityLevel: "strict", darkMode: true });
    message(frame, { type: "drawn", id: request.id, svg: SVG });
    expect(await result).toBe(SVG);
    expect(document.querySelector("iframe")).toBeNull();
    expect(cancelled).toHaveBeenCalledWith(
      timers.mock.results.find((_, index) => timers.mock.calls[index]?.[1] === 15_000)?.value,
    );
  });

  it("accepts only the current window, request id, and exact message shape", async () => {
    const { renderMermaidSvg } = await import("./mermaid.web");
    const result = renderMermaidSvg("graph TD; A --> B", "dark");
    const frame = await activeFrame();
    message(frame, { type: "ready" }, window);
    const request = start(frame);
    message(frame, { type: "drawn", id: request.id, svg: SVG }, window);
    message(frame, { type: "drawn", id: "stale", svg: SVG });
    message(frame, { type: "drawn", id: request.id, svg: SVG, extra: true });
    message(frame, { type: "invalid", id: request.id, extra: true });
    expect(document.querySelector("iframe")).toBe(frame);
    message(frame, { type: "drawn", id: request.id, svg: SVG });
    expect(await result).toBe(SVG);
  });

  it("serializes duplicate requests, caches invalid source, and keys by appearance", async () => {
    const { renderMermaidSvg } = await import("./mermaid.web");
    const first = renderMermaidSvg("same source", "dark");
    const duplicate = renderMermaidSvg("same source", "dark");
    await finish(await activeFrame());
    expect(await first).toBe(SVG);
    expect(await duplicate).toBe(SVG);
    expect(framesCreated()).toBe(1);

    const invalid = renderMermaidSvg("bad source", "dark");
    const frame = await activeFrame();
    const request = start(frame);
    message(frame, { type: "invalid", id: request.id });
    expect(await invalid).toBeNull();
    expect(await renderMermaidSvg("bad source", "dark")).toBeNull();
    expect(framesCreated()).toBe(2);

    const light = renderMermaidSvg("same source", "light");
    const lightFrame = await activeFrame();
    const lightRequest = start(lightFrame);
    expect(lightRequest.config).toMatchObject({ darkMode: false });
    message(lightFrame, { type: "drawn", id: lightRequest.id, svg: SVG });
    await light;
    expect(framesCreated()).toBe(3);
  });

  it("evicts the oldest result after 64 distinct sources", async () => {
    const { renderMermaidSvg } = await import("./mermaid.web");
    for (let count = 0; count < 65; count++) {
      const result = renderMermaidSvg(`source ${count}`, "dark");
      await finish(await activeFrame());
      await result;
    }
    expect(await renderMermaidSvg("source 64", "dark")).toBe(SVG);
    expect(framesCreated()).toBe(65);
    const first = renderMermaidSvg("source 0", "dark");
    await finish(await activeFrame());
    await first;
    expect(framesCreated()).toBe(66);
  });

  it("disposes a timed-out realm and retries with a fresh internal queue", async () => {
    const { renderMermaidSvg, MERMAID_RENDER_TIMEOUT_MS } = await import("./mermaid.web");
    const pending = renderMermaidSvg("pending", "dark");
    const oldFrame = await activeFrame();
    const oldWindow = oldFrame.contentWindow;
    const oldRequest = start(oldFrame);
    await vi.advanceTimersByTimeAsync(MERMAID_RENDER_TIMEOUT_MS);
    expect(await pending).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    const next = renderMermaidSvg("pending", "dark");
    const frame = await activeFrame();
    const request = start(frame);
    expect(frame === oldFrame).toBe(false);
    expect(frame.srcdoc === oldFrame.srcdoc).toBe(false);
    window.dispatchEvent(
      new MessageEvent("message", {
        source: oldWindow,
        data: { type: "drawn", id: oldRequest.id, svg: SVG },
      }),
    );
    expect(document.querySelector("iframe")).toBe(frame);
    message(frame, { type: "drawn", id: request.id, svg: SVG });
    expect(await next).toBe(SVG);
  });

  it("retries a timed-out script load without caching its failure", async () => {
    let releaseImport = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    vi.doMock("mermaid/dist/mermaid.min.js?raw", async () => {
      await gate;
      return {
        get default() {
          return library.read();
        },
      };
    });
    const { renderMermaidSvg, MERMAID_RENDER_TIMEOUT_MS } = await import("./mermaid.web");
    const pending = renderMermaidSvg("load timeout", "dark");
    await flush();
    await vi.advanceTimersByTimeAsync(MERMAID_RENDER_TIMEOUT_MS);
    expect(await pending).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    releaseImport();
    await vi.dynamicImportSettled();
    await flush();
    expect(document.querySelector("iframe")).toBeNull();
    const retry = renderMermaidSvg("load timeout", "dark");
    await finish(await activeFrame());
    expect(await retry).toBe(SVG);
    expect(library.read).toHaveBeenCalledTimes(2);
  });

  it("retries a failed library load and a failed frame load", async () => {
    library.read.mockImplementationOnce(() => {
      throw new Error("chunk unavailable");
    });
    const { renderMermaidSvg } = await import("./mermaid.web");
    expect(await renderMermaidSvg("retry", "dark")).toBeNull();
    const retry = renderMermaidSvg("retry", "dark");
    const frame = await activeFrame();
    message(frame, { type: "failed" });
    expect(await retry).toBeNull();
    const final = renderMermaidSvg("retry", "dark");
    await finish(await activeFrame());
    expect(await final).toBe(SVG);
  });

  it("cancels active and queued work without caching or retaining listeners", async () => {
    const { renderMermaidSvg } = await import("./mermaid.web");
    const active = new AbortController();
    const queued = new AbortController();
    const first = renderMermaidSvg("A", "dark", active.signal);
    const frame = await activeFrame();
    const oldWindow = frame.contentWindow;
    const request = start(frame);
    const second = renderMermaidSvg("B", "dark", queued.signal);
    queued.abort();
    active.abort();
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: oldWindow,
        data: { type: "drawn", id: request.id, svg: SVG },
      }),
    );
    const retry = renderMermaidSvg("A", "dark");
    await finish(await activeFrame());
    expect(await retry).toBe(SVG);
    expect(framesCreated()).toBe(2);
  });

  it("cancels old hook generations on A → B → A and on unmount", async () => {
    const { useMermaidSvg } = await import("./mermaid.web");
    function Result({ source }: { source: string }) {
      return <output>{useMermaidSvg(source) ?? "source"}</output>;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Result source="A" />));
    const oldFrame = await activeFrame();
    const oldWindow = oldFrame.contentWindow;
    const oldRequest = start(oldFrame);
    await act(async () => root.render(<Result source="B" />));
    expect(oldFrame.isConnected).toBe(false);
    const middle = await activeFrame();
    await act(async () => root.render(<Result source="A" />));
    expect(middle.isConnected).toBe(false);
    const current = await activeFrame();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: oldWindow,
          data: { type: "drawn", id: oldRequest.id, svg: SVG.replace("Order flow", "old") },
        }),
      );
      await finish(current);
    });
    expect(host.textContent).toBe(SVG);
    await act(async () => {
      document.documentElement.dataset.theme = "light";
      await flush();
    });
    const themed = await activeFrame();
    expect(start(themed).config).toMatchObject({ darkMode: false });
    await act(async () => root.unmount());
    expect(document.querySelector("iframe")).toBeNull();
  });
});
