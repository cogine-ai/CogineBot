import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  Api,
  AssistantMessage,
  Model,
  MutableModels,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import type {
  AgentRuntime,
  BackgroundJob,
  BackgroundJobHandlers,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import {
  ComposioEmulator,
  InMemoryRealtimeFanout,
  MessagingTeamChatEmulator,
  RunStarter,
  RunWorkerHost,
  ScriptedAgentRuntime,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { AppHandles } from "../../../apps/api/src/app.ts";
import { createJobReconciler } from "../../adapters/src/job-reconciler.js";
import { mirrorMessagingOutbound } from "../../adapters/src/messaging-delivery.js";
import { modelsForRequest, PiAgentRuntime } from "../../adapters/src/pi-runtime.js";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const wait = (assertion: () => Promise<void> | void) =>
  vi.waitFor(assertion, { timeout: 10_000, interval: 20 });

function loopGuardResponse(activeModel: Model<Api>, calls: ToolCall[]) {
  const message: AssistantMessage = {
    role: "assistant",
    content: calls,
    api: activeModel.api,
    provider: activeModel.provider,
    model: activeModel.id,
    usage: {
      input: 40,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 50,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [] } });
  for (const [contentIndex, toolCall] of calls.entries()) {
    stream.push({ type: "toolcall_start", contentIndex, partial: message });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
  }
  stream.push({ type: "done", reason: "toolUse", message });
  stream.end(message);
  return stream;
}

async function rpc<T>(
  handles: AppHandles,
  cookie: string,
  procedure: string,
  body: unknown = {},
): Promise<T> {
  const response = await handles.app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify({ json: body }),
  });
  const value = (await response.json()) as { json: T };
  expect(response.status).toBe(200);
  return value.json;
}

async function openApp(runtime = new ScriptedAgentRuntime()) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "run-dispatch-fixture-"));
  const { createApp } = await import("../../../apps/api/src/app.ts");
  const handles = await createApp({
    databaseUrl: process.env.DATABASE_URL!,
    realtimeDatabaseUrl: process.env.DATABASE_URL!,
    dataDir,
    sandboxProvider: "fake",
    agentRuntime: "scripted",
    runtime,
    wakeupDriver: "graphile",
    defaultProvider: "scripted",
    defaultModel: "scripted",
    signupsEnabled: "true",
    authUrl: origin,
    webOrigin: origin,
    composio: new ComposioEmulator(),
    encryptionKey: "synthetic-dispatch-fixture-encryption-key",
  });
  return {
    handles,
    runtime,
    close: async () => {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function seed(handles: AppHandles, label: string, computerMode?: "dedicated") {
  const signup = await handles.app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      name: "Fixture",
      email: `${randomUUID()}@example.test`,
      password: "password12",
    }),
  });
  expect(signup.status).toBeLessThan(400);
  const cookie = sessionCookieHeader(signup);
  const me = await rpc<{ userId: string; spaceId: string }>(handles, cookie, "me");
  const bot = await rpc<{ id: string }>(handles, cookie, "bots/create", {
    name: "Fixture",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
    ...(computerMode ? { computerMode } : {}),
  });
  await wait(async () =>
    expect(
      await handles.prisma.run.count({
        where: { botId: bot.id, status: { notIn: ["completed", "cancelled", "failed"] } },
      }),
    ).toBe(0),
  );
  const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
  const identity = { userId: me.userId, spaceId: me.spaceId, botId: bot.id, threadId: thread.id };
  const task = await handles.prisma.task.create({
    data: { ...identity, prompt: `Reply to ${label}.`, status: "queued" },
  });
  const run = await handles.prisma.run.create({
    data: { ...identity, taskId: task.id, trigger: "user", status: "queued" },
  });
  return { ...identity, cookie, run };
}

