import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { SandboxRateLimitError, WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import type { WorkspaceSaveFailureReason, WorkspaceSaveProgress } from "@rakazo/contracts";
import { WorkspaceSaveFailureReasonSchema } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  Prisma,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type SaveStatusDeps = { prisma: PrismaClient; events?: ThreadEvents };
type SaveTarget = { id: string; spaceId: string };

export class WorkspaceSaveDiskSpaceError extends WorkspaceTooLargeError {
  constructor() {
    super("bytes");
    this.message = "There is not enough disk space to save the computer's files";
  }
}

export function workspaceSaveFailureReason(
  error: unknown,
  storage: boolean,
): WorkspaceSaveFailureReason {
  if (
    error instanceof WorkspaceSaveDiskSpaceError ||
    (error instanceof Error && "code" in error && error.code === "ENOSPC")
  ) {
    return "disk_space";
  }
  if (error instanceof WorkspaceTooLargeError) {
    return error.limit === "bytes" ? "too_large" : "too_many_files";
  }
  if (error instanceof SandboxRateLimitError) return "rate_limited";
  return storage ? "storage_failed" : "export_failed";
}

const failureText: Record<WorkspaceSaveFailureReason, string> = {
  disk_space: "Not enough disk space to save the workspace.",
  too_large: "The computer's files are too large to save.",
  too_many_files: "The computer has too many files to save.",
  rate_limited: "The computer provider is limiting save requests.",
  export_failed: "The computer could not export its files.",
  storage_failed: "The workspace could not be stored.",
};

function saveBots(prisma: Pick<PrismaClient, "bot">, computer: SaveTarget) {
  return prisma.bot.findMany({
    where: { computerId: computer.id, spaceId: computer.spaceId, archivedAt: null },
    select: { id: true, thread: { select: { id: true } } },
  });
}

/** Invalidation only. Receivers read the authoritative status instead of replaying counters. */
export async function notifyWorkspaceSaveChanged(deps: SaveStatusDeps, computer: SaveTarget) {
  if (!deps.events) return;
  const events = deps.events;
  try {
    const bots = await saveBots(deps.prisma, computer);
    if (bots.length === 0) return;
    const memberships = await deps.prisma.chatGroupMember.findMany({
      where: {
        bot: { computerId: computer.id, spaceId: computer.spaceId, archivedAt: null },
        group: { spaceId: computer.spaceId, archivedAt: null },
      },
      select: { botId: true, group: { select: { thread: { select: { id: true } } } } },
    });
    const targets = [
      ...bots.map((bot) => ({ botId: bot.id, thread: bot.thread })),
      ...memberships.map(({ botId, group }) => ({ botId, thread: group.thread })),
    ];
    for (const { botId, thread } of targets) {
      if (!thread) continue;
      await events
        .append({
          spaceId: computer.spaceId,
          threadId: thread.id,
          botId,
          type: "computer.status",
          payload: { workspaceSaveChanged: true },
        })
        .catch((error: unknown) => getLogger().warn("notify workspace save status", { error }));
    }
  } catch (error) {
    getLogger().warn("load workspace save status recipients", { error });
  }
}

export async function writeWorkspaceSaveProgress(
  deps: SaveStatusDeps,
  fence: Prisma.ComputerWhereInput,
  claimAt: Date,
  progress: WorkspaceSaveProgress | null | undefined,
): Promise<boolean> {
  try {
    const result = await deps.prisma.computer.updateMany({
      where: { ...fence, updatedAt: claimAt },
      data: {
        updatedAt: claimAt,
        workspaceSaveProgress:
          progress === undefined
            ? Prisma.DbNull
            : { claimAt: claimAt.toISOString(), observedAt: new Date().toISOString(), progress },
      },
    });
    return result.count === 1;
  } catch (error) {
    getLogger().warn("write workspace save progress", { error });
    return false;
  }
}

/** The failure record, first system note per thread, and its event commit together. */
export async function recordWorkspaceSaveFailure(
  deps: SaveStatusDeps,
  computer: SaveTarget,
  where: () => Prisma.ComputerWhereInput,
  context: AdapterContext,
  reason: WorkspaceSaveFailureReason,
) {
  try {
    const notices = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        const candidates = deps.events ? await saveBots(tx, computer) : [];
        const threadIds = candidates.flatMap(({ thread }) => (thread ? [thread.id] : []));
        // Match takeover/Stop's Thread → Computer lock order.
        const lockedThreads = new Set(
          threadIds.length > 0
            ? (
                await tx.$queryRaw<
                  { id: string }[]
                >`SELECT id FROM threads WHERE "spaceId" = ${computer.spaceId} AND id IN (${Prisma.join(threadIds)}) ORDER BY id FOR UPDATE`
              ).map(({ id }) => id)
            : [],
        );
        await tx.$queryRaw`SELECT id FROM computers WHERE id = ${computer.id} AND "spaceId" = ${computer.spaceId} FOR UPDATE`;
        if (context.signal.aborted) return [];
        const current = await tx.computer.findFirst({
          where: where(),
          select: { updatedAt: true, workspaceSaveFailure: true },
        });
        if (!current) return [];
        const existing = current.workspaceSaveFailure;
        const episode =
          existing && typeof existing === "object" && !Array.isArray(existing)
            ? existing
            : undefined;
        const previous = WorkspaceSaveFailureReasonSchema.safeParse(episode?.reason);
        const existingNonce = typeof episode?.nonce === "string" ? episode.nonce : undefined;
        const clientNonce = existingNonce ?? `computer-unsaved:${randomUUID()}`;
        // Chat history can be cleared independently of the computer's save episode.
        const notifiedThreads = new Set(
          Array.isArray(episode?.notifiedThreadIds)
            ? episode.notifiedThreadIds.filter((id) => typeof id === "string")
            : [],
        );
        const recipients = [];
        if (lockedThreads.size > 0) {
          for (const bot of await saveBots(tx, computer)) {
            const threadId = bot.thread?.id;
            if (!threadId || !lockedThreads.has(threadId) || notifiedThreads.has(threadId))
              continue;
            notifiedThreads.add(threadId);
            recipients.push({ botId: bot.id, threadId });
          }
        }
        if (!previous.success || previous.data !== reason || !existingNonce || recipients.length) {
          const recordedFailure = await tx.computer.updateMany({
            where: where(),
            data: {
              workspaceSaveFailure: {
                reason,
                nonce: clientNonce,
                notifiedThreadIds: [...notifiedThreads],
              },
              updatedAt: current.updatedAt,
            },
          });
          if (recordedFailure.count !== 1) return [];
        }
        const blocks = [{ kind: "meta" as const, text: failureText[reason] }];
        const recorded: { threadId: string; seq: number }[] = [];
        for (const { botId, threadId } of recipients) {
          const message = await createThreadMessageInTransaction(tx, {
            threadId,
            botId,
            role: "system",
            blocks,
            clientNonce,
          });
          const event = await appendEventInTransaction(tx, {
            spaceId: computer.spaceId,
            threadId,
            botId,
            type: "thread.message.created",
            payload: { messageId: message.id, messageSeq: message.seq, role: "system", blocks },
          });
          recorded.push({ threadId, seq: event.seq });
        }
        return recorded;
      }),
    );
    for (const { threadId, seq } of notices) {
      await deps.events?.notify?.(threadId, seq).catch(() => undefined);
    }
  } catch (error) {
    getLogger().warn("record workspace save failure", { error });
  }
}
