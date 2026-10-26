import { Trans } from "@lingui/react/macro";
import type { OpenApiImportReviewState } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { openApiDiagnosticText } from "../../lib/openapi-diagnostic";

export function OpenApiImportReview({
  state,
  onConfirm,
  onCheck,
  onPreview,
}: {
  state: OpenApiImportReviewState;
  onConfirm(): void;
  onCheck(): void;
  onPreview(): void;
}) {
  const preview = state.preview;
  const result = state.confirmation;
  const diagnostics =
    result && result.status !== "installed" ? result.diagnostics : (preview?.diagnostics ?? []);
  const busy = state.phase === "confirming" || state.phase === "previewing";
  return (
    <div data-testid="openapi-import-review" className="space-y-3">
      {preview?.target ? <p className="break-words text-sm">{preview.target}</p> : null}
      <div className="max-h-72 space-y-3 overflow-y-auto break-words text-sm">
        {preview ? (
          <>
            <p className="font-medium">
              <Trans>Ready</Trans> · {preview.counts.accepted}
            </p>
            {preview.operations.map((operation) => (
              <div key={operation.id}>
                <p>{operation.id}</p>
                <p className="text-muted-foreground">
                  {operation.method} {operation.path}
                </p>
              </div>
            ))}
            {preview.counts.rejected > 0 ? (
              <p className="font-medium">
                <Trans>Not imported</Trans> · {preview.counts.rejected}
              </p>
            ) : null}
          </>
        ) : null}
        {diagnostics.map((diagnostic, index) => (
          <div key={`${diagnostic.code}:${index}`}>
            {diagnostic.operationId ? <p>{diagnostic.operationId}</p> : null}
            {diagnostic.path ? (
              <p className="text-muted-foreground">
                {diagnostic.method} {diagnostic.path}
              </p>
            ) : null}
            <p className="text-muted-foreground">{openApiDiagnosticText(diagnostic.code)}</p>
            {diagnostic.pointer ? (
              <p className="text-xs text-muted-foreground">{diagnostic.pointer}</p>
            ) : null}
          </div>
        ))}
      </div>
      {preview && preview.counts.omittedDiagnostics > 0 ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Additional diagnostics omitted: {preview.counts.omittedDiagnostics}</Trans>
        </p>
      ) : null}
      {state.phase === "unknown" ? (
        <p role="status" className="text-sm">
          <Trans>Could not confirm installation.</Trans>
        </p>
      ) : null}
      {state.phase === "pending" ? (
        <p role="status" className="text-sm">
          <Trans>Installation pending.</Trans>
        </p>
      ) : null}
      {state.phase === "review" && state.error ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not preview OpenAPI.</Trans>
        </p>
      ) : null}
      {state.phase === "terminal" && result?.status !== "installed" ? (
        <p role="status" className="text-sm">
          {result?.status === "removed" ? (
            <Trans>This installation was removed.</Trans>
          ) : (
            <Trans>Preview again before adding.</Trans>
          )}
        </p>
      ) : null}
      {busy ? (
        <Button size="sm" disabled>
          {state.phase === "previewing" ? <Trans>Previewing…</Trans> : <Trans>Adding…</Trans>}
        </Button>
      ) : null}
      {state.phase === "review" && preview?.status === "ready" ? (
        <Button size="sm" onClick={onConfirm}>
          <Trans>Add</Trans>
        </Button>
      ) : null}
      {state.phase === "unknown" || state.phase === "pending" ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={onCheck}>
            <Trans>Check status</Trans>
          </Button>
          <Button size="sm" variant="secondary" onClick={onConfirm}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {(state.phase === "review" && preview?.status !== "ready") ||
      (state.phase === "terminal" && result?.status !== "installed") ? (
        <Button size="sm" variant="secondary" onClick={onPreview}>
          <Trans>Preview again</Trans>
        </Button>
      ) : null}
    </div>
  );
}
