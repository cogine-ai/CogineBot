import type { PrismaClient } from "./client.js";

export const MAX_SELF_RECOVERIES_PER_RUN = 3;

/** Consume an output recovery while this worker still owns the running episode. */
export async function reserveRunSelfRecovery(
  prisma: Pick<PrismaClient, "run">,
  input: {
    runId: string;
    spaceId: string;
    leaseOwner: string;
    leaseFence: number;
    now?: Date;
  },
): Promise<boolean> {
  const reserved = await prisma.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      status: "running",
      leaseOwner: input.leaseOwner,
      leaseFence: input.leaseFence,
      leaseExpiresAt: { gt: input.now ?? new Date() },
      selfRecoveries: { lt: MAX_SELF_RECOVERIES_PER_RUN },
    },
    data: { selfRecoveries: { increment: 1 } },
  });
  return reserved.count === 1;
}
