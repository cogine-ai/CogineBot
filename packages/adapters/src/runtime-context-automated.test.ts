import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  ContextBudgetError,
  ContextCacheTracker,
  estimateContextTokens,
  providerContextPrefix,
} from "./context-selection.js";
import { createRuntimeContextPolicy } from "./runtime-context.js";

const label = "[Automated message from CogineBot, not from the user]";
const model = {
  provider: "automated-policy",
  id: "automated-policy-model",
  baseUrl: "https://models.invalid",
  contextWindow: 16_384,
  maxTokens: 512,
} as Model<Api>;
const image = { type: "image" as const, data: "c3ludGhldGlj", mimeType: "image/png" };
function fixture(strategy: AgentRunRequest["contextStrategy"] = "retrieval") {
  const request: AgentRunRequest = {
    botId: "context-bot",
    threadId: "context-thread",
    runId: "context-run",
    instructions: "Stable instructions",
    prompt: "Inspect the screen",
    tools: [],
    history: [],
    contextStrategy: strategy,
    model: {
      provider: model.provider,
      id: model.id,
      cacheCapabilities: { scope: "account", retentionMs: 300_000, minimumTokens: 1 },
    },
  };
  const context: Context = {
    systemPrompt: request.instructions,
    tools: [],
    messages: [
      { role: "user", content: request.prompt, timestamp: 1 },
      fauxAssistantMessage([
        { type: "toolCall", id: "capture", name: "computer_observe", arguments: {} },
      ]),
      {
        role: "toolResult",
        toolCallId: "capture",
        toolName: "computer_observe",
        content: [{ type: "text", text: "Captured" }, image],
        details: { retained: true },
        isError: false,
        timestamp: 2,
      },
    ],
  };
  return { request, context };
}
const texts = (message: Message | undefined) =>
  Array.isArray(message?.content)
    ? message.content.filter((part) => part.type === "text").map((part) => part.text)
    : [];

