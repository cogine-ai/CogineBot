import { createHash } from "node:crypto";
import type { NativeEventObservation, NativeRoutineEventSpec } from "@rakazo/contracts";
import { nativeEventResource } from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { NativeActionError } from "../action.js";
import type { NotionEventPrincipal, NotionEventSignal } from "./signals.js";
import { notionSignalAccessible, notionSignalCandidate } from "./signals.js";
import { nativeObservationMatches } from "./store.js";
import type { NativeSourceReadContext, NativeSourceReadResult } from "./worker.js";

type Obj = Record<string, unknown>;
/** Supplied only by the fenced NativeOAuthStore/NativeHttpClient composition; never a model URL/body. */
export interface NativeEventReadApi {
  get(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<unknown>;
  queryNotionDataSource(id: string, cursor?: string): Promise<unknown>;
}
const obj = (value: unknown): Obj => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new NativeActionError(
      "incomplete_response",
      "The event resource response was incomplete.",
    );
  return value as Obj;
};
const optional = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
const id = (value: unknown): string => {
  if (typeof value !== "string" || !value || value.length > 2048)
    throw new NativeActionError("incomplete_response", "The event resource identity was missing.");
  return value;
};
const hash = (value: unknown) => createHash("sha256").update(stableJsonValue(value)).digest("hex");
/** Hosted file URLs/expiry are renewable capabilities, not content versions. External URLs remain significant. */
function stableNotionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNotionValue);
  if (!value || typeof value !== "object") return value;
  const current = value as Obj;
  return Object.fromEntries(
    Object.entries(current).map(([key, entry]) => [
      key,
      current.type === "file" && key === "file"
        ? stableNotionValue(
            Object.fromEntries(
              Object.entries(obj(entry)).filter(
                ([field]) => !["url", "expiry_time"].includes(field),
              ),
            ),
          )
        : stableNotionValue(entry),
    ]),
  );
}
const notionHash = (value: unknown) => hash(stableNotionValue(value));
const sameId = (left: unknown, right: string) =>
  typeof left === "string" &&
  left.replaceAll("-", "").toLowerCase() === right.replaceAll("-", "").toLowerCase();
