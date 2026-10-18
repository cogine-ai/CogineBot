import type { NativeAction } from "../action.js";
import { NativeActionError } from "../action.js";
import { array, identity, incomplete, object, segment, text } from "../collaboration-action.js";
import { authorize, businessActions } from "./common.js";
import contract from "./figma.contract.json" with { type: "json" };

function versionCursor(next: unknown, fileKey: unknown): string | null {
  if (next === undefined || next === null) return null;
  let url: URL;
  try {
    url = new URL(text(next));
  } catch {
    return incomplete("Figma returned an invalid version continuation.");
  }
  if (
    url.origin !== "https://api.figma.com" ||
    url.pathname !== `/v1/files/${segment(fileKey)}/versions` ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !["before", "page_size"].includes(key)) ||
    url.searchParams.getAll("before").length !== 1 ||
    !/^[0-9]+$/.test(url.searchParams.get("before") ?? "")
  )
    return incomplete("Figma returned an invalid version continuation.");
  return url.searchParams.get("before");
}
export function createFigmaActions(): NativeAction[] {
  return businessActions(
    contract.actions,
    async (args, run) => {
      const id = run.definition.id,
        base = `/v1/files/${segment(args.fileKey)}`;
      if (id === "figma.files.get") {
        const body = object(
          (
            await run.request({
              method: "GET",
              path: base,
              query: {
                depth: Number(args.depth ?? 2),
                version: args.version as string | undefined,
              },
            })
          ).body,
        );
        text(body.name);
        text(body.version);
        identity(body.document);
        return run.finish({
          action_id: id,
          fileKey: args.fileKey,
          file: body,
          depth: args.depth ?? 2,
          completeTree: false,
        });
      }
      if (id === "figma.nodes.get") {
        const body = object(
            (
              await run.request({
                method: "GET",
                path: `${base}/nodes`,
                query: { ids: (args.ids as string[]).join(","), depth: Number(args.depth ?? 2) },
              })
            ).body,
          ),
          nodes = object(body.nodes);
        const items = (args.ids as string[]).map((nodeId) => {
          if (nodes[nodeId] === null) return { nodeId, available: false };
          const result = object(nodes[nodeId]),
            document = identity(result.document);
          if (document.id !== nodeId) return incomplete("Figma returned another selected node.");
          return { nodeId, available: true, ...result };
        });
        return run.finish({
          action_id: id,
          fileKey: args.fileKey,
          items,
          depth: args.depth ?? 2,
          completeTree: false,
        });
      }
      if (id === "figma.images.render") {
        const body = object(
          (
            await run.request({
              method: "GET",
              path: `/v1/images/${segment(args.fileKey)}`,
              query: {
                ids: (args.ids as string[]).join(","),
                format: String(args.format ?? "png"),
                scale: Number(args.scale ?? 1),
              },
            })
          ).body,
        );
        if (body.err !== undefined && body.err !== null)
          return incomplete("Figma did not complete this image render.");
        const images = object(body.images),
          items = [];
        for (const nodeId of args.ids as string[]) {
          const url = images[nodeId];
          if (url === null) {
            items.push({ nodeId, rendered: false, url: null });
            continue;
          }
          if (typeof url !== "string" || !url)
            return incomplete("Figma omitted a selected node render result.");
          await run.context.validateResourceUrl(url);
          items.push({ nodeId, rendered: true, url });
        }
        return run.finish({
          action_id: id,
          fileKey: args.fileKey,
          items,
          linksExpire: true,
          storedAsArtifact: false,
        });
      }
      if (id === "figma.versions.list") {
        const body = object(
          (
            await run.request({
              method: "GET",
              path: `${base}/versions`,
              query: {
                page_size: Number(args.pageSize ?? 30),
                before: args.before as string | undefined,
              },
            })
          ).body,
        );
        const cursor = versionCursor(object(body.pagination).next_page, args.fileKey);
        return run.finish({
          action_id: id,
          items: array(body.versions).map(identity),
          hasMore: cursor !== null,
          nextBefore: cursor,
          allPagesRead: args.before === undefined && cursor === null,
        });
      }
      if (id === "figma.components.list") {
        const body = object(
          (await run.request({ method: "GET", path: `${base}/components` })).body,
        );
        if (body.error !== false || body.status !== 200)
          return incomplete("Figma did not return a complete component result.");
        const items = array(object(body.meta).components).map((item) => {
          const row = object(item);
          text(row.key);
          text(row.node_id);
          return row;
        });
        return run.finish({
          action_id: id,
          fileKey: args.fileKey,
          items,
          hasMore: false,
          allPagesRead: true,
        });
      }
      if (id === "figma.comments.list" || id === "figma.comments.delete") {
        const body = object(
            (await run.request({ method: "GET", path: `${base}/comments`, query: { as_md: true } }))
              .body,
          ),
          comments = array(body.comments).map(identity);
        if (id === "figma.comments.list")
          return run.finish({ action_id: id, items: comments, hasMore: false, allPagesRead: true });
        const comment = comments.find((row) => row.id === args.commentId);
        if (!comment)
          throw new NativeActionError(
            "resource_unavailable",
            "The selected comment is unavailable.",
          );
        if (object(comment.user).id !== run.context.principal.subject)
          throw new NativeActionError(
            "insufficient_scope",
            "Only comments authored by this connected user can be deleted.",
          );
        const response = await run.request(
          { method: "DELETE", path: `${base}/comments/${segment(args.commentId)}` },
          true,
        );
        if (response.status !== 200 && response.status !== 204)
          return run.unknown("Figma did not confirm comment deletion.");
        return run.finish(
          { action_id: id, commentId: args.commentId, deleted: true },
          { resource_id: args.commentId },
        );
      }
      const comment = identity(
        (
          await run.request(
            {
              method: "POST",
              path: `${base}/comments`,
              body: {
                message: args.message,
                ...(args.commentId ? { comment_id: args.commentId } : {}),
              },
            },
            true,
          )
        ).body,
      );
      if (
        comment.file_key !== args.fileKey ||
        object(comment.user).id !== run.context.principal.subject
      )
        return run.unknown("Figma returned another author or file for the posted comment.");
      return run.finish({ action_id: id, comment }, { resource_id: comment.id });
    },
    (def, ctx) => {
      authorize("figma", def, ctx);
      if (def.id === "figma.comments.delete") {
        const configured = ctx.principal.context.configuredScopes;
        if (
          ctx.principal.context.scopeAuthority === "provider_enforced"
            ? !Array.isArray(configured) || !configured.includes("file_comments:read")
            : !ctx.principal.scopes.includes("file_comments:read")
        )
          throw new NativeActionError(
            "insufficient_scope",
            "Deleting with an authorship check also requires comment read access.",
          );
      }
    },
  );
}
export const figmaActions = createFigmaActions();
