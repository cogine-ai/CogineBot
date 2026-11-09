import { Trans } from "@lingui/react/macro";
import type { DelegatedApproval } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { AskCard } from "./AskCard";

export function DelegatedApprovalCard({
  approval,
  onAnswer,
  onOpenBot,
}: {
  approval: DelegatedApproval;
  onAnswer: (approval: DelegatedApproval, action: string) => Promise<void>;
  onOpenBot: (botId: string) => void;
}) {
  return (
    <div data-testid="delegated-approval" className="mt-2 space-y-1.5">
      <div className="text-[13px] font-medium text-muted-foreground">{approval.botName}</div>
      <AskCard
        block={approval.block}
        canAnswer={approval.state === "pending"}
        onAnswer={(action) => onAnswer(approval, action)}
      />
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        {approval.state === "inactive" && approval.block.status === "answered" ? (
          <span>
            <Trans>No longer active</Trans>
          </span>
        ) : null}
        {approval.state === "failed" ? (
          <span>
            <Trans>Action failed</Trans>
          </span>
        ) : null}
        {approval.state === "unknown" ? (
          <span>
            <Trans>Result unconfirmed</Trans>
          </span>
        ) : null}
        {approval.receiptUrl ? (
          <a href={approval.receiptUrl} target="_blank" rel="noreferrer" className="underline">
            <Trans>View result</Trans>
          </a>
        ) : approval.state === "succeeded" ? (
          <span>
            <Trans>Action completed</Trans>
          </span>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => onOpenBot(approval.botId)}>
          <Trans>View execution chat</Trans>
        </Button>
      </div>
    </div>
  );
}
