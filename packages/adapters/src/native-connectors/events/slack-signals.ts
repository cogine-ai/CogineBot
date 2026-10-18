import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  NativeRoutineEventSpec,
  NativeSlackBotEvent,
  NativeSlackEventSignal,
  NativeSlackLifecycleSignal,
} from "@rakazo/contracts";
import { NativeSlackEventSignalSchema, NativeSlackLifecycleSignalSchema } from "@rakazo/contracts";

export class InvalidNativeSlackSignal extends Error {
  constructor() {
    super("Invalid Slack event signature or envelope.");
    this.name = "InvalidNativeSlackSignal";
  }
}
export interface SlackVerifiedHook {
  id: string;
  configId: string;
  configRevision: number;
  revision: number;
  appId: string;
  teamId: string | null;
  botEvents: readonly NativeSlackBotEvent[];
  verified: boolean;
}
export interface SlackEventPrincipal {
  tokenType: "bot";
  subject: string;
  teamId: string;
  enterpriseId: string | null;
  scopes: readonly string[];
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidNativeSlackSignal();
  return value as Record<string, unknown>;
}
const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9]+$/.test(value) || value.length > 64)
    throw new InvalidNativeSlackSignal();
  return value;
};
export type SlackVerifiedEnvelope =
  | { kind: "challenge"; challenge: string }
  | { kind: "event"; signal: NativeSlackEventSignal }
  | { kind: "lifecycle"; signal: NativeSlackLifecycleSignal }
  | { kind: "ignored" };
