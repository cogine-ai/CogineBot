import { z } from "zod";
import type { ThinkingLevel } from "./bot-settings.js";
import { BotSettingsRevisionSchema, ThinkingLevelSchema } from "./bot-settings.js";
import { Id } from "./ids.js";
import type { DefaultModelChoice } from "./model-defaults.js";
import { DefaultModelChoiceSchema } from "./model-defaults.js";

const accountChoice = z.strictObject({
  model: DefaultModelChoiceSchema,
  level: ThinkingLevelSchema,
});
const spaceChoice = z.discriminatedUnion("mode", [
  z.strictObject({ model: DefaultModelChoiceSchema, mode: z.literal("inherit") }),
  z.strictObject({
    model: DefaultModelChoiceSchema,
    mode: z.literal("fixed"),
    level: ThinkingLevelSchema.nullable(),
  }),
]);

const revision = BotSettingsRevisionSchema;
const account = z.object({ value: accountChoice.nullable(), revision });
const space = z.object({ value: spaceChoice.nullable(), revision });
const receipt = z.object({ clientNonce: z.string().min(1).max(128), requestHash: z.string() });
export const AccountThinkingHistory = account.extend({ receipt }).array();
export const SpaceThinkingHistory = space.extend({ receipt: receipt.optional() }).array();
export type AccountThinkingChoice = z.infer<typeof accountChoice>;
export type SpaceThinkingChoice = z.infer<typeof spaceChoice>;

const effective = z.object({
  level: ThinkingLevelSchema.nullable(),
  source: z.enum(["bot", "space", "account", "system"]),
  unsupported: z.boolean(),
});

const binding = z.object({
  model: DefaultModelChoiceSchema,
  credentialId: Id,
  connectionRevision: z.number().int().positive(),
  modelAccountRevision: revision,
  modelSpaceRevision: revision,
});

export const ThinkingDefaultsSchema = z.object({
  account,
  space,
  effective,
  binding: binding.nullable(),
  levels: ThinkingLevelSchema.array(),
  followsAccount: z.boolean(),
  followingSpaces: z.array(z.object({ id: Id, name: z.string() })),
});
export type ThinkingDefaults = z.infer<typeof ThinkingDefaultsSchema>;

const write = {
  expectedRevision: revision,
  binding: binding.nullable(),
  clientNonce: receipt.shape.clientNonce,
};
export const UpdateThinkingDefaultsInput = z.discriminatedUnion("scope", [
  z.strictObject({
    ...write,
    scope: z.literal("account"),
    level: ThinkingLevelSchema.nullable(),
    followingSpaceIds: Id.array(),
  }),
  z.strictObject({
    ...write,
    scope: z.literal("space"),
    value: z.union([z.enum(["inherit", "copy", "modelDefault"]), ThinkingLevelSchema]),
    expectedAccountRevision: revision,
    expectedLevel: ThinkingLevelSchema.nullable(),
  }),
]);
export type UpdateThinkingDefaultsInput = z.infer<typeof UpdateThinkingDefaultsInput>;

export const UpdateThinkingDefaultsResult = z.object({
  status: z.enum(["updated", "conflict", "unavailable"]),
  settings: ThinkingDefaultsSchema,
});
export type UpdateThinkingDefaultsResult = z.infer<typeof UpdateThinkingDefaultsResult>;

export function sameDefaultModel(
  left: DefaultModelChoice | null,
  right: DefaultModelChoice | null,
) {
  return left === right || (left?.provider === right?.provider && left?.modelId === right?.modelId);
}

export function resolveThinkingDefault(input: {
  model: DefaultModelChoice;
  allowed: readonly ThinkingLevel[];
  explicit: ThinkingLevel | null;
  legacy: ThinkingLevel | null;
  account: AccountThinkingChoice | null;
  space: SpaceThinkingChoice | null;
}): z.infer<typeof effective> {
  const { model, allowed, explicit, legacy, account, space } = input;
  const applicable = space && sameDefaultModel(space.model, model) ? space : null;
  if (explicit) return { level: explicit, source: "bot", unsupported: false };
  if (applicable?.mode === "fixed") {
    const supported = applicable.level === null || allowed.includes(applicable.level);
    return {
      level: supported ? applicable.level : null,
      source: supported ? "space" : "system",
      unsupported: !supported,
    };
  }
  if (!applicable && legacy) return { level: legacy, source: "space", unsupported: false };
  if (account && sameDefaultModel(account.model, model)) {
    const supported = allowed.includes(account.level);
    return {
      level: supported ? account.level : null,
      source: supported ? "account" : "system",
      unsupported: !supported,
    };
  }
  return { level: null, source: "system", unsupported: false };
}
