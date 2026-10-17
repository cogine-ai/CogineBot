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
];

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
            <Trans>No connected Calendar or Notion accounts</Trans>
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
  | "anchorBlockId";
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
              {row.displayName} ·{" "}
              {row.provider === "google-calendar" ? "Google Calendar" : "Notion"}
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
