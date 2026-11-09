import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  BackgroundJobPayloads,
  CloudAgentProvider,
  CloudAgentSnapshot,
} from "@rakazo/adapter-kit";
import {
  CloudAgentRequestRejected,
  CloudAgentRetryLater,
  CloudAgentUnavailable,
  runContinueJob,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentHttpsUrl } from "@rakazo/core";
import { appendEventInTransaction, type CloudAgent, Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cloudAgentsEnabled } from "./cloud-agent-factory.js";
import {
  type CloudAgentDeps,
  cloudAgentBlock,
  enqueueCloudAgent,
  hasObservedFollowupRun,
} from "./cloud-agent-service.js";
import { cloudAgentLaunchSchema, cloudAgentPromptSchema } from "./cloud-agent-tools.js";

/** Reconcile one persisted intent. A fenced lease serializes remote mutations. */
export async function pollCloudAgent(
  deps: CloudAgentDeps,
  payload: BackgroundJobPayloads["cloud_agent.poll"],
) {
  const connection = deps.cloudAgent;
  if (!connection || !cloudAgentsEnabled(connection, connection.spaceId ?? "")) return;
  const now = new Date();
  const token = randomUUID();
  const [agent] = await deps.prisma.cloudAgent.updateManyAndReturn({
    where: {
      id: payload.agentId,
      providerKey: connection.key,
      ...(connection.spaceId ? { spaceId: connection.spaceId } : {}),
      nextPollAt: { lte: now },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: { leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 90_000) },
  });
  if (!agent) return;
  const context: AdapterContext = {
    operationId: agent.id,
    traceId: agent.id,
    spaceId: agent.spaceId,
    userId: agent.userId,
    botId: agent.botId,
    signal: AbortSignal.timeout(60_000),
  };
  const provider = connection.provider;
  try {
    const [card, member, bot] = await Promise.all([
      deps.prisma.message.findFirst({
        where: { id: agent.messageId ?? "", threadId: agent.threadId },
        select: { id: true },
      }),
      deps.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: agent.spaceId, userId: agent.userId } },
        select: { id: true },
      }),
      deps.prisma.bot.findFirst({
        where: { id: agent.botId, spaceId: agent.spaceId, userId: agent.userId, archivedAt: null },
      }),
    ]);
    const abandoned = !card || !member || !bot;
    if ((abandoned || agent.cancelRequested) && !agent.remoteId && !agent.launchDispatched) {
      await finishPoll(
        deps,
        agent,
        { status: "cancelled", cancelRequested: false, launchRequest: {} },
        { abandoned },
      );
      return;
    }
    if (!agent.remoteId) {
      // Write dispatch intent before I/O; a crash replays the same idempotent create.
      const marked = await deps.prisma.cloudAgent.updateMany({
        where: fence(agent),
        data: { launchDispatched: true },
      });
      if (!marked.count) return;
      const request = cloudAgentLaunchSchema.parse(agent.launchRequest);
      try {
        const snapshot = await provider.launch({ ...request, idempotencyKey: agent.id }, context);
        await finishPoll(
          deps,
          agent,
          {
            ...snapshotData(snapshot, agent.latestRunId),
            remoteId: snapshot.id,
            launchRequest: {},
            cancelRequested: abandoned || agent.cancelRequested,
          },
          { abandoned, preserveStop: true },
        );
      } catch (error) {
        if (error instanceof CloudAgentRetryLater) {
          await retryPoll(deps, agent, error, {
            unaccepted: error.requestRejected && !agent.launchDispatched ? "launch" : undefined,
          });
        } else if (
          agent.launchDispatched &&
          error instanceof CloudAgentUnavailable &&
          error.reason === "not_found"
        ) {
          // A create-route rejection cannot settle an earlier response that went missing.
          await retryPoll(deps, agent, error);
        } else if (error instanceof CloudAgentRequestRejected && !agent.launchDispatched) {
          await finishPoll(
            deps,
            agent,
            { status: "failed", launchRequest: {} },
            { abandoned, preserveStop: true },
          );
        } else {
          throw error;
        }
      }
      return;
    }
    if (agent.followupDispatching) {
      // A list can establish a successor, but cannot tie it to this POST.
      // Only the original receipt can authorize adopting or cancelling that Run.
      const successor = await provider.observeRunSuccessor(
        agent.remoteId,
        agent.latestRunId,
        context,
      );
      const followup = agent.followup;
      const observed =
        successor &&
        successor !== agent.latestRunId &&
        followup &&
        typeof followup === "object" &&
        !Array.isArray(followup) &&
        !hasObservedFollowupRun(followup)
          ? { ...followup, runObserved: true }
          : undefined;
      await retryPoll(deps, agent, undefined, { observedFollowup: observed });
      return;
    }
    if (abandoned || agent.cancelRequested) {
      if (agent.followup) {
        await finishPoll(
          deps,
          agent,
          { status: "cancelled", followup: Prisma.DbNull, cancelRequested: false },
          { abandoned },
        );
        return;
      }
      const runId = agent.latestRunId;
      const snapshot = await provider.cancel(agent.remoteId, context, runId ?? undefined);
      if (snapshot.id !== agent.remoteId || (runId && snapshot.latestRunId !== runId)) {
        await retryPoll(deps, agent);
        return;
      }
      await finishPoll(
        deps,
        agent,
        {
          ...snapshotData(snapshot, agent.latestRunId),
          cancelRequested: snapshot.status === "running",
          followup: Prisma.DbNull,
          followupDispatching: false,
        },
        { abandoned },
      );
      return;
    }
    if (agent.followup) {
      let previousRunId: string | undefined;
      try {
        previousRunId = await readFollowupBaseline(provider, agent, context);
      } catch (error) {
        if (error instanceof CloudAgentUnavailable) throw error;
        await retryPoll(deps, agent, error, { unaccepted: "followup" });
        return;
      }
      if (!previousRunId) {
        await retryPoll(deps, agent, undefined, { unaccepted: "followup" });
        return;
      }
      const marked = await deps.prisma.cloudAgent.updateMany({
        where: fence(agent),
        data: { followupDispatching: true, latestRunId: previousRunId },
      });
      if (!marked.count) return;
      try {
        const snapshot = await provider.reply(
          agent.remoteId,
          cloudAgentPromptSchema.parse(agent.followup),
          context,
        );
        if (
          snapshot.id !== agent.remoteId ||
          !snapshot.latestRunId ||
          snapshot.latestRunId === previousRunId
        )
          throw new Error("Cloud agent follow-up did not identify a new run");
        await finishPoll(
          deps,
          agent,
          {
            ...snapshotData(snapshot, agent.latestRunId),
            followup: Prisma.DbNull,
            followupDispatching: false,
          },
          { preserveStop: true },
        );
      } catch (error) {
        if (error instanceof CloudAgentRetryLater) {
          await retryPoll(deps, agent, error, {
            unaccepted: error.requestRejected ? "followup" : undefined,
          });
          return;
        }
        if (!(error instanceof CloudAgentRequestRejected)) throw error;
        await finishPoll(
          deps,
          agent,
          { status: "failed", followup: Prisma.DbNull, followupDispatching: false },
          { preserveStop: true },
        );
      }
      return;
    }
    // A specific run cannot regress to stale agent-level metadata after a follow-up.
    const snapshot = await provider.get(agent.remoteId, context, agent.latestRunId ?? undefined);
    if (
      snapshot.id !== agent.remoteId ||
      (agent.latestRunId && snapshot.latestRunId !== agent.latestRunId)
    ) {
      await retryPoll(deps, agent);
      return;
    }
    await finishPoll(deps, agent, snapshotData(snapshot, agent.latestRunId));
  } catch (error) {
    if (error instanceof CloudAgentUnavailable) {
      // A vanished target ends observation. It does not prove a pending follow-up was cancelled.
      await finishPoll(
        deps,
        agent,
        {
          status: "failed",
          remoteId: null,
          launchRequest: {},
          followup: Prisma.DbNull,
          followupDispatching: false,
        },
        { preserveStop: true },
      );
    } else {
      await retryPoll(deps, agent, error);
    }
  } finally {
    // A concurrent user action can change version while remote I/O is in flight.
    // Release only our lease, preserving that action's pending intent and due date.
    await deps.prisma.cloudAgent.updateMany({
      where: { id: agent.id, leaseToken: token },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }
}

async function readFollowupBaseline(
  provider: CloudAgentProvider,
  agent: CloudAgent,
  context: AdapterContext,
) {
  if (!agent.remoteId) return undefined;
  // Record the newest visible terminal Run before dispatch as the observation anchor.
  const snapshot = await provider.get(agent.remoteId, context);
  if (snapshot.id !== agent.remoteId || !snapshot.latestRunId || snapshot.status === "running") {
    return undefined;
  }
  return snapshot.latestRunId;
}

function fence(agent: CloudAgent) {
  return {
    id: agent.id,
    version: agent.version,
    leaseToken: agent.leaseToken,
    leaseExpiresAt: { gt: new Date() },
  };
}

function snapshotData(
  snapshot: CloudAgentSnapshot,
  previousRunId: string | null,
): Prisma.CloudAgentUpdateManyMutationInput {
  const newRun = snapshot.latestRunId !== undefined && snapshot.latestRunId !== previousRunId;
  return {
    title: snapshot.title,
    status: snapshot.status,
    url: cloudAgentHttpsUrl(snapshot.url) ?? "",
    branch: snapshot.branch ?? (newRun ? null : undefined),
    prUrl: snapshot.prUrl ? (cloudAgentHttpsUrl(snapshot.prUrl) ?? "") : newRun ? null : undefined,
    latestRunId: snapshot.latestRunId,
  };
}

async function retryPoll(
  deps: CloudAgentDeps,
  agent: CloudAgent,
  error?: unknown,
  {
    unaccepted,
    observedFollowup,
  }: { unaccepted?: "launch" | "followup"; observedFollowup?: Prisma.InputJsonObject } = {},
) {
  const retry = error instanceof CloudAgentRetryLater ? error : undefined;
  if (retry?.reason === "credential")
    getLogger().warn("cloud agent credential rejected; check the provider connection");
  else if (error) getLogger().warn("cloud agent operation deferred to reconciliation");

  const now = Date.now();
  const backoff = Math.min(60_000, 5_000 * 2 ** Math.min(agent.errorCount, 4));
  const delay = retry?.retryAfterMs;
  const nextPollAt = new Date(
    Math.min(
      8.64e15,
      now + Math.max(backoff, delay !== undefined && Number.isFinite(delay) ? delay : 0),
    ),
  );
  const data = {
    nextPollAt,
    errorCount: { increment: 1 },
    leaseToken: null,
    leaseExpiresAt: null,
    ...(unaccepted === "launch" ? { launchDispatched: false } : {}),
    ...(unaccepted === "followup" ? { followupDispatching: false } : {}),
    ...(observedFollowup ? { followup: observedFollowup } : {}),
  };
  const saved = await deps.prisma.cloudAgent.updateMany({ where: fence(agent), data });
  if (saved.count) {
    await enqueueCloudAgent(deps, agent.id, nextPollAt);
    return;
  }

  // Stop can advance the version during I/O. Preserve its intent, but carry forward
  // the provider delay or the proof that this generation can be cancelled locally.
  const cancelPollAt = unaccepted ? new Date() : nextPollAt;
  const cancelled = await deps.prisma.cloudAgent.updateMany({
    where: {
      id: agent.id,
      leaseToken: agent.leaseToken,
      leaseExpiresAt: { gt: new Date() },
      generation: agent.generation,
      cancelRequested: true,
    },
    data: { ...data, nextPollAt: cancelPollAt },
  });
  if (cancelled.count) await enqueueCloudAgent(deps, agent.id, cancelPollAt);
}

async function finishPoll(
  deps: CloudAgentDeps,
  agent: CloudAgent,
  data: Prisma.CloudAgentUpdateManyMutationInput,
  { abandoned = false, preserveStop = false }: { abandoned?: boolean; preserveStop?: boolean } = {},
) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    // Same lock order as clearing chat: thread first, then message/run changes.
    const thread = await tx.thread.updateMany({
      where: {
        id: agent.threadId,
        spaceId: agent.spaceId,
        userId: agent.userId,
      },
      data: { nextEventSeq: { increment: 0 } },
    });
    const message = thread.count
      ? await tx.message.findFirst({
          where: {
            id: agent.messageId ?? "",
            threadId: agent.threadId,
          },
        })
      : null;
    const [member, bot] = await Promise.all([
      tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: agent.spaceId, userId: agent.userId } },
        select: { id: true },
      }),
      tx.bot.findFirst({
        where: { id: agent.botId, spaceId: agent.spaceId, userId: agent.userId, archivedAt: null },
        select: { id: true },
      }),
    ]);
    const detached = abandoned || !message || !member || !bot;
    const status = typeof data.status === "string" ? data.status : agent.status;
    const terminal = status !== "running";
    // Leaving this field untouched preserves a Stop recorded while a verified receipt
    // was in flight. A terminal observation closes the intent.
    const cancelRequested = terminal
      ? false
      : detached || data.cancelRequested === true
        ? true
        : undefined;
    const nextPollAt = terminal ? null : new Date(Date.now() + 5_000);
    const updated = await tx.cloudAgent.updateMany({
      where: preserveStop
        ? {
            id: agent.id,
            leaseToken: agent.leaseToken,
            leaseExpiresAt: { gt: new Date() },
            generation: agent.generation,
            OR: [{ version: agent.version }, { cancelRequested: true }],
          }
        : fence(agent),
      data: {
        ...data,
        cancelRequested,
        nextPollAt,
        errorCount: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        version: { increment: 1 },
      },
    });
    if (!updated.count) return null;
    const saved = await tx.cloudAgent.findUniqueOrThrow({ where: { id: agent.id } });
    let seq: number | undefined;
    let wakeRunId: string | undefined;
    if (message && !detached) {
      const nextBlock = cloudAgentBlock(saved);
      const blocks = (message.blocks as MessageBlock[]).map((block) =>
        block.kind === "cloud_agent" && block.agentId === agent.id ? nextBlock : block,
      );
      if (JSON.stringify(blocks) !== JSON.stringify(message.blocks)) {
        await tx.message.update({ where: { id: message.id }, data: { blocks } });
        const event = await appendEventInTransaction(tx, {
          spaceId: agent.spaceId,
          threadId: agent.threadId,
          botId: agent.botId,
          type: "thread.cloud_agent",
          payload: { messageId: message.id, ...nextBlock },
        });
        seq = event.seq;
      }
      if (terminal && saved.wakeGeneration < saved.generation) {
        // Provider text is untrusted. Wake with local identity and status only.
        const summary = `Cloud agent ${agent.id} is ${status}. Use cloud_agent_status to inspect its result.`;
        const task = await tx.task.create({
          data: {
            spaceId: agent.spaceId,
            botId: agent.botId,
            threadId: agent.threadId,
            userId: agent.userId,
            prompt: summary,
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: agent.spaceId,
            botId: agent.botId,
            threadId: agent.threadId,
            userId: agent.userId,
            taskId: task.id,
            status: "queued",
            trigger: "cloud_agent",
            clientNonce: `cloud-agent-wake-run:${agent.id}:${saved.generation}`,
          },
        });
        await tx.cloudAgent.update({
          where: { id: agent.id },
          data: { wakeGeneration: saved.generation },
        });
        wakeRunId = run.id;
      }
    }
    return { seq, wakeRunId, nextPollAt };
  });
  if (!committed) return;
  if (committed.seq !== undefined)
    await deps.events.notify(agent.threadId, committed.seq).catch(() => undefined);
  if (committed.wakeRunId) {
    // The existing run reconciler recovers a queued wake after an enqueue failure.
    await deps.jobs.enqueue(runContinueJob(committed.wakeRunId)).catch(() => {
      getLogger().warn("cloud agent wake deferred to reconciliation");
    });
  }
  if (committed.nextPollAt) await enqueueCloudAgent(deps, agent.id, committed.nextPollAt);
}
