import { z } from "zod";
import { BotSettingsRevisionSchema } from "./bot-settings.js";
import { Id } from "./ids.js";

export const VoiceChoiceSchema = z.strictObject({
  provider: z.string().min(1).max(80),
  voiceId: z.string().min(1).max(120),
});
export type VoiceChoice = z.infer<typeof VoiceChoiceSchema>;

const revision = BotSettingsRevisionSchema;
const receipt = z.object({
  clientNonce: z.string().min(1).max(128),
  requestHash: z.string(),
});

export const VoiceDefaultVersionSchema = z.object({
  value: VoiceChoiceSchema.nullable(),
  revision,
});
export const VoiceOverrideVersionSchema = z.object({
  value: z.boolean(),
  revision,
});
export const VoiceDefaultHistorySchema = VoiceDefaultVersionSchema.extend({ receipt }).array();
export const VoiceOverrideHistorySchema = VoiceOverrideVersionSchema.extend({
  receipt: receipt.optional(),
  voice: VoiceChoiceSchema.optional(),
}).array();

export const EffectiveVoiceChoiceSchema = z.object({
  choice: VoiceChoiceSchema.nullable(),
  source: z.enum(["space", "account", "system"]),
});
export type EffectiveVoiceChoice = z.infer<typeof EffectiveVoiceChoiceSchema>;

export const VoiceDefaultsSchema = z.object({
  account: VoiceDefaultVersionSchema,
  space: VoiceOverrideVersionSchema,
  provider: z.string().nullable(),
  effective: EffectiveVoiceChoiceSchema,
  followingSpaces: z.array(z.object({ id: Id, name: z.string() })),
});
export type VoiceDefaults = z.infer<typeof VoiceDefaultsSchema>;

const write = {
  expectedRevision: revision,
  clientNonce: receipt.shape.clientNonce,
};
export const UpdateVoiceDefaultsInput = z.discriminatedUnion("scope", [
  z.strictObject({
    ...write,
    scope: z.literal("account"),
    value: VoiceChoiceSchema.nullable(),
    followingSpaceIds: z.array(Id),
  }),
  z.strictObject({
    ...write,
    scope: z.literal("space"),
    enabled: z.boolean(),
    expectedAccountRevision: revision,
    expectedProvider: VoiceChoiceSchema.shape.provider.nullable(),
  }),
]);
export type UpdateVoiceDefaultsInput = z.infer<typeof UpdateVoiceDefaultsInput>;

export const UpdateVoiceDefaultsResult = z.object({
  status: z.enum(["updated", "conflict", "unavailable"]),
  settings: VoiceDefaultsSchema,
});
export type UpdateVoiceDefaultsResult = z.infer<typeof UpdateVoiceDefaultsResult>;

export function resolveVoiceDefault(
  local: VoiceChoice | null,
  provider: string,
  override: boolean,
  account: VoiceChoice | null,
): EffectiveVoiceChoice {
  if (override) return { choice: local, source: "space" };
  if (account) {
    return { choice: account.provider === provider ? account : null, source: "account" };
  }
  return { choice: local, source: "system" };
}
