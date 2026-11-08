import type { AdapterContext, SandboxProvider } from "@rakazo/adapter-kit";
import type { GroupRunTeardownKey, PrismaClient } from "@rakazo/db";
import {
  completeGroupRunTeardownProviderPhase,
  finishPendingGroupRunTeardown,
  listPendingGroupRunTeardowns,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cancelComputerRunWork } from "./computer-idle.js";
import { screenLeaseIdForRun, toComputerRef } from "./computer-lifecycle.js";

type Sandbox = Pick<SandboxProvider, "execute" | "releaseScreen">;

export async function stopCancelledGroupComputer(
  sandbox: Sandbox,
  owner: { spaceId: string; userId: string },
  computer: {
    id: string;
    homeKey: string;
    kind: string;
    providerRef: string | null;
    botId: string;
    runId: string;
    fence: number;
  },
  options?: { onlyIfRunning: true; screenOnly?: boolean },
) {
  if (!computer.providerRef) return;
  const context: AdapterContext = {
    operationId: "stop",
    traceId: "stop",
    spaceId: owner.spaceId,
    userId: owner.userId,
    botId: computer.botId,
    runId: computer.runId,
    screenLeaseId: screenLeaseIdForRun(computer, computer.runId),
    cancelRunWork: true,
    signal: options ? AbortSignal.timeout(30_000) : new AbortController().signal,
  };
  const ref = toComputerRef(computer);
  if (!options?.screenOnly)
    await cancelComputerRunWork(sandbox, ref, computer.id, computer.runId, context);
  if (options) await sandbox.releaseScreen?.(ref, context, { onlyIfRunning: true });
  else await sandbox.releaseScreen?.(ref, context);
}

export function createGroupRunTeardownRecovery(deps: { prisma: PrismaClient; sandbox: Sandbox }) {
  const limit = 2;
  let after: Pick<GroupRunTeardownKey, "computerId" | "runId"> | undefined;
  const settle = (key: GroupRunTeardownKey, eager: boolean) =>
    runAsTenant(key, async () => {
      const pending = await completeGroupRunTeardownProviderPhase(
        deps.prisma,
        key,
        async (work) => {
          if (!work.providerCleanup) return;
          // Generic shell exec can start a stopped provider. A restarted cleanup
          // may only revisit the old screen through the provider's no-wake path.
          await stopCancelledGroupComputer(
            deps.sandbox,
            { spaceId: key.spaceId, userId: work.marker.userId },
            {
              ...work.computer,
              botId: work.marker.botId,
              runId: key.runId,
              fence: work.marker.canonicalFence ?? 0,
            },
            { onlyIfRunning: true, screenOnly: !eager },
          );
        },
      );
      if (pending) await finishPendingGroupRunTeardown(deps.prisma, key, pending);
    });
  return {
    settle: (key: GroupRunTeardownKey) => settle(key, true),
    async reconcile() {
      const pending = await runAsSystem("find pending group run teardowns", () =>
        listPendingGroupRunTeardowns(deps.prisma, { after, limit }),
      );
      after = pending.length === limit ? pending.at(-1) : undefined;
      const results = await Promise.allSettled(pending.map((key) => settle(key, false)));
      for (const result of results) {
        if (result.status === "rejected")
          getLogger().error("group run teardown retry", result.reason);
      }
    },
  };
}
