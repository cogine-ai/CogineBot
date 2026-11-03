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
import {
  createAssistantMessageEventStream,
  createProvider,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import { ComposioEmulator, FakeSandboxProvider } from "@rakazo/adapters";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadMessage } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { AppHandles } from "../../../apps/api/src/app.ts";
import { modelsForRequest, PiAgentRuntime } from "../../adapters/src/pi-runtime.js";
import type { TurnCheckpoint } from "../../adapters/src/turn-checkpoint.js";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const fixtureKey = "synthetic-checkpoint-pg-model-key";
const instructions = "Keep the checkpoint instruction canary. Never deploy anything.";
const historyText = "Earlier valid history: the checkpoint project is Aurora.";
const prompt = "Save the first file, ask whether to continue, then save the tail file.";
const beforeText = "I saved the first checkpoint file before asking.";
const afterText = "The saved checkpoint work and its tail are complete.";
const choiceLabel = "Continue with the saved files.";
const firstPath = "notes/checkpoint-first.txt";
const tailPath = "notes/checkpoint-tail.txt";
const model: Model<"openai-completions"> = {
  provider: "anthropic",
  id: "synthetic-checkpoint-pg",
  name: "Synthetic checkpoint PG fixture",
  api: "openai-completions",
  baseUrl: "https://models.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 1_024,
};

function response(content: AssistantMessage["content"], activeModel: Model<Api>) {
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
  for (const [contentIndex, part] of content.entries()) {
    if (part.type !== "toolCall") continue;
    stream.push({ type: "toolcall_start", contentIndex, partial: message });
    stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
  }
  stream.push({ type: "done", reason: hasCalls ? "toolUse" : "stop", message });
  stream.end(message);
  return stream;
}

function call(id: string, name: string, args: ToolCall["arguments"] = {}): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function toolResult(context: TranscriptContext, id: string) {
  const result = context.messages.findLast(
    (message) => message.role === "toolResult" && message.toolCallId === id,
  );
  if (result?.role !== "toolResult") throw new Error(`Missing actual result ${id}`);
  return result;
}

type ModelStep = (context: TranscriptContext) => AssistantMessage["content"];

type CreatedEffect = { id: string; runId: string; kind: string; request: unknown };

