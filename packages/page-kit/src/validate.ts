/// <reference path="./sucrase-parser.d.ts" />
import { PAGE_SOURCE_MAX_BYTES, pageSourceBytes } from "@rakazo/contracts";
import React from "react";
// Sucrase's own parser, pinned with it, so the check reads the same tokens the compiler does.
import { parse } from "sucrase/dist/parser/index.js";
import { IdentifierRole } from "sucrase/dist/parser/tokenizer/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";
import {
  compilePageSource,
  declaredSources,
  hasPageSourceDeclaration,
  pageViewerCode,
} from "./compile.js";
import { createComponentScope, identifierName } from "./component-scope.js";
import {
  PAGE_GLOBALS,
  PAGE_HELPERS,
  PAGE_KIT_COMPONENTS,
  PAGE_KIT_MODULE,
  PAGE_MODULES,
} from "./components.js";
import { selfRenderingKitNames, selfRenderingMessage } from "./shadow.js";

export { PAGE_KIT_GUIDE } from "./guide.js";

const MAX_REPORTED_ERRORS = 20;

/**
 * A page that passes carries its viewer code, compiled once here and stored with the version.
 * Warnings do not stop the save; they tell the bot about text the reader would see verbatim.
 */
type PageSourceCheck =
  | { ok: true; code: string; warnings?: string[] }
  | { ok: false; errors: string[] };

