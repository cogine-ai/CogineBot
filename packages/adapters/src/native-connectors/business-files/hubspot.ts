import type { NativeAction } from "../action.js";
import { NativeActionError } from "../action.js";
import type { Data } from "../collaboration-action.js";
import {
  array,
  identity,
  incomplete,
  object,
  segment,
  select,
  text,
} from "../collaboration-action.js";
import { authorize, businessActions, exact } from "./common.js";
import contract from "./hubspot.contract.json" with { type: "json" };

const OBJECTS = { contacts: "contactId", companies: "companyId", deals: "dealId" } as const;
const SINGULAR = { contacts: "contact", companies: "company", deals: "deal" } as const;
export function createHubSpotActions(): NativeAction[] {
  return businessActions(
    contract.actions,
    async (args, run) => {
      const id = run.definition.id;
      if (id === "hubspot.pipelines.list") {
        const body = object(
          (await run.request({ method: "GET", path: "/crm/pipelines/2026-09/deals" })).body,
        );
        const items = array(body.results).map((value) => {
          const pipeline = identity(value);
          text(pipeline.label);
          return {
            ...pipeline,
            stages: array(pipeline.stages).map((stage) => {
              const row = identity(stage);
              text(row.label);
              return row;
            }),
          };
        });
        return run.finish({ action_id: id, items, hasMore: false, allPagesRead: true });
      }
      if (id === "hubspot.associations.create") {
        for (const kind of [args.fromType, args.toType])
          if (!run.context.principal.scopes.includes(`crm.objects.${kind}.write`))
            throw new NativeActionError(
              "insufficient_scope",
              "Associating these records requires both selected object write permissions.",
            );
        if (args.fromType === args.toType && args.fromId === args.toId)
          throw new NativeActionError("invalid_input", "Select two distinct CRM records.");
        const body = object(
          (
            await run.request(
              {
                method: "PUT",
                path: `/crm/objects/2026-09/${args.fromType}/${segment(args.fromId)}/associations/default/${args.toType}/${segment(args.toId)}`,
              },
              true,
            )
          ).body,
        );
        if (
          body.status !== "COMPLETE" ||
          (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length)) ||
          (body.numErrors !== undefined && body.numErrors !== 0)
        )
          return run.unknown("HubSpot did not confirm the selected association completed.");
        const rows = array(body.results);
        if (
          !rows.length ||
          rows.some((value) => {
            const row = object(value);
            return (
              String(object(row.from).id) !== args.fromId || String(object(row.to).id) !== args.toId
            );
          })
        )
          return run.unknown("HubSpot did not identify the selected associated records.");
        return run.finish(
          {
            action_id: id,
            fromType: args.fromType,
            fromId: args.fromId,
            toType: args.toType,
            toId: args.toId,
            association: body,
          },
          { resource_id: `${args.fromType}:${args.fromId}:${args.toType}:${args.toId}` },
        );
      }
      const family = id.split(".")[1] as keyof typeof OBJECTS,
        base = `/crm/objects/2026-09/${family}`;
      if (id.endsWith(".search")) {
        const body = object(
          (
            await run.request({
              method: "POST",
              path: `${base}/search`,
              body: { ...select(args, ["query", "after", "properties"]), limit: args.limit ?? 25 },
            })
          ).body,
        );
        const items = array(body.results).map(identity),
          next = body.paging === undefined ? undefined : object(object(body.paging).next ?? {}),
          after = next?.after;
        if (after !== undefined && !/^[0-9]+$/.test(String(after)))
          return incomplete("HubSpot returned an invalid search cursor.");
        const total = body.total;
        if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
          return incomplete("HubSpot omitted search count metadata.");
        const searchLimitReached = total > 10000 || (after !== undefined && Number(after) >= 10000);
        return run.finish({
          action_id: id,
          items,
          total,
          hasMore: after !== undefined,
          nextAfter: after === undefined ? null : Number(after),
          allPagesRead: args.after === undefined && after === undefined && !searchLimitReached,
          searchLimitReached,
        });
      }
      const selected = args[OBJECTS[family]],
        path = `${base}/${segment(selected)}`;
      if (id.endsWith(".get")) {
        const row = exact(
          (
            await run.request({
              method: "GET",
              path,
              query: { properties: args.properties as string[] | undefined, archived: false },
            })
          ).body,
          selected,
        );
        object(row.properties);
        return run.finish({ action_id: id, [SINGULAR[family]]: row });
      }
      let before: Data | undefined;
      if (id.endsWith(".update")) {
        before = exact(
          (
            await run.request({
              method: "GET",
              path,
              query: {
                archived: false,
                ...(family === "deals" ? { properties: ["pipeline", "dealstage"] } : {}),
              },
            })
          ).body,
          selected,
        );
        if (text(before.updatedAt) !== args.expectedUpdatedAt)
          throw new NativeActionError(
            "version_conflict",
            "This CRM record changed after it was read.",
          );
      }
      if (family === "deals") {
        const properties = object(args.properties),
          prior = before ? object(before.properties) : {};
        if (properties.pipeline !== undefined && properties.dealstage === undefined)
          throw new NativeActionError(
            "invalid_input",
            "Select the stage together with the destination pipeline.",
          );
        if (properties.dealstage !== undefined) {
          const pipelineId = text(properties.pipeline ?? prior.pipeline),
            stageId = text(properties.dealstage);
          const pipeline = exact(
            (
              await run.request({
                method: "GET",
                path: `/crm/pipelines/2026-09/deals/${segment(pipelineId)}`,
              })
            ).body,
            pipelineId,
          );
          if (
            pipeline.archived === true ||
            !array(pipeline.stages)
              .map(identity)
              .some((stage) => stage.id === stageId && stage.archived !== true)
          )
            throw new NativeActionError(
              "invalid_input",
              "Select a stage from this account’s current deal pipeline.",
            );
        }
      }
      const resource = identity(
        (
          await run.request(
            {
              method: id.endsWith(".update") ? "PATCH" : "POST",
              path: id.endsWith(".update") ? path : base,
              body: { properties: args.properties },
            },
            true,
          )
        ).body,
      );
      if (id.endsWith(".update") && resource.id !== selected)
        return run.unknown("HubSpot did not identify the selected updated CRM record.");
      object(resource.properties);
      return run.finish(
        {
          action_id: id,
          [SINGULAR[family]]: resource,
          ...(id.endsWith(".update") ? { concurrency_guarantee: "best_effort_precheck" } : {}),
        },
        { resource_id: resource.id },
      );
    },
    (def, ctx) => {
      authorize("hubspot", def, ctx);
      const c = ctx.principal.context;
      if (
        !ctx.principal.tenant ||
        c.hubId !== ctx.principal.tenant ||
        !["account", "user"].includes(String(c.hubspotAccessLevel)) ||
        (c.actorType === "user") !== (c.hubspotAccessLevel === "user")
      )
        throw new NativeActionError(
          "authorization_required",
          "Select a verified HubSpot account or user-level authorization.",
        );
      const family = def.id.split(".")[1];
      if (
        (def.id.endsWith(".update") || def.id === "hubspot.deals.create") &&
        !ctx.principal.scopes.includes(`crm.objects.${family}.read`)
      )
        throw new NativeActionError(
          "insufficient_scope",
          "The version and stage prechecks also require the corresponding CRM read permission.",
        );
    },
  );
}
export const hubspotActions = createHubSpotActions();
