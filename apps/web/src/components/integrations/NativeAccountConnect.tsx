import { Trans, useLingui } from "@lingui/react/macro";
import type {
  NativeAppId,
  NativeBeginInput,
  NativeConfigStatus,
  NativeSetupState,
} from "@rakazo/contracts";
import { NativeBeginInputSchema } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

/** Collects an exact connection source; the parent owns authorization and completion. */
export function NativeAccountConnect({
  appId,
  previousConnectionId,
  onSubmit,
  onCancel,
  authorizationUrl,
}: {
  appId: NativeAppId;
  previousConnectionId?: string;
  onSubmit: (input: NativeBeginInput) => Promise<void>;
  onCancel: () => void;
  authorizationUrl?: string;
}) {
  const { t } = useLingui();
  const id = useId();
  const [state, setState] = useState<NativeSetupState | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [credential, setCredential] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const submitting = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setState(null);
    setSelectedId("");
    setCredential("");
    setError(null);
    void rpc.nativeConnectors
      .status()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        // Auto-select only an unambiguous source; several sources require a deliberate choice.
        const ready = next.configurations.filter(
          (entry) => entry.appId === appId && entry.enabled && entry.configured,
        );
        setSelectedId(ready.length === 1 ? ready[0]!.id : "");
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err, t`Could not load connection methods`));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appId, previousConnectionId, reload]);

  const configurations =
    state?.configurations.filter(
      (entry) => entry.appId === appId && entry.enabled && entry.configured,
    ) ?? [];
  const selected = configurations.find((entry) => entry.id === selectedId);
  const usesConfiguredCredential = selected?.usesConfiguredCredential === true;
  const oauth = selected?.credentialKind === "oauth" || selected?.credentialKind === "mcp_oauth";
  const canChooseDriveFiles =
    appId === "google-drive" &&
    selected?.credentialKind === "oauth" &&
    !previousConnectionId &&
    selected.driveFilePickerAvailable === true;
  function methodLabel(entry: NativeConfigStatus): string {
    const kind =
      entry.credentialKind === "machine_key"
        ? ["feishu-lark", "dingtalk", "wecom"].includes(appId)
          ? t`App credentials`
          : t`Machine API key`
        : entry.credentialKind === "internal_token"
          ? t`Internal integration`
          : entry.credentialKind === "personal_token"
            ? appId === "linear"
              ? t`Personal API key`
              : appId === "slack"
                ? t`User token`
                : appId === "hubspot"
                  ? t`Private app token`
                  : t`Personal access token`
            : entry.credentialKind === "bot_token"
              ? t`Bot token`
              : entry.credentialKind === "github_app_installation"
                ? t`GitHub App installation`
                : t`Account authorization`;
    const ownership =
      entry.ownership === "official" ? t`Official application` : t`Your application`;
    const actor = entry.actor
      ? entry.actor === "installation"
        ? t`App installation`
        : entry.actor === "bot"
          ? t`Bot`
          : entry.actor === "app"
            ? t`Application`
            : t`User`
      : null;
    return `${entry.label} · ${ownership} · ${kind}${actor ? ` · ${actor}` : ""}`;
  }
  const credentialLabel =
    selected?.credentialKind === "machine_key"
      ? t`Machine API key`
      : selected?.credentialKind === "internal_token"
        ? t`Internal integration token`
        : selected?.credentialKind === "bot_token"
          ? appId === "telegram-bot"
            ? t`Telegram bot token`
            : appId === "discord"
              ? t`Discord bot token`
              : t`Slack bot token`
          : selected?.credentialKind === "github_app_installation"
            ? t`GitHub App private key JSON`
            : appId === "linear"
              ? t`Linear API key`
              : appId === "slack"
                ? t`Slack user token`
                : appId === "hubspot"
                  ? t`HubSpot private app token`
                  : t`Personal access token`;
  const submitLabel = usesConfiguredCredential
    ? t`Connect application`
    : oauth
      ? t`Authorize account`
      : selected?.credentialKind === "machine_key"
        ? t`Connect machine`
        : selected?.credentialKind === "internal_token"
          ? t`Connect integration`
          : t`Connect account`;

  async function submit(authorizationFlow?: "drive_picker") {
    if (!selected || submitting.current) return;
    if (authorizationFlow && !canChooseDriveFiles) return;
    const parsed = NativeBeginInputSchema.safeParse({
      configId: selected.id,
      ...(authorizationFlow ? { authorizationFlow } : {}),
      ...(previousConnectionId ? { previousConnectionId } : {}),
      ...(!oauth && !usesConfiguredCredential ? { credential: credential.trim() } : {}),
    });
    if (!parsed.success) {
      setError(t`Enter a valid credential`);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(parsed.data);
      setCredential("");
    } catch (err) {
      setError(errorText(err, t`Could not connect`));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      aria-busy={loading || busy}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-base font-medium text-foreground">
        {previousConnectionId ? t`Reconnect account` : t`Connect account`}
      </h3>
      {loading ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Loading connection methods…</Trans>
        </p>
      ) : null}
      {!loading && state && configurations.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {state.canConfigure
              ? t`No connection method is configured.`
              : t`Ask your administrator to enable a connection method.`}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {state.canConfigure ? (
              <a
                className="text-sm underline underline-offset-4"
                href="/integrations/setup"
                target="_blank"
                rel="noreferrer"
              >
                <Trans>Set up application</Trans>
              </a>
            ) : null}
            <Button type="button" variant="outline" onClick={() => setReload((value) => value + 1)}>
              <Trans>Check again</Trans>
            </Button>
          </div>
        </div>
      ) : null}
      {configurations.length > 0 ? (
        <Field>
          <FieldLabel htmlFor={`${id}-source`}>
            <Trans>Connection method</Trans>
          </FieldLabel>
          <NativeSelect
            id={`${id}-source`}
            className="w-full"
            value={selectedId}
            disabled={busy}
            required
            onChange={(event) => {
              setSelectedId(event.target.value);
              setCredential("");
              setError(null);
            }}
          >
            {configurations.length > 1 ? (
              <NativeSelectOption value="">
                <Trans>Choose a connection method</Trans>
              </NativeSelectOption>
            ) : null}
            {configurations.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {methodLabel(entry)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      {selected && !oauth && !usesConfiguredCredential ? (
        <Field>
          <FieldLabel htmlFor={`${id}-credential`}>{credentialLabel}</FieldLabel>
          <Input
            id={`${id}-credential`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            autoCapitalize="none"
            value={credential}
            disabled={busy}
            required
            maxLength={16384}
            onChange={(event) => setCredential(event.target.value)}
          />
          {selected.credentialKind === "machine_key" ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Uses a machine identity restricted to the configured knowledge bases.</Trans>
            </p>
          ) : null}
          {selected.credentialKind === "internal_token" ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Only pages shared with this integration are available.</Trans>
            </p>
          ) : null}
          {selected.credentialKind === "github_app_installation" ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                Enter JSON with appId, installationId and privateKeyPem for the configured
                installation.
              </Trans>
            </p>
          ) : null}
        </Field>
      ) : null}
      {appId === "figma" && selected?.credentialKind === "oauth" ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            Authorizing this Figma account replaces its previous authorization for this application.
          </Trans>
        </p>
      ) : null}
      {canChooseDriveFiles ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm text-muted-foreground">
            <Trans>Connect with access to the files and folders you choose in Google.</Trans>
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void submit("drive_picker")}
          >
            <Trans>Choose accessible files</Trans>
          </Button>
        </div>
      ) : null}
      {appId === "google-drive" &&
      selected?.credentialKind === "oauth" &&
      !previousConnectionId &&
      selected.driveFilePickerAvailable === false ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Ask an administrator to enable access to selected files.</Trans>
        </p>
      ) : null}
      {busy && authorizationUrl ? (
        <a
          className="inline-flex text-sm underline underline-offset-4"
          href={authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Trans>Continue authorization</Trans>
        </a>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setCredential("");
            onCancel();
          }}
        >
          <Trans>Back</Trans>
        </Button>
        {!loading && !state ? (
          <Button type="button" variant="outline" onClick={() => setReload((value) => value + 1)}>
            <Trans>Try again</Trans>
          </Button>
        ) : null}
        {configurations.length > 0 ? (
          <Button
            type="submit"
            disabled={
              busy || !selected || (!oauth && !usesConfiguredCredential && !credential.trim())
            }
          >
            {busy ? t`Connecting…` : submitLabel}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
