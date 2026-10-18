import type { Connection, NativeRoutineEventSpec, NativeRoutineTrigger } from "@rakazo/contracts";
import { CreateRoutineInput, nativeEventApp } from "@rakazo/contracts";
import { expect, it } from "vitest";
import {
  draftFromNativeRoutineTrigger,
  emptyNativeRoutineTriggerDraft,
  nativeEventAccounts,
  nativeEventAppForKind,
  nativeRoutineTriggerInputs,
  resetNativeRoutineTriggerDraft,
} from "./routine-native-events";

const PAGE = "11111111-1111-4111-8111-111111111111";
const specs: NativeRoutineEventSpec[] = [
  { kind: "sharepoint.list_item.changed", siteId: "site", listId: "list" },
  {
    kind: "excel.range.changed",
    driveId: "drive",
    itemId: "workbook",
    worksheetId: "sheet",
    address: "A1:B2",
  },
  { kind: "planner.task.changed", planId: "plan" },
  { kind: "teams.channel_message.created", teamId: "team", channelId: "channel" },
  { kind: "feishu.calendar_event.changed", calendarId: "calendar" },
  {
    kind: "dingtalk.calendar_event.changed",
    userId: "user",
    calendarId: "calendar",
    timeMin: "2026-10-18T00:00:00Z",
    timeMax: "2026-10-19T00:00:00Z",
  },
  { kind: "wecom.schedule.changed", calendarId: "calendar" },
  { kind: "telegram.pinned_message.changed", chatId: "-100123456" },
  { kind: "discord.channel_message.created", channelId: "423456789012345678" },
  {
    kind: "discord.command.invoked",
    guildId: "323456789012345678",
    channelId: "423456789012345678",
    commandId: "523456789012345678",
    commandName: "review",
  },

  { kind: "calendar.event_changed", calendarId: "primary", target: { kind: "calendar" } },
  {
    kind: "calendar.event_starting",
    calendarId: "primary",
    target: { kind: "calendar" },
    leadMinutes: 15,
  },
  { kind: "notion.page_content_changed", target: { type: "page", pageId: PAGE } },
  {
    kind: "notion.page_properties_or_data_source_changed",
    target: { type: "page", pageId: PAGE },
    propertyIds: ["title"],
  },
  { kind: "notion.comment_changed", target: { type: "page", pageId: PAGE } },
  { kind: "gmail.message_received", labelIds: ["INBOX"] },
  {
    kind: "gmail.thread_or_label_changed",
    threadId: "thread_fixture",
    labelIds: ["Label_fixture"],
  },
  { kind: "drive.file_changed", fileId: "file_fixture" },
  { kind: "drive.file_trashed", fileId: "file_fixture" },
  { kind: "slack.app_mention", channelId: "CFIXTURE" },
  { kind: "slack.app_dm", channelId: "DFIXTURE" },
  { kind: "slack.channel_message", channelId: "CFIXTURE", threadTs: "1234567890.123456" },
];
function trigger(spec: NativeRoutineEventSpec): NativeRoutineTrigger {
  return {
    id: "fixture-trigger",
    version: 4,
    routineId: "fixture-routine",
    connectionId: "fixture-connection",
    spec,
    armedAt: "2026-10-18T00:00:00Z",
  };
}
for (const spec of specs)
  it(`${spec.kind} round-trips through the real Routine API input without adding an active flag`, () => {
    const draft = draftFromNativeRoutineTrigger(trigger(spec));
    const parsed = nativeRoutineTriggerInputs([draft]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual([
      { id: "fixture-trigger", expectedVersion: 4, connectionId: "fixture-connection", spec },
    ]);
    expect(nativeEventAppForKind(spec.kind)).toBe(nativeEventApp(spec));
    const create = CreateRoutineInput.parse({
      botId: "fixture-bot",
      name: "Fixture",
      prompt: "Fixture",
      nativeTriggers: parsed.data,
    });
    expect(create.active).toBe(false);
  });
it("Gmail requires an explicit label or thread, deduplicates labels and does not send stale fields", () => {
  const blank = {
    ...emptyNativeRoutineTriggerDraft(),
    connectionId: "fixture-connection",
    kind: "gmail.message_received" as const,
  };
  expect(nativeRoutineTriggerInputs([blank]).success).toBe(false);
  const parsed = nativeRoutineTriggerInputs([
    {
      ...blank,
      labelIds: "Label_Z\nLabel_A\nLabel_Z\n",
      threadId: " thread_fixture ",
      calendarId: "stale_calendar",
      fileId: "stale_file",
      channelId: "stale_channel",
    },
  ]);
  expect(parsed.success && parsed.data[0]!.spec).toEqual({
    kind: "gmail.message_received",
    labelIds: ["Label_A", "Label_Z"],
    threadId: "thread_fixture",
  });
});
it("switching accounts or event kinds clears dependent fields and preserves only the existing trigger revision", () => {
  const draft = draftFromNativeRoutineTrigger(
    trigger({
      kind: "slack.channel_message",
      channelId: "CFIXTURE",
      threadTs: "1234567890.123456",
    }),
  );
  const reset = resetNativeRoutineTriggerDraft(draft, "other_connection", "drive.file_changed");
  expect(reset).toMatchObject({
    id: "fixture-trigger",
    expectedVersion: 4,
    connectionId: "other_connection",
    kind: "drive.file_changed",
    channelId: "",
    threadTs: "",
    fileId: "",
  });
  expect(nativeRoutineTriggerInputs([reset]).success).toBe(false);
});
it("only connected native event-capable accounts are selectable; long-tail accounts are not silently migrated", () => {
  const rows = [
    "google-calendar",
    "notion",
    "gmail",
    "google-drive",
    "slack",
    "google-docs",
    "github",
  ].map(
    (provider) =>
      ({
        id: provider,
        provider,
        connectorId: "native",
        status: "connected",
        capabilities: [],
        displayName: provider,
        createdAt: "2026-10-18T00:00:00Z",
      }) as Connection,
  );
  rows.push(
    { ...rows[2]!, id: "broker-gmail", connectorId: "composio" },
    { ...rows[4]!, id: "revoked-slack", status: "revoked" },
  );
  expect(nativeEventAccounts(rows).map((row) => row.id)).toEqual([
    "google-calendar",
    "notion",
    "gmail",
    "google-drive",
    "slack",
  ]);
});
