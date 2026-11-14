import type { Connection } from "@rakazo/contracts";
import type { NativeRoutineTriggerDraft } from "@rakazo/core/routine-native-events";
import {
  NATIVE_ROUTINE_EVENT_KINDS,
  nativeEventAccounts,
  nativeEventAppForKind,
  resetNativeRoutineTriggerDraft,
} from "@rakazo/core/routine-native-events";
import { Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { routineEventLabel } from "../lib/routine-event-label";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";

export function RoutineNativeEventFields({
  draft,
  rows,
  disabled,
  onChange,
  onRemove,
}: {
  draft: NativeRoutineTriggerDraft;
  rows: Connection[];
  disabled: boolean;
  onChange: (draft: NativeRoutineTriggerDraft) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const accounts = nativeEventAccounts(rows);
  const selected = accounts.find((row) => row.id === draft.connectionId);
  const kinds = NATIVE_ROUTINE_EVENT_KINDS.filter(
    (kind) => nativeEventAppForKind(kind) === selected?.provider,
  );
  const locked = disabled || !selected;
  function field(key: keyof NativeRoutineTriggerDraft, label: string, multiline = false) {
    return (
      <View key={key} style={{ gap: 4 }}>
        <Text style={{ color: native.secondaryLabel }}>{label}</Text>
        <TextInput
          accessibilityLabel={label}
          value={String(draft[key] ?? "")}
          editable={!locked}
          multiline={multiline}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            color: native.label,
            backgroundColor: native.fill,
            padding: 12,
            borderRadius: 10,
          }}
          onChangeText={(value) => {
            if (!locked) onChange({ ...draft, [key]: value });
          }}
        />
      </View>
    );
  }
  const calendar = draft.kind.startsWith("calendar.");
  const properties = draft.kind === "notion.page_properties_or_data_source_changed";
  const comment = draft.kind === "notion.comment_changed";
  return (
    <View style={{ gap: 12 }}>
      <MenuPicker
        label={t("Account")}
        disabled={disabled}
        value={draft.connectionId}
        choices={[
          { key: "", label: t("Choose account") },
          ...(draft.connectionId && !selected
            ? [{ key: draft.connectionId, label: t("Previous account unavailable") }]
            : []),
          ...accounts.map((row) => ({ key: row.id, label: row.displayName })),
        ]}
        onChange={(id) => {
          if (!disabled && id !== draft.connectionId && accounts.some((row) => row.id === id))
            onChange(resetNativeRoutineTriggerDraft(draft, id));
        }}
      />
      <MenuPicker
        label={t("Event")}
        disabled={locked}
        value={draft.kind}
        choices={[
          { key: "", label: t("Choose event") },
          ...(draft.kind && !kinds.includes(draft.kind)
            ? [{ key: draft.kind, label: routineEventLabel(draft.kind) }]
            : []),
          ...kinds.map((kind) => ({ key: kind, label: routineEventLabel(kind) })),
        ]}
        onChange={(value) => {
          const kind = kinds.find((kind) => kind === value);
          if (!locked && kind && kind !== draft.kind)
            onChange(resetNativeRoutineTriggerDraft(draft, draft.connectionId, kind));
        }}
      />
      {calendar ? (
        <>
          {field("calendarId", t("Calendar ID"))}
          <MenuPicker
            label={t("Calendar target")}
            disabled={locked}
            value={draft.calendarTarget}
            choices={[
              { key: "calendar", label: t("Whole calendar") },
              { key: "single", label: t("Single event") },
              { key: "series", label: t("Recurring series") },
              { key: "instance", label: t("Recurring instance") },
            ]}
            onChange={(value) => {
              if (
                !locked &&
                value !== draft.calendarTarget &&
                ["calendar", "single", "series", "instance"].includes(value)
              )
                onChange({
                  ...draft,
                  calendarTarget: value as NativeRoutineTriggerDraft["calendarTarget"],
                  eventId: "",
                });
            }}
          />
          {draft.calendarTarget !== "calendar" ? field("eventId", t("Event ID")) : null}
          {draft.kind === "calendar.event_starting"
            ? field("leadMinutes", t("Minutes before"))
            : null}
        </>
      ) : null}
      {properties || comment ? (
        <MenuPicker
          label={t("Notion target")}
          disabled={locked}
          value={draft.notionTarget}
          choices={[
            { key: "page", label: t("Page") },
            ...(properties
              ? [{ key: "data_source", label: t("Data source") }]
              : [
                  { key: "block", label: t("Block") },
                  { key: "discussion", label: t("Discussion") },
                ]),
          ]}
          onChange={(value) => {
            if (
              !locked &&
              value !== draft.notionTarget &&
              (properties ? ["page", "data_source"] : ["page", "block", "discussion"]).includes(
                value,
              )
            )
              onChange({
                ...draft,
                notionTarget: value as NativeRoutineTriggerDraft["notionTarget"],
                pageId: "",
                dataSourceId: "",
                blockId: "",
                discussionId: "",
                anchorBlockId: "",
              });
          }}
        />
      ) : null}
      {draft.kind === "notion.page_content_changed" ||
      ((properties || comment) && draft.notionTarget !== "data_source")
        ? field("pageId", t("Page ID"))
        : null}
      {properties && draft.notionTarget === "data_source"
        ? field("dataSourceId", t("Data source ID"))
        : null}
      {properties ? field("propertyIds", t("Property IDs (optional, one per line)"), true) : null}
      {comment && draft.notionTarget === "block" ? field("blockId", t("Block ID")) : null}
      {comment && draft.notionTarget === "discussion" ? (
        <>
          {field("discussionId", t("Discussion ID"))}
          {field("anchorBlockId", t("Anchor block ID"))}
        </>
      ) : null}
      {draft.kind.startsWith("gmail.") ? (
        <>
          {field("labelIds", t("Label IDs (any match, one per line)"), true)}
          {field("threadId", t("Thread ID (optional)"))}
        </>
      ) : null}
      {draft.kind.startsWith("drive.") ? field("fileId", t("File ID")) : null}
      {draft.kind.startsWith("slack.") ||
      draft.kind.startsWith("discord.") ||
      draft.kind === "teams.channel_message.created"
        ? field("channelId", t("Channel ID"))
        : null}
      {draft.kind === "slack.channel_message"
        ? field("threadTs", t("Thread timestamp (optional)"))
        : null}
      {draft.kind === "sharepoint.list_item.changed" ? (
        <>
          {field("siteId", t("Site ID"))}
          {field("listId", t("List ID"))}
        </>
      ) : null}
      {draft.kind === "excel.range.changed" ? (
        <>
          {field("driveId", t("Drive ID"))}
          {field("itemId", t("Workbook item ID"))}
          {field("worksheetId", t("Worksheet ID"))}
          {field("address", t("Cell range (A1 notation)"))}
        </>
      ) : null}
      {draft.kind === "planner.task.changed" ? field("planId", t("Plan ID")) : null}
      {draft.kind === "teams.channel_message.created" ? field("teamId", t("Team ID")) : null}
      {[
        "feishu.calendar_event.changed",
        "dingtalk.calendar_event.changed",
        "wecom.schedule.changed",
      ].includes(draft.kind)
        ? field("calendarId", t("Calendar ID"))
        : null}
      {draft.kind === "dingtalk.calendar_event.changed" ? (
        <>
          {field("userId", t("User ID"))}
          {field("timeMin", t("Start time (ISO 8601)"))}
          {field("timeMax", t("End time (ISO 8601)"))}
        </>
      ) : null}
      {draft.kind === "telegram.pinned_message.changed" ? field("chatId", t("Chat ID")) : null}
      {draft.kind === "discord.command.invoked" ? (
        <>
          {field("guildId", t("Server ID"))}
          {field("commandId", t("Command ID"))}
          {field("commandName", t("Command name"))}
        </>
      ) : null}
      <NativeActionButton
        label={t("Remove application event")}
        prominence="quiet"
        disabled={disabled}
        onPress={onRemove}
      />
    </View>
  );
}
