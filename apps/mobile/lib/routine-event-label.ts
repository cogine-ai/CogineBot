import type { NativeRoutineEventKind } from "@rakazo/contracts";
import { t } from "./i18n";

export function routineEventLabel(kind: NativeRoutineEventKind): string {
  switch (kind) {
    case "sharepoint.list_item.changed":
      return t("SharePoint list item changed");
    case "excel.range.changed":
      return t("Excel range changed");
    case "planner.task.changed":
      return t("Planner task changed");
    case "teams.channel_message.created":
      return t("New Teams channel message");
    case "feishu.calendar_event.changed":
      return t("Feishu / Lark calendar changed");
    case "dingtalk.calendar_event.changed":
      return t("DingTalk calendar changed");
    case "wecom.schedule.changed":
      return t("WeCom schedule changed");
    case "telegram.pinned_message.changed":
      return t("Telegram pinned message changed");
    case "discord.channel_message.created":
      return t("New Discord channel message");
    case "discord.command.invoked":
      return t("Discord command invoked");
    case "calendar.event_changed":
      return t("Calendar event changed");
    case "calendar.event_starting":
      return t("Before a Calendar event");
    case "notion.page_content_changed":
      return t("Notion page content changed");
    case "notion.page_properties_or_data_source_changed":
      return t("Notion properties or data source changed");
    case "notion.comment_changed":
      return t("Notion comments changed");
    case "gmail.message_received":
      return t("New Gmail message");
    case "gmail.thread_or_label_changed":
      return t("Gmail thread or labels changed");
    case "drive.file_changed":
      return t("Drive file changed");
    case "drive.file_trashed":
      return t("Drive file moved to trash");
    case "slack.app_mention":
      return t("This Slack bot is mentioned");
    case "slack.app_dm":
      return t("Direct message to this Slack bot");
    case "slack.channel_message":
      return t("Message in a Slack channel");
  }
}
