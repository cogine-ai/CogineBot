import type { NativeRoutineEventSpec, NativeRoutineTrigger, Routine } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { routineRowDetail, routineStatusLine, sortRoutinesByNextRun } from "./routine.js";

function routine(partial: Partial<Routine>): Routine {
  return {
    id: "routine-1",
    botId: "bot-1",
    name: "Weekly review",
    prompt: "Review the week.",
    crons: [],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function trigger(spec: NativeRoutineEventSpec, id = spec.kind): NativeRoutineTrigger {
  return {
    id,
    version: 1,
    routineId: "routine-1",
    connectionId: `connection-${id}`,
    spec,
    armedAt: "2026-10-18T00:00:00.000Z",
  };
}

describe("routineStatusLine", () => {
  it("shows readable schedules instead of cron expressions", () => {
    expect(routineStatusLine(routine({ crons: ["0 6 * * *"] }))).toBe(
      "Active · Every day at 6:00 AM · UTC",
    );
    expect(routineStatusLine(routine({ crons: ["0 6 * * 0"] }))).toBe(
      "Active · Every Sunday at 6:00 AM · UTC",
    );
    expect(routineStatusLine(routine({ crons: ["30 8 * * 1-5"] }))).toBe(
      "Active · Weekdays at 8:30 AM · UTC",
    );
    expect(routineStatusLine(routine({ crons: ["0 * * * *"] }))).toBe("Active · Every hour · UTC");
  });

  it("keeps the routine's time zone and other triggers", () => {
    expect(
      routineStatusLine(
        routine({
          active: false,
          crons: ["0 9 * * 1"],
          timezone: "Europe/Berlin",
          webhookEnabled: true,
        }),
      ),
    ).toBe("Paused · Every Monday at 9:00 AM, Webhook · Europe/Berlin");
  });

  it("omits the trigger segment when there are no triggers", () => {
    expect(routineStatusLine(routine({}))).toBe("Active · UTC");
  });

  it.each<NativeRoutineEventSpec>([
    { kind: "gmail.message_received", labelIds: ["INBOX"] },
    { kind: "gmail.thread_or_label_changed", threadId: "thread-1" },
    { kind: "drive.file_changed", fileId: "file-1" },
    { kind: "drive.file_trashed", fileId: "file-1" },
    { kind: "slack.app_mention", channelId: "C1" },
    { kind: "slack.app_dm", channelId: "D1" },
    { kind: "slack.channel_message", channelId: "C1", threadTs: "123.456" },
  ])("shows the native event family for $kind", (spec) => {
    const label = spec.kind.startsWith("gmail.")
      ? "Gmail event"
      : spec.kind.startsWith("drive.")
        ? "Drive event"
        : "Slack bot event";
    expect(routineStatusLine(routine({ nativeTriggers: [trigger(spec)] }))).toBe(
      `Active · ${label} · UTC`,
    );
  });

  it("keeps each native family once and distinguishes Slack bot events from message triggers", () => {
    expect(
      routineStatusLine(
        routine({
          active: false,
          messageProvider: "slack",
          nativeTriggers: [
            trigger({
              kind: "calendar.event_changed",
              calendarId: "primary",
              target: { kind: "calendar" },
            }),
            trigger({
              kind: "notion.page_content_changed",
              target: { type: "page", pageId: "e6f387fd-b1ec-435b-8a86-83d8e4be2ba0" },
            }),
            trigger({ kind: "gmail.message_received", labelIds: ["INBOX"] }),
            trigger({ kind: "gmail.thread_or_label_changed", threadId: "thread-1" }),
            trigger({ kind: "drive.file_changed", fileId: "file-1" }),
            trigger({ kind: "slack.app_mention", channelId: "C1" }),
          ],
        }),
      ),
    ).toBe(
      "Paused · Calendar event, Notion event, Gmail event, Drive event, Slack bot event, Slack message · UTC",
    );
  });
  it("shows remaining platform events without silently conflating them with chat message triggers", () => {
    const value = routine({
      nativeTriggers: [
        trigger({ kind: "teams.channel_message.created", teamId: "team", channelId: "channel" }),
        trigger({ kind: "wecom.schedule.changed", calendarId: "calendar" }),
        trigger({ kind: "discord.channel_message.created", channelId: "423456789012345678" }),
        trigger({
          kind: "discord.command.invoked",
          guildId: "323456789012345678",
          channelId: "423456789012345678",
          commandId: "523456789012345678",
          commandName: "review",
        }),
      ],
      messageProvider: "teams",
    });
    expect(routineStatusLine(value)).toBe(
      "Active · Teams event, WeCom event, Discord bot event, Teams message · UTC",
    );
  });
});

describe("routine profile rows", () => {
  it.each<[NativeRoutineEventSpec, string]>([
    [
      { kind: "calendar.event_changed", calendarId: "calendar", target: { kind: "calendar" } },
      "Calendar event",
    ],
    [
      {
        kind: "notion.page_content_changed",
        target: { type: "page", pageId: "e6f387fd-b1ec-435b-8a86-83d8e4be2ba0" },
      },
      "Notion event",
    ],
    [{ kind: "gmail.message_received", labelIds: ["INBOX"] }, "Gmail event"],
    [{ kind: "drive.file_changed", fileId: "file" }, "Drive event"],
    [{ kind: "slack.app_mention", channelId: "C1" }, "Slack bot event"],
    [{ kind: "sharepoint.list_item.changed", siteId: "site", listId: "list" }, "SharePoint event"],
    [
      {
        kind: "excel.range.changed",
        driveId: "drive",
        itemId: "item",
        worksheetId: "sheet",
        address: "A1",
      },
      "Excel event",
    ],
    [{ kind: "planner.task.changed", planId: "plan" }, "Planner event"],
    [
      { kind: "teams.channel_message.created", teamId: "team", channelId: "channel" },
      "Teams event",
    ],
    [{ kind: "feishu.calendar_event.changed", calendarId: "calendar" }, "Feishu / Lark event"],
    [
      {
        kind: "dingtalk.calendar_event.changed",
        userId: "user",
        calendarId: "calendar",
        timeMin: "2026-10-20T00:00:00Z",
        timeMax: "2026-10-21T00:00:00Z",
      },
      "DingTalk event",
    ],
    [{ kind: "wecom.schedule.changed", calendarId: "calendar" }, "WeCom event"],
    [{ kind: "telegram.pinned_message.changed", chatId: "123456" }, "Telegram bot event"],
    [
      { kind: "discord.channel_message.created", channelId: "423456789012345678" },
      "Discord bot event",
    ],
  ])("retains the native event-family label in profile rows: %s", (spec, label) => {
    const value = routine({ nativeTriggers: [trigger(spec)] });
    expect(routineRowDetail(value, "UTC")).toBe(label);
    expect(routineStatusLine(value)).toBe(`Active · ${label} · UTC`);
  });

  it("shows the schedule and only a different time zone or paused status", () => {
    expect(routineRowDetail(routine({ crons: ["30 8 * * 1-5"] }), "UTC")).toBe(
      "Weekdays at 8:30 AM",
    );
    expect(
      routineRowDetail(
        routine({ active: false, crons: ["0 6 * * *"], timezone: "Europe/Berlin" }),
        "UTC",
      ),
    ).toBe("Every day at 6:00 AM · Europe/Berlin · Paused");
  });

  it("puts the soonest scheduled run first and keeps unscheduled rows oldest first", () => {
    const rows = [
      routine({ id: "none-new", createdAt: "2026-03-01T00:00:00Z" }),
      routine({ id: "later", nextRunAt: "2026-11-02T00:00:00Z" }),
      routine({ id: "none-old", createdAt: "2026-02-01T00:00:00Z" }),
      routine({ id: "soon", nextRunAt: "2026-11-01T00:00:00Z" }),
    ];
    expect(sortRoutinesByNextRun(rows).map((row) => row.id)).toEqual([
      "soon",
      "later",
      "none-old",
      "none-new",
    ]);
    expect(rows[0]?.id).toBe("none-new");
  });

  it("treats invalid next-run timestamps as unscheduled instead of losing a known upcoming run", () => {
    expect(
      sortRoutinesByNextRun([
        routine({ id: "unknown", nextRunAt: "not-a-date" }),
        routine({ id: "scheduled", nextRunAt: "2026-11-01T00:00:00Z" }),
      ]).map((row) => row.id),
    ).toEqual(["scheduled", "unknown"]);
  });
});
