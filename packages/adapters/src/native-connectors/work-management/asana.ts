import { collaborationActions, object, segment, select } from "../collaboration-action.js";
import contract from "./asana.contract.json" with { type: "json" };
import { authorize, cursorResult, gid, nonempty, offsetQuery, sameId } from "./helpers.js";

const TASK = [
  "gid",
  "resource_type",
  "name",
  "notes",
  "completed",
  "completed_at",
  "modified_at",
  "created_at",
  "due_on",
  "due_at",
  "assignee",
  "projects",
  "workspace",
  "parent",
  "permalink_url",
];
export const asanaActions = collaborationActions(
  contract.actions,
  async (args, run) => {
    const id = run.definition.id;
    if (
      [
        "asana.workspaces.list",
        "asana.projects.list",
        "asana.tasks.list",
        "asana.stories.list",
      ].includes(id)
    ) {
      const workspace = id === "asana.workspaces.list",
        projects = id === "asana.projects.list",
        tasks = id === "asana.tasks.list";
      const fields = workspace
        ? ["gid", "name", "resource_type", "is_organization"]
        : projects
          ? ["gid", "name", "resource_type", "archived", "permalink_url", "workspace"]
          : tasks
            ? TASK
            : [
                "gid",
                "resource_type",
                "resource_subtype",
                "text",
                "created_at",
                "created_by",
                "type",
                "is_pinned",
              ];
      const path = workspace
        ? "/workspaces"
        : projects
          ? `/workspaces/${segment(args.workspace_gid)}/projects`
          : tasks
            ? `/projects/${segment(args.project_gid)}/tasks`
            : `/tasks/${segment(args.task_gid)}/stories`;
      const body = object(
        (
          await run.request({
            method: "GET",
            path,
            query: {
              ...offsetQuery(args),
              ...select(args, projects ? ["archived"] : tasks ? ["completed_since"] : []),
              opt_fields: fields.join(","),
            },
          })
        ).body,
      );
      return run.finish(cursorResult(body, args, fields, "asana"));
    }
    const path = `/tasks/${segment(args.task_gid)}`;
    if (id === "asana.tasks.get")
      return run.finish(
        sameId(
          gid(
            object(
              (await run.request({ method: "GET", path, query: { opt_fields: TASK.join(",") } }))
                .body,
            ).data,
            TASK,
          ),
          args.task_gid,
          "gid",
        ),
      );
    const create = id === "asana.tasks.create",
      comment = id === "asana.comments.create";
    const data = comment
      ? { text: args.text }
      : create
        ? select(args, ["workspace", "name", "notes", "projects", "assignee", "due_on"])
        : nonempty(args.changes);
    const row = gid(
      object(
        (
          await run.request(
            {
              method: create || comment ? "POST" : "PUT",
              path: comment ? `${path}/stories` : create ? "/tasks" : path,
              body: { data },
            },
            true,
          )
        ).body,
      ).data,
      comment
        ? ["gid", "resource_type", "resource_subtype", "text", "created_at", "created_by"]
        : TASK,
    );
    if (!create && !comment) sameId(row, args.task_gid, "gid");
    return run.finish(row, { resource_id: String(row.gid) });
  },
  authorize,
);
