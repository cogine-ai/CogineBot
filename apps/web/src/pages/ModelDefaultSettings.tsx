import { Trans, useLingui } from "@lingui/react/macro";
import { usePreferenceSettings } from "@rakazo/chat-ui/read-aloud";
import type {
  DefaultModelChoice,
  ModelDefaults,
  UpdateModelDefaultsInput,
} from "@rakazo/contracts";
import { defaultModelChoiceKey } from "@rakazo/contracts";
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

export function ModelDefaultSettings({
  label,
  busy,
  begin,
  finish,
  onChange,
}: {
  label: (choice: DefaultModelChoice) => string;
  busy: boolean;
  begin: () => number | null;
  finish: (owner: number) => void;
  onChange: () => Promise<unknown>;
}) {
  const rpc = useSpaceRpc();
  const isCurrent = useSpaceRpcCurrent();
  const { t } = useLingui();
  const id = useId();
  const transport = useMemo(
    () => ({
      read: (signal: AbortSignal) => rpc.models.defaults({}, { signal }),
      write: (input: UpdateModelDefaultsInput, signal: AbortSignal) =>
        rpc.models.updateDefaults(input, { signal }),
      isCurrent,
    }),
    [rpc, isCurrent],
  );
  const { settings, pending, problem, load, save } = usePreferenceSettings(transport);
  const [intent, setIntent] = useState<{
    value: DefaultModelChoice | null;
    snapshot: ModelDefaults;
    transport: typeof transport;
  } | null>(null);
  const confirm = intent?.transport === transport ? intent : null;
  const account = settings?.account.value;
  const key = defaultModelChoiceKey;
  const accountKey = account ? key(account) : "";
  const listed = settings?.choices.some((choice) => key(choice) === accountKey);
  const effective = settings?.effective;
  const source =
    effective?.source === "account"
      ? t`My default`
      : effective?.source === "space"
        ? t`This Space`
        : t`System default`;
  const choiceLabel = (value: DefaultModelChoice | null) =>
    value ? label(value) : t`No account default`;

  async function sync(input?: UpdateModelDefaultsInput) {
    if (!isCurrent()) return;
    const owner = begin();
    if (owner === null) return;
    try {
      if (input) {
        if (!(await save(input))) return;
      } else {
        await load();
      }
      if (isCurrent()) await onChange();
    } finally {
      finish(owner);
    }
  }

  return (
    <section aria-label={t`Model defaults`} className="mt-4 space-y-2 border-t border-border pt-3">
      {problem ? (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          {problem === "conflict"
            ? t`Settings changed elsewhere.`
            : problem === "unavailable"
              ? t`Choose a model connection in this Space.`
              : problem === "load"
                ? t`Could not load model defaults`
                : t`Could not save model defaults`}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending || busy}
            onClick={() => void sync()}
          >
            <Trans>Reload</Trans>
          </Button>
        </div>
      ) : null}
      {settings ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
          <label htmlFor={`${id}-account`} className="flex items-center gap-2">
            <Trans>My default model</Trans>
            <NativeSelect
              id={`${id}-account`}
              value={account && !listed ? "saved" : accountKey}
              disabled={pending || busy || (!account && !settings.choices.length)}
              onChange={(event) => {
                const selected = event.target.value;
                const choice = settings.choices.find((candidate) => key(candidate) === selected);
                if (choice || selected === "")
                  setIntent({ value: choice ?? null, snapshot: settings, transport });
              }}
            >
              <NativeSelectOption value="">{t`No account default`}</NativeSelectOption>
              {account && !listed ? (
                <NativeSelectOption disabled value="saved">
                  {label(account)}
                </NativeSelectOption>
              ) : null}
              {settings.choices.map((choice) => (
                <NativeSelectOption value={key(choice)} key={key(choice)}>
                  {label(choice)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label htmlFor={`${id}-space`} className="flex items-center gap-2">
            <Trans>Override model in this Space</Trans>
            <Switch
              id={`${id}-space`}
              checked={settings.space.value}
              disabled={
                pending ||
                busy ||
                (!settings.space.value && (!effective?.choice || Boolean(effective.unavailable)))
              }
              onCheckedChange={(enabled) =>
                void sync({
                  scope: "space",
                  enabled,
                  expectedRevision: settings.space.revision,
                  expectedAccountRevision: settings.account.revision,
                  expectedChoice: settings.effective.choice,
                  clientNonce: newClientId(),
                })
              }
            />
          </label>
          <span className="text-muted-foreground">
            {effective?.unavailable ? t`Choose a model connection in this Space.` : source}
          </span>
        </div>
      ) : null}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setIntent(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Change my default model?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm ? (
                <strong>
                  {choiceLabel(confirm.snapshot.account.value)} → {choiceLabel(confirm.value)}.{" "}
                </strong>
              ) : null}
              <Trans>Following Spaces use their own connection for new runs.</Trans>{" "}
              {confirm?.snapshot.followingSpaces.map(({ name }) => name).join(", ")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || pending}
              onClick={() => {
                if (!confirm) return;
                setIntent(null);
                void sync({
                  scope: "account",
                  value: confirm.value,
                  expectedRevision: confirm.snapshot.account.revision,
                  followingSpaceIds: confirm.snapshot.followingSpaces.map(({ id }) => id),
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
