import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { blocksToAgentHistoryText, isApprovalAskBlock, isSecretAskBlock } from "@rakazo/core";
import type { PrismaClient, Run } from "@rakazo/db";
import type { StoredScriptedState } from "./scripted-state.js";
import { parseStoredScriptedState, scriptedStateDigest } from "./scripted-state.js";

type ScriptedRun = Pick<Run, "id" | "spaceId" | "botId" | "threadId" | "scriptedState">;

export interface ScriptedResume {
  stored?: StoredScriptedState;
  resume?: "answer" | "takeover";
  held: boolean;
}

function invalidState(): never {
  throw new Error("Invalid scripted continuation state");
}

/** Admit only progress whose source rows and interactive receipt still belong to this run. */
export async function loadScriptedResume(
  prisma: PrismaClient,
  run: ScriptedRun,
  takeoverCheckpoint?: string | null,
): Promise<ScriptedResume> {
  if (run.scriptedState === null) {
    const paused = await prisma.attempt.findFirst({
      where: { runId: run.id, status: { in: ["waiting_input", "waiting_takeover"] } },
      select: { id: true },
    });
    if (paused) invalidState();
    return { held: false };
  }

  const stored = parseStoredScriptedState(run.scriptedState, run.id);
  const [writer, rows, consumed, pending] = await Promise.all([
    prisma.attempt.findFirst({
      where: { id: stored.attemptId, runId: run.id, fence: stored.fence },
    }),
    prisma.steeringMessage.findMany({
      where: {
        id: { in: stored.state.batch.map((item) => item.id) },
        runId: run.id,
        botId: run.botId,
        claimedAt: { not: null },
        message: { threadId: run.threadId },
      },
      include: { message: { select: { id: true, blocks: true, seq: true } } },
      orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
    }),
    prisma.externalEffect.findMany({
      where: { id: { in: stored.consumedEffectIds }, runId: run.id, spaceId: run.spaceId },
      select: { id: true },
    }),
    stored.pendingEffect
      ? prisma.externalEffect.findFirst({
          where: {
            id: stored.pendingEffect.id,
            runId: run.id,
            spaceId: run.spaceId,
            kind: stored.pendingEffect.kind,
            idempotencyKey: stored.pendingEffect.idempotencyKey,
          },
          select: { request: true },
        })
      : Promise.resolve(null),
  ]);
  if (!writer || rows.length !== stored.state.batch.length) invalidState();
  for (const [index, row] of rows.entries()) {
    const member = stored.state.batch[index]!;
    const blocks = MessageBlockSchema.array().safeParse(row.message.blocks);
    if (
      row.id !== member.id ||
      row.messageId !== member.messageId ||
      row.message.id !== member.messageId ||
      !blocks.success ||
      scriptedStateDigest(blocksToAgentHistoryText(blocks.data)) !== member.contentDigest
    )
      invalidState();
  }
  if (consumed.length !== stored.consumedEffectIds.length) invalidState();
  if (
    stored.pendingEffect &&
    (stored.state.cursor.phase !== "tool" ||
      !pending ||
      scriptedStateDigest(pending.request) !== stored.pendingEffect.requestDigest)
  )
    invalidState();

  if (!stored.pause) {
    // A checkpoint before a yield can survive a crash before the pause transaction.
    // A committed waiting attempt must instead have its exact atomic receipt.
    if (writer.status === "waiting_input" || writer.status === "waiting_takeover") invalidState();
    return { stored, held: false };
  }

  if (stored.pause.kind === "input") {
    if (
      writer.status !== "waiting_input" ||
      (stored.state.cursor.phase !== "ask" && stored.state.cursor.phase !== "tool")
    )
      invalidState();
    const message = await prisma.message.findFirst({
      where: {
        id: stored.pause.messageId,
        runId: run.id,
        threadId: run.threadId,
        botId: run.botId,
        role: "bot",
      },
      select: { id: true, blocks: true, createdAt: true },
    });
    const blocks = MessageBlockSchema.array().safeParse(message?.blocks);
    if (!message || !blocks.success || message.createdAt < writer.startedAt) invalidState();
    const asks = blocks.data.filter((block) => block.kind === "ask");
    if (asks.length !== 1) invalidState();
    const ask = asks[0]!;
    if (stored.state.cursor.phase === "ask") {
      if (stored.pendingEffect || isApprovalAskBlock(ask) || isSecretAskBlock(ask)) invalidState();
    } else {
      if (!stored.pendingEffect) invalidState();
      if (isApprovalAskBlock(ask)) {
        if (ask.approvalEffectId !== stored.pendingEffect.id) invalidState();
      } else if (isSecretAskBlock(ask)) {
        if (stored.pendingEffect.kind !== "request_secret") invalidState();
      } else invalidState();
    }
    if (ask.status !== "answered") return { stored, held: true };
    return {
      stored,
      ...(stored.state.cursor.phase === "ask" ? { resume: "answer" as const } : {}),
      held: false,
    };
  }

  if (
    writer.status !== "waiting_takeover" ||
    stored.state.cursor.phase !== "takeover" ||
    stored.pendingEffect
  )
    invalidState();
  const requested = await prisma.event.findFirst({
    where: {
      runId: run.id,
      threadId: run.threadId,
      botId: run.botId,
      spaceId: run.spaceId,
      seq: stored.pause.eventSeq,
      type: "computer.takeover.requested",
    },
    select: { seq: true, createdAt: true },
  });
  if (!requested || requested.createdAt < writer.startedAt) invalidState();
  if (takeoverCheckpoint !== "takeover" && takeoverCheckpoint !== "takeover-skipped")
    return { stored, held: true };
  const released = await prisma.event.findFirst({
    where: {
      runId: run.id,
      threadId: run.threadId,
      botId: run.botId,
      spaceId: run.spaceId,
      seq: { gt: requested.seq },
      type: "computer.takeover.released",
    },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  if (!released?.payload || typeof released.payload !== "object" || Array.isArray(released.payload))
    invalidState();
  const reason = released.payload.reason;
  if (
    typeof reason !== "string" ||
    (takeoverCheckpoint === "takeover-skipped") !== (reason === "skipped" || reason === "expired")
  )
    invalidState();
  return { stored, resume: "takeover", held: false };
}
