import type { NativeEventObservation, NativeRoutineEventSpec } from "@rakazo/contracts";
import { nativeEventResource } from "@rakazo/contracts";
import type { NativeActionContext } from "../action.js";
import { NativeActionError } from "../action.js";
import { pollDiscordMessages, pollTelegramPinned } from "../bot-platforms/readers.js";
import { type EnterpriseEventSpec, readEnterpriseEvent } from "../enterprise/readers.js";
import { type MicrosoftEventSpec, readMicrosoftEvent } from "../microsoft/readers.js";
import { verifyRemainingEventResource } from "./remaining-resources.js";
import { isRemainingEventSpec, type RemainingReadApi } from "./remaining-transport.js";
import { nativeGoogleWatchBinding } from "./transport.js";
import type { NativeSourceReadContext, NativeSourceReadResult } from "./worker.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function remainingObservation(
  context: NativeSourceReadContext,
  observation: {
    eventIdentity: string;
    observedVersion: string;
    occurredAt: string;
    metadata?: Record<string, unknown>;
    messageId?: string | null;
    channelId?: string;
    chatId?: string;
  },
): NativeEventObservation {
  const spec = context.row.spec as NativeRoutineEventSpec;
  const evidence = ["sharepoint.", "excel.", "planner.", "teams."].some((prefix) =>
    spec.kind.startsWith(prefix),
  )
    ? "microsoft_read"
    : ["feishu.", "dingtalk.", "wecom."].some((prefix) => spec.kind.startsWith(prefix))
      ? "enterprise_read"
      : "bot_read";
  return {
    triggerId: context.row.id,
    triggerVersion: context.row.version,
    connectionId: context.row.connectionId,
    authorizationRevision: context.row.authorizationRevision,
    kind: spec.kind,
    resource: nativeEventResource(spec),
    eventIdentity: observation.eventIdentity,
    observedVersion: observation.observedVersion,
    occurredAt: observation.occurredAt,
    evidence,
    ...(observation.messageId ? { messageId: observation.messageId } : {}),
    ...(observation.channelId ? { channelId: observation.channelId } : {}),
    sourceMetadata: observation.metadata ?? {
      ...(observation.chatId ? { chatId: observation.chatId } : {}),
      ...(observation.channelId ? { channelId: observation.channelId } : {}),
      messageId: observation.messageId ?? null,
    },
  };
}
/** Preserve the original worker's created/replayed semantics. Leaf acknowledgement means claim AND enqueue completed. */
export async function emitRemainingObservation(
  context: NativeSourceReadContext,
  observation: Parameters<typeof remainingObservation>[1],
): Promise<boolean> {
  await context.emit(remainingObservation(context, observation));
  return true;
}
export async function readRemainingEvent(
  context: NativeSourceReadContext,
  api: RemainingReadApi,
  principal: NativeActionContext["principal"],
): Promise<NativeSourceReadResult> {
  const spec = context.row.spec as NativeRoutineEventSpec;
  if (!isRemainingEventSpec(spec))
    throw new NativeActionError(
      "invalid_input",
      "Choose a supported exact remaining event source.",
    );
  const state = object(context.row.state),
    fingerprint = nativeGoogleWatchBinding(context);
  const common = {
    state,
    fingerprint,
    signal: context.signal,
    heartbeat: context.heartbeat,
    emit: (observation: Parameters<typeof remainingObservation>[1]) =>
      emitRemainingObservation(context, observation),
  };
  if (
    ["sharepoint.", "excel.", "planner.", "teams."].some((prefix) => spec.kind.startsWith(prefix))
  ) {
    const result = await readMicrosoftEvent({ ...common, spec: spec as MicrosoftEventSpec }, api);
    return { ...result, state: { ...result.state, ready: true } };
  }
  if (["feishu.", "dingtalk.", "wecom."].some((prefix) => spec.kind.startsWith(prefix))) {
    const result = await readEnterpriseEvent({ ...common, spec: spec as EnterpriseEventSpec }, api);
    return { ...result, state: { ...result.state, ready: true } };
  }
  if (spec.kind === "discord.command.invoked") {
    await verifyRemainingEventResource(spec, api, principal);
    return {
      state: { ...state, ready: true, commandBinding: fingerprint },
      nextPollAt: new Date(Date.now() + 60000),
    };
  }
  const result =
    spec.kind === "telegram.pinned_message.changed"
      ? await pollTelegramPinned(api.request, principal, spec.chatId, state.bot)
      : spec.kind === "discord.channel_message.created"
        ? await pollDiscordMessages(
            api.request,
            principal,
            spec.channelId,
            state.bot,
            context.row.armedAt,
          )
        : undefined;
  if (!result)
    throw new NativeActionError("invalid_input", "This bot event source is unavailable.");
  for (const observation of result.observations) {
    await context.heartbeat();
    await emitRemainingObservation(context, observation);
  }
  return { state: { ...state, ready: true, bot: result.state }, nextPollAt: result.nextPollAt };
}
