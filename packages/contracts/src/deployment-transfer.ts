import * as z from "zod";
import { BotSecretAuth, BotSecretName } from "./bot-secrets.js";
import { Id } from "./ids.js";

export const DEPLOYMENT_TRANSFER_MAX_ITEMS = 100;
export const DEPLOYMENT_TRANSFER_TTL_MS = 5 * 60_000;

/** Public-site syntax only. Network/address admission belongs to the backend transport. */
export function normalizeDeploymentTransferOrigin(value: string): string {
  if (
    !value ||
    value.length > 2048 ||
    /[\s\\?#@]/u.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error("Choose an HTTPS deployment origin.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Choose an HTTPS deployment origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin.length > 2048
  )
    throw new Error("Choose an HTTPS deployment origin.");
  return url.origin;
}

export const DeploymentTransferOriginSchema = z.string().transform((value, context) => {
  try {
    return normalizeDeploymentTransferOrigin(value);
  } catch {
    context.addIssue({ code: "custom", message: "Choose an HTTPS deployment origin." });
    return z.NEVER;
  }
});
export const DeploymentTransferIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const DeploymentTransferNonceSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !s.includes("\0"));
export const DeploymentTransferDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const DeploymentTransferSideSchema = z.enum(["source", "target"]);
export const DeploymentTransferPhaseSchema = z.enum([
  "created",
  "draft",
  "proposed",
  "previewed",
  "approved",
  "grant_pending",
  "ready",
  "transferring",
  "unknown",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "expired",
]);
export const DeploymentTransferReasonSchema = z.enum([
  "target_kept",
  "source_changed",
  "target_changed",
  "unsupported_kind",
  "oauth_reauthorization",
  "login_password_only",
  "write_unknown",
  "peer_unavailable",
  "access_changed",
  "expired",
  "cancelled",
  "destination_conflict",
  "credential_limit",
  "source_resource_shared",
  "resource_unknown",
  "restore",
  "invalid_credential",
  "removed",
]);
export type DeploymentTransferReason = z.infer<typeof DeploymentTransferReasonSchema>;

export const DeploymentTransferAuthSchema = z.discriminatedUnion("type", [
  BotSecretAuth.options[0].strict(),
  BotSecretAuth.options[1].strict(),
  BotSecretAuth.options[2].strict(),
  BotSecretAuth.options[3].strict(),
]);
export const DeploymentTransferScopeSchema = z
  .object({
    userId: Id,
    spaceId: Id,
    botId: Id,
  })
  .strict();
export const DeploymentTransferPublicIdentitySchema = z
  .object({
    deploymentId: z.string().uuid(),
    origin: DeploymentTransferOriginSchema,
    fingerprint: DeploymentTransferDigestSchema,
  })
  .strict();
export const DeploymentTransferCandidateSchema = z
  .object({
    itemKey: z.string().min(1).max(200),
    revision: z.string().uuid(),
    kind: z.enum(["password", "api_key"]),
    name: BotSecretName,
    origin: z.string().min(1).max(2048),
    auth: DeploymentTransferAuthSchema,
  })
  .strict();
export const DeploymentTransferOmissionSchema = z
  .object({
    name: z.string().max(256),
    reason: DeploymentTransferReasonSchema,
  })
  .strict();
export const DeploymentTransferPlanItemSchema = z
  .object({
    source: DeploymentTransferCandidateSchema,
    action: z.enum(["create", "keep", "overwrite"]),
    targetRevision: z.string().uuid().nullable(),
    canOverwrite: z.boolean(),
    reason: DeploymentTransferReasonSchema.optional(),
  })
  .strict();
export const DeploymentTransferPlanSchema = z
  .object({
    sourceScope: DeploymentTransferScopeSchema,
    targetScope: DeploymentTransferScopeSchema,
    sourceBotName: z.string().max(120),
    targetBotName: z.string().max(120),
    sourceOwnerName: z.string().max(200),
    sourceSpaceName: z.string().max(200),
    targetOwnerName: z.string().max(200),
    targetSpaceName: z.string().max(200),
    items: z.array(DeploymentTransferPlanItemSchema).max(DEPLOYMENT_TRANSFER_MAX_ITEMS),
  })
  .strict();
export const DeploymentTransferReceiptItemSchema = z
  .object({
    itemKey: z.string().min(1).max(200),
    name: z.string().max(64),
    kind: z.enum(["password", "api_key"]),
    status: z.enum([
      "pending",
      "sending",
      "unknown",
      "copied",
      "kept",
      "conflict",
      "skipped",
      "failed",
      "cancelled",
      "expired",
      "removed",
    ]),
    revision: z.number().int().positive(),
    reason: DeploymentTransferReasonSchema.optional(),
    canRecover: z.boolean(),
    targetState: z.enum(["unchanged", "modified", "removed"]).optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.targetState && item.status !== "copied")
      context.addIssue({ code: "custom", message: "Target observation requires a copied receipt" });
  });