const enc = encodeURIComponent;
const propertySegment = (value: string): string => {
  try {
    return enc(decodeURIComponent(value));
  } catch {
    throw new NativeActionError(
      "incomplete_response",
      "The returned Notion property ID encoding was invalid.",
    );
  }
};
const MAX_PAGES = 1000; // Operational bound: reaching it fails incomplete; never advances cursor or claims complete.
const POLL_MS = 60_000; // Product compensation cadence, not an upstream delivery promise.
const after = (now: Date, ms = POLL_MS) => new Date(now.getTime() + ms);
function observation(
  context: NativeSourceReadContext,
  fields: Pick<NativeEventObservation, "eventIdentity" | "observedVersion" | "occurredAt"> &
    Partial<NativeEventObservation>,
): NativeEventObservation {
  const row = context.row,
    spec = row.spec as NativeRoutineEventSpec;
  return {
    triggerId: row.id,
    triggerVersion: row.version,
    connectionId: row.connectionId,
    authorizationRevision: row.authorizationRevision,
    kind: spec.kind,
    resource: nativeEventResource(spec),
    evidence: "visible_state_change",
    ...fields,
  };
}
function targetMatches(
  spec: Extract<NativeRoutineEventSpec, { calendarId: string }>,
  event: Obj,
): boolean {
  return (
    spec.target.kind === "calendar" ||
    (spec.target.kind === "series" &&
      (event.id === spec.target.eventId || event.recurringEventId === spec.target.eventId)) ||
    (spec.target.kind !== "series" && event.id === spec.target.eventId)
  );
}
function calendarPage(value: unknown): Obj {
  const page = obj(value);
  if (
    page.kind !== "calendar#events" ||
    !Array.isArray(page.items) ||
    (page.nextPageToken !== undefined &&
      (typeof page.nextPageToken !== "string" || !page.nextPageToken))
  )
    throw new NativeActionError("incomplete_response", "Calendar event pagination was incomplete.");
  return page;
}
/** Complete baseline suppresses old events; incremental pages retain the ORIGINAL syncToken until the last page. */
export async function readCalendarChanges(
  context: NativeSourceReadContext,
  api: NativeEventReadApi,
  now = new Date(),
  forceBaseline = false,
): Promise<NativeSourceReadResult> {
  const spec = context.row.spec as Extract<
    NativeRoutineEventSpec,
    { kind: "calendar.event_changed" }
  >;
  const previous = optional(context.row.state),
    previousCursor = optional(previous.calendarChanged);
  const fingerprint = hash({
    calendarId: spec.calendarId,
    singleEvents: false,
    showDeleted: true,
    maxResults: 2500,
  });
  const syncToken =
    !forceBaseline &&
    previous.ready === true &&
    previousCursor.queryFingerprint === fingerprint &&
    typeof previousCursor.syncToken === "string"
      ? previousCursor.syncToken
      : undefined;
  let pageToken: string | undefined;
  const seen = new Set<string>();
  try {
    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
      const page = calendarPage(
        await api.get(`/calendars/${enc(spec.calendarId)}/events`, {
          singleEvents: false,
          showDeleted: true,
          maxResults: 2500,
          syncToken,
          pageToken,
        }),
      );
      for (const raw of page.items as unknown[]) {
        const event = obj(raw),
          eventId = id(event.id);
        if (!syncToken || !targetMatches(spec, event)) continue;
        const version =
          typeof event.etag === "string" && event.etag
            ? event.etag
            : hash({
                id: eventId,
                status: event.status ?? null,
                updated: event.updated ?? null,
                recurringEventId: event.recurringEventId ?? null,
                originalStartTime: event.originalStartTime ?? null,
                start: event.start ?? null,
                end: event.end ?? null,
              });
        // A delta since the committed baseline is observed now; reminder-only edits need not advance provider updated.
        const occurredAt = now.toISOString();
        const observed = observation(context, {
          evidence: "calendar_sync",
          eventIdentity: `calendar:${eventId}:${version}`,
          observedVersion: version,
          occurredAt,
          eventId,
          ...(typeof event.recurringEventId === "string"
            ? { recurringEventId: event.recurringEventId }
            : {}),
          ...(event.originalStartTime
            ? { originalStartTime: stableJsonValue(event.originalStartTime) }
            : {}),
        });
        if (nativeObservationMatches(context.row, observed, now)) await context.emit(observed);
      }
      await context.heartbeat();
      if (page.nextPageToken === undefined) {
        const nextSyncToken = id(page.nextSyncToken);
        return {
          state: {
            ...previous,
            ready: true,
            calendarChanged: { queryFingerprint: fingerprint, syncToken: nextSyncToken },
          },
          nextPollAt: after(now),
        };
      }
      pageToken = String(page.nextPageToken);
      if (seen.has(pageToken))
        throw new NativeActionError(
          "incomplete_response",
          "Calendar repeated a pagination cursor.",
        );
      seen.add(pageToken);
    }
    throw new NativeActionError(
      "incomplete_response",
      "Calendar pagination exceeded the operational bound; the cursor was not advanced.",
    );
  } catch (error) {
    if (syncToken && error instanceof NativeActionError && error.options.recovery?.status === 410)
      return readCalendarChanges(context, api, now, true);
    throw error;
  }
}
/** Convert a normal IANA local midnight exactly. Skipped/nonexistent midnight fails closed, never assumes UTC. */
export function calendarStartInstant(startValue: unknown, calendarTimeZone: unknown): Date {
  const start = obj(startValue);
  if (
    typeof start.dateTime === "string" &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(start.dateTime) &&
    Number.isFinite(Date.parse(start.dateTime))
  )
    return new Date(start.dateTime);
  if (
    typeof start.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(start.date) ||
    typeof calendarTimeZone !== "string"
  )
    throw new NativeActionError(
      "incomplete_response",
      "The all-day event needs its calendar's authoritative IANA time zone.",
    );
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: calendarTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new NativeActionError("incomplete_response", "The calendar time zone is invalid.");
  }
  const utc = Date.parse(`${start.date}T00:00:00Z`);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== start.date)
    throw new NativeActionError("incomplete_response", "The all-day date is invalid.");
  const parts = (instant: number) =>
    Object.fromEntries(
      format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
    );
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const instant = utc + hours * 3600000,
      p = parts(instant);
    offsets.add(
      Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour),
        Number(p.minute),
        Number(p.second),
      ) - instant,
    );
  }
  const candidates = [...offsets]
    .map((offset) => utc - offset)
    .filter((instant) => {
      const p = parts(instant);
      return (
        `${p.year}-${p.month}-${p.day}` === start.date &&
        p.hour === "00" &&
        p.minute === "00" &&
        p.second === "00"
      );
    });
  if (!candidates.length)
    throw new NativeActionError(
      "incomplete_response",
      "This local date has no unambiguous representable midnight; do not guess a reminder instant.",
    );
  return new Date(Math.min(...candidates));
}
/** Separate expanded future-window query: never mixes a time bound with syncToken. Every due instance is reread. */
export async function readCalendarStarting(
  context: NativeSourceReadContext,
  api: NativeEventReadApi,
  now = new Date(),
): Promise<NativeSourceReadResult> {
  const spec = context.row.spec as Extract<
      NativeRoutineEventSpec,
      { kind: "calendar.event_starting" }
    >,
    previous = optional(context.row.state);
  const timeMax = after(now, spec.leadMinutes * 60_000 + POLL_MS).toISOString();
  let pageToken: string | undefined,
    nextPollAt = after(now);
  const seen = new Set<string>();
  for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
    const page = calendarPage(
      await api.get(`/calendars/${enc(spec.calendarId)}/events`, {
        singleEvents: true,
        showDeleted: true,
        maxResults: 2500,
        timeMin: now.toISOString(),
        timeMax,
        pageToken,
      }),
    );
    for (const raw of page.items as unknown[]) {
      const event = obj(raw);
      id(event.id);
      if (event.status === "cancelled" || !targetMatches(spec, event)) continue;
      const start = calendarStartInstant(event.start, page.timeZone),
        dueAt = new Date(start.getTime() - spec.leadMinutes * 60_000);
      if (start <= now) continue;
      if (dueAt > now) {
        if (dueAt < nextPollAt) nextPollAt = dueAt;
        continue;
      }
      if (previous.ready !== true) continue;
      const current = obj(
        await api.get(`/calendars/${enc(spec.calendarId)}/events/${enc(String(event.id))}`),
      );
      if (
        current.id !== event.id ||
        current.status === "cancelled" ||
        !targetMatches(spec, current)
      )
        continue;
      const freshStart = calendarStartInstant(current.start, page.timeZone);
      if (freshStart.getTime() !== start.getTime()) continue;
      const observed = observation(context, {
        evidence: "calendar_clock",
        eventIdentity: `calendar-start:${id(current.id)}:${freshStart.toISOString()}`,
        observedVersion: typeof current.etag === "string" ? current.etag : hash(current),
        occurredAt: now.toISOString(),
        eventId: id(current.id),
        scheduledStart: freshStart.toISOString(),
        ...(typeof current.recurringEventId === "string"
          ? { recurringEventId: current.recurringEventId }
          : {}),
        ...(current.originalStartTime
          ? { originalStartTime: stableJsonValue(current.originalStartTime) }
          : {}),
      });
      if (nativeObservationMatches(context.row, observed, now)) await context.emit(observed);
    }
    await context.heartbeat();
    if (page.nextPageToken === undefined)
      return {
        state: { ...previous, ready: true },
        nextPollAt: previous.ready === true ? nextPollAt : now,
      };
    pageToken = String(page.nextPageToken);
    if (seen.has(pageToken))
      throw new NativeActionError("incomplete_response", "Calendar repeated a pagination cursor.");
    seen.add(pageToken);
  }
  throw new NativeActionError(
    "incomplete_response",
    "Calendar future-window pagination was incomplete.",
  );
}

