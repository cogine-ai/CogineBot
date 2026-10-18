import type { NativeActionContext } from "../action.js";
import { NativeActionError } from "../action.js";
import {
  boundTarget,
  discordBot,
  discordTarget,
  id,
  PERMISSIONS,
  requireDiscord,
  telegramBot,
  telegramTarget,
} from "../bot-platforms/permissions.js";
import { array, object } from "../collaboration-action.js";
import { logicalError } from "../enterprise/common.js";
import { odataString } from "../microsoft/graph.js";
import type { RemainingEventSpec, RemainingReadApi } from "./remaining-transport.js";

const enc = encodeURIComponent;
const unavailable = (): never => {
  throw new NativeActionError(
    "resource_unavailable",
    "The exact selected event resource could not be verified.",
  );
};
function exact(value: unknown, expected: string) {
  const row = object(value);
  if (row.id !== expected) return unavailable();
  return row;
}
/** Enrollment reads the exact resource using the same account and transport used by the Routine reader. */
export async function verifyRemainingEventResource(
  spec: RemainingEventSpec,
  api: RemainingReadApi,
  principal: NativeActionContext["principal"],
): Promise<void> {
  switch (spec.kind) {
    case "sharepoint.list_item.changed":
      exact(await api.get(`/sites/${enc(spec.siteId)}`), spec.siteId);
      exact(await api.get(`/sites/${enc(spec.siteId)}/lists/${enc(spec.listId)}`), spec.listId);
      return;
    case "excel.range.changed": {
      const base = `/drives/${enc(spec.driveId)}/items/${enc(spec.itemId)}`;
      const file = exact(await api.get(base, { $select: "id,parentReference,file" }), spec.itemId);
      if (object(file.parentReference).driveId !== spec.driveId || !file.file) return unavailable();
      exact(
        await api.get(`${base}/workbook/worksheets/${enc(spec.worksheetId)}`),
        spec.worksheetId,
      );
      const range = object(
        await api.get(
          `${base}/workbook/worksheets/${enc(spec.worksheetId)}/range(address=${odataString(spec.address)})`,
        ),
      );
      const canonical = (value: string) => value.replaceAll("$", "").toUpperCase();
      if (
        typeof range.address !== "string" ||
        canonical(range.address.split("!").at(-1)!) !== canonical(spec.address) ||
        !Number.isSafeInteger(range.rowCount) ||
        !Number.isSafeInteger(range.columnCount) ||
        Number(range.rowCount) < 1 ||
        Number(range.columnCount) < 1 ||
        Number(range.rowCount) * Number(range.columnCount) > 10000
      )
        return unavailable();
      return;
    }
    case "planner.task.changed":
      exact(await api.get(`/planner/plans/${enc(spec.planId)}`), spec.planId);
      return;
    case "teams.channel_message.created":
      exact(
        await api.get(`/teams/${enc(spec.teamId)}/channels/${enc(spec.channelId)}`),
        spec.channelId,
      );
      return;
    case "feishu.calendar_event.changed": {
      const body = object(await api.get(`/calendar/v4/calendars/${enc(spec.calendarId)}`));
      logicalError("feishu", body);
      if (object(object(body.data).calendar).calendar_id !== spec.calendarId) return unavailable();
      return;
    }
    case "dingtalk.calendar_event.changed": {
      const body = object(await api.get(`/v1.0/calendar/users/${enc(spec.userId)}/calendars`));
      logicalError("dingtalk", body);
      if (
        !array(object(body.response).calendars).some(
          (value) => object(value).id === spec.calendarId,
        )
      )
        return unavailable();
      return;
    }
    case "wecom.schedule.changed": {
      const body = object(await api.post("/oa/calendar/get", { cal_id_list: [spec.calendarId] }));
      logicalError("wecom", body);
      const rows = array(body.calendar_list);
      if (rows.length !== 1 || object(rows[0]).cal_id !== spec.calendarId) return unavailable();
      return;
    }
    case "telegram.pinned_message.changed": {
      boundTarget(principal, spec.chatId, "telegram-bot");
      if (id((await telegramBot(api.request)).id) !== principal.subject) return unavailable();
      await telegramTarget(api.request, principal.subject, spec.chatId);
      return;
    }
    case "discord.channel_message.created":
    case "discord.command.invoked": {
      boundTarget(principal, spec.channelId, "discord");
      if (id((await discordBot(api.request)).id) !== principal.subject || !principal.tenant)
        return unavailable();
      const target = await discordTarget(
        api.request,
        principal.subject,
        principal.tenant,
        spec.channelId,
      );
      if (spec.kind === "discord.channel_message.created") {
        requireDiscord(target, PERMISSIONS.READ_MESSAGE_HISTORY);
        return;
      }
      if (
        spec.guildId !== principal.tenant ||
        typeof principal.context.applicationId !== "string" ||
        typeof principal.context.interactionPublicKey !== "string"
      )
        return unavailable();
      const appId = principal.context.applicationId;
      exact(await api.get("/oauth2/applications/@me"), appId);
      const command = exact(
        await api.get(
          `/applications/${enc(appId)}/guilds/${enc(spec.guildId)}/commands/${enc(spec.commandId)}`,
        ),
        spec.commandId,
      );
      if (
        command.application_id !== appId ||
        command.guild_id !== spec.guildId ||
        command.name !== spec.commandName ||
        command.type !== 1
      )
        return unavailable();
      return;
    }
  }
}
