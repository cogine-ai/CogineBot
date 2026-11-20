import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineJobKey } from "@rakazo/adapter-kit";
import { TimeZoneSchema } from "@rakazo/contracts";
import {
  cronFromPreset,
  intervalUsesAnchor,
  isOneShotRoutineCron,
  isOneShotRoutineCrons,
  ONCE_ROUTINE_CRON,
  parseRoutineDateTime,
} from "@rakazo/core";
import { sitesInText } from "@rakazo/core/egress";
import type { PrismaClient, Routine, ThreadEvents } from "@rakazo/db";
import { lockActiveRoutineGroup, Prisma, withTransactionRetry } from "@rakazo/db";
import { listNativeRoutineTriggersBatch } from "./native-connectors/events/store.js";
import { nativeSourceJob } from "./native-connectors/events/worker.js";
import {
  patchRoutineTiming,
  publishRoutineTiming,
  RoutineTimingError,
  repeatStartAt,
  routineAdmissionError,
  routineNextRepeat,
  syncRoutineWakeup,
} from "./routine-timing.js";

export { isOneShotRoutineCron, ONCE_ROUTINE_CRON };

export const SCHEDULE_TOOL_NAMES = new Set([
  "schedule_create",
  "schedule_list",
  "schedule_update",
  "schedule_cancel",
]);

export function isRoutinePromptTool(name: string): boolean {
  return name === "schedule_create" || name === "schedule_update";
}

const ROUTINE_SITE_APPROVAL_TAG = "routine-site-approval-v1";

/** Store the exact schedule arguments and destinations shown on its dedicated approval card. */
export function routineSiteApprovalRequest(args: Record<string, unknown>, sites: string[]) {
  return [ROUTINE_SITE_APPROVAL_TAG, args, sites];
}

export function routineSiteApprovalDetails(
  request: unknown,
): { args: Record<string, unknown>; sites: string[] } | undefined {
  if (!Array.isArray(request) || request.length !== 3 || request[0] !== ROUTINE_SITE_APPROVAL_TAG)
    return undefined;
  const [, args, sites] = request;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  if (
    !Array.isArray(sites) ||
    sites.length === 0 ||
    !sites.every((site) => typeof site === "string")
  )
    return undefined;
  const promptSites = [...sitesInText(typeof args.prompt === "string" ? args.prompt : "")];
  if (
    promptSites.length !== sites.length ||
    promptSites.some((site, index) => site !== sites[index])
  )
    return undefined;
  return { args, sites };
}

export function filterBuiltinToolsForRun<T extends { name: string }>(
  tools: T[],
  runTrigger: string,
): T[] {
  return runTrigger === "routine" ? tools.filter((tool) => !isRoutinePromptTool(tool.name)) : tools;
}

/** Keep cross-bot messaging thread-specific while exposing schedules in DMs and groups. */
export function filterBuiltinToolsForThread<T extends { name: string }>(
  tools: T[],
  groupId: string | null | undefined,
): T[] {
  return tools.filter(
    (tool) =>
      (groupId || tool.name !== "handoff_to_bot") &&
      // In a group the room is the shared surface: hand the stage to a member
      // rather than starting a private thread off to one side.
      (!groupId || tool.name !== "message_bot"),
  );
}

type ScheduleUnit = "minutes" | "hours" | "days" | "seconds";

export type ResolvedSchedule =
  | { ok: true; cron: string; nextRunAt: Date; oneShot: boolean; startAt?: Date }
  | { ok: false; error: string };

/**
 * Providers sometimes serialize omitted optional tool fields as null or an empty
 * string. Treat those values as absent, while preserving numeric zero so the
 * normal validation can reject an invalid zero interval/delay with a useful
 * error instead of reporting two schedule modes at once.
 */
export function isScheduleValueProvided(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

export function compactScheduleInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => isScheduleValueProvided(value)),
  );
}

const TIMING_KEYS = ["cron", "every", "unit", "runAt", "delayMinutes", "delaySeconds"] as const;

export function scheduleTimingArguments(args: Record<string, unknown>): Record<string, unknown> {
  return compactScheduleInput(
    Object.fromEntries([...TIMING_KEYS, "startAt"].map((name) => [name, args[name]])),
  );
}

