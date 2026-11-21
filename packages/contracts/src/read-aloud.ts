import { z } from "zod";
import { BotSettingsRevisionSchema } from "./bot-settings.js";
import { Id } from "./ids.js";

const source = z.enum(["bot", "space", "account", "system"]);
export const ReadAloudEffectiveSchema = z.object({ enabled: z.boolean(), source });
export type ReadAloudEffective = z.infer<typeof ReadAloudEffectiveSchema>;

const version = z.object({ value: z.boolean().nullable(), revision: BotSettingsRevisionSchema });
export const ReadAloudSettingsSchema = z.object({
  account: version,
  space: version,
  effective: ReadAloudEffectiveSchema,
  followingSpaces: z.array(z.object({ id: Id, name: z.string() })),
});
export type ReadAloudSettings = z.infer<typeof ReadAloudSettingsSchema>;

const write = {
  expectedRevision: BotSettingsRevisionSchema,
  clientNonce: z.string().min(1).max(128),
};

export const UpdateReadAloudInput = z.discriminatedUnion("scope", [
  z.strictObject({
    ...write,
    scope: z.literal("account"),
    value: z.boolean().nullable(),
    followingSpaceIds: z.array(Id),
  }),
  z.strictObject({
    ...write,
    scope: z.literal("space"),
    value: z.union([z.boolean(), z.literal("copy"), z.null()]),
    expectedAccountRevision: BotSettingsRevisionSchema,
  }),
]);
export type UpdateReadAloudInput = z.infer<typeof UpdateReadAloudInput>;

export const UpdateReadAloudResult = z.object({
  status: z.enum(["updated", "conflict"]),
  settings: ReadAloudSettingsSchema,
});

export type UpdateReadAloudResult = z.infer<typeof UpdateReadAloudResult>;

export const ReadAloudStoredVersionSchema = version.extend({
  clientNonce: write.clientNonce,
  requestHash: z.string(),
});

/** Null means to continue down the preference chain. False is an explicit choice. */
export function resolveReadAloud(
  bot: boolean | null,
  space: boolean | null,
  account: boolean | null,
): ReadAloudEffective {
  if (bot !== null) return { enabled: bot, source: "bot" };
  if (space !== null) return { enabled: space, source: "space" };
  if (account !== null) return { enabled: account, source: "account" };
  return { enabled: false, source: "system" };
}

export function isReadAloudConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("data" in error)) return false;
  const data = error.data;
  return Boolean(
    data && typeof data === "object" && "reason" in data && data.reason === "read_aloud_changed",
  );
}
