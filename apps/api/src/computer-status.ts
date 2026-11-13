import type { SandboxProvider } from "@rakazo/adapter-kit";
import {
  computerActiveDeadline,
  computerActiveEpoch,
  computerRecoveryProviderUnavailable,
  computerStopClaimIsStale,
  computerSupportsTerminal,
  computerSupportsUpdate,
  powerProvider,
  toComputerRef,
} from "@rakazo/adapters";
import type { ComputerStatus } from "@rakazo/contracts";
import { WorkspaceSaveFailureReasonSchema, WorkspaceSaveProgressSchema } from "@rakazo/contracts";
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
    runningSince?: Date | null;
    runningObservedAt?: Date | null;
    suspensionReason?: string | null;
    workspaceSaveProgress?: unknown;
    workspaceSaveFailure?: unknown;
  } | null,
  busyBotName: string | null = null,
  sandbox?: SandboxProvider,
): ComputerStatus {
  const kind = (computer?.kind ?? "fake") as ComputerStatus["kind"];
  const mode = computer?.scope === "dedicated" ? "dedicated" : "team";
  const screen = computerScreenSize(computer?.kind);
  if (kind === "none") {
    return {
      botId,
      mode,
      kind,
      state: "stopped",
      controlHolder: "none",
      controlBotId: null,
      takeoverRequested: false,
      screenAvailable: false,
      screenWidth: screen.width,
      screenHeight: screen.height,
      homeRevision: computer?.homeRevision ?? null,
      busyBotName: null,
      canUpdate: false,
      terminalAvailable: false,
    };
  }
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
  const ref =
    computer?.providerRef && computer.homeKey !== undefined
      ? toComputerRef({ ...computer, providerRef: computer.providerRef, homeKey: computer.homeKey })
      : undefined;
  const recoveryBlocked = ref && computerRecoveryProviderUnavailable(sandbox, ref);
  const requiresExplicitWake =
    sandbox && ref && powerProvider(sandbox, ref)?.billsWhileRunning?.(ref) === true;
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
  const storedProgress = computer?.workspaceSaveProgress;
  const storedFailure = computer?.workspaceSaveFailure;
  const progress =
    !computer?.stopRequestedAt &&
    computer?.state === "suspending" &&
    storedProgress &&
    typeof storedProgress === "object" &&
    "claimAt" in storedProgress &&
    storedProgress.claimAt === computer.updatedAt?.toISOString() &&
    "observedAt" in storedProgress &&
    typeof storedProgress.observedAt === "string" &&
    Number.isFinite(Date.parse(storedProgress.observedAt)) &&
    !computerStopClaimIsStale(new Date(storedProgress.observedAt)) &&
    "progress" in storedProgress
      ? WorkspaceSaveProgressSchema.nullable().safeParse(storedProgress.progress)
      : undefined;
  const failure =
    state === "running" &&
    storedFailure &&
    typeof storedFailure === "object" &&
    "reason" in storedFailure
      ? WorkspaceSaveFailureReasonSchema.safeParse(storedFailure.reason)
      : undefined;
  const deadline =
    state === "running" && sandbox && computer && ref
      ? computerActiveDeadline(sandbox, ref, computerActiveEpoch(computer))
      : undefined;
  return {
    botId,
    mode,
    kind,
    state: unavailable ? "error" : state,
    ...(powerState ? { powerState } : {}),
    ...(recoveryBlocked ? { recoveryBlocked: true } : {}),
    ...(progress?.success ? { workspaceSaveProgress: progress.data } : {}),
    ...(failure?.success ? { workspaceSaveFailure: failure.data } : {}),
    ...(requiresExplicitWake ? { requiresExplicitWake: true as const } : {}),
    ...(deadline ? { activeLimitAt: deadline.toISOString() } : {}),
    ...(state === "suspended" && computer?.suspensionReason === "active_limit"
      ? { suspensionReason: "active_limit" as const }
      : {}),
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