const KIT_NAMES: ReadonlySet<string> = new Set(PAGE_KIT_COMPONENTS);
// Built once; the kit is long enough that the checker gives up on joining the literal tuple.
const KIT_LIST = (PAGE_KIT_COMPONENTS as readonly string[]).join(", ");
// Escapes JSX decodes in its own text, but that a JavaScript string shows as typed.
const HTML_ENTITY = /&(?:lt|gt|amp|quot|apos|nbsp|#39|#x27);/;

const GIVEN: ReadonlySet<string> = new Set(PAGE_GLOBALS);
const DECLARATION_ROLES: ReadonlySet<IdentifierRole | null> = new Set([
  IdentifierRole.TopLevelDeclaration,
  IdentifierRole.FunctionScopedDeclaration,
  IdentifierRole.BlockScopedDeclaration,
  IdentifierRole.ObjectShorthandTopLevelDeclaration,
  IdentifierRole.ObjectShorthandFunctionScopedDeclaration,
  IdentifierRole.ObjectShorthandBlockScopedDeclaration,
  IdentifierRole.ImportDeclaration,
]);

/**
 * Catches mistakes before the user sees the page, with line numbers the bot can act on. It is
 * not a security boundary: page code runs only inside the sandboxed viewer, which is the boundary.
 */
export function checkPageSource(source: string): PageSourceCheck {
  const bytes = pageSourceBytes(source);
  if (bytes > PAGE_SOURCE_MAX_BYTES) {
    return {
      ok: false,
      errors: [
        `The page is ${bytes} bytes; the limit is ${PAGE_SOURCE_MAX_BYTES}. Move data out or split the page.`,
      ],
    };
  }
  const lineOf = lineLocator(source);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(source, true, false, false);
  } catch (error) {
    return { ok: false, errors: [syntaxErrorText(error)] };
  }
  const { tokens } = parsed;
  const errors: string[] = [];
  const warnings: string[] = [];
  const scope = createComponentScope(parsed, source);
  const componentErrors = new Map<string, string>();
  const checkComponent = (name: string, index: number, line: number) => {
    if (componentErrors.has(name)) return;
    if (scope.isInEagerTemporalDeadZone(name, index)) {
      componentErrors.set(
        name,
        `line ${line}: <${name}> is used before it is initialized. Move its declaration before this use or render it inside a component.`,
      );
    } else if (!GIVEN.has(name) && !scope.has(name, index)) {
      componentErrors.set(
        name,
        `line ${line}: <${name}> is not a kit component. Use ${KIT_LIST}, or define ${name} in this file.`,
      );
    }
  };
  let defaults = 0;
  let loadsModule = false;
  const blocked = new Set<string>();
  tokens.forEach((token, index) => {
    const text = source.slice(token.start, token.end);
    const line = lineOf(token.start);
    if (token.type === TokenType._import) {
      const problem = importProblem(tokens, index, source);
      if (problem) errors.push(`line ${line}: ${problem}`);
      else loadsModule = true;
    } else if (
      (token.type === TokenType.string || token.type === TokenType.template) &&
      !isJsxAttributeValue(tokens, index) &&
      HTML_ENTITY.test(text)
    ) {
      warnings.push(
        `line ${line}: ${text.match(HTML_ENTITY)![0]} in a JavaScript string shows up literally; write the plain character instead.`,
      );
    } else if (token.type === TokenType._export) {
      if (tokens[index + 1]?.type === TokenType._default) {
        defaults += 1;
        if (isLiteralDefault(tokens, index + 2, token.rhsEndIndex)) {
          errors.push(
            `line ${line}: the default export must be a React component, not a literal value.`,
          );
        }
      } else {
        const end =
          tokens[index + 1]?.type === TokenType.braceL
            ? defaultExportListEnd(tokens, index + 1, source)
            : undefined;
        if (end === undefined) {
          errors.push(`line ${line}: only \`export default\` is allowed.`);
        } else {
          defaults += 1;
          // A default re-export loads a module just as an import does.
          if (tokens[end + 2]?.type === TokenType.string) {
            const from = tokens[end + 1]!;
            if (source.slice(from.start, from.end) === "from") {
              const problem = importProblem(tokens, index, source);
              if (problem) errors.push(`line ${line}: ${problem}`);
              else loadsModule = true;
            }
          }
        }
      }
    } else if (token.type === TokenType.jsxTagStart) {
      const nameToken =
        tokens[index + 1]?.type === TokenType.jsxName ? tokens[index + 1] : undefined;
      const name = nameToken ? source.slice(nameToken.start, nameToken.end) : "";
      // A lowercase first letter makes an element, and HTML reads its name in any case.
      const element = /^[a-z]/.test(name) ? name.toLowerCase() : "";
      if (BLOCKED_ELEMENTS.has(element) && !blocked.has(element)) {
        blocked.add(element);
        errors.push(
          `line ${line}: <${name}> is not allowed in a page; ${BLOCKED_ELEMENTS.get(element)}`,
        );
      }
    } else if (
      token.type === TokenType.jsxName &&
      /^on[a-z]/i.test(text) &&
      tokens[index + 1]?.type === TokenType.eq &&
      tokens[index + 2]?.type === TokenType.string
    ) {
      errors.push(
        `line ${line}: ${text} takes a function, not a string: write ${text}={() => ...}.`,
      );
    } else if (
      token.type === TokenType.name &&
      text === "require" &&
      token.identifierRole === IdentifierRole.Access
    ) {
      errors.push(
        `line ${line}: require is not available; everything a page can use is already in scope.`,
      );
    } else if (token.type === TokenType.jsxName && token.identifierRole === IdentifierRole.Access) {
      checkComponent(text, index, line);
    } else if (
      // Compiled pages call React.createElement(Name, ...) where JSX would write <Name>.
      token.type === TokenType.name &&
      text === "createElement" &&
      tokens[index + 1]?.type === TokenType.parenL &&
      tokens[index + 2]?.type === TokenType.name
    ) {
      const argument = tokens[index + 2]!;
      const name = identifierName(source.slice(argument.start, argument.end));
      const next = tokens[index + 3]?.type;
      const member =
        next === TokenType.dot || next === TokenType.questionDot || next === TokenType.bracketL;
      const receiver = tokens[index - 2];
      const receiverAccess = tokens[index - 1]?.type;
      const reactMember =
        member &&
        receiver &&
        (receiverAccess === TokenType.dot || receiverAccess === TokenType.questionDot) &&
        source.slice(receiver.start, receiver.end) === "React";
      if (reactMember || (!member && /^[A-Z]/.test(name))) {
        checkComponent(name, index + 2, lineOf(argument.start));
      }
    } else if (
      // Static names passed to createElement name the same elements as JSX.
      token.type === TokenType.name &&
      text === "createElement" &&
      tokens[index + 1]?.type === TokenType.parenL
    ) {
      const name = staticElementName(tokens, index + 2, source);
      if (name === undefined) return;
      const element = name.toLowerCase();
      if (BLOCKED_ELEMENTS.has(element) && !blocked.has(element)) {
        blocked.add(element);
        errors.push(
          `line ${line}: <${name}> is not allowed in a page; ${BLOCKED_ELEMENTS.get(element)}`,
        );
      }
    }
  });
  const moduleBindings = new Set(["exports", "Object"]);
  if (loadsModule) moduleBindings.add("require");
  if (hasPageSourceDeclaration(source)) moduleBindings.add("globalThis");
  for (const { name, start } of moduleBindingConflicts(parsed, source, moduleBindings)) {
    errors.push(
      `line ${lineOf(start)}: rename the module binding \`${name}\`; the viewer uses this name.`,
    );
  }
  for (const { name, start } of selfRenderingKitNames(tokens, source)) {
    errors.push(`line ${lineOf(start)}: ${selfRenderingMessage(name)}`);
  }
  errors.push(...componentErrors.values());
  if (defaults !== 1) {
    errors.push("The page needs exactly one `export default` of its top component.");
  }
  // The list goes back to the model, so a file with the same mistake on every line stays cheap.
  if (errors.length > MAX_REPORTED_ERRORS) {
    const more = errors.length - MAX_REPORTED_ERRORS;
    return { ok: false, errors: [...errors.slice(0, MAX_REPORTED_ERRORS), `…and ${more} more.`] };
  }
  if (errors.length) return { ok: false, errors };
  let compiled: string;
  try {
    declaredSources(source);
    compiled = compilePageSource(source);
  } catch (error) {
    return { ok: false, errors: [syntaxErrorText(error)] };
  }
  const code = pageViewerCode(source, compiled);
  return warnings.length
    ? { ok: true, code, warnings: warnings.slice(0, MAX_REPORTED_ERRORS) }
    : { ok: true, code };
}

