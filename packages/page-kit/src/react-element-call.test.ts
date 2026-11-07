import { parse } from "sucrase/dist/parser/index.js";
import { describe, expect, it } from "vitest";
import { createComponentScope } from "./component-scope.js";
import { PAGE_KIT_MODULE } from "./components.js";
import { createReactElementCallLookup } from "./react-element-call.js";

function recognizedArguments(source: string): string[] {
  const parsed = parse(source, true, false, false);
  const lookup = createReactElementCallLookup(parsed, source, createComponentScope(parsed, source));
  return parsed.tokens.flatMap((_, index) => {
    const argument = lookup(index);
    const token = argument === undefined ? undefined : parsed.tokens[argument];
    return token ? [source.slice(token.start, token.end)] : [];
  });
}

describe("React createElement call recognition", () => {
  it.each([
    ["export default () => React.createElement(Missing.Card)", ["Missing"]],
    [
      "import { createElement } from 'react'; export default () => createElement(Missing.Card)",
      ["Missing"],
    ],
    ["import { createElement as h } from 'react'; export default () => h('iframe')", ["'iframe'"]],
    ["import R from 'react'; export default () => R.createElement(Missing.Card)", ["Missing"]],
    [
      "import { default as R } from 'react'; export default () => R.createElement(Missing.Card)",
      ["Missing"],
    ],
    [
      "import * as R from 'react'; export default () => R?.createElement?.(Missing.Card)",
      ["Missing"],
    ],
    [
      "import { createElement as h } from 'react'; export default () => \\u0068(Missing.Card)",
      ["Missing"],
    ],
    ["import { createElement as h } from 'react'; export default (h) => h(Missing.Card)", []],
    ["import R from 'react'; export default (R) => R.createElement(Missing.Card)", []],
    ["export default ({ React }) => React.createElement('iframe')", []],
    ["const createElement = () => null; export default () => createElement('iframe')", []],
    [
      "const mock = { createElement: () => null }; export default () => mock.createElement(Missing.Card)",
      [],
    ],
    ["export default () => globalThis.React.createElement(Missing.Card)", []],
    [
      `import { Text as createElement } from "${PAGE_KIT_MODULE}"; export default () => createElement(Missing.Card)`,
      [],
    ],
    ["export default () => React.createElement()", []],
  ])("identifies only actual React arguments in %s", (source, expected) => {
    expect(recognizedArguments(source)).toEqual(expected);
  });
});
