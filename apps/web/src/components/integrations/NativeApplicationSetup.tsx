import { Trans, useLingui } from "@lingui/react/macro";
import type {
  NativeAppId,
  NativeConfigEditable,
  NativeConfigInput,
  NativeConfigStatus,
  NativeSetupState,
} from "@rakazo/contracts";
import { NativeConfigInputSchema } from "@rakazo/contracts";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
} from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

type CredentialKind = NativeConfigInput["credentialKind"];
type Draft = Omit<NativeConfigInput, "knowledgeBaseIds"> & {
  hasClientSecret: boolean;
  knowledgeBaseIdsText: string;
};
const APPS: readonly { id: NativeAppId; name: string }[] = [
  { id: "coginex", name: "CogineX" },
  { id: "knowai", name: "Knowai" },
  { id: "google-calendar", name: "Google Calendar" },
  { id: "notion", name: "Notion" },
];
const GOOGLE = "https://www.googleapis.com/auth/";
function fresh(appId: NativeAppId): Draft {
  return {
    appId,
    label: "",
    ownership: "byo",
    enabled: true,
    credentialKind:
      appId === "coginex" ? "mcp_oauth" : appId === "knowai" ? "machine_key" : "oauth",
    scopes:
      appId === "google-calendar"
        ? [
            "openid",
            "email",
            `${GOOGLE}calendar.calendarlist.readonly`,
            `${GOOGLE}calendar.events.readonly`,
            `${GOOGLE}calendar.freebusy`,
          ]
        : [],
    capabilities: appId === "knowai" ? ["retrieve"] : appId === "notion" ? ["read_content"] : [],
    knowledgeBaseIdsText: "",
    hasClientSecret: false,
  };
}
function fromConfiguration(value: NativeConfigEditable): Draft {
  // Explicitly omit callbackUri, hasClientSecret and revision from the write payload.
  return {
    id: value.id,
    expectedRevision: value.revision,
    appId: value.appId,
    label: value.label,
    ownership: value.ownership,
    enabled: value.enabled,
    credentialKind: value.credentialKind,
    endpoint: value.endpoint,
    clientId: value.clientId,
    scopes: [...value.scopes],
    capabilities: [...value.capabilities],
    tenantId: value.tenantId,
    knowledgeBaseIdsText: value.knowledgeBaseIds.join(", "),
    hasClientSecret: value.hasClientSecret,
  };
}
function input(draft: Draft): NativeConfigInput {
  return {
    ...(draft.id ? { id: draft.id, expectedRevision: draft.expectedRevision } : {}),
    appId: draft.appId,
    label: draft.label.trim(),
    ownership: draft.ownership,
    enabled: draft.enabled,
    credentialKind: draft.credentialKind,
    ...(draft.endpoint?.trim() ? { endpoint: draft.endpoint.trim() } : {}),
    ...(draft.clientId?.trim() ? { clientId: draft.clientId.trim() } : {}),
    ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
    scopes: [...draft.scopes],
    capabilities: [...draft.capabilities],
    knowledgeBaseIds: [
      ...new Set(
        draft.knowledgeBaseIdsText
          .split(/[,\n]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ],
    ...(draft.tenantId?.trim() ? { tenantId: draft.tenantId.trim() } : {}),
  };
}

/** A section inside deployment settings, separate from individual account authorization. */
export function NativeApplicationSetup({
  onDone,
  onCancel,
}: {
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [state, setState] = useState<NativeSetupState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const saving = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void rpc.nativeConnectors
      .status()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err, t`Could not load applications`));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  function kindLabel(kind: CredentialKind) {
    return kind === "mcp_oauth" || kind === "oauth"
      ? t`Account authorization`
      : kind === "machine_key"
        ? t`Machine API key`
        : kind === "internal_token"
          ? t`Internal integration`
          : t`Personal access token`;
  }
  function update(value: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...value } : current));
    setError(null);
    setNotice(null);
  }
  async function run(action: () => Promise<void>) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, t`Could not save application`));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function edit(entry: NativeConfigStatus) {
    await run(async () => {
      const value = await rpc.nativeConnectors.configuration({ id: entry.id });
      setDraft(fromConfiguration(value));
    });
  }
  function remember(entry: NativeConfigStatus) {
    setState((current) =>
      current
        ? {
            ...current,
            configurations: [
              ...current.configurations.filter((value) => value.id !== entry.id),
              entry,
            ].sort((a, b) => a.appId.localeCompare(b.appId) || a.id.localeCompare(b.id)),
          }
        : current,
    );
  }
  async function toggle(entry: NativeConfigStatus) {
    await run(async () => {
      const value = await rpc.nativeConnectors.configuration({ id: entry.id });
      const saved = await rpc.nativeConnectors.save({
        ...input(fromConfiguration(value)),
        enabled: !entry.enabled,
      });
      remember(saved);
      setNotice(entry.enabled ? t`Connection method disabled` : t`Connection method enabled`);
      onDone?.();
    });
  }
  async function save() {
    if (!draft) return;
    const parsed = NativeConfigInputSchema.safeParse(input(draft));
    if (!parsed.success) {
      setError(t`Complete the required application settings`);
      return;
    }
    await run(async () => {
      const saved = await rpc.nativeConnectors.save(parsed.data);
      setDraft(null);
      remember(saved);
      setNotice(t`Application saved`);
      onDone?.();
    });
  }
  function checked(key: "scopes" | "capabilities", value: string, enabled: boolean) {
    if (!draft) return;
    update({
      [key]: enabled
        ? [...new Set([...draft[key], value])]
        : draft[key].filter((entry) => entry !== value),
    });
  }
  const calendarPermissions = [
    { value: "email", label: t`Show account email` },
    { value: `${GOOGLE}calendar.calendarlist.readonly`, label: t`List calendars` },
    { value: `${GOOGLE}calendar.events.readonly`, label: t`Read events` },
    { value: `${GOOGLE}calendar.events`, label: t`Create and change events` },
    { value: `${GOOGLE}calendar.freebusy`, label: t`Check calendar availability` },
    { value: `${GOOGLE}calendar.events.freebusy`, label: t`Check event availability` },
  ];
  const capabilities =
    draft?.appId === "knowai"
      ? [
          { value: "retrieve", label: t`Search and read knowledge` },
          { value: "ingest", label: t`Add and reprocess knowledge` },
          { value: "chat", label: t`Ask questions` },
        ]
      : [
          { value: "read_content", label: t`Read pages` },
          { value: "insert_content", label: t`Create pages and blocks` },
          { value: "update_content", label: t`Edit pages and blocks` },
          { value: "read_comments", label: t`Read comments` },
          { value: "insert_comments", label: t`Add comments` },
        ];
  if (loading && !state)
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading applications…</Trans>
      </p>
    );
  if (!state)
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button variant="outline" onClick={() => setReload((value) => value + 1)}>
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  if (!state.canConfigure) return null;
  return (
    <section
      className="space-y-4 border-t border-border pt-6"
      aria-labelledby={`${id}-title`}
      aria-busy={busy || loading}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-base font-medium text-foreground">
          <Trans>Application credentials</Trans>
        </h2>
        {!draft ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy || loading}
            onClick={() => {
              setDraft(fresh("coginex"));
              setError(null);
              setNotice(null);
            }}
          >
            <Trans>Add application</Trans>
          </Button>
        ) : null}
      </div>
      {!draft ? (
        <>
          {!state.configurations.length ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Set up an application here. Members connect their accounts from Apps.</Trans>
            </p>
          ) : null}
          <div className="divide-y divide-border">
            {state.configurations.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{entry.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {APPS.find((app) => app.id === entry.appId)?.name} ·{" "}
                    {kindLabel(entry.credentialKind)} ·{" "}
                    {!entry.enabled
                      ? t`Disabled`
                      : entry.configured
                        ? t`Ready for accounts`
                        : t`Setup incomplete`}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || loading}
                  onClick={() => void edit(entry)}
                >
                  <Trans>Edit</Trans>
                </Button>
                <Switch
                  aria-label={t`Enable ${entry.label}`}
                  checked={entry.enabled}
                  disabled={busy || loading}
                  onCheckedChange={() => void toggle(entry)}
                />
              </div>
            ))}
          </div>
          {state.configurations.length ? (
            <p className="text-xs text-muted-foreground">
              <Trans>Disabled methods cannot be used. Connected accounts are kept.</Trans>
            </p>
          ) : null}
        </>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h3 className="text-sm font-medium">
            {draft.id ? t`Edit application` : t`Add application`}
          </h3>
          {draft.id ? (
            <p className="text-sm text-muted-foreground">
              {APPS.find((app) => app.id === draft.appId)?.name} · {kindLabel(draft.credentialKind)}{" "}
              · {draft.ownership === "official" ? t`Official application` : t`Your application`}
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${id}-app`}>
                  <Trans>Application</Trans>
                </FieldLabel>
                <NativeSelect
                  id={`${id}-app`}
                  className="w-full"
                  value={draft.appId}
                  disabled={busy}
                  onChange={(event) => {
                    const app = APPS.find((entry) => entry.id === event.target.value);
                    if (app) setDraft(fresh(app.id));
                  }}
                >
                  {APPS.map((app) => (
                    <NativeSelectOption key={app.id} value={app.id}>
                      {app.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-ownership`}>
                  <Trans>Application owner</Trans>
                </FieldLabel>
                <NativeSelect
                  id={`${id}-ownership`}
                  className="w-full"
                  value={draft.ownership}
                  disabled={busy}
                  onChange={(event) =>
                    update({ ownership: event.target.value === "official" ? "official" : "byo" })
                  }
                >
                  <NativeSelectOption value="byo">
                    <Trans>Your application</Trans>
                  </NativeSelectOption>
                  <NativeSelectOption value="official">
                    <Trans>Official application</Trans>
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>
          )}
          <Field>
            <FieldLabel htmlFor={`${id}-label`}>
              <Trans>Connection method name</Trans>
            </FieldLabel>
            <Input
              id={`${id}-label`}
              value={draft.label}
              maxLength={80}
              required
              disabled={busy}
              placeholder={t`For example, Company Calendar`}
              onChange={(event) => update({ label: event.target.value })}
            />
          </Field>
          {!draft.id && draft.appId === "notion" ? (
            <Field>
              <FieldLabel htmlFor={`${id}-kind`}>
                <Trans>Authorization</Trans>
              </FieldLabel>
              <NativeSelect
                id={`${id}-kind`}
                className="w-full"
                value={draft.credentialKind}
                disabled={busy}
                onChange={(event) => {
                  const kind = event.target.value;
                  if (kind === "oauth" || kind === "internal_token" || kind === "personal_token")
                    update({ credentialKind: kind, clientId: undefined, clientSecret: undefined });
                }}
              >
                <NativeSelectOption value="oauth">
                  <Trans>Account authorization</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="internal_token">
                  <Trans>Internal integration token</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="personal_token">
                  <Trans>Personal access token</Trans>
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          ) : null}
          {draft.appId === "coginex" || draft.appId === "knowai" ? (
            <Field>
              <FieldLabel htmlFor={`${id}-endpoint`}>
                {draft.appId === "coginex" ? t`MCP endpoint` : t`API origin`}
              </FieldLabel>
              <Input
                id={`${id}-endpoint`}
                type="url"
                value={draft.endpoint ?? ""}
                required
                disabled={busy}
                placeholder="https://"
                onChange={(event) => update({ endpoint: event.target.value })}
              />
            </Field>
          ) : null}
          {draft.credentialKind === "oauth" ? (
            <>
              <Field>
                <FieldLabel htmlFor={`${id}-callback`}>
                  <Trans>Callback URL</Trans>
                </FieldLabel>
                <Input
                  id={`${id}-callback`}
                  value={state.callbackUri}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
                <p className="text-xs text-muted-foreground">
                  <Trans>Register this exact URL in the application’s OAuth settings.</Trans>
                </p>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-client`}>
                  <Trans>Client ID</Trans>
                </FieldLabel>
                <Input
                  id={`${id}-client`}
                  value={draft.clientId ?? ""}
                  required
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => update({ clientId: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-secret`}>
                  <Trans>Client secret</Trans>
                </FieldLabel>
                <Input
                  id={`${id}-secret`}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={draft.clientSecret ?? ""}
                  required={!draft.hasClientSecret}
                  maxLength={8192}
                  disabled={busy}
                  onChange={(event) => update({ clientSecret: event.target.value })}
                />
                {draft.hasClientSecret ? (
                  <p className="text-xs text-muted-foreground">
                    <Trans>Leave blank to keep the saved secret.</Trans>
                  </p>
                ) : null}
              </Field>
            </>
          ) : null}
          {draft.credentialKind === "machine_key" ||
          draft.credentialKind === "internal_token" ||
          draft.credentialKind === "personal_token" ? (
            <p className="text-xs text-muted-foreground">
              <Trans>Members enter their credentials when connecting from Apps.</Trans>
            </p>
          ) : null}
          {draft.appId === "knowai" ? (
            <>
              <Field>
                <FieldLabel htmlFor={`${id}-tenant`}>
                  <Trans>Tenant ID</Trans>
                </FieldLabel>
                <Input
                  id={`${id}-tenant`}
                  value={draft.tenantId ?? ""}
                  required
                  disabled={busy}
                  onChange={(event) => update({ tenantId: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-knowledge`}>
                  <Trans>Allowed knowledge base IDs</Trans>
                </FieldLabel>
                <Input
                  id={`${id}-knowledge`}
                  value={draft.knowledgeBaseIdsText}
                  required
                  disabled={busy}
                  placeholder={t`Separate IDs with commas`}
                  onChange={(event) => update({ knowledgeBaseIdsText: event.target.value })}
                />
              </Field>
            </>
          ) : null}
          {draft.appId === "google-calendar" ||
          draft.appId === "notion" ||
          draft.appId === "knowai" ? (
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="mb-2 text-sm font-medium">
                <Trans>Permissions</Trans>
              </legend>
              {(draft.appId === "google-calendar" ? calendarPermissions : capabilities).map(
                (permission) => (
                  <Field key={permission.value} orientation="horizontal">
                    <Switch
                      id={`${id}-${permission.value}`}
                      checked={(draft.appId === "google-calendar"
                        ? draft.scopes
                        : draft.capabilities
                      ).includes(permission.value)}
                      onCheckedChange={(value) =>
                        checked(
                          draft.appId === "google-calendar" ? "scopes" : "capabilities",
                          permission.value,
                          value,
                        )
                      }
                    />
                    <FieldLabel htmlFor={`${id}-${permission.value}`}>
                      {permission.label}
                    </FieldLabel>
                  </Field>
                ),
              )}
              {draft.appId === "notion" ? (
                <p className="text-xs text-muted-foreground">
                  <Trans>Match the capabilities enabled in your Notion integration.</Trans>
                </p>
              ) : null}
            </fieldset>
          ) : null}
          <Field orientation="horizontal">
            <Switch
              id={`${id}-enabled`}
              checked={draft.enabled}
              disabled={busy}
              onCheckedChange={(enabled) => update({ enabled })}
            />
            <FieldLabel htmlFor={`${id}-enabled`}>
              <Trans>Enabled</Trans>
            </FieldLabel>
          </Field>
          {draft.id ? (
            <p className="text-xs text-muted-foreground">
              <Trans>Changing authorization settings requires accounts to authorize again.</Trans>
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setError(null);
                onCancel?.();
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t`Saving…` : t`Save application`}
            </Button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
