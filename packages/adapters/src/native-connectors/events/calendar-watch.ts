import { randomBytes, randomUUID } from "node:crypto";
import { NativeActionError } from "../action.js";
import { nativeEventWebhookOrigin } from "./notion-hooks.js";
import type { CalendarEventChannel } from "./signals.js";
import { calendarChannelTokenHash } from "./signals.js";
import type { NativeCalendarChannelApi } from "./transport.js";
import type { NativeSourceReadContext } from "./worker.js";

interface StoredChannel extends CalendarEventChannel {
  requestedAt: number;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const RENEW_BEFORE_MS = 300000,
  TTL_SECONDS = 604800;
/** Persist pending identity BEFORE the POST; rotate with overlap and pull immediately after a confirmed response. */
export async function ensureCalendarChannel(
  context: NativeSourceReadContext,
  api: NativeCalendarChannelApi,
  apiUrl: string,
  persist: (state: Record<string, unknown>) => Promise<void>,
  now = Date.now(),
): Promise<void> {
  const origin = nativeEventWebhookOrigin(apiUrl),
    state = object(context.row.state);
  if (!origin) {
    context.row.state = { ...state, delivery: "polling_only_no_public_https" };
    return;
  }
  const raw = Array.isArray(state.calendarChannels) ? state.calendarChannels : [];
  const channels = (raw as StoredChannel[]).filter(
    (channel) =>
      channel &&
      typeof channel.id === "string" &&
      channel.expiration !== null &&
      channel.expiration > now,
  );
  const active = channels.find(
    (channel) => channel.phase === "active" && channel.expiration! > now + RENEW_BEFORE_MS,
  );
  if (active) return;
  // An ambiguous POST does not reuse a channel ID. Avoid hot-looping registration while still compensating by reads.
  if (typeof state.watchRetryAt === "number" && state.watchRetryAt > now) return;
  const token = randomBytes(32).toString("base64url"),
    pending: StoredChannel = {
      id: randomUUID(),
      tokenHash: calendarChannelTokenHash(token),
      phase: "pending",
      resourceId: null,
      resourceUri: null,
      expiration: now + TTL_SECONDS * 1000,
      requestedAt: now,
    };
  const pendingState = {
    ...state,
    calendarChannels: [...channels.filter((channel) => channel.phase !== "pending"), pending],
    watchRetryAt: now + RENEW_BEFORE_MS,
  };
  await persist(pendingState);
  context.row.state = pendingState;
  let response: Record<string, unknown>;
  try {
    response = object(
      await api.watch({
        id: pending.id,
        address: `${origin}/api/connectors/events/calendar`,
        token,
        ttlSeconds: TTL_SECONDS,
      }),
    );
  } catch (error) {
    // Old active channel stays usable; pending channel never activates on its own. Keep read compensation running.
    const failed = { ...pendingState, delivery: "polling_watch_unconfirmed" };
    await persist(failed);
    context.row.state = failed;
    if (
      error instanceof NativeActionError &&
      ["authorization_required", "authorization_expired", "insufficient_scope"].includes(error.kind)
    )
      throw error;
    return;
  }
  const expiration =
    typeof response.expiration === "string" || typeof response.expiration === "number"
      ? Number(response.expiration)
      : NaN;
  if (
    response.kind !== "api#channel" ||
    response.id !== pending.id ||
    typeof response.resourceId !== "string" ||
    !response.resourceId ||
    typeof response.resourceUri !== "string" ||
    !response.resourceUri ||
    !Number.isSafeInteger(expiration) ||
    expiration <= now
  ) {
    if (typeof response.resourceId === "string" && response.id === pending.id)
      await api.stop({ id: pending.id, resourceId: response.resourceId }).catch(() => undefined);
    const incomplete = { ...pendingState, delivery: "polling_watch_response_incomplete" };
    await persist(incomplete);
    context.row.state = incomplete;
    return;
  }
  const current: StoredChannel = {
    ...pending,
    phase: "active",
    resourceId: response.resourceId,
    resourceUri: response.resourceUri,
    expiration,
  };
  const overlap = {
    ...state,
    calendarChannels: [
      ...channels
        .filter((channel) => channel.phase !== "pending")
        .map((channel) => ({ ...channel, phase: "retiring" as const })),
      current,
    ],
    delivery: "watch_and_poll",
    watchRetryAt: 0,
  };
  await persist(overlap);
  context.row.state = overlap;
  const retained: StoredChannel[] = [current];
  for (const old of channels) {
    if (!old.resourceId) continue;
    try {
      await api.stop({ id: old.id, resourceId: old.resourceId });
    } catch {
      retained.push({ ...old, phase: "retiring" });
    }
  }
  const completed = { ...overlap, calendarChannels: retained };
  await persist(completed);
  context.row.state = completed;
}
