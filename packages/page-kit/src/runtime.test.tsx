// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { pageViewerCode } from "./compile.js";
import { checkPageSource } from "./validate.js";

it("mounts a page and reports its height where the browser has no ResizeObserver", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", undefined);
  const posted: unknown[] = [];
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message);
  });
  await import("./runtime.js");
  const code = pageViewerCode(
    `const App = () => (\n  <Page title="Hello">\n    <Text>Drawn</Text>\n  </Page>\n);\nexport default App;\n`,
  );
  const page = (window as unknown as { RakazoPage: { mount: (boot: object) => void } }).RakazoPage;
  await act(async () => {
    page.mount({ code, theme: "light", errorTitle: "This page couldn't be shown." });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // jsdom runs no inline scripts, so the page's own code shows its error panel; what matters is
  // that mounting got that far instead of throwing before anything drew.
  expect(document.body.textContent).toContain("This page couldn't be shown.");
  expect(posted).toContainEqual(expect.objectContaining({ type: "rakazo-page:height" }));
});

it.each([
  [
    "a local component under a kit name",
    "const Steps = () => <p>Own steps</p>;\nconst App = () => <Steps />;\nexport default App;\n",
    "Own steps",
  ],
  [
    "JSX next to a different module binding named React",
    "const React = { label: 'Independent JSX' }; export default () => <>{React.label}</>;",
    "Independent JSX",
  ],
  [
    "JSX with a React import and locally shadowed compiler alias",
    String.raw`import React from "react";
      const \u005f_pageKitReact = "Escaped binding";
      export default function App({React = "Local prop"}) {
        const __pageKitReact1 = "Local alias";
        return <p>{\u005f_pageKitReact}: {React}: {__pageKitReact1}</p>;
      }`,
    "Escaped binding: Local prop: Local alias",
  ],
  [
    "React imported explicitly with a fragment and JSX",
    'import * as React from "react"; export default () => <React.Fragment><p>Explicit React</p></React.Fragment>;',
    "Explicit React",
  ],
  [
    "a memoized default component",
    "export default React.memo(function App() { return <p>Memoized page</p>; });",
    "Memoized page",
  ],
  [
    "a default component forwarding a ref",
    "export default React.forwardRef(function App(_props, ref) { return <p ref={ref}>Ref page</p>; });",
    "Ref page",
  ],
  [
    "a lazy default component",
    "export default React.lazy(() => Promise.resolve({default: () => <p>Lazy page</p>}));",
    "Lazy page",
  ],
  [
    "a lowered import alias and names local to nested scopes",
    `import { useState as exports } from "react";
     class Support { static { var Object = "local"; } }
     for (var name of []) { let exports; }
     { function Object() {} }
     export default function App() {
       const [label] = exports("Scoped page");
       return <p>{label}</p>;
     }`,
    "Scoped page",
  ],
  [
    "local names the generated module does not need",
    `const globalThis = {require: "Local data"};
     const require = {};
     export default function App() { return <p>{globalThis.require}</p>; }`,
    "Local data",
  ],
  [
    "a default export that is only data",
    "export default { count: 2 };",
    "This page couldn't be shown.",
  ],
])("handles %s in saved viewer code", async (_name, source, expected) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await import("./runtime.js");
  // jsdom runs no inline scripts, so run the page's script the way a browser would.
  const append = document.head.append.bind(document.head);
  const appendSpy = vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
    for (const node of nodes) {
      if (node instanceof HTMLScriptElement) new Function(node.text)();
    }
    append(...nodes);
  });
  try {
    const checked = checkPageSource(source);
    if (!checked.ok) throw new Error(checked.errors.join("\n"));
    document.body.replaceChildren();
    const page = (window as unknown as { RakazoPage: { mount: (boot: object) => void } })
      .RakazoPage;
    await act(async () => {
      page.mount({
        code: checked.code,
        theme: "light",
        errorTitle: "This page couldn't be shown.",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain(expected);
  } finally {
    appendSpy.mockRestore();
  }
});

async function mountForDraw(code: string) {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await import("./runtime.js");
  document.body.replaceChildren();
  const report = vi.fn();
  window.__coginePageReportDraw = report;
  const append = document.head.append.bind(document.head);
  const appendSpy = vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
    for (const node of nodes) {
      if (node instanceof HTMLScriptElement) {
        expect(window.__coginePageReportDraw).toBeUndefined();
        expect(window.RakazoPage).toBeUndefined();
        new Function(node.text)();
      }
    }
    append(...nodes);
  });
  try {
    await act(async () => {
      window.RakazoPage!.mount({ code, theme: "light", errorTitle: "Page failed" });
    });
    return report;
  } finally {
    appendSpy.mockRestore();
  }
}

it.each([
  [
    "a committed Page",
    "exports.default = () => React.createElement('p', null, typeof window.__coginePageReportDraw);",
    true,
  ],
  ["an empty Page", "exports.default = () => null;", false],
  ["a failed factory", "throw new Error('fixture runtime error');", false],
] as const)("only reports a trusted draw for %s", async (_name, code, expected) => {
  const report = await mountForDraw(code);
  if (expected) expect(report).toHaveBeenCalledExactlyOnceWith(true);
  else expect(report).not.toHaveBeenCalled();
});

it("does not report a draw when an error boundary replaces an empty Page", async () => {
  const fixture = window as Window & { failFixturePage?: () => void };
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const report = await mountForDraw(`
      exports.default = () => {
        const [failed, setFailed] = React.useState(false);
        window.failFixturePage = () => setFailed(true);
        if (failed) throw new Error("fixture render error");
        return null;
      };
    `);
    expect(report).not.toHaveBeenCalled();
    await act(async () => fixture.failFixturePage?.());
    expect(document.body.textContent).toContain("Page failed");
    expect(report).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    delete fixture.failFixturePage;
  }
});
