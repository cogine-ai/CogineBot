import type { Prisma } from "./client.js";

/** Any work that makes repeating the turn without a business recovery plan unsafe. */
export async function hasPriorRunWork(
  tx: Prisma.TransactionClient,
  source: { id: string; spaceId: string; threadId: string; botId: string },
): Promise<boolean> {
  const [tool, message, effect, steering] = await Promise.all([
    tx.event.findFirst({
      where: { runId: source.id, spaceId: source.spaceId, type: "agent.tool.called" },
      select: { id: true },
    }),
    tx.message.findFirst({
      where: { runId: source.id, threadId: source.threadId, role: "bot" },
      select: { id: true },
    }),
    tx.externalEffect.findFirst({
      where: { runId: source.id, spaceId: source.spaceId },
      select: { id: true },
    }),
    tx.steeringMessage.findFirst({
      where: { runId: source.id, botId: source.botId, claimedAt: { not: null } },
      select: { id: true },
    }),
  ]);
  return Boolean(tool || message || effect || steering);
}
