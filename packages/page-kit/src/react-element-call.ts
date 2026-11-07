/// <reference path="./sucrase-parser.d.ts" />
import type { parse } from "sucrase/dist/parser/index.js";
import { IdentifierRole } from "sucrase/dist/parser/tokenizer/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";
import { type createComponentScope, identifierName } from "./component-scope.js";

/** Identify React factories by the binding at the call, so local names can shadow imports. */
export function createReactElementCallLookup(
  { tokens }: ReturnType<typeof parse>,
  source: string,
  scope: ReturnType<typeof createComponentScope>,
): (calleeIndex: number) => number | undefined {
  const raw = (index: number) => source.slice(tokens[index]!.start, tokens[index]!.end);
  const name = (index: number) => identifierName(raw(index));
  const factories = new Set<number>();
  const receivers = new Set<number>();
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.type !== TokenType._import) continue;
    let module = index + 1;
    while (
      module < tokens.length &&
      tokens[module]?.type !== TokenType.string &&
      tokens[module]?.type !== TokenType.parenL &&
      tokens[module]?.type !== TokenType.dot &&
      tokens[module]?.type !== TokenType.eof
    )
      module += 1;
    if (tokens[module]?.type !== TokenType.string || raw(module).slice(1, -1) !== "react") continue;

    for (let local = index + 1; local < module; local++) {
      if (tokens[local]?.identifierRole !== IdentifierRole.ImportDeclaration) continue;
      const aliased = tokens[local - 2]?.identifierRole === IdentifierRole.ImportAccess;
      const imported = name(aliased ? local - 2 : local);
      if (
        local === index + 1 ||
        tokens[local - 2]?.type === TokenType.star ||
        (aliased && imported === "default")
      )
        receivers.add(local);
      else if (imported === "createElement") factories.add(local);
    }
  }
  return (index) => {
    if (tokens[index]?.type !== TokenType.name) return undefined;
    const paren = index + (tokens[index + 1]?.type === TokenType.questionDot ? 2 : 1);
    if (tokens[paren]?.type !== TokenType.parenL || tokens[paren + 1]?.type === TokenType.parenR)
      return undefined;

    const previous = tokens[index - 1]?.type;
    if (previous === TokenType.dot || previous === TokenType.questionDot) {
      const receiver = index - 2;
      if (
        name(index) !== "createElement" ||
        tokens[receiver]?.type !== TokenType.name ||
        tokens[receiver]?.identifierRole !== IdentifierRole.Access
      )
        return undefined;
      const receiverName = name(receiver);
      const declaration = scope.declarationIndex(receiverName, receiver);
      if (declaration === undefined ? receiverName !== "React" : !receivers.has(declaration))
        return undefined;
    } else {
      if (tokens[index]?.identifierRole !== IdentifierRole.Access) return undefined;
      const declaration = scope.declarationIndex(name(index), index);
      if (declaration === undefined || !factories.has(declaration)) return undefined;
    }
    return paren + 1;
  };
}
