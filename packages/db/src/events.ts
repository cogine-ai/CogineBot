import { createHash } from "node:crypto";
import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { SharedPageUpdateRequest } from "@rakazo/contracts";
import {
  type BotSecretDestination,
  HISTORY_SOURCE_UNAVAILABLE,
  loginCardAnswer,
  type MessageBlock,
  MessageBlock as MessageBlockSchema,
  type ProductEvent,
  runQuotaWaitStateSchema,
  SHARED_PAGE_UPDATE_REQUEST_KIND,
  SharedPageUpdateRequestSchema,
  sharedPageUpdateApprovalTitle,
  type WebsiteLoginAnswer,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  blocksToAgentHistoryText,
  type ConnectorBatchActionNames,
  callIdFromClientNonce,
  canonicalApprovalSite,
  displayedBatchApprovalRuleNames,
  formatBotSecretHttpApprovalDetail,
  isApprovalAskBlock,
  isCallClientNonce,
  isConversationalRun,
  isSecretAskBlock,
  messageBypassesQuotaWait,
  messageBypassesTakeoverWait,
  messageReaction,
  messagingChannelId,
  readBotSecretHttpEffect,
  releasedTakeoverComputerBlocks,
  resolveAskChoice,
  SITE_SENDING_TOOLS,
  STEERING_CONTINUATION_PROMPT,
  sanitizeJsonValue,
  THREAD_HIDDEN_RUN_TRIGGERS,
} from "@rakazo/core";
import { urlSite } from "@rakazo/core/egress";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { getLogger } from "@rakazo/logging";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { ownedConnectionSelection, updateTaskConnectionSelection } from "./connection-selection.js";
import type { AnswerDelegatedApprovalInput } from "./delegated-approvals.js";
import {
  lockDelegatedApproval,
  ordinaryApprovalCard,
  PROTECTED_APPROVAL_TOOLS,
} from "./delegated-approvals.js";
import { lockRunHistoryGrant } from "./history-retrieval.js";
import type { RunLease } from "./messages.js";
import {
  assertRunCanWriteHistory,
  assertRunIsCancelled,
  createThreadMessageInTransaction,
  findPendingAsk,
  RunHistoryWriteError,
} from "./messages.js";
import {
  firstRoutineRetryExecutionFence,
  lockRoutineRetryExecution,
  lockRoutineRetryThread,
  planRoutineRetryInTransaction,
  type RoutineRetryExecutionInput,
  revokePendingRoutineRetries,
  routineRetrySteeringTargetIsCurrent,
  type VerifyRoutineRetryNativeSource,
} from "./routine-retry.js";
import { reserveRunProgressResetInTransaction } from "./run-progress.js";
import { clearEndedRunState, runLoginGenerationKind } from "./run-secrets.js";
import { isRunResponse, readRunTimingFields } from "./run-timing.js";
import { loadRunTurnCheckpointSecretEffectId } from "./run-turn-checkpoint.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

const EVENT_BATCH_SIZE = 200;
const PUSH_CATCH_UP_MS = 30_000;
const POLL_ONLY_CATCH_UP_MS = 400;

export interface AppendEventInput {
  spaceId: string;
  threadId: string;
  botId: string;
  type: ProductEvent["type"];
  payload: Record<string, unknown>;
  runId?: string;
  /** Terminal echo after the run is already cancelled. Every other event stays rejected. */
  allowCancelledRun?: boolean;
  /** The executing attempt's lease; a superseded attempt cannot write. Never serialized. */
  lease?: RunLease;
}

export interface ThreadEvents {
  answerDelegatedApproval(
    input: AnswerDelegatedApprovalInput,
  ): Promise<"accepted" | "already_answered" | "conflict">;
  answerRunInput(input: AnswerRunInput): Promise<boolean>;
  append(input: AppendEventInput): Promise<ProductEvent>;
  claimSteering(input: ClaimSteeringInput): Promise<ClaimedSteeringMessage[]>;
  clearThread(input: ClearThreadInput): Promise<ClearThreadResult>;
  finalizeComputerControlRelease(
    input: FinalizeComputerControlReleaseInput,
  ): Promise<FinalizeComputerControlReleaseResult | false>;
  finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult | false>;
  notify(
    threadId: string,
    seq: number,
    firstResponseRunId?: string,
    cancelledRunIds?: string[],
  ): Promise<void>;
  notifyDelegatedApprovalParent(runId: string): Promise<void>;
  pauseRunForInput(input: PauseRunForInput): Promise<boolean>;
  pauseRunForTakeover(input: PauseRunForTakeover): Promise<boolean>;
  sendUserMessage(input: SendUserMessageInput): Promise<SendUserMessageResult>;
  follow(
    threadId: string,
    cursor: number,
    signal?: AbortSignal,
    delegatedApprovalTarget?: { spaceId: string; botId: string },
  ): AsyncGenerator<ProductEvent>;
}

export interface ClearThreadInput {
  spaceId: string;
  threadId: string;
  /** Event author and the bot-scoped target for one-to-one chats. */
  botId: string;
  groupId?: string;
}

export interface ClearThreadResult {
  event: ProductEvent;
  cancelledRunIds: string[];
  historyCompactionGeneration: number;
}

export interface FinalizeComputerControlReleaseInput {
  spaceId: string;
  computerId: string;
  botId: string;
  runId: string | null;
  leaseId: string;
  holder: "bot" | "none";
  reason: "done" | "expired" | "released" | "skipped";
}

export interface FinalizeComputerControlReleaseResult {
  runId: string | null;
}

export interface ClaimSteeringInput {
  threadId: string;
  botId: string;
  runId: string;
  leaseOwner: string;
  leaseFence: number;
  seenIds: string[];
  /** Only a Pi turn that is already running may grant a fresh owner progress budget. */
  liveProgressReset?: true;
}

export interface ClaimedSteeringMessage {
  id: string;
  messageId: string;
  text: string;
  blocks: MessageBlock[];
  /** This claimed message was authored by the authenticated owner of this run. */
  ownerInput?: true;
  /** A new progress window was committed atomically with this live claim. */
  progressResetAt?: Date;
}

export interface FinalizeRunResult {
  continuationRunId: string | null;
  routineRetryAt?: Date;
  historyRevoked?: true;
}

interface FinalizeRunBase {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
}

export type FinalizeRunInput = FinalizeRunBase &
  (
    | {
        outcome: "completed";
        blocks: MessageBlock[];
        markUnread?: boolean;
        /** Cross-chat evidence requires the same live human source under the thread lock. */
        historyGrantSourceId?: string | null;
      }
    | { outcome: "failed"; error: string; partialText?: string; retryRoutine?: boolean }
  );

export interface PauseRunForInput {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  blocks: MessageBlock[];
  historyGrant?: { userId: string; sourceMessageId: string | null };
  /**
   * Unredacted choice actions for resume. Persisted only on the run checkpoint
   * (not in message blocks) so clients still see redacted labels.
   */
  offeredActions?: Array<{ id: string; label: string }>;
  /** Internal scripted progress; associated with the new card in this transaction. */
  scriptedState?: Prisma.InputJsonObject;
}

const CHOICE_ASK_CHECKPOINT_KIND = "choice_ask_v1";

function choiceAskCheckpoint(actions: Array<{ id: string; label: string }>): string {
  return JSON.stringify({ kind: CHOICE_ASK_CHECKPOINT_KIND, actions });
}

function resumeChoiceLabel(
  selected: { id: string; label: string },
  checkpoint: string | null | undefined,
): string {
  if (!checkpoint) return selected.label;
  try {
    const parsed = JSON.parse(checkpoint) as {
      kind?: string;
      actions?: Array<{ id?: unknown; label?: unknown }>;
    };
    if (parsed.kind !== CHOICE_ASK_CHECKPOINT_KIND || !Array.isArray(parsed.actions)) {
      return selected.label;
    }
    const offered = parsed.actions.find((action) => action.id === selected.id);
    return typeof offered?.label === "string" && offered.label.length > 0
      ? offered.label
      : selected.label;
  } catch {
    return selected.label;
  }
}

export interface PauseRunForTakeover {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  reason: string;
  /** Computer that should expose the pending takeover to the UI via controlRunId. */
  computerId: string;
  /** Internal scripted progress; associated with the takeover pause atomically. */
  scriptedState?: Prisma.InputJsonObject;
  /** Executor-authorized local effect; its receipt commits with the actual pause. */
  effect?: { id: string; expectedStatus: "intended" | "approved" };
}

export interface AnswerRunInput {
  spaceId: string;
  threadId: string;
  runId: string;
  messageId: string;
  answeredByUserId: string;
  answer: string;
  /** Internal model prompt with generated context separated from owner instructions. */
  taskPrompt?: string;
  /** Raw owner answer for choice matching when `answer` includes generated context. */
  choiceAnswer?: string;
  /** Server-owned composer message carrying the original answer and its provenance. */
  answerSourceMessageId?: string;
  /** Identifies a spoken answer as part of a live voice call. */
  clientNonce?: string;
  /** Only for a login card; `answer` carries its password. */
  username?: string;
  login?: WebsiteLoginAnswer;
}

export interface SendUserMessageInput {
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  blocks: MessageBlock[];
  prompt: string;
  trigger: "user" | "follow_up" | "webhook" | "messaging";
  clientNonce?: string;
  linkMessageToRun?: boolean;
  /** When false, persist the user message without starting a run (team-chat transcript). */
  createRun?: boolean;
  /** When true, start a new run even if the bot is already busy (team-chat delivery). */
  allowParallelRun?: boolean;
  /** Exact Routine prompts used to compose an inbound delivery. */
  routineSources?: {
    trigger: "webhook" | "github" | "messaging";
    messageProvider?: string;
    routines: Array<{ id: string; prompt: string }>;
  };
  /** Model every routine in an inbound delivery agreed on. */
  modelPin?: {
    /** Trusted Routine rows which produced this server-side capture. */
    routineIds: string[];
    modelProvider: string;
    modelId: string;
    modelCredentialId?: string | null;
    thinkingLevel: string | null;
  };
}

export interface SendUserMessageResult {
  messageId: string;
  seq: number;
  taskId: string | null;
  runId: string | null;
}

