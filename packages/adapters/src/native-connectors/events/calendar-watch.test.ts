import assert from "node:assert/strict";
import { test } from "vitest";
import { NativeActionError } from "../action.js";
import { ensureCalendarChannel } from "./calendar-watch.js";
import type { NativeSourceReadContext } from "./worker.js";
import { nativeSourceRetry } from "./worker.js";

const NOW = Date.parse("2026-10-18T10:00:00Z");
function fixture(state: Record<string, unknown> = {}) {
  const saved: Record<string, unknown>[] = [];
  const context = { row: { id: "trigger-a", version: 1, state } } as NativeSourceReadContext;
  const persist = async (value: Record<string, unknown>) => {
    saved.push(structuredClone(value));
  };
  return { context, saved, persist };
}
test("Calendar channel persists pending before watch, trusts actual expiration, and never stores token", async () => {
  const f = fixture();
  let requestedId = "";
  await ensureCalendarChannel(
    f.context,
    {
      watch: async (input) => {
        requestedId = input.id;
        assert.equal(f.saved.length, 1);
        const pending = (f.saved[0]!.calendarChannels as Array<Record<string, unknown>>)[0]!;
        assert.equal(pending.phase, "pending");
        assert.equal(JSON.stringify(pending).includes(input.token), false);
        assert.equal(input.address, "https://api.example.test/api/connectors/events/calendar");
        return {
          kind: "api#channel",
          id: input.id,
          resourceId: "r",
          resourceUri: "https://www.googleapis.com/calendar/v3/calendars/real/events",
          expiration: String(NOW + 3600000),
        };
      },
      stop: async () => {
        throw new Error("Unexpected stop");
      },
    },
    "https://api.example.test",
    f.persist,
    NOW,
  );
  const last = f.saved.at(-1)!,
    channel = (last.calendarChannels as Array<Record<string, unknown>>)[0]!;
  assert.equal(channel.id, requestedId);
  assert.equal(channel.phase, "active");
  assert.equal(channel.expiration, NOW + 3600000);
  assert.equal(last.delivery, "watch_and_poll");
});
test("Calendar renew confirms new channel before stopping old; failed stop keeps safe overlap", async () => {
  const old = {
      id: "old",
      tokenHash: "synthetic",
      phase: "active",
      resourceId: "old-resource",
      resourceUri: "https://www.googleapis.com/calendar/v3/calendars/real/events",
      expiration: NOW + 60000,
      requestedAt: NOW - 1000,
    },
    f = fixture({ calendarChannels: [old] });
  let watched = false;
  await ensureCalendarChannel(
    f.context,
    {
      watch: async (input) => {
        watched = true;
        assert.equal((f.saved[0]!.calendarChannels as unknown[]).length, 2);
        return {
          kind: "api#channel",
          id: input.id,
          resourceId: "new-resource",
          resourceUri: old.resourceUri,
          expiration: NOW + 3600000,
        };
      },
      stop: async (input) => {
        assert.equal(watched, true);
        assert.equal(input.id, "old");
        throw new Error("synthetic stop unavailable");
      },
    },
    "https://api.example.test",
    f.persist,
    NOW,
  );
  const channels = f.saved.at(-1)!.calendarChannels as Array<Record<string, unknown>>;
  assert.equal(channels.length, 2);
  assert.equal(channels.find((item) => item.id === "old")?.phase, "retiring");
});
test("Calendar ambiguous watch keeps old channel and compensation; missing actual expiration never claims watch ready", async () => {
  for (const missing of [false, true]) {
    const f = fixture();
    let stops = 0;
    await ensureCalendarChannel(
      f.context,
      {
        watch: async (input) => {
          if (!missing)
            throw new NativeActionError("result_unknown", "synthetic uncertain", {
              uncertain: true,
            });
          return {
            kind: "api#channel",
            id: input.id,
            resourceId: "resource",
            resourceUri: "https://www.googleapis.com/calendar/v3/calendars/real/events",
          };
        },
        stop: async () => {
          stops++;
        },
      },
      "https://api.example.test",
      f.persist,
      NOW,
    );
    assert.notEqual(f.saved.at(-1)!.delivery, "watch_and_poll");
    assert.equal(stops, missing ? 1 : 0);
  }
});
test("local HTTP deployment stays explicit polling-only without a watch request", async () => {
  const f = fixture();
  await ensureCalendarChannel(
    f.context,
    {
      watch: async () => {
        throw new Error("Unexpected watch");
      },
      stop: async () => {
        throw new Error("Unexpected stop");
      },
    },
    "http://127.0.0.1:3100",
    f.persist,
    NOW,
  );
  assert.equal(
    (f.context.row.state as Record<string, unknown>).delivery,
    "polling_only_no_public_https",
  );
  assert.equal(f.saved.length, 0);
});
test("source retry preserves cursor and honors upstream Retry-After without retaining body", () => {
  const retry = nativeSourceRetry(
    { ready: true, calendarChanged: { syncToken: "synthetic-cursor" } },
    new NativeActionError("rate_limited", "PRIVATE-BODY", { retryAfterSeconds: 3600 }),
    new Date(NOW),
  );
  assert.equal(retry.nextPollAt.getTime(), NOW + 3600000);
  assert.deepEqual(retry.state.calendarChanged, { syncToken: "synthetic-cursor" });
  assert.equal(retry.state.lastErrorCode, "rate_limited");
  assert.equal(JSON.stringify(retry.state).includes("PRIVATE-BODY"), false);
});
