import type {
  AgentHomeStore,
  AgentRuntime,
  ArtifactStore,
  BackgroundJobExecution,
  BackgroundJobHandlers,
  JobPublisher,
  MessagingSurface,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import { messagingDeliverJob, runContinueJob } from "@rakazo/adapter-kit";
import type { PlatformModelAllowlist } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { claimRoutineRetry, runAsSystem, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { expireComputerControl } from "./computer-control.js";
import { scheduleComputerSleep, sleepComputerIfIdle } from "./computer-idle.js";
import { performComputerUpdate } from "./computer-update.js";
import type { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import type { NativeRoutineEventService } from "./native-connectors/events/service.js";
import {
  nativeTriggerScope,
  verifyRoutineRetryNativeSource,
} from "./native-connectors/events/store.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";

type Tenant = { spaceId: string; userId: string };

/** Resolve one durable owner before running the whole background operation in that scope. */
function asOwner<Key, P extends Key>(
  owner: (payload: Key) => Promise<Tenant | null | undefined>,
  handler: (payload: P, execution?: BackgroundJobExecution) => Promise<void>,
): (payload: P, execution?: BackgroundJobExecution) => Promise<void> {
  return async (payload, execution) => {
    const tenant = await runAsSystem("find the tenant a background job acts for", () =>
      owner(payload),
    );
    if (tenant) await runAsTenant(tenant, () => handler(payload, execution));
  };
}

const OWNER = { spaceId: true, userId: true } as const;

export function createBackgroundJobHandlers(deps: {
  executor: ReturnType<typeof createRunExecutor>;
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  workerId: string;
  runtime: AgentRuntime;
  secretStore: SecretStore;
  memoryProviders: MemoryProviderResolver;
  platformModelAllowlist?: PlatformModelAllowlist;
  deploymentModelKey?: string;
  deploymentModelConfigured?: boolean;
  messaging?: MessagingSurface;
  artifacts?: Pick<ArtifactStore, "get">;
  cloudAgent?: CloudAgentConnection | null;
  nativeEvents?: Pick<NativeRoutineEventService, "poll" | "notionSignal"> &
    Partial<Pick<NativeRoutineEventService, "slackSignal" | "slackLifecycle" | "discordSignal">>;
}): BackgroundJobHandlers {
  const run = ({ runId }: { runId: string }) =>
    deps.prisma.run.findUnique({ where: { id: runId }, select: OWNER });
  const routine = ({ routineId }: { routineId: string }) =>
    deps.prisma.routine.findUnique({ where: { id: routineId }, select: OWNER });
  const computer = ({ computerId }: { computerId: string }) =>
    deps.prisma.computer.findUnique({ where: { id: computerId }, select: OWNER });
  const thread = ({ threadId }: { threadId: string }) =>
    deps.prisma.thread.findUnique({ where: { id: threadId }, select: OWNER });
  const skill = ({ skillId }: { skillId: string }) =>
    deps.prisma.taughtSkill.findUnique({ where: { id: skillId }, select: OWNER });
  const cloudAgent = ({ agentId }: { agentId: string }) =>
    deps.prisma.cloudAgent.findUnique({ where: { id: agentId }, select: OWNER });
  const updatedComputer = async ({ updateId }: { updateId: string }) =>
    (
      await deps.prisma.computerUpdate.findUnique({
        where: { id: updateId },
        select: { computer: { select: OWNER } },
      })
    )?.computer ?? null;
  const native = ({ triggerId }: { triggerId: string }) =>
    nativeTriggerScope(deps.prisma, triggerId);
  const discord = async (payload: { triggerId: string; userId: string; spaceId: string }) => {
    const owner = await native(payload);
    return owner?.userId === payload.userId && owner.spaceId === payload.spaceId ? owner : null;
  };
  const deliverMessaging = async (runId?: string) =>
    runAsSystem("drain the messaging outbox across Spaces", async () => {
      if (!deps.messaging) return;
      await deliverMessagingOutbound(
        {
          prisma: deps.prisma,
          messaging: deps.messaging,
          events: deps.events,
          jobs: deps.jobs,
          artifacts: deps.artifacts,
        },
        { runId },
        {
          operationId: `messaging.deliver:${runId ?? "drain"}`,
          traceId: `messaging.deliver:${runId ?? "drain"}`,
          spaceId: "",
          userId: "",
          signal: new AbortController().signal,
        },
      );
    });

  return {
    "native.source.poll": asOwner(native, async (payload) => {
      if (!deps.nativeEvents) throw new Error("Native event processing is unavailable");
      await deps.nativeEvents.poll(payload, new AbortController().signal);
    }),
    "native.slack.lifecycle": async (payload) => {
      if (!deps.nativeEvents?.slackLifecycle)
        throw new Error("Native Slack event processing is unavailable");
      await runAsSystem("apply a verified Slack lifecycle receipt", () =>
        deps.nativeEvents!.slackLifecycle!(payload),
      );
    },
    "native.discord.signal": asOwner(discord, async (payload) => {
      if (!deps.nativeEvents?.discordSignal)
        throw new Error("Native Discord event processing is unavailable");
      await deps.nativeEvents.discordSignal(payload, new AbortController().signal);
    }),
    "native.slack.signal": asOwner(native, async (payload) => {
      if (!deps.nativeEvents?.slackSignal)
        throw new Error("Native Slack event processing is unavailable");
      await deps.nativeEvents.slackSignal(payload, new AbortController().signal);
    }),
    "native.notion.signal": asOwner(native, async (payload) => {
      if (!deps.nativeEvents) throw new Error("Native event processing is unavailable");
      await deps.nativeEvents.notionSignal(payload, new AbortController().signal);
    }),
    "run.continue": asOwner(run, async (payload, execution) => {
      if (payload.quotaWaitRevision !== undefined)
        await deps.executor.continueRun(
          payload.runId,
          deps.workerId,
          execution?.onRunStarted,
          payload.quotaWaitRevision,
        );
      else if (execution)
        await deps.executor.continueRun(payload.runId, deps.workerId, execution.onRunStarted);
      else await deps.executor.continueRun(payload.runId, deps.workerId);
      // Automatic messaging mirror: once the run's bot messages are durable,
      // copy them into the outbox. Never let mirror failures fail the run.
      if (deps.messaging) {
        await mirrorMessagingOutbound(
          {
            prisma: deps.prisma,
            messaging: deps.messaging,
            events: deps.events,
            jobs: deps.jobs,
            artifacts: deps.artifacts,
          },
          payload.runId,
        );
        await deps.jobs.enqueue(messagingDeliverJob()).catch(async (error) => {
          getLogger().error("messaging.deliver enqueue error", error);
          await deliverMessaging();
        });
      }
    }),
    "messaging.deliver": async (payload) => {
      await deliverMessaging(payload.runId);
    },
    "routine.wakeup": asOwner(routine, async (payload) => {
      await deps.executor.wakeRoutine(payload.routineId, payload.scheduledFor);
    }),
    "routine.retry": asOwner(run, async ({ runId }) => {
      const retry = await claimRoutineRetry(
        deps.prisma,
        runId,
        undefined,
        verifyRoutineRetryNativeSource,
      );
      // A committed queued Run is recovered by the ordinary Run reconciler.
      if (retry) await deps.jobs.enqueue(runContinueJob(retry.runId));
    }),
    "computer.update": asOwner(updatedComputer, async ({ updateId }) => {
      await performComputerUpdate(deps, updateId);
    }),
    "computer.sleep": asOwner(computer, async (payload) => {
      await sleepComputerIfIdle(deps, payload.computerId, payload.activeSince);
    }),
    "computer.control-expire": asOwner(computer, async (payload) => {
      if (await expireComputerControl(deps, payload.computerId, payload.leaseId)) {
        scheduleComputerSleep(deps.jobs, payload.computerId);
      }
    }),
    "skill.teaching-expire": asOwner(skill, async (payload) => {
      await expireTaughtSkillTeaching(deps, payload.skillId);
    }),
    "cloud_agent.poll": asOwner(cloudAgent, async (payload) => {
      await pollCloudAgent(
        {
          prisma: deps.prisma,
          jobs: deps.jobs,
          events: deps.events,
          cloudAgent: deps.cloudAgent,
        },
        payload,
      );
    }),
    "history.compact": asOwner(thread, async (payload) => {
      // Retrieval policies use stored context without paid message-count compaction.
      // Skip legacy backlog work after a policy change.
      if (deps.executor.contextStrategy && deps.executor.contextStrategy !== "current") return;
      await compactHistory(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          jobs: deps.jobs,
          memoryProviders: deps.memoryProviders,
          platformModelAllowlist: deps.platformModelAllowlist,
          deploymentModelKey: deps.deploymentModelKey,
          deploymentModelConfigured: deps.deploymentModelConfigured,
          ...(deps.executor.resolveModel ? { resolveModel: deps.executor.resolveModel } : {}),
        },
        payload.threadId,
      );
    }),
  };
}
