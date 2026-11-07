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
  getCurrentTools,
} from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approvalPausedToolResult } from "./approval-effect.js";
import { FIND_TOOL, USE_TOOL } from "./builtin-tool-bridge.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { modelsForRequest, PiAgentRuntime } from "./pi-runtime.js";
import type { LoopGuardStreak } from "./tool-loop.js";
import { advanceToolCallLoopGuard, toolResultFingerprint } from "./tool-loop.js";

const provider = { stream: vi.fn() };

const model: Model<"openai-completions"> = {
  provider: "offline-bridge",
  id: "builtin-discovery",
  name: "Offline discovery fixture",
  api: "openai-completions",
  baseUrl: "https://models.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65_536,
  maxTokens: 1_024,
};

function fixtureModels(): MutableModels {
  return modelsForRequest(
    { model: { provider: model.provider, id: model.id, apiKey: "fixture" } },
    model.provider,
  ) as MutableModels;
}

function registerFixtureProvider() {
  fixtureModels().setProvider(
    createProvider({
      id: model.provider,
      models: [model],
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

function response(calls: ToolCall[] = []) {
  const message: AssistantMessage = {
    role: "assistant",
    content: calls.length ? calls : [{ type: "text", text: "Done." }],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  for (const [contentIndex, toolCall] of calls.entries()) {
    stream.push({ type: "toolcall_start", contentIndex, partial: message });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
  }
  stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message });
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

let ordinal = 0;
function request(
  tools: ConnectorTool[],
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    botId: "bridge-bot",
    threadId: "bridge-thread",
    runId: `bridge-run-${++ordinal}`,
    prompt: "Complete the requested work.",
    instructions: "Use tools, then answer.",
    history: [],
    contextStrategy: "current",
    model: { provider: model.provider, id: model.id, apiKey: "fixture" },
    tools,
    ...overrides,
  };
}

async function consume(input: AgentRunRequest, signal = new AbortController().signal) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, { signal })) events.push(event);
  return events;
}

function result(context: TranscriptContext, id: string) {
  const message = context.messages.find(
    (candidate) => candidate.role === "toolResult" && candidate.toolCallId === id,
  );
  if (message?.role !== "toolResult") throw new Error(`Missing result ${id}`);
  return message;
}

