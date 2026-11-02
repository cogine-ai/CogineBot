import {
  DeploymentTransferCandidateSchema,
  DeploymentTransferDigestSchema,
  DeploymentTransferIdSchema,
  DeploymentTransferNonceSchema,
  DeploymentTransferOmissionSchema,
  DeploymentTransferPhaseSchema,
  DeploymentTransferReasonSchema,
  DeploymentTransferReceiptItemSchema,
  DeploymentTransferScopeSchema,
  normalizeDeploymentTransferOrigin,
} from "@rakazo/contracts";
import * as z from "zod";
import { DEPLOYMENT_TRANSFER_PROTOCOL } from "./deployment-transfer-crypto.js";

const protocol = z.literal(DEPLOYMENT_TRANSFER_PROTOCOL);
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestamp = z.iso.datetime();
const canonicalOrigin = z.string().refine((value) => {
  try {
    return normalizeDeploymentTransferOrigin(value) === value;
  } catch {
    return false;
  }
}, "Invalid deployment origin");
const signed = <T extends z.ZodType>(payload: T) =>
  z
    .object({
      payload,
      signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    })
    .strict();
export const TransferPeerIdentitySchema = z
  .object({
    deploymentId: z.string().uuid(),
    origin: canonicalOrigin,
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{40,200}$/),
    fingerprint: DeploymentTransferDigestSchema,
  })
  .strict();
export type TransferPeerIdentity = z.infer<typeof TransferPeerIdentitySchema>;
export const TransferResourceIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline") }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
  z
    .object({
      kind: z.literal("external"),
      fingerprint: DeploymentTransferDigestSchema,
      deletionKeyFingerprint: DeploymentTransferDigestSchema,
    })
    .strict(),
]);
export const TransferChallengeSchema = z
  .object({
    protocol,
    kind: z.literal("challenge"),
    transferId: DeploymentTransferIdSchema,
    locatorHash: DeploymentTransferDigestSchema,
    sourceOrigin: canonicalOrigin,
    target: TransferPeerIdentitySchema,
    targetNonce: nonce,
    targetBindingDigest: DeploymentTransferDigestSchema,
    expiresAt: timestamp,
  })
  .strict();
export const SignedTransferChallengeSchema = signed(TransferChallengeSchema);
export const TransferSelectionSchema = DeploymentTransferCandidateSchema.extend({
  sourceSecretId: z.string().min(1).max(200),
}).strict();
export const TransferProposalSchema = z
  .object({
    protocol,
    kind: z.literal("proposal"),
    challenge: SignedTransferChallengeSchema,
    source: TransferPeerIdentitySchema,
    sourceScope: DeploymentTransferScopeSchema,
    sourceBotName: z.string().max(120),
    sourceOwnerName: z.string().max(200),
    sourceSpaceName: z.string().max(200),
    sourceNonce: nonce,
    proposalRevision: z.number().int().positive(),
    selection: z.array(TransferSelectionSchema).min(1).max(100),
    protectedSourceResources: z.array(TransferResourceIdentitySchema).max(100),
    leftOut: z.array(DeploymentTransferOmissionSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.selection.map((item) => item.itemKey)).size !== value.selection.length)
      context.addIssue({ code: "custom", message: "Duplicate transfer item" });
    if (new Set(value.selection.map((item) => item.sourceSecretId)).size !== value.selection.length)
      context.addIssue({ code: "custom", message: "Duplicate source credential" });
  });
export const SignedTransferProposalSchema = signed(TransferProposalSchema);
const expected = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z
    .object({
      kind: z.literal("present"),
      id: z.string().min(1).max(200),
      revision: z.string().uuid(),
    })
    .strict(),
]);
export const TransferPlanItemSchema = z
  .object({
    source: TransferSelectionSchema,
    action: z.enum(["create", "keep", "overwrite"]),
    expectedTarget: expected,
    canOverwrite: z.boolean(),
    reason: DeploymentTransferReasonSchema.optional(),
  })
  .strict();
export const TransferPlanSchema = z
  .object({
    protocol,
    kind: z.literal("plan"),
    transferId: DeploymentTransferIdSchema,
    proposalDigest: DeploymentTransferDigestSchema,
    revision: z.number().int().positive(),
    source: TransferPeerIdentitySchema,
    target: TransferPeerIdentitySchema,
    sourceScope: DeploymentTransferScopeSchema,
    targetScope: DeploymentTransferScopeSchema,
    sourceBotName: z.string().max(120),
    targetBotName: z.string().max(120),
    sourceOwnerName: z.string().max(200),
    sourceSpaceName: z.string().max(200),
    targetOwnerName: z.string().max(200),
    targetSpaceName: z.string().max(200),
    sourceNonce: nonce,
    targetNonce: nonce,
    expiresAt: timestamp,
    items: z.array(TransferPlanItemSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.items.map((item) => item.source.itemKey)).size !== value.items.length)
      context.addIssue({ code: "custom", message: "Duplicate transfer item" });
  });
