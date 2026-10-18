import { z } from "zod";

const Id = z.string().min(1).max(1024);
const Revision = z.string().min(1).max(512);
const IsoDate = z.iso.datetime({ offset: true });
const CalendarTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("calendar") }).strict(),
  z.object({ kind: z.enum(["single", "series", "instance"]), eventId: Id }).strict(),
]);
const CalendarFields = { calendarId: Id, target: CalendarTarget.default({ kind: "calendar" }) };
const NotionPageTarget = z.object({ type: z.literal("page"), pageId: z.uuid() }).strict();
const NotionDataSourceTarget = z
  .object({ type: z.literal("data_source"), dataSourceId: z.uuid() })
  .strict();
const NotionCommentTarget = z.discriminatedUnion("type", [
  NotionPageTarget,
  z.object({ type: z.literal("block"), blockId: z.uuid(), pageId: z.uuid() }).strict(),
  z
    .object({
      type: z.literal("discussion"),
      discussionId: z.uuid(),
      anchorBlockId: z.uuid(),
      pageId: z.uuid(),
    })
    .strict(),
]);

/** User intent only. Owner, source generation, cursor, secrets and execution options are server-owned. */
export const NativeRoutineEventSpecSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("sharepoint.list_item.changed"), siteId: Id, listId: Id }).strict(),
    z
      .object({
        kind: z.literal("excel.range.changed"),
        driveId: Id,
        itemId: Id,
        worksheetId: Id,
        address: z
          .string()
          .regex(/^\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})?$/),
      })
      .strict(),
    z.object({ kind: z.literal("planner.task.changed"), planId: Id }).strict(),
    z
      .object({ kind: z.literal("teams.channel_message.created"), teamId: Id, channelId: Id })
      .strict(),
    z.object({ kind: z.literal("feishu.calendar_event.changed"), calendarId: Id }).strict(),
    z
      .object({
        kind: z.literal("dingtalk.calendar_event.changed"),
        userId: Id,
        calendarId: Id,
        timeMin: IsoDate,
        timeMax: IsoDate,
      })
      .strict(),
    z.object({ kind: z.literal("wecom.schedule.changed"), calendarId: Id }).strict(),
    z
      .object({
        kind: z.literal("telegram.pinned_message.changed"),
        chatId: z.string().regex(/^-?[1-9][0-9]{0,18}$/),
      })
      .strict(),
    z
      .object({
        kind: z.literal("discord.channel_message.created"),
        channelId: z.string().regex(/^[1-9][0-9]{5,20}$/),
      })
      .strict(),
    z
      .object({
        kind: z.literal("discord.command.invoked"),
        guildId: z.string().regex(/^[1-9][0-9]{5,20}$/),
        channelId: z.string().regex(/^[1-9][0-9]{5,20}$/),
        commandId: z.string().regex(/^[1-9][0-9]{5,20}$/),
        commandName: z.string().regex(/^[a-z0-9_-]{1,32}$/),
      })
      .strict(),
    z.object({ kind: z.literal("calendar.event_changed"), ...CalendarFields }).strict(),
    z
      .object({
        kind: z.literal("calendar.event_starting"),
        ...CalendarFields,
        leadMinutes: z.number().int().min(1).max(40_320),
      })
      .strict(),
    z.object({ kind: z.literal("notion.page_content_changed"), target: NotionPageTarget }).strict(),
    z
      .object({
        kind: z.literal("notion.page_properties_or_data_source_changed"),
        target: z.union([NotionPageTarget, NotionDataSourceTarget]),
        propertyIds: z.array(Id).min(1).max(100).optional(),
      })
      .strict(),
    z.object({ kind: z.literal("notion.comment_changed"), target: NotionCommentTarget }).strict(),
    z
      .object({
        kind: z.literal("gmail.message_received"),
        labelIds: z.array(Id).min(1).max(20).optional(),
        threadId: Id.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("gmail.thread_or_label_changed"),
        labelIds: z.array(Id).min(1).max(20).optional(),
        threadId: Id.optional(),
      })
      .strict(),
    z.object({ kind: z.literal("drive.file_changed"), fileId: Id }).strict(),
    z.object({ kind: z.literal("drive.file_trashed"), fileId: Id }).strict(),
    z.object({ kind: z.literal("slack.app_mention"), channelId: Id }).strict(),
    z.object({ kind: z.literal("slack.app_dm"), channelId: Id }).strict(),
    z
      .object({ kind: z.literal("slack.channel_message"), channelId: Id, threadTs: Id.optional() })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.kind === "dingtalk.calendar_event.changed" &&
      Date.parse(value.timeMin) >= Date.parse(value.timeMax)
    )
      context.addIssue({
        code: "custom",
        path: ["timeMax"],
        message: "The event window must end after it starts.",
      });
    if (
      (value.kind === "gmail.message_received" || value.kind === "gmail.thread_or_label_changed") &&
      !value.threadId &&
      !value.labelIds?.length
    )
      context.addIssue({
        code: "custom",
        path: ["labelIds"],
        message: "Choose the exact Gmail labels or thread.",
      });
  });
