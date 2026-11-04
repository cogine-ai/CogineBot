import type { MessageBlock } from "@rakazo/contracts";
import { callIdFromClientNonce, isBackgroundRunTrigger } from "@rakazo/core";
import type { Prisma, RunLease } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor.js";

/** Deps for one attempt: its run's history writes carry the lease, so a superseded attempt cannot write. */
export function withRunLease(deps: ExecutorDeps, runId: string, lease: RunLease): ExecutorDeps {
  return {
    ...deps,
    runLease: { runId, ...lease },
    events: {
      ...deps.events,
      append: (input) => deps.events.append(input.runId === runId ? { lease, ...input } : input),
    },
  };
}

export function runLeaseFor(
  deps: Pick<ExecutorDeps, "runLease">,
  runId: string,
): RunLease | undefined {
  return deps.runLease?.runId === runId ? deps.runLease : undefined;
}

export async function publishMessage(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; threadId: string; botId: string; trigger: string },
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
  markUnread?: boolean,
  clientNonce?: string,
) {
  if (isBackgroundRunTrigger(run.trigger)) {
    blocks = blocks.filter((block) => block.kind === "ask" || block.kind === "computer");
    if (blocks.length === 0) return null;
  }
  const lease = runLeaseFor(deps, run.id);
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction((tx) =>
      persistMessageInTransaction(tx, run, role, blocks, markUnread, clientNonce, false, lease),
    ),
  );
  await deps.events
    .notify(run.threadId, committed.eventSeq, committed.firstResponseRunId)
    .catch((error) => {
      getLogger().error("thread message realtime notification", error);
    });
  return committed.message;
}

export async function persistMessageInTransaction(
  tx: Prisma.TransactionClient,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
  markUnread?: boolean,
  clientNonce?: string,
  allowCancelledRun = false,
  lease?: RunLease,
) {
  const message = await createThreadMessageInTransaction(tx, {
    threadId: run.threadId,
    role,
    blocks,
    botId: run.botId,
    runId: run.id,
    markUnread,
    clientNonce,
    allowCancelledRun,
    lease,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.message.created",
    runId: run.id,
    allowCancelledRun,
    lease,
    payload: {
      messageId: message.id,
      messageSeq: message.seq,
      role,
      blocks,
      callId: callIdFromClientNonce(clientNonce),
    },
  });
  return {
    message,
    eventSeq: event.seq,
    firstResponseRunId: event.firstResponse ? run.id : undefined,
  };
}