export const TransferGrantSchema = z
  .object({
    protocol,
    kind: z.literal("grant"),
    grantNonce: nonce,
    plan: TransferPlanSchema,
    planDigest: DeploymentTransferDigestSchema,
    tokenHash: DeploymentTransferDigestSchema,
  })
  .strict();
export const SignedTransferGrantSchema = signed(TransferGrantSchema);
export const TransferGrantDeliverySchema = z
  .object({
    grant: SignedTransferGrantSchema,
    writeToken: nonce,
  })
  .strict();
const itemBinding = {
  protocol,
  transferId: DeploymentTransferIdSchema,
  planDigest: DeploymentTransferDigestSchema,
  grantNonce: nonce,
  source: TransferPeerIdentitySchema,
  target: TransferPeerIdentitySchema,
  sourceScope: DeploymentTransferScopeSchema,
  targetScope: DeploymentTransferScopeSchema,
  sourceNonce: nonce,
  targetNonce: nonce,
  expiresAt: timestamp,
  commitNonce: DeploymentTransferNonceSchema,
  itemKey: z.string().min(1).max(200),
  sourceRevision: z.string().uuid(),
};
export const TransferItemSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...itemBinding, kind: z.literal("item"), value: z.string().min(1).max(16_384) })
    .strict(),
  z.object({ ...itemBinding, kind: z.literal("recover") }).strict(),
  z
    .object({
      ...itemBinding,
      kind: z.literal("recover_inline"),
      value: z.string().min(1).max(16_384),
      expectedWriteFence: z.number().int().nonnegative(),
    })
    .strict(),
]);
export const SignedTransferItemSchema = signed(TransferItemSchema);
const queryBinding = {
  protocol,
  transferId: DeploymentTransferIdSchema,
  proposalDigest: DeploymentTransferDigestSchema,
  planDigest: DeploymentTransferDigestSchema.nullable(),
  source: TransferPeerIdentitySchema,
  target: TransferPeerIdentitySchema,
  sourceScope: DeploymentTransferScopeSchema,
  targetBindingDigest: DeploymentTransferDigestSchema,
  sourceNonce: nonce,
  targetNonce: nonce,
  requestNonce: nonce,
  messageExpiresAt: timestamp,
};
export const TransferStatusQuerySchema = z
  .object({ ...queryBinding, kind: z.literal("status") })
  .strict();
export const TransferCancelSchema = z
  .object({ ...queryBinding, kind: z.literal("cancel") })
  .strict();
export const SignedTransferStatusQuerySchema = signed(TransferStatusQuerySchema);
export const SignedTransferCancelSchema = signed(TransferCancelSchema);
export const TransferReceiptSchema = z
  .object({
    protocol,
    kind: z.literal("receipt"),
    transferId: DeploymentTransferIdSchema,
    proposalDigest: DeploymentTransferDigestSchema,
    planDigest: DeploymentTransferDigestSchema.nullable(),
    requestNonce: DeploymentTransferNonceSchema,
    phase: DeploymentTransferPhaseSchema,
    revision: z.number().int().positive(),
    grantStored: z.boolean(),
    items: z.array(DeploymentTransferReceiptItemSchema).max(100),
    recovery: z
      .array(
        z
          .object({
            itemKey: z.string().min(1).max(200),
            writeFence: z.number().int().nonnegative(),
            state: z.enum(["found", "absent", "unknown"]),
            inline: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const SignedTransferReceiptSchema = signed(TransferReceiptSchema);
export type TransferChallenge = z.infer<typeof TransferChallengeSchema>;
export type TransferProposal = z.infer<typeof TransferProposalSchema>;
export type TransferPlan = z.infer<typeof TransferPlanSchema>;
export type TransferPlanItem = z.infer<typeof TransferPlanItemSchema>;
export type TransferSelection = z.infer<typeof TransferSelectionSchema>;
export type TransferGrantDelivery = z.infer<typeof TransferGrantDeliverySchema>;
export type TransferItem = z.infer<typeof TransferItemSchema>;
export type TransferStatusQuery = z.infer<typeof TransferStatusQuerySchema>;
export type TransferCancel = z.infer<typeof TransferCancelSchema>;
export type TransferReceipt = z.infer<typeof TransferReceiptSchema>;
export type SignedTransfer<T> = { payload: T; signature: string };