export type NativeRoutineEventSpec = z.infer<typeof NativeRoutineEventSpecSchema>;
export const NativeRoutineEventKindSchema = z.enum([
  "sharepoint.list_item.changed",
  "excel.range.changed",
  "planner.task.changed",
  "teams.channel_message.created",
  "feishu.calendar_event.changed",
  "dingtalk.calendar_event.changed",
  "wecom.schedule.changed",
  "telegram.pinned_message.changed",
  "discord.channel_message.created",
  "discord.command.invoked",
  "calendar.event_changed",
  "calendar.event_starting",
  "notion.page_content_changed",
  "notion.page_properties_or_data_source_changed",
  "notion.comment_changed",
  "gmail.message_received",
  "gmail.thread_or_label_changed",
  "drive.file_changed",
  "drive.file_trashed",
  "slack.app_mention",
  "slack.app_dm",
  "slack.channel_message",
]);
export type NativeRoutineEventKind = z.infer<typeof NativeRoutineEventKindSchema>;

export const NativeRoutineTriggerInputSchema = z
  .object({
    id: Id.optional(),
    expectedVersion: z.number().int().positive().optional(),
    connectionId: Id,
    spec: NativeRoutineEventSpecSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.id) !== (value.expectedVersion !== undefined))
      context.addIssue({
        code: "custom",
        path: ["expectedVersion"],
        message: "An existing trigger requires its current version.",
      });
  });
export type NativeRoutineTriggerInput = z.infer<typeof NativeRoutineTriggerInputSchema>;
export const NativeRoutineTriggersInputSchema = z
  .array(NativeRoutineTriggerInputSchema)
  .max(20)
  .superRefine((values, context) => {
    const ids = values.flatMap((value) => (value.id ? [value.id] : []));
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "A trigger can only be updated once." });
    const keys = values.map((value) => JSON.stringify([value.connectionId, value.spec]));
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: "custom", message: "Duplicate native event triggers." });
  });

/** Safe UI DTO; no cursor, channel verifier, webhook secret or raw provider payload. */
export const NativeRoutineTriggerSchema = z.object({
  id: Id,
  version: z.number().int().positive(),
  routineId: Id,
  connectionId: Id,
  spec: NativeRoutineEventSpecSchema,
  armedAt: IsoDate,
});
export type NativeRoutineTrigger = z.infer<typeof NativeRoutineTriggerSchema>;

export const SaveNativeRoutineTriggerInputSchema = NativeRoutineTriggerInputSchema.safeExtend({
  routineId: Id,
});
export const RemoveNativeRoutineTriggerInputSchema = z
  .object({ routineId: Id, triggerId: Id, expectedVersion: z.number().int().positive() })
  .strict();

