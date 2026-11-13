import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentBackupMcpOmission, AgentBackupOmissionReason } from "@rakazo/contracts";
import { BOT_NAME_MAX_LENGTH, BOT_PACKAGE_MAX_BYTES } from "@rakazo/contracts";
import type { BotPackageImportState } from "@rakazo/core";
import {
  BackupModelKeyUnavailable,
  backupModelKeySourceDigest,
  createBotPackageImport,
} from "@rakazo/core";
import {
  agentBackupFileGroups,
  agentBackupSelectableGroups,
  isBackupModelKeyProvider,
} from "@rakazo/core/agent-backup";
import { Button, Checkbox, Input, Switch, Textarea } from "@rakazo/ui-web";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  readBotBackupFolder,
  readBotPackageFile,
  readBotPackageModelKey,
  supportsBotBackupFolder,
} from "../lib/bot-package-file";
import { newClientId } from "../lib/client-id";
import { createSpaceRpc } from "../lib/rpc";
import { BotPackageDocumentView, BotPackageLeftOutList } from "./BotPackageDocumentView";
import { BotPackageSkills } from "./BotPackageTools";

export function BotPackageImport({
  spaceId,
  isCurrent,
  onImported,
  onOpen,
  onConnections,
  onCancel,
}: {
  spaceId: string;
  isCurrent(): boolean;
  onImported(): void;
  onOpen(botId: string): void;
  onConnections(): void;
  onCancel(): void;
}) {
  const { t } = useLingui();
  const backupOmissionLabels: Record<AgentBackupOmissionReason, string> = {
    invalidSkill: t`This Skill is missing valid metadata.`,
    missingSkillFiles: t`This Skill needs additional files.`,
    skillRequirements: t`This Skill declares requirements that need review.`,
    skillLimit: t`This Skill exceeds the Bot limits.`,
    stock: t`The original template was omitted.`,
    instructionLimit: t`This instruction file exceeds the Bot limit.`,
    memoryLimit: t`This note exceeds the Bot memory limits.`,
    identity: t`This identity file has no supported fields.`,
    routineSchedule: t`This schedule needs manual setup.`,
    routineOwner: t`The schedule owner could not be confirmed.`,
  };
  const mcpOmissionLabels: Record<AgentBackupMcpOmission["reason"], string> = {
    setup: t`This connection needs manual setup.`,
    toolPolicy: t`This connection's tool restrictions cannot be carried over.`,
    disabled: t`This connection is disabled in the backup.`,
    endpoint: t`This connection needs a public HTTPS MCP address with a supported path.`,
    limit: t`Additional connections exceed the import limit.`,
  };
  const ids = useId();
  const [state, setState] = useState<BotPackageImportState | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const manager = useRef<ReturnType<typeof createBotPackageImport> | null>(null);
  const current = useRef<() => boolean>(() => false);
  const fileGeneration = useRef(0);
  const localSource = useRef<{ file: File | readonly File[]; projection: string } | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const canPickFolder = supportsBotBackupFolder();
  const imported = useRef<string | null>(null);
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;
  useLayoutEffect(() => {
    let active = true;
    const valid = () => active && isCurrent();
    setReading(false);
    setFileError(null);
    current.current = valid;
    const client = createSpaceRpc(spaceId, valid);
    const review = createBotPackageImport({
      preview: (input, signal) => client.botPackages.preview(input, { signal }),
      import: (input, signal) => client.botPackages.import(input, { signal }),
      readModelKey: (model, sourceDigest, signal) => {
        const source = localSource.current;
        const version = fileGeneration.current;
        return source && backupModelKeySourceDigest(source.projection) === sourceDigest
          ? readBotPackageModelKey(
              source.file,
              model,
              () => valid() && !signal.aborted && version === fileGeneration.current,
            )
          : Promise.resolve(undefined);
      },
      status: (input, signal) => client.botPackages.status(input, { signal }),
      recent: (signal) => client.botPackages.recent(undefined, { signal }),
      resume: (input, signal) => client.botPackages.resume(input, { signal }),
      cancel: (input, signal) => client.botPackages.cancel(input, { signal }),
      newNonce: newClientId,
      isCurrent: valid,
      changed(next) {
        if (next.phase === "completed") localSource.current = null;
        setState(next);
      },
    });
    manager.current = review;
    return () => {
      active = false;
      localSource.current = null;
      fileGeneration.current++;
      review.dispose();
      manager.current = null;
    };
  }, [spaceId, isCurrent]);
  const receipt = state?.receipt;
  useEffect(() => {
    if (
      receipt?.status !== "completed" ||
      !current.current() ||
      imported.current === receipt.importId
    )
      return;
    imported.current = receipt.importId;
    onImportedRef.current();
  }, [receipt]);
  const phase = state?.phase ?? "editing";
  const busy = phase === "importing" || phase === "checking";
  const locked =
    busy || phase === "unknown" || receipt?.status === "importing" || receipt?.status === "failed";
  const preview = state?.preview;
  const reattachingKey = phase === "unknown" && Boolean(receipt?.modelKey ?? preview?.modelKey);
  const pickDisabled = reading || phase === "previewing" || (locked && !reattachingKey);
  const backupNotice = preview?.document.routines.length
    ? t`Imported routines start paused.`
    : preview?.model ||
        preview?.modelKey ||
        preview?.document.connections.length ||
        preview?.canImport === false
      ? null
      : t`This import includes supported text only.`;
  const fileGroups = useMemo(() => agentBackupFileGroups(state?.source ?? ""), [state?.source]);
  const backup = fileGroups !== null;
  const excluded = new Set(state?.excludedBackupPaths);
  const includedRoutines = new Set(state?.includedBackupRoutines);
  const selection = fileGroups
    ? agentBackupSelectableGroups(
        fileGroups,
        state?.includeMemory ?? false,
        excluded,
        includedRoutines,
        state?.includeBackupModel,
        new Set(state?.includedBackupConnections),
      )
    : null;
  function edit(input: {
    source?: string;
    name?: string;
    includeMemory?: boolean;
    includeBackupModel?: boolean;
    importModelKey?: boolean;
  }) {
    fileGeneration.current++;
    setReading(false);
    setFileError(null);
    if (input.source !== undefined) localSource.current = null;
    manager.current?.edit(input);
  }
  async function readSource(
    selected: File | readonly File[],
    read: (valid: () => boolean) => Promise<string>,
    errorMessage: string,
  ) {
    const version = ++fileGeneration.current;
    const valid = () => version === fileGeneration.current && current.current();
    setReading(true);
    setFileError(null);
    try {
      const source = await read(valid);
      if (valid()) {
        localSource.current = { file: selected, projection: source };
        if (!reattachingKey) manager.current?.edit({ source, includeMemory: false });
      }
    } catch {
      if (valid()) setFileError(errorMessage);
    } finally {
      if (valid()) setReading(false);
    }
  }
  return (
    <section className="space-y-4" data-testid="bot-package-import">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium">
          <Trans>Import bot</Trans>
        </h2>
        <Button variant="ghost" onClick={onCancel}>
          <Trans>Close</Trans>
        </Button>
      </div>
      {phase !== "completed" ? (
        <>
          {backup ? (
            <div className="flex items-center justify-between gap-3">
              <p role="status" className="text-sm">
                <Trans>Agent backup selected</Trans>
              </p>
              <Button
                variant="ghost"
                disabled={locked}
                onClick={() => edit({ source: "", includeMemory: false })}
              >
                <Trans>Use JSON instead</Trans>
              </Button>
            </div>
          ) : (
            <label htmlFor={`${ids}-source`} className="block text-sm">
              <Trans>Bot package or Grok JSON</Trans>
              <Textarea
                id={`${ids}-source`}
                aria-label={t`Bot package or Grok JSON`}
                value={state?.source ?? ""}
                maxLength={BOT_PACKAGE_MAX_BYTES}
                rows={7}
                disabled={locked}
                onChange={(event) => edit({ source: event.target.value })}
                className="mt-2 font-mono text-xs"
              />
            </label>
          )}
          <p className="text-sm text-muted-foreground">
            {reattachingKey
              ? t`Choose the backup again to resume importing the API key.`
              : t`OpenClaw or Hermes backup`}
          </p>
          <Input
            aria-label={t`Choose package file`}
            type="file"
            accept=".json,.txt,.zip,.tar.gz,.tgz,application/json,text/plain,application/zip,application/gzip"
            disabled={pickDisabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file)
                void readSource(
                  file,
                  (valid) => readBotPackageFile(file, valid),
                  t`Could not read this package. Use a JSON file or an agent backup up to 4 MiB.`,
                );
            }}
          />
          {canPickFolder ? (
            <>
              <input
                ref={(input) => {
                  folderInput.current = input;
                  input?.setAttribute("webkitdirectory", "");
                }}
                type="file"
                hidden
                disabled={pickDisabled}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  if (files.length)
                    void readSource(
                      files,
                      (valid) => readBotBackupFolder(files, valid),
                      t`Could not read this backup folder. Choose a supported agent folder or use a backup file.`,
                    );
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={pickDisabled}
                onClick={() => folderInput.current?.click()}
              >
                <Trans>Choose backup folder</Trans>
              </Button>
            </>
          ) : null}
          <label htmlFor={`${ids}-name`} className="block text-sm">
            <Trans>Name</Trans>
            <Input
              id={`${ids}-name`}
              aria-label={t`Imported bot name`}
              value={state?.name ?? ""}
              maxLength={BOT_NAME_MAX_LENGTH}
              placeholder={preview?.document.profile.name ?? ""}
              disabled={locked || reading}
              onChange={(event) => edit({ name: event.target.value })}
            />
          </label>
          <label
            htmlFor={`${ids}-memory`}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span>
              <Trans>Include memory</Trans>
              {preview ? (
                <span aria-hidden="true">{` · ${preview.availableMemoryCount}`}</span>
              ) : null}
            </span>
            <Switch
              id={`${ids}-memory`}
              checked={state?.includeMemory ?? false}
              disabled={locked || reading}
              onCheckedChange={(includeMemory) => edit({ includeMemory })}
            />
          </label>
          {fileGroups && selection ? (
            <details className="text-sm">
              <summary className="cursor-pointer">
                <Trans>Choose backup content</Trans>
              </summary>
              {selection.model ? (
                <label className="mt-3 flex items-start gap-2" htmlFor={`${ids}-backup-model`}>
                  <Checkbox
                    id={`${ids}-backup-model`}
                    checked={selection.model.selected}
                    disabled={locked || reading}
                    onCheckedChange={(checked) => edit({ includeBackupModel: checked === true })}
                  />
                  <span className="min-w-0 break-all" dir="auto">
                    <Trans>Model</Trans> · {selection.model.label}
                  </span>
                </label>
              ) : null}
              {selection.model?.selected &&
              fileGroups.modelProvider &&
              isBackupModelKeyProvider(fileGroups.modelProvider) &&
              localSource.current ? (
                <label className="mt-3 flex items-start gap-2" htmlFor={`${ids}-backup-model-key`}>
                  <Checkbox
                    id={`${ids}-backup-model-key`}
                    checked={state?.importModelKey ?? false}
                    disabled={locked || reading}
                    onCheckedChange={(checked) => edit({ importModelKey: checked === true })}
                  />
                  <Trans>Also import this model’s API key</Trans>
                </label>
              ) : null}
              {selection.groups.map(({ kind, items }) => (
                <fieldset key={kind} className="mt-3 space-y-2">
                  <legend className="font-medium">
                    {kind === "instructions"
                      ? t`Instructions`
                      : kind === "skills"
                        ? t`Skills`
                        : kind === "routines"
                          ? t`Routines`
                          : kind === "connections"
                            ? t`Connections`
                            : t`Memory`}
                  </legend>
                  {items.map(({ path, label, selected, atLimit }, index) => (
                    <label
                      key={path}
                      htmlFor={`${ids}-backup-${kind}-${index}`}
                      className="flex items-start gap-2"
                    >
                      <Checkbox
                        id={`${ids}-backup-${kind}-${index}`}
                        checked={selected}
                        disabled={locked || reading || atLimit}
                        onCheckedChange={(checked) =>
                          manager.current?.setBackupFileIncluded(path, checked)
                        }
                      />
                      <span className="min-w-0 break-all" dir="auto">
                        {label}
                      </span>
                    </label>
                  ))}
                </fieldset>
              ))}
              {fileGroups.unavailableConnections.length ? (
                <ul className="mt-3 space-y-1 text-muted-foreground">
                  {fileGroups.unavailableConnections.map(({ path, name, reason }) => (
                    <li key={path} className="break-words" dir="auto">
                      {name} · {mcpOmissionLabels[reason]}
                    </li>
                  ))}
                </ul>
              ) : null}
              {fileGroups.unavailable.length ? (
                <div className="mt-3 space-y-1">
                  <p className="font-medium">
                    <Trans>Unavailable backup files</Trans>
                  </p>
                  <ul className="space-y-1 text-muted-foreground">
                    {fileGroups.unavailable.map(({ path, reason }) => (
                      <li key={path} className="break-all" dir="auto">
                        <span>{path}</span>
                        <p className="break-words">
                          {reason
                            ? backupOmissionLabels[reason]
                            : t`This runtime file is not used.`}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </details>
          ) : null}
          <Button
            variant="outline"
            disabled={
              locked || reading || !state?.source.trim() || selection?.hasSelection === false
            }
            onClick={() => void manager.current?.preview()}
          >
            {phase === "previewing" ? <Trans>Previewing…</Trans> : <Trans>Preview</Trans>}
          </Button>
        </>
      ) : null}
      {fileError ? (
        <p role="alert" className="text-sm text-destructive">
          {fileError}
        </p>
      ) : null}
      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error instanceof BackupModelKeyUnavailable
            ? t`Could not read the API key. Choose the backup again.`
            : phase === "editing" || phase === "review"
              ? t`Could not preview this package.`
              : t`Could not confirm import. Check status before trying again.`}
        </p>
      ) : null}
      {preview && phase !== "completed" ? (
        <>
          <BotPackageDocumentView document={preview.document} />
          {preview.model ? (
            <p className="break-all text-sm" dir="auto">
              <Trans>Model</Trans> · {preview.model.provider}/{preview.model.modelId}
            </p>
          ) : null}
          {preview.modelKey ? (
            <p className="break-all text-sm" dir="auto">
              <Trans>Import API key</Trans> · {preview.modelKey.provider}/{preview.modelKey.modelId}
            </p>
          ) : null}
          <BotPackageLeftOutList items={preview.leftOut} />
          {backup && preview.document.connections.length ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Review tool access in the imported bot before using these connections.</Trans>
            </p>
          ) : null}
          {backup ? (
            backupNotice ? (
              <p className="text-sm text-muted-foreground">{backupNotice}</p>
            ) : null
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                <Trans>Skills stay off. Routines stay paused. Connections need setup.</Trans>
              </p>
              <p className="text-sm text-muted-foreground">
                <Trans>Models, credentials, files, and chat history are not imported.</Trans>
              </p>
            </>
          )}
          {phase === "review" && preview.canImport !== false ? (
            <Button disabled={reading} onClick={() => void manager.current?.confirm()}>
              <Trans>Import as new bot</Trans>
            </Button>
          ) : null}
        </>
      ) : null}
      {phase === "unknown" || receipt?.status === "importing" || receipt?.status === "failed" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || reading}
            onClick={() => void manager.current?.check()}
          >
            <Trans>Check status</Trans>
          </Button>
          {state?.canRetry && (receipt || preview) ? (
            <Button
              variant="outline"
              disabled={busy || reading || (reattachingKey && localSource.current === null)}
              onClick={() =>
                void (receipt ? manager.current?.resume() : manager.current?.confirm())
              }
            >
              <Trans>Resume import</Trans>
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={busy || reading}
            onClick={() => void manager.current?.cancel()}
          >
            <Trans>Cancel import</Trans>
          </Button>
        </div>
      ) : null}
      {receipt ? (
        <section className="space-y-3" data-testid="bot-package-receipt">
          <h3 className="font-medium" dir="auto">
            {receipt.botName}
          </h3>
          <p>
            {receipt.status === "completed"
              ? t`Bot imported`
              : receipt.status === "removed"
                ? t`This imported bot was removed.`
                : receipt.status === "cancelled"
                  ? t`Import cancelled.`
                  : t`Import needs attention.`}
          </p>
          <BotPackageLeftOutList items={receipt.leftOut} />
          {receipt.status === "completed" && receipt.botId ? (
            <>
              <BotPackageSkills botId={receipt.botId} spaceId={spaceId} isCurrent={isCurrent} />
              {receipt.connections.length ? (
                <div className="space-y-2">
                  {receipt.connections.map((connection) => (
                    <p key={connection.id} className="text-sm" dir="auto">
                      {connection.name}
                      {connection.setup === "mcp"
                        ? t` · Review tool access in the imported bot`
                        : connection.note
                          ? ` · ${connection.note}`
                          : ""}
                    </p>
                  ))}
                  {receipt.connections.some(({ setup }) => setup !== "mcp") ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (current.current()) onConnections();
                      }}
                    >
                      <Trans>Set up connections</Trans>
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <Button
                onClick={() => {
                  if (current.current() && receipt.botId) onOpen(receipt.botId);
                }}
              >
                <Trans>Open bot</Trans>
              </Button>
            </>
          ) : null}
          {phase === "completed" ? (
            <Button variant="outline" onClick={() => manager.current?.reset()}>
              <Trans>Import another bot</Trans>
            </Button>
          ) : null}
        </section>
      ) : null}
      <Button
        variant="ghost"
        disabled={locked}
        onClick={() => {
          setRecentOpen(!recentOpen);
          if (!recentOpen) void manager.current?.loadRecent();
        }}
      >
        <Trans>Recent imports</Trans>
      </Button>
      {recentOpen ? (
        <div className="space-y-2" data-testid="bot-package-recent">
          {state?.recentLoading ? (
            <p>
              <Trans>Loading…</Trans>
            </p>
          ) : null}
          {state?.recentError ? (
            <p role="alert">
              <Trans>Could not load recent imports.</Trans>
            </p>
          ) : null}
          {state?.recent.map((item) => (
            <div key={item.importId} className="flex items-center justify-between gap-3">
              <span dir="auto">{item.botName}</span>
              <Button
                variant="outline"
                disabled={locked || reading}
                onClick={() => {
                  if (state?.clientNonce !== item.clientNonce) {
                    fileGeneration.current++;
                    localSource.current = null;
                    setReading(false);
                    setFileError(null);
                  }
                  void manager.current?.recover(item.clientNonce);
                }}
              >
                <Trans>Review import</Trans>
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
