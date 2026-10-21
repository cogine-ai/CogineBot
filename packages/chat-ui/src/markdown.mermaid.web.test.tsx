// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMarkdown } from "./markdown.web";

const renderer = vi.hoisted(() => ({ svg: undefined as string | null | undefined, use: vi.fn() }));
vi.mock("./mermaid.web", () => ({
  useMermaidSvg: (source: string) => {
    renderer.use(source);
    return renderer.svg;
  },
}));

const SVG = '<svg viewBox="0 0 120 80"><title>Order flow</title></svg>';

afterEach(() => {
  renderer.svg = undefined;
  renderer.use.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("web markdown diagrams", () => {
  it.each([
    "```mermaid\ngraph TD; A --> B\n```",
    "~~~MeRmAiD title=flow\ngraph TD; A --> B\n~~~",
    "> ```mermaid\n> graph TD; A --> B\n> ```",
    "- ```mermaid\n  graph TD; A --> B\n  ```",
    "  ```mermaid\n  graph TD; A --> B\n  ```",
    "````mermaid\ngraph TD; A --> B\n`````",
  ])("draws only a completed streaming fence: %s", (source) => {
    renderer.svg = SVG;
    const html = renderToStaticMarkup(
      <ChatMarkdown streaming>{`${source}\n\nMore text`}</ChatMarkdown>,
    );
    expect(html).toContain('data-testid="chat-diagram"');
    expect(html).toContain('alt="Order flow"');
    expect(html).toContain("More text");
    expect(renderer.use).toHaveBeenCalledWith("graph TD; A --> B\n");
  });

  it.each([
    "```mermaid\ngraph TD; A --> B",
    "> ~~~mermaid\n> graph TD; A --> B",
    "- ```mermaid\n  graph TD; A --> B",
    "````mermaid\ngraph TD; A --> B\n```",
    "```mermaid\ngraph TD; A --> B\n~~~",
  ])("keeps incomplete streaming source visible without loading the renderer: %s", (source) => {
    const html = renderToStaticMarkup(<ChatMarkdown streaming>{source}</ChatMarkdown>);
    expect(html).toContain("graph TD; A --&gt; B");
    expect(html).not.toContain('data-testid="chat-diagram"');
    expect(renderer.use).not.toHaveBeenCalled();
  });

  it("does not load diagrams for ordinary or empty code blocks", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"```typescript\nconst graph = 1;\n```\n\n```mermaid\n\n```"}</ChatMarkdown>,
    );
    expect(html).toContain("const graph = 1;");
    expect(html).toContain("Copy code");
    expect(html).not.toContain("rk-chat-markdown-diagram-wrap");
    expect(renderer.use).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '<svg viewBox="0 0 Infinity 1"></svg>'])(
    "preserves code and its copy action when drawing is unavailable: %s",
    (svg) => {
      renderer.svg = svg;
      const html = renderToStaticMarkup(
        <ChatMarkdown>{"```mermaid\ninvalid source\n```"}</ChatMarkdown>,
      );
      expect(html).toContain("invalid source\n");
      expect(html).toContain("Copy diagram source");
      expect(html).toContain("rk-chat-markdown-diagram-wrap");
      expect(html).not.toContain("Show source");
      expect(html).not.toContain('data-testid="chat-diagram"');
    },
  );

  it("offers source and diagram views and copies the unchanged source in both", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    renderer.svg = SVG;
    const source = "graph TD; A --> B  \n\n";
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(<ChatMarkdown>{`\`\`\`mermaid\n${source}\`\`\``}</ChatMarkdown>),
    );
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("Order flow");
    expect(host.querySelector("svg")).not.toBeNull(); // The copy icon, never the diagram SVG.
    expect(host.querySelector("img")?.src).toMatch(/^data:image\/svg\+xml/);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Copy diagram source"]')?.click(),
    );
    expect(copy).toHaveBeenLastCalledWith(source);
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Show source")
        ?.click(),
    );
    expect(host.querySelector("pre code")?.textContent).toBe(source);
    expect(host.querySelector("img")).toBeNull();
    const toggle = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Show diagram",
    );
    await act(async () => toggle?.click());
    expect(host.querySelector("img")).not.toBeNull();
    expect(renderer.use).toHaveBeenCalledWith(source);
    await act(async () => root.unmount());
  });
});
