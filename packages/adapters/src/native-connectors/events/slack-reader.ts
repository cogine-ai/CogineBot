import type {
  NativeEventObservation,
  NativeRoutineEventSpec,
  NativeSlackEventSignal,
} from "@rakazo/contracts";
import { NativeActionError } from "../action.js";
import type { NativeEventReadApi } from "./readers.js";
import type { SlackEventPrincipal, SlackVerifiedHook } from "./slack-signals.js";
import { slackSignalAccessible, slackSignalCandidate } from "./slack-signals.js";
import type { NativeSourceReadContext, NativeSourceReadResult } from "./worker.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new NativeActionError(
      "incomplete_response",
      "Slack returned no current channel identity.",
    );
  return value as Record<string, unknown>;
}
/** Reads current membership only; never scans old messages or treats a poll as an Events delivery. */
export async function readSlackWebhook(
  context: NativeSourceReadContext,
  api: NativeEventReadApi,
  event: NativeSlackEventSignal,
  principal: SlackEventPrincipal,
  hook: SlackVerifiedHook,
): Promise<NativeSourceReadResult> {
  const row = context.row,
    spec = row.spec as NativeRoutineEventSpec;
  const original =
    row.state && typeof row.state === "object" && !Array.isArray(row.state)
      ? (row.state as Record<string, unknown>)
      : {};
  const result = () => ({ state: original, nextPollAt: new Date(Date.now() + 24 * 60 * 60_000) });
  if (
    row.configId !== hook.configId ||
    row.configRevision !== hook.configRevision ||
    !hook.verified ||
    hook.appId !== event.appId ||
    (hook.teamId !== null && hook.teamId !== event.teamId) ||
    !slackSignalCandidate(spec, event) ||
    !slackSignalAccessible(event, principal)
  )
    return result();
  const scopes = principal.scopes;
  if (spec.kind === "slack.app_mention" && !scopes.includes("app_mentions:read"))
    throw new NativeActionError(
      "insufficient_scope",
      "The bot has not granted app mention events.",
    );
  const data = object(await api.get("/conversations.info", { channel: event.channelId }));
  if (data.ok !== true)
    throw new NativeActionError(
      data.error === "missing_scope" ? "insufficient_scope" : "resource_unavailable",
      "Slack could not verify the bot's current channel access.",
    );
  const channel = object(data.channel);
  if (channel.id !== event.channelId || channel.is_archived === true)
    throw new NativeActionError("resource_unavailable", "The selected channel is unavailable.");
  if (spec.kind === "slack.app_dm") {
    // A successful bot-token DM info read is scoped to that bot's direct conversation.
    if (channel.is_im !== true || !scopes.includes("im:read") || !scopes.includes("im:history"))
      throw new NativeActionError(
        "insufficient_scope",
        "The selected bot cannot read this app DM.",
      );
  } else {
    const privateChannel = channel.is_private === true;
    if (
      spec.kind === "slack.channel_message" &&
      event.channelType !== (privateChannel ? "group" : "channel")
    )
      throw new NativeActionError(
        "incomplete_response",
        "Slack event and current channel type disagree.",
      );
    if (
      channel.is_im === true ||
      channel.is_mpim === true ||
      channel.is_member !== true ||
      !scopes.includes(privateChannel ? "groups:read" : "channels:read")
    )
      throw new NativeActionError(
        "insufficient_scope",
        "The selected bot must be a current member of this channel.",
      );
    if (
      spec.kind === "slack.channel_message" &&
      !scopes.includes(privateChannel ? "groups:history" : "channels:history")
    )
      throw new NativeActionError(
        "insufficient_scope",
        "The bot has not granted message events for this channel type.",
      );
  }
  await context.heartbeat();
  const instant = new Date(Number(event.messageTs) * 1000);
  if (!Number.isFinite(instant.getTime()))
    throw new NativeActionError(
      "incomplete_response",
      "Slack returned an invalid message timestamp.",
    );
  if (instant < row.armedAt) return result();
  const observation: NativeEventObservation = {
    triggerId: row.id,
    triggerVersion: row.version,
    connectionId: row.connectionId,
    authorizationRevision: row.authorizationRevision,
    kind: spec.kind,
    resource: { type: "slack_channel", id: event.channelId },
    eventIdentity: `slack:${event.appId}:${event.teamId}:${event.eventId}`,
    observedVersion: `${event.eventId}:${event.channelId}:${event.messageTs}`,
    occurredAt: instant.toISOString(),
    evidence: "slack_events",
    slackEventId: event.eventId,
    channelId: event.channelId,
    messageTs: event.messageTs,
    ...(event.threadTs ? { threadTs: event.threadTs } : {}),
  };
  await context.emit(observation);
  return {
    state: { ...original, lastSlackEventId: event.eventId },
    nextPollAt: result().nextPollAt,
  };
}
