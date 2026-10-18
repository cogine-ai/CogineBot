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
      ["google-calendar", "notion", "gmail", "google-drive", "slack"].includes(row.provider),
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
