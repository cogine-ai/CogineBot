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

function fittedThinkingModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    api: "anthropic-messages",
    provider: "synthetic-fitted-thinking",
    id: "synthetic-fitted-thinking",
    name: "Synthetic fitted thinking",
    baseUrl: "https://127.0.0.1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
    ...overrides,
  };
}

async function captureFittedThinking(model: Model<Api>, options: SimpleStreamOptions) {
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
  const afterCall = vi.fn();
  const stream = observedPiStream(
    models,
    model,
    { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
    {
      apiKey: "synthetic-key",
      reasoning: "medium",
      ...options,
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json(
          { error: { type: "invalid_request_error", message: "Synthetic capture" } },
          { status: 400 },
        );
      },
    },
    vi.fn(),
    { beforeCall, afterCall },
  );
  for await (const _event of stream) {
    /* Actual SDK serializer and response parser. */
  }
  return { requests, beforeCall, afterCall, result: await stream.result() };
}

it.each([1024, 2048, 4096])(
  "fits automatic Anthropic thinking into reserved cap %s without expanding quota",
  async (cap) => {
    const { requests, beforeCall, afterCall } = await captureFittedThinking(fittedThinkingModel(), {
      maxTokens: cap,
    });
    expect(beforeCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ maxOutputTokens: cap }),
    );
    expect(afterCall).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.max_tokens).toBe(cap);
    expect(requests[0]?.thinking).toMatchObject(
      cap === 1024 ? { type: "disabled" } : { type: "enabled", budget_tokens: cap - 1024 },
    );
  },
);

it.each(
  (["low", "high"] as const).flatMap((reasoning) =>
    [1, 1024, 1025, 2047, 2048, 4096].map((cap) => ({ reasoning, cap })),
  ),
)(
  "fits automatic $reasoning thinking at $cap without invalid subminimum budgets",
  async ({ reasoning, cap }) => {
    const { requests, beforeCall, afterCall } = await captureFittedThinking(fittedThinkingModel(), {
      reasoning,
      maxTokens: cap,
    });
    expect(beforeCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ maxOutputTokens: cap }),
    );
    expect(afterCall).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.max_tokens).toBe(cap);
    expect(requests[0]?.thinking).toMatchObject(
      cap < 2048
        ? { type: "disabled" }
        : {
            type: "enabled",
            budget_tokens: cap === 2048 ? 1024 : reasoning === "low" ? 2048 : 3072,
          },
    );
  },
);

it.each(["replace", "mutate"] as const)(
  "preserves explicit caller thinking through %s snapshots",
  async (mode) => {
    for (const budget of [32, 1024, 99999]) {
      const onPayload: NonNullable<SimpleStreamOptions["onPayload"]> = (payload) => {
        const row = payload as { thinking: { type: string; budget_tokens: number } };
        if (mode === "mutate") {
          row.thinking.budget_tokens = budget;
          return row;
        }
        return { ...row, thinking: { type: "enabled", budget_tokens: budget } };
      };
      const { requests, result, beforeCall, afterCall } = await captureFittedThinking(
        fittedThinkingModel(),
        { maxTokens: 2048, onPayload },
      );
      expect(beforeCall).toHaveBeenCalledOnce();
      expect(afterCall).toHaveBeenCalledOnce();
      if (budget === 1024) {
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          max_tokens: 2048,
          thinking: { type: "enabled", budget_tokens: 1024 },
        });
      } else {
        expect(requests).toHaveLength(0);
        expect(result.errorMessage).toBe("Model thinking budget exceeds the reserved output limit");
      }
    }
  },
);

it("keeps adaptive thinking unchanged and refuses impossible forced thinking", async () => {
  const adaptive = await captureFittedThinking(
    fittedThinkingModel({ compat: { forceAdaptiveThinking: true } }),
    { maxTokens: 1024 },
  );
  expect(adaptive.requests).toHaveLength(1);
  expect(adaptive.requests[0]).toMatchObject({ max_tokens: 1024, thinking: { type: "adaptive" } });
  const forced = await captureFittedThinking(
    fittedThinkingModel({ thinkingLevelMap: { off: null } }),
    { maxTokens: 1024 },
  );
  expect(forced.requests).toHaveLength(0);
  expect(forced.result.errorMessage).toBe(
    "Model thinking budget exceeds the reserved output limit",
  );
});

it("fits thinking to the effective context reservation instead of configured output", async () => {
  const { requests, beforeCall } = await captureFittedThinking(
    fittedThinkingModel({ contextWindow: 4096 }),
    { maxTokens: 4096 },
  );
  expect(beforeCall).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ maxOutputTokens: 1 }),
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ max_tokens: 1, thinking: { type: "disabled" } });
});

it.each(["off", null, undefined] as const)(
  "sends an accepted low-cap runtime configuration with thinking=%s",
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
            botId: "synthetic",
            threadId: "synthetic",
            runId: `low-cap-${thinkingLevel}`,
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
              maxTokens: 1024,
            },
          },
          { signal: AbortSignal.timeout(15000) },
        )) {
          /* Actual Agent+SDK. */
        }
      })(),
    ).rejects.toThrow("Synthetic capture");
    expect(beforeCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ maxOutputTokens: 1024 }),
    );
    expect(afterCall).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ max_tokens: 1024, thinking: { type: "disabled" } });
  },
);

it("uses the resolved backup own thinking budget without extra calls or reservation", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const beforeCall = vi.fn(() => "reservation");
  const afterCall = vi.fn();
  const backup = {
    provider: "openai-compatible",
    id: "synthetic-backup",
    baseUrl: "https://127.0.0.1/v1",
    apiProtocol: "anthropic-messages" as const,
    apiKey: "synthetic-backup-key",
    reasoning: true,
    thinkingLevel: "low" as const,
    maxTokens: 4096,
    contextWindow: 65536,
  };
  const runtime = new PiAgentRuntime({
    modelCallObserver: { beforeCall, afterCall },
    modelFetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json(
        {
          error: {
            type: requests.length === 1 ? "insufficient_quota" : "invalid_request_error",
            message: requests.length === 1 ? "Insufficient credits" : "Synthetic capture",
          },
        },
        { status: requests.length === 1 ? 402 : 400 },
      );
    },
  });
  await expect(
    (async () => {
      for await (const _event of runtime.run(
        {
          botId: "synthetic",
          threadId: "synthetic",
          runId: "thinking-backup",
          prompt: "Short answer",
          instructions: "Be concise",
          history: [],
          tools: [],
          model: {
            ...backup,
            id: "synthetic-primary",
            apiProtocol: "chat-completions",
            thinkingLevel: "high",
          },
          fallbackModels: [backup],
        },
        { signal: AbortSignal.timeout(15000) },
      )) {
        /* Actual Agent fallback and SDK requests. */
      }
    })(),
  ).rejects.toThrow("Synthetic capture");
  expect(requests).toHaveLength(2);
  expect(beforeCall).toHaveBeenCalledTimes(2);
  expect(afterCall).toHaveBeenCalledTimes(2);
  expect(requests[1]).toMatchObject({
    model: "synthetic-backup",
    max_tokens: 4096,
    thinking: { type: "enabled", budget_tokens: 2048 },
  });
});
