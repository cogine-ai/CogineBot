/// <reference path="./sucrase-parser.d.ts" />
import type { parse } from "sucrase/dist/parser/index.js";
import { IdentifierRole } from "sucrase/dist/parser/tokenizer/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";

type Tokens = ReturnType<typeof parse>["tokens"];

type LexicalScope = {
  start: number;
  parent?: LexicalScope;
  varScope?: LexicalScope;
  deferred: boolean;
  guarded: boolean;
  forVar: boolean;
  returnAt?: number;
  bindings: Map<string, number | null>;
};

export function identifierName(spelling: string): string {
  return spelling.replace(/\\u(?:\{([\da-f]+)\}|([\da-f]{4}))/gi, (match, point, unit) => {
    const value = Number.parseInt(point ?? unit, 16);
    return value <= 0x10ffff ? String.fromCodePoint(value) : match;
  });
}

/** Resolve component roots by lexical binding, without evaluating page code. */
export function createComponentScope({ tokens, scopes }: ReturnType<typeof parse>, source: string) {
  const { initializers, initializedAt } = simpleDeclarations(tokens);
  const jsxRoots = directJsxRoots(tokens);
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
      const before = tokens[start - 1]?.type;
      const localVars = scope.isFunctionScope || before === TokenType._static;
      const paren = tokens[start + 1]?.type === TokenType.parenL ? start + 1 : start + 2;
      const current: LexicalScope = {
        start,
        parent,
        varScope: localVars ? undefined : (parent?.varScope ?? parent),
        deferred: scope.isFunctionScope,
        guarded:
          parent?.guarded === true ||
          (!scope.isFunctionScope &&
            (before === TokenType.parenR ||
              before === TokenType._else ||
              before === TokenType._do ||
              before === TokenType._try ||
              before === TokenType._finally ||
              tokens[start]?.type === TokenType._for)),
        // Sucrase also marks a `var` binding in a for header as block scoped.
        forVar:
          tokens[start]?.type === TokenType._for &&
          tokens[paren]?.type === TokenType.parenL &&
          tokens[paren + 1]?.type === TokenType._var,
        bindings: new Map(),
      };
      root ??= current;
      stack.push(current);
    }
    const scope = stack.at(-1);
    scopesAt[index] = scope;
    if (!scope) continue;

    const token = tokens[index]!;
    if (
      token.type === TokenType._return &&
      tokens[scope.start]?.type === TokenType.braceL &&
      isStatementStart(tokens, index, scope.start)
    )
      scope.returnAt = index;
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
    if (binding) {
      // A class's name is available in its own body, including static members.
      const initialized =
        tokens[index - 1]?.type === TokenType._class ? index : initializedAt.get(index);
      binding.bindings.set(
        identifierName(source.slice(token.start, token.end)),
        initialized ?? null,
      );
    }
  }

  return {
    isInEagerTemporalDeadZone(name: string, tokenIndex: number): boolean {
      const current = scopesAt[tokenIndex];
      if (current?.guarded) return false;
      const read = eagerReadStart(
        tokens,
        source,
        initializers,
        jsxRoots,
        tokenIndex,
        current?.start,
      );
      if (read === undefined) return false;
      const identifier = identifierName(name);
      let initialization: number | null | undefined;
      for (let scope = current; scope; scope = scope.parent) {
        if (scope.returnAt !== undefined && read > scope.returnAt) return false;
        if (initialization === undefined) initialization = scope.bindings.get(identifier);
        // An outer declaration can initialize before an inner function is invoked.
        if (scope.deferred) break;
      }
      return initialization != null && tokenIndex < initialization;
    },
    has(name: string, tokenIndex: number): boolean {
      const identifier = identifierName(name);
      for (let scope = scopesAt[tokenIndex]; scope; scope = scope.parent) {
        if (scope.bindings.has(identifier)) return true;
      }
      return false;
    },
  };
}

