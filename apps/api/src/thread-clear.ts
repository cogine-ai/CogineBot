import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import { runJobKey } from "@rakazo/adapter-kit";
import type { MemoryProviderResolver } from "@rakazo/adapters";
import type { ClearThreadInput, MemoryCleanupState, PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export async function clearThreadConversation(
  deps: {
    prisma: Pick<PrismaClient, "spaceMemoryConfig">;
    events: Pick<ThreadEvents, "clearThread" | "settleMemoryCleanup">;
    jobs: Pick<JobPublisher, "cancel">;
    memoryProviders: MemoryProviderResolver;
  },
  input: ClearThreadInput,
  context: AdapterContext,
): Promise<{ ok: true; threadId: string } & MemoryCleanupState> {
  let cleanupExpected = false;
  if (!input.groupId) {
    try {
      cleanupExpected = Boolean(
        await deps.prisma.spaceMemoryConfig.findUnique({
          where: { spaceId: input.spaceId },
          select: { spaceId: true },
        }),
      );
    } catch (error) {
      getLogger().error("semantic memory configuration before thread clear failed", error);
      cleanupExpected = true;
    }
  }
  const cleared = await deps.events.clearThread({
    ...input,
    ...(cleanupExpected ? { memoryCleanupExpected: true } : {}),
  });
  let state: MemoryCleanupState = {
    memoryCleanupCursor: cleared.event.seq,
    ...(cleared.memoryCleanupUnconfirmed ? { memoryCleanupUnconfirmed: true } : {}),
    memoryCleanupPending: cleared.memoryCleanupPending === true,
  };
  await Promise.all(
    cleared.cancelledRunIds.map((id) => deps.jobs.cancel(runJobKey(id)).catch(() => {})),
  );
  if (cleared.cleanup) {
    let unconfirmed = false;
    try {
      const configured = await deps.memoryProviders.resolve(input.spaceId);
      if (!configured) {
        unconfirmed = true;
      } else {
        const result = await configured.provider.purgeHistory(
          { botId: input.botId, generations: cleared.cleanup.generations },
          context,
        );
        unconfirmed = !result.ok;
        if (!result.ok)
          getLogger().error("semantic memory purge after thread clear failed", result.error);
      }
    } catch (error) {
      getLogger().error("semantic memory cleanup after thread clear failed", error);
      unconfirmed = true;
    }
    try {
      const settled = await deps.events.settleMemoryCleanup({
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        token: cleared.cleanup.token,
        unconfirmed,
      });
      state = { ...settled, memoryCleanupCursor: settled.memoryCleanupCursor ?? cleared.event.seq };
    } catch (error) {
      // The destructive transaction already committed its intent. Keep that truthful receipt.
      getLogger().error("semantic memory cleanup settlement failed", error);
      state = {
        ...state,
        ...(unconfirmed ? { memoryCleanupUnconfirmed: true } : {}),
        memoryCleanupPending: true,
      };
    }
  }
  return { ok: true, threadId: input.threadId, ...state };
}
