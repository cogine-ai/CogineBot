import type { NativeAction, NativeActionContext } from "./action.js";
import { NativeActionError } from "./action.js";
import type { CollaborationDefinition, Data } from "./collaboration-action.js";
import {
  array,
  collaborationActions,
  identity,
  incomplete,
  object,
  segment,
  select,
} from "./collaboration-action.js";
import contract from "./github.contract.json" with { type: "json" };

const HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
const ISSUE = [
  "id",
  "node_id",
  "number",
  "title",
  "body",
  "state",
  "state_reason",
  "html_url",
  "user",
  "assignees",
  "labels",
  "comments",
  "created_at",
  "updated_at",
  "closed_at",
  "pull_request",
];
const PULL = [
  ...ISSUE,
  "draft",
  "merged",
  "mergeable",
  "mergeable_state",
  "merged_at",
  "head",
  "base",
  "requested_reviewers",
];
function project(value: unknown, fields: string[]): Data {
  return select(identity(value), fields);
}
function authorize(
  def: CollaborationDefinition,
  context: Pick<NativeActionContext, "principal">,
): void {
  const actor = context.principal.context.actorType;
  if (!["installation", "user", "fine_grained_pat"].includes(String(actor)))
    throw new NativeActionError(
      "authorization_required",
      "A verified GitHub installation or user is required.",
    );
  // Fine-grained PAT permissions are not introspectable through /user. Never invent OAuth scopes.
  // GitHub enforces repository permissions on every request. Installation permissions are verified at issuance.
  if (actor === "installation") {
    if (!context.principal.context.installationId)
      throw new NativeActionError(
        "authorization_required",
        "The installation identity is missing.",
      );
    const permissions = object(context.principal.context.githubPermissions);
    const row = contract.actions.find((item) => item.id === def.id)!;
    const allowed = (label: string) => {
      const [key, level] = label.split(":");
      return permissions[key!] === "write" || permissions[key!] === level;
    };
    if (
      row.authorization.acceptedAnyOfPermissions.length &&
      !row.authorization.acceptedAnyOfPermissions.some(allowed)
    )
      throw new NativeActionError(
        "insufficient_scope",
        "This installation has not granted the required repository permission.",
      );
    if (def.id === "github.ci.status" && !["statuses:read", "statuses:write"].some(allowed))
      throw new NativeActionError(
        "insufficient_scope",
        "This installation has not granted commit-status read permission.",
      );
  }
}
export function createGithubActions(): NativeAction[] {
  return collaborationActions(
    contract.actions,
    async (args, run) => {
      const c = run.context.principal.context;
      const name = `${args.owner}/${args.repo}`;
      if (run.definition.id === "github.repositories.list") {
        const installation = c.actorType === "installation";
        const response = await run.request({
          method: "GET",
          path: installation ? "/installation/repositories" : "/user/repos",
          headers: HEADERS,
          query: { per_page: Number(args.per_page ?? 30), page: Number(args.page ?? 1) },
        });
        const body = installation ? object(response.body).repositories : response.body;
        const items = array(body).map((value) =>
          project(value, [
            "id",
            "node_id",
            "full_name",
            "name",
            "description",
            "private",
            "html_url",
            "default_branch",
            "archived",
            "disabled",
            "visibility",
            "updated_at",
            "pushed_at",
          ]),
        );
        if (items.some((item) => typeof item.full_name !== "string"))
          return incomplete("GitHub omitted repository names.");
        const hasMore = /rel="next"/.test(response.headers.get("link") ?? "");
        return run.finish({
          items,
          hasMore,
          nextPage: hasMore ? Number(args.page ?? 1) + 1 : null,
          allPagesRead: !args.page && !hasMore,
        });
      }
      if (
        Array.isArray(c.repositoryAllowlist) &&
        !c.repositoryAllowlist.some(
          (repo) => typeof repo === "string" && repo.toLowerCase() === name.toLowerCase(),
        )
      )
        throw new NativeActionError(
          "resource_unavailable",
          "This repository is outside the selected installation grant.",
        );
      const root = `/repos/${segment(args.owner)}/${segment(args.repo)}`;
      const page = {
        per_page: args.per_page === undefined ? 30 : Number(args.per_page),
        page: args.page === undefined ? 1 : Number(args.page),
      };
      const call = async (
        path: string,
        query?: Record<string, string | number | boolean | undefined>,
      ) => run.request({ method: "GET", path, headers: HEADERS, ...(query ? { query } : {}) });
      const list = async (
        path: string,
        fields: string[],
        query: Record<string, string | number | boolean | undefined>,
      ) => {
        const result = await call(path, query),
          items = array(result.body).map((value) => project(value, fields));
        const hasMore = /rel="next"/.test(result.headers.get("link") ?? "");
        return {
          items,
          hasMore,
          nextPage: hasMore ? page.page + 1 : null,
          allPagesRead: page.page === 1 && !hasMore,
        };
      };
      const id = run.definition.id;
      if (id === "github.issues.list" || id === "github.pulls.list") {
        const issue = id === "github.issues.list";
        const result = await list(`${root}/${issue ? "issues" : "pulls"}`, issue ? ISSUE : PULL, {
          ...page,
          ...select(args, issue ? ["state", "labels", "since"] : ["state", "head", "base"]),
        } as Record<string, string | number>);
        return run.finish({ ...result, ...(issue ? { includesPullRequestMarkers: true } : {}) });
      }
      if (id === "github.issues.get" || id === "github.pulls.get") {
        const issue = id === "github.issues.get",
          number = issue ? args.issue_number : args.pull_number;
        const result = project(
          (await call(`${root}/${issue ? "issues" : "pulls"}/${segment(number)}`)).body,
          issue ? ISSUE : PULL,
        );
        if (Number(result.number) !== number)
          return incomplete("GitHub returned another issue or pull request.");
        const comments =
          args.includeComments === true
            ? await list(
                `${root}/issues/${segment(number)}/comments`,
                ["id", "node_id", "body", "html_url", "user", "created_at", "updated_at"],
                page,
              )
            : undefined;
        return run.finish({
          [issue ? "issue" : "pull"]: result,
          ...(comments ? { comments } : {}),
        });
      }
      if (id === "github.issues.create" || id === "github.comments.create") {
        const issue = id === "github.issues.create";
        const response = await run.request(
          {
            method: "POST",
            path: issue
              ? `${root}/issues`
              : `${root}/issues/${segment(args.issue_number)}/comments`,
            headers: HEADERS,
            body: select(args, issue ? ["title", "body", "assignees", "labels"] : ["body"]),
          },
          true,
        );
        const resource = project(
          response.body,
          issue ? ISSUE : ["id", "node_id", "body", "html_url", "user", "created_at", "updated_at"],
        );
        if (
          response.status !== 201 ||
          (issue && (!Number.isSafeInteger(resource.number) || Number(resource.number) < 1))
        )
          return run.unknown("GitHub did not confirm the created resource identity.");
        return run.finish(
          { [issue ? "issue" : "comment"]: resource },
          { resource_id: resource.id },
        );
      }
      const ref = segment(args.ref),
        checksResponse = await call(`${root}/commits/${ref}/check-runs`, page),
        checks = object(checksResponse.body);
      const statusResponse = await call(`${root}/commits/${ref}/status`, page),
        status = object(statusResponse.body);
      const checkRuns = array(checks.check_runs).map((value) =>
        project(value, [
          "id",
          "name",
          "status",
          "conclusion",
          "head_sha",
          "details_url",
          "html_url",
          "started_at",
          "completed_at",
        ]),
      );
      const statuses = array(status.statuses).map((value) =>
        project(value, [
          "id",
          "state",
          "context",
          "description",
          "target_url",
          "created_at",
          "updated_at",
        ]),
      );
      if (
        !Number.isSafeInteger(checks.total_count) ||
        Number(checks.total_count) < 0 ||
        !Number.isSafeInteger(status.total_count) ||
        Number(status.total_count) < 0 ||
        typeof status.state !== "string" ||
        typeof status.sha !== "string"
      )
        return incomplete("GitHub omitted CI completeness metadata.");
      const hasMore =
        /rel="next"/.test(
          `${checksResponse.headers.get("link") ?? ""} ${statusResponse.headers.get("link") ?? ""}`,
        ) ||
        Number(checks.total_count) > (page.page - 1) * page.per_page + checkRuns.length ||
        Number(status.total_count) > (page.page - 1) * page.per_page + statuses.length;
      return run.finish({
        checks: { total_count: checks.total_count, check_runs: checkRuns },
        status: { ...select(status, ["sha", "state", "total_count"]), statuses },
        hasMore,
        allPagesRead: page.page === 1 && !hasMore,
        nextPage: hasMore ? page.page + 1 : null,
      });
    },
    authorize,
  );
}
export const githubActions = createGithubActions();
