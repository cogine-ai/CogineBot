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
