import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import type { NativeAction } from "../action.js";
import {
  artifact,
  changes,
  get,
  graphActions,
  ifMatch,
  incomplete,
  invalid,
  list,
  object,
  odataString,
  resource,
  saveFile,
  segment,
  text,
  validName,
  write,
} from "./graph.js";
import todoContract from "./microsoft-todo.contract.json" with { type: "json" };
import driveContract from "./onedrive.contract.json" with { type: "json" };
import spContract from "./sharepoint.contract.json" with { type: "json" };

export function createOneDriveActions(): NativeAction[] {
  return graphActions(driveContract.actions, async (args, run) => {
    const id = run.definition.id,
      base = args.driveId ? `/drives/${segment(args.driveId)}` : "/me/drive",
      path = `${base}/items/${segment(args.itemId)}`;
    if (id === "onedrive.children.list")
      return list(
        run,
        `${base}/items/${args.itemId ? segment(args.itemId) : "root"}/children`,
        args,
      );
    if (id === "onedrive.items.search")
      return list(run, `${base}/root/search(q=${odataString(args.query)})`, args);
    if (id === "onedrive.items.get") return run.finish(resource(await get(run, path), args.itemId));
    if (id === "onedrive.files.download") {
      const file = object(await get(run, path));
      resource(file, args.itemId);
      if (
        !file.file ||
        typeof file.size !== "number" ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > ATTACHMENT_MAX_BYTES
      )
        return invalid("Select a complete file within the local attachment size limit.");
      if (!run.context.downloadResource)
        return invalid("The Microsoft private download transport is unavailable.");
      // URL comes only from the fixed Graph metadata response. The composition root validates public HTTPS/CDN authority, pins DNS and never sends a bearer token.
      const downloaded = await run.context.downloadResource({
        url: text(file["@microsoft.graph.downloadUrl"]),
        maxBytes: ATTACHMENT_MAX_BYTES,
      });
      if (downloaded.bytes.byteLength !== file.size)
        return incomplete("The downloaded Microsoft file is incomplete.");
      return run.finish(
        await saveFile(
          run.context,
          downloaded.bytes,
          text(file.name),
          typeof object(file.file).mimeType === "string"
            ? String(object(file.file).mimeType)
            : downloaded.mimeType,
        ),
      );
    }
    if (id === "onedrive.files.upload") {
      const file = await artifact(run.context, args.artifactId);
      return write(run, {
        method: "PUT",
        path: `${base}/items/${segment(args.parentId)}:/${segment(validName(args.name))}:/content`,
        query: { "@microsoft.graph.conflictBehavior": "fail" },
        headers: { "content-type": file.mimeType },
        body: file.bytes,
      });
    }
    if (id === "onedrive.folders.create")
      return write(run, {
        method: "POST",
        path: `${base}/items/${segment(args.parentId)}/children`,
        body: {
          name: validName(args.name),
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        },
      });
    if (id === "onedrive.items.move")
      return write(
        run,
        {
          method: "PATCH",
          path,
          headers: ifMatch(args),
          body: {
            parentReference: { id: args.parentId },
            ...(args.name ? { name: validName(args.name) } : {}),
          },
        },
        args.itemId,
      );
    if (id === "onedrive.links.create") {
      const output = await run.request(
        {
          method: "POST",
          path: `${path}/createLink`,
          body: { type: args.type, scope: args.scope },
        },
        true,
      );
      const permission = resource(output.body),
        link = object(permission.link);
      if (
        link.type !== args.type ||
        link.scope !== args.scope ||
        !text(link.webUrl).startsWith("https://")
      )
        return run.unknown("Microsoft did not confirm the requested sharing link policy.");
      return run.finish(permission, { resource_id: permission.id });
    }
    return incomplete("Missing frozen OneDrive action.");
  });
}
const todoKeys = [
  "title",
  "body",
  "dueDateTime",
  "reminderDateTime",
  "isReminderOn",
  "importance",
  "status",
] as const;
export function createMicrosoftTodoActions(): NativeAction[] {
  return graphActions(todoContract.actions, async (args, run) => {
    const id = run.definition.id,
      tasks = `/me/todo/lists/${segment(args.listId)}/tasks`,
      task = `${tasks}/${segment(args.taskId)}`;
    if (id === "microsoft_todo.lists.list") return list(run, "/me/todo/lists", args);
    if (id === "microsoft_todo.lists.create")
      return write(run, {
        method: "POST",
        path: "/me/todo/lists",
        body: { displayName: args.displayName },
      });
    if (id === "microsoft_todo.tasks.list") return list(run, tasks, args);
    if (id === "microsoft_todo.tasks.get")
      return run.finish(resource(await get(run, task), args.taskId));
    if (id === "microsoft_todo.tasks.create" || id === "microsoft_todo.tasks.update") {
      const body = changes(args, todoKeys);
      for (const key of ["dueDateTime", "reminderDateTime"])
        if (body[key] && !Number.isFinite(Date.parse(String(object(body[key]).dateTime))))
          return invalid("Use a valid date-time for To Do reminders and due dates.");
      if (body.isReminderOn === true && !body.reminderDateTime)
        return invalid("Include an explicit reminder time when enabling a reminder.");
      return write(
        run,
        {
          method: id.endsWith("create") ? "POST" : "PATCH",
          path: id.endsWith("create") ? tasks : task,
          body,
          ...(id.endsWith("update") ? { headers: ifMatch(args) } : {}),
        },
        id.endsWith("update") ? args.taskId : undefined,
      );
    }
    if (id === "microsoft_todo.checklist.list") return list(run, `${task}/checklistItems`, args);
    if (id === "microsoft_todo.checklist.create")
      return write(run, {
        method: "POST",
        path: `${task}/checklistItems`,
        body: { displayName: args.displayName, isChecked: args.isChecked ?? false },
      });
    return incomplete("Missing frozen Microsoft To Do action.");
  });
}
export function createSharePointActions(): NativeAction[] {
  return graphActions(spContract.actions, async (args, run) => {
    const id = run.definition.id,
      site = `/sites/${segment(args.siteId)}`,
      items = `${site}/lists/${segment(args.listId)}/items`,
      item = `${items}/${segment(args.itemId)}`;
    if (id === "sharepoint.sites.get")
      return run.finish(resource(await get(run, site), args.siteId));
    if (id === "sharepoint.drives.list") return list(run, `${site}/drives`, args);
    if (id === "sharepoint.lists.list") return list(run, `${site}/lists`, args);
    if (id === "sharepoint.items.list") return list(run, items, args, { $expand: "fields" });
    if (id === "sharepoint.items.get")
      return run.finish(resource(await get(run, item, { $expand: "fields" }), args.itemId));
    if (id === "sharepoint.items.create")
      return write(run, { method: "POST", path: items, body: { fields: args.fields } });
    if (id === "sharepoint.items.delete")
      return write(run, { method: "DELETE", path: item, headers: ifMatch(args) }, args.itemId);
    if (id === "sharepoint.items.update") {
      const response = await run.request(
        { method: "PATCH", path: `${item}/fields`, headers: ifMatch(args), body: args.fields },
        true,
      );
      const fields = object(response.body);
      // fieldValueSet has no id; the exact item path and If-Match bind the acknowledged write.
      return run.finish({ id: args.itemId, fields }, { resource_id: args.itemId });
    }
    return incomplete("Missing frozen SharePoint action.");
  });
}
