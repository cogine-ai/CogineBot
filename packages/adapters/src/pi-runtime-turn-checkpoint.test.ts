import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  JsonObject,
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
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentToolExecutionResult,
  ConnectorRoute,
  ConnectorTool,
  ModelCallObserver,
} from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approvalPausedToolResult } from "./approval-effect.js";
import { USE_TOOL } from "./builtin-tool-bridge.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { modelsForRequest, PiAgentRuntime } from "./pi-runtime.js";
import { piSessionBotRoot } from "./pi-session.js";
import type { RuntimeContextDecision } from "./runtime-context.js";
import type { TurnCheckpoint } from "./turn-checkpoint.js";

const provider = { stream: vi.fn() };

const model: Model<"openai-completions"> = {
  provider: "offline-checkpoint",
  id: "first-model",
  name: "Offline checkpoint fixture",
  api: "openai-completions",
  baseUrl: "https://models.invalid/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 1_024,
};
const alternateModel: Model<"openai-completions"> = { ...model, id: "second-model" };

function fixtureModels(): MutableModels {
  return modelsForRequest(
    { model: { provider: model.provider, id: model.id, apiKey: "fixture" } },
    model.provider,
  ) as MutableModels;
}

function registerFixtureProvider(extraModels: Model<Api>[] = []) {
  fixtureModels().setProvider(
    createProvider({
      id: model.provider,
      models: [model, alternateModel, ...extraModels],
      auth: {
        apiKey: {
          name: "Offline fixture",
          resolve: async () => ({ auth: { apiKey: "fixture" }, source: "fixture" }),
        },
      },
      api: {
        stream: (...args) => provider.stream(...args),
        streamSimple: (...args) => provider.stream(...args),
      },
    }),
  );
}

function response(
  content: AssistantMessage["content"] = [{ type: "text", text: "Done." }],
  activeModel: Model<Api> = model,
) {
  const calls = content.filter((part) => part.type === "toolCall");
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
    stopReason: calls.length ? "toolUse" : "stop",
    timestamp: 1,
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [] } });
  for (const [contentIndex, part] of content.entries()) {
    if (part.type !== "toolCall") continue;
    stream.push({ type: "toolcall_start", contentIndex, partial: message });
    stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
  }
  stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message });
  stream.end(message);
  return stream;
}

function unavailableResponse(activeModel: Model<Api>) {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: activeModel.api,
    provider: activeModel.provider,
    model: activeModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "HTTP 402 synthetic provider quota exhausted",
    timestamp: 1,
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "error", reason: "error", error: message });
  stream.end(message);
  return stream;
}

