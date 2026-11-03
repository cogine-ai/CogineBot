import { createHash } from "node:crypto";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerContextPrefix } from "./context-selection.js";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
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

import { PiAgentRuntime } from "./pi-runtime.js";

const claude: Model<"anthropic-messages"> = {
  provider: "anthropic",
  id: "binding-model",
  name: "binding-model",
  api: "anthropic-messages",
  baseUrl: "https://models.invalid",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

/** The prefix a signed thinking block is bound to: instructions, tools and earlier messages. */
function prefixSignature(context: Context, count: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        providerContextPrefix(
          context.systemPrompt ?? "",
          context.tools ?? [],
          context.messages.slice(0, count),
        ),
      ),
    )
    .digest("hex");
}

/** The first message whose thinking no longer matches the prefix it was signed with. */
function staleThinking(context: Context): number | undefined {
  const index = context.messages.findIndex(
    (message, position) =>
      message.role === "assistant" &&
      message.content.some(
        (part) =>
          part.type === "thinking" && part.thinkingSignature !== prefixSignature(context, position),
      ),
  );
  return index < 0 ? undefined : index;
}

function reply(content: AssistantMessage["content"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: claude.api,
    provider: claude.provider,
    model: claude.id,
    usage: {
      input: 1000,
      output: 20,
      cacheRead: 900,
      cacheWrite: 0,
      totalTokens: 1020,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: errorMessage
      ? "error"
      : content.some((part) => part.type === "toolCall")
        ? "toolUse"
        : "stop",
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function stream(message: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...message, content: [] } });
  if (message.stopReason === "error") {
    result.push({ type: "error", reason: "error", error: message });
  } else {
    for (const [contentIndex, part] of message.content.entries()) {
      if (part.type !== "toolCall") continue;
      result.push({ type: "toolcall_start", contentIndex, partial: message });
      result.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
    }
    result.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
  }
  result.end(message);
  return result;
}

/**
 * A provider that binds each thinking block to the conversation it was written in, as Claude
 * does: it signs every block with the request's prefix and rejects a request that replays a
 * block after anything before it changed.
 */
function bindingProvider(toolCalls: number) {
  const contexts: Context[] = [];
  const rejected: number[] = [];
  providerState.stream.mockImplementation((_model: unknown, context: Context) => {
    contexts.push(structuredClone(context));
    const stale = staleThinking(context);
    if (stale !== undefined) {
      rejected.push(contexts.length - 1);
      return stream(
        reply(
          [],
          `400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.${stale}.content.0: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation."}}`,
        ),
      );
    }
    const step = contexts.length - 1 - rejected.length;
    const thinking = {
      type: "thinking" as const,
      thinking: `Plan step ${step}`,
      thinkingSignature: prefixSignature(context, context.messages.length),
    };
    return stream(
      reply(
        step < toolCalls
          ? [
              thinking,
              { type: "toolCall", id: `call-${step}`, name: "fetch_logs", arguments: { step } },
            ]
          : [thinking, { type: "text", text: "Done." }],
      ),
    );
  });
  return { contexts, rejected };
}

function request(history: AgentRunRequest["history"] = []): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Find out why the alarm fired",
    instructions: "Use tools when useful.",
    history,
    tools: [
      {
        name: "fetch_logs",
        description: "Fetch log lines for one step.",
        inputSchema: {
          type: "object",
          properties: { step: { type: "number" } },
          required: ["step"],
        },
        readOnly: true,
      },
    ],
    model: { provider: claude.provider, id: claude.id, apiKey: "fake-key", thinkingLevel: "high" },
    executeTool: vi.fn(async (_name: string, args: { step: number }) => ({
      lines: `log ${args.step} ${"synthetic log line ".repeat(300)}`,
    })),
  } as unknown as AgentRunRequest;
}

async function run(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  providerState.models.clear();
  providerState.models.set(
    `${claude.provider}/${claude.id}`,
    claude as unknown as Record<string, unknown>,
  );
  providerState.stream.mockReset();
});

