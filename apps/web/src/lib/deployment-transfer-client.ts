import type { DeploymentTransferStatus } from "@rakazo/contracts";
import type { DeploymentTransferState } from "@rakazo/core";
import {
  createDeploymentTransfer,
  deploymentTransferStatusPath,
  parseDeploymentTransferPage,
} from "@rakazo/core";
import { newClientId } from "./client-id";
import {
  createSpaceRpc,
  currentRpcSessionGeneration,
  currentSpaceSelectionGeneration,
} from "./rpc";

export { deploymentTransferStatusPath as transferStatusPath } from "@rakazo/core";

export function sourceTransferPageUrl(snapshot: DeploymentTransferStatus): string | null {
  if (snapshot.side !== "target" || !snapshot.sourcePageUrl) return null;
  try {
    const url = new URL(snapshot.sourcePageUrl);
    const page = parseDeploymentTransferPage(url.pathname + url.search);
    if (
      url.href !== snapshot.sourcePageUrl ||
      snapshot.sourcePageUrl.includes("#") ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !page ||
      !("locator" in page) ||
      page.locator !== snapshot.transferId ||
      page.targetOrigin !== snapshot.target.origin
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function createWebDeploymentTransfer({
  spaceId,
  side,
  isCurrent,
  changed,
}: {
  spaceId: string | null;
  side?: "source" | "target";
  isCurrent(): boolean;
  changed(state: DeploymentTransferState): void;
}) {
  const session = currentRpcSessionGeneration();
  const selection = currentSpaceSelectionGeneration();
  const origin = window.location.origin;
  const valid = () =>
    isCurrent() &&
    session === currentRpcSessionGeneration() &&
    selection === currentSpaceSelectionGeneration() &&
    origin === window.location.origin;
  const client = createSpaceRpc(spaceId, valid);
  const manager = createDeploymentTransfer({
    side,
    start: (input, signal) => client.transfer.start(input, { signal }),
    preview: (input, signal) => client.transfer.preview(input, { signal }),
    propose: (input, signal) => client.transfer.propose(input, { signal }),
    approve: (input, signal) => client.transfer.approve(input, { signal }),
    commit: (input, signal) => client.transfer.commit(input, { signal }),
    status: (input, signal) => client.transfer.status(input, { signal }),
    recent: (botId, signal) => client.transfer.recent({ botId }, { signal }),
    cancel: (input, signal) => client.transfer.cancel(input, { signal }),
    newNonce: newClientId,
    isCurrent: valid,
    changed,
  });
  return { manager, client, isCurrent: valid };
}

/** Persist the owner-authenticated recovery address before dispatch without unmounting its writer. */
export function rememberTransferAddress(state: DeploymentTransferState): string | null {
  const side =
    state.snapshot?.side ??
    (state.recovery && "side" in state.recovery ? state.recovery.side : null);
  const recovery = state.snapshot ? { transferId: state.snapshot.transferId } : state.recovery;
  if (!side || !recovery) return null;
  const path = deploymentTransferStatusPath(side, recovery);
  if (state.request === "saving") window.history.replaceState(window.history.state, "", path);
  return path;
}
