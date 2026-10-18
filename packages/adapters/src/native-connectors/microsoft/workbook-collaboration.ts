import type { NativeAction, NativeRequest } from "../action.js";
import { NativeActionError } from "../action.js";
import type { CollaborationRun } from "../collaboration-action.js";
import excelContract from "./excel.contract.json" with { type: "json" };
import type { Data } from "./graph.js";
import {
  array,
  changes,
  get,
  graphActions,
  ifMatch,
  incomplete,
  invalid,
  list,
  object,
  odataString,
  page,
  pageRequest,
  resource,
  segment,
  text,
  write,
} from "./graph.js";
import plannerContract from "./planner.contract.json" with { type: "json" };
import teamsContract from "./teams.contract.json" with { type: "json" };

function rectangle(value: unknown): { rows: number; columns: number } {
  const address = text(value).toUpperCase(),
    match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/.exec(
      address,
    );
  if (!match)
    return invalid(
      "Select a bounded A1 cell or rectangular A1:B10 range within the chosen worksheet.",
    );
  const column = (letters: string) =>
    [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
  const c1 = column(match[1]!),
    c2 = column(match[3] ?? match[1]!),
    r1 = Number(match[2]),
    r2 = Number(match[4] ?? match[2]);
  if (c2 < c1 || r2 < r1 || c2 > 16384 || r2 > 1048576 || (r2 - r1 + 1) * (c2 - c1 + 1) > 10000)
    return invalid("Select at most 10,000 cells in one worksheet range.");
  return { rows: r2 - r1 + 1, columns: c2 - c1 + 1 };
}
function matrix(
  value: unknown,
  shape?: { rows: number; columns: number },
  formula = false,
): unknown[][] {
  const rows = array(value).map(array);
  if (
    !rows.length ||
    !rows[0]!.length ||
    rows.length * rows[0]!.length > 10000 ||
    rows.some((row) => row.length !== rows[0]!.length) ||
    (shape && (rows.length !== shape.rows || rows[0]!.length !== shape.columns)) ||
    (formula && rows.some((row) => row.some((cell) => cell !== null && typeof cell !== "string")))
  )
    return invalid(
      "Use a rectangular matrix matching the selected range, with at most 10,000 cells.",
    );
  return rows;
}
async function workbookSession(run: CollaborationRun, base: string): Promise<string> {
  // A session is not an independent user effect. No mutation of workbook cells occurs here.
  const response = await run.request({
    method: "POST",
    path: `${base}/createSession`,
    body: { persistChanges: !run.definition.readOnly },
  });
  if (response.status === 202)
    throw new NativeActionError(
      "temporarily_unavailable",
      "Microsoft is still opening this workbook. No workbook change was sent.",
    );
  return text(object(response.body).id);
}
export function createExcelActions(): NativeAction[] {
  return graphActions(excelContract.actions, async (args, run) => {
    const id = run.definition.id,
      base = `/drives/${segment(args.driveId)}/items/${segment(args.itemId)}/workbook`,
      sheet = `${base}/worksheets/${segment(args.worksheetId)}`,
      table = `${base}/tables/${segment(args.tableId)}`;
    const shape =
      id.startsWith("excel.ranges.") || id === "excel.tables.create"
        ? rectangle(args.address)
        : undefined;
    const session = await workbookSession(run, base),
      headers = { "workbook-session-id": session };
    const original = run.context.request;
    const sessionContext = {
      ...run.context,
      request: (request: NativeRequest) =>
        original({ ...request, headers: { ...request.headers, ...headers } }),
    };
    run.context.request = sessionContext.request;
    try {
      if (id === "excel.worksheets.list" || id === "excel.tables.list") {
        const path = `${base}/${id === "excel.worksheets.list" ? "worksheets" : "tables"}`;
        const request =
          args.cursor === undefined ? { method: "GET" as const, path } : pageRequest(path, args);
        return run.finish(page((await run.request(request)).body, path));
      }
      if (id === "excel.ranges.get") {
        const range = await get(run, `${sheet}/range(address=${odataString(args.address)})`);
        if (
          typeof range.address !== "string" ||
          !Number.isSafeInteger(range.rowCount) ||
          !Number.isSafeInteger(range.columnCount) ||
          range.rowCount !== shape!.rows ||
          range.columnCount !== shape!.columns
        )
          return incomplete("Microsoft omitted the complete selected range dimensions.");
        matrix(range.values, shape);
        matrix(range.formulas, shape);
        return run.finish(range);
      }
      if (id === "excel.rows.list")
        return run.finish(
          page(
            (await run.request(pageRequest(`${table}/rows`, args))).body,
            `${table}/rows`,
            (value) => {
              const row = object(value);
              if (!Number.isSafeInteger(row.index) || Number(row.index) < 0)
                return incomplete("Microsoft omitted a table row index.");
              matrix(row.values);
              return row;
            },
          ),
        );
      if (id === "excel.ranges.update") {
        if ((args.values === undefined) === (args.formulas === undefined))
          return invalid("Choose either values or formulas for one range update.");
        const key = args.values !== undefined ? "values" : "formulas",
          body = { [key]: matrix(args[key], shape, key === "formulas") };
        const response = object(
          (
            await run.request(
              {
                method: "PATCH",
                path: `${sheet}/range(address=${odataString(args.address)})`,
                headers,
                body,
              },
              true,
            )
          ).body,
        );
        if (
          typeof response.address !== "string" ||
          response.rowCount !== shape!.rows ||
          response.columnCount !== shape!.columns
        )
          return run.unknown(
            "Microsoft acknowledged a range edit without the selected range dimensions.",
          );
        return run.finish({ ...response, workbookId: args.itemId }, { resource_id: args.itemId });
      }
      if (id === "excel.rows.append") {
        const response = object(
          (
            await run.request(
              {
                method: "POST",
                path: `${table}/rows/add`,
                headers,
                body: { values: matrix(args.values), index: null },
              },
              true,
            )
          ).body,
        );
        // Workbook rows use index, not a resource id.
        if (
          typeof response.index !== "number" ||
          !Number.isSafeInteger(response.index) ||
          response.index < 0 ||
          !Array.isArray(response.values)
        )
          return run.unknown("Microsoft omitted the acknowledged appended row index and values.");
        return run.finish(
          { ...response, workbookId: args.itemId, tableId: args.tableId },
          { resource_id: args.itemId },
        );
      }
      if (id === "excel.tables.create")
        return await write(run, {
          method: "POST",
          path: `${sheet}/tables/add`,
          headers,
          body: { address: args.address, hasHeaders: args.hasHeaders },
        });
      if (id === "excel.worksheets.create")
        return await write(run, {
          method: "POST",
          path: `${base}/worksheets/add`,
          headers,
          body: { name: args.name },
        });
      return incomplete("Missing frozen Excel action.");
    } finally {
      run.context.request = original;
      // Closing a session must not erase a confirmed business-write receipt or trigger replay.
      try {
        await run.request({ method: "POST", path: `${base}/closeSession`, headers });
      } catch {
        /* Session expires upstream; preserve the primary outcome. */
      }
    }
  });
}
const plannerKeys = [
  "title",
  "bucketId",
  "percentComplete",
  "priority",
  "dueDateTime",
  "startDateTime",
  "assignments",
] as const;
function plannerChanges(args: Data): Data {
  const body = changes(args, plannerKeys);
  if (body.assignments)
    body.assignments = Object.fromEntries(
      Object.entries(object(body.assignments)).map(([id, assigned]) => [
        id,
        assigned === true
          ? { "@odata.type": "#microsoft.graph.plannerAssignment", orderHint: " !" }
          : null,
      ]),
    );
  for (const key of ["dueDateTime", "startDateTime"])
    if (body[key] && !Number.isFinite(Date.parse(String(body[key]))))
      return invalid("Use a valid ISO timestamp for Planner task dates.");
  return body;
}
export function createPlannerActions(): NativeAction[] {
  return graphActions(plannerContract.actions, async (args, run) => {
    const id = run.definition.id,
      task = `/planner/tasks/${segment(args.taskId)}`;
    if (id === "planner.plans.list")
      return list(run, `/groups/${segment(args.groupId)}/planner/plans`, args);
    if (id === "planner.buckets.list")
      return list(run, `/planner/plans/${segment(args.planId)}/buckets`, args);
    if (id === "planner.tasks.list")
      return list(run, `/planner/plans/${segment(args.planId)}/tasks`, args);
    if (id === "planner.tasks.get" || id === "planner.details.get")
      return run.finish(
        resource(
          await get(run, id === "planner.details.get" ? `${task}/details` : task),
          args.taskId,
        ),
      );
    if (id === "planner.tasks.create")
      return write(run, {
        method: "POST",
        path: "/planner/tasks",
        body: { planId: args.planId, ...plannerChanges(args) },
      });
    if (id === "planner.tasks.update")
      return write(
        run,
        { method: "PATCH", path: task, headers: ifMatch(args), body: plannerChanges(args) },
        args.taskId,
      );
    if (id === "planner.tasks.delete")
      return write(run, { method: "DELETE", path: task, headers: ifMatch(args) }, args.taskId);
    return incomplete("Missing frozen Planner action.");
  });
}
export function createTeamsActions(): NativeAction[] {
  return graphActions(teamsContract.actions, async (args, run) => {
    const id = run.definition.id,
      channel = `/teams/${segment(args.teamId)}/channels/${segment(args.channelId)}/messages`,
      chat = `/chats/${segment(args.chatId)}/messages`;
    if (id === "teams.teams.list")
      return run.finish(
        page(
          (await run.request({ method: "GET", path: "/me/joinedTeams" })).body,
          "/me/joinedTeams",
        ),
      );
    if (id === "teams.channels.list")
      return list(run, `/teams/${segment(args.teamId)}/channels`, args);
    if (id === "teams.channel_messages.list") return list(run, channel, args);
    if (id === "teams.chats.list") return list(run, "/me/chats", args);
    if (id === "teams.chat_messages.list") return list(run, chat, args);
    if (
      [
        "teams.channel_messages.send",
        "teams.channel_messages.reply",
        "teams.chat_messages.send",
      ].includes(id)
    )
      return write(run, {
        method: "POST",
        path:
          id === "teams.chat_messages.send"
            ? chat
            : id === "teams.channel_messages.reply"
              ? `${channel}/${segment(args.messageId)}/replies`
              : channel,
        body: { body: { contentType: "text", content: args.content } },
      });
    return incomplete("Missing frozen Teams action.");
  });
}