export function resolveScheduleTiming(
  input: {
    cron?: unknown;
    every?: unknown;
    unit?: unknown;
    runAt?: unknown;
    delayMinutes?: unknown;
    delaySeconds?: unknown;
    startAt?: unknown;
  },
  timezone = "UTC",
  now = new Date(),
): ResolvedSchedule {
  if (!TimeZoneSchema.safeParse(timezone).success) return { ok: false, error: "Unknown timezone." };
  const hasRepeat =
    isScheduleValueProvided(input.cron) ||
    isScheduleValueProvided(input.every) ||
    isScheduleValueProvided(input.unit);
  const hasOneShot =
    isScheduleValueProvided(input.runAt) ||
    isScheduleValueProvided(input.delayMinutes) ||
    isScheduleValueProvided(input.delaySeconds);
  if (hasRepeat && hasOneShot) {
    return {
      ok: false,
      error: "Provide either a repeating schedule or a one-shot time, not both.",
    };
  }
  if (!hasRepeat && !hasOneShot) {
    return {
      ok: false,
      error:
        "Provide cron, every/unit for repeating schedules, or runAt/delayMinutes/delaySeconds for one-shot.",
    };
  }
  const hasCron = isScheduleValueProvided(input.cron);
  const hasInterval = isScheduleValueProvided(input.every) || isScheduleValueProvided(input.unit);
  if (hasCron && hasInterval) {
    return {
      ok: false,
      error: "Provide exactly one timing method: cron, or every and unit, not both.",
    };
  }

  if (hasOneShot) {
    if (isScheduleValueProvided(input.startAt)) {
      return { ok: false, error: "Start time is only for repeating schedules." };
    }
    const oneShotFields = [input.runAt, input.delayMinutes, input.delaySeconds].filter(
      isScheduleValueProvided,
    );
    if (oneShotFields.length !== 1) {
      return {
        ok: false,
        error:
          "Provide exactly one of runAt, delayMinutes, or delaySeconds for a one-shot schedule.",
      };
    }
    let nextRunAt: Date;
    if (isScheduleValueProvided(input.delaySeconds)) {
      const delaySeconds = Number(input.delaySeconds);
      if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
        return { ok: false, error: "delaySeconds must be a non-negative number." };
      }
      nextRunAt = new Date(now.getTime() + delaySeconds * 1_000);
    } else if (isScheduleValueProvided(input.delayMinutes)) {
      const delayMinutes = Number(input.delayMinutes);
      if (!Number.isFinite(delayMinutes) || delayMinutes < 0) {
        return { ok: false, error: "delayMinutes must be a non-negative number." };
      }
      nextRunAt = new Date(now.getTime() + delayMinutes * 60_000);
    } else {
      const parsed = parseRoutineDateTime(String(input.runAt ?? ""), timezone);
      if (!parsed) {
        return { ok: false, error: "runAt must be a valid ISO datetime." };
      }
      nextRunAt = parsed;
    }
    if (!Number.isFinite(nextRunAt.getTime()) || nextRunAt <= now) {
      return { ok: false, error: "One-shot schedules must run in the future." };
    }
    return { ok: true, cron: ONCE_ROUTINE_CRON, nextRunAt, oneShot: true };
  }

  let startAt: Date | undefined;
  if (isScheduleValueProvided(input.startAt)) {
    try {
      startAt = repeatStartAt(String(input.startAt), timezone, now);
    } catch (error) {
      if (!(error instanceof RoutineTimingError)) throw error;
      return { ok: false, error: error.message };
    }
  }
  const first = startAt ? { startAt } : {};

  if (hasCron) {
    const cron = String(input.cron).trim();
    if (!cron) return { ok: false, error: "cron must be a non-empty 5-field cron expression." };
    if (isOneShotRoutineCron(cron)) {
      return {
        ok: false,
        error: "Use runAt, delayMinutes, or delaySeconds for one-shot schedules.",
      };
    }
    const intervalError = validateRepeatingCron(cron);
    if (intervalError) return { ok: false, error: intervalError };
    try {
      const nextRunAt = routineNextRepeat([cron], timezone, now, startAt);
      return { ok: true, cron, nextRunAt, oneShot: false, ...first };
    } catch {
      return { ok: false, error: "cron must be a valid 5-field cron expression." };
    }
  }

  const every = Number(input.every);
  const unit = String(input.unit ?? "") as ScheduleUnit;
  if (!Number.isFinite(every) || every <= 0 || !Number.isInteger(every)) {
    return { ok: false, error: "every must be a positive whole number." };
  }
  if (unit === "seconds") {
    return { ok: false, error: "minimum interval is 1 minute" };
  }
  if (!["minutes", "hours", "days"].includes(unit)) {
    return { ok: false, error: 'unit must be "minutes", "hours", or "days".' };
  }
  if (unit === "minutes" && every < 1) {
    return { ok: false, error: "minimum interval is 1 minute" };
  }
  const cron = cronFromPreset({ freq: "Interval", n: every, unit });
  const intervalError = validateRepeatingCron(cron);
  if (intervalError) return { ok: false, error: intervalError };
  try {
    const nextRunAt = routineNextRepeat([cron], timezone, now, startAt);
    return { ok: true, cron, nextRunAt, oneShot: false, ...first };
  } catch {
    return { ok: false, error: "every/unit produced an invalid cron expression." };
  }
}

function validateRepeatingCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "cron must be a 5-field cron expression.";
  const minuteExpr = parts[0] ?? "*";
  const step = /^\*\/(\d+)$/.exec(minuteExpr);
  if (step) {
    const n = Number(step[1]);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      return "minimum interval is 1 minute";
    }
  }
  return null;
}

export interface ScheduleToolDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "append">;
  jobs: JobPublisher;
}

async function publishGroupRoutineTiming(deps: ScheduleToolDeps, row: Routine): Promise<void> {
  if (!row.groupScoped) return;
  const direct = await deps.prisma.thread
    .findUnique({
      where: { botId: row.botId },
      select: { id: true, userId: true, spaceId: true },
    })
    .catch(() => null);
  if (direct) await publishRoutineTiming(deps.events, row, direct, row.active);
}

/** Persist and enqueue a bot routine that wakes in the originating thread. */
export async function createScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    directThreadId?: string;
    groupScoped?: boolean;
    name: string;
    prompt: string;
    authorizedSites?: string[];
    timezone?: string;
    schedule: Record<string, unknown>;
  },
) {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name) return { error: "name is required." };
  if (!prompt) return { error: "prompt is required." };
  if (name.length > 80) return { error: "name must be 80 characters or fewer." };

  const timezone = String(input.timezone ?? "UTC");
  const resolved = resolveScheduleTiming(input.schedule, timezone);
  if (!resolved.ok) return { error: resolved.error };
  const intervalBased = isScheduleValueProvided(input.schedule.every);

  const scope = {
    spaceId: input.spaceId,
    botId: input.botId,
    userId: input.userId,
    threadId: input.threadId,
  };
  const result = await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        if (input.groupScoped && !(await lockActiveRoutineGroup(tx, scope))) {
          return { error: "The original conversation is no longer available." };
        }
        const error = await routineAdmissionError(tx, {
          ...scope,
          name,
          directThreadId: input.directThreadId,
        });
        if (error) return { error };
        return {
          row: await tx.routine.create({
            data: {
              ...scope,
              name,
              prompt,
              ...(input.authorizedSites?.length ? { authorizedSites: input.authorizedSites } : {}),
              crons: [resolved.cron],
              timezone,
              notify: true,
              active: true,
              nextRunAt: resolved.nextRunAt,
              startAt: resolved.startAt,
              intervalBased,
              intervalAnchorAt: intervalUsesAnchor([resolved.cron], intervalBased)
                ? resolved.nextRunAt
                : null,
              groupScoped: input.groupScoped,
            },
          }),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  if (!result.row) return { error: result.error };
  const { row } = result;
  await syncRoutineWakeup(deps.jobs, row);

  try {
    await deps.events.append({
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "routine.created",
      payload: { name: row.name },
    });
  } catch {
    // Match routines.create: the reminder is live even if the thread signal fails.
  }
  await publishGroupRoutineTiming(deps, row);

  return {
    ok: true as const,
    routineId: row.id,
    name: row.name,
    cron: row.crons[0],
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    timezone: row.timezone,
    oneShot: resolved.oneShot,
  };
}

