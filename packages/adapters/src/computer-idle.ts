import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { computerSleepJob, SandboxRateLimitError } from "@rakazo/adapter-kit";
import { COMPUTER_ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { expireComputerExecutionLeases } from "@rakazo/db";
import { computerActiveDeadline, scheduleComputerActiveLimit } from "./computer-active-limit.js";
import { expireComputerControl, hasActiveComputerControl } from "./computer-control.js";
import {
  checkpointComputerBeforeStop,
  isSandboxUnsafeStop,
  powerProvider,
  publishComputerPowerStatus,
  requestClaimedComputerStop,
  savedComputerPowerState,
  stoppedComputerControl,
} from "./computer-power.js";
import { notifyWorkspaceSaveChanged } from "./computer-save-status.js";
import { toComputerRef } from "./computer-support.js";
import { ComputerCheckpointChangedError, type ParkedComputerLeases } from "./computer-workspace.js";
import { isSandboxGoneError } from "./e2b-sandbox.js";

export const DEFAULT_SANDBOX_IDLE_MS = 10 * 60 * 1000;
const BACKGROUND_WORK_MARKER_PREFIX = "/tmp/rakazo-background-";
const BACKGROUND_WORK_IDLE_SENTINEL = "rakazo-background-idle";

export const BACKGROUND_WORK_LAUNCH = [
  `marker="${BACKGROUND_WORK_MARKER_PREFIX}$1-$2-$3"`,
  "set -o noclobber",
  'exec 9>"$marker" || exit 1',
  "set +o noclobber",
  'exec bash -lc "$4"',
].join("\n");

/** Terminate background shell wrappers for one cancelled run. Browser teardown stays screen-scoped. */
export const CANCEL_COMPUTER_RUN_WORK = [
  'computerId="$1"',
  'runId="$2"',
  '[ -n "$computerId" ] && [ -n "$runId" ] || exit 0',
  `prefix="${BACKGROUND_WORK_MARKER_PREFIX}$computerId-$runId-"`,
  // Match the timeout wrapper cmdline (still contains the launch tag after exec into the user command).
  `pkill -TERM -f "rakazo-background-launch $computerId $runId " 2>/dev/null || true`,
  "if [ -d /proc ]; then",
  "  for fd in /proc/[0-9]*/fd/*; do",
  '    target="$(readlink "$fd" 2>/dev/null)" || continue',
  '    case "$target" in',
  '      "$prefix"*)',
  `        pid="\${fd#/proc/}"; pid="\${pid%%/*}"`,
  '        if [ -n "$pid" ] && [ "$pid" -eq "$pid" ] 2>/dev/null; then',
  // Never kill -PID (process group): sandbox work often shares the caller's PGID.
  '          kill -TERM "$pid" 2>/dev/null || true',
  "        fi",
  "        ;;",
  "    esac",
  "  done",
  'elif [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsof >/dev/null 2>&1; then',
  '  for marker in "$prefix"*; do',
  '    [ -e "$marker" ] || continue',
  '    for pid in $(lsof -t -- "$marker" 2>/dev/null); do',
  '      kill -TERM "$pid" 2>/dev/null || true',
  "    done",
  "  done",
  "fi",
  "sleep 0.2",
  `pkill -KILL -f "rakazo-background-launch $computerId $runId " 2>/dev/null || true`,
  "if [ -d /proc ]; then",
  "  for fd in /proc/[0-9]*/fd/*; do",
  '    target="$(readlink "$fd" 2>/dev/null)" || continue',
  '    case "$target" in',
  '      "$prefix"*)',
  `        pid="\${fd#/proc/}"; pid="\${pid%%/*}"`,
  '        if [ -n "$pid" ] && [ "$pid" -eq "$pid" ] 2>/dev/null; then',
  '          kill -KILL "$pid" 2>/dev/null || true',
  "        fi",
  "        ;;",
  "    esac",
  "  done",
  'elif [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsof >/dev/null 2>&1; then',
  '  for marker in "$prefix"*; do',
  '    [ -e "$marker" ] || continue',
  '    for pid in $(lsof -t -- "$marker" 2>/dev/null); do',
  '      kill -KILL "$pid" 2>/dev/null || true',
  "    done",
  "  done",
  "fi",
  'rm -f -- "$prefix"* 2>/dev/null || true',
].join("\n");

/**
 * Kill the primary browser session without matching chromium-screen-* profiles.
 * Covers Docker (--user-data-dir=.../chromium) and portable launches that only
 * use the symlinked primary profile (E2B desktop.launch / Daytona nohup).
 */
export const CANCEL_PRIMARY_BROWSER_WORK = [
  "pkill -TERM -f -- '--user-data-dir=.*/.browser-profiles/chromium$' || true",
  "pkill -TERM -f -- '--user-data-dir=.*/.browser-profiles/chromium ' || true",
  // Portable primary browsers often omit --user-data-dir; match argv0 only so
  // unrelated processes (e.g. node --engine=chromium) are not killed.
  "if [ -d /proc ]; then for pid in /proc/[0-9]*; do",
  '  cmdline="$(tr "\\0" " " <"$pid/cmdline" 2>/dev/null)" || continue',
  '  case "$cmdline" in *chromium-screen-*) continue ;; esac',
  '  argv0=""; IFS= read -r -d "" argv0 <"$pid/cmdline" || true',
  '  case "$argv0" in',
  "    */google-chrome|*/google-chrome-*|google-chrome|google-chrome-*|*/chromium|*/chromium-*|chromium|chromium-*|*/chrome|chrome|*/firefox|*/firefox-*|firefox|firefox-*)",
  `      kill -TERM "\${pid#/proc/}" 2>/dev/null || true`,
  "      ;;",
  "  esac",
  "done; fi",
  "sleep 0.2",
  "pkill -KILL -f -- '--user-data-dir=.*/.browser-profiles/chromium$' || true",
  "pkill -KILL -f -- '--user-data-dir=.*/.browser-profiles/chromium ' || true",
  "if [ -d /proc ]; then for pid in /proc/[0-9]*; do",
  '  cmdline="$(tr "\\0" " " <"$pid/cmdline" 2>/dev/null)" || continue',
  '  case "$cmdline" in *chromium-screen-*) continue ;; esac',
  '  argv0=""; IFS= read -r -d "" argv0 <"$pid/cmdline" || true',
  '  case "$argv0" in',
  "    */google-chrome|*/google-chrome-*|google-chrome|google-chrome-*|*/chromium|*/chromium-*|chromium|chromium-*|*/chrome|chrome|*/firefox|*/firefox-*|firefox|firefox-*)",
  `      kill -KILL "\${pid#/proc/}" 2>/dev/null || true`,
  "      ;;",
  "  esac",
  "done; fi",
  'rm -f "$HOME/.browser-profiles/chromium/SingletonLock" "$HOME/.browser-profiles/chromium/SingletonCookie" "$HOME/.browser-profiles/chromium/SingletonSocket" 2>/dev/null || true',
].join("; ");

export function cancelComputerRunWorkArgv(computerId: string, runId: string): string[] {
  return ["bash", "-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, runId];
}

export async function cancelComputerRunWork(
  sandbox: Pick<SandboxProvider, "execute">,
  computer: ComputerRef,
  computerId: string,
  runId: string,
  context: AdapterContext,
): Promise<void> {
  if (!computerId || !runId) return;
  try {
    for await (const _event of sandbox.execute(
      computer,
      { argv: cancelComputerRunWorkArgv(computerId, runId), timeoutMs: 15_000 },
      context,
    )) {
      // Drain so providers can finish the exec session.
    }
  } catch {
    // Best effort after the run is already cancelled.
  }
}

export const BACKGROUND_WORK_PROBE = [
  `prefix="${BACKGROUND_WORK_MARKER_PREFIX}$1-"`,
  `idle() { printf '${BACKGROUND_WORK_IDLE_SENTINEL}\\n'; exit 1; }`,
  'markers=("$prefix"*)',
  "if [ -d /proc ]; then",
  "  command -v readlink >/dev/null 2>&1 || exit 2",
  "  for fd in /proc/[0-9]*/fd/*; do",
  '    target="$(readlink "$fd" 2>/dev/null)"',
  '    case "$target" in "$prefix"*) exit 0 ;; esac',
  "  done",
  `  for marker in "\${markers[@]}"; do [ -e "$marker" ] && rm -f -- "$marker"; done`,
  "  idle",
  "fi",
  'if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then',
  "  command -v lsof >/dev/null 2>&1 || exit 2",
  `  for marker in "\${markers[@]}"; do`,
  '    [ -e "$marker" ] || continue',
  '    lsof -t -- "$marker" >/dev/null 2>&1 && exit 0',
  '    rm -f -- "$marker"',
  "  done",
  "  idle",
  "fi",
  "exit 2",
].join("\n");

export function sandboxIdleMs(): number {
  const raw = Number(process.env.SANDBOX_IDLE_MS ?? DEFAULT_SANDBOX_IDLE_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_SANDBOX_IDLE_MS;
}

export function computerIdleSleepEnabled(): boolean {
  return process.env.SANDBOX_IDLE_MS?.trim() !== "0";
}

export function scheduleComputerSleep(
  jobs: JobPublisher,
  computerId: string,
  retryAfterMs = 0,
): void {
  if (!computerId || !computerIdleSleepEnabled()) return;
  const delay = Math.max(sandboxIdleMs(), Math.min(retryAfterMs, 60 * 60_000));
  void jobs.enqueue(computerSleepJob(computerId, new Date(Date.now() + delay)));
}

export async function touchRunningComputer(
  deps: { sandbox: SandboxProvider; jobs: JobPublisher },
  computer: {
    id: string;
    homeKey: string;
    providerRef: string;
    providerAuthority?: string | null;
    kind: string;
    runningSince?: Date | null;
    controlHolder: string;
    controlLeaseId: string | null;
    controlLeaseExpiresAt: Date | null;
  },
): Promise<void> {
  const ref = toComputerRef(computer);
  const deadline = computerActiveDeadline(deps.sandbox, ref, computer.runningSince);
  if (deadline && deadline.getTime() <= Date.now() && !hasActiveComputerControl(computer)) return;
  scheduleComputerSleep(deps.jobs, computer.id);
  await deps.sandbox.keepAlive?.(ref, { onlyIfRunning: true });
}

export async function sleepComputerIfIdle(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
  },
  computerId: string,
  activeSince?: string,
): Promise<void> {
  if (!activeSince && !computerIdleSleepEnabled()) return;
  let computer = await loadComputer(deps.prisma, computerId);
  if (!computer?.providerRef || computer.state !== "running" || computer.kind === "desktop") return;

  const deadline = computerActiveDeadline(
    deps.sandbox,
    toComputerRef(computer),
    computer.runningSince,
  );
  if (activeSince && (!deadline || computer.runningSince?.toISOString() !== activeSince)) return;
  const retry = (retryAfterMs = 0, whileInUse = false) => {
    if (activeSince && computer?.runningSince) {
      const baseDelay = whileInUse ? Math.min(60_000, sandboxIdleMs() / 2) : sandboxIdleMs();
      const at = new Date(Date.now() + Math.max(baseDelay, Math.min(retryAfterMs, 60 * 60_000)));
      void scheduleComputerActiveLimit(deps.jobs, computerId, computer.runningSince, at);
    } else {
      scheduleComputerSleep(deps.jobs, computerId, retryAfterMs);
    }
  };
  if (deadline && activeSince && deadline.getTime() > Date.now()) {
    await scheduleComputerActiveLimit(deps.jobs, computerId, computer.runningSince!, deadline);
    return;
  }
  // A distinct key keeps the maximum runtime from moving when viewers reschedule idle sleep.
  if (!activeSince && deadline && deadline.getTime() <= Date.now()) return;

  if (computer.controlBotId && computer.controlLeaseId && !hasActiveComputerControl(computer)) {
    await expireComputerControl(deps, computer.id, computer.controlLeaseId);
    computer = await loadComputer(deps.prisma, computerId);
    if (!computer?.providerRef || computer.state !== "running") return;
    if (activeSince && computer.runningSince?.toISOString() !== activeSince) return;
  }
  const ref = toComputerRef(computer);
  const protectUse = async () => {
    retry(0, true);
    if (activeSince) {
      await powerProvider(deps.sandbox, ref)?.keepAlive?.(ref, { onlyIfRunning: true });
    }
  };
  if (hasActiveComputerControl(computer)) {
    await protectUse();
    return;
  }

  if (activeSince && computer.executionRunId) {
    const { executionRunId } = computer;
    const run = await deps.prisma.run.findFirst({
      where: { id: executionRunId, spaceId: computer.spaceId },
      select: { status: true },
    });
    if (run && !["completed", "failed", "cancelled"].includes(run.status)) {
      retry();
      return;
    }
    // A stranded pre-lease binding to an ended run must not hold a new runtime indefinitely.
    const cleared = await deps.prisma.computer.updateMany({
      where: { id: computerId, state: "running", executionRunId, updatedAt: computer.updatedAt },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
        updatedAt: computer.updatedAt,
      },
    });
    if (cleared.count !== 1) {
      retry();
      return;
    }
  }

  const activeStatuses = COMPUTER_ACTIVE_RUN_STATUSES.filter(
    (status) => status !== "waiting_takeover",
  );
  const runHolds = () =>
    activeSince
      ? deps.prisma.run.findFirst({
          where: { bot: { computerId }, ...executingRun(new Date()) },
          select: { id: true },
        })
      : findActiveRun(deps.prisma, computerId, activeStatuses);
  if (await runHolds()) {
    await protectUse();
    return;
  }

  const ctx: AdapterContext = {
    operationId: "computer.sleep",
    traceId: "computer.sleep",
    spaceId: computer.spaceId,
    userId: computer.userId,
    botId: computer.controlBotId ?? undefined,
    signal: new AbortController().signal,
  };
  let stopped = await savedComputerPowerState(deps, computer, ref, ctx);
  if (
    !activeSince &&
    !stopped &&
    !computer.restorePending &&
    (await hasActiveBackgroundWork(deps.sandbox, ref, ctx, computerId))
  ) {
    retry();
    await deps.sandbox.keepAlive?.(ref);
    return;
  }

  const checkpointedAt = new Date(Math.max(Date.now(), computer.updatedAt.getTime() + 1));
  const parked = activeSince
    ? await parkedTakeoverLeases(deps.prisma, computerId, checkpointedAt)
    : [];
  const limitGuard = (now: Date): Prisma.ComputerWhereInput =>
    activeSince
      ? {
          runningSince: new Date(activeSince),
          bots: { none: { runs: { some: executingRun(now) } } },
          OR: [
            { controlHolder: { not: "user" } },
            { controlLeaseId: null },
            { controlLeaseExpiresAt: null },
            { controlLeaseExpiresAt: { lte: now } },
          ],
        }
      : {};
  const recorded = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      state: "running",
      maintenanceId: null,
      providerRef: computer.providerRef,
      ...(computer.providerAuthority !== undefined
        ? { providerAuthority: computer.providerAuthority }
        : {}),
      kind: computer.kind,
      screenGeneration: computer.screenGeneration,
      stopRequestedAt: null,
      updatedAt: computer.updatedAt,
      executionRunId: null,
      ...limitGuard(checkpointedAt),
      ...blockingLeases(parked, checkpointedAt),
    },
    data: { state: "suspending", updatedAt: checkpointedAt },
  });
  if (recorded.count !== 1) {
    retry();
    return;
  }
  const suspensionClaim = {
    id: computerId,
    state: "suspending",
    providerRef: computer.providerRef,
    kind: computer.kind,
    // The database revokes screen capabilities when running becomes suspending.
    screenGeneration: computer.screenGeneration + 1,
    maintenanceId: null,
    ...(computer.providerAuthority !== undefined
      ? { providerAuthority: computer.providerAuthority }
      : {}),
    updatedAt: checkpointedAt,
    ...(activeSince ? { runningSince: new Date(activeSince) } : {}),
  };

  let damaged = false;
  try {
    if (stopped === "stopped") {
      stopped = await savedComputerPowerState(deps, computer, ref, ctx);
    }
    if (!stopped && !computer.restorePending) {
      const loss = await checkpointComputerBeforeStop(
        deps,
        computer,
        ref,
        ctx,
        suspensionClaim,
        parked,
      );
      damaged = loss === "damaged";
      if (loss === "gone") stopped = loss;
    }
  } catch (error) {
    await deps.prisma.computer.updateMany({
      where: { ...suspensionClaim, stopRequestedAt: null },
      data: { state: "running" },
    });
    retry(error instanceof SandboxRateLimitError ? error.retryAfterMs : undefined);
    if (!(error instanceof ComputerCheckpointChangedError)) throw error;
    return;
  }

  if (stopped !== "gone") {
    const [current, activeAfterCheckpoint, backgroundAfterCheckpoint] = await Promise.all([
      deps.prisma.computer.findUnique({
        where: { id: computerId },
        select: { state: true, providerRef: true, updatedAt: true },
      }),
      runHolds(),
      activeSince || stopped || damaged || computer.restorePending
        ? false
        : hasActiveBackgroundWork(deps.sandbox, ref, ctx, computerId),
    ]);
    if (activeAfterCheckpoint || backgroundAfterCheckpoint) {
      await deps.prisma.computer.updateMany({
        where: suspensionClaim,
        data: { state: "running" },
      });
      retry();
      if (backgroundAfterCheckpoint) await deps.sandbox.keepAlive?.(ref);
      return;
    }
    if (
      current?.state !== "suspending" ||
      current.providerRef !== computer.providerRef ||
      current.updatedAt.getTime() !== checkpointedAt.getTime()
    ) {
      await deps.prisma.computer.updateMany({
        where: suspensionClaim,
        data: { state: "running" },
      });
      retry();
      return;
    }
  }

  const stopRequired = !stopped;
  try {
    stopped ??= await requestClaimedComputerStop(
      deps,
      { ...limitGuard(new Date()), ...blockingLeases(parked, new Date()), ...suspensionClaim },
      ref,
      ctx,
    );
  } catch (error) {
    const quarantined = isSandboxUnsafeStop(error);
    const changed = await deps.prisma.computer.updateMany({
      where: { ...suspensionClaim, stopRequestedAt: quarantined ? { not: null } : null },
      data: quarantined
        ? { state: "quarantined", stopRequestedAt: null, ...stoppedComputerControl }
        : { state: "running" },
    });
    if (quarantined && changed.count === 1) {
      await publishComputerPowerStatus(deps, computer, "quarantined");
    }
    if (!quarantined)
      retry(error instanceof SandboxRateLimitError ? error.retryAfterMs : undefined);
    throw error;
  }
  const state = stopped === "gone" ? "stopped" : damaged ? "needs_recovery" : "suspended";
  const pauseReason = state === "suspended" && activeSince && stopRequired ? "active_limit" : null;
  const settle = (prisma: Pick<PrismaClient, "computer">) =>
    prisma.computer.updateMany({
      where: { ...suspensionClaim, stopRequestedAt: stopRequired ? { not: null } : null },
      data: {
        state,
        stopRequestedAt: null,
        ...(computer.runningSince ? { runningSince: null } : {}),
        ...(pauseReason ? { suspensionReason: pauseReason } : {}),
        ...(damaged || stopped === "gone" ? { restorePending: true } : {}),
        ...(stopped === "gone" ? { providerRef: null } : {}),
        ...stoppedComputerControl,
      },
    });
  const settled =
    parked.length > 0
      ? await deps.prisma.$transaction(async (tx) => {
          const result = await settle(tx);
          if (result.count === 1) {
            await expireComputerExecutionLeases(tx, { computerId, OR: [...parked] });
          }
          return result;
        })
      : await settle(deps.prisma);
  if (settled.count === 1) {
    await publishComputerPowerStatus(deps, computer, state, pauseReason);
    if (pauseReason) await notifyWorkspaceSaveChanged(deps, computer);
  } else if (stopRequired) throw new ComputerCheckpointChangedError();
}

