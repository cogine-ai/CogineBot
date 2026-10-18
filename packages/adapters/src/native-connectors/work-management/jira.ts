import { NativeActionError } from "../action.js";
import type { Data } from "../collaboration-action.js";
import {
  array,
  collaborationActions,
  incomplete,
  object,
  segment,
  select,
  text,
} from "../collaboration-action.js";
import { adf, authorize, nonempty, project } from "./helpers.js";
import contract from "./jira.contract.json" with { type: "json" };

const FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "project",
  "assignee",
  "reporter",
  "labels",
  "created",
  "updated",
  "duedate",
  "attachment",
];
function issue(value: unknown): Data {
  const row = project(value, ["id", "key", "fields"]);
  text(row.key);
  row.fields = select(object(row.fields), FIELDS);
  return row;
}
function changes(args: Data): Data {
  const output = select(args, ["summary", "labels"]);
  if (args.description !== undefined) output.description = adf(args.description);
  if (args.assigneeAccountId !== undefined) output.assignee = { accountId: args.assigneeAccountId };
  return output;
}
export const jiraActions = collaborationActions(
  contract.actions,
  async (args, run) => {
    const id = run.definition.id;
    if (id === "jira.projects.list") {
      const body = object(
        (
          await run.request({
            method: "GET",
            path: "/rest/api/3/project/search",
            query: {
              startAt: Number(args.startAt ?? 0),
              maxResults: Number(args.maxResults ?? 30),
            },
          })
        ).body,
      );
      if (
        typeof body.isLast !== "boolean" ||
        typeof body.startAt !== "number" ||
        typeof body.maxResults !== "number"
      )
        return incomplete("Jira omitted project pagination state.");
      return run.finish({
        items: array(body.values).map((row) =>
          project(row, ["id", "key", "name", "projectTypeKey", "simplified", "style"]),
        ),
        hasMore: !body.isLast,
        nextStartAt: body.isLast ? null : body.startAt + body.maxResults,
        allPagesRead: !args.startAt && body.isLast,
      });
    }
    if (id === "jira.issues.search") {
      const body = object(
        (
          await run.request({
            method: "POST",
            path: "/rest/api/3/search/jql",
            body: {
              ...select(args, ["jql", "nextPageToken"]),
              maxResults: Number(args.maxResults ?? 30),
              fields: FIELDS,
            },
          })
        ).body,
      );
      if (
        typeof body.isLast !== "boolean" ||
        (!body.isLast && typeof body.nextPageToken !== "string")
      )
        return incomplete("Jira omitted issue pagination state.");
      return run.finish({
        items: array(body.issues).map(issue),
        hasMore: !body.isLast,
        nextPageToken: body.isLast ? null : body.nextPageToken,
        allPagesRead: !args.nextPageToken && body.isLast,
      });
    }
    const path = `/rest/api/3/issue/${segment(args.issue)}`;
    if (id === "jira.issues.get") {
      const row = issue(
        (await run.request({ method: "GET", path, query: { fields: FIELDS.join(",") } })).body,
      );
      if (![row.id, row.key].some((value) => String(value) === String(args.issue)))
        return incomplete("Jira returned another issue.");
      return run.finish(row);
    }
    if (id === "jira.transitions.list") {
      const body = object((await run.request({ method: "GET", path: `${path}/transitions` })).body);
      return run.finish({
        items: array(body.transitions).map((row) =>
          project(row, [
            "id",
            "name",
            "to",
            "hasScreen",
            "isGlobal",
            "isInitial",
            "isConditional",
            "isAvailable",
          ]),
        ),
      });
    }
    if (id === "jira.issues.create") {
      const row = project(
        (
          await run.request(
            {
              method: "POST",
              path: "/rest/api/3/issue",
              body: {
                fields: {
                  ...changes(args),
                  project: { id: args.projectId },
                  issuetype: { id: args.issueTypeId },
                },
              },
            },
            true,
          )
        ).body,
        ["id", "key"],
      );
      text(row.key);
      return run.finish(row, { resource_id: String(row.id) });
    }
    if (id === "jira.comments.create") {
      const row = project(
        (
          await run.request(
            { method: "POST", path: `${path}/comment`, body: { body: adf(args.body) } },
            true,
          )
        ).body,
        ["id", "body", "author", "created", "updated"],
      );
      return run.finish(row, { resource_id: String(row.id) });
    }
    if (id === "jira.issues.update") {
      const fields = changes(nonempty(args.changes));
      if (!Object.keys(fields).length)
        throw new NativeActionError("invalid_input", "Choose a supported issue field.");
      await run.request({ method: "PUT", path, body: { fields } }, true);
      return run.finish({ issue: args.issue, updated: true }, { resource_id: String(args.issue) });
    }
    await run.request(
      {
        method: "POST",
        path: `${path}/transitions`,
        body: { transition: { id: args.transitionId } },
      },
      true,
    );
    return run.finish(
      { issue: args.issue, transitionId: args.transitionId, transitioned: true },
      { resource_id: String(args.issue) },
    );
  },
  authorize,
);
