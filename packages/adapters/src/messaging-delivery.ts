import { createHash } from "node:crypto";
import type {
  AdapterContext,
  ArtifactStore,
  JobPublisher,
  MessagingFailureReason,
  MessagingOutboundAttachment,
  MessagingOutboundStatus,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import { messagingDeliverJob, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_HOPS,
  botMessageHopExhausted,
  nextBotMessageHop,
  projectExternalPageMessages,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  readMessagingDelivery,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { MessagingSendError, providerOfThreadId } from "./chat-sdk-surface.js";
import { splitOutboundBody } from "./messaging-platforms.js";

/**
 * Margin under vendor consecutive-outbound caps (sendblue enforces one hard):
 * past this many DMs without a reply from the owner, mirror rows stay pending
 * until the next inbound resets the counter.
 */
export const MESSAGING_DM_OUTBOUND_CAP = 140;

/** Provider-send attempts before a mirrored row is declared lost. */
export const MESSAGING_OUTBOUND_MAX_ATTEMPTS = 5;
export const MESSAGING_CLAIM_TTL_MS = 2 * 60_000;
export const MESSAGING_PENDING_STATUSES = ["pending", "file_pending"];
const receiptRetentionMs = 15 * 60_000;
const maxConcurrentConversations = 8;

type OutboundRow = Prisma.MessagingOutboundGetPayload<Record<string, never>>;
type Route = { kind: "dm" | "group"; identityId?: string; threadId?: string; provider: string };

export interface MessagingDeliveryDeps {
  prisma: PrismaClient;
  messaging: MessagingSurface;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify">;
  jobs: Pick<JobPublisher, "enqueue">;
  artifacts?: Pick<ArtifactStore, "get">;
}

type IdentityRow = {
  id: string;
  provider: string;
  address: string;
  dmThreadId: string | null;
  outboundSinceInbound: number;
  spaceId?: string;
  userId?: string;
  botId?: string;
};

/**
 * Automatic mirror, not a send tool: every text-bearing bot message of a
 * messaging run is copied into the uniform outbox and sent, so delivery does
 * not depend on prompt compliance. DM runs go to the owner's conversation;
 * channel runs go to the group with an attribution prefix and are fanned
 * out internally to peer approved bots (agent-to-agent traffic never
 * transits the messaging provider). Also drains pending outbox rows (invites
 * and intros are enqueued by the channels slice).
 */
export async function deliverMessagingOutbound(
  deps: MessagingDeliveryDeps,
  input: { runId?: string },
  context: AdapterContext,
): Promise<void> {
  if (input.runId) {
    await mirrorMessagingOutbound(deps, input.runId);
  }
  await drain(deps, context);
}

export async function mirrorMessagingOutbound(
  deps: MessagingDeliveryDeps,
  runId: string,
): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: {
      sourceMessage: true,
      thread: { select: { externalConversation: { select: { provider: true } } } },
    },
  });
  if (!run) return;
  const terminal = run.status === "completed" || run.status === "failed";
  // Installed Slack conversations reply through their own workspace adapter.
  // Mark the legacy mirror as considered so recovery cannot queue it forever.
  if (
    !run.thread?.externalConversation?.provider.startsWith("slack~") &&
    !(
      run.trigger === "bot_message" &&
      !(await delegatedRouteAllowsLegacyMirror(deps.prisma, run.parentRunId))
    )
  ) {
    await mirrorRun(deps, run);
  }
  // A running snapshot can precede the final reply even if the Run settles
  // before this write. Only a snapshot already terminal acknowledges its mirror.
  if (run.trigger === "messaging" && terminal) {
    await deps.prisma.run.updateMany({
      where: { id: runId, trigger: "messaging" },
      data: { messagingMirroredAt: new Date() },
    });
  }
}

async function delegatedRouteAllowsLegacyMirror(prisma: PrismaClient, parentId: string | null) {
  for (let hop = 0; parentId && hop <= BOT_MESSAGE_MAX_HOPS; hop++) {
    const parent = await prisma.run.findUnique({
      where: { id: parentId },
      select: {
        parentRunId: true,
        thread: { select: { externalConversation: { select: { provider: true } } } },
      },
    });
    if (!parent || parent.thread?.externalConversation?.provider.startsWith("slack~")) return false;
    parentId = parent.parentRunId;
  }
  return !parentId;
}

