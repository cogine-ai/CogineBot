import type * as AgentCore from "@earendil-works/pi-agent-core";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Model, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  stream: vi.fn(),
  agents: [] as AgentCore.Agent[],
}));
vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentCore>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: AgentOptions) {
        super(options);
        captured.agents.push(this);
      }
    },
  };
});
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) =>
      provider === model.provider && id === model.id ? model : undefined,
    streamSimple: (...args: unknown[]) => captured.stream(...args),
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
  provider: "offline-automated",
  id: "provenance-model",
  name: "Offline provenance fixture",
  api: "openai-completions",
  baseUrl: "https://models.invalid/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 1024,
};
const image = { type: "image" as const, data: "c3ludGhldGlj", mimeType: "image/png" };
const label = "[Automated message from CogineBot, not from the user]";
function response(content: AssistantMessage["content"] = []) {
  const toolUse = content.some((part) => part.type === "toolCall");
  const message: AssistantMessage = {
    role: "assistant",
    content,
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
    stopReason: toolUse ? "toolUse" : "stop",
    timestamp: 1,
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
  stream.end(message);
  return stream;
}
const call = (id: string, name: string, args: ToolCall["arguments"] = {}): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const text = (message: { content?: unknown }) =>
  typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : "";
const system = (context: Context) =>
  context.systemPrompt ??
  context.messages
    .filter((message) => message.role === "system")
    .map(text)
    .join("\n");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  captured.stream.mockReset();
  captured.agents = [];
});

