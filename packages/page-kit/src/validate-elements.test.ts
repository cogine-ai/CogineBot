import { expect, it } from "vitest";
import { checkPageSource } from "./validate.js";

it.each([
  'const R = React; export default () => R.createElement("iframe");',
  'const { createElement } = React; export default () => createElement("iframe");',
])("retains static tag validation for an indirect React factory: %s", (source) => {
  expect(checkPageSource(source)).toEqual({
    ok: false,
    errors: [expect.stringContaining("<iframe> is not allowed")],
  });
});

const page = (tag: string) =>
  `const suffix = "-card";\nexport default () => React.createElement(${tag});`;

it.each([
  ["`iframe`", "iframe"],
  ["(`sCrIpT`)", "sCrIpT"],
  [String.raw`"\u0069frame"`, "iframe"],
  [String.raw`'ob\x6aect'`, "object"],
  ["`foreign\\u{4f}bject`", "foreignObject"],
  ["`i\\\nframe`", "iframe"],
])("rejects a blocked element written as %s", (tag, name) => {
  expect(checkPageSource(page(tag))).toEqual({
    ok: false,
    errors: [expect.stringContaining(`line 2: <${name}> is not allowed in a page`)],
  });
});

it.each([
  "`svg`",
  String.raw`"\u0064iv"`,
  `\`style\${suffix}\``,
  "`style` + suffix",
  '"style" + suffix',
])("accepts an ordinary element or leaves a dynamic tag to the viewer: %s", (tag) => {
  expect(checkPageSource(page(tag))).toEqual({ ok: true, code: expect.any(String) });
});
