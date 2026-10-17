import assert from "node:assert/strict";
import type { NativeRoutineEventSpec } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { it as test } from "vitest";
import type { NativeOAuthStore } from "../oauth.js";
import { NativeRoutineEventApi } from "./api.js";
import { NativeEventResourceVerifier } from "./resource-verifier.js";

const PAGE = "11111111-1111-4111-8111-111111111111",
  BLOCK = "22222222-2222-4222-8222-222222222222",
  DS = "33333333-3333-4333-8333-333333333333",
  DISCUSSION = "44444444-4444-4444-8444-444444444444";
const scope = { userId: "synthetic-owner", spaceId: "synthetic-space" };
const READ = "https://www.googleapis.com/auth/calendar.events.readonly";
type Authorization = Awaited<ReturnType<NativeOAuthStore["authorization"]>>;
function fixture(
  app = "google-calendar",
  responses: Array<Record<string, unknown> | Response> = [],
  mutate?: (bound: Authorization, call: number) => void,
) {
  const calls: Array<{ url: URL; method: string; headers: Headers }> = [];
  let checks = 0;
  const bound = {
    connection: {
      id: "connection-a",
      ...scope,
      connectorId: "native",
      provider: app,
      metadata: { authRevision: "auth-a" },
      updatedAt: new Date("2026-10-18T00:00:00Z"),
    },
    config: {
      id: "config-a",
      revision: 1,
      appId: app,
      config: {
        scopes: app === "google-calendar" ? [READ] : [],
        capabilities: app === "notion" ? ["read_content", "read_comments"] : [],
        knowledgeBaseIds: [],
      },
    },
    grant: { id: "grant-a", authGeneration: 1, scopes: app === "google-calendar" ? [READ] : [] },
    auth: { tokens: { accessToken: "synthetic-read-token" } },
  } as unknown as Authorization;
  const oauth = {
    authorization: async (connectionId: string, context: { userId: string; spaceId: string }) => {
      assert.equal(connectionId, "connection-a");
      assert.equal(context.userId, scope.userId);
      assert.equal(context.spaceId, scope.spaceId);
      mutate?.(bound, ++checks);
      return structuredClone(bound);
    },
  };
  const verifier = new NativeEventResourceVerifier(oauth, {
    network: {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (input, init) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url),
          headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer synthetic-read-token");
        assert.equal(init?.method, "GET");
        assert.equal(init.body, undefined);
        calls.push({ url, method: String(init?.method), headers });
        const response = responses.shift();
        if (!response) throw new Error("Unexpected fixture request");
        return response instanceof Response ? response : new Response(JSON.stringify(response));
      },
    },
  });
  return { bound, oauth, verifier, calls, checks: () => checks };
}
const signal = () => new AbortController().signal;
const prepare = (verifier: NativeEventResourceVerifier, spec: NativeRoutineEventSpec) =>
  verifier.prepare(scope, { connectionId: "connection-a", spec }, signal());
test("Calendar resource proof uses fixed API authority and returns exact grant, not credentials", async () => {
  const { verifier, calls } = fixture("google-calendar", [{ kind: "calendar#events", items: [] }]);
  const result = await prepare(verifier, {
    kind: "calendar.event_changed",
    calendarId: "primary",
    target: { kind: "calendar" },
  });
  assert.equal(calls[0]!.url.origin, "https://www.googleapis.com");
  assert.equal(calls[0]!.url.pathname, "/calendar/v3/calendars/primary/events");
  assert.equal(calls[0]!.url.searchParams.get("singleEvents"), "false");
  assert.equal(result.proof.authGeneration, 1);
  assert.equal(result.proof.authorizationRevision, "auth-a");
  assert.equal(result.proof.connectionId, "connection-a");
  assert.equal(JSON.stringify(result).includes("synthetic-read-token"), false);
});
test("Calendar recurrence target is read and cannot silently change kind", async () => {
  const exact = fixture("google-calendar", [
    { kind: "calendar#events", items: [] },
    { id: "series-a", recurrence: ["RRULE:FREQ=DAILY"] },
  ]);
  await prepare(exact.verifier, {
    kind: "calendar.event_starting",
    calendarId: "primary",
    target: { kind: "series", eventId: "series-a" },
    leadMinutes: 15,
  });
  assert.equal(exact.calls[1]!.url.pathname, "/calendar/v3/calendars/primary/events/series-a");
  const wrong = fixture("google-calendar", [
    { kind: "calendar#events", items: [] },
    { id: "series-a", recurrence: ["RRULE:FREQ=DAILY"] },
  ]);
  await assert.rejects(
    prepare(wrong.verifier, {
      kind: "calendar.event_changed",
      calendarId: "primary",
      target: { kind: "single", eventId: "series-a" },
    }),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "kind" in error &&
          error.kind === "resource_unavailable",
      ),
  );
});
for (const [name, mutate] of Object.entries<(bound: Authorization) => void>({
  freeBusyOnly: (bound) => {
    bound.grant.scopes = ["https://www.googleapis.com/auth/calendar.freebusy"];
  },
  foreignOwner: (bound) => {
    bound.connection.userId = "other";
  },
  wrongSource: (bound) => {
    bound.connection.connectorId = "composio";
  },
}))
  test(`resource proof refuses ${name} before network`, async () => {
    const f = fixture("google-calendar", [], mutate);
    await assert.rejects(
      prepare(f.verifier, {
        kind: "calendar.event_changed",
        calendarId: "primary",
        target: { kind: "calendar" },
      }),
    );
    assert.equal(f.calls.length, 0);
  });
