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
import { runContinueJob, SandboxUnavailableError } from "@rakazo/adapter-kit";
import {
  ComposioEmulator,
  FakeSandboxProvider,
  InMemoryRealtimeFanout,
  LocalAgentHomeStore,
  MessagingTeamChatEmulator,
  migrateJobQueue,
  RunJobPublisher,
  RunStarter,
  RunWorkerHost,
  ScriptedAgentRuntime,
} from "@rakazo/adapters";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadEvents } from "@rakazo/db";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AppHandles } from "../../../apps/api/src/app.ts";
import { formatCurrentTimeInstruction } from "../../adapters/src/current-time.js";
import { createJobReconciler } from "../../adapters/src/job-reconciler.js";
import { mirrorMessagingOutbound } from "../../adapters/src/messaging-delivery.js";
import { modelsForRequest, PiAgentRuntime } from "../../adapters/src/pi-runtime.js";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const wait = (assertion: () => Promise<void> | void) =>
  vi.waitFor(assertion, { timeout: 10_000, interval: 20 });

function piResponse(activeModel: Model<Api>, content: AssistantMessage["content"]) {
  const hasCalls = content.some((part) => part.type === "toolCall");
  const message: AssistantMessage = {
    role: "assistant",
    content,
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
    stopReason: hasCalls ? "toolUse" : "stop",
    timestamp: 1,
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [] } });
  for (const [contentIndex, toolCall] of content.entries()) {
    if (toolCall.type !== "toolCall") continue;
    stream.push({ type: "toolcall_start", contentIndex, partial: message });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
  }
  stream.push({ type: "done", reason: hasCalls ? "toolUse" : "stop", message });
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

