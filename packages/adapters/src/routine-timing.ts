import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import {
  hasMixedOneShotSchedule,
  intervalUsesAnchor,
  isIntervalCron,
  isOneShotRoutineCrons,
  nextRoutineDateFrom,
  nextRoutineOccurrence,
  parseRoutineDateTime,
  retimeIntervalAnchor,
  retimeRoutineStart,
  retimeRoutineTimezone,
} from "@rakazo/core";
import type { PrismaClient, Routine } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export class RoutineTimingError extends Error {}

export function repeatStartAt(value: string, timezone: string, now: Date): Date {
  const date = parseRoutineDateTime(value, timezone);
  if (!date) throw new RoutineTimingError("Start time must be a valid ISO date or datetime.");
  if (date < now) throw new RoutineTimingError("Start time must be in the future.");
  return date;
}

export function routineNextRepeat(
  crons: string[],
  timezone: string,
  now: Date,
  startAt?: Date | null,
) {
  try {
    const next = nextRoutineDateFrom(crons, now, timezone, startAt);
    if (next) return next;
  } catch {
    // Report a bad persisted schedule as an input error.
  }
  throw new RoutineTimingError("Enter a valid cron expression.");
}

export function routineIntervalMode(crons: string[], requested?: boolean): boolean {
  if (!requested) return false;
  if (crons.length === 1 && isIntervalCron(crons[0] ?? "")) return true;
  throw new RoutineTimingError("An interval requires one repeating interval schedule.");
}

type Timing = Pick<
  Routine,
  "crons" | "timezone" | "active" | "nextRunAt" | "startAt" | "intervalBased" | "intervalAnchorAt"
>;

/** Recompute only when the schedule changes. Metadata edits leave worker progress alone. */
export function patchRoutineTiming(
  current: Timing,
  input: {
    crons?: string[];
    timezone?: string;
    active?: boolean;
    startAt?: string | null;
    runAt?: Date;
    intervalBased?: boolean;
  },
  now: Date,
) {
  const crons = input.crons ?? current.crons;
  const timezone = input.timezone ?? current.timezone;
  const active = input.active ?? current.active;
  if (hasMixedOneShotSchedule(crons)) {
    throw new RoutineTimingError("A one-time schedule can't be combined with other schedules.");
  }
  const oneShot = isOneShotRoutineCrons(crons);
  const repeating = crons.length > 0 && !oneShot;
  const cronsChanged =
    crons.length !== current.crons.length || crons.some((cron, i) => cron !== current.crons[i]);
  const intervalBased = routineIntervalMode(
    crons,
    input.intervalBased ?? (!cronsChanged && current.intervalBased),
  );
  const cadenceChanged = cronsChanged || intervalBased !== (current.intervalBased ?? false);
  if (!repeating && input.startAt !== undefined) {
    throw new RoutineTimingError("Start time is only for repeating schedules.");
  }
  const timezoneChanged = timezone !== current.timezone;
  let startAt = current.startAt;
  if (!repeating || input.startAt === null) startAt = null;
  else if (input.startAt !== undefined) startAt = repeatStartAt(input.startAt, timezone, now);
  else if (timezoneChanged && startAt && startAt > now)
    startAt = retimeRoutineStart(crons, startAt, current.timezone, timezone, intervalBased);

  const floorChanged = startAt?.getTime() !== current.startAt?.getTime();
  const retime = cadenceChanged || timezoneChanged || floorChanged;
  const resettingAnchor = cadenceChanged || (input.startAt !== undefined && floorChanged);
  const usesAnchor = intervalUsesAnchor(crons, intervalBased);
  // The live cursor has advanced past fired occurrences. Keep it when pausing so
  // a later timezone edit cannot bring a consumed calendar day back into the future.
  let intervalAnchorAt =
    usesAnchor && !resettingAnchor ? (current.nextRunAt ?? current.intervalAnchorAt) : null;
  if (intervalAnchorAt && timezoneChanged) {
    intervalAnchorAt = retimeIntervalAnchor(
      crons[0] ?? "",
      intervalAnchorAt,
      current.timezone,
      timezone,
    );
  }
  if (usesAnchor && !intervalAnchorAt) {
    intervalAnchorAt = routineNextRepeat(crons, timezone, now, startAt);
  }

  const activating = active && !current.active;
  let nextRunAt = current.nextRunAt;

  if (oneShot) {
    if (input.runAt && !active) {
      throw new RoutineTimingError("Resume this one-shot to save a new run time.");
    }
    if (input.runAt && (!Number.isFinite(input.runAt.getTime()) || input.runAt <= now)) {
      throw new RoutineTimingError("Run time must be in the future.");
    }
    nextRunAt = input.runAt ?? nextRunAt;
    if (active && (!nextRunAt || (input.active === true && nextRunAt <= now))) {
      throw new RoutineTimingError("Add a run time for this one-shot.");
    }
  } else if (repeating && (retime || (active && (activating || !nextRunAt)))) {
    if (
      !intervalAnchorAt &&
      timezoneChanged &&
      !cadenceChanged &&
      input.startAt === undefined &&
      nextRunAt &&
      nextRunAt > now
    ) {
      try {
        const carried = retimeRoutineTimezone(crons, nextRunAt, now, current.timezone, timezone);
        nextRunAt =
          carried && (!startAt || carried >= startAt)
            ? carried
            : routineNextRepeat(crons, timezone, now, startAt);
      } catch {
        throw new RoutineTimingError("Enter a valid cron expression.");
      }
    } else {
      const fromInterval = intervalAnchorAt
        ? intervalAnchorAt >= now
          ? intervalAnchorAt
          : nextRoutineOccurrence(crons, intervalAnchorAt, now, timezone, true)
        : null;
      nextRunAt =
        fromInterval && (!startAt || fromInterval >= startAt)
          ? fromInterval
          : routineNextRepeat(crons, timezone, now, startAt);
    }
  } else if (!repeating) nextRunAt = null;

  if (!active) nextRunAt = null;
  const changed =
    retime || active !== current.active || nextRunAt?.getTime() !== current.nextRunAt?.getTime();
  return {
    changed,
    data: { crons, timezone, active, nextRunAt, startAt, intervalBased, intervalAnchorAt },
  };
}

