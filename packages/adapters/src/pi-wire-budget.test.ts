import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import { observedPiStream } from "./pi-usage.js";

const apis = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
};

function fixture(api: keyof typeof apis, reasoning = false) {
  const model: Model<Api> = {
    provider: "synthetic-wire-budget",
    id: "synthetic-wire-budget",
    api,
    name: "Synthetic wire budget",
    baseUrl: "https://model.invalid/v1",
    reasoning,
    ...(api === "openai-completions" ? { compat: { maxTokensField: "max_tokens" as const } } : {}),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 8_192,
    contextWindow: 200_000,
  };
  const models = builtinModels() as MutableModels;
  models.setProvider(
    createProvider({
      id: model.provider,
      models: [model],
      api: apis[api](),
      auth: {
        apiKey: {
          name: "Synthetic",
          resolve: async () => ({ auth: { apiKey: "synthetic-key" }, source: "fixture" }),
        },
      },
    }),
  );
  return { model, models };
}

describe("actual SDK final wire budgets", () => {
  it.each(
    (Object.keys(apis) as Array<keyof typeof apis>).flatMap((api) =>
      [1, 15, 16].flatMap((cap) =>
        [false, true].flatMap((replace) =>
          [false, true].map((deadline) => ({ api, cap, replace, deadline })),
        ),
      ),
    ),
  )(
    "keeps $api cap$cap equal to reservation after replacement=$replace deadline=$deadline",
    async ({ api, cap, replace, deadline }) => {
      const { model, models } = fixture(api);
      const requests: Record<string, unknown>[] = [];
      const beforeCall = vi.fn((_call: { maxOutputTokens: number }) => "reservation");
      const onPayload = vi.fn((payload: unknown) =>
        replace
          ? {
              ...(payload as Record<string, unknown>),
              max_tokens: 99_999,
              max_completion_tokens: 99_999,
              max_output_tokens: 99_999,
            }
          : undefined,
      );
      const stream = observedPiStream(
        models,
        model,
        { messages: [{ role: "user", content: "Short request", timestamp: 1 }] },
        {
          apiKey: "synthetic-wire-key",
          maxTokens: cap,
          onPayload,
          fetch: async (_input, init) => {
            requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                error: {
                  message: "Synthetic endpoint stops after serialization",
                  type: "invalid_request_error",
                },
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          },
        },
        vi.fn(),
        { beforeCall, afterCall: vi.fn() },
        undefined,
        deadline ? { requestDeadline: Date.now() + 10_000 } : undefined,
      );
      for await (const _event of stream) {
        /* The real SDK serializes and parses the synthetic error. */
      }
      expect((await stream.result()).stopReason).toBe("error");
      expect(onPayload).toHaveBeenCalledOnce();
      expect(beforeCall).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ maxOutputTokens: cap }),
      );
      expect(requests).toHaveLength(1);
      const field =
        api === "openai-responses"
          ? "max_output_tokens"
          : api === "anthropic-messages"
            ? "max_tokens"
            : "max_tokens";
      expect(requests[0]?.[field]).toBe(cap);
      for (const name of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
        if (name !== field) expect(requests[0]).not.toHaveProperty(name);
      }
    },
  );
});

it.each([
  { cap: 1, deadline: false },
  { cap: 15, deadline: true },
])(
  "keeps SDK default CC max_completion_tokens cap$cap after replacement deadline=$deadline",
  async ({ cap, deadline }) => {
    const { model, models } = fixture("openai-completions");
    delete model.compat;
    const requests: Record<string, unknown>[] = [];
    const beforeCall = vi.fn(() => "reservation");
    const afterCall = vi.fn();
    const onPayload = vi.fn((payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      max_tokens: 99_999,
      max_completion_tokens: 99_999,
      max_output_tokens: 99_999,
    }));
    const stream = observedPiStream(
      models,
      model,
      { messages: [{ role: "user", content: "Short request", timestamp: 1 }] },
      {
        apiKey: "synthetic-wire-key",
        maxTokens: cap,
        onPayload,
        fetch: async (_input, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return Response.json(
            {
              error: { message: "Synthetic serialization complete", type: "invalid_request_error" },
            },
            { status: 400 },
          );
        },
      },
      vi.fn(),
      { beforeCall, afterCall },
      undefined,
      deadline ? { requestDeadline: Date.now() + 10_000 } : undefined,
    );
    for await (const _event of stream) {
      /* Real SDK default field and final payload hook. */
    }
    expect((await stream.result()).stopReason).toBe("error");
    expect(onPayload).toHaveBeenCalledOnce();
    expect(beforeCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ maxOutputTokens: cap }),
    );
    expect(afterCall).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.max_completion_tokens).toBe(cap);
    expect(requests[0]).not.toHaveProperty("max_tokens");
    expect(requests[0]).not.toHaveProperty("max_output_tokens");
  },
);
