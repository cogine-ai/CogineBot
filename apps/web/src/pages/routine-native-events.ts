import type { Connection, NativeRoutineEventKind, NativeRoutineTrigger } from "@rakazo/contracts";
import { NativeRoutineTriggersInputSchema } from "@rakazo/contracts";

/** Unsaved user intent only; authorization proof and delivery state never enter this form. */
export type NativeRoutineTriggerDraft = {
  key: string;
  id?: string;
  expectedVersion?: number;
  connectionId: string;
  kind: NativeRoutineEventKind | "";
  calendarId: string;
  calendarTarget: "calendar" | "single" | "series" | "instance";
  eventId: string;
  leadMinutes: string;
  notionTarget: "page" | "data_source" | "block" | "discussion";
  pageId: string;
  dataSourceId: string;
  blockId: string;
  discussionId: string;
  anchorBlockId: string;
  propertyIds: string;
  labelIds: string;
  threadId: string;
  fileId: string;
  channelId: string;
  threadTs: string;
  siteId: string;
  listId: string;
  driveId: string;
  itemId: string;
  worksheetId: string;
  address: string;
  planId: string;
  teamId: string;
  chatId: string;
  guildId: string;
  commandId: string;
  commandName: string;
  userId: string;
  timeMin: string;
  timeMax: string;
};

export function emptyNativeRoutineTriggerDraft(): NativeRoutineTriggerDraft {
  return {
    key: crypto.randomUUID(),
    connectionId: "",
    kind: "",
    calendarId: "",
    calendarTarget: "calendar",
    eventId: "",
    leadMinutes: "15",
    notionTarget: "page",
    pageId: "",
    dataSourceId: "",
    blockId: "",
    discussionId: "",
    anchorBlockId: "",
    propertyIds: "",
    labelIds: "",
    threadId: "",
    fileId: "",
    channelId: "",
    threadTs: "",
    siteId: "",
    listId: "",
    driveId: "",
    itemId: "",
    worksheetId: "",
    address: "",
    planId: "",
    teamId: "",
    chatId: "",
    guildId: "",
    commandId: "",
    commandName: "",
    userId: "",
    timeMin: "",
    timeMax: "",
  };
}

export function draftFromNativeRoutineTrigger(
  trigger: NativeRoutineTrigger,
): NativeRoutineTriggerDraft {
  const draft = {
    ...emptyNativeRoutineTriggerDraft(),
    key: trigger.id,
    id: trigger.id,
    expectedVersion: trigger.version,
    connectionId: trigger.connectionId,
    kind: trigger.spec.kind,
  };
  const spec = trigger.spec;
  switch (spec.kind) {
    case "sharepoint.list_item.changed":
      draft.siteId = spec.siteId;
      draft.listId = spec.listId;
      break;
    case "excel.range.changed":
      draft.driveId = spec.driveId;
      draft.itemId = spec.itemId;
      draft.worksheetId = spec.worksheetId;
      draft.address = spec.address;
      break;
    case "planner.task.changed":
      draft.planId = spec.planId;
      break;
    case "teams.channel_message.created":
      draft.teamId = spec.teamId;
      draft.channelId = spec.channelId;
      break;
    case "feishu.calendar_event.changed":
    case "wecom.schedule.changed":
      draft.calendarId = spec.calendarId;
      break;
    case "dingtalk.calendar_event.changed":
      draft.userId = spec.userId;
      draft.calendarId = spec.calendarId;
      draft.timeMin = spec.timeMin;
      draft.timeMax = spec.timeMax;
      break;
    case "telegram.pinned_message.changed":
      draft.chatId = spec.chatId;
      break;
    case "discord.channel_message.created":
      draft.channelId = spec.channelId;
      break;
    case "discord.command.invoked":
      draft.guildId = spec.guildId;
      draft.channelId = spec.channelId;
      draft.commandId = spec.commandId;
      draft.commandName = spec.commandName;
      break;
    case "calendar.event_changed":
    case "calendar.event_starting":
      draft.calendarId = spec.calendarId;
      draft.calendarTarget = spec.target.kind;
      if (spec.target.kind !== "calendar") draft.eventId = spec.target.eventId;
      if (spec.kind === "calendar.event_starting") draft.leadMinutes = String(spec.leadMinutes);
      break;
    case "notion.page_content_changed":
      draft.pageId = spec.target.pageId;
      break;
    case "notion.page_properties_or_data_source_changed":
      draft.notionTarget = spec.target.type;
      if (spec.target.type === "page") draft.pageId = spec.target.pageId;
      else draft.dataSourceId = spec.target.dataSourceId;
      draft.propertyIds = spec.propertyIds?.join("\n") ?? "";
      break;
    case "notion.comment_changed":
      draft.notionTarget = spec.target.type;
      draft.pageId = spec.target.pageId;
      if (spec.target.type === "block") draft.blockId = spec.target.blockId;
      if (spec.target.type === "discussion") {
        draft.discussionId = spec.target.discussionId;
        draft.anchorBlockId = spec.target.anchorBlockId;
      }
      break;
    case "gmail.message_received":
    case "gmail.thread_or_label_changed":
      draft.labelIds = spec.labelIds?.join("\n") ?? "";
      draft.threadId = spec.threadId ?? "";
      break;
    case "drive.file_changed":
    case "drive.file_trashed":
      draft.fileId = spec.fileId;
      break;
    case "slack.app_mention":
    case "slack.app_dm":
    case "slack.channel_message":
      draft.channelId = spec.channelId;
      if (spec.kind === "slack.channel_message") draft.threadTs = spec.threadTs ?? "";
  }
  return draft;
}

