import { Trans, useLingui } from "@lingui/react/macro";
import { usePreferenceSettings } from "@rakazo/chat-ui/read-aloud";
import type {
  ThinkingDefaults,
  ThinkingLevel,
  UpdateThinkingDefaultsInput,
} from "@rakazo/contracts";
import { ThinkingLevelSchema } from "@rakazo/contracts";
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
} from "@rakazo/ui-web";
import { useEffect, useId, useMemo, useState } from "react";
import { newClientId } from "../lib/client-id";
import { thinkingLevelLabel } from "../lib/model-catalog";
import { useSpaceRpc, useSpaceRpcCurrent } from "../lib/space-rpc";

export function ThinkingDefaultSettings({
  busy,
  begin,
  finish,
  onRead,
}: {
  busy: boolean;
  begin: () => number | null;
  finish: (owner: number) => void;
  onRead: (settings: ThinkingDefaults | null) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const rpc = useSpaceRpc();
  const isCurrent = useSpaceRpcCurrent();
  const transport = useMemo(
    () => ({
      read: (signal: AbortSignal) => rpc.models.thinkingDefaults({}, { signal }),
      write: (input: UpdateThinkingDefaultsInput, signal: AbortSignal) =>
        rpc.models.updateThinkingDefaults(input, { signal }),
      isCurrent,
    }),
    [rpc, isCurrent],
  );
  const { settings, pending, problem, load, save } = usePreferenceSettings(transport);
  useEffect(() => onRead(settings), [settings, onRead]);
  const [intent, setIntent] = useState<{
    value: ThinkingLevel | null;
    snapshot: ThinkingDefaults;
    transport: typeof transport;
  } | null>(null);
  const confirm = intent?.transport === transport ? intent : null;
  const model = settings?.binding?.model;
  const account = settings?.account.value;
  const effective = settings?.effective;
  const allLevels: ThinkingLevel[] = settings?.levels.filter((level) => level !== "off") ?? [];
  const accountMatches =
    account?.model.provider === model?.provider && account?.model.modelId === model?.modelId;
  const source =
    effective?.source === "space"
      ? t`This Space`
      : effective?.source === "account"
        ? t`My default`
        : t`Model default`;
  const label = (level: ThinkingLevel | null | undefined) =>
    level ? thinkingLevelLabel(level) : t`Model default`;
  const describeChoice = (level: ThinkingLevel | null | undefined, modelId?: string) =>
    level && modelId ? `${label(level)} · ${modelId}` : label(level);
  const disabled = busy || pending;

  async function persist(input: UpdateThinkingDefaultsInput) {
    if (!isCurrent()) return;
    const owner = begin();
    if (owner === null) return;
    try {
      await save(input);
    } finally {
      finish(owner);
    }
  }

  if (!problem && !account && allLevels.length === 0) return null;
  return (
    <section aria-label={t`Thinking defaults`} className="mt-3 space-y-2">
      {problem ? (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          {problem === "conflict"
            ? t`Settings changed elsewhere.`
            : problem === "unavailable"
              ? t`Thinking level is unavailable for this model.`
              : problem === "load"
                ? t`Could not load thinking defaults`
                : t`Could not save thinking defaults`}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => void load()}
          >
            <Trans>Reload</Trans>
          </Button>
        </div>
      ) : null}
      {settings ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <label htmlFor={`${id}-account`} className="flex items-center gap-2">
            <Trans>My default thinking</Trans>
            <NativeSelect
              id={`${id}-account`}
              value={
                account
                  ? accountMatches && allLevels.includes(account.level)
                    ? account.level
                    : "saved"
                  : ""
              }
              disabled={disabled}
              onChange={(event) => {
                const level = ThinkingLevelSchema.safeParse(event.target.value);
                if (level.success || !event.target.value)
                  setIntent({ value: level.data ?? null, snapshot: settings, transport });
              }}
            >
              <NativeSelectOption value="">{t`Model default`}</NativeSelectOption>
              {account && (!accountMatches || !allLevels.includes(account.level)) ? (
                <NativeSelectOption value="saved" disabled>
                  {label(account.level)} · {account.model.modelId}
                </NativeSelectOption>
              ) : null}
              {allLevels.map((level) => (
                <NativeSelectOption key={level} value={level}>
                  {label(level)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          {allLevels.length > 0 ? (
            <label htmlFor={`${id}-space`} className="flex items-center gap-2">
              <Trans>Thinking in this Space</Trans>
              <NativeSelect
                id={`${id}-space`}
                value={
                  settings.followsAccount
                    ? "inherit"
                    : effective?.level === "off"
                      ? "off"
                      : effective?.level && allLevels.includes(effective.level)
                        ? effective.level
                        : "modelDefault"
                }
                disabled={disabled}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    value !== "inherit" &&
                    value !== "copy" &&
                    value !== "modelDefault" &&
                    !ThinkingLevelSchema.safeParse(value).success
                  )
                    return;
                  void persist({
                    scope: "space",
                    value: value as Extract<
                      UpdateThinkingDefaultsInput,
                      { scope: "space" }
                    >["value"],
                    binding: settings.binding,
                    expectedRevision: settings.space.revision,
                    expectedAccountRevision: settings.account.revision,
                    expectedLevel: settings.effective.level,
                    clientNonce: newClientId(),
                  });
                }}
              >
                <NativeSelectOption value="inherit">{t`Follow my default`}</NativeSelectOption>
                {settings.followsAccount ? (
                  <NativeSelectOption value="copy">{t`Keep the current level in this Space`}</NativeSelectOption>
                ) : null}
                {!settings.followsAccount && effective?.level === "off" ? (
                  <NativeSelectOption value="off" disabled>
                    {label("off")}
                  </NativeSelectOption>
                ) : null}
                <NativeSelectOption value="modelDefault">{t`Model default`}</NativeSelectOption>
                {allLevels.map((level) => (
                  <NativeSelectOption key={level} value={level}>
                    {label(level)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          ) : null}
          <span className="text-muted-foreground">
            {effective?.unsupported ? t`Thinking level is unavailable for this model.` : source}
          </span>
        </div>
      ) : null}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setIntent(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Change my default thinking?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm ? (
                <strong>
                  {describeChoice(
                    confirm.snapshot.account.value?.level,
                    confirm.snapshot.account.value?.model.modelId,
                  )}
                  {" → "}
                  {describeChoice(confirm.value, confirm.snapshot.binding?.model.modelId)}.{" "}
                </strong>
              ) : null}
              <Trans>
                New runs use this level on supported, matching models. These Spaces may be affected.
              </Trans>{" "}
              {confirm?.snapshot.followingSpaces.map(({ name }) => name).join(", ")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={disabled}
              onClick={() => {
                if (!confirm) return;
                setIntent(null);
                void persist({
                  scope: "account",
                  level: confirm.value,
                  binding: confirm.snapshot.binding,
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
