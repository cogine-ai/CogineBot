/// <reference path="./sucrase-parser.d.ts" />
import type { parse } from "sucrase/dist/parser/index.js";
import { IdentifierRole } from "sucrase/dist/parser/tokenizer/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";

type LexicalScope = {
  start: number;
  parent?: LexicalScope;
  varScope?: LexicalScope;
  forVar: boolean;
  bindings: Set<string>;
};

export function identifierName(spelling: string): string {
  return spelling.replace(/\\u(?:\{([\da-f]+)\}|([\da-f]{4}))/gi, (match, point, unit) => {
    const value = Number.parseInt(point ?? unit, 16);
    return value <= 0x10ffff ? String.fromCodePoint(value) : match;
  });
}

/** Resolve component roots by lexical binding, without evaluating page code. */
export function createComponentScope({ tokens, scopes }: ReturnType<typeof parse>, source: string) {
  const stack: LexicalScope[] = [];
  const scopesAt = new Array<LexicalScope | undefined>(tokens.length);
  let root: LexicalScope | undefined;
  let nextScope = scopes.length - 1;
  // Sucrase records scopes as they end, from inner to outer at a shared boundary.
  for (let index = tokens.length - 1; index >= 0; index--) {
    while (stack.at(-1)?.start === index + 1) stack.pop();
    while (scopes[nextScope]?.endTokenIndex === index + 1) {
      const scope = scopes[nextScope--]!;
      const start = scope.startTokenIndex;
      const parent = stack.at(-1);
      const localVars = scope.isFunctionScope || tokens[start - 1]?.type === TokenType._static;
      const paren = tokens[start + 1]?.type === TokenType.parenL ? start + 1 : start + 2;
      const current: LexicalScope = {
        start,
        parent,
        varScope: localVars ? undefined : (parent?.varScope ?? parent),
        // Sucrase also marks a `var` binding in a for header as block scoped.
        forVar:
          tokens[start]?.type === TokenType._for &&
          tokens[paren]?.type === TokenType.parenL &&
          tokens[paren + 1]?.type === TokenType._var,
        bindings: new Set(),
      };
      root ??= current;
      stack.push(current);
    }
    const scope = stack.at(-1);
    scopesAt[index] = scope;
    if (!scope) continue;

    const token = tokens[index]!;
    const role = token.identifierRole;
    let binding: LexicalScope | undefined;
    if (
      role === IdentifierRole.ImportDeclaration ||
      role === IdentifierRole.TopLevelDeclaration ||
      role === IdentifierRole.ObjectShorthandTopLevelDeclaration
    ) {
      binding = root;
    } else if (
      role === IdentifierRole.FunctionScopedDeclaration ||
      role === IdentifierRole.ObjectShorthandFunctionScopedDeclaration
    ) {
      const before = tokens[index - 1]?.type;
      const functionName =
        before === TokenType._function ||
        (before === TokenType.star && tokens[index - 2]?.type === TokenType._function);
      // A named function expression is already in its private name scope.
      // A function declaration in a strict block is local to that block.
      binding = functionName ? scope : (scope.varScope ?? scope);
    } else if (
      role === IdentifierRole.BlockScopedDeclaration ||
      role === IdentifierRole.ObjectShorthandBlockScopedDeclaration
    ) {
      binding = scope.forVar ? (scope.varScope ?? scope) : scope;
    }
    binding?.bindings.add(identifierName(source.slice(token.start, token.end)));
  }

  return {
    has(name: string, tokenIndex: number): boolean {
      const identifier = identifierName(name);
      for (let scope = scopesAt[tokenIndex]; scope; scope = scope.parent) {
        if (scope.bindings.has(identifier)) return true;
      }
      return false;
    },
  };
}
