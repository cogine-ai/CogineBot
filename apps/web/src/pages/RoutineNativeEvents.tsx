import { Trans, useLingui } from "@lingui/react/macro";
import type { Connection, NativeRoutineEventKind } from "@rakazo/contracts";
import { NativeRoutineEventKindSchema } from "@rakazo/contracts";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { rpc, selectedSpaceId } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import type { NativeRoutineTriggerDraft } from "./routine-native-events";
import {
  nativeEventAccounts,
  nativeEventAppForKind,
  resetNativeRoutineTriggerDraft,
} from "./routine-native-events";

const EVENT_KINDS: NativeRoutineEventKind[] = [
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
];
const EVENT_APP_NAMES: Record<string, string> = {
  "google-calendar": "Google Calendar",
  notion: "Notion",
  gmail: "Gmail",
  "google-drive": "Google Drive",
  slack: "Slack",
  sharepoint: "SharePoint",
  excel: "Excel",
  planner: "Planner",
  teams: "Teams",
  "feishu-lark": "飞书 / Lark",
  dingtalk: "钉钉",
  wecom: "企业微信",
  "telegram-bot": "Telegram Bot",
  discord: "Discord",
};

export function RoutineNativeEvents({
  value,
  onChange,
  connectionsRevision,
  scopeKey,
  onOpenApplications,
}: {
  value: NativeRoutineTriggerDraft[];
  onChange: (next: NativeRoutineTriggerDraft[]) => void;
  connectionsRevision: number;
  scopeKey: string;
  onOpenApplications: () => void;
}) {
  const { t } = useLingui();
  const [rows, setRows] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const spaceId = selectedSpaceId();
    setRows([]);
    setLoading(true);
    setError(null);
    void rpc.connections
      .list()
      .then((next) => {
        if (!cancelled && selectedSpaceId() === spaceId) setRows(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled && selectedSpaceId() === spaceId)
          setError(errorText(reason, t`Could not load accounts`));
      })
      .finally(() => {
        if (!cancelled && selectedSpaceId() === spaceId) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionsRevision, scopeKey, retry]);
  const accounts = nativeEventAccounts(rows);
  return (
    <fieldset className="space-y-2" aria-label={t`Application events`}>
      {value.map((draft, index) => (
        <NativeEventFields
          key={draft.key}
          draft={draft}
          rows={rows}
          accounts={accounts}
          loading={loading}
          onChange={(next) =>
            onChange(value.map((item, position) => (position === index ? next : item)))
          }
          onRemove={() => onChange(value.filter((_, position) => position !== index))}
        />
      ))}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {error ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            <Trans>Try again</Trans>
          </Button>
        ) : null}
        <Button type="button" variant="link" size="sm" onClick={onOpenApplications}>
          <Trans>Connect an account</Trans>
        </Button>
        {!loading && !error && accounts.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            <Trans>No connected accounts for application events</Trans>
          </span>
        ) : null}
      </div>
    </fieldset>
  );
}

type TextKey =
  | "calendarId"
  | "eventId"
  | "leadMinutes"
  | "pageId"
  | "dataSourceId"
  | "blockId"
  | "discussionId"
  | "anchorBlockId"
  | "threadId"
  | "fileId"
  | "channelId"
  | "threadTs"
  | "siteId"
  | "listId"
  | "driveId"
  | "itemId"
  | "worksheetId"
  | "address"
  | "planId"
  | "teamId"
  | "chatId"
  | "guildId"
  | "commandId"
  | "commandName"
  | "userId"
  | "timeMin"
  | "timeMax";