export function resetNativeRoutineTriggerDraft(
  draft: NativeRoutineTriggerDraft,
  connectionId: string,
  kind: NativeRoutineTriggerDraft["kind"] = "",
): NativeRoutineTriggerDraft {
  return {
    ...emptyNativeRoutineTriggerDraft(),
    key: draft.key,
    ...(draft.id ? { id: draft.id, expectedVersion: draft.expectedVersion } : {}),
    connectionId,
    kind,
  };
}

export function nativeEventAppForKind(kind: NativeRoutineTriggerDraft["kind"]) {
  const prefix = kind.split(".")[0];
  if (["sharepoint", "excel", "planner", "teams", "dingtalk", "wecom", "discord"].includes(prefix!))
    return prefix;
  if (prefix === "feishu") return "feishu-lark";
  if (prefix === "telegram") return "telegram-bot";
  return kind.startsWith("calendar.")
    ? "google-calendar"
    : kind.startsWith("notion.")
      ? "notion"
      : kind.startsWith("gmail.")
        ? "gmail"
        : kind.startsWith("drive.")
          ? "google-drive"
          : kind.startsWith("slack.")
            ? "slack"
            : null;
}

export function nativeEventAccounts(rows: readonly Connection[]): Connection[] {
  return rows.filter(
    (row) =>
      row.connectorId === "native" &&
      row.status === "connected" &&
      [
        "google-calendar",
        "notion",
        "gmail",
        "google-drive",
        "slack",
        "sharepoint",
        "excel",
        "planner",
        "teams",
        "feishu-lark",
        "dingtalk",
        "wecom",
        "telegram-bot",
        "discord",
      ].includes(row.provider),
  );
}

function notionTarget(draft: NativeRoutineTriggerDraft) {
  switch (draft.notionTarget) {
    case "page":
      return { type: "page", pageId: draft.pageId.trim() };
    case "data_source":
      return { type: "data_source", dataSourceId: draft.dataSourceId.trim() };
    case "block":
      return { type: "block", blockId: draft.blockId.trim(), pageId: draft.pageId.trim() };
    case "discussion":
      return {
        type: "discussion",
        discussionId: draft.discussionId.trim(),
        anchorBlockId: draft.anchorBlockId.trim(),
        pageId: draft.pageId.trim(),
      };
  }
}