async function mirrorRun(
  deps: MessagingDeliveryDeps,
  run: Prisma.RunGetPayload<{ include: { sourceMessage: true } }>,
): Promise<void> {
  if (run.trigger === "messaging") {
    const sourceBlocks = (run.sourceMessage?.blocks ?? []) as MessageBlock[];
    const channelBlock = sourceBlocks.find(
      (block): block is Extract<MessageBlock, { kind: "channel_message" }> =>
        block.kind === "channel_message",
    );
    if (channelBlock) {
      await mirrorChannelRun(deps, run, channelBlock);
      return;
    }
  } else if (run.trigger !== "bot_message") {
    // Mirror inbound messaging runs and delegated bot_message replies only.
    // Do not push in-app user/routine runs out to the linked chat.
    return;
  }

  const identity = await deps.prisma.messagingIdentity.findUnique({
    where: { botId: run.botId },
  });
  if (!identity) return;

  // bot_message runs can carry the bot's user-facing reply after a delegate wake.
  // The projection keeps reply text and Page titles, separate from inter-bot chatter.

  const messages = await deps.prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
  });
  await enqueueReplyParts(deps, projectExternalPageMessages(messages), {
    kind: "dm",
    identityId: identity.id,
    threadId: identity.dmThreadId ?? undefined,
    provider: identity.provider,
  });
}

async function enqueueReplyParts(
  deps: MessagingDeliveryDeps,
  replies: ReadonlyArray<{
    message: { id: string; blocks: unknown; createdAt?: Date };
    text: string;
  }>,
  route: Route,
) {
  for (const { message, text } of replies) {
    const bodies = text ? splitOutboundBody(route.provider, text) : [];
    const artifacts = replyArtifacts(message.blocks);
    const common = { ...route, sourceMessageId: message.id, createdAt: message.createdAt };
    const primaryKey = `msg:${message.id}`;
    const parts = [
      ...bodies.map((body, partIndex) => ({
        ...common,
        idempotencyKey: partIndex === 0 ? primaryKey : `${primaryKey}:part:${partIndex}`,
        body,
        partIndex: 2 * partIndex,
      })),
      ...artifacts.map((artifactId, index) => ({
        ...common,
        idempotencyKey:
          bodies.length === 0 && index === 0 ? primaryKey : `${primaryKey}:file:${artifactId}`,
        body: "",
        // Previous workers keep handling text after a rollback.
        status: "file_pending",
        artifactId,
        partIndex: 2 * (bodies.length + index),
      })),
    ];
    const [first, ...rest] = parts;
    if (!first) continue;
    // The primary part claims an immutable snapshot. All parts commit together,
    // including when a different mirror observes revised blocks concurrently.
    const inserted = await deps.prisma.$transaction(async (tx) => {
      const claim = await tx.messagingOutbound.createMany({ data: [first], skipDuplicates: true });
      if (!claim.count) return false;
      if (rest.length) await tx.messagingOutbound.createMany({ data: rest });
      return true;
    });
    if (inserted) await publishMessagingDelivery(deps.prisma, deps.events, [message.id]);
  }
}

function replyArtifacts(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  return [
    ...new Set(
      blocks.flatMap((block: { kind?: unknown; artifactId?: unknown } | null) =>
        (block?.kind === "image" || block?.kind === "file") && typeof block.artifactId === "string"
          ? [block.artifactId]
          : [],
      ),
    ),
  ];
}

/**
 * Channel runs post to the group with an attribution prefix, then fan the
 * post out internally to peer approved bots: context only by default, a
 * waking run on @-mention, bounded by the shared bot-message hop budget.
 */
