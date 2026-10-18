import { Trans, useLingui } from "@lingui/react/macro";
import type {
  NativeConfigStatus,
  NativeSlackBotEvent,
  NativeSlackHook,
  NativeSlackHookStatus,
} from "@rakazo/contracts";
import { SaveNativeSlackHookInputSchema } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Field,
  FieldLabel,
  Input,
  Switch,
} from "@rakazo/ui-web";
import { ArrowLeft } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

const EVENTS: { event: NativeSlackBotEvent; scope: string }[] = [
  { event: "app_mention", scope: "app_mentions:read" },
  { event: "message.im", scope: "im:history" },
  { event: "message.channels", scope: "channels:history" },
  { event: "message.groups", scope: "groups:history" },
];
/** App-owner setup only. Signed delivery does not itself enable any Routine. */
export function NativeSlackEventSetup({
  config,
  onBack,
}: {
  config: NativeConfigStatus;
  onBack: () => void;
}) {
  const { t } = useLingui(),
    id = useId();
  const generation = useRef(0),
    pending = useRef(false),
    statusRequest = useRef(0);
  const [status, setStatus] = useState<NativeSlackHookStatus | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0),
    [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NativeSlackHook | null>(null);
  const [appId, setAppId] = useState(""),
    [secret, setSecret] = useState("");
  const [events, setEvents] = useState<NativeSlackBotEvent[]>([]),
    [confirmed, setConfirmed] = useState(false);
  const [stopping, setStopping] = useState<NativeSlackHook | null>(null);
  useEffect(() => {
    generation.current++;
    statusRequest.current++;
    pending.current = false;
    setStatus(null);
    setEditing(null);
    setStopping(null);
    setAppId("");
    setSecret("");
    setEvents([]);
    setConfirmed(false);
    setError(null);
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [config.id, config.revision]);
  useEffect(() => {
    if (pending.current) return;
    let cancelled = false;
    const current = generation.current,
      request = ++statusRequest.current;
    setLoading(true);
    void rpc.nativeConnectors
      .slackWebhookStatus({ configId: config.id })
      .then((next) => {
        if (!cancelled && generation.current === current && statusRequest.current === request) {
          setStatus(next);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled && generation.current === current && statusRequest.current === request)
          setError(errorText(reason, t`Could not load Slack event subscriptions`));
      })
      .finally(() => {
        if (!cancelled && generation.current === current && statusRequest.current === request)
          setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [config.id, config.revision, reload]);
  function phase(hook: NativeSlackHook) {
    switch (hook.phase) {
      case "waiting_for_verification":
        return t`Verify the Request URL in Slack`;
      case "active":
        return t`Request URL verified`;
      case "disabled":
        return t`Stopped`;
      case "invalidated":
        return t`Application settings changed`;
    }
  }
  function edit(hook: NativeSlackHook) {
    setEditing(hook);
    setAppId(hook.appId);
    setSecret("");
    setEvents([...hook.botEvents]);
    setConfirmed(false);
    setError(null);
  }
  async function save() {
    if (pending.current) return;
    const parsed = SaveNativeSlackHookInputSchema.safeParse({
      configId: config.id,
      ...(editing ? { id: editing.id, expectedRevision: editing.revision } : {}),
      appId: appId.trim(),
      signingSecret: secret,
      botEvents: events,
      botSubscriptionsConfirmed: confirmed,
    });
    if (!parsed.success) {
      setError(t`Enter the Slack App ID, signing secret and bot subscriptions.`);
      return;
    }
    const current = generation.current;
    pending.current = true;
    statusRequest.current++;
    setLoading(false);
    setBusy(true);
    setError(null);
    setSecret("");
    try {
      const hook = await rpc.nativeConnectors.saveSlackWebhook(parsed.data);
      if (generation.current !== current) return;
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              hooks: [hook, ...previous.hooks.filter((entry) => entry.id !== hook.id)],
            }
          : previous,
      );
      setEditing(null);
      setAppId("");
      setEvents([]);
      setConfirmed(false);
      setReload((value) => value + 1);
    } catch (reason) {
      if (generation.current === current)
        setError(errorText(reason, t`Could not save Slack event subscription`));
    } finally {
      if (generation.current === current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  async function stop() {
    if (!stopping || pending.current) return;
    const current = generation.current;
    pending.current = true;
    statusRequest.current++;
    setLoading(false);
    setBusy(true);
    setError(null);
    try {
      const hook = await rpc.nativeConnectors.disableSlackWebhook({
        configId: config.id,
        id: stopping.id,
        expectedRevision: stopping.revision,
      });
      if (generation.current !== current) return;
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              hooks: previous.hooks.map((entry) => (entry.id === hook.id ? hook : entry)),
            }
          : previous,
      );
      setStopping(null);
      setReload((value) => value + 1);
    } catch (reason) {
      if (generation.current === current)
        setError(errorText(reason, t`Could not stop Slack event subscription`));
    } finally {
      if (generation.current === current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section
      className="space-y-4 border-t border-border pt-6"
      aria-busy={loading || busy}
      aria-labelledby={`${id}-title`}
    >
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t`Back to applications`}
          disabled={busy}
          onClick={() => {
            setSecret("");
            onBack();
          }}
        >
          <ArrowLeft />
        </Button>
        <h2 id={`${id}-title`} className="text-base font-medium">
          <Trans>Slack event subscriptions</Trans>
        </h2>
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Loading subscriptions…</Trans>
        </p>
      ) : null}
      {status && !status.publicHttpsAvailable ? (
        <p className="text-sm text-muted-foreground">
          <Trans>A public HTTPS API URL is required.</Trans>
        </p>
      ) : null}
      {status?.hooks.map((hook) => (
        <div key={hook.id} className="space-y-2 rounded-xl border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">{hook.appId}</p>
              <p className="text-xs text-muted-foreground">{phase(hook)}</p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => edit(hook)}
              >
                <Trans>Replace signing secret</Trans>
              </Button>
              {hook.enabled ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setStopping(hook)}
                >
                  <Trans>Stop</Trans>
                </Button>
              ) : null}
            </div>
          </div>
          {hook.webhookUrl ? (
            <Field>
              <FieldLabel htmlFor={`${id}-${hook.id}-url`}>
                <Trans>Slack Request URL</Trans>
              </FieldLabel>
              <Input
                id={`${id}-${hook.id}-url`}
                value={hook.webhookUrl}
                readOnly
                onFocus={(event) => event.target.select()}
              />
            </Field>
          ) : null}
          <p className="text-xs text-muted-foreground">{hook.botEvents.join(", ")}</p>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={loading || busy}
        onClick={() => setReload((value) => value + 1)}
      >
        <Trans>Check verification</Trans>
      </Button>
      {status?.publicHttpsAvailable ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h3 className="text-sm font-medium">
            {editing ? t`Replace event credentials` : t`Set up Slack events`}
          </h3>
          <Field>
            <FieldLabel htmlFor={`${id}-app`}>
              <Trans>Slack App ID</Trans>
            </FieldLabel>
            <Input
              id={`${id}-app`}
              value={appId}
              required
              disabled={busy}
              onChange={(event) => setAppId(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-secret`}>
              <Trans>Signing secret</Trans>
            </FieldLabel>
            <Input
              id={`${id}-secret`}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={secret}
              minLength={16}
              maxLength={4096}
              required
              disabled={busy}
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="mb-2 text-sm font-medium">
              <Trans>Subscribe to bot events</Trans>
            </legend>
            {EVENTS.map((entry) => (
              <Field key={entry.event} orientation="horizontal">
                <Switch
                  id={`${id}-${entry.event}`}
                  checked={events.includes(entry.event)}
                  onCheckedChange={(checked) => {
                    setEvents((values) =>
                      checked
                        ? [...values, entry.event]
                        : values.filter((value) => value !== entry.event),
                    );
                    setConfirmed(false);
                  }}
                />
                <FieldLabel htmlFor={`${id}-${entry.event}`}>
                  {entry.event} · {entry.scope}
                </FieldLabel>
              </Field>
            ))}
          </fieldset>
          <p className="text-xs text-muted-foreground">
            <Trans>
              After saving, verify the Request URL and enable these bot events in Slack. Grant the
              matching bot scopes separately.
            </Trans>
          </p>
          <Field orientation="horizontal">
            <Switch
              id={`${id}-confirm`}
              checked={confirmed}
              disabled={busy}
              onCheckedChange={setConfirmed}
            />
            <FieldLabel htmlFor={`${id}-confirm`}>
              <Trans>I will enable these bot events in Slack</Trans>
            </FieldLabel>
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !confirmed || !events.length}>
              <Trans>Save event subscription</Trans>
            </Button>
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setSecret("");
                  setAppId("");
                  setEvents([]);
                  setConfirmed(false);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <AlertDialog
        open={Boolean(stopping)}
        onOpenChange={(open) => {
          if (!open && !busy) setStopping(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Stop Slack events?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                This stops delivery here. Remove the event subscription in Slack separately.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void stop()}>
              <Trans>Stop</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
