import type {
  Actor,
  BotSettingsHistorySchema,
  BotSettingsValues,
  UndoBotSettingsInput,
} from "@rakazo/contracts";
import type { BotSettingsRow, Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  botSettingsValues,
  botSettingsVersions,
  describeBotSettingsChange,
  IsolationError,
  lockBotModelSetting,
  lockOwnedBotSettings,
  prepareBotSettingsVersion,
  withTransactionRetry,
  writeBotSettingsVersion,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type History = ReturnType<typeof BotSettingsHistorySchema.parse>;
type Setting = History["current"][number];

export function botSettingsHistory(
  row: BotSettingsRow,
  effective: Partial<Record<Setting["field"], Pick<Setting, "after" | "source">>> = {},
): History {
  const sources = {
    instructions: "bot",
    model: row.modelId ? "bot" : "space",
    thinkingLevel: row.thinkingLevel ? "bot" : "model",
    voice: row.voiceId ? "bot" : "space",
    readAloud: "bot",
  } as const;
  return {
    revision: row.settingsRevision,
    current: describeBotSettingsChange({}, botSettingsValues(row)).map(({ field, after }) => ({
      field,
      after,
      source: sources[field],
      ...effective[field],
    })),
    versions: botSettingsVersions(row).map((version) => ({
      id: version.id,
      revision: version.revision,
      createdAt: version.createdAt,
      changes: describeBotSettingsChange(version.before, version.after).map(
        (change) => version.changes?.find(({ field }) => field === change.field) ?? change,
      ),
      canUndo: version.revision === row.settingsRevision,
    })),
  };
}

export async function undoBotSettings(input: {
  prisma: PrismaClient;
  actor: Actor;
  threadId: string;
  request: ReturnType<typeof UndoBotSettingsInput.parse>;
  validate: (tx: Prisma.TransactionClient, values: BotSettingsValues) => Promise<boolean>;
  notify: (threadId: string, seq: number) => Promise<void>;
}) {
  const { prisma, actor, threadId, request, validate, notify } = input;
  const { botId, versionId, expectedRevision, clientNonce } = request;
  const committed = await withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockBotModelSetting(tx, botId);
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR NO KEY UPDATE`;
        const [member] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM space_members
      WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR SHARE`;
        if (!member) throw new IsolationError();
        const row = await lockOwnedBotSettings(tx, actor, botId);
        if (!row) throw new IsolationError();
        const versions = botSettingsVersions(row);
        const previous = versions.find((version) => version.undo?.clientNonce === clientNonce);
        if (previous?.undo?.versionId === versionId && previous.revision === expectedRevision + 1)
          return { result: { status: "updated" as const, revision: previous.revision } };
        const [latest] = versions;
        const conflict = (reason: "changed" | "connection") => ({
          result: { status: "conflict" as const, reason, history: botSettingsHistory(row) },
        });
        if (
          previous ||
          latest?.id !== versionId ||
          row.settingsRevision !== expectedRevision ||
          latest.revision !== expectedRevision
        )
          return conflict("changed");
        if (!(await validate(tx, latest.before))) return conflict("connection");
        const next = prepareBotSettingsVersion(row, latest.before, { versionId, clientNonce });
        if (!next) return conflict("changed");
        const changes = latest.changes?.map(({ field, before, after }) => ({
          field,
          before: after,
          after: before,
        }));
        const written = await writeBotSettingsVersion(tx, row, {
          ...next,
          ...(changes && { changes }),
        });
        const event = await appendEventInTransaction(tx, {
          spaceId: actor.spaceId,
          threadId,
          botId,
          type: "bot.updated",
          payload: {
            botId,
            name: written.name,
            title: written.title,
            description: written.description,
          },
        });
        return {
          seq: event.seq,
          result: { status: "updated" as const, revision: written.settingsRevision },
        };
      },
      { isolationLevel: "Serializable" },
    ),
  );
  if ("seq" in committed && committed.seq !== undefined)
    await notify(threadId, committed.seq).catch((error) =>
      getLogger().error("Settings undo notification", error),
    );
  return committed.result;
}