async function mirrorChannelRun(
  deps: MessagingDeliveryDeps,
  run: { id: string; botId: string },
  channelBlock: Extract<MessageBlock, { kind: "channel_message" }>,
): Promise<void> {
  const identity = await deps.prisma.messagingIdentity.findUnique({
    where: { botId: run.botId },
  });
  if (!identity) return;
  const channel = await deps.prisma.messagingChannel.findUnique({
    where: { id: channelBlock.channelId },
  });
  if (!channel) return;
  const owner = await deps.prisma.user.findUnique({
    where: { id: identity.userId },
    select: { name: true },
  });
  const firstName = owner?.name.trim().split(/\s+/)[0] || "Owner";
  const fromLabel = `${firstName}'s agent`;

  const replies = await deps.prisma.message.findMany({
    select: { id: true, blocks: true, createdAt: true },
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
  });
  // Ask answers are entered privately in the app. Check the same snapshot as
  // the replies so a resumed run cannot publish an answer-influenced response.
  if (
    replies.some((message) =>
      (message.blocks as MessageBlock[]).some(
        (block) => block.kind === "ask" && block.status === "answered",
      ),
    )
  )
    return;
  const projected = projectExternalPageMessages(replies);
  await enqueueReplyParts(
    deps,
    projected.map(({ message, text }) => ({ message, text: text ? `${fromLabel}: ${text}` : "" })),
    { kind: "group", threadId: channel.threadId, provider: providerOfThreadId(channel.threadId) },
  );
  const messages = projected.filter((entry) => entry.text);

  const hop = nextBotMessageHop(channelBlock.hop);
  const peers = await deps.prisma.messagingChannelMember.findMany({
    where: {
      channelId: channel.id,
      status: "approved",
      identityId: { not: null },
      NOT: { identityId: identity.id },
    },
  });
  for (const { message, text, authoredText } of messages) {
    for (const peer of peers) {
      const peerIdentity = await deps.prisma.messagingIdentity.findUnique({
        where: { id: peer.identityId! },
      });
      if (!peerIdentity) continue;
      const peerThread = await deps.prisma.thread.findFirst({
        where: { botId: peerIdentity.botId },
      });
      if (!peerThread) continue;
      const peerBot = await deps.prisma.bot.findUnique({
        where: { id: peerIdentity.botId },
        select: { name: true },
      });
      const block: MessageBlock = {
        kind: "channel_message",
        provider: identity.provider,
        ...(channelBlock.transport ? { transport: channelBlock.transport } : {}),
        channelId: channel.id,
        fromAddress: identity.address,
        fromLabel,
        text,
        hop,
      };
      const clientNonce = `messaging-peer:${message.id}:${peerIdentity.botId}`;
      const mentioned = peerBot?.name
        ? new RegExp(`@${escapeRegExp(peerBot.name)}\\b`, "i").test(authoredText)
        : false;
      if (mentioned && !botMessageHopExhausted(hop)) {
        const sent = await deps.events.sendUserMessage({
          spaceId: peerIdentity.spaceId,
          threadId: peerThread.id,
          botId: peerIdentity.botId,
          userId: peerIdentity.userId,
          blocks: [block],
          prompt: `[Group "${channel.name ?? "group"}" — ${fromLabel}]: ${text}`,
          trigger: "messaging",
          clientNonce,
        });
        if (sent.runId) {
          await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
            getLogger().error("messaging peer wake enqueue error", error);
          });
        }
        continue;
      }
      // Context only: the peer sees the post in history without a wake.
      const existing = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: peerThread.id, clientNonce } },
      });
      if (existing) continue;
      const event = await deps.prisma.$transaction(async (tx) => {
        const created = await createThreadMessageInTransaction(tx, {
          threadId: peerThread.id,
          role: "user",
          blocks: [block],
          clientNonce,
        });
        return appendEventInTransaction(tx, {
          spaceId: peerIdentity.spaceId,
          threadId: peerThread.id,
          botId: peerIdentity.botId,
          type: "thread.message.created",
          payload: {
            messageId: created.id,
            messageSeq: created.seq,
            role: "user",
            blocks: [block],
          },
        });
      });
      await deps.events.notify(peerThread.id, event.seq).catch(() => undefined);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `connect:{requesterBotId}:{targetBotId}` — agent-connection approval DMs. */
function connectInvitePair(
  idempotencyKey: string,
): { requesterBotId: string; targetBotId: string } | null {
  const match = /^connect:([^:]+):([^:]+)$/.exec(idempotencyKey);
  if (!match) return null;
  return { requesterBotId: match[1]!, targetBotId: match[2]! };
}

/**
 * Deliver a connect invite while holding the connection row lock.
 * Revoke's status update blocks behind this lock, so it cannot commit
 * (and delete the claim) between the pending check and the send.
 * Only used for rare approval DMs, not for ordinary mirrored traffic.
 *
 * At-most-once: any failure after the provider call (or an ambiguous
 * transport error) keeps the outer claim as `sent` so drain does not
 * restore pending and duplicate the YES/NO DM. A lost invite is fine;
 * reconnect starts a fresh cycle.
 */
