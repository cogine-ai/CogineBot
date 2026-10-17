import { createHash } from "node:crypto";
import type { NativeAction, NativeActionContext, NativeRequest } from "./action.js";
import { NativeActionError } from "./action.js";
import contract from "./calendar.contract.json" with { type: "json" };
import { validateNativeInput } from "./validation.js";

type Obj = Record<string, unknown>;
type Schema = Obj;
const rows = contract.actions;
const EVENT_FIELDS = [
  "id",
  "etag",
  "status",
  "eventType",
  "summary",
  "description",
  "location",
  "start",
  "end",
  "recurrence",
  "recurringEventId",
  "originalStartTime",
  "organizer",
  "creator",
  "attendees",
  "attendeesOmitted",
  "iCalUID",
  "htmlLink",
  "updated",
  "visibility",
  "transparency",
  "reminders",
  "conferenceData",
  "hangoutLink",
  "privateCopy",
];
const CALENDAR_FIELDS = [
  "id",
  "etag",
  "summary",
  "summaryOverride",
  "description",
  "location",
  "timeZone",
  "primary",
  "accessRole",
  "selected",
  "hidden",
  "deleted",
  "colorId",
  "backgroundColor",
  "foregroundColor",
  "conferenceProperties",
  "defaultReminders",
  "notificationSettings",
];
const PREFIX = "https://www.googleapis.com/auth/";
const enc = (value: unknown) => encodeURIComponent(String(value));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function obj(value: unknown, upstream = false): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new NativeActionError(
      upstream ? "incomplete_response" : "invalid_input",
      "Expected an object.",
    );
  return value as Obj;
}
function optionalObj(value: unknown): Obj | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : undefined;
}
function fail(message: string): never {
  throw new NativeActionError("invalid_input", message);
}
function project(value: unknown, fields: string[]): Obj {
  const source = obj(value, true);
  if (typeof source.id !== "string" || !source.id)
    throw new NativeActionError("incomplete_response", "Provider omitted resource identity.");
  return Object.fromEntries(
    fields
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, structuredClone(source[key])]),
  );
}
function event(value: unknown): Obj {
  return project(value, EVENT_FIELDS);
}
function calendar(value: unknown): Obj {
  return project(value, CALENDAR_FIELDS);
}
function query(args: Obj, keys: string[]): NonNullable<NativeRequest["query"]> {
  return Object.fromEntries(
    keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]),
  ) as NonNullable<NativeRequest["query"]>;
}
function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
function validDateTime(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !validDate(value.slice(0, 10))
  )
    return false;
  const pieces = value.slice(11).match(/^(\d{2}):(\d{2}):(\d{2})/)!;
  return (
    Number(pieces[1]) <= 23 &&
    Number(pieces[2]) <= 59 &&
    Number(pieces[3]) <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}
