import assert from "node:assert/strict";
import type { NativeEventObservation, NativeRoutineEventSpec } from "@rakazo/contracts";
import { NativeEventObservationSchema, nativeEventResource } from "@rakazo/contracts";
import { it as test } from "vitest";
import { NativeActionError } from "../action.js";
import type { NativeEventReadApi } from "./readers.js";
import {
  calendarStartInstant,
  readCalendarChanges,
  readCalendarStarting,
  readNotionChanges,
  readNotionSnapshot,
  readNotionWebhook,
} from "./readers.js";
import type { NotionEventSignal } from "./signals.js";
import type { NativeSourceReadContext } from "./worker.js";

const PAGE = "11111111-1111-4111-8111-111111111111",
  BLOCK = "22222222-2222-4222-8222-222222222222",
  DS = "33333333-3333-4333-8333-333333333333",
  DISCUSSION = "44444444-4444-4444-8444-444444444444",
  COMMENT = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-10-18T10:00:00Z");
function source(spec: NativeRoutineEventSpec, state: Record<string, unknown> = {}) {
  const events: NativeEventObservation[] = [],
    resource = nativeEventResource(spec);
  let heartbeats = 0;
  const context: NativeSourceReadContext = {
    scope: { userId: "synthetic-owner", spaceId: "synthetic-space" },
    row: {
      id: "trigger-a",
      routineId: "routine-a",
      connectionId: "connection-a",
      authorizationRevision: "auth-a",
      grantId: "grant-a",
      authGeneration: 1,
      configId: "config-a",
      configRevision: 1,
      kind: spec.kind,
      resourceType: resource.type,
      resourceId: resource.id,
      spec,
      version: 1,
      armedAt: new Date(NOW.getTime() - 3600000),
      state,
      nextPollAt: NOW,
      leaseId: "lease-a",
      leaseUntil: new Date(NOW.getTime() + 120000),
    },
    signal: new AbortController().signal,
    emit: async (event) => {
      events.push(event);
      return true;
    },
    heartbeat: async () => {
      heartbeats++;
    },
  };
  return { context, events, heartbeats: () => heartbeats };
}
type Call = {
  path: string;
  query: Record<string, string | number | boolean | undefined>;
  post: boolean;
};
function api(responses: Array<unknown | Error>): { api: NativeEventReadApi; calls: Call[] } {
  const calls: Call[] = [];
  const next = () => {
    const value = responses.shift();
    if (value instanceof Error) throw value;
    if (!value) throw new Error("Unexpected fixture request");
    return structuredClone(value);
  };
  return {
    calls,
    api: {
      get: async (path, query = {}) => {
        calls.push({ path, query, post: false });
        return next();
      },
      queryNotionDataSource: async (id, cursor) => {
        calls.push({
          path: `/v1/data_sources/${id}/query`,
          query: { start_cursor: cursor },
          post: true,
        });
        return next();
      },
    },
  };
}
const CHANGED: NativeRoutineEventSpec = {
  kind: "calendar.event_changed",
  calendarId: "primary",
  target: { kind: "calendar" },
};
const STARTING: NativeRoutineEventSpec = {
  kind: "calendar.event_starting",
  calendarId: "primary",
  target: { kind: "calendar" },
  leadMinutes: 10,
};
const cp = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  kind: "calendar#events",
  timeZone: "Asia/Taipei",
  items,
  ...extra,
});
const np = (results: unknown[], more = false, cursor: string | null = null) => ({
  object: "list",
  results,
  has_more: more,
  next_cursor: cursor,
});
async function baselineState() {
  const s = source(CHANGED),
    f = api([cp([], { nextSyncToken: "original-sync" })]);
  return (await readCalendarChanges(s.context, f.api, NOW)).state;
}
test("Calendar baseline consumes all pages, emits no preexisting event, commits only final cursor", async () => {
  const s = source(CHANGED),
    f = api([
      cp([{ id: "old" }], { nextPageToken: "page-2" }),
      cp([{ id: "old-2" }], { nextSyncToken: "final-sync" }),
    ]);
  const result = await readCalendarChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 0);
  assert.equal(s.heartbeats(), 2);
  assert.equal(f.calls[1]!.query.pageToken, "page-2");
  assert.equal((result.state.calendarChanged as Record<string, unknown>).syncToken, "final-sync");
  assert.equal(result.state.ready, true);
});
test("Calendar incremental query preserves original token and includes cancelled tombstone", async () => {
  const state = await baselineState(),
    s = source(CHANGED, state),
    f = api([
      cp([{ id: "event-a", etag: "a", updated: NOW.toISOString() }], { nextPageToken: "page-2" }),
      cp([{ id: "cancelled-a", status: "cancelled" }], { nextSyncToken: "next-sync" }),
    ]);
  const result = await readCalendarChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 2);
  assert.equal(s.events[1]!.eventId, "cancelled-a");
  assert.equal(s.events[0]!.evidence, "calendar_sync");
  for (const call of f.calls) {
    assert.equal(call.query.syncToken, "original-sync");
    assert.equal(call.query.timeMin, undefined);
    assert.equal(call.query.orderBy, undefined);
    assert.equal(call.query.showDeleted, true);
  }
  assert.equal((result.state.calendarChanged as Record<string, unknown>).syncToken, "next-sync");
});
test("Calendar page failure or absent final nextSyncToken cannot advance durable cursor", async () => {
  for (const responses of [
    [
      cp([], { nextPageToken: "p2" }),
      new NativeActionError("temporarily_unavailable", "synthetic failure"),
    ],
    [cp([])],
  ]) {
    const state = await baselineState(),
      s = source(CHANGED, state),
      f = api(responses);
    await assert.rejects(readCalendarChanges(s.context, f.api, NOW));
    assert.equal((state.calendarChanged as Record<string, unknown>).syncToken, "original-sync");
  }
});
test("Calendar 410 rebuilds only this exact baseline without mass fire; 403 never becomes deletion", async () => {
  const state = await baselineState(),
    s = source(CHANGED, state),
    f = api([
      new NativeActionError("resource_unavailable", "expired", { recovery: { status: 410 } }),
      cp([{ id: "preexisting" }], { nextSyncToken: "rebuilt" }),
    ]);
  const result = await readCalendarChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 0);
  assert.equal(f.calls[1]!.query.syncToken, undefined);
  assert.equal((result.state.calendarChanged as Record<string, unknown>).syncToken, "rebuilt");
  const denied = api([new NativeActionError("resource_unavailable", "denied")]);
  await assert.rejects(readCalendarChanges(s.context, denied.api, NOW));
  assert.equal(denied.calls.length, 1);
});
test("Calendar recurrence filter keeps only selected series and exact source", async () => {
  const initial = source({ ...CHANGED, target: { kind: "series", eventId: "series-a" } }),
    b = api([cp([], { nextSyncToken: "s" })]);
  const state = (await readCalendarChanges(initial.context, b.api, NOW)).state;
  const s = source({ ...CHANGED, target: { kind: "series", eventId: "series-a" } }, state),
    f = api([
      cp(
        [
          {
            id: "instance-a",
            recurringEventId: "series-a",
            originalStartTime: { dateTime: "2026-10-18T18:00:00+08:00" },
            etag: "a",
          },
          { id: "sibling", recurringEventId: "series-b", etag: "b" },
        ],
        { nextSyncToken: "next" },
      ),
    ]);
  await readCalendarChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0]!.connectionId, "connection-a");
  assert.equal(s.events[0]!.recurringEventId, "series-a");
});
test("Calendar starting uses expanded window and rereads the current occurrence", async () => {
  const s = source(STARTING, { ready: true }),
    ev = {
      id: "instance-a",
      recurringEventId: "series-a",
      etag: "one",
      start: { dateTime: "2026-10-18T18:05:00+08:00" },
    },
    f = api([cp([ev]), { ...ev, etag: "two" }]);
  await readCalendarStarting(s.context, f.api, NOW);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0]!.scheduledStart, "2026-10-18T10:05:00.000Z");
  assert.equal(s.events[0]!.evidence, "calendar_clock");
  assert.equal(f.calls[0]!.query.singleEvents, true);
  assert.equal(f.calls[0]!.query.syncToken, undefined);
  assert.equal(f.calls[1]!.path, "/calendars/primary/events/instance-a");
});
test("Calendar moved/cancelled or past instance cannot fire an obsolete reminder", async () => {
  const ev = { id: "event-a", start: { dateTime: "2026-10-18T10:05:00Z" } };
  for (const fresh of [
    { ...ev, start: { dateTime: "2026-10-18T11:05:00Z" } },
    { ...ev, status: "cancelled" },
  ]) {
    const s = source(STARTING, { ready: true }),
      f = api([cp([ev]), fresh]);
    await readCalendarStarting(s.context, f.api, NOW);
    assert.equal(s.events.length, 0);
  }
  const s = source(STARTING, { ready: true }),
    f = api([cp([{ id: "past", start: { dateTime: "2026-10-18T09:59:00Z" } }])]);
  await readCalendarStarting(s.context, f.api, NOW);
  assert.equal(s.events.length, 0);
  assert.equal(f.calls.length, 1);
});
test("Calendar future due instant is persisted as next poll, initial arm does not invent a run", async () => {
  const s = source(STARTING, { ready: true }),
    f = api([cp([{ id: "event-a", start: { dateTime: "2026-10-18T10:10:30Z" } }])]);
  const result = await readCalendarStarting(s.context, f.api, NOW);
  assert.equal(result.nextPollAt.toISOString(), "2026-10-18T10:00:30.000Z");
  assert.equal(s.events.length, 0);
  const initial = source(STARTING),
    p = api([cp([{ id: "event-a", start: { dateTime: "2026-10-18T10:05:00Z" } }])]);
  const armed = await readCalendarStarting(initial.context, p.api, NOW);
  assert.equal(initial.events.length, 0);
  assert.equal(armed.state.ready, true);
  assert.equal(armed.nextPollAt, NOW);
});
test("Calendar all-day uses authoritative IANA zone, including DST; missing zone fails closed", () => {
  assert.equal(
    calendarStartInstant({ date: "2026-10-19" }, "Asia/Taipei").toISOString(),
    "2026-10-18T16:00:00.000Z",
  );
  assert.equal(
    calendarStartInstant({ date: "2026-11-01" }, "America/New_York").toISOString(),
    "2026-11-01T04:00:00.000Z",
  );
  assert.throws(() => calendarStartInstant({ date: "2026-10-19" }, undefined));
  assert.throws(() => calendarStartInstant({ date: "2026-02-31" }, "UTC"));
});
function content(text: string) {
  return [
    { object: "page", id: PAGE },
    np([
      {
        object: "block",
        id: BLOCK,
        has_children: false,
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
      },
    ]),
  ];
}
const CONTENT: NativeRoutineEventSpec = {
  kind: "notion.page_content_changed",
  target: { type: "page", pageId: PAGE },
};
test("Notion content baseline then real block change fires exactly scoped visible-state evidence", async () => {
  const first = source(CONTENT),
    b = api(content("one")),
    state = (await readNotionChanges(first.context, b.api, NOW)).state;
  assert.equal(first.events.length, 0);
  const second = source(CONTENT, state),
    c = api(content("two"));
  const next = await readNotionChanges(second.context, c.api, NOW);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0]!.resource.id, PAGE);
  assert.equal(second.events[0]!.evidence, "visible_state_change");
  assert.equal(JSON.stringify(next.state).includes("two"), false);
  const same = source(CONTENT, next.state),
    d = api(content("two"));
  await readNotionChanges(same.context, d.api, NOW);
  assert.equal(same.events.length, 0);
});
test("Notion page content traverses child blocks and all pages, incomplete cursor never commits", async () => {
  const s = source(CONTENT),
    f = api([
      { object: "page", id: PAGE },
      np([{ id: BLOCK, has_children: true }], true, "p2"),
      np([{ id: DS, has_children: false }]),
      np([{ id: DISCUSSION, has_children: false }]),
    ]);
  await readNotionChanges(s.context, f.api, NOW);
  assert.equal(f.calls[2]!.query.start_cursor, "p2");
  assert.equal(f.calls[3]!.path, `/v1/blocks/${BLOCK}/children`);
  const broken = api([
    { object: "page", id: PAGE },
    { results: [], has_more: true, next_cursor: null },
  ]);
  await assert.rejects(readNotionChanges(source(CONTENT).context, broken.api, NOW));
});
const PROPS: NativeRoutineEventSpec = {
  kind: "notion.page_properties_or_data_source_changed",
  target: { type: "page", pageId: PAGE },
  propertyIds: ["XGe@"],
};
const pageProps = (number: number) => ({
  object: "page",
  id: PAGE,
  properties: { Amount: { id: "XGe%40", type: "number", number } },
});
test("Notion property change compares stable encoded IDs and does not match by display name", async () => {
  const b = source(PROPS),
    state = (await readNotionChanges(b.context, api([pageProps(1)]).api, NOW)).state;
  const s = source(PROPS, state);
  await readNotionChanges(s.context, api([pageProps(2)]).api, NOW);
  assert.equal(s.events.length, 1);
  assert.deepEqual(s.events[0]!.propertyIds, ["XGe@"]);
  const wrong = source({ ...PROPS, propertyIds: ["Amount"] }, state);
  await readNotionChanges(wrong.context, api([pageProps(2)]).api, NOW);
  assert.equal(wrong.events.length, 0);
});
test("Notion data-source content query paginates POST read and schema IDs stay distinct from database", async () => {
  const spec: NativeRoutineEventSpec = {
    kind: "notion.page_properties_or_data_source_changed",
    target: { type: "data_source", dataSourceId: DS },
  };
  const s = source(spec),
    f = api([
      {
        object: "data_source",
        id: DS,
        properties: { Amount: { id: "amount", type: "number", number: { format: "dollar" } } },
      },
      np([pageProps(1)], true, "q2"),
      np([{ ...pageProps(2), id: BLOCK }]),
    ]);
  const result = await readNotionSnapshot(s.context, f.api);
  assert.equal(f.calls[1]!.post, true);
  assert.equal(f.calls[2]!.query.start_cursor, "q2");
  assert.ok(result.propertyHashes?.amount);
  assert.ok(result.propertyHashes?.["XGe@"]);
  await assert.rejects(
    readNotionSnapshot(s.context, api([{ object: "database", id: DS, properties: {} }]).api),
  );
});
const COMMENTS: NativeRoutineEventSpec = {
  kind: "notion.comment_changed",
  target: { type: "discussion", discussionId: DISCUSSION, anchorBlockId: BLOCK, pageId: PAGE },
};
const commentResponses = (comments: unknown[]) => [
  { object: "page", id: PAGE },
  { object: "block", id: BLOCK, parent: { type: "page_id", page_id: PAGE } },
  np(comments),
];
const comment = {
  object: "comment",
  id: COMMENT,
  discussion_id: DISCUSSION,
  last_edited_time: NOW.toISOString(),
  rich_text: [{ text: { content: "SYNTHETIC-COMMENT-BODY" } }],
};
test("Notion discussion compensation keeps minimum witness and notices deletion without retaining body", async () => {
  const b = source(COMMENTS),
    state = (await readNotionChanges(b.context, api(commentResponses([comment])).api, NOW)).state;
  assert.equal(JSON.stringify(state).includes("SYNTHETIC-COMMENT-BODY"), false);
  const s = source(COMMENTS, state);
  await readNotionChanges(s.context, api(commentResponses([])).api, NOW);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0]!.resource.type, "discussion");
});
const principal = {
  workspaceId: DS,
  botId: BLOCK,
  ownerUserId: PAGE,
  credentialKind: "oauth" as const,
};
const deleted: NotionEventSignal = {
  id: DISCUSSION,
  timestamp: NOW.toISOString(),
  workspaceId: DS,
  integrationId: PAGE,
  subscriptionId: BLOCK,
  type: "comment.deleted",
  accessibleBy: [{ id: BLOCK, type: "bot" }],
  entity: { id: COMMENT, type: "comment" },
  pageId: PAGE,
  parent: { id: BLOCK, type: "block" },
};
test("Notion deleted comment webhook needs same-binding discussion witness and current anchor access", async () => {
  const b = source(COMMENTS),
    state = (await readNotionChanges(b.context, api(commentResponses([comment])).api, NOW)).state;
  const s = source(COMMENTS, state);
  const next = await readNotionWebhook(
    s.context,
    api(commentResponses([])).api,
    deleted,
    principal,
    NOW,
  );
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0]!.evidence, "notion_webhook");
  assert.equal(s.events[0]!.eventIdentity, `${PAGE}:${BLOCK}:${DISCUSSION}`);
  assert.equal(JSON.stringify(next.state).includes("SYNTHETIC-COMMENT-BODY"), false);
  const unknown = source(COMMENTS, state);
  await readNotionWebhook(
    unknown.context,
    api(commentResponses([])).api,
    { ...deleted, entity: { id: DS, type: "comment" } },
    principal,
    NOW,
  );
  assert.equal(unknown.events.length, 0);
});
test("Notion signed signal still cannot bypass workspace, baseline or current REST permission", async () => {
  const s = source(COMMENTS, { ready: true, notion: { fingerprint: "old" } }),
    none = api([]);
  await readNotionWebhook(s.context, none.api, { ...deleted, workspaceId: PAGE }, principal, NOW);
  assert.equal(none.calls.length, 0);
  assert.equal(s.events.length, 0);
  await assert.rejects(
    readNotionWebhook(source(COMMENTS).context, api([]).api, deleted, principal, NOW),
    /baseline/,
  );
  await assert.rejects(
    readNotionWebhook(
      s.context,
      api([new NativeActionError("resource_unavailable", "not shared")]).api,
      deleted,
      principal,
      NOW,
    ),
  );
  assert.equal(s.events.length, 0);
});
test("Notion compensation then late same-state webhook does not emit twice", async () => {
  const b = source(COMMENTS),
    base = (await readNotionChanges(b.context, api(commentResponses([comment])).api, NOW)).state;
  const p = source(COMMENTS, base),
    polled = await readNotionChanges(p.context, api(commentResponses([])).api, NOW);
  assert.equal(p.events.length, 1);
  const late = source(COMMENTS, polled.state);
  await readNotionWebhook(late.context, api(commentResponses([])).api, deleted, principal, NOW);
  assert.equal(late.events.length, 0);
});
test("Notion A→B→A→B creates distinct transition receipts and retry keeps the same key", async () => {
  let state = (await readNotionChanges(source(CONTENT).context, api(content("A")).api, NOW)).state;
  const identities: string[] = [];
  for (const value of ["B", "A", "B"]) {
    const s = source(CONTENT, state),
      result = await readNotionChanges(s.context, api(content(value)).api, NOW);
    identities.push(s.events[0]!.eventIdentity);
    const retry = source(CONTENT, state);
    await readNotionChanges(retry.context, api(content(value)).api, NOW);
    assert.equal(retry.events[0]!.eventIdentity, s.events[0]!.eventIdentity);
    state = result.state;
  }
  assert.equal(new Set(identities).size, 3);
  assert.equal(state.changeSequence, 3);
});
test("Notion hosted file signed URL renewal is not content/property change; external URL remains content", async () => {
  const hosted = (suffix: string) => [
    { object: "page", id: PAGE },
    np([
      {
        id: BLOCK,
        type: "image",
        has_children: false,
        last_edited_time: NOW.toISOString(),
        image: {
          type: "file",
          file: {
            url: `https://files.example.test/resource?signature=${suffix}`,
            expiry_time: suffix,
          },
        },
      },
    ]),
  ];
  const base = (await readNotionChanges(source(CONTENT).context, api(hosted("one")).api, NOW))
    .state;
  const renewed = source(CONTENT, base);
  await readNotionChanges(renewed.context, api(hosted("two")).api, NOW);
  assert.equal(renewed.events.length, 0);
  const spec: NativeRoutineEventSpec = {
    kind: "notion.page_properties_or_data_source_changed",
    target: { type: "page", pageId: PAGE },
  };
  const files = (suffix: string) => ({
    object: "page",
    id: PAGE,
    properties: {
      Files: {
        id: "files",
        type: "files",
        files: [
          {
            name: "report.pdf",
            type: "file",
            file: {
              url: `https://files.example.test/path?signature=${suffix}`,
              expiry_time: suffix,
            },
          },
        ],
      },
    },
  });
  const pbase = (await readNotionChanges(source(spec).context, api([files("one")]).api, NOW)).state,
    p = source(spec, pbase);
  await readNotionChanges(p.context, api([files("two")]).api, NOW);
  assert.equal(p.events.length, 0);
  const external = (url: string) => [
    { object: "page", id: PAGE },
    np([
      {
        id: BLOCK,
        type: "image",
        has_children: false,
        image: { type: "external", external: { url } },
      },
    ]),
  ];
  const ebase = (
      await readNotionChanges(
        source(CONTENT).context,
        api(external("https://example.test/a")).api,
        NOW,
      )
    ).state,
    e = source(CONTENT, ebase);
  await readNotionChanges(e.context, api(external("https://example.test/b")).api, NOW);
  assert.equal(e.events.length, 1);
});
test("Notion relation beyond first 25 values is completely paged before comparison", async () => {
  const spec: NativeRoutineEventSpec = {
    kind: "notion.page_properties_or_data_source_changed",
    target: { type: "page", pageId: PAGE },
    propertyIds: ["relation"],
  };
  const relation = (last: string) => [
    {
      object: "page",
      id: PAGE,
      properties: {
        Related: {
          id: "relation",
          type: "relation",
          relation: Array.from({ length: 25 }, (_, i) => ({ id: `visible-${i}` })),
          has_more: true,
        },
      },
    },
    np(
      Array.from({ length: 25 }, (_, i) => ({
        object: "property_item",
        id: "relation",
        type: "relation",
        relation: { id: `visible-${i}` },
      })),
      true,
      "r2",
    ),
    np([{ object: "property_item", id: "relation", type: "relation", relation: { id: last } }]),
  ];
  const base = (await readNotionChanges(source(spec).context, api(relation("last-a")).api, NOW))
      .state,
    s = source(spec, base),
    f = api(relation("last-b"));
  await readNotionChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 1);
  assert.equal(f.calls[2]!.query.start_cursor, "r2");
  assert.equal(f.calls[1]!.path, `/v1/pages/${PAGE}/properties/relation`);
  const bad = api([
    relation("x")[0],
    { object: "list", results: [], has_more: true, next_cursor: null },
  ]);
  await assert.rejects(readNotionChanges(source(spec, base).context, bad.api, NOW));
});
test("Notion authoritative same-fingerprint property signal is not swallowed without a covering poll receipt", async () => {
  const spec: NativeRoutineEventSpec = {
    kind: "notion.page_properties_or_data_source_changed",
    target: { type: "page", pageId: PAGE },
    propertyIds: ["XGe@"],
  };
  const base = (await readNotionChanges(source(spec).context, api([pageProps(1)]).api, NOW)).state;
  const signal: NotionEventSignal = {
    ...deleted,
    type: "page.properties_updated",
    entity: { id: PAGE, type: "page" },
    propertyIds: ["XGe%40"],
    parent: undefined,
    pageId: undefined,
  };
  const s = source(spec, base);
  await readNotionWebhook(s.context, api([pageProps(1)]).api, signal, principal, NOW);
  assert.equal(s.events.length, 1);
});
test("Notion URL-encoded property IDs are not encoded twice in item request paths", async () => {
  const spec: NativeRoutineEventSpec = {
      kind: "notion.page_properties_or_data_source_changed",
      target: { type: "page", pageId: PAGE },
    },
    f = api([
      {
        object: "page",
        id: PAGE,
        properties: {
          Related: { id: "f%5C%5C%3Ap", type: "relation", relation: [], has_more: true },
        },
      },
      np([]),
    ]);
  await readNotionSnapshot(source(spec).context, f.api);
  assert.equal(f.calls[1]!.path, `/v1/pages/${PAGE}/properties/f%5C%5C%3Ap`);
  assert.equal(f.calls[1]!.path.includes("%255C"), false);
});