export interface RunSecretWriter {
  withPrepared?<T>(
    prisma: PrismaClient,
    input: AnswerRunInput,
    commit: (writer: RunSecretWriter) => Promise<T>,
  ): Promise<T>;
  store(input: {
    botId: string;
    credential?: BotSecretDestination;
    runId: string;
    userId: string;
    spaceId: string;
    plaintext: string;
    remember?: boolean;
    effectId?: string;
    expectedRevision?: string | null;
    tx: Prisma.TransactionClient;
  }): Promise<void>;
}

export type ApprovalBatchResolutionContext = {
  batchCard: boolean;
  loadInstalledKind(resourceId: string): Promise<string | undefined>;
};

type ResolveApprovalBatch = (
  effect: { kind: string; request: unknown },
  context: ApprovalBatchResolutionContext,
) => ConnectorBatchActionNames | undefined | Promise<ConnectorBatchActionNames | undefined>;

export function createThreadEvents(
  prisma: PrismaClient,
  realtime?: RealtimeFanout,
  options: {
    catchUpMs?: number;
    runSecretWriter?: RunSecretWriter;
    resolveApprovalBatch?: ResolveApprovalBatch;
  } = {},
): ThreadEvents {
  return {
    answerDelegatedApproval: (input) =>
      answerDelegatedApproval(prisma, input, realtime, options.resolveApprovalBatch),
    answerRunInput: (input) =>
      answerRunInput(
        prisma,
        input,
        realtime,
        options.runSecretWriter,
        options.resolveApprovalBatch,
      ),
    append: (input) => appendEvent(prisma, input, realtime),
    claimSteering: (input) => claimSteering(prisma, input),
    clearThread: (input) => clearThread(prisma, input, realtime),
    finalizeComputerControlRelease: (input) =>
      finalizeComputerControlRelease(prisma, input, realtime),
    finalizeRun: (input) => finalizeRun(prisma, input, realtime),
    notify: async (threadId, seq, firstResponseRunId, cancelledRunIds = []) => {
      await notifyCommittedEvent(prisma, realtime, threadId, seq, firstResponseRunId);
      await Promise.all(
        cancelledRunIds.map((runId) => notifyDelegatedApprovalParent(prisma, realtime, runId)),
      );
    },
    notifyDelegatedApprovalParent: (runId) =>
      notifyDelegatedApprovalParent(prisma, realtime, runId),
    pauseRunForInput: (input) => pauseRunForInput(prisma, input, realtime),
    pauseRunForTakeover: (input) => pauseRunForTakeover(prisma, input, realtime),
    sendUserMessage: (input) => sendUserMessage(prisma, input, realtime),
    follow: (threadId, cursor, signal, delegatedApprovalTarget) =>
      followThreadEvents(
        prisma,
        threadId,
        cursor,
        realtime,
        signal,
        options.catchUpMs,
        delegatedApprovalTarget,
      ),
  };
}

