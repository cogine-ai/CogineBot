import { mkdir } from "node:fs/promises";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  computerControlExpireJobKey,
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import type { ComputerUpdate } from "@rakazo/contracts";
import { COMPUTER_ACTIVE_RUN_STATUSES, parseScreenLeaseId, screenLeaseId } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { expireComputerExecutionLeases, parseComputerMode } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  clearInactiveUserComputerControl,
  expireComputerControl,
  hasActiveComputerControl,
  isIdleOwnComputerTakeover,
  revokeScreenControl,
} from "./computer-control.js";
import {
  confirmComputerStop,
  inspectComputerPower,
  isSandboxDamaged,
  isSandboxUnsafeStop,
  markClaimedComputerStop,
  matchesComputerProvisionRoute,
  needsProviderIdentityProof,
  requestClaimedComputerStop,
  saveComputerBeforeStop,
  stoppedComputerControl,
} from "./computer-power.js";
import { toComputerRef } from "./computer-support.js";
import {
  ComputerCheckpointChangedError,
  ensureComputerWorkspaceLayout,
  removeDeletedBotWorkspaces,
  restoreComputerWorkspace,
} from "./computer-workspace.js";
import { LocalAgentHomeStore, resolveAgentHomePath } from "./home.js";

type ComputerUpdateProgress = (
  stage: Exclude<ComputerUpdate["stage"], "preparing">,
) => Promise<void>;

const EXECUTION_LEASE_MS = 5 * 60_000;
const BOOT_WAIT_ATTEMPTS = 40;
const BOOT_WAIT_MS = 250;
/**
 * A booting claim newer than an execution-lease TTL is treated as live, not abandoned.
 * Dedicated / lease-less boots never write an execution-lease row, so this stamp age is the
 * lower bound before reclaim/Reset may treat a lease-less claim as abandoned. Align with
 * EXECUTION_LEASE_MS (a crashed team worker's lease would expire then). Slow dedicated boots
 * past this window stay protected while their run worker lease still heartbeats.
 */
const BOOT_CLAIM_STALE_MS = EXECUTION_LEASE_MS;

/**
 * Booting and suspending claims newer than an execution-lease TTL are live.
 * Older ones are abandoned: the worker died mid-transition, and Reset or a later
 * provision may reclaim them. Missing stamps fail closed (treated as live).
 */
function isAbandonedLifecycleClaim(updatedAt: Date | null | undefined, now = Date.now()): boolean {
  return updatedAt instanceof Date && now - updatedAt.getTime() >= BOOT_CLAIM_STALE_MS;
}

function isLiveSuspending(
  computer: { state: string; updatedAt?: Date | null; stopRequestedAt?: Date | null },
  now = Date.now(),
): boolean {
  return (
    (computer.state === "suspending" || computer.state === "restoring") &&
    !isAbandonedLifecycleClaim(computer.stopRequestedAt ?? computer.updatedAt, now)
  );
}

/**
 * "Nobody but us holds this computer."
 *
 * Whoever moves a computer to "booting" holds its execution lease for the whole provision,
 * renewed on the run heartbeat, so a booting row whose only live lease is our own belongs to
 * a worker that died between the claim and its own failure handler. Before this nothing
 * cleared that state -- the claim took only stopped/suspended/error rows and replaceComputer
 * refused a booting one -- so the computer stayed wedged for good and every run on its bot
 * retried forever.
 *
 * Used only when claiming an abandoned "booting" row. End-of-boot writes fence on the claim
 * stamp (updatedAt) instead: fencing them with this predicate too would let a second Team bot
 * lease that appears mid-provision block both activation and the failure write, leave the row
 * stuck in "booting", and destroy the valid winner's sandbox. A lease that merely expired
 * without being taken still passes, so a slow manual boot that never heartbeats keeps working.
 *
 * When screenLeaseId is absent, require that no live execution lease exists at all. Booting
 * reclaim compare-and-swaps the pre-wait updatedAt so two lease-less callers cannot both
 * match even if one re-reads the other's claim stamp during the boot wait.
 */
function heldByNobodyElse(lease: { ownerId: string; fence: number } | null) {
  return {
    executionLeases: {
      none: {
        expiresAt: { gt: new Date() },
        ...(lease ? { NOT: { runId: lease.ownerId, fence: lease.fence } } : {}),
      },
    },
  };
}

/**
 * A live execution lease held by some OTHER bot on this computer.
 *
 * replaceComputer already holds the lease for its own bot, so "any live lease" would always
 * be true there; a shared Team Computer mid-boot for a different bot must still be refused.
 */
