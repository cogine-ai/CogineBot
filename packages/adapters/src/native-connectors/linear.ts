import type { NativeAction, NativeActionContext } from "./action.js";
import { NativeActionError } from "./action.js";
import type { CollaborationDefinition, Data } from "./collaboration-action.js";
import {
  array,
  collaborationActions,
  identity,
  incomplete,
  object,
  scopes,
  select,
  text,
} from "./collaboration-action.js";
import contract from "./linear.contract.json" with { type: "json" };

const definitions = new Map(contract.actions.map((row) => [row.id, row]));
function authorize(
  def: CollaborationDefinition,
  context: Pick<NativeActionContext, "principal">,
): void {
  const c = context.principal.context;
  if (
    !["user", "app"].includes(String(c.actorType)) ||
    typeof c.organizationId !== "string" ||
    c.organizationId !== context.principal.tenant
  )
    throw new NativeActionError(
      "authorization_required",
      "Select a verified Linear actor and workspace.",
    );
  if (c.credentialType !== "api_key") scopes(context, def.authorization.acceptedAnyOfScopes);
  // API key team/resource permissions are enforced by Linear; they are not fabricated OAuth scopes.
}
export function createLinearActions(): NativeAction[] {
  return collaborationActions(
    contract.actions,
    async (args, run) => {
      const id = run.definition.id,
        definition = definitions.get(id)!;
      const graphql = async (
        actionId: string,
        variables: Data,
        mutation: boolean,
      ): Promise<Data> => {
        const response = await run.request(
          {
            method: "POST",
            path: "/graphql",
            body: { query: definitions.get(actionId)!.graphql, variables },
          },
          mutation,
        );
        const body = object(response.body);
        if (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length)) {
          if (mutation)
            return run.unknown(
              "Linear returned mutation errors or partial data; the mutation will not be replayed.",
            );
          const codes = Array.isArray(body.errors)
            ? body.errors
                .map((value) => object(value).extensions)
                .map((value) =>
                  value && typeof value === "object" ? (value as Data).code : undefined,
                )
            : [];
          const rate = codes.some((code) => code === "RATELIMITED" || code === "RATE_LIMITED");
          throw new NativeActionError(
            rate ? "rate_limited" : "incomplete_response",
            "Linear returned GraphQL errors; partial data is not a complete result.",
          );
        }
        return object(body.data);
      };
      const single = async (actionId: string, key: string, id: unknown) =>
        identity((await graphql(actionId, { id }, false))[key]);
      if (id === "linear.issues.get") {
        const key = id === "linear.issues.get" ? "issue" : "project";
        const resource = await single(id, key, args.id);
        if (
          key === "issue"
            ? resource.id !== args.id && resource.identifier !== args.id
            : resource.id !== args.id
        )
          return incomplete("Linear returned another selected resource.");
        return run.finish({ [key]: resource });
      }
      if (id.endsWith(".list")) {
        const key = id.split(".")[1]!;
        const variables: Data = { first: args.first ?? 25, after: args.after ?? null };
        if (key === "issues") {
          const filter: Data = {};
          for (const [input, field] of [
            ["teamId", "team"],
            ["assigneeId", "assignee"],
            ["projectId", "project"],
            ["stateId", "state"],
          ])
            if (args[input!]) filter[field!] = { id: { eq: args[input!] } };
          if (args.query) filter.title = { containsIgnoreCase: args.query };
          variables.filter = filter;
        }
        const connection = object((await graphql(id, variables, false))[key]),
          nodes = array(connection.nodes).map(identity),
          page = object(connection.pageInfo);
        if (
          typeof page.hasNextPage !== "boolean" ||
          (page.hasNextPage && (typeof page.endCursor !== "string" || !page.endCursor))
        )
          return incomplete("Linear omitted pagination metadata.");
        return run.finish({
          items: nodes,
          hasMore: page.hasNextPage,
          nextCursor: page.endCursor ?? null,
          allPagesRead: args.after === undefined && !page.hasNextPage,
        });
      }
      if (id === "linear.issues.update") {
        const prior = await single("linear.issues.get", "issue", args.id);
        if (prior.id !== args.id && prior.identifier !== args.id)
          return incomplete("Linear returned another issue for the version precheck.");
        if (text(prior.updatedAt) !== args.expectedUpdatedAt)
          throw new NativeActionError(
            "version_conflict",
            "This issue changed after it was read. Review its current fields before updating it.",
          );
      }
      const variables =
        id === "linear.issues.update"
          ? { id: args.id, input: args.changes }
          : { input: select(args, Object.keys(definition.inputSchema.properties)) };
      const field =
        id === "linear.comments.create"
          ? "commentCreate"
          : id === "linear.issues.create"
            ? "issueCreate"
            : "issueUpdate";
      const data = object((await graphql(id, variables, true))[field]),
        key = field === "commentCreate" ? "comment" : "issue";
      if (data.success !== true) return run.unknown("Linear did not confirm mutation success.");
      const resource = identity(data[key]);
      if (
        id === "linear.issues.update" &&
        resource.id !== args.id &&
        resource.identifier !== args.id
      )
        return run.unknown("Linear did not identify the selected updated issue.");
      return run.finish(
        {
          [key]: resource,
          ...(id === "linear.issues.update"
            ? { concurrency_guarantee: "best_effort_precheck" }
            : {}),
        },
        { resource_id: resource.id },
      );
    },
    authorize,
  );
}
export const linearActions = createLinearActions();
