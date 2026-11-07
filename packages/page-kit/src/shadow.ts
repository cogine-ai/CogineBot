/// <reference path="./sucrase-parser.d.ts" />
import type { parse } from "sucrase/dist/parser/index.js";
import { IdentifierRole } from "sucrase/dist/parser/tokenizer/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";
import { type createComponentScope, identifierName } from "./component-scope.js";
import { PAGE_KIT_COMPONENTS } from "./components.js";

type Tokens = ReturnType<typeof parse>["tokens"];

const KIT: ReadonlySet<string> = new Set(PAGE_KIT_COMPONENTS);

/**
 * Top-level components named like a kit component that use that name inside themselves. The
 * page's own `Status` replaces the kit's in the whole file, so `<Status>` inside it renders
 * itself forever and hangs the viewer. Reusing a name without using it inside is harmless.
 */
export function selfRenderingKitNames(
  { tokens, scopes }: ReturnType<typeof parse>,
  source: string,
  directElementComponents: ReadonlySet<number>,
  scope: ReturnType<typeof createComponentScope>,
): { name: string; start: number }[] {
  const found: { name: string; start: number }[] = [];
  const text = (index: number) => source.slice(tokens[index]!.start, tokens[index]!.end);
  const scopeEnds = new Map(scopes.map((entry) => [entry.startTokenIndex, entry.endTokenIndex]));

  tokens.forEach((token, index) => {
    if (
      token.type !== TokenType.name ||
      token.identifierRole !== IdentifierRole.TopLevelDeclaration
    )
      return;
    const name = identifierName(text(index));
    if (!KIT.has(name) || found.some((entry) => entry.name === name)) return;
    const end = definitionEnd(tokens, index, scopeEnds);
    const declaration = scope.declarationIndex(name, index);
    if (end === undefined || declaration === undefined) return;
    const privateName = exactNamedInitializer(tokens, text, scopeEnds, index, end);
    for (let at = index + 1; at < end; at++) {
      const next = tokens[at]!;
      const tag =
        next.type === TokenType.jsxName &&
        tokens[at - 1]?.type === TokenType.jsxTagStart &&
        tokens[at + 1]?.type !== TokenType.dot &&
        tokens[at + 1]?.type !== TokenType.colon;
      if ((!tag && !directElementComponents.has(at)) || identifierName(text(at)) !== name) continue;
      const used = scope.declarationIndex(name, at);
      if (used !== declaration && (used === undefined || used !== privateName)) continue;
      found.push({ name, start: token.start });
      break;
    }
  });
  return found;
}

function definitionEnd(
  tokens: Tokens,
  index: number,
  scopeEnds: ReadonlyMap<number, number>,
): number | undefined {
  const following = tokens[index + 1];
  if (following?.type === TokenType.eq) return following.rhsEndIndex ?? undefined;
  const before = tokens[index - 1];
  if (
    before?.type === TokenType._function ||
    (before?.type === TokenType.star && tokens[index - 2]?.type === TokenType._function)
  ) {
    // Sucrase's parameter scope ends at the closing token of the function body.
    return scopeEnds.get(index + 1);
  }
  if (before?.type === TokenType._class && before.contextId !== null) {
    for (let at = index + 1; at < tokens.length; at++) {
      const token = tokens[at]!;
      if (token.type === TokenType.braceR && token.contextId === before.contextId) return at;
    }
  }
  return undefined;
}

/** An exact function or class initializer can render itself through its private name. */
function exactNamedInitializer(
  tokens: Tokens,
  text: (index: number) => string,
  scopeEnds: ReadonlyMap<number, number>,
  declaration: number,
  end: number,
): number | undefined {
  if (tokens[declaration + 1]?.type !== TokenType.eq) return undefined;
  const start = declaration + 2;
  let expression = start;
  while (tokens[expression]?.type === TokenType.parenL) expression++;
  const groups = expression - start;
  if (text(expression) === "async") expression++;
  if (tokens[expression]?.type !== TokenType._class && text(expression) !== "function")
    return undefined;
  const name = expression + (tokens[expression + 1]?.type === TokenType.star ? 2 : 1);
  if (tokens[name]?.type !== TokenType.name) return undefined;
  const expressionEnd = scopeEnds.get(name);
  if (expressionEnd === undefined || expressionEnd + groups !== end) return undefined;
  for (let index = expressionEnd; index < end; index++) {
    if (tokens[index]?.type !== TokenType.parenR) return undefined;
  }
  return name;
}

export function selfRenderingMessage(name: string): string {
  return `your own \`${name}\` replaces the kit's ${name} in this file, so the <${name}> inside it renders itself forever. Rename yours, for example ${name}View.`;
}
