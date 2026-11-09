import { textBoundary, truncatePlainText } from "@rakazo/core";

export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
export const MAX_WEB_SEARCH_RESULTS = 10;
export const DEFAULT_WEB_FETCH_MAX_CHARS = 8_000;
export const MAX_WEB_FETCH_MAX_CHARS = 50_000;
export const MIN_WEB_FETCH_MAX_CHARS = 100;
export const MAX_WEB_FETCH_OFFSET = 5 * 1024 * 1024;

export function clampMaxResults(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WEB_SEARCH_MAX_RESULTS;
  return Math.min(MAX_WEB_SEARCH_RESULTS, Math.max(1, Math.floor(n)));
}

export function clampMaxChars(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WEB_FETCH_MAX_CHARS;
  return Math.min(MAX_WEB_FETCH_MAX_CHARS, Math.max(MIN_WEB_FETCH_MAX_CHARS, Math.floor(n)));
}

export function clampOffset(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (n > MAX_WEB_FETCH_OFFSET) {
    throw new Error(`web_fetch can skip at most ${MAX_WEB_FETCH_OFFSET} characters.`);
  }
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Bound a body that already starts at offset. Providers can set a lower continuation limit. */
export function pageWindow(
  rest: string,
  maxChars: number,
  offset: number,
  maxOffset = MAX_WEB_FETCH_OFFSET,
): { text: string; truncated: boolean; offset: number; nextOffset?: number; maxOffset?: number } {
  const text = truncatePlainText(rest, maxChars);
  const truncated = text.length < rest.length;
  const next = offset + text.length;
  const limit = Math.min(maxOffset, MAX_WEB_FETCH_OFFSET);
  return {
    text,
    truncated,
    offset,
    ...(truncated && next > offset && next <= limit ? { nextOffset: next } : {}),
    ...(limit < MAX_WEB_FETCH_OFFSET ? { maxOffset: limit } : {}),
  };
}

export function readWebPage(text: string, maxChars: number, offset: number) {
  if (textBoundary(text, offset) !== offset) {
    throw new Error("Use an offset at a character boundary or the returned nextOffset.");
  }
  return pageWindow(text.slice(offset), maxChars, offset);
}
