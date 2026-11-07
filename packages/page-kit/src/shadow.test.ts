import { parse } from "sucrase/dist/parser/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";
import { describe, expect, it } from "vitest";
import { createComponentScope } from "./component-scope.js";
import { createReactElementCallLookup } from "./react-element-call.js";
import { selfRenderingKitNames } from "./shadow.js";

function selfRenderingNames(source: string): string[] {
  const parsed = parse(source, true, false, false);
  const scope = createComponentScope(parsed, source);
  const reactArgument = createReactElementCallLookup(parsed, source, scope);
  const components = new Set<number>();
  parsed.tokens.forEach((_, index) => {
    const at = reactArgument(index);
    if (
      at !== undefined &&
      parsed.tokens[at]?.type === TokenType.name &&
      (parsed.tokens[at + 1]?.type === TokenType.parenR ||
        parsed.tokens[at + 1]?.type === TokenType.comma)
    )
      components.add(at);
  });
  return selfRenderingKitNames(parsed, source, components, scope).map(({ name }) => name);
}

describe("self-rendering kit names", () => {
  it.each([
    ["function Table() { return null; } export default () => <Table />;", []],
    [
      "import {createElement as h} from 'react'; function Table(){return null;} export default () => h(Table);",
      [],
    ],
    ["const Table = () => null, App = () => <Table />; export default App;", []],
    [
      "class Table extends React.Component { render(){ return null; } } export default () => <Table />;",
      [],
    ],
    [
      "import {createElement as h} from 'react'; function Table(){ function Inner({Table}){return h(Table)} return h(Inner,{Table:()=>h('p',null,'OK')}); }",
      [],
    ],
    ["function Table({Table}) { return <Table />; }", []],
    ["function Table() { return <Table.Item />; }", []],
    ["function Table() { return <Table />; }", ["Table"]],
    ["import {createElement as h} from 'react'; function Table() { return h(Table); }", ["Table"]],
    ["const Other = () => null, Table = () => <Table />;", ["Table"]],
    ["class Table extends React.Component { render(){ return <Table />; } }", ["Table"]],
    ["function Table() { const render = () => <Table />; return render(); }", ["Table"]],
    ["const Table = (function Table() { return <Table />; });", ["Table"]],
    [
      "const Table = class Table extends React.Component { render(){ return <Table />; } };",
      ["Table"],
    ],
    ["const Table = identity(function Table() { return <Table />; });", []],
    ["const Table = function Table({Table}) { return <Table />; };", []],
  ])("resolves recursion within the named definition in %s", (source, expected) => {
    expect(selfRenderingNames(source)).toEqual(expected);
  });
});
