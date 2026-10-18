import { createHash } from "node:crypto";
import type { NativeActionContext } from "../action.js";
import { NativeActionError } from "../action.js";
import type { Data } from "../collaboration-action.js";
import { array, incomplete, object, select, stable, text } from "../collaboration-action.js";
import type { BotRequest } from "./permissions.js";
import {
  boundTarget,
  discordBot,
  discordTarget,
  id,
  PERMISSIONS,
  requireDiscord,
  telegramBot,
  telegramTarget,
} from "./permissions.js";

export interface BotPollObservation {
  eventIdentity: string;
  observedVersion: string;
  occurredAt: string;
  messageId: string | null;
  chatId?: string;
  channelId?: string;
}
export interface BotPollResult {
  state: Data;
  observations: BotPollObservation[];
  nextPollAt: Date;
}
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const currentState = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
const fingerprint = (principal: NativeActionContext["principal"], target: string) =>
  hash({
    bot: principal.subject,
    guild: principal.tenant,
    space: principal.context.boundSpaceId,
    configRevision: principal.context.configRevision,
    target,
  });
const schedule = (now: Date) => new Date(now.getTime() + 60000);
function access(principal: NativeActionContext["principal"]): void {
  if (!principal.capabilities.includes("read"))
    throw new NativeActionError(
      "insufficient_scope",
      "Reading events is not enabled for this bot connection.",
    );
}

/** Existing Routine state is the cursor; no getUpdates, second webhook or message-consumer is created. */
export async function pollTelegramPinned(
  request: BotRequest,
  principal: NativeActionContext["principal"],
  chatId: string,
  state: unknown = {},
  now = new Date(),
): Promise<BotPollResult> {
  access(principal);
  boundTarget(principal, chatId, "telegram-bot");
  const bot = await telegramBot(request);
  if (id(bot.id) !== principal.subject)
    throw new NativeActionError("authorization_expired", "The bot identity changed.");
  const proof = await telegramTarget(request, principal.subject, chatId),
    pinned = proof.chat.pinned_message === undefined ? null : object(proof.chat.pinned_message),
    previous = currentState(state),
    binding = fingerprint(principal, chatId);
  if (
    pinned &&
    (id(object(pinned.chat).id) !== chatId ||
      typeof pinned.message_id !== "number" ||
      !Number.isSafeInteger(pinned.message_id) ||
      pinned.message_id < 1)
  )
    return incomplete("Telegram omitted the pinned message identity.");
  const snapshot = pinned
      ? {
          ...select(pinned, ["message_id", "date", "edit_date", "text", "caption"]),
          ...(pinned.document
            ? {
                document: select(object(pinned.document), [
                  "file_unique_id",
                  "file_name",
                  "file_size",
                ]),
              }
            : {}),
        }
      : null,
    digest = hash(snapshot);
  const sequence =
    typeof previous.sequence === "number" &&
    Number.isSafeInteger(previous.sequence) &&
    previous.sequence >= 0
      ? previous.sequence
      : 0;
  const ready = previous.ready === true && previous.binding === binding;
  if (!ready)
    return {
      state: {
        ready: true,
        binding,
        digest,
        sequence: 0,
        messageId: pinned ? String(pinned.message_id) : null,
      },
      observations: [],
      nextPollAt: schedule(now),
    };
  if (previous.digest === digest)
    return { state: previous, observations: [], nextPollAt: schedule(now) };
  if (sequence >= Number.MAX_SAFE_INTEGER)
    return incomplete("The pinned-message cursor must be reset explicitly.");
  const next = sequence + 1,
    version = hash({ binding, sequence: next, digest });
  return {
    state: {
      ready: true,
      binding,
      digest,
      sequence: next,
      messageId: pinned ? String(pinned.message_id) : null,
    },
    observations: [
      {
        eventIdentity: `telegram:pinned:${binding}:${next}:${digest}`,
        observedVersion: version,
        occurredAt: now.toISOString(),
        chatId,
        messageId: pinned ? String(pinned.message_id) : null,
      },
    ],
    nextPollAt: schedule(now),
  };
}