function loadComputer(prisma: PrismaClient, computerId: string) {
  return prisma.computer.findUnique({
    where: { id: computerId },
    select: {
      id: true,
      homeKey: true,
      scope: true,
      providerRef: true,
      providerAuthority: true,
      kind: true,
      screenGeneration: true,
      state: true,
      homeRevisionAt: true,
      runningSince: true,
      executionRunId: true,
      restorePending: true,
      spaceId: true,
      userId: true,
      controlHolder: true,
      controlLeaseId: true,
      controlLeaseExpiresAt: true,
      controlBotId: true,
      updatedAt: true,
    },
  });
}

function executingRun(now: Date): Prisma.RunWhereInput {
  return { status: { in: ["leased", "running"] }, leaseExpiresAt: { gt: now } };
}

function blockingLeases(parked: ParkedComputerLeases, now: Date): Prisma.ComputerWhereInput {
  return {
    executionLeases: {
      none: { expiresAt: { gt: now }, ...(parked.length ? { NOT: [...parked] } : {}) },
    },
  };
}

async function parkedTakeoverLeases(
  prisma: PrismaClient,
  computerId: string,
  now: Date,
): Promise<ParkedComputerLeases> {
  const leases = await prisma.computerExecutionLease.findMany({
    where: { computerId, expiresAt: { gt: now } },
    select: { botId: true, runId: true, fence: true },
  });
  if (leases.length === 0) return [];
  const waiting = await prisma.run.findMany({
    where: {
      bot: { computerId },
      id: { in: leases.map((lease) => lease.runId) },
      status: "waiting_takeover",
    },
    select: { id: true, botId: true },
  });
  return leases.filter((lease) =>
    waiting.some((run) => run.id === lease.runId && run.botId === lease.botId),
  );
}

