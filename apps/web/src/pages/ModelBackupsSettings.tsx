import { Trans, useLingui } from "@lingui/react/macro";
import type { Me, ModelBackupChoice, ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import {
  backupChoiceKey,
  connectedBackupOptions,
  MAX_MODEL_BACKUPS,
  moveBackupChoice,
  sameBackupChoices,
} from "@rakazo/contracts";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useMemo, useRef, useState } from "react";
import { currentSpaceSelectionGeneration, rpc, selectedSpaceId } from "../lib/rpc";

type Scope = { userId: string; spaceId: string };
export type ModelConnectionSave = Scope & {
  credential: ModelCredential;
  spaceGeneration: number;
};
type BackupsState = {
  scopeKey: string;
  loading: boolean;
  ready: boolean;
  saving: boolean;
  saved: ModelBackupChoice[];
  draft: ModelBackupChoice[];
  selectedKey: string;
  selectedChoice: ModelBackupChoice | null;
  error: string | null;
  notice: string | null;
};
type AcknowledgedRevisions = {
  scopeKey: string;
  spaceGeneration: number;
  revisions: Map<string, number>;
};

function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.userId, scope.spaceId]);
}

function isSelectedSpace(spaceId: string): boolean {
  const selected = selectedSpaceId();
  return selected === null || selected === spaceId;
}

function acknowledgedBackupChoice(
  choice: ModelBackupChoice,
  owner: AcknowledgedRevisions,
  activeScopeKey: string,
): ModelBackupChoice {
  if (
    owner.scopeKey !== activeScopeKey ||
    owner.spaceGeneration !== currentSpaceSelectionGeneration()
  )
    return choice;
  const revision = owner.revisions.get(backupChoiceKey(choice));
  return revision === undefined || revision <= (choice.expectedRevision ?? 0)
    ? choice
    : { ...choice, expectedRevision: revision };
}

