import type { SpaceCollaborationPolicy } from "@rakazo/contracts";
import { MessageBlock } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, stuckWorkStatusMessages } from "@rakazo/core";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { IsolationError } from "./scope.js";
import { lockSpaceLifecycle, SpaceDeletionInProgressError, SpaceNotFoundError } from "./spaces.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const BOT_COLLABORATION_ORIGINS = [
  "bot_peer",
  "group_handoff",
  "child_prompt",
  "external_agent",
  "peer_return",
] as const;
export type BotCollaborationOrigin = (typeof BOT_COLLABORATION_ORIGINS)[number];
export type CollaborationNotice = { threadId: string; seq: number };
type Tx = Prisma.TransactionClient;

export class BotCollaborationDisabledError extends Error {
  constructor() {
    super("policy_disabled");
    this.name = "BotCollaborationDisabledError";
  }
}
export class CannotChangeCollaborationError extends Error {
  constructor() {
    super("Only the Space owner can change this.");
    this.name = "CannotChangeCollaborationError";
  }
}
export class CollaborationRevisionConflictError extends Error {
  constructor() {
    super("Collaboration settings changed. Refresh and try again.");
    this.name = "CollaborationRevisionConflictError";
  }
}

/** All policy writers, peer deliveries and initial starts share this lock order. */
async function lockSpaces(tx: Tx, spaceIds: readonly string[]) {
  for (const id of [...new Set(spaceIds)].sort()) await lockSpaceLifecycle(tx, id);
}

export interface AuthorizeBotCollaborationInput {
  sourceRunId: string;
  sourceSpaceId: string;
  sourceThreadId: string;
  sourceBotId: string;
  sourceUserId: string;
  targetSpaceId: string;
  targetThreadId: string;
  targetBotId: string;
  targetUserId: string;
  toolName: "message_bot" | "message_agent" | "handoff_to_bot" | "spawn_bot";
  allowTerminalSource?: boolean;
}

/** Validate current database scope and policy inside the delivery transaction.
 * Existing address, connection and group checks still belong to each dispatch entry.
 */
export async function authorizeBotCollaboration(tx: Tx, input: AuthorizeBotCollaborationInput) {
  await lockSpaces(tx, [input.sourceSpaceId, input.targetSpaceId]);
  const [
    sourceSpace,
    targetSpace,
    source,
    sourceBot,
    targetBot,
    targetThread,
    sourceMember,
    targetMember,
  ] = await Promise.all([
    tx.space.findUnique({ where: { id: input.sourceSpaceId } }),
    tx.space.findUnique({ where: { id: input.targetSpaceId } }),
    tx.run.findFirst({
      where: {
        id: input.sourceRunId,
        spaceId: input.sourceSpaceId,
        threadId: input.sourceThreadId,
        botId: input.sourceBotId,
        userId: input.sourceUserId,
        status: input.allowTerminalSource
          ? { in: ["completed", "failed", "cancelled"] }
          : "running",
      },
    }),
    tx.bot.findFirst({
      where: {
        id: input.sourceBotId,
        spaceId: input.sourceSpaceId,
        userId: input.sourceUserId,
        archivedAt: null,
      },
    }),
    tx.bot.findFirst({
      where: {
        id: input.targetBotId,
        spaceId: input.targetSpaceId,
        userId: input.targetUserId,
        archivedAt: null,
      },
    }),
    tx.thread.findFirst({ where: { id: input.targetThreadId, spaceId: input.targetSpaceId } }),
    tx.spaceMember.findUnique({
      where: {
        spaceId_userId: {
          spaceId: input.sourceSpaceId,
          userId: input.sourceUserId,
        },
      },
    }),
    tx.spaceMember.findUnique({
      where: {
        spaceId_userId: {
          spaceId: input.targetSpaceId,
          userId: input.targetUserId,
        },
      },
    }),
  ]);
  if (
    !sourceSpace?.allowBotCollaboration ||
    sourceSpace.deletingAt ||
    !targetSpace?.allowBotCollaboration ||
    targetSpace.deletingAt ||
    !source ||
    !sourceBot ||
    !targetBot ||
    !targetThread ||
    !sourceMember ||
    !targetMember ||
    sourceBot.disabledBuiltinTools.includes(input.toolName) ||
    (input.allowTerminalSource && source.collaborationStatus === "policy_disabled")
  )
    throw new BotCollaborationDisabledError();
  if (
    input.toolName !== "message_agent" &&
    (input.sourceSpaceId !== input.targetSpaceId || input.sourceUserId !== input.targetUserId)
  )
    throw new BotCollaborationDisabledError();
  return {
    sourceRevision: sourceSpace.collaborationRevision,
    targetRevision: targetSpace.collaborationRevision,
  };
}

