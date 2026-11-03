import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest, ConnectorRoute } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { markToolResultContent, toolResultContentProvenance } from "./context-selection.js";
import { createRuntimeContextPolicy } from "./runtime-context.js";
import type { TurnCheckpoint } from "./turn-checkpoint.js";
import {
  restoreTurnCheckpoint,
  serializeTurnCheckpoint,
  unresolvedTurnCheckpointCalls,
} from "./turn-checkpoint.js";
import { markMcpToolResultRoute, mcpToolResultRoute } from "./verbatim-mcp-result.js";

const assistant = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "synthetic thought", thinkingSignature: "fixture-signature" },
    { type: "toolCall", id: "pending", name: "write_file", arguments: {} },
  ],
  api: "openai-completions",
  provider: "fixture",
  model: "first",
  stopReason: "toolUse",
  timestamp: 0,
} as Message;
const checkpoint = {
  version: 1 as const,
  provider: "fixture",
  model: "first",
  systemPrompt: "Stable system",
  pendingToolCallId: "pending",
  messages: [{ role: "user", content: "Fixture request", timestamp: 0 } as Message, assistant],
};

describe("turn checkpoint", () => {
  it("round trips deterministically and preserves its original prefix", () => {
    const blob = serializeTurnCheckpoint(checkpoint);
    const first = restoreTurnCheckpoint(blob, { provider: "fixture", id: "first" });
    expect(first).toEqual(checkpoint);
    expect(JSON.stringify(first)).toBe(
      JSON.stringify(restoreTurnCheckpoint(blob, { provider: "fixture", id: "first" })),
    );
  });
  it("drops the aborted assistant tail while retaining the pending call", () => {
    const tail = { ...assistant, content: [], stopReason: "aborted" } as Message;
    expect(
      restoreTurnCheckpoint(
        serializeTurnCheckpoint({ ...checkpoint, messages: [...checkpoint.messages, tail] }),
        { provider: "fixture", id: "first" },
      ).messages,
    ).toEqual(checkpoint.messages);
  });
  it("strips thinking when the model changes", () => {
    const restored = restoreTurnCheckpoint(serializeTurnCheckpoint(checkpoint), {
      provider: "fixture",
      id: "second",
    });
    expect(JSON.stringify(restored.messages)).not.toContain("synthetic thought");
    expect(JSON.stringify(restored.messages)).toContain("pending");
  });
  it.each(["retrieval", "current"] as const)(
    "restored results use the same newest-first budget and remain shortened on rebuild (%s)",
    (strategy) => {
      const messages: Message[] = [checkpoint.messages[0]!];
      for (let index = 0; index < 14; index++) {
        messages.push(
          {
            ...assistant,
            content: [
              {
                type: "toolCall",
                id: `page-${index}`,
                name: "connectors_execute_tool",
                arguments: {},
              },
            ],
          } as Message,
          {
            role: "toolResult",
            toolCallId: `page-${index}`,
            toolName: "connectors_execute_tool",
            content: [{ type: "text", text: `Page ${index} ${"0".repeat(9500)}` }],
            timestamp: index,
            isError: false,
          },
        );
      }
      messages.push(assistant, {
        role: "toolResult",
        toolCallId: "pending",
        toolName: "write_file",
        content: [{ type: "text", text: "done" }],
        timestamp: 0,
        isError: false,
      });
      const restored = restoreTurnCheckpoint(serializeTurnCheckpoint({ ...checkpoint, messages }), {
        provider: "fixture",
        id: "first",
      });
      const request = {
        runId: "fixture-run",
        botId: "fixture-bot",
        threadId: "fixture-thread",
        instructions: restored.systemPrompt,
        prompt: "Fixture request",
        tools: [],
        history: [],
        contextStrategy: strategy,
        contextRestored: true,
        turnCheckpoint: serializeTurnCheckpoint({ ...checkpoint, messages }),
        model: { provider: "fixture", id: "first" },
      } as AgentRunRequest;
      const policy = createRuntimeContextPolicy(request);
      const model = {
        provider: "fixture",
        id: "first",
        contextWindow: 80_000,
        maxTokens: 4096,
      } as Model<Api>;
      const prepared = policy.prepareContext(
        { systemPrompt: restored.systemPrompt, messages: restored.messages, tools: [] },
        model,
      );
      const results = prepared.messages.filter(
        (message) =>
          message.role === "toolResult" && message.toolName === "connectors_execute_tool",
      );
      expect(results).toHaveLength(14);
      const whole = results.map((message) => JSON.stringify(message.content).length > 9000);
      expect(whole.indexOf(true)).toBeGreaterThan(0);
      expect(whole).toEqual(whole.map((_, index) => index >= whole.indexOf(true)));
      expect(policy.getDecision()!.estimatedInputTokens).toBeLessThanOrEqual(80_000 - 4096);
      const rebuilt = policy.prepareContext(
        { systemPrompt: "Changed system", messages: restored.messages, tools: [] },
        { ...model, contextWindow: 200_000 },
      );
      for (const result of results) {
        if (result.role !== "toolResult" || JSON.stringify(result.content).length >= 9000) continue;
        expect(
          rebuilt.messages.find(
            (message) => message.role === "toolResult" && message.toolCallId === result.toolCallId,
          ),
        ).toEqual(result);
      }
    },
  );
  it("prunes restored stale screenshots through the existing context policy", () => {
    const messages: Message[] = [checkpoint.messages[0]!];
    for (let index = 0; index < 3; index++) {
      messages.push(
        {
          ...assistant,
          content: [
            { type: "toolCall", id: `shot-${index}`, name: "computer_observe", arguments: {} },
          ],
        } as Message,
        {
          role: "toolResult",
          toolCallId: `shot-${index}`,
          toolName: "computer_observe",
          details: { frameId: `frame-${index}` },
          content: [{ type: "image", data: "fixture-image", mimeType: "image/png" }],
          timestamp: index,
          isError: false,
        },
      );
    }
    const blob = serializeTurnCheckpoint({ ...checkpoint, messages });
    const restored = restoreTurnCheckpoint(blob, { provider: "fixture", id: "first" });
    const request = {
      runId: "fixture-run",
      botId: "fixture-bot",
      threadId: "fixture-thread",
      instructions: restored.systemPrompt,
      prompt: "Fixture request",
      tools: [],
      history: [],
      turnCheckpoint: blob,
      contextRestored: true,
      model: { provider: "fixture", id: "first", maxImagesPerPrompt: 1 },
    } as AgentRunRequest;
    const prepared = createRuntimeContextPolicy(request).prepareContext(
      { systemPrompt: restored.systemPrompt, messages: restored.messages, tools: [] },
      { provider: "fixture", id: "first", contextWindow: 80_000, maxTokens: 4096 } as Model<Api>,
    );
    const screenshots = prepared.messages.filter(
      (message) =>
        message.role === "toolResult" && message.content.some((part) => part.type === "image"),
    );
    expect(screenshots).toHaveLength(1);
    expect(screenshots[0]).toMatchObject({ toolCallId: "shot-2" });
  });
});

