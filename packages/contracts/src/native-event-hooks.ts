import { z } from "zod";

const Id = z.string().min(1).max(256);
const Revision = z.number().int().positive();
const Existing = z.object({ configId: Id, id: Id, expectedRevision: Revision }).strict();
export const NativeNotionHookStatusInputSchema = z.object({ configId: Id }).strict();
export const BeginNativeNotionHookSetupInputSchema = z.object({ configId: Id }).strict();
export const RevealNativeNotionHookTokenInputSchema = Existing;
export const ConfirmNativeNotionHookSetupInputSchema = Existing.extend({
  integrationId: z.uuid(),
  verifiedInNotion: z.literal(true),
}).strict();
export const DisableNativeNotionHookInputSchema = Existing;
export const NativeNotionHookSchema = z
  .object({
    id: Id,
    configId: Id,
    configRevision: Revision,
    revision: Revision,
    phase: z.enum([
      "waiting_for_challenge",
      "waiting_for_owner",
      "waiting_for_signed_identity",
      "active",
      "disabled",
      "expired",
      "invalidated",
    ]),
    integrationId: z.uuid().nullable(),
    candidateIntegrationId: z.uuid().nullable(),
    subscriptionId: z.uuid().nullable(),
    configured: z.boolean(),
    enabled: z.boolean(),
    webhookUrl: z.string().url().nullable(),
    setupExpiresAt: z.string().nullable(),
    ownerConfirmedAt: z.string().nullable(),
    lastVerifiedAt: z.string().nullable(),
  })
  .strict();
export const NativeNotionHookStatusSchema = z
  .object({
    configId: Id,
    publicHttpsAvailable: z.boolean(),
    hooks: z.array(NativeNotionHookSchema),
  })
  .strict();
export const RevealNativeNotionHookTokenSchema = z
  .object({
    hook: NativeNotionHookSchema,
    verificationToken: z.string().min(16).max(4096),
  })
  .strict();
export type NativeNotionHook = z.infer<typeof NativeNotionHookSchema>;
export type NativeNotionHookStatus = z.infer<typeof NativeNotionHookStatusSchema>;
export type RevealedNativeNotionHookToken = z.infer<typeof RevealNativeNotionHookTokenSchema>;