export const DeploymentTransferStatusSchema = z
  .object({
    transferId: DeploymentTransferIdSchema,
    side: DeploymentTransferSideSchema,
    phase: DeploymentTransferPhaseSchema,
    revision: z.number().int().positive(),
    expiresAt: z.string(),
    localScope: DeploymentTransferScopeSchema,
    source: DeploymentTransferPublicIdentitySchema.nullable(),
    target: DeploymentTransferPublicIdentitySchema,
    candidates: z.array(DeploymentTransferCandidateSchema).max(DEPLOYMENT_TRANSFER_MAX_ITEMS),
    plan: DeploymentTransferPlanSchema.nullable(),
    proposalDigest: DeploymentTransferDigestSchema.nullable(),
    planDigest: DeploymentTransferDigestSchema.nullable(),
    commitNonce: DeploymentTransferNonceSchema.nullable(),
    items: z.array(DeploymentTransferReceiptItemSchema).max(DEPLOYMENT_TRANSFER_MAX_ITEMS),
    leftOut: z.array(DeploymentTransferOmissionSchema).max(DEPLOYMENT_TRANSFER_MAX_ITEMS),
    grantDelivery: z.enum(["none", "pending", "unknown", "stored", "acknowledged"]),
    canApprove: z.boolean(),
    canCommit: z.boolean(),
    canRecover: z.boolean(),
    sourcePageUrl: z.string().max(4096).optional(),
    writeRevokedReason: z.literal("restore").optional(),
  })
  .strict();
export type DeploymentTransferStatus = z.infer<typeof DeploymentTransferStatusSchema>;
export type DeploymentTransferCandidate = z.infer<typeof DeploymentTransferCandidateSchema>;
export type DeploymentTransferPlan = z.infer<typeof DeploymentTransferPlanSchema>;
export type DeploymentTransferScope = z.infer<typeof DeploymentTransferScopeSchema>;

export const DeploymentTransferStartInput = z
  .object({
    targetBotId: Id,
    sourceOrigin: DeploymentTransferOriginSchema,
    clientNonce: DeploymentTransferNonceSchema,
  })
  .strict();
export const DeploymentTransferPreviewInput = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("source"),
      targetOrigin: DeploymentTransferOriginSchema,
      locator: DeploymentTransferIdSchema,
      sourceBotId: Id,
      clientNonce: DeploymentTransferNonceSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("target"),
      transferId: DeploymentTransferIdSchema,
      expectedRevision: z.number().int().positive(),
      decisions: z
        .array(
          z
            .object({
              itemKey: z.string().min(1).max(200),
              action: z.enum(["keep", "overwrite"]),
            })
            .strict(),
        )
        .max(DEPLOYMENT_TRANSFER_MAX_ITEMS),
    })
    .strict(),
]);
export const DeploymentTransferProposeInput = z
  .object({
    transferId: DeploymentTransferIdSchema,
    expectedRevision: z.number().int().positive(),
    selected: z
      .array(
        z
          .object({
            itemKey: z.string().min(1).max(200),
            revision: z.string().uuid(),
          })
          .strict(),
      )
      .min(1)
      .max(DEPLOYMENT_TRANSFER_MAX_ITEMS),
  })
  .strict();
export const DeploymentTransferApproveInput = z
  .object({
    transferId: DeploymentTransferIdSchema,
    expectedRevision: z.number().int().positive(),
    planDigest: DeploymentTransferDigestSchema,
    expectedSourceFingerprint: DeploymentTransferDigestSchema,
  })
  .strict();
export const DeploymentTransferCommitInput = z
  .object({
    transferId: DeploymentTransferIdSchema,
    expectedRevision: z.number().int().positive(),
    planDigest: DeploymentTransferDigestSchema,
    expectedTargetFingerprint: DeploymentTransferDigestSchema,
    clientNonce: DeploymentTransferNonceSchema,
  })
  .strict();
export const DeploymentTransferStatusInput = z.union([
  z.object({ transferId: DeploymentTransferIdSchema }).strict(),
  z
    .object({ clientNonce: DeploymentTransferNonceSchema, side: DeploymentTransferSideSchema })
    .strict(),
]);
export const DeploymentTransferCancelInput = z
  .object({
    transferId: DeploymentTransferIdSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export const DeploymentTransferRecentSchema = DeploymentTransferStatusSchema.pick({
  transferId: true,
  side: true,
  phase: true,
  revision: true,
  expiresAt: true,
  localScope: true,
  source: true,
  target: true,
});
export type DeploymentTransferStartInput = z.infer<typeof DeploymentTransferStartInput>;
export type DeploymentTransferPreviewInput = z.infer<typeof DeploymentTransferPreviewInput>;
export type DeploymentTransferProposeInput = z.infer<typeof DeploymentTransferProposeInput>;
export type DeploymentTransferApproveInput = z.infer<typeof DeploymentTransferApproveInput>;
export type DeploymentTransferCommitInput = z.infer<typeof DeploymentTransferCommitInput>;
export type DeploymentTransferStatusInput = z.infer<typeof DeploymentTransferStatusInput>;
export type DeploymentTransferCancelInput = z.infer<typeof DeploymentTransferCancelInput>;
export type DeploymentTransferRecent = z.infer<typeof DeploymentTransferRecentSchema>;