async function hasForeignExecutionLease(
  prisma: PrismaClient,
  computerId: string,
  botId: string,
): Promise<boolean> {
  const live = await prisma.computerExecutionLease.findFirst({
    where: { computerId, botId: { not: botId }, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return live !== null;
}

/**
 * A live worker lease on another run that uses this computer.
 *
 * Dedicated boots never take a computer execution lease, so after BOOT_CLAIM_STALE_MS the
 * claim stamp alone would look abandoned while provision is still running. A heartbeating
 * run lease proves the provisioner is alive. exceptRunId lets a recovering continueRun
 * reclaim its own abandoned boot without treating itself as foreign.
 */
async function hasLiveForeignRunLease(
  prisma: PrismaClient,
  computerId: string,
  exceptRunId?: string,
): Promise<boolean> {
  const live = await prisma.run.findFirst({
    where: {
      status: { in: [...COMPUTER_ACTIVE_RUN_STATUSES] },
      bot: { computerId },
      leaseExpiresAt: { gt: new Date() },
      ...(exceptRunId ? { id: { not: exceptRunId } } : {}),
    },
    select: { id: true },
  });
  return live !== null;
}

export class ComputerBusyError extends Error {
  constructor() {
    super("Computer is busy");
    this.name = "ComputerBusyError";
  }
}

export class ComputerRecoveryRequiredError extends Error {
  constructor() {
    super("The computer needs recovery before it can be started.");
    this.name = "ComputerRecoveryRequiredError";
  }
}

export function computerStopClaimIsStale(updatedAt?: Date | null): boolean {
  return isAbandonedLifecycleClaim(updatedAt);
}

export async function quarantineAbandonedComputerOperation(
  prisma: PrismaClient,
  computer: {
    id: string;
    state: string;
    kind: string;
    providerRef: string | null;
    screenGeneration: number;
    updatedAt: Date;
    stopRequestedAt: Date | null;
  },
  context?: AdapterContext,
): Promise<boolean> {
  const startedAt =
    computer.stopRequestedAt ?? (computer.state === "restoring" ? computer.updatedAt : null);
  if (
    !startedAt ||
    !computerStopClaimIsStale(startedAt) ||
    (await hasLiveForeignRunLease(prisma, computer.id, context?.runId))
  ) {
    return false;
  }
  const lease = context?.screenLeaseId ? parseScreenLeaseId(context.screenLeaseId) : null;
  const { id, state, kind, providerRef, screenGeneration, updatedAt } = computer;
  const marked = await prisma.computer.updateMany({
    where: {
      id,
      state,
      kind,
      providerRef,
      screenGeneration,
      updatedAt,
      stopRequestedAt: computer.stopRequestedAt,
      ...heldByNobodyElse(lease),
    },
    data: {
      state: "quarantined",
      stopRequestedAt: null,
      ...(state === "restoring" ? { restorePending: true } : {}),
      ...stoppedComputerControl,
    },
  });
  return marked.count === 1;
}

async function guardComputerBoot(
  prisma: PrismaClient,
  computer: Parameters<typeof quarantineAbandonedComputerOperation>[1],
  context: AdapterContext,
): Promise<void> {
  if (
    computer.state === "quarantined" ||
    computer.state === "needs_recovery" ||
    (await quarantineAbandonedComputerOperation(prisma, computer, context))
  ) {
    throw new ComputerRecoveryRequiredError();
  }
  if (computer.stopRequestedAt || computer.state === "restoring") throw new ComputerBusyError();
}

export { toComputerRef } from "./computer-support.js";

export async function provisionComputer(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
    dataDir?: string;
  },
  computerId: string,
  context: AdapterContext,
  controlHolder: "bot" | "none" = "none",
  onProgress?: ComputerUpdateProgress,
): Promise<ComputerRef> {
  let existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
  if (existing.maintenanceId && existing.maintenanceId !== context.operationId)
    throw new ComputerBusyError();
  await guardComputerBoot(deps.prisma, existing, context);
  if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
    await expireComputerControl(deps, existing.id, existing.controlLeaseId);
    existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    await guardComputerBoot(deps.prisma, existing, context);
    if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  const requireReusableProvider = async () => {
    if (!existing.providerRef) return;
    const ref = toComputerRef(existing);
    if (await matchesComputerProvisionRoute(deps.sandbox, ref)) {
      if (!needsProviderIdentityProof(deps.sandbox, ref)) return;
      const state = await inspectComputerPower(deps.sandbox, ref, context);
      if (state === "running" || state === "stopped") return;
    }
    context.signal.throwIfAborted();
    const lease = context.screenLeaseId ? parseScreenLeaseId(context.screenLeaseId) : null;
    const quarantined = await deps.prisma.computer.updateMany({
      where: {
        id: computerId,
        state: existing.state,
        kind: existing.kind,
        providerRef: existing.providerRef,
        providerAuthority: existing.providerAuthority,
        updatedAt: existing.updatedAt,
        screenGeneration: existing.screenGeneration,
        maintenanceId: existing.maintenanceId,
        ...heldByNobodyElse(lease),
        stopRequestedAt: null,
      },
      data: { state: "quarantined", ...stoppedComputerControl },
    });
    if (quarantined.count !== 1) throw new ComputerBusyError();
    throw new ComputerRecoveryRequiredError();
  };
  if (existing.state !== "booting" && existing.state !== "suspending") {
    await requireReusableProvider();
  }
  let retainedDamage: { ref: ComputerRef; error: unknown } | undefined;
  const homePath = resolveAgentHomePath(deps.home, existing.homeKey, deps.dataDir ?? "./data");
  if (deps.home instanceof LocalAgentHomeStore) {
    await deps.home.ensureHomeDirectory(existing.homeKey);
  } else {
    await mkdir(homePath, { recursive: true });
  }

  // Re-provisioning a live computer enters booting and revokes its screen URLs.
  // A provider-confirmed live reference needs setup, not a new lifecycle claim.
  if (
    existing.state === "running" &&
    !existing.restorePending &&
    existing.providerRef &&
    deps.sandbox.isRunning
  ) {
    const ref = toComputerRef(existing);
    if (await deps.sandbox.isRunning(ref, context)) {
      context.signal.throwIfAborted();
      const retained = await deps.prisma.computer.updateMany({
        where: {
          id: computerId,
          state: "running",
          providerRef: existing.providerRef,
          kind: existing.kind,
          screenGeneration: existing.screenGeneration,
          restorePending: false,
          stopRequestedAt: null,
          maintenanceId: existing.maintenanceId ?? null,
          ...(context.botId
            ? { bots: { some: { id: context.botId, archivedAt: null, computerSwitching: false } } }
            : {}),
        },
        data: {
          updatedAt: new Date(),
          ...(deps.sandbox.providerAuthority
            ? { providerAuthority: deps.sandbox.providerAuthority(ref.kind) }
            : {}),
        },
      });
      if (retained.count !== 1) throw new ComputerBusyError();
      try {
        await deps.sandbox.prepare(ref, context);
        await ensureComputerWorkspaceLayout(
          deps.sandbox,
          ref,
          parseComputerMode(existing.scope),
          context.botId,
          context,
        );
        return ref.kind === "desktop" ? { ...ref, fresh: false } : ref;
      } catch (error) {
        if (!isSandboxDamaged(error)) throw error;
        retainedDamage = { ref, error };
      }
    }
  }

  // If we first observe abandoned "booting", remember that stamp before waiting. A concurrent
  // reclaim bumps updatedAt while state stays "booting"; fencing the claim on the pre-wait
  // stamp keeps those callers mutually exclusive. After the wait, a finished boot returns
  // "running" and takes the normal reconnect claim instead.
  //
  // Only reclaim stamps that were already older than an execution-lease TTL when we first
  // saw them. A fresher stamp means another caller may still be provisioning (dedicated and
  // lease-less boots can outlast the short boot-wait poll); stealing would double-provision
  // and roll back their sandbox. Live team boots with an execution lease are already blocked
  // by heldByNobodyElse; this guards the lease-less path (and expired-lease gaps).
  const reclaimStamp = existing.state === "booting" ? existing.updatedAt : null;
  const bootClaimIsStale =
    reclaimStamp !== null && Date.now() - reclaimStamp.getTime() >= BOOT_CLAIM_STALE_MS;
  // Idle stop does not refresh updatedAt while checkpointing or waiting on provider stop.
  // A live suspend can therefore age across the TTL during the ready wait; only reclaim
  // stamps that were already abandoned when we first saw them, matching booting reclaim.
  const suspendStamp = existing.state === "suspending" ? existing.updatedAt : null;
  const suspendClaimIsStale = suspendStamp !== null && isAbandonedLifecycleClaim(suspendStamp);
  // A fresh booting claim (or one whose run lease is still live) cannot be reclaimed after
  // the wait either, so do not block workers for the full boot-wait window. Shared Postgres
  // journeys previously hung createApp stop() while continueRun sat in that wait against a
  // wedged mid-boot row left by an earlier suite.
  if (existing.state === "booting" && reclaimStamp !== null && !bootClaimIsStale) {
    throw new ComputerBusyError();
  }
  if (
    existing.state === "booting" &&
    (await hasLiveForeignRunLease(deps.prisma, computerId, context.runId))
  ) {
    throw new ComputerBusyError();
  }
  const waited = existing.state === "booting" || existing.state === "suspending";
  if (waited) {
    existing = await waitForComputerReady(deps.prisma, computerId, context);
    await guardComputerBoot(deps.prisma, existing, context);
  }
  // A booting row whose holder is gone is reclaimable. A suspending row is too once
  // its claim was already older than an execution-lease TTL when first observed and
  // no other run is still alive.
  const staleSuspending =
    existing.state === "suspending" &&
    suspendClaimIsStale &&
    existing.updatedAt.getTime() === suspendStamp?.getTime() &&
    !(await hasLiveForeignRunLease(deps.prisma, computerId, context.runId));
  if (
    !staleSuspending &&
    !["running", "stopped", "suspended", "error", "booting"].includes(existing.state)
  ) {
    throw new ComputerBusyError();
  }
  // Waited for suspending (or similar) and landed on booting we never stamped: another
  // caller owns that boot. Do not adopt its updatedAt / previousRef and double-provision.
  if (existing.state === "booting" && existing.updatedAt.getTime() !== reclaimStamp?.getTime()) {
    throw new ComputerBusyError();
  }
  // We came to reclaim abandoned booting; if another caller already activated, do not fall
  // through into reconnect (that would provision again under their providerRef).
  if (reclaimStamp !== null && existing.state === "running") {
    throw new ComputerBusyError();
  }
  // Stamp age is only a lower bound. Dedicated / lease-less boots can provision longer than
  // BOOT_CLAIM_STALE_MS; a heartbeating foreign run lease means the holder is still alive.
  if (
    existing.state === "booting" &&
    reclaimStamp !== null &&
    (await hasLiveForeignRunLease(deps.prisma, computerId, context.runId))
  ) {
    throw new ComputerBusyError();
  }

  if (waited) await requireReusableProvider();

  const reconnecting =
    Boolean(existing.providerRef) &&
    (existing.state === "running" || existing.state === "suspending");
  // Reconnect can allocate a replacement too. Claim it before any provider call,
  // and compare the observed reference so a delayed caller cannot replace a winner.
  // An abandoned "booting" row is claimed only when no other live execution lease remains,
  // and only when we observed "booting" (never as an OR arm on a running/stopped claim).
  const previousRef = { providerRef: existing.providerRef, kind: existing.kind };
  const bootLease = context.screenLeaseId ? parseScreenLeaseId(context.screenLeaseId) : null;
  // Reclaim "booting" only when we observed it. Always ORing a booting arm lets a second
  // caller match after the first claimed running/stopped/… → booting and double-provision.
  // Stale "suspending" uses the same stamp fence so two recoveries cannot both provision.
  const claimWhere =
    existing.state === "booting" || existing.state === "suspending"
      ? {
          state: existing.state,
          updatedAt: existing.state === "booting" ? reclaimStamp! : suspendStamp!,
          ...(existing.state === "suspending" ? previousRef : {}),
          ...heldByNobodyElse(bootLease),
        }
      : {
          state: existing.state,
          ...previousRef,
        };
  // Choose the claim stamp before writing so a concurrent reclaim cannot make us adopt its
  // updatedAt on a follow-up read (which would let our activation overwrite the newer owner).
  // Advance past the observed stamp even when Date.now() equals it (same ms or clock skew);
  // otherwise a booting self-transition would leave the CAS token unchanged and a second
  // worker that observed the same stamp could also claim and provision.
  const observedStamp = reclaimStamp ?? suspendStamp ?? existing.updatedAt;
  let claimStamp = new Date(Math.max(Date.now(), observedStamp.getTime() + 1));
  const claimed = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      ...claimWhere,
      stopRequestedAt: null,
      screenGeneration: existing.screenGeneration,
      maintenanceId: existing.maintenanceId ?? null,
      ...(context.botId
        ? { bots: { some: { id: context.botId, archivedAt: null, computerSwitching: false } } }
        : {}),
    },
    data: {
      state: "booting",
      updatedAt: claimStamp,
      ...(!existing.providerRef ? { restorePending: true } : {}),
    },
  });
  if (claimed.count !== 1) throw new ComputerBusyError();
  let provisioned: ComputerRef | undefined;
  let recoveryStarted = false;
  let claimRef = previousRef;
  let fallbackRef = previousRef;
  let fallbackAuthority: string | null | undefined = existing.providerAuthority;
  const authorityFor = (ref: ComputerRef) => deps.sandbox.providerAuthority?.(ref.kind);
  let claimState = "booting";
  let restorePending = existing.restorePending || !existing.providerRef;
  let restoreContext = context;
  let finishRestoreRenewal: (() => Promise<void>) | undefined;
  const bootClaim = () => ({
    id: computerId,
    state: claimState,
    updatedAt: claimStamp,
    ...claimRef,
    maintenanceId: existing.maintenanceId ?? null,
  });
  const markRestorePending = async (candidate?: ComputerRef) => {
    if (restorePending && !candidate) return;
    const target = candidate
      ? { providerRef: candidate.providerRef, kind: candidate.kind }
      : undefined;
    const providerAuthority = candidate && authorityFor(candidate);
    const marked = await deps.prisma.computer.updateMany({
      where: { ...bootClaim(), stopRequestedAt: null },
      data: {
        ...target,
        ...(providerAuthority ? { providerAuthority } : {}),
        restorePending: true,
        updatedAt: claimStamp,
      },
    });
    if (marked.count !== 1) throw new ComputerBusyError();
    if (target) claimRef = target;
    restorePending = true;
  };
  const provision = async (providerRef?: string) => {
    const ref = await deps.sandbox.provision(
      {
        botId: existing.homeKey,
        homePath,
        providerRef,
        providerKind: existing.kind as ComputerRef["kind"],
        isolateWorkspaceGeneration: true,
        beforeWorkspaceReplacement: markRestorePending,
      },
      context,
    );
    const providerAuthority = authorityFor(ref);
    provisioned = providerAuthority ? { ...ref, providerAuthority } : ref;
    await deps.sandbox.prepare(provisioned, context);
    return provisioned;
  };
  try {
    await onProgress?.("recreating");
    let ref: ComputerRef;
    try {
      if (retainedDamage) {
        provisioned = retainedDamage.ref;
        throw retainedDamage.error;
      }
      ref = await provision(existing.providerRef ?? undefined);
    } catch (error) {
      if (!isSandboxDamaged(error)) throw error;
      const damaged = provisioned ?? (existing.providerRef ? toComputerRef(existing) : undefined);
      if (!damaged || context.signal.aborted || hasActiveComputerControl(existing)) throw error;

      // Persist the exact candidate, including a fresh provider reference, before stopping it.
      const damagedRef = { providerRef: damaged.providerRef, kind: damaged.kind };
      const replacingDamaged =
        damaged.fresh === true ||
        damaged.providerRef !== existing.providerRef ||
        damaged.kind !== existing.kind;
      const allowed = await deps.prisma.computer.updateMany({
        where: {
          ...bootClaim(),
          stopRequestedAt: null,
          autoRecoveredAt: null,
          ...heldByNobodyElse(bootLease),
        },
        data: {
          ...damagedRef,
          ...(damaged.providerAuthority ? { providerAuthority: damaged.providerAuthority } : {}),
          autoRecoveredAt: new Date(),
          ...(replacingDamaged ? { restorePending: true } : {}),
          updatedAt: claimStamp,
        },
      });
      if (allowed.count !== 1) throw error;
      claimRef = damagedRef;
      restorePending ||= replacingDamaged;
      recoveryStarted = true;
      const stopped = await requestClaimedComputerStop(
        deps,
        { ...bootClaim(), ...heldByNobodyElse(bootLease) },
        damaged,
        context,
        damaged.fresh ? "destroy" : "stop",
      );
      const nextRef = stopped === "gone" ? null : damaged.providerRef;
      const cleared = await deps.prisma.computer.updateMany({
        where: { ...bootClaim(), stopRequestedAt: { not: null } },
        data: {
          providerRef: nextRef,
          ...(nextRef === null && damaged.providerAuthority ? { providerAuthority: null } : {}),
          stopRequestedAt: null,
          updatedAt: claimStamp,
        },
      });
      if (cleared.count !== 1) throw new ComputerBusyError();
      claimRef = { providerRef: nextRef, kind: damaged.kind };
      fallbackRef = claimRef;
      fallbackAuthority = nextRef ? damaged.providerAuthority : null;
      provisioned = undefined;
      ref = await provision(nextRef ?? undefined);
    }
    const replacement =
      restorePending ||
      ref.fresh === true ||
      !existing.providerRef ||
      existing.providerRef !== ref.providerRef ||
      existing.kind !== ref.kind;
    if (replacement) {
      await markRestorePending();
      await onProgress?.("restoring");
      // Persist the candidate and renew its ownership independently of restore duration.
      const target = { providerRef: ref.providerRef, kind: ref.kind };
      const startedAt = new Date(Math.max(Date.now(), claimStamp.getTime() + 1));
      const current = await deps.prisma.computer.updateMany({
        where: { ...bootClaim(), stopRequestedAt: null },
        data: {
          ...target,
          ...(ref.providerAuthority ? { providerAuthority: ref.providerAuthority } : {}),
          state: "restoring",
          updatedAt: startedAt,
        },
      });
      if (current.count !== 1) throw new ComputerBusyError();
      claimState = "restoring";
      claimRef = target;
      claimStamp = startedAt;
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      let renewal: Promise<void> | undefined;
      const timer = setInterval(() => {
        if (renewal || signal.aborted) return;
        const stamp = new Date(Math.max(Date.now(), claimStamp.getTime() + 1));
        renewal = deps.prisma.computer
          .updateMany({
            where: { ...bootClaim(), stopRequestedAt: null },
            data: { updatedAt: stamp },
          })
          .then(({ count }) => {
            if (count !== 1) throw new ComputerBusyError();
            claimStamp = stamp;
          })
          .catch((error: unknown) => controller.abort(error))
          .finally(() => {
            renewal = undefined;
          });
      }, 30_000);
      finishRestoreRenewal = async () => {
        clearInterval(timer);
        await renewal;
      };
      restoreContext = { ...context, signal };
      await restoreComputerWorkspace(
        deps.home,
        deps.sandbox,
        existing.homeKey,
        ref,
        restoreContext,
      );
    }
    restoreContext.signal.throwIfAborted();
    await onProgress?.("reconnecting");
    await ensureComputerWorkspaceLayout(
      deps.sandbox,
      ref,
      parseComputerMode(existing.scope),
      context.botId,
      restoreContext,
    );
    // Bots deleted while this computer was not running could not remove their folders then.
    // Skip only plain reconnects; a provider may start or replace the computer during one.
    if (existing.scope === "team" && (!reconnecting || replacement || ref.started === true)) {
      await removeDeletedBotWorkspaces(deps, ref, existing.spaceId, restoreContext).catch(
        (error) => {
          getLogger().error("team bot folder cleanup", error);
        },
      );
    }
    await finishRestoreRenewal?.();
    restoreContext.signal.throwIfAborted();
    const activeControl = hasActiveComputerControl(existing);
    const activated = await deps.prisma.computer.updateMany({
      where: {
        ...bootClaim(),
        stopRequestedAt: null,
        ...(context.botId
          ? { bots: { some: { id: context.botId, archivedAt: null, computerSwitching: false } } }
          : {}),
      },
      data: {
        state: "running",
        providerRef: ref.providerRef,
        kind: ref.kind,
        ...(ref.providerAuthority ? { providerAuthority: ref.providerAuthority } : {}),
        restorePending: false,
        ...(!reconnecting || recoveryStarted
          ? {
              controlHolder: activeControl ? "user" : controlHolder,
              ...(!activeControl
                ? {
                    controlLeaseId: null,
                    controlLeaseExpiresAt: null,
                    controlBotId: null,
                    controlRunId: null,
                  }
                : {}),
            }
          : {}),
      },
    });
    if (activated.count !== 1) {
      throw new ComputerBusyError();
    }
    return ref;
  } catch (error) {
    await finishRestoreRenewal?.();
    // A failed reconnect never owns an existing workspace, even if setup failed.
    const unsafe = isSandboxUnsafeStop(error);
    const damaged = isSandboxDamaged(error);
    let rollbackError: unknown;
    let rolledBack: "stopped" | "gone" | undefined;
    if (provisioned && !unsafe && !damaged && (!reconnecting || provisioned.fresh === true)) {
      const target = { providerRef: provisioned.providerRef, kind: provisioned.kind };
      const cleanup = context.signal.aborted
        ? { ...context, signal: AbortSignal.timeout(120_000) }
        : context;
      try {
        await markClaimedComputerStop(deps.prisma, bootClaim(), cleanup, {
          ...target,
          ...(provisioned.providerAuthority
            ? { providerAuthority: provisioned.providerAuthority }
            : {}),
        });
        claimRef = target;
        await deps.sandbox
          .releaseScreen?.(provisioned, cleanup, { onlyIfRunning: true })
          .catch(() => undefined);
        rolledBack = await confirmComputerStop(
          deps.sandbox,
          provisioned,
          cleanup,
          provisioned.fresh ? "destroy" : "stop",
          provisioned.kind === "desktop" && provisioned.fresh
            ? { retireWorkspace: true }
            : undefined,
        );
      } catch (failure) {
        // The next claimant may have adopted the same identity.
        if (!(failure instanceof ComputerCheckpointChangedError)) rollbackError = failure;
      }
    }
    try {
      await deps.prisma.computer.updateMany({
        where: bootClaim(),
        data: {
          state:
            unsafe || rollbackError || (claimState === "restoring" && !rolledBack)
              ? "quarantined"
              : damaged || recoveryStarted
                ? "needs_recovery"
                : reconnecting && !restorePending
                  ? "running"
                  : "error",
          stopRequestedAt: null,
          ...(unsafe || rollbackError || damaged || recoveryStarted || claimState === "restoring"
            ? { restorePending: true, ...stoppedComputerControl }
            : {}),
          ...((damaged || rollbackError) && provisioned
            ? {
                providerRef: provisioned.providerRef,
                kind: provisioned.kind,
                ...(provisioned.providerAuthority
                  ? { providerAuthority: provisioned.providerAuthority }
                  : {}),
              }
            : rolledBack === "gone"
              ? {
                  ...fallbackRef,
                  ...(fallbackAuthority !== undefined
                    ? {
                        providerAuthority:
                          fallbackRef.providerRef === claimRef.providerRef
                            ? null
                            : fallbackAuthority,
                      }
                    : {}),
                  providerRef:
                    fallbackRef.providerRef === claimRef.providerRef
                      ? null
                      : fallbackRef.providerRef,
                }
              : {}),
        },
      });
    } catch (recordError) {
      throw new AggregateError(
        [error, ...(rollbackError ? [rollbackError] : []), recordError],
        "Computer provisioning failed and its failure could not be recorded",
      );
    }
    if (rollbackError) {
      // The provider was still down for the cleanup, which adds nothing to why the start failed.
      const cause = rollbackError instanceof Error ? rollbackError.cause : undefined;
      if (
        cause instanceof SandboxUnresponsiveError ||
        cause instanceof SandboxUnavailableError ||
        cause instanceof SandboxRateLimitError
      ) {
        getLogger().warn("computer.rollback_failed", {
          provider: provisioned?.kind,
          error: rollbackError,
        });
        throw error;
      }
      throw new AggregateError(
        [error, rollbackError],
        "Computer provisioning failed and its sandbox could not be rolled back",
      );
    }
    throw error;
  }
}

