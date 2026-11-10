import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { formatFileSize } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";

export function WorkspaceSaveStatus({
  computer,
  onViewFiles,
}: {
  computer: ComputerStatus | null;
  onViewFiles?: () => void;
}) {
  const { t } = useLingui();
  const progress = computer?.state === "stopping" ? computer.workspaceSaveProgress : undefined;
  const failure = computer?.state === "running" ? computer.workspaceSaveFailure : undefined;
  if (progress !== undefined) {
    const files = progress?.files ?? 0;
    const size = progress ? formatFileSize(progress.bytes) : "";
    return (
      <div>
        <p>
          <Trans>Saving workspace…</Trans>
        </p>
        {progress ? (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="workspace-save-progress">
            <Trans>
              {files} files processed · {size}
            </Trans>
          </p>
        ) : null}
      </div>
    );
  }
  if (!failure) return null;
  const reason = {
    disk_space: t`Not enough disk space to save the workspace.`,
    too_large: t`The computer's files are too large to save.`,
    too_many_files: t`The computer has too many files to save.`,
    rate_limited: t`The computer provider is limiting save requests.`,
    export_failed: t`The computer could not export its files.`,
    storage_failed: t`The workspace could not be stored.`,
  }[failure];
  return (
    <div
      className="mt-3 rounded-md border border-warning/30 bg-warning/10 p-2 text-sm"
      data-testid="workspace-save-failure"
    >
      <p className="font-medium text-foreground">
        <Trans>Computer still running. Workspace not saved.</Trans>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{reason}</p>
      {onViewFiles ? (
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onViewFiles}>
          <Trans>View files</Trans>
        </Button>
      ) : null}
    </div>
  );
}
