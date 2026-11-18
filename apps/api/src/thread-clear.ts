import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import { runJobKey } from "@rakazo/adapter-kit";
import type { MemoryProviderResolver } from "@rakazo/adapters";
import type { ClearThreadInput, PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export async function clearThreadConversation(
  deps: {
    prisma: Pick<PrismaClient, "spaceMemoryConfig">;
    events: Pick<ThreadEvents, "clearThread" | "markMemoryCleanupUnconfirmed">;
    jobs: Pick<JobPublisher, "cancel">;
    memoryProviders: MemoryProviderResolver;
  },
  input: ClearThreadInput,
  context: AdapterContext,
): Promise<{ ok: true; memoryCleanupUnconfirmed?: true }> {
  const cleared = await deps.events.clearThread(input);
  let unconfirmed = cleared.memoryCleanupUnconfirmed === true;
  const [configured] = await Promise.all([
    input.groupId
      ? Promise.resolve(null)
      : deps.memoryProviders.resolve(input.spaceId).catch((error) => {
          getLogger().error("semantic memory resolution after thread clear failed", error);
          unconfirmed = true;
          return null;
        }),
    Promise.all(
      cleared.cancelledRunIds.map((id) => deps.jobs.cancel(runJobKey(id)).catch(() => {})),
    ),
  ]);

  if (!input.groupId) {
    if (!configured && !unconfirmed) {
      try {
        // A saved connection disabled by its trust boundary is not an absent provider.
        unconfirmed = Boolean(
          await deps.prisma.spaceMemoryConfig.findUnique({
            where: { spaceId: input.spaceId },
            select: { spaceId: true },
          }),
        );
      } catch (error) {
        getLogger().error("semantic memory configuration after thread clear failed", error);
        unconfirmed = true;
      }
    }
    if (configured) {
      try {
        const purged = await configured.provider.purgeHistory(
          {
            botId: input.botId,
            generations: [
              Math.max(0, cleared.historyCompactionGeneration - 1),
              cleared.historyCompactionGeneration,
            ],
          },
          context,
        );
        if (!purged.ok) {
          getLogger().error("semantic memory purge after thread clear failed", purged.error);
          unconfirmed = true;
        }
      } catch (error) {
        getLogger().error("semantic memory purge after thread clear failed", error);
        unconfirmed = true;
      }
    }
    if (unconfirmed) await deps.events.markMemoryCleanupUnconfirmed(input);
  }
  return { ok: true, ...(unconfirmed ? { memoryCleanupUnconfirmed: true } : {}) };
}
