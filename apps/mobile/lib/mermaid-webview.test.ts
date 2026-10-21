import { CHAT_DIAGRAM_MAX_TEXT_SIZE, chatMermaidConfig } from "@rakazo/chat-ui/mermaid";
import { darkTokens } from "@rakazo/ui-tokens";
import { describe, expect, it, vi } from "vitest";
import {
  diagramBootScript,
  diagramDocument,
  diagramScriptUrl,
  isDiagramDocument,
  MAX_DIAGRAM_HEIGHT,
  parseDiagramMessage,
} from "./mermaid-webview";

const requestId = "diagram-test";
const config = chatMermaidConfig(darkTokens, "dark");

describe("diagram document permissions", () => {
  it("loads only the fixed public script from the configured server without credentials", () => {
    const url = diagramScriptUrl("https://server.example.test/nested?ignored=yes");
    expect(url).toBe("https://server.example.test/api/v1/assets/mermaid.js");
    const html = diagramDocument(url);
    expect(html).toContain(`script-src ${url}`);
    expect(html).toContain('crossorigin="anonymous" referrerpolicy="no-referrer"');
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "font-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "img-src data:",
    ]) {
      expect(html).toContain(directive);
    }
    expect(html).not.toContain("unsafe-eval");
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).not.toContain("localStorage");
  });

  it.each([
    "file:///private/test",
    "javascript:alert(1)",
    "data:text/html,x",
    "https://user:pass@server.example.test",
  ])("rejects an unsupported or credentialed endpoint %s", (endpoint) =>
    expect(() => diagramScriptUrl(endpoint)).toThrow(),
  );

  it("does not allow arbitrary script paths, queries or fragments", () => {
    for (const path of ["evil.js", "mermaid.js?extra=1", "mermaid.js#x"]) {
      expect(() => diagramDocument(`https://server.example.test/api/v1/assets/${path}`)).toThrow();
    }
  });

  it("allows the local document and rejects navigation to any other address", () => {
    expect(isDiagramDocument("about:blank")).toBe(true);
    expect(isDiagramDocument("about:blank/")).toBe(true);
    for (const url of [
      "https://server.example.test/api/v1/assets/mermaid.js",
      "https://external.example.test/",
      "about:blank#next",
      "file:///test",
      "javascript:alert(1)",
      "mailto:test@example.test",
    ]) {
      expect(isDiagramDocument(url)).toBe(false);
    }
  });
});

describe("diagram bridge messages", () => {
  const drawn = { type: "drawn", requestId, width: 320, height: 80, alt: "A flow chart" };
  const parse = (value: unknown) => parseDiagramMessage(JSON.stringify(value), requestId);

  it("accepts only the current request and exact message schema", () => {
    expect(parse(drawn)).toEqual({ type: "drawn", width: 320, height: 80, alt: "A flow chart" });
    expect(parse({ type: "failed", requestId })).toEqual({ type: "failed" });
    for (const message of [
      null,
      [],
      "drawn",
      { ...drawn, requestId: "old-request" },
      { ...drawn, unexpected: "extra" },
      { ...drawn, width: "320" },
      { ...drawn, height: null },
      { ...drawn, alt: {} },
      { ...drawn, alt: "x".repeat(1_025) },
      { type: "failed", requestId, unexpected: true },
    ]) {
      expect(parse(message)).toBeNull();
    }
    expect(parseDiagramMessage("{invalid", requestId)).toBeNull();
  });

  it.each([0, -1, MAX_DIAGRAM_HEIGHT + 1])("fails closed for height %s", (height) => {
    expect(parse({ ...drawn, height })).toEqual({ type: "failed" });
  });

  it("fails closed for nonfinite dimensions and unsafe widths", () => {
    expect(
      parseDiagramMessage(
        `{"type":"drawn","requestId":"${requestId}","width":1e999,"height":80,"alt":""}`,
        requestId,
      ),
    ).toEqual({ type: "failed" });
    expect(
      parseDiagramMessage(
        `{"type":"drawn","requestId":"${requestId}","width":320,"height":1e999,"alt":""}`,
        requestId,
      ),
    ).toEqual({ type: "failed" });
    expect(parse({ ...drawn, width: Number.MAX_SAFE_INTEGER + 1 })).toEqual({ type: "failed" });
    expect(parse({ ...drawn, width: -1 })).toEqual({ type: "failed" });
    expect(parse({ ...drawn, width: 12_000, height: MAX_DIAGRAM_HEIGHT })).toEqual({
      type: "drawn",
      width: 12_000,
      height: MAX_DIAGRAM_HEIGHT,
      alt: drawn.alt,
    });
  });
});