/** Read timing for simple declarators, including names later in a comma list. */
function simpleDeclarations(tokens: Tokens) {
  const initializers = new Set<number>();
  const initializedAt = new Map<number, number>();
  for (let index = 0; index < tokens.length; index++) {
    const keyword = tokens[index]?.type;
    if (keyword !== TokenType._const && keyword !== TokenType._let && keyword !== TokenType._var)
      continue;

    let name = index + 1;
    while (tokens[name]?.type === TokenType.name) {
      const equals = tokens[name + 1];
      const end = equals?.type === TokenType.eq ? equals.rhsEndIndex : null;
      if (end !== null) initializers.add(name + 1);
      if (keyword !== TokenType._var) initializedAt.set(name, end ?? name + 1);
      if (tokens[end ?? name + 1]?.type !== TokenType.comma) break;
      name = (end ?? name + 1) + 1;
    }
  }
  return { initializers, initializedAt };
}

/** Map ordinary children and exact JSX-valued braces to their outer JSX expression. */
function directJsxRoots(tokens: Tokens): (number | undefined)[] {
  type Tag = {
    start: number;
    depth: number;
    phase: "attributes" | "children" | "closing";
    directParent?: number;
    expressionParens?: number;
  };
  const stack: Tag[] = [];
  const roots = new Array<number | undefined>(tokens.length);
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const type = tokens[index]?.type;
    const tag = stack.at(-1);
    if (type === TokenType.braceL || type === TokenType.dollarBraceL) depth++;
    else if (type === TokenType.braceR) depth--;
    else if (type === TokenType.jsxTagStart) {
      if (tokens[index + 1]?.type === TokenType.slash) {
        if (tag) tag.phase = "closing";
        continue;
      }
      const opening: Tag = { start: index, depth, phase: "attributes" };
      if (tag && depth === tag.depth && tag.phase === "children") {
        opening.directParent = tag.start;
      } else if (tag && depth === tag.depth + 1) {
        let previous = index - 1;
        while (tokens[previous]?.type === TokenType.parenL) previous--;
        if (tokens[previous]?.type === TokenType.braceL) {
          opening.directParent = tag.start;
          opening.expressionParens = index - previous - 1;
        }
      }
      stack.push(opening);
    } else if (type === TokenType.jsxTagEnd && tag) {
      if (tag.phase !== "closing" && tokens[index - 1]?.type !== TokenType.slash) {
        tag.phase = "children";
        continue;
      }
      stack.pop();
      if (tag.expressionParens !== undefined) {
        let end = index + 1;
        while (tokens[end]?.type === TokenType.parenR) end++;
        if (end - index - 1 !== tag.expressionParens || tokens[end]?.type !== TokenType.braceR)
          continue;
      }
      roots[tag.start] = tag.directParent;
    }
  }
  for (let index = 0; index < roots.length; index++) {
    const parent = roots[index];
    if (parent !== undefined) roots[index] = roots[parent] ?? parent;
  }
  return roots;
}

function isStatementStart(tokens: Tokens, start: number, scopeStart: number | undefined): boolean {
  const before = tokens[start - 1]?.type;
  return (
    start === 0 ||
    before === TokenType.semi ||
    (before === TokenType.braceL && start - 1 === scopeStart)
  );
}

/** Only straight-line expression starts, avoiding branches and deferred field initializers. */
function eagerReadStart(
  tokens: Tokens,
  source: string,
  initializers: ReadonlySet<number>,
  jsxRoots: readonly (number | undefined)[],
  index: number,
  scopeStart: number | undefined,
): number | undefined {
  let start = index - 1;
  if (tokens[start]?.type === TokenType.parenL) {
    // The caller already recognized this argument as the component in createElement.
    start -= 1;
    while (tokens[start - 1]?.type === TokenType.dot) start -= 2;
  } else {
    if (tokens[start]?.type !== TokenType.jsxTagStart) return undefined;
    start = jsxRoots[start] ?? start;
  }
  while (
    tokens[start - 1]?.type === TokenType.parenL ||
    tokens[start - 1]?.type === TokenType.bracketL
  )
    start -= 1;
  // Only consider a return at a statement start, e.g. outside an unbraced if.
  const previous = tokens[start - 1];
  if (previous?.type === TokenType._return) {
    if (/[\n\r\u2028\u2029]/.test(source.slice(previous.end, tokens[start]!.start)))
      return undefined;
    start -= 1;
  }
  return initializers.has(start - 1) || isStatementStart(tokens, start, scopeStart)
    ? start
    : undefined;
}