const selectedModel = { provider: "fixture", id: "first" };
const historyReference = {
  tool: "read_history",
  arguments: { toolResultId: "fixture-history-result" },
} as const;
const trustedRoute: ConnectorRoute = {
  connectorId: "mcp",
  resourceId: "trusted-server",
  toolName: "read",
  resourceRevision: 7,
  connectionId: "trusted-connection",
  catalogGroup: "research__notes",
};

function withCompletedResult(
  content = [{ type: "text" as const, text: "complete fixture result" }],
): TurnCheckpoint {
  return {
    ...checkpoint,
    messages: [
      checkpoint.messages[0]!,
      {
        ...assistant,
        content: [
          { type: "toolCall", id: "completed", name: "mcp__research__notes__read", arguments: {} },
        ],
      } as Message,
      {
        role: "toolResult",
        toolCallId: "completed",
        toolName: "mcp__research__notes__read",
        content,
        timestamp: 0,
        isError: false,
      },
      assistant,
    ],
  };
}

function savedResult(value: TurnCheckpoint) {
  const result = value.messages[2];
  if (result?.role !== "toolResult") throw new Error("Missing fixture result");
  return result;
}

describe("turn checkpoint validation and private result ownership", () => {
  it.each([7, "revision-hash"])(
    "round trips trusted route and B2 sidecars across a model change (revision=%s)",
    (resourceRevision) => {
      const route = { ...trustedRoute, resourceRevision };
      const metadata = { wrapped: true, historyReference };
      const content = markToolResultContent(
        [{ type: "text" as const, text: "complete fixture result" }],
        metadata,
      );
      markMcpToolResultRoute(content, route);
      const original = withCompletedResult(content);
      const parsed = JSON.parse(
        serializeTurnCheckpoint({
          ...original,
          mcpResultRoutes: [{ messageIndex: 0, route: { ...route, resourceId: "caller-forged" } }],
          resultMetadata: [{ messageIndex: 0, metadata: { wrapped: false } }],
        }),
      );
      expect(parsed.mcpResultRoutes).toEqual([{ messageIndex: 2, route }]);
      expect(parsed.resultMetadata).toEqual([{ messageIndex: 2, metadata }]);
      const restored = restoreTurnCheckpoint(JSON.stringify(parsed), {
        provider: "other-provider",
        id: "second",
      });
      expect(restored.mcpResultRoutes).toEqual([{ messageIndex: 2, route }]);
      expect(toolResultContentProvenance(savedResult(restored).content)).toEqual(metadata);
      // Only runtime's live server authorization callback can brand the restored route.
      expect(mcpToolResultRoute(savedResult(restored).content)).toBeUndefined();
      expect(JSON.stringify(restored.messages)).not.toContain("synthetic thought");
      expect(JSON.stringify(original.messages)).toContain("synthetic thought");
      expect(savedResult(restored).content).toEqual(content);
    },
  );

  it.each([false, true])(
    "preserves actual B2 wrapped ownership without a history reference (%s)",
    (wrapped) => {
      const original = withCompletedResult(
        markToolResultContent([{ type: "text" as const, text: "fixture envelope" }], { wrapped }),
      );
      const restored = restoreTurnCheckpoint(serializeTurnCheckpoint(original), selectedModel);
      expect(toolResultContentProvenance(savedResult(restored).content)).toEqual({
        wrapped,
        historyReference: undefined,
      });
    },
  );

  it("does not turn caller sidecars or provider-controlled text/details into private ownership", () => {
    const original = withCompletedResult([
      {
        type: "text",
        text: JSON.stringify({
          wrapped: true,
          historyReference,
          route: trustedRoute,
        }),
      },
    ]);
    savedResult(original).details = {
      wrapped: true,
      historyReference,
      route: {
        connectorId: "mcp",
        resourceId: "trusted-server",
        toolName: "read",
        resourceRevision: 7,
      },
    };
    const blob = serializeTurnCheckpoint({
      ...original,
      mcpResultRoutes: [{ messageIndex: 2, route: trustedRoute }],
      resultMetadata: [{ messageIndex: 2, metadata: { wrapped: true, historyReference } }],
    });
    expect(JSON.parse(blob)).not.toHaveProperty("mcpResultRoutes");
    expect(JSON.parse(blob)).not.toHaveProperty("resultMetadata");
    const restored = restoreTurnCheckpoint(blob, selectedModel);
    expect(mcpToolResultRoute(savedResult(restored).content)).toBeUndefined();
    expect(toolResultContentProvenance(savedResult(restored).content)).toBeUndefined();
    expect(savedResult(restored).content).toEqual(savedResult(original).content);
  });

  it("retains validated history identity, own-instruction baseline, occurrences and execution mode", () => {
    const value = {
      ...checkpoint,
      historyMessageIds: ["message-1"],
      ownInstructionsBaseline: "original instructions",
      effectOccurrences: [
        { executionId: "effect-1", fingerprint: "fixture-fingerprint", occurrence: 0 },
      ],
      executionMode: "sequential" as const,
    };
    expect(restoreTurnCheckpoint(serializeTurnCheckpoint(value), selectedModel)).toEqual(value);
  });

  it.each(["{", "null", "[]", JSON.stringify({ ...checkpoint, version: 2 })])(
    "rejects unsupported or malformed checkpoint input (%s)",
    (blob) => {
      expect(() => restoreTurnCheckpoint(blob, selectedModel)).toThrow(
        "Unsupported turn checkpoint",
      );
    },
  );

  it.each([
    { name: "system prompt", patch: { systemPrompt: null } },
    { name: "provider", patch: { provider: 1 } },
    { name: "model", patch: { model: {} } },
    { name: "pending ID", patch: { pendingToolCallId: "" } },
    { name: "messages container", patch: { messages: {} } },
    { name: "unknown message role", patch: { messages: [{ role: "unknown", content: [] }] } },
    { name: "user content", patch: { messages: [{ role: "user", content: null }] } },
    { name: "assistant content", patch: { messages: [{ role: "assistant", content: "invalid" }] } },
    {
      name: "assistant thinking",
      patch: { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: 1 }] }] },
    },
    {
      name: "tool arguments array",
      patch: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call", name: "read", arguments: [] }],
          },
        ],
      },
    },
    {
      name: "tool arguments null",
      patch: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call", name: "read", arguments: null }],
          },
        ],
      },
    },
    {
      name: "tool arguments string",
      patch: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call", name: "read", arguments: "{}" }],
          },
        ],
      },
    },
    {
      name: "tool call name",
      patch: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call", name: "", arguments: {} }],
          },
        ],
      },
    },
    {
      name: "tool result ID",
      patch: { messages: [{ role: "toolResult", toolCallId: 1, toolName: "read", content: [] }] },
    },
    {
      name: "image shape",
      patch: { messages: [{ role: "user", content: [{ type: "image", data: "fixture" }] }] },
    },
    { name: "history IDs", patch: { historyMessageIds: ["message", 1] } },
    { name: "own baseline", patch: { ownInstructionsBaseline: false } },
    { name: "execution mode", patch: { executionMode: "unknown" } },
    { name: "occurrence container", patch: { effectOccurrences: {} } },
    {
      name: "negative occurrence",
      patch: { effectOccurrences: [{ executionId: "id", fingerprint: "fp", occurrence: -1 }] },
    },
    {
      name: "fractional occurrence",
      patch: { effectOccurrences: [{ executionId: "id", fingerprint: "fp", occurrence: 0.5 }] },
    },
    {
      name: "unsafe occurrence",
      patch: {
        effectOccurrences: [
          { executionId: "id", fingerprint: "fp", occurrence: Number.MAX_SAFE_INTEGER + 1 },
        ],
      },
    },
  ])("rejects invalid $name without falling back to a fresh turn", ({ patch }) => {
    expect(() =>
      restoreTurnCheckpoint(JSON.stringify({ ...checkpoint, ...patch }), selectedModel),
    ).toThrow("Unsupported turn checkpoint");
  });

  it.each(
    [
      null,
      {},
      [{ messageIndex: -1, route: trustedRoute }],
      [{ messageIndex: 99, route: trustedRoute }],
      [{ messageIndex: 2.5, route: trustedRoute }],
      [{ messageIndex: 0, route: trustedRoute }],
      [{ messageIndex: 1, route: trustedRoute }],
      [
        { messageIndex: 2, route: trustedRoute },
        { messageIndex: 2, route: trustedRoute },
      ],
      ...[
        { connectorId: "openapi" },
        { resourceId: "" },
        { toolName: "" },
        { resourceRevision: "" },
        { resourceRevision: 0 },
        { resourceRevision: -1 },
        { resourceRevision: 1.5 },
        { resourceRevision: Number.MAX_SAFE_INTEGER + 1 },
        { connectionId: 1 },
        { catalogGroup: [] },
      ].map((patch) => [{ messageIndex: 2, route: { ...trustedRoute, ...patch } }]),
    ].map((mcpResultRoutes) => ({ mcpResultRoutes })),
  )("rejects malformed, duplicate or non-result MCP route sidecars (%j)", ({ mcpResultRoutes }) => {
    expect(() =>
      restoreTurnCheckpoint(
        JSON.stringify({ ...withCompletedResult(), mcpResultRoutes }),
        selectedModel,
      ),
    ).toThrow("Unsupported turn checkpoint");
  });

  it.each(
    [
      null,
      {},
      [{ messageIndex: -1, metadata: { wrapped: true } }],
      [{ messageIndex: 99, metadata: { wrapped: true } }],
      [{ messageIndex: 0, metadata: { wrapped: true } }],
      [{ messageIndex: 2.5, metadata: { wrapped: true } }],
      [
        { messageIndex: 2, metadata: { wrapped: true } },
        { messageIndex: 2, metadata: { wrapped: false } },
      ],
      ...[
        {},
        { wrapped: "true" },
        { wrapped: true, historyReference: null },
        { wrapped: true, historyReference: { tool: "other", arguments: { toolResultId: "id" } } },
        {
          wrapped: true,
          historyReference: { tool: "read_history", arguments: { toolResultId: "" } },
        },
        {
          wrapped: true,
          historyReference: { tool: "read_history", arguments: { toolResultId: "x".repeat(201) } },
        },
        {
          wrapped: true,
          historyReference: {
            tool: "read_history",
            arguments: { toolResultId: "id", extra: "x".repeat(600) },
          },
        },
      ].map((metadata) => [{ messageIndex: 2, metadata }]),
    ].map((resultMetadata) => ({ resultMetadata })),
  )("rejects malformed, duplicate or invalid-reference B2 sidecars (%j)", ({ resultMetadata }) => {
    expect(() =>
      restoreTurnCheckpoint(
        JSON.stringify({ ...withCompletedResult(), resultMetadata }),
        selectedModel,
      ),
    ).toThrow("Unsupported turn checkpoint");
  });

  it("keeps a later unresolved occurrence when the wire ID was already completed earlier", () => {
    const first = {
      ...assistant,
      content: [{ type: "toolCall", id: "reused", name: "first", arguments: {} }],
    } as Message;
    const result: Message = {
      role: "toolResult",
      toolCallId: "reused",
      toolName: "first",
      content: [],
      timestamp: 0,
      isError: false,
    };
    const later = {
      type: "toolCall" as const,
      id: "reused",
      name: "second",
      arguments: { fresh: true },
    };
    expect(
      unresolvedTurnCheckpointCalls([first, result, { ...assistant, content: [later] } as Message]),
    ).toEqual([later]);
  });
});