type Tokens = ReturnType<typeof parse>["tokens"];

/** Sucrase emits its bridge in the same scope as the compiled page. */
function moduleBindingConflicts(
  { tokens, scopes }: ReturnType<typeof parse>,
  source: string,
  reserved: ReadonlySet<string>,
) {
  const conflicts: { name: string; start: number }[] = [];
  const stack: typeof scopes = [];
  const root = scopes.at(-1);
  let nextScope = scopes.length - 1;
  let localVarScopes = 0;
  const isLocalVarScope = (scope: (typeof scopes)[number]) =>
    scope !== root &&
    (scope.isFunctionScope || tokens[scope.startTokenIndex - 1]?.type === TokenType._static);

  // Sucrase lists scopes by end index. Walk backwards to tell module vars from nested locals.
  for (let i = tokens.length - 1; i >= 0; i--) {
    while (stack.at(-1)?.startTokenIndex === i + 1) {
      if (isLocalVarScope(stack.pop()!)) localVarScopes -= 1;
    }
    while (scopes[nextScope]?.endTokenIndex === i + 1) {
      const scope = scopes[nextScope--]!;
      stack.push(scope);
      if (isLocalVarScope(scope)) localVarScopes += 1;
    }
    const token = tokens[i]!;
    const role = token.identifierRole;
    if (token.type !== TokenType.name || !DECLARATION_ROLES.has(role) || localVarScopes > 0)
      continue;
    const name = identifierName(source.slice(token.start, token.end));
    if (!reserved.has(name)) continue;

    const before = tokens[i - 1]?.type;
    const namespaceImport =
      role === IdentifierRole.ImportDeclaration && tokens[i - 2]?.type === TokenType.star;
    const strictBlockFunction =
      before === TokenType._function ||
      (before === TokenType.star && tokens[i - 2]?.type === TokenType._function);
    const moduleVar =
      (role === IdentifierRole.FunctionScopedDeclaration ||
        role === IdentifierRole.ObjectShorthandFunctionScopedDeclaration) &&
      !strictBlockFunction;
    // In a for header Sucrase gives var declarations the same role as let and const.
    const inner = stack.at(-1)?.startTokenIndex ?? 0;
    const forVar =
      (role === IdentifierRole.BlockScopedDeclaration ||
        role === IdentifierRole.ObjectShorthandBlockScopedDeclaration) &&
      tokens[inner]?.type === TokenType._for &&
      tokens[inner + 1]?.type === TokenType.parenL &&
      tokens[inner + 2]?.type === TokenType._var;
    if (
      role === IdentifierRole.TopLevelDeclaration ||
      role === IdentifierRole.ObjectShorthandTopLevelDeclaration ||
      namespaceImport ||
      moduleVar ||
      forVar
    ) {
      conflicts.push({ name, start: token.start });
    }
  }
  return conflicts.reverse();
}

