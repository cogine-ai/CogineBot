import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import { PAGE_SOURCE_MAX_BYTES } from "@rakazo/contracts";
import { PAGE_KIT_GUIDE } from "@rakazo/page-kit/validate";
import { describe, expect, it, vi } from "vitest";
import { catalogExecuteToolName } from "./approval-effect.js";
import {
  boundToolResultText,
  ContextBudgetError,
  ContextCacheTracker,
  markToolResultContent,
  toolResultContentProvenance,
} from "./context-selection.js";
import * as outputBudget from "./pi-output-budget.js";
import { effectivePiOutputTokens } from "./pi-output-budget.js";
import { createRuntimeContextPolicy } from "./runtime-context.js";
import { markMcpToolResultRoute, mcpToolResultRoute } from "./verbatim-mcp-result.js";

const model = {
  id: "synthetic-model",
  provider: "synthetic-provider",
  baseUrl: "https://synthetic.invalid",
  contextWindow: 65536,
  maxTokens: 4096,
} as Model<Api>;
function fixture(count = 30) {
  const history = Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    createdAt: "2026-01-01T00:00:00Z",
    role: "user" as const,
    content: `Original discussion ${index}: ${"synthetic history ".repeat(30)}`,
  }));
  const request: AgentRunRequest = {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    instructions: "Stable instructions",
    prompt: "Current objective",
    history,
    tools: [],
    model: { provider: "synthetic-provider", id: "synthetic-model" },
  };
  const messages: Message[] = history.map((item) => ({
    role: "user",
    content: item.content,
    timestamp: 0,
    rakazoHistory: true,
    rakazoMessageId: item.id,
  }));
  messages.push({ role: "user", content: request.prompt, timestamp: 100 });
  const context: Context = { systemPrompt: request.instructions, tools: [], messages };
  return { request, context };
}
function enableHistoryRetrieval(request: AgentRunRequest) {
  request.tools = ["read_history", "search_history"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
  }));
  request.executeTool = async () => ({});
}
describe("runtime context policy", () => {
  it.each(["save_page", "use_tool"])(
    "tells the model when a whole Page source cannot fit through %s",
    (name) => {
      const { request, context } = fixture(0);
      const page = {
        pageId: "page-1",
        version: 2,
        title: "Saved page",
        source: "A".repeat(PAGE_SOURCE_MAX_BYTES),
      };
      const args = { pageId: page.pageId };
      const ordinary = "Other tool evidence ".repeat(125);
      context.messages.push(
        fauxAssistantMessage([
          {
            type: "toolCall",
            id: "page-read",
            name,
            arguments: name === "use_tool" ? { name: "save_page", arguments: args } : args,
          },
          { type: "toolCall", id: "other-result", name: "shell", arguments: {} },
        ]),
        {
          role: "toolResult",
          toolCallId: "page-read",
          toolName: name,
          content: [{ type: "text", text: JSON.stringify(page) }],
          isError: false,
          timestamp: 101,
        },
        {
          role: "toolResult",
          toolCallId: "other-result",
          toolName: "shell",
          content: [{ type: "text", text: ordinary }],
          isError: false,
          timestamp: 101,
        },
      );
      const policy = createRuntimeContextPolicy(request);
      const prepared = policy.prepareContext(context, {
        ...model,
        contextWindow: 8192,
        maxTokens: 512,
      });
      const result = prepared.messages.find((message) => message.role === "toolResult");
      expect(result?.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            contextTruncated: true,
            error:
              "The Page source does not fit this model context. Use a model with a larger context window before editing this Page.",
            pageId: page.pageId,
            version: page.version,
          }),
        },
      ]);
      expect(
        prepared.messages.find(
          (message) => message.role === "toolResult" && message.toolCallId === "other-result",
        )?.content,
      ).toEqual([{ type: "text", text: ordinary }]);
      const roomy = createRuntimeContextPolicy(request).prepareContext(context, {
        ...model,
        contextWindow: 150000,
        maxTokens: 512,
      });
      expect(roomy.messages.find((message) => message.role === "toolResult")?.content).toEqual([
        { type: "text", text: JSON.stringify(page) },
      ]);
    },
  );

  it("preserves a deferred Page Kit guide after it has been read when it still fits", () => {
    const { request, context } = fixture(0);
    const guide = JSON.stringify({ guide: PAGE_KIT_GUIDE });
    context.messages.push(
      fauxAssistantMessage([
        {
          type: "toolCall",
          id: "guide",
          name: "use_tool",
          arguments: {
            name: "save_page",
            arguments: { help: true },
          },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "guide",
        toolName: "use_tool",
        content: [{ type: "text", text: guide }],
        isError: false,
        timestamp: 101,
      },
    );
    for (let index = 0; index < 3; index++) {
      const id = `shell-${index}`;
      context.messages.push(
        fauxAssistantMessage([{ type: "toolCall", id, name: "shell", arguments: {} }]),
        {
          role: "toolResult",
          toolCallId: id,
          toolName: "shell",
          content: [{ type: "text", text: "x".repeat(2800) }],
          isError: false,
          timestamp: index + 102,
        },
      );
    }
    const prepared = createRuntimeContextPolicy(request).prepareContext(context, {
      ...model,
      contextWindow: 10000,
      maxTokens: 512,
    });
    const result = prepared.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "guide",
    );
    expect(result?.content).toEqual([{ type: "text", text: guide }]);
  });

  it("retains a full Page source when it fits the model but not the optional rebuild headroom", () => {
    const { request, context } = fixture(6);
    const small = { ...model, contextWindow: 8192, maxTokens: 512 };
    const policy = createRuntimeContextPolicy(request);
    const before = policy.prepareContext(context, small);
    expect(before.messages).toHaveLength(context.messages.length);
    const source = JSON.stringify({ pageId: "page-1", version: 2, source: "A".repeat(23_000) });
    context.messages.push(
      fauxAssistantMessage([
        { type: "toolCall", id: "page", name: "save_page", arguments: { pageId: "page-1" } },
      ]),
      {
        role: "toolResult",
        toolCallId: "page",
        toolName: "save_page",
        content: [{ type: "text", text: source }],
        isError: false,
        timestamp: 101,
      },
    );
    const after = policy.prepareContext(context, small);
    expect(after.messages.length).toBeLessThan(context.messages.length);
    expect(after.messages.at(-1)?.content).toEqual([{ type: "text", text: source }]);
  });

  it("explicitly omits a Page Kit guide that cannot fit the actual input budget", () => {
    const { request, context } = fixture(0);
    context.messages.push(
      fauxAssistantMessage([
        { type: "toolCall", id: "guide", name: "save_page", arguments: { help: true } },
      ]),
      {
        role: "toolResult",
        toolCallId: "guide",
        toolName: "save_page",
        content: [{ type: "text", text: JSON.stringify({ guide: PAGE_KIT_GUIDE }) }],
        isError: false,
        timestamp: 101,
      },
    );
    const after = createRuntimeContextPolicy(request).prepareContext(context, {
      ...model,
      contextWindow: 2800,
      maxTokens: 512,
    });
    expect(after.messages.at(-1)?.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          contextTruncated: true,
          error:
            "The Page Kit guide does not fit this model context. Use a model with a larger context window before building a Page.",
        }),
      },
    ]);
  });

  it.each([
    { reusedId: false, identicalBodies: false },
    { reusedId: true, identicalBodies: false },
    { reusedId: true, identicalBodies: true },
  ])(
    "keeps shortened results attached to their own call occurrence (reused ID: $reusedId, identical body: $identicalBodies)",
    ({ reusedId, identicalBodies }) => {
      const { request, context } = fixture(0);
      request.contextStrategy = "retrieval";
      const oldId = "earlier-call";
      const newId = reusedId ? oldId : "new-call";
      const oldText = JSON.stringify({
        id: "old-result",
        evidence: "0123456789".repeat(identicalBodies ? 400 : 1000),
      });
      const newText = identicalBodies
        ? oldText
        : JSON.stringify({ id: "new-result", evidence: "new details ".repeat(300) });
      context.messages.push(
        fauxAssistantMessage([{ type: "toolCall", id: oldId, name: "shell", arguments: {} }]),
        {
          role: "toolResult",
          toolCallId: oldId,
          toolName: "shell",
          content: [{ type: "text", text: oldText }],
          isError: false,
          timestamp: 1,
        },
        fauxAssistantMessage([{ type: "toolCall", id: newId, name: "shell", arguments: {} }]),
        {
          role: "toolResult",
          toolCallId: newId,
          toolName: "shell",
          content: [{ type: "text", text: newText }],
          isError: false,
          timestamp: 2,
        },
      );
      const policy = createRuntimeContextPolicy(request);
      const selectedModel = { ...model, contextWindow: 6000, maxTokens: 512 };
      const first = policy.prepareContext(context, selectedModel);
      const firstResults = first.messages.filter((message) => message.role === "toolResult");
      expect(firstResults).toHaveLength(2);
      expect(JSON.stringify(firstResults[0]!.content)).toContain("contextTruncated");
      expect(firstResults[1]!.content).toEqual([{ type: "text", text: newText }]);
      const next = policy.prepareContext(
        { ...context, systemPrompt: "Changed instructions" },
        selectedModel,
      );
      const nextResults = next.messages.filter((message) => message.role === "toolResult");
      expect(nextResults[1]!.content).toEqual([{ type: "text", text: newText }]);
      expect(
        context.messages.filter((message) => message.role === "toolResult")[0]!.content,
      ).toEqual([{ type: "text", text: oldText }]);
    },
  );
  it("isolates cache predictions and projections by connection ID even with identical provider credentials", () => {
    const { request, context } = fixture(120);
    enableHistoryRetrieval(request);
    request.threadId = "same-key-distinct-connections";
    request.model.apiKey = "fixture-same-key";
    request.model.modelCredentialId = "connection-a";
    request.model.cacheCapabilities = { scope: "connection", retentionMs: 300_000 };
    const tracker = new ContextCacheTracker(() => 100);
    const adapter = { userId: "same-user", spaceId: "same-space" };
    const a = createRuntimeContextPolicy(request, adapter, {
      cacheTracker: tracker,
      credentialScope: "same-resolved-key",
    });
    a.prepareContext(context, model);
    a.onUsage({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 0 });
    const same = createRuntimeContextPolicy(request, adapter, {
      cacheTracker: tracker,
      credentialScope: "same-resolved-key",
    });
    same.prepareContext(context, model);
    expect(same.getDecision()?.predictedCache).toBe("likely-warm");
    const otherRequest = {
      ...request,
      model: { ...request.model, modelCredentialId: "connection-b" },
    };
    const b = createRuntimeContextPolicy(otherRequest, adapter, {
      cacheTracker: tracker,
      credentialScope: "same-resolved-key",
    });
    const actual = b.prepareContext(context, model);
    expect(b.getDecision()?.predictedCache).toBe("likely-cold");
    const control = createRuntimeContextPolicy(otherRequest, adapter, {
      cacheTracker: new ContextCacheTracker(() => 100),
      credentialScope: "same-resolved-key",
    });
    expect(actual).toEqual(control.prepareContext(context, model));
  });
  it("bounds a restored diagnostic context only for the trusted boolean hint", () => {
    const { request, context } = fixture(120);
    const unbounded = createRuntimeContextPolicy({
      ...request,
      contextStrategy: "current",
      contextRestored: false,
    });
    expect(unbounded.prepareContext(context, model).messages).toHaveLength(context.messages.length);
    const restored = createRuntimeContextPolicy({
      ...request,
      contextStrategy: "current",
      contextRestored: true,
    });
    expect(restored.prepareContext(context, model).messages.length).toBeLessThan(
      context.messages.length,
    );
    expect(restored.getDecision()?.strategy).toBe(DEFAULT_CONTEXT_STRATEGY);
    const notTrusted = createRuntimeContextPolicy({
      ...request,
      contextStrategy: "current",
      contextRestored: "true" as unknown as boolean,
    });
    expect(notTrusted.prepareContext(context, model).messages).toHaveLength(
      context.messages.length,
    );
  });
  it.each(["account", "connection"] as const)(
    "automatically preserves a selected prefix while a declared %s cache is warm",
    (scope) => {
      let now = 0;
      const tracker = new ContextCacheTracker(() => now);
      const { request, context } = fixture(120);
      const original = JSON.stringify({ history: request.history, context });
      request.threadId = `automatic-prefix-${scope}`;
      enableHistoryRetrieval(request);
      request.model.cacheCapabilities = { scope, retentionMs: 300000 };
      const first = createRuntimeContextPolicy(request, undefined, { cacheTracker: tracker });
      const initial = first.prepareContext(context, model);
      expect(first.getDecision()).toMatchObject({
        strategy: "cache-aware",
        predictedCache: "likely-cold",
      });
      expect(initial.messages.length).toBeLessThan(context.messages.length);
      const navigation = String(initial.messages[0]!.content);
      expect(navigation).toContain("Historical navigation snapshots");
      const referencedIds = [...navigation.matchAll(/\[message (message-\d+) at /g)].map(
        (match) => match[1],
      );
      expect(referencedIds.length).toBeGreaterThan(0);
      for (const id of referencedIds)
        expect(request.history.some((item) => item.id === id)).toBe(true);
      expect(initial.messages.at(-1)).toBe(context.messages.at(-1));
      expect(initial.messages.at(-2)).toBe(context.messages.at(-2));
      first.onUsage({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0 });
      now = 1000;
      const next = createRuntimeContextPolicy(request, undefined, { cacheTracker: tracker });
      const continued = next.prepareContext(
        {
          ...context,
          messages: [
            ...context.messages,
            { role: "user", content: "Next question", timestamp: now },
          ],
        },
        model,
      );
      expect(next.getDecision()).toMatchObject({
        strategy: "cache-aware",
        predictedCache: "likely-warm",
      });
      expect(continued.messages.slice(0, initial.messages.length)).toEqual(initial.messages);
      expect(continued.messages).toHaveLength(initial.messages.length + 1);
      now = 300000;
      next.prepareContext(context, model);
      expect(next.getDecision()!.predictedCache).toBe("likely-cold");
      expect(JSON.stringify({ history: request.history, context })).toBe(original);
    },
  );
  it.each([undefined, "short", "long"] as const)(
    "uses the declared window with retention mode %s",
    (retentionMode) => {
      const { request, context } = fixture();
      enableHistoryRetrieval(request);
      request.model.cacheCapabilities = { scope: "connection", retentionMs: 1, retentionMode };
      const policy = createRuntimeContextPolicy(request);
      policy.prepareContext(context, model);
      expect(policy.getDecision()!.strategy).toBe("cache-aware");
    },
  );
  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "keeps the default for an unknown or invalid cache window %s",
    (retentionMs) => {
      const { request, context } = fixture();
      enableHistoryRetrieval(request);
      request.model.cacheCapabilities = { scope: "connection", retentionMs };
      const policy = createRuntimeContextPolicy(request);
      policy.prepareContext(context, model);
      expect(policy.getDecision()!.strategy).toBe(DEFAULT_CONTEXT_STRATEGY);
    },
  );
  it("accepts a finite positive fractional window at the runtime boundary", () => {
    const { request, context } = fixture();
    enableHistoryRetrieval(request);
    request.model.cacheCapabilities = { scope: "connection", retentionMs: 0.5 };
    const policy = createRuntimeContextPolicy(request);
    policy.prepareContext(context, model);
    expect(policy.getDecision()!.strategy).toBe("cache-aware");
  });
  it("keeps the default when caching is explicitly disabled", () => {
    const { request, context } = fixture();
    enableHistoryRetrieval(request);
    request.model.cacheCapabilities = {
      scope: "connection",
      retentionMs: 300000,
      retentionMode: "none",
    };
    const policy = createRuntimeContextPolicy(request);
    policy.prepareContext(context, model);
    expect(policy.getDecision()!.strategy).toBe(DEFAULT_CONTEXT_STRATEGY);
  });
  it.each(["current", "retrieval", "snapshots", "cache-aware"] as const)(
    "honors an explicit %s strategy over an eligible connection",
    (contextStrategy) => {
      const { request, context } = fixture();
      enableHistoryRetrieval(request);
      request.model.cacheCapabilities = { scope: "connection", retentionMs: 300000 };
      request.contextStrategy = contextStrategy;
      const policy = createRuntimeContextPolicy(request);
      const prepared = policy.prepareContext(context, model);
      expect(policy.getDecision()!.strategy).toBe(contextStrategy);
      if (contextStrategy === "current") expect(prepared).toBe(context);
    },
  );
  it.each([
    [],
    ["read_history"],
    ["search_history"],
    ["READ_HISTORY", "search_history"],
    ["read_history", "read_history"],
  ])("preserves fitting originals when required history tools are unavailable: %j", (...names) => {
    const { request, context } = fixture(60);
    enableHistoryRetrieval(request);
    request.tools = names.map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object" },
    }));
    request.model.cacheCapabilities = { scope: "connection", retentionMs: 300000 };
    const policy = createRuntimeContextPolicy(request);
    expect(policy.prepareContext(context, model).messages).toEqual(context.messages);
    expect(policy.getDecision()!.strategy).toBe(DEFAULT_CONTEXT_STRATEGY);
  });
  it("preserves fitting originals when history tools have no execution entry point", () => {
    const { request, context } = fixture(60);
    enableHistoryRetrieval(request);
    request.executeTool = undefined;
    request.model.cacheCapabilities = { scope: "connection", retentionMs: 300000 };
    const policy = createRuntimeContextPolicy(request);
    expect(policy.prepareContext(context, model).messages).toEqual(context.messages);
    expect(policy.getDecision()!.strategy).toBe(DEFAULT_CONTEXT_STRATEGY);
  });
  it.each([undefined, null, { inputTokens: null, outputTokens: null, cacheReadTokens: null }])(
    "does not turn an unreported or cancelled request into a warm prefix: %j",
    (usage) => {
      const { request, context } = fixture(60);
      request.threadId = "automatic-no-usage";
      enableHistoryRetrieval(request);
      request.model.cacheCapabilities = { scope: "connection", retentionMs: 300000 };
      const tracker = new ContextCacheTracker(() => 1000);
      const first = createRuntimeContextPolicy(request, undefined, { cacheTracker: tracker });
      first.prepareContext(context, model);
      first.onUsage(usage);
      const next = createRuntimeContextPolicy(request, undefined, { cacheTracker: tracker });
      next.prepareContext(context, model);
      expect(next.getDecision()).toMatchObject({
        strategy: "cache-aware",
        predictedCache: "likely-cold",
      });
    },
  );
  it.each([
    "userId",
    "spaceId",
    "botId",
    "threadId",
    "apiKey",
    "baseUrl",
    "resolvedEndpoint",
    "provider",
    "credentialScope",
    "headers",
    "modelId",
    "oauth",
  ] as const)("does not reuse automatic warmth after changing %s", (changedScope) => {
    const { request, context } = fixture(1);
    enableHistoryRetrieval(request);
    request.threadId = `automatic-isolation-${changedScope}`;
    request.model.cacheCapabilities = { scope: "account", retentionMs: 300000 };
    request.model.apiKey = "synthetic-first-key";
    request.model.oauth = {
      credential: {
        type: "oauth",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: 123456,
      },
    };
    const adapter = { userId: "user", spaceId: "space" };
    const resolved = { ...model, headers: { "Synthetic-Account": "first" } };
    const tracker = new ContextCacheTracker(() => 1000);
    const options = { cacheTracker: tracker, credentialScope: "synthetic-first-scope" };
    const first = createRuntimeContextPolicy(request, adapter, options);
    first.prepareContext(context, resolved);
    first.onUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 });
    const control = createRuntimeContextPolicy(request, adapter, options);
    control.prepareContext(context, resolved);
    expect(control.getDecision()!.predictedCache).toBe("likely-warm");
    if (changedScope === "userId" || changedScope === "spaceId") adapter[changedScope] = "other";
    else if (changedScope === "botId" || changedScope === "threadId")
      request[changedScope] = "other";
    else if (changedScope === "apiKey" || changedScope === "baseUrl")
      request.model[changedScope] = "synthetic-other";
    else if (changedScope === "credentialScope") options.credentialScope = "synthetic-other-scope";
    else if (changedScope === "headers") resolved.headers["Synthetic-Account"] = "other";
    else if (changedScope === "resolvedEndpoint") resolved.baseUrl = "https://other.invalid";
    else if (changedScope === "provider") resolved.provider = "other-provider";
    else if (changedScope === "modelId") resolved.id = "other-model";
    else
      request.model.oauth.credential = {
        ...request.model.oauth.credential,
        access: "synthetic-other-access",
      };
    const next = createRuntimeContextPolicy(request, adapter, options);
    expect(next.prepareContext(context, resolved).messages).toEqual(context.messages);
    expect(next.getDecision()).toMatchObject({
      strategy: "cache-aware",
      predictedCache: "likely-cold",
    });
  });
  it("matches the qualified explicit strategy when backend history retrieval is usable", () => {
    const { request, context } = fixture();
    enableHistoryRetrieval(request);
    const implicit = createRuntimeContextPolicy(request);
    const explicit = createRuntimeContextPolicy({
      ...request,
      contextStrategy: DEFAULT_CONTEXT_STRATEGY,
    });
    expect(implicit.prepareContext(context, model)).toEqual(
      explicit.prepareContext(context, model),
    );
    expect(implicit.getDecision()!.strategy).toBe("retrieval");
  });
  it.each(["no tools", "one tool", "no backend"])(
    "preserves fitting standalone originals with %s",
    (capability) => {
      const { request, context } = fixture();
      request.tools = (
        capability === "no tools"
          ? []
          : capability === "one tool"
            ? ["read_history"]
            : ["read_history", "search_history"]
      ).map((name) => ({ name, description: name, inputSchema: { type: "object" } }));
      if (capability !== "no backend") request.executeTool = async () => ({});
      const implicit = createRuntimeContextPolicy(request).prepareContext(context, model);
      expect(implicit.messages).toEqual(context.messages);
      expect(JSON.stringify(implicit)).not.toContain("Historical navigation snapshots");
      const explicit = createRuntimeContextPolicy({
        ...request,
        contextStrategy: "retrieval",
      }).prepareContext(context, model);
      expect(explicit.messages.length).toBeLessThan(context.messages.length);
    },
  );
  it("bounds standalone originals by the model window while preserving current input", () => {
    const { request, context } = fixture(100);
    const policy = createRuntimeContextPolicy(request);
    const prepared = policy.prepareContext(context, {
      ...model,
      contextWindow: 8192,
      maxTokens: 1024,
    });
    expect(prepared.messages.length).toBeLessThan(context.messages.length);
    expect(prepared.messages.at(-1)).toEqual(context.messages.at(-1));
    expect(policy.getDecision()!.estimatedInputTokens).toBeLessThanOrEqual(8192 - 1024);
  });
  it.each(["current", "retrieval", "snapshots", "cache-aware"] as const)(
    "keeps a real result reference when a small prior result reaches the %s policy",
    (strategy) => {
      const { request, context } = fixture(0);
      const reference = {
        tool: "read_history" as const,
        arguments: { toolResultId: "stored-small-result" },
      };
      const original = { nextCursor: "c".repeat(1_800), body: "b".repeat(1_000) };
      const initial = boundToolResultText(JSON.stringify(original), 12_000, {}, reference);
      expect(JSON.parse(initial)).toMatchObject({ result: original, historyReference: reference });
      const call = (id: string) =>
        ({
          role: "assistant",
          content: [{ type: "toolCall", id, name: "connector", arguments: {} }],
          timestamp: 1,
        }) as unknown as Message;
      const result = (id: string, text: string) =>
        ({
          role: "toolResult",
          toolCallId: id,
          toolName: "connector",
          content: markToolResultContent([{ type: "text", text }], {
            historyReference: id === "old" ? reference : undefined,
            wrapped: id === "old",
          }),
          isError: false,
          timestamp: 2,
        }) as Message;
      context.messages.push(
        call("old"),
        result("old", initial),
        ...Array.from({ length: 3 }, (_, index) => [
          call(`new-${index}`),
          result(`new-${index}`, "0123456789".repeat(500)),
        ]).flat(),
      );
      const prepared = createRuntimeContextPolicy({
        ...request,
        contextStrategy: strategy,
      }).prepareContext(context, { ...model, contextWindow: 20000, maxTokens: 512 });
      const prior = prepared.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "old",
      ) as Extract<Message, { role: "toolResult" }>;
      const text = prior.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      expect(JSON.parse(text)).toMatchObject({ historyReference: reference });
      expect(toolResultContentProvenance(prior.content)).toEqual({
        historyReference: reference,
        wrapped: true,
      });
      if (strategy === "current") expect(JSON.parse(text).result).toMatchObject(original);
      else
        expect(JSON.parse(text)).toMatchObject({ error: "budget_error", contextTruncated: true });
    },
  );

  it("keeps an earlier skill read verbatim while shortening other old tool evidence", () => {
    const { request, context } = fixture(2);
    const call = (id: string, name: string) =>
      ({
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: {} }],
        timestamp: 101,
      }) as unknown as Message;
    const result = (id: string, name: string, body: string) =>
      ({
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text: body }],
        isError: false,
        timestamp: 102,
      }) as Message;
    const skill = JSON.stringify({
      name: "daily-brief",
      description: "Daily brief",
      source: "user",
      readOnly: false,
      content: `---\nname: daily-brief\n---\n${"1. Step kept for skill_update.\n".repeat(80)}`,
    });
    const shellOutput = "0123456789".repeat(400);
    context.messages.push(
      call("read", "skill_read"),
      result("read", "skill_read", skill),
      call("shell-1", "shell"),
      result("shell-1", "shell", shellOutput),
      call("shell-2", "shell"),
      result("shell-2", "shell", shellOutput),
      call("shell-3", "shell"),
      result("shell-3", "shell", shellOutput),
    );
    const policy = createRuntimeContextPolicy({
      ...request,
      contextStrategy: DEFAULT_CONTEXT_STRATEGY,
    });
    const prepared = policy.prepareContext(context, {
      ...model,
      contextWindow: 9000,
      maxTokens: 512,
    });
    const body = (id: string) => {
      const message = prepared.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === id,
      ) as Extract<Message, { role: "toolResult" }>;
      return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    };
    expect(skill.length).toBeGreaterThan(2500);
    expect(body("read")).toBe(skill);
    expect(body("shell-1")).toContain("Earlier result shortened after you read it");
    expect(body("shell-3")).toBe(shellOutput);
  });
  it.each([
    { contextWindow: 15000, firstWhole: 3 },
    { contextWindow: 22000, firstWhole: 1 },
    { contextWindow: 11000, firstWhole: 5 },
  ])(
    "keeps whole recent results within the available budget ($contextWindow)",
    ({ contextWindow, firstWhole }) => {
      const { request, context } = fixture(0);
      const body = "0123456789".repeat(300);
      for (let index = 0; index < 6; index++) {
        const id = `step-${index}`;
        context.messages.push(
          fauxAssistantMessage([{ type: "toolCall", id, name: "shell", arguments: {} }]),
          {
            role: "toolResult",
            toolCallId: id,
            toolName: "shell",
            content: [{ type: "text", text: body }],
            isError: false,
            timestamp: index + 1,
          },
        );
      }
      const original = structuredClone(context);
      const policy = createRuntimeContextPolicy({ ...request, contextStrategy: "retrieval" });
      const prepared = policy.prepareContext(context, { ...model, contextWindow, maxTokens: 512 });
      const results = prepared.messages.filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(6);
      for (const [index, result] of results.entries()) {
        if (index >= firstWhole) expect(result.content).toEqual([{ type: "text", text: body }]);
        else
          expect(JSON.stringify(result.content)).toContain(
            "Earlier result shortened after you read it",
          );
      }
      const rebuilt = policy.prepareContext(
        { ...context, systemPrompt: "Changed instructions force a rebuild" },
        { ...model, contextWindow: 30000, maxTokens: 512 },
      );
      expect(
        rebuilt.messages
          .filter((message) => message.role === "toolResult")
          .map((message) => message.content),
      ).toEqual(results.map((message) => message.content));
      expect(context).toEqual(original);
    },
  );
  it("leaves the baseline provider payload untouched", () => {
    const { request, context } = fixture();
    const policy = createRuntimeContextPolicy({ ...request, contextStrategy: "current" });
    expect(policy.prepareContext(context, model)).toBe(context);
  });
  it("bounds diagnostic context for a learned request window without losing the live tool group", () => {
    const { request, context } = fixture(120);
    request.contextStrategy = "current";
    request.model.contextWindow = 32_768;
    context.tools = [
      { name: "shell", description: "Read the requested file", parameters: { type: "object" } },
    ];
    const live = context.messages.at(-1)!;
    const calls = ["first", "second"].map((id) => ({
      type: "toolCall" as const,
      id,
      name: "shell",
      arguments: {},
    }));
    const thinking = {
      type: "thinking" as const,
      thinking: "Read both sources",
      thinkingSignature: "prior-conversation-signature",
    };
    context.messages.push(
      fauxAssistantMessage([thinking, ...calls]),
      ...calls.map(({ id }) => ({
        role: "toolResult" as const,
        toolCallId: id,
        toolName: "shell",
        content: [{ type: "text" as const, text: `Result ${id}` }],
        isError: false,
        timestamp: 101,
      })),
    );
    const nominal = { ...model, contextWindow: 32_768, maxTokens: 256 };
    const policy = createRuntimeContextPolicy(request);
    const first = policy.prepareContext(context, nominal);
    expect(first.messages).toHaveLength(124);
    expect(first.messages.at(-3)?.content).toContainEqual(thinking);

    const narrow = { ...nominal, contextWindow: 2048 };
    const next = policy.prepareContext(context, narrow, { contextWindow: 2048 });
    expect(next.messages.length).toBeLessThan(first.messages.length);
    expect(next.systemPrompt).toBe("Stable instructions");
    expect(next.tools).toEqual(context.tools);
    expect(next.messages.at(-4)).toEqual(live);
    expect(next.messages.at(-3)?.content).toEqual(calls);
    expect(next.messages.slice(-2)).toMatchObject([
      { role: "toolResult", toolCallId: "first" },
      { role: "toolResult", toolCallId: "second" },
    ]);
    expect(policy.getDecision()!.estimatedInputTokens).toBeLessThanOrEqual(1792);
    expect(request.model.contextWindow).toBe(32_768);
    expect(context.messages.at(-3)?.content).toContainEqual(thinking);
  });
  it("keeps the quoted input on an output-only correction when cache warmth expires", () => {
    let now = 0;
    const tracker = new ContextCacheTracker(() => now);
    const { request, context } = fixture(280);
    request.model.cacheCapabilities = { scope: "account", retentionMs: 60 };
    enableHistoryRetrieval(request);
    const warm = createRuntimeContextPolicy({ ...request, contextStrategy: "current" }, undefined, {
      cacheTracker: tracker,
    });
    warm.prepareContext(context, model);
    warm.onUsage({ inputTokens: 1, outputTokens: 1 });

    const policy = createRuntimeContextPolicy(request, undefined, { cacheTracker: tracker });
    const rejectedInput = policy.prepareContext(context, model);
    expect(rejectedInput.messages).toHaveLength(context.messages.length);
    expect(policy.getDecision()!.predictedCache).toBe("likely-warm");
    policy.onUsage(null);
    now = 61;

    const lowerOutput = { ...model, maxTokens: 1024 };
    const corrected = policy.prepareContext(context, lowerOutput, { preserveInput: true });
    expect(corrected).toEqual(rejectedInput);
    expect(policy.getDecision()!.predictedCache).toBe("likely-cold");
    policy.onUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 12 });
    expect(policy.getDecision()!.observedReuse).toBe(true);

    const followUp = { role: "user" as const, content: "A new message arrived", timestamp: 62 };
    const changed = { ...context, messages: [...context.messages, followUp] };
    expect(() => policy.prepareContext(changed, lowerOutput, { preserveInput: true })).toThrow(
      "leaves no smaller request to send",
    );
    expect(policy.prepareContext(changed, lowerOutput).messages.at(-1)).toEqual(followUp);
  });
  it.each(["system", "tool schema", "current user"] as const)(
    "refuses a learned window too small for the required %s",
    (required) => {
      const { request, context } = fixture(0);
      request.contextStrategy = "current";
      const policy = createRuntimeContextPolicy(request);
      const previous = policy.prepareContext(context, model);
      const previousDecision = policy.getDecision();
      const content = "Required instructions for this request. ".repeat(800);
      const oversized: Context =
        required === "system"
          ? { ...context, systemPrompt: content }
          : required === "tool schema"
            ? {
                ...context,
                tools: [
                  { name: "required_tool", description: content, parameters: { type: "object" } },
                ],
              }
            : { ...context, messages: [{ role: "user", content, timestamp: 100 }] };

      const narrow = { ...model, contextWindow: 2048, maxTokens: 256 };
      expect(() => policy.prepareContext(oversized, narrow, { contextWindow: 2048 })).toThrow(
        ContextBudgetError,
      );
      expect(policy.getDecision()).toEqual(previousDecision);
      expect(policy.prepareContext(context, model, { preserveInput: true })).toEqual(previous);
    },
  );
  it.each(["retrieval", "snapshots"] as const)(
    "keeps Pi transcript instructions and tools through %s history selection",
    (strategy) => {
      const { request, context } = fixture(100);
      const system = {
        role: "system",
        content: request.instructions,
        sections: { active: "Approval pending: prepare only a proposal" },
        toolsAdded: [
          {
            name: "read_history",
            description: "Read saved messages",
            parameters: { type: "object", properties: {} },
          },
        ],
        timestamp: 0,
      } as Message;
      context.systemPrompt = undefined;
      context.tools = undefined;
      context.messages.unshift(system);
      const policy = createRuntimeContextPolicy({ ...request, contextStrategy: strategy });
      const prepared = policy.prepareContext(context, model);
      expect(prepared.messages).toContain(system);
      expect(prepared.messages[0]).toBe(system);
      if (strategy === "snapshots")
        expect(String(prepared.messages[1]?.content)).toContain("Historical navigation snapshots");
      expect(prepared.messages.at(-1)).toBe(context.messages.at(-1));
      expect(prepared.messages.length).toBeLessThan(context.messages.length);
      expect(policy.getDecision()!.estimatedInputTokens).toBeLessThanOrEqual(
        model.contextWindow - model.maxTokens,
      );
    },
  );
  it("retains current request and subsequent steering while bounding old history", () => {
    const { request, context } = fixture();
    context.messages.push({ role: "user", content: "New constraint", timestamp: 200 });
    const prepared = createRuntimeContextPolicy({
      ...request,
      contextStrategy: "retrieval",
    }).prepareContext(context, model);
    expect(prepared.messages).toContainEqual(context.messages.at(-2));
    expect(prepared.messages).toContainEqual(context.messages.at(-1));
    expect(prepared.messages.length).toBeLessThan(context.messages.length);
  });
  it.each(["snapshots", "cache-aware"] as const)(
    "retains already-short history without lookup navigation under %s",
    (strategy) => {
      const { request, context } = fixture(100);
      for (const [index, item] of request.history.entries()) {
        item.content = `Short original ${index}: ${index === 4 ? "ORBIT-731; approval pending" : "no action"}`;
        (context.messages[index] as { content: string }).content = item.content;
      }
      const policy = createRuntimeContextPolicy({ ...request, contextStrategy: strategy });
      const prepared = policy.prepareContext(context, model);
      expect(prepared.messages).toEqual(context.messages);
      expect(JSON.stringify(prepared)).toContain("ORBIT-731; approval pending");
      expect(JSON.stringify(prepared)).not.toContain("Historical navigation snapshots");
    },
  );
  it("measures short original history separately from Pi's system transcript", () => {
    const { request, context } = fixture(100);
    for (const [index, item] of request.history.entries()) {
      item.content = `Short original ${index}: ${index === 4 ? "ORBIT-731" : "no action"}`;
      (context.messages[index] as { content: string }).content = item.content;
    }
    const system = {
      role: "system",
      content: "Instructions ".repeat(1200),
      timestamp: 0,
    } as Message;
    context.systemPrompt = undefined;
    context.messages.unshift(system);
    const prepared = createRuntimeContextPolicy({
      ...request,
      contextStrategy: "snapshots",
    }).prepareContext(context, model);
    expect(prepared.messages).toEqual(context.messages);
  });
  it("uses the model-relative allowance for short history and still enforces the full window", () => {
    const { request, context } = fixture(100);
    for (const [index, item] of request.history.entries()) {
      item.content = `Short original ${index}: ${"evidence ".repeat(5)}`;
      (context.messages[index] as { content: string }).content = item.content;
    }
    const prepared = createRuntimeContextPolicy({
      ...request,
      contextStrategy: "snapshots",
    }).prepareContext(context, { ...model, contextWindow: 12000 });
    expect(prepared.messages.length).toBeLessThan(context.messages.length);
    expect(prepared.messages.at(-1)).toEqual(context.messages.at(-1));
  });
  it("creates navigation snapshots from originals with IDs and dates without inference", () => {
    const { request, context } = fixture(120);
    const policy = createRuntimeContextPolicy({ ...request, contextStrategy: "snapshots" });
    const prepared = policy.prepareContext(context, model);
    const first = prepared.messages[0]!.content;
    expect(first).toContain("Historical navigation snapshots");
    expect(first).toContain("message message-100 at 2026-01-01T00:00:00Z");
    expect(first).toContain("read_history");
    expect(prepared.messages.at(-1)).toEqual(context.messages.at(-1));
    expect(policy.getDecision()!.estimatedInputTokens).toBeLessThan(32768);
  });
  it("uses fake-clock warmth from matching model requests, expiry only selects existing snapshots", () => {
    let now = 0;
    const tracker = new ContextCacheTracker(() => now);
    const { request, context } = fixture(120);
    request.model.cacheCapabilities = { scope: "account", retentionMs: 300000, minimumTokens: 1 };
    const baseline = createRuntimeContextPolicy(
      { ...request, contextStrategy: "current" },
      undefined,
      { cacheTracker: tracker },
    );
    baseline.prepareContext(context, model);
    baseline.onUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 20 });
    expect(baseline.getDecision()!.observedReuse).toBe(true);
    now = 10000;
    const warm = createRuntimeContextPolicy(
      { ...request, contextStrategy: "cache-aware" },
      undefined,
      { cacheTracker: tracker },
    );
    expect(warm.prepareContext(context, model).messages).toHaveLength(context.messages.length);
    expect(warm.getDecision()!.predictedCache).toBe("likely-warm");
    now = 300000;
    const cold = createRuntimeContextPolicy(
      { ...request, contextStrategy: "cache-aware" },
      undefined,
      { cacheTracker: tracker },
    );
    expect(cold.prepareContext(context, model).messages.length).toBeLessThan(
      context.messages.length,
    );
    expect(cold.getDecision()!.predictedCache).toBe("likely-cold");
  });
  it("does not extend cache retention by a long model response", () => {
    let now = 0;
    const tracker = new ContextCacheTracker(() => now);
    const { request, context } = fixture(20);
    request.model.cacheCapabilities = { scope: "account", retentionMs: 300000, minimumTokens: 1 };
    const policy = createRuntimeContextPolicy(
      { ...request, contextStrategy: "current" },
      undefined,
      { cacheTracker: tracker },
    );
    policy.prepareContext(context, model);
    now = 300001;
    policy.onUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 20 });
    policy.prepareContext(context, model);
    expect(policy.getDecision()!.predictedCache).toBe("likely-cold");
    policy.onUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 });
    now += 100;
    policy.prepareContext(context, model);
    expect(policy.getDecision()!.predictedCache).toBe("likely-warm");
    expect(JSON.stringify(context)).not.toContain("startedAt");
  });
  it("reuses a compressed catalogue while warm without expanding it to original history", () => {
    let now = 0;
    const tracker = new ContextCacheTracker(() => now);
    const { request, context } = fixture(30);
    request.model.cacheCapabilities = { scope: "account", retentionMs: 300000, minimumTokens: 1 };
    request.threadId = "compressed-thread";
    const policy = createRuntimeContextPolicy(
      { ...request, contextStrategy: "cache-aware" },
      undefined,
      { cacheTracker: tracker },
    );
    const first = policy.prepareContext(context, model);
    policy.onUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 });
    now = 1000;
    const nextContext = {
      ...context,
      messages: [
        ...context.messages,
        { role: "user" as const, content: "Follow-up question", timestamp: now },
      ],
    };
    const next = createRuntimeContextPolicy(
      { ...request, contextStrategy: "cache-aware" },
      undefined,
      { cacheTracker: tracker },
    );
    const prepared = next.prepareContext(nextContext, model);
    expect(next.getDecision()!.predictedCache).toBe("likely-warm");
    expect(prepared.messages[0]!.content).toBe(first.messages[0]!.content);
    expect(prepared.messages).toHaveLength(first.messages.length + 1);
  });
  it("preserves an existing rolling summary when it fits", () => {
    const { request, context } = fixture();
    const summary =
      "Rakazo-owned compacted context through message sequence 10.\n<compacted_thread_summary>Durable approval constraint</compacted_thread_summary>";
    request.history.unshift({ role: "user", content: summary });
    context.messages.unshift({
      role: "user",
      content: summary,
      timestamp: 0,
      rakazoHistory: true,
    } as Message);
    const prepared = createRuntimeContextPolicy({
      ...request,
      contextStrategy: "snapshots",
    }).prepareContext(context, model);
    expect(prepared.messages[0]!.content).toBe(summary);
  });
  it("places a rolling summary after Pi's leading system message", () => {
    const { request, context } = fixture();
    const system = { role: "system", content: "System guidance", timestamp: 0 } as Message;
    const summary =
      "Rakazo-owned compacted context through message sequence 10.\n<compacted_thread_summary>Durable approval constraint</compacted_thread_summary>";
    request.history.unshift({ role: "user", content: summary });
    context.messages.unshift({
      role: "user",
      content: summary,
      timestamp: 0,
      rakazoHistory: true,
    } as Message);
    context.messages.unshift(system);
    context.systemPrompt = undefined;
    const prepared = createRuntimeContextPolicy({
      ...request,
      contextStrategy: "snapshots",
    }).prepareContext(context, model);
    expect(prepared.messages[0]).toBe(system);
    expect(prepared.messages[1]?.content).toBe(summary);
  });
  it("allows bounded images inside the real model window and rejects a genuinely tiny window", () => {
    const { request, context } = fixture(1);
    context.messages[1] = {
      role: "user",
      timestamp: 1,
      content: [
        { type: "text", text: request.prompt },
        { type: "image", mimeType: "image/png", data: "a".repeat(40000) },
      ],
    };
    const roomy = { ...model, contextWindow: 160000 };
    const policy = createRuntimeContextPolicy({ ...request, contextStrategy: "retrieval" });
    expect(policy.prepareContext(context, roomy).messages.at(-1)).toEqual(context.messages.at(-1));
    expect(() => policy.prepareContext(context, { ...model, contextWindow: 16000 })).toThrow(
      ContextBudgetError,
    );
  });
  it("invalidates advisory warmth on resolved credential or provider account header rotation", () => {
    const tracker = new ContextCacheTracker(() => 1000);
    const { request, context } = fixture(1);
    request.threadId = "rotating-credential-thread";
    request.model.cacheCapabilities = { scope: "account", retentionMs: 300000, minimumTokens: 1 };
    const scopedModel = { ...model, headers: { "Synthetic-Account": "first" } };
    const first = createRuntimeContextPolicy(
      { ...request, contextStrategy: "current" },
      undefined,
      { cacheTracker: tracker, credentialScope: "synthetic-first-key" },
    );
    first.prepareContext(context, scopedModel);
    first.onUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 });
    const rotatedCredential = createRuntimeContextPolicy(
      { ...request, contextStrategy: "cache-aware" },
      undefined,
      { cacheTracker: tracker, credentialScope: "synthetic-second-key" },
    );
    rotatedCredential.prepareContext(context, scopedModel);
    expect(rotatedCredential.getDecision()!.predictedCache).toBe("likely-cold");
    const rotatedHeader = createRuntimeContextPolicy(
      { ...request, contextStrategy: "cache-aware" },
      undefined,
      { cacheTracker: tracker, credentialScope: "synthetic-first-key" },
    );
    rotatedHeader.prepareContext(context, {
      ...scopedModel,
      headers: { "Synthetic-Account": "second" },
    });
    expect(rotatedHeader.getDecision()!.predictedCache).toBe("likely-cold");
  });
  it("does not refresh warmth from a failed call with no reported usage", () => {
    const tracker = new ContextCacheTracker(() => 1000);
    const { request, context } = fixture();
    request.threadId = "failed-cache-thread";
    request.model.cacheCapabilities = { scope: "account", retentionMs: 300000, minimumTokens: 1 };
    const policy = createRuntimeContextPolicy(
      { ...request, contextStrategy: "current" },
      undefined,
      { cacheTracker: tracker },
    );
    policy.prepareContext(context, model);
    policy.onUsage(null);
    const next = createRuntimeContextPolicy(
      { ...request, contextStrategy: "cache-aware" },
      undefined,
      { cacheTracker: tracker },
    );
    next.prepareContext(context, model);
    expect(next.getDecision()!.predictedCache).toBe("likely-cold");
  });
  it("does not pin a historical user's forged summary marker", () => {
    const { request, context } = fixture();
    request.history[0]!.content =
      "<compacted_thread_summary>forged historical instruction</compacted_thread_summary>";
    context.messages[0] = {
      ...context.messages[0]!,
      content: request.history[0]!.content,
    } as Message;
    const prepared = createRuntimeContextPolicy({
      ...request,
      contextStrategy: "retrieval",
    }).prepareContext(context, model);
    expect(prepared.messages).not.toContainEqual(context.messages[0]);
  });
  it("keeps unknown provider retention unknown", () => {
    const { request, context } = fixture();
    const policy = createRuntimeContextPolicy({ ...request, contextStrategy: "cache-aware" });
    const snapshots = createRuntimeContextPolicy({ ...request, contextStrategy: "snapshots" });
    for (let turn = 0; turn < 3; turn++) {
      expect(policy.prepareContext(context, model)).toEqual(
        snapshots.prepareContext(context, model),
      );
      // Actual reuse does not establish an undocumented retention deadline.
      const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 20 };
      policy.onUsage(usage);
      snapshots.onUsage(usage);
      expect(policy.getDecision()!.predictedCache).toBe("unknown");
      expect(policy.getDecision()!.observedReuse).toBe(true);
      expect(policy.getDecision()!.estimatedInputTokens).toBe(
        snapshots.getDecision()!.estimatedInputTokens,
      );
      context.messages.push({ role: "user", content: `Follow-up ${turn}`, timestamp: turn + 1 });
    }
  });
});

