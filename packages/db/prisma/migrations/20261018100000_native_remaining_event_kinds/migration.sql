-- Extend the existing explicit Routine bridge; no new source worker or event table.
BEGIN;
ALTER TABLE "native_routine_triggers" DROP CONSTRAINT "native_routine_triggers_kind";
ALTER TABLE "native_routine_triggers" ADD CONSTRAINT "native_routine_triggers_kind" CHECK ("kind" IN (
  'calendar.event_changed','calendar.event_starting',
  'notion.page_content_changed','notion.page_properties_or_data_source_changed','notion.comment_changed',
  'gmail.message_received','gmail.thread_or_label_changed','drive.file_changed','drive.file_trashed',
  'slack.app_mention','slack.app_dm','slack.channel_message',
  'sharepoint.list_item.changed','excel.range.changed','planner.task.changed','teams.channel_message.created',
  'feishu.calendar_event.changed','dingtalk.calendar_event.changed','wecom.schedule.changed',
  'telegram.pinned_message.changed','discord.channel_message.created','discord.command.invoked'
));
COMMIT;
