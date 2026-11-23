import { z } from "zod";
import { BotSettingsRevisionSchema } from "./bot-settings.js";
import { Id } from "./ids.js";

export const DefaultModelChoiceSchema = z.strictObject({
  provider: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
});
export type DefaultModelChoice = z.infer<typeof DefaultModelChoiceSchema>;

export function defaultModelChoiceKey({ provider, modelId }: DefaultModelChoice) {
  return JSON.stringify([provider, modelId]);
}

const accountVersion = z.object({
  value: DefaultModelChoiceSchema.nullable(),
  revision: BotSettingsRevisionSchema,
});
const spaceVersion = z.object({
  value: z.boolean(),
  revision: BotSettingsRevisionSchema,
});
const receipt = z.object({ clientNonce: z.string().min(1).max(128), requestHash: z.string() });
export const AccountModelDefaultHistory = accountVersion.extend({ receipt }).array();
export const SpaceModelDefaultHistory = spaceVersion
  .extend({
    receipt: receipt.optional(),
    choice: DefaultModelChoiceSchema.optional(),
  })
  .array();

export const ModelDefaultsSchema = z.object({
  account: accountVersion,
  space: spaceVersion,
  effective: z.object({
    choice: DefaultModelChoiceSchema.nullable(),
    source: z.enum(["space", "account", "system"]),
    unavailable: z.enum(["missing", "ambiguous"]).nullable(),
  }),
  choices: z.array(DefaultModelChoiceSchema),
  followingSpaces: z.array(z.object({ id: Id, name: z.string() })),
});
export type ModelDefaults = z.infer<typeof ModelDefaultsSchema>;

const write = {
  expectedRevision: BotSettingsRevisionSchema,
  clientNonce: receipt.shape.clientNonce,
};
export const UpdateModelDefaultsInput = z.discriminatedUnion("scope", [
  z.strictObject({
    ...write,
    scope: z.literal("account"),
    value: DefaultModelChoiceSchema.nullable(),
    followingSpaceIds: z.array(Id),
  }),
  z.strictObject({
    ...write,
    scope: z.literal("space"),
    enabled: z.boolean(),
    expectedAccountRevision: BotSettingsRevisionSchema,
    expectedChoice: DefaultModelChoiceSchema.nullable(),
  }),
]);
export type UpdateModelDefaultsInput = z.infer<typeof UpdateModelDefaultsInput>;

export const UpdateModelDefaultsResult = z.object({
  status: z.enum(["updated", "conflict", "unavailable"]),
  settings: ModelDefaultsSchema,
});
export type UpdateModelDefaultsResult = z.infer<typeof UpdateModelDefaultsResult>;

export const UNAVAILABLE_PERSONAL_MODEL =
  "Choose a model connection in this Space to use your default model.";
