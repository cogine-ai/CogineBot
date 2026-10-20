import type * as AgentCore from "@earendil-works/pi-agent-core";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Model, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  stream: vi.fn(),
  agent: undefined as AgentCore.Agent | undefined,
  options: undefined as AgentOptions | undefined,
}));

// Capture the generated definitions without replacing Agent's actual loop,
// argument validation, tool dispatch, event handling, or completion lifecycle.
vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentCore>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: AgentOptions) {
        super(options);
        providerState.agent = this;
        providerState.options = options;
      }
    },
  };
});

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) =>
      provider === model.provider && id === model.id ? model : undefined,
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));
vi.mock("./pi-current-models.js", () => ({ supplementPiModels: (models: unknown) => models }));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { builtinAgentTools } from "./builtin-tools.js";
import { PiAgentRuntime } from "./pi-runtime.js";

const model: Model<"openai-completions"> = {
  provider: "offline-sequential",
  id: "batch-order",
  name: "Offline batch fixture",
  api: "openai-completions",
  baseUrl: "https://models.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 1_024,
};

function response(calls: ToolCall[] = []) {
  const message: AssistantMessage = {
    role: "assistant",
    content: calls.length ? calls : [{ type: "text", text: "Done." }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: calls.length ? "toolUse" : "stop",
    timestamp: 1,
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message });
  stream.end(message);
  return stream;
}

function call(id: string, name: string, args: ToolCall["arguments"] = {}): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function run(names: string[], executeTool: AgentRunRequest["executeTool"]) {
  return (async () => {
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime().run({
      botId: "batch-bot",
      threadId: "batch-thread",
      runId: `batch-${names.join("-")}`,
      prompt: "Complete the requested operations in order.",
      instructions: "Use the available tools, then give a final answer.",
      history: [],
      tools: builtinAgentTools.filter((tool) => names.includes(tool.name)),
      model: { provider: model.provider, id: model.id },
      executeTool,
    })) {
      events.push(event);
    }
    return events;
  })();
}

function nextMacrotask() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

describe("real Pi tool batch ordering", () => {
  beforeEach(() => {
    providerState.stream.mockReset();
    providerState.agent = undefined;
    providerState.options = undefined;
    vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Unexpected network request"))),
    );
  });

  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("marks exactly memory and the three schedule tools sequential in real runtime definitions", async () => {
    providerState.stream.mockImplementation(() => response());
    await run(
      ["remember", "schedule_create", "schedule_list", "schedule_cancel", "read_file", "shell"],
      async () => ({ ok: true }),
    );

    const tools = providerState.agent!.state.tools;
    expect(
      tools.filter((tool) => tool.executionMode === "sequential").map((tool) => tool.name),
    ).toEqual(["remember", "schedule_cancel", "schedule_create", "schedule_list"]);
    for (const name of ["read_file", "shell"]) {
      expect(tools.find((tool) => tool.name === name)?.executionMode).toBeUndefined();
    }
    expect(providerState.options?.toolExecution).toBeUndefined();
    expect(providerState.agent!.toolExecution).toBe("parallel");
  });

  it("finishes each remember before a following read or remember in the same assistant batch", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        response([
          call("remember-first", "remember", { content: "First fact" }),
          call("read-first", "read_file", { path: "MEMORY.md" }),
          call("remember-second", "remember", { content: "Second fact" }),
          call("read-second", "read_file", { path: "MEMORY.md" }),
        ]),
      )
      .mockImplementation(() => response());
    const started = barrier();
    const release = barrier();
    const trace: string[] = [];
    const reads: string[][] = [];
    const facts: string[] = [];
    const work = run(["remember", "read_file"], async (name, args) => {
      trace.push(`${name}:start`);
      if (name === "remember") {
        if (facts.length === 0) {
          started.resolve();
          await release.promise;
        }
        facts.push(String(args.content));
      } else {
        reads.push([...facts]);
      }
      trace.push(`${name}:end`);
      return { facts: [...facts] };
    });
    try {
      await Promise.race([started.promise, work]);
      await nextMacrotask();
      expect(trace).toEqual(["remember:start"]);
      expect(reads).toEqual([]);
    } finally {
      release.resolve();
      await work;
    }

    expect(reads).toEqual([["First fact"], ["First fact", "Second fact"]]);
    expect(trace).toEqual([
      "remember:start",
      "remember:end",
      "read_file:start",
      "read_file:end",
      "remember:start",
      "remember:end",
      "read_file:start",
      "read_file:end",
    ]);
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(
      providerState.agent!.state.messages.filter((message) => message.role === "toolResult"),
    ).toHaveLength(4);
  });

  it("lists the completed create and cancel in the same schedule batch", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        response([
          call("create", "schedule_create", {
            name: "Review",
            prompt: "Prepare review",
            delayMinutes: 10,
          }),
          call("list-created", "schedule_list"),
          call("cancel", "schedule_cancel", { name: "Review" }),
          call("list-cancelled", "schedule_list"),
        ]),
      )
      .mockImplementation(() => response());
    const started = barrier();
    const release = barrier();
    const trace: string[] = [];
    const schedules: string[] = [];
    const listings: string[][] = [];
    const work = run(["schedule_create", "schedule_list", "schedule_cancel"], async (name) => {
      trace.push(`${name}:start`);
      if (name === "schedule_create") {
        started.resolve();
        await release.promise;
        schedules.push("Review");
      } else if (name === "schedule_cancel") {
        schedules.pop();
      } else {
        listings.push([...schedules]);
      }
      trace.push(`${name}:end`);
      return { schedules: [...schedules] };
    });
    try {
      await Promise.race([started.promise, work]);
      await nextMacrotask();
      expect(trace).toEqual(["schedule_create:start"]);
      expect(listings).toEqual([]);
    } finally {
      release.resolve();
      await work;
    }

    expect(listings).toEqual([["Review"], []]);
    expect(trace).toEqual([
      "schedule_create:start",
      "schedule_create:end",
      "schedule_list:start",
      "schedule_list:end",
      "schedule_cancel:start",
      "schedule_cancel:end",
      "schedule_list:start",
      "schedule_list:end",
    ]);
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("keeps batches of ordinary reads concurrent", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        response([
          call("read-a", "read_file", { path: "a.txt" }),
          call("read-b", "read_file", { path: "b.txt" }),
        ]),
      )
      .mockImplementation(() => response());
    const started = barrier();
    const release = barrier();
    const trace: string[] = [];
    const work = run(["read_file"], async (_name, args) => {
      const path = String(args.path);
      trace.push(`${path}:start`);
      if (path === "a.txt") {
        started.resolve();
        await release.promise;
      }
      trace.push(`${path}:end`);
      return { content: path };
    });
    try {
      await Promise.race([started.promise, work]);
      await nextMacrotask();
      expect(trace).toEqual(["a.txt:start", "b.txt:start", "b.txt:end"]);
    } finally {
      release.resolve();
      await work;
    }
    expect(trace.at(-1)).toBe("a.txt:end");
    const nextContext = providerState.stream.mock.calls[1]![1] as Context;
    expect(
      nextContext.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => message.toolCallId),
    ).toEqual(["read-a", "read-b"]);
  });
});
