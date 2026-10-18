import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import type { NativeAction, NativeActionContext, NativeRequest } from "../action.js";
import { NativeActionError } from "../action.js";
import type { CollaborationDefinition, Data } from "../collaboration-action.js";
import {
  array,
  type CollaborationRun,
  collaborationActions,
  identity,
  incomplete,
  invalid,
  object,
  scopes,
  segment,
  text,
} from "../collaboration-action.js";
import { MICROSOFT_CONSUMER_TENANT } from "./metadata.js";

export interface GraphDefinition extends CollaborationDefinition {
  authorization: CollaborationDefinition["authorization"] & { businessAccountOnly?: boolean };
  upstream: { method: string; path: string };
}
export type { Data };
export { array, identity, incomplete, invalid, object, segment, text };
export const graphSegment = segment;
export const odataString = (value: unknown): string =>
  segment(`'${String(value).replaceAll("'", "''")}'`);
export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !["@microsoft.graph.downloadUrl", "@odata.nextLink", "@odata.deltaLink"].includes(key),
        )
        .map(([key, child]) => [key, sanitize(child)]),
    );
  return value;
}
export function resource(value: unknown, expected?: unknown): Data {
  const row = identity(value);
  if (expected !== undefined && row.id !== expected)
    return incomplete("Microsoft returned another resource identity.");
  return sanitize(row) as Data;
}
export function graphActions(
  definitions: readonly GraphDefinition[],
  execute: (args: Data, run: CollaborationRun) => Promise<Data>,
): NativeAction[] {
  return collaborationActions(definitions, execute, (definition, { principal }) => {
    const def = definition as GraphDefinition,
      ctx = principal.context;
    if (
      ctx.actorType !== "user" ||
      ctx.credentialType !== "oauth" ||
      typeof ctx.tenantId !== "string" ||
      ctx.tenantId !== principal.tenant ||
      (def.authorization.businessAccountOnly && principal.tenant === MICROSOFT_CONSUMER_TENANT)
    )
      throw new NativeActionError(
        "authorization_required",
        "Select an eligible verified Microsoft user and tenant.",
      );
    scopes({ principal }, def.authorization.acceptedAnyOfScopes);
  }).map((action) => ({
    ...action,
    execute(args, context) {
      return action.execute(args, {
        ...context,
        async request(request) {
          const response = await context.request({
            ...request,
            ...(action.id.startsWith("outlook.") || action.id.startsWith("outlook_calendar.")
              ? { headers: { Prefer: 'IdType="ImmutableId"', ...request.headers } }
              : {}),
          });
          if ([409, 412].includes(response.status))
            throw new NativeActionError(
              "version_conflict",
              "The Microsoft resource changed; read it again before editing.",
            );
          if (response.status === 408)
            throw new NativeActionError(
              action.readOnly ? "temporarily_unavailable" : "result_unknown",
              "Microsoft did not confirm the request.",
              { uncertain: !action.readOnly },
            );
          return response;
        },
      });
    },
  }));
}
const pagingKeys = new Set([
  "$skiptoken",
  "$skipToken",
  "$skip",
  "$top",
  "$select",
  "$expand",
  "$filter",
  "$orderby",
  "$search",
  "startDateTime",
  "endDateTime",
  "token",
]);
export function graphLink(value: unknown, path: string): NativeRequest {
  let url: URL;
  try {
    url = new URL(text(value));
  } catch {
    return invalid("Invalid Microsoft collection cursor.");
  }
  if (
    url.origin !== "https://graph.microsoft.com" ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== `/v1.0${path}` ||
    url.search.length > 12000 ||
    [...url.searchParams.keys()].some((key) => !pagingKeys.has(key))
  )
    return invalid("The Microsoft cursor belongs to another collection or authority.");
  return { method: "GET", path, query: Object.fromEntries(url.searchParams) };
}
export function pageRequest(
  path: string,
  args: Data,
  query: NonNullable<NativeRequest["query"]> = {},
): NativeRequest {
  if (args.cursor !== undefined) {
    let url: string;
    try {
      url = Buffer.from(String(args.cursor), "base64url").toString("utf8");
    } catch {
      return invalid("Invalid Microsoft cursor.");
    }
    return graphLink(url, path);
  }
  return {
    method: "GET",
    path,
    query: { $top: typeof args.top === "number" ? args.top : 25, ...query },
  };
}
export function page(value: unknown, path: string, map: (value: unknown) => Data = resource): Data {
  const body = object(value),
    rows = array(body.value).map((value) => map(value));
  const next = body["@odata.nextLink"];
  if (next !== undefined) graphLink(next, path);
  return {
    items: rows,
    nextCursor: next === undefined ? null : Buffer.from(text(next)).toString("base64url"),
  };
}
export const get = async (
  run: CollaborationRun,
  path: string,
  query?: NativeRequest["query"],
): Promise<Data> => object((await run.request({ method: "GET", path, query })).body);
export async function list(
  run: CollaborationRun,
  path: string,
  args: Data,
  query?: NativeRequest["query"],
): Promise<Data> {
  return run.finish(page((await run.request(pageRequest(path, args, query))).body, path));
}
export async function write(
  run: CollaborationRun,
  request: NativeRequest,
  expected?: unknown,
): Promise<Data> {
  const response = await run.request(request, true);
  if (response.status === 204)
    return run.finish(
      { id: expected, deleted: request.method === "DELETE", acknowledged: true },
      { resource_id: expected },
    );
  const output = resource(response.body, expected);
  return run.finish(output, { resource_id: output.id });
}
export const ifMatch = (args: Data): Record<string, string> => {
  const etag = text(args.expectedEtag);
  if (!/^(?:W\/)?"[^"\r\n]+"$/.test(etag))
    return invalid("Use the exact read ETag, without wildcard overwrite.");
  return { "If-Match": etag };
};
export function validName(value: unknown): string {
  const name = text(value);
  if (name === "." || name === ".." || /[/\\:*?"<>|]/.test(name) || /[. ]$/.test(name))
    return invalid("Use one valid file or folder name.");
  return name;
}
export async function artifact(
  context: NativeActionContext,
  artifactId: unknown,
  max = ATTACHMENT_MAX_BYTES,
) {
  const file = await context.readArtifact(text(artifactId));
  if (
    !(file.bytes instanceof Uint8Array) ||
    file.bytes.byteLength > max ||
    file.bytes.byteLength < 1
  )
    return invalid("The local file exceeds this operation's attachment limit.");
  return file;
}
export async function saveFile(
  context: NativeActionContext,
  bytes: Uint8Array,
  name: string,
  mimeType: string,
): Promise<Data> {
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES || !context.writeArtifact)
    throw new NativeActionError(
      "not_configured",
      "Private local artifact storage is required for downloads.",
    );
  return { artifact: await context.writeArtifact({ bytes, name, mimeType }) };
}
export function changes(args: Data, keys: readonly string[]): Data {
  const result = Object.fromEntries(
    keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]),
  );
  if (!Object.keys(result).length) return invalid("Select at least one field to change.");
  return result;
}
export function window(start: unknown, end: unknown): void {
  const first = Date.parse(String(start)),
    last = Date.parse(String(end));
  if (
    !Number.isFinite(first) ||
    !Number.isFinite(last) ||
    first >= last ||
    last - first > 366 * 86400000
  )
    invalid("Use a valid explicit time window of at most one year.");
}
