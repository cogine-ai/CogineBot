import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { expect, it, vi } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";
import { observedPiStream } from "./pi-usage.js";

it.each(
  (["low", "xhigh", "max"] as const).flatMap((reasoning) =>
    [0, 1024].map((budget) => ({ reasoning, budget })),
  ),
)(
  "keeps explicit Anthropic thinking $reasoning budget $budget inside its one reservation",
  async ({ reasoning, budget }) => {
    const model: Model<Api> = {
      api: "anthropic-messages",
      provider: "synthetic-thinking",
      id: "synthetic-thinking",
      name: "Synthetic",
      baseUrl: "https://127.0.0.1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
    };
    const models = createModels();
    models.setProvider(
      createProvider({
        id: model.provider,
        models: [model],
        api: anthropicMessagesApi(),
        auth: {
          apiKey: {
            name: "Synthetic",
            resolve: async () => ({ auth: { apiKey: "synthetic-key" }, source: "fixture" }),
          },
        },
      }),
    );
    const requests: Array<Record<string, unknown>> = [];
    const beforeCall = vi.fn(() => "reservation");
    const options: SimpleStreamOptions = {
      apiKey: "synthetic-key",
      reasoning,
      thinkingBudgets: { low: budget, high: budget },
      maxTokens: 512,
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json(
          { error: { type: "invalid_request_error", message: "Synthetic capture" } },
          { status: 400 },
        );
      },
    };
    const stream = observedPiStream(
      models,
      model,
      { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
      options,
      vi.fn(),
      { beforeCall, afterCall: vi.fn() },
    );
    for await (const _event of stream) {
      /* Real SDK serialization and error parser. */
    }
    const result = await stream.result();
    expect(beforeCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ maxOutputTokens: 512 }),
    );
    if (budget === 0) {
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ max_tokens: 512, thinking: { type: "disabled" } });
    } else {
      expect(requests).toHaveLength(0);
      expect(result.errorMessage).toBe("Model thinking budget exceeds the reserved output limit");
    }
  },
);

it.each(["off", null, undefined] as const)(
  "keeps actual runtime Anthropic thinking=%s distinct from explicit zero budget",
  async (thinkingLevel) => {
    const requests: Array<Record<string, unknown>> = [];
    const beforeCall = vi.fn(() => "reservation");
    const afterCall = vi.fn();
    const runtime = new PiAgentRuntime({
      modelCallObserver: { beforeCall, afterCall },
      modelFetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json(
          { error: { type: "invalid_request_error", message: "Synthetic capture" } },
          { status: 400 },
        );
      },
    });
    await expect(
      (async () => {
        for await (const _event of runtime.run(
          {
            botId: "synthetic-bot",
            threadId: "synthetic-thread",
            runId: `synthetic-thinking-${thinkingLevel}`,
            prompt: "Short answer",
            instructions: "Be concise",
            history: [],
            tools: [],
            model: {
              provider: "openai-compatible",
              id: "synthetic-thinking",
              baseUrl: "https://127.0.0.1/v1",
              apiProtocol: "anthropic-messages",
              apiKey: "synthetic-key",
              reasoning: true,
              thinkingLevel,
              contextWindow: 32768,
              maxTokens: 4096,
            },
          },
          { signal: AbortSignal.timeout(15000) },
        )) {
          /* Actual Agent and SDK. */
        }
      })(),
    ).rejects.toThrow("Synthetic capture");
    expect(beforeCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ maxOutputTokens: 4096 }),
    );
    expect(afterCall).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.max_tokens).toBe(4096);
    if (thinkingLevel === "off")
      expect(requests[0]).toMatchObject({ thinking: { type: "disabled" } });
    else expect(requests[0]).toMatchObject({ thinking: { type: "enabled", budget_tokens: 3072 } });
  },
);
