import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Data } from "./common.js";
import type { EnterpriseEventObservation, EnterpriseEventSpec } from "./readers.js";
import { readEnterpriseEvent } from "./readers.js";

const now = new Date("2026-10-18T03:00:00Z"),
  feishu = { kind: "feishu.calendar_event.changed", calendarId: "calendar-fixture" } as const,
  ding = {
    kind: "dingtalk.calendar_event.changed",
    userId: "user-fixture",
    calendarId: "calendar-fixture",
    timeMin: "2026-10-01T00:00:00Z",
    timeMax: "2026-11-01T00:00:00Z",
  } as const,
  wecom = { kind: "wecom.schedule.changed", calendarId: "calendar-fixture" } as const;
function setup(
  spec: EnterpriseEventSpec,
  responses: unknown[],
  state?: Data,
  options: { accept?: boolean; fingerprint?: string } = {},
) {
  const emitted: EnterpriseEventObservation[] = [],
    calls: Array<{ method: string; path: string; args: unknown }> = [];
  let beats = 0;
  async function reply(method: string, path: string, args: unknown) {
    calls.push({ method, path, args });
    assert.ok(responses.length, "Unexpected source HTTP");
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r;
  }
  const promise = readEnterpriseEvent(
    {
      spec,
      state,
      fingerprint: options.fingerprint ?? "fixture-generation",
      signal: AbortSignal.timeout(10000),
      heartbeat: async () => {
        beats++;
      },
      emit: async (o) => {
        emitted.push(o);
        return options.accept !== false;
      },
      now,
    },
    { get: (p, q) => reply("GET", p, q), post: (p, b) => reply("POST", p, b) },
  );
  return {
    promise,
    emitted,
    calls,
    get beats() {
      return beats;
    },
  };
}
const fs = (summary = "Fixture", extra: Data = {}) => ({
    code: 0,
    data: {
      items: [
        {
          event_id: "event-fixture",
          summary,
          status: "confirmed",
          start_time: { timestamp: "1800000000" },
          end_time: { timestamp: "1800003600" },
        },
      ],
      has_more: false,
      ...extra,
    },
  }),
  ds = (updateTime = "2026-10-17T03:00:00Z", extra: Data = {}) => ({
    events: [{ id: "event-fixture", updateTime }],
    ...extra,
  }),
  ws = (summary = "Fixture") => ({
    errcode: 0,
    schedule_list: [
      {
        schedule_id: "schedule-fixture",
        cal_id: "calendar-fixture",
        summary,
        start_time: 1800000000,
        end_time: 1800003600,
      },
    ],
  });
