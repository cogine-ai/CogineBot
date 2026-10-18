import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { NativeActionContext, NativeRequest, NativeResponse } from "../action.js";
import { logicalError } from "./common.js";
import { enterpriseApps } from "./index.js";

const actions = enterpriseApps.flatMap((a) => a.actions),
  find = (id: string) => {
    const action = actions.find((a) => a.id === id);
    assert.ok(action, id);
    return action;
  };
const ok = (body: unknown, status = 200): NativeResponse => ({
  status,
  body,
  headers: new Headers(),
});
const setup = (app: string, values: Array<NativeResponse | Error>, actor = "app") => {
  const requests: NativeRequest[] = [],
    checkpoints: Record<string, unknown>[] = [];
  const context: NativeActionContext = {
    operationId: "fixture-operation",
    signal: AbortSignal.timeout(10000),
    principal: {
      subject: actor === "user" ? "union-fixture" : "app-fixture",
      tenant: "tenant-fixture",
      scopes: ["docx:document", "task:task:write", "calendar:calendar", "im:message"],
      capabilities: [],
      knowledgeBaseIds: [],
      context: {
        provider: app,
        appId: "client-fixture",
        tenantId: "tenant-fixture",
        actorType: actor,
        credentialType: actor === "user" ? "oauth" : "machine_key",
        region: "feishu",
        agentId: "1000001",
      },
    },
    async checkpoint(v) {
      checkpoints.push(structuredClone(v));
    },
    async request(r) {
      requests.push(structuredClone(r));
      assert.ok(values.length, `Unexpected ${r.method} ${r.path}`);
      const v = values.shift()!;
      if (v instanceof Error) throw v;
      return v;
    },
    async callMcp() {
      throw new Error("No MCP");
    },
    async readArtifact() {
      throw new Error("No artifact");
    },
    async validateResourceUrl() {},
  };
  return { context, requests, checkpoints, values };
};
const fs = (data: unknown) => ok({ code: 0, data }),
  wx = (body: Record<string, unknown> = {}) => ok({ errcode: 0, ...body });