describe("Pi runtime transcript sent to a provider that binds thinking to its conversation", () => {
  it.each([false, true])(
    "asks for a needed decision after an empty tool turn (silent: %s)",
    async (allowSilentEmpty) => {
      const contexts: Context[] = [];
      providerState.stream.mockImplementation((_model: unknown, context: Context) => {
        contexts.push(structuredClone(context));
        if (contexts.length === 1)
          return stream(
            reply([
              { type: "toolCall", id: "lookup-once", name: "fetch_logs", arguments: { step: 1 } },
            ]),
          );
        if (contexts.length === 2) return stream(reply([]));
        const followUp = JSON.stringify(context.messages.at(-1));
        expect(followUp).toContain(
          "If you need information or a decision from the user, ask them instead of guessing",
        );
        if (allowSilentEmpty) expect(followUp).toContain("even if you were told to stay silent");
        else expect(followUp).not.toContain("even if you were told to stay silent");
        return stream(
          reply([
            {
              type: "toolCall",
              id: "needed-decision",
              name: "ask_user",
              arguments: { question: "Which output format?", options: ["Document", "Spreadsheet"] },
            },
          ]),
        );
      });
      const input = request();
      input.allowSilentEmpty = allowSilentEmpty;
      input.tools.push({
        name: "ask_user",
        description: "Ask for a needed decision",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: { type: "array", items: { type: "string" } },
          },
          required: ["question", "options"],
        },
      });

      const events = await run(input);
      expect(contexts).toHaveLength(3);
      expect(input.executeTool).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual({
        type: "ask",
        text: "Which output format?",
        actions: [
          { id: "choice-1", label: "Document" },
          { id: "choice-2", label: "Spreadsheet" },
        ],
      });
      expect(events.at(-1)).toEqual({ type: "done", text: "Waiting for the user's choice." });
    },
  );

  it("appends steering and finished-shell messages without rewriting earlier provider input", async () => {
    const contexts: Context[] = [];
    const rejected: number[] = [];
    providerState.stream.mockImplementation((_model: unknown, context: Context) => {
      contexts.push(structuredClone(context));
      const stale = staleThinking(context);
      if (stale !== undefined) {
        rejected.push(contexts.length - 1);
        return stream(
          reply([], "400 Invalid signature in thinking block: bound to a different conversation"),
        );
      }
      const step = contexts.length - 1;
      const thinking = {
        type: "thinking" as const,
        thinking: `Plan ${step}`,
        thinkingSignature: prefixSignature(context, context.messages.length),
      };
      const content: AssistantMessage["content"] =
        step === 0
          ? [
              thinking,
              {
                type: "toolCall",
                id: "background-shell",
                name: "shell",
                arguments: { command: "synthetic-command" },
              },
            ]
          : step < 3
            ? [
                thinking,
                { type: "toolCall", id: `logs-${step}`, name: "fetch_logs", arguments: { step } },
              ]
            : [thinking, { type: "text", text: "Done." }];
      return stream(reply(content));
    });
    const input = request();
    input.tools.push({
      name: "shell",
      description: "Run a synthetic command",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    });
    const executed: string[] = [];
    input.executeTool = async (name, _args, _executionId, _route, observer) => {
      executed.push(name);
      if (name === "shell") {
        observer?.onShellStillRunning?.(
          Promise.resolve({ stdout: "Finished original command", stderr: "", code: 0 }),
        );
        return { stdout: "Device code", stderr: "", code: null, running: true };
      }
      return { lines: "Current original result ".repeat(300) };
    };
    let delivered = false;
    const claim = vi.fn(async () => {
      if (delivered || executed.length < 2) return [];
      delivered = true;
      return [
        {
          id: "steering-1",
          messageId: "message-1",
          text: "[Connected chat] Keep the existing draft.",
        },
      ];
    });
    input.claimSteering = claim;

    expect((await run(input)).at(-1)).toEqual({
      type: "done",
      text: expect.stringContaining("Done."),
    });
    expect(rejected).toEqual([]);
    expect(contexts).toHaveLength(5);
    expect(executed).toEqual(["shell", "fetch_logs", "fetch_logs"]);
    for (let index = 1; index < contexts.length; index++) {
      const previous = contexts[index - 1]!;
      expect(JSON.stringify(contexts[index]!.messages.slice(0, previous.messages.length))).toBe(
        JSON.stringify(previous.messages),
      );
    }
    const transcript = JSON.stringify(contexts.at(-1));
    expect(transcript).toContain("A message arrived while you were working:");
    expect(transcript).toContain("[Connected chat] Keep the existing draft.");
    expect(transcript).not.toContain("The person sent this");
    expect(transcript).toContain("Shell command finished.");
    expect(transcript).toContain("Finished original command");
    expect(claim.mock.calls.slice(2)).toContainEqual([["steering-1"]]);
  });

  it("keeps a helper's sent transcript stable through its own tool steps", async () => {
    const contexts: Context[] = [];
    const rejected: number[] = [];
    let parentCalls = 0;
    let childCalls = 0;
    providerState.stream.mockImplementation((_model: unknown, context: Context) => {
      const system =
        context.systemPrompt ??
        context.messages
          .filter((message) => message.role === "system")
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => part.text).join("\n"),
          )
          .join("\n");
      if (!system.includes("subagent named")) {
        parentCalls += 1;
        return stream(
          reply(
            parentCalls === 1
              ? [
                  {
                    type: "toolCall",
                    id: "delegate",
                    name: "run_subagent",
                    arguments: { name: "fixture-helper", task: "Inspect eight log pages" },
                  },
                ]
              : [{ type: "text", text: "Done." }],
          ),
        );
      }
      contexts.push(structuredClone(context));
      const stale = staleThinking(context);
      if (stale !== undefined) {
        rejected.push(contexts.length - 1);
        return stream(
          reply(
            [],
            `400 Invalid signature in thinking block: bound to a different conversation at ${stale}`,
          ),
        );
      }
      const step = childCalls++;
      const thinking = {
        type: "thinking" as const,
        thinking: `Helper step ${step}`,
        thinkingSignature: prefixSignature(context, context.messages.length),
      };
      return stream(
        reply(
          step < 8
            ? [
                thinking,
                step === 7
                  ? {
                      type: "toolCall",
                      id: "helper-progress",
                      name: "message_user",
                      arguments: { message: "Helper progress" },
                    }
                  : {
                      type: "toolCall",
                      id: `helper-${step}`,
                      name: "fetch_logs",
                      arguments: { step },
                    },
              ]
            : [thinking, { type: "text", text: "Helper done." }],
        ),
      );
    });
    const input = request();
    input.userTimezone = "Asia/Taipei";
    input.tools.push({
      name: "run_subagent",
      description: "Delegate a short task",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, task: { type: "string" } },
        required: ["task"],
      },
    });
    input.tools.push({
      name: "message_user",
      description: "Post a short progress update",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    });

    expect((await run(input)).at(-1)).toEqual({ type: "done", text: "Done." });
    expect(rejected).toEqual([]);
    expect(contexts).toHaveLength(9);
    expect(parentCalls).toBe(2);
    for (let index = 1; index < contexts.length; index++) {
      const previous = contexts[index - 1]!;
      expect(JSON.stringify(contexts[index]!.messages.slice(0, previous.messages.length))).toBe(
        JSON.stringify(previous.messages),
      );
    }
    const first = JSON.stringify(contexts[0]);
    expect(first).toContain("Your task comes from the parent bot, not from the human user");
    expect(first).toContain("Messages marked as automated come from CogineBot");
    expect(first).not.toContain("cannot talk to the user");
    expect(first).toContain("Asia/Taipei");
    expect(input.executeTool).toHaveBeenCalledTimes(8);
    expect(input.executeTool).toHaveBeenLastCalledWith(
      "message_user",
      { message: "Helper progress" },
      expect.any(String),
      undefined,
      expect.any(Object),
    );
  });

  it.each([
    ["without saved history", []],
    [
      "with saved history",
      Array.from({ length: 40 }, (_, index) => ({
        id: `message-${index}`,
        createdAt: "2026-01-01T00:00:00Z",
        role: index % 2 ? ("assistant" as const) : ("user" as const),
        content: `Earlier discussion ${index}: ${"synthetic history ".repeat(40)}`,
      })),
    ],
  ] as const)("extends every call's transcript unchanged %s", async (_label, history) => {
    const toolCalls = 10;
    const { contexts, rejected } = bindingProvider(toolCalls);

    const events = await run(request([...history]));

    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
    expect(rejected).toEqual([]);
    expect(contexts).toHaveLength(toolCalls + 1);
    for (let call = 1; call < contexts.length; call++) {
      const previous = contexts[call - 1]!;
      const current = contexts[call]!;
      expect(current.systemPrompt).toBe(previous.systemPrompt);
      expect(current.tools).toEqual(previous.tools);
      expect(current.messages.length).toBeGreaterThan(previous.messages.length);
      expect(JSON.stringify(current.messages.slice(0, previous.messages.length))).toBe(
        JSON.stringify(previous.messages),
      );
      for (const [index, message] of previous.messages.entries()) {
        expect(providerContextPrefix("", [], [current.messages[index]!])).toEqual(
          providerContextPrefix("", [], [message]),
        );
      }
    }
    // Every reasoning block written during the run reaches the last call, and nothing was cut.
    const last = contexts.at(-1)!;
    expect(
      last.messages.flatMap((message) =>
        message.role === "assistant"
          ? message.content.filter((part) => part.type === "thinking")
          : [],
      ),
    ).toHaveLength(toolCalls);
    expect(JSON.stringify(last)).not.toContain("truncated");
  });
});