/** Reject only literal values we can identify without running page code. */
function isLiteralDefault(tokens: Tokens, start: number, end: number | null): boolean {
  if (end === null) return false;
  if (tokens[end - 1]?.type === TokenType.semi) end -= 1;
  while (
    end - start > 2 &&
    tokens[start]?.type === TokenType.parenL &&
    tokens[end - 1]?.type === TokenType.parenR
  ) {
    start += 1;
    end -= 1;
  }
  const first = tokens[start]?.type;
  if (end - start === 1) {
    return (
      first === TokenType.num ||
      first === TokenType.bigint ||
      first === TokenType.string ||
      first === TokenType.regexp ||
      first === TokenType._null ||
      first === TokenType._true ||
      first === TokenType._false
    );
  }
  const next = tokens[start + 1]?.type;
  return (
    end - start === 2 &&
    (first === TokenType.plus || first === TokenType.minus) &&
    (next === TokenType.num || next === TokenType.bigint)
  );
}

// Plain HTML and SVG elements are fine for custom visuals; these would load or run something
// else, which the viewer's sandbox blocks anyway, so the page would show a hole.
const BLOCKED_ELEMENTS: ReadonlyMap<string, string> = new Map([
  ["script", "page code runs from the file itself."],
  ["style", "use style={{...}} on the element or the kit's components."],
  ["iframe", "pages cannot embed other pages."],
  ["object", "pages cannot embed other content."],
  ["embed", "pages cannot embed other content."],
  ["foreignobject", "draw with SVG shapes and text instead."],
]);

function staticElementName(tokens: Tokens, start: number, source: string): string | undefined {
  let index = start;
  while (tokens[index]?.type === TokenType.parenL) index += 1;
  const literal = tokens[index];
  const quasi = tokens[index + 1];
  let raw: string;
  let end: number;
  if (literal?.type === TokenType.string) {
    raw = source.slice(literal.start + 1, literal.end - 1);
    end = index + 1;
  } else if (
    literal?.type === TokenType.backQuote &&
    quasi?.type === TokenType.template &&
    tokens[index + 2]?.type === TokenType.backQuote
  ) {
    raw = source.slice(quasi.start, quasi.end);
    end = index + 3;
  } else {
    return undefined;
  }
  for (let parens = index - start; parens > 0; parens -= 1) {
    if (tokens[end]?.type !== TokenType.parenR) return undefined;
    end += 1;
  }
  if (tokens[end]?.type !== TokenType.comma && tokens[end]?.type !== TokenType.parenR) {
    return undefined;
  }
  // Decode spellings that can form a tag name without evaluating the page.
  return raw.replace(
    /\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|\r\n|[\s\S])/g,
    (match, point, unit, byte) => {
      const hex = point ?? unit ?? byte;
      if (hex !== undefined) {
        const value = Number.parseInt(hex, 16);
        return value <= 0x10ffff ? String.fromCodePoint(value) : match;
      }
      const escaped = match.slice(1);
      if (/^[\r\n\u2028\u2029]+$/.test(escaped)) return "";
      // Control and malformed escapes cannot spell a blocked name.
      return /^[0-9bfnrtuvx]$/.test(escaped) ? match : escaped;
    },
  );
}

