import type { NativeAction } from "../action.js";
import {
  array,
  call,
  enterpriseActions,
  epoch,
  incomplete,
  interval,
  named,
  page,
  pick,
  segment,
  text,
} from "./common.js";
import contract from "./feishu-lark.contract.json" with { type: "json" };

export function createFeishuActions(): NativeAction[] {
  return enterpriseActions("feishu-lark", contract.actions, async (args, run) => {
    const id = run.definition.id;
    if (id === "feishu.documents.content.get") {
      const data = await call(run, "feishu", {
        method: "GET",
        path: `/docx/v1/documents/${segment(args.documentId)}/raw_content`,
      });
      if (typeof data.content !== "string")
        return incomplete("Feishu omitted the document content.");
      return run.finish({ documentId: args.documentId, content: data.content });
    }
    if (id === "feishu.documents.create") {
      const data = await call(
        run,
        "feishu",
        {
          method: "POST",
          path: "/docx/v1/documents",
          body: {
            title: args.title,
            ...(args.folderToken ? { folder_token: args.folderToken } : {}),
          },
        },
        true,
      );
      const doc = named(data.document, "document_id");
      return run.finish({ document: doc }, { resource_id: doc.document_id });
    }
    if (id === "feishu.tasks.get")
      return run.finish({
        task: named(
          (
            await call(run, "feishu", {
              method: "GET",
              path: `/task/v2/tasks/${segment(args.taskGuid)}`,
            })
          ).task,
          "guid",
          args.taskGuid,
        ),
      });
    if (id === "feishu.tasks.create") {
      const data = await call(
        run,
        "feishu",
        {
          method: "POST",
          path: "/task/v2/tasks",
          body: {
            ...pick(args, ["summary", "description"]),
            ...(args.dueTimestamp
              ? { due: { timestamp: epoch(args.dueTimestamp), is_all_day: false } }
              : {}),
          },
        },
        true,
      );
      const task = named(data.task, "guid");
      return run.finish({ task }, { resource_id: task.guid });
    }
    if (id === "feishu.tasks.complete") {
      const completed_at = args.completed ? String(Date.now()) : "0";
      const data = await call(
        run,
        "feishu",
        {
          method: "PATCH",
          path: `/task/v2/tasks/${segment(args.taskGuid)}`,
          body: { task: { completed_at }, update_fields: ["completed_at"] },
        },
        true,
      );
      const task = named(data.task, "guid", args.taskGuid);
      if (task.completed_at !== completed_at)
        return run.unknown("Feishu did not confirm the requested task completion state.");
      return run.finish({ task }, { resource_id: task.guid });
    }
    if (id === "feishu.calendars.list")
      return run.finish(
        page(
          await call(run, "feishu", {
            method: "GET",
            path: "/calendar/v4/calendars",
            query: {
              page_size: Number(args.pageSize ?? 50),
              page_token: args.pageToken as string | undefined,
            },
          }),
          "calendar_list",
          "calendar_id",
        ),
      );
    if (id === "feishu.events.list") {
      interval(args.startTimestamp, args.endTimestamp);
      const limit = Number(args.pageSize ?? 50);
      const data = await call(run, "feishu", {
        method: "GET",
        path: `/calendar/v4/calendars/${segment(args.calendarId)}/events`,
        query: {
          start_time: epoch(args.startTimestamp),
          end_time: epoch(args.endTimestamp),
          page_size: limit,
        },
      });
      const items = array(data.items).map((value) => named(value, "event_id"));
      return run.finish({
        items,
        paginationSupported: false,
        nextPageToken: null,
        windowMayBeTruncated: data.has_more === true || items.length >= limit,
      });
    }

    if (id === "feishu.events.create") {
      interval(args.startTimestamp, args.endTimestamp);
      const data = await call(
        run,
        "feishu",
        {
          method: "POST",
          path: `/calendar/v4/calendars/${segment(args.calendarId)}/events`,
          body: {
            ...pick(args, ["summary", "description"]),
            start_time: { timestamp: epoch(args.startTimestamp), timezone: args.timeZone ?? "UTC" },
            end_time: { timestamp: epoch(args.endTimestamp), timezone: args.timeZone ?? "UTC" },
          },
        },
        true,
      );
      const event = named(data.event, "event_id");
      return run.finish({ calendarId: args.calendarId, event }, { resource_id: event.event_id });
    }
    if (id === "feishu.messages.send" || id === "feishu.messages.reply") {
      const request =
        id === "feishu.messages.send"
          ? {
              method: "POST" as const,
              path: "/im/v1/messages",
              query: { receive_id_type: String(args.receiveIdType) },
              body: {
                receive_id: args.receiveId,
                msg_type: "text",
                content: JSON.stringify({ text: args.text }),
                uuid: run.context.operationId,
              },
            }
          : {
              method: "POST" as const,
              path: `/im/v1/messages/${segment(args.messageId)}/reply`,
              body: {
                msg_type: "text",
                content: JSON.stringify({ text: args.text }),
                uuid: run.context.operationId,
              },
            };
      const message = named(await call(run, "feishu", request, true), "message_id");
      return run.finish(
        { message, accepted: true, deliveryVerified: false },
        { resource_id: text(message.message_id) },
      );
    }
    return incomplete("Missing frozen Feishu/Lark action.");
  });
}
