import { runContinueJob } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import {
  botMessageContext,
  botMessageHopExhausted,
  nextBotMessageHop,
  renderBotGroupDirectory,
  renderGroupMembersContext,
  resolveBotAddress,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  authorizeBotCollaboration,
  BotCollaborationDisabledError,
  BotCollaborationSourceInactiveError,
  collaborationRunFields,
  createThreadMessageInTransaction,
  groupMemberOrderBy,
  IsolationError,
  lockOwnedGroup,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { PeerDispatchDeps } from "./collaboration-policy.js";

export async function handoffToGroupBot(
  deps: PeerDispatchDeps,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
  },
  groupId: string,
  input: {
    bot_id?: string;
    confirm_name?: string;
    message: string;
    deliveryKey?: string;
    files?: Array<Extract<MessageBlock, { kind: "image" | "file" }>>;
  },
) {
  // The file-delivery wrapper bounds the message before it reads or saves files.
  const text = input.message.trim();
  const addressedGroup = await deps.prisma.chatGroup.findFirst({
    where: { id: groupId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
    select: {
      thread: { select: { id: true } },
      members: {
        where: { bot: { archivedAt: null } },
        select: { bot: { select: { id: true, name: true } } },
        orderBy: groupMemberOrderBy,
      },
    },
  });
  if (!addressedGroup?.thread) return { error: "group is no longer available" } as const;
  const addressedTarget = resolveBotAddress(
    addressedGroup.members.map((member) => member.bot),
    {
      botId: input.bot_id,
      name: input.confirm_name,
    },
  );
  if (!addressedTarget) return { error: "handoff target is not a group member" } as const;
  const addressedTargetId = addressedTarget.id;
  const addressedThreadId = addressedGroup.thread.id;
  const committed = await deps.prisma
    .$transaction(async (tx) => {
      const policy = await authorizeBotCollaboration(tx, {
        sourceRunId: run.id,
        sourceSpaceId: run.spaceId,
        sourceThreadId: run.threadId,
        sourceBotId: run.botId,
        sourceUserId: run.userId,
        targetSpaceId: run.spaceId,
        targetThreadId: addressedThreadId,
        targetBotId: addressedTargetId,
        targetUserId: run.userId,
        toolName: "handoff_to_bot",
      });
      try {
        await lockOwnedGroup(tx, run, groupId);
      } catch (error) {
        if (error instanceof IsolationError)
          return { error: "group is no longer available" } as const;
        throw error;
      }
      const [group, activeSource] = await Promise.all([
        tx.chatGroup.findFirst({
          where: { id: groupId, archivedAt: null, thread: { id: addressedThreadId } },
          include: {
            thread: { select: { id: true } },
            members: {
              where: { bot: { archivedAt: null } },
              include: { bot: { select: { id: true, name: true } } },
              orderBy: groupMemberOrderBy,
            },
          },
        }),
        tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            status: "running",
          },
          select: {
            id: true,
            thread: { select: { groupId: true } },
            sourceMessage: { select: { blocks: true } },
          },
        }),
      ]);
      if (!group?.thread || !activeSource)
        return { error: "source run is no longer active" } as const;
      const targetThreadId = group.thread.id;
      const inGroup = targetThreadId === run.threadId;
      if (!inGroup && activeSource.thread.groupId)
        return { error: "group handoffs must stay in the current group" } as const;
      for (const threadId of [...new Set([run.threadId, targetThreadId])].sort()) {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      }
      const deliveryKey = `group-handoff:${inGroup ? run.id : (input.deliveryKey ?? run.id)}`;
      if (!group.members.some((member) => member.bot.id === run.botId)) {
        return { error: "source bot is no longer a group member" } as const;
      }

      const existing = await tx.message.findUnique({
        where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
        select: {
          id: true,
          sourceRuns: {
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { id: true, botId: true, collaborationStatus: true },
          },
        },
      });
      if (existing) {
        const nextRun = existing.sourceRuns[0];
        if (nextRun?.collaborationStatus === "policy_disabled")
          return { error: "policy_disabled" } as const;
        const event = await tx.event.findFirst({
          where: {
            threadId: targetThreadId,
            type: "group.handoff",
            payload: { path: ["messageId"], equals: existing.id },
          },
          orderBy: { seq: "desc" },
          select: { seq: true },
        });
        if (!nextRun || !event) return { error: "recorded handoff is incomplete" } as const;
        return {
          ok: true,
          botId: nextRun.botId,
          runId: nextRun.id,
          eventSeq: event.seq,
          threadId: targetThreadId,
          inGroup,
          groupName: group.name,
        } as const;
      }

      const targetId = addressedTargetId;
      if (targetId === run.botId) return { error: "cannot hand off to yourself" } as const;
      if (!group.members.some((member) => member.bot.id === targetId)) {
        return { error: "handoff target is not a group member" } as const;
      }
      if (
        !input.bot_id &&
        input.confirm_name?.trim() &&
        !group.members.some(
          (member) =>
            member.bot.id === targetId &&
            member.bot.name.toLowerCase() === input.confirm_name!.trim().toLowerCase(),
        )
      ) {
        return { error: "handoff target changed; try again" } as const;
      }

      let sourceBlocks: MessageBlock[] = [];
      if (activeSource.sourceMessage) {
        const parsedSource = MessageBlock.array().safeParse(activeSource.sourceMessage.blocks);
        if (!parsedSource.success) {
          return { error: "cannot verify the group handoff chain" } as const;
        }
        sourceBlocks = parsedSource.data;
      }
      const sourceHandoff = sourceBlocks.find(
        (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
      );
      if (sourceHandoff?.fromBotId === targetId) {
        return {
          error:
            "do not hand this stage back to its sender; post the result in the shared thread instead",
        } as const;
      }
      const hop = nextBotMessageHop(sourceHandoff?.hop ?? botMessageContext(sourceBlocks)?.hop);
      if (botMessageHopExhausted(hop)) {
        return {
          error:
            "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
        } as const;
      }

      const handoffBlock: MessageBlock = {
        kind: "handoff",
        fromBotId: run.botId,
        toBotId: targetId,
        text,
        hop,
        deliveryStatus: "waiting_peer",
      };
      const message = await createThreadMessageInTransaction(tx, {
        threadId: targetThreadId,
        role: "bot",
        blocks: [handoffBlock, ...(input.files ?? [])],
        botId: run.botId,
        runId: inGroup ? run.id : undefined,
        clientNonce: deliveryKey,
      });
      const task = await tx.task.create({
        data: {
          spaceId: run.spaceId,
          botId: targetId,
          threadId: targetThreadId,
          userId: run.userId,
          prompt: text,
          status: "queued",
        },
      });
      const nextRun = await tx.run.create({
        data: {
          spaceId: run.spaceId,
          botId: targetId,
          threadId: targetThreadId,
          taskId: task.id,
          userId: run.userId,
          status: "queued",
          trigger: "follow_up",
          sourceMessageId: message.id,
          ...collaborationRunFields({
            origin: "group_handoff",
            sourceRunId: run.id,
            sourceSpaceId: run.spaceId,
            sourceBotId: run.botId,
            sourceRevision: policy.sourceRevision,
            targetRevision: policy.targetRevision,
            outboundMessageId: message.id,
          }),
        },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: targetThreadId,
        botId: run.botId,
        type: "group.handoff",
        runId: inGroup ? run.id : undefined,
        payload: {
          messageId: message.id,
          messageSeq: message.seq,
          role: "bot",
          fromBotId: run.botId,
          toBotId: targetId,
          text,
          blocks: [handoffBlock, ...(input.files ?? [])],
        },
      });
      await touchGroupUpdatedAt(tx, groupId);
      return {
        ok: true,
        botId: targetId,
        runId: nextRun.id,
        eventSeq: event.seq,
        threadId: targetThreadId,
        inGroup,
        groupName: group.name,
      } as const;
    })
    .catch((error: unknown) => {
      if (error instanceof BotCollaborationDisabledError)
        return { error: "policy_disabled" } as const;
      if (error instanceof BotCollaborationSourceInactiveError)
        return { error: error.message } as const;
      throw error;
    });
  if ("error" in committed) return committed;
  await deps.events.notify(committed.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("group handoff realtime notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable and the job reconciler will repair a missed immediate wake.
    getLogger().error("group handoff enqueue", error);
  });
  return {
    ok: true,
    botId: committed.botId,
    runId: committed.runId,
    groupId,
    groupName: committed.groupName,
    note: committed.inGroup
      ? "Handoff recorded. End this turn without narrating it; the next bot owns the next stage."
      : "Handoff recorded in the selected group. The next bot will reply there. Continue any independent work.",
  };
}

export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
  self: { id: string; name: string },
): Promise<string | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: {
          bot: { select: { id: true, name: true, title: true, description: true } },
        },
        orderBy: groupMemberOrderBy,
      },
    },
  });
  if (!group) return undefined;
  return renderGroupMembersContext(
    group.name,
    group.members.map((member) => member.bot),
    self,
  );
}

/** Only the current bot's active groups in its space are discoverable. */
export async function loadBotGroupDirectory(
  prisma: PrismaClient,
  actor: { botId: string; spaceId: string; userId: string },
): Promise<string | undefined> {
  const groups = await prisma.chatGroup.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
      members: { some: { botId: actor.botId, bot: { archivedAt: null } } },
      thread: { isNot: null },
    },
    select: {
      id: true,
      name: true,
      members: {
        where: { bot: { archivedAt: null } },
        select: { bot: { select: { id: true, name: true } } },
        orderBy: groupMemberOrderBy,
      },
    },
    orderBy: { createdAt: "asc" },
    take: 40,
  });
  return renderBotGroupDirectory(
    groups.map((group) => ({
      id: group.id,
      name: group.name,
      members: group.members.map((member) => member.bot),
    })),
  );
}
