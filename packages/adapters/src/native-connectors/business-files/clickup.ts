import type { NativeAction } from "../action.js";
import { NativeActionError } from "../action.js";
import {
  array,
  identity,
  incomplete,
  object,
  segment,
  select,
  text,
} from "../collaboration-action.js";
import contract from "./clickup.contract.json" with { type: "json" };
import { authorize, businessActions, exact, page } from "./common.js";

export function createClickUpActions(): NativeAction[] {
  return businessActions(
    contract.actions,
    async (args, run) => {
      const id = run.definition.id,
        base = "/api/v2";
      const result = async (
        path: string,
        query?: Record<string, string | number | boolean | undefined>,
      ) => object((await run.request({ method: "GET", path, ...(query ? { query } : {}) })).body);
      if (id === "clickup.workspaces.list") {
        const body = await result(`${base}/team`),
          allowed = run.context.principal.context.workspaceIds;
        const rows = array(body.teams).map(identity);
        if (!Array.isArray(allowed) || rows.some((x) => !allowed.includes(String(x.id))))
          return incomplete("ClickUp returned a workspace outside this verified authorization.");
        return run.finish({ action_id: id, ...page(rows, null, true) });
      }
      if (id === "clickup.spaces.list") {
        const allowed = run.context.principal.context.workspaceIds;
        if (!Array.isArray(allowed) || !allowed.includes(args.workspaceId))
          throw new NativeActionError(
            "insufficient_scope",
            "This workspace was not authorized for this account.",
          );
        const body = await result(`${base}/team/${segment(args.workspaceId)}/space`, {
          archived: args.archived as boolean | undefined,
        });
        return run.finish({ action_id: id, ...page(body.spaces, null, true) });
      }
      if (id === "clickup.lists.list") {
        const body = await result(`${base}/${args.parentType}/${segment(args.parentId)}/list`, {
          archived: args.archived as boolean | undefined,
        });
        return run.finish({ action_id: id, ...page(body.lists, null, true) });
      }
      if (id === "clickup.tasks.list") {
        const current = Number(args.page ?? 0);
        const body = await result(`${base}/list/${segment(args.listId)}/task`, {
          page: current,
          include_closed: args.includeClosed as boolean | undefined,
          subtasks: args.includeSubtasks as boolean | undefined,
          include_markdown_description: true,
        });
        const tasks = array(body.tasks).map(identity);
        if (body.last_page !== undefined && typeof body.last_page !== "boolean")
          return incomplete("ClickUp returned invalid task page metadata.");
        const more = body.last_page === undefined ? tasks.length === 100 : !body.last_page;
        return run.finish({
          action_id: id,
          items: tasks,
          hasMore: more,
          nextPage: more ? current + 1 : null,
          allPagesRead: current === 0 && !more,
        });
      }
      const taskPath = `${base}/task/${segment(args.taskId)}`;
      if (id === "clickup.tasks.get")
        return run.finish({ action_id: id, task: exact(await result(taskPath), args.taskId) });
      if (id === "clickup.tasks.update") {
        const before = exact(await result(taskPath), args.taskId);
        if (text(before.date_updated) !== args.expectedDateUpdated)
          throw new NativeActionError("version_conflict", "This task changed after it was read.");
        const task = exact(
          (await run.request({ method: "PUT", path: taskPath, body: args.changes }, true)).body,
          args.taskId,
        );
        return run.finish(
          { action_id: id, task, concurrency_guarantee: "best_effort_precheck" },
          { resource_id: task.id },
        );
      }
      if (id === "clickup.tasks.create") {
        const task = identity(
          (
            await run.request(
              {
                method: "POST",
                path: `${base}/list/${segment(args.listId)}/task`,
                body: {
                  ...select(args, ["name", "description", "status", "assignees"]),
                  ...(args.dueDate === undefined ? {} : { due_date: args.dueDate }),
                  check_required_custom_fields: true,
                },
              },
              true,
            )
          ).body,
        );
        return run.finish({ action_id: id, task }, { resource_id: task.id });
      }
      const comment = identity(
        (
          await run.request(
            {
              method: "POST",
              path: `${taskPath}/comment`,
              body: { comment_text: args.text, notify_all: args.notifyAll ?? false },
            },
            true,
          )
        ).body,
      );
      return run.finish({ action_id: id, comment }, { resource_id: comment.id });
    },
    (def, ctx) => authorize("clickup", def, ctx),
  );
}
export const clickupActions = createClickUpActions();