export async function clearThread(
  prisma: PrismaClient,
  input: ClearThreadInput,
  realtime?: RealtimeFanout,
): Promise<ClearThreadResult> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockRoutineRetryThread(tx, input.threadId);
    const thread = await tx.thread.update({
      where: {
        id: input.threadId,
        spaceId: input.spaceId,
        ...(input.groupId ? { groupId: input.groupId } : { botId: input.botId }),
      },
      data: { unread: false },
      select: { nextMessageSeq: true, historyCompactionGeneration: true },
    });
    const activeRuns = await tx.run.findMany({
      where: {
        spaceId: input.spaceId,
        threadId: input.threadId,
        ...(input.groupId ? {} : { botId: input.botId }),
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      select: { id: true, taskId: true },
    });
    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    await cancelRunsInTransaction(tx, activeRuns, now);
    await revokePendingRoutineRetries(tx, input);
    // Expire as tombstones so a still-open provider screen claim cannot reset fencing to 1.
    await expireComputerExecutionLeases(tx, { runId: { in: runIds } });
    await tx.computer.updateMany({
      where: { executionRunId: { in: runIds } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    await tx.message.deleteMany({ where: { threadId: input.threadId } });
    await tx.event.deleteMany({ where: { threadId: input.threadId } });
    // nextMessageSeq stays monotonic. Skip deleted history and clear its retry marker.
    await tx.thread.update({
      where: { id: input.threadId },
      data: {
        ...(thread.nextMessageSeq > 0
          ? { historyCompactedUpToSeq: thread.nextMessageSeq - 1 }
          : {}),
        historyCompactionSummary: null,
        historyCompactionGeneration: { increment: 1 },
        historyCompactionRetryAfterSeq: null,
      },
    });
    if (input.groupId) {
      await tx.chatGroup.update({ where: { id: input.groupId }, data: { updatedAt: now } });
    } else {
      await tx.bot.update({
        where: { id: input.botId, spaceId: input.spaceId },
        data: { updatedAt: now },
      });
    }
    const event = await appendEventInTransaction(tx, {
      ...input,
      type: "thread.cleared",
      payload: {},
    });
    return {
      event,
      cancelledRunIds: runIds,
      historyCompactionGeneration: thread.historyCompactionGeneration,
    };
  });
  await notifyRealtime(realtime, committed.event.threadId, committed.event.seq);
  await Promise.all(
    committed.cancelledRunIds.map((runId) =>
      notifyDelegatedApprovalParent(prisma, realtime, runId),
    ),
  );
  return {
    event: mapProductEvent(committed.event),
    cancelledRunIds: committed.cancelledRunIds,
    historyCompactionGeneration: committed.historyCompactionGeneration,
  };
}

async function lockInboundRoutines(tx: Prisma.TransactionClient, input: SendUserMessageInput) {
  const pin = input.modelPin;
  const source = input.trigger === "webhook" ? input.routineSources : undefined;
  const sourceRoutines = source?.routines ?? [];
  if (pin?.routineIds.length === 0) throw new IsolationError("Routine model selection changed.");
  const ids = [
    ...new Set([...(pin?.routineIds ?? []), ...sourceRoutines.map(({ id }) => id)]),
  ].sort();
  if (ids.length === 0) return undefined;
  const routines = await tx.$queryRaw<
    Array<{
      id: string;
      prompt: string;
      active: boolean;
      webhookEnabled: boolean;
      githubEnabled: boolean;
      messageProvider: string | null;
      authorizedInstructions: string | null;
      authorizedSites: string[];
      modelProvider: string | null;
      modelId: string | null;
      modelCredentialId: string | null;
      thinkingLevel: string | null;
    }>
  >(Prisma.sql`
    SELECT id, prompt, active, "webhookEnabled", "githubEnabled", "messageProvider",
      "authorizedInstructions", "authorizedSites",
      "modelProvider", "modelId", "modelCredentialId", "thinkingLevel"
    FROM routines
    WHERE id IN (${Prisma.join(ids)}) AND "userId"=${input.userId}
      AND "spaceId"=${input.spaceId} AND "botId"=${input.botId}
    ORDER BY id FOR UPDATE`);
  const byId = new Map(routines.map((routine) => [routine.id, routine]));
  if (
    pin?.routineIds.some((id) => {
      const routine = byId.get(id);
      return (
        !routine ||
        routine.modelProvider !== pin.modelProvider ||
        routine.modelId !== pin.modelId ||
        routine.modelCredentialId !== (pin.modelCredentialId ?? null) ||
        routine.thinkingLevel !== pin.thinkingLevel
      );
    })
  )
    throw new IsolationError("Routine model selection changed.");
  if (pin?.modelCredentialId) {
    const credential = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM user_model_credentials WHERE id=${pin.modelCredentialId}
        AND "userId"=${input.userId} AND provider=${pin.modelProvider} FOR KEY SHARE`);
    if (credential.length !== 1) throw new IsolationError("Model connection is unavailable.");
  }
  if (!source || sourceRoutines.length === 0) return undefined;
  const instructions: string[] = [];
  const sites = new Set<string>();
  for (const captured of sourceRoutines) {
    const routine = byId.get(captured.id);
    // Keep the delivered prompt, but never inherit authorization after a Routine edit or disable.
    if (!routine?.active || captured.prompt !== routine.prompt) continue;
    const enabled =
      source.trigger === "webhook"
        ? routine.webhookEnabled
        : source.trigger === "github"
          ? routine.githubEnabled
          : Boolean(source.messageProvider && routine.messageProvider === source.messageProvider);
    if (!enabled) continue;
    if (routine.authorizedInstructions) instructions.push(routine.authorizedInstructions);
    for (const site of routine.authorizedSites) sites.add(site);
  }
  return { routineInstructions: instructions.join("\n\n") || null, routineSites: [...sites] };
}

export async function sendUserMessage(
  prisma: PrismaClient,
  input: SendUserMessageInput,
  realtime?: RealtimeFanout,
): Promise<SendUserMessageResult> {
  const replay = async (): Promise<SendUserMessageResult | null> => {
    if (!input.clientNonce) return null;
    const message = await prisma.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: input.threadId,
          clientNonce: input.clientNonce,
        },
      },
      include: { sourceRuns: { orderBy: { createdAt: "asc" }, take: 1 } },
    });
    if (!message) return null;
    const created = message.sourceRuns[0];
    const run =
      created ??
      (message.runId ? await prisma.run.findUnique({ where: { id: message.runId } }) : null);
    return {
      messageId: message.id,
      seq: message.seq,
      taskId: created?.taskId ?? null,
      runId: run?.id ?? null,
    };
  };
  const existing = await replay();
  if (existing) return existing;

  const commit = () =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Keep the selected model and authorized Routine snapshot consistent with enqueue.
      const routineProvenance = await lockInboundRoutines(tx, input);
      // Message first: its thread-row lock serializes the whole send against clearThread, so a
      // concurrent clear either sees the committed run and cancels it, or strictly precedes this
      // transaction. Created in separate transactions, the run could land inside the clear's
      // window and later repopulate the cleared conversation, and a clear could strand the
      // message without its event.
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "user",
        authorUserId:
          input.trigger === "user" || input.trigger === "follow_up" ? input.userId : undefined,
        blocks: input.blocks,
        clientNonce: input.clientNonce,
      });
      const createRun = input.createRun !== false;
      // Include the creation intro. It has no tools, so it must not absorb the message, and a
      // second run would overlap it on a dedicated computer. Pending steering waits for the
      // continuation that starts when the intro finishes.
      const activeRuns =
        createRun && !input.allowParallelRun
          ? await tx.run.findMany({
              where: {
                threadId: input.threadId,
                botId: input.botId,
                status: { in: [...ACTIVE_RUN_STATUSES] },
              },
              select: { id: true, taskId: true, trigger: true, status: true },
            })
          : [];
      const holdingRuns = activeRuns.filter(
        (run) =>
          !messageBypassesQuotaWait(run) &&
          !messageBypassesTakeoverWait(run, input.trigger !== "webhook"),
      );
      // Steer a conversational run when there is one; a routine, webhook, or intro turn only holds the queue.
      const busy =
        holdingRuns.find(
          (run) => run.status !== "waiting_limit" && isConversationalRun(run.trigger),
        ) ??
        holdingRuns[0] ??
        null;
      let task = null;
      let run = null;
      if (createRun && !busy) {
        task = await tx.task.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            userId: input.userId,
            prompt: input.prompt,
            ...routineProvenance,
            status: "queued",
          },
        });
        run = await tx.run.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            taskId: task.id,
            userId: input.userId,
            status: "queued",
            trigger: input.trigger,
            clientNonce: input.clientNonce ? `send:${message.id}` : undefined,
            sourceMessageId: message.id,
            ...(input.modelPin
              ? {
                  modelProvider: input.modelPin.modelProvider,
                  modelId: input.modelPin.modelId,
                  modelCredentialId: input.modelPin.modelCredentialId ?? null,
                  thinkingLevel: input.modelPin.thinkingLevel,
                  modelPinned: true,
                }
              : {}),
          },
        });
        if (input.linkMessageToRun) {
          await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        }
      } else if (createRun && busy) {
        const held = busy.status === "waiting_limit" || !isConversationalRun(busy.trigger);
        await tx.steeringMessage.create({
          data: {
            messageId: message.id,
            botId: input.botId,
            userId: input.userId,
            // Keep messaging on the hold so the later run is mirrored back to that app.
            runId: held ? null : busy.id,
            ...(held && input.trigger === "messaging" ? { originTrigger: "messaging" } : {}),
            ...(input.modelPin
              ? {
                  modelProvider: input.modelPin.modelProvider,
                  modelId: input.modelPin.modelId,
                  modelCredentialId: input.modelPin.modelCredentialId ?? null,
                  thinkingLevel: input.modelPin.thinkingLevel,
                }
              : {}),
          },
        });
        if (busy.status === "waiting_takeover" || (busy.status === "queued" && !held)) {
          await tx.run.updateMany({
            where: { id: busy.id, status: busy.status },
            data: { wakeAt: new Date() },
          });
        }
        await tx.message.update({ where: { id: message.id }, data: { runId: busy.id } });
      }
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: run?.id ?? busy?.id,
        payload: {
          messageId: message.id,
          messageSeq: message.seq,
          role: "user",
          blocks: input.blocks,
          // Carries the call id on the live event so a spoken turn groups into the
          // call card immediately, instead of after a refetch reads the nonce.
          callId: callIdFromClientNonce(message.clientNonce),
        },
      });
      return { message, task, run, busy, event };
    });
  const committed = await commit().catch(async (error) => {
    const winner = await replay();
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  await notifyRealtime(realtime, input.threadId, committed.event.seq).catch((error) => {
    // The event is durable; subscribers recover it from their persisted cursor.
    getLogger().error("user message realtime notification", error);
  });
  return {
    messageId: committed.message.id,
    seq: committed.message.seq,
    taskId: committed.task?.id ?? null,
    runId: committed.run?.id ?? committed.busy?.id ?? null,
  };
}

export async function claimSteering(
  prisma: PrismaClient,
  input: ClaimSteeringInput,
): Promise<ClaimedSteeringMessage[]> {
  const claim = () =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
      const run = await tx.run.findFirst({
        where: {
          id: input.runId,
          threadId: input.threadId,
          botId: input.botId,
          status: "running",
          leaseOwner: input.leaseOwner,
          leaseFence: input.leaseFence,
        },
        select: {
          id: true,
          trigger: true,
          taskId: true,
          spaceId: true,
          userId: true,
          sourceMessageId: true,
          receivedOutsideMessage: true,
          sourceMessage: { select: { blocks: true } },
        },
      });
      if (!run || run.trigger === "created") return [];
      const channelId =
        run.trigger === "messaging"
          ? messagingChannelId(run.sourceMessage?.blocks as MessageBlock[] | undefined)
          : undefined;
      const directMessage = run.trigger === "messaging" && !channelId;
      // Pending rows from another chat stay for their own continuation.
      const pendingWhere = directMessage
        ? { runId: null, originTrigger: "messaging" }
        : channelId
          ? { runId: null }
          : { runId: null, originTrigger: null };
      const steering = await tx.steeringMessage.findMany({
        where: {
          botId: input.botId,
          id: input.seenIds.length ? { notIn: input.seenIds } : undefined,
          // A routine or webhook turn only takes steering addressed to it; pending user messages
          // wait for the conversational continuation that starts once it finishes.
          OR: isConversationalRun(run.trigger)
            ? [pendingWhere, { runId: input.runId }]
            : [{ runId: input.runId }],
          message: {
            threadId: input.threadId,
            // Private follow-ups remain unclaimed for the existing private continuation.
            ...(channelId
              ? { blocks: { array_contains: [{ kind: "channel_message", channelId }] } }
              : directMessage
                ? { NOT: { blocks: { array_contains: [{ kind: "channel_message" }] } } }
                : {}),
          },
        },
        include: {
          message: { select: { blocks: true, role: true, authorUserId: true, clientNonce: true } },
        },
        orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
      });
      if (steering.length === 0) return [];
      const claimed: ClaimedSteeringMessage[] = steering.map((item) => {
        const blocks = item.message.blocks as MessageBlock[];
        return {
          id: item.id,
          messageId: item.messageId,
          text: blocksToAgentHistoryText(blocks),
          blocks,
          ...(item.userId === run.userId &&
          item.message.role === "user" &&
          item.message.authorUserId === run.userId &&
          item.originTrigger === null &&
          !item.message.clientNonce?.startsWith("messaging:") &&
          !blocks.some((block) => block.kind === "channel_message")
            ? { ownerInput: true as const }
            : {}),
        };
      });
      const resetIndex = input.liveProgressReset
        ? steering.findLastIndex(
            (item, index) =>
              claimed[index]?.ownerInput &&
              (item.claimedAt === null || item.runId === null) &&
              item.messageId !== run.sourceMessageId &&
              !item.message.clientNonce?.startsWith("messaging:"),
          )
        : -1;
      const resetCandidate = claimed[resetIndex];
      if (resetCandidate) {
        // Fence the claim before task writes, in the same order as cancellation.
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM public.runs
          WHERE id = ${input.runId} AND status = 'running'
            AND "leaseOwner" = ${input.leaseOwner} AND "leaseFence" = ${input.leaseFence}
          FOR UPDATE
        `;
        if (!locked) return [];
      }
      const selections = steering.map((item) => item.connectionIds ?? []);
      await updateTaskConnectionSelection(tx, run, run.taskId, selections);
      const now = new Date();
      // A failed run can release a row without clearing its old claim timestamp.
      await tx.steeringMessage.updateMany({
        where: {
          id: { in: steering.map((item) => item.id) },
          OR: [{ claimedAt: null }, { runId: null }],
        },
        data: { runId: input.runId, claimedAt: now },
      });
      if (
        run.receivedOutsideMessage === false &&
        (run.trigger === "user" || run.trigger === "follow_up") &&
        claimed.some((item) => !item.ownerInput)
      ) {
        await tx.run.updateMany({
          where: {
            id: run.id,
            status: "running",
            leaseOwner: input.leaseOwner,
            leaseFence: input.leaseFence,
          },
          data: { receivedOutsideMessage: true },
        });
      }
      if (resetCandidate) {
        const reset = await reserveRunProgressResetInTransaction(tx, {
          ...input,
          spaceId: run.spaceId,
          steeringId: resetCandidate.id,
          now,
        });
        if (reset) resetCandidate.progressResetAt = reset.startedAt;
      }
      return claimed;
    });
  return withTransactionRetry(claim);
}

function matchesSharedPageApprovalCard(
  card: Extract<MessageBlock, { kind: "ask" }>,
  request: SharedPageUpdateRequest,
): boolean {
  return (
    card.reviewMode === "screen" &&
    card.text === sharedPageUpdateApprovalTitle(request.page.title) &&
    card.detail === request.detail &&
    card.actions?.length === 2 &&
    isApprovalAskBlock(card)
  );
}

