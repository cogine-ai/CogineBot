import type { NativeActionContext, NativeResponse } from "../action.js";
import { NativeActionError } from "../action.js";
import type { CollaborationDefinition, Data } from "../collaboration-action.js";
import {
  array,
  identity,
  incomplete,
  object,
  scopes,
  select,
  text,
} from "../collaboration-action.js";

export function authorize(
  def: CollaborationDefinition,
  context: Pick<NativeActionContext, "principal">,
): void {
  const p = context.principal;
  if (!p.subject || p.context.actorType !== "user")
    throw new NativeActionError("authorization_required", "Select a verified user account.");
  if (
    ["jira", "confluence"].includes(def.id.split(".")[0]!) &&
    (!p.tenant || p.context.cloudId !== p.tenant)
  )
    throw new NativeActionError(
      "authorization_required",
      "The selected Atlassian site is not verified.",
    );
  // Personal Todoist tokens expose no introspection endpoint. Never manufacture OAuth scopes.
  if (p.context.credentialType === "personal_token" && def.id.startsWith("todoist.")) return;
  // Asana documents default as Full permissions. This must survive the provider's
  // actual-grant/config intersection; no granular scope is synthesized from it.
  if (def.id.startsWith("asana.") && p.scopes.includes("default")) return;
  scopes(context, def.authorization.acceptedAnyOfScopes);
}
export function project(value: unknown, fields: readonly string[]): Data {
  return select(identity(value), fields);
}
export function gid(value: unknown, fields: readonly string[]): Data {
  const row = object(value);
  text(row.gid);
  return select(row, fields);
}
export function sameId(row: Data, expected: unknown, key = "id"): Data {
  if (String(row[key]) !== String(expected))
    incomplete("The service returned a different resource.");
  return row;
}
export function nonempty(value: unknown): Data {
  const row = object(value);
  if (!Object.keys(row).length)
    throw new NativeActionError("invalid_input", "Choose at least one field to change.");
  return row;
}
export function cursorResult(
  body: Data,
  input: Data,
  fields: readonly string[],
  source: "todoist" | "asana" | "confluence",
): Data {
  let next: unknown;
  let values: unknown;
  if (source === "todoist") {
    values = body.results;
    next = body.next_cursor;
    if (next !== null && typeof next !== "string")
      incomplete("Todoist omitted its pagination cursor.");
  } else if (source === "asana") {
    values = body.data;
    if (body.next_page === undefined) incomplete("Asana omitted its pagination state.");
    next = body.next_page === null ? null : text(object(body.next_page).offset);
  } else {
    values = body.results;
    const links = object(body._links);
    if (links.next === undefined) next = null;
    else {
      const parsed = new URL(text(links.next), "https://api.atlassian.com");
      next = parsed.searchParams.get("cursor");
      if (!next) incomplete("Confluence returned an unusable pagination cursor.");
    }
  }
  const items = array(values).map((row) =>
    source === "asana" ? gid(row, fields) : project(row, fields),
  );
  return {
    items,
    nextCursor: next,
    hasMore: next !== null && next !== "",
    allPagesRead: !input.cursor && !input.offset && !next,
  };
}
export function gitlabPage(response: NativeResponse, input: Data, fields: readonly string[]): Data {
  const raw = response.headers.get("x-next-page");
  if (raw && !/^[1-9]\d{0,8}$/.test(raw)) incomplete("GitLab returned an invalid next page.");
  const nextPage = raw ? Number(raw) : null;
  return {
    items: array(response.body).map((row) => project(row, fields)),
    nextPage,
    hasMore: nextPage !== null,
    allPagesRead: Number(input.page ?? 1) === 1 && nextPage === null,
  };
}
export function adf(value: unknown): Data {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: String(value) }] }],
  };
}
export const pageQuery = (args: Data) => ({
  page: Number(args.page ?? 1),
  per_page: Number(args.per_page ?? 30),
});
export const cursorQuery = (args: Data) => ({
  limit: Number(args.limit ?? 30),
  ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
});
export const offsetQuery = (args: Data) => ({
  limit: Number(args.limit ?? 30),
  ...(typeof args.offset === "string" ? { offset: args.offset } : {}),
});