async function sendConnectInvite(
  deps: MessagingDeliveryDeps,
  row: OutboundRow,
  claimStartedAt: Date,
  threadId: string,
  pair: { requesterBotId: string; targetBotId: string },
  context: AdapterContext,
): Promise<"delivered" | "skipped" | "held"> {
  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM agent_connections
          WHERE "requesterBotId" = ${pair.requesterBotId}
            AND "targetBotId" = ${pair.targetBotId}
          FOR UPDATE
        `;
        if (locked[0]?.status !== "pending") {
          await tx.messagingOutbound.updateMany({
            where: claimFilter(row, claimStartedAt),
            data: { status: "failed", deliveryState: "failed", claimStartedAt: null },
          });
          return "skipped";
        }
        const outbound = await tx.messagingOutbound.findFirst({
          where: claimFilter(row, claimStartedAt),
          select: { id: true },
        });
        if (!outbound) return "skipped";
        try {
          const sent = await deps.messaging.sendToThread({ threadId, body: row.body }, context);
          if (!sent.handle) return "held";
          await recordAcceptance(
            tx,
            claimFilter(row, claimStartedAt),
            providerOfThreadId(threadId),
            sent.handle,
          );
          return "delivered";
        } catch (error) {
          if (error instanceof MessagingSendError) throw error;
          // Provider error or lost response is ambiguous without an
          // idempotency key. Do not ask drain to retry.
          return "held";
        }
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
  } catch (error) {
    if (error instanceof MessagingSendError) throw error;
    // Lock/timeout after a possible accept: keep the outer claim as sent.
    return "held";
  }
}

const laneOrder = [
  { createdAt: "asc" },
  { sourceMessageId: { sort: "asc", nulls: "first" } },
  { partIndex: "asc" },
  { id: "asc" },
] as const;

function conversationOf(row: Pick<OutboundRow, "identityId" | "threadId">) {
  if (row.identityId) return { identityId: row.identityId };
  if (row.threadId) return { identityId: null, threadId: row.threadId };
  return null;
}

async function drain(deps: MessagingDeliveryDeps, context: AdapterContext): Promise<void> {
  const staleBefore = new Date(Date.now() - MESSAGING_CLAIM_TTL_MS);
  const stale = await deps.prisma.messagingOutbound.updateManyAndReturn({
    where: {
      status: "sent",
      deliveryState: { in: ["sending", "unknown"] },
      claimStartedAt: { not: null },
      updatedAt: { lte: staleBefore },
    },
    data: { deliveryState: "unknown", lastErrorClass: "outcome_unknown", claimStartedAt: null },
    select: { sourceMessageId: true },
  });
  if (stale.length)
    await publishMessagingDelivery(
      deps.prisma,
      deps.events,
      stale.map(({ sourceMessageId }) => sourceMessageId),
    );
  await deps.prisma.messagingOutbound.deleteMany({
    where: { status: "receipt", createdAt: { lte: new Date(Date.now() - receiptRetentionMs) } },
  });
  const pending = await deps.prisma.messagingOutbound.findMany({
    where: {
      status: { in: MESSAGING_PENDING_STATUSES },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: [...laneOrder],
  });
  const heads = new Map<string, OutboundRow>();
  for (const row of pending) {
    const lane = row.identityId ? `dm:${row.identityId}` : `thread:${row.threadId ?? row.id}`;
    if (!heads.has(lane)) heads.set(lane, row);
  }
  const next = heads.values();
  const errors: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(maxConcurrentConversations, heads.size) }, async () => {
      for (const head of next) {
        try {
          await deliverLane(deps, context, head);
        } catch (error) {
          errors.push(error);
        }
      }
    }),
  );
  if (errors.length) throw errors[0];
}

async function deliverLane(
  deps: MessagingDeliveryDeps,
  context: AdapterContext,
  head: OutboundRow,
): Promise<void> {
  const conversation = conversationOf(head);
  let row: OutboundRow | null = head;
  while (row) {
    if (context.signal.aborted || (row.nextAttemptAt && row.nextAttemptAt.getTime() > Date.now()))
      return;
    if (conversation) {
      const earlier = await deps.prisma.messagingOutbound.findFirst({
        where: {
          ...conversation,
          AND: [
            {
              OR: [
                { status: { in: MESSAGING_PENDING_STATUSES } },
                {
                  status: "sent",
                  deliveryState: { in: ["sending", "unknown"] },
                  claimStartedAt: { not: null },
                },
              ],
            },
            {
              OR: [
                { createdAt: { lt: row.createdAt } },
                ...(row.sourceMessageId
                  ? [
                      { createdAt: row.createdAt, sourceMessageId: null },
                      { createdAt: row.createdAt, sourceMessageId: { lt: row.sourceMessageId } },
                    ]
                  : []),
                {
                  createdAt: row.createdAt,
                  sourceMessageId: row.sourceMessageId,
                  partIndex: { lt: row.partIndex },
                },
                {
                  createdAt: row.createdAt,
                  sourceMessageId: row.sourceMessageId,
                  partIndex: row.partIndex,
                  id: { lt: row.id },
                },
              ],
            },
          ],
        },
        select: { id: true },
      });
      if (earlier) return;
    }
    const claimStartedAt = new Date();
    const claim = await deps.prisma.messagingOutbound.updateMany({
      where: {
        id: row.id,
        status: { in: MESSAGING_PENDING_STATUSES },
        attempts: row.attempts,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: claimStartedAt } }],
      },
      data: { status: "sent", deliveryState: "sending", claimStartedAt, nextAttemptAt: null },
    });
    if (claim.count !== 1) return;
    const sourceMessageId = row.kind === "attachment_notice" ? null : row.sourceMessageId;
    const canContinue = await deliverRow(deps, context, row, claimStartedAt).finally(() =>
      sourceMessageId
        ? publishMessagingDelivery(deps.prisma, deps.events, [sourceMessageId])
        : undefined,
    );
    if (!canContinue) return;
    row = conversation
      ? await deps.prisma.messagingOutbound.findFirst({
          where: { ...conversation, status: { in: MESSAGING_PENDING_STATUSES } },
          orderBy: [...laneOrder],
        })
      : null;
  }
}

function claimFilter(row: OutboundRow, claimStartedAt: Date) {
  return { id: row.id, status: "sent", deliveryState: "sending", claimStartedAt };
}

async function deliverRow(
  deps: MessagingDeliveryDeps,
  context: AdapterContext,
  row: OutboundRow,
  claimStartedAt: Date,
): Promise<boolean> {
  const where = claimFilter(row, claimStartedAt);
  let identity: IdentityRow | null = null;
  let attachment: MessagingOutboundAttachment | undefined;
  let threadId = row.threadId;
  let dispatched = false;
  let provider = row.provider ?? (threadId ? providerOfThreadId(threadId) : null);
  let handle: string;
  try {
    if (row.identityId) {
      identity = await deps.prisma.messagingIdentity.findUnique({ where: { id: row.identityId } });
      if (!identity) throw new MessagingSendError("permanent", "rejected");
      if (provider && provider !== identity.provider)
        throw new MessagingSendError("permanent", "rejected");
      provider = identity.provider;
      if (
        identity.provider === "sendblue" &&
        identity.outboundSinceInbound >= MESSAGING_DM_OUTBOUND_CAP
      ) {
        await deps.prisma.messagingOutbound.updateMany({
          where,
          data: { status: row.status, deliveryState: null, claimStartedAt: null },
        });
        return false;
      }
      threadId ??= await resolveDirectThread(deps, identity, context);
    }
    if (!threadId || !provider || providerOfThreadId(threadId) !== provider)
      throw new MessagingSendError("permanent", "rejected");
    if (row.artifactId) attachment = await loadOutboundAttachment(deps, row, provider, context);

    const invitePair = connectInvitePair(row.idempotencyKey);
    if (invitePair) {
      const result = await sendConnectInvite(
        deps,
        row,
        claimStartedAt,
        threadId,
        invitePair,
        context,
      );
      if (result === "held") await markUnknown(deps, row, claimStartedAt, provider);
      if (result !== "delivered") return true;
      if (identity) await countDirectSend(deps, identity.id);
      return true;
    }

    const stamped = await deps.prisma.messagingOutbound.updateMany({
      where,
      data: { provider, threadId },
    });
    if (stamped.count !== 1) return false;
    dispatched = true;
    const sent = await deps.messaging.sendToThread(
      {
        threadId,
        body: row.body,
        idempotencyKey: row.idempotencyKey,
        ...(attachment && { attachment }),
      },
      context,
    );
    if (!sent.handle) throw new MessagingSendError("unknown", "outcome_unknown");
    handle = sent.handle;
  } catch (error) {
    if (!(error instanceof MessagingSendError) && dispatched) {
      await markUnknown(deps, row, claimStartedAt, provider);
      return true;
    }
    const failure =
      error instanceof MessagingSendError
        ? error
        : new MessagingSendError("retryable", "rejected", undefined, error);
    if (failure.disposition === "unknown") {
      if (failure.inFlight && provider) {
        try {
          await markUnknown(deps, row, claimStartedAt, provider, true);
        } finally {
          void finishInFlight(
            deps,
            { ...row, threadId },
            claimStartedAt,
            provider,
            failure.inFlight,
          );
        }
        return false;
      }
      await markUnknown(deps, row, claimStartedAt, provider);
      return true;
    }
    return recordRejectedSend(deps, { ...row, threadId }, claimStartedAt, failure, provider);
  }

  // Once a provider accepts the message, even a failed write or counter
  // increment must never cause another provider call.
  try {
    await deps.prisma.$transaction((tx) => recordAcceptance(tx, where, provider, handle));
  } catch (error) {
    getLogger().error("messaging acceptance bookkeeping", error);
    await markUnknown(deps, row, claimStartedAt, provider);
  }
  if (identity) await countDirectSend(deps, identity.id);
  return true;
}

async function countDirectSend(deps: MessagingDeliveryDeps, identityId: string): Promise<void> {
  await deps.prisma.messagingIdentity
    .update({
      where: { id: identityId },
      data: { outboundSinceInbound: { increment: 1 } },
    })
    .catch((error) => getLogger().error("messaging counter update", error));
}

async function markUnknown(
  deps: MessagingDeliveryDeps,
  row: OutboundRow,
  claimStartedAt: Date,
  provider: string | null,
  inFlight = false,
) {
  await deps.prisma.messagingOutbound.updateMany({
    where: claimFilter(row, claimStartedAt),
    data: {
      provider,
      deliveryState: "unknown",
      lastErrorClass: "outcome_unknown",
      claimStartedAt: inFlight ? claimStartedAt : null,
    },
  });
}

async function finishInFlight(
  deps: MessagingDeliveryDeps,
  row: OutboundRow,
  claimStartedAt: Date,
  provider: string,
  inFlight: Promise<{ handle: string }>,
): Promise<void> {
  const where = {
    id: row.id,
    status: "sent",
    deliveryState: { in: ["sending", "unknown"] },
    claimStartedAt,
  };
  // Renew only while this process still owns a live SDK request.
  const keepClaim = setInterval(() => {
    void deps.prisma.messagingOutbound
      .updateMany({ where, data: { updatedAt: new Date() } })
      .catch(() => undefined);
  }, MESSAGING_CLAIM_TTL_MS / 4);
  keepClaim.unref();
  try {
    const result = await inFlight.catch((error: unknown) => error);
    if (result instanceof MessagingSendError && result.disposition !== "unknown") {
      const continueLane = await recordRejectedSend(
        deps,
        row,
        claimStartedAt,
        result,
        provider,
        where,
      );
      await publishMessagingDelivery(deps.prisma, deps.events, [row.sourceMessageId]);
      if (continueLane) await deps.jobs.enqueue(messagingDeliverJob());
      return;
    }
    const handle =
      result &&
      typeof result === "object" &&
      "handle" in result &&
      typeof result.handle === "string"
        ? result.handle
        : null;
    if (handle) {
      await deps.prisma.$transaction((tx) => recordAcceptance(tx, where, provider, handle));
      if (row.identityId) await countDirectSend(deps, row.identityId);
    } else {
      await deps.prisma.messagingOutbound.updateMany({
        where,
        data: { deliveryState: "unknown", lastErrorClass: "outcome_unknown", claimStartedAt: null },
      });
    }
    await publishMessagingDelivery(deps.prisma, deps.events, [row.sourceMessageId]);
    await deps.jobs.enqueue(messagingDeliverJob());
  } catch (error) {
    // The durable stale-claim sweep releases an interrupted finalizer.
    getLogger().error("messaging late acceptance bookkeeping", error);
  } finally {
    clearInterval(keepClaim);
  }
}

async function loadOutboundAttachment(
  deps: MessagingDeliveryDeps,
  row: OutboundRow,
  provider: string,
  context: AdapterContext,
): Promise<MessagingOutboundAttachment> {
  const unavailable = new MessagingSendError("permanent", "attachment_unavailable");
  if (
    !deps.artifacts ||
    !row.sourceMessageId ||
    !deps.messaging
      .platforms()
      .some((item) => item.provider === provider && item.capabilities.files)
  )
    throw unavailable;
  const source = await deps.prisma.message.findUnique({
    where: { id: row.sourceMessageId },
    select: { runId: true },
  });
  if (!source?.runId) throw unavailable;
  const run = await deps.prisma.run.findUnique({
    where: { id: source.runId },
    select: { spaceId: true, userId: true, botId: true },
  });
  if (!run) throw unavailable;
  const { spaceId, userId, botId } = run;
  const artifact = await deps.prisma.artifact.findFirst({
    where: { id: row.artifactId!, spaceId, userId, botId },
    select: { name: true, mimeType: true, storageKey: true },
  });
  if (!artifact) throw unavailable;
  const data = await deps.artifacts.get(artifact.storageKey, {
    ...context,
    spaceId,
    userId,
    botId,
  });
  return { data, name: artifact.name, mimeType: artifact.mimeType };
}

async function recordRejectedSend(
  deps: MessagingDeliveryDeps,
  row: OutboundRow,
  claimStartedAt: Date,
  failure: MessagingSendError,
  provider: string | null,
  where: Prisma.MessagingOutboundWhereInput = claimFilter(row, claimStartedAt),
): Promise<boolean> {
  const attempts = (row.attempts ?? 0) + 1;
  const exhausted =
    failure.disposition === "permanent" || attempts >= MESSAGING_OUTBOUND_MAX_ATTEMPTS;
  const retryAt = exhausted
    ? null
    : new Date(
        Date.now() + Math.max(messagingOutboundRetryDelayMs(attempts), failure.retryAfterMs ?? 0),
      );
  const update = {
    where,
    data: {
      provider,
      attempts,
      status: exhausted ? "failed" : row.status,
      deliveryState: exhausted ? "failed" : null,
      lastErrorClass: failure.reason,
      nextAttemptAt: retryAt,
      claimStartedAt: null,
    },
  };
  if (exhausted && row.artifactId) {
    await deps.prisma.$transaction(async (tx) => {
      const changed = await tx.messagingOutbound.updateMany(update);
      if (changed.count !== 1) return;
      await tx.messagingOutbound.createMany({
        data: [
          {
            idempotencyKey: `msg:${row.sourceMessageId}:attachment-notice`,
            kind: "attachment_notice",
            identityId: row.identityId,
            threadId: row.threadId,
            provider,
            body: "An attachment could not be sent.",
            sourceMessageId: row.sourceMessageId,
            createdAt: row.createdAt,
            partIndex: 2_147_483_647,
          },
        ],
        skipDuplicates: true,
      });
    });
    return true;
  }
  await deps.prisma.messagingOutbound.updateMany(update);
  if (retryAt) await deps.jobs.enqueue(messagingDeliverJob(undefined, retryAt));
  return exhausted;
}

/**
 * DM rows address the identity, not a thread: the conversation id is learned
 * from inbound webhooks and cached, with a provider lookup as fallback for
 * identities that predate the cache (or the multi-platform migration).
 */
async function resolveDirectThread(
  deps: MessagingDeliveryDeps,
  identity: IdentityRow,
  context: AdapterContext,
): Promise<string> {
  if (identity.dmThreadId) return identity.dmThreadId;
  const threadId = await deps.messaging.openDirectThread(
    identity.provider,
    identity.address,
    context,
  );
  await deps.prisma.messagingIdentity.update({
    where: { id: identity.id },
    data: { dmThreadId: threadId },
  });
  return threadId;
}

/** Exponential backoff per attempt, capped at one minute. */
function messagingOutboundRetryDelayMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 60_000);
}

/** Delivery receipts change the existing message without creating a chat turn. */
async function publishMessagingDelivery(
  prisma: PrismaClient,
  events: Pick<ThreadEvents, "notify">,
  ids: readonly (string | null)[],
) {
  for (const messageId of new Set(ids)) {
    if (!messageId) continue;
    try {
      const event = await prisma.$transaction(async (tx) => {
        const source = await tx.message.findUnique({
          where: { id: messageId },
          select: {
            botId: true,
            threadId: true,
            thread: { select: { botId: true, spaceId: true } },
          },
        });
        const botId = source?.botId ?? source?.thread.botId;
        if (!source || !botId) return null;
        // Serialize the read and publication with the thread's event cursor.
        // Receipt processing commits before it waits for this lock.
        await tx.$queryRaw`SELECT id FROM public.threads WHERE id = ${source.threadId} FOR UPDATE`;
        const state = (await readMessagingDelivery(tx, [messageId])).get(messageId);
        if (!state) return null;
        const latest = await tx.event.findFirst({
          where: {
            threadId: source.threadId,
            type: "thread.message.delivery",
            payload: { path: ["messageId"], equals: messageId },
          },
          orderBy: { seq: "desc" },
          select: { payload: true },
        });
        const previous = latest?.payload as {
          delivery?: { state?: string; reason?: string };
        } | null;
        if (previous?.delivery?.state === state.state && previous.delivery.reason === state.reason)
          return null;
        return appendEventInTransaction(tx, {
          spaceId: source.thread.spaceId,
          botId,
          threadId: source.threadId,
          type: "thread.message.delivery",
          payload: { messageId, delivery: state },
        });
      });
      if (event) await events.notify(event.threadId, event.seq);
    } catch (error) {
      // The snapshot still projects the durable outbox state.
      getLogger().error("messaging delivery status notification", error);
    }
  }
}

type Receipt = {
  deliveryState: "accepted" | "delivered" | "failed";
  deliveredAt: Date | null;
  lastErrorClass: MessagingFailureReason | null;
};

function receiptData(event: MessagingOutboundStatus): Receipt | null {
  switch (event.status.toUpperCase()) {
    case "DELIVERED":
    case "READ":
      return { deliveryState: "delivered", deliveredAt: new Date(), lastErrorClass: null };
    case "SENT":
      return { deliveryState: "accepted", deliveredAt: null, lastErrorClass: null };
    case "ERROR":
    case "DECLINED":
    case "FAILED":
      return {
        deliveryState: "failed",
        deliveredAt: null,
        lastErrorClass: event.reason ?? "rejected",
      };
    default:
      return null;
  }
}

function receiptOrder(state: string | null): number {
  if (state === "delivered") return 3;
  if (state === "failed") return 2;
  if (state === "accepted") return 1;
  return 0;
}

function receiptKey(provider: string, handle: string): string {
  const digest = createHash("sha256").update(provider).update("\0").update(handle).digest("hex");
  return `receipt:${digest}`;
}

async function lockReceipt(tx: Prisma.TransactionClient, key: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 2))::text`;
}