function payload(context: TranscriptContext, id: string) {
  const part = result(context, id).content.find(
    (candidate) => candidate.type === "text" && candidate.text.startsWith("{"),
  );
  if (part?.type !== "text") throw new Error(`Missing JSON result ${id}`);
  const value = JSON.parse(part.text);
  return value.result ?? value;
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("real Pi built-in discovery and execution", () => {
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

  it.each([
    { failure: new Error("Synthetic takeover control failure"), abort: false },
    { failure: undefined, abort: false },
    { failure: new Error("Synthetic takeover control failure"), abort: true },
  ])(
    "releases a finite tool budget after terminal takeover control failure %#",
    async ({ failure, abort }) => {
      vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "2");
      provider.stream
        .mockImplementationOnce(() =>
          response([call("takeover", "request_takeover", { reason: "Sign in" })]),
        )
        .mockImplementationOnce(() =>
          response([
            call("first", "read_file", { path: "first.txt" }),
            call("second", "read_file", { path: "second.txt" }),
          ]),
        )
        .mockImplementation(() => response());
      const controller = new AbortController();
      const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async () => {
        if (abort) controller.abort();
        return Promise.reject(failure);
      });
      const input = request([builtin("request_takeover"), builtin("read_file")], {
        executeTool: execute,
      });
      await expect(consume(input, controller.signal)).rejects.toThrow(
        failure instanceof Error ? failure.message : "undefined",
      );
      expect(execute).toHaveBeenCalledOnce();
      execute.mockClear();
      execute.mockImplementation(async () => ({ ok: true }));
      const retried = await consume(input);
      expect(execute.mock.calls.map(([name, args]) => [name, args.path])).toEqual([
        ["read_file", "first.txt"],
        ["read_file", "second.txt"],
      ]);
      expect(
        retried.some((event) => event.type === "progress" && event.text.includes("tool calls")),
      ).toBe(false);
    },
  );

  it.each(["pause", "abort", "exceeded"] as const)(
    "keeps the finite-budget lifecycle for an ordinary %s",
    async (ending) => {
      vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "2");
      provider.stream
        .mockImplementationOnce(() =>
          response(
            ending === "pause"
              ? [call("pause", "request_takeover", { reason: "Sign in" })]
              : [
                  call("initial", "read_file", { path: "initial.txt" }),
                  ...(ending === "exceeded"
                    ? [
                        call("second", "read_file", { path: "second.txt" }),
                        call("over", "read_file", { path: "over.txt" }),
                      ]
                    : []),
                ],
          ),
        )
        .mockImplementationOnce(() =>
          response([
            call("retry-first", "read_file", { path: "retry-first.txt" }),
            call("retry-second", "read_file", { path: "retry-second.txt" }),
          ]),
        )
        .mockImplementation(() => response());
      const controller = new AbortController();
      const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async () => {
        if (ending === "abort") controller.abort();
        return ending === "pause" ? approvalPausedToolResult() : { ok: true };
      });
      const input = request([builtin("request_takeover"), builtin("read_file")], {
        executeTool: execute,
      });
      const first = consume(input, controller.signal);
      if (ending === "abort") await expect(first).rejects.toThrow();
      else await first;
      expect(execute).toHaveBeenCalledTimes(ending === "exceeded" ? 2 : 1);
      execute.mockClear();
      execute.mockImplementation(async () => ({ ok: true }));
      const resumed = await consume(input);
      expect(execute).toHaveBeenCalledTimes(ending === "exceeded" ? 2 : 1);
      expect(
        resumed.some((event) => event.type === "progress" && event.text.includes("tool calls")),
      ).toBe(ending !== "exceeded");
    },
  );

  it("keeps core schemas stable while discovering and executing the actual deferred tool", async () => {
    const contexts: TranscriptContext[] = [];
    const deferred = builtin("scratchpad_add");
    provider.stream.mockImplementation((_model: Model<Api>, context: TranscriptContext) => {
      contexts.push(structuredClone(context));
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual([
        FIND_TOOL,
        "shell",
        USE_TOOL,
      ]);
      if (contexts.length === 1) {
        return response([call("find", FIND_TOOL, { names: [deferred.name] })]);
      }
      if (contexts.length === 2) {
        expect(payload(context, "find").tools).toEqual([
          {
            name: deferred.name,
            description: deferred.description,
            inputSchema: deferred.inputSchema,
          },
        ]);
        return response([
          call("deferred", USE_TOOL, {
            name: deferred.name,
            arguments: { title: "整理：α", notes: "Keep the exact title." },
          }),
        ]);
      }
      if (contexts.length === 3) {
        return response([call("core", "shell", { command: 123, cwd: "work/資料" })]);
      }
      return response();
    });
    const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async () => ({ ok: true }));
    const events = await consume(request([deferred, builtin("shell")], { executeTool: execute }));
    expect(execute.mock.calls.map(([name, args]) => ({ name, args }))).toEqual([
      { name: "scratchpad_add", args: { title: "整理：α", notes: "Keep the exact title." } },
      { name: "shell", args: { command: "123", cwd: "work/資料" } },
    ]);
    const tools = events.filter((event) => event.type === "tool");
    expect(tools.find((event) => event.name === "scratchpad_add")).toMatchObject({
      args: { title: "整理：α", notes: "Keep the exact title." },
      executionId: JSON.stringify(["pi-tool", "main", "deferred"]),
      viaUseTool: true,
    });
    expect(tools.some((event) => event.name === USE_TOOL)).toBe(false);
    expect(tools.find((event) => event.name === "shell")?.args).toEqual({
      command: "123",
      cwd: "work/資料",
    });
    expect(
      events.some((event) => event.type === "progress" && event.text === "Using use_tool"),
    ).toBe(false);
    const definitions = contexts.map((context) =>
      JSON.stringify(getCurrentTools(context.messages)),
    );
    expect(new Set(definitions).size).toBe(1);
  });

  const offeredNameCases: Array<{ names: string[] }> = [{ names: [] }, { names: ["shell"] }];
  it.each(offeredNameCases)(
    "adds no empty bridge when offered names are $names",
    async ({ names }) => {
      provider.stream.mockImplementation((_model: Model<Api>, context: TranscriptContext) => {
        expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(names);
        return response();
      });
      const execute = vi.fn(async () => ({ ok: true }));
      await consume(request(names.map(builtin), { executeTool: execute }));
      expect(execute).not.toHaveBeenCalled();
      expect(provider.stream).toHaveBeenCalledOnce();
    },
  );

  it("uses the same prepared canonical arguments for direct and bridged calls without a find gate", async () => {
    const content = { label: "資料 α", nested: { values: [1, true], exact: "a\nb" } };
    const args = { path: "notes/資料.json", content };
    provider.stream
      .mockImplementationOnce(() =>
        response([
          call("direct", "write_file", args),
          call("wrapped", USE_TOOL, { name: "write_file", arguments: args }),
        ]),
      )
      .mockImplementation(() => response());
    const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async () => ({ ok: true }));
    const events = await consume(
      request([builtin("write_file"), builtin("scratchpad_add")], { executeTool: execute }),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    const expected = { path: "notes/資料.json", content: JSON.stringify(content, null, 2) };
    expect(execute.mock.calls.map(([name, prepared]) => ({ name, prepared }))).toEqual([
      { name: "write_file", prepared: expected },
      { name: "write_file", prepared: expected },
    ]);
    expect(events.filter((event) => event.type === "tool").map((event) => event.name)).toEqual([
      "write_file",
      "write_file",
    ]);
  });

  it("preserves the current bot-creation fields through the real deferred wrapper", async () => {
    provider.stream
      .mockImplementationOnce(() =>
        response([
          call("spawn", USE_TOOL, {
            name: "spawn_bot",
            arguments: {
              name: "Scout",
              title: "Finds venues",
              instructions: "Ask before booking anything.",
              computer_mode: "team",
            },
          }),
        ]),
      )
      .mockImplementation(() => response());
    const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async () => ({ ok: true }));
    await consume(request([builtin("spawn_bot")], { executeTool: execute }));
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.slice(0, 3)).toEqual([
      "spawn_bot",
      {
        name: "Scout",
        title: "Finds venues",
        instructions: "Ask before booking anything.",
        prompt: "",
        computer_mode: "team",
      },
      JSON.stringify(["pi-tool", "main", "spawn"]),
    ]);
  });

  it.each(["not_offered", FIND_TOOL, USE_TOOL])(
    "rejects an unavailable or recursive inner target %s",
    async (name) => {
      provider.stream
        .mockImplementationOnce(() =>
          response([call("invalid", USE_TOOL, { name, arguments: {} })]),
        )
        .mockImplementation((_model: Model<Api>, context: TranscriptContext) => {
          expect(result(context, "invalid").isError).toBe(true);
          expect(JSON.stringify(result(context, "invalid").content)).toContain("not available");
          return response();
        });
      const execute = vi.fn(async () => ({ ok: true }));
      await consume(request([builtin("scratchpad_add")], { executeTool: execute }));
      expect(execute).not.toHaveBeenCalled();
    },
  );

  const discoveryLimitCases: Array<{ args: JsonObject }> = [
    { args: { names: Array.from({ length: 6 }, () => "scratchpad_add") } },
    { args: { query: "x".repeat(201) } },
  ];
  it.each(discoveryLimitCases)(
    "validates discovery limits before returning schemas (%j)",
    async ({ args }) => {
      provider.stream
        .mockImplementationOnce(() => response([call("invalid-find", FIND_TOOL, args)]))
        .mockImplementation((_model: Model<Api>, context: TranscriptContext) => {
          expect(result(context, "invalid-find").isError).toBe(true);
          expect(JSON.stringify(result(context, "invalid-find").content)).not.toContain(
            "inputSchema",
          );
          return response();
        });
      const execute = vi.fn(async () => ({ ok: true }));
      await consume(request([builtin("scratchpad_add")], { executeTool: execute }));
      expect(execute).not.toHaveBeenCalled();
    },
  );

  const invalidInnerCases: Array<{ args: JsonObject }> = [
    { args: { notes: "missing title" } },
    { args: { title: "Item", status: "unknown-status" } },
  ];
  it.each(invalidInnerCases)(
    "validates the real inner schema before execute (%j)",
    async ({ args }) => {
      provider.stream
        .mockImplementationOnce(() =>
          response([call("invalid-args", USE_TOOL, { name: "scratchpad_add", arguments: args })]),
        )
        .mockImplementation((_model: Model<Api>, context: TranscriptContext) => {
          expect(result(context, "invalid-args").isError).toBe(true);
          return response();
        });
      const execute = vi.fn(async () => ({ ok: true }));
      await consume(request([builtin("scratchpad_add")], { executeTool: execute }));
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("rechecks current availability after discovery while keeping provider definitions stable", async () => {
    let available = ["shell", "scratchpad_add"];
    const definitions: string[] = [];
    let step = 0;
    provider.stream.mockImplementation((_model: Model<Api>, context: TranscriptContext) => {
      definitions.push(JSON.stringify(getCurrentTools(context.messages)));
      step += 1;
      if (step === 1)
        return response([call("find-before", FIND_TOOL, { names: ["scratchpad_add"] })]);
      if (step === 2) {
        expect(payload(context, "find-before").tools[0].name).toBe("scratchpad_add");
        available = ["shell"];
        return response([
          call("revoked", USE_TOOL, { name: "scratchpad_add", arguments: { title: "No write" } }),
        ]);
      }
      if (step === 3) {
        expect(result(context, "revoked").isError).toBe(true);
        return response([call("find-after", FIND_TOOL, { names: ["scratchpad_add"] })]);
      }
      expect(payload(context, "find-after")).toMatchObject({
        tools: [],
        unknown: ["scratchpad_add"],
      });
      return response();
    });
    const execute = vi.fn(async () => ({ ok: true }));
    await consume(
      request([builtin("shell"), builtin("scratchpad_add")], {
        executeTool: execute,
        availableToolNames: async () => available,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(new Set(definitions).size).toBe(1);
  });

  it("finishes each deferred wrapper before its following read or write in the real SDK batch", async () => {
    provider.stream
      .mockImplementationOnce(() =>
        response([
          call("first", USE_TOOL, { name: "scratchpad_add", arguments: { title: "First" } }),
          call("read", "read_file", { path: "list.txt" }),
          call("second", USE_TOOL, { name: "scratchpad_add", arguments: { title: "Second" } }),
        ]),
      )
      .mockImplementation(() => response());
    const started = barrier();
    const release = barrier();
    const trace: string[] = [];
    const items: string[] = [];
    const reads: string[][] = [];
    const work = consume(
      request([builtin("scratchpad_add"), builtin("read_file")], {
        executeTool: async (name, args) => {
          trace.push(`${name}:start`);
          if (name === "scratchpad_add") {
            if (!items.length) {
              started.resolve();
              await release.promise;
            }
            items.push(String(args.title));
          } else reads.push([...items]);
          trace.push(`${name}:end`);
          return { items: [...items] };
        },
      }),
    );
    try {
      await Promise.race([started.promise, work]);
      await nextMacrotask();
      expect(trace).toEqual(["scratchpad_add:start"]);
      expect(reads).toEqual([]);
    } finally {
      release.resolve();
      await work;
    }
    expect(items).toEqual(["First", "Second"]);
    expect(reads).toEqual([["First"]]);
    expect(trace).toEqual([
      "scratchpad_add:start",
      "scratchpad_add:end",
      "read_file:start",
      "read_file:end",
      "scratchpad_add:start",
      "scratchpad_add:end",
    ]);
  });

  it("keeps ordinary direct reads parallel in a batch", async () => {
    provider.stream
      .mockImplementationOnce(() =>
        response([
          call("first", "read_file", { path: "first" }),
          call("second", "read_file", { path: "second" }),
        ]),
      )
      .mockImplementation(() => response());
    const started = barrier();
    const release = barrier();
    const trace: string[] = [];
    const work = consume(
      request([builtin("read_file")], {
        executeTool: async (_name, args) => {
          trace.push(`${args.path}:start`);
          if (args.path === "first") {
            started.resolve();
            await release.promise;
          }
          trace.push(`${args.path}:end`);
          return { path: args.path };
        },
      }),
    );
    try {
      await Promise.race([started.promise, work]);
      await nextMacrotask();
      expect(trace).toEqual(["first:start", "second:start", "second:end"]);
    } finally {
      release.resolve();
      await work;
    }
    expect(trace.at(-1)).toBe("first:end");
  });

  it("does not dispatch a queued wrapper after cancellation while retaining the completed first effect", async () => {
    provider.stream
      .mockImplementationOnce(() =>
        response([
          call("first", USE_TOOL, { name: "scratchpad_add", arguments: { title: "Committed" } }),
          call("second", USE_TOOL, { name: "scratchpad_add", arguments: { title: "Unstarted" } }),
        ]),
      )
      .mockImplementation(() => response());
    const started = barrier();
    const release = barrier();
    const controller = new AbortController();
    const committed: string[] = [];
    const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async (_name, args) => {
      committed.push(String(args.title));
      started.resolve();
      await release.promise;
      return { receipt: "Committed before cancellation" };
    });
    const work = consume(
      request([builtin("scratchpad_add")], { executeTool: execute }),
      controller.signal,
    ).catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
      return [];
    });
    try {
      await Promise.race([started.promise, work]);
      controller.abort();
    } finally {
      release.resolve();
      await work;
    }
    expect(execute).toHaveBeenCalledOnce();
    expect(committed).toEqual(["Committed"]);
    expect(provider.stream).toHaveBeenCalledOnce();
  });

  it("keeps main response batches and each helper call distinct through actual SDK events", async () => {
    let mainRequests = 0;
    let helperRequests = 0;
    const failedResults = new Map<string, string>();
    const repeatedReads = (prefix: string) =>
      Array.from({ length: 6 }, (_, index) =>
        call(`${prefix}-${index + 1}`, "read_file", { path: "same.txt" }),
      );
    provider.stream.mockImplementation((_model: Model<Api>, context: TranscriptContext) => {
      const helper = getCurrentSystemPrompt(context.messages).includes(
        'subagent named "Batch helper"',
      );
      if (helper) {
        helperRequests += 1;
        return helperRequests === 1 ? response(repeatedReads("helper-read")) : response();
      }
      mainRequests += 1;
      if (mainRequests === 1) return response(repeatedReads("main-read"));
      if (mainRequests === 2)
        return response([
          call("delegate", "run_subagent", {
            name: "Batch helper",
            task: "Read the same synthetic file six times.",
          }),
        ]);
      return response();
    });
    const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(
      async (name, args, _id, _route, observer) => {
        if (name === "run_subagent") return observer!.runSubagent!(args);
        expect(name).toBe("read_file");
        return { error: "The synthetic file is unavailable" };
      },
    );
    const events = await consume(
      request([builtin("read_file"), builtin("run_subagent")], {
        executeTool: execute,
        onToolCompleted: (completion) => {
          if (completion.name === "read_file")
            failedResults.set(
              completion.executionId,
              toolResultFingerprint(completion.result, completion.error),
            );
        },
      }),
    );
    const reads = events
      .filter((event) => event.type === "tool")
      .filter((event) => event.name === "read_file");
    const mainReads = reads.filter((event) => JSON.parse(event.executionId)[1] === "main");
    const helperReads = reads.filter((event) => JSON.parse(event.executionId)[1] !== "main");
    expect(mainReads).toHaveLength(6);
    expect(helperReads).toHaveLength(6);
    expect(new Set(mainReads.map((event) => event.response))).toEqual(new Set([1]));
    expect(helperReads.every((event) => event.response === undefined)).toBe(true);
    const delegate = events.find((event) => event.type === "tool" && event.name === "run_subagent");
    if (delegate?.type !== "tool") throw new Error("Missing actual helper dispatch");
    expect(
      helperReads.every((event) => JSON.parse(event.executionId)[1] === delegate.executionId),
    ).toBe(true);
    expect(new Set(reads.map((event) => event.executionId)).size).toBe(12);
    expect(failedResults.size).toBe(12);
    const countCalls = (calls: typeof reads) => {
      let streak: LoopGuardStreak = { key: undefined, count: 0 };
      const stopped: boolean[] = [];
      for (const event of calls) {
        const advanced = advanceToolCallLoopGuard(
          streak,
          event.name,
          event.args,
          streak.executionId ? failedResults.get(streak.executionId) : undefined,
          event.response,
        );
        if (advanced.streak !== streak)
          streak = { ...advanced.streak, executionId: event.executionId };
        stopped.push(advanced.stuck);
      }
      return { streak, stopped };
    };
    expect(countCalls(mainReads)).toMatchObject({
      streak: { count: 1 },
      stopped: [false, false, false, false, false, false],
    });
    expect(countCalls(helperReads)).toMatchObject({
      streak: { count: 6 },
      stopped: [false, false, false, false, false, true],
    });
    expect(execute).toHaveBeenCalledTimes(13);
    expect(mainRequests).toBe(3);
    expect(helperRequests).toBe(2);
  });
});