/** Edit a schedule in its owner and conversation scope. Web-created plans belong to the DM. */
export async function updateScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    directThread?: boolean;
    routineId: string;
    name?: string;
    prompt?: string;
    authorizedSites?: string[];
    timezone?: string;
    active?: boolean;
    schedule: Record<string, unknown>;
  },
) {
  if (!input.routineId) return { error: "id is required. Use schedule_list to find the schedule." };
  const name = input.name?.trim();
  const prompt = input.prompt?.trim();
  if (name === "" || (name && name.length > 80))
    return { error: "Enter a name of 1 to 80 characters." };
  if (prompt === "") return { error: "prompt cannot be empty." };
  if (input.timezone !== undefined && !TimeZoneSchema.safeParse(input.timezone).success) {
    return { error: "Unknown timezone." };
  }
  const scope = {
    id: input.routineId,
    spaceId: input.spaceId,
    botId: input.botId,
    userId: input.userId,
    bot: { archivedAt: null },
    ...(input.directThread
      ? { OR: [{ threadId: input.threadId }, { threadId: null, groupScoped: false }] }
      : { threadId: input.threadId }),
  };
  const current = await deps.prisma.routine.findFirst({ where: scope });
  if (!current) return { error: "Schedule not found in this conversation." };

  const now = new Date();
  const timezone = input.timezone ?? current.timezone;
  const hasTiming = TIMING_KEYS.some((key) => isScheduleValueProvided(input.schedule[key]));
  const startAt =
    input.schedule.startAt === "next"
      ? null
      : isScheduleValueProvided(input.schedule.startAt)
        ? String(input.schedule.startAt)
        : undefined;
  if ((hasTiming || startAt !== undefined) && current.crons.length === 0) {
    return { error: "A routine that runs on events has no schedule to retime." };
  }
  if (
    !hasTiming &&
    input.timezone !== undefined &&
    timezone !== current.timezone &&
    isOneShotRoutineCrons(current.crons)
  ) {
    return { error: "Provide a new runAt to move this one-time schedule." };
  }
  const timing = hasTiming
    ? resolveScheduleTiming({ ...input.schedule, startAt }, timezone, now)
    : undefined;
  if (timing && !timing.ok) return { error: timing.error };
  if (
    !hasTiming &&
    startAt === undefined &&
    name === undefined &&
    prompt === undefined &&
    input.active === undefined &&
    input.timezone === undefined
  )
    return { error: "Nothing to update." };

  let patch: ReturnType<typeof patchRoutineTiming>;
  try {
    patch = patchRoutineTiming(
      current,
      {
        crons: timing ? [timing.cron] : undefined,
        timezone: input.timezone,
        startAt,
        active: input.active,
        runAt: timing?.oneShot ? timing.nextRunAt : undefined,
        intervalBased: timing ? isScheduleValueProvided(input.schedule.every) : undefined,
      },
      now,
    );
  } catch (error) {
    if (!(error instanceof RoutineTimingError)) throw error;
    return { error: error.message };
  }
  const promptChanged = prompt !== undefined && prompt !== current.prompt;
  const timingTouched = patch.changed || input.active !== undefined;
  const result = await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        if (
          patch.data.active &&
          current.groupScoped &&
          !(await lockActiveRoutineGroup(tx, current))
        ) {
          return { error: "The original conversation is no longer available." };
        }
        if (
          patch.data.active &&
          current.groupScoped &&
          patch.data.crons.length === 0 &&
          !(await tx.nativeRoutineTrigger.count({ where: { routineId: current.id } }))
        ) {
          return { error: "Add a schedule or application event before resuming." };
        }
        if (
          timing?.oneShot &&
          !isOneShotRoutineCrons(current.crons) &&
          (current.webhookEnabled ||
            current.githubEnabled ||
            current.messageProvider ||
            (await tx.nativeRoutineTrigger.count({ where: { routineId: current.id } })) > 0)
        ) {
          return { error: "A one-time schedule cannot be combined with event triggers." };
        }
        if (patch.data.active && (input.active !== undefined || name !== undefined)) {
          const error = await routineAdmissionError(
            tx,
            {
              ...input,
              threadId: current.threadId,
              directThreadId: input.directThread ? input.threadId : undefined,
              name: name ?? current.name,
            },
            current,
          );
          if (error) return { error };
        }
        const { count } = await tx.routine.updateMany({
          where: {
            ...scope,
            ...(timingTouched
              ? {
                  updatedAt: current.updatedAt,
                  active: current.active,
                  nextRunAt: current.nextRunAt,
                  startAt: current.startAt,
                  crons: { equals: current.crons },
                  timezone: current.timezone,
                  intervalBased: current.intervalBased,
                  intervalAnchorAt: current.intervalAnchorAt,
                }
              : {}),
            ...(name !== undefined ? { name: current.name, active: current.active } : {}),
            ...(promptChanged ? { prompt: current.prompt } : {}),
          },
          data: {
            name,
            ...(promptChanged
              ? {
                  prompt,
                  authorizedInstructions: null,
                  authorizedSites: input.authorizedSites ?? [],
                  latestRunId: null,
                  autoCompletedRunId: null,
                }
              : {}),
            ...(patch.changed ? patch.data : {}),
            ...(patch.changed || input.active === false
              ? { latestRunId: null, autoCompletedRunId: null }
              : {}),
          },
        });
        if (!count)
          return { error: "The schedule changed while saving. Call schedule_list and try again." };
        const row = await tx.routine.findFirst({ where: scope });
        if (!row) return { error: "Schedule not found in this conversation." };
        const native =
          row.active && !current.active
            ? await tx.nativeRoutineTrigger.findMany({
                where: { routineId: row.id },
                select: { id: true, version: true },
              })
            : [];
        return { row, native };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  if (!result.row) return { error: result.error };
  const { row } = result;
  if (patch.changed) await syncRoutineWakeup(deps.jobs, row);
  for (const trigger of result.native)
    await deps.jobs.enqueue(nativeSourceJob(trigger.id, trigger.version)).catch(() => undefined);
  await deps.events
    .append({
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "routine.updated",
      payload: { routineId: row.id, active: row.active },
    })
    .catch(() => undefined);
  await publishGroupRoutineTiming(deps, row);
  return {
    ok: true as const,
    routineId: row.id,
    name: row.name,
    active: row.active,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    timezone: row.timezone,
  };
}