test("authorization changing during verification cannot issue/read through old grant", async () => {
  const f = fixture("google-calendar", [], (bound, call) => {
    if (call === 2) bound.connection.metadata = { authRevision: "new-auth" };
  });
  await assert.rejects(
    prepare(f.verifier, {
      kind: "calendar.event_changed",
      calendarId: "primary",
      target: { kind: "calendar" },
    }),
  );
  assert.equal(f.calls.length, 0);
});
test("Notion data source uses 2026-03-11 authoritative stable property IDs", async () => {
  const f = fixture("notion", [
    {
      object: "data_source",
      id: DS,
      properties: { Amount: { id: "XGe%40", type: "number", number: { format: "dollar" } } },
    },
  ]);
  await prepare(f.verifier, {
    kind: "notion.page_properties_or_data_source_changed",
    target: { type: "data_source", dataSourceId: DS },
    propertyIds: ["XGe@"],
  });
  assert.equal(f.calls[0]!.url.pathname, `/v1/data_sources/${DS}`);
  assert.equal(f.calls[0]!.headers.get("notion-version"), "2026-03-11");
  const wrong = fixture("notion", [
    { object: "data_source", id: DS, properties: { Amount: { id: "stable-id" } } },
  ]);
  await assert.rejects(
    prepare(wrong.verifier, {
      kind: "notion.page_properties_or_data_source_changed",
      target: { type: "data_source", dataSourceId: DS },
      propertyIds: ["Amount"],
    }),
  );
});
test("Notion page comments verify actual read_comments access", async () => {
  const f = fixture("notion", [
    { object: "page", id: PAGE },
    { object: "list", results: [], has_more: false, next_cursor: null },
  ]);
  await prepare(f.verifier, {
    kind: "notion.comment_changed",
    target: { type: "page", pageId: PAGE },
  });
  assert.equal(f.calls[1]!.url.pathname, "/v1/comments");
  assert.equal(f.calls[1]!.url.searchParams.get("block_id"), PAGE);
  const denied = fixture("notion", [
    { object: "page", id: PAGE },
    new Response(JSON.stringify({ code: "restricted_resource" }), { status: 403 }),
  ]);
  await assert.rejects(
    prepare(denied.verifier, {
      kind: "notion.comment_changed",
      target: { type: "page", pageId: PAGE },
    }),
  );
  assert.equal(denied.calls.length, 2);
});
test("Notion block under another page is not accepted as the selected anchor", async () => {
  const f = fixture("notion", [
    { object: "page", id: PAGE },
    { object: "block", id: BLOCK, parent: { type: "page_id", page_id: DS } },
  ]);
  await assert.rejects(
    prepare(f.verifier, {
      kind: "notion.comment_changed",
      target: { type: "block", blockId: BLOCK, pageId: PAGE },
    }),
  );
  assert.equal(f.calls.length, 2);
});
test("Notion discussion lookup follows complete pagination and requires exact discussion", async () => {
  const f = fixture("notion", [
    { object: "page", id: PAGE },
    { object: "block", id: BLOCK, parent: { type: "page_id", page_id: PAGE } },
    { object: "page", id: PAGE },
    {
      object: "list",
      results: [{ id: DS, discussion_id: DS }],
      has_more: true,
      next_cursor: "cursor-a",
    },
    {
      object: "list",
      results: [{ id: DS, discussion_id: DISCUSSION }],
      has_more: false,
      next_cursor: null,
    },
    { object: "list", results: [], has_more: false, next_cursor: null },
  ]);
  await prepare(f.verifier, {
    kind: "notion.comment_changed",
    target: { type: "discussion", discussionId: DISCUSSION, anchorBlockId: BLOCK, pageId: PAGE },
  });
  assert.equal(f.calls[4]!.url.searchParams.get("start_cursor"), "cursor-a");
});
test("undefined nativeTriggers preserves old configuration and makes no verifier/database request", async () => {
  let called = 0;
  const verifier = {
    prepare: async () => {
      called++;
      throw new Error("Unexpected verifier");
    },
  };
  const api = new NativeRoutineEventApi({} as PrismaClient, verifier);
  assert.equal(await api.prepareForRoutineMutation(scope, undefined, signal()), undefined);
  assert.deepEqual(await api.prepareForRoutineMutation(scope, [], signal()), []);
  assert.equal(called, 0);
});
test("standalone save checks Routine owner before external resource verification", async () => {
  let called = 0;
  const verifier = {
    prepare: async () => {
      called++;
      throw new Error("Unexpected verifier");
    },
  };
  const db = { $queryRaw: async () => [] } as unknown as PrismaClient;
  const api = new NativeRoutineEventApi(db, verifier);
  await assert.rejects(
    api.save(
      scope,
      {
        routineId: "foreign-routine",
        connectionId: "connection-a",
        spec: { kind: "calendar.event_changed", calendarId: "primary" },
      },
      signal(),
    ),
    /Routine not found/,
  );
  assert.equal(called, 0);
});
