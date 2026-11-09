import type {
  AdapterContext,
  WebFetchProvider,
  WebFetchRequest,
  WebSearchProvider,
} from "@rakazo/adapter-kit";
import { clampMaxChars, clampMaxResults, clampOffset } from "./web-limits.js";

export async function webSearchFromTool(
  search: WebSearchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query is required" };
  try {
    const results = await search.search(
      {
        query,
        maxResults: clampMaxResults(args.maxResults),
        signal: context.signal,
      },
      context,
    );
    return { results };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function webFetchFromTool(
  fetchProvider: WebFetchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
  assertRedirectAllowed: NonNullable<WebFetchRequest["assertRedirectAllowed"]>,
  beforeRequest?: WebFetchRequest["beforeRequest"],
) {
  const url = String(args.url ?? "").trim();
  if (!url) return { error: "url is required" };
  try {
    const offset = clampOffset(args.offset);
    if (offset && !fetchProvider.describe().capabilities.pagination)
      return { error: "This web provider does not support page offsets." };
    const result = await fetchProvider.fetch(
      {
        url,
        maxChars: clampMaxChars(args.maxChars),
        ...(offset ? { offset } : {}),
        signal: context.signal,
        assertRedirectAllowed,
        ...(beforeRequest ? { beforeRequest } : {}),
      },
      context,
    );
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