async function fixture(
  steps: ModelStep[],
  options: {
    prompt?: string;
    afterEffectCreate?: (effect: CreatedEffect) => Promise<void>;
    releaseEffectBarrier?: () => void;
  } = {},
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cogine-turn-checkpoint-pg-"));
  vi.stubEnv("PI_DEFAULT_PROVIDER", model.provider);
  vi.stubEnv("PI_DEFAULT_MODEL", model.id);
  vi.stubEnv("ANTHROPIC_API_KEY", fixtureKey);
  const models = modelsForRequest(
    { model: { provider: model.provider, id: model.id, apiKey: fixtureKey } },
    model.provider,
  ) as MutableModels;
  const previousProvider = models.getProvider(model.provider);
  const providerRequests: Array<{ generation: number; context: TranscriptContext }> = [];
  const providerFailures: unknown[] = [];
  let generation = 1;
  let reservations = 0;
  const actualRuntime = () =>
    new PiAgentRuntime({
      modelCallObserver: {
        beforeCall() {
          reservations += 1;
          return `synthetic-reservation-${reservations}`;
        },
        afterCall() {},
      },
    });
  let activeRuntime = actualRuntime();
  const firstRuntime = activeRuntime;
  const runtimeRequests: Array<{ generation: number; runId: string; checkpoint?: string }> = [];
  // Only the instance changes: the app still constructs and executes every real request.
  const forwarder: AgentRuntime = {
    describe: () => activeRuntime.describe(),
    run(request, context) {
      runtimeRequests.push({
        generation,
        runId: request.runId,
        checkpoint: request.turnCheckpoint,
      });
      return activeRuntime.run(request, context);
    },
    abort: (runId) => activeRuntime.abort(runId),
  };
  const stream = (activeModel: Model<Api>, context: TranscriptContext) => {
    const step = steps[providerRequests.length];
    providerRequests.push({ generation, context: structuredClone(context) });
    try {
      expect(activeModel.id).toBe(model.id);
      expect(activeModel.provider).toBe(model.provider);
      if (!step) throw new Error("Unexpected additional checkpoint model request");
      return response(step(context), activeModel);
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
          name: "Synthetic checkpoint fixture",
          resolve: async () => ({ auth: { apiKey: fixtureKey }, source: "fixture" }),
        },
      },
      api: { stream, streamSimple: stream },
    }),
  );

  let handles: AppHandles | undefined;
  let restoreJobs: (() => void) | undefined;
  const controlledDb = options.afterEffectCreate
    ? createDb(process.env.DATABASE_URL!, {
        applicationName: "synthetic-parallel-approval-checkpoint",
      })
    : undefined;
  // As in the DB race fixtures, the extension preserves real Prisma queries and transactions.
  const controlledPrisma = controlledDb?.prisma.$extends({
    query: {
      externalEffect: {
        async create({ args, query }) {
          const effect = await query(args);
          await options.afterEffectCreate?.(effect);
          return effect;
        },
      },
    },
  }) as unknown as PrismaClient | undefined;
  const sandbox = new FakeSandboxProvider();
  const writes = vi.spyOn(sandbox, "writeFile");
  const close = async () => {
    options.releaseEffectBarrier?.();
    try {
      await handles?.stop();
    } finally {
      try {
        if (!handles) await controlledDb?.prisma.$disconnect();
        await controlledDb?.pool.end();
      } finally {
        restoreJobs?.();
        writes.mockRestore();
        if (previousProvider) models.setProvider(previousProvider);
        else models.deleteProvider(model.provider);
        vi.unstubAllEnvs();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  };
  try {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      ...(controlledPrisma ? { prisma: controlledPrisma } : {}),
      dataDir,
      authUrl: origin,
      webOrigin: origin,
      sandboxProvider: "fake",
      sandbox,
      agentRuntime: "pi",
      runtime: forwarder,
      contextStrategy: "current",
      defaultProvider: model.provider,
      defaultModel: model.id,
      deploymentModelConfigured: true,
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "synthetic-checkpoint-pg-encryption-key",
    });
    const app = handles;
    const signup = await app.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `checkpoint-${randomUUID()}@example.test`,
        password: "password12",
        name: "Checkpoint fixture",
      }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    async function rpc<T>(procedure: string, input: unknown = {}): Promise<T> {
      const result = await app.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({ json: input }),
      });
      const body = (await result.json()) as { json: T; error?: { message: string } };
      if (!result.ok || body.error)
        throw new Error(`${procedure}: ${body.error?.message ?? result.status}`);
      return body.json;
    }
    const me = await rpc<{ userId: string; spaceId: string }>("me");
    const botName = `Checkpoint ${randomUUID()}`;
    let botId: string | undefined;
    const published: string[] = [];
    const enqueue = app.jobs.enqueue.bind(app.jobs);
    const jobSpy = vi.spyOn(app.jobs, "enqueue").mockImplementation(async (job) => {
      if (job.name === "run.continue") {
        const target = await app.prisma.run.findUnique({
          where: { id: job.payload.runId },
          select: { botId: true, bot: { select: { name: true, userId: true } } },
        });
        // Match this exact synthetic bot even while bots/create is publishing its intro.
        if (
          target &&
          (botId
            ? target.botId === botId
            : target.bot.userId === me.userId && target.bot.name === botName)
        ) {
          published.push(job.payload.runId);
          return;
        }
      }
      return enqueue(job);
    });
    restoreJobs = () => jobSpy.mockRestore();
    const bot = await rpc<{ id: string }>("bots/create", {
      name: botName,
      title: "",
      description: "",
      instructions,
      notifyOnFinish: false,
    });
    botId = bot.id;
    await discardBotIntroRun(app, cookie, bot.id);
    await app.awaitIdle?.();
    expect(providerRequests).toHaveLength(0);
    const thread = await app.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const history = await createThreadMessage(app.prisma, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text: historyText }],
    });
    const sent = await rpc<{ runId: string }>("threads/send", {
      botId: bot.id,
      text: options.prompt ?? prompt,
    });
    expect(published).toContain(sent.runId);
    const key = JSON.stringify(["runtime_checkpoint", sent.runId]);
    return {
      app,
      bot,
      me,
      thread,
      history,
      sent,
      rpc,
      close,
      writes,
      sandbox,
      key,
      providerRequests,
      runtimeRequests,
      get reservations() {
        return reservations;
      },
      async restartRuntime() {
        await app.awaitIdle?.();
        expect(
          await app.prisma.attempt.count({
            where: { runId: sent.runId, status: "running" },
          }),
        ).toBe(0);
        generation += 1;
        activeRuntime = actualRuntime();
        expect(activeRuntime).not.toBe(firstRuntime);
      },
      async continueRun(worker: string) {
        await app.executor.continueRun(sent.runId, worker);
        await app.awaitIdle?.();
        if (providerFailures.length) throw providerFailures[0];
      },
      async answer() {
        const messages = await app.prisma.message.findMany({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "asc" },
        });
        const cards = messages.flatMap((message) =>
          MessageBlockSchema.array()
            .parse(message.blocks)
            .flatMap((block) => (block.kind === "ask" ? [{ message, block }] : [])),
        );
        expect(cards).toHaveLength(1);
        const card = cards[0]!;
        expect(card.block.status).toBe("pending");
        expect(card.block.actions?.[0]).toEqual({ id: "choice-1", label: choiceLabel });
        await rpc("threads/answer", {
          botId: bot.id,
          runId: sent.runId,
          messageId: card.message.id,
          answer: "choice-1",
        });
      },
      async checkpoint() {
        const row = await app.prisma.externalEffect.findUniqueOrThrow({
          where: { idempotencyKey: key },
        });
        expect(row).toMatchObject({
          runId: sent.runId,
          spaceId: me.spaceId,
          kind: "runtime_checkpoint",
          status: "runtime_checkpoint",
        });
        expect(typeof row.result).toBe("string");
        return { row, saved: JSON.parse(String(row.result)) as TurnCheckpoint };
      },
      async clientSnapshot() {
        const snapshot = await rpc("threads/get", { botId: bot.id });
        const text = JSON.stringify(snapshot);
        for (const internal of [
          fixtureKey,
          "runtime_checkpoint",
          "effectOccurrences",
          "ownInstructionsBaseline",
        ])
          expect(text).not.toContain(internal);
        return text;
      },
      mainWrites() {
        return writes.mock.calls.filter(([, , context]) => context.runId === sent.runId);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function pausedBatch(context: TranscriptContext): AssistantMessage["content"] {
  expect(getCurrentSystemPrompt(context.messages)).toContain(instructions);
  expect(JSON.stringify(context.messages)).toContain(historyText);
  expect(JSON.stringify(context.messages)).toContain(prompt);
  return [
    { type: "text", text: beforeText },
    call("first-write", "write_file", { path: firstPath, content: "first-once-canary" }),
    // One sequential core tool makes the entire real SDK batch an unstarted-tail checkpoint.
    call("schedule-barrier", "schedule_list"),
    call("pending-question", "ask_user", {
      question: "Should I continue with the saved files?",
      options: [choiceLabel, "Stop."],
    }),
    call("tail-write", "write_file", { path: tailPath, content: "tail-once-canary" }),
  ];
}

describe.skipIf(!enabled)("durable Pi turn checkpoint product execution", () => {
  it("resumes the same run in a fresh Pi instance without replaying completed effects or losing the sequential tail", async () => {
    const f = await fixture([
      pausedBatch,
      (context) => {
        expect(getCurrentSystemPrompt(context.messages)).toContain(instructions);
        const text = JSON.stringify(context.messages);
        for (const canary of [historyText, prompt, beforeText, choiceLabel])
          expect(text).toContain(canary);
        expect(
          context.messages
            .filter((message) => message.role === "toolResult")
            .map((message) => message.toolCallId),
        ).toEqual(["first-write", "schedule-barrier", "pending-question", "tail-write"]);
        expect(JSON.stringify(toolResult(context, "pending-question").content)).toContain(
          choiceLabel,
        );
        for (const id of ["first-write", "tail-write"])
          expect(toolResult(context, id)).toMatchObject({ isError: false });
        return [{ type: "text", text: afterText }];
      },
    ]);
    try {
      await f.continueRun("checkpoint-first-worker");
      const paused = await f.app.prisma.run.findUniqueOrThrow({ where: { id: f.sent.runId } });
      expect(paused).toMatchObject({ status: "waiting_input", leaseFence: 1, leaseOwner: null });
      const { row, saved } = await f.checkpoint();
      expect(saved).toMatchObject({
        version: 1,
        provider: model.provider,
        model: model.id,
        pendingToolCallId: "pending-question",
        executionMode: "sequential",
        ownInstructionsBaseline: instructions,
      });
      expect(saved.systemPrompt).toContain(instructions);
      expect(saved.historyMessageIds).toContain(f.history.id);
      expect(saved.effectOccurrences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            executionId: JSON.stringify(["pi-tool", "main", "first-write"]),
            occurrence: 0,
          }),
        ]),
      );
      expect(
        saved.effectOccurrences?.every((entry) => Number.isSafeInteger(entry.occurrence)),
      ).toBe(true);
      expect(
        saved.effectOccurrences?.some((entry) => entry.executionId.includes("tail-write")),
      ).toBe(false);
      const firstEffect = await f.app.prisma.externalEffect.findFirstOrThrow({
        where: { runId: f.sent.runId, kind: "write_file" },
      });
      expect(firstEffect.status).toBe("completed");
      expect(f.mainWrites().map(([, file]) => file.path)).toEqual([
        expect.stringContaining(firstPath),
      ]);
      expect(
        [...f.sandbox.boxes.values()]
          .flatMap((box) => [...box.files.keys()])
          .some((file) => file.endsWith(tailPath)),
      ).toBe(false);
      expect(f.providerRequests).toHaveLength(1);
      expect(f.reservations).toBe(1);
      await f.clientSnapshot();

      await f.restartRuntime();
      await f.answer();
      const answered = await f.app.prisma.task.findUniqueOrThrow({ where: { id: paused.taskId } });
      expect(answered.prompt).toBe(`Selected choice choice-1: ${choiceLabel}`);
      await f.continueRun("checkpoint-resume-worker");
      expect(
        await f.app.prisma.run.findUniqueOrThrow({ where: { id: f.sent.runId } }),
      ).toMatchObject({ status: "completed", leaseFence: 2, leaseOwner: null });
      expect(f.providerRequests.map((request) => request.generation)).toEqual([1, 2]);
      expect(f.reservations).toBe(2);
      expect(f.runtimeRequests.filter((request) => request.runId === f.sent.runId)).toEqual([
        { generation: 1, runId: f.sent.runId, checkpoint: undefined },
        { generation: 2, runId: f.sent.runId, checkpoint: row.result },
      ]);
      expect(f.mainWrites().map(([, file]) => file.path)).toEqual([
        expect.stringContaining(firstPath),
        expect.stringContaining(tailPath),
      ]);
      for (const [file, content] of [
        [firstPath, "first-once-canary"],
        [tailPath, "tail-once-canary"],
      ])
        expect(await f.rpc("computer/readFile", { botId: f.bot.id, path: file })).toMatchObject({
          content,
        });
      expect(
        await f.app.prisma.externalEffect.findUnique({ where: { idempotencyKey: f.key } }),
      ).toBeNull();
      const effects = await f.app.prisma.externalEffect.findMany({
        where: { runId: f.sent.runId, kind: "write_file" },
        orderBy: { createdAt: "asc" },
      });
      expect(effects).toHaveLength(2);
      expect(effects[0]).toEqual(firstEffect);
      expect(effects.every((effect) => effect.status === "completed")).toBe(true);
      expect(
        await f.app.prisma.attempt.findMany({
          where: { runId: f.sent.runId },
          orderBy: { fence: "asc" },
          select: { fence: true, status: true, finishedAt: true },
        }),
      ).toEqual([
        { fence: 1, status: "waiting_input", finishedAt: expect.any(Date) },
        { fence: 2, status: "completed", finishedAt: expect.any(Date) },
      ]);
      const events = await f.app.prisma.event.findMany({
        where: { runId: f.sent.runId, type: "agent.tool.called" },
        orderBy: { seq: "asc" },
      });
      expect(events.map((event) => (event.payload as { name: string }).name)).toEqual([
        "write_file",
        "schedule_list",
        "ask_user",
        "write_file",
      ]);
      const commands = await f.rpc<
        Array<{ executionId: string; kind: string; command: string; status: string }>
      >("computer/commands", { botId: f.bot.id });
      expect(
        commands
          .filter((command) => command.kind === "write_file")
          .map(({ executionId, command, status }) => ({ executionId, command, status })),
      ).toEqual([
        {
          executionId: JSON.stringify(["pi-tool", "main", "first-write"]),
          command: firstPath,
          status: "done",
        },
        {
          executionId: JSON.stringify(["pi-tool", "main", "tail-write"]),
          command: tailPath,
          status: "done",
        },
      ]);
      const client = await f.clientSnapshot();
      expect(client).toContain(beforeText);
      expect(client).toContain(afterText);
      expect(
        await f.app.prisma.run.count({
          where: {
            botId: f.bot.id,
            status: { in: ["queued", "leased", "running", "waiting_input"] },
          },
        }),
      ).toBe(0);
    } finally {
      await f.close();
    }
  }, 45_000);

  it("fails a saved sequential turn before any new model or tool when its pending tail is disabled", async () => {
    const f = await fixture([pausedBatch]);
    try {
      await f.continueRun("checkpoint-disable-first");
      await f.checkpoint();
      const firstEffect = await f.app.prisma.externalEffect.findFirstOrThrow({
        where: { runId: f.sent.runId, kind: "write_file" },
      });
      await f.rpc("bots/update", { botId: f.bot.id, disabledBuiltinTools: ["write_file"] });
      await f.restartRuntime();
      await f.answer();
      await f.continueRun("checkpoint-disable-resume");
      expect(
        await f.app.prisma.run.findUniqueOrThrow({ where: { id: f.sent.runId } }),
      ).toMatchObject({
        status: "failed",
        leaseFence: 2,
        error: "Saved turn checkpoint could not be restored",
      });
      expect(f.providerRequests).toHaveLength(1);
      expect(f.reservations).toBe(1);
      expect(f.mainWrites().map(([, file]) => file.path)).toEqual([
        expect.stringContaining(firstPath),
      ]);
      expect(
        await f.app.prisma.externalEffect.findUniqueOrThrow({ where: { id: firstEffect.id } }),
      ).toEqual(firstEffect);
      expect(
        await f.app.prisma.externalEffect.findUnique({ where: { idempotencyKey: f.key } }),
      ).toBeNull();
      expect(
        await f.app.prisma.attempt.findMany({
          where: { runId: f.sent.runId },
          orderBy: { fence: "asc" },
          select: { fence: true, status: true },
        }),
      ).toEqual([
        { fence: 1, status: "waiting_input" },
        { fence: 2, status: "failed" },
      ]);
      const client = await f.clientSnapshot();
      expect(client).not.toContain(afterText);
    } finally {
      await f.close();
    }
  }, 45_000);

  it.each([
    {
      label: "unknown version",
      blob: JSON.stringify({ version: 999, privateTranscript: "PRIVATE-BAD-CHECKPOINT-CANARY" }),
    },
    { label: "malformed JSON", blob: "{PRIVATE-BAD-CHECKPOINT-CANARY" },
  ])(
    "fails closed on a present $label checkpoint without a fresh model or tool execution",
    async ({ blob }) => {
      const f = await fixture([]);
      try {
        await f.app.prisma.externalEffect.create({
          data: {
            runId: f.sent.runId,
            spaceId: f.me.spaceId,
            idempotencyKey: f.key,
            kind: "runtime_checkpoint",
            status: "runtime_checkpoint",
            request: {},
            result: blob,
          },
        });
        const retained = await f.app.prisma.externalEffect.create({
          data: {
            runId: f.sent.runId,
            spaceId: f.me.spaceId,
            idempotencyKey: JSON.stringify(["confirmed-fixture-effect", f.sent.runId]),
            kind: "write_file",
            status: "completed",
            request: { path: "confirmed-before-fixture.txt" },
            result: { receipt: "synthetic-confirmed-effect" },
          },
        });
        await f.continueRun("checkpoint-invalid-worker");
        expect(
          await f.app.prisma.run.findUniqueOrThrow({ where: { id: f.sent.runId } }),
        ).toMatchObject({
          status: "failed",
          leaseFence: 1,
          error: "Saved turn checkpoint could not be restored",
        });
        expect(f.providerRequests).toHaveLength(0);
        expect(f.reservations).toBe(0);
        expect(f.mainWrites()).toHaveLength(0);
        expect(f.runtimeRequests.filter((request) => request.runId === f.sent.runId)).toHaveLength(
          0,
        );
        expect(
          await f.app.prisma.event.count({
            where: { runId: f.sent.runId, type: "agent.tool.called" },
          }),
        ).toBe(0);
        expect(
          await f.app.prisma.externalEffect.findMany({ where: { runId: f.sent.runId } }),
        ).toEqual([retained]);
        expect(
          await f.app.prisma.attempt.findMany({
            where: { runId: f.sent.runId },
            select: { fence: true, status: true },
          }),
        ).toEqual([{ fence: 1, status: "failed" }]);
        expect(await f.clientSnapshot()).not.toContain("PRIVATE-BAD-CHECKPOINT-CANARY");
      } finally {
        await f.close();
      }
    },
    45_000,
  );
});