const MAX_ACTIVE_ROUTINES = 50;

/** Call inside the same serializable transaction as the write that admits the routine. */
export async function routineAdmissionError(
  prisma: Pick<PrismaClient, "routine">,
  scope: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string | null;
    directThreadId?: string;
    name: string;
  },
  existing?: Pick<Routine, "id" | "active" | "name">,
): Promise<string | undefined> {
  const normalize = (value: string) => value.trim().toLowerCase();
  const name = normalize(scope.name);
  const conversation = scope.threadId ?? scope.directThreadId;
  if (existing?.active && normalize(existing.name) === name) return undefined;
  const active = await prisma.routine.findMany({
    where: { spaceId: scope.spaceId, botId: scope.botId, active: true },
    select: { id: true, userId: true, threadId: true, name: true },
  });
  if (
    active.some(
      (row) =>
        row.id !== existing?.id &&
        row.userId === scope.userId &&
        (row.threadId ?? scope.directThreadId) === conversation &&
        normalize(row.name) === name,
    )
  ) {
    return "An active routine already has that name in this conversation.";
  }
  if (!existing?.active && active.length >= MAX_ACTIVE_ROUTINES) {
    return `This bot already has ${MAX_ACTIVE_ROUTINES} active routines. Pause or cancel one to add another.`;
  }
}

/** The stored occurrence is authoritative. Reconciliation restores a missed enqueue. */
export async function syncRoutineWakeup(
  jobs: JobPublisher,
  row: Pick<Routine, "id" | "active" | "nextRunAt">,
): Promise<void> {
  try {
    if (row.active && row.nextRunAt) await jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
    else await jobs.cancel(routineJobKey(row.id));
  } catch (error) {
    getLogger().warn("routine.wakeup_sync_failed", { routineId: row.id, error });
  }
}
