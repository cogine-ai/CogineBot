import type { AgentRunRequest, AgentRuntimeEvent, ModelCallObserver } from "@rakazo/adapter-kit";
import { MODEL_CONTEXT_TOO_SMALL_ERROR } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";

const prompt = "Preserve the current request for a short answer.";
const result = "Fixture complete.";
const apiKey = "synthetic-budget-key";
const tool = {
  name: "lookup_fixture",
  description: "Read a named fixture.",
  inputSchema: { type: "object", properties: { name: { type: "string" } } },
  readOnly: true,
};
const compatible = {
  provider: "openai-compatible",
  id: "fixture-compatible",
  baseUrl: "http://127.0.0.1:1/v1",
  contextWindow: 32_768,
  maxTokens: 1_024,
  apiKey,
};
const openRouter = {
  provider: "openrouter",
  id: "fixture-unlisted-model",
  contextWindow: 32_768,
  maxTokens: 4_096,
  apiKey,
};
const creditError = {
  message:
    "This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 768.",
  code: 402,
  metadata: { limit_source: "openrouter_credits" },
};

type CompletionPayload = {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  max_completion_tokens?: number;
  max_tokens?: number;
};

function request(model: AgentRunRequest["model"]): AgentRunRequest {
  return {
    botId: "budget-fixture-bot",
    threadId: "budget-fixture-thread",
    runId: `budget-fixture-${model.provider}`,
    prompt,
    instructions: "Use the offered tools when needed and answer briefly.",
    history: [],
    tools: [tool],
    contextStrategy: "retrieval",
    model,
  };
}

