import type { BotSettingsValues } from "@rakazo/contracts";
import { BotSettingsValuesSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  IsolationError,
  lockBotModelSetting,
  lockOwnedBotSettings,
  prepareBotSettingsVersion,
  withTransactionRetry,
  writeBotSettingsVersion,
} from "@rakazo/db";

export { lockBotModelSetting } from "@rakazo/db";

import { getLogger } from "@rakazo/logging";

type AppendEvent = typeof appendEventInTransaction;

export class BotInstructionsConflictError extends Error {
  constructor() {
    super("Instructions changed; review the current instructions first.");
    this.name = "BotInstructionsConflictError";
  }
}

/**
 * Persist a bot row. When profile metadata changes, write `bot.updated` in the same
 * transaction so clients can refresh the accepted profile and notification setting.
 * Realtime notify stays best-effort after commit.
 */
export async function commitBotUpdate(
  options: {
    prisma: PrismaClient;
    notify: (threadId: string, seq: number) => Promise<void>;
    spaceId: string;
    threadId: string;
    botId: string;
    data: Prisma.BotUncheckedUpdateInput;
    emitBotUpdated: boolean;
    expectedInstructions?: string;
    settingsOwnerId?: string;
    validate?: (tx: Prisma.TransactionClient) => Promise<void>;
  },
  appendEvent: AppendEvent = appendEventInTransaction,
): Promise<{ id: string; name: string; title: string; description: string }> {
  const update = async (client: Pick<Prisma.TransactionClient, "bot">) => {
    try {
      return await client.bot.update({
        where: {
          id: options.botId,
          spaceId: options.spaceId,
          ...(options.expectedInstructions !== undefined
            ? { instructions: options.expectedInstructions }
            : {}),
        },
        data: options.data,
        select: { id: true, name: true, title: true, description: true },
      });
    } catch (error) {
      // Only this guarded write's missing row means the accepted rules changed.
      if (
        options.expectedInstructions !== undefined &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2025"
      )
        throw new BotInstructionsConflictError();
      throw error;
    }
  };
  const changesModel =
    options.data.modelProvider !== undefined ||
    options.data.modelId !== undefined ||
    options.data.modelCredentialId !== undefined ||
    options.data.thinkingLevel !== undefined;
  const tracked: BotSettingsValues | undefined = options.settingsOwnerId
    ? BotSettingsValuesSchema.parse({
        instructions: options.data.instructions,
        modelProvider: options.data.modelProvider,
        modelId: options.data.modelId,
        modelCredentialId: options.data.modelCredentialId,
        thinkingLevel: options.data.thinkingLevel,
        voiceId: options.data.voiceId,
        autoSpeak: options.data.autoSpeak,
      })
    : undefined;
  const tracksChange = tracked && Object.values(tracked).some((value) => value !== undefined);
  if (!options.emitBotUpdated && !options.validate && !changesModel && !tracksChange)
    return update(options.prisma);

  const save = () =>
    options.prisma.$transaction(
      async (tx) => {
        if (changesModel) await lockBotModelSetting(tx, options.botId);
        if (options.emitBotUpdated || tracksChange)
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${options.threadId} FOR NO KEY UPDATE`;
        await options.validate?.(tx);
        const row =
          tracksChange && options.settingsOwnerId
            ? await lockOwnedBotSettings(
                tx,
                { spaceId: options.spaceId, userId: options.settingsOwnerId },
                options.botId,
              )
            : undefined;
        if (row === null) throw new IsolationError();
        if (
          row &&
          options.expectedInstructions !== undefined &&
          row.instructions !== options.expectedInstructions
        )
          throw new BotInstructionsConflictError();
        const version = row && tracked && prepareBotSettingsVersion(row, tracked);
        const updated =
          row && version
            ? await writeBotSettingsVersion(tx, row, version, options.data)
            : await update(tx);
        const event =
          options.emitBotUpdated || version
            ? await appendEvent(tx, {
                spaceId: options.spaceId,
                threadId: options.threadId,
                botId: options.botId,
                type: "bot.updated",
                payload: {
                  botId: updated.id,
                  name: updated.name,
                  title: updated.title,
                  description: updated.description,
                },
              })
            : undefined;
        return { updated, seq: event?.seq };
      },
      options.validate ? { isolationLevel: "Serializable" } : undefined,
    );
  const committed = options.validate ? await withTransactionRetry(save) : await save();

  if (committed.seq !== undefined)
    await options.notify(options.threadId, committed.seq).catch((error) => {
      getLogger().error("bot.updated realtime notification", error);
    });
  return committed.updated;
}

export function botProfileChanged(input: {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  instructions?: unknown;
  color?: unknown;
  notifyOnFinish?: unknown;
}): boolean {
  return (
    input.name !== undefined ||
    input.title !== undefined ||
    input.description !== undefined ||
    input.instructions !== undefined ||
    input.color !== undefined ||
    input.notifyOnFinish !== undefined
  );
}
