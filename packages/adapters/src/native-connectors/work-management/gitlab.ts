import { collaborationActions, segment, select } from "../collaboration-action.js";
import contract from "./gitlab.contract.json" with { type: "json" };
import { authorize, gitlabPage, pageQuery, project, sameId } from "./helpers.js";

const ISSUE = [
  "id",
  "iid",
  "project_id",
  "title",
  "description",
  "state",
  "web_url",
  "labels",
  "assignees",
  "author",
  "created_at",
  "updated_at",
  "due_date",
];
const MR = [
  ...ISSUE,
  "source_branch",
  "target_branch",
  "sha",
  "draft",
  "merge_status",
  "detailed_merge_status",
  "head_pipeline",
];
export const gitlabActions = collaborationActions(
  contract.actions,
  async (args, run) => {
    const id = run.definition.id;
    if (id === "gitlab.projects.list")
      return run.finish(
        gitlabPage(
          await run.request({
            method: "GET",
            path: "/projects",
            query: { ...pageQuery(args), membership: true, ...select(args, ["search"]) },
          }),
          args,
          [
            "id",
            "name",
            "path_with_namespace",
            "description",
            "web_url",
            "default_branch",
            "visibility",
            "archived",
          ],
        ),
      );
    const root = `/projects/${segment(args.project)}`;
    if (
      id === "gitlab.issues.list" ||
      id === "gitlab.merge_requests.list" ||
      id === "gitlab.pipelines.list"
    ) {
      const resource = id.split(".")[1]!;
      return run.finish(
        gitlabPage(
          await run.request({
            method: "GET",
            path: `${root}/${resource}`,
            query: {
              ...pageQuery(args),
              ...select(args, resource === "pipelines" ? ["ref", "status"] : ["state", "search"]),
            },
          }),
          args,
          resource === "pipelines"
            ? [
                "id",
                "iid",
                "project_id",
                "sha",
                "ref",
                "status",
                "source",
                "web_url",
                "created_at",
                "updated_at",
              ]
            : resource === "issues"
              ? ISSUE
              : MR,
        ),
      );
    }
    if (id === "gitlab.issues.get" || id === "gitlab.merge_requests.get") {
      const issue = id === "gitlab.issues.get",
        resource = issue ? "issues" : "merge_requests",
        iid = issue ? args.issue_iid : args.merge_request_iid;
      return run.finish(
        sameId(
          project(
            (await run.request({ method: "GET", path: `${root}/${resource}/${segment(iid)}` }))
              .body,
            issue ? ISSUE : MR,
          ),
          iid,
          "iid",
        ),
      );
    }
    if (id === "gitlab.issues.create") {
      const row = project(
        (
          await run.request(
            {
              method: "POST",
              path: `${root}/issues`,
              body: select(args, ["title", "description", "labels", "assignee_ids"]),
            },
            true,
          )
        ).body,
        ISSUE,
      );
      return run.finish(row, { resource_id: String(row.id) });
    }
    const row = project(
      (
        await run.request(
          {
            method: "POST",
            path: `${root}/issues/${segment(args.issue_iid)}/notes`,
            body: { body: args.body },
          },
          true,
        )
      ).body,
      ["id", "body", "author", "created_at", "updated_at", "system", "noteable_id", "noteable_iid"],
    );
    return run.finish(row, { resource_id: String(row.id) });
  },
  authorize,
);