describe.skipIf(!enabled)("parallel Pi approval checkpoint ownership", () => {
  it("binds the sole card to its saved call and resumes only that approved parallel operation", async () => {
    const commands = [
      "echo checkpoint-parallel-candidate-a",
      "echo checkpoint-parallel-candidate-b",
    ];
    const callIds = ["parallel-shell-a", "parallel-shell-b"];
    const calls = commands.map((command, index) => call(callIds[index]!, "shell", { command }));
    const parallelPrompt = "Run the two synthetic echo commands after owner approval.";
    let runId = "";
    let approvedCallId = "";
    let siblingCallId = "";
    let approvedCommand = "";
    const created: CreatedEffect[] = [];
    let release!: () => void;
    const bothCreated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(
      [
        (context) => {
          expect(JSON.stringify(context.messages)).toContain(parallelPrompt);
          return calls;
        },
        (context) => {
          expect(toolResult(context, approvedCallId)).toMatchObject({ isError: false });
          const sibling = toolResult(context, siblingCallId);
          expect(sibling.isError).toBe(true);
          const siblingText = sibling.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
          expect(JSON.parse(siblingText)).toMatchObject({ uncertain: true });
          expect(siblingText).toContain("was not replayed");
          return [{ type: "text", text: "Completed only the operation you approved." }];
        },
      ],
      {
        prompt: parallelPrompt,
        async afterEffectCreate(effect) {
          if (effect.runId !== runId || effect.kind !== "shell") return;
          // query(args) has already committed each real intended row. No transaction lock is held.
          created.push(effect);
          await bothCreated;
        },
        releaseEffectBarrier: () => release(),
      },
    );
    runId = f.sent.runId;
    const execute = vi.spyOn(f.sandbox, "execute");
    let firstAttempt: Promise<void> | undefined;
    let firstFailure: unknown;
    try {
      await f.rpc("approvalRules/set", {
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "shell",
      });
      firstAttempt = f.continueRun("parallel-approval-first-worker").catch((error) => {
        firstFailure = error;
      });
      await expect.poll(() => created.length, { timeout: 10_000, interval: 20 }).toBe(2);
      expect(
        created.map((effect) => (effect.request as { command: string }).command).sort(),
      ).toEqual([...commands].sort());
      release();
      await firstAttempt;
      if (firstFailure) throw firstFailure;
      expect(await f.app.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: "waiting_input",
        leaseFence: 1,
      });
      const messages = await f.app.prisma.message.findMany({
        where: { runId, role: "bot" },
        orderBy: { seq: "asc" },
      });
      const cards = messages.flatMap((message) =>
        MessageBlockSchema.array()
          .parse(message.blocks)
          .flatMap((block) =>
            block.kind === "ask" && block.approvalEffectId ? [{ message, block }] : [],
          ),
      );
      expect(cards).toHaveLength(1);
      const card = cards[0]!;
      expect(card.block.status).toBe("pending");
      const effectsBefore = await f.app.prisma.externalEffect.findMany({
        where: { runId, kind: "shell" },
        orderBy: { createdAt: "asc" },
      });
      expect(effectsBefore).toHaveLength(2);
      expect(effectsBefore.every((effect) => effect.status === "intended")).toBe(true);
      const approvedEffect = effectsBefore.find(
        (effect) => effect.id === card.block.approvalEffectId,
      );
      expect(approvedEffect).toBeDefined();
      approvedCommand = (approvedEffect!.request as { command: string }).command;
      expect(commands).toContain(approvedCommand);
      approvedCallId = callIds[commands.indexOf(approvedCommand)]!;
      siblingCallId = callIds.find((id) => id !== approvedCallId)!;
      const siblingBefore = effectsBefore.find((effect) => effect.id !== approvedEffect!.id)!;
      const { row, saved } = await f.checkpoint();
      expect(saved).toMatchObject({ executionMode: "parallel", pendingToolCallId: approvedCallId });
      expect(
        saved.messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content.filter((part) => part.type === "toolCall").map((part) => part.id)
            : [],
        ),
      ).toEqual(callIds);
      expect(execute.mock.calls.filter(([, , context]) => context.runId === runId)).toHaveLength(0);
      expect(f.providerRequests).toHaveLength(1);
      expect(f.reservations).toBe(1);
      await f.clientSnapshot();

      await f.restartRuntime();
      await f.rpc("threads/answer", {
        botId: f.bot.id,
        runId,
        messageId: card.message.id,
        answer: "allow",
      });
      expect(
        await f.app.prisma.externalEffect.findUniqueOrThrow({ where: { id: approvedEffect!.id } }),
      ).toMatchObject({ status: "approved" });
      await f.continueRun("parallel-approval-resume-worker");
      expect(await f.app.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: "completed",
        leaseFence: 2,
      });
      expect(f.providerRequests.map((request) => request.generation)).toEqual([1, 2]);
      expect(f.reservations).toBe(2);
      expect(f.runtimeRequests.filter((request) => request.runId === runId)[1]).toMatchObject({
        generation: 2,
        checkpoint: row.result,
      });
      const actualShellCalls = execute.mock.calls.filter(
        ([, request, context]) =>
          context.runId === runId && request.argv.some((arg) => commands.includes(arg)),
      );
      expect(actualShellCalls).toHaveLength(1);
      expect(actualShellCalls[0]![1].argv).toContain(approvedCommand);
      expect(
        execute.mock.calls.some(
          ([, request, context]) =>
            context.runId === runId &&
            request.argv.some((arg) => commands.includes(arg) && arg !== approvedCommand),
        ),
      ).toBe(false);
      const computerCommands = await f.rpc<
        Array<{ kind: string; command: string; executionId: string; status: string }>
      >("computer/commands", { botId: f.bot.id });
      expect(computerCommands.filter((command) => command.kind === "shell")).toEqual([
        expect.objectContaining({
          command: approvedCommand,
          status: "done",
          executionId: JSON.stringify(["pi-tool", "main", approvedCallId]),
        }),
      ]);
      const effectsAfter = await f.app.prisma.externalEffect.findMany({
        where: { runId, kind: "shell" },
      });
      expect(effectsAfter).toHaveLength(2);
      expect(effectsAfter.find((effect) => effect.id === approvedEffect!.id)).toMatchObject({
        status: "completed",
        request: approvedEffect!.request,
      });
      expect(effectsAfter.find((effect) => effect.id === siblingBefore.id)).toEqual(siblingBefore);
      expect(
        await f.app.prisma.externalEffect.findUnique({ where: { idempotencyKey: f.key } }),
      ).toBeNull();
      const finalMessages = await f.app.prisma.message.findMany({ where: { runId, role: "bot" } });
      expect(
        finalMessages
          .flatMap((message) => MessageBlockSchema.array().parse(message.blocks))
          .filter((block) => block.kind === "ask" && block.approvalEffectId),
      ).toHaveLength(1);
      const toolEvents = await f.app.prisma.event.findMany({
        where: { runId, type: "agent.tool.called" },
        select: { payload: true },
      });
      const executionIds = toolEvents.map(
        (event) => (event.payload as { executionId: string }).executionId,
      );
      expect(executionIds).toHaveLength(3);
      expect(
        executionIds.filter((id) => id === JSON.stringify(["pi-tool", "main", approvedCallId])),
      ).toHaveLength(2);
      expect(
        executionIds.filter((id) => id === JSON.stringify(["pi-tool", "main", siblingCallId])),
      ).toHaveLength(1);
      await f.clientSnapshot();
    } finally {
      release();
      await firstAttempt;
      try {
        await f.close();
      } finally {
        execute.mockRestore();
      }
    }
  }, 45_000);
});
