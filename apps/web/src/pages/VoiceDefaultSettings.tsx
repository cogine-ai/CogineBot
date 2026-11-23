import { Trans, useLingui } from "@lingui/react/macro";
import { usePreferenceSettings } from "@rakazo/chat-ui/read-aloud";
import type {
  UpdateVoiceDefaultsInput,
  VoiceChoice,
  VoiceDefaults,
  VoiceInfo,
} from "@rakazo/contracts";
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

export function VoiceDefaultSettings({
  catalog,
  busy,
  onChange,
  beginWrite,
  endWrite,
}: {
  catalog: { provider: string; voices: VoiceInfo[] } | null;
  busy: boolean;
  onChange: () => Promise<unknown>;
  beginWrite: () => boolean;
  endWrite: () => void;
}) {
  const rpc = useSpaceRpc();
  const isCurrent = useSpaceRpcCurrent();
  const { t } = useLingui();
  const id = useId();
  const transport = useMemo(
    () => ({
      read: (signal: AbortSignal) => rpc.voice.defaults({}, { signal }),
      write: (input: UpdateVoiceDefaultsInput, signal: AbortSignal) =>
        rpc.voice.updateDefaults(input, { signal }),
      isCurrent,
    }),
    [rpc, isCurrent],
  );
  const { settings, pending, problem, save, load } = usePreferenceSettings(transport);
  const [intent, setIntent] = useState<{
    value: VoiceChoice | null;
    snapshot: VoiceDefaults;
    transport: typeof transport;
  } | null>(null);
  const confirm = intent?.transport === transport ? intent : null;
  const choices = settings?.provider === catalog?.provider ? (catalog?.voices ?? []) : [];
  const accountChoice = settings?.account.value;
  const canSelect =
    accountChoice &&
    accountChoice.provider === catalog?.provider &&
    choices.some(({ id }) => id === accountChoice.voiceId);
  const effective = settings?.effective;
  const unavailable =
    effective?.source === "account" &&
    (!effective.choice ||
      (catalog?.provider === effective.choice.provider &&
        !choices.some(({ id }) => id === effective.choice?.voiceId)));
  const source =
    effective?.source === "space"
      ? t`This Space`
      : effective?.source === "account"
        ? t`My default`
        : t`System default`;
  const label = (choice: VoiceChoice | null) => {
    if (!choice) return t`System default`;
    return choice.provider === catalog?.provider
      ? (choices.find(({ id }) => id === choice.voiceId)?.label ?? choice.voiceId)
      : choice.voiceId;
  };
  async function sync(input?: UpdateVoiceDefaultsInput) {
    if (!beginWrite()) return;
    try {
      if (input) {
        if (!(await save(input))) return;
      } else {
        await load();
      }
      await onChange();
    } finally {
      endWrite();
    }
  }
  return (
    <section aria-label={t`Voice defaults`} className="space-y-3 border-b border-border pb-5">
      {problem ? (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          {problem === "conflict"
            ? t`Settings changed elsewhere.`
            : problem === "unavailable"
              ? t`Choose a voice available in this Space.`
              : problem === "load"
                ? t`Could not load voice settings`
                : t`Could not save that voice`}
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
        <>
          <label
            htmlFor={`${id}-account`}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <Trans>My default voice</Trans>
            <NativeSelect
              id={`${id}-account`}
              value={accountChoice ? (canSelect ? `voice:${accountChoice.voiceId}` : "saved") : ""}
              disabled={pending || busy || (!accountChoice && choices.length === 0)}
              onChange={(event) => {
                const option = choices.find(({ id }) => `voice:${id}` === event.target.value);
                if (option && catalog)
                  setIntent({
                    value: { provider: catalog.provider, voiceId: option.id },
                    snapshot: settings,
                    transport,
                  });
                else if (event.target.value === "")
                  setIntent({ value: null, snapshot: settings, transport });
              }}
            >
              <NativeSelectOption value="">{t`System default`}</NativeSelectOption>
              {accountChoice && !canSelect ? (
                <NativeSelectOption disabled value="saved">
                  {label(accountChoice)}
                </NativeSelectOption>
              ) : null}
              {choices.map(({ id, label }) => (
                <NativeSelectOption key={id} value={`voice:${id}`}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label
            htmlFor={`${id}-space`}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <Trans>Override voice in this Space</Trans>
            <Switch
              id={`${id}-space`}
              checked={settings.space.value}
              disabled={
                busy || pending || (!settings.space.value && (!effective?.choice || unavailable))
              }
              onCheckedChange={(enabled) =>
                void sync({
                  scope: "space",
                  enabled,
                  expectedRevision: settings.space.revision,
                  expectedAccountRevision: settings.account.revision,
                  expectedProvider: settings.provider,
                  clientNonce: newClientId(),
                })
              }
            />
          </label>
          <div className="flex justify-between gap-2 text-sm">
            <span className="text-muted-foreground">{source}</span>
            <span>
              {unavailable
                ? t`Choose a voice available in this Space.`
                : effective?.choice
                  ? label(effective.choice)
                  : t`Unavailable`}
            </span>
          </div>
        </>
      ) : null}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setIntent(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Change my default voice?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm ? (
                <strong>
                  {label(confirm.snapshot.account.value)} → {label(confirm.value)}.{" "}
                </strong>
              ) : null}
              <Trans>
                Applies to new playback in following Spaces where the voice is available.
              </Trans>{" "}
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
