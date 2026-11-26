import { Trans, useLingui } from "@lingui/react/macro";
import { useComputerStorage } from "@rakazo/chat-ui/computer-storage";
import { formatFileSize } from "@rakazo/core";
import { Button, Dialog, DialogContent, DialogTitle, DialogTrigger } from "@rakazo/ui-web";
import { HardDrive } from "lucide-react";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
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
  const { result, pending, failed, diagnose } = useComputerStorage(
    { botId, expectedTarget },
    (input, signal) => rpc.computer.diskUsage(input, { signal }),
    () => scope === rpcRecoveryScopeKey() && document.visibilityState !== "hidden",
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
          <Trans>Computer changed. Open Storage again.</Trans>
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
      {!pending && outcome?.status === "available" && outcome.data.candidates.length > 0 ? (
        <ul className="list-none space-y-1 border-t border-border pt-3">
          {outcome.data.candidates.map(({ path, logicalBytes }) => (
            <li key={path} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 break-all" dir="auto">
                {path}
              </span>
              <span className="shrink-0 text-muted-foreground">{formatFileSize(logicalBytes)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {outcome?.status !== "changed" ? (
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