function timeZone(value: unknown): void {
  if (value === undefined) return;
  try {
    new Intl.DateTimeFormat("en", { timeZone: String(value) }).format();
  } catch {
    fail("Use an explicit valid IANA time zone.");
  }
}
function window(args: Obj): void {
  if (
    !validDateTime(String(args.timeMin)) ||
    !validDateTime(String(args.timeMax)) ||
    Date.parse(String(args.timeMin)) >= Date.parse(String(args.timeMax))
  )
    fail("timeMin must precede timeMax with explicit offsets.");
  timeZone(args.timeZone);
}
function recurrence(value: unknown): void {
  if (value === undefined) return;
  for (const line of value as string[]) {
    const colon = line.indexOf(":"),
      kind = line.slice(0, colon),
      data = line.slice(colon + 1);
    if (["RDATE", "EXDATE"].includes(kind)) {
      if (
        !data.split(",").every((item) => {
          if (/^\d{8}$/.test(item))
            return validDate(`${item.slice(0, 4)}-${item.slice(4, 6)}-${item.slice(6, 8)}`);
          if (!/^\d{8}T\d{6}Z?$/.test(item)) return false;
          return validDateTime(
            `${item.slice(0, 4)}-${item.slice(4, 6)}-${item.slice(6, 8)}T${item.slice(9, 11)}:${item.slice(11, 13)}:${item.slice(13, 15)}Z`,
          );
        })
      )
        fail("Invalid recurrence date list.");
      continue;
    }
    if (!["RRULE", "EXRULE"].includes(kind)) fail("Unsupported recurrence line.");
    const entries = data.split(";").map((part) => {
      const [key, content, ...extra] = part.split("=");
      if (!key || !content || extra.length) return fail("Invalid recurrence rule.");
      return [key, content] as const;
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length)
      fail("Invalid recurrence rule.");
    const rule = Object.fromEntries(entries);
    const frequency = rule.FREQ;
    if (!frequency || !/^(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(frequency))
      fail("Recurrence requires a valid FREQ.");
    if (rule.COUNT && rule.UNTIL) fail("COUNT and UNTIL cannot be combined.");
    for (const [key, content] of entries) {
      if (key === "FREQ") continue;
      if (["COUNT", "INTERVAL"].includes(key)) {
        if (!/^[1-9]\d*$/.test(content) || !Number.isSafeInteger(+content))
          fail("Invalid recurrence count/interval.");
        continue;
      }
      if (key === "UNTIL") {
        if (!/^\d{8}(T\d{6}Z)?$/.test(content)) fail("Invalid recurrence UNTIL.");
        recurrence([`EXDATE:${content}`]);
        continue;
      }
      if (key === "WKST") {
        if (!/^(MO|TU|WE|TH|FR|SA|SU)$/.test(content)) fail("Invalid recurrence WKST.");
        continue;
      }
      if (key === "BYDAY") {
        if (
          !content
            .split(",")
            .every(
              (item) =>
                /^([+-]?[1-9]\d?)?(MO|TU|WE|TH|FR|SA|SU)$/.test(item) &&
                (!/\d/.test(item) || Math.abs(parseInt(item, 10)) <= 53),
            )
        )
          fail("Invalid recurrence BYDAY.");
        if (/\d/.test(content) && !["MONTHLY", "YEARLY"].includes(frequency))
          fail("Ordinal BYDAY requires MONTHLY or YEARLY.");
        continue;
      }
      const limits: Record<string, [number, number, boolean]> = {
        BYSECOND: [0, 60, false],
        BYMINUTE: [0, 59, false],
        BYHOUR: [0, 23, false],
        BYMONTHDAY: [-31, 31, true],
        BYYEARDAY: [-366, 366, true],
        BYWEEKNO: [-53, 53, true],
        BYMONTH: [1, 12, false],
        BYSETPOS: [-366, 366, true],
      };
      const bound = limits[key];
      if (
        !bound ||
        !content
          .split(",")
          .every(
            (item) =>
              /^[+-]?\d+$/.test(item) &&
              +item >= bound[0] &&
              +item <= bound[1] &&
              (!bound[2] || +item !== 0),
          )
      )
        fail("Invalid recurrence rule value.");
    }
    if (
      rule.BYSETPOS &&
      !Object.keys(rule).some((key) => key.startsWith("BY") && key !== "BYSETPOS")
    )
      fail("BYSETPOS requires another BY rule.");
    if ((rule.BYWEEKNO && rule.FREQ !== "YEARLY") || (rule.BYMONTHDAY && rule.FREQ === "WEEKLY"))
      fail("Invalid recurrence rule combination.");
  }
}
function eventTimes(data: Obj, partial = false, authoritative?: Obj): void {
  if (partial && data.start === undefined && data.end === undefined) {
    recurrence(data.recurrence);
    if (Array.isArray(data.recurrence) && data.recurrence.length)
      eventTimes({ ...authoritative, ...data });
    return;
  }
  if (data.start === undefined || data.end === undefined) fail("Change start and end together.");
  const start = obj(data.start),
    end = obj(data.end),
    isDate = typeof start.date === "string";
  if (isDate !== (typeof end.date === "string"))
    fail("Event start/end must use the same time shape.");
  const a = String(isDate ? start.date : start.dateTime),
    b = String(isDate ? end.date : end.dateTime);
  if (Date.parse(a) >= Date.parse(b))
    fail("Event end must follow start; all-day end is exclusive.");
  timeZone(start.timeZone);
  timeZone(end.timeZone);
  if (!isDate)
    for (const point of [start, end]) {
      if (typeof point.timeZone !== "string") continue;
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: point.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(String(point.dateTime)));
      const local = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const actual = `${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}:${local.second}`;
      if (String(point.dateTime).slice(0, 19) !== actual)
        fail("The event offset does not match its declared IANA time zone.");
    }
  const effectiveRecurrence = data.recurrence ?? authoritative?.recurrence;
  if (
    Array.isArray(effectiveRecurrence) &&
    effectiveRecurrence.length &&
    !isDate &&
    (!start.timeZone || start.timeZone !== end.timeZone)
  )
    fail("Recurring timed events require matching explicit IANA time zones.");
  recurrence(effectiveRecurrence);
}
function eventPath(args: Obj): string {
  return `/calendars/${enc(args.calendarId)}/events/${enc(args.eventId)}`;
}
function recoverable(error: unknown): boolean {
  return (
    !(error instanceof NativeActionError) ||
    error.options.uncertain === true ||
    ["result_unknown", "incomplete_response"].includes(error.kind)
  );
}
function uncertain(message: string, recovery: Obj, observed?: Obj): never {
  throw new NativeActionError("result_unknown", message, {
    uncertain: true,
    recovery: { ...recovery, ...observed },
  });
}
async function call(
  context: NativeActionContext,
  request: NativeRequest,
  write = false,
): Promise<unknown> {
  try {
    const response = await context.request(request);
    if (response.status >= 200 && response.status < 300) return response.body;
    const body = response.body && typeof response.body === "object" ? (response.body as Obj) : {};
    const details = body.error && typeof body.error === "object" ? (body.error as Obj) : body;
    const reasons = Array.isArray(details.errors)
      ? details.errors.map((item) => obj(item, true).reason)
      : [];
    if (response.status === 401)
      throw new NativeActionError("authorization_expired", "Reconnect the selected account.");
    if (
      response.status === 403 &&
      reasons.some((reason) =>
        [
          "rateLimitExceeded",
          "userRateLimitExceeded",
          "quotaExceeded",
          "dailyLimitExceeded",
        ].includes(String(reason)),
      )
    )
      throw new NativeActionError("rate_limited", "Google Calendar quota reached.");
    if (response.status === 403)
      throw new NativeActionError(
        "insufficient_scope",
        "Selected account cannot perform this operation.",
      );
    if (response.status === 404 || response.status === 410)
      throw new NativeActionError("resource_unavailable", "Calendar resource unavailable.");
    if (response.status === 409 || response.status === 412)
      throw new NativeActionError("version_conflict", "Calendar resource changed.", {
        recovery: { upstreamStatus: response.status },
      });
    const retry = response.headers.get("retry-after");
    if (response.status === 429)
      throw new NativeActionError("rate_limited", "Google Calendar rate limit reached.", {
        retryAfterSeconds: retry && /^\d+$/.test(retry) ? +retry : undefined,
      });
    if (response.status >= 500 || response.status === 408)
      throw new NativeActionError(
        write ? "result_unknown" : "temporarily_unavailable",
        "Calendar response unavailable.",
        { uncertain: write },
      );
    throw new NativeActionError("invalid_input", "Google Calendar rejected this operation.");
  } catch (error) {
    if (error instanceof NativeActionError) throw error;
    throw new NativeActionError(
      write ? "result_unknown" : "temporarily_unavailable",
      "Calendar response unavailable.",
      { uncertain: write },
    );
  }
}
async function get(context: NativeActionContext, path: string): Promise<Obj> {
  return event(await call(context, { method: "GET", path }));
}
function subset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => subset(item, actual[index]))
    );
  if (expected && typeof expected === "object")
    return (
      !!actual &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) => subset(value, (actual as Obj)[key]))
    );
  return expected === actual;
}
function sameEvent(expected: Obj, actual: Obj): boolean {
  return Object.entries(expected).every(([key, value]) => {
    if (key === "conferenceData") {
      const requested = obj(obj(value).createRequest),
        returned = optionalObj(actual.conferenceData);
      return !!returned && subset(requested, returned.createRequest);
    }
    if (key === "attendees" && Array.isArray(value)) {
      return (
        Array.isArray(actual.attendees) &&
        value.length === actual.attendees.length &&
        value.every((item) => {
          const requested = obj(item),
            found = (actual.attendees as Obj[]).find(
              (attendee) =>
                String(attendee.email).toLowerCase() === String(requested.email).toLowerCase(),
            );
          return (
            !!found &&
            Object.entries(requested).every(
              ([field, wanted]) =>
                field === "email" ||
                (field === "optional" && wanted === false && found[field] === undefined) ||
                subset(wanted, found[field]),
            )
          );
        })
      );
    }
    if (["start", "end"].includes(key)) {
      const wanted = obj(value),
        found = optionalObj(actual[key]);
      return (
        !!found &&
        (wanted.date !== undefined
          ? wanted.date === found.date
          : Date.parse(String(wanted.dateTime)) === Date.parse(String(found.dateTime))) &&
        (wanted.timeZone === undefined || wanted.timeZone === found.timeZone)
      );
    }
    return subset(value, actual[key]);
  });
}
async function preflight(args: Obj, context: NativeActionContext): Promise<Obj> {
  const current = await get(context, eventPath(args));
  if (current.id !== args.eventId || current.etag !== args.expectedEtag)
    throw new NativeActionError(
      "version_conflict",
      "Event identity or etag changed; review it again.",
    );
  const kind =
    current.recurringEventId && current.originalStartTime
      ? "instance"
      : Array.isArray(current.recurrence) && current.recurrence.length
        ? "series"
        : "single";
  if (kind !== args.targetKind)
    fail("The selected recurrence target kind does not match the event.");
  if (current.status === "cancelled")
    throw new NativeActionError("resource_unavailable", "This event is already cancelled.");
  return current;
}
type Recovery = Obj & {
  version: number;
  operationId: string;
  actionId: string;
  intentHash: string;
  stage: string;
};
async function begin(
  actionId: string,
  args: Obj,
  context: NativeActionContext,
  extra: Obj = {},
): Promise<Recovery> {
  const intentHash = hash(
    stable({
      actionId,
      args,
      subject: context.principal.subject,
      tenant: context.principal.tenant,
    }),
  );
  if (context.recovery && Object.keys(context.recovery).length) {
    const saved = context.recovery;
    if (
      saved.version !== 1 ||
      saved.operationId !== context.operationId ||
      saved.actionId !== actionId ||
      saved.intentHash !== intentHash
    )
      throw new NativeActionError(
        "version_conflict",
        "Recovery does not match this exact approved operation.",
      );
    return { ...saved } as Recovery;
  }
  const state: Recovery = {
    version: 1,
    operationId: context.operationId,
    actionId,
    intentHash,
    stage: "prepared",
    ...extra,
  };
  await context.checkpoint(state);
  return state;
}
async function checkpoint(
  context: NativeActionContext,
  state: Recovery,
  patch: Obj,
): Promise<void> {
  Object.assign(state, patch);
  await context.checkpoint(structuredClone(state));
}
async function page(
  args: Obj,
  context: NativeActionContext,
  path: string,
  keys: string[],
  kind: "event" | "calendar",
): Promise<Obj> {
  const body = obj(
    await call(context, { method: "GET", path, query: query({ maxResults: 100, ...args }, keys) }),
    true,
  );
  if (!Array.isArray(body.items))
    throw new NativeActionError("incomplete_response", "Calendar page omitted items.");
  if (
    body.nextPageToken !== undefined &&
    (typeof body.nextPageToken !== "string" || !body.nextPageToken)
  )
    throw new NativeActionError("incomplete_response", "Calendar page cursor is invalid.");
  const nextPageToken = body.nextPageToken ?? null;
  const items = body.items.map(kind === "event" ? event : calendar);
  const visibilityLimitedEventIds =
    kind === "event"
      ? items
          .filter(
            (item) => item.status !== "cancelled" && (!item.summary || !item.start || !item.end),
          )
          .map((item) => item.id)
      : [];
  const attendeesIncompleteEventIds =
    kind === "event"
      ? items.filter((item) => item.attendeesOmitted === true).map((item) => item.id)
      : [];
  return {
    items,
    nextPageToken,
    hasMore: nextPageToken !== null,
    allPagesRead: !args.pageToken && nextPageToken === null,
    ...(visibilityLimitedEventIds.length ? { visibilityLimitedEventIds } : {}),
    ...(attendeesIncompleteEventIds.length ? { attendeesIncompleteEventIds } : {}),
  };
}
async function conferenceResult(
  context: NativeActionContext,
  path: string,
  created: Obj,
  requested: boolean,
  recovered = false,
): Promise<Obj> {
  if (!requested)
    return {
      event: created,
      outcome: recovered ? "observed-satisfied" : "succeeded",
      notificationDelivery: "not-observed",
    };
  let current = created;
  const status = () => {
    const data = optionalObj(current.conferenceData),
      request = optionalObj(data?.createRequest),
      result = optionalObj(request?.status);
    return typeof result?.statusCode === "string" ? result.statusCode : "unknown";
  };
  // One bounded immediate readback; further checks use the existing events.get action.
  if (status() === "pending") {
    try {
      const readback = await get(context, path);
      if (readback.id === created.id) current = readback;
    } catch {
      /* The created event still exists; do not recreate it. */
    }
  }
  const data = optionalObj(current.conferenceData),
    request = optionalObj(data?.createRequest);
  const code =
    request?.requestId === `cgnconf${hash(`${context.operationId}:conference`)}`
      ? status()
      : "unknown";
  const entryPoints = data && Array.isArray(data.entryPoints) ? data.entryPoints : [];
  const success = code === "success" && entryPoints.length > 0;
  return {
    event: current,
    eventCreated: true,
    outcome: success ? (recovered ? "observed-satisfied" : "succeeded") : "partial",
    complete: success,
    conference: {
      status: code,
      requestId: request?.requestId ?? null,
      entryPoints,
      ...(data?.conferenceId ? { conferenceId: data.conferenceId } : {}),
      ...(data?.conferenceSolution ? { conferenceSolution: data.conferenceSolution } : {}),
    },
    incompleteReasons: success
      ? []
      : [
          code === "pending"
            ? "CONFERENCE_PENDING"
            : code === "failure"
              ? "CONFERENCE_FAILED"
              : "CONFERENCE_UNKNOWN",
        ],
    notificationDelivery: "not-observed",
  };
}
async function create(args: Obj, context: NativeActionContext): Promise<Obj> {
  const input = obj(args.event);
  eventTimes(input);
  const id = `cgn${hash(context.operationId)}`,
    body: Obj = { ...structuredClone(input), id };
  const conference = input.conferenceData !== undefined;
  if (conference) {
    body.conferenceData = {
      createRequest: {
        ...obj(obj(input.conferenceData).createRequest),
        requestId: `cgnconf${hash(`${context.operationId}:conference`)}`,
      },
    };
  }
  const path = `/calendars/${enc(args.calendarId)}/events`,
    exactPath = `${path}/${enc(id)}`;
  const state = await begin("calendar.events.create", args, context, {
    calendarId: args.calendarId,
    eventId: id,
  });
  if (state.eventId !== id || state.calendarId !== args.calendarId)
    throw new NativeActionError("version_conflict", "Create recovery target changed.");
  if (state.stage === "committed") {
    const receipt: Obj = { id, ...(state.etag ? { etag: state.etag } : {}) };
    if (conference) {
      try {
        const latest = await get(context, exactPath);
        if (latest.id === id) return conferenceResult(context, exactPath, latest, true);
      } catch {
        /* The original event ACK is durable even if latest details are unavailable. */
      }
      return {
        ...(await conferenceResult(context, exactPath, receipt, true)),
        acknowledged: true,
        resourceState: "not-refreshed",
      };
    }
    return {
      event: receipt,
      outcome: "succeeded",
      acknowledged: true,
      resourceState: "not-refreshed",
      notificationDelivery: "not-observed",
    };
  }
  if (state.stage !== "prepared") {
    try {
      const found = await get(context, exactPath);
      if (!sameEvent(body, found))
        uncertain("Stable event ID exists with different content.", state);
      return await conferenceResult(context, exactPath, found, conference, true);
    } catch (error) {
      if (error instanceof NativeActionError && error.kind === "result_unknown") throw error;
      uncertain("Read back the same event before retrying this create.", state);
    }
  }
  await checkpoint(context, state, { stage: "dispatching" });
  try {
    const created = event(
      await call(
        context,
        {
          method: "POST",
          path,
          query: {
            sendUpdates: String(args.sendUpdates),
            ...(conference ? { conferenceDataVersion: 1 } : {}),
          },
          body,
        },
        true,
      ),
    );
    if (created.id !== id) uncertain("Calendar did not confirm the stable event ID.", state);
    await checkpoint(context, state, {
      stage: "committed",
      eventId: created.id,
      etag: created.etag,
    });
    return await conferenceResult(context, exactPath, created, conference);
  } catch (error) {
    const duplicate =
      error instanceof NativeActionError &&
      error.kind === "version_conflict" &&
      error.options.recovery?.upstreamStatus !== 412;
    if (!duplicate && !recoverable(error)) throw error;
    try {
      const found = await get(context, exactPath);
      if (!sameEvent(body, found))
        uncertain("Existing stable event does not match this approved create.", state);
      await checkpoint(context, state, { stage: "committed", eventId: found.id, etag: found.etag });
      return await conferenceResult(context, exactPath, found, conference, true);
    } catch {
      uncertain("Calendar creation outcome is unknown; use the original event ID.", state);
    }
  }
}
async function update(args: Obj, context: NativeActionContext): Promise<Obj> {
  const changes = obj(args.changes);
  if (changes.recurrence !== undefined && args.targetKind !== "series")
    fail("Recurrence changes require an explicit series target.");
  const state = await begin("calendar.events.update", args, context, {
    calendarId: args.calendarId,
    eventId: args.eventId,
  });
  if (state.stage === "committed")
    return {
      event: { id: args.eventId, ...(state.etag ? { etag: state.etag } : {}) },
      outcome: "succeeded",
      acknowledged: true,
      resourceState: "not-refreshed",
    };
  if (state.stage !== "prepared") return updateReadback(args, context, state);
  const before = await preflight(args, context);
  eventTimes(changes, true, before);
  await checkpoint(context, state, { stage: "dispatching" });
  try {
    const changed = event(
      await call(
        context,
        {
          method: "PATCH",
          path: eventPath(args),
          query: { sendUpdates: String(args.sendUpdates) },
          headers: { "If-Match": String(args.expectedEtag) },
          body: changes,
        },
        true,
      ),
    );
    if (changed.id !== args.eventId)
      uncertain("Update returned a different event identity.", state);
    await checkpoint(context, state, { stage: "committed", etag: changed.etag });
    return { event: changed, outcome: "succeeded" };
  } catch (error) {
    if (!recoverable(error)) throw error;
    return updateReadback(args, context, state);
  }
}
async function updateReadback(
  args: Obj,
  context: NativeActionContext,
  state: Recovery,
): Promise<Obj> {
  try {
    const found = await get(context, eventPath(args));
    if (found.id === args.eventId && sameEvent(obj(args.changes), found))
      return { event: found, outcome: "observed-satisfied", notificationDelivery: "not-observed" };
  } catch {
    /* Preserve uncertainty; never rebase/re-PATCH. */
  }
  uncertain("Update outcome is unknown; the original event must be reviewed.", state);
}
async function remove(args: Obj, context: NativeActionContext): Promise<Obj> {
  const state = await begin("calendar.events.delete", args, context, {
    calendarId: args.calendarId,
    eventId: args.eventId,
  });
  if (state.stage !== "prepared") return deleteReadback(args, context, state);
  const before = await preflight(args, context);
  const organizer = optionalObj(before.organizer);
  const semantics =
    organizer?.self === true
      ? "cancel_for_everyone"
      : organizer?.self === false
        ? "remove_calendar_copy"
        : undefined;
  if (!semantics || semantics !== args.expectedSemantics)
    fail(
      "The authoritative organizer identity does not match the approved cancellation/copy-removal intent.",
    );
  await checkpoint(context, state, { stage: "dispatching", semantics });
  try {
    await call(
      context,
      {
        method: "DELETE",
        path: eventPath(args),
        query: { sendUpdates: String(args.sendUpdates) },
        headers: { "If-Match": String(args.expectedEtag) },
      },
      true,
    );
    await checkpoint(context, state, { stage: "committed" });
    return {
      calendarId: args.calendarId,
      eventId: args.eventId,
      outcome: "deleted",
      notificationDelivery: "not-observed",
      semantics,
    };
  } catch (error) {
    if (!recoverable(error)) throw error;
    return deleteReadback(args, context, state);
  }
}
async function deleteReadback(
  args: Obj,
  context: NativeActionContext,
  state: Recovery,
): Promise<Obj> {
  if (state.stage === "committed")
    return {
      calendarId: args.calendarId,
      eventId: args.eventId,
      outcome: "deleted",
      semantics: state.semantics,
      notificationDelivery: "not-observed",
    };
  let observed = "unavailable";
  try {
    const current = await get(context, eventPath(args));
    observed = current.status === "cancelled" ? "cancelled" : "present";
  } catch {
    /* 404 also means inaccessible. */
  }
  uncertain(
    "Deletion response was lost; absence does not prove cancellation or notification.",
    state,
    { observed },
  );
}
function selfAttendee(current: Obj): Obj {
  const candidates = Array.isArray(current.attendees)
    ? (current.attendees.filter(
        (value) => value && typeof value === "object" && (value as Obj).self === true,
      ) as Obj[])
    : [];
  const candidate = candidates[0];
  if (
    candidates.length !== 1 ||
    !candidate ||
    typeof candidate.email !== "string" ||
    !candidate.email
  )
    throw new NativeActionError(
      "resource_unavailable",
      "Cannot identify the primary-calendar participant.",
    );
  return candidate;
}
async function respond(args: Obj, context: NativeActionContext): Promise<Obj> {
  const state = await begin("calendar.events.respond", args, context, {
    calendarId: "primary",
    eventId: args.eventId,
  });
  const result = (outcome: string): Obj => ({
    eventId: args.eventId,
    calendarId: "primary",
    responseStatus: args.responseStatus,
    outcome,
    notificationDelivery: "not-observed",
  });
  const readback = async () => {
    try {
      const own = selfAttendee(await get(context, eventPath(args)));
      if (
        own.responseStatus === args.responseStatus &&
        (args.comment === undefined || own.comment === args.comment) &&
        (state.participantEmail === undefined || own.email === state.participantEmail)
      )
        return result("observed-satisfied");
    } catch {
      /* Do not respond as another participant. */
    }
    uncertain("RSVP outcome is unknown; inspect the original primary-calendar event.", state);
  };
  if (state.stage === "committed") return { ...result("succeeded"), acknowledged: true };
  if (state.stage !== "prepared") return readback();
  const own = selfAttendee(await preflight(args, context));
  const attendee = {
    email: own.email,
    responseStatus: args.responseStatus,
    ...(args.comment !== undefined ? { comment: args.comment } : {}),
  };
  await checkpoint(context, state, { stage: "dispatching", participantEmail: own.email });
  try {
    const changed = event(
      await call(
        context,
        {
          method: "PATCH",
          path: eventPath(args),
          query: { sendUpdates: String(args.sendUpdates) },
          headers: { "If-Match": String(args.expectedEtag) },
          body: { attendees: [attendee], attendeesOmitted: true },
        },
        true,
      ),
    );
    if (changed.id !== args.eventId || selfAttendee(changed).responseStatus !== args.responseStatus)
      uncertain("Calendar did not confirm the requested own RSVP.", state);
    await checkpoint(context, state, { stage: "committed" });
    return result("succeeded");
  } catch (error) {
    if (!recoverable(error)) throw error;
    return readback();
  }
}
async function move(args: Obj, context: NativeActionContext): Promise<Obj> {
  if (args.calendarId === args.destination) fail("Source and destination calendars must differ.");
  const state = await begin("calendar.events.move", args, context, {
    calendarId: args.calendarId,
    destination: args.destination,
    eventId: args.eventId,
  });
  const readback = async (): Promise<Obj> => {
    const observations: Obj = {};
    for (const [key, id] of [
      ["source", args.calendarId],
      ["destination", args.destination],
    ]) {
      try {
        observations[String(key)] = await get(
          context,
          `/calendars/${enc(id)}/events/${enc(args.eventId)}`,
        );
      } catch {
        observations[String(key)] = "unavailable";
      }
    }
    uncertain(
      "Move response is unknown; source/destination observations do not prove notification delivery.",
      state,
      { observations },
    );
  };
  if (state.stage === "committed")
    return {
      event: { id: args.eventId, ...(state.etag ? { etag: state.etag } : {}) },
      sourceCalendarId: args.calendarId,
      destinationCalendarId: args.destination,
      outcome: "succeeded",
      atomicVersionPrecondition: false,
      acknowledged: true,
      resourceState: "not-refreshed",
    };
  if (state.stage !== "prepared") return readback();
  const before = await preflight(args, context);
  if (before.eventType !== "default") fail("Only default events can be moved.");
  await checkpoint(context, state, {
    stage: "dispatching",
    priorEventFingerprint: hash(stable(before)),
    iCalUID: before.iCalUID,
  });
  try {
    const changed = event(
      await call(
        context,
        {
          method: "POST",
          path: `${eventPath(args)}/move`,
          query: { destination: String(args.destination), sendUpdates: String(args.sendUpdates) },
        },
        true,
      ),
    );
    if (changed.id !== args.eventId) uncertain("Move returned a different event identity.", state);
    await checkpoint(context, state, { stage: "committed", etag: changed.etag });
    return {
      event: changed,
      sourceCalendarId: args.calendarId,
      destinationCalendarId: args.destination,
      outcome: "succeeded",
      atomicVersionPrecondition: false,
    };
  } catch (error) {
    if (!recoverable(error)) throw error;
    return readback();
  }
}
async function importEvent(args: Obj, context: NativeActionContext): Promise<Obj> {
  const input = obj(args.event);
  eventTimes(input);
  const body = { ...structuredClone(input), iCalUID: args.iCalUID, eventType: "default" };
  const path = `/calendars/${enc(args.calendarId)}/events`;
  const state = await begin("calendar.events.import", args, context, {
    calendarId: args.calendarId,
    iCalUID: args.iCalUID,
  });
  const result = (found: Obj, outcome: string): Obj => ({
    event: found,
    outcome,
    semantics: "private-copy-import",
    notificationDelivery: "not-requested-by-this-contract",
  });
  const readback = async (): Promise<Obj> => {
    if (typeof state.eventId === "string") {
      try {
        const found = await get(context, `${path}/${enc(state.eventId)}`);
        if (sameEvent(body, found)) return result(found, "observed-satisfied");
      } catch {
        /* Do not create another copy. */
      }
    }
    const candidateIds: string[] = [];
    let pageToken: string | undefined;
    const seen = new Set<string>();
    for (let count = 0; count < 10; count++) {
      let response: Obj;
      try {
        response = obj(
          await call(context, {
            method: "GET",
            path,
            query: { iCalUID: String(args.iCalUID), maxResults: 2500, pageToken },
          }),
          true,
        );
      } catch {
        uncertain("Import lookup failed; do not re-import.", state);
      }
      if (!Array.isArray(response.items)) uncertain("Import lookup was incomplete.", state);
      for (const item of response.items) {
        const candidate = event(item);
        if (sameEvent(body, candidate)) candidateIds.push(String(candidate.id));
      }
      if (response.nextPageToken === undefined)
        uncertain("Matching copies cannot establish whether this import committed.", state, {
          candidateIds,
          candidateSearchComplete: true,
        });
      if (typeof response.nextPageToken !== "string" || seen.has(response.nextPageToken))
        uncertain("Import lookup cursor is invalid.", state, {
          candidateIds,
          candidateSearchComplete: false,
        });
      pageToken = response.nextPageToken;
      seen.add(pageToken);
    }
    uncertain("Import candidate lookup exceeded its bounded budget.", state, {
      candidateIds,
      candidateSearchComplete: false,
    });
  };
  if (state.stage === "committed" && typeof state.eventId === "string")
    return {
      ...result({ id: state.eventId, ...(state.etag ? { etag: state.etag } : {}) }, "succeeded"),
      acknowledged: true,
      resourceState: "not-refreshed",
    };
  if (state.stage !== "prepared") return readback();
  await checkpoint(context, state, { stage: "dispatching" });
  try {
    const imported = event(
      await call(context, { method: "POST", path: `${path}/import`, body }, true),
    );
    await checkpoint(context, state, {
      stage: "committed",
      eventId: imported.id,
      etag: imported.etag,
    });
    return result(imported, "succeeded");
  } catch (error) {
    if (!recoverable(error)) throw error;
    return readback();
  }
}
const implementations: Record<string, (args: Obj, context: NativeActionContext) => Promise<Obj>> = {
  "calendar.calendars.list": (args, context) =>
    page(
      args,
      context,
      "/users/me/calendarList",
      ["maxResults", "pageToken", "showHidden", "showDeleted", "minAccessRole"],
      "calendar",
    ),
  "calendar.calendars.get": async (args, context) => ({
    calendar: calendar(
      await call(context, {
        method: "GET",
        path: `/users/me/calendarList/${enc(args.calendarId)}`,
      }),
    ),
  }),
  "calendar.events.search": async (args, context) => {
    window(args);
    if (args.orderBy === "startTime" && args.singleEvents === false)
      fail("startTime ordering requires expanded singleEvents.");
    return page(
      { singleEvents: true, ...args },
      context,
      `/calendars/${enc(args.calendarId)}/events`,
      [
        "timeMin",
        "timeMax",
        "q",
        "timeZone",
        "singleEvents",
        "orderBy",
        "showDeleted",
        "maxResults",
        "pageToken",
      ],
      "event",
    );
  },
  "calendar.events.get": async (args, context) => {
    timeZone(args.timeZone);
    const current = event(
      await call(context, {
        method: "GET",
        path: eventPath(args),
        query: query(args, ["timeZone"]),
      }),
    );
    return {
      event: current,
      visibilityLimited:
        current.status !== "cancelled" && (!current.summary || !current.start || !current.end),
      attendeesComplete: current.attendeesOmitted !== true,
    };
  },
  "calendar.freebusy.query": async (args, context) => {
    window(args);
    const body = obj(await call(context, { method: "POST", path: "/freeBusy", body: args }), true);
    if (!body.calendars || typeof body.calendars !== "object" || Array.isArray(body.calendars))
      throw new NativeActionError("incomplete_response", "Free/busy response omitted calendars.");
    const calendars = body.calendars as Obj,
      groups = optionalObj(body.groups) ?? {};
    const unresolvedRequestedIds = (args.items as Obj[])
      .map((item) => String(item.id))
      .filter((id) => !Object.hasOwn(calendars, id) && !Object.hasOwn(groups, id));
    for (const group of Object.values(groups)) {
      const expanded = obj(group, true).calendars;
      if (
        Array.isArray(expanded) &&
        expanded.some((id) => typeof id !== "string" || !Object.hasOwn(calendars, id))
      )
        throw new NativeActionError(
          "incomplete_response",
          "Free/busy omitted an expanded calendar; do not infer free time.",
        );
    }
    const failedCalendarIds = Object.entries(body.calendars)
      .filter(
        ([, value]) =>
          Array.isArray(obj(value, true).errors) && (obj(value).errors as unknown[]).length > 0,
      )
      .map(([id]) => id);
    const failedGroupIds =
      body.groups && typeof body.groups === "object"
        ? Object.entries(body.groups)
            .filter(
              ([, value]) =>
                Array.isArray(obj(value, true).errors) &&
                (obj(value).errors as unknown[]).length > 0,
            )
            .map(([id]) => id)
        : [];
    return {
      freebusy: body,
      partial:
        failedCalendarIds.length > 0 ||
        failedGroupIds.length > 0 ||
        unresolvedRequestedIds.length > 0,
      failedCalendarIds,
      ...(unresolvedRequestedIds.length ? { unresolvedRequestedIds } : {}),
      ...(failedGroupIds.length ? { failedGroupIds } : {}),
    };
  },
  "calendar.events.create": create,
  "calendar.events.update": update,
  "calendar.events.delete": remove,
  "calendar.events.instances": async (args, context) => {
    window(args);
    return page(
      args,
      context,
      `${eventPath(args)}/instances`,
      ["timeMin", "timeMax", "timeZone", "showDeleted", "maxResults", "pageToken"],
      "event",
    );
  },
  "calendar.events.respond": respond,
  "calendar.events.move": move,
  "calendar.events.import": importEvent,
};

export const calendarActions: readonly NativeAction[] = rows.map((row) => {
  const implementation = implementations[row.id];
  if (!implementation) throw new Error(`Missing frozen Calendar implementation: ${row.id}`);
  return {
    id: row.id,
    description: row.id,
    inputSchema: row.inputSchema as Schema,
    readOnly: row.readOnly,
    scopesAnyOf: row.authorization.acceptedAnyOfScopes,
    execute: async (input, context) => {
      validateNativeInput(row.inputSchema as Schema, input);
      if (
        !row.authorization.acceptedAnyOfScopes.some((scope) =>
          context.principal.scopes.includes(scope),
        )
      ) {
        // Conditional owned/app-created scopes require a verified resource authority contract, never a caller assertion.
        throw new NativeActionError(
          "insufficient_scope",
          "The exact connection lacks a permitted Calendar scope.",
        );
      }
      context.signal.throwIfAborted();
      return implementation(structuredClone(input), context);
    },
  };
});
export const CALENDAR_ACTIONS = calendarActions;
export const calendarContractVersion = contract.frozenAt;
export const calendarScopePrefix = PREFIX;