function nativeRoutineTriggerIntent(draft: NativeRoutineTriggerDraft) {
  const base = {
    ...(draft.id ? { id: draft.id, expectedVersion: draft.expectedVersion } : {}),
    connectionId: draft.connectionId,
  };
  switch (draft.kind) {
    case "sharepoint.list_item.changed":
      return {
        ...base,
        spec: { kind: draft.kind, siteId: draft.siteId.trim(), listId: draft.listId.trim() },
      };
    case "excel.range.changed":
      return {
        ...base,
        spec: {
          kind: draft.kind,
          driveId: draft.driveId.trim(),
          itemId: draft.itemId.trim(),
          worksheetId: draft.worksheetId.trim(),
          address: draft.address.trim(),
        },
      };
    case "planner.task.changed":
      return { ...base, spec: { kind: draft.kind, planId: draft.planId.trim() } };
    case "teams.channel_message.created":
      return {
        ...base,
        spec: { kind: draft.kind, teamId: draft.teamId.trim(), channelId: draft.channelId.trim() },
      };
    case "feishu.calendar_event.changed":
    case "wecom.schedule.changed":
      return { ...base, spec: { kind: draft.kind, calendarId: draft.calendarId.trim() } };
    case "dingtalk.calendar_event.changed":
      return {
        ...base,
        spec: {
          kind: draft.kind,
          userId: draft.userId.trim(),
          calendarId: draft.calendarId.trim(),
          timeMin: draft.timeMin.trim(),
          timeMax: draft.timeMax.trim(),
        },
      };
    case "telegram.pinned_message.changed":
      return { ...base, spec: { kind: draft.kind, chatId: draft.chatId.trim() } };
    case "discord.channel_message.created":
      return { ...base, spec: { kind: draft.kind, channelId: draft.channelId.trim() } };
    case "discord.command.invoked":
      return {
        ...base,
        spec: {
          kind: draft.kind,
          guildId: draft.guildId.trim(),
          channelId: draft.channelId.trim(),
          commandId: draft.commandId.trim(),
          commandName: draft.commandName.trim(),
        },
      };
    case "calendar.event_changed":
    case "calendar.event_starting":
      return {
        ...base,
        spec: {
          kind: draft.kind,
          calendarId: draft.calendarId.trim(),
          target:
            draft.calendarTarget === "calendar"
              ? { kind: "calendar" }
              : { kind: draft.calendarTarget, eventId: draft.eventId.trim() },
          ...(draft.kind === "calendar.event_starting"
            ? { leadMinutes: Number(draft.leadMinutes) }
            : {}),
        },
      };
    case "notion.page_content_changed":
      return {
        ...base,
        spec: { kind: draft.kind, target: { type: "page", pageId: draft.pageId.trim() } },
      };
    case "notion.page_properties_or_data_source_changed":
      return {
        ...base,
        spec: {
          kind: draft.kind,
          target: notionTarget(draft),
          ...(draft.propertyIds.trim()
            ? {
                propertyIds: draft.propertyIds
                  .split(/\r?\n/)
                  .map((id) => id.trim())
                  .filter(Boolean),
              }
            : {}),
        },
      };
    case "notion.comment_changed":
      return { ...base, spec: { kind: draft.kind, target: notionTarget(draft) } };
    case "gmail.message_received":
    case "gmail.thread_or_label_changed":
      return {
        ...base,
        spec: {
          kind: draft.kind,
          ...(draft.labelIds.trim()
            ? {
                labelIds: [
                  ...new Set(
                    draft.labelIds
                      .split(/\r?\n/)
                      .map((id) => id.trim())
                      .filter(Boolean),
                  ),
                ].sort(),
              }
            : {}),
          ...(draft.threadId.trim() ? { threadId: draft.threadId.trim() } : {}),
        },
      };
    case "drive.file_changed":
    case "drive.file_trashed":
      return { ...base, spec: { kind: draft.kind, fileId: draft.fileId.trim() } };
    case "slack.app_mention":
    case "slack.app_dm":
    case "slack.channel_message":
      return {
        ...base,
        spec: {
          kind: draft.kind,
          channelId: draft.channelId.trim(),
          ...(draft.kind === "slack.channel_message" && draft.threadTs.trim()
            ? { threadTs: draft.threadTs.trim() }
            : {}),
        },
      };
    default:
      return { ...base, spec: { kind: draft.kind } };
  }
}

/** Only an explicit event edit calls this; ordinary routine updates omit the array. */
export function nativeRoutineTriggerInputs(drafts: readonly NativeRoutineTriggerDraft[]) {
  return NativeRoutineTriggersInputSchema.safeParse(drafts.map(nativeRoutineTriggerIntent));
}