function NativeEventFields({
  draft,
  rows,
  accounts,
  loading,
  onChange,
  onRemove,
}: {
  draft: NativeRoutineTriggerDraft;
  rows: Connection[];
  accounts: Connection[];
  loading: boolean;
  onChange: (next: NativeRoutineTriggerDraft) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const selected = accounts.find((row) => row.id === draft.connectionId);
  const previous = rows.find((row) => row.id === draft.connectionId);
  const app = selected?.provider ?? nativeEventAppForKind(draft.kind);
  const kinds = EVENT_KINDS.filter((kind) => nativeEventAppForKind(kind) === app);
  const kindLabel = (kind: NativeRoutineEventKind): string => {
    switch (kind) {
      case "sharepoint.list_item.changed":
        return t`SharePoint list item changed`;
      case "excel.range.changed":
        return t`Excel range changed`;
      case "planner.task.changed":
        return t`Planner task changed`;
      case "teams.channel_message.created":
        return t`New Teams channel message`;
      case "feishu.calendar_event.changed":
        return t`Feishu / Lark calendar changed`;
      case "dingtalk.calendar_event.changed":
        return t`DingTalk calendar changed`;
      case "wecom.schedule.changed":
        return t`WeCom schedule changed`;
      case "telegram.pinned_message.changed":
        return t`Telegram pinned message changed`;
      case "discord.channel_message.created":
        return t`New Discord channel message`;
      case "discord.command.invoked":
        return t`Discord command invoked`;
      case "calendar.event_changed":
        return t`Calendar event changed`;
      case "calendar.event_starting":
        return t`Before a Calendar event`;
      case "notion.page_content_changed":
        return t`Notion page content changed`;
      case "notion.page_properties_or_data_source_changed":
        return t`Notion properties or data source changed`;
      case "notion.comment_changed":
        return t`Notion comments changed`;
      case "gmail.message_received":
        return t`New Gmail message`;
      case "gmail.thread_or_label_changed":
        return t`Gmail thread or labels changed`;
      case "drive.file_changed":
        return t`Drive file changed`;
      case "drive.file_trashed":
        return t`Drive file moved to trash`;
      case "slack.app_mention":
        return t`This Slack bot is mentioned`;
      case "slack.app_dm":
        return t`Direct message to this Slack bot`;
      case "slack.channel_message":
        return t`Message in a Slack channel`;
    }
  };
  function textField(key: TextKey, label: ReactNode, number = false) {
    return (
      <Field>
        <FieldLabel htmlFor={`${fieldId}-${key}`}>{label}</FieldLabel>
        <Input
          id={`${fieldId}-${key}`}
          value={draft[key]}
          type={number ? "number" : "text"}
          {...(number ? { min: 1, max: 40_320, step: 1 } : {})}
          onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
        />
      </Field>
    );
  }
  const calendar =
    draft.kind === "calendar.event_changed" || draft.kind === "calendar.event_starting";
  const properties = draft.kind === "notion.page_properties_or_data_source_changed";
  const comment = draft.kind === "notion.comment_changed";
  const gmail = draft.kind.startsWith("gmail.");
  const drive = draft.kind.startsWith("drive.");
  const slack = draft.kind.startsWith("slack.");
  return (
    <div className="space-y-3 rounded-xl border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          <Trans>Application event</Trans>
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t`Remove application event`}
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      <Field>
        <FieldLabel htmlFor={`${fieldId}-account`}>
          <Trans>Account</Trans>
        </FieldLabel>
        <NativeSelect
          id={`${fieldId}-account`}
          value={draft.connectionId}
          disabled={loading}
          onChange={(event) => {
            const id = event.target.value;
            if (!id || accounts.some((row) => row.id === id))
              onChange(resetNativeRoutineTriggerDraft(draft, id));
          }}
        >
          <NativeSelectOption value="">
            {loading ? t`Loading accounts…` : t`Choose account`}
          </NativeSelectOption>
          {draft.connectionId && !selected ? (
            <NativeSelectOption value={draft.connectionId} disabled>
              {previous?.displayName ?? t`Previous account`} · {t`Unavailable`}
            </NativeSelectOption>
          ) : null}
          {accounts.map((row) => (
            <NativeSelectOption key={row.id} value={row.id}>
              {row.displayName} · {EVENT_APP_NAMES[row.provider] ?? row.provider}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${fieldId}-kind`}>
          <Trans>Event</Trans>
        </FieldLabel>
        <NativeSelect
          id={`${fieldId}-kind`}
          value={draft.kind}
          disabled={!selected}
          onChange={(event) => {
            const parsed = NativeRoutineEventKindSchema.safeParse(event.target.value);
            if (parsed.success && kinds.includes(parsed.data))
              onChange(resetNativeRoutineTriggerDraft(draft, draft.connectionId, parsed.data));
          }}
        >
          <NativeSelectOption value="">
            <Trans>Choose event</Trans>
          </NativeSelectOption>
          {kinds.map((kind) => (
            <NativeSelectOption key={kind} value={kind}>
              {kindLabel(kind)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {draft.connectionId && !selected && !loading ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Choose a connected account to change this event.</Trans>
        </p>
      ) : null}
      <fieldset disabled={!selected} className="space-y-3">
        {draft.kind === "sharepoint.list_item.changed" ? (
          <>
            {textField("siteId", t`Site ID`)}
            {textField("listId", t`List ID`)}
          </>
        ) : null}
        {draft.kind === "excel.range.changed" ? (
          <>
            {textField("driveId", t`Drive ID`)}
            {textField("itemId", t`Workbook item ID`)}
            {textField("worksheetId", t`Worksheet ID`)}
            {textField("address", t`Cell range (A1 notation)`)}
          </>
        ) : null}
        {draft.kind === "planner.task.changed" ? textField("planId", t`Plan ID`) : null}
        {draft.kind === "teams.channel_message.created" ? (
          <>
            {textField("teamId", t`Team ID`)}
            {textField("channelId", t`Channel ID`)}
          </>
        ) : null}
        {[
          "feishu.calendar_event.changed",
          "dingtalk.calendar_event.changed",
          "wecom.schedule.changed",
        ].includes(draft.kind)
          ? textField("calendarId", t`Calendar ID`)
          : null}
        {draft.kind === "dingtalk.calendar_event.changed" ? (
          <>
            {textField("userId", t`User ID`)}
            {textField("timeMin", t`Start time (ISO 8601)`)}
            {textField("timeMax", t`End time (ISO 8601)`)}
          </>
        ) : null}
        {draft.kind === "telegram.pinned_message.changed" ? textField("chatId", t`Chat ID`) : null}
        {draft.kind.startsWith("discord.") ? textField("channelId", t`Channel ID`) : null}
        {draft.kind === "discord.command.invoked" ? (
          <>
            {textField("guildId", t`Server ID`)}
            {textField("commandId", t`Command ID`)}
            {textField("commandName", t`Command name`)}
          </>
        ) : null}
        {gmail ? (
          <>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-gmail-labels`}>
                <Trans>Label IDs (any match, one per line)</Trans>
              </FieldLabel>
              <Textarea
                id={`${fieldId}-gmail-labels`}
                rows={3}
                value={draft.labelIds}
                onChange={(event) => onChange({ ...draft, labelIds: event.target.value })}
              />
            </Field>
            {textField("threadId", t`Thread ID (optional)`)}
            {!draft.labelIds.trim() && !draft.threadId.trim() ? (
              <p className="text-xs text-muted-foreground">
                <Trans>Enter a label ID or a thread ID.</Trans>
              </p>
            ) : null}
          </>
        ) : null}
        {drive ? textField("fileId", t`File ID`) : null}
        {slack ? (
          <>
            {textField(
              "channelId",
              draft.kind === "slack.app_dm" ? t`Direct message channel ID` : t`Channel ID`,
            )}
            {draft.kind === "slack.channel_message"
              ? textField("threadTs", t`Thread timestamp (optional)`)
              : null}
          </>
        ) : null}
        {calendar ? (
          <>
            {textField("calendarId", t`Calendar ID`)}
            <Field>
              <FieldLabel htmlFor={`${fieldId}-calendar-target`}>
                <Trans>Calendar target</Trans>
              </FieldLabel>
              <NativeSelect
                id={`${fieldId}-calendar-target`}
                value={draft.calendarTarget}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    calendarTarget: event.target
                      .value as NativeRoutineTriggerDraft["calendarTarget"],
                    eventId: "",
                  })
                }
              >
                <NativeSelectOption value="calendar">
                  <Trans>Whole calendar</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="single">
                  <Trans>Single event</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="series">
                  <Trans>Recurring series</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="instance">
                  <Trans>Recurring instance</Trans>
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            {draft.calendarTarget !== "calendar" ? textField("eventId", t`Event ID`) : null}
            {draft.kind === "calendar.event_starting"
              ? textField("leadMinutes", t`Minutes before`, true)
              : null}
          </>
        ) : null}
        {properties || comment ? (
          <Field>
            <FieldLabel htmlFor={`${fieldId}-notion-target`}>
              <Trans>Notion target</Trans>
            </FieldLabel>
            <NativeSelect
              id={`${fieldId}-notion-target`}
              value={draft.notionTarget}
              onChange={(event) =>
                onChange({
                  ...draft,
                  notionTarget: event.target.value as NativeRoutineTriggerDraft["notionTarget"],
                  pageId: "",
                  dataSourceId: "",
                  blockId: "",
                  discussionId: "",
                  anchorBlockId: "",
                })
              }
            >
              <NativeSelectOption value="page">
                <Trans>Page</Trans>
              </NativeSelectOption>
              {properties ? (
                <NativeSelectOption value="data_source">
                  <Trans>Data source</Trans>
                </NativeSelectOption>
              ) : null}
              {comment ? (
                <>
                  <NativeSelectOption value="block">
                    <Trans>Block</Trans>
                  </NativeSelectOption>
                  <NativeSelectOption value="discussion">
                    <Trans>Discussion</Trans>
                  </NativeSelectOption>
                </>
              ) : null}
            </NativeSelect>
          </Field>
        ) : null}
        {draft.kind === "notion.page_content_changed" ||
        ((properties || comment) && draft.notionTarget !== "data_source")
          ? textField("pageId", t`Page ID`)
          : null}
        {properties && draft.notionTarget === "data_source"
          ? textField("dataSourceId", t`Data source ID`)
          : null}
        {properties ? (
          <Field>
            <FieldLabel htmlFor={`${fieldId}-properties`}>
              <Trans>Property IDs (optional, one per line)</Trans>
            </FieldLabel>
            <Textarea
              id={`${fieldId}-properties`}
              rows={3}
              value={draft.propertyIds}
              onChange={(event) => onChange({ ...draft, propertyIds: event.target.value })}
            />
          </Field>
        ) : null}
        {comment && draft.notionTarget === "block" ? textField("blockId", t`Block ID`) : null}
        {comment && draft.notionTarget === "discussion" ? (
          <>
            {textField("discussionId", t`Discussion ID`)}
            {textField("anchorBlockId", t`Anchor block ID`)}
          </>
        ) : null}
      </fieldset>
    </div>
  );
}