async function recordAcceptance(
  tx: Prisma.TransactionClient,
  where: Prisma.MessagingOutboundWhereInput,
  provider: string,
  handle: string,
) {
  const key = handle ? receiptKey(provider, handle) : null;
  if (key) await lockReceipt(tx, key);
  const receipt = key
    ? await tx.messagingOutbound.findUnique({
        where: { idempotencyKey: key, status: "receipt" },
        select: { deliveryState: true, deliveredAt: true, lastErrorClass: true },
      })
    : null;
  const state = receipt?.deliveryState ?? "accepted";
  const changed = await tx.messagingOutbound.updateMany({
    where,
    data: {
      provider,
      providerHandle: handle || null,
      status: state === "failed" ? "failed" : "sent",
      deliveryState: state,
      claimStartedAt: null,
      deliveredAt: receipt?.deliveredAt ?? null,
      lastErrorClass: receipt?.lastErrorClass ?? null,
    },
  });
  if (key && receipt && changed.count === 1)
    await tx.messagingOutbound.deleteMany({ where: { idempotencyKey: key, status: "receipt" } });
}

/** Reconcile authenticated receipts with the same provider's exact handle. */
export async function applyMessagingOutboundStatus(
  prisma: PrismaClient,
  event: MessagingOutboundStatus,
  events?: Pick<ThreadEvents, "notify">,
): Promise<void> {
  const receipt = receiptData(event);
  if (!receipt || !event.handle) return;
  const key = receiptKey(event.provider, event.handle);
  const changed = await prisma.$transaction(async (tx) => {
    await lockReceipt(tx, key);
    const candidates = await tx.messagingOutbound.findMany({
      where: {
        providerHandle: event.handle,
        OR: [{ provider: event.provider }, { provider: null }],
      },
      select: {
        id: true,
        provider: true,
        identityId: true,
        threadId: true,
        deliveryState: true,
        sourceMessageId: true,
      },
    });
    const legacyIds = candidates.flatMap((row) =>
      !row.provider && row.identityId ? [row.identityId] : [],
    );
    const identities = legacyIds.length
      ? await tx.messagingIdentity.findMany({
          where: { id: { in: legacyIds }, provider: event.provider },
          select: { id: true },
        })
      : [];
    const legacy = new Set(identities.map(({ id }) => id));
    const matches = candidates.filter(
      (row) =>
        row.provider === event.provider ||
        (!row.provider &&
          (row.identityId
            ? legacy.has(row.identityId)
            : row.threadId && providerOfThreadId(row.threadId) === event.provider)),
    );
    if (matches.length) {
      const updates = matches.filter(
        (row) => receiptOrder(row.deliveryState) < receiptOrder(receipt.deliveryState),
      );
      if (updates.length)
        await tx.messagingOutbound.updateMany({
          where: { id: { in: updates.map(({ id }) => id) } },
          data: {
            ...receipt,
            provider: event.provider,
            status: receipt.deliveryState === "failed" ? "failed" : "sent",
          },
        });
      return updates.map(({ sourceMessageId }) => sourceMessageId);
    }

    // A webhook can arrive before the sender has saved its handle. Keep it
    // briefly for an in-flight send, without guessing a recipient or message.
    const sending = await tx.messagingOutbound.findFirst({
      where: {
        provider: event.provider,
        status: "sent",
        deliveryState: { in: ["sending", "unknown"] },
        claimStartedAt: { not: null },
      },
      select: { id: true },
    });
    if (!sending) return;
    const pending = await tx.messagingOutbound.findUnique({
      where: { idempotencyKey: key },
      select: { deliveryState: true },
    });
    if (receiptOrder(pending?.deliveryState ?? null) >= receiptOrder(receipt.deliveryState)) return;
    await tx.messagingOutbound.upsert({
      where: { idempotencyKey: key },
      create: {
        idempotencyKey: key,
        kind: "receipt",
        status: "receipt",
        provider: event.provider,
        body: "",
        ...receipt,
      },
      update: receipt,
    });
  });
  if (events && changed?.length) await publishMessagingDelivery(prisma, events, changed);
}
