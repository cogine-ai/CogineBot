import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import type { NativeAction, NativeRequest } from "../action.js";
import { NativeActionError } from "../action.js";
import { array, identity, incomplete, object, text } from "../collaboration-action.js";
import { authorize, businessActions, resourceName } from "./common.js";
import contract from "./dropbox.contract.json" with { type: "json" };

const apiArg = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
function fileIdentity(value: unknown): Record<string, unknown> {
  const row = identity(value);
  if (!["file", "folder", "deleted"].includes(String(row[".tag"])))
    return incomplete("Dropbox returned no resource type.");
  return row;
}
function concreteFile(value: unknown): Record<string, unknown> {
  const row = identity(value);
  if (
    (row[".tag"] !== undefined && row[".tag"] !== "file") ||
    typeof row.size !== "number" ||
    !Number.isSafeInteger(row.size) ||
    row.size < 0 ||
    typeof row.rev !== "string" ||
    !row.rev ||
    typeof row.name !== "string" ||
    !row.name
  )
    return incomplete("Dropbox returned incomplete file metadata.");
  return row;
}
function concreteFolder(value: unknown): Record<string, unknown> {
  const row = identity(value);
  if (
    (row[".tag"] !== undefined && row[".tag"] !== "folder") ||
    typeof row.name !== "string" ||
    !row.name
  )
    return incomplete("Dropbox returned incomplete folder metadata.");
  return row;
}
export function createDropboxActions(): NativeAction[] {
  return businessActions(
    contract.actions,
    async (args, run) => {
      const id = run.definition.id;
      if (id === "dropbox.shared_links.create") {
        const link = object(
          (
            await run.request(
              {
                method: "POST",
                path: "/2/sharing/create_shared_link_with_settings",
                body: {
                  path: args.path,
                  settings: {
                    access: { ".tag": "viewer" },
                    requested_visibility: { ".tag": args.visibility },
                    allow_download: args.allowDownload ?? true,
                  },
                },
              },
              true,
            )
          ).body,
        );
        if (!["file", "folder"].includes(String(link[".tag"])))
          return run.unknown("Dropbox omitted the shared resource type.");
        const url = text(link.url),
          permissions = object(link.link_permissions),
          visibility = text(object(permissions.resolved_visibility)[".tag"]);
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return run.unknown("Dropbox returned an invalid shared link.");
        }
        if (
          parsed.origin !== "https://www.dropbox.com" ||
          parsed.username ||
          parsed.password ||
          !["public", "team_only", "password", "shared_folder_only"].includes(visibility)
        )
          return run.unknown("Dropbox returned an unsupported shared link.");
        if (args.visibility === "team_only" && visibility !== "team_only")
          return run.unknown("Dropbox did not confirm the requested team-only visibility.");
        if (args.allowDownload === false && permissions.allow_download !== false)
          return run.unknown("Dropbox did not confirm the requested download restriction.");
        return run.finish(
          { action_id: id, sharedLink: link, resolvedVisibility: visibility },
          { resource_id: url },
        );
      }
      if (id === "dropbox.files.list" || id === "dropbox.files.search") {
        const listing = id === "dropbox.files.list",
          continuing = args.cursor !== undefined;
        const body = object(
          (
            await run.request({
              method: "POST",
              path: listing
                ? continuing
                  ? "/2/files/list_folder/continue"
                  : "/2/files/list_folder"
                : continuing
                  ? "/2/files/search/continue_v2"
                  : "/2/files/search_v2",
              body: continuing
                ? { cursor: args.cursor }
                : listing
                  ? {
                      path: args.path,
                      recursive: args.recursive ?? false,
                      limit: args.limit ?? 100,
                      include_deleted: false,
                    }
                  : {
                      query: args.query,
                      options: { path: args.path ?? "", max_results: args.limit ?? 100 },
                    },
            })
          ).body,
        );
        const rows = array(listing ? body.entries : body.matches).map((item) =>
          listing ? fileIdentity(item) : fileIdentity(object(object(item).metadata).metadata),
        );
        if (
          typeof body.has_more !== "boolean" ||
          (body.has_more && (typeof body.cursor !== "string" || !body.cursor))
        )
          return incomplete("Dropbox omitted its continuation cursor.");
        return run.finish({
          action_id: id,
          items: rows,
          hasMore: body.has_more,
          nextCursor: body.has_more ? body.cursor : null,
          allPagesRead: !continuing && !body.has_more,
        });
      }
      if (id === "dropbox.files.get") {
        const row = fileIdentity(
          (
            await run.request({
              method: "POST",
              path: "/2/files/get_metadata",
              body: { path: args.path, include_deleted: false },
            })
          ).body,
        );
        return run.finish({ action_id: id, metadata: row });
      }
      if (id === "dropbox.files.download") {
        if (!run.context.writeArtifact)
          throw new NativeActionError("not_configured", "Private file artifacts are unavailable.");
        const response = await run.request({
          method: "POST",
          path: "/2/files/download",
          service: "dropbox-content" as NativeRequest["service"],
          headers: { "Dropbox-API-Arg": apiArg({ path: args.path }) },
          responseType: "bytes",
        });
        if (
          !(response.body instanceof Uint8Array) ||
          response.body.byteLength > ATTACHMENT_MAX_BYTES
        )
          return incomplete("Dropbox returned an invalid or oversized private file.");
        let metadata: Record<string, unknown>;
        try {
          metadata = concreteFile(JSON.parse(response.headers.get("dropbox-api-result") ?? "null"));
        } catch {
          return incomplete("Dropbox omitted its downloaded file identity.");
        }
        if (metadata.size !== response.body.byteLength)
          return incomplete("Dropbox returned incomplete file bytes.");
        const artifact = await run.context.writeArtifact({
          bytes: response.body,
          name: resourceName(metadata.name),
          mimeType:
            response.headers.get("content-type")?.split(";")[0] || "application/octet-stream",
        });
        return run.finish({ action_id: id, metadata, artifact });
      }
      if (id === "dropbox.files.upload") {
        const artifact = await run.context.readArtifact(String(args.artifactId));
        if (artifact.bytes.byteLength > ATTACHMENT_MAX_BYTES)
          throw new NativeActionError("invalid_input", "The file exceeds the attachment limit.");
        const metadata = concreteFile(
          (
            await run.request(
              {
                method: "POST",
                path: "/2/files/upload",
                service: "dropbox-content" as NativeRequest["service"],
                headers: {
                  "content-type": "application/octet-stream",
                  "Dropbox-API-Arg": apiArg({
                    path: args.path,
                    mode: args.expectedRev
                      ? { ".tag": "update", update: args.expectedRev }
                      : { ".tag": "add" },
                    autorename: false,
                    strict_conflict: true,
                    mute: false,
                  }),
                },
                body: artifact.bytes,
              },
              true,
            )
          ).body,
        );
        if (metadata.size !== artifact.bytes.byteLength)
          return run.unknown("Dropbox did not return the uploaded file revision.");
        return run.finish(
          { action_id: id, metadata },
          { resource_id: metadata.id, rev: metadata.rev },
        );
      }
      const path =
        id === "dropbox.folders.create"
          ? "/2/files/create_folder_v2"
          : id === "dropbox.files.move"
            ? "/2/files/move_v2"
            : "/2/files/delete_v2";
      const body =
        id === "dropbox.folders.create"
          ? { path: args.path, autorename: false }
          : id === "dropbox.files.move"
            ? {
                from_path: args.fromPath,
                to_path: args.toPath,
                autorename: false,
                allow_ownership_transfer: false,
              }
            : { path: args.path, ...(args.expectedRev ? { parent_rev: args.expectedRev } : {}) };
      const received = object(
        (await run.request({ method: "POST", path, body }, true)).body,
      ).metadata;
      const metadata =
        id === "dropbox.folders.create" ? concreteFolder(received) : fileIdentity(received);
      return run.finish({ action_id: id, metadata }, { resource_id: text(metadata.id) });
    },
    (def, ctx) => authorize("dropbox", def, ctx),
  );
}
export const dropboxActions = createDropboxActions();
