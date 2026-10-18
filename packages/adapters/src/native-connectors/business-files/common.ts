import type { NativeAction, NativeActionContext } from "../action.js";
import { NativeActionError } from "../action.js";
import type { CollaborationDefinition, CollaborationRun, Data } from "../collaboration-action.js";
import {
  array,
  collaborationActions,
  identity,
  incomplete,
  scopes,
  text,
} from "../collaboration-action.js";

export function authorize(
  app: string,
  def: CollaborationDefinition,
  ctx: Pick<NativeActionContext, "principal">,
): void {
  const c = ctx.principal.context;
  if (
    c.businessFilesApp !== app ||
    !ctx.principal.subject ||
    !["oauth", "personal_token"].includes(String(c.credentialType)) ||
    (c.actorType !== "user" && !(app === "hubspot" && c.actorType === "app"))
  )
    throw new NativeActionError(
      "authorization_required",
      "Select a verified account for this application.",
    );
  if (c.scopeAuthority === "provider_enforced") {
    // Declared scopes are a local policy ceiling, never proof of provider-granted permission.
    const configured = c.configuredScopes;
    if (
      def.authorization.acceptedAnyOfScopes.length &&
      (!Array.isArray(configured) ||
        !def.authorization.acceptedAnyOfScopes.some((scope) => configured.includes(scope)))
    )
      throw new NativeActionError(
        "insufficient_scope",
        "This connection source does not enable this permission.",
      );
  } else scopes(ctx, def.authorization.acceptedAnyOfScopes);
}
export function businessActions(
  definitions: readonly CollaborationDefinition[],
  execute: (args: Data, run: CollaborationRun) => Promise<Data>,
  authorize: (
    definition: CollaborationDefinition,
    context: Pick<NativeActionContext, "principal">,
  ) => void,
): NativeAction[] {
  return collaborationActions(definitions, execute, authorize).map((action) => ({
    ...action,
    execute(args, context) {
      return action.execute(args, {
        ...context,
        async request(request) {
          const response = await context.request(request);
          if (response.status === 409 || response.status === 412) {
            let missing = false;
            if (response.body && typeof response.body === "object") {
              const error = (response.body as Data).error;
              if (error && typeof error === "object") {
                const path = (error as Data).path ?? (error as Data).path_lookup;
                if (path && typeof path === "object") {
                  const reason = (path as Data).reason ?? path;
                  missing = Boolean(
                    reason &&
                      typeof reason === "object" &&
                      (reason as Data)[".tag"] === "not_found",
                  );
                }
              }
            }
            throw new NativeActionError(
              missing ? "resource_unavailable" : "version_conflict",
              missing
                ? "The selected resource is unavailable."
                : "The selected resource conflicts with its current remote version.",
            );
          }
          if (response.status === 429) {
            const retry = response.headers.get("retry-after"),
              reset = response.headers.get("x-ratelimit-reset");
            const seconds = retry
              ? /^\d+(?:\.\d+)?$/.test(retry)
                ? Number(retry)
                : Math.ceil((Date.parse(retry) - Date.now()) / 1000)
              : reset
                ? Math.ceil(Number(reset) - Date.now() / 1000)
                : NaN;
            throw new NativeActionError(
              "rate_limited",
              "The service is rate limited. Try again after its cooldown.",
              {
                ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: seconds } : {}),
              },
            );
          }
          return response;
        },
      });
    },
  }));
}
export function page(rows: unknown, cursor: unknown, firstPage: boolean): Data {
  const items = array(rows).map(identity);
  if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || !cursor))
    return incomplete("The service returned an invalid continuation cursor.");
  return {
    items,
    hasMore: Boolean(cursor),
    nextCursor: cursor ?? null,
    allPagesRead: firstPage && !cursor,
  };
}
export function exact(value: unknown, expected: unknown): Data {
  const row = identity(value);
  if (String(row.id) !== String(expected))
    return incomplete("The service returned another selected resource.");
  return row;
}
export function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || !x))
    return incomplete(`The service omitted ${label}.`);
  return [...new Set(value as string[])];
}
export function resourceName(value: unknown): string {
  return text(value)
    .replace(/[\r\n\0/\\]/g, "_")
    .slice(0, 200);
}
