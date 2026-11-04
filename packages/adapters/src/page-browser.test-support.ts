import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";

export type ExactPage = {
  bind: (
    ref: string,
    element: Element,
    info?: { role?: string; name?: string; ax?: boolean },
  ) => boolean;
  resolve: (ref: string) => Element;
  cursor: (
    target: string,
    frame: string,
    loader: string,
    limit?: number,
  ) => Array<{ ref: string; role: string; name: string }>;
  reset: () => void;
  fill: (ref: string, value: string, origin: string, field: string) => boolean;
  act: (ref: string, kind: string, value?: string) => boolean;
  describe: (ref: string) => {
    value?: string;
    options?: Array<{ label: string; value: string; selected?: boolean; disabled?: boolean }>;
    optionsTotal?: number;
  };
  holdsLogin: (element: Element) => boolean;
};

/** Runs the shipped isolated-world script. Layout and secure context are unit fixtures. */
export function installExactPage(html: string, url = "https://login.example.test/") {
  const source = readFileSync(
    new URL("../../../infra/sandboxes/computer/page_secrets.py", import.meta.url),
    "utf8",
  );
  const script = source.match(/EVAL_HELPERS = r"""\n([\s\S]*?)\n"""/)?.[1];
  if (!script) throw new Error("Page secret helpers were not found");
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url,
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const win = dom.window;
  Object.defineProperty(win, "isSecureContext", { value: new URL(url).protocol === "https:" });
  win.Element.prototype.getBoundingClientRect = () => ({
    width: 10,
    height: 10,
    top: 0,
    left: 0,
    right: 10,
    bottom: 10,
    x: 0,
    y: 0,
    toJSON() {},
  });
  win.Element.prototype.scrollIntoView = () => {};
  let hitTarget: Element | null = null;
  win.document.elementFromPoint = () => hitTarget;
  Object.defineProperty(win.HTMLElement.prototype, "isContentEditable", {
    get() {
      return this.getAttribute("contenteditable") === "true";
    },
  });
  vm.runInContext(script, dom.getInternalVMContext());
  const exact = (win as unknown as { __rakazoPageBrowserExact: ExactPage })
    .__rakazoPageBrowserExact;
  const bind = (selector: string, ref = selector) => {
    const node = win.document.querySelector(selector);
    if (!node) throw new Error(`Missing fixture element ${selector}`);
    exact.bind(ref, node);
    hitTarget = node;
    return ref;
  };
  return {
    win,
    exact,
    bind,
    hit: (node: Element | null) => {
      hitTarget = node;
    },
    close: () => win.close(),
  };
}

/** Extract the actual Python-composed typing script, without reimplementing its focus policy. */
export function typingScript(name: "TYPE_START" | "TYPE_CHECK" | "TYPE_DONE") {
  const source = readFileSync(
    new URL("../../../infra/sandboxes/computer/rakazo-page-browser", import.meta.url),
    "utf8",
  );
  const boxes = source.match(/CODE_BOXES = r"""\n([\s\S]*?)\n"""/)?.[1];
  const body = source.match(
    new RegExp(`${name} = "\\(\\(\\) => \\{" \\+ CODE_BOXES \\+ r"""\\n([\\s\\S]*?)"""`),
  )?.[1];
  if (!boxes || !body) throw new Error(`Typing script ${name} was not found`);
  return `(() => {\n${boxes}\n${body}`;
}
