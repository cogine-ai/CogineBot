import { isOneShotRoutineCrons } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { lockOwnedGroup } from "./groups.js";
import { lockBotCreationIntro } from "./repos.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

const RETRY_DELAY_MS = 12 * 60_000;
const NEXT_RUN_WINDOW_MS = 30 * 60_000;

type RetrySource = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  routineId: string | null;
};

const retryTarget = {
  spaceId: true,
  userId: true,
  botId: true,
  threadId: true,
  routineId: true,
  thread: { select: { groupId: true } },
} satisfies Prisma.RunSelect;

type RetryTarget = Prisma.RunGetPayload<{ select: typeof retryTarget }>;

export interface RoutineRetryExecutionInput {
  runId: string;
  workerId: string;
  fence: number;
  startedAt: Date;
}

export type VerifyRoutineRetryNativeSource = (
  tx: Prisma.TransactionClient,
  input: {
    clientNonce: string;
    routineId: string;
    spaceId: string;
    userId: string;
    connectionIds: readonly string[];
  },
) => Promise<boolean>;

/** Serialize retry creation with Stop and history clear without locking against Run foreign keys. */
export async function lockRoutineRetryThread(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  threadId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`routine-retry-thread:${threadId}`}, 2))::text AS "lock"
  `;
}

export async function revokePendingRoutineRetries(
  tx: Pick<Prisma.TransactionClient, "run">,
  scope: { spaceId: string; threadId: string },
): Promise<void> {
  await tx.run.updateMany({
    where: {
      spaceId: scope.spaceId,
      threadId: scope.threadId,
      status: "failed",
      routineRetryAt: { not: null },
    },
    data: { routineRetryAt: null },
  });
}

async function readRetryRoutine(tx: Prisma.TransactionClient, source: RetrySource) {
  if (!source.routineId) return null;
  return tx.routine.findFirst({
    where: {
      id: source.routineId,
      spaceId: source.spaceId,
      userId: source.userId,
      botId: source.botId,
      bot: { spaceId: source.spaceId, userId: source.userId, archivedAt: null },
    },
    select: {
      active: true,
      crons: true,
      nextRunAt: true,
      latestRunId: true,
      autoCompletedRunId: true,
    },
  });
}

function canRetryRoutine(
  routine: Awaited<ReturnType<typeof readRetryRoutine>>,
  sourceId: string,
  at: Date,
  latestRunId = sourceId,
): boolean {
  return Boolean(
    routine?.latestRunId === latestRunId &&
      (routine.active ||
        (routine.autoCompletedRunId === sourceId &&
          routine.nextRunAt === null &&
          isOneShotRoutineCrons(routine.crons))) &&
      (!routine.nextRunAt || routine.nextRunAt.getTime() - at.getTime() > NEXT_RUN_WINDOW_MS),
  );
}

async function lockRetryTarget(tx: Prisma.TransactionClient, candidate: RetryTarget) {
  // Archive uses the same Bot mutex before scanning active Runs. Membership
  // changes use the Group row lock. Routine producers lock Routine before Run.
  await lockBotCreationIntro(tx, candidate.botId);
  await lockRoutineRetryThread(tx, candidate.threadId);
  const groupId = candidate.thread.groupId;
  if (groupId) {
    try {
      await lockOwnedGroup(tx, candidate, groupId);
    } catch (error) {
      if (!(error instanceof IsolationError)) throw error;
      return false;
    }
  }
  if (!candidate.routineId) return false;
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM routines WHERE id = ${candidate.routineId}
      AND "spaceId" = ${candidate.spaceId} AND "userId" = ${candidate.userId}
      AND "botId" = ${candidate.botId} FOR UPDATE
  `;
  return locked.length === 1;
}

async function retryThreadIsCurrent(
  tx: Prisma.TransactionClient,
  target: RetryTarget,
): Promise<boolean> {
  const { spaceId, userId, botId, threadId } = target;
  const groupId = target.thread.groupId;
  const scope = { spaceId, userId };
  const activeBot = { ...scope, archivedAt: null };
  const thread = await tx.thread.findFirst({
    where: {
      id: threadId,
      ...scope,
      ...(groupId
        ? {
            groupId,
            group: { ...scope, archivedAt: null, members: { some: { botId, bot: activeBot } } },
          }
        : { botId, groupId: null, bot: activeBot }),
    },
    select: { id: true },
  });
  return Boolean(thread);
}

