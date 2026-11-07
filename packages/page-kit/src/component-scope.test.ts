import { parse } from "sucrase/dist/parser/index.js";
import { IdentifierRole } from "sucrase/dist/parser/tokenizer/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";
import { describe, expect, it } from "vitest";
import { createComponentScope } from "./component-scope.js";

function bindingAtReferences(source: string, name: string): boolean[] {
  const parsed = parse(source, true, false, false);
  const scope = createComponentScope(parsed, source);
  return parsed.tokens.flatMap((token, index) =>
    (token.type === TokenType.name || token.type === TokenType.jsxName) &&
    token.identifierRole === IdentifierRole.Access &&
    source.slice(token.start, token.end) === name
      ? [scope.has(name, index)]
      : [],
  );
}

describe("component lexical scope", () => {
  it("finds a destructured parameter in its closure but not in a sibling", () => {
    expect(
      bindingAtReferences(
        "function Wrap({ Tile }) { return () => <Tile />; } const App = () => <Tile />;",
        "Tile",
      ),
    ).toEqual([true, false]);
  });

  it.each([
    ["let Tile", [true, false]],
    ["var Tile", [true, true]],
    ["function Tile() {}", [true, false]],
  ])("looks up %s in the appropriate block or enclosing function", (binding, expected) => {
    expect(
      bindingAtReferences(
        `function App() { if (true) { ${binding}; const render = () => <Tile />; } return <Tile />; }`,
        "Tile",
      ),
    ).toEqual(expected);
  });

  it.each([
    ["let", [true, false]],
    ["var", [true, true]],
  ])("resolves a %s binding in a destructured for header", (keyword, expected) => {
    expect(
      bindingAtReferences(
        `function App() { for (${keyword} { Tile } of []) { const render = () => <Tile />; } return <Tile />; }`,
        "Tile",
      ),
    ).toEqual(expected);
  });

  it("keeps static-block vars and function-body vars inside their own environments", () => {
    expect(
      bindingAtReferences(
        "class Support { static { var Tile; const render = () => <Tile />; } }" +
          "function App(render = () => <Tile />) { var Tile; return <Tile />; }",
        "Tile",
      ),
    ).toEqual([true, false, true]);
  });

  it.each([
    "function Tile() { return <Tile />; }",
    "class Tile extends React.Component { render() { return <Tile />; } }",
  ])("keeps a named expression binding private: %s", (expression) => {
    expect(
      bindingAtReferences(`const Impl = ${expression}; const App = () => <Tile />;`, "Tile"),
    ).toEqual([true, false]);
  });

  it("resolves imported namespace roots, including the createElement use site", () => {
    expect(
      bindingAtReferences(
        'import * as kit from "rakazo/page"; const View = () => <kit.Text />; ' +
          "const App = () => React.createElement(kit.Text);",
        "kit",
      ),
    ).toEqual([true, true]);
    expect(
      bindingAtReferences(
        "const View = (kit) => <kit.Text />; const App = () => React.createElement(kit.Text);",
        "kit",
      ),
    ).toEqual([true, false]);
  });

  it("resolves an escaped declaration by its JavaScript identifier name", () => {
    expect(
      bindingAtReferences("const \\u0054ile = () => null; const App = () => <Tile />;", "Tile"),
    ).toEqual([true]);
  });
});