/** Read a bounded complete new-message interval before advancing the saved Routine cursor. */
export async function pollDiscordMessages(
  request: BotRequest,
  principal: NativeActionContext["principal"],
  channelId: string,
  state: unknown = {},
  armedAt = new Date(0),
  now = new Date(),
): Promise<BotPollResult> {
  access(principal);
  boundTarget(principal, channelId, "discord");
  const bot = await discordBot(request);
  if (id(bot.id) !== principal.subject)
    throw new NativeActionError("authorization_expired", "The bot identity changed.");
  const proof = await discordTarget(request, principal.subject, principal.tenant!, channelId);
  requireDiscord(proof, PERMISSIONS.READ_MESSAGE_HISTORY);
  const previous = currentState(state),
    binding = fingerprint(principal, channelId),
    ready = previous.ready === true && previous.binding === binding;
  if (
    ready &&
    (typeof previous.lastMessageId !== "string" || !/^\d{1,21}$/.test(previous.lastMessageId))
  )
    return incomplete("The saved message cursor is invalid.");
  const old =
    ready && typeof previous.lastMessageId === "string" && /^\d{1,21}$/.test(previous.lastMessageId)
      ? previous.lastMessageId
      : "0";
  if (!ready) {
    const first = array(
      (
        await request({
          method: "GET",
          path: `/channels/${channelId}/messages`,
          query: { limit: 1 },
        })
      ).body,
    );
    if (first.length > 1) return incomplete("Discord exceeded the requested baseline page.");
    const latest = first.length ? object(first[0]) : null;
    if (latest && latest.channel_id !== channelId)
      return incomplete("Discord returned another baseline channel.");
    return {
      state: { ready: true, binding, lastMessageId: latest ? id(latest.id) : "0" },
      observations: [],
      nextPollAt: schedule(now),
    };
  }
  const found = new Map<string, Data>();
  let before: string | undefined,
    head = old,
    complete = false;
  for (let page = 0; page < 100; page++) {
    const rows = array(
      (
        await request({
          method: "GET",
          path: `/channels/${channelId}/messages`,
          query: { limit: 100, ...(before ? { before } : {}) },
        })
      ).body,
    ).map(object);
    if (rows.length > 100) return incomplete("Discord exceeded its requested page limit.");
    const ids = rows.map((row) => {
      if (row.channel_id !== channelId)
        return incomplete("Discord returned another message channel.");
      return id(row.id);
    });
    if (
      new Set(ids).size !== ids.length ||
      ids.some(
        (value) => BigInt(value) < 1n || (before !== undefined && BigInt(value) >= BigInt(before)),
      )
    )
      return incomplete("Discord message pagination did not advance.");
    for (const [index, row] of rows.entries()) {
      const messageId = ids[index]!;
      if (BigInt(messageId) > BigInt(head)) head = messageId;
      if (BigInt(messageId) > BigInt(old)) found.set(messageId, row);
    }
    if (!rows.length || rows.length < 100 || ids.some((value) => BigInt(value) <= BigInt(old))) {
      complete = true;
      break;
    }
    before = ids.reduce((smallest, value) => (BigInt(value) < BigInt(smallest) ? value : smallest));
  }
  if (!complete)
    return incomplete("The message interval exceeds this read bound; the cursor was not advanced.");
  const observations: BotPollObservation[] = [];
  for (const [messageId, row] of [...found.entries()].sort(([a], [b]) =>
    BigInt(a) < BigInt(b) ? -1 : 1,
  )) {
    if (id(object(row.author).id) === principal.subject || ![0, 19].includes(Number(row.type)))
      continue;
    const occurredAt = new Date(text(row.timestamp));
    if (!Number.isFinite(occurredAt.getTime()))
      return incomplete("Discord omitted a valid message timestamp.");
    if (occurredAt < armedAt) continue;
    observations.push({
      eventIdentity: `discord:${principal.tenant}:${channelId}:${messageId}`,
      observedVersion: messageId,
      occurredAt: occurredAt.toISOString(),
      channelId,
      messageId,
    });
  }
  return {
    state: { ready: true, binding, lastMessageId: head },
    observations,
    nextPollAt: schedule(now),
  };
}
