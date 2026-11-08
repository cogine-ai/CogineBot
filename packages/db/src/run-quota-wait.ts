import type { RunQuotaTarget, RunQuotaWaitState } from "@rakazo/contracts";
import {
  RUN_QUOTA_WAIT_MAX_MS,
  RUN_QUOTA_WAIT_MAX_RESUMES,
  runQuotaTargetSchema,
  runQuotaWaitStateSchema,
} from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { appendEventInTransaction } from "./events.js";
import { hasPriorRunWork } from "./run-prior-work.js";
import { isRunResponse } from "./run-timing.js";
import { withTransactionRetry } from "./transaction-retry.js";

type RunQuotaLease = {
  runId: string;
  leaseOwner: string;
  leaseFence: number;
};

/** Park the current attempt and its wake time together, before releasing its worker and computer. */
export async function parkRunQuotaWait(
  prisma: PrismaClient,
  input: RunQuotaLease & {
    attemptId: string;
    spaceId: string;
    threadId: string;
    botId: string;
    target: RunQuotaTarget;
    until: Date;
  },
  now?: Date,
): Promise<{ revision: number; until: Date; eventSeq: number } | null> {
  const { runId: id, spaceId, threadId, botId, leaseOwner, leaseFence, until } = input;
  const target = runQuotaTargetSchema.safeParse(input.target);
  if (!target.success || !Number.isFinite(until.getTime())) return null;

  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      // Thread first, like Stop and terminal writes. The Run lock also fences effect writers.
      const [thread] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM threads WHERE id = ${threadId} AND "spaceId" = ${spaceId} FOR UPDATE
      `;
      if (!thread) return null;
      const [run] = await tx.$queryRaw<
        Array<{
          quotaWait: Prisma.JsonValue;
          leaseExpiresAt: Date | null;
          firstResponseAt: Date | null;
        }>
      >`
        SELECT "quotaWait", "leaseExpiresAt", "firstResponseAt" FROM runs
        WHERE id = ${id} AND "spaceId" = ${spaceId} AND "threadId" = ${threadId}
          AND "botId" = ${botId} AND status = 'running'
          AND "leaseOwner" = ${leaseOwner} AND "leaseFence" = ${leaseFence}
        FOR UPDATE
      `;
      if (!run?.leaseExpiresAt || run.firstResponseAt) return null;

      let previous: RunQuotaWaitState | null = null;
      if (run.quotaWait !== null) {
        const parsed = runQuotaWaitStateSchema.safeParse(run.quotaWait);
        if (
          !parsed.success ||
          parsed.data.revision >= RUN_QUOTA_WAIT_MAX_RESUMES ||
          parsed.data.dispatchedFence !== leaseFence ||
          stableJsonValue(parsed.data.target) !== stableJsonValue(target.data)
        ) {
          return null;
        }
        previous = parsed.data;
      }
      if (await hasPriorRunWork(tx, { id, spaceId, threadId, botId })) return null;
      // Older runs can have provisional streamed replies without the first-response marker.
      const earlierStreaming = await tx.event.findMany({
        where: {
          runId: id,
          spaceId,
          threadId,
          botId,
          type: "thread.progress",
          payload: { path: ["streaming"], equals: true },
        },
        select: { payload: true },
      });
      if (
        earlierStreaming.some(
          ({ payload }) =>
            payload !== null &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            isRunResponse("thread.progress", payload),
        )
      ) {
        return null;
      }

      const at = now ?? new Date();
      const clock = at.getTime();
      if (
        !Number.isFinite(clock) ||
        run.leaseExpiresAt.getTime() <= clock ||
        until.getTime() <= clock ||
        until.getTime() > (previous ? Date.parse(previous.beganAt) : clock) + RUN_QUOTA_WAIT_MAX_MS
      ) {
        return null;
      }
      const state: RunQuotaWaitState = {
        revision: (previous?.revision ?? 0) + 1,
        beganAt: previous?.beganAt ?? at.toISOString(),
        until: until.toISOString(),
        target: target.data,
        dispatchedFence: null,
      };
      const attempt = await tx.attempt.updateMany({
        where: { id: input.attemptId, runId: id, fence: leaseFence, status: "running" },
        data: {
          status: "failed",
          error: "Model provider quota temporarily unavailable",
          finishedAt: at,
        },
      });
      if (attempt.count !== 1) return null;

      await tx.run.update({
        where: {
          id,
          spaceId,
          threadId,
          botId,
          status: "running",
          leaseOwner,
          leaseFence,
          leaseExpiresAt: { gt: at },
        },
        data: {
          status: "waiting_limit",
          wakeAt: until,
          quotaWait: state,
          error: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      await expireComputerExecutionLeases(tx, { runId: id });
      const event = await appendEventInTransaction(tx, {
        runId: id,
        spaceId,
        threadId,
        botId,
        type: "run.waiting_limit",
        payload: { until: state.until },
      });
      return { revision: state.revision, until, eventSeq: event.seq };
    }),
  );
}

/** Consume one quota wake or trusted human continuation at the model-open boundary. */
export async function claimRunQuotaResume(
  prisma: PrismaClient,
  input: RunQuotaLease & { state: RunQuotaWaitState },
  now?: Date,
): Promise<boolean> {
  const parsed = runQuotaWaitStateSchema.safeParse(input.state);
  if (!parsed.success) return false;
  const state = parsed.data;
  const { humanResume, ...receipt } = state;
  if (
    state.dispatchedFence !== null &&
    (!humanResume || state.dispatchedFence >= input.leaseFence)
  ) {
    return false;
  }
  const where = {
    id: input.runId,
    status: "running",
    leaseOwner: input.leaseOwner,
    leaseFence: input.leaseFence,
    quotaWait: { equals: state },
  };

  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const run = await tx.run.findFirst({ where, select: { spaceId: true, userId: true } });
      if (!run) return false;
      const [member] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM space_members WHERE "spaceId" = ${run.spaceId}
          AND "userId" = ${run.userId} FOR KEY SHARE
      `;
      if (!member) return false;
      const { modelCredentialId, connectionRevision, provider, modelId, backup } = state.target;
      if (modelCredentialId !== null) {
        // SHARE also excludes non-key updates such as replacing the connection revision.
        const [credential] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM user_model_credentials WHERE id = ${modelCredentialId}
            AND "userId" = ${run.userId} AND provider = ${provider}
            AND "connectionRevision" = ${connectionRevision} FOR SHARE
        `;
        if (!credential) return false;
      }
      if (backup) {
        // Backup edits take FOR UPDATE on the same membership before replacing the list.
        const saved = await tx.spaceBackupModel.findFirst({
          where: { ...run, provider, modelId, modelCredentialId },
          select: { position: true },
        });
        if (!saved) return false;
      }
      const at = now ?? new Date();
      const clock = at.getTime();
      if (!Number.isFinite(clock)) return false;
      if (
        !humanResume &&
        (clock < Date.parse(state.until) ||
          clock > Date.parse(state.beganAt) + RUN_QUOTA_WAIT_MAX_MS)
      ) {
        return false;
      }
      const claimed = await tx.run.updateMany({
        where: { ...where, ...run, leaseExpiresAt: { gt: at } },
        data: {
          quotaWait: humanResume ? receipt : { ...receipt, dispatchedFence: input.leaseFence },
        },
      });
      return claimed.count === 1;
    }),
  );
}
