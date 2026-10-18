import type { NativeAction, NativeActionContext, NativeRequest } from "../action.js";
import { NativeActionError } from "../action.js";
import type { CollaborationDefinition, CollaborationRun, Data } from "../collaboration-action.js";
import {
  array,
  collaborationActions,
  incomplete,
  invalid,
  object,
  scopes,
  segment,
  text,
} from "../collaboration-action.js";

export type { CollaborationRun, Data };
export { array, incomplete, invalid, object, segment, text };

interface Definition extends CollaborationDefinition {
  authorization: CollaborationDefinition["authorization"] & { actors: string[] };
}
export function enterpriseActions(
  appId: string,
  definitions: readonly Definition[],
  execute: (args: Data, run: CollaborationRun) => Promise<Data>,
): NativeAction[] {
  return collaborationActions(definitions, execute, (base, { principal }) => {
    const definition = base as Definition,
      c = principal.context;
    if (c.provider !== undefined && c.provider !== appId)
      throw new NativeActionError(
        "authorization_required",
        "The enterprise application identity changed.",
      );
    if (
      !definition.authorization.actors.includes(String(c.actorType)) ||
      typeof c.tenantId !== "string" ||
      c.tenantId !== principal.tenant ||
      typeof c.appId !== "string" ||
      !c.appId ||
      !["oauth", "machine_key"].includes(String(c.credentialType))
    )
      throw new NativeActionError(
        "authorization_required",
        "Select the verified enterprise actor, application and organization.",
      );
    if (appId === "feishu-lark" && !["feishu", "lark"].includes(String(c.region)))
      throw new NativeActionError(
        "authorization_required",
        "Select the exact Feishu or Lark region.",
      );
    if (c.actorType === "user" && appId === "feishu-lark") {
      scopes({ principal }, definition.authorization.acceptedAnyOfScopes);
      if (
        base.id.startsWith("feishu.messages.") &&
        !principal.scopes.some((s) => ["im:message", "im:message.send_as_user"].includes(s))
      )
        throw new NativeActionError(
          "insufficient_scope",
          "Sending as a user requires the user message permission.",
        );
    }
    // App tokens, DingTalk delegated permissions and WeCom ACLs are enforced upstream; do not invent OAuth scopes.
  });
}
export function logicalError(
  family: "feishu" | "wecom" | "dingtalk",
  body: Data,
  run?: CollaborationRun,
): void {
  const code = family === "feishu" ? body.code : family === "wecom" ? body.errcode : body.code;
  const success = code === 0 || code === "0" || (family === "dingtalk" && code === undefined);
  if (success && !body.error) return;
  const numeric = Number(code),
    raw = String(code ?? body.error);
  const expired =
    family === "feishu"
      ? [99991663, 99991664, 99991668, 99991669].includes(numeric)
      : family === "wecom"
        ? [40014, 42001].includes(numeric)
        : ["InvalidAuthentication", "InvalidAccessToken", "InvalidToken"].includes(raw);
  const rate =
    family === "feishu"
      ? numeric === 99991400
      : family === "wecom"
        ? [45009, 45011].includes(numeric)
        : /Throttl|RateLimit|TooManyRequests/.test(raw);
  const transient =
    family === "feishu"
      ? [99991644].includes(numeric)
      : family === "wecom"
        ? numeric === -1
        : /InternalError|ServiceUnavailable|SystemError/.test(raw);
  if (transient && run?.mutated)
    run.unknown("The enterprise service did not confirm the write outcome.");
  throw new NativeActionError(
    family === "feishu" && numeric === 99991401
      ? "not_configured"
      : expired
        ? "authorization_expired"
        : rate
          ? "rate_limited"
          : transient
            ? "temporarily_unavailable"
            : "insufficient_scope",
    "The enterprise service rejected this action or its current resource permissions.",
  );
}
export async function call(
  run: CollaborationRun,
  family: "feishu" | "wecom" | "dingtalk",
  request: NativeRequest,
  write = false,
): Promise<Data> {
  const body = object((await run.request(request, write)).body);
  logicalError(family, body, run);
  return family === "feishu" ? object(body.data) : body;
}
export function named(value: unknown, key: string, expected?: unknown): Data {
  const row = object(value);
  const id = text(row[key]);
  if (expected !== undefined && id !== expected)
    return incomplete("The enterprise service returned another resource.");
  return row;
}
export function pick(args: Data, keys: readonly string[]): Data {
  return Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
}
export function nonempty(args: Data, keys: readonly string[]): Data {
  const result = pick(args, keys);
  if (!Object.keys(result).length) return invalid("Choose at least one field to change.");
  return result;
}
export function epoch(value: unknown): string {
  const v = text(value);
  if (!/^\d{1,13}$/.test(v) || !Number.isSafeInteger(Number(v)))
    return invalid("Use an explicit Unix timestamp.");
  return v;
}
export function interval(start: unknown, end: unknown): void {
  if (Number(epoch(start)) >= Number(epoch(end))) invalid("The event end must follow its start.");
}
export function actor(context: NativeActionContext): Data {
  return context.principal.context;
}
export function page(body: Data, key: string, idKey: string): Data {
  const items = array(body[key]).map((value) => named(value, idKey));
  if (typeof body.has_more !== "boolean")
    return incomplete("The enterprise service omitted page completion metadata.");
  if (body.has_more && (typeof body.page_token !== "string" || !body.page_token))
    return incomplete("The enterprise service omitted its next cursor.");
  return { items, hasMore: body.has_more, nextPageToken: body.has_more ? body.page_token : null };
}
