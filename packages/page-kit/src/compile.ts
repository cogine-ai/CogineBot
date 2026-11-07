import { transform } from "sucrase";
import { parse } from "sucrase/dist/parser/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";
import { identifierName } from "./component-scope.js";

/** Page JSX to a CommonJS body. The save check compiles once and keeps the viewer code. */
export function compilePageSource(
  source: string,
  { tokens } = parse(source, true, false, false),
): string {
  const jsx = tokens.some((token) => token.type === TokenType.jsxTagStart);
  let reactFactory: string | undefined;
  if (jsx) {
    const names = new Set<string>();
    for (const token of tokens) {
      if (token.type === TokenType.name || token.type === TokenType.jsxName)
        names.add(identifierName(source.slice(token.start, token.end)));
    }
    reactFactory = "__pageKitReact";
    for (let suffix = 1; names.has(reactFactory); suffix++)
      reactFactory = `__pageKitReact${suffix}`;
  }
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxRuntime: "classic",
    ...(reactFactory && {
      jsxPragma: `${reactFactory}.createElement`,
      jsxFragmentPragma: `${reactFactory}.Fragment`,
    }),
    production: true,
    filePath: "page.jsx",
  });
  // Capture the viewer's React outside the author's lexical scope. Explicit React reads
  // and imports keep their original meaning; only the compiler's factory uses this alias.
  return reactFactory ? `((${reactFactory})=>{${code}\n})(React);` : code;
}

const SOURCES_PRAGMA = /^\uFEFF?\s*\/\*(?!\*)[ \t]*page-sources[ \t]*\r?\n([\s\S]*?)\*\//;

export function hasPageSourceDeclaration(source: string): boolean {
  return SOURCES_PRAGMA.test(source);
}

/**
 * A page may open with a comment declaring data sources: `/* page-sources` then a JSON object
 * of snapshots keyed by id. useSource reads them back; nothing refreshes them yet.
 */
export function declaredSources(source: string): string {
  const match = SOURCES_PRAGMA.exec(source);
  if (!match) return "";
  const json = match[1]!;
  let declared: unknown;
  try {
    declared = JSON.parse(json);
  } catch {
    throw new Error("The page-sources comment at the top of the page is not valid JSON.");
  }
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) {
    throw new Error(
      "The page-sources comment at the top of the page must contain a JSON object keyed by source id.",
    );
  }
  // Parse the embedded JSON as data so "__proto__" stays an own key, not a prototype setter.
  return `globalThis.__rakazoPageSources=globalThis.JSON.parse(${JSON.stringify(json.trim())});`;
}

/**
 * The page as the viewer runs it, compiled here so the viewer ships without the compiler. Its
 * sources are declared on the first line, so error line numbers still match the source, and a
 * page that cannot compile becomes code that throws, which the viewer shows as the page's error.
 */
export function pageViewerCode(source: string, compiled?: string): string {
  try {
    return `"use strict";${declaredSources(source)}${compiled ?? compilePageSource(source)}`;
  } catch (error) {
    return `throw new Error(${JSON.stringify(error instanceof Error ? error.message : String(error))});`;
  }
}
