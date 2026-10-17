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
      : null;
}

export function nativeEventAccounts(rows: readonly Connection[]): Connection[] {
  return rows.filter(
    (row) =>
      row.connectorId === "native" &&
      row.status === "connected" &&
      (row.provider === "google-calendar" || row.provider === "notion"),
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
    default:
      return { ...base, spec: { kind: draft.kind } };
  }
}

/** Only an explicit event edit calls this; ordinary routine updates omit the array. */
export function nativeRoutineTriggerInputs(drafts: readonly NativeRoutineTriggerDraft[]) {
  return NativeRoutineTriggersInputSchema.safeParse(drafts.map(nativeRoutineTriggerIntent));
}
