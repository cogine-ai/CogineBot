import type { Prisma, PrismaClient } from "@rakazo/db";
import { appendEventInTransaction, withTransactionRetry } from "@rakazo/db";
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
  if (!options.emitBotUpdated && !options.validate) return update(options.prisma);

  const save = () =>
    options.prisma.$transaction(
      async (tx) => {
        await options.validate?.(tx);
        const updated = await update(tx);
        const event = options.emitBotUpdated
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
