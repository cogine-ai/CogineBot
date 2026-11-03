import type * as AgentCore from "@earendil-works/pi-agent-core";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Model, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentToolExecutionObserver } from "@rakazo/adapter-kit";
import { HistoryReadInputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { readHistory } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  stream: vi.fn(),
  agent: undefined as AgentCore.Agent | undefined,
}));
vi.mock("@earendil-works/pi-agent-core", async (original) => {
  const actual = await original<typeof AgentCore>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: AgentOptions) {
        super(options);
        providerState.agent = this;
      }
    },
  };
});
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: () => model,
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
import { CONNECTOR_REDACTION_MAX_DEPTH } from "./connector-safety.js";
import { markToolResultContent, toolResultContentProvenance } from "./context-selection.js";
import { redactStoredToolResultView } from "./executor.js";
import { PiAgentRuntime, pruneComputerScreenshotContext } from "./pi-runtime.js";
import { clipToolResultContent } from "./pi-runtime-limits.js";
import { createRuntimeContextPolicy } from "./runtime-context.js";
import { mcpToolResultRoute } from "./verbatim-mcp-result.js";

const model: Model<"openai-completions"> = {
  provider: "offline-provenance",
  id: "content-lifetime",
  name: "Offline content lifetime",
  api: "openai-completions",
  baseUrl: "https://models.invalid/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 1024,
};
const reference = { tool: "read_history" as const, arguments: { toolResultId: "active-result" } };
const nextReference = { tool: "read_history" as const, arguments: { toolResultId: "new-result" } };
let ordinal = 0;
const call = (id: string): ToolCall => ({
  type: "toolCall",
  id,
  name: "connector_read",
  arguments: { id },
});
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
function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  ordinal += 1;
  return {
    botId: "bot",
    threadId: `thread-${ordinal}`,
    runId: `run-${ordinal}`,
    prompt: "Read connector evidence.",
    instructions: "Use tools.",
    history: [],
    contextStrategy: "retrieval",
    model: { provider: model.provider, id: model.id },
    tools: [
      {
        name: "connector_read",
        description: "Read synthetic data",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        route: { connectorId: "synthetic", toolName: "read" },
      },
    ],
    ...overrides,
  };
}
const resultMessage = (context: Context, id: string) =>
  context.messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === id,
  ) as Extract<Context["messages"][number], { role: "toolResult" }>;
const decode = (message: ReturnType<typeof resultMessage>) =>
  JSON.parse(message.content.find((part) => part.type === "text")!.text);
async function run(overrides: Partial<AgentRunRequest>) {
  for await (const _event of new PiAgentRuntime().run(request(overrides), {
    signal: new AbortController().signal,
  })) {
    /* Real pinned Agent loop, deterministic offline model. */
  }
}

