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

// The API route and the in-process reconciler share the runtime pool.
// Foreground callers wait here before opening a database transaction.
let teardownInFlight: Promise<void> | undefined;

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
  let after: Pick<GroupRunTeardownKey, "computerId" | "runId"> | undefined;
  const settle = async (key: GroupRunTeardownKey, eager: boolean) => {
    while (teardownInFlight) {
      if (!eager) return false;
      await teardownInFlight.catch(() => undefined);
    }
    const cleanup = runAsTenant(key, async () => {
      const pending = await completeGroupRunTeardownProviderPhase(
        deps.prisma,
        key,
        async (work) => {
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
    teardownInFlight = cleanup;
    try {
      await cleanup;
      return true;
    } finally {
      teardownInFlight = undefined;
    }
  };
  return {
    settle: (key: GroupRunTeardownKey) => settle(key, true),
    async reconcile() {
      if (teardownInFlight) return;
      const [pending] = await runAsSystem("find pending group run teardowns", () =>
        listPendingGroupRunTeardowns(deps.prisma, { after, limit: 1 }),
      );
      if (!pending) {
        after = undefined;
        return;
      }
      try {
        if (!(await settle(pending, false))) return;
      } catch (error) {
        getLogger().error("group run teardown retry", error);
      }
      after = pending;
    },
  };
}