export interface NativeEventScope {
  userId: string;
  spaceId: string;
}
export interface NativeEventResource {
  type:
    | "calendar"
    | "page"
    | "data_source"
    | "block"
    | "discussion"
    | "mailbox"
    | "drive_file"
    | "slack_channel"
    | "sharepoint_list"
    | "excel_range"
    | "planner_plan"
    | "teams_channel"
    | "enterprise_calendar"
    | "telegram_chat"
    | "discord_channel"
    | "discord_command";
  id: string;
}
export function nativeEventResource(spec: NativeRoutineEventSpec): NativeEventResource {
  switch (spec.kind) {
    case "sharepoint.list_item.changed":
      return { type: "sharepoint_list", id: JSON.stringify([spec.siteId, spec.listId]) };
    case "excel.range.changed":
      return {
        type: "excel_range",
        id: JSON.stringify([spec.driveId, spec.itemId, spec.worksheetId, spec.address]),
      };
    case "planner.task.changed":
      return { type: "planner_plan", id: spec.planId };
    case "teams.channel_message.created":
      return { type: "teams_channel", id: JSON.stringify([spec.teamId, spec.channelId]) };
    case "feishu.calendar_event.changed":
    case "wecom.schedule.changed":
      return { type: "enterprise_calendar", id: spec.calendarId };
    case "dingtalk.calendar_event.changed":
      return {
        type: "enterprise_calendar",
        id: JSON.stringify([spec.userId, spec.calendarId, spec.timeMin, spec.timeMax]),
      };
    case "telegram.pinned_message.changed":
      return { type: "telegram_chat", id: spec.chatId };
    case "discord.channel_message.created":
      return { type: "discord_channel", id: spec.channelId };
    case "discord.command.invoked":
      return {
        type: "discord_command",
        id: JSON.stringify([spec.guildId, spec.channelId, spec.commandId, spec.commandName]),
      };
  }
  if (spec.kind === "gmail.message_received" || spec.kind === "gmail.thread_or_label_changed")
    return { type: "mailbox", id: "me" };
  if (spec.kind === "drive.file_changed" || spec.kind === "drive.file_trashed")
    return { type: "drive_file", id: spec.fileId };
  if (
    spec.kind === "slack.app_mention" ||
    spec.kind === "slack.app_dm" ||
    spec.kind === "slack.channel_message"
  )
    return { type: "slack_channel", id: spec.channelId };
  if (spec.kind.startsWith("calendar."))
    return {
      type: "calendar",
      id: (spec as Extract<NativeRoutineEventSpec, { calendarId: string }>).calendarId,
    };
  const target = (spec as Extract<NativeRoutineEventSpec, { target: { type: string } }>).target;
  if (target.type === "page") return { type: "page", id: target.pageId.toLowerCase() };
  if (target.type === "data_source")
    return { type: "data_source", id: target.dataSourceId.toLowerCase() };
  if (target.type === "block") return { type: "block", id: target.blockId.toLowerCase() };
  return { type: "discussion", id: target.discussionId.toLowerCase() };
}
export function nativeEventApp(spec: NativeRoutineEventSpec): NativeEventAppId {
  const family = spec.kind.split(".")[0];
  if (["sharepoint", "excel", "planner", "teams", "dingtalk", "wecom", "discord"].includes(family!))
    return family as NativeEventAppId;
  if (family === "feishu") return "feishu-lark";
  if (family === "telegram") return "telegram-bot";
  return spec.kind.startsWith("calendar.")
    ? "google-calendar"
    : spec.kind.startsWith("gmail.")
      ? "gmail"
      : spec.kind.startsWith("drive.")
        ? "google-drive"
        : spec.kind.startsWith("slack.")
          ? "slack"
          : "notion";
}

export type NativeEventAppId =
  | "google-calendar"
  | "notion"
  | "gmail"
  | "google-drive"
  | "slack"
  | "sharepoint"
  | "excel"
  | "planner"
  | "teams"
  | "feishu-lark"
  | "dingtalk"
  | "wecom"
  | "telegram-bot"
  | "discord";

/** Only a trusted verifier can construct this; it is not a public API parameter. */
export interface NativeEventAuthorizationProof extends NativeEventScope {
  connectionId: string;
  authorizationRevision: string;
  grantId: string;
  authGeneration: number;
  configId: string;
  configRevision: number;
  appId: NativeEventAppId;
  resource: NativeEventResource;
  spec: NativeRoutineEventSpec;
}
export interface PreparedNativeRoutineTrigger {
  input: NativeRoutineTriggerInput;
  proof: NativeEventAuthorizationProof;
}

