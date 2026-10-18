import { NativeActionError } from "../action.js";
import {
  array,
  collaborationActions,
  incomplete,
  object,
  segment,
  select,
} from "../collaboration-action.js";
import contract from "./confluence.contract.json" with { type: "json" };
import { authorize, cursorQuery, cursorResult, project, sameId } from "./helpers.js";

const PAGE = [
  "id",
  "status",
  "title",
  "spaceId",
  "parentId",
  "parentType",
  "authorId",
  "ownerId",
  "createdAt",
  "version",
  "body",
  "_links",
];
export const confluenceActions = collaborationActions(
  contract.actions,
  async (args, run) => {
    const id = run.definition.id;
    const path = `/wiki/api/v2/pages/${segment(args.page_id)}`;
    if (id === "confluence.pages.get")
      return run.finish(
        sameId(
          project(
            (await run.request({ method: "GET", path, query: { "body-format": "storage" } })).body,
            PAGE,
          ),
          args.page_id,
        ),
      );
    if (id === "confluence.pages.search") {
      const body = object(
        (
          await run.request({
            method: "GET",
            path: "/wiki/rest/api/search",
            query: {
              ...cursorQuery(args),
              cql: `type=page AND (${String(args.cql)})`,
              excerpt: "none",
            },
          })
        ).body,
      );
      const rows = array(body.results).map((value) => {
        const row = object(value);
        return {
          ...select(row, ["title", "url", "lastModified", "entityType"]),
          content: project(row.content, ["id", "type", "status", "title", "_links"]),
        };
      });
      const pagination = cursorResult({ ...body, results: [] }, args, [], "confluence");
      return run.finish({ ...pagination, items: rows });
    }
    if (
      [
        "confluence.spaces.list",
        "confluence.comments.list",
        "confluence.attachments.list",
      ].includes(id)
    ) {
      const isSpace = id === "confluence.spaces.list",
        attachment = id === "confluence.attachments.list";
      const body = object(
        (
          await run.request({
            method: "GET",
            path: isSpace
              ? "/wiki/api/v2/spaces"
              : `${path}/${attachment ? "attachments" : "footer-comments"}`,
            query: {
              ...cursorQuery(args),
              ...(!isSpace && !attachment ? { "body-format": "storage" } : {}),
            },
          })
        ).body,
      );
      return run.finish(
        cursorResult(
          body,
          args,
          isSpace
            ? ["id", "key", "name", "type", "status", "homepageId"]
            : attachment
              ? [
                  "id",
                  "title",
                  "pageId",
                  "mediaType",
                  "fileSize",
                  "version",
                  "downloadLink",
                  "_links",
                ]
              : ["id", "pageId", "parentCommentId", "status", "title", "body", "version"],
          "confluence",
        ),
      );
    }
    if (id === "confluence.comments.create") {
      const row = project(
        (
          await run.request(
            {
              method: "POST",
              path: "/wiki/api/v2/footer-comments",
              body: { pageId: args.page_id, body: { representation: "storage", value: args.body } },
            },
            true,
          )
        ).body,
        ["id", "pageId", "body", "version"],
      );
      return run.finish(row, { resource_id: String(row.id) });
    }
    if (id === "confluence.pages.create") {
      const row = project(
        (
          await run.request(
            {
              method: "POST",
              path: "/wiki/api/v2/pages",
              body: {
                ...select(args, ["spaceId", "parentId", "title"]),
                status: "current",
                body: { representation: "storage", value: args.body },
              },
            },
            true,
          )
        ).body,
        PAGE,
      );
      return run.finish(row, { resource_id: String(row.id) });
    }
    const current = sameId(
      project((await run.request({ method: "GET", path })).body, PAGE),
      args.page_id,
    );
    if (object(current.version).number !== args.expectedVersion)
      throw new NativeActionError(
        "version_conflict",
        "This page changed. Read its current version before updating it.",
      );
    const row = sameId(
      project(
        (
          await run.request(
            {
              method: "PUT",
              path,
              body: {
                id: args.page_id,
                status: "current",
                title: args.title,
                body: { representation: "storage", value: args.body },
                version: { number: Number(args.expectedVersion) + 1 },
              },
            },
            true,
          )
        ).body,
        PAGE,
      ),
      args.page_id,
    );
    if (object(row.version).number !== Number(args.expectedVersion) + 1)
      return incomplete("Confluence omitted the updated page version.");
    return run.finish(row, { resource_id: String(row.id) });
  },
  authorize,
);