async function commitAnswerRunInput(
  tx: Prisma.TransactionClient,
  input: AnswerRunInput,
  runSecretWriter?: RunSecretWriter,
  resolveApprovalBatch?: ResolveApprovalBatch,
  delegation?: { effectId: string; nonceDigest: string },
): Promise<{ threadId: string; seq: number; ordinaryApproval?: true } | null> {
  // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
  // concurrent clear cannot deadlock against this transaction.
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  const run = await tx.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    select: {
      botId: true,
      userId: true,
      origin: true,
      parentRunId: true,
      collaborationMessageId: true,
      collaborationSourceBotId: true,
      collaborationSourceSpaceId: true,
      checkpoint: true,
      quotaWait: true,
    },
  });
  if (!run) return null;
  const message = await tx.message.findFirst({
    where: {
      id: input.messageId,
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
    },
  });
  const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
  if (!message || !parsed.success) return null;
  const pendingAsk = parsed.data.find(
    (block) => block.kind === "ask" && block.status !== "answered",
  );
  if (pendingAsk?.kind !== "ask") return null;
  if (
    delegation &&
    (!ordinaryApprovalCard(pendingAsk) || pendingAsk.approvalEffectId !== delegation.effectId)
  )
    return null;
  const approvalAsk = isApprovalAskBlock(pendingAsk);
  if ((pendingAsk.approvalEffectId || pendingAsk.reviewMode) && !approvalAsk) return null;
  const secretAsk = isSecretAskBlock(pendingAsk);
  const choiceAsk = !approvalAsk && !secretAsk && Boolean(pendingAsk.actions?.length);
  const selectedChoice = choiceAsk
    ? resolveAskChoice(input.choiceAnswer ?? input.answer, pendingAsk.actions)
    : undefined;
  if (secretAsk && !runSecretWriter) return null;
  if (secretAsk && pendingAsk.credential && run.userId !== input.answeredByUserId) return null;
  const loginAsk = secretAsk && pendingAsk.credential?.auth.type === "login";
  const login = loginAsk ? loginCardAnswer(pendingAsk.loginFields, input) : undefined;
  if (loginAsk ? !login : input.login !== undefined || input.username !== undefined) return null;
  const pendingSecretEffectId = secretAsk
    ? await loadRunTurnCheckpointSecretEffectId(tx, { id: input.runId, spaceId: input.spaceId })
    : undefined;
  const namedLogin = Boolean(login && pendingAsk.loginFields);
  if (
    namedLogin &&
    (!pendingSecretEffectId ||
      pendingSecretEffectId !== pendingAsk.loginRequestEffectId ||
      pendingAsk.loginExpectedRevision === undefined)
  )
    return null;
  let approvalEffect: {
    id: string;
    kind: string;
    request: Prisma.JsonValue;
    idempotencyKey: string;
  } | null = null;
  let approvalUserId: string | null = null;
  let approvalSite: string | undefined;
  let approvalTools: string[] = [];

  if (approvalAsk) {
    if (!pendingAsk.actions?.some((action) => action.id === input.answer)) return null;
    if (run.origin === "bot_peer") {
      if (run.userId !== input.answeredByUserId) return null;
      const current = await findPendingAsk(tx, input);
      if (
        current?.messageId !== input.messageId ||
        current.pendingAsk.approvalEffectId !== pendingAsk.approvalEffectId
      )
        return null;
    }
    approvalEffect = await tx.externalEffect.findFirst({
      where: {
        id: pendingAsk.approvalEffectId,
        spaceId: input.spaceId,
        runId: input.runId,
        status: "intended",
      },
    });
    if (!approvalEffect || (delegation && PROTECTED_APPROVAL_TOOLS.includes(approvalEffect.kind)))
      return null;
    const request = approvalEffect.request;
    const sharedPageRequest =
      approvalEffect.kind === "save_page" &&
      request !== null &&
      typeof request === "object" &&
      Object.hasOwn(request, "requestKind");
    const authenticated = approvalEffect.kind === "secret_request";
    if (sharedPageRequest || authenticated || pendingAsk.reviewMode === "screen") {
      if (
        run.userId !== input.answeredByUserId ||
        (input.answer !== "allow" && input.answer !== "deny") ||
        isCallClientNonce(input.clientNonce) ||
        delegation
      )
        return null;
      if (authenticated) {
        if (input.answer === "allow") {
          const bound = readBotSecretHttpEffect(request);
          const detail = bound && formatBotSecretHttpApprovalDetail(bound.args);
          if (pendingAsk.reviewMode !== "screen" || !detail || pendingAsk.detail !== detail)
            return null;
        }
      } else if (pendingAsk.botSettings) {
        if (
          approvalEffect.kind !== "update_bot" ||
          !request ||
          typeof request !== "object" ||
          Array.isArray(request) ||
          request.kind !== "own-bot-settings" ||
          request.botId !== pendingAsk.botSettings.botId ||
          request.botId !== run.botId ||
          request.userId !== run.userId ||
          request.spaceId !== input.spaceId ||
          request.runId !== input.runId
        )
          return null;
      } else {
        const bound = SharedPageUpdateRequestSchema.safeParse(request);
        if (
          !sharedPageRequest ||
          !bound.success ||
          !matchesSharedPageApprovalCard(pendingAsk, bound.data)
        )
          return null;
      }
    }
    if (input.answer === "always") {
      if (run.userId !== input.answeredByUserId) return null;
      approvalSite = alwaysAllowedSite(approvalEffect);
      const batchCard = pendingAsk.approvalScope === "connector_batch";
      const batch = await resolveApprovalBatch?.(approvalEffect, {
        batchCard,
        loadInstalledKind: async (id) =>
          (
            await tx.capabilityInstall.findFirst({
              where: { id, spaceId: input.spaceId, userId: run.userId },
              select: { kind: true },
            })
          )?.kind,
      });
      if (batch || batchCard) {
        if (!batch || !batchCard) return null;
        const names = displayedBatchApprovalRuleNames(batch, pendingAsk.detail);
        if (!names) return null;
        approvalTools = names;
      } else if (!SITE_SENDING_TOOLS.has(approvalEffect.kind)) {
        approvalTools = [approvalEffect.kind];
      }
      if (approvalSite) {
        // An older card can still offer Always after the owner added a site rule.
        const requiredSites = await tx.actionApprovalRule.findMany({
          where: {
            spaceId: input.spaceId,
            createdByUserId: input.answeredByUserId,
            matchKind: "site",
            effect: "require_approval",
          },
          select: { matchValue: true },
        });
        if (requiredSites.some((rule) => canonicalApprovalSite(rule.matchValue) === approvalSite))
          return null;
      }
      approvalUserId = input.answeredByUserId;
    }
  }

  const quotaWait =
    run.quotaWait == null ? undefined : runQuotaWaitStateSchema.safeParse(run.quotaWait).data;
  const queued = await tx.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      status: "waiting_input",
    },
    data: {
      status: "queued",
      wakeAt: new Date(),
      ...(choiceAsk ? { checkpoint: null } : {}),
      ...(quotaWait && quotaWait.dispatchedFence !== null
        ? { quotaWait: { ...quotaWait, humanResume: "input" } }
        : {}),
    },
  });
  if (queued.count !== 1) return null;

  const recordedAnswer = secretAsk ? "" : (selectedChoice?.id ?? input.answer);
  const callId = callIdFromClientNonce(input.clientNonce);
  const recordsCallUtterance = Boolean(callId && !secretAsk);

  // Give spoken answers the same durable, call-scoped user utterance as other voice turns.
  // Secret asks stay out of message history; the call UI requires those answers on screen.
  if (recordsCallUtterance) {
    const blocks = [{ kind: "text" as const, text: input.answer }];
    const utterance = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "user",
      authorUserId: input.answeredByUserId,
      blocks,
      botId: run.botId,
      runId: input.runId,
      clientNonce: input.clientNonce,
    });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      type: "thread.message.created",
      runId: input.runId,
      payload: { messageId: utterance.id, messageSeq: utterance.seq, role: "user", blocks, callId },
    });
  }

  const ordinaryApproval =
    approvalEffect &&
    ordinaryApprovalCard(pendingAsk) &&
    !PROTECTED_APPROVAL_TOOLS.includes(approvalEffect.kind);
  if (approvalAsk) {
    const allowed = input.answer === "allow" || input.answer === "always";
    const requiresPeerApprovalRecheck =
      allowed &&
      ordinaryApproval &&
      Boolean(
        delegation ||
          (run.origin === "bot_peer" &&
            run.parentRunId &&
            run.collaborationMessageId &&
            run.collaborationSourceBotId &&
            run.collaborationSourceSpaceId === input.spaceId &&
            (await tx.run.findFirst({
              where: {
                id: run.parentRunId,
                parentRunId: null,
                spaceId: input.spaceId,
                userId: run.userId,
                botId: run.collaborationSourceBotId,
                thread: {
                  botId: run.collaborationSourceBotId,
                  groupId: null,
                  externalConversationId: null,
                },
              },
              select: { id: true },
            }))),
      );
    await tx.externalEffect.update({
      where: { id: approvalEffect!.id },
      data: {
        status: allowed ? "approved" : "denied",
        ...(delegation ? { delegatedApprovalNonce: delegation.nonceDigest } : {}),
        ...(requiresPeerApprovalRecheck ? { requiresPeerApprovalRecheck } : {}),
      },
    });
    if (!allowed && approvalEffect?.kind === "generate_secret") {
      const request = approvalEffect.request;
      if (
        request &&
        typeof request === "object" &&
        !Array.isArray(request) &&
        request.type === "login" &&
        typeof request.inputId === "string"
      ) {
        await tx.secret.deleteMany({
          where: {
            id: request.inputId,
            userId: run.userId,
            spaceId: input.spaceId,
            kind: runLoginGenerationKind(input.runId, approvalEffect.idempotencyKey),
          },
        });
      }
    }
    // Save the approved destination or individual actions in the same transaction.
    for (const matchValue of approvalSite ? [approvalSite] : approvalTools) {
      await tx.actionApprovalRule.upsert({
        where: {
          spaceId_createdByUserId_effect_matchKind_matchValue: {
            spaceId: input.spaceId,
            createdByUserId: approvalUserId!,
            effect: "always_allow",
            matchKind: approvalSite ? "site" : "tool",
            matchValue,
          },
        },
        create: {
          spaceId: input.spaceId,
          createdByUserId: approvalUserId!,
          effect: "always_allow",
          matchKind: approvalSite ? "site" : "tool",
          matchValue,
        },
        update: {},
      });
    }
  } else if (secretAsk) {
    await runSecretWriter!.store({
      botId: run.botId,
      credential: pendingAsk.credential,
      runId: input.runId,
      userId: run.userId,
      spaceId: input.spaceId,
      plaintext: login?.plaintext ?? input.answer,
      ...(namedLogin
        ? {
            remember: login!.remember,
            effectId: pendingSecretEffectId,
            expectedRevision: pendingAsk.loginExpectedRevision,
          }
        : {}),
      tx,
    });
    const approved = await tx.externalEffect.updateMany({
      where: {
        ...(pendingSecretEffectId === undefined ? {} : { id: pendingSecretEffectId }),
        runId: input.runId,
        spaceId: input.spaceId,
        kind: "request_secret",
        status: "intended",
      },
      data: {
        status: "approved",
        ...(pendingAsk.credential
          ? {
              result:
                login?.remember === false
                  ? { loginProvided: pendingAsk.credential, remember: false }
                  : { credentialSaved: pendingAsk.credential },
            }
          : {}),
      },
    });
    if (pendingSecretEffectId !== undefined && approved.count !== 1)
      throw new Error("Protected input request changed; retry");
  } else {
    let prompt = input.taskPrompt ?? input.answer;
    if (selectedChoice) {
      prompt = `Selected choice ${selectedChoice.id}: ${resumeChoiceLabel(selectedChoice, run.checkpoint)}`;
      if (input.choiceAnswer !== undefined && input.taskPrompt !== undefined)
        prompt += `\n\n${input.taskPrompt}`;
    }
    const task = await tx.task.updateMany({
      where: { runs: { some: { id: input.runId } } },
      data: { prompt },
    });
    if (task.count !== 1) throw new Error("Run task was not available to answer");
  }

  const blocks = parsed.data.map((block) =>
    block === pendingAsk
      ? {
          ...block,
          status: "answered" as const,
          answer: recordedAnswer,
        }
      : block,
  );
  await tx.message.update({ where: { id: message.id }, data: { blocks } });
  const updated = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: run.botId,
    type: "thread.message.updated",
    runId: input.runId,
    payload: {
      messageId: message.id,
      messageSeq: message.seq,
      role: "bot",
      blocks,
      ...(input.answerSourceMessageId
        ? { answerSourceMessageId: input.answerSourceMessageId }
        : {}),
    },
  });
  return {
    threadId: updated.threadId,
    seq: updated.seq,
    ...(ordinaryApproval ? { ordinaryApproval: true } : {}),
  };
}

