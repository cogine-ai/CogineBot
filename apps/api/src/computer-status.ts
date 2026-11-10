import type { SandboxProvider } from "@rakazo/adapter-kit";
import {
  computerRecoveryProviderUnavailable,
  computerStopClaimIsStale,
  computerSupportsTerminal,
  computerSupportsUpdate,
  toComputerRef,
} from "@rakazo/adapters";
import type { ComputerStatus } from "@rakazo/contracts";
import { COMPUTER_ACTIVE_RUN_STATUSES, computerScreenSize } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** Mirrors computer.takeover: an execution lease blocks user control unless a takeover is pending. */
export function executionBlocksUserTakeover(input: {
  hasLease: boolean;
  leaseExpiresAt: Date | null | undefined;
  runStatus: string | null | undefined;
  now?: number;
  takeoverRequested?: boolean;
}): boolean {
  if (!input.hasLease) return false;
  if (input.runStatus === "waiting_takeover" || input.takeoverRequested) return false;
  const now = input.now ?? Date.now();
  const leaseActive = Boolean(input.leaseExpiresAt && input.leaseExpiresAt.getTime() > now);
  const runActive = Boolean(
    input.runStatus &&
      (COMPUTER_ACTIVE_RUN_STATUSES as readonly string[]).includes(input.runStatus),
  );
  return leaseActive || runActive;
}

export async function resolveBusyBotName(
  prisma: PrismaClient,
  input: {
    computerId: string | null | undefined;
    botId: string;
    botName: string;
  },
): Promise<string | null> {
  if (!input.computerId) return null;
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId: input.computerId, botId: input.botId } },
    select: { expiresAt: true, runId: true, computer: { select: { controlRunId: true } } },
  });
  if (!lease) return null;
  const run = await prisma.run.findUnique({
    where: { id: lease.runId },
    select: { status: true },
  });
  return executionBlocksUserTakeover({
    hasLease: true,
    leaseExpiresAt: lease.expiresAt,
    runStatus: run?.status,
    takeoverRequested: lease.computer.controlRunId === lease.runId,
  })
    ? input.botName
    : null;
}

export function toComputerStatus(
  botId: string,
  computer: {
    kind: string;
    homeKey?: string;
    providerRef?: string | null;
    providerAuthority?: string | null;
    state: string;
    scope: string;
    controlHolder: string;
    controlBotId?: string | null;
    controlRunId?: string | null;
    homeRevision: string;
    maintenanceId?: string | null;
    stopRequestedAt?: Date | null;
    updatedAt?: Date;
  } | null,
  busyBotName: string | null = null,
  sandbox?: SandboxProvider,
): ComputerStatus {
  let state: ComputerStatus["state"];
  switch (computer?.state) {
    case "quarantined":
    case "needs_recovery":
      state = computer.state;
      break;
    case "restoring":
      state = computerStopClaimIsStale(computer.updatedAt) ? "quarantined" : "booting";
      break;
    case "suspending":
      state = "stopping";
      break;
    case "stopped":
    case "booting":
    case "running":
    case "suspended":
    case "error":
      state = computer.maintenanceId ? "booting" : computer.state;
      break;
    default:
      state = "stopped";
  }
  if (computer?.stopRequestedAt) {
    state = computerStopClaimIsStale(computer.stopRequestedAt) ? "quarantined" : "stopping";
  }
  const recoveryBlocked =
    computer?.providerRef &&
    computer.homeKey !== undefined &&
    computerRecoveryProviderUnavailable(
      sandbox,
      toComputerRef({ ...computer, providerRef: computer.providerRef, homeKey: computer.homeKey }),
    );
  if (recoveryBlocked && state !== "stopping" && state !== "booting") state = "quarantined";
  const powerState =
    state === "stopping" || state === "quarantined" || state === "needs_recovery"
      ? state
      : undefined;
  const unavailable = powerState !== undefined;
  const screenAvailable =
    !recoveryBlocked &&
    !computer?.maintenanceId &&
    computer?.state !== "restoring" &&
    (state === "running" || state === "booting");
  const screen = computerScreenSize(computer?.kind);
  const kind = (computer?.kind ?? "fake") as ComputerStatus["kind"];
  return {
    botId,
    mode: computer?.scope === "dedicated" ? "dedicated" : "team",
    kind,
    state: unavailable ? "error" : state,
    ...(powerState ? { powerState } : {}),
    ...(recoveryBlocked ? { recoveryBlocked: true } : {}),
    controlHolder: (unavailable
      ? "none"
      : (computer?.controlHolder ?? "none")) as ComputerStatus["controlHolder"],
    controlBotId: unavailable ? null : (computer?.controlBotId ?? null),
    takeoverRequested: !unavailable && Boolean(computer?.controlRunId),
    screenAvailable,
    screenWidth: screen.width,
    screenHeight: screen.height,
    homeRevision: computer?.homeRevision ?? null,
    busyBotName,
    canUpdate: !unavailable && !recoveryBlocked && computerSupportsUpdate(kind),
    terminalAvailable: computerSupportsTerminal(kind),
  };
}