/** Only trusted dispatch code creates this metadata, never model/tool arguments. */
export function collaborationRunFields(input: {
  origin: BotCollaborationOrigin;
  sourceRunId: string;
  sourceSpaceId: string;
  sourceBotId: string;
  sourceRevision: number;
  targetRevision: number;
  outboundMessageId?: string;
}) {
  return {
    origin: input.origin,
    parentRunId: input.sourceRunId,
    collaborationSourceSpaceId: input.sourceSpaceId,
    collaborationSourceBotId: input.sourceBotId,
    collaborationSourceRevision: input.sourceRevision,
    collaborationRevision: input.targetRevision,
    collaborationMessageId: input.outboundMessageId ?? null,
    collaborationStatus: "waiting_peer",
  };
}

/** Persist sender-card settlement without changing any Run lifecycle status. */
async function settleRows(
  tx: Tx,
  runs: ReadonlyArray<{
    id: string;
    botId: string;
    parentRunId: string | null;
    collaborationMessageId: string | null;
    collaborationStatus: string | null;
  }>,
  status: "completed" | "policy_disabled",
): Promise<CollaborationNotice[]> {
  const notices: CollaborationNotice[] = [];
  for (const run of [...runs].sort((a, b) => a.id.localeCompare(b.id))) {
    if (run.collaborationStatus === "policy_disabled" && status === "completed") continue;
    await tx.run.updateMany({
      where: {
        id: run.id,
        ...(status === "completed" ? { collaborationStatus: { not: "policy_disabled" } } : {}),
      },
      data: {
        collaborationStatus: status,
        ...(status === "policy_disabled" ? { botOutcomeReturnedAt: new Date() } : {}),
      },
    });
    if (!run.collaborationMessageId || !run.parentRunId) continue;
    const message = await tx.message.findFirst({
      where: { id: run.collaborationMessageId, runId: run.parentRunId },
      include: { thread: { select: { spaceId: true } } },
    });
    if (!message?.botId) continue;
    const parsed = MessageBlock.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    let changed = false;
    const blocks = parsed.data.map((block) => {
      if (
        !(
          (block.kind === "bot_message_sent" || block.kind === "handoff") &&
          block.toBotId === run.botId
        ) &&
        !(block.kind === "child_bot" && block.botId === run.botId)
      )
        return block;
      if ("deliveryStatus" in block && block.deliveryStatus === "policy_disabled") return block;
      if ("deliveryStatus" in block && block.deliveryStatus === status) return block;
      changed = true;
      return { ...block, deliveryStatus: status };
    });
    if (!changed) continue;
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: message.thread.spaceId,
      threadId: message.threadId,
      botId: message.botId,
      type: "thread.message.updated",
      runId: run.parentRunId,
      allowCancelledRun: true,
      payload: { messageId: message.id, messageSeq: message.seq, role: message.role, blocks },
    });
    notices.push({ threadId: event.threadId, seq: event.seq });
  }
  return notices;
}

/** Return settlement is durable, so disabling never turns into a delayed return on reopen. */
export async function settleCollaborationDelivery(
  prisma: PrismaClient,
  runId: string,
  status: "completed" | "policy_disabled",
): Promise<CollaborationNotice[]> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const initial = await tx.run.findUnique({ where: { id: runId } });
      if (!initial || !BOT_COLLABORATION_ORIGINS.includes(initial.origin as BotCollaborationOrigin))
        return [];
      await lockSpaces(tx, [
        initial.spaceId,
        ...(initial.collaborationSourceSpaceId ? [initial.collaborationSourceSpaceId] : []),
      ]);
      const current = await tx.run.findUnique({ where: { id: runId } });
      if (!current) return [];
      return settleRows(tx, [current], status);
    }),
  );
}