function bootFixture({ parse = true, height = 100, width = 200, title = "A & B" } = {}) {
  const posts: string[] = [];
  const pagehide: Array<() => void> = [];
  const observers: Array<{ report: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
  const svg = {
    viewBox: { baseVal: { x: 0, y: 0, width, height: 100 } },
    style: { minWidth: "" },
    querySelector: () => ({ textContent: title }),
  };
  const root = {
    innerHTML: "",
    querySelector: () => svg,
    getBoundingClientRect: () => ({ height }),
  };
  const mermaid = {
    initialize: vi.fn(),
    parse: vi.fn(async () => parse),
    render: vi.fn(async () => ({ svg: "<svg><title>A &amp; B</title></svg>" })),
  };
  class Observer {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(report: () => void) {
      observers.push({ report, disconnect: this.disconnect });
    }
  }
  const window = {
    mermaid,
    ReactNativeWebView: { postMessage: (message: string) => posts.push(message) },
    ResizeObserver: Observer,
    addEventListener: (_event: string, handler: () => void) => pagehide.push(handler),
  };
  const document = { getElementById: () => root };
  const run = async (source = "graph TD; A-->B") => {
    const script = diagramBootScript(source, config, requestId);
    const execute = new Function("window", "document", "ResizeObserver", script);
    execute(window, document, Observer);
    for (let count = 0; count < 8; count += 1) await Promise.resolve();
  };
  return { window, root, svg, posts, mermaid, pagehide, observers, run };
}

describe("diagram boot", () => {
  it("rejects oversized source before initializing or parsing and permits the exact boundary", async () => {
    const fixture = bootFixture();
    await fixture.run("x".repeat(CHAT_DIAGRAM_MAX_TEXT_SIZE + 1));
    expect(fixture.mermaid.initialize).not.toHaveBeenCalled();
    expect(fixture.mermaid.parse).not.toHaveBeenCalled();
    expect(fixture.mermaid.render).not.toHaveBeenCalled();
    expect(fixture.posts.map((post) => parseDiagramMessage(post, requestId))).toEqual([
      { type: "failed" },
    ]);
    const boundary = bootFixture();
    const source = "x".repeat(CHAT_DIAGRAM_MAX_TEXT_SIZE);
    await boundary.run(source);
    expect(boundary.mermaid.initialize).toHaveBeenCalledOnce();
    expect(boundary.mermaid.parse).toHaveBeenCalledWith(source, { suppressErrors: true });
    expect(boundary.mermaid.render).toHaveBeenCalledOnce();
    expect(boundary.posts.map((post) => parseDiagramMessage(post, requestId))).toEqual([
      { type: "drawn", width: 200, height: 100, alt: "A & B" },
    ]);
  });

  it("embeds hostile source as data, preserving original text without executing it", async () => {
    const source =
      '</script><script>window.compromised=true</script>\u2028"; window.compromised=true; //';
    const script = diagramBootScript(source, config, requestId);
    expect(script).not.toContain("</script>");
    expect(script).toContain("\\u003c/script\\u003e");
    const fixture = bootFixture();
    await fixture.run(source);
    expect(fixture.mermaid.parse).toHaveBeenCalledWith(source, { suppressErrors: true });
    expect(fixture.window).not.toHaveProperty("compromised");
    expect(fixture.mermaid.initialize).toHaveBeenCalledWith(config);
    expect(JSON.parse(fixture.posts[0] ?? "{}")).toEqual({
      type: "drawn",
      requestId,
      width: 200,
      height: 100,
      alt: "A & B",
    });
    expect(fixture.svg.style.minWidth).toBe("160px");
  });

  it("reports parse/load/render errors without an unhandled rejection", async () => {
    for (const mode of ["parse", "render", "initialize", "missing"] as const) {
      const fixture = bootFixture({ parse: mode !== "parse" });
      if (mode === "render") fixture.mermaid.render.mockRejectedValueOnce(new Error("bad render"));
      if (mode === "initialize")
        fixture.mermaid.initialize.mockImplementationOnce(() => {
          throw new Error("bad config");
        });
      if (mode === "missing") Object.assign(fixture.window, { mermaid: undefined });
      await fixture.run();
      expect(fixture.posts.map((post) => parseDiagramMessage(post, requestId))).toEqual([
        { type: "failed" },
      ]);
    }
  });

  it("disconnects resize observation and ignores reports after the document leaves", async () => {
    const fixture = bootFixture();
    await fixture.run();
    expect(fixture.observers).toHaveLength(1);
    fixture.pagehide[0]?.();
    fixture.observers[0]?.report();
    expect(fixture.observers[0]?.disconnect).toHaveBeenCalledOnce();
    expect(fixture.posts).toHaveLength(1);
  });

  it("treats invalid measured geometry as terminal failure", async () => {
    const fixture = bootFixture({ height: MAX_DIAGRAM_HEIGHT + 1 });
    await fixture.run();
    expect(fixture.posts.map((post) => parseDiagramMessage(post, requestId))).toEqual([
      { type: "failed" },
    ]);
    expect(fixture.observers).toHaveLength(0);
    const nonfinite = bootFixture({ width: Infinity });
    await nonfinite.run();
    expect(nonfinite.posts.map((post) => parseDiagramMessage(post, requestId))).toEqual([
      { type: "failed" },
    ]);
  });
});
