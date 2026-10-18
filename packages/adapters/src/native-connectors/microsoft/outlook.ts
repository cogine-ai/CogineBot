import type { NativeAction } from "../action.js";
import type { Data } from "./graph.js";
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
  resource,
  saveFile,
  segment,
  text,
  window,
  write,
} from "./graph.js";
import calendarContract from "./outlook-calendar.contract.json" with { type: "json" };
import mailContract from "./outlook-mail.contract.json" with { type: "json" };

const recipient = (address: unknown) => ({ emailAddress: { address } });
export function createOutlookMailActions(): NativeAction[] {
  return graphActions(mailContract.actions, async (args, run) => {
    const id = run.definition.id,
      path = `/me/messages/${segment(args.messageId)}`;
    if (id === "outlook.messages.list")
      return list(
        run,
        args.folderId ? `/me/mailFolders/${segment(args.folderId)}/messages` : "/me/messages",
        args,
        {
          ...(args.search ? { $search: `"${String(args.search).replace(/["\\]/g, " ")}"` } : {}),
          $select:
            "id,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments,conversationId,webLink",
        },
      );
    if (id === "outlook.messages.get")
      return run.finish(resource(await get(run, path), args.messageId));
    if (id === "outlook.attachments.list")
      return list(run, `${path}/attachments`, args, {
        $select: "id,name,size,contentType,isInline",
      });
    if (id === "outlook.attachments.download") {
      const attachmentPath = `${path}/attachments/${segment(args.attachmentId)}`;
      const attachment = resource(
        await get(run, attachmentPath, { $select: "id,name,size,contentType" }),
        args.attachmentId,
      );
      if (
        attachment["@odata.type"] !== "#microsoft.graph.fileAttachment" ||
        typeof attachment.size !== "number" ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size < 0 ||
        attachment.size > 10 * 1024 * 1024
      )
        return invalid(
          "Only bounded file attachments can be downloaded; reference and item attachments need their own source application.",
        );
      const response = await run.request({
        method: "GET",
        path: `${attachmentPath}/$value`,
        responseType: "bytes",
      });
      if (!(response.body instanceof Uint8Array) || response.body.byteLength !== attachment.size)
        return incomplete("Microsoft omitted the complete attachment bytes.");
      const bytes = response.body;
      return run.finish(
        await saveFile(run.context, bytes, text(attachment.name), text(attachment.contentType)),
      );
    }
    if (id === "outlook.drafts.create") {
      const body: Data = {
        subject: args.subject,
        body: args.body,
        toRecipients: (args.to as unknown[]).map(recipient),
        ...(args.cc ? { ccRecipients: (args.cc as unknown[]).map(recipient) } : {}),
      };
      if (args.attachments) {
        const attachments = [];
        let total = 0;
        for (const row of args.attachments as Data[]) {
          const file = await artifact(run.context, row.artifactId, 2999999);
          total += file.bytes.byteLength;
          if (total > 2999999) return invalid("Keep the combined draft attachments below 3 MB.");
          attachments.push({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: file.name,
            contentType: file.mimeType,
            contentBytes: Buffer.from(file.bytes).toString("base64"),
          });
        }
        body.attachments = attachments;
      }
      const response = await run.request({ method: "POST", path: "/me/messages", body }, true);
      const draft = resource(response.body);
      if (draft.isDraft !== true) return run.unknown("Microsoft did not confirm an unsent draft.");
      return run.finish(draft, { resource_id: draft.id });
    }
    if (id === "outlook.drafts.send") {
      // Mail.Send alone cannot read a draft. The exact draft ID is caller-selected; Graph rejects non-drafts.
      await run.request({ method: "POST", path: `${path}/send` }, true, "dispatching", {
        acceptedStatus: 202,
      });
      return run.finish(
        {
          id: args.messageId,
          accepted: true,
          deliveryVerified: false,
          terminalStateVerified: false,
        },
        { resource_id: args.messageId },
      );
    }
    if (id === "outlook.messages.reply") {
      await run.request(
        { method: "POST", path: `${path}/reply`, body: { comment: args.comment } },
        true,
        "dispatching",
        { acceptedStatus: 202 },
      );
      return run.finish(
        {
          id: args.messageId,
          accepted: true,
          deliveryVerified: false,
          terminalStateVerified: false,
        },
        { resource_id: args.messageId },
      );
    }
    if (id === "outlook.messages.move")
      return write(run, {
        method: "POST",
        path: `${path}/move`,
        body: { destinationId: args.destinationId },
      });
    return incomplete("Missing frozen Outlook mail action.");
  });
}
const eventKeys = ["subject", "body", "start", "end", "attendees", "isAllDay", "location"] as const;
function eventChanges(args: Data): Data {
  const body = changes(args, eventKeys);
  if (body.attendees)
    body.attendees = (body.attendees as Data[]).map((row) => ({
      emailAddress: { address: row.address, ...(row.name ? { name: row.name } : {}) },
      type: row.type ?? "required",
    }));
  if (body.location) body.location = { displayName: body.location };
  for (const key of ["start", "end"])
    if (body[key]) {
      const value = object(body[key]);
      if (!Number.isFinite(Date.parse(String(value.dateTime))))
        return invalid("Use a valid calendar date and time with an explicit time zone.");
    }
  return body;
}
export function createOutlookCalendarActions(): NativeAction[] {
  return graphActions(calendarContract.actions, async (args, run) => {
    const id = run.definition.id,
      path = `/me/events/${segment(args.eventId)}`;
    if (id === "outlook_calendar.calendars.list") return list(run, "/me/calendars", args);
    if (id === "outlook_calendar.events.list") {
      window(args.startDateTime, args.endDateTime);
      return list(run, `/me/calendars/${segment(args.calendarId)}/calendarView`, args, {
        startDateTime: args.startDateTime as string,
        endDateTime: args.endDateTime as string,
      });
    }
    if (id === "outlook_calendar.events.get")
      return run.finish(resource(await get(run, path), args.eventId));
    if (id === "outlook_calendar.schedule.get") {
      const body = object(
        (
          await run.request({
            method: "POST",
            path: "/me/calendar/getSchedule",
            body: changes(args, ["schedules", "startTime", "endTime", "availabilityViewInterval"]),
          })
        ).body,
      );
      if (!Array.isArray(body.value) || body.value.length !== (args.schedules as unknown[]).length)
        return incomplete("Microsoft omitted a requested availability result.");
      return run.finish({ schedules: body.value });
    }
    if (id === "outlook_calendar.events.create")
      return write(run, {
        method: "POST",
        path: `/me/calendars/${segment(args.calendarId)}/events`,
        body: { ...eventChanges(args), transactionId: run.context.operationId },
      });
    if (id === "outlook_calendar.events.update")
      return write(
        run,
        { method: "PATCH", path, headers: ifMatch(args), body: eventChanges(args) },
        args.eventId,
      );
    if (id === "outlook_calendar.events.delete")
      return write(run, { method: "DELETE", path, headers: ifMatch(args) }, args.eventId);
    if (id === "outlook_calendar.events.cancel") {
      await run.request(
        { method: "POST", path: `${path}/cancel`, body: { comment: args.comment ?? "" } },
        true,
        "dispatching",
        { acceptedStatus: 202 },
      );
      return run.finish(
        { id: args.eventId, accepted: true, deliveryVerified: false, terminalStateVerified: false },
        { resource_id: args.eventId },
      );
    }
    return incomplete("Missing frozen Outlook calendar action.");
  });
}
