import { createHash } from "node:crypto";
import { NativeActionError } from "../action.js";
import { collaborationActions, object, segment, select } from "../collaboration-action.js";
import { authorize, cursorQuery, cursorResult, nonempty, project, sameId } from "./helpers.js";
import contract from "./todoist.contract.json" with { type: "json" };

const TASK = [
  "id",
  "content",
  "description",
  "project_id",
  "section_id",
  "parent_id",
  "is_completed",
  "checked",
  "priority",
  "labels",
  "due",
  "deadline",
  "assignee_id",
  "creator_uid",
  "added_at",
  "updated_at",
  "completed_at",
  "url",
];
export const todoistActions = collaborationActions(
  contract.actions,
  async (args, run) => {
    const id = run.definition.id;
    if (id === "todoist.projects.list" || id === "todoist.tasks.list") {
      const projects = id === "todoist.projects.list";
      const body = object(
        (
          await run.request({
            method: "GET",
            path: projects ? "/projects" : "/tasks",
            query: {
              ...cursorQuery(args),
              ...select(args, ["project_id", "section_id", "parent_id"]),
            },
          })
        ).body,
      );
      return run.finish(
        cursorResult(
          body,
          args,
          projects
            ? [
                "id",
                "name",
                "description",
                "color",
                "parent_id",
                "is_favorite",
                "is_archived",
                "is_deleted",
                "url",
              ]
            : TASK,
          "todoist",
        ),
      );
    }
    const path = `/tasks/${segment(args.task_id)}`;
    if (id === "todoist.tasks.get")
      return run.finish(
        sameId(project((await run.request({ method: "GET", path })).body, TASK), args.task_id),
      );
    // Fixed-length UUID derived from the existing ExternalEffect. It does not authorize replay of an unknown write.
    const digest = createHash("sha256").update(run.context.operationId).digest("hex");
    const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const headers = { "X-Request-Id": uuid };
    if (id === "todoist.tasks.close" || id === "todoist.tasks.reopen") {
      const close = id === "todoist.tasks.close";
      await run.request(
        { method: "POST", path: `${path}/${close ? "close" : "reopen"}`, headers },
        true,
      );
      return run.finish(
        { task_id: args.task_id, closed: close, recurringBehavior: "provider_defined" },
        { resource_id: String(args.task_id) },
      );
    }
    const create = id === "todoist.tasks.create",
      comment = id === "todoist.comments.create";
    const body = comment
      ? select(args, ["task_id", "content"])
      : create
        ? select(args, [
            "content",
            "description",
            "project_id",
            "section_id",
            "parent_id",
            "due_string",
            "due_date",
            "priority",
            "labels",
          ])
        : nonempty(args.changes);
    if (body.due_string !== undefined && body.due_date !== undefined) {
      throw new NativeActionError("invalid_input", "Choose a date or natural-language due date.");
    }
    const row = project(
      (
        await run.request(
          { method: "POST", path: comment ? "/comments" : create ? "/tasks" : path, headers, body },
          true,
        )
      ).body,
      comment ? ["id", "task_id", "project_id", "content", "posted_at", "attachment"] : TASK,
    );
    if (!create && !comment) sameId(row, args.task_id);
    return run.finish(row, { resource_id: String(row.id) });
  },
  authorize,
);
