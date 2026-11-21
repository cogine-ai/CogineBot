import { Trans, useLingui } from "@lingui/react/macro";
import { useReadAloudSettings } from "@rakazo/chat-ui/read-aloud";
import type { ReadAloudSettings as Settings } from "@rakazo/contracts";
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
  NativeSelect,
  NativeSelectOption,
  Switch,
} from "@rakazo/ui-web";
import { useId, useMemo, useState } from "react";
import { newClientId } from "../lib/client-id";
import { useSpaceRpc, useSpaceRpcCurrent } from "../lib/space-rpc";

export function ReadAloudSettings() {
  const rpc = useSpaceRpc();
  const isCurrent = useSpaceRpcCurrent();
  const { t } = useLingui();
  const id = useId();
  const transport = useMemo(
    () => ({
      read: (signal: AbortSignal) => rpc.preferences.readAloud({}, { signal }),
      write: (input: Parameters<typeof rpc.preferences.updateReadAloud>[0], signal: AbortSignal) =>
        rpc.preferences.updateReadAloud(input, { signal }),
      isCurrent,
    }),
    [rpc, isCurrent],
  );
  const { settings, pending, problem, load, save } = useReadAloudSettings(transport);
  const [intent, setConfirm] = useState<{
    value: boolean | null;
    snapshot: Settings;
    transport: typeof transport;
  } | null>(null);
  const confirm = intent?.transport === transport ? intent : null;
  const labelValue = (value: boolean | null) =>
    value === null ? t`System default` : value ? t`On` : t`Off`;
  const effectiveSource =
    settings?.effective.source === "space"
      ? t`This Space`
      : settings?.effective.source === "account"
        ? t`My default`
        : t`System default`;
  function saveSpace(value: boolean | "copy" | null) {
    if (!settings) return;
    void save({
      scope: "space",
      value,
      expectedRevision: settings.space.revision,
      expectedAccountRevision: settings.account.revision,
      clientNonce: newClientId(),
    });
  }
  return (
    <section aria-labelledby={id} className="mb-6 space-y-3 border-b border-border pb-5">
      <h3 id={id} className="text-sm font-medium">
        <Trans>Read replies aloud</Trans>
      </h3>
      {problem ? (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          {problem === "conflict"
            ? t`Settings changed elsewhere.`
            : problem === "load"
              ? t`Could not load read-aloud settings.`
              : t`Could not save read-aloud settings.`}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => void load()}
          >
            <Trans>Reload</Trans>
          </Button>
        </div>
      ) : null}
      {settings ? (
        <>
          <label
            htmlFor={`${id}-account`}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <Trans>My default</Trans>
            <NativeSelect
              id={`${id}-account`}
              aria-label={t`My default`}
              disabled={pending}
              value={settings.account.value === null ? "default" : String(settings.account.value)}
              onChange={(event) => {
                const value = event.target.value;
                setConfirm({
                  value: value === "default" ? null : value === "true",
                  snapshot: settings,
                  transport,
                });
              }}
            >
              <NativeSelectOption value="default">{t`System default`}</NativeSelectOption>
              <NativeSelectOption value="true">{t`On`}</NativeSelectOption>
              <NativeSelectOption value="false">{t`Off`}</NativeSelectOption>
            </NativeSelect>
          </label>
          <label
            htmlFor={`${id}-override`}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <Trans>Override in this Space</Trans>
            <Switch
              id={`${id}-override`}
              aria-label={t`Override in this Space`}
              checked={settings.space.value !== null}
              disabled={pending}
              onCheckedChange={(checked) => saveSpace(checked ? "copy" : null)}
            />
          </label>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">{effectiveSource}</span>
            {settings.space.value !== null ? (
              <Switch
                aria-label={t`Read replies aloud in this Space`}
                checked={settings.space.value}
                disabled={pending}
                onCheckedChange={saveSpace}
              />
            ) : (
              <span>{settings.effective.enabled ? t`On` : t`Off`}</span>
            )}
          </div>
        </>
      ) : null}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Change my read-aloud default?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm ? (
                <strong>
                  {labelValue(confirm.snapshot.account.value)} → {labelValue(confirm.value)}.{" "}
                </strong>
              ) : null}
              <Trans>This applies to new replies in Spaces that follow your default.</Trans>{" "}
              {confirm?.snapshot.followingSpaces.map(({ name }) => name).join(", ")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirm) return;
                const { value, snapshot } = confirm;
                setConfirm(null);
                void save({
                  scope: "account",
                  value,
                  expectedRevision: snapshot.account.revision,
                  followingSpaceIds: snapshot.followingSpaces.map(({ id }) => id),
                  clientNonce: newClientId(),
                });
              }}
            >
              <Trans>Confirm</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