async function notionPages(
  load: (cursor?: string) => Promise<unknown>,
  heartbeat: () => Promise<void>,
): Promise<Obj[]> {
  const all: Obj[] = [],
    seen = new Set<string>();
  let cursor: string | undefined;
  for (let n = 0; n < MAX_PAGES; n++) {
    const page = obj(await load(cursor));
    if (
      !Array.isArray(page.results) ||
      typeof page.has_more !== "boolean" ||
      (page.has_more && (typeof page.next_cursor !== "string" || !page.next_cursor))
    )
      throw new NativeActionError("incomplete_response", "Notion event pagination was incomplete.");
    all.push(...page.results.map(obj));
    await heartbeat();
    if (!page.has_more) return all;
    cursor = String(page.next_cursor);
    if (seen.has(cursor))
      throw new NativeActionError("incomplete_response", "Notion repeated a pagination cursor.");
    seen.add(cursor);
  }
  throw new NativeActionError(
    "incomplete_response",
    "Notion pagination exceeded the operational bound; state was not advanced.",
  );
}
interface NotionSnapshot {
  fingerprint: string;
  propertyHashes?: Record<string, string>;
  comments?: Array<{
    id: string;
    discussionId: string;
    anchorId: string;
    pageId: string;
    version: string;
  }>;
}
async function completePagePropertyHashes(
  page: Obj,
  api: NativeEventReadApi,
  heartbeat: () => Promise<void>,
): Promise<Record<string, string>> {
  const pairs: Array<[string, string]> = [];
  for (const raw of Object.values(obj(page.properties))) {
    const property = obj(raw),
      propertyId = id(property.id),
      key = decodeURIComponent(propertyId);
    if (
      !["title", "rich_text", "people", "relation", "rollup", "formula"].includes(
        String(property.type),
      )
    ) {
      pairs.push([key, notionHash(property)]);
      continue;
    }
    let cursor: string | undefined;
    const seen = new Set<string>(),
      items: unknown[] = [];
    let done = false,
      rollup: unknown = null;
    for (let n = 0; n < MAX_PAGES; n++) {
      const result = obj(
        await api.get(`/v1/pages/${enc(id(page.id))}/properties/${propertySegment(propertyId)}`, {
          page_size: 100,
          start_cursor: cursor,
        }),
      );
      if (result.object !== "list") {
        if (
          result.object !== "property_item" ||
          ["incomplete", "unsupported"].includes(String(optional(result.rollup).type)) ||
          optional(result.formula).type === "unsupported"
        )
          throw new NativeActionError(
            "incomplete_response",
            "The Notion property calculation was incomplete.",
          );
        items.push(result);
        done = true;
        await heartbeat();
        break;
      }
      if (
        !Array.isArray(result.results) ||
        typeof result.has_more !== "boolean" ||
        (result.has_more && (typeof result.next_cursor !== "string" || !result.next_cursor))
      )
        throw new NativeActionError(
          "incomplete_response",
          "The Notion property items were incomplete.",
        );
      items.push(...result.results);
      const calculated = optional(result.property_item).rollup;
      if (calculated !== undefined) {
        rollup = calculated;
        if (
          ["incomplete", "unsupported"].includes(String(optional(rollup).type)) &&
          !result.has_more
        )
          throw new NativeActionError(
            "incomplete_response",
            "The final Notion rollup was not calculated.",
          );
      }
      await heartbeat();
      if (!result.has_more) {
        done = true;
        break;
      }
      cursor = String(result.next_cursor);
      if (seen.has(cursor))
        throw new NativeActionError("incomplete_response", "The Notion property cursor repeated.");
      seen.add(cursor);
    }
    if (!done)
      throw new NativeActionError(
        "incomplete_response",
        "The Notion property pagination exceeded its operational bound.",
      );
    pairs.push([key, notionHash({ type: property.type, items, rollup })]);
  }
  return Object.fromEntries(pairs);
}
/** Reads only the explicit page/data source/comment anchor, storing hashes and IDs rather than document bodies. */
export async function readNotionSnapshot(
  context: NativeSourceReadContext,
  api: NativeEventReadApi,
): Promise<NotionSnapshot> {
  const spec = context.row.spec as Exclude<NativeRoutineEventSpec, { calendarId: string }>;
  const page = async (pageId: string) => {
    const value = obj(await api.get(`/v1/pages/${enc(pageId)}`));
    if (value.object !== "page" || !sameId(value.id, pageId))
      throw new NativeActionError("incomplete_response", "The exact Notion page was not verified.");
    return value;
  };
  const schemaProperties = (value: Obj): Record<string, string> =>
    Object.fromEntries(
      Object.entries(obj(value.properties)).map(([name, property]) => {
        const p = obj(property);
        return [decodeURIComponent(id(p.id)), notionHash({ name, ...p })];
      }),
    );
  if (spec.kind === "notion.page_content_changed") {
    const current = await page(spec.target.pageId),
      blocks: Obj[] = [],
      visited = new Set<string>();
    const walk = async (parentId: string): Promise<void> => {
      if (visited.has(parentId) || visited.size >= 10000)
        throw new NativeActionError(
          "incomplete_response",
          "The page subtree could not be completely read.",
        );
      visited.add(parentId);
      const children = await notionPages(
        (cursor) =>
          api.get(`/v1/blocks/${enc(parentId)}/children`, { page_size: 100, start_cursor: cursor }),
        context.heartbeat,
      );
      for (const child of children) {
        id(child.id);
        blocks.push(child);
        if (child.has_children === true) await walk(id(child.id));
      }
    };
    await walk(spec.target.pageId);
    return {
      fingerprint: notionHash({
        blocks,
        in_trash: current.in_trash ?? null,
        archived: current.archived ?? null,
      }),
    };
  }
  if (spec.kind === "notion.page_properties_or_data_source_changed") {
    if (spec.target.type === "page") {
      const current = await page(spec.target.pageId),
        propertyHashes = await completePagePropertyHashes(current, api, context.heartbeat);
      return {
        fingerprint: hash({
          propertyHashes,
          in_trash: current.in_trash ?? null,
          archived: current.archived ?? null,
        }),
        propertyHashes,
      };
    }
    const dataSourceId = spec.target.dataSourceId;
    const current = obj(await api.get(`/v1/data_sources/${enc(dataSourceId)}`));
    if (current.object !== "data_source" || !sameId(current.id, dataSourceId))
      throw new NativeActionError(
        "incomplete_response",
        "The exact Notion data source was not verified.",
      );
    const entries = await notionPages(
      (cursor) => api.queryNotionDataSource(dataSourceId, cursor),
      context.heartbeat,
    );
    const buckets = new Map<string, unknown[]>();
    for (const [key, value] of Object.entries(schemaProperties(current))) buckets.set(key, [value]);
    for (const entry of entries.sort((a, b) => id(a.id).localeCompare(id(b.id))))
      for (const [key, value] of Object.entries(
        await completePagePropertyHashes(entry, api, context.heartbeat),
      )) {
        const values = buckets.get(key) ?? [];
        values.push([id(entry.id), value]);
        buckets.set(key, values);
      }
    const propertyHashes = Object.fromEntries(
      [...buckets].map(([key, value]) => [key, hash(value)]),
    );
    return {
      fingerprint: hash({
        schema: current.properties,
        entries: entries.map((entry) => [entry.id, entry.in_trash ?? null, entry.archived ?? null]),
        propertyHashes,
      }),
      propertyHashes,
    };
  }
  const target = spec.target,
    anchor =
      target.type === "page"
        ? target.pageId
        : target.type === "block"
          ? target.blockId
          : target.anchorBlockId;
  await page(target.pageId);
  if (!sameId(anchor, target.pageId)) {
    let current = anchor;
    const visited = new Set<string>();
    let matched = false;
    while (!matched && visited.size < 100) {
      if (visited.has(current)) break;
      visited.add(current);
      const block = obj(await api.get(`/v1/blocks/${enc(current)}`));
      if (block.object !== "block" || !sameId(block.id, current)) break;
      const parent = obj(block.parent);
      if (parent.type === "page_id") {
        matched = sameId(parent.page_id, target.pageId);
        break;
      }
      if (parent.type !== "block_id" || typeof parent.block_id !== "string") break;
      current = parent.block_id;
    }
    if (!matched)
      throw new NativeActionError(
        "resource_unavailable",
        "The comment anchor moved outside the explicitly selected page.",
      );
  }
  const rows = await notionPages(
    (cursor) => api.get("/v1/comments", { block_id: anchor, page_size: 100, start_cursor: cursor }),
    context.heartbeat,
  );
  const comments = rows
    .filter(
      (comment) =>
        target.type !== "discussion" || sameId(comment.discussion_id, target.discussionId),
    )
    .map((comment) => ({
      id: id(comment.id),
      discussionId: id(comment.discussion_id),
      anchorId: anchor,
      pageId: target.pageId,
      version: hash({
        last_edited_time: comment.last_edited_time ?? null,
        rich_text: comment.rich_text ?? null,
        attachments: Array.isArray(comment.attachments)
          ? comment.attachments.map((attachment) => {
              const a = obj(attachment);
              return { id: a.id ?? null, name: a.name ?? null, type: a.type ?? null };
            })
          : [],
      }),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { fingerprint: hash(comments), comments };
}
/** Observations carry only the binding's explicitly selected IDs, never an unbounded upstream schema. */
function selectedObservationPropertyIds(
  spec: NativeRoutineEventSpec,
  candidates: readonly string[],
): string[] | undefined {
  if (spec.kind !== "notion.page_properties_or_data_source_changed" || !spec.propertyIds)
    return undefined;
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  };
  const actual = new Set(
    candidates.map(decode).filter((value): value is string => value !== undefined),
  );
  const selected = [
    ...new Set(
      spec.propertyIds
        .map(decode)
        .filter((value): value is string => value !== undefined && actual.has(value)),
    ),
  ];
  return selected.length ? selected : undefined;
}
/** Compensation observes visible state, not a complete edit log. First baseline never fires preexisting content. */
export async function readNotionChanges(
  context: NativeSourceReadContext,
  api: NativeEventReadApi,
  now = new Date(),
): Promise<NativeSourceReadResult> {
  const previous = optional(context.row.state),
    old = optional(previous.notion),
    current = await readNotionSnapshot(context, api),
    spec = context.row.spec as Exclude<NativeRoutineEventSpec, { calendarId: string }>;
  const changedProperties = Object.keys({
    ...optional(old.propertyHashes),
    ...current.propertyHashes,
  }).filter((key) => optional(old.propertyHashes)[key] !== current.propertyHashes?.[key]);
  const changed =
    previous.ready === true &&
    typeof old.fingerprint === "string" &&
    old.fingerprint !== current.fingerprint;
  const sequence =
    typeof previous.changeSequence === "number" &&
    Number.isSafeInteger(previous.changeSequence) &&
    previous.changeSequence >= 0
      ? previous.changeSequence
      : 0;
  if (changed && sequence >= Number.MAX_SAFE_INTEGER)
    throw new NativeActionError(
      "incomplete_response",
      "The native event observation sequence must be rearmed.",
    );
  let lastPollChange = previous.lastPollChange;
  if (changed) {
    const observed = observation(context, {
      eventIdentity: `visible-state:${sequence + 1}:${old.fingerprint}:${current.fingerprint}`,
      observedVersion: current.fingerprint,
      occurredAt: now.toISOString(),
      ...(selectedObservationPropertyIds(spec, changedProperties)
        ? { propertyIds: selectedObservationPropertyIds(spec, changedProperties) }
        : {}),
    });
    if (nativeObservationMatches(context.row, observed, now)) {
      await context.emit(observed);
      lastPollChange = { fingerprint: current.fingerprint, observedAt: now.toISOString() };
    }
  }
  return {
    state: {
      ...previous,
      ready: true,
      notion: current,
      changeSequence: changed ? sequence + 1 : sequence,
      ...(lastPollChange ? { lastPollChange } : {}),
      evidence: "visible_state_change",
    },
    nextPollAt: after(now),
  };
}
/** Called only from a verified, durable Notion signal job after revalidating its hook configuration and exact current OAuth principal. */
export async function readNotionWebhook(
  context: NativeSourceReadContext,
  api: NativeEventReadApi,
  signal: NotionEventSignal,
  principal: NotionEventPrincipal,
  now = new Date(),
): Promise<NativeSourceReadResult> {
  const previous = optional(context.row.state),
    spec = context.row.spec as NativeRoutineEventSpec;
  if (
    !notionSignalAccessible(signal, principal) ||
    !notionSignalCandidate(spec, signal) ||
    Date.parse(signal.timestamp) < context.row.armedAt.getTime()
  )
    return { state: previous, nextPollAt: context.row.nextPollAt ?? after(now) };
  if (previous.ready !== true)
    throw new NativeActionError(
      "temporarily_unavailable",
      "The exact event source baseline must finish before consuming this signal.",
    );
  const current = await readNotionSnapshot(context, api);
  // A committed compensation run may already cover this earlier signal. Same fingerprint alone is insufficient
  // (e.g. same-name hosted file replacement); distinct signed event IDs keep their own receipt.
  const covered = optional(previous.lastPollChange);
  if (
    covered.fingerprint === current.fingerprint &&
    typeof covered.observedAt === "string" &&
    Date.parse(signal.timestamp) <= Date.parse(covered.observedAt)
  )
    return { state: previous, nextPollAt: after(now) };
  if (spec.kind === "notion.comment_changed" && spec.target.type === "discussion") {
    const witness =
      current.comments?.find((comment) => sameId(comment.id, signal.entity.id)) ??
      (Array.isArray(optional(previous.notion).comments)
        ? (optional(previous.notion).comments as NonNullable<NotionSnapshot["comments"]>).find(
            (comment) => sameId(comment.id, signal.entity.id),
          )
        : undefined);
    if (
      !witness ||
      !sameId(witness.discussionId, spec.target.discussionId) ||
      !sameId(witness.anchorId, spec.target.anchorBlockId) ||
      !sameId(witness.pageId, spec.target.pageId)
    )
      return { state: previous, nextPollAt: after(now) };
  }
  const changedProperties = Object.keys({
    ...optional(optional(previous.notion).propertyHashes),
    ...current.propertyHashes,
  }).filter(
    (key) =>
      optional(optional(previous.notion).propertyHashes)[key] !== current.propertyHashes?.[key],
  );
  const propertyIds = selectedObservationPropertyIds(spec, [
    ...(signal.propertyIds ?? []),
    ...changedProperties,
  ]);
  const observed = observation(context, {
    evidence: "notion_webhook",
    eventIdentity: `${signal.integrationId}:${signal.subscriptionId}:${signal.id}`,
    observedVersion: current.fingerprint,
    occurredAt: signal.timestamp,
    ...(propertyIds ? { propertyIds } : {}),
  });
  if (nativeObservationMatches(context.row, observed, now)) await context.emit(observed);
  return {
    state: { ...previous, ready: true, notion: current, evidence: "notion_webhook" },
    nextPollAt: after(now),
  };
}
