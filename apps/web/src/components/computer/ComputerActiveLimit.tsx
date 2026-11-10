import { Trans } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";

export function ComputerActiveLimit({
  computer,
  onContinue,
}: {
  computer: ComputerStatus | null;
  onContinue: () => void;
}) {
  if (computer?.state === "suspended" && computer.suspensionReason === "active_limit") {
    return (
      <div className="space-y-2">
        <p>
          <Trans>Computer paused at its runtime limit.</Trans>
        </p>
        <p className="text-xs text-muted-foreground">
          <Trans>Background tasks may have stopped.</Trans>
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onContinue}>
          <Trans>Continue using computer</Trans>
        </Button>
      </div>
    );
  }
  return null;
}
