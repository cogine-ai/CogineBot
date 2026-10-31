import { ACTIVE_RUN_STATUSES, runSecretKind } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { appendEventInTransaction } from "./events.js";

export interface FailScriptedRunInput {
  runId: string;
  taskId: string;
  threadId: string;
  spaceId: string;
  botId: string;
  status: string;
  leaseOwner: string | null;
  /** The calling worker, rather than the owner copied from an observed run row. */
  workerId: string;
  leaseFence: number;
  /** Admission uses the observed episode; a running attempt uses its lease fence. */
  updatedAt?: Date;
  attemptId?: string;
  error: string;
}

/** Stop unsafe recovery without releasing any assigned steering into a new run. */
export async function failScriptedRunPreservingSteering(
  prisma: PrismaClient,
  input: FailScriptedRunInput,
): Promise<{ threadId: string; seq: number } | null> {
  if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(input.status)) return null;
  if (
    (input.status === "running" || input.status === "leased") &&
    input.leaseOwner !== input.workerId
  )
    return null;
  // Snapshot reads hold a shared thread lock for up to 15 seconds.
  return prisma.$transaction(
    async (tx) => {
      const threads = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM threads WHERE id = ${input.threadId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
      if (threads.length !== 1) return null;
      const now = new Date();
      const failed = await tx.run.updateMany({
        where: {
          id: input.runId,
          taskId: input.taskId,
          threadId: input.threadId,
          spaceId: input.spaceId,
          botId: input.botId,
          status: input.status,
          leaseOwner: input.leaseOwner,
          leaseFence: input.leaseFence,
          ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
        },
        data: {
          status: "failed",
          error: input.error,
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (failed.count !== 1) return null;
      const run = await tx.run.findUniqueOrThrow({
        where: { id: input.runId },
        select: { userId: true },
      });
      await tx.secret.deleteMany({
        where: { spaceId: input.spaceId, userId: run.userId, kind: runSecretKind(input.runId) },
      });
      const attempt = await tx.attempt.updateMany({
        where: {
          // Admission has won a new fence before creating an attempt. The terminal
          // run CAS above authorizes closing its prior active attempts as well.
          ...(input.attemptId ? { id: input.attemptId, fence: input.leaseFence } : {}),
          runId: input.runId,
          status: { in: ["running", "waiting_input", "waiting_takeover"] },
        },
        data: { status: "failed", error: input.error, finishedAt: now },
      });
      if (input.attemptId && attempt.count !== 1) {
        throw new Error("Active run attempt was not available to fail");
      }
      const sibling = await tx.run.findFirst({
        where: {
          taskId: input.taskId,
          id: { not: input.runId },
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: { id: true },
      });
      if (!sibling) {
        const task = await tx.task.updateMany({
          where: {
            id: input.taskId,
            spaceId: input.spaceId,
            threadId: input.threadId,
            botId: input.botId,
          },
          data: { status: "failed" },
        });
        if (task.count !== 1) throw new Error("Run task was not available to fail");
      }
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "run.failed",
        runId: input.runId,
        payload: { error: input.error },
      });
      await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
      await expireComputerExecutionLeases(tx, { runId: input.runId });
      // A user control lease remains on screen until release or revocation.
      await tx.computer.updateMany({
        where: {
          controlRunId: input.runId,
          OR: [{ controlHolder: { not: "user" } }, { controlLeaseId: null }],
        },
        data: { controlRunId: null },
      });
      await tx.computer.updateMany({
        where: { executionRunId: input.runId },
        data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
      });
      await tx.bot.update({ where: { id: input.botId }, data: { updatedAt: now } });
      return { threadId: event.threadId, seq: event.seq };
    },
    { maxWait: 5_000, timeout: 20_000 },
  );
}