export async function answerRunInput(
  prisma: PrismaClient,
  input: AnswerRunInput,
  realtime?: RealtimeFanout,
  runSecretWriter?: RunSecretWriter,
  resolveApprovalBatch?: ResolveApprovalBatch,
): Promise<boolean> {
  const commit = (writer = runSecretWriter) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) =>
      commitAnswerRunInput(tx, input, writer, resolveApprovalBatch),
    );
  const committed = runSecretWriter?.withPrepared
    ? await runSecretWriter.withPrepared(prisma, input, commit)
    : await commit();

  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  if (committed.ordinaryApproval)
    await notifyDelegatedApprovalParent(prisma, realtime, input.runId);
  return true;
}

export async function answerDelegatedApproval(
  prisma: PrismaClient,
  input: AnswerDelegatedApprovalInput,
  realtime?: RealtimeFanout,
  resolveApprovalBatch?: ResolveApprovalBatch,
): Promise<"accepted" | "already_answered" | "conflict"> {
  const result = await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const run = await lockDelegatedApproval(tx, input);
      if (!run) return "conflict" as const;
      const [message, effect] = await Promise.all([
        tx.message.findFirst({
          where: {
            id: input.messageId,
            threadId: run.threadId,
            botId: run.botId,
            runId: run.id,
            role: "bot",
          },
          select: { blocks: true },
        }),
        tx.externalEffect.findFirst({
          where: {
            id: input.effectId,
            spaceId: input.spaceId,
            runId: run.id,
            kind: { notIn: PROTECTED_APPROVAL_TOOLS },
          },
          select: { status: true },
        }),
      ]);
      const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
      const ask = parsed.data
        ?.filter(ordinaryApprovalCard)
        .find((block) => block.approvalEffectId === input.effectId);
      if (!ask || !effect) return "conflict" as const;
      if (ask.status === "answered")
        return ask.answer === input.action ? ("already_answered" as const) : ("conflict" as const);
      if (
        ask.status !== "pending" ||
        effect.status !== "intended" ||
        run.status !== "waiting_input"
      )
        return "conflict" as const;
      const nonceDigest = createHash("sha256").update(input.clientNonce).digest("hex");
      const priorNonce = await tx.externalEffect.findFirst({
        where: { id: { not: input.effectId }, runId: run.id, delegatedApprovalNonce: nonceDigest },
        select: { id: true },
      });
      if (priorNonce) return "conflict" as const;
      return (
        (await commitAnswerRunInput(
          tx,
          {
            spaceId: input.spaceId,
            threadId: run.threadId,
            runId: run.id,
            messageId: input.messageId,
            answeredByUserId: input.userId,
            answer: input.action,
          },
          undefined,
          resolveApprovalBatch,
          { effectId: input.effectId, nonceDigest },
        )) ?? "conflict"
      );
    }),
  );
  if (typeof result === "string") return result;
  await notifyRealtime(realtime, result.threadId, result.seq);
  await notifyDelegatedApprovalParent(prisma, realtime, input.runId);
  return "accepted";
}

/** The caller holds the thread row lock acquired while accepting the new user message. */
export async function retireWaitingQuestionInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string; runId: string; answer: string },
): Promise<boolean> {
  const answer = input.answer.trim();
  if (!answer) return false;
  const where = {
    id: input.runId,
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    status: "waiting_input",
  };
  const run = await tx.run.findFirst({ where, select: { taskId: true, userId: true } });
  if (!run) return false;
  const messages = await tx.message.findMany({
    where: { threadId: input.threadId, runId: input.runId, role: "bot" },
    select: { id: true, seq: true, blocks: true },
  });
  const questions = [];
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) return false;
    const pending = parsed.data.filter(
      (block) => block.kind === "ask" && block.status !== "answered",
    );
    // Never implicitly dismiss credentials or authorize an external effect, even on a mixed card.
    if (
      pending.some(
        (block) => block.kind === "ask" && (block.input === "secret" || block.approvalEffectId),
      )
    )
      return false;
    if (pending.length) {
      questions.push({
        id: message.id,
        seq: message.seq,
        blocks: parsed.data.map((block) =>
          pending.includes(block) ? { ...block, status: "answered" as const, answer } : block,
        ),
      });
    }
  }
  if (!questions.length) return false;
  const now = new Date();
  const retired = await tx.run.updateMany({
    where,
    data: {
      status: "cancelled",
      completedAt: now,
      checkpoint: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  if (retired.count !== 1) return false;
  await clearEndedRunState(tx, [{ id: input.runId, userId: run.userId, spaceId: input.spaceId }]);
  await tx.attempt.updateMany({
    where: { runId: input.runId, status: "waiting_input" },
    data: { status: "cancelled", finishedAt: now },
  });
  await tx.task.updateMany({
    where: { id: run.taskId, runs: { none: { status: { in: [...ACTIVE_RUN_STATUSES] } } } },
    data: { status: "cancelled" },
  });
  for (const question of questions) {
    await tx.message.update({ where: { id: question.id }, data: { blocks: question.blocks } });
    await appendEventInTransaction(tx, {
      ...input,
      type: "thread.message.updated",
      allowCancelledRun: true,
      payload: {
        messageId: question.id,
        messageSeq: question.seq,
        role: "bot",
        blocks: question.blocks,
      },
    });
  }
  await appendEventInTransaction(tx, { ...input, type: "run.cancelled", payload: {} });
  return true;
}

/** Read-only eligibility for an ordinary question immediately preceding composer text. */
export async function eligibleWaitingTextAnswer(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    runId: string;
    answeredByUserId: string;
    answer: string;
    taskPrompt?: string;
    choiceAnswer?: string;
    answerSourceMessageId?: string;
    beforeMessageSeq?: number;
  },
): Promise<string | null> {
  if (!input.answer.trim()) return null;
  const found = await findPendingAsk(tx, input);
  if (!found || isApprovalAskBlock(found.pendingAsk) || isSecretAskBlock(found.pendingAsk))
    return null;
  let beforeSeq = input.beforeMessageSeq;
  while (true) {
    const latest = await tx.message.findFirst({
      where: {
        threadId: input.threadId,
        ...(beforeSeq === undefined ? {} : { seq: { lt: beforeSeq } }),
      },
      orderBy: { seq: "desc" },
      select: { id: true, seq: true, role: true, blocks: true, replyToMessageId: true },
    });
    if (!latest) return null;
    if (!messageReaction({ ...latest, blocks: latest.blocks as MessageBlock[] }))
      return latest.id === found.messageId ? found.messageId : null;
    beforeSeq = latest.seq;
  }
}

/** Commit only ordinary answers that pass the read-only composer eligibility check. */
export async function answerWaitingRunWithTextInTransaction(
  tx: Prisma.TransactionClient,
  input: Parameters<typeof eligibleWaitingTextAnswer>[1],
): Promise<{ threadId: string; seq: number } | null> {
  const messageId = await eligibleWaitingTextAnswer(tx, input);
  return messageId
    ? commitAnswerRunInput(tx, { ...input, messageId, answer: input.answer.trim() })
    : null;
}

async function bindScriptedPause(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    spaceId: string;
    attemptId: string;
    leaseFence: number;
    scriptedState?: Prisma.InputJsonObject;
    blocks?: MessageBlock[];
  },
  pause: { kind: "input"; messageId: string } | { kind: "takeover"; eventSeq: number },
): Promise<void> {
  if (!input.scriptedState) return;
  const stored = input.scriptedState;
  if (
    stored.kind !== "scripted-state" ||
    (stored.version !== 2 && stored.version !== 4) ||
    stored.runId !== input.runId ||
    stored.attemptId !== input.attemptId ||
    stored.fence !== input.leaseFence
  )
    throw new Error("Scripted pause does not belong to this attempt");
  if (stored.version === 4) {
    const pending = stored.pendingEffect;
    const [card, otherAsk] = input.blocks?.filter((block) => block.kind === "ask") ?? [];
    if (
      pause.kind !== "input" ||
      !pending ||
      typeof pending !== "object" ||
      Array.isArray(pending) ||
      !("id" in pending) ||
      typeof pending.id !== "string" ||
      pending.kind !== "save_page" ||
      pending.requestKind !== SHARED_PAGE_UPDATE_REQUEST_KIND ||
      typeof pending.idempotencyKey !== "string" ||
      typeof pending.requestDigest !== "string" ||
      !card ||
      otherAsk ||
      card.status !== "pending" ||
      card.approvalEffectId !== pending.id
    ) {
      throw new Error("Scripted Page approval does not match this pause");
    }
    const effect = await tx.externalEffect.findFirst({
      where: {
        id: pending.id,
        runId: input.runId,
        spaceId: input.spaceId,
        kind: "save_page",
        idempotencyKey: pending.idempotencyKey,
        status: "intended",
      },
      select: { request: true },
    });
    const request = SharedPageUpdateRequestSchema.safeParse(effect?.request);
    if (
      !request.success ||
      !matchesSharedPageApprovalCard(card, request.data) ||
      createHash("sha256").update(stableJsonValue(effect?.request)).digest("hex") !==
        pending.requestDigest
    ) {
      throw new Error("Scripted Page approval does not match this pause");
    }
  }
  const updated = await tx.run.updateMany({
    where: {
      id: input.runId,
      leaseFence: input.leaseFence,
      status: pause.kind === "input" ? "waiting_input" : "waiting_takeover",
    },
    data: {
      scriptedState: {
        ...stored,
        pause: { ...pause, attemptId: input.attemptId, fence: input.leaseFence },
      },
    },
  });
  if (updated.count !== 1) throw new Error("Scripted pause lost its run fence");
}

