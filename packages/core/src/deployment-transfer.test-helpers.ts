import type { DeploymentTransferStatus } from "@rakazo/contracts";

export const candidate = {
  itemKey: "login-one",
  revision: "10000000-0000-4000-8000-000000000001",
  kind: "password" as const,
  name: "research-login",
  origin: "https://research.example.test",
  auth: { type: "login" as const },
};
export const sourceScope = { userId: "source-owner", spaceId: "source-space", botId: "source-bot" };
export const targetScope = { userId: "target-owner", spaceId: "target-space", botId: "target-bot" };
export const sourceIdentity = {
  deploymentId: "20000000-0000-4000-8000-000000000001",
  origin: "https://source.example.test",
  fingerprint: "b".repeat(64),
};
export const targetIdentity = {
  deploymentId: "20000000-0000-4000-8000-000000000002",
  origin: "https://target.example.test",
  fingerprint: "c".repeat(64),
};
export const plan = {
  sourceScope,
  targetScope,
  sourceBotName: "Research",
  targetBotName: "Research copy",
  sourceOwnerName: "Source owner",
  sourceSpaceName: "Source workspace",
  targetOwnerName: "Target owner",
  targetSpaceName: "Target workspace",
  items: [
    {
      source: candidate,
      action: "keep" as const,
      targetRevision: "10000000-0000-4000-8000-000000000002",
      canOverwrite: true,
    },
  ],
};
export const copied = {
  itemKey: candidate.itemKey,
  name: candidate.name,
  kind: candidate.kind,
  status: "copied" as const,
  revision: 1,
  canRecover: false,
};
export function snapshot(patch: Partial<DeploymentTransferStatus> = {}): DeploymentTransferStatus {
  return {
    transferId: "a".repeat(43),
    side: "source",
    phase: "draft",
    revision: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    localScope: sourceScope,
    source: sourceIdentity,
    target: targetIdentity,
    candidates: [candidate],
    plan: null,
    proposalDigest: null,
    planDigest: null,
    commitNonce: null,
    items: [],
    leftOut: [],
    grantDelivery: "none",
    canApprove: false,
    canCommit: false,
    canRecover: false,
    ...patch,
  };
}
