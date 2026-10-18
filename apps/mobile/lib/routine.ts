import type { Routine } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { t } from "./i18n";

export function routineStatusLine(routine: Routine): string {
  const triggers = [
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("calendar."))
      ? [t("Calendar event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("notion."))
      ? [t("Notion event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("gmail."))
      ? [t("Gmail event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("drive."))
      ? [t("Drive event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("slack."))
      ? [t("Slack bot event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("sharepoint."))
      ? [t("SharePoint event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("excel."))
      ? [t("Excel event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("planner."))
      ? [t("Planner event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("teams."))
      ? [t("Teams event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("feishu."))
      ? [t("Feishu / Lark event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("dingtalk."))
      ? [t("DingTalk event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("wecom."))
      ? [t("WeCom event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("telegram."))
      ? [t("Telegram bot event")]
      : []),
    ...(routine.nativeTriggers?.some((trigger) => trigger.spec.kind.startsWith("discord."))
      ? [t("Discord bot event")]
      : []),
    ...routine.crons.map(formatCron),
    ...(routine.webhookEnabled ? [t("Webhook")] : []),
    ...(routine.githubEnabled ? [t("Git event")] : []),
    ...(routine.messageProvider === "slack"
      ? [t("Slack message")]
      : routine.messageProvider === "teams"
        ? [t("Teams message")]
        : routine.messageProvider
          ? [t("Message event")]
          : []),
  ].join(", ");
  return [routine.active ? t("Active") : t("Paused"), triggers, routine.timezone]
    .filter(Boolean)
    .join(" · ");
}
