import { transform } from "sucrase";

/** Page JSX to a CommonJS body. The save check compiles once and keeps the viewer code. */
export function compilePageSource(source: string): string {
  return transform(source, {
    transforms: ["jsx", "imports"],
    jsxRuntime: "classic",
    production: true,
    filePath: "page.jsx",
  }).code;
}

const SOURCES_PRAGMA = /^\uFEFF?\s*\/\*(?!\*)[ \t]*page-sources[ \t]*\r?\n([\s\S]*?)\*\//;

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