async function waitForComputerReady(
  prisma: PrismaClient,
  computerId: string,
  context: AdapterContext,
) {
  for (let attempt = 0; attempt < BOOT_WAIT_ATTEMPTS; attempt += 1) {
    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error("computer boot aborted");
    }
    const current = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (current.state === "running" && current.providerRef) return current;
    if (current.state !== "booting" && current.state !== "suspending") return current;
    await new Promise((resolve) => setTimeout(resolve, BOOT_WAIT_MS));
  }
  return prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
}

export interface ComputerExecutionLease {
  computerId: string;
  botId: string;
  runId: string;
  fence: number;
}

export function screenLeaseIdForRun(
  lease: Pick<ComputerExecutionLease, "runId" | "fence"> | null,
  runId: string,
  fence = 0,
): string {
  return screenLeaseId(lease?.runId ?? runId, lease?.fence ?? fence);
}

/** Dedicated screen leases serialize workers and retain the fence after release. */
export async function acquireDedicatedScreenLeaseFence(
  prisma: PrismaClient,
  input: {
    computerId: string;
    runId: string;
    botId: string;
    workerId: string;
    runFence: number;
  },
): Promise<ComputerExecutionLease> {
  return prisma.$transaction(async (tx) => {
    // Lock in a fixed order and fail fast if assignment or worker ownership is changing.
    const assignedBot = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM bots
      WHERE id = ${input.botId}
        AND "computerId" = ${input.computerId}
        AND "computerSwitching" = false
      FOR UPDATE SKIP LOCKED`;
    if (assignedBot.length !== 1) throw new ComputerBusyError();

    const computer = await tx.$queryRaw<Array<{ id: string; scope: string }>>`
      SELECT id, scope FROM computers WHERE id = ${input.computerId} FOR UPDATE SKIP LOCKED`;
    if (computer.length !== 1 || computer[0]?.scope !== "dedicated") {
      throw new ComputerBusyError();
    }

    await lockOwnedRun(tx, input);

    // An unexpired holder owns the screen until release, pause, or expiry. Keep the
    // expired row so explicit release never resets the next worker's screen fence.
    // The current worker ownership check also permits resuming this run's held takeover.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXECUTION_LEASE_MS);
    const [existing] = await tx.computerExecutionLease.updateManyAndReturn({
      where: {
        computerId: input.computerId,
        botId: input.botId,
        OR: [{ expiresAt: { lte: now } }, { runId: input.runId }],
      },
      data: { runId: input.runId, expiresAt, fence: { increment: 1 } },
      select: { fence: true },
    });
    if (existing) {
      return {
        computerId: input.computerId,
        botId: input.botId,
        runId: input.runId,
        fence: existing.fence,
      };
    }

    const history = await tx.run.aggregate({
      where: { botId: input.botId },
      _max: { leaseFence: true },
    });
    const fence = Math.max(input.runFence, history._max.leaseFence ?? 0) + 1;
    try {
      const created = await tx.computerExecutionLease.create({
        data: {
          computerId: input.computerId,
          botId: input.botId,
          runId: input.runId,
          fence,
          expiresAt,
        },
        select: { fence: true },
      });
      return {
        computerId: input.computerId,
        botId: input.botId,
        runId: input.runId,
        fence: created.fence,
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ComputerBusyError();
      throw error;
    }
  });
}

async function lockOwnedRun(
  tx: Prisma.TransactionClient,
  input: { runId: string; botId: string; workerId: string; runFence: number },
): Promise<void> {
  const currentRun = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM runs
    WHERE id = ${input.runId}
      AND "botId" = ${input.botId}
      AND status = 'running'
      AND "leaseOwner" = ${input.workerId}
      AND "leaseFence" = ${input.runFence}
      AND "leaseExpiresAt" > ${new Date()}
    FOR UPDATE SKIP LOCKED`;
  if (currentRun.length !== 1) throw new ComputerBusyError();
}

export async function acquireComputerExecutionLease(
  prisma: PrismaClient,
  input: {
    computerId: string;
    runId: string;
    botId: string;
  } & ({ workerId: string; runFence: number } | { workerId?: never; runFence?: never }),
): Promise<ComputerExecutionLease | null> {
  const computer = await prisma.computer.findUniqueOrThrow({ where: { id: input.computerId } });
  if (computer.maintenanceId && computer.maintenanceId !== input.runId)
    throw new ComputerBusyError();
  if (computer.scope !== "team") return null;
  if (isLiveSuspending(computer)) throw new ComputerBusyError();
  return prisma.$transaction(async (tx) => {
    // Only the locked current worker claim may reclaim a live same-run lease.
    // API operations have no worker claim and may acquire only new or expired leases.
    const ownsRun = input.workerId !== undefined;
    if (ownsRun) await lockOwnedRun(tx, input);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXECUTION_LEASE_MS);
    const [reclaimed] = await tx.computerExecutionLease.updateManyAndReturn({
      where: {
        computerId: input.computerId,
        botId: input.botId,
        OR: [{ expiresAt: { lt: now } }, ...(ownsRun ? [{ runId: input.runId }] : [])],
      },
      data: {
        runId: input.runId,
        expiresAt,
        fence: { increment: 1 },
      },
      select: { fence: true },
    });
    if (reclaimed) {
      return validateAcquiredComputerLease(tx, {
        computerId: input.computerId,
        botId: input.botId,
        runId: input.runId,
        fence: reclaimed.fence,
      });
    }
    try {
      const created = await tx.computerExecutionLease.create({
        data: {
          computerId: input.computerId,
          botId: input.botId,
          runId: input.runId,
          fence: 1,
          expiresAt,
        },
        select: { fence: true },
      });
      return validateAcquiredComputerLease(tx, {
        computerId: input.computerId,
        botId: input.botId,
        runId: input.runId,
        fence: created.fence,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ComputerBusyError();
      throw error;
    }
  });
}

async function validateAcquiredComputerLease(
  prisma: Prisma.TransactionClient,
  lease: ComputerExecutionLease,
): Promise<ComputerExecutionLease> {
  const computer = await prisma.computer.findUniqueOrThrow({
    where: { id: lease.computerId },
    select: { state: true, maintenanceId: true, updatedAt: true, stopRequestedAt: true },
  });
  if (
    !isLiveSuspending(computer) &&
    (!computer.maintenanceId || computer.maintenanceId === lease.runId)
  )
    return lease;
  throw new ComputerBusyError();
}

export async function renewComputerExecutionLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<boolean> {
  if (!lease) return true;
  const now = new Date();
  const renewed = await prisma.computerExecutionLease.updateMany({
    where: {
      computerId: lease.computerId,
      botId: lease.botId,
      runId: lease.runId,
      fence: lease.fence,
      expiresAt: { gt: now },
    },
    data: { expiresAt: new Date(now.getTime() + EXECUTION_LEASE_MS) },
  });
  return renewed.count === 1;
}

export async function holdComputerExecutionLeaseForTakeover(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<boolean> {
  if (!lease) return true;
  const now = new Date();
  const held = await prisma.computerExecutionLease.updateMany({
    where: {
      computerId: lease.computerId,
      botId: lease.botId,
      runId: lease.runId,
      fence: lease.fence,
      expiresAt: { gt: now },
    },
    data: { expiresAt: new Date(now.getTime() + 24 * 60 * 60_000) },
  });
  return held.count === 1;
}

export async function releaseComputerExecutionLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<void> {
  if (!lease) return;
  // Keep the row as an expired tombstone so the next run for this bot increments
  // its fence. Deleting it resets the fence to 1, which lets a still-open screen
  // session from the previous run reject the new run as stale.
  await expireComputerExecutionLeases(prisma, {
    computerId: lease.computerId,
    botId: lease.botId,
    runId: lease.runId,
    fence: lease.fence,
  });
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export type ComputerReplaceMode = "recover" | "reset" | "update";

export function computerSupportsUpdate(kind: string): boolean {
  return kind !== "desktop";
}

/** Kinds whose provider opens a user terminal through the shared Linux screen gateway. */
export function computerSupportsTerminal(kind: string): boolean {
  return (
    kind === "docker" || kind === "e2b" || kind === "daytona" || kind === "box" || kind === "fake"
  );
}

export async function replaceComputer(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
    dataDir?: string;
  },
  computerId: string,
  mode: ComputerReplaceMode,
  context: AdapterContext,
  controlHolder: "bot" | "none" = "none",
  onProgress?: ComputerUpdateProgress,
  options?: { handBackIdleTakeover?: boolean },
): Promise<ComputerRef> {
  let existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
  if (existing.maintenanceId && existing.maintenanceId !== context.operationId)
    throw new ComputerBusyError();
  const recoveryRequired =
    existing.stopRequestedAt ||
    ["restoring", "quarantined", "needs_recovery"].includes(existing.state);
  if (mode === "update" && recoveryRequired) throw new ComputerRecoveryRequiredError();
  const botId = context.botId;
  if (!botId) throw new Error("computer replacement requires a bot id");
  // Leave a takeover a run is waiting on. Expiry would resume that run.
  if (
    options?.handBackIdleTakeover &&
    existing.controlHolder === "user" &&
    existing.controlBotId === botId &&
    existing.controlRunId
  ) {
    throw new ComputerBusyError();
  }
  const handBackIdleTakeover =
    options?.handBackIdleTakeover === true && isIdleOwnComputerTakeover(existing, botId);
  if (!handBackIdleTakeover && existing.controlLeaseId && !hasActiveComputerControl(existing)) {
    if (options?.handBackIdleTakeover && existing.controlRunId) throw new ComputerBusyError();
    const expired = await expireComputerControl(deps, existing.id, existing.controlLeaseId);
    existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    // Failed provider revoke keeps the lease for retry; do not wipe it and continue reset.
    if (!expired && existing.controlLeaseId && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  // Orphaned controlHolder=user with no lease id can be cleared for reset/recover.
  if (
    !handBackIdleTakeover &&
    existing.controlHolder === "user" &&
    !hasActiveComputerControl(existing) &&
    !existing.controlLeaseId
  ) {
    await clearInactiveUserComputerControl(deps.prisma, existing.id);
    existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (existing.controlHolder === "user" && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  if (hasActiveComputerControl(existing) && !handBackIdleTakeover) {
    throw new ComputerBusyError();
  }
  // Reset is the in-product recovery for a hung suspend. Recover and update still refuse
  // so they cannot destroy a computer that is only stuck, not requested as a Reset.
  if (existing.state === "suspending" && mode !== "reset" && !existing.stopRequestedAt) {
    throw new ComputerBusyError();
  }
  // Allow Reset on a stale "booting" or "suspending" row unless another bot still holds a live
  // lease. Dedicated computers never create an execution-lease row, so the foreign-lease check
  // alone cannot see an in-flight dedicated boot or idle stop. Refuse claim stamps younger than
  // an execution-lease TTL (not merely the boot-wait poll) so a slow dedicated provision or
  // suspend is not destroyed mid-flight. Also refuse while a run still uses the computer —
  // before claiming suspending — so rollback cannot bump @updatedAt under an in-flight boot.
  if (["booting", "suspending", "restoring"].includes(existing.state)) {
    if (await hasForeignExecutionLease(deps.prisma, computerId, botId)) {
      throw new ComputerBusyError();
    }
    if (!isAbandonedLifecycleClaim(existing.stopRequestedAt ?? existing.updatedAt)) {
      throw new ComputerBusyError();
    }
    const activeBootRun = await deps.prisma.run.findFirst({
      where: {
        status: { in: [...COMPUTER_ACTIVE_RUN_STATUSES] },
        bot: { computerId },
      },
      select: { id: true },
    });
    if (activeBootRun) throw new ComputerBusyError();
  }

  const previousState = existing.state;
  const previousControl = handBackIdleTakeover
    ? {
        controlHolder: "user" as const,
        controlLeaseId: existing.controlLeaseId,
        controlLeaseExpiresAt: existing.controlLeaseExpiresAt,
        controlBotId: existing.controlBotId,
        controlRunId: null,
      }
    : null;
  const now = new Date();
  const claimStamp = new Date(Math.max(now.getTime(), existing.updatedAt.getTime() + 1));
  const claimed = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      state: previousState,
      maintenanceId: existing.maintenanceId ?? null,
      providerRef: existing.providerRef,
      kind: existing.kind,
      screenGeneration: existing.screenGeneration,
      updatedAt: existing.updatedAt,
      stopRequestedAt: existing.stopRequestedAt,
      restorePending: existing.restorePending,
      executionLeases: { none: { botId: { not: botId }, expiresAt: { gt: now } } },
      ...(handBackIdleTakeover
        ? {
            controlHolder: "user" as const,
            controlBotId: botId,
            controlRunId: null,
            controlLeaseId: existing.controlLeaseId,
          }
        : {
            OR: [
              { controlHolder: { not: "user" } },
              { controlLeaseId: null },
              { controlLeaseExpiresAt: null },
              { controlLeaseExpiresAt: { lte: now } },
            ],
          }),
    },
    data: {
      state: "suspending",
      stopRequestedAt: null,
      updatedAt: claimStamp,
      ...(handBackIdleTakeover
        ? {
            controlHolder: "none" as const,
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
            controlBotId: null,
            controlRunId: null,
          }
        : {}),
    },
  });
  if (claimed.count !== 1) throw new ComputerBusyError();
  const suspensionClaim = {
    id: computerId,
    state: "suspending",
    updatedAt: claimStamp,
    providerRef: existing.providerRef,
    kind: existing.kind,
    screenGeneration: existing.screenGeneration + (previousState === "suspending" ? 0 : 1),
    maintenanceId: existing.maintenanceId ?? null,
  };
  const releaseClaim = () =>
    deps.prisma.computer.updateMany({
      where: { ...suspensionClaim, stopRequestedAt: null },
      data: { state: previousState, stopRequestedAt: existing.stopRequestedAt, ...previousControl },
    });
  // Re-check after the claim in case a run started between the pre-check and CAS.
  const activeRun = await deps.prisma.run.findFirst({
    where: {
      status: { in: [...COMPUTER_ACTIVE_RUN_STATUSES] },
      bot: { computerId },
    },
    select: { id: true },
  });
  if (activeRun) {
    await releaseClaim();
    throw new ComputerBusyError();
  }

  if (previousControl?.controlLeaseId && existing.providerRef) {
    try {
      await revokeScreenControl(
        deps,
        existing,
        context,
        previousControl.controlLeaseId,
        // The activation compare still names this providerRef; the replacement
        // overwrites it. Clearing it here would strand the in-flight claim.
        { clearGoneRef: false },
      );
    } catch (error) {
      getLogger().error("release own takeover before maintenance", error);
      await releaseClaim();
      throw new ComputerBusyError();
    }
    await deps.jobs
      .cancel(computerControlExpireJobKey(computerId, previousControl.controlLeaseId))
      .catch((error) => {
        getLogger().error("computer control expiry cancellation", error);
      });
  }
  if (previousControl) {
    try {
      const bot = await deps.prisma.bot.findFirst({
        where: { id: botId },
        select: { thread: { select: { id: true } } },
      });
      if (bot?.thread) {
        await deps.events.append({
          spaceId: context.spaceId,
          threadId: bot.thread.id,
          botId,
          type: "computer.takeover.released",
          payload: {
            holder: "none",
            leaseId: previousControl.controlLeaseId,
            reason: "released",
          },
        });
      }
    } catch (error) {
      getLogger().error("maintenance takeover release event", error);
    }
  }

  const oldRef = existing.providerRef ? toComputerRef(existing) : null;
  let stopRequested = false;
  let settled = false;
  try {
    // Retry the checkpoint even after an earlier update left the row in error.
    if (
      oldRef &&
      !existing.restorePending &&
      !recoveryRequired &&
      (mode === "update" || (existing.state === "running" && mode === "recover"))
    ) {
      await onProgress?.("saving");
      await saveComputerBeforeStop(deps, existing, oldRef, context, suspensionClaim);
    }
    await onProgress?.("recreating");
    if (oldRef) {
      const lease = context.screenLeaseId ? parseScreenLeaseId(context.screenLeaseId) : null;
      await requestClaimedComputerStop(
        deps,
        { ...suspensionClaim, ...heldByNobodyElse(lease) },
        oldRef,
        context,
        "destroy",
        oldRef.kind === "desktop" ? { retireWorkspace: true } : undefined,
      );
      stopRequested = true;
    }
    const stopped = await deps.prisma.computer.updateMany({
      where: { ...suspensionClaim, stopRequestedAt: stopRequested ? { not: null } : null },
      data: {
        state: "stopped",
        providerRef: null,
        restorePending: true,
        stopRequestedAt: null,
        ...stoppedComputerControl,
        updatedAt: claimStamp,
      },
    });
    if (stopped.count !== 1) throw new ComputerBusyError();
    settled = true;
    return await provisionComputer(deps, computerId, context, controlHolder, onProgress);
  } catch (error) {
    if (!settled) {
      const uncertain = stopRequested || isSandboxUnsafeStop(error);
      await deps.prisma.computer
        .updateMany({
          where: { ...suspensionClaim, stopRequestedAt: uncertain ? { not: null } : null },
          data: uncertain
            ? { state: "quarantined", stopRequestedAt: null, ...stoppedComputerControl }
            : {
                state: previousState,
                stopRequestedAt: existing.stopRequestedAt,
                // A provider screen was already revoked if hand-back succeeded.
                ...(previousControl ? stoppedComputerControl : {}),
              },
        })
        .catch(() => undefined);
    }
    throw error;
  }
}