export async function pauseRunForInput(
  prisma: PrismaClient,
  input: PauseRunForInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Thread row first, then run rows — the same order as clearThread and finalizeRun, so a
    // concurrent clear cannot deadlock against this transaction.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    if (
      input.historyGrant &&
      !(await lockRunHistoryGrant(tx, {
        ...input.historyGrant,
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      }))
    )
      return null;
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "waiting_input",
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(input.offeredActions?.length
          ? { checkpoint: choiceAskCheckpoint(input.offeredActions) }
          : {}),
      },
    });
    if (paused.count !== 1) return null;
    await expireComputerExecutionLeases(tx, { runId: input.runId });

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_input", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const message = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "bot",
      blocks: input.blocks,
      botId: input.botId,
      runId: input.runId,
    });
    await bindScriptedPause(tx, input, { kind: "input", messageId: message.id });
    const response = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.created",
      runId: input.runId,
      payload: {
        messageId: message.id,
        messageSeq: message.seq,
        role: "bot",
        blocks: input.blocks,
      },
    });
    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "run.waiting_input",
      runId: input.runId,
      payload: {},
    });
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return {
      threadId: waitingEvent.threadId,
      seq: waitingEvent.seq,
      firstResponseRunId: response.firstResponse ? input.runId : undefined,
    };
  });

  if (!committed) return false;
  await notifyCommittedEvent(
    prisma,
    realtime,
    committed.threadId,
    committed.seq,
    committed.firstResponseRunId,
  );
  if (input.blocks.some(ordinaryApprovalCard))
    await notifyDelegatedApprovalParent(prisma, realtime, input.runId);
  return true;
}

export async function pauseRunForTakeover(
  prisma: PrismaClient,
  input: PauseRunForTakeover,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: "waiting_takeover",
        leaseOwner: null,
        leaseExpiresAt: null,
        checkpoint: null,
      },
    });
    if (paused.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "waiting_takeover", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    const now = new Date();
    // Serialize with concurrent computer/takeover grants that mutate the same row.
    await tx.$queryRaw`
      SELECT id FROM computers WHERE id = ${input.computerId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
    const computer = await tx.computer.findFirst({
      where: { id: input.computerId, spaceId: input.spaceId },
      select: {
        controlHolder: true,
        controlBotId: true,
        controlLeaseId: true,
        controlLeaseExpiresAt: true,
      },
    });
    const activeUserLease = Boolean(
      computer?.controlHolder === "user" &&
        computer.controlLeaseId &&
        computer.controlLeaseExpiresAt &&
        computer.controlLeaseExpiresAt.getTime() > now.getTime(),
    );
    // Keep an active same-bot user lease so Skip / I'm done appear immediately.
    // Preserve another bot's active lease — computer/takeover owns revocation. Do not attach
    // this run to that lease: release validates controlBotId and could clear the binding without
    // resuming the waiting run. The requesting bot's takeover flow binds it after revocation.
    // Otherwise clear stale control, but bind controlRunId so takeoverRequested is true.
    const retainControl = Boolean(activeUserLease && computer?.controlBotId === input.botId);
    const preserveForeignLease = Boolean(
      activeUserLease && computer?.controlBotId && computer.controlBotId !== input.botId,
    );
    const marked = await tx.computer.updateMany({
      where: {
        id: input.computerId,
        spaceId: input.spaceId,
        state: "running",
        restorePending: false,
        stopRequestedAt: null,
      },
      data: retainControl
        ? { state: "running", controlRunId: input.runId }
        : preserveForeignLease
          ? { state: "running" }
          : {
              state: "running",
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: input.runId,
            },
    });
    if (marked.count !== 1) throw new Error("Computer was not available to mark for takeover");

    if (input.effect) {
      const completed = await tx.externalEffect.updateMany({
        where: {
          id: input.effect.id,
          spaceId: input.spaceId,
          runId: input.runId,
          kind: "request_takeover",
          status: { equals: input.effect.expectedStatus, in: ["intended", "approved"] },
        },
        data: { status: "completed", result: { takeover: "requested" } },
      });
      if (completed.count !== 1) throw new Error("Takeover approval effect was not available");
    }

    let firstResponse = false;
    if (input.scriptedState || input.effect) {
      // Durable cards commit with the receipt that makes their pause resumable.
      const blocks: MessageBlock[] = [{ kind: "computer", state: "Needs you", text: input.reason }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "bot",
        blocks,
        botId: input.botId,
        runId: input.runId,
        markUnread: true,
      });
      const response = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: input.runId,
        payload: { messageId: message.id, messageSeq: message.seq, role: "bot", blocks },
      });
      firstResponse = response.firstResponse;
    }

    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "computer.takeover.requested",
      runId: input.runId,
      payload: {
        reason: input.reason,
        takeoverRequested: true,
        retainedControl: retainControl,
      },
    });
    await bindScriptedPause(tx, input, { kind: "takeover", eventSeq: waitingEvent.seq });
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    return {
      threadId: waitingEvent.threadId,
      seq: waitingEvent.seq,
      firstResponseRunId: firstResponse ? input.runId : undefined,
    };
  });

  if (!committed) return false;
  await notifyCommittedEvent(
    prisma,
    realtime,
    committed.threadId,
    committed.seq,
    committed.firstResponseRunId,
  );
  return true;
}

export async function finalizeComputerControlRelease(
  prisma: PrismaClient,
  input: FinalizeComputerControlReleaseInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeComputerControlReleaseResult | false> {
  const committed = await withTransactionRetry(() =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const runScope = input.runId
        ? {
            id: input.runId,
            spaceId: input.spaceId,
            botId: input.botId,
            thread: takeoverThreadScope(input),
          }
        : null;
      const controlledRun = runScope
        ? await tx.run.findFirst({
            where: runScope,
            select: { threadId: true, status: true },
          })
        : null;
      const bot = await tx.bot.findFirst({
        where: { id: input.botId, spaceId: input.spaceId },
        select: { thread: { select: { id: true } } },
      });
      const threadId = controlledRun?.threadId ?? bot?.thread?.id;
      if (threadId) {
        // Match pause, clear and Stop: Thread, then Run, then Computer.
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
      }

      const lockedRun =
        controlledRun && input.runId
          ? await lockTakeoverRunInTransaction(tx, {
              ...input,
              runId: input.runId,
              threadId: controlledRun.threadId,
            })
          : null;

      const cleared = await tx.computer.updateMany({
        where: {
          id: input.computerId,
          spaceId: input.spaceId,
          controlBotId: input.botId,
          controlLeaseId: input.leaseId,
          controlRunId: input.runId,
          state: { notIn: ["suspending", "restoring", "quarantined", "needs_recovery"] },
          stopRequestedAt: null,
        },
        data: {
          controlHolder: input.holder,
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
          controlBotId: null,
          controlRunId: null,
        },
      });
      if (cleared.count !== 1) return null;

      const checkpoint =
        input.reason === "skipped" || input.reason === "expired" ? "takeover-skipped" : "takeover";
      const resumed =
        lockedRun && input.runId
          ? await tx.run.updateMany({
              where: {
                id: input.runId,
                spaceId: input.spaceId,
                botId: input.botId,
                status: "waiting_takeover",
              },
              data: {
                status: "queued",
                wakeAt: new Date(),
                checkpoint,
              },
            })
          : { count: 0 };
      // A steered continue may already hold the run as leased/running. Stamp the
      // checkpoint without stealing the lease so the worker can restore tools.
      const stamped =
        lockedRun && input.runId && resumed.count !== 1
          ? await tx.run.updateMany({
              where: {
                id: input.runId,
                spaceId: input.spaceId,
                botId: input.botId,
                status: { in: ["leased", "running"] },
              },
              data: { checkpoint },
            })
          : { count: 0 };
      const runId = resumed.count === 1 || stamped.count === 1 ? input.runId : null;

      if (!threadId) return { threadId: null, seq: null, runId };
      if (lockedRun && input.runId) {
        await settleReleasedTakeoverCardsInTransaction(tx, {
          spaceId: input.spaceId,
          threadId,
          botId: input.botId,
          runId: input.runId,
          reason: input.reason,
        });
      }
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId,
        botId: input.botId,
        runId: runId ?? undefined,
        type: "computer.takeover.released",
        payload: {
          holder: input.holder,
          leaseId: input.leaseId,
          reason: input.reason,
        },
      });
      return { threadId: event.threadId, seq: event.seq, runId };
    }),
  );

  if (!committed) return false;
  if (committed.threadId && committed.seq !== null) {
    await notifyRealtime(realtime, committed.threadId, committed.seq);
  }
  return { runId: committed.runId };
}

/** A Run may own a private thread, a group, or an external conversation. */
function takeoverThreadScope(input: { spaceId: string; botId: string }): Prisma.ThreadWhereInput {
  return {
    spaceId: input.spaceId,
    OR: [
      { botId: input.botId },
      { groupId: { not: null } },
      { externalConversationId: { not: null } },
    ],
  };
}

async function lockTakeoverRunInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string; runId: string },
) {
  await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} AND "spaceId" = ${input.spaceId}
    AND "botId" = ${input.botId} AND "threadId" = ${input.threadId} FOR UPDATE`;
  return tx.run.findFirst({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      thread: takeoverThreadScope(input),
    },
    select: { status: true },
  });
}

export interface BindWaitingTakeoverControlInput {
  spaceId: string;
  botId: string;
  computerId: string;
  controlLeaseId: string;
  controlRunId: string | null;
}

/** Bind the current execution fence and its grant event in one commit. */
export async function bindWaitingTakeoverControl(
  prisma: PrismaClient,
  input: BindWaitingTakeoverControlInput,
  notify?: (threadId: string, seq: number) => Promise<void>,
): Promise<boolean> {
  const committed = await withTransactionRetry(() =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const observedLease = await tx.computerExecutionLease.findUnique({
        where: { computerId_botId: { computerId: input.computerId, botId: input.botId } },
        select: { runId: true, fence: true },
      });
      if (!observedLease || observedLease.runId === input.controlRunId) return null;
      const candidate = await tx.run.findFirst({
        where: {
          id: observedLease.runId,
          spaceId: input.spaceId,
          botId: input.botId,
          thread: takeoverThreadScope(input),
        },
        select: { threadId: true, status: true },
      });
      if (candidate?.status !== "waiting_takeover") return null;
      const threadId = candidate.threadId;
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
      const run = await lockTakeoverRunInTransaction(tx, {
        ...input,
        threadId,
        runId: observedLease.runId,
      });
      if (run?.status !== "waiting_takeover") return null;
      const [currentLease] = await tx.$queryRaw<Array<{ runId: string; fence: number }>>`
      SELECT "runId", fence FROM computer_execution_leases
      WHERE "computerId" = ${input.computerId} AND "botId" = ${input.botId} FOR UPDATE`;
      if (
        !currentLease ||
        currentLease.runId !== observedLease.runId ||
        currentLease.fence !== observedLease.fence
      )
        return null;
      const bound = await tx.computer.updateMany({
        where: {
          id: input.computerId,
          spaceId: input.spaceId,
          controlLeaseId: input.controlLeaseId,
          controlBotId: input.botId,
          controlRunId: input.controlRunId,
        },
        data: { controlRunId: currentLease.runId },
      });
      if (bound.count !== 1) return null;
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId,
        botId: input.botId,
        runId: currentLease.runId,
        type: "computer.takeover.granted",
        payload: { leaseId: input.controlLeaseId, takeoverRequested: true },
      });
      return { threadId, seq: event.seq };
    }),
  );
  if (!committed) return false;
  await notify?.(committed.threadId, committed.seq);
  return true;
}

