import type { AdapterContext } from "@rakazo/adapter-kit";
import { connectionAuthorizationRevision } from "../../connector-account-binding.js";
import type { RemoteTransportDependencies } from "../../remote-mcp.js";
import { NativeActionError } from "../action.js";
import { NativeConfigSettingsSchema } from "../config.js";
import { NativeHttpClient } from "../http.js";
import type { NativeOAuthStore } from "../oauth.js";
import type { NativeEventReadApi } from "./readers.js";
import type { NotionEventPrincipal } from "./signals.js";
import type { NativeSourceReadContext } from "./worker.js";

const READ = ["calendar.events.readonly", "calendar.events", "calendar.readonly", "calendar"].map(
  (scope) => `https://www.googleapis.com/auth/${scope}`,
);
function pinnedEventAuthorization(
  oauth: Pick<NativeOAuthStore, "authorization">,
  context: NativeSourceReadContext,
) {
  const row = context.row,
    app = row.kind.startsWith("calendar.") ? "google-calendar" : "notion";
  const actor: AdapterContext = {
    ...context.scope,
    operationId: `native-source:${row.id}:${row.version}`,
    traceId: "native-source",
    signal: context.signal,
  };
  const revalidate = async (force = false) => {
    const live = await oauth.authorization(row.connectionId, actor, force);
    if (
      live.connection.userId !== context.scope.userId ||
      live.connection.spaceId !== context.scope.spaceId ||
      live.connection.connectorId !== "native" ||
      live.connection.provider !== app ||
      connectionAuthorizationRevision(live.connection) !== row.authorizationRevision ||
      live.grant.id !== row.grantId ||
      live.grant.authGeneration !== row.authGeneration ||
      live.config.id !== row.configId ||
      live.config.revision !== row.configRevision
    )
      throw new NativeActionError(
        "authorization_required",
        "The event's exact account authorization changed.",
      );
    const settings = NativeConfigSettingsSchema.parse(live.config.config),
      scopes = live.grant.scopes.filter((scope) => settings.scopes.includes(scope));
    if (
      app === "google-calendar"
        ? !READ.some((scope) => scopes.includes(scope))
        : !settings.capabilities.includes("read_content") ||
          (row.kind === "notion.comment_changed" &&
            !settings.capabilities.includes("read_comments"))
    )
      throw new NativeActionError(
        "insufficient_scope",
        "The exact account lacks this event's read capability.",
      );
    return live;
  };
  return revalidate;
}
/** Reuses native auth/refresh and guarded transport. Token rotation is allowed; a new authorization generation is not. */
export async function withNativeEventReadApi<T>(
  oauth: Pick<NativeOAuthStore, "authorization">,
  context: NativeSourceReadContext,
  read: (api: NativeEventReadApi, principal: NotionEventPrincipal | undefined) => Promise<T>,
  network?: RemoteTransportDependencies,
): Promise<T> {
  const row = context.row,
    app = row.kind.startsWith("calendar.") ? "google-calendar" : "notion";
  const revalidate = pinnedEventAuthorization(oauth, context);
  const bound = await revalidate(),
    identity = bound.auth.identity,
    principalContext = identity.context;
  const principal: NotionEventPrincipal | undefined =
    app === "notion" &&
    typeof identity.tenant === "string" &&
    principalContext.credentialKind === "oauth" &&
    typeof principalContext.botId === "string" &&
    typeof principalContext.ownerUserId === "string"
      ? {
          credentialKind: "oauth",
          workspaceId: identity.tenant,
          botId: principalContext.botId,
          ownerUserId: principalContext.ownerUserId,
        }
      : undefined;
  const http = new NativeHttpClient(
    app === "google-calendar" ? "https://www.googleapis.com/calendar/v3" : "https://api.notion.com",
    async () => ({ kind: "bearer", value: (await revalidate()).auth.tokens.accessToken }),
    {
      network,
      readOnly: true,
      signal: context.signal,
      headers: app === "notion" ? { "Notion-Version": "2026-03-11" } : undefined,
      onUnauthorized: async () => {
        await revalidate(true);
      },
    },
  );
  try {
    const result = await read(
      {
        get: async (path, query) => (await http.request({ method: "GET", path, query })).body,
        // POST is a documented read operation. Only the fixed Data Source query shape is allowed here.
        queryNotionDataSource: async (id, cursor) => {
          if (app !== "notion")
            throw new NativeActionError(
              "invalid_input",
              "This event reader cannot query a Notion data source.",
            );
          return (
            await http.request({
              method: "POST",
              path: `/v1/data_sources/${encodeURIComponent(id)}/query`,
              body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
            })
          ).body;
        },
      },
      principal,
    );
    await revalidate();
    return result;
  } finally {
    await http.close();
  }
}

export interface NativeCalendarChannelApi {
  watch(input: {
    id: string;
    address: string;
    token: string;
    ttlSeconds: number;
  }): Promise<unknown>;
  stop(input: { id: string; resourceId: string }): Promise<void>;
}
/** Server-only channel management; no user data writes, arbitrary endpoints, or retry after ambiguous POST. */
export async function withNativeCalendarChannelApi<T>(
  oauth: Pick<NativeOAuthStore, "authorization">,
  context: NativeSourceReadContext,
  manage: (api: NativeCalendarChannelApi) => Promise<T>,
  network?: RemoteTransportDependencies,
): Promise<T> {
  if (!context.row.kind.startsWith("calendar."))
    throw new NativeActionError(
      "invalid_input",
      "Only a Calendar binding can manage this channel.",
    );
  const calendarId = (context.row.spec as { calendarId: string }).calendarId,
    revalidate = pinnedEventAuthorization(oauth, context);
  await revalidate();
  const http = new NativeHttpClient(
    "https://www.googleapis.com/calendar/v3",
    async () => ({ kind: "bearer", value: (await revalidate()).auth.tokens.accessToken }),
    {
      network,
      readOnly: false,
      signal: context.signal,
      onUnauthorized: async () => {
        await revalidate(true);
      },
    },
  );
  try {
    return await manage({
      watch: async (input) =>
        (
          await http.request({
            method: "POST",
            path: `/calendars/${encodeURIComponent(calendarId)}/events/watch`,
            body: {
              id: input.id,
              type: "web_hook",
              address: input.address,
              token: input.token,
              params: { ttl: String(input.ttlSeconds) },
            },
          })
        ).body,
      stop: async (input) => {
        await http.request({ method: "POST", path: "/channels/stop", body: input });
      },
    });
  } finally {
    await http.close();
  }
}
