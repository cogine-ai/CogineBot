import { createHash } from "node:crypto";
import { NativeActionError } from "../action.js";
import { stable } from "../collaboration-action.js";
import type { Data } from "./common.js";
import {
  array,
  incomplete,
  invalid,
  logicalError,
  named,
  object,
  pick,
  segment,
  text,
} from "./common.js";
export type EnterpriseEventSpec =
  | { kind: "feishu.calendar_event.changed"; calendarId: string }
  | {
      kind: "dingtalk.calendar_event.changed";
      userId: string;
      calendarId: string;
      timeMin: string;
      timeMax: string;
    }
  | { kind: "wecom.schedule.changed"; calendarId: string };
export interface EnterpriseEventObservation {
  eventIdentity: string;
  observedVersion: string;
  occurredAt: string;
  metadata: Data;
}
export interface EnterpriseReadContext {
  spec: EnterpriseEventSpec;
  state?: Data;
  fingerprint: string;
  signal: AbortSignal;
  heartbeat(): Promise<void>;
  emit(observation: EnterpriseEventObservation): Promise<boolean>;
  now?: Date;
}
export interface EnterpriseReadApi {
  get(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<unknown>;
  post?(path: string, body: Data): Promise<unknown>;
}
export interface EnterpriseReadResult {
  state: Data;
  nextPollAt: Date;
}
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const optional = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
const MAX_PAGES = 1000,
  MAX_ITEMS = 50000;
async function beat(ctx: EnterpriseReadContext) {
  ctx.signal.throwIfAborted();
  await ctx.heartbeat();
}
async function collect(
  ctx: EnterpriseReadContext,
  api: EnterpriseReadApi,
): Promise<Map<string, { version: string; metadata: Data; occurredAt?: string }>> {
  const rows = new Map<string, { version: string; metadata: Data; occurredAt?: string }>(),
    seen = new Set<string>();
  let cursor: string | undefined,
    offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    await beat(ctx);
    const spec = ctx.spec;
    if (spec.kind === "feishu.calendar_event.changed") {
      const envelope = object(
        await api.get(`/calendar/v4/calendars/${segment(spec.calendarId)}/events`, {
          // Only anchor mode supports provider pagination; explicit windows are truncated.
          anchor_time: "1",
          page_size: 100,
          page_token: cursor,
        }),
      );
      logicalError("feishu", envelope);
      const body = object(envelope.data);
      for (const raw of array(body.items)) {
        const row = named(raw, "event_id"),
          version = hash(
            pick(row, [
              "summary",
              "description",
              "status",
              "start_time",
              "end_time",
              "recurrence",
              "visibility",
              "free_busy_status",
            ]),
          );
        rows.set(text(row.event_id), {
          version,
          metadata: {
            calendarId: spec.calendarId,
            eventId: row.event_id,
            status: row.status ?? null,
          },
        });
      }
      if (typeof body.has_more !== "boolean")
        return incomplete("Feishu omitted event page completion.");
      if (!body.has_more) return rows;
      cursor = text(body.page_token);
    } else if (spec.kind === "dingtalk.calendar_event.changed") {
      if (
        !Number.isFinite(Date.parse(spec.timeMin)) ||
        !Number.isFinite(Date.parse(spec.timeMax)) ||
        Date.parse(spec.timeMin) >= Date.parse(spec.timeMax)
      )
        return invalid("Use an explicit DingTalk event window.");
      const body = object(
        await api.get(
          `/v1.0/calendar/users/${segment(spec.userId)}/calendars/${segment(spec.calendarId)}/events`,
          { timeMin: spec.timeMin, timeMax: spec.timeMax, maxResults: 100, nextToken: cursor },
        ),
      );
      logicalError("dingtalk", body);
      for (const raw of array(body.events)) {
        const row = named(raw, "id"),
          version = text(row.updateTime);
        rows.set(text(row.id), {
          version,
          metadata: {
            userId: spec.userId,
            calendarId: spec.calendarId,
            eventId: row.id,
            status: row.status ?? null,
          },
          occurredAt: version,
        });
      }
      if (body.nextToken !== undefined && typeof body.nextToken !== "string")
        return incomplete("DingTalk returned an invalid event cursor.");
      cursor = typeof body.nextToken === "string" && body.nextToken ? body.nextToken : undefined;
      if (!cursor) return rows;
    } else {
      if (!api.post)
        throw new NativeActionError(
          "not_configured",
          "The fixed WeCom event POST transport is unavailable.",
        );
      const body = object(
        await api.post("/oa/schedule/get_by_calendar", {
          cal_id: spec.calendarId,
          offset,
          limit: 1000,
        }),
      );
      logicalError("wecom", body);
      const list = array(body.schedule_list);
      for (const raw of list) {
        const row = named(raw, "schedule_id");
        if (row.cal_id !== spec.calendarId)
          return incomplete("WeCom returned another application's calendar.");
        rows.set(text(row.schedule_id), {
          version: hash(
            pick(row, [
              "summary",
              "description",
              "start_time",
              "end_time",
              "reminders",
              "status",
              "attendees",
              "admins",
            ]),
          ),
          metadata: {
            calendarId: spec.calendarId,
            scheduleId: row.schedule_id,
            status: row.status ?? null,
          },
        });
      }
      // Official offset listing ends on an EMPTY page, not an assumed short-page invariant.
      if (!list.length) return rows;
      offset += list.length;
    }
    if (rows.size > MAX_ITEMS)
      return incomplete("The selected enterprise calendar exceeds the bounded source scan.");
    if (cursor) {
      if (seen.has(cursor))
        return incomplete("The enterprise service repeated a pagination cursor.");
      seen.add(cursor);
    }
  }
  return incomplete("The enterprise calendar scan did not finish; no event cursor was advanced.");
}
/** Narrow source reader for the existing Routine worker. No subscriptions, extra consumer, history replay or deletion inference. */
export async function readEnterpriseEvent(
  ctx: EnterpriseReadContext,
  api: EnterpriseReadApi,
): Promise<EnterpriseReadResult> {
  if (!ctx.fingerprint)
    return invalid("Bind the exact account/source generation before reading enterprise events.");
  const binding = hash({ spec: ctx.spec, generation: ctx.fingerprint }),
    old = optional(ctx.state?.enterprise),
    saved = old.version === 1 && old.fingerprint === binding && old.ready === true ? old : {},
    previous = optional(saved.resources),
    next: Data = { ...previous },
    rows = await collect(ctx, api),
    now = ctx.now ?? new Date();
  if (rows.size > MAX_ITEMS)
    return incomplete("The selected enterprise calendar exceeds the bounded source scan.");
  for (const [id, row] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    const prior = optional(previous[id]),
      changed = prior.hash !== row.version;
    const sequence =
      (Number.isSafeInteger(prior.sequence) ? Number(prior.sequence) : 0) +
      (saved.ready === true && changed ? 1 : 0);
    if (!Number.isSafeInteger(sequence))
      return incomplete("The source observation sequence exceeded its bound.");
    if (saved.ready === true && changed) {
      await beat(ctx);
      const observedVersion = `${sequence}:${row.version}`,
        occurredAt =
          row.occurredAt && Number.isFinite(Date.parse(row.occurredAt))
            ? new Date(row.occurredAt).toISOString()
            : now.toISOString();
      if (
        !(await ctx.emit({
          eventIdentity: hash({ kind: ctx.spec.kind, id, observedVersion }),
          observedVersion,
          occurredAt,
          metadata: row.metadata,
        }))
      )
        throw new NativeActionError(
          "temporarily_unavailable",
          "The durable source receipt was not accepted; keep the previous state.",
        );
    }
    next[id] = { hash: row.version, sequence };
  }
  if (Object.keys(next).length > MAX_ITEMS)
    return incomplete("The source version cache exceeds its bound; keep the previous state.");
  return {
    state: {
      ...ctx.state,
      enterprise: { version: 1, ready: true, fingerprint: binding, resources: next },
    },
    nextPollAt: new Date(now.getTime() + 60000),
  };
}
