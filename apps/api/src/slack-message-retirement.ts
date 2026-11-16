import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { GroupRunTeardownKey, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  cancelRunsInTransaction,
  createThreadMessageInTransaction,
  Prisma,
  recordGroupRunTeardowns,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { teamChatMessageClientNonce } from "./team-chat-bridge.js";
import { inboundDeliveryClientNonce, messagingWakeIdempotencyKey } from "./webhook-inbound.js";

const BATCH_SIZE = 20;
const RETIRED = "Slack authorization changed. Send a new message to continue.";
const UNCONFIRMED =
  "Slack reply delivery could not be confirmed. Check the channel before sending a new message.";

// A persisted grant change is irreversible for this receipt. Provider outages
// and missing process configuration do not establish revocation.
const retired = Prisma.sql`
  NOT EXISTS (
    SELECT 1 FROM public.messaging_installations i
    WHERE c.provider = 'slack~' || i.id AND i.provider = 'slack'
      AND i."spaceId" = c."spaceId" AND i."userId" = c."userId" AND i."botId" = c."botId"
      AND i."workspaceId" = c."workspaceId" AND i.status = 'active'
      AND coalesce(e."slackGrantRevision", 1) = i.revision AND e."createdAt" > i."acceptAfter"
  )
`;

function candidates(now: Date) {
  return Prisma.sql`
    c.provider LIKE 'slack~%' AND ${retired}
    AND (
      e.status IN ('received', 'deferred', 'queueing', 'running')
      OR (e.status = 'ignored' AND
        (e."engagementReason" = 'message_routine_wake' OR
          r.status IN (${Prisma.join([...ACTIVE_RUN_STATUSES])})))
      OR (e.status = 'failed' AND r.status IN (${Prisma.join([...ACTIVE_RUN_STATUSES])}))
      OR (e.status = 'delivering' AND
        (e."providerReplyHandle" IS NOT NULL OR e."nextAttemptAt" IS NULL OR e."nextAttemptAt" <= ${now}))
    )
  `;
}

/** Settle retired installed-channel work without loading or using its credentials. */
export async function retireSlackMessages(
  prisma: PrismaClient,
  events: Pick<ThreadEvents, "notify">,
  settleComputerTeardown: (key: GroupRunTeardownKey) => Promise<unknown>,
) {
  const now = new Date();
  const pending = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT e.id FROM public.external_messages e
    JOIN public.external_conversations c ON c.id = e."externalConversationId"
    LEFT JOIN public.runs r ON r.id = e."runId"
    WHERE ${candidates(now)}
    ORDER BY e."createdAt", e.id LIMIT ${BATCH_SIZE}
  `);
  for (const { id } of pending) {
    const settled = await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          providerReplyHandle: string | null;
          providerEventId: string;
          slackGrantRevision: number | null;
          provider: string;
          conversationId: string;
          spaceId: string;
          userId: string;
          botId: string;
          threadId: string;
        }>
      >(Prisma.sql`
        SELECT e.id, e.status, e."providerReplyHandle", e."providerEventId",
          e."slackGrantRevision", c.provider, c.id AS "conversationId",
          c."spaceId", c."userId", c."botId", t.id AS "threadId"
        FROM public.external_messages e
        JOIN public.external_conversations c ON c.id = e."externalConversationId"
        JOIN public.threads t ON t."externalConversationId" = c.id
        LEFT JOIN public.runs r ON r.id = e."runId"
        WHERE e.id = ${id} AND ${candidates(now)}
        FOR UPDATE OF e
      `);
      if (!row) return null;
      // Admission locks receipt before Thread. Keep that order when cancelling
      // its exact Run, and never stop unrelated work in the same conversation.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${row.threadId} FOR UPDATE`;
      let teardownKeys: GroupRunTeardownKey[] = [];
      let eventSeq: number | null = null;
      if (row.status === "delivering") {
        await tx.externalMessage.update({
          where: { id },
          data: {
            status: "delivered",
            providerReplyHandle: row.providerReplyHandle ?? "unconfirmed",
            deliveredAt: now,
            nextAttemptAt: null,
            lastError: row.providerReplyHandle
              ? null
              : "Delivery confirmation lost; skipped retry to avoid duplicates",
          },
        });
        if (row.providerReplyHandle) return null;
      } else {
        const run = await tx.run.findFirst({
          where: {
            spaceId: row.spaceId,
            userId: row.userId,
            botId: row.botId,
            threadId: row.threadId,
            OR: [
              {
                trigger: "messaging",
                sourceMessage: {
                  clientNonce: teamChatMessageClientNonce(row.provider, row.providerEventId),
                },
              },
              {
                trigger: "webhook",
                sourceMessage: {
                  clientNonce: inboundDeliveryClientNonce(
                    "messaging",
                    row.botId,
                    messagingWakeIdempotencyKey(row.provider, row.providerEventId),
                  ),
                },
              },
            ],
          },
          select: { id: true, taskId: true, botId: true },
        });
        if (run) {
          const cancelled = await cancelRunsInTransaction(tx, [run], now);
          const pending = await recordGroupRunTeardowns(
            tx,
            { spaceId: row.spaceId, userId: row.userId },
            cancelled,
            [],
          );
          teardownKeys = pending.keys;
          for (const winner of cancelled) {
            await tx.run.update({ where: { id: winner.id }, data: { error: RETIRED } });
            const event = await appendEventInTransaction(tx, {
              spaceId: row.spaceId,
              threadId: row.threadId,
              botId: row.botId,
              runId: winner.id,
              type: "run.cancelled",
              payload: {},
            });
            eventSeq = event.seq;
          }
        }
        await tx.externalMessage.update({
          where: { id },
          data: {
            status: "failed",
            runId: run?.id ?? null,
            nextAttemptAt: null,
            lastError: RETIRED,
          },
        });
      }
      const unknownDelivery = row.status === "delivering";
      const nonce = `slack-grant-retired:${row.conversationId}:${row.slackGrantRevision ?? "legacy"}${unknownDelivery ? ":unconfirmed" : ""}`;
      if (
        await tx.message.findUnique({
          where: { threadId_clientNonce: { threadId: row.threadId, clientNonce: nonce } },
          select: { id: true },
        })
      )
        return { teardownKeys, threadId: row.threadId, eventSeq };
      const blocks = [{ kind: "meta" as const, text: unknownDelivery ? UNCONFIRMED : RETIRED }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: row.threadId,
        botId: row.botId,
        role: "system",
        blocks,
        clientNonce: nonce,
        markUnread: true,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: row.spaceId,
        threadId: row.threadId,
        botId: row.botId,
        type: "thread.message.created",
        payload: { messageId: message.id, messageSeq: message.seq, role: "system", blocks },
      });
      return { teardownKeys, threadId: row.threadId, eventSeq: event.seq };
    });
    if (!settled) continue;
    if (settled.eventSeq !== null) {
      await events.notify(settled.threadId, settled.eventSeq).catch(() => {
        getLogger().error("Slack retirement notification failed");
      });
    }
    for (const key of settled.teardownKeys) await settleComputerTeardown(key);
  }
}
