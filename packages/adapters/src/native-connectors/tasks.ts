import type { NativeActionContext, NativeRequest } from "./action.js";
import { NativeActionError } from "./action.js";
import contract from "./tasks.contract.json" with { type: "json" };
import type { Obj, WorkspaceImplementation } from "./workspace-google.js";
import {
  enc,
  googleCall,
  identity,
  invalid,
  object,
  workspaceActions,
  workspaceWrite,
} from "./workspace-google.js";

const path = (args: Obj) => `/lists/${enc(args.tasklistId)}/tasks`;
const taskPath = (args: Obj) => `${path(args)}/${enc(args.taskId)}`;
function task(value: unknown, expected?: unknown): Obj {
  return identity(value, "id", expected);
}
async function read(args: Obj, context: NativeActionContext, id = args.taskId): Promise<Obj> {
  return task(await googleCall(context, { method: "GET", path: `${path(args)}/${enc(id)}` }), id);
}
function date(value: unknown): string | null {
  if (value === null) return null;
  const day = String(value);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  )
    return invalid("Use a valid date without a time for Google Tasks.");
  return `${day}T00:00:00.000Z`;
}
function changes(args: Obj): Obj {
  const output = { ...args };
  if (args.dueDate !== undefined) {
    output.due = date(args.dueDate);
    delete output.dueDate;
  }
  return output;
}
async function preflight(args: Obj, context: NativeActionContext): Promise<Obj> {
  const current = await read(args, context);
  if (typeof current.etag !== "string" || current.etag !== args.expectedEtag)
    throw new NativeActionError("version_conflict", "The task changed since the approved read.");
  return current;
}
async function position(
  args: Obj,
  context: NativeActionContext,
): Promise<NonNullable<NativeRequest["query"]>> {
  const query: NonNullable<NativeRequest["query"]> = {};
  if (args.parent !== undefined) {
    if (args.parent === args.taskId) invalid("A task cannot be its own parent.");
    const parent = await read(args, context, args.parent);
    if (parent.parent || parent.assignmentInfo || parent.deleted)
      invalid("Choose an ordinary top-level parent task; assigned tasks cannot have subtasks.");
    query.parent = String(args.parent);
  }
  if (args.previous !== undefined) {
    if (args.previous === args.taskId || args.previous === args.parent)
      invalid("Choose a different previous sibling task.");
    const previous = await read(args, context, args.previous);
    if ((previous.parent ?? undefined) !== args.parent || previous.deleted)
      invalid("The previous task must be a sibling under the selected parent.");
    query.previous = String(args.previous);
  }
  return query;
}
async function page(args: Obj, context: NativeActionContext, tasklists: boolean): Promise<Obj> {
  const query: NonNullable<NativeRequest["query"]> = {
    maxResults: (args.maxResults as number) ?? 100,
  };
  if (!tasklists)
    Object.assign(query, { showCompleted: true, showHidden: true, showDeleted: false });
  for (const key of [
    "pageToken",
    ...(tasklists ? [] : ["showCompleted", "showHidden", "showDeleted", "updatedMin"]),
  ])
    if (args[key] !== undefined) query[key] = args[key] as string | boolean;
  const body = object(
    await googleCall(context, {
      method: "GET",
      path: tasklists ? "/users/@me/lists" : path(args),
      query,
    }),
  );
  if (
    (body.items !== undefined && !Array.isArray(body.items)) ||
    (body.nextPageToken !== undefined &&
      (typeof body.nextPageToken !== "string" ||
        !body.nextPageToken ||
        body.nextPageToken === args.pageToken))
  )
    throw new NativeActionError("incomplete_response", "Google returned an invalid task page.");
  return {
    items: ((body.items ?? []) as unknown[]).map((value) => task(value)),
    ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    hasMore: Boolean(body.nextPageToken),
    allPagesRead: !args.pageToken && !body.nextPageToken,
  };
}
const implementations: Record<string, WorkspaceImplementation> = {
  "tasks.tasklists.list": (args, context) => page(args, context, true),
  "tasks.tasklists.create": (args, context) =>
    workspaceWrite(
      "tasks.tasklists.create",
      args,
      context,
      async () => ({ method: "POST", path: "/users/@me/lists", body: { title: args.title } }),
      (value) => ({ tasklist: task(value), outcome: "succeeded" }),
      (output) => ({ tasklistId: object(output.tasklist).id }),
    ),
  "tasks.tasks.list": (args, context) => page(args, context, false),
  "tasks.tasks.get": async (args, context) => ({ task: await read(args, context) }),
  "tasks.tasks.create": (args, context) =>
    workspaceWrite(
      "tasks.tasks.create",
      args,
      context,
      async () => {
        const body = changes(
          Object.fromEntries(
            ["title", "notes", "dueDate"]
              .filter((key) => args[key] !== undefined)
              .map((key) => [key, args[key]]),
          ),
        );
        const query = await position(args, context);
        return {
          method: "POST",
          path: path(args),
          ...(Object.keys(query).length ? { query } : {}),
          body,
        };
      },
      (value) => ({ task: task(value), outcome: "succeeded", atomicVersionPrecondition: false }),
      (output) => ({
        tasklistId: args.tasklistId,
        taskId: object(output.task).id,
        atomicVersionPrecondition: false,
      }),
    ),
  "tasks.tasks.update": (args, context) =>
    workspaceWrite(
      "tasks.tasks.update",
      args,
      context,
      async () => {
        await preflight(args, context);
        return {
          method: "PATCH",
          path: taskPath(args),
          headers: { "If-Match": String(args.expectedEtag) },
          body: changes(object(args.changes)),
        };
      },
      (value) => ({
        task: task(value, args.taskId),
        outcome: "succeeded",
        atomicVersionPrecondition: true,
      }),
      () => ({ tasklistId: args.tasklistId, taskId: args.taskId, atomicVersionPrecondition: true }),
    ),
  "tasks.tasks.move": (args, context) =>
    workspaceWrite(
      "tasks.tasks.move",
      args,
      context,
      async () => {
        const current = await preflight(args, context);
        if (current.assignmentInfo)
          invalid("Assigned tasks cannot be moved through this connector.");
        return {
          method: "POST",
          path: `${taskPath(args)}/move`,
          query: await position(args, context),
        };
      },
      (value) => ({
        task: task(value, args.taskId),
        outcome: "succeeded",
        atomicVersionPrecondition: false,
      }),
      () => ({
        tasklistId: args.tasklistId,
        taskId: args.taskId,
        atomicVersionPrecondition: false,
      }),
    ),
  "tasks.tasks.delete": (args, context) =>
    workspaceWrite(
      "tasks.tasks.delete",
      args,
      context,
      async () => {
        const current = await preflight(args, context);
        if (current.assignmentInfo)
          invalid(
            "Delete assigned tasks from their source application to avoid deleting the original task.",
          );
        return { method: "DELETE", path: taskPath(args) };
      },
      () => ({
        taskId: args.taskId,
        tasklistId: args.tasklistId,
        outcome: "deleted",
        atomicVersionPrecondition: false,
      }),
      () => ({
        tasklistId: args.tasklistId,
        taskId: args.taskId,
        atomicVersionPrecondition: false,
      }),
    ),
};
export const tasksActions = workspaceActions(contract, implementations);
export const TASKS_ACTIONS = tasksActions;
export const tasksContractVersion = contract.frozenAt;
