import type { NativeAction } from "../action.js";
import { NativeActionError } from "../action.js";
import {
  array,
  call,
  enterpriseActions,
  incomplete,
  invalid,
  named,
  nonempty,
  object,
  pick,
  segment,
  text,
} from "./common.js";
import contract from "./dingtalk.contract.json" with { type: "json" };

export function createDingtalkActions(): NativeAction[] {
  return enterpriseActions("dingtalk", contract.actions, async (args, run) => {
    const id = run.definition.id,
      calendars = `/v1.0/calendar/users/${segment(args.userId)}/calendars`,
      events = `${calendars}/${segment(args.calendarId)}/events`,
      event = `${events}/${segment(args.eventId)}`,
      tasks = `/v1.0/todo/users/${segment(args.unionId)}/tasks`,
      task = `${tasks}/${segment(args.taskId)}`;
    if (
      id.startsWith("dingtalk.tasks.") &&
      run.context.principal.context.actorType === "user" &&
      args.unionId !== run.context.principal.subject
    )
      throw new NativeActionError(
        "authorization_required",
        "Use this delegated user's verified union ID for To Do.",
      );
    if (id === "dingtalk.messages.send") {
      const body = await call(
        run,
        "dingtalk",
        {
          method: "POST",
          path: "/v1.0/robot/oToMessages/batchSend",
          body: {
            robotCode: text(run.context.principal.context.appId),
            userIds: args.userIds,
            msgKey: "sampleText",
            msgParam: JSON.stringify({ content: args.text }),
          },
        },
        true,
      );
      const processQueryKey = text(body.processQueryKey),
        invalidStaffIds = array(body.invalidStaffIdList ?? []),
        filteredStaffIds = array(body.filteredStaffIdList ?? []),
        flowControlledStaffIds = array(body.flowControlledStaffIdList ?? []);
      return run.finish(
        {
          processQueryKey,
          accepted: true,
          deliveryVerified: false,
          partial: !!(
            invalidStaffIds.length ||
            filteredStaffIds.length ||
            flowControlledStaffIds.length
          ),
          invalidStaffIds,
          filteredStaffIds,
          flowControlledStaffIds,
        },
        { resource_id: processQueryKey },
      );
    }
    if (id === "dingtalk.calendars.list") {
      const body = await call(run, "dingtalk", { method: "GET", path: calendars });
      return run.finish({
        items: array(object(body.response).calendars).map((row) => named(row, "id")),
      });
    }
    if (id === "dingtalk.events.list") {
      if (
        !Number.isFinite(Date.parse(String(args.timeMin))) ||
        !Number.isFinite(Date.parse(String(args.timeMax))) ||
        Date.parse(String(args.timeMin)) >= Date.parse(String(args.timeMax))
      )
        return invalid("Use a valid explicit calendar interval.");
      const body = await call(run, "dingtalk", {
        method: "GET",
        path: events,
        query: {
          timeMin: String(args.timeMin),
          timeMax: String(args.timeMax),
          maxResults: Number(args.maxResults ?? 50),
          nextToken: args.nextToken as string | undefined,
        },
      });
      if (body.nextToken !== undefined && typeof body.nextToken !== "string")
        return incomplete("DingTalk returned invalid pagination metadata.");
      return run.finish({
        items: array(body.events).map((row) => named(row, "id")),
        nextToken: body.nextToken || null,
      });
    }
    if (id === "dingtalk.events.get")
      return run.finish({
        event: named(
          await call(run, "dingtalk", { method: "GET", path: event }),
          "id",
          args.eventId,
        ),
      });
    if (id === "dingtalk.events.create" || id === "dingtalk.events.update") {
      if (id.endsWith("update")) {
        const current = named(
          await call(run, "dingtalk", { method: "GET", path: event }),
          "id",
          args.eventId,
        );
        if (current.updateTime !== args.expectedUpdateTime)
          throw new NativeActionError(
            "version_conflict",
            "This event changed after the approved read.",
          );
      }
      const body = nonempty(args, ["summary", "description", "start", "end"]);
      const result = named(
        await call(
          run,
          "dingtalk",
          {
            method: id.endsWith("create") ? "POST" : "PUT",
            path: id.endsWith("create") ? events : event,
            body,
          },
          true,
        ),
        "id",
        id.endsWith("update") ? args.eventId : undefined,
      );
      return run.finish(
        {
          event: result,
          concurrencyControl: "upstream-permissions-and-observed-version-preflight",
        },
        { resource_id: result.id },
      );
    }
    if (id === "dingtalk.tasks.get")
      return run.finish({
        task: named(await call(run, "dingtalk", { method: "GET", path: task }), "id", args.taskId),
      });
    if (id === "dingtalk.tasks.create") {
      const output = named(
        await call(
          run,
          "dingtalk",
          {
            method: "POST",
            path: tasks,
            body: {
              ...pick(args, ["subject", "description", "executorIds", "dueTime"]),
              creatorId: args.unionId,
              operatorId: args.unionId,
              sourceId: run.context.operationId,
            },
          },
          true,
        ),
        "id",
      );
      return run.finish({ task: output }, { resource_id: output.id });
    }
    if (id === "dingtalk.tasks.update") {
      const current = named(
        await call(run, "dingtalk", { method: "GET", path: task }),
        "id",
        args.taskId,
      );
      if (current.modifiedTime !== args.expectedModifiedTime)
        throw new NativeActionError(
          "version_conflict",
          "This task changed after the approved read.",
        );
      const body = nonempty(args, ["subject", "description", "done", "dueTime"]);
      const output = await call(
        run,
        "dingtalk",
        { method: "PUT", path: task, query: { operatorId: String(args.unionId) }, body },
        true,
      );
      if (output.result !== true) return run.unknown("DingTalk did not confirm the task update.");
      return run.finish(
        { taskId: args.taskId, acknowledged: true, resourceSnapshotCurrent: false },
        { resource_id: args.taskId },
      );
    }
    return incomplete("Missing frozen DingTalk action.");
  });
}