async function baseline(spec: EnterpriseEventSpec, responses: unknown[]) {
  const run = setup(spec, responses);
  const result = await run.promise;
  assert.equal(run.emitted.length, 0);
  return result.state;
}
describe("Enterprise narrow existing-Routine readers", () => {
  for (const [name, spec, responses] of [
    ["Feishu", feishu, [fs()]],
    ["DingTalk", ding, [ds()]],
    ["WeCom", wecom, [ws(), { errcode: 0, schedule_list: [] }]],
  ] as const)
    it(`${name} creates silent initial baseline without historical events`, async () => {
      const run = setup(spec, [...responses]);
      const result = await run.promise;
      assert.equal(run.emitted.length, 0);
      assert.equal(result.nextPollAt.toISOString(), "2026-10-18T03:01:00.000Z");
      assert.ok(run.beats > 0);
      assert.ok(result.state.enterprise);
    });
  it("Feishu drains all pages before emitting and uses trustworthy observation time", async () => {
    const state = await baseline(feishu, [fs()]);
    const run = setup(
      feishu,
      [
        fs("changed", { has_more: true, page_token: "next" }),
        { code: 0, data: { items: [], has_more: false } },
      ],
      state,
    );
    await run.promise;
    assert.equal(run.calls.length, 2);
    assert.equal((run.calls[1]!.args as Data).page_token, "next");
    assert.equal((run.calls[0]!.args as Data).anchor_time, "1");
    assert.equal((run.calls[1]!.args as Data).anchor_time, "1");
    assert.equal((run.calls[0]!.args as Data).start_time, undefined);
    assert.equal(run.emitted.length, 1);
    assert.equal(run.emitted[0]?.occurredAt, now.toISOString());
    assert.deepEqual(run.emitted[0]?.metadata, {
      calendarId: "calendar-fixture",
      eventId: "event-fixture",
      status: "confirmed",
    });
  });
  it("DingTalk binds the selected window and actual event update time", async () => {
    const state = await baseline(ding, [ds()]);
    const run = setup(ding, [ds("2026-10-18T02:59:00Z")], state);
    await run.promise;
    assert.equal((run.calls[0]!.args as Data).timeMin, ding.timeMin);
    assert.equal(run.emitted[0]?.occurredAt, "2026-10-18T02:59:00.000Z");
  });
  it("WeCom keeps paging after a short page until an explicit empty page", async () => {
    const run = setup(wecom, [
      ws(),
      {
        errcode: 0,
        schedule_list: [{ schedule_id: "second", cal_id: "calendar-fixture", summary: "Second" }],
      },
      { errcode: 0, schedule_list: [] },
    ]);
    await run.promise;
    assert.deepEqual(
      run.calls.map((c) => (c.args as Data).offset),
      [0, 1, 2],
    );
    assert.ok(
      run.calls.every((c) => c.method === "POST" && c.path === "/oa/schedule/get_by_calendar"),
    );
  });
  it("WeCom rejects another calendar before advancing or emitting", async () => {
    const state = await baseline(wecom, [ws(), { errcode: 0, schedule_list: [] }]);
    const run = setup(
      wecom,
      [
        {
          errcode: 0,
          schedule_list: [{ schedule_id: "schedule-fixture", cal_id: "other-calendar" }],
        },
      ],
      state,
    );
    await assert.rejects(run.promise);
    assert.equal(run.emitted.length, 0);
  });
  it("repeated pagination cursor is incomplete and emits nothing", async () => {
    const state = await baseline(feishu, [fs()]);
    const run = setup(
      feishu,
      [
        fs("changed", { has_more: true, page_token: "again" }),
        fs("changed", { has_more: true, page_token: "again" }),
      ],
      state,
    );
    await assert.rejects(run.promise);
    assert.equal(run.emitted.length, 0);
  });
  it("a failed later page cannot emit partial observations", async () => {
    const state = await baseline(ding, [ds()]);
    const run = setup(
      ding,
      [ds("2026-10-18T02:00:00Z", { nextToken: "next" }), new Error("fixture network failure")],
      state,
    );
    await assert.rejects(run.promise);
    assert.equal(run.emitted.length, 0);
  });
  it("failed durable emission preserves prior state and deterministic retry event identity", async () => {
    const state = await baseline(feishu, [fs()]),
      before = structuredClone(state);
    const failed = setup(feishu, [fs("changed")], state, { accept: false });
    await assert.rejects(failed.promise);
    assert.deepEqual(state, before);
    const retry = setup(feishu, [fs("changed")], state);
    await retry.promise;
    assert.equal(failed.emitted[0]?.eventIdentity, retry.emitted[0]?.eventIdentity);
  });
  it("content changes A to B to A to B retain distinct persisted observation sequences", async () => {
    let state = await baseline(feishu, [fs("A")]);
    const ids: string[] = [];
    for (const value of ["B", "A", "B"]) {
      const run = setup(feishu, [fs(value)], state);
      state = (await run.promise).state;
      ids.push(run.emitted[0]!.eventIdentity);
    }
    assert.equal(new Set(ids).size, 3);
  });
  it("unchanged snapshot emits nothing and incomplete visibility does not imply deletion", async () => {
    let state = await baseline(feishu, [fs()]);
    const absent = setup(feishu, [{ code: 0, data: { items: [], has_more: false } }], state);
    state = (await absent.promise).state;
    assert.equal(absent.emitted.length, 0);
    const restored = setup(feishu, [fs()], state);
    await restored.promise;
    assert.equal(restored.emitted.length, 0);
  });
  it("new account/source generation silently rebaselines instead of replaying old source state", async () => {
    const state = await baseline(feishu, [fs()]);
    const run = setup(feishu, [fs("changed")], state, { fingerprint: "another-generation" });
    await run.promise;
    assert.equal(run.emitted.length, 0);
  });
  it("invalid selected DingTalk time window is rejected without HTTP", async () => {
    const run = setup({ ...ding, timeMax: ding.timeMin }, []);
    await assert.rejects(run.promise);
    assert.equal(run.calls.length, 0);
  });
  it("Feishu missing completion flag does not create a baseline", async () => {
    const run = setup(feishu, [{ code: 0, data: { items: [] } }]);
    await assert.rejects(run.promise);
    assert.equal(run.emitted.length, 0);
  });
  it("logical provider auth expiry is not misread as an empty calendar", async () => {
    const run = setup(wecom, [{ errcode: 42001, schedule_list: [] }]);
    await assert.rejects(
      run.promise,
      (e: unknown) => (e as { kind: string }).kind === "authorization_expired",
    );
  });
});