describe("real Pi tool-result content provenance", () => {
  beforeEach(() => {
    providerState.stream.mockReset();
    providerState.agent = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Unexpected network"))),
    );
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("isolates resolved identities when separate calls reuse a connector content array", async () => {
    const raw = {
      kind: "agent_tool_result" as const,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ body: "Original evidence ".repeat(1500) }),
        },
      ],
      details: { route: { connectorId: "mcp", resourceId: "selected" } },
    };
    const rawText = raw.content[0]!.text;
    const contexts: Context[] = [];
    providerState.stream.mockImplementation((_model, context: Context) => {
      contexts.push(context);
      const step = contexts.length;
      if (step > 1) {
        const first = resultMessage(context, "first");
        expect(mcpToolResultRoute(first.content)?.resourceId).toBe("selected");
        expect(first.content.some((part) => part.type === "text" && part.text === rawText)).toBe(
          true,
        );
      }
      if (step === 3) {
        const second = resultMessage(context, "second");
        expect(mcpToolResultRoute(second.content)?.resourceId).toBe("unselected");
        const text = second.content.filter(
          (part) => part.type === "text" && !part.text.startsWith("[Automated message"),
        );
        expect(JSON.stringify(text).length).toBeLessThan(rawText.length);
        expect(JSON.stringify(text)).toContain("contextTruncated");
        return response();
      }
      const offered =
        context.tools?.[0] ??
        context.messages.find((message) => message.role === "system")?.toolsAdded?.[0];
      if (!offered) throw new Error("Synthetic tool was not offered");
      return response([
        {
          ...call(step === 1 ? "first" : "second"),
          name: offered.name,
          arguments: { id: step === 1 ? "selected" : "unselected" },
        },
      ]);
    });
    const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(
      async (_name, args, _executionId, _route, observer) => {
        observer?.onConnectorRouteResolved?.({
          connectorId: "mcp",
          resourceId: String(args.id),
          catalogGroup: args.id === "selected" ? "research" : "research__notes",
          toolName: "search",
        });
        return raw;
      },
    );
    await run({
      model: { provider: model.provider, id: model.id, contextWindow: 200_000 },
      verbatimMcpServers: { ids: ["selected"], slugs: ["research"] },
      tools: [
        {
          name: "connectors_execute_tool",
          description: "Execute a synthetic MCP catalog selection",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          route: { connectorId: "mcp", toolName: "__catalog_execute" },
        },
      ],
      executeTool: execute,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(contexts).toHaveLength(3);
    expect(raw.content[0]!.text).toBe(rawText);
    expect(mcpToolResultRoute(raw.content)).toBeUndefined();
  });

  it.each([
    ["mcp__mail__read.events", { id: "record" }, true],
    ["connectors_execute_tool", { id: "mail-server:read", arguments: {} }, true],
    ["connectors_execute_tool", { id: "MAIL/read", arguments: {} }, true],
    ["connectors_execute_tool", { id: "mail--read", arguments: {} }, false],
    ["mcp__mailbox__read", { id: "record" }, false],
    ["mcp__other__read", { id: "record" }, false],
    ["mcp__mail__notes__read", { id: "record" }, false],
    ["connectors_execute_tool", { id: "mail__notes__read", arguments: {} }, false],
    ["connectors_execute_tool", { id: "mail-server:read", arguments: {} }, false],
    ["mcp__mail__notes__read", { id: "record" }, true],
  ] as const)(
    "preserves opted-in content and provenance for %s %j (whole: %s)",
    async (name, args, whole) => {
      const images = Array.from({ length: whole ? 3 : 1 }, (_, index) => ({
        type: "image" as const,
        data: `synthetic-${index}`,
        mimeType: "image/png",
      }));
      const raw = {
        kind: "agent_tool_result" as const,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id: "exact-id", evidence: "Original evidence ".repeat(1500) }),
          },
          { type: "text" as const, text: "Second original block ".repeat(700) },
          ...images,
        ],
        details: {
          source: "offline",
          route: { connectorId: "mcp", resourceId: "mail-server", catalogGroup: "mail" },
          verbatim: true,
          ...(whole ? { frameId: "synthetic-frame" } : {}),
        },
        isError: false,
      };
      const stored = vi.fn(async () => reference);
      const execute = vi.fn(
        async (
          _name: string,
          _args: Record<string, unknown>,
          _executionId: string,
          _route: unknown,
          observer?: AgentToolExecutionObserver,
        ) => {
          observer?.onConnectorRouteResolved?.({
            connectorId: "mcp",
            resourceId: whole ? "mail-server" : "other-server",
            catalogGroup: whole ? "mail" : "other",
            toolName: "read",
          });
          return raw;
        },
      );
      const contexts: Context[] = [];
      providerState.stream.mockImplementation((_model: unknown, context: Context) => {
        contexts.push(context);
        const offered =
          context.tools?.[0] ??
          context.messages.find((message) => message.role === "system")?.toolsAdded?.[0];
        if (!offered) throw new Error("Synthetic tool was not offered");
        return contexts.length === 1
          ? response([{ ...call("mcp-read"), name: offered.name, arguments: { ...args } }])
          : response();
      });

      await run({
        tools: [
          {
            name,
            description: "Read synthetic evidence",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" }, arguments: { type: "object" } },
            },
            route: { connectorId: "mcp", toolName: "read", connectionId: "mail-connection" },
          },
        ],
        model: { provider: model.provider, id: model.id, contextWindow: 200_000 },
        verbatimMcpServers: { ids: ["mail-server"], slugs: ["mail"] },
        executeTool: execute,
        storeToolResult: stored,
      });

      expect(execute).toHaveBeenCalledWith(
        name,
        args,
        expect.any(String),
        expect.any(Object),
        expect.any(Object),
      );
      expect(stored).toHaveBeenCalledWith(expect.objectContaining({ name, result: raw }));
      expect(contexts).toHaveLength(2);
      const sent = resultMessage(contexts[1]!, "mcp-read");
      expect(toolResultContentProvenance(sent.content)?.historyReference).toEqual(reference);
      expect(sent.content.filter((part) => part.type === "image")).toEqual(images);
      if (whole) {
        expect(
          sent.content.filter(
            (part) => part.type !== "text" || !part.text.startsWith("[Automated message"),
          ),
        ).toEqual(raw.content);
        const retained = resultMessage(
          { messages: providerState.agent!.state.messages as Context["messages"] },
          "mcp-read",
        );
        expect(retained.content).toEqual(raw.content);
        expect(toolResultContentProvenance(retained.content)?.historyReference).toEqual(reference);
      } else {
        const encoded = sent.content
          .flatMap((part) =>
            part.type === "text" && !part.text.startsWith("[Automated message") ? [part.text] : [],
          )
          .join("");
        expect(encoded.length).toBeLessThan(12_000);
        expect(JSON.parse(encoded)).toMatchObject({ historyReference: reference });
      }
      expect(JSON.stringify(raw.content).length).toBeGreaterThan(12_000);
    },
  );
  it("returns only a safe tool error when a stored read view cannot be redacted", async () => {
    let body: unknown = { id: "private-source-canary", body: "x".repeat(400) };
    for (let index = 0; index <= CONNECTOR_REDACTION_MAX_DEPTH; index += 1) body = { nested: body };
    const text = JSON.stringify(body);
    const query = vi.fn().mockResolvedValue([
      {
        id: "stored",
        runId: "run",
        createdAt: new Date(0),
        payload: { name: "connector.read", executionId: "call" },
        toolResult: { text, storedBytes: Buffer.byteLength(text) },
      },
    ]);
    providerState.stream
      .mockImplementationOnce(() =>
        response([
          {
            type: "toolCall",
            id: "failed-read",
            name: "read_history",
            arguments: { toolResultId: "stored" },
          },
        ]),
      )
      .mockImplementationOnce((_model, context: Context) => {
        const failed = resultMessage(context, "failed-read");
        expect(failed.isError).toBe(true);
        expect(failed.content).toEqual([{ type: "text", text: "redaction_error" }]);
        const wire = JSON.stringify(failed);
        for (const key of ["private-source-canary", "nextRead", "viewHash", "storageTruncated"])
          expect(wire).not.toContain(key);
        return response();
      });
    await run({
      tools: [builtinAgentTools.find((tool) => tool.name === "read_history")!],
      executeTool: async (_name, args) =>
        readHistory(
          { $queryRaw: query } as unknown as PrismaClient,
          {
            spaceId: "space",
            userId: "user",
            threadId: "thread",
            botId: "bot",
            transformToolResult: (value) => redactStoredToolResultView(value, []),
          },
          HistoryReadInputSchema.parse(args),
        ),
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("keeps an active reference after more than 1024 unrelated views and through actual Agent content identity", async () => {
    let actualContent: unknown[] | undefined;
    providerState.stream
      .mockImplementationOnce(() => response([call("old")]))
      .mockImplementationOnce((_model, context: Context) => {
        const old = resultMessage(context, "old");
        expect(old.content).toBe(actualContent);
        expect(toolResultContentProvenance(old.content)).toEqual({
          historyReference: reference,
          wrapped: true,
        });
        for (let index = 0; index < 1100; index += 1) {
          clipToolResultContent(
            [
              {
                type: "text",
                text: JSON.stringify({ id: `unrelated-${index}`, body: "x".repeat(300) }),
              },
            ],
            12000,
            { tool: "read_history", arguments: { toolResultId: `unrelated-${index}` } },
            true,
          );
        }
        return response([call("new")]);
      })
      .mockImplementationOnce((_model, context: Context) => {
        const old = resultMessage(context, "old");
        expect(old.content).toBe(actualContent);
        expect(decode(old)).toEqual({
          result: { nextCursor: "c".repeat(1800), body: "b".repeat(1000) },
          historyReference: reference,
        });
        expect(toolResultContentProvenance(old.content)).toEqual({
          historyReference: reference,
          wrapped: true,
        });
        return response();
      });
    await run({
      executeTool: async (_name, args) =>
        args.id === "old"
          ? { nextCursor: "c".repeat(1800), body: "b".repeat(1000) }
          : { id: "done" },
      storeToolResult: async () => reference,
      onToolCompleted: (completion) => {
        if (completion.executionId.includes("old"))
          actualContent = (completion.result as { content: unknown[] }).content;
      },
    });
    expect(providerState.stream).toHaveBeenCalledTimes(3);
  });

  it.each([
    { healthy: true, outer: false },
    { healthy: false, outer: false },
    { healthy: true, outer: true },
    { healthy: false, outer: true },
  ])(
    "treats a fresh echoed view as new data (healthy=$healthy outer=$outer)",
    async ({ healthy, outer }) => {
      let echoed: unknown;
      providerState.stream
        .mockImplementationOnce(() => response([call("original")]))
        .mockImplementationOnce((_model, context: Context) => {
          const original = resultMessage(context, "original");
          const text = original.content.find((part) => part.type === "text")!.text;
          echoed = outer
            ? {
                content: [{ type: "text", text }],
                _meta: { id: "new-outer-evidence", body: "new outer body ".repeat(80) },
              }
            : JSON.parse(text);
          return response([call("echo")]);
        })
        .mockImplementationOnce((_model, context: Context) => {
          const echo = resultMessage(context, "echo");
          expect(toolResultContentProvenance(echo.content)?.historyReference).toEqual(
            healthy ? nextReference : undefined,
          );
          if (healthy || !outer) expect(decode(echo).result).toEqual(echoed);
          expect(decode(echo).historyReference).toEqual(healthy ? nextReference : undefined);
          return response([call("last")]);
        })
        .mockImplementationOnce((_model, context: Context) => {
          const echo = resultMessage(context, "echo");
          if (healthy) expect(decode(echo).historyReference).toEqual(nextReference);
          else if (outer) expect(decode(echo)).toEqual(echoed);
          else expect(decode(echo)).toMatchObject({ historyUnavailable: true });
          expect(toolResultContentProvenance(echo.content)?.historyReference).toEqual(
            healthy ? nextReference : undefined,
          );
          expect(decode(echo).historyReference).not.toEqual(reference);
          if (outer) expect(JSON.stringify(decode(echo))).toContain("new-outer-evidence");
          return response();
        });
      await run({
        executeTool: async (_name, args) =>
          args.id === "original"
            ? { id: "original-id", body: "x".repeat(2000) }
            : args.id === "echo"
              ? echoed
              : { id: "done" },
        storeToolResult: async (input) =>
          input.executionId.includes("original") ? reference : healthy ? nextReference : undefined,
      });
      expect(providerState.stream).toHaveBeenCalledTimes(4);
    },
  );

  it("copies private ownership through image pruning and model-only labels without changing raw identities", () => {
    const image = { type: "image" as const, data: "synthetic", mimeType: "image/png" };
    const content = markToolResultContent(
      [
        {
          type: "text" as const,
          text: JSON.stringify({ result: { id: "owned" }, historyReference: reference }),
        },
        image,
      ],
      { historyReference: reference, wrapped: true },
    );
    const message = {
      role: "toolResult" as const,
      toolCallId: "image",
      toolName: "computer_observe",
      content,
      details: { frameId: "synthetic-frame" },
      isError: false,
      timestamp: 1,
    };
    const pruned = pruneComputerScreenshotContext([message], 0)[0] as typeof message;
    expect(pruned.content).not.toBe(content);
    expect(toolResultContentProvenance(pruned.content)).toEqual(
      toolResultContentProvenance(content),
    );
    const raw: Context = { messages: [message], tools: [] };
    const policy = createRuntimeContextPolicy(request({ contextStrategy: "current" }));
    const view = policy.prepareContext(raw, model);
    const projected = view.messages[0] as typeof message;
    expect(projected.content).not.toBe(content);
    expect(toolResultContentProvenance(projected.content)).toEqual(
      toolResultContentProvenance(content),
    );
    expect(raw.messages[0]).toBe(message);
    expect(message.content).toBe(content);
    expect(message.content[1]).toBe(image);
  });

  it("ignores prior private metadata when a provider reuses an owned content array", async () => {
    let priorContent: ReturnType<typeof resultMessage>["content"];
    providerState.stream
      .mockImplementationOnce(() => response([call("original")]))
      .mockImplementationOnce((_model, context: Context) => {
        priorContent = resultMessage(context, "original").content;
        return response([call("reuse")]);
      })
      .mockImplementationOnce((_model, context: Context) => {
        const fresh = resultMessage(context, "reuse");
        expect(fresh.content).not.toBe(priorContent);
        expect(toolResultContentProvenance(fresh.content)).toEqual({
          historyReference: undefined,
          wrapped: true,
        });
        expect(toolResultContentProvenance(priorContent)).toEqual({
          historyReference: reference,
          wrapped: true,
        });
        expect(decode(fresh)).toMatchObject({
          historyUnavailable: true,
          result: { content: priorContent },
        });
        return response();
      });
    await run({
      executeTool: async (_name, args) =>
        args.id === "original"
          ? { id: "original", body: "x".repeat(300) }
          : { kind: "agent_tool_result", content: priorContent!, details: {} },
      storeToolResult: async (input) =>
        input.executionId.includes("original") ? reference : undefined,
    });
    expect(providerState.stream).toHaveBeenCalledTimes(3);
  });
});
