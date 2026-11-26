import { Trans, useLingui } from "@lingui/react/macro";
import { useComputerCleanup, useComputerStorage } from "@rakazo/chat-ui/computer-storage";
import type { ComputerDiskUsageResult } from "@rakazo/contracts";
import { formatFileSize } from "@rakazo/core";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@rakazo/ui-web";
import { HardDrive } from "lucide-react";
import { useId, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { rpc, rpcRecoveryScopeKey, subscribeRpcRecoveryScope } from "../../lib/rpc";

export function ComputerStorageButton({
  botId,
  expectedTarget,
}: {
  botId: string;
  expectedTarget?: string;
}) {
  const scope = useSyncExternalStore(subscribeRpcRecoveryScope, rpcRecoveryScopeKey);
  return (
    <StorageDialog
      key={JSON.stringify([scope, botId, expectedTarget])}
      scope={scope}
      botId={botId}
      expectedTarget={expectedTarget}
    />
  );
}

function StorageDialog({
  scope,
  botId,
  expectedTarget,
}: {
  scope: string;
  botId: string;
  expectedTarget?: string;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const dismiss = () => {
      if (document.visibilityState === "hidden") setOpen(false);
    };
    document.addEventListener("visibilitychange", dismiss);
    return () => document.removeEventListener("visibilitychange", dismiss);
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          expectedTarget ? (
            <Button size="sm" variant="outline">
              <Trans>Storage</Trans>
            </Button>
          ) : (
            <Button variant="ghost" size="icon-xs" aria-label={t`Storage`}>
              <HardDrive />
            </Button>
          )
        }
      />
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[80dvh] overflow-auto sm:max-w-md"
      >
        <DialogTitle>
          <Trans>Storage</Trans>
        </DialogTitle>
        {open ? (
          <StorageResult scope={scope} botId={botId} expectedTarget={expectedTarget} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function StorageResult({
  scope,
  botId,
  expectedTarget,
}: {
  scope: string;
  botId: string;
  expectedTarget?: string;
}) {
  const isCurrent = () => scope === rpcRecoveryScopeKey() && document.visibilityState !== "hidden";
  const { result, pending, failed, diagnose } = useComputerStorage(
    { botId, expectedTarget },
    (input, signal) => rpc.computer.diskUsage(input, { signal, context: { isCurrent } }),
    isCurrent,
  );
  const outcome = result?.outcome;
  const free =
    outcome?.status === "available" ? formatFileSize(outcome.data.volume.availableBytes) : "";
  const total =
    outcome?.status === "available" ? formatFileSize(outcome.data.volume.totalBytes) : "";
  return (
    <>
      <div role="status" className="text-muted-foreground">
        {pending ? <Trans>Diagnosing…</Trans> : null}
        {!pending &&
        (failed || outcome?.status === "timeout" || outcome?.status === "unavailable") ? (
          <Trans>Could not diagnose storage.</Trans>
        ) : null}
        {!pending && outcome?.status === "unsupported" ? (
          <Trans>Storage diagnostics are unavailable for this computer.</Trans>
        ) : null}
        {!pending && outcome?.status === "not_running" ? (
          <Trans>Computer is not running.</Trans>
        ) : null}
        {!pending && outcome?.status === "changed" ? (
          expectedTarget ? (
            <Trans>Computer changed. Open Storage from the Files toolbar.</Trans>
          ) : (
            <Trans>Computer changed. Open Storage again.</Trans>
          )
        ) : null}
        {!pending && outcome?.status === "available" ? (
          <>
            <p>
              <Trans>
                {free} available of {total}
              </Trans>
            </p>
            {outcome.data.volume.availableInodes === 0 ? (
              <p>
                <Trans>No free inodes.</Trans>
              </p>
            ) : null}
            {outcome.data.partial ? (
              <p>
                <Trans>Partial results</Trans>
              </p>
            ) : null}
          </>
        ) : null}
      </div>
      {!pending && result && outcome?.status === "available" ? (
        <StorageSelection diagnosis={result} isCurrent={isCurrent} diagnose={diagnose} />
      ) : null}
      {!pending && outcome?.status !== "available" && outcome?.status !== "changed" ? (
        <Button
          className="justify-self-end"
          variant="outline"
          disabled={pending}
          onClick={() => void diagnose()}
        >
          {result || failed ? <Trans>Retry</Trans> : <Trans>Diagnose storage</Trans>}
        </Button>
      ) : null}
    </>
  );
}

function StorageSelection({
  diagnosis,
  isCurrent,
  diagnose,
}: {
  diagnosis: ComputerDiskUsageResult;
  isCurrent: () => boolean;
  diagnose: () => Promise<void>;
}) {
  const { candidates, canSelect, selected, plan, busy, failed, choose, review, finish } =
    useComputerCleanup(
      diagnosis,
      {
        plan: (input, signal) =>
          rpc.computer.planCleanup(input, { signal, context: { isCurrent } }),
        confirm: (input, signal) =>
          rpc.computer.confirmCleanup(input, { signal, context: { isCurrent } }),
        cancel: (input, signal) =>
          rpc.computer.cancelCleanup(input, { signal, context: { isCurrent } }),
      },
      isCurrent,
    );
  const fileIdPrefix = useId();
  const reviewing = plan?.status === "awaiting_confirmation";
  const files = plan?.selected ?? candidates;

  return (
    <>
      {files.length > 0 ? (
        <ul className="list-none space-y-2 border-t border-border pt-3">
          {files.map((file, index) => (
            <li key={file.path} className="flex items-baseline justify-between gap-3">
              {canSelect && "cleanup" in file && file.cleanup ? (
                <label
                  htmlFor={`${fileIdPrefix}-${index}`}
                  className="flex min-w-0 items-center gap-2"
                >
                  <Checkbox
                    id={`${fileIdPrefix}-${index}`}
                    aria-label={file.path}
                    checked={selected.has(file.path)}
                    disabled={busy}
                    onCheckedChange={(checked) => choose(file.path, checked)}
                  />
                  <span className="min-w-0 break-all" dir="auto">
                    {file.path}
                  </span>
                </label>
              ) : (
                <span className="min-w-0 break-all" dir="auto">
                  {file.path}
                </span>
              )}
              <span className="shrink-0 text-muted-foreground">
                {formatFileSize(file.logicalBytes)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {reviewing || plan?.status === "reviewed" ? (
        <p className="text-muted-foreground">
          <Trans>Files stay in place.</Trans>
        </p>
      ) : null}
      {plan?.status === "reviewed" ? (
        <p role="status">
          <Trans>Selection saved.</Trans>
        </p>
      ) : null}
      {plan?.status === "expired" ? (
        <p role="status">
          <Trans>Selection expired. Diagnose storage again.</Trans>
        </p>
      ) : null}
      {failed ? (
        <p role="alert">
          <Trans>Could not update the selection.</Trans>
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {reviewing ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => void finish("cancel")}>
              <Trans>Cancel</Trans>
            </Button>
            <Button disabled={busy} onClick={() => void finish("confirm")}>
              <Trans>Confirm selection</Trans>
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={() => void diagnose()}>
              <Trans>Retry</Trans>
            </Button>
            {!plan && canSelect ? (
              <Button disabled={busy || !selected.size} onClick={() => void review()}>
                <Trans>Review selection</Trans>
              </Button>
            ) : null}
          </>
        )}
        {reviewing && failed ? (
          <Button variant="outline" disabled={busy} onClick={() => void diagnose()}>
            <Trans>Retry</Trans>
          </Button>
        ) : null}
      </div>
    </>
  );
}
