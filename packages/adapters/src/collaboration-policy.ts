import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { settleCollaborationDelivery } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type CollaborationEvents = { notify(threadId: string, seq: number): Promise<void> };
export interface PeerDispatchDeps {
  prisma: PrismaClient;
  events: CollaborationEvents;
  jobs: Pick<JobPublisher, "enqueue">;
}

/** Publish committed delivery changes without turning a missed wake into a replay. */
export async function notifyCollaborationNotices(
  events: CollaborationEvents,
  notices: ReadonlyArray<{ threadId: string; seq: number }>,
): Promise<void> {
  await Promise.all(
    notices.map(({ threadId, seq }) =>
      events.notify(threadId, seq).catch((error) => {
        getLogger().error("collaboration delivery notification", error);
      }),
    ),
  );
}

/** A delivery receipt is durable before its realtime notification is attempted. */
export async function settlePeerDelivery(
  deps: { prisma: PrismaClient; events: CollaborationEvents },
  runId: string,
  status: "completed" | "policy_disabled",
): Promise<void> {
  const notices = await settleCollaborationDelivery(deps.prisma, runId, status);
  await notifyCollaborationNotices(deps.events, notices);
}