interface SettleReleasedTakeoverCardsInput {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  reason: unknown;
  lease?: RunLease;
}

/** Resume repairs a missed settlement without rewriting an already settled card. */
export async function settleReleasedTakeoverCards(
  prisma: PrismaClient,
  input: SettleReleasedTakeoverCardsInput,
  notify?: (threadId: string, seq: number) => Promise<void>,
): Promise<void> {
  const seq = await withTransactionRetry(() =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
      return settleReleasedTakeoverCardsInTransaction(tx, input);
    }),
  );
  if (seq !== null) await notify?.(input.threadId, seq);
}

async function settleReleasedTakeoverCardsInTransaction(
  tx: Prisma.TransactionClient,
  input: SettleReleasedTakeoverCardsInput,
): Promise<number | null> {
  const run = await lockTakeoverRunInTransaction(tx, input);
  if (!run || run.status === "cancelled") return null;
  const messages = await tx.message.findMany({
    where: { threadId: input.threadId, runId: input.runId, botId: input.botId, role: "bot" },
    select: { id: true, seq: true, blocks: true },
  });
  let lastSeq: number | null = null;
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    const blocks = releasedTakeoverComputerBlocks(parsed.data, input.reason);
    if (!blocks) continue;
    await tx.message.update({
      where: { id: message.id },
      data: { blocks: blocks as Prisma.InputJsonValue },
    });
    const updated = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.updated",
      runId: input.runId,
      lease: input.lease,
      payload: { messageId: message.id, messageSeq: message.seq, role: "bot", blocks },
    });
    lastSeq = updated.seq;
  }
  return lastSeq;
}

export async function appendEvent(
  prisma: PrismaClient,
  input: AppendEventInput,
  realtime?: RealtimeFanout,
): Promise<ProductEvent> {
  // Concurrent writers in one thread (group members, bot messages) can deadlock on the thread row.
  const event = await withTransactionRetry(() =>
    prisma.$transaction((tx: Prisma.TransactionClient) => appendEventInTransaction(tx, input)),
  );
  const productEvent = mapProductEvent(event);
  await notifyCommittedEvent(
    prisma,
    realtime,
    event.threadId,
    event.seq,
    event.firstResponse ? input.runId : undefined,
  );
  return productEvent;
}

/** Fence the first retry start after computer admission and before any attempt work. */
export async function beginRoutineRetryExecution(
  prisma: PrismaClient,
  input: RoutineRetryExecutionInput,
  verifyNativeSource?: VerifyRoutineRetryNativeSource,
): Promise<{ started: boolean; cancellationSeq?: number; continuationRunId?: string }> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const decision = await lockRoutineRetryExecution(tx, input, verifyNativeSource);
      if (!decision) return { started: false };
      const fence = firstRoutineRetryExecutionFence(input);
      if (decision.allowed) {
        const mark = await tx.run.updateMany({
          where: fence,
          data: { startedAt: input.startedAt },
        });
        return { started: mark.count === 1 };
      }
      const { child } = decision;
      const canContinueSteering = await routineRetrySteeringTargetIsCurrent(tx, child);
      // History writers lock Thread before Run. The prior thread advisory also
      // excludes a concurrent Stop or clear from admitting a replacement.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${child.threadId} FOR UPDATE`;
      const cancelled = await tx.run.updateMany({
        where: fence,
        data: {
          status: "cancelled",
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (cancelled.count !== 1) return { started: false };
      await clearEndedRunState(tx, [child]);
      await tx.task.update({
        where: {
          id: child.taskId,
          spaceId: child.spaceId,
          userId: child.userId,
          botId: child.botId,
          threadId: child.threadId,
        },
        data: { status: "cancelled" },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: child.spaceId,
        threadId: child.threadId,
        botId: child.botId,
        runId: child.id,
        type: "run.cancelled",
        payload: {},
      });
      const continuationRunId = canContinueSteering
        ? await createPendingSteeringRun(tx, child)
        : null;
      return {
        started: false,
        cancellationSeq: event.seq,
        ...(continuationRunId ? { continuationRunId } : {}),
      };
    }),
  );
}

export async function finalizeRun(
  prisma: PrismaClient,
  input: FinalizeRunInput,
  realtime?: RealtimeFanout,
): Promise<FinalizeRunResult | false> {
  const committed = await withTransactionRetry(() => finalizeRunOnce(prisma, input));
  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  await notifyDelegatedApprovalParent(prisma, realtime, input.runId);
  const timing = await readRunTimingFields(prisma, input.runId);
  if (committed.firstResponse) {
    getLogger().info("run.first_response", { "run.id": input.runId, ...timing });
  }
  getLogger().info("run.finished", {
    "run.id": input.runId,
    "run.outcome": input.outcome,
    ...timing,
    "space.id": input.spaceId,
    "thread.id": input.threadId,
    "bot.id": input.botId,
  });
  return {
    continuationRunId: committed.continuationRunId,
    ...(committed.routineRetryAt ? { routineRetryAt: committed.routineRetryAt } : {}),
    ...(committed.historyRevoked ? { historyRevoked: true } : {}),
  };
}

/** Stamps one turn-level wall-clock duration on the final tool block. */
export function completedRunBlocks(
  blocks: MessageBlock[],
  startedAt: Date | null,
  completedAt: Date,
): MessageBlock[] {
  if (!startedAt) return blocks;
  const durationMs = completedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) return blocks;
  const index = blocks.findLastIndex((block) => block.kind === "steps");
  if (index < 0) return blocks;
  return blocks.map((block, blockIndex) =>
    blockIndex === index && block.kind === "steps"
      ? { ...block, durationMs: Math.round(durationMs) }
      : block,
  );
}

async function finalizeRunOnce(
  prisma: PrismaClient,
  input: FinalizeRunInput,
): Promise<{
  threadId: string;
  seq: number;
  continuationRunId: string | null;
  firstResponse: boolean;
  routineRetryAt?: Date;
  historyRevoked: boolean;
} | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    let writableRun: Awaited<ReturnType<typeof assertRunCanWriteHistory>>;
    try {
      writableRun = await assertRunCanWriteHistory(tx, input.runId);
    } catch (error) {
      if (error instanceof RunHistoryWriteError) return null;
      throw error;
    }
    if (!writableRun) return null;
    const historyRevoked =
      input.outcome === "completed" &&
      input.historyGrantSourceId !== undefined &&
      !(await lockRunHistoryGrant(tx, {
        id: input.runId,
        spaceId: input.spaceId,
        userId: writableRun.userId,
        threadId: input.threadId,
        sourceMessageId: input.historyGrantSourceId,
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      }));
    const now = new Date();
    const terminal = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        taskId: input.taskId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (terminal.count !== 1) return null;
    await clearEndedRunState(tx, [
      { id: input.runId, userId: writableRun.userId, spaceId: input.spaceId },
    ]);

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        finishedAt: now,
      },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to finalize");

    const task = await tx.task.updateMany({
      where: {
        id: input.taskId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
      },
      data: { status: input.outcome },
    });
    if (task.count !== 1) throw new Error("Run task was not available to finalize");

    let completedMessageId: string | undefined;
    let firstResponse = false;
    const blocks: MessageBlock[] =
      input.outcome === "completed"
        ? historyRevoked
          ? [{ kind: "text", text: HISTORY_SOURCE_UNAVAILABLE }]
          : completedRunBlocks(input.blocks, writableRun.startedAt, now)
        : input.partialText?.trim()
          ? [
              {
                kind: "text",
                text: sanitizeJsonValue(input.partialText.replaceAll("\0", "\uFFFD")),
              },
            ]
          : [];
    if (blocks.length > 0) {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "bot",
        blocks,
        botId: input.botId,
        runId: input.runId,
        markUnread: input.outcome === "completed" && (historyRevoked || input.markUnread),
      });
      if (input.outcome === "completed") completedMessageId = message.id;
      const response = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: input.runId,
        payload: { messageId: message.id, messageSeq: message.seq, role: "bot", blocks },
      });
      firstResponse = response.firstResponse;
    }
    const lastEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: input.outcome === "completed" ? "run.completed" : "run.failed",
      runId: input.runId,
      payload:
        input.outcome === "completed"
          ? completedMessageId
            ? { messageId: completedMessageId }
            : {}
          : { error: input.error },
    });
    let routineRetryAt =
      input.outcome === "failed" && input.retryRoutine
        ? await planRoutineRetryInTransaction(tx, input.runId, now)
        : undefined;
    await tx.event.deleteMany({ where: { runId: input.runId, type: "thread.progress" } });
    if (input.outcome === "completed") {
      await tx.steeringMessage.deleteMany({
        where: { runId: input.runId, claimedAt: { not: null } },
      });
      await tx.steeringMessage.updateMany({
        where: { runId: input.runId },
        data: { runId: null },
      });
    } else {
      const { sourceMessage } = await tx.run.findUniqueOrThrow({
        where: { id: input.runId },
        select: { sourceMessage: { select: { seq: true } } },
      });
      // A continuation's source is the newest steering it was created for. Only newer
      // messages justify another run after failure, even if setup failed before claiming.
      await tx.steeringMessage.updateMany({
        where: {
          runId: input.runId,
          message: sourceMessage ? { seq: { gt: sourceMessage.seq } } : undefined,
        },
        data: { runId: null },
      });
    }
    const continuationRunId = await createPendingSteeringRun(tx, input);
    if (continuationRunId && routineRetryAt) {
      await tx.run.update({ where: { id: input.runId }, data: { routineRetryAt: null } });
      routineRetryAt = undefined;
    }
    await tx.bot.update({ where: { id: input.botId }, data: { updatedAt: now } });
    return {
      threadId: lastEvent.threadId,
      seq: lastEvent.seq,
      continuationRunId,
      firstResponse,
      routineRetryAt,
      historyRevoked,
    };
  });
}