function findActiveRun(prisma: PrismaClient, computerId: string, statuses: readonly string[]) {
  return prisma.run.findFirst({
    where: {
      bot: { computerId },
      status: { in: statuses as (typeof COMPUTER_ACTIVE_RUN_STATUSES)[number][] },
    },
    select: { id: true },
  });
}

async function hasActiveBackgroundWork(
  sandbox: SandboxProvider,
  computer: ReturnType<typeof toComputerRef>,
  context: AdapterContext,
  computerId: string,
): Promise<boolean> {
  if (sandbox.inspectBackgroundWork) {
    try {
      return (await sandbox.inspectBackgroundWork(computer, computerId, context)) !== "idle";
    } catch (error) {
      return !isGoneComputerError(computer, error);
    }
  }
  let exitCode: number | undefined;
  let stdout = "";
  try {
    for await (const event of sandbox.execute(
      computer,
      {
        argv: ["bash", "-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", computerId],
        timeoutMs: 10_000,
      },
      context,
    )) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "exit") exitCode = event.code;
    }
  } catch (error) {
    return !isGoneComputerError(computer, error);
  }
  // Only the probe's explicit idle result permits suspension; unsupported or failed probes retry.
  return exitCode !== 1 || stdout.trim() !== BACKGROUND_WORK_IDLE_SENTINEL;
}

/** Only the matching provider's resource-loss evidence can discard a computer reference. */
function isGoneComputerError(computer: ComputerRef, error: unknown): boolean {
  return computer.kind === "e2b" && !isSandboxUnsafeStop(error) && isSandboxGoneError(error);
}