/** Verifies bytes before parsing; the deprecated verification-token field is never consulted. */
export function verifySlackEnvelope(
  raw: Uint8Array,
  signature: string | null,
  timestamp: string | null,
  signingSecret: string,
  hook: Pick<SlackVerifiedHook, "appId" | "teamId" | "botEvents">,
  now = new Date(),
): SlackVerifiedEnvelope {
  if (
    !raw.length ||
    raw.length > 1_000_000 ||
    !signature ||
    !/^v0=[a-f0-9]{64}$/.test(signature) ||
    !timestamp ||
    !/^[0-9]{1,12}$/.test(timestamp) ||
    Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp)) > 300
  )
    throw new InvalidNativeSlackSignal();
  const expected = createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:`)
      .update(raw)
      .digest(),
    supplied = Buffer.from(signature.slice(3), "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new InvalidNativeSlackSignal();
  let envelope: Record<string, unknown>;
  try {
    envelope = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
  } catch {
    throw new InvalidNativeSlackSignal();
  }
  if (envelope.api_app_id !== undefined && envelope.api_app_id !== hook.appId)
    throw new InvalidNativeSlackSignal();
  if (envelope.type === "url_verification") {
    if (
      typeof envelope.challenge !== "string" ||
      !envelope.challenge ||
      envelope.challenge.length > 4096
    )
      throw new InvalidNativeSlackSignal();
    return { kind: "challenge", challenge: envelope.challenge };
  }
  if (envelope.type !== "event_callback") return { kind: "ignored" };
  if (envelope.api_app_id !== hook.appId) throw new InvalidNativeSlackSignal();
  const teamId = id(envelope.team_id);
  if (hook.teamId && teamId !== hook.teamId) throw new InvalidNativeSlackSignal();
  const event = record(envelope.event);
  if (event.type === "tokens_revoked" || event.type === "app_uninstalled") {
    if (!hook.botEvents.includes(event.type)) return { kind: "ignored" };
    const tokens = event.type === "tokens_revoked" ? record(event.tokens) : {};
    const parsed = NativeSlackLifecycleSignalSchema.safeParse({
      eventId: envelope.event_id,
      appId: envelope.api_app_id,
      teamId,
      enterpriseId:
        envelope.context_enterprise_id == null && envelope.enterprise_id == null
          ? null
          : id(envelope.context_enterprise_id ?? envelope.enterprise_id),
      eventTime: envelope.event_time,
      type: event.type,
      botUserIds: tokens.bot ?? [],
      oauthUserIds: tokens.oauth ?? [],
    });
    if (!parsed.success) throw new InvalidNativeSlackSignal();
    return { kind: "lifecycle", signal: parsed.data };
  }
  if (!["app_mention", "message"].includes(String(event.type))) return { kind: "ignored" };
  // User-authored file shares are new messages. Edits, deletes, bots and system subtypes are not.
  if (
    event.bot_id ||
    event.app_id ||
    (event.subtype !== undefined && event.subtype !== "file_share")
  )
    return { kind: "ignored" };
  const channelType = event.channel_type;
  const subscription =
    event.type === "app_mention"
      ? "app_mention"
      : channelType === "im"
        ? "message.im"
        : channelType === "channel"
          ? "message.channels"
          : channelType === "group"
            ? "message.groups"
            : undefined;
  if (!subscription || !hook.botEvents.includes(subscription)) return { kind: "ignored" };
  if (!Array.isArray(envelope.authorizations) || envelope.authorizations.length > 100)
    throw new InvalidNativeSlackSignal();
  const authorizations = envelope.authorizations.map((value) => {
    const entry = record(value);
    if (
      typeof entry.is_bot !== "boolean" ||
      (entry.is_enterprise_install !== undefined &&
        typeof entry.is_enterprise_install !== "boolean")
    )
      throw new InvalidNativeSlackSignal();
    return {
      userId: id(entry.user_id),
      teamId: entry.team_id == null ? null : id(entry.team_id),
      enterpriseId: entry.enterprise_id == null ? null : id(entry.enterprise_id),
      isBot: entry.is_bot,
      isEnterpriseInstall: entry.is_enterprise_install === true,
    };
  });
  const parsed = NativeSlackEventSignalSchema.safeParse({
    eventId: envelope.event_id,
    appId: envelope.api_app_id,
    teamId,
    enterpriseId:
      envelope.context_enterprise_id == null && envelope.enterprise_id == null
        ? null
        : id(envelope.context_enterprise_id ?? envelope.enterprise_id),
    eventTime: envelope.event_time,
    type: event.type,
    channelId: event.channel,
    ...(channelType !== undefined ? { channelType } : {}),
    messageTs: event.ts,
    ...(event.thread_ts !== undefined ? { threadTs: event.thread_ts } : {}),
    userId: event.user,
    authorizations,
  });
  if (!parsed.success) throw new InvalidNativeSlackSignal();
  return { kind: "event", signal: parsed.data };
}
export function slackSignalCandidate(
  spec: NativeRoutineEventSpec,
  signal: NativeSlackEventSignal,
): boolean {
  if (!("channelId" in spec) || spec.channelId !== signal.channelId) return false;
  if (spec.kind === "slack.app_mention") return signal.type === "app_mention";
  if (spec.kind === "slack.app_dm") return signal.type === "message" && signal.channelType === "im";
  return (
    spec.kind === "slack.channel_message" &&
    signal.type === "message" &&
    ["channel", "group"].includes(String(signal.channelType)) &&
    (!spec.threadTs || (signal.threadTs ?? signal.messageTs) === spec.threadTs)
  );
}
/** A truncated authorization list cannot confer access to any unlisted bot/installation. */
export function slackSignalAccessible(
  signal: NativeSlackEventSignal,
  principal: SlackEventPrincipal,
): boolean {
  if (
    principal.tokenType !== "bot" ||
    signal.teamId !== principal.teamId ||
    signal.userId === principal.subject ||
    (signal.enterpriseId !== null && signal.enterpriseId !== principal.enterpriseId)
  )
    return false;
  return signal.authorizations.some(
    (entry) =>
      entry.isBot &&
      !entry.isEnterpriseInstall &&
      entry.userId === principal.subject &&
      entry.teamId === principal.teamId &&
      entry.enterpriseId === principal.enterpriseId,
  );
}