/** Finds the end of a list that only names the default export, as bundlers write it. */
function defaultExportListEnd(tokens: Tokens, open: number, source: string): number | undefined {
  const words: string[] = [];
  for (let index = open + 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === TokenType.braceR) {
      if (words.at(-1) === ",") words.pop();
      return words.length === 3 && words[1] === "as" && words[2] === "default" ? index : undefined;
    }
    words.push(source.slice(token.start, token.end));
  }
  return undefined;
}

/** An import of React or the kit is allowed and changes nothing; anything else cannot load. */
function importProblem(tokens: Tokens, start: number, source: string): string | undefined {
  const text = (index: number) => source.slice(tokens[index]!.start, tokens[index]!.end);
  let index = start + 1;
  const names: string[] = [];
  let hasDefault = false;
  let inBraces = false;
  for (; index < tokens.length && tokens[index]!.type !== TokenType.string; index++) {
    const { type, identifierRole } = tokens[index]!;
    if (type === TokenType.parenL || type === TokenType.dot) break;
    if (type === TokenType.braceL) inBraces = true;
    else if (type === TokenType.braceR) inBraces = false;
    else if (
      type === TokenType.name &&
      inBraces &&
      (identifierRole === IdentifierRole.ImportAccess ||
        identifierRole === IdentifierRole.ExportAccess ||
        (identifierRole === IdentifierRole.ImportDeclaration && text(index - 1) !== "as"))
    ) {
      names.push(identifierName(text(index)));
    } else if (type === TokenType.name && !inBraces && !["from", "as"].includes(text(index))) {
      // A namespace import ("* as Kit") is fine; a bare name is a default import.
      if (text(index - 1) !== "as") hasDefault = true;
    }
  }
  const from = tokens[index]?.type === TokenType.string ? text(index).slice(1, -1) : undefined;
  if (from === undefined || !PAGE_MODULES.has(from)) {
    return `only "react" and "${PAGE_KIT_MODULE}" can be imported, and neither is needed: the kit components, React and its hooks are already in scope.`;
  }
  if (from === "react") {
    // The viewer supplies the same React package. Default imports also have compiler interop.
    const unknown = names.filter((name) => name !== "default" && !Object.hasOwn(React, name));
    return unknown.length
      ? `${unknown.join(", ")} ${unknown.length > 1 ? "are" : "is"} not exported by React.`
      : undefined;
  }
  if (hasDefault) return `"${PAGE_KIT_MODULE}" has no default export; import components by name.`;
  const unknown = names.filter(
    (name) => !KIT_NAMES.has(name) && !PAGE_HELPERS.includes(name as (typeof PAGE_HELPERS)[number]),
  );
  return unknown.length
    ? `${unknown.join(", ")} ${unknown.length > 1 ? "are" : "is"} not in the kit. Use ${KIT_LIST}.`
    : undefined;
}

function isJsxAttributeValue(tokens: Tokens, index: number): boolean {
  return tokens[index - 1]?.type === TokenType.eq && tokens[index - 2]?.type === TokenType.jsxName;
}

function syntaxErrorText(error: unknown): string {
  const loc = (error as { loc?: { line: number; column: number } }).loc;
  const message = (error instanceof Error ? error.message : String(error)).replace(
    /\s*\(\d+:\d+\)$/,
    "",
  );
  return loc ? `line ${loc.line}, column ${loc.column + 1}: ${message}` : message;
}

function lineLocator(source: string): (offset: number) => number {
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}
