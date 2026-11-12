import { randomUUID } from "node:crypto";
import type { Actor, BotSettingsChange, BotSettingsValues } from "@rakazo/contracts";
import { BotSettingsStoredVersionSchema, BotSettingsValuesSchema } from "@rakazo/contracts";
import type { Bot, Prisma } from "./client.js";

type SettingsVersion = ReturnType<typeof BotSettingsStoredVersionSchema.parse>;

export const botSettingsSelect = {
  id: true,
  name: true,
  instructions: true,
  modelProvider: true,
  modelId: true,
  modelCredentialId: true,
  thinkingLevel: true,
  voiceId: true,
  autoSpeak: true,
  settingsRevision: true,
  settingsHistory: true,
} as const satisfies Prisma.BotSelect;

export type BotSettingsRow = Pick<Bot, keyof typeof botSettingsSelect>;

export function botSettingsValues(row: BotSettingsRow): BotSettingsValues {
  return BotSettingsValuesSchema.parse({
    instructions: row.instructions,
    modelProvider: row.modelProvider,
    modelId: row.modelId,
    modelCredentialId: row.modelCredentialId,
    thinkingLevel: row.thinkingLevel,
    voiceId: row.voiceId,
    autoSpeak: row.autoSpeak,
  });
}

export function botSettingsVersions(row: BotSettingsRow) {
  return BotSettingsStoredVersionSchema.array().parse(row.settingsHistory);
}

export function describeBotSettingsChange(
  before: BotSettingsValues,
  after: BotSettingsValues,
): BotSettingsChange[] {
  const changes: BotSettingsChange[] = [];
  const model = (value: BotSettingsValues) =>
    value.modelProvider && value.modelId
      ? `${value.modelProvider}/${value.modelId}`
      : "Space default";
  if (after.instructions !== undefined)
    changes.push({
      field: "instructions",
      before: before.instructions ?? "",
      after: after.instructions,
    });
  if (after.modelId !== undefined)
    changes.push({ field: "model", before: model(before), after: model(after) });
  if (after.thinkingLevel !== undefined)
    changes.push({
      field: "thinkingLevel",
      before: before.thinkingLevel ?? "Model default",
      after: after.thinkingLevel ?? "Model default",
    });
  if (after.voiceId !== undefined)
    changes.push({
      field: "voice",
      before: before.voiceId ?? "Space default",
      after: after.voiceId ?? "Space default",
    });
  if (after.autoSpeak !== undefined)
    changes.push({
      field: "readAloud",
      before: before.autoSpeak ? "On" : "Off",
      after: after.autoSpeak ? "On" : "Off",
    });
  return changes;
}

/** Use the same model lock for chat, Settings and attachment admission. */
export async function lockBotModelSetting(tx: Prisma.TransactionClient, botId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`bot-model:${botId}`}, 2))::text`;
}

/** Event writers lock the thread first, then the Bot row. */
export async function lockOwnedBotSettings(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "userId" | "spaceId">,
  botId: string,
) {
  await tx.$queryRaw`SELECT id FROM bots
    WHERE id = ${botId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}
      AND "archivedAt" IS NULL FOR NO KEY UPDATE`;
  return tx.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: botSettingsSelect,
  });
}

export function prepareBotSettingsVersion(
  row: BotSettingsRow,
  patch: BotSettingsValues,
  undo?: SettingsVersion["undo"],
): SettingsVersion | undefined {
  const current = botSettingsValues(row);
  const keys = Object.keys(patch) as Array<keyof BotSettingsValues>;
  const changed = keys.filter((key) => patch[key] !== undefined && patch[key] !== current[key]);
  if (!changed.length) return;
  const modelKeys = ["modelProvider", "modelId", "modelCredentialId"] as const;
  const included = new Set<keyof BotSettingsValues>(
    modelKeys.some((key) => changed.includes(key)) ? [...changed, ...modelKeys] : changed,
  );
  const before = Object.fromEntries([...included].map((key) => [key, current[key]]));
  const after = Object.fromEntries(
    [...included].map((key) => [key, patch[key] === undefined ? current[key] : patch[key]]),
  );
  return {
    id: randomUUID(),
    revision: row.settingsRevision + 1,
    createdAt: new Date().toISOString(),
    before,
    after,
    ...(undo && { undo }),
  };
}

/** The caller holds the Bot row. The trigger advances the revision for every settings writer. */
export async function writeBotSettingsVersion(
  tx: Prisma.TransactionClient,
  row: BotSettingsRow,
  version: SettingsVersion,
  other: Prisma.BotUncheckedUpdateInput = {},
) {
  return tx.bot.update({
    where: { id: row.id, settingsRevision: row.settingsRevision },
    data: {
      ...other,
      ...version.after,
      settingsHistory: [version, ...botSettingsVersions(row)].slice(0, 20),
    },
    select: { id: true, name: true, title: true, description: true, settingsRevision: true },
  });
}
