import { z } from "zod";
import { Id } from "./ids.js";

export const BOT_INSTRUCTIONS_MAX_LENGTH = 20000;

export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const BotSettingsValuesSchema = z.strictObject({
  instructions: z.string().max(BOT_INSTRUCTIONS_MAX_LENGTH).optional(),
  modelProvider: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  modelCredentialId: Id.nullable().optional(),
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
  voiceId: z.string().nullable().optional(),
  autoSpeak: z.boolean().optional(),
});
export type BotSettingsValues = z.infer<typeof BotSettingsValuesSchema>;

export const BotSettingsChangeSchema = z.object({
  field: z.enum(["instructions", "model", "thinkingLevel", "voice", "readAloud"]),
  before: z.string(),
  after: z.string(),
});
export type BotSettingsChange = z.infer<typeof BotSettingsChangeSchema>;

export const BotSettingsRevisionSchema = z.number().int().nonnegative();

export const BotSettingsCardSchema = z.object({
  botId: Id,
  botName: z.string(),
  changes: z.array(BotSettingsChangeSchema).min(1).max(5),
  versionId: Id.optional(),
  revision: BotSettingsRevisionSchema.optional(),
  playback: z.literal("device_if_enabled").optional(),
});

export const BotSettingsHistorySchema = z.object({
  revision: BotSettingsRevisionSchema,
  current: z.array(
    BotSettingsChangeSchema.pick({ field: true, after: true }).extend({
      source: z.enum(["bot", "space", "system", "model"]),
    }),
  ),
  versions: z.array(
    z.object({
      id: Id,
      revision: BotSettingsRevisionSchema,
      createdAt: z.string(),
      changes: z.array(BotSettingsChangeSchema),
      canUndo: z.boolean(),
    }),
  ),
});

export const UndoBotSettingsInput = z.strictObject({
  botId: Id,
  versionId: Id,
  expectedRevision: BotSettingsRevisionSchema,
  clientNonce: z.string().min(1).max(128),
});

export const BotSettingsStoredVersionSchema = z.object({
  id: Id,
  revision: BotSettingsRevisionSchema,
  createdAt: z.string(),
  before: BotSettingsValuesSchema,
  after: BotSettingsValuesSchema,
  changes: z.array(BotSettingsChangeSchema).optional(),
  undo: z.object({ versionId: Id, clientNonce: z.string() }).optional(),
});

export const UndoBotSettingsResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("updated"), revision: BotSettingsRevisionSchema }),
  z.object({
    status: z.literal("conflict"),
    reason: z.enum(["changed", "connection"]),
    history: BotSettingsHistorySchema,
  }),
]);

/** The non-secret model binding and instructions already supplied to the Run. */
export const BotSettingsRunSnapshot = z.object({
  instructions: z.string(),
  revision: BotSettingsRevisionSchema,
  modelProvider: z.string(),
  modelId: z.string(),
  modelCredentialId: Id.nullable(),
  connectionRevision: z.number().int().nullable(),
  thinkingLevel: ThinkingLevelSchema.nullable(),
});
