import { describe, expect, it } from "vitest";
import { DEPLOYMENT_TRANSFER_PROTOCOL } from "./deployment-transfer-crypto.js";
import {
  SignedTransferItemSchema,
  TransferPeerIdentitySchema,
  TransferPlanSchema,
  TransferProposalSchema,
  TransferReceiptSchema,
} from "./deployment-transfer-protocol.js";

const protocol = DEPLOYMENT_TRANSFER_PROTOCOL;
const nonce = "a".repeat(43);
const digest = "a".repeat(64);
const signature = "b".repeat(86);
const scope = { userId: "owner", spaceId: "space", botId: "bot" };
const identity = {
  deploymentId: "6a11f69e-2873-4f90-a3a3-9262d39cc0b1",
  origin: "https://source.example",
  publicKey: "a".repeat(59),
  fingerprint: digest,
};
const target = {
  ...identity,
  deploymentId: "951ead0a-e07b-43c7-9a70-f727f9e106e7",
  origin: "https://target.example",
};
const expiresAt = "2026-11-03T01:00:00.000Z";
const selection = {
  itemKey: "item",
  revision: "ed3c58ef-4504-4be5-a76f-21c8736fb927",
  kind: "api_key",
  name: "api_key",
  origin: "https://service.example",
  auth: { type: "bearer" },
  sourceSecretId: "row",
};
const proposal = {
  protocol,
  kind: "proposal",
  challenge: {
    signature,
    payload: {
      protocol,
      kind: "challenge",
      transferId: nonce,
      locatorHash: digest,
      sourceOrigin: identity.origin,
      target,
      targetNonce: nonce,
      targetBindingDigest: digest,
      expiresAt,
    },
  },
  source: identity,
  sourceScope: scope,
  sourceBotName: "Source",
  sourceOwnerName: "Owner",
  sourceSpaceName: "Space",
  sourceNonce: nonce,
  proposalRevision: 1,
  selection: [selection],
  protectedSourceResources: [{ kind: "inline" }],
  leftOut: [],
};
const plan = {
  protocol,
  kind: "plan",
  transferId: nonce,
  proposalDigest: digest,
  revision: 2,
  source: identity,
  target,
  sourceScope: scope,
  targetScope: scope,
  sourceBotName: "Source",
  targetBotName: "Target",
  sourceOwnerName: "Source owner",
  sourceSpaceName: "Source space",
  targetOwnerName: "Target owner",
  targetSpaceName: "Target space",
  sourceNonce: nonce,
  targetNonce: nonce,
  expiresAt,
  items: [
    {
      source: selection,
      action: "create",
      expectedTarget: { kind: "absent" },
      canOverwrite: false,
    },
  ],
};
const item = {
  protocol,
  kind: "item",
  transferId: nonce,
  planDigest: digest,
  grantNonce: nonce,
  source: identity,
  target,
  sourceScope: scope,
  targetScope: scope,
  sourceNonce: nonce,
  targetNonce: nonce,
  expiresAt,
  commitNonce: "batch-nonce",
  itemKey: selection.itemKey,
  sourceRevision: selection.revision,
  value: "protected-value",
};

describe("private deployment-transfer protocol boundaries", () => {
  it("requires canonical origins at the signed wire boundary", () => {
    expect(TransferPeerIdentitySchema.safeParse(identity).success).toBe(true);
    for (const origin of [
      "https://SOURCE.example",
      "https://source.example/",
      "https://source.example:443",
      "https://source.example?",
      "http://source.example",
    ])
      expect(TransferPeerIdentitySchema.safeParse({ ...identity, origin }).success).toBe(false);
  });
  it("rejects duplicate item keys and duplicate source rows before signing a proposal", () => {
    expect(TransferProposalSchema.safeParse(proposal).success).toBe(true);
    expect(
      TransferProposalSchema.safeParse({
        ...proposal,
        selection: [selection, { ...selection, sourceSecretId: "other" }],
      }).success,
    ).toBe(false);
    expect(
      TransferProposalSchema.safeParse({
        ...proposal,
        selection: [selection, { ...selection, itemKey: "other" }],
      }).success,
    ).toBe(false);
  });
  it("binds an expected target by both its id and opaque revision", () => {
    expect(TransferPlanSchema.safeParse(plan).success).toBe(true);
    expect(
      TransferPlanSchema.safeParse({
        ...plan,
        items: [{ ...plan.items[0], expectedTarget: { kind: "present", id: "target-row" } }],
      }).success,
    ).toBe(false);
    expect(
      TransferPlanSchema.safeParse({ ...plan, items: [plan.items[0], plan.items[0]] }).success,
    ).toBe(false);
  });
  it("keeps initial writes, found-ref adoption and inline re-sealing separate", () => {
    expect(SignedTransferItemSchema.safeParse({ payload: item, signature }).success).toBe(true);
    const { value: _value, ...binding } = item;
    expect(
      SignedTransferItemSchema.safeParse({ payload: { ...binding, kind: "recover" }, signature })
        .success,
    ).toBe(true);
    expect(
      SignedTransferItemSchema.safeParse({ payload: { ...item, kind: "recover" }, signature })
        .success,
    ).toBe(false);
    expect(
      SignedTransferItemSchema.safeParse({
        payload: { ...item, kind: "recover_inline" },
        signature,
      }).success,
    ).toBe(false);
    expect(
      SignedTransferItemSchema.safeParse({
        payload: { ...item, kind: "recover_inline", expectedWriteFence: 2 },
        signature,
      }).success,
    ).toBe(true);
  });
  it("does not admit credentials, bearer tokens or provider references into receipts", () => {
    const receipt = {
      protocol,
      kind: "receipt",
      transferId: nonce,
      proposalDigest: digest,
      planDigest: digest,
      requestNonce: "batch-nonce",
      phase: "unknown",
      revision: 1,
      grantStored: true,
      items: [],
      recovery: [],
    };
    expect(TransferReceiptSchema.safeParse(receipt).success).toBe(true);
    for (const extra of [
      { value: "secret" },
      { writeToken: nonce },
      { recoveryRef: "provider:key" },
    ])
      expect(TransferReceiptSchema.safeParse({ ...receipt, ...extra }).success).toBe(false);
  });
});