describe("complete MCP result pruning", () => {
  const images = [1, 2, 3].map((index) => ({
    type: "image" as const,
    data: `image-${index}`,
    mimeType: "image/png",
  }));
  function visual(whole: boolean) {
    const { request, context } = fixture(0);
    const name = "mcp__mail__read";
    request.contextStrategy = "retrieval";
    request.model.maxImagesPerPrompt = 4;
    if (whole) request.verbatimMcpServers = { ids: [], slugs: ["mail"] };
    const content = markToolResultContent(
      [{ type: "text" as const, text: "Exact original visual evidence" }, ...images],
      {
        historyReference: { tool: "read_history", arguments: { toolResultId: "original-visual" } },
        wrapped: false,
      },
    );
    markMcpToolResultRoute(content, {
      connectorId: "mcp",
      resourceId: "mail-id",
      catalogGroup: "mail",
      toolName: "read",
    });
    context.messages.push(
      fauxAssistantMessage([{ type: "toolCall", id: "visual", name, arguments: {} }]),
      {
        role: "toolResult",
        toolCallId: "visual",
        toolName: name,
        content,
        details: { frameId: "mcp-frame" },
        isError: false,
        timestamp: 2,
      },
    );
    return { request, context, content };
  }
  it.each([false, true])(
    "keeps complete multipart image evidence only for trusted servers (%s)",
    (whole) => {
      const { request, context, content } = visual(whole);
      const prepared = createRuntimeContextPolicy(request, undefined, {
        imageTokens: 10,
      }).prepareContext(context, model);
      const result = prepared.messages.find((message) => message.role === "toolResult")!;
      expect(result.content.filter((part) => part.type === "image")).toHaveLength(whole ? 3 : 0);
      if (whole) expect(result.content.slice(-content.length)).toEqual(content);
      expect(content.filter((part) => part.type === "image")).toHaveLength(3);
      expect(toolResultContentProvenance(result.content)).toEqual({
        historyReference: { tool: "read_history", arguments: { toolResultId: "original-visual" } },
        wrapped: false,
      });
    },
  );
  it("keeps resolved MCP identity through labels without stored-history metadata", () => {
    const { request, context, content } = visual(true);
    const route = {
      connectorId: "mcp",
      resourceId: "mail-id",
      catalogGroup: "mail",
      toolName: "read",
    };
    const result = context.messages[2] as Extract<Message, { role: "toolResult" }>;
    result.content = markMcpToolResultRoute([...content], route);
    expect(toolResultContentProvenance(result.content)).toBeUndefined();
    const prepared = createRuntimeContextPolicy(request, undefined, {
      imageTokens: 10,
    }).prepareContext(context, model);
    const labelled = prepared.messages.find((message) => message.role === "toolResult")!;
    expect(labelled.content.filter((part) => part.type === "image")).toHaveLength(3);
    expect(mcpToolResultRoute(labelled.content)).toEqual(route);
    expect(toolResultContentProvenance(labelled.content)).toBeUndefined();
  });
  it.each(["retrieval", "current"] as const)(
    "rejects necessary complete images beyond the actual %s model limit",
    (contextStrategy) => {
      const { request, context, content } = visual(true);
      request.contextStrategy = contextStrategy;
      request.model.maxImagesPerPrompt = 2;
      expect(() =>
        createRuntimeContextPolicy(request, undefined, { imageTokens: 10 }).prepareContext(
          context,
          model,
        ),
      ).toThrow("image limit is 2");
      expect(content).toHaveLength(4);
      request.model.maxImagesPerPrompt = 3;
      expect(
        createRuntimeContextPolicy(request, undefined, { imageTokens: 10 })
          .prepareContext(context, model)
          .messages.at(-1)!
          .content.slice(-content.length),
      ).toEqual(content);
    },
  );
  it("counts prompt images together with complete multipart results", () => {
    const { request, context, content } = visual(true);
    request.model.maxImagesPerPrompt = 3;
    context.messages[0] = {
      role: "user",
      content: [{ type: "text", text: request.prompt }, images[0]!],
      timestamp: 0,
    };
    expect(() =>
      createRuntimeContextPolicy(request, undefined, { imageTokens: 10 }).prepareContext(
        context,
        model,
      ),
    ).toThrow("required context contains 4 images");
    expect(content).toHaveLength(4);
  });
  it("drops an old optional whole group rather than clipping it or rejecting newer images", () => {
    const { request, context, content } = visual(true);
    request.model.maxImagesPerPrompt = 2;
    context.messages.push(
      fauxAssistantMessage([
        { type: "toolCall", id: "ordinary", name: "computer_observe", arguments: {} },
      ]),
      {
        role: "toolResult",
        toolCallId: "ordinary",
        toolName: "computer_observe",
        content: [images[0]!, images[1]!],
        details: { frameId: "ordinary-frame" },
        isError: false,
        timestamp: 3,
      },
    );
    const prepared = createRuntimeContextPolicy(request, undefined, {
      imageTokens: 10,
    }).prepareContext(context, model);
    expect(
      prepared.messages.some(
        (message) => message.role === "toolResult" && message.toolCallId === "visual",
      ),
    ).toBe(false);
    expect(
      (prepared.messages.at(-1) as Extract<Message, { role: "toolResult" }>).content.filter(
        (part) => part.type === "image",
      ),
    ).toHaveLength(2);
    request.model.maxImagesPerPrompt = 5;
    const roomy = createRuntimeContextPolicy(request, undefined, {
      imageTokens: 10,
    }).prepareContext(context, model);
    const old = roomy.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "visual",
    )!;
    expect(old.content.slice(-content.length)).toEqual(content);
    expect(content).toHaveLength(4);
  });
  it("reserves the required whole result before pruning ordinary screenshots in the same step", () => {
    const { request, context, content } = visual(true);
    request.model.maxImagesPerPrompt = 3;
    context.messages[1] = fauxAssistantMessage([
      { type: "toolCall", id: "visual", name: "mcp__mail__read", arguments: {} },
      { type: "toolCall", id: "ordinary", name: "computer_observe", arguments: {} },
    ]);
    context.messages.push({
      role: "toolResult",
      toolCallId: "ordinary",
      toolName: "computer_observe",
      content: [images[0]!, images[1]!],
      details: { frameId: "ordinary-frame" },
      isError: false,
      timestamp: 3,
    });
    const prepared = createRuntimeContextPolicy(request, undefined, {
      imageTokens: 10,
    }).prepareContext(context, model);
    const marked = prepared.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "visual",
    )!;
    expect(marked.content.slice(-content.length)).toEqual(content);
    expect(
      (prepared.messages.at(-1) as Extract<Message, { role: "toolResult" }>).content.filter(
        (part) => part.type === "image",
      ),
    ).toHaveLength(0);
  });
  it("keeps restored current bounded when an optional old complete result exceeds its image budget", () => {
    const { request, context } = visual(true);
    request.contextStrategy = "current";
    request.contextRestored = true;
    request.model.maxImagesPerPrompt = 2;
    context.messages.push(fauxAssistantMessage([{ type: "text", text: "Read the old evidence" }]), {
      role: "user",
      content: "Continue",
      timestamp: 3,
    });
    const prepared = createRuntimeContextPolicy(request, undefined, {
      imageTokens: 10,
    }).prepareContext(context, model);
    expect(prepared.messages.some((message) => message.role === "toolResult")).toBe(false);
  });
  it("uses the original catalog call arguments before pruning a complete result", () => {
    const { request, context, content } = visual(true);
    request.verbatimMcpServers = { ids: ["mail-id"], slugs: [] };
    const name = catalogExecuteToolName("mcp");
    context.messages[1] = fauxAssistantMessage([
      { type: "toolCall", id: "visual", name, arguments: { id: "mail-id:read" } },
    ]);
    (context.messages[2] as Extract<Message, { role: "toolResult" }>).toolName = name;
    const prepared = createRuntimeContextPolicy(request, undefined, {
      imageTokens: 10,
    }).prepareContext(context, model);
    expect(prepared.messages.at(-1)!.content.slice(-content.length)).toEqual(content);
  });
  it("does not reuse an old catalog preservation decision for a later call with the same ID", () => {
    const { request, context, content } = visual(true);
    request.verbatimMcpServers = { ids: ["mail-id"], slugs: [] };
    request.model.maxImagesPerPrompt = 2;
    const name = catalogExecuteToolName("mcp");
    context.messages[1] = fauxAssistantMessage([
      { type: "toolCall", id: "visual", name, arguments: { id: "mail-id:read" } },
    ]);
    context.messages.push(
      fauxAssistantMessage([
        { type: "toolCall", id: "visual", name, arguments: { id: "other-id:read" } },
      ]),
      {
        role: "toolResult",
        toolCallId: "visual",
        toolName: name,
        content: [images[0]!, images[1]!],
        details: { frameId: "new-frame" },
        isError: false,
        timestamp: 3,
      },
    );
    const prepared = createRuntimeContextPolicy(request, undefined, {
      imageTokens: 10,
    }).prepareContext(context, model);
    const results = prepared.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]!.content.filter((part) => part.type === "image")).toEqual([
      images[0],
      images[1],
    ]);
    expect(content).toHaveLength(4);
  });
  it("does not treat an image-budget failure as a previously sent diagnostic transcript", () => {
    const { request, context } = visual(true);
    request.contextStrategy = "current";
    request.model.maxImagesPerPrompt = 2;
    const thinking = {
      type: "thinking" as const,
      thinking: "Unsent reasoning",
      thinkingSignature: "unsent-signature",
    };
    context.messages[1] = fauxAssistantMessage([
      thinking,
      { type: "toolCall", id: "visual", name: "mcp__mail__read", arguments: {} },
    ]);
    const policy = createRuntimeContextPolicy(request, undefined, { imageTokens: 10 });
    expect(() => policy.prepareContext(context, model)).toThrow("image limit is 2");
    request.model.maxImagesPerPrompt = 3;
    const prepared = policy.prepareContext(
      { ...context, systemPrompt: "Changed before the first successful send" },
      model,
    );
    expect(
      prepared.messages.find((message) => message.role === "assistant")!.content,
    ).toContainEqual(thinking);
  });
});

