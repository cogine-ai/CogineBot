import { Trans, useLingui } from "@lingui/react/macro";
import type {
  NativeAppId,
  NativeConfigInput,
  NativeConfigStatus,
  NativeSetupState,
} from "@rakazo/contracts";
import { NativeConfigInputSchema, remainingNativeProfile } from "@rakazo/contracts";
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
import { NativeNotionWebhookSetup } from "./NativeNotionWebhookSetup";
import { NativeSlackEventSetup } from "./NativeSlackEventSetup";
import type { NativeApplicationDraft } from "./native-application-options";
import {
  NATIVE_APPLICATIONS as APPS,
  changeNativeCredential,
  freshNativeApplication as fresh,
  draftNativeApplication as fromConfiguration,
  GOOGLE_SCOPE_PREFIX as GOOGLE,
  GOOGLE_DEFAULT_SCOPES,
  nativeApplicationInput as input,
  nativeApplicationActors,
  nativeApplicationCredentialKinds,
  nativeGmailCallbackAudience,
  nativeOwnerSuppliesCredential,
} from "./native-application-options";

type CredentialKind = NativeConfigInput["credentialKind"];
type Draft = NativeApplicationDraft;
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
  const [webhookConfig, setWebhookConfig] = useState<NativeConfigStatus | null>(null);
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

  function kindLabel(kind: CredentialKind, appId?: NativeAppId) {
    if (kind === "personal_token" && appId === "hubspot") return t`Private app token`;
    if (kind === "machine_key" && appId && ["feishu-lark", "dingtalk", "wecom"].includes(appId))
      return t`App credentials`;
    return kind === "mcp_oauth" || kind === "oauth"
      ? t`Account authorization`
      : kind === "machine_key"
        ? t`Machine API key`
        : kind === "bot_token"
          ? t`Bot token`
          : kind === "github_app_installation"
            ? t`GitHub App installation`
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
    const prepared =
      draft.googleWatch && state
        ? {
            ...draft,
            googleWatch: {
              ...draft.googleWatch,
              callbackAudience: nativeGmailCallbackAudience(state.callbackUri),
            },
          }
        : draft;
    const parsed = NativeConfigInputSchema.safeParse(input(prepared));
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
  const googlePermissions: Partial<Record<NativeAppId, { value: string; label: string }[]>> = {
    "google-calendar": [
      { value: "calendar.calendarlist.readonly", label: t`List calendars` },
      { value: "calendar.events.readonly", label: t`Read events` },
      { value: "calendar.events", label: t`Create and change events` },
      { value: "calendar.freebusy", label: t`Check calendar availability` },
      { value: "calendar.events.freebusy", label: t`Check event availability` },
    ],
    gmail: [
      { value: "gmail.readonly", label: t`Read mail` },
      { value: "gmail.send", label: t`Send mail` },
      { value: "gmail.compose", label: t`Create drafts and send mail` },
      { value: "gmail.modify", label: t`Change messages and labels` },
      { value: "gmail.labels", label: t`Manage labels` },
    ],
    "google-drive": [
      { value: "drive.metadata.readonly", label: t`Find files and read metadata` },
      { value: "drive.file", label: t`Create and use app files` },
      { value: "drive.readonly", label: t`Read all accessible Drive files` },
      { value: "drive", label: t`Manage all accessible Drive files` },
    ],
    "google-docs": [
      { value: "documents.readonly", label: t`Read accessible documents` },
      { value: "documents", label: t`Create and edit accessible documents` },
      { value: "drive.file", label: t`Create and copy app files` },
      { value: "drive.readonly", label: t`Read all accessible Drive files` },
      { value: "drive", label: t`Manage all accessible Drive files` },
    ],
    "google-sheets": [
      { value: "spreadsheets.readonly", label: t`Read accessible spreadsheets` },
      { value: "spreadsheets", label: t`Create and edit accessible spreadsheets` },
      { value: "drive.file", label: t`Create and use app files` },
      { value: "drive.readonly", label: t`Read all accessible Drive files` },
      { value: "drive", label: t`Manage all accessible Drive files` },
    ],
    "google-slides": [
      { value: "presentations.readonly", label: t`Read accessible presentations` },
      { value: "presentations", label: t`Create and edit accessible presentations` },
      { value: "drive.file", label: t`Create and copy app files` },
      { value: "drive.readonly", label: t`Read all accessible Drive files` },
      { value: "drive", label: t`Manage all accessible Drive files` },
    ],
    "google-tasks": [
      { value: "tasks.readonly", label: t`Read task lists and tasks` },
      { value: "tasks", label: t`Create and change task lists and tasks` },
    ],
  };
  const collaborationPermissions =
    draft?.appId === "linear" && draft.credentialKind === "oauth"
      ? ["read", "write", "issues:create", "comments:create"]
      : draft?.appId === "slack"
        ? [
            "app_mentions:read",
            "users:read",
            "users:read.email",
            "channels:read",
            "groups:read",
            "im:read",
            "mpim:read",
            "channels:history",
            "groups:history",
            "im:history",
            "mpim:history",
            "chat:write",
            "chat:write.public",
            "im:write",
            "mpim:write",
            "reactions:write",
            "files:write",
            "files:read",
            ...(draft.actor === "user" ? ["search:read"] : []),
          ]
        : draft
          ? [...(remainingNativeProfile(draft.appId)?.scopes ?? [])]
          : [];
  const googleApp = Boolean(draft && GOOGLE_DEFAULT_SCOPES[draft.appId]);
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
  const permissions = draft
    ? googleApp
      ? (googlePermissions[draft.appId] ?? []).map((permission) => ({
          ...permission,
          value: GOOGLE + permission.value,
        }))
      : capabilities
    : [];
  const credentialOptions = draft
    ? nativeApplicationCredentialKinds(draft.appId, draft.ownership)
    : [];
  const actorOptions = draft ? nativeApplicationActors(draft) : [];
  const remainingCapabilities = draft
    ? [...(remainingNativeProfile(draft.appId)?.capabilities ?? [])]
    : [];
  const capabilityLabel = (capability: string) =>
    capability === "read"
      ? t`Read messages`
      : capability === "send"
        ? t`Send messages`
        : capability === "edit"
          ? t`Edit messages`
          : capability === "delete"
            ? t`Delete messages`
            : capability === "reactions"
              ? t`Reactions`
              : capability === "files"
                ? t`Files`
                : capability === "commands"
                  ? t`Register commands`
                  : capability;
  const enterpriseApp = Boolean(
    draft && ["feishu-lark", "dingtalk", "wecom"].includes(draft.appId),
  );
  const botApp = Boolean(draft && ["telegram-bot", "discord"].includes(draft.appId));
  const ownerCredential = Boolean(draft && nativeOwnerSuppliesCredential(draft));
  const tenantApp = Boolean(
    draft &&
      (enterpriseApp ||
        ["jira", "confluence", "dropbox", "hubspot", "discord"].includes(draft.appId) ||
        draft.appId.startsWith("outlook-") ||
        ["onedrive", "microsoft-todo", "sharepoint", "excel", "planner", "teams"].includes(
          draft.appId,
        )),
  );
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
  if (webhookConfig)
    return webhookConfig.appId === "slack" ? (
      <NativeSlackEventSetup config={webhookConfig} onBack={() => setWebhookConfig(null)} />
    ) : (
      <NativeNotionWebhookSetup config={webhookConfig} onBack={() => setWebhookConfig(null)} />
    );
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
                    {kindLabel(entry.credentialKind, entry.appId)} ·{" "}
                    {!entry.enabled
                      ? t`Disabled`
                      : entry.configured
                        ? t`Ready for accounts`
                        : t`Setup incomplete`}
                  </p>
                </div>
                {entry.appId === "notion" && entry.credentialKind === "oauth" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy || loading}
                    onClick={() => setWebhookConfig(entry)}
                  >
                    <Trans>Webhooks</Trans>
                  </Button>
                ) : null}
                {entry.appId === "slack" &&
                (entry.actor === "bot" || entry.credentialKind === "bot_token") ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy || loading}
                    onClick={() => setWebhookConfig(entry)}
                  >
                    <Trans>Events</Trans>
                  </Button>
                ) : null}
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
                    if (app) {
                      setDraft(fresh(app.id));
                      setError(null);
                      setNotice(null);
                    }
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
                  onChange={(event) => {
                    const ownership = event.target.value === "official" ? "official" : "byo";
                    if (
                      draft.appId === "feishu-lark" &&
                      ownership === "official" &&
                      draft.credentialKind === "machine_key"
                    ) {
                      update(changeNativeCredential({ ...draft, ownership }, "oauth"));
                    } else
                      update({
                        ownership,
                        ...(["telegram-bot", "discord"].includes(draft.appId)
                          ? { clientSecret: undefined }
                          : {}),
                      });
                  }}
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
          {!draft.id && credentialOptions.length > 1 ? (
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
                  if (credentialOptions.includes(kind as CredentialKind))
                    update(changeNativeCredential(draft, kind as CredentialKind));
                }}
              >
                {credentialOptions.map((kind) => (
                  <NativeSelectOption key={kind} value={kind}>
                    {kind === "personal_token" && draft.appId === "linear"
                      ? t`Personal API key`
                      : kind === "personal_token" && draft.appId === "slack"
                        ? t`User token`
                        : kind === "personal_token" && draft.appId === "hubspot"
                          ? t`Private app token`
                          : enterpriseApp && kind === "machine_key"
                            ? t`App credentials`
                            : kindLabel(kind)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          {actorOptions.length > 1 || ["github", "linear", "slack"].includes(draft.appId) ? (
            <Field>
              <FieldLabel htmlFor={`${id}-actor`}>
                <Trans>Acts as</Trans>
              </FieldLabel>
              <NativeSelect
                id={`${id}-actor`}
                value={draft.actor ?? actorOptions[0]}
                disabled={busy || actorOptions.length < 2}
                onChange={(event) => {
                  const actor = event.target.value as NonNullable<Draft["actor"]>;
                  if (actorOptions.includes(actor))
                    update({
                      actor,
                      ...(draft.appId === "slack" && actor === "bot"
                        ? {
                            scopes: draft.scopes.filter((scope) => scope !== "search:read"),
                            capabilities: [],
                          }
                        : {}),
                    });
                }}
              >
                {actorOptions.map((actor) => (
                  <NativeSelectOption key={actor} value={actor}>
                    {actor === "installation"
                      ? t`App installation`
                      : actor === "bot"
                        ? t`Bot`
                        : actor === "app"
                          ? draft.appId === "hubspot"
                            ? t`HubSpot account`
                            : t`Application`
                          : draft.appId === "hubspot"
                            ? t`User permissions`
                            : t`User`}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          {draft.credentialKind === "github_app_installation" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${id}-github-app`}>
                  <Trans>GitHub App ID</Trans>
                </FieldLabel>
                <Input
                  id={`${id}-github-app`}
                  inputMode="numeric"
                  pattern="[0-9]+"
                  required
                  disabled={busy}
                  value={draft.githubAppId ?? ""}
                  onChange={(event) => update({ githubAppId: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-github-installation`}>
                  <Trans>Installation ID</Trans>
                </FieldLabel>
                <Input
                  id={`${id}-github-installation`}
                  inputMode="numeric"
                  pattern="[0-9]+"
                  required
                  disabled={busy}
                  value={draft.githubInstallationId ?? ""}
                  onChange={(event) => update({ githubInstallationId: event.target.value })}
                />
              </Field>
            </div>
          ) : null}
          {draft.appId === "coginex" || draft.appId === "knowai" || draft.appId === "gitlab" ? (
            <Field>
              <FieldLabel htmlFor={`${id}-endpoint`}>
                {draft.appId === "coginex"
                  ? t`MCP endpoint`
                  : draft.appId === "gitlab"
                    ? t`GitLab origin`
                    : t`API origin`}
              </FieldLabel>
              <Input
                id={`${id}-endpoint`}
                type="url"
                value={draft.endpoint ?? ""}
                required={draft.appId !== "gitlab"}
                disabled={busy}
                placeholder={draft.appId === "gitlab" ? "https://gitlab.com" : "https://"}
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
                  {draft.appId === "wecom"
                    ? t`Suite ID`
                    : draft.appId === "feishu-lark"
                      ? t`App ID`
                      : t`Client ID`}
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
          {draft.credentialKind === "oauth" && ["feishu-lark", "wecom"].includes(draft.appId) ? (
            draft.enterpriseCallbackUri ? (
              <Field>
                <FieldLabel htmlFor={`${id}-enterprise-callback`}>
                  <Trans>Event callback URL</Trans>
                </FieldLabel>
                <Input
                  id={`${id}-enterprise-callback`}
                  value={draft.enterpriseCallbackUri}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
              </Field>
            ) : (
              <p className="text-xs text-muted-foreground">
                <Trans>Save this application to get its event callback URL.</Trans>
              </p>
            )
          ) : null}
          {draft.appId === "discord" && draft.id && draft.capabilities.includes("commands") ? (
            <Field>
              <FieldLabel htmlFor={`${id}-discord-interaction`}>
                <Trans>Interactions endpoint URL</Trans>
              </FieldLabel>
              <Input
                id={`${id}-discord-interaction`}
                value={new URL(
                  `/api/connectors/events/discord/${encodeURIComponent(draft.id)}`,
                  state.callbackUri,
                ).toString()}
                readOnly
                onFocus={(event) => event.target.select()}
              />
              <p className="text-xs text-muted-foreground">
                <Trans>Connect this bot before registering this URL in Discord.</Trans>
              </p>
            </Field>
          ) : null}
          {enterpriseApp ? (
            <>
              {draft.appId === "feishu-lark" ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-region`}>
                    <Trans>Platform</Trans>
                  </FieldLabel>
                  <NativeSelect
                    id={`${id}-region`}
                    required
                    value={draft.region ?? ""}
                    disabled={busy}
                    onChange={(event) =>
                      update({ region: event.target.value === "lark" ? "lark" : "feishu" })
                    }
                  >
                    <NativeSelectOption value="feishu">飞书</NativeSelectOption>
                    <NativeSelectOption value="lark">Lark</NativeSelectOption>
                  </NativeSelect>
                </Field>
              ) : null}
              {draft.credentialKind !== "oauth" && draft.appId !== "wecom" ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-enterprise-client`}>
                    {draft.appId === "dingtalk" ? t`AppKey` : t`App ID`}
                  </FieldLabel>
                  <Input
                    id={`${id}-enterprise-client`}
                    value={draft.clientId ?? ""}
                    required
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => update({ clientId: event.target.value })}
                  />
                </Field>
              ) : null}
              {draft.appId === "wecom" ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-agent`}>
                    <Trans>Agent ID</Trans>
                  </FieldLabel>
                  <Input
                    id={`${id}-agent`}
                    value={draft.agentId ?? ""}
                    required
                    inputMode="numeric"
                    pattern="[0-9]+"
                    disabled={busy}
                    onChange={(event) => update({ agentId: event.target.value })}
                  />
                </Field>
              ) : null}
            </>
          ) : null}
          {enterpriseApp && draft.credentialKind === "machine_key" ? (
            <p className="text-xs text-muted-foreground">
              <Trans>This application is bound to the current space.</Trans>
            </p>
          ) : null}
          {draft.credentialKind === "oauth" && ["feishu-lark", "wecom"].includes(draft.appId) ? (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                <Trans>Authorization callbacks</Trans>
              </summary>
              <div className="mt-3 space-y-3">
                {(
                  [
                    {
                      key: "verificationToken",
                      label: t`Verification token`,
                      saved: draft.hasVerificationToken,
                    },
                    {
                      key: "encryptionKey",
                      label: t`Encryption key`,
                      saved: draft.hasEncryptionKey,
                    },
                  ] as const
                ).map((field) => (
                  <Field key={field.key}>
                    <FieldLabel htmlFor={`${id}-${field.key}`}>{field.label}</FieldLabel>
                    <Input
                      id={`${id}-${field.key}`}
                      type="password"
                      autoComplete="new-password"
                      spellCheck={false}
                      maxLength={512}
                      value={draft[field.key] ?? ""}
                      disabled={busy}
                      onChange={(event) => update({ [field.key]: event.target.value })}
                    />
                    {field.saved ? (
                      <p className="text-xs text-muted-foreground">
                        <Trans>Leave blank to keep the saved secret.</Trans>
                      </p>
                    ) : null}
                  </Field>
                ))}
              </div>
            </details>
          ) : null}
          {ownerCredential ? (
            <Field>
              <FieldLabel htmlFor={`${id}-owner-secret`}>
                {botApp
                  ? draft.appId === "discord"
                    ? t`Discord bot token`
                    : t`Telegram bot token`
                  : t`App secret`}
              </FieldLabel>
              <Input
                id={`${id}-owner-secret`}
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
          ) : null}
          {tenantApp ? (
            <Field>
              <FieldLabel htmlFor={`${id}-resource-tenant`}>
                {enterpriseApp
                  ? ["dingtalk", "wecom"].includes(draft.appId)
                    ? draft.credentialKind === "machine_key"
                      ? t`Corp ID`
                      : t`Corp ID (optional)`
                    : t`Tenant ID (optional)`
                  : draft.appId === "jira" || draft.appId === "confluence"
                    ? t`Cloud site ID`
                    : draft.appId === "discord"
                      ? t`Server ID`
                      : draft.appId === "hubspot"
                        ? t`HubSpot account ID (optional)`
                        : draft.appId === "dropbox"
                          ? t`Team ID (optional)`
                          : t`Microsoft tenant ID (optional)`}
              </FieldLabel>
              <Input
                id={`${id}-resource-tenant`}
                value={draft.tenantId ?? ""}
                required={
                  ["jira", "confluence", "discord"].includes(draft.appId) ||
                  (["dingtalk", "wecom"].includes(draft.appId) &&
                    draft.credentialKind === "machine_key")
                }
                disabled={busy}
                onChange={(event) => update({ tenantId: event.target.value })}
              />
            </Field>
          ) : null}
          {draft.appId === "discord" ? (
            <p className="text-xs text-muted-foreground">
              <Trans>This server is bound to the current space.</Trans>
            </p>
          ) : null}
          {botApp ? (
            <Field>
              <FieldLabel htmlFor={`${id}-targets`}>
                {draft.appId === "telegram-bot" ? t`Allowed chat IDs` : t`Allowed channel IDs`}
              </FieldLabel>
              <Input
                id={`${id}-targets`}
                value={draft.targetIdsText}
                required
                disabled={busy}
                placeholder={t`Separate IDs with commas`}
                onChange={(event) => update({ targetIdsText: event.target.value })}
              />
            </Field>
          ) : null}
          {draft.appId === "gmail" ? (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                <Trans>Gmail push notifications</Trans>
              </summary>
              <div className="mt-3 space-y-3">
                <Field orientation="horizontal">
                  <Switch
                    id={`${id}-gmail-watch-enabled`}
                    disabled={busy || !state.callbackUri.startsWith("https://")}
                    checked={Boolean(draft.googleWatch)}
                    onCheckedChange={(enabled) =>
                      update({
                        googleWatch: enabled
                          ? {
                              projectId: "",
                              topicName: "",
                              subscriptionName: "",
                              pushServiceAccountEmail: "",
                              callbackAudience: nativeGmailCallbackAudience(state.callbackUri),
                            }
                          : undefined,
                      })
                    }
                  />
                  <FieldLabel htmlFor={`${id}-gmail-watch-enabled`}>
                    <Trans>Use Google Pub/Sub</Trans>
                  </FieldLabel>
                </Field>
                {!state.callbackUri.startsWith("https://") ? (
                  <p className="text-xs text-muted-foreground">
                    <Trans>A public HTTPS API URL is required.</Trans>
                  </p>
                ) : null}
                {draft.googleWatch ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      <Trans>
                        Configure the Pub/Sub topic, push subscription and service account in Google
                        Cloud first. Saving these fields does not verify delivery.
                      </Trans>
                    </p>
                    {(
                      [
                        { key: "projectId", label: t`Google Cloud project ID` },
                        { key: "topicName", label: t`Topic resource name` },
                        { key: "subscriptionName", label: t`Subscription resource name` },
                        { key: "pushServiceAccountEmail", label: t`Push service account email` },
                      ] as const
                    ).map((field) => (
                      <Field key={field.key}>
                        <FieldLabel htmlFor={`${id}-watch-${field.key}`}>{field.label}</FieldLabel>
                        <Input
                          id={`${id}-watch-${field.key}`}
                          type={field.key === "pushServiceAccountEmail" ? "email" : "text"}
                          value={draft.googleWatch![field.key]}
                          required
                          disabled={busy}
                          onChange={(event) =>
                            update({
                              googleWatch: {
                                ...draft.googleWatch!,
                                [field.key]: event.target.value,
                              },
                            })
                          }
                        />
                      </Field>
                    ))}
                    <Field>
                      <FieldLabel htmlFor={`${id}-watch-audience`}>
                        <Trans>Push callback audience</Trans>
                      </FieldLabel>
                      <Input
                        id={`${id}-watch-audience`}
                        readOnly
                        value={nativeGmailCallbackAudience(state.callbackUri)}
                        onFocus={(event) => event.target.select()}
                      />
                    </Field>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    <Trans>
                      Without Pub/Sub, enabled Gmail routines use periodic change checks.
                    </Trans>
                  </p>
                )}
              </div>
            </details>
          ) : null}
          {!ownerCredential &&
          (draft.credentialKind === "machine_key" ||
            draft.credentialKind === "internal_token" ||
            draft.credentialKind === "personal_token" ||
            draft.credentialKind === "bot_token" ||
            draft.credentialKind === "github_app_installation") ? (
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
          {googleApp || draft.appId === "notion" || draft.appId === "knowai" ? (
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="mb-2 text-sm font-medium">
                <Trans>Permissions</Trans>
              </legend>
              {permissions.map((permission) => (
                <Field key={permission.value} orientation="horizontal">
                  <Switch
                    id={`${id}-${permission.value}`}
                    checked={(googleApp ? draft.scopes : draft.capabilities).includes(
                      permission.value,
                    )}
                    onCheckedChange={(value) =>
                      checked(googleApp ? "scopes" : "capabilities", permission.value, value)
                    }
                  />
                  <FieldLabel htmlFor={`${id}-${permission.value}`}>{permission.label}</FieldLabel>
                </Field>
              ))}
              {draft.appId === "notion" ? (
                <p className="text-xs text-muted-foreground">
                  <Trans>Match the capabilities enabled in your Notion integration.</Trans>
                </p>
              ) : null}
            </fieldset>
          ) : null}
          {collaborationPermissions.length ? (
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="mb-2 text-sm font-medium">
                <Trans>Application scopes</Trans>
              </legend>
              {collaborationPermissions.map((scope) => (
                <Field key={scope} orientation="horizontal">
                  <Switch
                    id={`${id}-scope-${scope}`}
                    checked={draft.scopes.includes(scope)}
                    onCheckedChange={(value) => checked("scopes", scope, value)}
                  />
                  <FieldLabel htmlFor={`${id}-scope-${scope}`}>{scope}</FieldLabel>
                </Field>
              ))}
            </fieldset>
          ) : null}
          {remainingCapabilities.length ? (
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="mb-2 text-sm font-medium">
                <Trans>Permissions</Trans>
              </legend>
              {remainingCapabilities.map((capability) => (
                <Field key={capability} orientation="horizontal">
                  <Switch
                    id={`${id}-capability-${capability}`}
                    checked={draft.capabilities.includes(capability)}
                    onCheckedChange={(value) => checked("capabilities", capability, value)}
                  />
                  <FieldLabel htmlFor={`${id}-capability-${capability}`}>
                    {capabilityLabel(capability)}
                  </FieldLabel>
                </Field>
              ))}
            </fieldset>
          ) : null}
          {draft.appId === "slack" && draft.actor === "user" ? (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                <Trans>Advanced Slack data access</Trans>
              </summary>
              <fieldset className="mt-3 space-y-2" disabled={busy}>
                <legend className="mb-2 text-sm font-medium">
                  <Trans>Slack data access</Trans>
                </legend>
                <p className="text-xs text-muted-foreground">
                  <Trans>Requires Slack platform eligibility and approved data handling.</Trans>
                </p>
                <Field orientation="horizontal">
                  <Switch
                    id={`${id}-slack-user-data`}
                    checked={draft.capabilities.includes("slack_user_data_allowed")}
                    onCheckedChange={(value) =>
                      checked("capabilities", "slack_user_data_allowed", value)
                    }
                  />
                  <FieldLabel htmlFor={`${id}-slack-user-data`}>
                    <Trans>Allow user data processing</Trans>
                  </FieldLabel>
                </Field>
                {draft.scopes.includes("search:read") ? (
                  <Field orientation="horizontal">
                    <Switch
                      id={`${id}-slack-legacy-search`}
                      checked={draft.capabilities.includes("slack_legacy_search_allowed")}
                      onCheckedChange={(value) =>
                        checked("capabilities", "slack_legacy_search_allowed", value)
                      }
                    />
                    <FieldLabel htmlFor={`${id}-slack-legacy-search`}>
                      <Trans>Allow legacy search for an eligible Slack app</Trans>
                    </FieldLabel>
                  </Field>
                ) : null}
              </fieldset>
            </details>
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