/** Reject only never-started peer work; an already-started local episode may resume. */
export async function authorizeCollaborationRunStart(
  tx: Tx,
  runId: string,
): Promise<{ allowed: boolean; notices: CollaborationNotice[] }> {
  const initial = await tx.run.findUnique({ where: { id: runId } });
  if (!initial) return { allowed: false, notices: [] };
  if (
    !BOT_COLLABORATION_ORIGINS.includes(initial.origin as BotCollaborationOrigin) ||
    initial.startedAt
  )
    return { allowed: true, notices: [] };
  await lockSpaces(tx, [
    initial.spaceId,
    ...(initial.collaborationSourceSpaceId ? [initial.collaborationSourceSpaceId] : []),
  ]);
  const run = await tx.run.findUnique({ where: { id: runId } });
  if (!run) return { allowed: false, notices: [] };
  if (run.startedAt) return { allowed: true, notices: [] };
  if (run.status !== "queued" && run.status !== "leased") return { allowed: false, notices: [] };
  const [target, source, sourceBot, targetBot] = await Promise.all([
    tx.space.findUnique({ where: { id: run.spaceId } }),
    run.collaborationSourceSpaceId
      ? tx.space.findUnique({ where: { id: run.collaborationSourceSpaceId } })
      : null,
    run.collaborationSourceBotId
      ? tx.bot.findUnique({ where: { id: run.collaborationSourceBotId } })
      : null,
    tx.bot.findUnique({ where: { id: run.botId } }),
  ]);
  const tool =
    run.origin === "external_agent"
      ? "message_agent"
      : run.origin === "group_handoff"
        ? "handoff_to_bot"
        : run.origin === "child_prompt"
          ? "spawn_bot"
          : "message_bot";
  let permitted = Boolean(
    target?.allowBotCollaboration &&
      !target.deletingAt &&
      source?.allowBotCollaboration &&
      !source.deletingAt &&
      source.collaborationRevision === run.collaborationSourceRevision &&
      target.collaborationRevision === run.collaborationRevision &&
      sourceBot &&
      !sourceBot.archivedAt &&
      sourceBot.spaceId === run.collaborationSourceSpaceId &&
      !sourceBot.disabledBuiltinTools.includes(tool) &&
      targetBot &&
      !targetBot.archivedAt &&
      targetBot.spaceId === run.spaceId &&
      targetBot.userId === run.userId &&
      run.collaborationStatus !== "policy_disabled",
  );
  if (permitted && sourceBot) {
    const [sourceMember, targetMember, thread, parent, message] = await Promise.all([
      tx.spaceMember.findUnique({
        where: {
          spaceId_userId: {
            spaceId: sourceBot.spaceId,
            userId: sourceBot.userId,
          },
        },
      }),
      tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
      }),
      tx.thread.findFirst({
        where: { id: run.threadId, spaceId: run.spaceId, userId: run.userId },
      }),
      run.parentRunId
        ? tx.run.findFirst({
            where: {
              id: run.parentRunId,
              spaceId: sourceBot.spaceId,
              botId: sourceBot.id,
              userId: sourceBot.userId,
            },
          })
        : null,
      run.sourceMessageId
        ? tx.message.findFirst({
            where: {
              id: run.sourceMessageId,
              threadId: run.threadId,
            },
          })
        : null,
    ]);
    const blocks = MessageBlock.array().safeParse(message?.blocks);
    const sourceMatches =
      run.origin === "child_prompt"
        ? Boolean(message || (!run.parentRunId && targetBot?.parentBotId === sourceBot.id))
        : blocks.success &&
          blocks.data.some((block) =>
            run.origin === "group_handoff"
              ? block.kind === "handoff" &&
                block.fromBotId === sourceBot.id &&
                block.toBotId === run.botId
              : block.kind === "bot_message_received" && block.fromBotId === sourceBot.id,
          );
    permitted = Boolean(
      sourceMember &&
        targetMember &&
        thread &&
        sourceMatches &&
        (!run.parentRunId || parent) &&
        (run.origin === "external_agent" ||
          (sourceBot.spaceId === run.spaceId && sourceBot.userId === run.userId)),
    );
  }
  if (permitted && run.origin === "external_agent") {
    const connection = await tx.agentConnection.findFirst({
      where: {
        status: "approved",
        OR: [
          { requesterBotId: run.collaborationSourceBotId!, targetBotId: run.botId },
          { requesterBotId: run.botId, targetBotId: run.collaborationSourceBotId! },
        ],
      },
      select: { id: true },
    });
    const locked = connection
      ? await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
          SELECT status FROM agent_connections WHERE id = ${connection.id} FOR UPDATE
        `)
      : [];
    permitted = locked[0]?.status === "approved";
  }
  if (permitted) return { allowed: true, notices: [] };
  await cancelRunsInTransaction(tx, [run], new Date());
  await tx.run.updateMany({ where: { id: run.id }, data: { error: "policy_disabled" } });
  const notices = await settleRows(tx, [run], "policy_disabled");
  const event = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "run.cancelled",
    runId: run.id,
    allowCancelledRun: true,
    payload: { reason: "policy_disabled", error: "policy_disabled" },
  });
  notices.push({ threadId: event.threadId, seq: event.seq });
  return { allowed: false, notices };
}

/** Owner-only compare-and-set update and pending-delivery settlement commit together. */
export async function updateSpaceCollaborationForMember(
  prisma: PrismaClient,
  input: {
    currentSpaceId: string;
    userId: string;
    spaceId: string;
    allowBotCollaboration: boolean;
    expectedCollaborationRevision: number;
  },
): Promise<{ policy: SpaceCollaborationPolicy; notices: CollaborationNotice[] }> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockSpaces(tx, [input.currentSpaceId, input.spaceId]);
      const [currentMember, targetMember, space] = await Promise.all([
        tx.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: input.currentSpaceId, userId: input.userId } },
        }),
        tx.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
        }),
        tx.space.findUnique({ where: { id: input.spaceId } }),
      ]);
      if (!currentMember) throw new IsolationError();
      if (!space || !targetMember || currentMember.organizationId !== targetMember.organizationId)
        throw new SpaceNotFoundError();
      if (targetMember.role !== "owner") throw new CannotChangeCollaborationError();
      if (space.deletingAt) throw new SpaceDeletionInProgressError();
      if (space.collaborationRevision !== input.expectedCollaborationRevision)
        throw new CollaborationRevisionConflictError();
      if (space.allowBotCollaboration === input.allowBotCollaboration)
        return {
          policy: {
            spaceId: space.id,
            allowBotCollaboration: space.allowBotCollaboration,
            collaborationRevision: space.collaborationRevision,
            canManageCollaboration: true,
          },
          notices: [],
        };
      if (space.collaborationRevision === 2147483647)
        throw new CollaborationRevisionConflictError();
      const revision = space.collaborationRevision + 1;
      await tx.space.update({
        where: { id: space.id },
        data: {
          allowBotCollaboration: input.allowBotCollaboration,
          collaborationRevision: revision,
        },
      });
      await tx.spaceCollaborationChange.create({
        data: {
          spaceId: space.id,
          actorUserId: input.userId,
          previousAllowed: space.allowBotCollaboration,
          allowed: input.allowBotCollaboration,
          revision,
        },
      });
      const notices: CollaborationNotice[] = [];
      if (!input.allowBotCollaboration) {
        // An upgrade leaves already-started legacy peers unclassified. Suppress
        // their still-pending returns without rewriting origins or Run history.
        const legacy = await tx.$queryRaw<
          Array<{
            id: string;
            botId: string;
            parentRunId: string | null;
            collaborationMessageId: string | null;
            collaborationStatus: string | null;
          }>
        >(Prisma.sql`
          SELECT DISTINCT r."id", r."botId", r."parentRunId",
            r."collaborationMessageId", r."collaborationStatus"
          FROM runs r
          JOIN threads target_thread ON target_thread.id = r."threadId"
            AND target_thread."spaceId" = r."spaceId" AND target_thread."userId" = r."userId"
          JOIN bots target_bot ON target_bot.id = r."botId"
            AND target_bot."spaceId" = r."spaceId" AND target_bot."userId" = r."userId"
          JOIN messages incoming ON incoming.id = r."sourceMessageId"
            AND incoming."threadId" = r."threadId" AND incoming.role = 'user'
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(incoming.blocks) = 'array'
              THEN incoming.blocks ELSE '[]'::jsonb END
          ) block
          JOIN bots sender ON sender.id = block->>'fromBotId'
          WHERE r.origin = 'human' AND r.trigger = 'bot_message'
            AND r."startedAt" IS NOT NULL AND r."botOutcomeReturnedAt" IS NULL
            AND r."collaborationStatus" IS NULL AND block->>'kind' = 'bot_message_received'
            AND (r.status IN (${Prisma.join([...ACTIVE_RUN_STATUSES, "completed", "failed"])})
              OR (r.status = 'cancelled' AND r.error IN (${Prisma.join([...stuckWorkStatusMessages()])})))
            AND (r."spaceId" = ${space.id} OR sender."spaceId" = ${space.id})
        `);
        notices.push(...(await settleRows(tx, legacy, "policy_disabled")));
        const runs = await tx.run.findMany({
          where: {
            origin: { in: [...BOT_COLLABORATION_ORIGINS] },
            collaborationStatus: "waiting_peer",
            OR: [{ spaceId: space.id }, { collaborationSourceSpaceId: space.id }],
          },
          orderBy: { id: "asc" },
        });
        const unstarted = runs.filter(
          (run) => !run.startedAt && ["queued", "leased"].includes(run.status),
        );
        await cancelRunsInTransaction(tx, unstarted, new Date());
        await tx.run.updateMany({
          where: { id: { in: unstarted.map((run) => run.id) } },
          data: { error: "policy_disabled" },
        });
        notices.push(...(await settleRows(tx, runs, "policy_disabled")));
        for (const run of unstarted) {
          const event = await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            type: "run.cancelled",
            runId: run.id,
            allowCancelledRun: true,
            payload: { reason: "policy_disabled", error: "policy_disabled" },
          });
          notices.push({ threadId: event.threadId, seq: event.seq });
        }
      }
      return {
        policy: {
          spaceId: space.id,
          allowBotCollaboration: input.allowBotCollaboration,
          collaborationRevision: revision,
          canManageCollaboration: true,
        },
        notices,
      };
    }),
  );
}
