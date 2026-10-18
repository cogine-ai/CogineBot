import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { NativeActionError } from "../action.js";
import type { MicrosoftEventObservation, MicrosoftEventSpec } from "./readers.js";
import { readMicrosoftEvent } from "./readers.js";

const now = new Date("2026-10-18T02:00:00Z"),
  deltaPath = "/sites/site-fixture/lists/list-fixture/items/delta",
  delta = (token: string) => `https://graph.microsoft.com/v1.0${deltaPath}?token=${token}`;
const sp = {
  kind: "sharepoint.list_item.changed",
  siteId: "site-fixture",
  listId: "list-fixture",
} as const;
const ex = {
  kind: "excel.range.changed",
  driveId: "drive-fixture",
  itemId: "book-fixture",
  worksheetId: "sheet-fixture",
  address: "A1:B1",
} as const;
const pl = { kind: "planner.task.changed", planId: "plan-fixture" } as const;
const tm = {
  kind: "teams.channel_message.created",
  teamId: "team-fixture",
  channelId: "channel-fixture",
} as const;
const matrix = (value = 1) => ({
  address: "Sheet1!A1:B1",
  rowCount: 1,
  columnCount: 2,
  values: [[value, "Fixture"]],
  formulas: [[value, "Fixture"]],
  numberFormat: [["General", "General"]],
});
function setup(
  spec: MicrosoftEventSpec,
  values: Array<unknown | Error>,
  state?: Record<string, unknown>,
  fingerprint = "generation-fixture",
) {
  const emitted: MicrosoftEventObservation[] = [],
    requests: Array<{ path: string; query: unknown }> = [];
  const context = {
    spec,
    state,
    fingerprint,
    now,
    signal: AbortSignal.timeout(10000),
    async heartbeat() {},
    async emit(o: MicrosoftEventObservation) {
      emitted.push(o);
      return true;
    },
  };
  const api = {
    async get(path: string, query?: unknown) {
      requests.push({ path, query });
      assert.ok(values.length, `Unexpected event request ${path}`);
      const next = values.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { context, api, emitted, requests, values };
}
describe("Microsoft existing Routine reader adapters", () => {
  it("baselines a selected SharePoint list with token latest and emits no history", async () => {
    const s = setup(sp, [{ value: [], "@odata.deltaLink": delta("baseline") }]);
    const result = await readMicrosoftEvent(s.context, s.api);
    assert.equal(s.emitted.length, 0);
    assert.deepEqual(s.requests[0]?.query, { token: "latest" });
    assert.equal((result.state.microsoft as Record<string, unknown>).deltaLink, delta("baseline"));
  });
  it("waits for the final delta page, keeps last duplicate item state, and includes a deletion facet", async () => {
    const baseline = setup(sp, [{ value: [], "@odata.deltaLink": delta("baseline") }]);
    const state = (await readMicrosoftEvent(baseline.context, baseline.api)).state;
    const s = setup(
      sp,
      [
        { value: [{ id: "item-fixture", eTag: '"one"' }], "@odata.nextLink": delta("page2") },
        {
          value: [
            { id: "item-fixture", eTag: '"two"' },
            { id: "deleted-fixture", deleted: { state: "deleted" } },
          ],
          "@odata.deltaLink": delta("next"),
        },
      ],
      state,
    );
    const result = await readMicrosoftEvent(s.context, s.api);
    assert.equal(s.emitted.length, 2);
    assert.equal(s.emitted[0]?.observedVersion, '"two"');
    assert.equal(s.emitted[1]?.metadata.deleted, true);
    assert.equal((result.state.microsoft as Record<string, unknown>).deltaLink, delta("next"));
  });
  it("does not emit a partial delta or advance a cursor on a failed later page", async () => {
    const base = setup(sp, [{ value: [], "@odata.deltaLink": delta("baseline") }]);
    const state = (await readMicrosoftEvent(base.context, base.api)).state;
    const s = setup(
      sp,
      [
        { value: [{ id: "item-fixture", eTag: '"one"' }], "@odata.nextLink": delta("page2") },
        new Error("Fixture failure"),
      ],
      state,
    );
    await assert.rejects(readMicrosoftEvent(s.context, s.api));
    assert.equal(s.emitted.length, 0);
    assert.equal((state.microsoft as Record<string, unknown>).deltaLink, delta("baseline"));
  });
  it("rebaselines only an explicitly expired delta token, with no historical emission", async () => {
    const base = setup(sp, [{ value: [], "@odata.deltaLink": delta("baseline") }]);
    const state = (await readMicrosoftEvent(base.context, base.api)).state;
    const s = setup(
      sp,
      [
        new NativeActionError("resource_unavailable", "Expired", { recovery: { status: 410 } }),
        { value: [], "@odata.deltaLink": delta("newbaseline") },
      ],
      state,
    );
    await readMicrosoftEvent(s.context, s.api);
    assert.equal(s.emitted.length, 0);
    assert.deepEqual(s.requests[1]?.query, { token: "latest" });
  });
  it("rejects a delta continuation that changes selected list or host", async () => {
    const s = setup(sp, [
      { value: [], "@odata.nextLink": "https://example.test/steal?token=fixture" },
    ]);
    await assert.rejects(readMicrosoftEvent(s.context, s.api), { kind: "invalid_input" });
    assert.equal(s.requests.length, 1);
  });
  it("does not commit a cursor if durable emission rejects it", async () => {
    const base = setup(sp, [{ value: [], "@odata.deltaLink": delta("baseline") }]);
    const state = (await readMicrosoftEvent(base.context, base.api)).state;
    const s = setup(
      sp,
      [{ value: [{ id: "item-fixture", eTag: '"one"' }], "@odata.deltaLink": delta("next") }],
      state,
    );
    s.context.emit = async () => false;
    await assert.rejects(readMicrosoftEvent(s.context, s.api), { kind: "temporarily_unavailable" });
    assert.equal((state.microsoft as Record<string, unknown>).deltaLink, delta("baseline"));
  });
  it("emits an Excel range only after a complete prior content baseline", async () => {
    const base = setup(ex, [matrix()]);
    const state = (await readMicrosoftEvent(base.context, base.api)).state;
    assert.equal(base.emitted.length, 0);
    const same = setup(ex, [matrix()], state);
    await readMicrosoftEvent(same.context, same.api);
    assert.equal(same.emitted.length, 0);
    const changed = setup(ex, [matrix(2)], state);
    await readMicrosoftEvent(changed.context, changed.api);
    assert.equal(changed.emitted.length, 1);
    assert.equal(changed.emitted[0]?.metadata.fileId, "book-fixture");
  });
  it("does not emit a partial or oversized Excel range", async () => {
    for (const body of [
      { ...matrix(), values: [[1]] },
      { ...matrix(), rowCount: 100000 },
    ]) {
      const s = setup(ex, [body]);
      await assert.rejects(readMicrosoftEvent(s.context, s.api), { kind: "incomplete_response" });
      assert.equal(s.emitted.length, 0);
    }
  });
  it("baselines Planner and distinguishes visible created, updated and removed tasks after a complete scan", async () => {
    const base = setup(pl, [
      {
        value: [
          { id: "task-a", planId: "plan-fixture", "@odata.etag": '"a1"' },
          { id: "task-b", planId: "plan-fixture", "@odata.etag": '"b1"' },
        ],
      },
    ]);
    const state = (await readMicrosoftEvent(base.context, base.api)).state;
    const changed = setup(
      pl,
      [
        {
          value: [
            { id: "task-a", planId: "plan-fixture", "@odata.etag": '"a2"' },
            { id: "task-c", planId: "plan-fixture", "@odata.etag": '"c1"' },
          ],
        },
      ],
      state,
    );
    await readMicrosoftEvent(changed.context, changed.api);
    assert.deepEqual(
      changed.emitted.map((e) => e.metadata.change),
      ["updated", "created", "removed_from_visible_plan"],
    );
  });
  it("does not infer Planner deletion from a failed or cyclic page", async () => {
    const path = "/planner/plans/plan-fixture/tasks",
      url = `https://graph.microsoft.com/v1.0${path}?$skiptoken=fixture`;
    const s = setup(pl, [
      { value: [], "@odata.nextLink": url },
      { value: [], "@odata.nextLink": url },
    ]);
    await assert.rejects(readMicrosoftEvent(s.context, s.api), { kind: "incomplete_response" });
    assert.equal(s.emitted.length, 0);
  });
  it("fully pages Teams roots even when old threads with new replies precede new messages", async () => {
    const row = (id: string, date: string) => ({
      id,
      createdDateTime: date,
      channelIdentity: { teamId: "team-fixture", channelId: "channel-fixture" },
      replyToId: null,
      messageType: "message",
      deletedDateTime: null,
    });
    const base = setup(tm, [{ value: [row("old", "2026-10-17T01:00:00Z")] }]);
    const state = (await readMicrosoftEvent(base.context, base.api)).state;
    const path = "/teams/team-fixture/channels/channel-fixture/messages";
    const changed = setup(
      tm,
      [
        {
          value: [row("old", "2026-10-17T01:00:00Z")],
          "@odata.nextLink": `https://graph.microsoft.com/v1.0${path}?$skiptoken=fixture`,
        },
        { value: [row("new", "2026-10-18T01:00:00Z")] },
      ],
      state,
    );
    await readMicrosoftEvent(changed.context, changed.api);
    assert.equal(changed.requests.length, 2);
    assert.equal(changed.emitted.length, 1);
    assert.equal(changed.emitted[0]?.metadata.messageId, "new");
  });
  it("rebaselines when the exact account/grant generation fingerprint changes", async () => {
    const base = setup(ex, [matrix()]);
    const state = (await readMicrosoftEvent(base.context, base.api)).state;
    const changed = setup(ex, [matrix(2)], state, "new-authorization-generation");
    await readMicrosoftEvent(changed.context, changed.api);
    assert.equal(changed.emitted.length, 0);
  });
  it("assigns a new durable observation version when an Excel range returns to an earlier value", async () => {
    const baseline = setup(ex, [matrix(1)]);
    let state = (await readMicrosoftEvent(baseline.context, baseline.api)).state;
    const versions = [];
    for (const value of [2, 1, 2]) {
      const next = setup(ex, [matrix(value)], state);
      state = (await readMicrosoftEvent(next.context, next.api)).state;
      versions.push(next.emitted[0]!.eventIdentity);
    }
    assert.equal(new Set(versions).size, 3);
  });
});