async function openApp(
  runtime: AgentRuntime = new ScriptedAgentRuntime(),
  overrides: {
    sandbox?: FakeSandboxProvider;
    agentRuntime?: "pi";
    defaultProvider?: string;
    defaultModel?: string;
    deploymentModelConfigured?: boolean;
    contextStrategy?: "current";
    wakeupDriver?: "memory";
    realtime?: InMemoryRealtimeFanout;
  } = {},
) {
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
    ...overrides,
  });
  return {
    handles,
    runtime,
    dataDir,
    close: async () => {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function seed(
  handles: AppHandles,
  label: string,
  computerMode?: "dedicated",
  afterIntro?: () => Promise<void>,
) {
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
  await afterIntro?.();
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
  beforeAll(async () => {
    await migrateJobQueue(process.env.DATABASE_URL!);
  });

  it("starts new work behind a protected wait before the old executor finally returns", async () => {
    const realtime = new InMemoryRealtimeFanout();
    const runtime = new ScriptedAgentRuntime();
    const originalRun = runtime.run.bind(runtime);
    const originalPublish = realtime.publish.bind(realtime);
    let oldRunId: string | undefined;
    let oldExecution: Promise<unknown> | undefined;
    let heldPause = false;
    let newRunId: string | undefined;
    let releasePause!: () => void;
    let releaseNew!: () => void;
    const paused = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const newWork = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    const f = await openApp(runtime, { realtime });
    const runSpy = vi.spyOn(runtime, "run").mockImplementation(async function* (request, context) {
      if (
        oldRunId &&
        request.runId !== oldRunId &&
        request.prompt.includes("Start a separate report")
      ) {
        newRunId = request.runId;
        await newWork;
      }
      yield* originalRun(request, context);
    });
    const publish = vi.spyOn(realtime, "publish").mockImplementation(async (topic, payload) => {
      await originalPublish(topic, payload);
      if (oldRunId && !heldPause) {
        const run = await f.handles.prisma.run.findUnique({ where: { id: oldRunId } });
        if (!heldPause && run?.status === "waiting_input") {
          heldPause = true;
          await paused;
        }
      }
    });
    try {
      const seeded = await seed(f.handles, "protected input");
      oldRunId = seeded.run.id;
      await f.handles.prisma.task.update({
        where: { id: seeded.run.taskId },
        data: { prompt: "Show a secret card for a masked API key." },
      });
      oldExecution = f.handles.executor.continueRun(oldRunId, "pause-notification-boundary");
      await wait(() => expect(heldPause).toBe(true));
      const protectedState = async () => ({
        run: await f.handles.prisma.run.findUniqueOrThrow({ where: { id: oldRunId! } }),
        effects: await f.handles.prisma.externalEffect.findMany({
          where: { runId: oldRunId },
          orderBy: { id: "asc" },
        }),
        cards: await f.handles.prisma.message.findMany({
          where: { runId: oldRunId },
          orderBy: { seq: "asc" },
        }),
      });
      const before = await protectedState();
      expect(
        before.effects.some(
          (effect) => effect.kind === "request_secret" && effect.status === "intended",
        ),
      ).toBe(true);
      const sent = await rpc<{ runId: string }>(f.handles, seeded.cookie, "threads/send", {
        botId: seeded.botId,
        text: "Start a separate report.",
        clientNonce: randomUUID(),
      });
      expect(sent.runId).not.toBe(oldRunId);
      await wait(() => expect(newRunId).toBe(sent.runId));
      const lease = await f.handles.prisma.computerExecutionLease.findFirstOrThrow({
        where: { runId: sent.runId },
      });
      expect(lease.expiresAt.getTime()).toBeGreaterThan(Date.now());
      releasePause();
      await oldExecution;
      expect(await protectedState()).toEqual(before);
      expect(
        await f.handles.prisma.computerExecutionLease.findUniqueOrThrow({
          where: { id: lease.id },
        }),
      ).toMatchObject({ runId: sent.runId, fence: lease.fence, expiresAt: lease.expiresAt });
      releaseNew();
      await wait(async () =>
        expect(
          (await f.handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } })).status,
        ).toBe("completed"),
      );
      expect((await protectedState()).effects).toEqual(before.effects);
    } finally {
      releasePause();
      releaseNew();
      try {
        await oldExecution;
      } finally {
        try {
          await f.close();
        } finally {
          publish.mockRestore();
          runSpy.mockRestore();
        }
      }
    }
  });

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

  it.each(["card", "composer"] as const)(
    "does not answer a real Pi question through a late initial dispatch hint (%s)",
    verifyHumanWaitAnswer,
  );

  async function verifyHumanWaitAnswer(answerPath: "card" | "composer") {
    const choice = "Continue with the saved work.";
    const question = "Should I write the saved tail?";
    const tailPath = "notes/human-wait-tail.txt";
    const tailText = "Only the real user's answer authorizes this saved tail.";
    const finalText = "The answered task is complete.";
    const fixtureKey = "synthetic-human-wait-model-key";
    const model: Model<"openai-completions"> = {
      provider: "anthropic",
      id: "synthetic-human-wait-dispatch",
      name: "Synthetic human wait dispatch",
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
    const modelRequests: TranscriptContext[] = [];
    const providerFailures: unknown[] = [];
    const stream = (activeModel: Model<Api>, context: TranscriptContext) => {
      try {
        expect(activeModel.id).toBe(model.id);
        modelRequests.push(structuredClone(context));
        expect(modelRequests.length).toBeLessThanOrEqual(2);
        return piResponse(
          activeModel,
          modelRequests.length === 1
            ? [
                // This real sequential tool makes the entire SDK batch retain its unstarted tail.
                { type: "toolCall", id: "wait-order", name: "schedule_list", arguments: {} },
                {
                  type: "toolCall",
                  id: "wait-question",
                  name: "ask_user",
                  arguments: { question, options: [choice, "Stop."] },
                },
                {
                  type: "toolCall",
                  id: "answered-tail",
                  name: "write_file",
                  arguments: { path: tailPath, content: tailText },
                },
              ]
            : [{ type: "text", text: finalText }],
        );
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
            name: "Synthetic human wait fixture",
            resolve: async () => ({ auth: { apiKey: fixtureKey }, source: "fixture" }),
          },
        },
        api: { stream, streamSimple: stream },
      }),
    );
    let targetRunId: string | undefined;
    let reservations = 0;
    const pi = new PiAgentRuntime({
      modelCallObserver: {
        beforeCall() {
          reservations += 1;
          return `human-wait-reservation-${reservations}`;
        },
        afterCall() {},
      },
    });
    const scripted = new ScriptedAgentRuntime();
    const runtimeRequests: Array<{ runId: string; prompt: string; checkpoint?: string }> = [];
    const executions: Array<{ name: string; id: string }> = [];
    const runtime: AgentRuntime = {
      describe: () => pi.describe(),
      run(request, context) {
        if (request.runId !== targetRunId) return scripted.run(request, context);
        runtimeRequests.push({
          runId: request.runId,
          prompt: request.prompt,
          checkpoint: request.turnCheckpoint,
        });
        const execute = request.executeTool;
        if (!execute) throw new Error("The real executor must provide executeTool");
        request.executeTool = (name, args, id, route, observer) => {
          executions.push({ name, id });
          return execute(name, args, id, route, observer);
        };
        return pi.run(request, context);
      },
      abort: (runId) => pi.abort(runId),
    };
    const sandbox = new FakeSandboxProvider();
    const write = vi.spyOn(sandbox, "writeFile");
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Synthetic Pi dispatch must not make network requests"));
    let fixture: Awaited<ReturnType<typeof openApp>> | undefined;
    let recovery: RunWorkerHost | undefined;
    let restoreJobs: (() => void) | undefined;
    let starter: RunStarter | undefined;
    try {
      fixture = await openApp(runtime, {
        sandbox,
        agentRuntime: "pi",
        defaultProvider: model.provider,
        defaultModel: model.id,
        deploymentModelConfigured: true,
        contextStrategy: "current",
        wakeupDriver: "memory",
      });
      const handles = fixture.handles;
      const seeded = await seed(handles, "human wait dispatch");
      targetRunId = seeded.run.id;
      const prisma = handles.prisma;
      const fanout = new InMemoryRealtimeFanout();
      const dispatch = new RunStarter(fanout);
      starter = dispatch;
      const handlers = {
        "run.continue": async ({ runId }, execution) => {
          if (runId !== targetRunId) return;
          await handles.executor.continueRun(runId, "human-wait-dispatch", execution?.onRunStarted);
        },
      } as BackgroundJobHandlers;
      const publisher = new RunJobPublisher(prisma, handles.jobs, dispatch);
      const backgroundEnqueue = handles.jobs.enqueue.bind(handles.jobs);
      const jobs = vi
        .spyOn(handles.jobs, "enqueue")
        .mockImplementation((job) =>
          job.name === "run.continue" && job.payload.runId === targetRunId
            ? publisher.enqueue(job)
            : backgroundEnqueue(job),
        );
      restoreJobs = () => jobs.mockRestore();
      recovery = new RunWorkerHost(prisma, fanout, dispatch, { intervalMs: 25 });
      await recovery.start(handlers);
      await wait(async () =>
        expect(await prisma.run.findUniqueOrThrow({ where: { id: targetRunId } })).toMatchObject({
          status: "waiting_input",
          wakeAt: null,
          leaseFence: 1,
          leaseOwner: null,
          scriptedState: null,
        }),
      );
      await recovery.stop();
      await handles.awaitIdle?.();
      dispatch.attach(handlers);
      const paused = await prisma.run.findUniqueOrThrow({ where: { id: targetRunId } });
      const checkpoint = await prisma.externalEffect.findUniqueOrThrow({
        where: { idempotencyKey: JSON.stringify(["runtime_checkpoint", targetRunId]) },
      });
      expect(checkpoint.status).toBe("runtime_checkpoint");
      expect(typeof checkpoint.result).toBe("string");
      expect(JSON.parse(String(checkpoint.result))).toMatchObject({
        executionMode: "sequential",
        pendingToolCallId: "wait-question",
      });
      const messages = await prisma.message.findMany({
        where: { runId: targetRunId },
        orderBy: { seq: "asc" },
      });
      const cards = messages.flatMap((message) =>
        MessageBlockSchema.array()
          .parse(message.blocks)
          .flatMap((block) => (block.kind === "ask" ? [{ message, block }] : [])),
      );
      expect(cards).toHaveLength(1);
      const card = cards[0]!;
      expect(card.block).toMatchObject({
        text: question,
        status: "pending",
        actions: [
          { id: "choice-1", label: choice },
          { id: "choice-2", label: "Stop." },
        ],
      });
      const targetWrites = () =>
        write.mock.calls.filter(([, , context]) => context.runId === targetRunId);
      expect(targetWrites()).toHaveLength(0);
      expect(modelRequests).toHaveLength(1);
      expect(reservations).toBe(1);
      expect(await prisma.attempt.count({ where: { runId: targetRunId } })).toBe(1);
      const state = async () => ({
        run: await prisma.run.findUniqueOrThrow({ where: { id: targetRunId } }),
        task: await prisma.task.findUniqueOrThrow({ where: { id: paused.taskId } }),
        attempts: await prisma.attempt.findMany({
          where: { runId: targetRunId },
          orderBy: { id: "asc" },
        }),
        effects: await prisma.externalEffect.findMany({
          where: { runId: targetRunId },
          orderBy: { id: "asc" },
        }),
        messages: await prisma.message.findMany({
          where: { runId: targetRunId },
          orderBy: { seq: "asc" },
        }),
        events: await prisma.event.findMany({
          where: { runId: targetRunId },
          orderBy: { seq: "asc" },
        }),
        modelRequests: structuredClone(modelRequests),
        runtimeRequests: structuredClone(runtimeRequests),
        reservations,
        executions: structuredClone(executions),
        writes: structuredClone(targetWrites()),
      });
      const unanswered = await state();
      for (const hint of [
        runContinueJob(targetRunId),
        { ...runContinueJob(targetRunId), keepExisting: true },
        runContinueJob(targetRunId),
      ]) {
        await publisher.enqueue(hint);
        await dispatch.stop();
        await handles.awaitIdle?.();
        expect(await state()).toEqual(unanswered);
        dispatch.attach(handlers);
      }
      // A compatibility fixture for an old unanswered Run carrying a future marker.
      const futureHumanWake = new Date(Date.now() + 60_000);
      await prisma.run.update({ where: { id: targetRunId }, data: { wakeAt: futureHumanWake } });
      expect(await prisma.run.findUniqueOrThrow({ where: { id: targetRunId } })).toMatchObject({
        status: "waiting_input",
        wakeAt: futureHumanWake,
        leaseFence: 1,
      });
      const answerNonce = `human-wait-answer:${randomUUID()}`;
      if (answerPath === "composer") {
        const sent = await rpc<{ runId: string }>(handles, seeded.cookie, "threads/send", {
          botId: seeded.botId,
          text: choice,
          clientNonce: answerNonce,
        });
        expect(sent.runId).toBe(targetRunId);
      } else {
        await rpc(handles, seeded.cookie, "threads/answer", {
          botId: seeded.botId,
          runId: targetRunId,
          messageId: card.message.id,
          answer: "choice-1",
          clientNonce: answerNonce,
        });
      }
      await wait(async () =>
        expect(await prisma.run.findUniqueOrThrow({ where: { id: targetRunId } })).toMatchObject({
          status: "completed",
          wakeAt: null,
          leaseFence: 2,
          leaseOwner: null,
        }),
      );
      await dispatch.stop();
      await handles.awaitIdle?.();
      expect(providerFailures).toEqual([]);
      expect(modelRequests).toHaveLength(2);
      expect(reservations).toBe(2);
      expect(runtimeRequests.map((request) => request.runId)).toEqual([targetRunId, targetRunId]);
      expect(runtimeRequests[1]).toMatchObject({
        checkpoint: checkpoint.result,
      });
      const resumedPrompt = runtimeRequests[1]!.prompt.split("\n\n");
      const timestamp =
        /^Current date and time: \w+, (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) \(UTC\)\./.exec(
          resumedPrompt[1] ?? "",
        );
      expect(timestamp).not.toBeNull();
      expect(resumedPrompt).toEqual([
        `Selected choice choice-1: ${choice}`,
        formatCurrentTimeInstruction(new Date(timestamp![1]!)),
      ]);
      const answerResult = modelRequests[1]!.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "wait-question",
      );
      expect(answerResult?.role).toBe("toolResult");
      expect(JSON.stringify(answerResult)).toContain(choice);
      expect(await prisma.task.findUniqueOrThrow({ where: { id: paused.taskId } })).toMatchObject({
        prompt: `Selected choice choice-1: ${choice}`,
      });
      expect(targetWrites()).toHaveLength(1);
      expect(targetWrites()[0]?.[1]).toMatchObject({ path: `bots/${seeded.botId}/${tailPath}` });
      expect(new TextDecoder().decode(targetWrites()[0]?.[1].content)).toBe(tailText);
      expect(executions.map(({ name }) => name)).toEqual(["schedule_list", "write_file"]);
      expect(new Set(executions.map(({ id }) => id)).size).toBe(2);
      expect(
        await prisma.attempt.findMany({
          where: { runId: targetRunId },
          orderBy: { fence: "asc" },
        }),
      ).toEqual([
        expect.objectContaining({ fence: 1, status: "waiting_input" }),
        expect.objectContaining({ fence: 2, status: "completed" }),
      ]);
      const finalMessages = await prisma.message.findMany({ where: { runId: targetRunId } });
      const finalCards = finalMessages.flatMap((message) =>
        MessageBlockSchema.array()
          .parse(message.blocks)
          .filter((block) => block.kind === "ask"),
      );
      expect(finalCards).toEqual([
        expect.objectContaining({ text: question, status: "answered", answer: "choice-1" }),
      ]);
      expect(JSON.stringify(finalMessages)).toContain(finalText);
      expect(
        await prisma.messagingOutbound.count({
          where: { sourceMessageId: { in: finalMessages.map(({ id }) => id) } },
        }),
      ).toBe(0);
      expect(network).not.toHaveBeenCalled();
    } finally {
      if (targetRunId) pi.abort(targetRunId);
      await recovery?.stop();
      await starter?.stop();
      restoreJobs?.();
      await fixture?.close();
      write.mockRestore();
      network.mockRestore();
      if (previousProvider) models.setProvider(previousProvider);
      else models.deleteProvider(model.provider);
      vi.unstubAllEnvs();
    }
  }

  it("preserves a real computer-outage retry deadline across late initial dispatch hints", async () => {
    const filePath = "notes/queued-backoff.txt";
    const fileText = "The real retry deadline must pass before this write.";
    const finalText = "The computer recovered after its retry deadline.";
    let targetRunId: string | undefined;
    let runtimeCalls = 0;
    const tools: Array<{ name: string; id?: string; args: unknown }> = [];
    const scripted = new ScriptedAgentRuntime();
    const runtime: AgentRuntime = {
      describe: () => scripted.describe(),
      async *run(request, context) {
        if (request.runId !== targetRunId) {
          yield* scripted.run(request, context);
          return;
        }
        runtimeCalls += 1;
        request.script = [
          { toolCalls: [{ name: "write_file", args: { path: filePath, content: fileText } }] },
          { assistant: finalText, complete: true },
        ];
        for await (const event of scripted.run(request, context)) {
          if (event.type === "tool")
            tools.push({
              name: event.name,
              id: event.executionId,
              args: structuredClone(event.args),
            });
          yield event;
        }
      },
      abort: (runId) => scripted.abort(runId),
    };
    const sandbox = new FakeSandboxProvider();
    const originalPrepare = sandbox.prepare.bind(sandbox);
    const preparations: number[] = [];
    const prepare = vi.spyOn(sandbox, "prepare").mockImplementation(async (computer, context) => {
      if (targetRunId && context.runId === targetRunId) {
        preparations.push(Date.now());
        if (preparations.length === 1) throw new SandboxUnavailableError();
      }
      await originalPrepare(computer, context);
    });
    const write = vi.spyOn(sandbox, "writeFile");
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Synthetic outage dispatch must not make network requests"));
    let fixture: Awaited<ReturnType<typeof openApp>> | undefined;
    let recovery: RunWorkerHost | undefined;
    let starter: RunStarter | undefined;
    let restoreJobs: (() => void) | undefined;
    try {
      fixture = await openApp(runtime, { sandbox, wakeupDriver: "memory" });
      const handles = fixture.handles;
      const seeded = await seed(handles, "queued backoff", "dedicated");
      targetRunId = seeded.run.id;
      const prisma = handles.prisma;
      const fanout = new InMemoryRealtimeFanout();
      const dispatch = new RunStarter(fanout);
      starter = dispatch;
      const publisher = new RunJobPublisher(prisma, handles.jobs, dispatch);
      const retries: BackgroundJob[] = [];
      const backgroundEnqueue = handles.jobs.enqueue.bind(handles.jobs);
      const jobs = vi.spyOn(handles.jobs, "enqueue").mockImplementation((job) => {
        if (job.name === "run.continue" && job.payload.runId === targetRunId) {
          if (job.availableAt) retries.push(structuredClone(job));
          return publisher.enqueue(job);
        }
        return backgroundEnqueue(job);
      });
      restoreJobs = () => jobs.mockRestore();
      const handlers = {
        "run.continue": async ({ runId }, execution) => {
          if (runId !== targetRunId) return;
          await handles.executor.continueRun(
            runId,
            "queued-outage-dispatch",
            execution?.onRunStarted,
          );
        },
      } as BackgroundJobHandlers;
      recovery = new RunWorkerHost(prisma, fanout, dispatch, { intervalMs: 25 });
      await recovery.start(handlers);
      await wait(async () => {
        const run = await prisma.run.findUniqueOrThrow({ where: { id: targetRunId } });
        expect(run).toMatchObject({ status: "queued", leaseFence: 1, leaseOwner: null });
        expect(run.wakeAt?.getTime()).toBeGreaterThan(Date.now());
      });
      await recovery.stop();
      await handles.awaitIdle?.();
      dispatch.attach(handlers);
      const queued = await prisma.run.findUniqueOrThrow({ where: { id: targetRunId } });
      const retryAt = queued.wakeAt;
      expect(retryAt).toBeInstanceOf(Date);
      if (!retryAt) throw new Error("The real typed outage must persist its retry deadline");
      expect(preparations).toHaveLength(1);
      expect(retryAt.getTime()).toBeGreaterThanOrEqual(preparations[0]! + 15_000);
      expect(retries).toHaveLength(1);
      expect(retries[0]!.availableAt).toEqual(retryAt);
      expect(runtimeCalls).toBe(1);
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("write_file");
      const targetWrites = () =>
        write.mock.calls.filter(([, , context]) => context.runId === targetRunId);
      expect(targetWrites()).toHaveLength(0);
      expect(await prisma.attempt.findMany({ where: { runId: targetRunId } })).toEqual([
        expect.objectContaining({ status: "setup_failed", fence: 1 }),
      ]);
      const state = async () => ({
        run: await prisma.run.findUniqueOrThrow({ where: { id: targetRunId } }),
        task: await prisma.task.findUniqueOrThrow({ where: { id: queued.taskId } }),
        attempts: await prisma.attempt.findMany({
          where: { runId: targetRunId },
          orderBy: { id: "asc" },
        }),
        effects: await prisma.externalEffect.findMany({
          where: { runId: targetRunId },
          orderBy: { id: "asc" },
        }),
        messages: await prisma.message.findMany({
          where: { runId: targetRunId },
          orderBy: { seq: "asc" },
        }),
        events: await prisma.event.findMany({
          where: { runId: targetRunId },
          orderBy: { seq: "asc" },
        }),
        runtimeCalls,
        tools: structuredClone(tools),
        preparations: [...preparations],
        writes: structuredClone(targetWrites()),
      });
      const backingOff = await state();
      for (const hint of [
        runContinueJob(targetRunId),
        { ...runContinueJob(targetRunId), keepExisting: true },
        runContinueJob(targetRunId),
        { ...runContinueJob(targetRunId), availableAt: new Date(Date.now() - 1_000) },
        {
          ...runContinueJob(targetRunId),
          availableAt: new Date(retryAt.getTime() + 60_000),
          keepExisting: true,
        },
      ]) {
        await publisher.enqueue(hint);
        await dispatch.stop();
        await handles.awaitIdle?.();
        expect(await state()).toEqual(backingOff);
        dispatch.attach(handlers);
      }
      // The process-local timer was drained; real scanning must recover the durable date.
      await recovery.start(handlers);
      await vi.waitFor(
        async () => {
          expect(await prisma.run.findUniqueOrThrow({ where: { id: targetRunId } })).toMatchObject({
            status: "completed",
            leaseFence: 2,
            leaseOwner: null,
          });
        },
        { timeout: 20_000, interval: 25 },
      );
      await recovery.stop();
      await handles.awaitIdle?.();
      expect(preparations).toHaveLength(2);
      expect(preparations[1]).toBeGreaterThanOrEqual(retryAt.getTime());
      expect(runtimeCalls).toBe(2);
      expect(tools.map(({ name }) => name)).toEqual(["write_file", "write_file"]);
      expect(targetWrites()).toHaveLength(1);
      expect(targetWrites()[0]?.[1]).toMatchObject({ path: filePath });
      expect(new TextDecoder().decode(targetWrites()[0]?.[1].content)).toBe(fileText);
      expect(
        await prisma.attempt.findMany({ where: { runId: targetRunId }, orderBy: { fence: "asc" } }),
      ).toEqual([
        expect.objectContaining({ status: "setup_failed", fence: 1 }),
        expect.objectContaining({ status: "completed", fence: 2 }),
      ]);
      const messages = await prisma.message.findMany({ where: { runId: targetRunId } });
      expect(JSON.stringify(messages)).toContain(finalText);
      expect(retries).toHaveLength(1);
      expect(network).not.toHaveBeenCalled();
    } finally {
      if (targetRunId) await scripted.abort(targetRunId);
      await recovery?.stop();
      await starter?.stop();
      restoreJobs?.();
      await fixture?.close();
      prepare.mockRestore();
      write.mockRestore();
      network.mockRestore();
    }
  }, 30_000);

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
        return piResponse(activeModel, [
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

      const unrelated = await seed(handles, "unrelated recovery");
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
      expect(
        enqueued.some(
          (job) => job.name === "run.continue" && job.payload.runId === unrelated.run.id,
        ),
      ).toBe(true);
      expect(
        enqueued.some((job) => job.name === "run.continue" && job.payload.runId === targetRunId),
      ).toBe(false);
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

  it("checkpoints dirty Pi work after a loop guard without cancelling workspace export", async () => {
    const filePath = "notes/loop-guard-workspace.txt";
    const fileText = "The stopped Pi turn must retain its actual workspace write.";
    const fixtureKey = "synthetic-loop-guard-workspace-key";
    const model: Model<"openai-completions"> = {
      provider: "anthropic",
      id: "synthetic-loop-guard-workspace",
      name: "Synthetic loop guard workspace",
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
    let requests = 0;
    let reservations = 0;
    const providerFailures: unknown[] = [];
    const stream = (activeModel: Model<Api>, context: TranscriptContext) => {
      try {
        requests += 1;
        expect(activeModel.id).toBe(model.id);
        expect(requests).toBeLessThanOrEqual(7);
        if (requests > 1) {
          const previous = context.messages.findLast((message) => message.role === "toolResult");
          expect(previous).toMatchObject({
            toolCallId: requests === 2 ? "dirty-write" : `dirty-repeat-${requests - 2}`,
          });
          expect(JSON.stringify(previous)).toContain(
            requests === 2 ? filePath : "message is required",
          );
        }
        return piResponse(activeModel, [
          requests === 1
            ? {
                type: "toolCall",
                id: "dirty-write",
                name: "write_file",
                arguments: { path: filePath, content: fileText },
              }
            : {
                type: "toolCall",
                id: `dirty-repeat-${requests - 1}`,
                name: "message_user",
                arguments: { message: "" },
              },
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
            name: "Synthetic workspace fixture",
            resolve: async () => ({ auth: { apiKey: fixtureKey }, source: "fixture" }),
          },
        },
        api: { stream, streamSimple: stream },
      }),
    );
    const pi = new PiAgentRuntime({
      modelCallObserver: {
        beforeCall() {
          reservations += 1;
          return `dirty-loop-reservation-${reservations}`;
        },
        afterCall() {},
      },
    });
    const scripted = new ScriptedAgentRuntime();
    let targetRunId: string | undefined;
    let releaseFinalResult = () => {};
    const finalResultReleased = new Promise<void>((resolve) => {
      releaseFinalResult = resolve;
    });
    let finalResultHeld = false;
    let runtimeAborted = false;
    const executions: string[] = [];
    const runtime: AgentRuntime = {
      describe: () => pi.describe(),
      run(request, context) {
        if (request.runId !== targetRunId) return scripted.run(request, context);
        context?.signal?.addEventListener(
          "abort",
          () => {
            runtimeAborted = true;
            releaseFinalResult();
          },
          { once: true },
        );
        const execute = request.executeTool;
        if (!execute) throw new Error("The real executor must provide executeTool");
        request.executeTool = (name, args, id, route, observer) => {
          executions.push(id);
          const result = execute(name, args, id, route, observer);
          if (id !== JSON.stringify(["pi-tool", "main", "dirty-repeat-6"])) return result;
          // The actual tool and effect finish normally; retain only its result
          // transport until cleanup, preventing an unrelated eighth model call.
          return result.then(async (value) => {
            finalResultHeld = true;
            await finalResultReleased;
            return value;
          });
        };
        return pi.run(request, context);
      },
      abort: (runId) => pi.abort(runId),
    };
    const sandbox = new FakeSandboxProvider();
    const write = vi.spyOn(sandbox, "writeFile");
    const originalExport = sandbox.exportWorkspace.bind(sandbox);
    const exports: Array<{ aborted: boolean; runId?: string }> = [];
    const exported = vi
      .spyOn(sandbox, "exportWorkspace")
      .mockImplementation(async function* (computer, context) {
        if (context.runId === targetRunId) {
          exports.push({ aborted: context.signal.aborted, runId: context.runId });
          context.signal.throwIfAborted();
        }
        yield* originalExport(computer, context);
      });
    let fixture: Awaited<ReturnType<typeof openApp>> | undefined;
    let executing: Promise<void> | undefined;
    try {
      fixture = await openApp(runtime, {
        sandbox,
        agentRuntime: "pi",
        defaultProvider: model.provider,
        defaultModel: model.id,
        deploymentModelConfigured: true,
        contextStrategy: "current",
      });
      const continueRun = fixture.handles.executor.continueRun.bind(fixture.handles.executor);
      const introExecutions: Promise<void>[] = [];
      const intro = vi
        .spyOn(fixture.handles.executor, "continueRun")
        .mockImplementation((...args) => {
          const execution = continueRun(...args);
          introExecutions.push(execution);
          return execution;
        });
      let seeded: Awaited<ReturnType<typeof seed>>;
      try {
        seeded = await seed(fixture.handles, "dirty loop guard", "dedicated", async () => {
          // The intro becomes terminal before its executor releases the computer and
          // starts queued work. Finish that cleanup before inserting the manual Run.
          expect(introExecutions).not.toHaveLength(0);
          await Promise.all(introExecutions);
        });
      } finally {
        intro.mockRestore();
      }
      targetRunId = seeded.run.id;
      executing = fixture.handles.executor.continueRun(targetRunId, "dirty-loop-guard-worker");
      await executing;
      expect(providerFailures).toEqual([]);
      expect(requests).toBe(7);
      expect(reservations).toBe(7);
      expect(executions).toHaveLength(7);
      expect(new Set(executions).size).toBe(7);
      expect(finalResultHeld).toBe(true);
      expect(runtimeAborted).toBe(true);
      const writes = write.mock.calls.filter(([, , context]) => context.runId === targetRunId);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.[1]).toMatchObject({ path: filePath });
      expect(new TextDecoder().decode(writes[0]?.[1].content)).toBe(fileText);
      // Fake is deliberately not the Docker/local-home checkpoint fast path.
      expect(exports).toEqual([{ runId: targetRunId, aborted: false }]);
      expect(
        await fixture.handles.prisma.run.findUniqueOrThrow({ where: { id: targetRunId } }),
      ).toMatchObject({ status: "completed", error: null, leaseFence: 1, leaseOwner: null });
      expect(
        await fixture.handles.prisma.attempt.findMany({ where: { runId: targetRunId } }),
      ).toEqual([
        expect.objectContaining({ status: "completed", fence: 1, finishedAt: expect.any(Date) }),
      ]);
      const computer = await fixture.handles.prisma.computer.findFirstOrThrow({
        where: { bots: { some: { id: seeded.botId } } },
      });
      expect(computer).toMatchObject({ kind: "fake", homeRevision: expect.any(String) });
      expect(
        await new LocalAgentHomeStore(fixture.dataDir).readFile(computer.homeKey, filePath, {
          operationId: "dirty-checkpoint-readback",
          traceId: "dirty-checkpoint-readback",
          userId: seeded.userId,
          spaceId: seeded.spaceId,
          botId: seeded.botId,
          runId: targetRunId,
          signal: new AbortController().signal,
        }),
      ).toBe(fileText);
      const messages = await fixture.handles.prisma.message.findMany({
        where: { runId: targetRunId, role: "bot" },
      });
      expect(JSON.stringify(messages)).toContain(
        "times in a row without making progress, so I stopped early",
      );
    } finally {
      releaseFinalResult();
      if (targetRunId) await pi.abort(targetRunId);
      await executing?.catch(() => undefined);
      await fixture?.close();
      exported.mockRestore();
      write.mockRestore();
      if (previousProvider) models.setProvider(previousProvider);
      else models.deleteProvider(model.provider);
      vi.unstubAllEnvs();
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
