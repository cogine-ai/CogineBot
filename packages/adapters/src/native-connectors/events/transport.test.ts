import assert from "node:assert/strict";
import { it as test } from "vitest";
import type { NativeOAuthStore } from "../oauth.js";
import { readCalendarChanges } from "./readers.js";
import { withNativeEventReadApi } from "./transport.js";
import type { NativeSourceReadContext } from "./worker.js";

const scope = { userId: "synthetic-owner", spaceId: "synthetic-space" },
  NOW = new Date("2026-10-18T10:00:00Z"),
  READ = "https://www.googleapis.com/auth/calendar.events.readonly";
function setup() {
  const emitted: unknown[] = [];
  const context: NativeSourceReadContext = {
    scope,
    row: {
      id: "trigger-a",
      routineId: "routine-a",
      connectionId: "connection-a",
      authorizationRevision: "auth-a",
      grantId: "grant-a",
      authGeneration: 1,
      configId: "config-a",
      configRevision: 1,
      kind: "calendar.event_changed",
      resourceType: "calendar",
      resourceId: "primary",
      spec: { kind: "calendar.event_changed", calendarId: "primary", target: { kind: "calendar" } },
      version: 1,
      armedAt: new Date(NOW.getTime() - 3600000),
      state: {},
      nextPollAt: NOW,
      leaseId: "lease-a",
      leaseUntil: new Date(NOW.getTime() + 120000),
    },
    signal: new AbortController().signal,
    heartbeat: async () => {},
    emit: async (event) => {
      emitted.push(event);
      return true;
    },
  };
  type Authorization = Awaited<ReturnType<NativeOAuthStore["authorization"]>>;
  const live = {
    connection: {
      id: "connection-a",
      ...scope,
      connectorId: "native",
      provider: "google-calendar",
      metadata: { authRevision: "auth-a" },
    },
    config: {
      id: "config-a",
      revision: 1,
      config: { scopes: [READ], capabilities: [], knowledgeBaseIds: [] },
    },
    grant: { id: "grant-a", authGeneration: 1, scopes: [READ] },
    auth: { tokens: { accessToken: "synthetic-access" }, identity: { tenant: null, context: {} } },
  } as unknown as Authorization;
  return { context, live, emitted };
}
test("actual HTTP410 class/status reaches Calendar cursor reset through fenced native transport", async () => {
  const { context, live, emitted } = setup();
  const baseline = await readCalendarChanges(
    context,
    {
      get: async () => ({ kind: "calendar#events", items: [], nextSyncToken: "expired-cursor" }),
      queryNotionDataSource: async () => {
        throw new Error("unexpected");
      },
    },
    NOW,
  );
  context.row.state = baseline.state;
  const calls: URL[] = [];
  const result = await withNativeEventReadApi(
    { authorization: async () => structuredClone(live) },
    context,
    (api) => readCalendarChanges(context, api, NOW),
    {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (input) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        calls.push(url);
        return calls.length === 1
          ? new Response(JSON.stringify({ error: { message: "synthetic expired" } }), {
              status: 410,
            })
          : new Response(
              JSON.stringify({
                kind: "calendar#events",
                items: [{ id: "preexisting" }],
                nextSyncToken: "rebuilt-cursor",
              }),
            );
      },
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.searchParams.get("syncToken"), "expired-cursor");
  assert.equal(calls[1]!.searchParams.has("syncToken"), false);
  assert.equal(emitted.length, 0);
  assert.equal(
    (result.state.calendarChanged as Record<string, unknown>).syncToken,
    "rebuilt-cursor",
  );
});
test("native event transport rechecks generation before each request and permits ordinary token rotation", async () => {
  for (const changeGeneration of [false, true]) {
    const { context, live } = setup();
    let checks = 0,
      requests = 0;
    const run = () =>
      withNativeEventReadApi(
        {
          authorization: async () => {
            checks++;
            if (checks === 3) {
              if (changeGeneration) live.grant.authGeneration = 2;
              else live.auth.tokens.accessToken = "synthetic-rotated";
            }
            return structuredClone(live);
          },
        },
        context,
        async (api) => {
          await api.get("/calendars/primary/events");
          await api.get("/calendars/primary/events");
          return true;
        },
        {
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
          fetch: async () => {
            requests++;
            return new Response("{}");
          },
        },
      );
    if (changeGeneration) {
      await assert.rejects(run());
      assert.equal(requests, 1);
    } else {
      assert.equal(await run(), true);
      assert.equal(requests, 2);
    }
  }
});