function call(id: string, name: string, args: ToolCall["arguments"] = {}): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function builtin(name: string): ConnectorTool {
  const tool = builtinAgentTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing fixture tool ${name}`);
  return tool;
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}
const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

let ordinal = 0;
function request(
  tools: ConnectorTool[],
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    botId: "checkpoint-bot",
    threadId: "checkpoint-thread",
    runId: `checkpoint-run-${++ordinal}`,
    prompt: "Finish the pending work.",
    instructions: "Original instruction baseline.",
    history: [{ id: "history-original", role: "user", content: "Original history canary." }],
    contextStrategy: "current",
    model: { provider: model.provider, id: model.id, apiKey: "fixture" },
    tools,
    ...overrides,
  };
}

async function consume(input: AgentRunRequest, runtime = new PiAgentRuntime()) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(input, { signal: new AbortController().signal }))
    events.push(event);
  return events;
}

function captures() {
  const callbacks = new Map<string, () => string>();
  return {
    callbacks,
    onCheckpoint: (capture: () => string, executionId: string) => {
      callbacks.set(executionId, capture);
    },
    at(executionId: string) {
      const capture = callbacks.get(executionId);
      if (!capture) throw new Error(`No runtime capture for ${executionId}`);
      return JSON.stringify(JSON.parse(capture()));
    },
  };
}

function result(context: TranscriptContext, id: string) {
  const message = context.messages.findLast(
    (candidate) => candidate.role === "toolResult" && candidate.toolCallId === id,
  );
  if (message?.role !== "toolResult") throw new Error(`Missing result ${id}`);
  return message;
}
function resultText(context: TranscriptContext, id: string) {
  return result(context, id)
    .content.flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

async function capturedApproval(
  extra: Partial<AgentRunRequest> = {},
  pendingCall = call("approval", "write_file", { path: "report.txt", content: "Pending write" }),
) {
  const store = captures();
  let blob: string | undefined;
  const input = request([builtin("write_file")], {
    ...extra,
    onCheckpoint: store.onCheckpoint,
    executeTool: async (_name, _args, executionId) => {
      blob = store.at(executionId);
      return approvalPausedToolResult();
    },
  });
  provider.stream.mockImplementationOnce(() => response([pendingCall]));
  const events = await consume(input);
  expect(blob).toBeDefined();
  expect(provider.stream).toHaveBeenCalledOnce();
  expect(events.filter((event) => event.type === "tool")).toHaveLength(1);
  return { input, blob: blob!, events };
}

async function capturedWrappedInteraction(name: "ask_user" | "request_takeover") {
  const store = captures();
  const args: JsonObject =
    name === "ask_user"
      ? { question: "Which option?", options: ["First", "Second"] }
      : { reason: "Finish the sign-in." };
  const input = request([builtin(name), builtin("scratchpad_add")], {
    onCheckpoint: store.onCheckpoint,
  });
  provider.stream.mockImplementationOnce(() =>
    response([call("wrapped-interaction", USE_TOOL, { name, arguments: args })]),
  );
  const events = await consume(input);
  const interaction = events.find((event) => event.type === "tool" && event.name === name);
  if (interaction?.type !== "tool") throw new Error("Missing wrapped interaction");
  const blob = store.at(interaction.executionId);
  expect((JSON.parse(blob) as TurnCheckpoint).pendingToolCallId).toBe("wrapped-interaction");
  provider.stream.mockReset();
  return { input, blob, executionId: interaction.executionId };
}

describe("real Pi turn checkpoint producer and recovery", () => {
  beforeEach(() => {
    provider.stream.mockReset();
    provider.stream.mockImplementation(() => {
      throw new Error("Unexpected extra model turn");
    });
    registerFixtureProvider();
    vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Unexpected network request"))),
    );
  });
  afterEach(() => {
    fixtureModels().deleteProvider(model.provider);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("captures a completed parallel sibling at the actual pause and does not redo it in a fresh runtime", async () => {
    const store = captures();
    const siblingFinished = barrier();
    let blob: string | undefined;
    const input = request([builtin("write_file"), builtin("read_file")], {
      onCheckpoint: store.onCheckpoint,
      onToolCompleted: (completion) => {
        if (completion.name === "read_file") siblingFinished.resolve();
      },
      executeTool: async (name, _args, executionId) => {
        if (name === "read_file") return { receipt: "Completed sibling receipt" };
        await siblingFinished.promise;
        await nextMacrotask();
        blob = store.at(executionId);
        return approvalPausedToolResult();
      },
    });
    provider.stream.mockImplementationOnce(() =>
      response([
        call("sibling", "read_file", { path: "input.txt" }),
        call("pending", "write_file", { path: "report.txt", content: "Exact approved content" }),
      ]),
    );
    const pausedEvents = await consume(input);
    expect(blob).toBeDefined();
    const checkpoint = JSON.parse(blob!) as TurnCheckpoint;
    expect(checkpoint.executionMode).toBe("parallel");
    expect(checkpoint.pendingToolCallId).toBe("pending");
    expect(checkpoint.historyMessageIds).toContain("history-original");
    expect(
      checkpoint.messages.some(
        (message) => message.role === "toolResult" && message.toolCallId === "sibling",
      ),
    ).toBe(true);
    expect(JSON.stringify(checkpoint.messages)).toContain("Completed sibling receipt");
    expect(JSON.stringify(pausedEvents)).not.toContain("pendingToolCallId");

    const resumedContexts: TranscriptContext[] = [];
    provider.stream
      .mockReset()
      .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
        resumedContexts.push(structuredClone(context));
        expect(resultText(context, "sibling")).toContain("Completed sibling receipt");
        expect(resultText(context, "pending")).toContain("Approved receipt");
        expect(getCurrentSystemPrompt(context.messages)).toContain(
          "Original instruction baseline.",
        );
        expect(getCurrentSystemPrompt(context.messages)).not.toContain("Changed live instruction.");
        return response(undefined, activeModel);
      });
    const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async () => ({
      receipt: "Approved receipt",
    }));
    await consume({
      ...input,
      instructions: "Changed live instruction.",
      prompt: "The user approved the pending write.",
      history: [
        ...input.history,
        { id: "history-new", role: "user", content: "New history after pause." },
      ],
      turnCheckpoint: blob,
      executeTool: execute,
    });
    expect(execute.mock.calls.map(([name, args]) => ({ name, args }))).toEqual([
      { name: "write_file", args: { path: "report.txt", content: "Exact approved content" } },
    ]);
    expect(resumedContexts).toHaveLength(1);
    const wire = JSON.stringify(resumedContexts[0]);
    expect(wire.split("Original history canary.")).toHaveLength(2);
    expect(wire.split("New history after pause.")).toHaveLength(2);
  });

  it("resumes an explicit sequential tail exactly once without repeating the completed prefix", async () => {
    const store = captures();
    const trace: string[] = [];
    let blob: string | undefined;
    const input = request([builtin("remember"), builtin("scratchpad_add"), builtin("read_file")], {
      onCheckpoint: store.onCheckpoint,
      executeTool: async (name, args, executionId) => {
        trace.push(`${name}:${args.title ?? args.content ?? args.path}`);
        if (name === "scratchpad_add") {
          blob = store.at(executionId);
          return approvalPausedToolResult();
        }
        return { receipt: "Prefix already committed" };
      },
    });
    provider.stream.mockImplementationOnce(() =>
      response([
        call("before", "remember", { content: "Retain this fact" }),
        call("pending", USE_TOOL, { name: "scratchpad_add", arguments: { title: "Pending item" } }),
        call("tail-read", "read_file", { path: "after.txt" }),
        call("tail-write", USE_TOOL, { name: "scratchpad_add", arguments: { title: "Tail item" } }),
      ]),
    );
    await consume(input);
    expect(trace).toEqual(["remember:Retain this fact", "scratchpad_add:Pending item"]);
    expect(JSON.parse(blob!).executionMode).toBe("sequential");
    provider.stream
      .mockReset()
      .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
        for (const id of ["before", "pending", "tail-read", "tail-write"])
          expect(result(context, id).isError).toBe(false);
        return response(undefined, activeModel);
      });
    const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async () => ({
      receipt: "Recovered",
    }));
    const events = await consume({ ...input, turnCheckpoint: blob, executeTool: execute });
    expect(execute.mock.calls.map(([name, args]) => ({ name, args }))).toEqual([
      { name: "scratchpad_add", args: { title: "Pending item" } },
      { name: "read_file", args: { path: "after.txt" } },
      { name: "scratchpad_add", args: { title: "Tail item" } },
    ]);
    expect(events.filter((event) => event.type === "tool").map((event) => event.name)).toEqual([
      "scratchpad_add",
      "read_file",
      "scratchpad_add",
    ]);
    expect(provider.stream).toHaveBeenCalledOnce();
  });

  it("keeps protected Page data out of the real Pi recorder and blocks an invalid saved tail before execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cogine-page-session-"));
    const store = captures();
    const userId = "fixture-owner";
    const secret = "fixture-page-protected-value";
    let blob: string | undefined;
    const input = request([builtin("write_file"), builtin("save_page")], {
      pageToolSecrets: () => [secret],
      onCheckpoint: store.onCheckpoint,
      executeTool: async (name, _args, executionId) => {
        if (name === "save_page") return { pageId: "page-1", source: secret };
        blob = store.at(executionId);
        return approvalPausedToolResult();
      },
    });
    const runtime = new PiAgentRuntime({ sessionRoot: directory });
    const consumeWithRecorder = async (request: AgentRunRequest) => {
      for await (const _ of runtime.run(request, {
        userId,
        signal: new AbortController().signal,
      })) {
        // Consume the real runtime until completion or the persisted pause.
      }
    };
    try {
      provider.stream.mockImplementationOnce(() =>
        response([
          call("read-page", USE_TOOL, { name: "save_page", arguments: { pageId: "page-1" } }),
          call("pending", "write_file", { path: "report.txt", content: "Exact pending body" }),
          call("unsafe-page", USE_TOOL, {
            name: "save_page",
            arguments: { title: "Draft", source: secret },
          }),
          call("safe-page", USE_TOOL, { name: "save_page", arguments: { help: true } }),
        ]),
      );
      await consumeWithRecorder(input);
      expect(blob).toContain(secret);

      provider.stream.mockImplementationOnce(
        (activeModel: Model<Api>, context: TranscriptContext) => {
          expect(resultText(context, "read-page")).toContain("[redacted]");
          expect(resultText(context, "unsafe-page")).toContain("invalid or protected arguments");
          expect(resultText(context, "safe-page")).toContain("Resumed safely");
          expect(JSON.stringify(context)).not.toContain(secret);
          return response(undefined, activeModel);
        },
      );
      const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async () => ({
        receipt: "Resumed safely",
      }));
      // Supply the original pre-filter capture to exercise the independent restore boundary.
      await consumeWithRecorder({ ...input, turnCheckpoint: blob, executeTool: execute });
      expect(execute.mock.calls.map(([name, args]) => [name, args])).toEqual([
        ["write_file", { path: "report.txt", content: "Exact pending body" }],
        ["save_page", { help: true }],
      ]);

      const owner = piSessionBotRoot(directory, userId, input.botId);
      const files = await readdir(owner);
      expect(files).toHaveLength(2);
      const jsonl = (
        await Promise.all(files.map((file) => readFile(join(owner, file), "utf8")))
      ).join("\n");
      expect(jsonl).toContain("Exact pending body");
      expect(jsonl).toContain("[redacted]");
      expect(jsonl).not.toContain(secret);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["ask_user", "request_takeover"] as const)(
    "resumes %s with the supplied result without issuing the interaction again",
    async (name) => {
      const store = captures();
      const args: JsonObject =
        name === "ask_user"
          ? { question: "Which option?", options: ["First", "Second"] }
          : { reason: "Please finish the sign-in." };
      const input = request([builtin(name)], { onCheckpoint: store.onCheckpoint });
      provider.stream.mockImplementationOnce(() => response([call("interaction", name, args)]));
      const paused = await consume(input);
      expect(
        paused.some((event) => event.type === (name === "ask_user" ? "ask" : "takeover")),
      ).toBe(true);
      const toolEvent = paused.find((event) => event.type === "tool" && event.name === name);
      if (toolEvent?.type !== "tool") throw new Error("Missing paused interaction identity");
      const blob = store.at(toolEvent.executionId);
      expect(JSON.parse(blob).pendingToolCallId).toBe("interaction");
      provider.stream
        .mockReset()
        .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
          expect(resultText(context, "interaction")).toContain("Chosen response receipt");
          return response(undefined, activeModel);
        });
      const execute = vi.fn(async () => ({ ok: true }));
      const resumed = await consume({
        ...input,
        prompt: "Continue after the user replied.",
        turnCheckpoint: blob,
        resumeToolResult: {
          kind: "agent_tool_result",
          content: [{ type: "text", text: "Chosen response receipt" }],
          details: {},
        },
        executeTool: execute,
      });
      expect(execute).not.toHaveBeenCalled();
      expect(resumed.some((event) => event.type === "ask" || event.type === "takeover")).toBe(
        false,
      );
      expect(provider.stream).toHaveBeenCalledOnce();
    },
  );

  it.each(["release", "skip", "prompt"] as const)(
    "restores a wrapped takeover with the %s response without replaying it",
    async (kind) => {
      const { input, blob } = await capturedWrappedInteraction("request_takeover");
      const note = `Verified ${kind} response: continue without assuming sign-in completed.`;
      provider.stream.mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
        expect(resultText(context, "wrapped-interaction")).toBe(note);
        expect(result(context, "wrapped-interaction").toolName).toBe(USE_TOOL);
        return response(undefined, activeModel);
      });
      const execute = vi.fn(async () => ({ takeover: "requested" }));
      const events = await consume({
        ...input,
        prompt: note,
        turnCheckpoint: blob,
        ...(kind === "prompt"
          ? {}
          : {
              resumeToolResult: {
                kind: "agent_tool_result" as const,
                content: [{ type: "text" as const, text: note }],
                details: {},
              },
            }),
        executeTool: execute,
      });
      expect(execute).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === "takeover" || event.type === "ask")).toBe(false);
      expect(provider.stream).toHaveBeenCalledOnce();
    },
  );

  it("restores a wrapped question with its supplied answer", async () => {
    const { input, blob } = await capturedWrappedInteraction("ask_user");
    provider.stream.mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
      expect(resultText(context, "wrapped-interaction")).toBe("Selected First");
      return response(undefined, activeModel);
    });
    const execute = vi.fn(async () => ({ ok: true }));
    await consume({
      ...input,
      turnCheckpoint: blob,
      resumeToolResult: {
        kind: "agent_tool_result",
        content: [{ type: "text", text: "Selected First" }],
        details: {},
      },
      executeTool: execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(provider.stream).toHaveBeenCalledOnce();
  });

  it("still executes an unapproved wrapped takeover through its original authorization path", async () => {
    const { input, blob, executionId } = await capturedWrappedInteraction("request_takeover");
    const execute = vi.fn(async () => approvalPausedToolResult());
    await consume({
      ...input,
      turnCheckpoint: blob,
      resumeUnreleasedTakeoverExecutionId: executionId,
      executeTool: execute,
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "request_takeover",
      { reason: "Finish the sign-in." },
      executionId,
      undefined,
    );
    expect(provider.stream).not.toHaveBeenCalled();
  });

  it.each(["missing target", "malformed wrapper", "invalid question"] as const)(
    "preserves the wrapped restore error for %s",
    async (kind) => {
      const { input, blob } = await capturedWrappedInteraction(
        kind === "invalid question" ? "ask_user" : "request_takeover",
      );
      const checkpoint = JSON.parse(blob) as TurnCheckpoint;
      for (const message of checkpoint.messages) {
        if (message.role !== "assistant") continue;
        for (const pending of message.content) {
          if (pending.type !== "toolCall" || pending.id !== "wrapped-interaction") continue;
          if (kind === "malformed wrapper") pending.arguments.name = 42;
          if (kind === "invalid question") {
            pending.arguments.arguments = { question: "Which option?", options: [] };
          }
        }
      }
      provider.stream.mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
        expect(result(context, "wrapped-interaction").isError).toBe(true);
        expect(resultText(context, "wrapped-interaction")).not.toContain("SHOULD NOT RESUME");
        return response(undefined, activeModel);
      });
      const execute = vi.fn(async () => ({ takeover: "requested" }));
      await consume({
        ...input,
        ...(kind === "missing target" ? { tools: [builtin("scratchpad_add")] } : {}),
        turnCheckpoint: JSON.stringify(checkpoint),
        prompt: "SHOULD NOT RESUME",
        executeTool: execute,
      });
      expect(execute).not.toHaveBeenCalled();
      expect(provider.stream).toHaveBeenCalledOnce();
    },
  );

  it("does not treat an ordinary connector named use_tool as the built-in bridge", async () => {
    const store = captures();
    const connector: ConnectorTool = {
      name: USE_TOOL,
      description: "A synthetic connector, not the built-in dispatcher",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, arguments: { type: "object" } },
        required: ["name", "arguments"],
      },
      route: { connectorId: "custom", toolName: USE_TOOL },
    };
    let blob: string | undefined;
    const input = request([connector, builtin("ask_user")], {
      onCheckpoint: store.onCheckpoint,
      executeTool: async (_name, _args, executionId) => {
        blob = store.at(executionId);
        return approvalPausedToolResult();
      },
    });
    const args = { name: "ask_user", arguments: { question: "Not an interaction" } };
    provider.stream.mockImplementationOnce(() => response([call("custom-call", USE_TOOL, args)]));
    await consume(input);
    expect(blob).toBeDefined();
    provider.stream
      .mockReset()
      .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
        expect(resultText(context, "custom-call")).toContain("custom receipt");
        return response(undefined, activeModel);
      });
    const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async () => ({
      receipt: "custom receipt",
    }));
    await consume({ ...input, turnCheckpoint: blob!, executeTool: execute });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]!.slice(0, 4)).toEqual([
      USE_TOOL,
      args,
      JSON.stringify(["pi-tool", "main", "custom-call"]),
      connector.route,
    ]);
    expect(provider.stream).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "does not replay an unknown parallel sibling, including a reused wire ID (%s)",
    async (reuseWireId) => {
      const store = captures();
      const siblingStarted = barrier();
      const releaseSibling = barrier();
      const pauseCaptured = barrier();
      let blob: string | undefined;
      let sourceEffects = 0;
      const sibling: ConnectorTool = {
        name: "send_record",
        description: "Write one synthetic record",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      };
      const input = request([builtin("write_file"), builtin("read_file"), sibling], {
        onCheckpoint: store.onCheckpoint,
        executeTool: async (name, _args, executionId) => {
          if (name === "read_file") return { receipt: "Old response receipt" };
          if (name === "send_record") {
            sourceEffects += 1;
            siblingStarted.resolve();
            await releaseSibling.promise;
            return { receipt: "Late sibling receipt" };
          }
          await siblingStarted.promise;
          blob = store.at(executionId);
          pauseCaptured.resolve();
          return approvalPausedToolResult();
        },
      });
      if (reuseWireId)
        provider.stream.mockImplementationOnce(() =>
          response([call("reused", "read_file", { path: "earlier.txt" })]),
        );
      provider.stream.mockImplementationOnce(() =>
        response([
          call("pending", "write_file", { path: "approved.txt", content: "Approved" }),
          call("reused", "send_record", { id: "record-once" }),
        ]),
      );
      const originalWork = consume(input);
      try {
        await Promise.race([pauseCaptured.promise, originalWork]);
        expect(blob).toBeDefined();
        const saved = JSON.parse(blob!) as TurnCheckpoint;
        expect(saved.executionMode).toBe("parallel");
        const latestAssistant = saved.messages.findLastIndex(
          (message) => message.role === "assistant",
        );
        expect(
          saved.messages
            .slice(latestAssistant + 1)
            .some((message) => message.role === "toolResult" && message.toolCallId === "reused"),
        ).toBe(false);
      } finally {
        releaseSibling.resolve();
        await originalWork;
      }
      provider.stream
        .mockReset()
        .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
          const uncertain = result(context, "reused");
          expect(uncertain.isError).toBe(true);
          expect(resultText(context, "reused")).toContain('"uncertain":true');
          expect(resultText(context, "reused")).not.toContain("Old response receipt");
          expect(resultText(context, "reused")).not.toContain("Late sibling receipt");
          return response(undefined, activeModel);
        });
      const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async () => ({
        receipt: "Approved write receipt",
      }));
      await consume({ ...input, turnCheckpoint: blob, executeTool: execute });
      expect(sourceEffects).toBe(1);
      expect(execute.mock.calls.map(([name]) => name)).toEqual(["write_file"]);
    },
  );

  it.each([
    [
      "unsupported version",
      (saved: Record<string, unknown>) => {
        saved.version = 2;
      },
    ],
    [
      "malformed messages",
      (saved: Record<string, unknown>) => {
        saved.messages = [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "bad", name: "write_file", arguments: [] }],
          },
        ];
      },
    ],
    [
      "invalid execution mode",
      (saved: Record<string, unknown>) => {
        saved.executionMode = "guess";
      },
    ],
  ] as const)("refuses %s before model or tool dispatch", async (_label, corrupt) => {
    const captured = await capturedApproval();
    const saved = JSON.parse(captured.blob);
    corrupt(saved);
    const execute = vi.fn(async () => ({ ok: true }));
    provider.stream.mockReset().mockImplementation(() => response());
    await expect(
      consume({ ...captured.input, turnCheckpoint: JSON.stringify(saved), executeTool: execute }),
    ).rejects.toThrow("Unsupported turn checkpoint");
    expect(execute).not.toHaveBeenCalled();
    expect(provider.stream).not.toHaveBeenCalled();
  });

  it("refuses a removed pending tool without replaying the original prompt", async () => {
    const captured = await capturedApproval();
    const execute = vi.fn(async () => ({ ok: true }));
    provider.stream.mockReset().mockImplementation(() => response());
    await expect(
      consume({
        ...captured.input,
        tools: [],
        turnCheckpoint: captured.blob,
        executeTool: execute,
      }),
    ).rejects.toThrow("no longer available");
    expect(execute).not.toHaveBeenCalled();
    expect(provider.stream).not.toHaveBeenCalled();
  });

  it("validates a restored pending call against the current schema and reports the error without executing", async () => {
    const original: ConnectorTool = {
      name: "submit_record",
      description: "Submit one synthetic record",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    };
    const captured = await capturedApproval(
      { tools: [original] },
      call("approval", "submit_record", { id: "original-id" }),
    );
    const execute = vi.fn(async () => ({ ok: true }));
    const narrowed = {
      ...original,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", enum: ["different-id"] } },
        required: ["id"],
      },
    };
    provider.stream
      .mockReset()
      .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
        expect(result(context, "approval").isError).toBe(true);
        expect(resultText(context, "approval")).toMatch(/id|validation|argument/i);
        expect(JSON.stringify(context.messages)).toContain("Original history canary.");
        return response(undefined, activeModel);
      });
    await consume({
      ...captured.input,
      tools: [narrowed],
      turnCheckpoint: captured.blob,
      executeTool: execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(provider.stream).toHaveBeenCalledOnce();
  });

  it("rechecks live permission before a saved inner call is resumed", async () => {
    const captured = await capturedApproval();
    const execute = vi.fn(async () => ({ ok: true }));
    provider.stream
      .mockReset()
      .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
        expect(result(context, "approval").isError).toBe(true);
        expect(resultText(context, "approval")).toContain("no longer available");
        return response(undefined, activeModel);
      });
    await consume({
      ...captured.input,
      turnCheckpoint: captured.blob,
      availableToolNames: async () => [],
      executeTool: execute,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["aborted", "error"] as const)(
    "drops a failed assistant tail and old thinking when the model changes (%s)",
    async (stopReason) => {
      const store = captures();
      let blob: string | undefined;
      const input = request([builtin("write_file")], {
        onCheckpoint: store.onCheckpoint,
        executeTool: async (_name, _args, executionId) => {
          blob = store.at(executionId);
          return approvalPausedToolResult();
        },
      });
      provider.stream.mockImplementationOnce(() =>
        response([
          {
            type: "thinking",
            thinking: "Old model private thinking canary",
            thinkingSignature: "old-signature",
          },
          call("pending", "write_file", { path: "report.txt", content: "Keep content" }),
        ]),
      );
      await consume(input);
      const saved = JSON.parse(blob!) as TurnCheckpoint;
      expect(JSON.stringify(saved.messages)).toContain("Old model private thinking canary");
      const assistant = saved.messages.findLast((message) => message.role === "assistant");
      if (assistant?.role !== "assistant") throw new Error("Missing captured assistant");
      saved.messages.push({
        ...assistant,
        stopReason,
        content: [{ type: "text", text: "Discarded failed tail canary" }],
      });
      provider.stream
        .mockReset()
        .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
          const wire = JSON.stringify(context.messages);
          expect(wire).not.toContain("Old model private thinking canary");
          expect(wire).not.toContain("old-signature");
          expect(wire).not.toContain("Discarded failed tail canary");
          expect(wire).toContain("Original history canary.");
          expect(resultText(context, "pending")).toContain("Recovered receipt");
          return response(undefined, activeModel);
        });
      const execute = vi.fn(async () => ({ receipt: "Recovered receipt" }));
      await consume({
        ...input,
        turnCheckpoint: JSON.stringify(saved),
        model: { provider: alternateModel.provider, id: alternateModel.id, apiKey: "fixture" },
        executeTool: execute,
      });
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it("automatically bounds an actually restored current-mode transcript at the provider boundary", async () => {
    const store = captures();
    const fetchTool: ConnectorTool = {
      name: "fetch_page",
      description: "Read one synthetic page",
      inputSchema: { type: "object", properties: { page: { type: "number" } }, required: ["page"] },
    };
    const input = request([fetchTool, builtin("ask_user")], {
      onCheckpoint: store.onCheckpoint,
      executeTool: async (_name, args) => ({
        kind: "agent_tool_result",
        content: [{ type: "text", text: `Page ${args.page} ${"original evidence ".repeat(600)}` }],
        details: {},
      }),
    });
    let step = 0;
    provider.stream.mockImplementation(() => {
      step += 1;
      return step <= 14
        ? response([call(`page-${step}`, "fetch_page", { page: step })])
        : response([
            call("question", "ask_user", { question: "Continue?", options: ["Yes", "No"] }),
          ]);
    });
    const paused = await consume(input);
    const toolEvent = paused.find((event) => event.type === "tool" && event.name === "ask_user");
    if (toolEvent?.type !== "tool") throw new Error("Missing paused question");
    const blob = store.at(toolEvent.executionId);
    expect(
      JSON.parse(blob).messages.filter(
        (message: { role: string }) => message.role === "toolResult",
      ),
    ).toHaveLength(14);
    const decisions: RuntimeContextDecision[] = [];
    const contexts: TranscriptContext[] = [];
    provider.stream
      .mockReset()
      .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
        contexts.push(structuredClone(context));
        expect(resultText(context, "question")).toContain("Continue from pause");
        return response(undefined, activeModel);
      });
    const execute = vi.fn(async () => ({ ok: true }));
    await consume(
      {
        ...input,
        turnCheckpoint: blob,
        model: { ...input.model, contextWindow: 24_000, maxTokens: 1_024 },
        resumeToolResult: {
          kind: "agent_tool_result",
          content: [{ type: "text", text: "Continue from pause" }],
          details: {},
        },
        executeTool: execute,
      },
      new PiAgentRuntime({
        onContextDecision: (decision) => {
          decisions.push(decision);
        },
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(1);
    expect(JSON.stringify(contexts[0]).length).toBeLessThan(blob.length);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.strategy).not.toBe("current");
    expect(decisions[0]!.estimatedInputTokens).toBeLessThanOrEqual(24_000 - 1_024);
    const savedResults = (JSON.parse(blob).messages as TurnCheckpoint["messages"]).filter(
      (message) => message.role === "toolResult",
    );
    const restoredResults = contexts[0]!.messages.filter(
      (message) => message.role === "toolResult",
    );
    expect(restoredResults.map((message) => message.toolCallId)).toEqual([
      ...savedResults.map((message) => message.toolCallId),
      "question",
    ]);
    expect(
      savedResults.some((saved) => {
        const restored = restoredResults.find((message) => message.toolCallId === saved.toolCallId);
        const savedText = JSON.stringify(saved.content);
        const restoredText = JSON.stringify(restored?.content);
        return (
          restoredText.length < savedText.length &&
          restoredText.includes("Earlier result shortened after you read it")
        );
      }),
    ).toBe(true);
  });

  it("prunes stale captured screenshots through the live restored provider request", async () => {
    const store = captures();
    const image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE7sAAAAASUVORK5CYII=";
    let step = 0;
    const input = request([builtin("computer_observe"), builtin("ask_user")], {
      onCheckpoint: store.onCheckpoint,
      executeTool: async () => ({
        kind: "agent_tool_result",
        content: [{ type: "image", data: image, mimeType: "image/png" }],
        details: { frameId: `frame-${step}` },
      }),
    });
    provider.stream.mockImplementation(() => {
      step += 1;
      return step <= 3
        ? response([call(`shot-${step}`, "computer_observe")])
        : response([
            call("question", "ask_user", {
              question: "Which screen?",
              options: ["Current", "Cancel"],
            }),
          ]);
    });
    const paused = await consume(input);
    const pausedTool = paused.find((event) => event.type === "tool" && event.name === "ask_user");
    if (pausedTool?.type !== "tool") throw new Error("Missing paused question");
    const blob = store.at(pausedTool.executionId);
    expect(
      (JSON.parse(blob) as TurnCheckpoint).messages.filter(
        (message) =>
          message.role === "toolResult" && message.content.some((part) => part.type === "image"),
      ),
    ).toHaveLength(3);
    provider.stream
      .mockReset()
      .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
        const screenshots = context.messages.filter(
          (message) =>
            message.role === "toolResult" && message.content.some((part) => part.type === "image"),
        );
        expect(screenshots).toHaveLength(1);
        expect(screenshots[0]).toMatchObject({ toolCallId: "shot-3" });
        return response(undefined, activeModel);
      });
    const execute = vi.fn(async () => ({ ok: true }));
    await consume({
      ...input,
      turnCheckpoint: blob,
      model: { ...input.model, maxImagesPerPrompt: 1 },
      resumeToolResult: {
        kind: "agent_tool_result",
        content: [{ type: "text", text: "Use the current screen" }],
        details: {},
      },
      executeTool: execute,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { trusted: true, available: true },
    { trusted: false, available: true },
    { trusted: true, available: false },
  ])(
    "round trips catalog ownership and live permissions without accepting details as authority ($trusted/$available)",
    async ({ trusted, available }) => {
      const route: ConnectorRoute = {
        connectorId: "mcp",
        resourceId: "selected-server",
        toolName: "read",
        catalogGroup: "mail__notes",
        resourceRevision: 1,
      };
      const store = captures();
      const originalText = JSON.stringify({
        id: "exact-row",
        body: "Original MCP evidence ".repeat(1_800),
      });
      const original: AgentToolExecutionResult = {
        kind: "agent_tool_result",
        content: [{ type: "text", text: originalText }],
        details: { route, verbatim: true },
      };
      const catalog: ConnectorTool = {
        name: "connectors_execute_tool",
        description: "Read a synthetic MCP catalog entry",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, arguments: { type: "object" } },
          required: ["id", "arguments"],
        },
        route: { connectorId: "mcp", toolName: "__catalog_execute" },
      };
      const input = request([catalog, builtin("ask_user")], {
        onCheckpoint: store.onCheckpoint,
        verbatimMcpServers: { ids: ["selected-server"], slugs: ["mail__notes"] },
        executeTool: async (_name, _args, _executionId, _toolRoute, observer) => {
          if (trusted) observer?.onConnectorRouteResolved?.(route);
          return original;
        },
      });
      provider.stream
        .mockImplementationOnce(() =>
          response([
            call("catalog-read", "connectors_execute_tool", {
              id: "mail__notes/read",
              arguments: {},
            }),
          ]),
        )
        .mockImplementationOnce(() =>
          response([
            call("question", "ask_user", {
              question: "Use this evidence?",
              options: ["Use", "Skip"],
            }),
          ]),
        );
      const paused = await consume(input);
      const pausedTool = paused.find((event) => event.type === "tool" && event.name === "ask_user");
      if (pausedTool?.type !== "tool") throw new Error("Missing paused question");
      const blob = store.at(pausedTool.executionId);
      const saved = JSON.parse(blob) as TurnCheckpoint;
      if (trusted)
        expect(saved.mcpResultRoutes).toEqual([{ messageIndex: expect.any(Number), route }]);
      else expect(saved.mcpResultRoutes).toBeUndefined();
      provider.stream
        .mockReset()
        .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
          const text = resultText(context, "catalog-read");
          if (trusted) expect(text).toContain(originalText);
          else expect(text.length).toBeLessThan(originalText.length);
          expect(JSON.stringify(context)).not.toContain("mcpResultRoutes");
          return response(undefined, activeModel);
        });
      const revalidate = vi.fn(async (savedRoute: ConnectorRoute) =>
        available ? { ...savedRoute } : undefined,
      );
      const execute = vi.fn(async () => ({ ok: true }));
      const resumed = consume({
        ...input,
        turnCheckpoint: blob,
        restoreMcpResultRoute: revalidate,
        resumeToolResult: {
          kind: "agent_tool_result",
          content: [{ type: "text", text: "Use the evidence" }],
          details: {},
        },
        executeTool: execute,
      });
      if (available) await resumed;
      else {
        await expect(resumed).rejects.toThrow("no longer available");
        expect(provider.stream).not.toHaveBeenCalled();
      }
      expect(execute).not.toHaveBeenCalled();
      expect(revalidate).toHaveBeenCalledTimes(trusted ? 1 : 0);
      if (trusted) expect(revalidate).toHaveBeenCalledWith(route);
    },
  );

  it("captures the actual prepared provider prefix with its shortened evidence and unstarted tail", async () => {
    const store = captures();
    const fetchTool: ConnectorTool = {
      name: "fetch_page",
      description: "Read one synthetic page",
      inputSchema: { type: "object", properties: { page: { type: "number" } }, required: ["page"] },
    };
    const originalResults = new Map<string, string>();
    const input = request([fetchTool, builtin("ask_user"), builtin("scratchpad_add")], {
      contextStrategy: "snapshots",
      model: {
        provider: model.provider,
        id: model.id,
        apiKey: "fixture",
        contextWindow: 24_000,
        maxTokens: 1_024,
      },
      onCheckpoint: store.onCheckpoint,
      executeTool: async (name, args, executionId) => {
        expect(name).toBe("fetch_page");
        const body = `Page ${args.page} ${"original prepared-prefix evidence ".repeat(600)}`;
        originalResults.set(JSON.parse(executionId)[2], body);
        return { kind: "agent_tool_result", content: [{ type: "text", text: body }], details: {} };
      },
    });
    const contexts: TranscriptContext[] = [];
    provider.stream.mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
      contexts.push(structuredClone(context));
      return contexts.length <= 14
        ? response(
            [call(`page-${contexts.length}`, "fetch_page", { page: contexts.length })],
            activeModel,
          )
        : response(
            [
              call("prepared-question", "ask_user", {
                question: "Continue?",
                options: ["Yes", "No"],
              }),
              call("unstarted-tail", USE_TOOL, {
                name: "scratchpad_add",
                arguments: { title: "Only after the answer" },
              }),
            ],
            activeModel,
          );
    });
    const events = await consume(input);
    const question = events.find((event) => event.type === "tool" && event.name === "ask_user");
    if (question?.type !== "tool") throw new Error("Missing prepared-prefix pause");
    const saved = JSON.parse(store.at(question.executionId)) as TurnCheckpoint;
    const sent = contexts.at(-1)!;
    expect(saved.messages.slice(0, sent.messages.length)).toEqual(
      JSON.parse(JSON.stringify(sent.messages)),
    );
    const wireResults = sent.messages.filter((message) => message.role === "toolResult");
    expect(wireResults.length).toBeGreaterThan(0);
    expect(
      wireResults.some((message) => {
        const body = message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        return (
          body.includes("Earlier result shortened after you read it") &&
          body.length < originalResults.get(message.toolCallId)!.length
        );
      }),
    ).toBe(true);
    expect(saved).toMatchObject({
      pendingToolCallId: "prepared-question",
      executionMode: "sequential",
    });
    const pendingAssistant = saved.messages.at(-1);
    expect(pendingAssistant?.role).toBe("assistant");
    if (pendingAssistant?.role !== "assistant")
      throw new Error("Missing captured pending response");
    expect(
      pendingAssistant.content.filter((part) => part.type === "toolCall").map((part) => part.id),
    ).toEqual(["prepared-question", "unstarted-tail"]);
    expect(
      events.filter((event) => event.type === "tool" && event.name === "scratchpad_add"),
    ).toEqual([]);
    expect(originalResults.size).toBe(14);
    expect(contexts).toHaveLength(15);
  });

  it("selects a bounded backup for a restored current-mode transcript without replaying completed tools", async () => {
    const store = captures();
    const fetchTool: ConnectorTool = {
      name: "fetch_page",
      description: "Read one synthetic page",
      inputSchema: { type: "object", properties: { page: { type: "number" } }, required: ["page"] },
    };
    const input = request([fetchTool, builtin("ask_user")], {
      onCheckpoint: store.onCheckpoint,
      executeTool: async (_name, args) => ({
        kind: "agent_tool_result",
        content: [
          { type: "text", text: `Page ${args.page} ${"original fallback evidence ".repeat(600)}` },
        ],
        details: {},
      }),
    });
    let sourceCalls = 0;
    provider.stream.mockImplementation(() => {
      sourceCalls += 1;
      return sourceCalls <= 14
        ? response([call(`page-${sourceCalls}`, "fetch_page", { page: sourceCalls })])
        : response([
            call("backup-question", "ask_user", { question: "Continue?", options: ["Yes", "No"] }),
          ]);
    });
    const paused = await consume(input);
    const question = paused.find((event) => event.type === "tool" && event.name === "ask_user");
    if (question?.type !== "tool") throw new Error("Missing fallback checkpoint pause");
    const blob = store.at(question.executionId);
    const backup: Model<Api> = { ...alternateModel, id: "small-backup", contextWindow: 24_000 };
    registerFixtureProvider([backup]);
    const contexts: Array<{ modelId: string; context: TranscriptContext }> = [];
    provider.stream
      .mockReset()
      .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
        contexts.push({ modelId: activeModel.id, context: structuredClone(context) });
        if (activeModel.id === model.id) return unavailableResponse(activeModel);
        expect(activeModel.id).toBe(backup.id);
        expect(resultText(context, "backup-question")).toContain("Continue from verified answer");
        return response([{ type: "text", text: "Backup finished the saved work." }], activeModel);
      });
    const authorize = vi.fn(async () => undefined);
    const resolveFallbackModel = vi.fn(async () => ({
      provider: backup.provider,
      id: backup.id,
      apiKey: "fixture-backup",
      contextWindow: backup.contextWindow,
      maxTokens: 1_024,
      authorize,
    }));
    const onModelChange = vi.fn(async () => undefined);
    const execute = vi.fn(async () => ({ ok: true }));
    const reservations: Array<Parameters<ModelCallObserver["beforeCall"]>[0]> = [];
    const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>((call) => {
      reservations.push(call);
      return `fallback-reservation-${reservations.length}`;
    });
    const afterCall = vi.fn<ModelCallObserver["afterCall"]>(async () => undefined);
    const decisions: RuntimeContextDecision[] = [];
    const events = await consume(
      {
        ...input,
        turnCheckpoint: blob,
        fallbackModels: [{ provider: backup.provider, id: backup.id }],
        resolveFallbackModel,
        onModelChange,
        resumeToolResult: {
          kind: "agent_tool_result",
          content: [{ type: "text", text: "Continue from verified answer" }],
          details: {},
        },
        executeTool: execute,
      },
      new PiAgentRuntime({
        modelCallObserver: { beforeCall, afterCall },
        onContextDecision: (decision) => {
          decisions.push(decision);
        },
      }),
    );
    expect(contexts.map((item) => item.modelId)).toEqual([model.id, backup.id]);
    expect(resolveFallbackModel).toHaveBeenCalledExactlyOnceWith(backup.provider, backup.id);
    expect(onModelChange).toHaveBeenCalledExactlyOnceWith(backup.provider, backup.id);
    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(reservations.map((reservation) => reservation.modelId)).toEqual([model.id, backup.id]);
    expect(reservations[1]!.inputTokensEstimate + reservations[1]!.maxOutputTokens).toBeLessThan(
      backup.contextWindow,
    );
    expect(afterCall.mock.calls.map(([id]) => id)).toEqual([
      "fallback-reservation-1",
      "fallback-reservation-2",
    ]);
    expect(JSON.stringify(contexts[1]!.context).length).toBeLessThan(
      JSON.stringify(contexts[0]!.context).length,
    );
    expect(
      contexts[1]!.context.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => message.toolCallId),
    ).toEqual([
      ...Array.from({ length: 14 }, (_, index) => `page-${index + 1}`),
      "backup-question",
    ]);
    expect(decisions).toHaveLength(2);
    expect(decisions.every((decision) => decision.strategy !== "current")).toBe(true);
    expect(
      events.some(
        (event) => event.type === "done" && event.text === "Backup finished the saved work.",
      ),
    ).toBe(true);
  });

  it.each([false, true])(
    "retains claimed user steering once when restoring an interaction (explicit result: %s)",
    async (explicitResult) => {
      const store = captures();
      const pendingId = "steering-interaction";
      const input = request([builtin("ask_user")], { onCheckpoint: store.onCheckpoint });
      provider.stream.mockImplementationOnce(() =>
        response([
          call(pendingId, "ask_user", {
            question: "Continue the saved work?",
            options: ["Continue", "Stop"],
          }),
        ]),
      );
      const paused = await consume(input);
      const question = paused.find((event) => event.type === "tool" && event.name === "ask_user");
      if (question?.type !== "tool") throw new Error("Missing steering interaction pause");
      const blob = store.at(question.executionId);
      expect((JSON.parse(blob) as TurnCheckpoint).pendingToolCallId).toBe(pendingId);
      expect(provider.stream).toHaveBeenCalledOnce();

      const marker = `CLAIMED-USER-STEERING-ONCE-${explicitResult}`;
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE7sAAAAASUVORK5CYII=";
      const image = {
        name: "steering-pixel.png",
        mimeType: "image/png" as const,
        data: Buffer.from(png, "base64"),
      };
      const steering = [
        {
          id: "claimed-steering-once",
          messageId: "claimed-user-message",
          text: marker,
          images: [image],
        },
      ];
      const claimSteering = vi.fn<NonNullable<AgentRunRequest["claimSteering"]>>(async (seenIds) =>
        steering.filter((item) => !seenIds.includes(item.id)),
      );
      const contexts: TranscriptContext[] = [];
      provider.stream
        .mockReset()
        .mockImplementation((activeModel: Model<Api>, context: TranscriptContext) => {
          contexts.push(structuredClone(context));
          return response(undefined, activeModel);
        });
      const resumedPrompt = "Continue with the saved choice.";
      const receipt = "Verified interaction response receipt.";
      const execute = vi.fn(async () => ({ ok: true }));
      const freshRuntime = new PiAgentRuntime();
      const events = await consume(
        {
          ...input,
          prompt: resumedPrompt,
          history: [
            ...input.history,
            { id: steering[0]!.messageId, role: "user", content: marker, images: [image] },
          ],
          turnCheckpoint: blob,
          claimSteering,
          ...(explicitResult
            ? {
                resumeToolResult: {
                  kind: "agent_tool_result" as const,
                  content: [{ type: "text" as const, text: receipt }],
                  details: {},
                },
              }
            : {}),
          executeTool: execute,
        },
        freshRuntime,
      );

      expect(provider.stream).toHaveBeenCalledOnce();
      expect(contexts).toHaveLength(1);
      const context = contexts[0]!;
      const wire = JSON.stringify(context.messages);
      expect(wire.split(marker)).toHaveLength(2);
      expect(wire.split("Original history canary.")).toHaveLength(2);
      const steeringUsers = context.messages
        .filter((message) => message.role === "user")
        .filter((message) => JSON.stringify(message.content).includes(marker));
      expect(steeringUsers).toHaveLength(1);
      expect(steeringUsers[0]!.content).toEqual([
        { type: "text", text: marker },
        { type: "image", data: png, mimeType: "image/png" },
      ]);
      expect(
        context.messages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.type === "image")
            : [],
        ),
      ).toEqual([{ type: "image", data: png, mimeType: "image/png" }]);
      expect(
        context.messages.filter(
          (message) => message.role === "toolResult" && message.toolCallId === pendingId,
        ),
      ).toHaveLength(1);
      expect(resultText(context, pendingId)).toBe(explicitResult ? receipt : resumedPrompt);
      expect(resultText(context, pendingId)).not.toContain(marker);
      expect(resultText(context, pendingId)).not.toContain("Additional user context:");
      expect(claimSteering).toHaveBeenNthCalledWith(1, []);
      expect(
        claimSteering.mock.calls.slice(1).every(([seenIds]) => seenIds.includes(steering[0]!.id)),
      ).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === "ask" || event.type === "takeover")).toBe(false);
    },
  );
});
