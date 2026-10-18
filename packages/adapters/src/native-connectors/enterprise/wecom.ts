import type { NativeAction } from "../action.js";
import type { CollaborationRun, Data } from "./common.js";
import {
  array,
  call,
  enterpriseActions,
  incomplete,
  invalid,
  named,
  object,
  pick,
  text,
} from "./common.js";
import contract from "./wecom.contract.json" with { type: "json" };

function userId(value: unknown): string {
  const id = text(value);
  if (id === "@all" || /[|\r\n]/.test(id))
    return invalid("Select one explicit organization user ID; broadcast targets are unavailable.");
  return id;
}
async function schedule(run: CollaborationRun, id: unknown): Promise<Data> {
  const body = await call(run, "wecom", {
    method: "POST",
    path: "/oa/schedule/get",
    body: { schedule_id_list: [id] },
  });
  const rows = array(body.schedule_list);
  if (rows.length !== 1) return incomplete("WeCom omitted the selected application schedule.");
  return named(rows[0], "schedule_id", id);
}
function scheduleBody(args: Data): Data {
  const body: Data = {};
  for (const [input, field] of [
    ["summary", "summary"],
    ["description", "description"],
    ["startTime", "start_time"],
    ["endTime", "end_time"],
    ["calendarId", "cal_id"],
  ])
    if (args[input!] !== undefined) body[field!] = args[input!];
  if (args.attendeeIds)
    body.attendees = (args.attendeeIds as unknown[]).map((id) => ({ userid: userId(id) }));
  if (args.admins) body.admins = (args.admins as unknown[]).map(userId);
  if (
    body.start_time !== undefined &&
    body.end_time !== undefined &&
    Number(body.start_time) >= Number(body.end_time)
  )
    return invalid("The schedule end must follow its start.");
  return body;
}
// WeCom updates overwrite the schedule. Preserve supported non-edited fields from the exact pre-read.
function overwriteSchedule(current: Data, args: Data, mode: number): Data {
  const start = current.start_time,
    end = current.end_time;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    Number(start) < 0 ||
    Number(end) <= Number(start)
  )
    return incomplete("WeCom omitted the current schedule interval; no overwrite was sent.");
  const merged = pick(current, ["admins", "summary", "description", "location", "is_whole_day"]);
  if (current.reminders !== undefined)
    merged.reminders = pick(object(current.reminders), [
      "is_remind",
      "is_repeat",
      "remind_before_event_secs",
      "remind_time_diffs",
      "repeat_type",
      "repeat_until",
      "is_custom_repeat",
      "repeat_interval",
      "repeat_day_of_week",
      "repeat_day_of_month",
      "timezone",
    ]);
  // A recurring split addresses the selected occurrence, not the historical master start.
  merged.start_time = mode === 0 ? start : args.operationStartTime;
  merged.end_time =
    mode === 0 ? end : Number(args.operationStartTime) + Number(end) - Number(start);
  Object.assign(merged, scheduleBody(args));
  if (
    !Number.isSafeInteger(merged.start_time) ||
    !Number.isSafeInteger(merged.end_time) ||
    Number(merged.start_time) < 0 ||
    Number(merged.end_time) > 4294967295 ||
    Number(merged.start_time) >= Number(merged.end_time)
  )
    return invalid("Use a valid schedule interval within the supported Unix timestamp range.");
  return merged;
}
export function createWeComActions(): NativeAction[] {
  return enterpriseActions("wecom", contract.actions, async (args, run) => {
    const id = run.definition.id,
      agent = Number(run.context.principal.context.agentId);
    if (!Number.isSafeInteger(agent) || agent < 1)
      return invalid("Select the verified WeCom application agent ID.");
    if (id === "wecom.members.get") {
      const member = named(
        await call(run, "wecom", {
          method: "GET",
          path: "/user/get",
          query: { userid: userId(args.userId) },
        }),
        "userid",
      );
      if (text(member.userid).toLowerCase() !== text(args.userId).toLowerCase())
        return incomplete("WeCom returned a different organization member.");
      return run.finish({ member });
    }
    if (id === "wecom.messages.send") {
      if (Buffer.byteLength(String(args.text), "utf8") > 2048)
        return invalid("WeCom text messages support at most 2,048 UTF-8 bytes.");
      const body = await call(
        run,
        "wecom",
        {
          method: "POST",
          path: "/message/send",
          body: {
            agentid: agent,
            touser: (args.userIds as unknown[]).map(userId).join("|"),
            msgtype: "text",
            text: { content: args.text },
          },
        },
        true,
      );
      const msgid = text(body.msgid),
        invalidUsers =
          typeof body.invaliduser === "string" ? body.invaliduser.split("|").filter(Boolean) : [],
        unlicensedUsers =
          typeof body.unlicenseduser === "string"
            ? body.unlicenseduser.split("|").filter(Boolean)
            : [];
      return run.finish(
        {
          messageId: msgid,
          accepted: true,
          deliveryVerified: false,
          partial: !!(invalidUsers.length || unlicensedUsers.length),
          invalidUsers,
          unlicensedUsers,
        },
        { resource_id: msgid },
      );
    }
    if (id === "wecom.calendars.create") {
      const admins = (args.admins as unknown[]).map(userId);
      const body = await call(
        run,
        "wecom",
        {
          method: "POST",
          path: "/oa/calendar/add",
          body: {
            calendar: {
              summary: args.summary,
              color: args.color ?? "#0000FF",
              ...pick(args, ["description"]),
              admins,
              shares: admins.map((userid) => ({ userid, permission: 1 })),
            },
            agentid: agent,
          },
        },
        true,
      );
      const calendarId = text(body.cal_id);
      return run.finish(
        { calendarId, failures: body.fail_result ?? null },
        { resource_id: calendarId },
      );
    }
    if (id === "wecom.calendars.get") {
      const body = await call(run, "wecom", {
        method: "POST",
        path: "/oa/calendar/get",
        body: { cal_id_list: [args.calendarId] },
      });
      const rows = array(body.calendar_list);
      if (rows.length !== 1) return incomplete("WeCom omitted the selected application calendar.");
      return run.finish({ calendar: named(rows[0], "cal_id", args.calendarId) });
    }
    if (id === "wecom.schedules.get")
      return run.finish({ schedule: await schedule(run, args.scheduleId) });
    if (id === "wecom.schedules.create") {
      const body = await call(
        run,
        "wecom",
        {
          method: "POST",
          path: "/oa/schedule/add",
          body: { schedule: scheduleBody(args), agentid: agent },
        },
        true,
      );
      const scheduleId = text(body.schedule_id);
      return run.finish({ scheduleId, calendarId: args.calendarId }, { resource_id: scheduleId });
    }
    if (id === "wecom.schedules.update" || id === "wecom.schedules.cancel") {
      const current = await schedule(run, args.scheduleId),
        recurring = object(current.reminders ?? {}).is_repeat === 1;
      if (recurring && args.operationMode === undefined)
        return invalid(
          "Choose whether this repeating schedule change affects this occurrence, future occurrences or the full series.",
        );
      const mode = Number(args.operationMode ?? 0);
      if (!recurring && mode !== 0)
        return invalid(
          "This schedule does not repeat; edit the full schedule without a recurrence operation.",
        );
      if (
        ![0, 1, 2].includes(mode) ||
        ([1, 2].includes(mode) && !Number.isSafeInteger(args.operationStartTime))
      )
        return invalid(
          "Include the exact occurrence start for an occurrence or future-series change.",
        );
      const control = {
        op_mode: mode,
        ...(mode === 0 ? {} : { op_start_time: args.operationStartTime }),
      };
      const changed = scheduleBody(args);
      if (id.endsWith("update") && !Object.keys(changed).length)
        return invalid("Select at least one schedule field to change.");
      const body = id.endsWith("cancel")
        ? { schedule_id: args.scheduleId, ...control }
        : {
            schedule: { schedule_id: args.scheduleId, ...overwriteSchedule(current, args, mode) },
            skip_attendees: args.attendeeIds === undefined ? 1 : 0,
            ...control,
          };
      const result = await call(
        run,
        "wecom",
        {
          method: "POST",
          path: id.endsWith("cancel") ? "/oa/schedule/del" : "/oa/schedule/update",
          body,
        },
        true,
      );
      const actualId =
        id.endsWith("update") && result.schedule_id !== undefined
          ? text(result.schedule_id)
          : mode !== 0 && id.endsWith("update")
            ? incomplete("WeCom omitted the new schedule ID produced by the recurring split.")
            : text(args.scheduleId);
      return run.finish(
        {
          scheduleId: actualId,
          originalScheduleId: args.scheduleId,
          atomicConcurrencyControl: false,
          acknowledged: true,
          resourceSnapshotCurrent: false,
          operationMode: mode,
        },
        { resource_id: actualId },
      );
    }
    return incomplete("Missing frozen WeCom action.");
  });
}
