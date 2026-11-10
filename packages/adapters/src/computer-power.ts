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

export function matchesComputerProvider(sandbox: SandboxProvider, ref: ComputerRef): boolean {
  return !ref.providerAuthority || sandbox.providerAuthority?.(ref.kind) === ref.providerAuthority;
}

function powerProvider(sandbox: SandboxProvider, ref: ComputerRef): SandboxProvider | undefined {
  if (!matchesComputerProvider(sandbox, ref)) return undefined;
  return sandbox.providerForPower ? sandbox.providerForPower(ref) : sandbox;
}

export function needsProviderIdentityProof(sandbox: SandboxProvider, ref: ComputerRef): boolean {
  return Boolean(
    sandbox.providerForPower &&
      !ref.providerAuthority &&
      ref.kind !== "desktop" &&
      ref.kind !== "fake",
  );
}

export function canTrustComputerGoneError(sandbox: SandboxProvider, ref: ComputerRef): boolean {
  return matchesComputerProvider(sandbox, ref) && !needsProviderIdentityProof(sandbox, ref);
}

export async function matchesComputerProvisionRoute(
  sandbox: SandboxProvider,
  ref: ComputerRef,
): Promise<boolean> {
  if (!matchesComputerProvider(sandbox, ref)) return false;
  if (!sandbox.providerForPower) return true;
  const kind = (await sandbox.provisionKind?.()) ?? sandbox.describe().id;
  return kind === ref.kind;
}

async function verifyComputerProvider(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  context: AdapterContext,
): Promise<void> {
  if (!needsProviderIdentityProof(sandbox, ref)) return;
  const current = await inspectComputerPower(sandbox, ref, context);
  if (current !== "running" && current !== "stopped") {
    throw new Error("The original computer could not be verified at this provider");
  }
}

/** Raw evidence for callers that need to distinguish a missing resource from a failed probe. */
export async function probeComputerPower(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  context: AdapterContext,
): Promise<SandboxPowerState> {
  const provider = powerProvider(sandbox, ref);
  if (!provider?.inspectPowerState || context.signal.aborted) return "unknown";
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]);
  try {
    return await withAbort(provider.inspectPowerState(ref, { ...context, signal }), signal);
  } catch {
    return "unknown";
  }
}

export async function inspectComputerPower(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  context: AdapterContext,
): Promise<SandboxPowerState> {
  const state = await probeComputerPower(sandbox, ref, context);
  return state === "gone" && needsProviderIdentityProof(sandbox, ref) ? "unknown" : state;
}

export function computerRecoveryProviderUnavailable(
  sandbox: SandboxProvider | undefined,
  ref: ComputerRef,
): boolean {
  return Boolean(sandbox && !powerProvider(sandbox, ref));
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
  const provider = powerProvider(deps.sandbox, ref);
  if (!provider) throw new Error("The original computer provider is unavailable");
  await verifyComputerProvider(deps.sandbox, ref, context);
  let exported = false;
  let stagingFailed = false;
  try {
    await checkpointAndRecordComputerWorkspace(
      { ...deps, sandbox: provider },
      computer,
      ref,
      context,
      {
        claim,
        onExported: () => {
          exported = true;
        },
        onStagingFailure: () => {
          stagingFailed = true;
        },
      },
    );
    return undefined;
  } catch (error) {
    if (!exported && !stagingFailed && !context.signal.aborted) {
      if (isSandboxDamaged(error)) return "damaged";
      if (
        !isSandboxUnsafeStop(error) &&
        ((ref.kind === "e2b" &&
          canTrustComputerGoneError(deps.sandbox, ref) &&
          isSandboxGoneError(error)) ||
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

/** Persist the exact target before crossing the provider boundary. */
export async function markClaimedComputerStop(
  prisma: PrismaClient,
  claim: Prisma.ComputerWhereInput & { updatedAt: Date },
  context: AdapterContext,
  target?: { providerRef: string; kind: ComputerRef["kind"]; providerAuthority?: string | null },
): Promise<void> {
  context.signal.throwIfAborted();
  const pending = await prisma.computer.updateMany({
    where: { ...claim, stopRequestedAt: null },
    data: { ...target, stopRequestedAt: new Date(), updatedAt: claim.updatedAt },
  });
  if (pending.count !== 1) throw new ComputerCheckpointChangedError();
}

export async function requestClaimedComputerStop(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  claim: Prisma.ComputerWhereInput & { updatedAt: Date },
  ref: ComputerRef,
  context: AdapterContext,
  operation: "stop" | "destroy" = "stop",
  options?: Parameters<SandboxProvider["destroy"]>[2],
): Promise<"stopped" | "gone"> {
  await markClaimedComputerStop(deps.prisma, claim, context);
  return confirmComputerStop(deps.sandbox, ref, context, operation, options);
}

export async function confirmComputerStop(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  context: AdapterContext,
  operation: "stop" | "destroy" = "stop",
  options?: Parameters<SandboxProvider["destroy"]>[2],
): Promise<"stopped" | "gone"> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]);
  try {
    signal.throwIfAborted();
    const provider = powerProvider(sandbox, ref);
    if (!provider) throw new Error("The original computer provider is unavailable");
    await verifyComputerProvider(sandbox, ref, context);
    const providerContext = { ...context, signal };
    const request =
      operation === "destroy" && options
        ? provider.destroy(ref, providerContext, options)
        : provider[operation](ref, providerContext);
    const outcome = await withAbort(Promise.resolve(request), signal);
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