/** Queue one follow-up when this bot still has unclaimed steering and no live run. */
export async function createPendingSteeringRun(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string },
): Promise<string | null> {
  const active = await tx.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
      NOT: { status: "waiting_limit", trigger: { in: [...THREAD_HIDDEN_RUN_TRIGGERS] } },
    },
    select: { id: true },
  });
  if (active) return null;
  const pending = await tx.steeringMessage.findMany({
    where: {
      botId: input.botId,
      runId: null,
      message: { threadId: input.threadId },
    },
    include: { message: { select: { id: true, blocks: true, seq: true } } },
    orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
  });
  if (pending.length === 0) return null;
  // One origin per continuation so a group channel and a direct chat are not answered together.
  const origin = steeringOrigin(pending[0]!);
  const batch = pending.filter((item) => steeringOrigin(item) === origin);
  const source = batch.at(-1)!;
  // A later text message does not replace the model selected for an admitted image.
  const newestAdmittedImage =
    origin === "app"
      ? batch.findLast(
          (item) =>
            item.modelProvider &&
            item.modelId &&
            (item.message.blocks as MessageBlock[]).some(
              (block) => block.kind === "image" && block.imageHandling === "confirm",
            ),
        )
      : undefined;
  const modelPin = continuationModelPin(newestAdmittedImage ? [newestAdmittedImage] : batch);
  const selections = batch.map((item) => item.connectionIds ?? []);
  const connectionIds = selections.some((ids) => ids.length)
    ? await ownedConnectionSelection(
        tx,
        {
          spaceId: input.spaceId,
          userId: batch[0]!.userId,
        },
        [],
        selections,
      )
    : [];
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: batch[0]!.userId,
      ...(connectionIds.length ? { connectionIds } : {}),
      prompt: STEERING_CONTINUATION_PROMPT,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId: batch[0]!.userId,
      status: "queued",
      trigger: origin === "app" ? "follow_up" : "messaging",
      sourceMessageId: source.message.id,
      ...(modelPin ?? {}),
    },
  });
  await tx.steeringMessage.updateMany({
    where: { id: { in: batch.map((item) => item.id) }, runId: null },
    data: { runId: run.id, claimedAt: null },
  });
  return run.id;
}

function continuationModelPin(
  batch: ReadonlyArray<{
    modelProvider?: string | null;
    modelId?: string | null;
    modelCredentialId?: string | null;
    thinkingLevel?: string | null;
  }>,
) {
  const first = batch[0];
  if (!first?.modelProvider || !first.modelId) return null;
  const agreed = batch.every(
    (item) =>
      item.modelProvider === first.modelProvider &&
      item.modelId === first.modelId &&
      (item.modelCredentialId ?? null) === (first.modelCredentialId ?? null) &&
      (item.thinkingLevel ?? null) === (first.thinkingLevel ?? null),
  );
  if (!agreed) return null;
  return {
    modelProvider: first.modelProvider,
    modelId: first.modelId,
    modelCredentialId: first.modelCredentialId ?? null,
    thinkingLevel: first.thinkingLevel ?? null,
    modelPinned: true,
  };
}

function steeringOrigin(item: {
  originTrigger: string | null;
  message: { blocks: unknown };
}): string {
  if (item.originTrigger !== "messaging") return "app";
  const channelId = messagingChannelId(item.message.blocks as MessageBlock[] | undefined);
  return channelId ? `channel:${channelId}` : "dm";
}

export async function appendEventInTransaction(
  tx: Prisma.TransactionClient,
  input: AppendEventInput,
  eventId?: string,
) {
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: { nextEventSeq: { increment: 1 } },
    select: { nextEventSeq: true },
  });
  // run.cancelled is appended after the run row already reads cancelled, so it
  // asserts the terminal status where every other event needs a writable run.
  let firstResponseAt: Date | null | undefined;
  if (input.type === "run.cancelled") {
    await assertRunIsCancelled(tx, input.runId);
  } else {
    const run = await assertRunCanWriteHistory(tx, input.runId, {
      allowCancelled: input.allowCancelledRun,
      lease: input.lease,
    });
    firstResponseAt = run?.firstResponseAt;
  }
  // Unpaired UTF-16 surrogates (e.g. a split emoji high half) are invalid JSON for Postgres.
  const payload = sanitizeJsonValue(input.payload);
  const event = await tx.event.create({
    data: {
      ...(eventId ? { id: eventId } : {}),
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      seq: thread.nextEventSeq - 1,
      type: input.type,
      payload: payload as Prisma.InputJsonValue,
      runId: input.runId,
    },
  });
  const firstResponse = Boolean(
    input.runId &&
      !firstResponseAt &&
      isRunResponse(input.type, input.payload) &&
      (
        await tx.run.updateMany({
          where: { id: input.runId, firstResponseAt: null },
          data: { firstResponseAt: event.createdAt },
        })
      ).count === 1,
  );
  return { ...event, firstResponse };
}

/** Timing metadata is returned by the transaction that recorded first output. */
async function notifyCommittedEvent(
  prisma: PrismaClient,
  realtime: RealtimeFanout | undefined,
  threadId: string,
  seq: number,
  firstResponseRunId?: string,
): Promise<void> {
  await notifyRealtime(realtime, threadId, seq);
  if (!firstResponseRunId) return;
  getLogger().info("run.first_response", {
    "run.id": firstResponseRunId,
    ...(await readRunTimingFields(prisma, firstResponseRunId)),
  });
}

export async function notifyRealtime(
  realtime: RealtimeFanout | undefined,
  threadId: string,
  cursor: number,
): Promise<void> {
  await realtime?.publish(threadTopic(threadId), JSON.stringify({ cursor })).catch(() => undefined);
}

const DELEGATED_APPROVAL_PULSE = "delegated-approval-changed";

async function notifyDelegatedApprovalParent(
  prisma: PrismaClient,
  realtime: RealtimeFanout | undefined,
  runId: string,
) {
  if (!realtime) return;
  try {
    const run = await prisma.run.findFirst({
      where: { id: runId, origin: "bot_peer", collaborationMessageId: { not: null } },
      select: { parentRunId: true, collaborationSourceBotId: true, userId: true, spaceId: true },
    });
    if (!run?.parentRunId || !run.collaborationSourceBotId) return;
    const parent = await prisma.run.findFirst({
      where: {
        id: run.parentRunId,
        parentRunId: null,
        spaceId: run.spaceId,
        userId: run.userId,
        botId: run.collaborationSourceBotId,
      },
      select: { threadId: true },
    });
    if (parent) await realtime.publish(threadTopic(parent.threadId), DELEGATED_APPROVAL_PULSE);
  } catch (error) {
    // The authenticated query is authoritative. The heartbeat repairs lost signals.
    getLogger().error("delegated approval notification", error);
  }
}

export async function eventsAfter(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  limit?: number,
) {
  return prisma.event.findMany({
    where: { threadId, seq: { gt: cursor } },
    orderBy: { seq: "asc" },
    ...(limit ? { take: limit } : {}),
    // Private tool-result bodies are accessible only through scoped read_history references.
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      seq: true,
      type: true,
      payload: true,
      runId: true,
      createdAt: true,
    },
  });
}

export async function* followThreadEvents(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  realtime?: RealtimeFanout,
  signal?: AbortSignal,
  catchUpMs = realtime ? PUSH_CATCH_UP_MS : POLL_ONLY_CATCH_UP_MS,
  delegatedApprovalTarget?: { spaceId: string; botId: string },
): AsyncGenerator<ProductEvent> {
  let seq = cursor;
  let approvalChanged = false;
  const latch = new ChangeLatch();
  const unsubscribe = realtime
    ? await realtime
        .subscribe(threadTopic(threadId), (payload) => {
          if (payload === DELEGATED_APPROVAL_PULSE) approvalChanged = true;
          latch.notify();
        })
        .catch(() => async () => {})
    : async () => {};
  try {
    while (!signal?.aborted) {
      const observedGeneration = latch.generation;
      if (approvalChanged && delegatedApprovalTarget) {
        approvalChanged = false;
        yield {
          ...delegatedApprovalTarget,
          threadId,
          id: DELEGATED_APPROVAL_PULSE,
          seq: 0,
          type: "heartbeat",
          createdAt: new Date().toISOString(),
          payload: {},
        };
      }
      let batchSize = 0;
      do {
        const events = await eventsAfter(prisma, threadId, seq, EVENT_BATCH_SIZE);
        batchSize = events.length;
        for (const event of events) {
          seq = event.seq;
          yield mapProductEvent(event);
        }
      } while (batchSize === EVENT_BATCH_SIZE && !signal?.aborted);
      if (signal?.aborted) break;
      await latch.waitForChange(observedGeneration, catchUpMs, signal);
    }
  } finally {
    await unsubscribe();
  }
}

function threadTopic(threadId: string): string {
  return `thread:${threadId}`;
}

function mapProductEvent(event: {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  seq: number;
  type: string;
  payload: unknown;
  runId: string | null;
  createdAt: Date;
}): ProductEvent {
  return {
    id: event.id,
    spaceId: event.spaceId,
    threadId: event.threadId,
    botId: event.botId,
    seq: event.seq,
    type: event.type as ProductEvent["type"],
    runId: event.runId ?? undefined,
    createdAt: event.createdAt.toISOString(),
    payload: event.payload as Record<string, unknown>,
  };
}

class ChangeLatch {
  generation = 0;
  private wake: (() => void) | undefined;

  notify(): void {
    this.generation += 1;
    this.wake?.();
  }

  async waitForChange(expected: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.generation !== expected || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wake = finish;
      signal?.addEventListener("abort", finish, { once: true });
      if (this.generation !== expected || signal?.aborted) finish();
    });
  }
}

function alwaysAllowedSite(effect: {
  kind: string;
  request: Prisma.JsonValue;
}): string | undefined {
  if (!SITE_SENDING_TOOLS.has(effect.kind)) return undefined;
  const request = effect.request as { url?: unknown } | null;
  return typeof request?.url === "string" ? urlSite(request.url) : undefined;
}
