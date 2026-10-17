import { Trans, useLingui } from "@lingui/react/macro";
import type {
  NativeConfigStatus,
  NativeNotionHook,
  NativeNotionHookStatus,
} from "@rakazo/contracts";
import { ConfirmNativeNotionHookSetupInputSchema } from "@rakazo/contracts";
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
  Checkbox,
  Field,
  FieldLabel,
  Input,
} from "@rakazo/ui-web";
import { ArrowLeft } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

/** Deployment setup only. Account credentials and Routine resource selection live in Apps. */
export function NativeNotionWebhookSetup({
  config,
  onBack,
}: {
  config: NativeConfigStatus;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const generation = useRef(0);
  const pending = useRef(false);
  const statusRequest = useRef(0);
  const [status, setStatus] = useState<NativeNotionHookStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [integrationIds, setIntegrationIds] = useState<Record<string, string>>({});
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null);
  const [stopping, setStopping] = useState<NativeNotionHook | null>(null);

  useEffect(() => {
    generation.current++;
    statusRequest.current++;
    setStatus(null);
    setRevealed(null);
    setIntegrationIds({});
    setVerified({});
    setStopping(null);
    setStatusError(null);
    setError(null);
    setNotice(null);
    pending.current = false;
    setBusy(false);
    return () => {
      generation.current++;
      statusRequest.current++;
    };
  }, [config.id, config.revision]);
  useEffect(() => {
    if (pending.current) return;
    let cancelled = false;
    const current = generation.current;
    const request = ++statusRequest.current;
    const isCurrent = () =>
      !cancelled && generation.current === current && statusRequest.current === request;
    setLoadingStatus(true);
    void rpc.nativeConnectors
      .notionWebhookStatus({ configId: config.id })
      .then((next) => {
        if (!isCurrent()) return;
        setRevealed((previous) => {
          const hook = next.hooks.find((entry) => entry.id === previous?.id);
          const expiresAt = Date.parse(hook?.setupExpiresAt ?? "");
          return hook?.phase === "waiting_for_owner" &&
            Number.isFinite(expiresAt) &&
            expiresAt > Date.now()
            ? previous
            : null;
        });
        setStatus(next);
        setStatusError(null);
      })
      .catch((err: unknown) => {
        if (isCurrent()) setStatusError(errorText(err, t`Could not load event subscriptions`));
      })
      .finally(() => {
        if (isCurrent()) setLoadingStatus(false);
      });
    return () => {
      cancelled = true;
    };
  }, [config.id, config.revision, reload]);

  const waiting = status?.hooks.some((hook) => hook.phase.startsWith("waiting_for_"));
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      if (!pending.current) setReload((value) => value + 1);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [waiting]);
  const revealedHook = status?.hooks.find((hook) => hook.id === revealed?.id);
  useEffect(() => {
    if (!revealed) return;
    const expiry = Date.parse(revealedHook?.setupExpiresAt ?? "");
    if (
      revealedHook?.phase !== "waiting_for_owner" ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now()
    ) {
      setRevealed(null);
      return;
    }
    const timer = window.setTimeout(() => setRevealed(null), expiry - Date.now());
    return () => window.clearTimeout(timer);
  }, [revealed, revealedHook?.phase, revealedHook?.setupExpiresAt]);

  function phaseLabel(phase: NativeNotionHook["phase"]) {
    switch (phase) {
      case "waiting_for_challenge":
        return t`Waiting for Notion`;
      case "waiting_for_owner":
        return t`Verify in Notion`;
      case "waiting_for_signed_identity":
        return t`Waiting for first signed event`;
      case "active":
        return t`Receiving events`;
      case "disabled":
        return t`Stopped`;
      case "expired":
        return t`Setup expired`;
      case "invalidated":
        return t`Application settings changed`;
    }
  }
  async function perform(
    action: "begin" | "reveal" | "confirm" | "disable",
    hook?: NativeNotionHook,
  ) {
    if (pending.current) return;
    const current = generation.current;
    if (
      action === "confirm" &&
      status?.hooks.some((other) => other.id !== hook?.id && other.enabled)
    ) {
      setError(t`Stop the existing subscription here before enabling this one.`);
      return;
    }
    const existing = hook
      ? { configId: config.id, id: hook.id, expectedRevision: hook.revision }
      : null;
    const confirmation =
      action === "confirm" && hook
        ? ConfirmNativeNotionHookSetupInputSchema.safeParse({
            ...existing,
            integrationId: integrationIds[hook.id]?.trim(),
            verifiedInNotion: verified[hook.id],
          })
        : null;
    if (confirmation && !confirmation.success) {
      setError(t`Enter the integration ID and verify the subscription in Notion first.`);
      return;
    }
    pending.current = true;
    statusRequest.current++;
    setLoadingStatus(false);
    setBusy(true);
    setError(null);
    setNotice(null);
    if (action !== "reveal") setRevealed(null);
    try {
      let next: NativeNotionHook;
      let token: string | undefined;
      if (action === "begin")
        next = await rpc.nativeConnectors.beginNotionWebhookSetup({ configId: config.id });
      else if (action === "reveal" && existing) {
        const result = await rpc.nativeConnectors.revealNotionWebhookToken(existing);
        next = result.hook;
        token = result.verificationToken;
      } else if (action === "confirm" && confirmation?.success) {
        next = await rpc.nativeConnectors.confirmNotionWebhookSetup(confirmation.data);
      } else if (action === "disable" && existing)
        next = await rpc.nativeConnectors.disableNotionWebhook(existing);
      else return;
      if (generation.current !== current) return;
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              hooks: [next, ...previous.hooks.filter((entry) => entry.id !== next.id)],
            }
          : previous,
      );
      if (token) {
        const expiresAt = Date.parse(next.setupExpiresAt ?? "");
        if (
          next.phase === "waiting_for_owner" &&
          Number.isFinite(expiresAt) &&
          expiresAt > Date.now()
        )
          setRevealed({ id: next.id, value: token });
        else setError(t`This setup has expired. Refresh to check its status.`);
      }
      if (action === "disable") {
        setStopping(null);
        setNotice(t`Webhook stopped here. Remove the subscription in Notion separately.`);
      }
      setReload((value) => value + 1);
    } catch (err) {
      if (generation.current === current) {
        setRevealed(null);
        setError(errorText(err, t`Could not update event subscription`));
        setReload((value) => value + 1);
      }
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
      aria-labelledby={`${fieldId}-title`}
      aria-busy={busy}
    >
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t`Back to applications`}
          onClick={() => {
            generation.current++;
            statusRequest.current++;
            setRevealed(null);
            onBack();
          }}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 id={`${fieldId}-title`} className="text-base font-medium">
            <Trans>Notion webhooks</Trans>
          </h2>
          <p className="truncate text-sm text-muted-foreground">{config.label}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || loadingStatus}
          onClick={() => {
            setError(null);
            setReload((value) => value + 1);
          }}
        >
          {loadingStatus ? t`Refreshing…` : t`Refresh`}
        </Button>
      </div>
      {error || statusError ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? statusError}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {!status ? (
        loadingStatus ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Loading subscriptions…</Trans>
          </p>
        ) : null
      ) : (
        <>
          {!status.publicHttpsAvailable ? (
            <p className="text-sm text-muted-foreground">
              <Trans>A public HTTPS address is required to receive Notion webhooks.</Trans>
            </p>
          ) : null}
          {status.hooks.map((hook) => {
            const live = hook.phase.startsWith("waiting_for_") || hook.phase === "active";
            const hasOtherEnabled = status.hooks.some(
              (other) => other.id !== hook.id && other.enabled,
            );
            return (
              <div key={hook.id} className="space-y-3 rounded-xl border border-border p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium">{phaseLabel(hook.phase)}</h3>
                  {live ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setRevealed(null);
                        setStopping(hook);
                      }}
                    >
                      <Trans>Stop subscription</Trans>
                    </Button>
                  ) : null}
                </div>
                {hook.webhookUrl ? (
                  <Field>
                    <FieldLabel htmlFor={`${fieldId}-${hook.id}-url`}>
                      <Trans>Webhook URL</Trans>
                    </FieldLabel>
                    <Input
                      id={`${fieldId}-${hook.id}-url`}
                      value={hook.webhookUrl}
                      readOnly
                      onFocus={(event) => event.target.select()}
                    />
                    {hook.phase === "waiting_for_challenge" ? (
                      <p className="text-xs text-muted-foreground">
                        <Trans>Add this URL in your Notion integration’s Webhooks tab.</Trans>
                      </p>
                    ) : null}
                  </Field>
                ) : null}
                {hook.phase === "waiting_for_owner" ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      <Trans>
                        Paste the verification token into Notion and verify the subscription.
                      </Trans>
                    </p>
                    {revealed?.id === hook.id ? (
                      <Field>
                        <FieldLabel htmlFor={`${fieldId}-${hook.id}-token`}>
                          <Trans>Verification token</Trans>
                        </FieldLabel>
                        <Input
                          id={`${fieldId}-${hook.id}-token`}
                          value={revealed.value}
                          readOnly
                          autoComplete="off"
                          spellCheck={false}
                          onFocus={(event) => event.target.select()}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setRevealed(null)}
                        >
                          <Trans>Hide token</Trans>
                        </Button>
                      </Field>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void perform("reveal", hook)}
                      >
                        <Trans>Show verification token</Trans>
                      </Button>
                    )}
                    <Field>
                      <FieldLabel htmlFor={`${fieldId}-${hook.id}-integration`}>
                        <Trans>Integration ID in Notion</Trans>
                      </FieldLabel>
                      <Input
                        id={`${fieldId}-${hook.id}-integration`}
                        value={integrationIds[hook.id] ?? ""}
                        disabled={busy}
                        autoComplete="off"
                        onChange={(event) =>
                          setIntegrationIds((previous) => ({
                            ...previous,
                            [hook.id]: event.target.value,
                          }))
                        }
                      />
                      {hook.candidateIntegrationId ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            setIntegrationIds((previous) => ({
                              ...previous,
                              [hook.id]: hook.candidateIntegrationId ?? "",
                            }))
                          }
                        >
                          <Trans>Use ID from received event</Trans>
                        </Button>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          <Trans>
                            Enter your integration ID, or make a change in Notion to receive it.
                          </Trans>
                        </p>
                      )}
                    </Field>
                    <p className="text-xs text-muted-foreground">
                      <Trans>
                        Check this ID against your Notion integration before enabling events.
                      </Trans>
                    </p>
                    <Field orientation="horizontal">
                      <Checkbox
                        id={`${fieldId}-${hook.id}-verified`}
                        checked={verified[hook.id] ?? false}
                        disabled={busy}
                        onCheckedChange={(value) =>
                          setVerified((previous) => ({ ...previous, [hook.id]: value === true }))
                        }
                      />
                      <FieldLabel htmlFor={`${fieldId}-${hook.id}-verified`}>
                        <Trans>I verified this subscription in Notion</Trans>
                      </FieldLabel>
                    </Field>
                    {hasOtherEnabled ? (
                      <p className="text-sm text-muted-foreground">
                        <Trans>Stop the existing subscription here before enabling this one.</Trans>
                      </p>
                    ) : null}
                    <Button
                      type="button"
                      disabled={
                        busy ||
                        hasOtherEnabled ||
                        !verified[hook.id] ||
                        !integrationIds[hook.id]?.trim()
                      }
                      onClick={() => void perform("confirm", hook)}
                    >
                      <Trans>Enable events</Trans>
                    </Button>
                  </>
                ) : null}
                {hook.phase === "waiting_for_signed_identity" ? (
                  <p className="text-sm text-muted-foreground">
                    <Trans>Make a change in Notion to confirm event delivery.</Trans>
                  </p>
                ) : null}
                {hook.phase === "active" && hook.integrationId ? (
                  <p className="break-all text-xs text-muted-foreground">
                    <Trans>Integration</Trans> · {hook.integrationId}
                  </p>
                ) : null}
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            disabled={busy || !status.publicHttpsAvailable || !config.enabled || !config.configured}
            onClick={() => void perform("begin")}
          >
            <Trans>Set up subscription</Trans>
          </Button>
          <a
            className="ml-3 text-sm text-muted-foreground underline underline-offset-4"
            href="https://developers.notion.com/reference/webhooks"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Trans>Notion setup instructions</Trans>
          </a>
        </>
      )}
      <AlertDialog
        open={Boolean(stopping)}
        onOpenChange={(open) => {
          if (!open && !busy) setStopping(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Stop this subscription?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Webhook deliveries will be ignored. Routines continue checking Notion for changes.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (stopping) void perform("disable", stopping);
              }}
            >
              <Trans>Stop subscription</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
