import type { DelegatedApproval, DelegatedApprovalAction } from "@rakazo/contracts";
import { ApprovalReceiptSchema, MessageBlock } from "@rakazo/contracts";
import { isApprovalAskBlock } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { findPendingAsk } from "./messages.js";
import { lockSpaceLifecycle } from "./spaces.js";
import { withTransactionRetry } from "./transaction-retry.js";

export interface DelegatedApprovalSource {
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
}

export interface AnswerDelegatedApprovalInput extends DelegatedApprovalSource {
  sessionId: string;
  clientNonce: string;
  dispatchMessageId: string;
  runId: string;
  messageId: string;
  effectId: string;
  action: DelegatedApprovalAction;
}

/** Use the same Space -> sorted threads order as peer dispatch and policy changes. */
export async function lockDelegatedApproval(
  tx: Prisma.TransactionClient,
  input: AnswerDelegatedApprovalInput,
) {
  await lockSpaceLifecycle(tx, input.spaceId);
  const candidate = await tx.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      userId: input.userId,
      origin: "bot_peer",
      collaborationSourceBotId: input.botId,
      collaborationMessageId: input.dispatchMessageId,
    },
    select: { threadId: true, botId: true },
  });
  if (!candidate || candidate.threadId === input.threadId || candidate.botId === input.botId)
    return null;

  for (const id of [input.threadId, candidate.threadId].sort()) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM threads WHERE id = ${id} AND "spaceId" = ${input.spaceId} FOR UPDATE
    `;
    if (!locked.length) return null;
  }
  // Archive locks active Runs before changing the Bot row. Holding the B Run
  // also serializes with Stop and protects the recheck through the commit.
  await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE`;
  if (!(await lockApprovalOwners(tx, input, [input.botId, candidate.botId]))) return null;
  const sessions = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "session" WHERE id = ${input.sessionId} AND "userId" = ${input.userId}
      AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') FOR SHARE
  `;
  if (!sessions.length) return null;
  const [run] = await loadDelegatedApprovalRuns(tx, input, [input.dispatchMessageId], input.runId);
  return run?.threadId === candidate.threadId && run.botId === candidate.botId && run.policyActive
    ? run
    : null;
}

async function lockApprovalOwners(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; userId: string },
  botIds: string[],
) {
  for (const id of botIds.sort()) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM bots WHERE id = ${id} AND "spaceId" = ${input.spaceId}
      AND "userId" = ${input.userId} AND "archivedAt" IS NULL FOR SHARE
    `;
    if (!locked.length) return false;
  }
  const membership = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM space_members WHERE "spaceId" = ${input.spaceId} AND "userId" = ${input.userId}
    FOR SHARE
  `;
  return membership.length === 1;
}

type PeerApprovalExecution = {
  spaceId: string;
  runId: string;
  effectId: string;
  leaseOwner: string;
  leaseFence: number;
};

export function claimDelegatedApprovedEffect(prisma: PrismaClient, input: PeerApprovalExecution) {
  return withTransactionRetry(() =>
    prisma.$transaction((tx) => guardPeerApprovalExecution(tx, input, "approved")),
  );
}

export function recheckDelegatedApprovalDispatch(
  prisma: PrismaClient,
  input: PeerApprovalExecution,
) {
  return withTransactionRetry(() =>
    prisma.$transaction((tx) => recheckDelegatedApprovalDispatchInTransaction(tx, input)),
  );
}

export function recheckDelegatedApprovalDispatchInTransaction(
  tx: Prisma.TransactionClient,
  input: PeerApprovalExecution,
) {
  return guardPeerApprovalExecution(tx, input, "executing");
}

async function guardPeerApprovalExecution(
  tx: Prisma.TransactionClient,
  input: PeerApprovalExecution,
  status: "approved" | "executing",
): Promise<boolean> {
  await lockSpaceLifecycle(tx, input.spaceId);
  const active = await tx.$queryRaw<Array<{ id: string }>>`
  SELECT id FROM runs WHERE id = ${input.runId} AND "spaceId" = ${input.spaceId}
    AND status = 'running' AND "leaseOwner" = ${input.leaseOwner}
    AND "leaseFence" = ${input.leaseFence}
    AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') FOR UPDATE