describe("automated source context policy", () => {
  it.each(["current", "retrieval", "snapshots", "cache-aware"] as const)(
    "sends one image label under %s without mutating raw history or accumulating labels",
    (strategy) => {
      const { request, context } = fixture(strategy);
      const raw = structuredClone(context);
      const cache = new ContextCacheTracker(() => 100);
      const predicts = vi.spyOn(cache, "predict");
      const records = vi.spyOn(cache, "record");
      const policy = createRuntimeContextPolicy(request, undefined, {
        cacheTracker: cache,
        imageTokens: 10,
      });
      const first = policy.prepareContext(context, model);
      const second = policy.prepareContext(first, model);
      expect(texts(first.messages.at(-1))[0]).toContain(label);
      expect(second).toEqual(first);
      expect(context).toEqual(raw);
      policy.onUsage({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 0 });
      const prefix = providerContextPrefix(first.systemPrompt!, first.tools!, first.messages);
      expect(records).toHaveBeenCalledWith(expect.objectContaining({ prefix }), 0);
      for (const [prediction] of predicts.mock.calls) {
        const messages = (prediction.prefix as { messages: Message[] }).messages;
        expect(texts(messages.at(-1))[0]).toContain(label);
      }
      expect(policy.getDecision()!.estimatedInputTokens).toBe(estimateContextTokens(prefix, 10));
    },
  );

  it("shortens raw JSON before labeling and reserves label overhead inside a tight budget", () => {
    const { request, context } = fixture();
    const result = context.messages.at(-1)! as Extract<Message, { role: "toolResult" }>;
    const content = JSON.stringify({
      id: "exact-id",
      status: "pending",
      evidence: "detail ".repeat(3000),
    });
    result.content = [{ type: "text", text: content }, image];
    const policy = createRuntimeContextPolicy(request, undefined, { imageTokens: 10 });
    const prepared = policy.prepareContext(context, { ...model, contextWindow: 2800 });
    const [source, body] = texts(prepared.messages.at(-1));
    expect(source).toContain(label);
    expect(JSON.parse(body!)).toMatchObject({
      id: "exact-id",
      status: "pending",
      contextTruncated: true,
    });
    expect(JSON.parse(body!).evidence).toContain("Tool result truncated");
    expect(
      estimateContextTokens(
        providerContextPrefix(prepared.systemPrompt!, prepared.tools!, prepared.messages),
        10,
      ),
    ).toBeLessThanOrEqual(2288);
    expect(result.content[0]).toEqual({ type: "text", text: content });
    expect(prepared.messages.at(-1)!.content).toContain(image);
    expect(policy.getDecision()!.truncatedToolResults).toBeGreaterThan(0);
    // Required evidence with no verbose body cannot borrow room reserved for labels.
    result.content = [image];
    const tight = createRuntimeContextPolicy(request, undefined, { imageTokens: 10 });
    expect(() => tight.prepareContext(context, { ...model, contextWindow: 1000 })).toThrow(
      ContextBudgetError,
    );
  });

  it.each(["snapshots", "cache-aware"] as const)(
    "omits optional navigation that exceeds the label-adjusted budget under %s",
    (strategy) => {
      const { request, context } = fixture(strategy);
      request.threadId = `tight-navigation-${strategy}`;
      request.history = Array.from({ length: 12 }, (_, index) => ({
        id: `history-${index}`,
        role: "user" as const,
        content: `Earlier discussion ${index}: ${"evidence ".repeat(150)}`,
      }));
      context.messages.unshift(
        ...request.history.map((message) => ({
          role: "user" as const,
          content: message.content,
          timestamp: 0,
          rakazoHistory: true,
          rakazoMessageId: message.id,
        })),
      );
      request.prompt = `Current objective: ${"x".repeat(3180)}`;
      const current = context.messages.splice(12, 1)[0]!;
      (current as Extract<Message, { role: "user" }>).content = request.prompt;
      context.messages.push(current);
      const raw = structuredClone(context);
      const policy = createRuntimeContextPolicy(request, undefined, { imageTokens: 10 });
      const prepared = policy.prepareContext(context, { ...model, contextWindow: 5000 });

      expect(prepared.messages.at(-1)).toEqual(current);
      expect(
        texts(prepared.messages.find((message) => message.role === "toolResult"))[0],
      ).toContain(label);
      expect(JSON.stringify(prepared)).not.toContain("Historical navigation snapshots");
      expect(
        estimateContextTokens(
          providerContextPrefix(prepared.systemPrompt!, prepared.tools!, prepared.messages),
          10,
        ),
      ).toBeLessThanOrEqual(4488);
      expect(context).toEqual(raw);

      const unlabelled = structuredClone(context);
      const result = unlabelled.messages.find(
        (message) => message.role === "toolResult",
      )! as Extract<Message, { role: "toolResult" }>;
      result.content = [{ type: "text", text: "Captured" }];
      const withoutReserve = createRuntimeContextPolicy(
        { ...request, threadId: `${request.threadId}-no-images` },
        undefined,
        { imageTokens: 10 },
      ).prepareContext(unlabelled, { ...model, contextWindow: 5000 });
      expect(JSON.stringify(withoutReserve)).toContain("Historical navigation snapshots");
      expect(
        estimateContextTokens(
          providerContextPrefix(
            withoutReserve.systemPrompt!,
            withoutReserve.tools!,
            withoutReserve.messages,
          ),
          10,
        ),
      ).toBeLessThanOrEqual(4488);

      const roomy = createRuntimeContextPolicy(
        { ...request, threadId: `${request.threadId}-more-room` },
        undefined,
        { imageTokens: 10 },
      ).prepareContext(context, { ...model, contextWindow: 5200 });
      expect(JSON.stringify(roomy)).toContain("Historical navigation snapshots");
      expect(
        estimateContextTokens(
          providerContextPrefix(roomy.systemPrompt!, roomy.tools!, roomy.messages),
          10,
        ),
      ).toBeLessThanOrEqual(4688);
    },
  );

  it("labels helper results without claiming images after the actual image block is removed", () => {
    const { request, context } = fixture();
    const result = context.messages.at(-1)! as Extract<Message, { role: "toolResult" }>;
    result.toolName = "run_subagent";
    result.content = [{ type: "text", text: "Subagent failed: unavailable" }];
    result.isError = true;
    const prepared = createRuntimeContextPolicy(request).prepareContext(context, model);
    expect(texts(prepared.messages.at(-1))).toEqual([
      `${label} Result from your helper, not a message from the user.`,
      "Subagent failed: unavailable",
    ]);
    expect(JSON.stringify(prepared)).not.toContain("Screenshot(s)");
    expect(prepared.messages.at(-1)).toMatchObject({
      toolCallId: "capture",
      isError: true,
      details: { retained: true },
    });
    expect(result.content).toEqual([{ type: "text", text: "Subagent failed: unavailable" }]);
  });

  it("reuses raw compressed projection hashes while all full, candidate and final cache views carry labels", () => {
    const { request, context } = fixture("cache-aware");
    request.threadId = "raw-projection-with-images";
    request.history = Array.from({ length: 30 }, (_, index) => ({
      id: `history-${index}`,
      role: "user" as const,
      content: `History ${index}: ${"earlier evidence ".repeat(50)}`,
    }));
    context.messages.unshift(
      ...request.history.map((message) => ({
        role: "user" as const,
        content: message.content,
        timestamp: 0,
        rakazoHistory: true,
        rakazoMessageId: message.id,
      })),
    );
    let now = 100;
    const cache = new ContextCacheTracker(() => now);
    const first = createRuntimeContextPolicy(request, undefined, {
      cacheTracker: cache,
      imageTokens: 10,
    });
    const compressed = first.prepareContext(context, model);
    expect(compressed.messages.length).toBeLessThan(context.messages.length);
    first.onUsage({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 0 });
    now = 1000;
    const predict = vi.spyOn(cache, "predict");
    const second = createRuntimeContextPolicy(request, undefined, {
      cacheTracker: cache,
      imageTokens: 10,
    });
    const next = second.prepareContext(
      {
        ...context,
        messages: [...context.messages, { role: "user", content: "Continue", timestamp: now }],
      },
      model,
    );
    expect(second.getDecision()!.predictedCache).toBe("likely-warm");
    expect(next.messages).toHaveLength(compressed.messages.length + 1);
    expect(next.messages[0]).toEqual(compressed.messages[0]);
    expect(predict.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [entry] of predict.mock.calls) {
      const results = (entry.prefix as { messages: Message[] }).messages.filter(
        (message) => message.role === "toolResult",
      );
      expect(results).toHaveLength(1);
      expect(texts(results[0])[0]).toContain(label);
    }
    const fallback = createRuntimeContextPolicy(
      { ...request, model: { ...request.model, id: "fallback" } },
      undefined,
      { cacheTracker: cache, imageTokens: 10 },
    );
    const fallbackView = fallback.prepareContext(context, { ...model, id: "fallback" });
    expect(texts(fallbackView.messages.at(-1))[0]).toContain(label);
    expect(fallback.getDecision()!.predictedCache).toBe("likely-cold");
  });
});