/** List bot routines, optionally restricted to the current group thread. */
export async function listSchedulesFromTool(
  deps: Pick<ScheduleToolDeps, "prisma">,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId?: string;
    currentThreadId?: string;
    directThread?: boolean;
  },
) {
  const rows = await deps.prisma.routine.findMany({
    where: {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  const nativeByRoutine = await listNativeRoutineTriggersBatch(
    deps.prisma,
    input,
    rows.map((row) => row.id),
  );
  return {
    routines: rows.map((row) => ({
      nativeTriggers: nativeByRoutine.get(row.id) ?? [],
      routineId: row.id,
      name: row.name,
      prompt: row.prompt,
      crons: row.crons,
      active: row.active,
      ...(input.currentThreadId
        ? {
            editableInConversation:
              row.threadId === input.currentThreadId ||
              Boolean(input.directThread && !row.threadId && !row.groupScoped),
          }
        : {}),
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      timezone: row.timezone,
      oneShot: isOneShotRoutineCrons(row.crons),
    })),
  };
}

/** Cancel a bot routine, optionally restricted to the current group thread. */
export async function cancelScheduleFromTool(
  deps: ScheduleToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId?: string;
    nameThreadId?: string;
    directThread?: boolean;
    routineId?: string;
    name?: string;
  },
) {
  const routineId = input.routineId?.trim();
  const name = input.name?.trim();
  if (!routineId && !name) {
    return { error: "Provide routineId or the exact schedule name to cancel." };
  }

  const scope = {
    spaceId: input.spaceId,
    botId: input.botId,
    userId: input.userId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
  let existing: Pick<Routine, "id" | "name"> | null | undefined;
  const select = { id: true, name: true };
  if (routineId) {
    existing = await deps.prisma.routine.findFirst({ where: { ...scope, id: routineId }, select });
  } else {
    const named = input.nameThreadId;
    const matches = await deps.prisma.routine.findMany({
      where: {
        ...scope,
        name,
        ...(named
          ? input.directThread
            ? { OR: [{ threadId: named }, { threadId: null, groupScoped: false }] }
            : { threadId: named }
          : {}),
      },
      select,
      take: 2,
    });
    if (matches.length > 1)
      return { error: "Several schedules match. Cancel using the schedule ID." };
    existing = matches[0];
  }
  if (!existing) return { error: "Schedule not found." };

  await deps.prisma.routine.delete({ where: { id: existing.id } });
  await deps.jobs.cancel(routineJobKey(existing.id));
  return { ok: true as const, routineId: existing.id, name: existing.name };
}