const date = { dateTime: "2026-10-18T01:00:00Z", timeZone: "UTC" };
const fixtures = [
  {
    app: "feishu-lark",
    id: "feishu.documents.content.get",
    args: { documentId: "doc-fixture" },
    responses: [fs({ content: "Fixture document" })],
    paths: ["GET /docx/v1/documents/doc-fixture/raw_content"],
  },
  {
    app: "feishu-lark",
    id: "feishu.documents.create",
    args: { title: "Fixture" },
    responses: [fs({ document: { document_id: "doc-created" } })],
    paths: ["POST /docx/v1/documents"],
  },
  {
    app: "feishu-lark",
    id: "feishu.tasks.get",
    args: { taskGuid: "task-fixture" },
    responses: [fs({ task: { guid: "task-fixture" } })],
    paths: ["GET /task/v2/tasks/task-fixture"],
  },
  {
    app: "feishu-lark",
    id: "feishu.tasks.create",
    args: { summary: "Fixture" },
    responses: [fs({ task: { guid: "task-created" } })],
    paths: ["POST /task/v2/tasks"],
  },
  {
    app: "feishu-lark",
    id: "feishu.tasks.complete",
    args: { taskGuid: "task-fixture", completed: false },
    responses: [fs({ task: { guid: "task-fixture", completed_at: "0" } })],
    paths: ["PATCH /task/v2/tasks/task-fixture"],
  },
  {
    app: "feishu-lark",
    id: "feishu.calendars.list",
    args: {},
    responses: [fs({ calendar_list: [{ calendar_id: "calendar-fixture" }], has_more: false })],
    paths: ["GET /calendar/v4/calendars"],
  },
  {
    app: "feishu-lark",
    id: "feishu.events.list",
    args: {
      calendarId: "calendar-fixture",
      startTimestamp: "1792285200",
      endTimestamp: "1792288800",
    },
    responses: [fs({ items: [{ event_id: "event-fixture" }], has_more: false })],
    paths: ["GET /calendar/v4/calendars/calendar-fixture/events"],
  },
  {
    app: "feishu-lark",
    id: "feishu.events.create",
    args: {
      calendarId: "calendar-fixture",
      summary: "Fixture",
      startTimestamp: "1792285200",
      endTimestamp: "1792288800",
    },
    responses: [fs({ event: { event_id: "event-created" } })],
    paths: ["POST /calendar/v4/calendars/calendar-fixture/events"],
  },
  {
    app: "feishu-lark",
    id: "feishu.messages.send",
    args: { receiveId: "chat-fixture", receiveIdType: "chat_id", text: "Fixture" },
    responses: [fs({ message_id: "message-created" })],
    paths: ["POST /im/v1/messages"],
  },
  {
    app: "feishu-lark",
    id: "feishu.messages.reply",
    args: { messageId: "message-fixture", text: "Fixture" },
    responses: [fs({ message_id: "reply-created" })],
    paths: ["POST /im/v1/messages/message-fixture/reply"],
  },
  {
    app: "dingtalk",
    id: "dingtalk.messages.send",
    args: { userIds: ["user-fixture"], text: "Fixture" },
    responses: [
      ok({
        processQueryKey: "process-fixture",
        invalidStaffIdList: [],
        filteredStaffIdList: [],
        flowControlledStaffIdList: [],
      }),
    ],
    paths: ["POST /v1.0/robot/oToMessages/batchSend"],
  },
  {
    app: "dingtalk",
    id: "dingtalk.calendars.list",
    args: { userId: "user-fixture" },
    responses: [ok({ response: { calendars: [{ id: "calendar-fixture" }] } })],
    paths: ["GET /v1.0/calendar/users/user-fixture/calendars"],
  },
  {
    app: "dingtalk",
    id: "dingtalk.events.list",
    args: {
      userId: "user-fixture",
      calendarId: "calendar-fixture",
      timeMin: "2026-10-18T00:00:00Z",
      timeMax: "2026-10-19T00:00:00Z",
    },
    responses: [ok({ events: [{ id: "event-fixture" }], nextToken: "" })],
    paths: ["GET /v1.0/calendar/users/user-fixture/calendars/calendar-fixture/events"],
  },
  {
    app: "dingtalk",
    id: "dingtalk.events.get",
    args: { userId: "user-fixture", calendarId: "calendar-fixture", eventId: "event-fixture" },
    responses: [ok({ id: "event-fixture" })],
    paths: [
      "GET /v1.0/calendar/users/user-fixture/calendars/calendar-fixture/events/event-fixture",
    ],
  },
  {
    app: "dingtalk",
    id: "dingtalk.events.create",
    args: {
      userId: "user-fixture",
      calendarId: "calendar-fixture",
      summary: "Fixture",
      start: date,
      end: { ...date, dateTime: "2026-10-18T02:00:00Z" },
    },
    responses: [ok({ id: "event-created" })],
    paths: ["POST /v1.0/calendar/users/user-fixture/calendars/calendar-fixture/events"],
  },
  {
    app: "dingtalk",
    id: "dingtalk.events.update",
    args: {
      userId: "user-fixture",
      calendarId: "calendar-fixture",
      eventId: "event-fixture",
      expectedUpdateTime: "2026-10-18T00:00:00Z",
      summary: "Updated",
    },
    responses: [
      ok({ id: "event-fixture", updateTime: "2026-10-18T00:00:00Z" }),
      ok({ id: "event-fixture" }),
    ],
    paths: [
      "GET /v1.0/calendar/users/user-fixture/calendars/calendar-fixture/events/event-fixture",
      "PUT /v1.0/calendar/users/user-fixture/calendars/calendar-fixture/events/event-fixture",
    ],
  },
  {
    app: "dingtalk",
    id: "dingtalk.tasks.get",
    args: { unionId: "union-fixture", taskId: "task-fixture" },
    responses: [ok({ id: "task-fixture" })],
    paths: ["GET /v1.0/todo/users/union-fixture/tasks/task-fixture"],
  },
  {
    app: "dingtalk",
    id: "dingtalk.tasks.create",
    args: { unionId: "union-fixture", subject: "Fixture", executorIds: ["union-fixture"] },
    responses: [ok({ id: "task-created" })],
    paths: ["POST /v1.0/todo/users/union-fixture/tasks"],
  },
  {
    app: "dingtalk",
    id: "dingtalk.tasks.update",
    args: {
      unionId: "union-fixture",
      taskId: "task-fixture",
      expectedModifiedTime: 100,
      done: true,
    },
    responses: [ok({ id: "task-fixture", modifiedTime: 100 }), ok({ result: true })],
    paths: [
      "GET /v1.0/todo/users/union-fixture/tasks/task-fixture",
      "PUT /v1.0/todo/users/union-fixture/tasks/task-fixture",
    ],
  },
  {
    app: "wecom",
    id: "wecom.members.get",
    args: { userId: "user-fixture" },
    responses: [wx({ userid: "user-fixture" })],
    paths: ["GET /user/get"],
  },
  {
    app: "wecom",
    id: "wecom.messages.send",
    args: { userIds: ["user-fixture"], text: "Fixture" },
    responses: [wx({ msgid: "message-created", invaliduser: "" })],
    paths: ["POST /message/send"],
  },
  {
    app: "wecom",
    id: "wecom.calendars.create",
    args: { summary: "Fixture", admins: ["user-fixture"] },
    responses: [wx({ cal_id: "calendar-created" })],
    paths: ["POST /oa/calendar/add"],
  },
  {
    app: "wecom",
    id: "wecom.calendars.get",
    args: { calendarId: "calendar-fixture" },
    responses: [wx({ calendar_list: [{ cal_id: "calendar-fixture" }] })],
    paths: ["POST /oa/calendar/get"],
  },
  {
    app: "wecom",
    id: "wecom.schedules.get",
    args: { scheduleId: "schedule-fixture" },
    responses: [wx({ schedule_list: [{ schedule_id: "schedule-fixture" }] })],
    paths: ["POST /oa/schedule/get"],
  },
  {
    app: "wecom",
    id: "wecom.schedules.create",
    args: { calendarId: "calendar-fixture", summary: "Fixture", startTime: 100, endTime: 200 },
    responses: [wx({ schedule_id: "schedule-created" })],
    paths: ["POST /oa/schedule/add"],
  },
  {
    app: "wecom",
    id: "wecom.schedules.update",
    args: { scheduleId: "schedule-fixture", summary: "Updated" },
    responses: [
      wx({
        schedule_list: [
          {
            schedule_id: "schedule-fixture",
            start_time: 100,
            end_time: 200,
            reminders: { is_repeat: 0 },
          },
        ],
      }),
      wx(),
    ],
    paths: ["POST /oa/schedule/get", "POST /oa/schedule/update"],
  },
  {
    app: "wecom",
    id: "wecom.schedules.cancel",
    args: { scheduleId: "schedule-fixture" },
    responses: [
      wx({
        schedule_list: [
          {
            schedule_id: "schedule-fixture",
            start_time: 100,
            end_time: 200,
            reminders: { is_repeat: 0 },
          },
        ],
      }),
      wx(),
    ],
    paths: ["POST /oa/schedule/get", "POST /oa/schedule/del"],
  },
];
describe("Enterprise exact provider action contracts", () => {
  it("registers all frozen core actions", () => {
    assert.equal(actions.length, 27);
    assert.deepEqual(actions.map((a) => a.id).sort(), fixtures.map((f) => f.id).sort());
  });
  for (const f of fixtures) {
    it(`${f.id} implements the real provider method`, async () => {
      const s = setup(
        f.app,
        f.responses.map((r) => ({
          ...r,
          body: structuredClone(r.body),
          headers: new Headers(r.headers),
        })),
      );
      const result = await find(f.id).execute(f.args, s.context);
      assert.ok(result && typeof result === "object");
      assert.deepEqual(
        s.requests.map((r) => `${r.method} ${r.path}`),
        f.paths,
      );
      assert.equal(s.values.length, 0);
      if (!find(f.id).readOnly) {
        assert.equal(s.checkpoints.at(-1)?.complete, true);
        const retry = setup(f.app, []);
        retry.context.recovery = s.checkpoints.at(-1);
        const recovered = (await find(f.id).execute(f.args, retry.context)) as Record<
          string,
          unknown
        >;
        assert.equal(recovered.recovered_from_exact_ack, true);
        assert.equal(retry.requests.length, 0);
      }
    });
    it(`${f.id} rejects a changed enterprise identity before HTTP`, async () => {
      const s = setup(f.app, []);
      s.context.principal.context.tenantId = "another-tenant";
      await assert.rejects(find(f.id).execute(f.args, s.context), {
        kind: "authorization_required",
      });
      assert.equal(s.requests.length, 0);
    });
  }
  it("never treats a Feishu bot scope as permission to send as a user", async () => {
    const s = setup("feishu-lark", [], "user");
    s.context.principal.scopes = ["im:message:send_as_bot"];
    await assert.rejects(
      find("feishu.messages.send").execute(
        { receiveId: "chat-fixture", receiveIdType: "chat_id", text: "Fixture" },
        s.context,
      ),
      { kind: "insufficient_scope" },
    );
  });
  it("reports partial WeCom recipient acceptance without claiming delivery", async () => {
    const s = setup("wecom", [wx({ msgid: "message-created", invaliduser: "user-two" })]);
    const out = (await find("wecom.messages.send").execute(
      { userIds: ["user-one", "user-two"], text: "Fixture" },
      s.context,
    )) as Record<string, unknown>;
    assert.equal(out.partial, true);
    assert.equal(out.deliveryVerified, false);
  });
  for (const user of ["@all", "user-one|user-two"])
    it(`rejects an injected broadcast target ${user}`, async () => {
      const s = setup("wecom", []);
      await assert.rejects(
        find("wecom.messages.send").execute({ userIds: [user], text: "Fixture" }, s.context),
        { kind: "invalid_input" },
      );
      assert.equal(s.requests.length, 0);
    });
  it("requires an explicit recurrence operation before cancelling a whole repeating series", async () => {
    const s = setup("wecom", [
      wx({ schedule_list: [{ schedule_id: "schedule-fixture", reminders: { is_repeat: 1 } }] }),
    ]);
    await assert.rejects(
      find("wecom.schedules.cancel").execute({ scheduleId: "schedule-fixture" }, s.context),
      { kind: "invalid_input" },
    );
    assert.equal(s.requests.length, 1);
  });
  it("does not silently discard missing Feishu pagination metadata", async () => {
    const s = setup("feishu-lark", [fs({ calendar_list: [] })]);
    await assert.rejects(find("feishu.calendars.list").execute({}, s.context), {
      kind: "incomplete_response",
    });
  });
  it("does not pretend Feishu time-window results are pageable", async () => {
    const s = setup("feishu-lark", [
      fs({ items: [{ event_id: "event-fixture" }], has_more: true }),
    ]);
    const result = (await find("feishu.events.list").execute(
      {
        calendarId: "calendar-fixture",
        startTimestamp: "1792285200",
        endTimestamp: "1792288800",
        pageSize: 50,
      },
      s.context,
    )) as Record<string, unknown>;
    assert.equal(result.paginationSupported, false);
    assert.equal(result.windowMayBeTruncated, true);
    assert.equal(result.nextPageToken, null);
    assert.equal(s.requests[0]?.query?.page_token, undefined);
  });
  it("rejects Feishu time-window page token before HTTP", async () => {
    const s = setup("feishu-lark", []);
    await assert.rejects(
      find("feishu.events.list").execute(
        {
          calendarId: "calendar-fixture",
          startTimestamp: "1792285200",
          endTimestamp: "1792288800",
          pageToken: "not-supported",
        },
        s.context,
      ),
      { kind: "invalid_input" },
    );
    assert.equal(s.requests.length, 0);
  });
  it("WeCom title edits preserve overwrite fields and skip unchanged attendees", async () => {
    const reminders = {
      is_remind: 1,
      is_repeat: 1,
      repeat_type: 1,
      repeat_until: 2000000000,
      remind_time_diffs: [-300],
      timezone: 8,
    };
    const s = setup("wecom", [
      wx({
        schedule_list: [
          {
            schedule_id: "schedule-fixture",
            start_time: 100,
            end_time: 200,
            summary: "Before",
            description: "Keep description",
            location: "Keep location",
            is_whole_day: 0,
            admins: ["admin-fixture"],
            attendees: [{ userid: "keep-user", response_status: 1 }],
            reminders,
          },
        ],
      }),
      wx(),
    ]);
    await find("wecom.schedules.update").execute(
      { scheduleId: "schedule-fixture", summary: "After", operationMode: 0 },
      s.context,
    );
    const body = s.requests[1]!.body as Record<string, unknown>,
      schedule = body.schedule as Record<string, unknown>;
    assert.equal(body.skip_attendees, 1);
    assert.equal(schedule.attendees, undefined);
    assert.equal(schedule.start_time, 100);
    assert.equal(schedule.end_time, 200);
    assert.equal(schedule.description, "Keep description");
    assert.equal(schedule.location, "Keep location");
    assert.deepEqual(schedule.reminders, reminders);
    assert.deepEqual(schedule.admins, ["admin-fixture"]);
    assert.equal(schedule.summary, "After");
    assert.equal(schedule.cal_id, undefined);
  });
  it("WeCom recurring occurrence edits record the actual split resource and preserve occurrence duration", async () => {
    const s = setup("wecom", [
      wx({
        schedule_list: [
          {
            schedule_id: "schedule-fixture",
            start_time: 100,
            end_time: 200,
            summary: "Before",
            reminders: { is_repeat: 1, repeat_type: 1 },
          },
        ],
      }),
      wx({ schedule_id: "split-fixture" }),
    ]);
    const out = (await find("wecom.schedules.update").execute(
      {
        scheduleId: "schedule-fixture",
        summary: "Changed occurrence",
        operationMode: 1,
        operationStartTime: 1000,
      },
      s.context,
    )) as Record<string, unknown>;
    assert.equal(out.scheduleId, "split-fixture");
    assert.equal(out.originalScheduleId, "schedule-fixture");
    assert.equal(s.checkpoints.at(-1)?.resource_id, "split-fixture");
    const schedule = (s.requests[1]!.body as Record<string, unknown>).schedule as Record<
      string,
      unknown
    >;
    assert.equal(schedule.start_time, 1000);
    assert.equal(schedule.end_time, 1100);
  });
  it("WeCom attendee changes explicitly replace only the requested attendee set", async () => {
    const s = setup("wecom", [
      wx({
        schedule_list: [
          {
            schedule_id: "schedule-fixture",
            start_time: 100,
            end_time: 200,
            attendees: [{ userid: "before" }],
          },
        ],
      }),
      wx(),
    ]);
    await find("wecom.schedules.update").execute(
      { scheduleId: "schedule-fixture", attendeeIds: ["after"] },
      s.context,
    );
    const body = s.requests[1]!.body as Record<string, unknown>;
    assert.equal(body.skip_attendees, 0);
    assert.deepEqual((body.schedule as Record<string, unknown>).attendees, [{ userid: "after" }]);
  });
  it("WeCom recurring split without returned resource ID has an unknown write outcome", async () => {
    const s = setup("wecom", [
      wx({
        schedule_list: [
          {
            schedule_id: "schedule-fixture",
            start_time: 100,
            end_time: 200,
            reminders: { is_repeat: 1 },
          },
        ],
      }),
      wx(),
    ]);
    await assert.rejects(
      find("wecom.schedules.update").execute(
        {
          scheduleId: "schedule-fixture",
          summary: "Changed",
          operationMode: 2,
          operationStartTime: 1000,
        },
        s.context,
      ),
      { kind: "result_unknown" },
    );
  });
  it("WeCom recurrence controls cannot shift a non-repeating schedule", async () => {
    const s = setup("wecom", [
      wx({
        schedule_list: [
          {
            schedule_id: "schedule-fixture",
            start_time: 100,
            end_time: 200,
            reminders: { is_repeat: 0 },
          },
        ],
      }),
    ]);
    await assert.rejects(
      find("wecom.schedules.update").execute(
        {
          scheduleId: "schedule-fixture",
          summary: "Changed",
          operationMode: 1,
          operationStartTime: 1000,
        },
        s.context,
      ),
      { kind: "invalid_input" },
    );
    assert.equal(s.requests.length, 1);
  });
  it("WeCom update cannot move an event to another calendar", async () => {
    const s = setup("wecom", []);
    await assert.rejects(
      find("wecom.schedules.update").execute(
        { scheduleId: "schedule-fixture", calendarId: "other-calendar" },
        s.context,
      ),
      { kind: "invalid_input" },
    );
    assert.equal(s.requests.length, 0);
  });
  it("Feishu configured egress-IP rejection is not a retryable rate limit", () => {
    assert.throws(() => logicalError("feishu", { code: 99991401 }), { kind: "not_configured" });
    assert.throws(() => logicalError("feishu", { code: 99991400 }), { kind: "rate_limited" });
  });
  it("preserves an uncertain enterprise write and blocks same-effect replay", async () => {
    const s = setup("wecom", [new Error("Fixture lost response")]);
    const input = { userIds: ["user-fixture"], text: "Fixture" };
    await assert.rejects(find("wecom.messages.send").execute(input, s.context), {
      kind: "result_unknown",
    });
    const retry = setup("wecom", []);
    retry.context.recovery = s.checkpoints.at(-1);
    await assert.rejects(find("wecom.messages.send").execute(input, retry.context), {
      kind: "result_unknown",
    });
    assert.equal(retry.requests.length, 0);
  });
});
