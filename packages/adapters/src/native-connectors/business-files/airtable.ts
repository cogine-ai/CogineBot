import type { NativeAction } from "../action.js";
import { NativeActionError } from "../action.js";
import { identity, incomplete, object, segment, stable } from "../collaboration-action.js";
import contract from "./airtable.contract.json" with { type: "json" };
import { authorize, businessActions, exact, page } from "./common.js";

export function createAirtableActions(): NativeAction[] {
  return businessActions(
    contract.actions,
    async (args, run) => {
      const id = run.definition.id;
      if (id === "airtable.bases.list") {
        const body = object(
          (
            await run.request({
              method: "GET",
              path: "/v0/meta/bases",
              query: { offset: args.offset as string | undefined },
            })
          ).body,
        );
        return run.finish({
          action_id: id,
          ...page(body.bases, body.offset, args.offset === undefined),
        });
      }
      if (id === "airtable.tables.list") {
        const body = object(
          (
            await run.request({
              method: "GET",
              path: `/v0/meta/bases/${segment(args.baseId)}/tables`,
            })
          ).body,
        );
        return run.finish({ action_id: id, ...page(body.tables, null, true) });
      }
      const table = `/v0/${segment(args.baseId)}/${segment(args.tableId)}`,
        record = `${table}/${segment(args.recordId)}`;
      if (id === "airtable.records.list") {
        const body = object(
          (
            await run.request({
              method: "GET",
              path: table,
              query: {
                pageSize: Number(args.pageSize ?? 100),
                offset: args.offset as string | undefined,
                view: args.view as string | undefined,
                filterByFormula: args.filterByFormula as string | undefined,
                "fields[]": args.fields as string[] | undefined,
              },
            })
          ).body,
        );
        return run.finish({
          action_id: id,
          ...page(body.records, body.offset, args.offset === undefined),
        });
      }
      if (id === "airtable.records.get")
        return run.finish({
          action_id: id,
          record: exact((await run.request({ method: "GET", path: record })).body, args.recordId),
        });
      if (id === "airtable.records.update") {
        const before = exact(
            (await run.request({ method: "GET", path: record })).body,
            args.recordId,
          ),
          prior = object(before.fields),
          expected = object(args.expectedFields);
        if (Object.keys(expected).some((key) => stable(prior[key]) !== stable(expected[key])))
          throw new NativeActionError(
            "version_conflict",
            "This record changed after its fields were read.",
          );
      }
      const write = await run.request(
        {
          method:
            id === "airtable.records.delete"
              ? "DELETE"
              : id === "airtable.records.update"
                ? "PATCH"
                : "POST",
          path:
            id === "airtable.records.create"
              ? table
              : id === "airtable.comments.create"
                ? `${record}/comments`
                : record,
          ...(id === "airtable.records.delete"
            ? {}
            : {
                body:
                  id === "airtable.comments.create"
                    ? { text: args.text }
                    : { fields: args.fields, typecast: false },
              }),
        },
        true,
      );
      const resource = identity(write.body);
      if (
        id === "airtable.records.delete" &&
        (resource.id !== args.recordId || resource.deleted !== true)
      )
        return run.unknown("Airtable did not confirm the selected record deletion.");
      if (id === "airtable.records.update" && resource.id !== args.recordId)
        return incomplete("Airtable returned another updated record.");
      return run.finish(
        {
          action_id: id,
          [id === "airtable.comments.create" ? "comment" : "record"]: resource,
          ...(id === "airtable.records.update"
            ? { concurrency_guarantee: "best_effort_precheck" }
            : {}),
        },
        { resource_id: resource.id },
      );
    },
    (def, ctx) => {
      authorize("airtable", def, ctx);
      if (
        def.id === "airtable.records.update" &&
        ctx.principal.context.scopeAuthority !== "provider_enforced" &&
        !ctx.principal.scopes.includes("data.records:read")
      )
        throw new NativeActionError(
          "insufficient_scope",
          "Updating with a field precheck also requires record read access.",
        );
    },
  );
}
export const airtableActions = createAirtableActions();