describe("optional history and effective output capacity", () => {
  const ccModel = {
    ...model,
    api: "openai-completions",
    contextWindow: 8192,
    maxTokens: 1024,
  } as Model<Api>;
  function capacityFixture() {
    const { request, context } = fixture(100);
    request.model.contextWindow = 8192;
    request.model.maxTokens = 1024;
    request.instructions = context.systemPrompt = "Complete the requested task";
    request.prompt = "Save hello to notes.txt";
    for (const [index, item] of request.history.entries()) {
      item.content = `Old message ${index} ${"filler ".repeat(80)}`;
      (context.messages[index] as { content: string }).content = item.content;
    }
    (context.messages.at(-1) as { content: string }).content = request.prompt;
    return { request, context };
  }
  it("leaves attainable configured output capacity by removing only optional history", () => {
    const { request, context } = capacityFixture();
    const raw = structuredClone(context);
    const prepared = createRuntimeContextPolicy(request).prepareContext(context, ccModel);
    expect(effectivePiOutputTokens(ccModel, prepared, 1024)).toBe(1024);
    expect(prepared.messages.at(-1)).toEqual(context.messages.at(-1));
    expect(context).toEqual(raw);
  });
  it("keeps the normal selection when the SDK cannot improve its unavoidable small-window cap", () => {
    const { request, context } = capacityFixture();
    request.model.contextWindow = 4096;
    const small = { ...ccModel, contextWindow: 4096 };
    const unknown = createRuntimeContextPolicy(request).prepareContext(context, {
      ...small,
      api: "openai-responses",
    });
    const prepared = createRuntimeContextPolicy(request).prepareContext(context, small);
    expect(effectivePiOutputTokens(small, prepared, 1024)).toBe(1);
    expect(prepared.messages).toEqual(unknown.messages);
  });
  it("targets the actual mandatory capacity without inventing an output minimum", () => {
    const { request, context } = capacityFixture();
    request.prompt = "Required words ".repeat(900);
    (context.messages.at(-1) as { content: string }).content = request.prompt;
    const mandatory = { ...context, messages: [context.messages.at(-1)!] };
    const attainable = effectivePiOutputTokens(ccModel, mandatory, 1024)!;
    expect(attainable).toBeGreaterThan(1);
    expect(attainable).toBeLessThan(1024);
    const prepared = createRuntimeContextPolicy(request).prepareContext(context, ccModel);
    expect(effectivePiOutputTokens(ccModel, prepared, 1024)).toBe(attainable);
    expect(prepared.messages.at(-1)).toEqual(mandatory.messages[0]);
  });
  it("preserves diagnostic input and separates audited and uncalibrated API budgets", () => {
    const { request, context } = capacityFixture();
    request.contextStrategy = "current";
    const prepared = createRuntimeContextPolicy(request).prepareContext(context, ccModel);
    expect(prepared.messages).toEqual(context.messages);
    expect(effectivePiOutputTokens(ccModel, prepared, 1024)).toBe(1);
    request.contextStrategy = undefined;
    const bounded = createRuntimeContextPolicy(request).prepareContext(context, ccModel);
    for (const api of ["openai-responses", "anthropic-messages"] as const) {
      const audited = { ...ccModel, api };
      const equivalent = createRuntimeContextPolicy(request).prepareContext(context, audited);
      expect(equivalent.messages).toEqual(bounded.messages);
      expect(effectivePiOutputTokens(audited, equivalent, 1024)).toBe(1024);
    }
    const uncalibrated = { ...ccModel, api: "google-generative-ai" } as Model<Api>;
    const normal = createRuntimeContextPolicy(request).prepareContext(context, uncalibrated);
    expect(effectivePiOutputTokens(uncalibrated, normal, 1024)).toBeUndefined();
    expect(bounded.messages.length).toBeLessThan(normal.messages.length);
  });
  it("keeps restored diagnostic input bounded with attainable output", () => {
    const { request, context } = capacityFixture();
    request.contextStrategy = "current";
    request.contextRestored = true;
    const prepared = createRuntimeContextPolicy(request).prepareContext(context, ccModel);
    expect(effectivePiOutputTokens(ccModel, prepared, 1024)).toBe(1024);
    expect(prepared.messages.at(-1)).toEqual(context.messages.at(-1));
  });
  it("does not measure mandatory and optional candidates again when the normal cap already fits", () => {
    const { request, context } = fixture(0);
    request.model.maxTokens = 1024;
    const spy = vi.spyOn(outputBudget, "effectivePiOutputTokens");
    try {
      createRuntimeContextPolicy(request).prepareContext(context, ccModel);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("evaluates labelled whole-result evidence without further shortening its mandatory payload", () => {
    const { request, context } = capacityFixture();
    request.verbatimMcpServers = { ids: [], slugs: ["mail"] };
    request.model.maxImagesPerPrompt = 1;
    const content = markToolResultContent(
      [
        {
          type: "text" as const,
          text: JSON.stringify({ id: "exact", body: "original evidence ".repeat(50) }),
        },
        { type: "image" as const, data: "synthetic", mimeType: "image/png" },
      ],
      {
        historyReference: { tool: "read_history", arguments: { toolResultId: "original" } },
        wrapped: false,
      },
    );
    markMcpToolResultRoute(content, {
      connectorId: "mcp",
      resourceId: "mail-id",
      catalogGroup: "mail",
      toolName: "read",
    });
    context.messages.push(
      fauxAssistantMessage([
        { type: "toolCall", id: "whole", name: "mcp__mail__read", arguments: {} },
      ]),
      {
        role: "toolResult",
        toolCallId: "whole",
        toolName: "mcp__mail__read",
        content,
        details: { frameId: "whole-frame" },
        isError: false,
        timestamp: 3,
      },
    );
    const prepared = createRuntimeContextPolicy(request, undefined, {
      imageTokens: 10,
    }).prepareContext(context, ccModel);
    const result = prepared.messages.find((message) => message.role === "toolResult")!;
    expect(result.content.slice(-content.length)).toEqual(content);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Automated message"),
    });
    expect(toolResultContentProvenance(result.content)).toEqual({
      historyReference: { tool: "read_history", arguments: { toolResultId: "original" } },
      wrapped: false,
    });
    expect(effectivePiOutputTokens(ccModel, prepared, 1024)).toBe(1024);
  });
  it("rebuilds an append only when optional selection improves a real SDK window constraint", () => {
    const { request, context } = capacityFixture();
    const policy = createRuntimeContextPolicy(request);
    const first = policy.prepareContext(context, ccModel);
    const continuation = {
      ...context,
      messages: [
        ...context.messages,
        fauxAssistantMessage([{ type: "toolCall", id: "step", name: "shell", arguments: {} }]),
        {
          role: "toolResult" as const,
          toolCallId: "step",
          toolName: "shell",
          content: [{ type: "text" as const, text: "New evidence ".repeat(60) }],
          isError: false,
          timestamp: 3,
        },
      ],
    };
    const appended = {
      ...context,
      messages: [...first.messages, ...continuation.messages.slice(context.messages.length)],
    };
    expect(effectivePiOutputTokens(ccModel, appended, 1024)).toBeLessThan(1024);
    const prepared = policy.prepareContext(continuation, ccModel);
    expect(effectivePiOutputTokens(ccModel, prepared, 1024)).toBe(1024);
    expect(prepared.messages.length).toBeLessThan(appended.messages.length);
    expect(prepared.messages.at(-1)).toEqual(continuation.messages.at(-1));
    expect(policy.prepareContext(continuation, ccModel)).toEqual(prepared);
  });
  it("keeps appending when a fresh choice cannot improve the SDK output cap", () => {
    const { request, context } = capacityFixture();
    request.model.contextWindow = 4096;
    const small = { ...ccModel, contextWindow: 4096 };
    const policy = createRuntimeContextPolicy(request);
    const first = policy.prepareContext(context, small);
    const continued = {
      ...context,
      messages: [...context.messages, { role: "user" as const, content: "Continue", timestamp: 3 }],
    };
    const next = policy.prepareContext(continued, small);
    expect(effectivePiOutputTokens(small, next, 1024)).toBe(1);
    expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages);
  });
});
