import type { NativeRoutineEventSpec } from "@rakazo/contracts";
import type { RemoteTransportDependencies } from "../../remote-mcp.js";
import type { NativeActionContext, NativeRequest, NativeResponse } from "../action.js";
import { NativeActionError } from "../action.js";
import { NativeConfigSettingsSchema } from "../config.js";
import { type NativeCredential, NativeHttpClient } from "../http.js";
import { MICROSOFT_CONSUMER_TENANT } from "../microsoft/metadata.js";
import type { NativeOAuthStore } from "../oauth.js";
import { nativeServiceBase } from "../service-bases.js";

type Bound = Awaited<ReturnType<NativeOAuthStore["authorization"]>>;
export type RemainingEventSpec = Extract<
  NativeRoutineEventSpec,
  {
    kind:
      | "sharepoint.list_item.changed"
      | "excel.range.changed"
      | "planner.task.changed"
      | "teams.channel_message.created"
      | "feishu.calendar_event.changed"
      | "dingtalk.calendar_event.changed"
      | "wecom.schedule.changed"
      | "telegram.pinned_message.changed"
      | "discord.channel_message.created"
      | "discord.command.invoked";
  }
>;
export function isRemainingEventSpec(spec: NativeRoutineEventSpec): spec is RemainingEventSpec {
  return [
    "sharepoint.",
    "excel.",
    "planner.",
    "teams.",
    "feishu.",
    "dingtalk.",
    "wecom.",
    "telegram.",
    "discord.",
  ].some((prefix) => spec.kind.startsWith(prefix));
}
export interface RemainingReadApi {
  request(input: NativeRequest): Promise<NativeResponse>;
  get(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<unknown>;
  post(path: string, body: Record<string, unknown>): Promise<unknown>;
}
export function remainingEventPrincipal(bound: Bound): NativeActionContext["principal"] {
  const settings = NativeConfigSettingsSchema.parse(bound.config.config);
  return {
    subject: bound.grant.subject,
    tenant: bound.grant.tenant,
    scopes: bound.grant.scopes.filter((scope) => settings.scopes.includes(scope)),
    capabilities: settings.capabilities,
    knowledgeBaseIds: settings.knowledgeBaseIds,
    context: { ...bound.auth.identity.context, configuredScopes: settings.scopes },
  };
}
/** Only fixed provider read operations; selected account, generation and config are rechecked for every request. */
export async function withRemainingNativeRead<T>(
  bound: Bound,
  revalidate: (force?: boolean) => Promise<Bound>,
  signal: AbortSignal,
  read: (api: RemainingReadApi, principal: NativeActionContext["principal"]) => Promise<T>,
  network?: RemoteTransportDependencies,
  rejectCredential?: (expectedTokenVersion: number) => Promise<void>,
): Promise<T> {
  const app = bound.config.appId,
    settings = NativeConfigSettingsSchema.parse(bound.config.config),
    principal = remainingEventPrincipal(bound);
  if (
    ["sharepoint", "excel", "planner", "teams"].includes(app) &&
    (principal.context.actorType !== "user" ||
      principal.context.credentialType !== "oauth" ||
      !principal.tenant ||
      principal.tenant === MICROSOFT_CONSUMER_TENANT ||
      principal.context.tenantId !== principal.tenant)
  )
    throw new NativeActionError(
      "authorization_required",
      "Select an eligible verified Microsoft work account and tenant.",
    );
  let requestTokenVersion = bound.grant.tokenVersion;
  const credential = async (): Promise<NativeCredential> => {
    const live = await revalidate();
    requestTokenVersion = live.grant.tokenVersion;
    const token = live.auth.tokens.accessToken;
    if (app === "dingtalk")
      return { kind: "header", header: "x-acs-dingtalk-access-token", value: token };
    if (app === "wecom") return { kind: "query", parameter: "access_token", value: token };
    if (app === "telegram-bot") return { kind: "telegram_bot", value: token };
    if (app === "discord") return { kind: "raw", value: `Bot ${token}` };
    return { kind: "bearer", value: token };
  };
  const http = new NativeHttpClient(
    nativeServiceBase(app, settings.endpoint, undefined, principal.tenant, settings.region),
    credential,
    {
      network,
      signal,
      readOnly: true,
      enterpriseAuthorization:
        app === "feishu-lark"
          ? "feishu"
          : app === "wecom"
            ? "wecom"
            : app === "dingtalk"
              ? "dingtalk"
              : undefined,
      onRejectedCredential: async () => {
        await rejectCredential?.(requestTokenVersion);
      },
      onUnauthorized: async () => {
        const current = await revalidate();
        if (current.grant.tokenVersion === requestTokenVersion) await revalidate(true);
      },
    },
  );
  const request = async (input: NativeRequest) => {
    if (
      input.service ||
      (input.method !== "GET" &&
        !(
          app === "wecom" &&
          input.method === "POST" &&
          ["/oa/calendar/get", "/oa/schedule/get_by_calendar"].includes(input.path)
        ))
    )
      throw new NativeActionError(
        "invalid_input",
        "This event transport only supports fixed read operations.",
      );
    return http.request(input);
  };
  try {
    const result = await read(
      {
        request,
        get: async (path, query) => (await request({ method: "GET", path, query })).body,
        post: async (path, body) => (await request({ method: "POST", path, body })).body,
      },
      principal,
    );
    await revalidate();
    return result;
  } finally {
    await http.close();
  }
}
