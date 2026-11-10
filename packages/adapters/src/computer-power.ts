import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  SandboxPowerState,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { SandboxUnsafeStopError } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  ComputerCheckpointChangedError,
  checkpointAndRecordComputerWorkspace,
} from "./computer-workspace.js";
import { isSandboxGoneError } from "./e2b-sandbox.js";
import { withAbort } from "./web-ssrf.js";

export const stoppedComputerControl = {
  controlHolder: "none",
  controlLeaseId: null,
  controlLeaseExpiresAt: null,
  controlBotId: null,
  controlRunId: null,
} as const;

export async function inspectComputerPower(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  context: AdapterContext,
): Promise<SandboxPowerState> {
  if (!sandbox.inspectPowerState || context.signal.aborted) return "unknown";
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]);
  return withAbort(sandbox.inspectPowerState(ref, { ...context, signal }), signal).catch(
    () => "unknown" as const,
  );
}

/** Match the provider before deciding that a stopped computer needs no new export. */
export async function savedComputerPowerState(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  computer: {
    id: string;
    spaceId: string;
    homeRevisionAt?: Date | null;
    restorePending?: boolean;
    controlHolder: string;
  },
  ref: ComputerRef,
  context: AdapterContext,
): Promise<"stopped" | "gone" | undefined> {
  const state = await inspectComputerPower(deps.sandbox, ref, context);
  if (state === "gone") return state;
  const savedAt = computer.homeRevisionAt;
  if (
    state !== "stopped" ||
    !savedAt ||
    computer.restorePending ||
    computer.controlHolder === "user"
  ) {
    return undefined;
  }
  const bots = { computerId: computer.id };
  const assigned = await deps.prisma.bot.findMany({ where: bots, select: { id: true } });
  const [run, takeover] = await Promise.all([
    deps.prisma.run.findFirst({
      where: { bot: bots, updatedAt: { gt: savedAt } },
      select: { id: true },
    }),
    deps.prisma.event.findFirst({
      where: {
        spaceId: computer.spaceId,
        botId: { in: assigned.map(({ id }) => id) },
        type: "computer.takeover.granted",
        createdAt: { gt: savedAt },
      },
      select: { id: true },
    }),
  ]);
  return run || takeover ? undefined : "stopped";
}

export async function saveComputerBeforeStop(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider; home: AgentHomeStore },
  computer: Parameters<typeof checkpointAndRecordComputerWorkspace>[1] &
    Parameters<typeof savedComputerPowerState>[1],
  ref: ComputerRef,
  context: AdapterContext,
  claim: Prisma.ComputerWhereInput,
): Promise<"stopped" | "gone" | "damaged" | undefined> {
  const state = await savedComputerPowerState(deps, computer, ref, context);
  if (state || computer.restorePending) return state;
  return checkpointComputerBeforeStop(deps, computer, ref, context, claim);
}

/** Only loss during the provider export can fall back to the previous revision. */
export async function checkpointComputerBeforeStop(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider; home: AgentHomeStore },
  computer: Parameters<typeof checkpointAndRecordComputerWorkspace>[1],
  ref: ComputerRef,
  context: AdapterContext,
  claim: Prisma.ComputerWhereInput,
): Promise<"gone" | "damaged" | undefined> {
  let exported = false;
  let stagingFailed = false;
  try {
    await checkpointAndRecordComputerWorkspace(deps, computer, ref, context, {
      claim,
      onExported: () => {
        exported = true;
      },
      onStagingFailure: () => {
        stagingFailed = true;
      },
    });
    return undefined;
  } catch (error) {
    if (!exported && !stagingFailed && !context.signal.aborted) {
      if (isSandboxDamaged(error)) return "damaged";
      if (
        !isSandboxUnsafeStop(error) &&
        ((ref.kind === "e2b" && isSandboxGoneError(error)) ||
          (await inspectComputerPower(deps.sandbox, ref, context)) === "gone")
      ) {
        return "gone";
      }
    }
    throw error;
  }
}

export async function publishComputerPowerStatus(
  deps: { prisma: PrismaClient; events: ThreadEvents },
  computer: { id: string; spaceId: string },
  status: "stopped" | "suspended" | "needs_recovery" | "quarantined",
): Promise<void> {
  const bots = await deps.prisma.bot.findMany({
    where: { computerId: computer.id },
    select: { id: true, thread: { select: { id: true } } },
  });
  for (const bot of bots) {
    if (!bot.thread) continue;
    await deps.events.append({
      spaceId: computer.spaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "computer.status",
      payload:
        status === "quarantined" || status === "needs_recovery"
          ? { status: "error", powerState: status }
          : { status },
    });
  }
}

/** Record the in-flight request before crossing the provider boundary. */
export async function requestClaimedComputerStop(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  claim: Prisma.ComputerWhereInput & { updatedAt: Date },
  ref: ComputerRef,
  context: AdapterContext,
  operation: "stop" | "destroy" = "stop",
  releaseScreen = false,
): Promise<"stopped" | "gone"> {
  context.signal.throwIfAborted();
  const pending = await deps.prisma.computer.updateMany({
    where: { ...claim, stopRequestedAt: null },
    data: { stopRequestedAt: new Date(), updatedAt: claim.updatedAt },
  });
  if (pending.count !== 1) throw new ComputerCheckpointChangedError();
  if (releaseScreen) {
    await deps.sandbox
      .releaseScreen?.(ref, context, { onlyIfRunning: true })
      .catch(() => undefined);
  }
  return confirmComputerStop(deps.sandbox, ref, context, operation);
}

export async function confirmComputerStop(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  context: AdapterContext,
  operation: "stop" | "destroy" = "stop",
): Promise<"stopped" | "gone"> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]);
  try {
    signal.throwIfAborted();
    const outcome = await withAbort(
      Promise.resolve(sandbox[operation](ref, { ...context, signal })),
      signal,
    );
    return operation === "destroy" || outcome === "gone" ? "gone" : "stopped";
  } catch (error) {
    if (hasErrorName(error, "SandboxNotFoundError") && !isSandboxUnsafeStop(error)) return "gone";
    const state = await inspectComputerPower(sandbox, ref, context);
    // A paused resource can still receive a delayed stop. Only confirmed absence is conclusive.
    if (state === "gone") return state;
    throw new SandboxUnsafeStopError(error);
  }
}

function hasErrorName(error: unknown, name: string): boolean {
  const seen = new Set<Error>();
  for (
    let current = error;
    current instanceof Error && !seen.has(current);
    current = current.cause
  ) {
    if (current.name === name) return true;
    seen.add(current);
  }
  return false;
}

export function isSandboxUnsafeStop(error: unknown): boolean {
  return hasErrorName(error, "SandboxUnsafeStopError");
}

export function isSandboxDamaged(error: unknown): boolean {
  return !isSandboxUnsafeStop(error) && hasErrorName(error, "SandboxDamagedError");
}
