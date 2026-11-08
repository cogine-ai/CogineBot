import { isConversationalRun } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";

const RESET_KIND = "runtime_progress_reset";
const RESET_LIMIT = 3;
const RESET_GAP_MS = 60_000;
const keyOf = (runId: string) => JSON.stringify([RESET_KIND, runId]);

type ProgressResetInput = {
  runId: string;
  spaceId: string;
  threadId: string;
  botId: string;
  leaseOwner: string;
  leaseFence: number;
  steeringId: string;
  now: Date;
};

type StoredReset = { steeringId: string; startedAtMs: number; startMessageSeq: number };

function isStoredReset(value: Prisma.JsonValue): value is StoredReset {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { steeringId, startedAtMs, startMessageSeq } = value;
  return (
    Object.keys(value).length === 3 &&
    typeof steeringId === "string" &&
    steeringId.length > 0 &&
    typeof startedAtMs === "number" &&
    Number.isSafeInteger(startedAtMs) &&
    startedAtMs >= 0 &&
    Number.isFinite(new Date(startedAtMs).getTime()) &&
    typeof startMessageSeq === "number" &&
    Number.isSafeInteger(startMessageSeq) &&
    startMessageSeq >= 0
  );
}

async function loadStoredResets(
  db: Pick<PrismaClient, "externalEffect">,
  runId: string,
  spaceId?: string,
): Promise<StoredReset[]> {
  const row = await db.externalEffect.findUnique({
    where: { idempotencyKey: keyOf(runId) },
    select: { runId: true, spaceId: true, kind: true, status: true, request: true, result: true },
  });
  if (!row) return [];
  const resets = row.result;
  if (
    row.runId !== runId ||
    (spaceId !== undefined && row.spaceId !== spaceId) ||
    row.kind !== RESET_KIND ||
    row.status !== RESET_KIND ||
    !row.request ||
    typeof row.request !== "object" ||
    Array.isArray(row.request) ||
    Object.keys(row.request).length !== 0 ||
    !Array.isArray(resets) ||
    resets.length === 0 ||
    resets.length > RESET_LIMIT ||
    !resets.every(isStoredReset) ||
    new Set(resets.map(({ steeringId }) => steeringId)).size !== resets.length ||
    resets.some((reset, index) => {
      const previous = index === 0 ? undefined : resets[index - 1];
      return (
        previous &&
        (reset.startedAtMs - previous.startedAtMs < RESET_GAP_MS ||
          reset.startMessageSeq < previous.startMessageSeq)
      );
    })
  ) {
    throw new Error("Invalid Run progress reset state");
  }
  return resets;
}

function anchor(reset: StoredReset) {
  return { startedAt: new Date(reset.startedAtMs), startMessageSeq: reset.startMessageSeq };
}

/** Restore the latest budget anchor. Progress at or after its sequence consumes that budget. */
export async function loadRunProgressReset(prisma: PrismaClient, runId: string) {
  const latest = (await loadStoredResets(prisma, runId)).at(-1);
  return latest && anchor(latest);
}

/** Grant a budget reset only once for an authenticated owner steering message in this attempt. */
export async function reserveRunProgressResetInTransaction(
  tx: Prisma.TransactionClient,
  input: ProgressResetInput,
) {
  const { runId, spaceId, threadId, botId, leaseOwner, leaseFence, steeringId } = input;
  const startedAtMs = input.now.getTime();
  if (!Number.isFinite(startedAtMs) || startedAtMs < 0)
    throw new Error("Invalid Run progress reset time");
  // Match the lock order for history writes so this anchor divides committed messages.
  const [thread] = await tx.$queryRaw<Array<{ nextMessageSeq: number }>>`
    SELECT "nextMessageSeq" FROM public.threads
    WHERE id = ${threadId} AND "spaceId" = ${spaceId}
    FOR UPDATE
  `;
  if (!thread) return;
  const [run] = await tx.$queryRaw<
    Array<{ userId: string; trigger: string; sourceMessageId: string | null }>
  >`
    SELECT "userId", trigger, "sourceMessageId" FROM public.runs
    WHERE id = ${runId} AND "spaceId" = ${spaceId} AND "threadId" = ${threadId}
      AND "botId" = ${botId} AND status = 'running'
      AND "leaseOwner" = ${leaseOwner} AND "leaseFence" = ${leaseFence}
    FOR UPDATE
  `;
  if (!run || run.trigger === "messaging" || !isConversationalRun(run.trigger)) return;

  const steering = await tx.steeringMessage.findFirst({
    where: {
      id: steeringId,
      runId,
      botId,
      userId: run.userId,
      claimedAt: { not: null },
      originTrigger: null,
      message: { threadId, role: "user", authorUserId: run.userId },
    },
    select: {
      claimedAt: true,
      messageId: true,
      message: { select: { blocks: true, clientNonce: true } },
    },
  });
  if (
    !steering?.claimedAt ||
    steering.messageId === run.sourceMessageId ||
    steering.message.clientNonce?.startsWith("messaging:") ||
    !Array.isArray(steering.message.blocks) ||
    steering.message.blocks.some(
      (block) =>
        block && typeof block === "object" && "kind" in block && block.kind === "channel_message",
    )
  )
    return;

  const resets = await loadStoredResets(tx, runId, spaceId);
  if (resets.length >= RESET_LIMIT || resets.some((reset) => reset.steeringId === steeringId))
    return;
  const previous = resets.at(-1);
  // Replaying a source claimed during the cooldown cannot make it newly eligible.
  if (
    previous &&
    Math.min(startedAtMs, steering.claimedAt.getTime()) < previous.startedAtMs + RESET_GAP_MS
  )
    return;

  const reset = { steeringId, startedAtMs, startMessageSeq: thread.nextMessageSeq };
  const scope = {
    idempotencyKey: keyOf(runId),
    runId,
    spaceId,
    kind: RESET_KIND,
    status: RESET_KIND,
  };
  const result = [...resets, reset];
  await tx.externalEffect.upsert({
    where: scope,
    create: { ...scope, request: {}, result },
    update: { result },
  });
  return anchor(reset);
}