describe("automated source in the real Agent loop", () => {
  it("labels parent and child model views, delegates with owner time and preserves raw tool history and events", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T15:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Unexpected network request"))),
    );
    const contexts: Context[] = [];
    let parentCalls = 0;
    let childCalls = 0;
    captured.stream.mockImplementation((_model: Model<"openai-completions">, context: Context) => {
      contexts.push(structuredClone(context));
      if (system(context).includes("subagent named")) {
        childCalls += 1;
        return childCalls === 1
          ? response([call("child-image", "computer_observe")])
          : response([{ type: "text", text: "Helper inspected the image." }]);
      }
      parentCalls += 1;
      if (parentCalls === 1) return response([call("parent-image", "computer_observe")]);
      if (parentCalls === 2)
        return response([
          call("delegate", "run_subagent", { name: "helper", task: "Inspect the screen." }),
        ]);
      if (parentCalls === 3) return response();
      return response([{ type: "text", text: "Done." }]);
    });
    const beforeCall = vi.fn(
      async (_call: { inputTokensEstimate: number }) => "synthetic-reservation",
    );
    const onToolCompleted = vi.fn();
    const toolResult = {
      kind: "agent_tool_result" as const,
      content: [{ type: "text" as const, text: "Raw image evidence" }, image],
      details: { untrusted: true, retained: "raw-details" },
      isError: false,
    };
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime({
      modelCallObserver: { beforeCall, afterCall: vi.fn() },
    }).run(
      {
        botId: "provenance-bot",
        threadId: "provenance-thread",
        runId: "provenance-run",
        prompt: "Inspect and delegate.",
        instructions: "Stable parent instructions.",
        userTimezone: "Asia/Taipei",
        tools: builtinAgentTools.filter((tool) =>
          ["computer_observe", "run_subagent"].includes(tool.name),
        ),
        history: [],
        contextStrategy: "retrieval",
        model: { provider: model.provider, id: model.id },
        executeTool: async () => structuredClone(toolResult),
        onToolCompleted,
      },
      { userId: "different-actor", spaceId: "shared-space" },
    ))
      events.push(event);

    expect(
      events.filter((event) => event.type === "subagent" && event.status === "failed"),
    ).toEqual([]);
    expect(
      captured.agents[0]!.state.messages.filter(
        (message) => message.role === "toolResult" && message.isError,
      ),
    ).toEqual([]);
    expect(parentCalls).toBe(4);
    expect(childCalls).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "done", text: "Done." }));
    const child = contexts.filter((context) => system(context).includes("subagent named"));
    expect(text(child[0]!.messages.at(-1)!)).toContain(
      `${label} Task from the parent bot (not from the user):`,
    );
    expect(text(child[0]!.messages.at(-1)!)).toContain("Asia/Taipei");
    expect(text(child[0]!.messages.at(-1)!)).toContain("2026-10-23T15:00:00Z");
    expect(system(child[0]!)).not.toContain("Current date and time");
    expect(system(child[1]!)).toBe(system(child[0]!));
    for (const context of contexts) {
      for (const message of context.messages) {
        if (message.role !== "toolResult") continue;
        expect(text(message)).toContain(label);
        if (message.toolName === "computer_observe") {
          expect(text(message)).toContain("Screenshot(s) returned by this tool call.");
          expect(message.content).toContainEqual(image);
          expect(message.details).toEqual(toolResult.details);
        } else expect(text(message)).toContain("Result from your helper");
      }
    }
    const parent = contexts.filter((context) => !system(context).includes("subagent named"));
    expect(parent.every((context) => system(context) === "Stable parent instructions.")).toBe(true);
    expect(text(parent.at(-1)!.messages.at(-1)!)).toBe(
      `${label} Continue the original task from the latest tool result. Do not stop after a tool call; use any remaining tools needed, then give the user the final answer.`,
    );
    expect(beforeCall).toHaveBeenCalledTimes(contexts.length);
    for (const [index, context] of contexts.entries()) {
      // Invalid synthetic image bytes use the serialized-byte bound plus fixed framing.
      expect(beforeCall.mock.calls[index]![0].inputTokensEstimate).toBe(
        Buffer.byteLength(JSON.stringify(context), "utf8") + 256,
      );
    }
    for (const agent of captured.agents) {
      for (const message of agent.state.messages) {
        if (message.role !== "toolResult") continue;
        expect(text(message)).not.toContain(label);
        if (message.toolName === "computer_observe") {
          expect(message.content).toEqual(toolResult.content);
          expect(message.details).toEqual(toolResult.details);
        } else expect(text(message)).toBe("Helper inspected the image.");
      }
    }
    expect(
      events.filter((event) => event.type === "tool" && event.name === "computer_observe"),
    ).toHaveLength(2);
    const completions = onToolCompleted.mock.calls.map(([completion]) => completion);
    expect(completions).toHaveLength(3);
    expect(
      completions
        .filter((completion) => completion.name === "computer_observe")
        .map((completion) => completion.result),
    ).toEqual([toolResult, toolResult]);
    expect(completions.find((completion) => completion.name === "run_subagent").result).toEqual({
      content: [{ type: "text", text: "Helper inspected the image." }],
      details: { result: "Helper inspected the image." },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("retains a failed delegation in raw completion history while identifying its model view as helper output", async () => {
    const contexts: Context[] = [];
    captured.stream
      .mockImplementationOnce((_model: unknown, context: Context) => {
        contexts.push(structuredClone(context));
        return response([
          call("failed-delegate", "run_subagent", {
            name: "helper",
            task: "Inspect",
            model_provider: "unavailable",
            model_id: "unavailable",
          }),
        ]);
      })
      .mockImplementation((_model: unknown, context: Context) => {
        contexts.push(structuredClone(context));
        return response([{ type: "text", text: "Unable to delegate." }]);
      });
    const onToolCompleted = vi.fn();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime().run({
      botId: "failed-bot",
      threadId: "failed-thread",
      runId: "failed-helper",
      prompt: "Delegate",
      instructions: "Stable instructions",
      history: [],
      tools: builtinAgentTools.filter((tool) => tool.name === "run_subagent"),
      model: { provider: model.provider, id: model.id },
      onToolCompleted,
    }))
      events.push(event);
    const rawFailure = "Subagent failed: Per-call subagent model selection is unavailable";
    const result = contexts[1]!.messages.find((message) => message.role === "toolResult")!;
    expect(text(result)).toBe(
      `${label} Result from your helper, not a message from the user.\n${rawFailure}`,
    );
    expect(captured.agents[0]!.state.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "failed-delegate",
        content: [{ type: "text", text: rawFailure }],
        details: { result: rawFailure },
      }),
    );
    expect(onToolCompleted.mock.calls[0]![0].result).toEqual({
      content: [{ type: "text", text: rawFailure }],
      details: { result: rawFailure },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        status: "failed",
        result: "Per-call subagent model selection is unavailable",
      }),
    );
  });
});
