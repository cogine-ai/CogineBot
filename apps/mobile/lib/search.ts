import type { SearchHit } from "@rakazo/contracts";
import { rpc } from "./api";

export type SearchQueryOptions = NonNullable<Parameters<typeof rpc>[2]>;

export async function querySpaceSearch(
  q: string,
  options: SearchQueryOptions = {},
): Promise<SearchHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const result = await rpc<{ hits: SearchHit[] }>("search/query", { q: trimmed }, options);
  return result.hits;
}
