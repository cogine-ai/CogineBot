import type { DeploymentTransferStatus, DeploymentTransferStatusInput } from "@rakazo/contracts";
import { normalizeDeploymentTransferOrigin } from "@rakazo/contracts";
import { deploymentTransferStatusPath } from "@rakazo/core";
import { captureApiRequestContext, rpc } from "./api";
import type { MobileScope } from "./mobile-scope";
import { isMobileScopeCurrent } from "./mobile-scope";
import { currentReadySessionGeneration } from "./session";

/** Existing transfer receipts authorize their persisted scope on the server, without a me/Space fallback. */
export async function mobileDeploymentTransferClient(scope: MobileScope, isMounted: () => boolean) {
  const isCurrent = () =>
    isMounted() &&
    isMobileScopeCurrent(scope) &&
    currentReadySessionGeneration() === scope.sessionGeneration;
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("Transfer is no longer current.");
  };
  assertCurrent();
  const context = await captureApiRequestContext(scope.spaceId);
  assertCurrent();
  if (context.apiBase !== scope.apiBase || context.sessionGeneration !== scope.sessionGeneration)
    throw new Error("Transfer is no longer current.");
  const requestContext = { ...context, isCurrent };
  return {
    isCurrent,
    async request<T>(procedure: string, input: unknown, signal?: AbortSignal): Promise<T> {
      assertCurrent();
      signal?.throwIfAborted();
      const value = await rpc<T>(procedure, input, {
        requestContext,
        skipSpaceAuthRecovery: true,
        signal,
      });
      assertCurrent();
      signal?.throwIfAborted();
      return value;
    },
    pageUrl(
      snapshot: DeploymentTransferStatus | null,
      recovery: DeploymentTransferStatusInput | null,
    ): string | null {
      assertCurrent();
      const side = snapshot?.side ?? (recovery && "side" in recovery ? recovery.side : null);
      const input = snapshot ? { transferId: snapshot.transferId } : recovery;
      if (!side || !input) return null;
      try {
        const local = snapshot ? (side === "target" ? snapshot.target : snapshot.source) : null;
        const origin = normalizeDeploymentTransferOrigin(local?.origin ?? scope.apiBase);
        return new URL(deploymentTransferStatusPath(side, input), origin).href;
      } catch {
        return null;
      }
    },
  };
}
export type MobileDeploymentTransferClient = Awaited<
  ReturnType<typeof mobileDeploymentTransferClient>
>;