describe.skipIf(!enabled)("API direct run composition (PostgreSQL)", () => {
  it("loads the stored actor and Space when a wake carries conflicting metadata", async () => {
    const f = await openApp();
    try {
      const [a, b] = await Promise.all([seed(f.handles, "actor A"), seed(f.handles, "actor B")]);
      const original = f.runtime.run.bind(f.runtime);
      const captured = vi
        .spyOn(f.runtime, "run")
        .mockImplementation(async function* (request, context) {
          if (request.runId === b.run.id) {
            expect(context).toMatchObject({
              userId: b.userId,
              spaceId: b.spaceId,
              botId: b.botId,
              runId: b.run.id,
            });
          }
          yield* original(request, context);
        });
      await f.handles.jobs.enqueue({
        ...runContinueJob(b.run.id),
        payload: { runId: b.run.id, userId: a.userId, spaceId: a.spaceId, botId: a.botId },
      } as BackgroundJob);
      await wait(async () =>
        expect(
          (await f.handles.prisma.run.findUniqueOrThrow({ where: { id: b.run.id } })).status,
        ).toBe("completed"),
      );
      expect(captured.mock.calls.filter(([request]) => request.runId === b.run.id)).toHaveLength(1);
      expect(await f.handles.prisma.attempt.count({ where: { runId: a.run.id } })).toBe(0);
      expect(
        await f.handles.prisma.run.findUniqueOrThrow({ where: { id: b.run.id } }),
      ).toMatchObject({ userId: b.userId, spaceId: b.spaceId, botId: b.botId });
      expect(
        await f.handles.prisma.message.count({ where: { runId: b.run.id, threadId: a.threadId } }),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("starts a fifth unrelated chat while four runs are waiting on external work", async () => {
    const f = await openApp();
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const seeded = await Promise.all(
        Array.from({ length: 5 }, (_, index) => seed(f.handles, `parallel ${index}`)),
      );
      const waiting = new Set(seeded.slice(0, 4).map(({ run }) => run.id));
      const entered = new Set<string>();
      const original = f.runtime.run.bind(f.runtime);
      const runtime = vi
        .spyOn(f.runtime, "run")
        .mockImplementation(async function* (request, context) {
          entered.add(request.runId);
          if (waiting.has(request.runId)) await blocked;
          yield* original(request, context);
        });
      try {
        await Promise.all(
          seeded.slice(0, 4).map(({ run }) => f.handles.jobs.enqueue(runContinueJob(run.id))),
        );
        await wait(() => expect(entered.size).toBe(4));
        const fifth = seeded[4]!;
        await f.handles.jobs.enqueue(runContinueJob(fifth.run.id));
        await wait(async () => {
          const completed = await f.handles.prisma.run.findUniqueOrThrow({
            where: { id: fifth.run.id },
          });
          expect(completed.status).toBe("completed");
          expect(completed.firstResponseAt).toBeInstanceOf(Date);
        });
        expect(
          await f.handles.prisma.run.count({
            where: { id: { in: [...waiting] }, status: "running" },
          }),
        ).toBe(4);
        expect(entered.size).toBe(5);
      } finally {
        release();
        await wait(async () =>
          expect(
            await f.handles.prisma.run.count({
              where: { id: { in: seeded.map(({ run }) => run.id) }, status: "completed" },
            }),
          ).toBe(5),
        );
        runtime.mockRestore();
      }
    } finally {
      release();
      await f.close();
    }
  });

  it("does not claim future work through a stale direct delivery", async () => {
    const f = await openApp();
    try {
      const seeded = await seed(f.handles, "future run");
      const expected = await f.handles.prisma.run.update({
        where: { id: seeded.run.id },
        data: { wakeAt: new Date(Date.now() + 60_000) },
      });
      await f.handles.executor.continueRun(seeded.run.id, "stale-delivery");
      expect(
        await f.handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      ).toEqual(expected);
      expect(await f.handles.prisma.attempt.count({ where: { runId: seeded.run.id } })).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("awaits already-started parallel Pi message tools before settling a loop guard", async () => {
    const lateText = "The already-started progress message must reach the linked chat.";
    const fixtureKey = "synthetic-loop-guard-model-key";
    const model: Model<"openai-completions"> = {
      provider: "anthropic",
      id: "synthetic-loop-guard-settlement",
      name: "Synthetic loop guard settlement",
      api: "openai-completions",
      baseUrl: "https://models.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 1_024,
    };
    vi.stubEnv("PI_DEFAULT_PROVIDER", model.provider);
    vi.stubEnv("PI_DEFAULT_MODEL", model.id);
    vi.stubEnv("ANTHROPIC_API_KEY", fixtureKey);
    const models = modelsForRequest(
      { model: { provider: model.provider, id: model.id, apiKey: fixtureKey } },
      model.provider,
    ) as MutableModels;
    const previousProvider = models.getProvider(model.provider);
    const providerFailures: unknown[] = [];
    let modelRequests = 0;
    let reservations = 0;
    const stream = (activeModel: Model<Api>, context: TranscriptContext) => {
      try {
        modelRequests += 1;
        expect(activeModel.id).toBe(model.id);
        expect(modelRequests).toBeLessThanOrEqual(6);
        if (modelRequests > 1) {
          const previous = context.messages.findLast((message) => message.role === "toolResult");
          expect(previous).toMatchObject({ toolCallId: `repeated-message-${modelRequests - 1}` });
          expect(JSON.stringify(previous)).toContain("message is required");
        }
        const repeated: ToolCall = {
          type: "toolCall",
          id: `repeated-message-${modelRequests}`,
          name: "message_user",
          arguments: { message: "" },
        };
        return loopGuardResponse(activeModel, [
          repeated,
          ...(modelRequests === 6
            ? [
                {
                  type: "toolCall" as const,
                  id: "late-progress-message",
                  name: "message_user",
                  arguments: { message: lateText },
                },
              ]
            : []),
        ]);
      } catch (error) {
        providerFailures.push(error);
        throw error;
      }
    };
    models.setProvider(
      createProvider({
        id: model.provider,
        models: [model],
        auth: {
          apiKey: {
            name: "Synthetic loop guard fixture",
            resolve: async () => ({ auth: { apiKey: fixtureKey }, source: "fixture" }),
          },
        },
        api: { stream, streamSimple: stream },
      }),
    );

    let targetRunId: string | undefined;
    const executionScope = new AsyncLocalStorage<string>();
    const lateExecutionId = JSON.stringify(["pi-tool", "main", "late-progress-message"]);
    let enteredLatePublication = () => {};
    const latePublicationEntered = new Promise<void>((resolve) => {
      enteredLatePublication = resolve;
    });
    let releaseLatePublication = () => {};
    const latePublicationReleased = new Promise<void>((resolve) => {
      releaseLatePublication = resolve;
    });
    let observedAbort = () => {};
    const cleanupStarted = new Promise<void>((resolve) => {
      observedAbort = resolve;
    });
    let lateEffectId: string | undefined;
    const db = createDb(process.env.DATABASE_URL!, {
      applicationName: "synthetic-loop-guard-settlement",
    });
    const observedPrisma = db.prisma.$extends({
      query: {
        externalEffect: {
          async create({ args, query }) {
            const effect = await query(args);
            if (
              effect.runId === targetRunId &&
              effect.kind === "message_user" &&
              (effect.request as { message?: unknown }).message === lateText
            ) {
              lateEffectId = effect.id;
            }
            return effect;
          },
        },
        run: {
          async updateMany({ args, query }) {
            if (targetRunId && args.where?.id === targetRunId && args.data.status === "completed") {
              // The sibling is waiting before BEGIN, holding no database lock.
              await latePublicationEntered;
            }
            return query(args);
          },
        },
      },
    });
    let publicationWaiting = false;
    function gateTransactions<T extends object>(client: T): T {
      return new Proxy(client, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          // createApp adds its real secret-persistence extension. Preserve that
          // extension while carrying the same pre-BEGIN gate into its client.
          if (property === "$extends")
            return (...args: unknown[]) => gateTransactions(Reflect.apply(value, target, args));
          if (property !== "$transaction") return value;
          return (...args: unknown[]) => {
            const transact = () => Reflect.apply(value, target, args);
            if (executionScope.getStore() === lateExecutionId && !publicationWaiting) {
              // The real message_user has passed its abort check and is about to
              // publish. Delay before BEGIN, not while holding Run/Thread locks.
              publicationWaiting = true;
              enteredLatePublication();
              return latePublicationReleased.then(transact);
            }
            return transact();
          };
        },
      });
    }
    const controlledPrisma = gateTransactions(observedPrisma) as unknown as PrismaClient;
    const pi = new PiAgentRuntime({
      modelCallObserver: {
        beforeCall() {
          reservations += 1;
          return `loop-guard-reservation-${reservations}`;
        },
        afterCall() {},
      },
    });
    const scripted = new ScriptedAgentRuntime();
    const executions: Array<{ name: string; id: string; args: Record<string, unknown> }> = [];
    const runtime: AgentRuntime = {
      describe: () => pi.describe(),
      run(request, context) {
        if (request.runId !== targetRunId) return scripted.run(request, context);
        context?.signal?.addEventListener("abort", observedAbort, { once: true });
        const execute = request.executeTool;
        if (!execute) throw new Error("The real executor must provide executeTool");
        request.executeTool = (name, args, id, route, observer) => {
          executions.push({ name, id, args: structuredClone(args) });
          return executionScope.run(id, () => execute(name, args, id, route, observer));
        };
        return pi.run(request, context);
      },
      abort: (runId) => pi.abort(runId),
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "loop-guard-settlement-"));
    let handles: AppHandles | undefined;
    let executing: Promise<void> | undefined;
    let terminalVisible: Promise<unknown> | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        prisma: controlledPrisma,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        runtime,
        contextStrategy: "current",
        wakeupDriver: "memory",
        defaultProvider: model.provider,
        defaultModel: model.id,
        deploymentModelConfigured: true,
        signupsEnabled: "true",
        authUrl: origin,
        webOrigin: origin,
        composio: new ComposioEmulator(),
        encryptionKey: "synthetic-loop-guard-encryption-key",
      });
      const seeded = await seed(handles, "loop guard settlement");
      targetRunId = seeded.run.id;
      await handles.prisma.run.update({
        where: { id: targetRunId },
        data: { trigger: "messaging" },
      });
      await handles.prisma.messagingIdentity.create({
        data: {
          provider: "slack",
          address: randomUUID(),
          userId: seeded.userId,
          spaceId: seeded.spaceId,
          botId: seeded.botId,
          dmThreadId: "slack:synthetic-loop-guard",
        },
      });
      const observer = db.prisma;
      const jobs: JobPublisher = {
        enqueue: vi.fn(async (_job: BackgroundJob) => undefined),
        cancel: async () => undefined,
        close: async () => undefined,
      };
      const mirrorDeps = {
        prisma: observer,
        jobs,
        events: createThreadEvents(observer),
        messaging: new MessagingTeamChatEmulator({ provider: "slack" }),
      };
      executing = handles.executor.continueRun(targetRunId, "loop-guard-worker");
      void executing.catch(() => undefined);
      terminalVisible = wait(async () =>
        expect((await observer.run.findUniqueOrThrow({ where: { id: targetRunId } })).status).toBe(
          "completed",
        ),
      );
      void terminalVisible.catch(() => undefined);
      await wait(() => expect(publicationWaiting).toBe(true)).catch(async (error) => {
        const diagnostic = {
          modelRequests,
          reservations,
          providerFailures: providerFailures.map((failure) =>
            failure instanceof Error ? failure.message : String(failure),
          ),
          executions,
          run: await observer.run.findUnique({
            where: { id: targetRunId },
            select: { status: true, error: true, leaseOwner: true, leaseFence: true },
          }),
          effects: await observer.externalEffect.findMany({
            where: { runId: targetRunId, kind: "message_user" },
            select: { status: true, request: true, result: true },
          }),
        };
        throw new Error(
          `Loop guard publication gate was unreachable: ${JSON.stringify(diagnostic)}`,
          {
            cause: error,
          },
        );
      });
      expect(lateEffectId).toEqual(expect.any(String));
      expect(
        await observer.externalEffect.findUniqueOrThrow({ where: { id: lateEffectId } }),
      ).toMatchObject({
        runId: targetRunId,
        kind: "message_user",
        request: { message: lateText },
      });
      // Old code exposes terminal first; cleanup-first code instead exposes
      // abort while still running. Both paths release the same real tool below.
      await Promise.race([terminalVisible, cleanupStarted]);
      await mirrorMessagingOutbound(mirrorDeps, targetRunId);
      expect(
        await observer.message.count({
          where: { runId: targetRunId, blocks: { equals: [{ kind: "text", text: lateText }] } },
        }),
      ).toBe(0);
      releaseLatePublication();
      await executing;
      await terminalVisible;
      expect(providerFailures).toEqual([]);
      expect(modelRequests).toBe(6);
      expect(reservations).toBe(6);
      expect(executions).toHaveLength(7);
      expect(new Set(executions.map((execution) => execution.id)).size).toBe(7);
      expect(executions.filter(({ args }) => args.message === lateText)).toHaveLength(1);
      const final = await observer.run.findUniqueOrThrow({ where: { id: targetRunId } });
      const attempts = await observer.attempt.findMany({ where: { runId: targetRunId } });
      expect(final).toMatchObject({ status: "completed", leaseFence: 1, leaseOwner: null });
      expect(attempts).toEqual([
        expect.objectContaining({ status: "completed", fence: 1, finishedAt: expect.any(Date) }),
      ]);
      const late = await observer.message.findMany({
        where: { runId: targetRunId, blocks: { equals: [{ kind: "text", text: lateText }] } },
      });
      expect(late).toHaveLength(1);
      const stop = await observer.message.findMany({ where: { runId: targetRunId, role: "bot" } });
      expect(JSON.stringify(stop)).toContain(
        "times in a row without making progress, so I stopped early",
      );

      const recovery = createJobReconciler({ prisma: observer, jobs });
      await recovery.reconcileOnce();
      const enqueued = vi.mocked(jobs.enqueue).mock.calls.map(([job]) => job);
      for (const job of enqueued) {
        if (job.name === "messaging.deliver" && job.payload.runId === targetRunId)
          await mirrorMessagingOutbound(mirrorDeps, targetRunId);
      }
      // Recovery must see an unacknowledged Run until every admitted message
      // has finished. A premature terminal stamp permanently loses this row.
      expect(
        await observer.messagingOutbound.findMany({ where: { sourceMessageId: late[0]!.id } }),
      ).toEqual([
        expect.objectContaining({ body: lateText, idempotencyKey: `msg:${late[0]!.id}` }),
      ]);
      expect(enqueued.some((job) => job.name === "run.continue")).toBe(false);
      expect(await observer.attempt.findMany({ where: { runId: targetRunId } })).toEqual(attempts);
      expect(await observer.run.findUniqueOrThrow({ where: { id: targetRunId } })).toMatchObject({
        ...final,
        messagingMirroredAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
      expect(mirrorDeps.messaging.sent).toEqual([]);
    } finally {
      enteredLatePublication();
      releaseLatePublication();
      if (targetRunId) pi.abort(targetRunId);
      await executing?.catch(() => undefined);
      await terminalVisible?.catch(() => undefined);
      await handles?.stop();
      await db.prisma.$disconnect();
      await db.pool.end();
      if (previousProvider) models.setProvider(previousProvider);
      else models.deleteProvider(model.provider);
      vi.unstubAllEnvs();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "creates new chat behind a background takeover and preserves actual user control=%s",
    async (userHasScreen) => {
      const f = await openApp();
      let recovery: RunWorkerHost | undefined;
      try {
        const { run, cookie, ...identity } = await seed(
          f.handles,
          "background handoff",
          "dedicated",
        );
        const takeoverPrompt = "Take over so I can sign in.";
        const routine = await f.handles.prisma.routine.create({
          data: {
            ...identity,
            name: "Background handoff fixture",
            prompt: takeoverPrompt,
            crons: ["* * * * *"],
            active: false,
          },
        });
        await f.handles.prisma.task.update({
          where: { id: run.taskId },
          data: { prompt: takeoverPrompt },
        });
        await f.handles.prisma.run.update({
          where: { id: run.id },
          data: { trigger: "routine", routineId: routine.id },
        });
        await f.handles.jobs.enqueue(runContinueJob(run.id));
        await wait(async () =>
          expect(
            await f.handles.prisma.run.findUniqueOrThrow({ where: { id: run.id } }),
          ).toMatchObject({ status: "waiting_takeover", leaseOwner: null }),
        );
        await wait(async () =>
          expect(await f.handles.prisma.attempt.findMany({ where: { runId: run.id } })).toEqual([
            expect.objectContaining({
              status: "waiting_takeover",
              finishedAt: expect.any(Date),
            }),
          ]),
        );
        if (userHasScreen) {
          await rpc(f.handles, cookie, "computer/boot", { botId: identity.botId });
          await rpc(f.handles, cookie, "computer/takeover", { botId: identity.botId });
        }
        const oldState = async () => ({
          run: await f.handles.prisma.run.findUniqueOrThrow({ where: { id: run.id } }),
          attempts: await f.handles.prisma.attempt.findMany({
            where: { runId: run.id },
            orderBy: { id: "asc" },
          }),
          effects: await f.handles.prisma.externalEffect.findMany({
            where: { runId: run.id },
            orderBy: { id: "asc" },
          }),
          computer: await f.handles.prisma.computer.findFirstOrThrow({
            where: { bots: { some: { id: identity.botId } } },
          }),
          leases: await f.handles.prisma.computerExecutionLease.findMany({
            where: { botId: identity.botId },
            orderBy: { id: "asc" },
          }),
          cards: await f.handles.prisma.message.findMany({
            where: { runId: run.id },
            orderBy: { seq: "asc" },
          }),
        });
        const before = await oldState();
        const sent = await rpc<{ runId: string }>(f.handles, cookie, "threads/send", {
          botId: identity.botId,
          text: "Reply with the next available step.",
          clientNonce: `new-chat-${randomUUID()}`,
        });
        expect(sent.runId).not.toBe(run.id);
        expect(await f.handles.prisma.steeringMessage.count({ where: { runId: run.id } })).toBe(0);
        // The immediate dispatch may claim once before observing the occupied computer.
        await wait(async () => {
          const queued = await f.handles.prisma.run.findUniqueOrThrow({
            where: { id: sent.runId },
          });
          expect(queued).toMatchObject({ status: "queued", leaseOwner: null, startedAt: null });
          expect(queued.leaseFence).toBeGreaterThan(0);
        });
        const queuedBeforeRecovery = await f.handles.prisma.run.findUniqueOrThrow({
          where: { id: sent.runId },
        });
        expect(queuedBeforeRecovery).toMatchObject({
          trigger: "user",
          botId: identity.botId,
          threadId: identity.threadId,
          userId: identity.userId,
          spaceId: identity.spaceId,
          sourceMessageId: expect.any(String),
        });
        expect(
          await f.handles.prisma.steeringMessage.count({
            where: { messageId: queuedBeforeRecovery.sourceMessageId! },
          }),
        ).toBe(0);
        expect(
          await f.handles.prisma.task.findUniqueOrThrow({
            where: { id: queuedBeforeRecovery.taskId },
          }),
        ).toMatchObject({ prompt: "Reply with the next available step." });
        expect(await f.handles.prisma.attempt.count({ where: { runId: sent.runId } })).toBe(0);
        const fanout = new InMemoryRealtimeFanout();
        recovery = new RunWorkerHost(f.handles.prisma, fanout, new RunStarter(fanout), {
          intervalMs: 25,
        });
        // A later unrelated chat proves that recovery scanned the blocked chat's lane.
        const sentinel = userHasScreen ? await seed(f.handles, "recovery sentinel") : undefined;
        await recovery.start({
          "run.continue": async ({ runId }, execution) =>
            f.handles.executor.continueRun(
              runId,
              "background-handoff-recovery",
              execution?.onRunStarted,
            ),
        } as BackgroundJobHandlers);
        if (userHasScreen) {
          await wait(async () =>
            expect(
              (await f.handles.prisma.run.findUniqueOrThrow({ where: { id: sentinel!.run.id } }))
                .status,
            ).toBe("completed"),
          );
          expect(await oldState()).toEqual(before);
          expect(
            await f.handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } }),
          ).toEqual(queuedBeforeRecovery);
          expect(await f.handles.prisma.attempt.count({ where: { runId: sent.runId } })).toBe(0);
        } else {
          await wait(async () =>
            expect(
              (await f.handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } })).status,
            ).toBe("completed"),
          );
          expect(
            await f.handles.prisma.run.findUniqueOrThrow({ where: { id: run.id } }),
          ).toMatchObject({ status: "cancelled", leaseFence: before.run.leaseFence });
          expect(await f.handles.prisma.attempt.count({ where: { runId: run.id } })).toBe(1);
        }
      } finally {
        await recovery?.stop();
        await f.close();
      }
    },
  );

  it("makes repeated stop calls wait for active work, then resumes the same run", async () => {
    const f = await openApp();
    const observer = createDb(process.env.DATABASE_URL!);
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = () => {};
    const sawAbort = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let restore = () => {};
    try {
      const seeded = await seed(f.handles, "shutdown handback");
      const original = f.runtime.run.bind(f.runtime);
      const run = vi.spyOn(f.runtime, "run").mockImplementation(async function* (request, context) {
        if (request.runId !== seeded.run.id) {
          yield* original(request, context);
          return;
        }
        context?.signal?.addEventListener("abort", aborted, { once: true });
        started();
        await released;
      });
      restore = () => run.mockRestore();
      await f.handles.jobs.enqueue(runContinueJob(seeded.run.id));
      await entered;
      let firstDone = false;
      let secondDone = false;
      const first = f.handles.stop().then(() => {
        firstDone = true;
      });
      const second = f.handles.stop().then(() => {
        secondDone = true;
      });
      await sawAbort;
      expect(firstDone).toBe(false);
      expect(secondDone).toBe(false);
      release();
      await Promise.all([first, second]);
      expect(
        await observer.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      ).toMatchObject({ status: "queued", leaseOwner: null, leaseExpiresAt: null, error: null });
      expect(await observer.prisma.attempt.findMany({ where: { runId: seeded.run.id } })).toEqual([
        expect.objectContaining({ status: "interrupted" }),
      ]);
      expect(
        await observer.prisma.event.count({
          where: { runId: seeded.run.id, type: { in: ["run.failed", "run.cancelled"] } },
        }),
      ).toBe(0);
      restore();
      const recovered = await openApp();
      try {
        await recovered.handles.jobs.enqueue(runContinueJob(seeded.run.id));
        await wait(async () =>
          expect(
            (await observer.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).status,
          ).toBe("completed"),
        );
        expect(
          await observer.prisma.attempt.findMany({
            where: { runId: seeded.run.id },
            orderBy: { fence: "asc" },
          }),
        ).toEqual([
          expect.objectContaining({ status: "interrupted", fence: 1 }),
          expect.objectContaining({ status: "completed", fence: 2 }),
        ]);
      } finally {
        await recovered.close();
      }
    } finally {
      release();
      restore();
      await f.close();
      await observer.prisma.$disconnect();
      await observer.pool.end();
    }
  });
});