function completion() {
  return new Response(
    `data: ${JSON.stringify({
      id: "fixture-completion",
      choices: [{ index: 0, delta: { role: "assistant", content: result }, finish_reason: "stop" }],
    })}\n\ndata: ${JSON.stringify({
      id: "fixture-completion",
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function fixture(status: number, error: Record<string, unknown>) {
  const calls: Array<{ url: string; authorization: string | null; payload: CompletionPayload }> =
    [];
  const modelFetch: typeof fetch = async (input, init) => {
    const sent = new Request(input, init);
    calls.push({
      url: sent.url,
      authorization: sent.headers.get("authorization"),
      payload: (await sent.json()) as CompletionPayload,
    });
    return calls.length === 1 ? Response.json({ error }, { status }) : completion();
  };
  const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(() => `budget-${calls.length}`);
  const afterCall = vi.fn<ModelCallObserver["afterCall"]>();
  const runtime = new PiAgentRuntime({ modelFetch, modelCallObserver: { beforeCall, afterCall } });
  return { runtime, calls, beforeCall };
}

async function run(runtime: PiAgentRuntime, input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(input, { signal: AbortSignal.timeout(5_000) })) {
    events.push(event);
  }
  return events;
}

describe("Pi provider request budgets over HTTP", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("Unexpected network request outside the synthetic transport");
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    {
      model: compatible,
      url: "http://127.0.0.1:1/v1/chat/completions",
      status: 400,
      error: {
        code: "context_length_exceeded",
        type: "invalid_request_error",
        message: "This model's maximum context length is 4096 tokens. This request used 10000.",
      },
    },
    {
      model: { ...compatible, provider: "groq", id: "llama-3.3-70b-versatile", baseUrl: undefined },
      url: "https://api.groq.com/openai/v1/chat/completions",
      status: 413,
      error: {
        code: "rate_limit_exceeded",
        type: "tokens",
        message:
          "Request too large for this model on tokens per minute (TPM): Limit 4096, Requested 10000, please reduce your message size.",
      },
    },
  ])(
    "fits the next $model.provider request on the same connection",
    async ({ model, url, status, error }) => {
      const { runtime, calls, beforeCall } = fixture(status, error);
      const input = request(model);
      input.history = Array.from({ length: 8 }, (_, index) => [
        {
          role: "user" as const,
          content: `Question ${index}. ${"Review fixture history. ".repeat(60)}`,
        },
        {
          role: "assistant" as const,
          content: `Answer ${index}. ${"Record fixture details. ".repeat(60)}`,
        },
      ]).flat();
      input.onModelChange = vi.fn();

      const events = await run(runtime, input);

      expect(events.at(-1)).toEqual({ type: "done", text: result });
      expect(calls.map(({ url, authorization }) => ({ url, authorization }))).toEqual([
        { url, authorization: `Bearer ${apiKey}` },
        { url, authorization: `Bearer ${apiKey}` },
      ]);
      expect(input.onModelChange).not.toHaveBeenCalled();
      const [initial, corrected] = calls.map(({ payload }) => payload);
      expect(corrected?.model).toBe(model.id);
      expect(JSON.stringify(corrected?.messages).length).toBeLessThan(
        JSON.stringify(initial?.messages).length,
      );
      const current = corrected!.messages.findLast(({ role }) => role === "user");
      expect(JSON.stringify(current?.content)).toContain(prompt);
      expect(JSON.stringify(initial!.messages[0]?.content)).toContain(input.instructions);
      expect(corrected!.messages[0]).toEqual(initial!.messages[0]);
      expect(initial?.tools).toContainEqual(
        expect.objectContaining({ function: expect.objectContaining({ name: tool.name }) }),
      );
      expect(corrected?.tools).toEqual(initial?.tools);
      // The planned window is floor(4096 * 0.85). The SDK must not apply its
      // nominal context buffer again and reduce the usable output to one token.
      expect(
        calls.map(({ payload }) => payload.max_completion_tokens ?? payload.max_tokens),
      ).toEqual([1_024, 870]);
      expect(beforeCall.mock.calls.map(([call]) => call.maxOutputTokens)).toEqual([1_024, 870]);
      expect(beforeCall).toHaveBeenCalledTimes(2);
      expect(beforeCall.mock.calls[1]![0].inputTokensEstimate).toBeLessThan(
        beforeCall.mock.calls[0]![0].inputTokensEstimate,
      );
    },
  );

  it("stops before a second request or reservation when required context cannot fit", async () => {
    const { runtime, calls, beforeCall } = fixture(400, {
      code: "context_length_exceeded",
      type: "invalid_request_error",
      message: "This model's maximum context length is 1024 tokens. This request used 4000.",
    });
    const input = request(compatible);
    input.instructions = "Keep the fixed fixture instructions and all constraints. ".repeat(75);
    input.tools = [
      { ...tool, description: "Read this fixture using its exact contract. ".repeat(75) },
    ];

    await expect(run(runtime, input)).rejects.toThrow(MODEL_CONTEXT_TOO_SMALL_ERROR);

    expect(calls).toHaveLength(1);
    expect(beforeCall).toHaveBeenCalledOnce();
  });

  it("reserves and sends the exact affordable OpenRouter output on the same connection", async () => {
    const { runtime, calls, beforeCall } = fixture(402, creditError);
    const input = request(openRouter);

    const events = await run(runtime, input);

    expect(events.at(-1)).toEqual({ type: "done", text: result });
    expect(calls.map(({ url, authorization }) => ({ url, authorization }))).toEqual([
      { url: "https://openrouter.ai/api/v1/chat/completions", authorization: `Bearer ${apiKey}` },
      { url: "https://openrouter.ai/api/v1/chat/completions", authorization: `Bearer ${apiKey}` },
    ]);
    expect(calls.map(({ payload }) => payload.max_completion_tokens)).toEqual([4_096, 768]);
    expect(beforeCall.mock.calls.map(([call]) => call.maxOutputTokens)).toEqual([4_096, 768]);
    expect(calls[1]?.payload.messages).toEqual(calls[0]?.payload.messages);
    expect(calls[1]?.payload.tools).toEqual(calls[0]?.payload.tools);
  });

  it("shares the HTTP retry limit across an affordability correction and later outages", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.stubEnv("MODEL_STREAM_MAX_RETRIES", "1");
    try {
      const caps: Array<number | undefined> = [];
      const unavailable = "Fixture service unavailable.";
      const modelFetch: typeof fetch = async (input, init) => {
        const payload = (await new Request(input, init).json()) as CompletionPayload;
        caps.push(payload.max_completion_tokens);
        return caps.length === 1
          ? Response.json({ error: creditError }, { status: 402 })
          : Response.json(
              { error: { message: unavailable } },
              { status: 503, headers: { "retry-after-ms": "1" } },
            );
      };
      const outcome = run(new PiAgentRuntime({ modelFetch }), request(openRouter)).catch(
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(caps).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(35_000);

      expect(await outcome).toEqual(
        expect.objectContaining({ message: expect.stringContaining(unavailable) }),
      );
      // One correction and two outer retries use the Run's three retries.
      expect(caps).toEqual([4_096, 768, 768, 768]);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
});
