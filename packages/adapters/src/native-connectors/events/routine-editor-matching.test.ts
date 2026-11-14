import type { NativeEventObservation, NativeRoutineEventSpec } from "@rakazo/contracts";
import { nativeEventResource } from "@rakazo/contracts";
import {
  draftFromNativeRoutineTrigger,
  nativeRoutineTriggerInputs,
} from "@rakazo/core/routine-native-events";
import { expect, it } from "vitest";
import triggerFixtures from "../../../../testkit/src/routine-trigger-fixtures.json" with {
  type: "json",
};
import type { NativeRoutineTriggerRow } from "./store.js";
import { nativeObservationMatches } from "./store.js";

const routineTriggerSpecs = triggerFixtures.specs as NativeRoutineEventSpec[];
function routineTriggerFixture(spec: NativeRoutineEventSpec) {
  return { ...triggerFixtures.trigger, spec };
}

const now = new Date("2026-10-18T12:00:00Z");
function observation(spec: NativeRoutineEventSpec): Partial<NativeEventObservation> {
  switch (spec.kind) {
    case "calendar.event_changed":
    case "calendar.event_starting":
      return {
        eventId: spec.target.kind === "calendar" ? "event-a" : spec.target.eventId,
        scheduledStart: "2026-10-18T12:05:00Z",
      };
    case "notion.page_content_changed":
    case "notion.comment_changed":
      return {};
    case "notion.page_properties_or_data_source_changed":
      return { propertyIds: spec.propertyIds };
    case "gmail.message_received":
    case "gmail.thread_or_label_changed":
      return { evidence: "gmail_history", threadId: spec.threadId, labelIds: spec.labelIds };
    case "drive.file_changed":
    case "drive.file_trashed":
      return {
        evidence: "drive_changes",
        fileId: spec.fileId,
        trashed: spec.kind === "drive.file_trashed",
      };
    case "slack.app_mention":
    case "slack.app_dm":
    case "slack.channel_message":
      return {
        evidence: "slack_events",
        channelId: spec.channelId,
        ...(spec.kind === "slack.channel_message" ? { threadTs: spec.threadTs } : {}),
      };
    case "sharepoint.list_item.changed":
      return {
        evidence: "microsoft_read",
        sourceMetadata: { siteId: spec.siteId, listId: spec.listId, itemId: "item-a" },
      };
    case "excel.range.changed":
      return {
        evidence: "microsoft_read",
        sourceMetadata: {
          driveId: spec.driveId,
          fileId: spec.itemId,
          worksheetId: spec.worksheetId,
          address: spec.address,
        },
      };
    case "planner.task.changed":
      return {
        evidence: "microsoft_read",
        sourceMetadata: { planId: spec.planId, taskId: "task-a" },
      };
    case "teams.channel_message.created":
      return {
        evidence: "microsoft_read",
        sourceMetadata: { teamId: spec.teamId, channelId: spec.channelId, messageId: "message-a" },
      };
    case "feishu.calendar_event.changed":
      return {
        evidence: "enterprise_read",
        sourceMetadata: { calendarId: spec.calendarId, eventId: "event-a" },
      };
    case "dingtalk.calendar_event.changed":
      return {
        evidence: "enterprise_read",
        sourceMetadata: { calendarId: spec.calendarId, userId: spec.userId, eventId: "event-a" },
      };
    case "wecom.schedule.changed":
      return {
        evidence: "enterprise_read",
        sourceMetadata: { calendarId: spec.calendarId, scheduleId: "schedule-a" },
      };
    case "telegram.pinned_message.changed":
      return { evidence: "bot_read", sourceMetadata: { chatId: spec.chatId } };
    case "discord.channel_message.created":
      return {
        evidence: "bot_read",
        channelId: spec.channelId,
        sourceMetadata: { channelId: spec.channelId },
        messageId: "message-a",
      };
    case "discord.command.invoked":
      return {
        evidence: "discord_interaction",
        guildId: spec.guildId,
        channelId: spec.channelId,
        commandId: spec.commandId,
        commandName: spec.commandName,
        interactionId: "interaction-a",
      };
  }
}
for (const spec of routineTriggerSpecs) {
  it(`matches only the selected target after editor serialization: ${JSON.stringify(spec)}`, () => {
    const fixture = routineTriggerFixture(spec);
    const result = nativeRoutineTriggerInputs([draftFromNativeRoutineTrigger(fixture)]);
    if (!result.success) throw result.error;
    const saved = result.data[0]!;
    const row = {
      ...fixture,
      spec: saved.spec,
      authorizationRevision: "synthetic-auth",
      armedAt: new Date(fixture.armedAt),
      state: { ready: true },
    } as NativeRoutineTriggerRow;
    const event: NativeEventObservation = {
      triggerId: fixture.id,
      triggerVersion: fixture.version,
      connectionId: fixture.connectionId,
      authorizationRevision: "synthetic-auth",
      kind: spec.kind,
      resource: nativeEventResource(spec),
      eventIdentity: "synthetic-event",
      observedVersion: "v1",
      occurredAt: now.toISOString(),
      evidence: "visible_state_change",
      ...observation(spec),
    };
    expect(nativeObservationMatches(row, event, now)).toBe(true);
    for (const mismatch of [
      { resource: { ...event.resource, id: "unselected-target" } },
      { connectionId: "other-account" },
      { authorizationRevision: "revoked" },
      { triggerVersion: fixture.version + 1 },
    ])
      expect(nativeObservationMatches(row, { ...event, ...mismatch }, now)).toBe(false);
    if (event.sourceMetadata) {
      for (const key of Object.keys(event.sourceMetadata).filter(
        (key) => !["eventId", "messageId", "itemId", "scheduleId", "taskId"].includes(key),
      )) {
        expect(
          nativeObservationMatches(
            row,
            { ...event, sourceMetadata: { ...event.sourceMetadata, [key]: "other" } },
            now,
          ),
        ).toBe(false);
      }
    }
    if (spec.kind.startsWith("slack.") || spec.kind.startsWith("discord."))
      expect(nativeObservationMatches(row, { ...event, channelId: "other" }, now)).toBe(false);
    if (spec.kind === "slack.channel_message" && spec.threadTs)
      expect(nativeObservationMatches(row, { ...event, threadTs: "other" }, now)).toBe(false);
    if (spec.kind === "gmail.message_received" || spec.kind === "gmail.thread_or_label_changed") {
      if (spec.labelIds)
        expect(nativeObservationMatches(row, { ...event, labelIds: ["other"] }, now)).toBe(false);
      if (spec.threadId)
        expect(nativeObservationMatches(row, { ...event, threadId: "other" }, now)).toBe(false);
    }
    if (spec.kind === "notion.page_properties_or_data_source_changed" && spec.propertyIds)
      expect(nativeObservationMatches(row, { ...event, propertyIds: ["other"] }, now)).toBe(false);
    if (spec.kind === "calendar.event_changed" || spec.kind === "calendar.event_starting") {
      if (spec.target.kind !== "calendar")
        expect(nativeObservationMatches(row, { ...event, eventId: "sibling" }, now)).toBe(false);
      if (spec.kind === "calendar.event_starting")
        expect(nativeObservationMatches(row, event, new Date("2026-10-18T12:06:00Z"))).toBe(false);
    }
  });
}