async function lockRetryOwner(
  tx: Prisma.TransactionClient,
  { spaceId, userId }: Pick<RetryTarget, "spaceId" | "userId">,
): Promise<boolean> {
  const members = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM space_members WHERE "spaceId" = ${spaceId} AND "userId" = ${userId} FOR KEY SHARE
  `;
  return members.length === 1;
}

/** Routine revocation does not revoke human steering on a still-authorized thread. */
export async function routineRetrySteeringTargetIsCurrent(
  tx: Prisma.TransactionClient,
  target: RetryTarget,
): Promise<boolean> {
  return (await retryThreadIsCurrent(tx, target)) && lockRetryOwner(tx, target);
}

async function retryAuthorizationIsCurrent(
  tx: Prisma.TransactionClient,
  target: RetryTarget,
  original: RetrySource & { clientNonce: string | null; task: { connectionIds: string[] } },
  verifyNativeSource?: VerifyRoutineRetryNativeSource,
): Promise<boolean> {
  if (
    !original.routineId ||
    !(await retryThreadIsCurrent(tx, target)) ||
    (await hasPriorWork(tx, original))
  )
    return false;
  if (original.clientNonce?.startsWith("native-event:")) {
    return Boolean(
      await verifyNativeSource?.(tx, {
        spaceId: target.spaceId,
        userId: target.userId,
        clientNonce: original.clientNonce,
        routineId: original.routineId,
        connectionIds: original.task.connectionIds,
      }),
    );
  }
  return lockRetryOwner(tx, target);
}

async function hasPriorWork(tx: Prisma.TransactionClient, source: RetrySource): Promise<boolean> {
  const [tool, message, effect, steering] = await Promise.all([
    tx.event.findFirst({
      where: { runId: source.id, spaceId: source.spaceId, type: "agent.tool.called" },
      select: { id: true },
    }),
    tx.message.findFirst({
      where: { runId: source.id, threadId: source.threadId, role: "bot" },
      select: { id: true },
    }),
    tx.externalEffect.findFirst({
      where: { runId: source.id, spaceId: source.spaceId },
      select: { id: true },
    }),
    tx.steeringMessage.findFirst({
      where: { runId: source.id, botId: source.botId, claimedAt: { not: null } },
      select: { id: true },
    }),
  ]);
  return Boolean(tool || message || effect || steering);
}

/** The failed Run is the outbox. Call while its terminal transaction still owns its fence. */
export async function planRoutineRetryInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
  completedAt: Date,
): Promise<Date | undefined> {
  const source = await tx.run.findFirst({
    where: { id: runId, trigger: "routine", status: "failed", retryOfRunId: null },
    select: { id: true, spaceId: true, userId: true, botId: true, threadId: true, routineId: true },
  });
  if (!source?.routineId) return;
  const at = new Date(completedAt.getTime() + RETRY_DELAY_MS);
  // Do not lock Routine after the terminal transaction has locked Thread and Run.
  // The delayed consumer takes the Routine lock and repeats every eligibility check.
  if (!canRetryRoutine(await readRetryRoutine(tx, source), source.id, at)) return;
  if (await hasPriorWork(tx, source)) return;
  await tx.run.update({ where: { id: source.id }, data: { routineRetryAt: at } });
  return at;
}

/** A delayed job is only a wake hint. The exact source intent authorizes one new Run. */
export async function claimRoutineRetry(
  prisma: PrismaClient,
  originalRunId: string,
  now?: Date,
  verifyNativeSource?: VerifyRoutineRetryNativeSource,
): Promise<{ runId: string } | null> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const intent = {
        id: originalRunId,
        trigger: "routine",
        status: "failed",
        retryOfRunId: null,
      };
      const candidate = await tx.run.findFirst({
        where: { ...intent, routineRetryAt: { lte: now ?? new Date() } },
        select: retryTarget,
      });
      if (!candidate) return null;
      const targetLocked = await lockRetryTarget(tx, candidate);

      const source = await tx.run.findFirst({
        where: { ...intent, routineRetryAt: { lte: now ?? new Date() } },
        select: {
          id: true,
          spaceId: true,
          userId: true,
          botId: true,
          threadId: true,
          routineId: true,
          routineRetryAt: true,
          clientNonce: true,
          modelPinned: true,
          modelProvider: true,
          modelId: true,
          modelCredentialId: true,
          thinkingLevel: true,
          task: {
            select: {
              prompt: true,
              routineInstructions: true,
              routineSites: true,
              connectionIds: true,
            },
          },
        },
      });
      if (!source) return null;
      const consume = await tx.run.updateMany({
        where: { ...intent, routineRetryAt: source.routineRetryAt },
        data: { routineRetryAt: null },
      });
      if (consume.count !== 1 || !targetLocked || !source.routineId) return null;

      const routine = await readRetryRoutine(tx, source);
      const scope = { spaceId: source.spaceId, userId: source.userId };
      if (!canRetryRoutine(routine, source.id, now ?? new Date())) return null;
      if (!(await retryAuthorizationIsCurrent(tx, candidate, source, verifyNativeSource)))
        return null;
      if (!canRetryRoutine(routine, source.id, now ?? new Date())) return null;

      const destination = {
        ...scope,
        botId: source.botId,
        threadId: source.threadId,
        status: "queued",
      };
      const task = await tx.task.create({ data: { ...destination, ...source.task } });
      const child = await tx.run.create({
        data: {
          ...destination,
          taskId: task.id,
          trigger: "routine",
          routineId: source.routineId,
          retryOfRunId: source.id,
          ...(source.modelPinned
            ? {
                modelPinned: true,
                modelProvider: source.modelProvider,
                modelId: source.modelId,
                modelCredentialId: source.modelCredentialId,
                thinkingLevel: source.thinkingLevel,
              }
            : {}),
        },
        select: { id: true },
      });
      await tx.routine.update({ where: { id: source.routineId }, data: { latestRunId: child.id } });
      return { runId: child.id };
    }),
  );
}

export function firstRoutineRetryExecutionFence(input: RoutineRetryExecutionInput) {
  return {
    id: input.runId,
    trigger: "routine",
    retryOfRunId: { not: null },
    startedAt: null,
    status: "running",
    leaseOwner: input.workerId,
    leaseFence: input.fence,
    leaseExpiresAt: { gt: new Date() },
  } as const;
}

/** Keep eligibility and the first-start write in one transaction after computer admission. */
export async function lockRoutineRetryExecution(
  tx: Prisma.TransactionClient,
  input: RoutineRetryExecutionInput,
  verifyNativeSource?: VerifyRoutineRetryNativeSource,
) {
  const fence = firstRoutineRetryExecutionFence(input);
  const candidate = await tx.run.findFirst({ where: fence, select: retryTarget });
  if (!candidate) return null;
  const targetLocked = await lockRetryTarget(tx, candidate);
  const child = await tx.run.findFirst({
    where: fence,
    select: { ...retryTarget, id: true, retryOfRunId: true, taskId: true },
  });
  if (!child) return null;
  if (!targetLocked || !child.routineId || !child.retryOfRunId) return { child, allowed: false };

  const original = await tx.run.findFirst({
    where: {
      id: child.retryOfRunId,
      trigger: "routine",
      status: "failed",
      retryOfRunId: null,
      spaceId: child.spaceId,
      userId: child.userId,
      botId: child.botId,
      threadId: child.threadId,
      routineId: child.routineId,
    },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      threadId: true,
      routineId: true,
      clientNonce: true,
      task: { select: { connectionIds: true } },
    },
  });
  if (!original) return { child, allowed: false };
  const routine = await readRetryRoutine(tx, child);
  if (!canRetryRoutine(routine, original.id, new Date(), child.id))
    return { child, allowed: false };
  const authorized = await retryAuthorizationIsCurrent(tx, child, original, verifyNativeSource);
  return {
    child,
    allowed: authorized && canRetryRoutine(routine, original.id, new Date(), child.id),
  };
}
