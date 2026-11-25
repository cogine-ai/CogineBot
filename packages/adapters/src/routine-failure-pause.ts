import {
  intervalUsesAnchor,
  isOneShotRoutineCrons,
  normalizeRunError,
  sanitizeRunErrorDetails,
} from "@rakazo/core";
import type { PrismaClient, Routine, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  lockActiveRoutineGroup,
  Prisma,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { routineTimerNonce } from "./routine-coalescing.js";
import { publishRoutineTiming } from "./routine-timing.js";

const PAUSE_AFTER = 5;
export const ROUTINE_MODEL_CONNECTION_FAILURE = "setup:model-connection";
export const ROUTINE_MODEL_MISSING = "setup:model-missing";

type RunScope = {
  id: string;
  routineId: string;
  userId: string;
  spaceId: string;
  botId: string;
  retryOfRunId: string | null;
};

type FailurePauseDeps = {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "append" | "notify">;
};

const routineSelect = {
  id: true,
  spaceId: true,
  userId: true,
  botId: true,
  threadId: true,
  name: true,
  crons: true,
  intervalBased: true,
  intervalAnchorAt: true,
  nextRunAt: true,
  failurePausedAt: true,
};
type FailureRoutine = Pick<Routine, keyof typeof routineSelect>;

async function failingStreak(
  db: Pick<PrismaClient, "run" | "$queryRaw">,
  routine: FailureRoutine,
  sourceId: string,
): Promise<string | null> {
  const prefix = routineTimerNonce(routine.id, "");
  const since = routine.failurePausedAt;
  const source = await db.run.findFirst({
    where: {
      id: sourceId,
      routineId: routine.id,
      userId: routine.userId,
      spaceId: routine.spaceId,
      botId: routine.botId,
      trigger: "routine",
      status: "failed",
      retryOfRunId: null,
      clientNonce: { startsWith: prefix },
      ...(since && { createdAt: { gt: since } }),
    },
    select: { id: true },
  });
  if (!source) return null;

  // Read roots and retries in one snapshot. A retry replaces its parent's
  // outcome without moving the occurrence forward in the schedule's history.
  const rounds = await db.$queryRaw<
    Array<{ status: string; cause: string | null; error: string | null; retryAt: Date | null }>
  >`
    SELECT COALESCE(retry.status, root.status) AS status,
           CASE WHEN retry.id IS NULL THEN root."routineFailureCause"
                ELSE retry."routineFailureCause" END AS cause,
           CASE WHEN retry.id IS NULL THEN root.error ELSE retry.error END AS error,
           root."routineRetryAt" AS "retryAt"
    FROM runs root
    LEFT JOIN runs retry ON retry."retryOfRunId" = root.id
      AND retry."routineId" = root."routineId" AND retry."spaceId" = root."spaceId"
      AND retry."userId" = root."userId" AND retry."botId" = root."botId"
      AND retry."threadId" = root."threadId" AND retry.trigger = 'routine'
    WHERE root."routineId" = ${routine.id} AND root."userId" = ${routine.userId}
      AND root."spaceId" = ${routine.spaceId} AND root."botId" = ${routine.botId}
      AND root.trigger = 'routine' AND root."retryOfRunId" IS NULL
      AND starts_with(root."clientNonce", ${prefix})
      AND root.status IN ('completed', 'failed') AND retry.status IS DISTINCT FROM 'cancelled'
      ${since ? Prisma.sql`AND root."createdAt" > ${since}` : Prisma.empty}
    ORDER BY root."createdAt" DESC, root.id DESC
    LIMIT ${PAUSE_AFTER}
  `;
  const newest = rounds[0];
  if (
    rounds.length < PAUSE_AFTER ||
    !newest?.cause ||
    !newest.error ||
    !rounds.every(
      (round) =>
        round.status === "failed" && round.retryAt === null && round.cause === newest.cause,
    )
  )
    return null;
  if (newest.cause === ROUTINE_MODEL_CONNECTION_FAILURE)
    return "Check or reconnect the selected model in Settings.";
  if (newest.cause === ROUTINE_MODEL_MISSING) return "Connect a model in Settings.";
  return normalizeRunError(newest.error).summary;
}

export async function pauseRoutineAfterRepeatedFailures(
  deps: FailurePauseDeps,
  run: RunScope,
  now?: Date,
): Promise<void> {
  const where = {
    id: run.routineId,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    active: true,
    bot: { spaceId: run.spaceId, userId: run.userId, archivedAt: null },
  };
  const source = run.retryOfRunId ?? run.id;
  const repeating = (row: FailureRoutine | null): row is FailureRoutine =>
    Boolean(row?.crons.length && !isOneShotRoutineCrons(row.crons));
  try {
    const routine = await deps.prisma.routine.findFirst({ where, select: routineSelect });
    if (!repeating(routine) || !(await failingStreak(deps.prisma, routine, source))) return;

    const paused = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM routines WHERE id = ${routine.id} FOR UPDATE`;
      const current = await tx.routine.findFirst({ where, select: routineSelect });
      if (!repeating(current)) return null;
      const reason = await failingStreak(tx, current, source);
      if (!reason) return null;
      const updated = await tx.routine.updateMany({
        where,
        data: {
          active: false,
          nextRunAt: null,
          ...(intervalUsesAnchor(current.crons, current.intervalBased) && {
            intervalAnchorAt: current.nextRunAt ?? current.intervalAnchorAt,
          }),
          latestRunId: null,
          autoCompletedRunId: null,
          failurePausedAt: now ?? new Date(),
        },
      });
      return updated.count === 1 ? { routine: current, reason } : null;
    });
    if (paused) await tellRoutineOwner(deps, paused.routine, paused.reason);
  } catch {
    getLogger().warn("routine.failure_pause_failed", { routineId: run.routineId });
  }
}

async function tellRoutineOwner(deps: FailurePauseDeps, routine: FailureRoutine, reason: string) {
  const direct = await deps.prisma.thread.findFirst({
    where: {
      botId: routine.botId,
      spaceId: routine.spaceId,
      userId: routine.userId,
      groupId: null,
    },
    select: { id: true, spaceId: true, userId: true },
  });
  const notice = deps.prisma
    .$transaction(async (tx) => {
      const threadId = (await lockActiveRoutineGroup(tx, routine)) ? routine.threadId : direct?.id;
      if (!threadId) return null;
      const name = sanitizeRunErrorDetails(routine.name)
        .replace(/[\r\n]/g, " ")
        .replace(/[\\`*_{}[\]<>()#!]/g, "\\$&");
      const blocks = [
        {
          kind: "text" as const,
          text: `I paused “${name}” after ${PAUSE_AFTER} scheduled runs failed for the same reason. ${reason}\n\nAfter fixing it, resume in Routines or ask me in the original chat.`,
        },
      ];
      const message = await createThreadMessageInTransaction(tx, {
        threadId,
        botId: routine.botId,
        role: "bot",
        blocks,
      });
      return appendEventInTransaction(tx, {
        spaceId: routine.spaceId,
        threadId,
        botId: routine.botId,
        type: "thread.message.created",
        payload: { messageId: message.id, messageSeq: message.seq, role: "bot", blocks },
      });
    })
    .then(async (event) => {
      if (event) await deps.events.notify(event.threadId, event.seq);
    })
    .catch(() => {
      getLogger().warn("routine.failure_pause_notice_failed", { routineId: routine.id });
    });
  await Promise.all([notice, direct && publishRoutineTiming(deps.events, routine, direct, false)]);
}