/** Server-produced observation. This is never exposed as a model-callable fire RPC. */
export const NativeEventObservationSchema = z
  .object({
    triggerId: Id,
    triggerVersion: z.number().int().positive(),
    connectionId: Id,
    authorizationRevision: Revision,
    kind: NativeRoutineEventKindSchema,
    resource: z
      .object({
        type: z.enum([
          "calendar",
          "page",
          "data_source",
          "block",
          "discussion",
          "mailbox",
          "drive_file",
          "slack_channel",
          "sharepoint_list",
          "excel_range",
          "planner_plan",
          "teams_channel",
          "enterprise_calendar",
          "telegram_chat",
          "discord_channel",
          "discord_command",
        ]),
        id: z.string().min(1).max(8192),
      })
      .strict(),
    eventIdentity: Id,
    observedVersion: z.string().min(1).max(2048),
    occurredAt: IsoDate,
    evidence: z
      .enum([
        "calendar_sync",
        "calendar_clock",
        "notion_webhook",
        "visible_state_change",
        "gmail_history",
        "drive_changes",
        "slack_events",
        "microsoft_read",
        "enterprise_read",
        "bot_read",
        "discord_interaction",
      ])
      .default("visible_state_change"),
    eventId: Id.optional(),
    recurringEventId: Id.optional(),
    originalStartTime: z.string().max(128).optional(),
    scheduledStart: IsoDate.optional(),
    responseStatus: z.string().max(32).optional(),
    propertyIds: z.array(Id).min(1).max(100).optional(),
    messageId: Id.optional(),
    threadId: Id.optional(),
    labelIds: z.array(Id).max(100).optional(),
    historyId: Id.optional(),
    fileId: Id.optional(),
    trashed: z.boolean().optional(),
    slackEventId: Id.optional(),
    channelId: Id.optional(),
    messageTs: Id.optional(),
    threadTs: Id.optional(),
    sourceMetadata: z.record(z.string(), z.unknown()).optional(),
    interactionId: Id.optional(),
    guildId: Id.optional(),
    commandId: Id.optional(),
    commandName: z.string().max(32).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind.startsWith("gmail.") && (!value.messageId || !value.historyId))
      context.addIssue({
        code: "custom",
        message: "Gmail requires the exact history and message IDs.",
      });
    if (value.kind.startsWith("drive.") && !value.fileId)
      context.addIssue({ code: "custom", message: "Drive requires the exact file ID." });
    if (value.kind === "drive.file_trashed" && value.trashed !== true)
      context.addIssue({
        code: "custom",
        message: "A removed change alone does not prove a trashed file.",
      });
    if (
      value.kind.startsWith("slack.") &&
      (!value.slackEventId || !value.channelId || !value.messageTs)
    )
      context.addIssue({
        code: "custom",
        message: "Slack requires the verified event, channel and message IDs.",
      });
    if (value.kind.startsWith("calendar.") && !value.eventId)
      context.addIssue({
        code: "custom",
        path: ["eventId"],
        message: "A Calendar observation requires the actual event ID.",
      });
    if (value.kind === "calendar.event_starting" && !value.scheduledStart)
      context.addIssue({
        code: "custom",
        path: ["scheduledStart"],
        message: "A reminder requires the current authoritative start instant.",
      });
  });
export type NativeEventObservation = z.infer<typeof NativeEventObservationSchema>;

/** Server-produced verified interaction; no token or raw provider payload enters the existing queue. */
export const NativeDiscordSignalJobSchema = z
  .object({
    triggerId: Id,
    triggerVersion: z.number().int().positive(),
    userId: Id,
    spaceId: Id,
    configId: Id,
    configRevision: z.number().int().positive(),
    connectionId: Id,
    authorizationRevision: Revision,
    grantId: Id,
    authGeneration: z.number().int().positive(),
    interaction: z
      .object({
        id: z.string().regex(/^[1-9][0-9]{5,20}$/),
        applicationId: z.string().regex(/^[1-9][0-9]{5,20}$/),
        guildId: z.string().regex(/^[1-9][0-9]{5,20}$/),
        channelId: z.string().regex(/^[1-9][0-9]{5,20}$/),
        commandId: z.string().regex(/^[1-9][0-9]{5,20}$/),
        commandName: z.string().regex(/^[a-z0-9_-]{1,32}$/),
        userId: z.string().regex(/^[1-9][0-9]{5,20}$/),
        options: z
          .array(
            z
              .object({
                name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
                type: z.union([z.literal(3), z.literal(4), z.literal(5)]),
                value: z.union([z.string().max(6000), z.number().int().safe(), z.boolean()]),
              })
              .strict(),
          )
          .max(25),
      })
      .strict(),
  })
  .strict();
export type NativeDiscordSignalJob = z.infer<typeof NativeDiscordSignalJobSchema>;