export function ModelBackupsSettings({
  userId,
  spaceId,
  catalog,
  credentials,
  connectionSave,
}: Scope & {
  catalog: ModelCatalogEntry[];
  credentials: ModelCredential[];
  connectionSave?: ModelConnectionSave | null;
}) {
  const { t } = useLingui();
  const activeScopeKey = scopeKey({ userId, spaceId });
  const activeScopeRef = useRef(activeScopeKey);
  activeScopeRef.current = activeScopeKey;
  const requestGenerationRef = useRef(0);
  const appliedConnectionSaveRef = useRef(connectionSave);
  const spaceGeneration = currentSpaceSelectionGeneration();
  // A successful save acknowledges its new revision. Background metadata alone
  // must retain the revision captured by a pending backup draft.
  const acknowledgedRevisionsRef = useRef({
    scopeKey: activeScopeKey,
    spaceGeneration,
    revisions: new Map<string, number>(),
  });
  if (
    acknowledgedRevisionsRef.current.scopeKey !== activeScopeKey ||
    acknowledgedRevisionsRef.current.spaceGeneration !== spaceGeneration
  ) {
    acknowledgedRevisionsRef.current = {
      scopeKey: activeScopeKey,
      spaceGeneration,
      revisions: new Map(),
    };
  }
  const [reloadNonce, setReloadNonce] = useState(0);
  const [state, setState] = useState<BackupsState>({
    scopeKey: activeScopeKey,
    loading: true,
    ready: false,
    saving: false,
    saved: [],
    draft: [],
    selectedKey: "",
    selectedChoice: null,
    error: null,
    notice: null,
  });
  const options = useMemo(
    () => connectedBackupOptions(catalog, credentials),
    [catalog, credentials],
  );
  const optionByKey = useMemo(
    () => new Map(options.map((option) => [backupChoiceKey(option), option])),
    [options],
  );
  const currentState = state.scopeKey === activeScopeKey ? state : null;
  const selectedSpaceMatches = isSelectedSpace(spaceId);
  const dirty = currentState ? !sameBackupChoices(currentState.saved, currentState.draft) : false;
  const draftKeys = new Set(currentState?.draft.map(backupChoiceKey) ?? []);
  const addableOptions = options.filter((option) => !draftKeys.has(backupChoiceKey(option)));
  const addableKey = currentState?.selectedKey ?? "";
  const editable = Boolean(
    currentState?.ready && !currentState.loading && !currentState.saving && selectedSpaceMatches,
  );

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled &&
      generation === requestGenerationRef.current &&
      activeScopeRef.current === activeScopeKey &&
      isSelectedSpace(spaceId);
    setState({
      scopeKey: activeScopeKey,
      loading: true,
      ready: false,
      saving: false,
      saved: [],
      draft: [],
      selectedKey: "",
      selectedChoice: null,
      error: null,
      notice: null,
    });
    void (async () => {
      try {
        if (!isSelectedSpace(spaceId)) {
          throw new Error(t`Space changed. Reopen Models to load its backup list.`);
        }
        const currentMe = (await rpc.me({ context: { spaceId } })) as Me;
        if (currentMe.userId !== userId || currentMe.spaceId !== spaceId || !isCurrent()) {
          throw new Error(t`Space changed. Reopen Models to load its backup list.`);
        }
        const saved = await rpc.models.backups({}, { context: { spaceId } });
        if (!isCurrent()) return;
        const snapshot = saved.map((choice) => {
          const revision = choice.modelCredentialId
            ? optionByKey.get(backupChoiceKey(choice))?.expectedRevision
            : undefined;
          return acknowledgedBackupChoice(
            revision === undefined ? { ...choice } : { ...choice, expectedRevision: revision },
            acknowledgedRevisionsRef.current,
            activeScopeKey,
          );
        });
        setState({
          scopeKey: activeScopeKey,
          loading: false,
          ready: true,
          saving: false,
          saved: snapshot,
          draft: snapshot,
          selectedKey: "",
          selectedChoice: null,
          error: null,
          notice: null,
        });
      } catch (error) {
        if (!isCurrent()) return;
        setState((previous) =>
          previous.scopeKey === activeScopeKey
            ? {
                ...previous,
                loading: false,
                ready: false,
                error: error instanceof Error ? error.message : t`Could not load backup models`,
              }
            : previous,
        );
      }
    })();
    return () => {
      cancelled = true;
      if (requestGenerationRef.current === generation) requestGenerationRef.current += 1;
    };
  }, [activeScopeKey, reloadNonce, spaceId, t, userId]);

  useEffect(() => {
    if (!connectionSave || connectionSave === appliedConnectionSaveRef.current) return;
    appliedConnectionSaveRef.current = connectionSave;
    if (
      connectionSave.userId !== userId ||
      connectionSave.spaceId !== spaceId ||
      connectionSave.spaceGeneration !== currentSpaceSelectionGeneration() ||
      activeScopeRef.current !== activeScopeKey ||
      !isSelectedSpace(spaceId)
    )
      return;
    const owner = acknowledgedRevisionsRef.current;
    for (const option of connectedBackupOptions(catalog, [connectionSave.credential])) {
      if (option.expectedRevision !== undefined)
        owner.revisions.set(backupChoiceKey(option), option.expectedRevision);
    }
    setState((previous) =>
      previous.scopeKey === activeScopeKey
        ? {
            ...previous,
            saved: previous.saved.map((choice) =>
              acknowledgedBackupChoice(choice, owner, activeScopeKey),
            ),
            draft: previous.draft.map((choice) =>
              acknowledgedBackupChoice(choice, owner, activeScopeKey),
            ),
            selectedChoice: previous.selectedChoice
              ? acknowledgedBackupChoice(previous.selectedChoice, owner, activeScopeKey)
              : null,
          }
        : previous,
    );
  }, [activeScopeKey, catalog, connectionSave, spaceGeneration, spaceId, userId]);

  function updateDraft(next: (draft: ModelBackupChoice[]) => ModelBackupChoice[]) {
    if (!editable) return;
    setState((previous) =>
      previous.scopeKey === activeScopeKey
        ? { ...previous, draft: next(previous.draft), error: null, notice: null }
        : previous,
    );
  }

  function addSelected() {
    if (!currentState || !editable || currentState.draft.length >= MAX_MODEL_BACKUPS) return;
    const option = currentState.selectedChoice;
    if (
      !option ||
      currentState.draft.some((choice) => backupChoiceKey(choice) === backupChoiceKey(option))
    ) {
      return;
    }
    setState((previous) =>
      previous.scopeKey === activeScopeKey
        ? {
            ...previous,
            draft: [
              ...previous.draft,
              {
                provider: option.provider,
                modelId: option.modelId,
                modelCredentialId: option.modelCredentialId,
                expectedRevision: option.expectedRevision,
              },
            ],
            selectedKey: "",
            selectedChoice: null,
            error: null,
            notice: null,
          }
        : previous,
    );
  }

  async function save() {
    if (
      !currentState?.ready ||
      currentState.loading ||
      currentState.saving ||
      !dirty ||
      !isSelectedSpace(spaceId)
    ) {
      return;
    }
    const generation = requestGenerationRef.current;
    const choices = currentState.draft.map((choice) => ({ ...choice }));
    const isCurrent = () =>
      generation === requestGenerationRef.current &&
      activeScopeRef.current === activeScopeKey &&
      isSelectedSpace(spaceId);
    setState((previous) =>
      previous.scopeKey === activeScopeKey
        ? { ...previous, saving: true, error: null, notice: null }
        : previous,
    );
    try {
      const currentMe = (await rpc.me({ context: { spaceId } })) as Me;
      if (currentMe.userId !== userId || currentMe.spaceId !== spaceId || !isCurrent()) {
        throw new Error(t`Space changed. Reopen Models to save its backup list.`);
      }
      await rpc.models.setBackups(choices, { context: { spaceId } });
      if (!isCurrent()) return;
      setState((previous) =>
        previous.scopeKey === activeScopeKey
          ? {
              ...previous,
              saving: false,
              saved: choices.map((choice) =>
                acknowledgedBackupChoice(choice, acknowledgedRevisionsRef.current, activeScopeKey),
              ),
              error: null,
              notice: t`Backup models saved.`,
            }
          : previous,
      );
    } catch (error) {
      if (!isCurrent()) return;
      setState((previous) =>
        previous.scopeKey === activeScopeKey
          ? {
              ...previous,
              saving: false,
              error: error instanceof Error ? error.message : t`Could not save backup models`,
              notice: null,
            }
          : previous,
      );
    } finally {
      if (isCurrent()) {
        setState((previous) =>
          previous.scopeKey === activeScopeKey ? { ...previous, saving: false } : previous,
        );
      }
    }
  }

  const rowLabels = (choice: ModelBackupChoice) => {
    const option = optionByKey.get(backupChoiceKey(choice));
    const entry = catalog.find(
      (candidate) => candidate.provider === choice.provider && candidate.id === choice.modelId,
    );
    const providerName = option?.providerName ?? entry?.providerName ?? choice.provider;
    const label = option?.label ?? entry?.label ?? choice.modelId;
    return { full: `${providerName} · ${label}`, available: Boolean(option) };
  };

  return (
    <section
      data-testid="model-backups"
      aria-labelledby="model-backups-title"
      className="mt-8 border-t border-border pt-5"
    >
      <h3 id="model-backups-title" className="text-[15px] font-medium text-foreground">
        <Trans>Backup models</Trans>
      </h3>
      {!currentState || currentState.loading ? (
        <p className="mt-2 text-[13px] text-muted-foreground" role="status">
          <Trans>Loading…</Trans>
        </p>
      ) : (
        <>
          {currentState.draft.length === 0 ? (
            <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
              {addableOptions.length === 0 ? (
                <Trans>Connect a provider to add backups.</Trans>
              ) : (
                <Trans>Add connected models to use them as backups.</Trans>
              )}
            </p>
          ) : (
            <ol
              aria-label={t`Backup models order`}
              className="mt-3 divide-y divide-border rounded-xl border border-border"
            >
              {currentState.draft.map((choice, index) => {
                const { full, available } = rowLabels(choice);
                return (
                  <li
                    key={backupChoiceKey(choice)}
                    className="flex items-center gap-3 px-3 py-2.5"
                    data-testid={`model-backup-${index + 1}`}
                  >
                    <span className="w-5 shrink-0 text-center text-[12px] tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">{full}</span>
                      {!available ? (
                        <span className="block text-[12px] text-muted-foreground">
                          <Trans>Not connected</Trans>
                        </span>
                      ) : null}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t`Move ${full} up`}
                        disabled={index === 0 || !editable}
                        onClick={() => updateDraft((draft) => moveBackupChoice(draft, index, -1))}
                      >
                        <span aria-hidden="true">↑</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t`Move ${full} down`}
                        disabled={index === currentState.draft.length - 1 || !editable}
                        onClick={() => updateDraft((draft) => moveBackupChoice(draft, index, 1))}
                      >
                        <span aria-hidden="true">↓</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t`Remove ${full}`}
                        disabled={!editable}
                        onClick={() =>
                          updateDraft((draft) =>
                            draft.filter((_, itemIndex) => itemIndex !== index),
                          )
                        }
                      >
                        <Trans>Remove</Trans>
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {currentState.draft.length >= MAX_MODEL_BACKUPS ? (
            <p className="mt-2 text-[12px] text-muted-foreground">
              <Trans>Maximum of 10 backup models.</Trans>
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 text-[13px] text-muted-foreground">
              <label htmlFor="model-backup-picker">
                <Trans>Add connected model</Trans>
              </label>
              <NativeSelect
                id="model-backup-picker"
                aria-label={t`Add connected model`}
                className="mt-1.5 w-full text-foreground"
                value={addableKey}
                disabled={
                  !editable ||
                  currentState.draft.length >= MAX_MODEL_BACKUPS ||
                  addableOptions.length === 0
                }
                onChange={(event) => {
                  if (!editable) return;
                  setState((previous) =>
                    previous.scopeKey === activeScopeKey
                      ? {
                          ...previous,
                          selectedKey: event.target.value,
                          selectedChoice: optionByKey.get(event.target.value) ?? null,
                          error: null,
                          notice: null,
                        }
                      : previous,
                  );
                }}
              >
                <NativeSelectOption value="">
                  <Trans>Select a connected model</Trans>
                </NativeSelectOption>
                {addableOptions.map((option) => (
                  <NativeSelectOption key={backupChoiceKey(option)} value={backupChoiceKey(option)}>
                    {option.providerName} · {option.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={
                !editable ||
                currentState.draft.length >= MAX_MODEL_BACKUPS ||
                !addableKey ||
                !addableOptions.some((option) => backupChoiceKey(option) === addableKey)
              }
              onClick={addSelected}
            >
              <Trans>Add</Trans>
            </Button>
            <Button type="button" disabled={!editable || !dirty} onClick={() => void save()}>
              {currentState.saving ? <Trans>Saving…</Trans> : <Trans>Save backups</Trans>}
            </Button>
          </div>
          {currentState.error ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-sm text-destructive" role="alert">
                {currentState.error}
              </p>
              {!currentState.ready && !currentState.loading ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!selectedSpaceMatches}
                  onClick={() => setReloadNonce((value) => value + 1)}
                >
                  <Trans>Retry</Trans>
                </Button>
              ) : null}
            </div>
          ) : null}
          {currentState.notice ? (
            <p className="mt-2 text-sm text-success" role="status">
              {currentState.notice}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