test("Notion 101+ signed property IDs retain the selected final ID within bounded observations", async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `prop-${i}`),
    spec: NativeRoutineEventSpec = {
      kind: "notion.page_properties_or_data_source_changed",
      target: { type: "page", pageId: PAGE },
      propertyIds: [ids[149]!],
    };
  const page = {
    object: "page",
    id: PAGE,
    properties: { Last: { id: ids[149], type: "number", number: 1 } },
  };
  const state = (await readNotionChanges(source(spec).context, api([page]).api, NOW)).state;
  const signal: NotionEventSignal = {
    ...deleted,
    type: "page.properties_updated",
    entity: { id: PAGE, type: "page" },
    propertyIds: ids,
    parent: undefined,
    pageId: undefined,
  };
  const s = source(spec, state);
  await readNotionWebhook(s.context, api([page]).api, signal, principal, NOW);
  assert.equal(s.events.length, 1);
  assert.deepEqual(s.events[0]!.propertyIds, [ids[149]]);
  assert.ok(NativeEventObservationSchema.safeParse(s.events[0]).success);
  const unfiltered = { ...spec, propertyIds: undefined },
    u = source(unfiltered, state);
  await readNotionWebhook(u.context, api([page]).api, signal, principal, NOW);
  assert.equal(u.events.length, 1);
  assert.equal(u.events[0]!.propertyIds, undefined);
  assert.ok(NativeEventObservationSchema.safeParse(u.events[0]).success);
});
test("Notion 101+ compensation schema changes do not overflow observation or truncate final selection", async () => {
  const properties = (value: number) =>
    Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [
        `P${i}`,
        { id: `prop-${i}`, type: "number", number: value },
      ]),
    );
  const spec: NativeRoutineEventSpec = {
    kind: "notion.page_properties_or_data_source_changed",
    target: { type: "page", pageId: PAGE },
    propertyIds: ["prop-149"],
  };
  const state = (
      await readNotionChanges(
        source(spec).context,
        api([{ object: "page", id: PAGE, properties: properties(1) }]).api,
        NOW,
      )
    ).state,
    s = source(spec, state);
  await readNotionChanges(
    s.context,
    api([{ object: "page", id: PAGE, properties: properties(2) }]).api,
    NOW,
  );
  assert.equal(s.events.length, 1);
  assert.deepEqual(s.events[0]!.propertyIds, ["prop-149"]);
  assert.ok(NativeEventObservationSchema.safeParse(s.events[0]).success);
});

test("Calendar reminder-only delta with old updated fires using trusted observation time and same etag receipt", async () => {
  const state = await baselineState(),
    oldUpdated = "2020-01-01T00:00:00Z",
    s = source(CHANGED, state),
    f = api([
      cp(
        [
          {
            id: "event-a",
            etag: "new-reminder-etag",
            updated: oldUpdated,
            reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
          },
        ],
        { nextSyncToken: "reminder-next" },
      ),
    ]);
  const result = await readCalendarChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0]!.occurredAt, NOW.toISOString());
  assert.equal(s.events[0]!.observedVersion, "new-reminder-etag");
  assert.equal(
    (result.state.calendarChanged as Record<string, unknown>).syncToken,
    "reminder-next",
  );
  const retry = source(CHANGED, state);
  await readCalendarChanges(
    retry.context,
    api([
      cp([{ id: "event-a", etag: "new-reminder-etag", updated: oldUpdated }], {
        nextSyncToken: "reminder-next",
      }),
    ]).api,
    new Date(NOW.getTime() + 1000),
  );
  assert.equal(retry.events[0]!.eventIdentity, s.events[0]!.eventIdentity);
});