`;
  if (!active.length) return false;
  const run = await tx.run.findUnique({
    where: { id: input.runId },
    select: {
      origin: true,
      userId: true,
      botId: true,
      collaborationSourceBotId: true,
      collaborationSourceSpaceId: true,
      collaborationStatus: true,
      collaborationRevision: true,
      collaborationSourceRevision: true,
      space: {
        select: { allowBotCollaboration: true, deletingAt: true, collaborationRevision: true },
      },
    },
  });
  const sourceBotId = run?.collaborationSourceBotId;
  const available = Boolean(
    run?.origin === "bot_peer" &&
      sourceBotId &&
      sourceBotId !== run.botId &&
      run.collaborationSourceSpaceId === input.spaceId &&
      run.space.allowBotCollaboration &&
      !run.space.deletingAt &&
      run.collaborationStatus !== "policy_disabled" &&
      run.collaborationRevision === run.space.collaborationRevision &&
      run.collaborationSourceRevision === run.space.collaborationRevision &&
      (await lockApprovalOwners(tx, { spaceId: input.spaceId, userId: run.userId }, [
        sourceBotId,
        run.botId,
      ])) &&
      (await tx.bot.findFirst({
        where: { id: sourceBotId, NOT: { disabledBuiltinTools: { has: "message_bot" } } },
        select: { id: true },
      })),
  );
  const where = {
    id: input.effectId,
    spaceId: input.spaceId,
    runId: input.runId,
    status,
    requiresPeerApprovalRecheck: true,
  };
  if (status === "executing")
    return available && Boolean(await tx.externalEffect.findFirst({ where, select: { id: true } }));
  const updated = await tx.externalEffect.updateMany({
    where,
    data: available
      ? { status: "executing" }
      : {
          status: "completed",
          result: {
            error: "The delegated action is no longer authorized.",
            code: "delegated_approval_revoked",
          },
          approvalReceipt: { state: "failed" },
        },
  });
  return available && updated.count === 1;
}

export async function loadDelegatedApprovalRuns(
  db: Prisma.TransactionClient,
  source: DelegatedApprovalSource,
  dispatchMessageIds: string[],
  runId?: string,
) {
  if (!dispatchMessageIds.length) return [];
  const [sourceThread, membership, dispatches] = await Promise.all([
    db.thread.findFirst({
      where: {
        id: source.threadId,
        spaceId: source.spaceId,
        userId: source.userId,
        botId: source.botId,
        groupId: null,
        externalConversationId: null,
        bot: { spaceId: source.spaceId, userId: source.userId, archivedAt: null },
      },
      select: { bot: { select: { disabledBuiltinTools: true } } },
    }),
    db.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: source.spaceId, userId: source.userId } },
      select: {
        space: {
          select: { allowBotCollaboration: true, collaborationRevision: true, deletingAt: true },
        },
      },
    }),
    db.message.findMany({
      where: {
        id: { in: dispatchMessageIds },
        threadId: source.threadId,
        botId: source.botId,
        role: "bot",
        runId: { not: null },
      },
      select: { id: true, runId: true, blocks: true },
    }),
  ]);
  if (!sourceThread?.bot || !membership || membership.space.deletingAt) return [];
  const { space } = membership;
  const sourcePolicyActive =
    space.allowBotCollaboration && !sourceThread.bot.disabledBuiltinTools.includes("message_bot");

  const outbound = new Map(
    dispatches.flatMap((message) => {
      const parsed = MessageBlock.array().safeParse(message.blocks);
      const dispatch = parsed.data?.find((block) => block.kind === "bot_message_sent");
      return dispatch && (dispatch.intent === "request" || dispatch.intent === "question")
        ? [[message.id, { runId: message.runId!, dispatch }] as const]
        : [];
    }),
  );
  if (!outbound.size) return [];
  const parents = await db.run.findMany({
    where: {
      id: { in: [...outbound.values()].map((entry) => entry.runId) },
      botId: source.botId,
      threadId: source.threadId,
      spaceId: source.spaceId,
      userId: source.userId,
      parentRunId: null,
    },
    select: { id: true },
  });
  if (!parents.length) return [];
  const runs = await db.run.findMany({
    where: {
      ...(runId ? { id: runId } : {}),
      spaceId: source.spaceId,
      userId: source.userId,
      botId: { not: source.botId },
      origin: "bot_peer",
      trigger: "bot_message",
      parentRunId: { in: parents.map((parent) => parent.id) },
      collaborationMessageId: { in: [...outbound.keys()] },
      collaborationSourceBotId: source.botId,
      collaborationSourceSpaceId: source.spaceId,
      bot: { spaceId: source.spaceId, userId: source.userId, archivedAt: null },
      thread: {
        spaceId: source.spaceId,
        userId: source.userId,
        groupId: null,
        externalConversationId: null,
      },
    },
    select: {
      id: true,
      threadId: true,
      botId: true,
      status: true,
      parentRunId: true,
      collaborationMessageId: true,
      collaborationStatus: true,
      collaborationRevision: true,
      collaborationSourceRevision: true,
      bot: { select: { name: true } },
      thread: { select: { botId: true } },
      sourceMessage: {
        select: { threadId: true, role: true, authorUserId: true, runId: true, blocks: true },
      },
    },
  });
  return runs.flatMap((run) => {
    const dispatchMessageId = run.collaborationMessageId;
    const anchor = dispatchMessageId && outbound.get(dispatchMessageId);
    const inbound = run.sourceMessage;
    if (
      !dispatchMessageId ||
      !anchor ||
      anchor.runId !== run.parentRunId ||
      anchor.dispatch.toBotId !== run.botId ||
      run.thread.botId !== run.botId ||
      !inbound ||
      inbound.threadId !== run.threadId ||
      inbound.role !== "user" ||
      inbound.authorUserId !== null ||
      inbound.runId !== run.id
    )
      return [];
    const parsed = MessageBlock.array().safeParse(inbound.blocks);
    const request = parsed.data?.find((block) => block.kind === "bot_message_received");
    if (
      !request ||
      request.fromBotId !== source.botId ||
      request.returnToMessageId !== dispatchMessageId ||
      request.intent !== anchor.dispatch.intent ||
      request.hop !== 1
    )
      return [];
    return [
      {
        id: run.id,
        threadId: run.threadId,
        botId: run.botId,
        botName: run.bot.name,
        status: run.status,
        dispatchMessageId,
        policyActive:
          sourcePolicyActive &&
          run.collaborationStatus !== "policy_disabled" &&
          run.collaborationSourceRevision === space.collaborationRevision &&
          run.collaborationRevision === space.collaborationRevision,
      },
    ];
  });
}

export type DelegatedApprovalRun = Awaited<ReturnType<typeof loadDelegatedApprovalRuns>>[number];

/** The original Bot chat can acknowledge a repeated decision on its own peer Run. */
export async function hasPeerApprovalDecision(
  db: Prisma.TransactionClient,
  input: DelegatedApprovalSource & {
    runId: string;
    messageId: string;
    action: DelegatedApprovalAction;
  },
): Promise<boolean> {
  const run = await db.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      threadId: input.threadId,
      origin: "bot_peer",
      collaborationStatus: { not: "policy_disabled" },
    },
    select: { id: true },
  });
  if (!run) return false;
  const message = await db.message.findFirst({
    where: {
      id: input.messageId,
      threadId: input.threadId,
      botId: input.botId,
      runId: run.id,
      role: "bot",
    },
    select: { blocks: true },
  });
  const parsed = MessageBlock.array().safeParse(message?.blocks);
  const ask = parsed.data
    ?.filter(ordinaryApprovalCard)
    .find((block) => block.status === "answered" && block.answer === input.action);
  if (!ask) return false;
  return Boolean(
    await db.externalEffect.findFirst({
      where: {
        id: ask.approvalEffectId,
        spaceId: input.spaceId,
        runId: run.id,
        status:
          input.action === "deny"
            ? "denied"
            : { in: ["approved", "executing", "completed", "uncertain"] },
      },
      select: { id: true },
    }),
  );
}

export function ordinaryApprovalCard(block: MessageBlock): block is DelegatedApproval["block"] & {
  approvalEffectId: string;
} {
  return (
    block.kind === "ask" &&
    Boolean(block.approvalEffectId) &&
    block.input !== "secret" &&
    !block.credential &&
    !block.purpose &&
    !block.reviewMode &&
    isApprovalAskBlock(block)
  );
}

export async function loadDelegatedApprovals(
  db: Prisma.TransactionClient,
  source: DelegatedApprovalSource,
  dispatchMessageIds: string[],
): Promise<DelegatedApproval[]> {
  const runs = await loadDelegatedApprovalRuns(db, source, dispatchMessageIds);
  if (!runs.length) return [];
  const runById = new Map(runs.map((run) => [run.id, run]));
  // Ask creations identify candidate messages through the run/event index. Read the
  // current message rows so deleted history and stale event payloads cannot expose cards.
  const events = await db.event.findMany({
    where: {
      spaceId: source.spaceId,
      runId: { in: [...runById.keys()] },
      type: "thread.message.created",
      payload: { path: ["blocks"], array_contains: [{ kind: "ask" }] },
    },
    select: { payload: true },
  });
  const messageIds = events.flatMap(({ payload }) => {
    if (
      payload &&
      typeof payload === "object" &&
      "messageId" in payload &&
      typeof payload.messageId === "string"
    )
      return [payload.messageId];
    return [];
  });
  if (!messageIds.length) return [];
  const messages = await db.message.findMany({
    where: { id: { in: messageIds }, role: "bot" },
    select: { id: true, threadId: true, botId: true, runId: true, blocks: true },
    orderBy: [{ seq: "asc" }, { id: "asc" }],
  });
  const cards = messages.flatMap((message) => {
    const run = message.runId && runById.get(message.runId);
    if (!run || message.threadId !== run.threadId || message.botId !== run.botId) return [];
    const parsed = MessageBlock.array().safeParse(message.blocks);
    return (
      parsed.data?.filter(ordinaryApprovalCard).map((block) => ({ message, run, block })) ?? []
    );
  });
  if (!cards.length) return [];
  const pendingByRun = new Map(
    await Promise.all(
      runs
        .filter((run) => run.status === "waiting_input" && run.policyActive)
        .map(
          async (run) =>
            [run.id, await findPendingAsk(db, { threadId: run.threadId, runId: run.id })] as const,
        ),
    ),
  );
  const effects = await db.externalEffect.findMany({
    where: {
      id: { in: cards.map(({ block }) => block.approvalEffectId) },
      spaceId: source.spaceId,
    },
    select: { id: true, runId: true, status: true, approvalReceipt: true },
  });
  const effectById = new Map(effects.map((effect) => [effect.id, effect]));
  const latestByEffect = new Map(cards.map((card) => [card.block.approvalEffectId, card]));
  return [...latestByEffect.values()].flatMap(({ message, run, block }) => {
    const effect = effectById.get(block.approvalEffectId);
    if (effect?.runId !== run.id) return [];
    const pending = pendingByRun.get(run.id);
    const receipt = ApprovalReceiptSchema.safeParse(effect.approvalReceipt).data;
    const state = delegatedApprovalState(
      run,
      block,
      effect.status,
      receipt?.state,
      pending?.messageId === message.id && pending.pendingAsk.approvalEffectId === effect.id,
    );
    const receiptUrl = state === "succeeded" ? receipt?.url : undefined;
    return [
      {
        dispatchMessageId: run.dispatchMessageId,
        botId: run.botId,
        botName: run.botName,
        runId: run.id,
        messageId: message.id,
        effectId: effect.id,
        block,
        state,
        ...(receiptUrl ? { receiptUrl } : {}),
      },
    ];
  });
}

function delegatedApprovalState(
  run: DelegatedApprovalRun,
  block: DelegatedApproval["block"],
  status: string,
  receiptState: "succeeded" | "failed" | "unknown" | undefined,
  current: boolean,
): DelegatedApproval["state"] {
  if (status === "denied" || block.answer === "deny") return "denied";
  if (status === "uncertain") return "unknown";
  if (status === "completed") return receiptState ?? "unknown";
  if (run.status === "cancelled" || !run.policyActive)
    return status === "executing" ? "unknown" : "inactive";
  if (run.status === "failed") return status === "executing" ? "unknown" : "failed";
  if (status === "approved" || status === "executing")
    return run.status === "completed" ? "unknown" : "allowed";
  return status === "intended" &&
    run.status === "waiting_input" &&
    block.status === "pending" &&
    current
    ? "pending"
    : "inactive";
}
