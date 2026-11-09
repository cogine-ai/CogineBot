import { once } from "node:events";
import { createServer } from "node:http";
import type { Api, Context, Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRuntimeEvent, AgentUsage } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { lookupOpenRouterUsage } from "./openrouter-usage.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";
import { PiAgentRuntime, reliableModelStream } from "./pi-runtime.js";
import { normalizePiUsage, observedPiStream, usageReportingFetch } from "./pi-usage.js";

const model: Model<Api> = {
  provider: "openrouter",
  id: "fixture",
  api: "openai-completions",
  name: "fixture",
  baseUrl: "https://model.example.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 256,
};
const sse = (usage?: object) =>
  `${[
    {
      id: "test",
      choices: [{ index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: null }],
    },
    { id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ...(usage ? [{ id: "test", choices: [], usage }] : []),
  ]
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join("")}data: [DONE]\n\n`;

async function run(usage?: object, selectedModel = model) {
  const events: AgentRuntimeEvent[] = [];
  const beforeCall = vi.fn((_call: { inputTokensEstimate: number }) => "reservation");
  const afterCall = vi.fn();
  const stream = await observedPiStream(
    builtinModels(),
    selectedModel,
    { systemPrompt: "Fixture", messages: [{ role: "user", content: "test", timestamp: 1 }] },
    {
      apiKey: "fake-fixture-key",
      fetch: async () =>
        new Response(sse(usage), { headers: { "content-type": "text/event-stream" } }),
    },
    (event) => events.push(event),
    { beforeCall, afterCall },
  );
  for await (const _event of stream) {
    /* Real Pi provider parser consumes synthetic endpoint. */
  }
  return { events, beforeCall, afterCall, result: await stream.result() };
}

async function runCostCall(
  fetch: typeof globalThis.fetch,
  baseUrl = "https://openrouter.ai/api/v1",
  overrides: Partial<Model<Api>> = {},
) {
  const recordUsage = vi.fn();
  const models = builtinModels();
  const selected = { ...model, baseUrl, ...overrides };
  const context: Context = { messages: [{ role: "user", content: "Test cost", timestamp: 1 }] };
  const stream = reliableModelStream(
    models,
    selected,
    context,
    { apiKey: "fixture-connection-key", fetch, maxRetries: 0 },
    undefined,
    undefined,
    (options) =>
      observedPiStream(
        models,
        selected,
        context,
        options,
        () => undefined,
        undefined,
        { operationKind: "answer", modelCredentialId: "fixture-connection" },
        { recordUsage },
      ),
  );
  await stream.result();
  expect(recordUsage).toHaveBeenCalledTimes(1);
  return recordUsage.mock.calls[0]?.[0];
}

describe("provider cost evidence", () => {
  it.each([
    {
      name: "completed",
      interrupted: false,
      reportedCost: undefined,
      source: "pi-catalog-estimate",
    },
    { name: "interrupted", interrupted: true, reportedCost: undefined, source: null },
    {
      name: "reported before interruption",
      interrupted: true,
      reportedCost: 0.125,
      source: "provider-reported",
    },
  ])("classifies Anthropic cost when $name", async ({ interrupted, reportedCost, source }) => {
    const frames = [
      {
        type: "message_start",
        message: {
          id: "msg-cost-fixture",
          type: "message",
          role: "assistant",
          model: "fixture",
          content: [],
          usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2, ...(reportedCost === undefined ? {} : { cost: reportedCost }) },
      },
      interrupted
        ? { type: "error", error: { type: "overloaded_error", message: "Fixture interrupted" } }
        : { type: "message_stop" },
    ];
    const stream = frames
      .map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
      .join("");
    const event = await runCostCall(
      async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      "https://model.example.test",
      { provider: "anthropic", api: "anthropic-messages" },
    );
    expect(event).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      pricingSnapshot: model.cost,
      costSource: source,
    });
    if (source === null) expect(event.costUsd).toBeNull();
    else expect(event.costUsd).toBeCloseTo(reportedCost ?? 0.000014, 12);
  });

  it.each(["interrupted-json", "sse-error"] as const)(
    "does not trust a generation header against $0 identity evidence",
    async (format) => {
      const conflict = JSON.stringify({
        error: { message: "Fixture", metadata: { generation_id: "gen-current" } },
      });
      let sent = false;
      const body =
        format === "sse-error"
          ? `data: ${conflict}\n\n`
          : new ReadableStream<Uint8Array>({
              pull(controller) {
                if (!sent) {
                  sent = true;
                  controller.enqueue(new TextEncoder().encode(conflict));
                  return;
                }
                controller.error(new Error("Fixture connection reset"));
              },
            });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        new Response(body, {
          status: format === "sse-error" ? 200 : 400,
          headers: {
            "content-type": format === "sse-error" ? "text/event-stream" : "application/json",
            "x-generation-id": "gen-other",
          },
        }),
      );
      expect(await runCostCall(fetch)).toMatchObject({ providerRequestId: null, costUsd: null });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("does not reconcile conflicting generation IDs in the HTTP error header and body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "Fixture", metadata: { generation_id: "gen-current" } } },
          { status: 429, headers: { "x-generation-id": "gen-other" } },
        ),
      );
    expect(await runCostCall(fetch)).toMatchObject({ providerRequestId: null, costUsd: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["", '{"error":{"message":"Fixture"}}'])(
    "keeps an interrupted HTTP error body unknown even with preserved status",
    async (prefix) => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (prefix && !sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode(prefix));
            return;
          }
          controller.error(new Error("Fixture connection reset"));
        },
      });
      const event = await runCostCall(
        async () =>
          new Response(body, {
            status: 400,
            headers: { "content-type": "application/json", "x-request-id": "req-fixture" },
          }),
      );
      expect(event).toMatchObject({
        providerRequestId: "req-fixture",
        costUsd: null,
        costSource: null,
      });
    },
  );

  it("keeps a redirected error unknown through the normal runtime's bounded response", async () => {
    const response = Object.defineProperties(
      Response.json(
        { error: "Fixture" },
        {
          status: 429,
          headers: { "x-generation-id": "gen-other" },
        },
      ),
      {
        url: { value: "https://other.example.test/api/v1/chat/completions" },
        redirected: { value: true },
      },
    );
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response);
    expect(await runCostCall(fetch)).toMatchObject({ providerRequestId: null, costUsd: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a compatible HTTP rejection with explicit generation metadata unknown", async () => {
    const event = await runCostCall(
      async () =>
        Response.json(
          { error: { message: "Fixture", metadata: { generation_id: "gen-assigned" } } },
          { status: 429 },
        ),
      "https://proxy.example.test/api/v1",
    );
    expect(event).toMatchObject({ providerRequestId: "gen-assigned", costUsd: null });
  });

  it("does not reconcile when two generation IDs for one request conflict", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      new Response(sse().replaceAll('"id":"test"', '"id":"gen-current"'), {
        headers: { "content-type": "text/event-stream", "x-generation-id": "gen-other" },
      }),
    );
    expect(await runCostCall(fetch)).toMatchObject({ providerRequestId: null, costUsd: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the exact Anthropic request key for a verified OpenRouter generation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "Fixture" } },
          {
            status: 429,
            headers: { "x-generation-id": "gen-anthropic" },
          },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: { id: "gen-anthropic", is_byok: false, total_cost: 0.25 },
        }),
      );
    const event = await runCostCall(fetch, "https://openrouter.ai/api", {
      api: "anthropic-messages",
    });
    const [initial, request] = fetch.mock.calls[0]!;
    expect(new URL(String(initial)).pathname).toBe("/api/v1/messages");
    const headers = new Headers(request?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBe("fixture-connection-key");
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer fixture-connection-key",
    );
    expect(event).toMatchObject({ providerRequestId: "gen-anthropic", costUsd: 0.25 });
  });

  it("keeps the native SDK response ID without installing a Google fetch override", async () => {
    const models = builtinModels();
    const selected = { ...model, api: "google-generative-ai", provider: "google" };
    vi.spyOn(models, "streamSimple").mockImplementation((_model, _context, options) => {
      expect(options?.fetch).toBeUndefined();
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        api: selected.api,
        provider: selected.provider,
        model: selected.id,
        content: [],
        responseId: "google-response-fixture",
        stopReason: "stop" as const,
        timestamp: 1,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    });
    const recordUsage = vi.fn();
    await observedPiStream(
      models,
      selected,
      { messages: [] },
      undefined,
      vi.fn(),
      undefined,
      undefined,
      { recordUsage },
    ).result();
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRequestId: "google-response-fixture",
        costUsd: null,
      }),
    );
  });

  it.each([
    { status: 429, cost: 0, source: "provider-rejection" },
    { status: 502, cost: null, source: null },
  ])(
    "records a verified refusal but keeps a $status outcome appropriately classified",
    async ({ status, cost, source }) => {
      const event = await runCostCall(async () =>
        Response.json(
          { error: { message: "Fixture" } },
          {
            status,
            headers: { "x-request-id": "req-fixture" },
          },
        ),
      );
      expect(event).toMatchObject({
        providerRequestId: "req-fixture",
        modelCredentialId: "fixture-connection",
        costOwner: "user",
        costUsd: cost,
        costSource: source,
        pricingSnapshot: model.cost,
        inputTokens: null,
        outputTokens: null,
      });
    },
  );

  it("does not convert a lost earlier attempt into zero after a subsequent refusal", async () => {
    const reported = new Set<keyof AgentUsage>();
    const fetch = usageReportingFetch(
      vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValueOnce(new Error("Connection closed"))
        .mockResolvedValueOnce(Response.json({ error: "Fixture" }, { status: 429 })),
      reported,
    );
    await expect(fetch("https://model.example.test")).rejects.toThrow("Connection closed");
    await fetch("https://model.example.test");
    expect(normalizePiUsage(undefined, model, reported)).toMatchObject({
      costUsd: null,
      costSource: null,
      providerRequestId: null,
    });
  });

  it("separates BYOK charges from a directly reported stream and skips the lookup", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      new Response(
        sse({
          prompt_tokens: 2,
          completion_tokens: 1,
          cost: 0,
          is_byok: true,
          cost_details: { upstream_inference_cost: 0.125 },
        }),
        { headers: { "content-type": "text/event-stream", "x-generation-id": "gen-fixture" } },
      ),
    );
    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    try {
      const runtime = new PiAgentRuntime({ modelFetch: fetch });
      const recordUsage = vi.fn();
      for await (const _event of runtime.run(
        {
          botId: "fixture-bot",
          threadId: "fixture-thread",
          runId: "fixture-cost-run",
          prompt: "Test cost",
          instructions: "Fixture",
          history: [],
          tools: [],
          onUsage: recordUsage,
          model: {
            provider: "openai-compatible",
            id: "fixture",
            apiProtocol: "chat-completions",
            apiKey: "fixture-connection-key",
            modelCredentialId: "fixture-connection",
            baseUrl: "https://openrouter.ai/api/v1",
            contextWindow: 4096,
            maxTokens: 256,
          },
        },
        { signal: AbortSignal.timeout(5000) },
      )) {
        // The real compatible transport consumes only injected responses.
      }
      expect(recordUsage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          providerRequestId: "gen-fixture",
          modelCredentialId: "fixture-connection",
          costUsd: 0.125,
          costSource: "provider-reported",
          openRouterFeeUsd: 0,
          upstreamInferenceCostUsd: 0.125,
        }),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });

  it.each(["verified", "other-id", "unavailable", "compatible", "conflicting-byok"] as const)(
    "limits generation lookup and settlement to a verified request (%s)",
    async (result) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          new Response(
            sse({ prompt_tokens: 10, completion_tokens: 2, cost: 0.125, is_byok: true }),
            { headers: { "content-type": "text/event-stream", "x-generation-id": "gen-current" } },
          ),
        )
        .mockResolvedValueOnce(
          result === "unavailable"
            ? new Response(null, { status: 404 })
            : Response.json({
                data: {
                  id: result === "other-id" ? "gen-other" : "gen-current",
                  is_byok: result !== "conflicting-byok",
                  total_cost: 0.125,
                  upstream_inference_cost: 0.25,
                },
              }),
        );
      const event = await runCostCall(
        fetch,
        result === "compatible" ? "https://proxy.example.test/api/v1" : undefined,
      );
      if (result === "compatible") {
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(event.providerRequestId).not.toBe("gen-current");
        expect(event.upstreamInferenceCostUsd).toBeUndefined();
        return;
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      const [url, options] = fetch.mock.calls[1]!;
      expect(url).toBe("https://openrouter.ai/api/v1/generation?id=gen-current");
      expect(options?.redirect).toBe("error");
      expect(new Headers(options?.headers).get("authorization")).toBe(
        new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization"),
      );
      expect(event).toMatchObject({
        providerRequestId: "gen-current",
        costUsd: result === "verified" ? 0.375 : null,
        openRouterFeeUsd: 0.125,
      });
      if (result === "verified")
        expect(event).toMatchObject({
          upstreamInferenceCostUsd: 0.25,
          usageSource: "provider-reconciled",
        });
    },
  );

  it("retains an assigned generation as unknown when a rejection cannot prove it was unused", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: "Fixture" },
          {
            status: 429,
            headers: { "x-generation-id": "gen-assigned" },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const event = await runCostCall(fetch);
    expect(event).toMatchObject({
      providerRequestId: "gen-assigned",
      costUsd: null,
      costSource: null,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled lookup even when the transport ignores cancellation", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
    try {
      const lookup = lookupOpenRouterUsage(
        () => new Promise<Response>(() => {}),
        "gen-fixture",
        "Bearer fixture-key",
      );
      controller.abort();
      await expect(lookup).resolves.toBeNull();
      expect(timeout).toHaveBeenCalledWith(5_000);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("Pi usage accounting", () => {
  it.each([false, true])(
    "acknowledges a producer sink only after successful accounting (fails=%s)",
    async (fails) => {
      const sink = vi.fn(async () => {
        if (fails) throw new Error("Synthetic ledger unavailable");
      });
      const events: AgentRuntimeEvent[] = [];
      const stream = await observedPiStream(
        builtinModels(),
        model,
        { messages: [] },
        {
          apiKey: "fake-fixture-key",
          fetch: async () =>
            new Response(sse({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }), {
              headers: { "content-type": "text/event-stream" },
            }),
        },
        (event) => events.push(event),
        undefined,
        undefined,
        { recordUsage: sink },
      );
      for await (const _event of stream) {
      }
      expect(sink).toHaveBeenCalledOnce();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ inputTokens: 10, outputTokens: 2 });
      expect(events[0]?.type === "usage" ? events[0].accounted : undefined).toBe(
        fails ? undefined : true,
      );
    },
  );
  it.each([
    { kind: "answer", afterUser: false, expected: "retrieval" },
    { kind: "answer", afterUser: true, expected: "answer" },
    { kind: "subagent", afterUser: false, expected: "subagent" },
    { kind: "setup", afterUser: false, expected: "setup" },
  ] as const)(
    "attributes history-result consumption to $expected while preserving $kind precedence",
    async ({ kind, afterUser, expected }) => {
      const messages: Context["messages"] = [
        {
          role: "toolResult",
          toolCallId: "history-call",
          toolName: "search_history",
          content: [{ type: "text", text: "Synthetic history" }],
          isError: false,
          timestamp: 1,
        },
      ];
      if (afterUser) messages.push({ role: "user", content: "New task", timestamp: 2 });
      const events: AgentRuntimeEvent[] = [];
      const stream = await observedPiStream(
        builtinModels(),
        model,
        { messages },
        {
          apiKey: "fake-fixture-key",
          fetch: async () =>
            new Response(sse({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }), {
              headers: { "content-type": "text/event-stream" },
            }),
        },
        (event) => events.push(event),
        undefined,
        { operationKind: kind },
      );
      for await (const _event of stream) {
      }
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ operationKind: expected, totalTokens: 12 });
    },
  );
  it("attributes a model call requesting history to retrieval without duplicating its usage", async () => {
    const reply = `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "history-call", type: "function", function: { name: "read_history", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`;
    const events: AgentRuntimeEvent[] = [];
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      {
        apiKey: "fake-fixture-key",
        fetch: async () =>
          new Response(reply, { headers: { "content-type": "text/event-stream" } }),
      },
      (event) => events.push(event),
    );
    for await (const _event of stream) {
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operationKind: "retrieval", totalTokens: 12 });
  });
  it("accounts a cancelled model call even when the event consumer closes before usage arrives", async () => {
    const onUsage = vi.fn();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Pending" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 10 } } })}\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    try {
      const stream = new PiAgentRuntime().run(
        {
          botId: "bot-fixture",
          threadId: "thread-fixture",
          runId: "run-fixture-cancelled",
          prompt: "Test",
          instructions: "Fixture",
          history: [],
          tools: [],
          onUsage,
          model: {
            provider: "openai-compatible",
            id: "fixture",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
          },
        },
        { signal: AbortSignal.timeout(15000) },
      );
      expect((await stream.next()).value).toMatchObject({ type: "text" });
      await stream.return!();
      expect(onUsage).toHaveBeenCalledOnce();
      expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
        inputTokens: 60,
        outputTokens: 30,
        cacheReadTokens: 40,
        reasoningTokens: 10,
        totalTokens: 130,
        callId: expect.any(String),
      });
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }
  }, 30000);
  it("settles a thrown provider call before exposing the terminal event", async () => {
    let finishSettlement = () => {};
    const settlement = new Promise<void>((resolve) => {
      finishSettlement = resolve;
    });
    const afterCall = vi.fn(async () => settlement);
    const models = {
      streamSimple: () => {
        throw new Error("Synthetic provider exception");
      },
    } as unknown as Parameters<typeof observedPiStream>[0];
    const stream = await observedPiStream(models, model, { messages: [] }, undefined, vi.fn(), {
      beforeCall: () => "reservation",
      afterCall,
    });
    let terminalSeen = false;
    const next = stream[Symbol.asyncIterator]()
      .next()
      .then((event) => {
        terminalSeen = true;
        return event;
      });
    for (let index = 0; index < 4; index++) await Promise.resolve();
    expect(afterCall).toHaveBeenCalledOnce();
    expect(terminalSeen).toBe(false);
    finishSettlement();
    expect((await next).value).toMatchObject({ type: "error" });
    expect(afterCall).toHaveBeenCalledWith("reservation", null);
  });
  it("does not derive an unsafe integer total from valid component counts", () => {
    expect(
      normalizePiUsage(
        {
          input: Number.MAX_SAFE_INTEGER,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: Number.MAX_SAFE_INTEGER + 1,
        },
        model,
        new Set(["cacheReadTokens", "cacheWriteTokens"]),
      ).totalTokens,
    ).toBeNull();
  });
  it("keeps fractional or unsafe token counts unknown", () => {
    expect(
      normalizePiUsage({ input: 1.5, output: Number.MAX_SAFE_INTEGER + 1 }, model),
    ).toMatchObject({ inputTokens: null, outputTokens: null });
  });
  it("disables hidden SDK retries for a guarded model call", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "Synthetic rate limit", type: "rate_limit" } }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );
    const afterCall = vi.fn();
    const events: AgentRuntimeEvent[] = [];
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { apiKey: "fake-fixture-key", fetch: fetcher, maxRetries: 3 },
      (event) => events.push(event),
      { beforeCall: () => "reservation", afterCall },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).stopReason).toBe("error");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(afterCall).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
  });
  it("prepares context before budget reservation and provider execution", async () => {
    const beforeCall = vi.fn((_call: { inputTokensEstimate: number }) => "reservation");
    const onUsage = vi.fn(() => {
      throw new Error("telemetry unavailable");
    });
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      {
        apiKey: "fake-fixture-key",
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { messages: unknown[] };
          expect(JSON.stringify(body.messages)).toContain("x".repeat(10000));
          return new Response(sse({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
      vi.fn(),
      { beforeCall, afterCall: vi.fn() },
      undefined,
      { prepareContext: () => ({ messages: [], systemPrompt: "x".repeat(10000) }), onUsage },
    );
    for await (const _event of stream) {
    }
    expect(beforeCall.mock.calls[0]?.[0]).toMatchObject({
      inputTokensEstimate: expect.any(Number),
    });
    expect(beforeCall.mock.calls[0]?.[0]?.inputTokensEstimate).toBeGreaterThan(3000);
    expect(beforeCall.mock.calls[0]?.[0]?.inputTokensEstimate).toBeLessThan(4000);
    expect(onUsage).toHaveBeenCalledOnce();
    expect((await stream.result()).stopReason).toBe("stop");
  });
  it.each([
    ["prompt", 1],
    ["tools", 1],
    ["none", 1024],
  ] as const)(
    "reserves the actual SDK output cap with legacy %s pressure",
    async (pressure, cap) => {
      const beforeCall = vi.fn((_call: { maxOutputTokens: number }) => "reservation");
      const afterCall = vi.fn();
      const wireCaps: number[] = [];
      const stream = observedPiStream(
        builtinModels(),
        { ...model, reasoning: false, contextWindow: 8192, maxTokens: 1024 },
        { messages: [{ role: "user", content: "Short request", timestamp: 1 }] },
        {
          apiKey: "fake-fixture-key",
          maxTokens: 1024,
          fetch: async (_input, init) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            const caps = ["max_tokens", "max_completion_tokens"]
              .filter((field) => Object.hasOwn(body, field))
              .map((field) => body[field]);
            expect(caps).toEqual([cap]);
            wireCaps.push(caps[0] as number);
            return new Response(sse({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }), {
              headers: { "content-type": "text/event-stream" },
            });
          },
        },
        vi.fn(),
        { beforeCall, afterCall },
        undefined,
        {
          prepareContext: (context) => ({
            ...context,
            systemPrompt:
              pressure === "prompt"
                ? "Required instructions. ".repeat(700)
                : "Required instructions.",
            tools: [
              {
                name: "read_evidence",
                description:
                  pressure === "tools" ? "Read evidence. ".repeat(1100) : "Read evidence",
                parameters: { type: "object", properties: {} },
              },
            ],
          }),
        },
      );
      for await (const _event of stream) {
        /* Real SDK request builder and synthetic provider response. */
      }
      expect((await stream.result()).stopReason).toBe("stop");
      expect(beforeCall).toHaveBeenCalledOnce();
      expect(beforeCall.mock.calls[0]?.[0].maxOutputTokens).toBe(cap);
      expect(afterCall).toHaveBeenCalledOnce();
      expect(wireCaps).toEqual([cap]);
    },
  );
  it("context policy rejection terminates without reserving or spending", async () => {
    const beforeCall = vi.fn((_call: { inputTokensEstimate: number }) => "reservation");
    const fetcher = vi.fn();
    const push = vi.fn();
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { fetch: fetcher },
      push,
      { beforeCall, afterCall: vi.fn() },
      undefined,
      {
        prepareContext: () => {
          throw new Error("context exceeds budget");
        },
      },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).errorMessage).toBe("context exceeds budget");
    expect(beforeCall).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
  it("does not count an already-aborted next turn as a model call", async () => {
    const beforeCall = vi.fn();
    const afterCall = vi.fn();
    const prepareContext = vi.fn();
    const recordUsage = vi.fn();
    const fetcher = vi.fn();
    const push = vi.fn();
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { signal: AbortSignal.abort(new Error("synthetic tool stop")), fetch: fetcher },
      push,
      { beforeCall, afterCall },
      undefined,
      { prepareContext, recordUsage },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).errorMessage).toBe("synthetic tool stop");
    for (const callback of [beforeCall, afterCall, prepareContext, recordUsage, fetcher, push])
      expect(callback).not.toHaveBeenCalled();
  });
  it("retains reported zero through the full generic runtime and its safe network adapter", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse({
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    try {
      const events: AgentRuntimeEvent[] = [];
      for await (const event of new PiAgentRuntime().run(
        {
          botId: "bot-fixture",
          threadId: "thread-fixture",
          runId: "run-fixture",
          prompt: "test",
          instructions: "fixture",
          history: [],
          tools: [],
          model: {
            provider: "openai-compatible",
            id: "fixture",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
          },
        },
        { signal: AbortSignal.timeout(5000) },
      ))
        events.push(event);
      expect(events.find((event) => event.type === "usage")).toMatchObject({
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
  it("keeps network protections when composing raw-usage observation", async () => {
    const fetcher = vi.fn();
    const safe = createOpenAiCompatibleFetch(usageReportingFetch(fetcher, new Set()));
    await expect(safe("http://169.254.169.254/v1/chat/completions")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves real endpoint cache and reasoning breakdown without double counting", async () => {
    const { events, afterCall, result } = await run({
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe("stop");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "usage",
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: null,
      reasoningTokens: 10,
      totalTokens: 130,
      costSource: "pi-catalog-estimate",
    });
    expect(afterCall).toHaveBeenCalledOnce();
  });
  it("distinguishes explicit reported zero from omitted provider measurements", async () => {
    const reported = await run({
      prompt_tokens: 10,
      completion_tokens: 0,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    expect(reported.events[0]).toMatchObject({
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    });
    const omitted = await run();
    expect(omitted.events[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      costUsd: null,
    });
  });
  it.each(["prompt_cache_hit_tokens", "cached_tokens"])(
    "recognizes cache-read alias %s with fully cached input",
    async (alias) => {
      const { events } = await run({
        prompt_tokens: 40,
        completion_tokens: 2,
        total_tokens: 42,
        [alias]: 40,
      });
      expect(events[0]).toMatchObject({ inputTokens: 0, cacheReadTokens: 40 });
    },
  );
  it("recognizes all-cache-write input and explicit zero read usage", async () => {
    const { events } = await run({
      prompt_tokens: 40,
      completion_tokens: 2,
      total_tokens: 42,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 40 },
    });
    expect(events[0]).toMatchObject({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 40 });
  });
  it("preserves zero uncached input when all reported prompt tokens are cached", async () => {
    const { events } = await run({
      prompt_tokens: 40,
      completion_tokens: 2,
      total_tokens: 42,
      prompt_tokens_details: { cached_tokens: 40 },
    });
    expect(events[0]).toMatchObject({ inputTokens: 0, cacheReadTokens: 40 });
  });
  it("preserves provider reported dollar cost even when pricing or cache-write usage is unavailable", async () => {
    const { events } = await run({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      cost: 0.00003,
    });
    expect(events[0]).toMatchObject({
      costUsd: 0.00003,
      costSource: "provider-reported",
      pricingVersion: null,
      cacheWriteTokens: null,
    });
  });
  it("keeps compatible zero pricing unknown", () => {
    expect(
      normalizePiUsage(
        {
          input: 10,
          output: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ).costUsd,
    ).toBeNull();
  });
  it.each([
    { input: 7, cost: 0.000011 },
    { input: 8, cost: 0.000035 },
    { input: 27, cost: 0.000092 },
    { input: 28, cost: 0.000158 },
  ])("retains Pi's tiered estimate for $input uncached tokens", ({ input, cost }) => {
    const tieredModel: Model<Api> = {
      ...model,
      cost: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        tiers: [
          { inputTokensAbove: 30, input: 5, output: 6, cacheRead: 2, cacheWrite: 0 },
          { inputTokensAbove: 10, input: 3, output: 4, cacheRead: 1, cacheWrite: 0 },
        ],
      },
    };
    const usage: Usage = {
      input,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
      totalTokens: input + 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(tieredModel, usage);
    const normalized = normalizePiUsage(usage, tieredModel, new Set(["cacheWriteTokens"]));
    expect(normalized.costUsd).toBe(usage.cost.total);
    expect(normalized.costUsd).toBeCloseTo(cost, 12);
    expect(normalized).toMatchObject({
      costSource: "pi-catalog-estimate",
      pricingVersion: "pi-ai-1.3.0",
    });
  });
  it("recognizes a priced tier above a zero-priced base", () => {
    expect(
      normalizePiUsage(
        {
          input: 11,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.000033, output: 0.000008, cacheRead: 0, cacheWrite: 0, total: 0.000041 },
        },
        {
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            tiers: [{ inputTokensAbove: 10, input: 3, output: 4, cacheRead: 1, cacheWrite: 1 }],
          },
        },
        new Set(["cacheReadTokens", "cacheWriteTokens"]),
      ),
    ).toMatchObject({ costUsd: 0.000041, costSource: "pi-catalog-estimate" });
  });
  it.each(["cacheReadTokens", "cacheWriteTokens"] as const)(
    "keeps a tier estimate unknown without measured %s",
    (missing) => {
      expect(
        normalizePiUsage(
          {
            input: 9,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            cost: {
              input: 0.000009,
              output: 0.000004,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.000013,
            },
          },
          {
            cost: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              tiers: [{ inputTokensAbove: 10, input: 3, output: 4, cacheRead: 1, cacheWrite: 1 }],
            },
          },
          new Set([missing === "cacheReadTokens" ? "cacheWriteTokens" : "cacheReadTokens"]),
        ),
      ).toMatchObject({ costUsd: null, costSource: null, pricingVersion: null });
    },
  );
  it("keeps a tier estimate unknown when the input sum is unsafe", () => {
    expect(
      normalizePiUsage(
        {
          input: Number.MAX_SAFE_INTEGER,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
        },
        {
          cost: {
            ...model.cost,
            tiers: [{ inputTokensAbove: 10, input: 3, output: 4, cacheRead: 1, cacheWrite: 1 }],
          },
        },
        new Set(["cacheWriteTokens"]),
      ),
    ).toMatchObject({ costUsd: null, costSource: null, pricingVersion: null });
  });
  it("preserves provider-reported zero cost when a tier cannot be selected", async () => {
    const { events } = await run(
      { prompt_tokens: 9, completion_tokens: 2, cost: 0 },
      {
        ...model,
        cost: {
          ...model.cost,
          tiers: [{ inputTokensAbove: 10, input: 3, output: 4, cacheRead: 1, cacheWrite: 1 }],
        },
      },
    );
    expect(events[0]).toMatchObject({
      costUsd: 0,
      costSource: "provider-reported",
      pricingVersion: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });
  it("does not start model work when budget reservation fails", async () => {
    const fetcher = vi.fn();
    const push = vi.fn();
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { fetch: fetcher },
      push,
      {
        beforeCall: () => {
          throw new Error("budget exhausted");
        },
        afterCall: vi.fn(),
      },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).errorMessage).toBe("budget exhausted");
    expect(push).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("retains bytes and observes fragmented CRLF SSE with explicit zeros", async () => {
    const bytes = new TextEncoder().encode('data: {"usage":{"prompt_tokens":0}}\r\n\r\n');
    const reported = new Set<"inputTokens">();
    const fetcher = usageReportingFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      reported,
    );
    const response = await fetcher("https://model.example.test");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(reported.has("inputTokens")).toBe(true);
  });
});

describe("Pi corrective request dispatch budget", () => {
  it.each([400, 1_000])(
    "deducts %dms of synchronous context work without an observer",
    async (elapsed) => {
      let now = 10_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const realModels = builtinModels();
      const streamSimple = vi.fn(realModels.streamSimple.bind(realModels));
      const models = { ...realModels, streamSimple } as typeof realModels;
      const fetcher = vi.fn(
        async () => new Response(sse(), { headers: { "content-type": "text/event-stream" } }),
      );
      const push = vi.fn();
      const onRequestDeadlineExceeded = vi.fn();
      const onProviderError = vi.fn();
      try {
        const result = observedPiStream(
          models,
          model,
          { messages: [] },
          { apiKey: "fixture", fetch: fetcher, timeoutMs: 1_000 },
          push,
          undefined,
          undefined,
          {
            requestDeadline: 11_000,
            prepareContext: (context) => {
              now += elapsed;
              return context;
            },
            onRequestDeadlineExceeded,
            onProviderError,
          },
        );
        for await (const _event of result) {
        }
        if (elapsed === 1_000) {
          expect(streamSimple).not.toHaveBeenCalled();
          expect(fetcher).not.toHaveBeenCalled();
          expect(push).not.toHaveBeenCalled();
          expect(onRequestDeadlineExceeded).toHaveBeenCalledOnce();
        } else {
          expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 600 });
          expect(streamSimple.mock.calls[0]?.[2]).not.toHaveProperty("requestDeadline");
          expect(fetcher).toHaveBeenCalledOnce();
          expect(onRequestDeadlineExceeded).not.toHaveBeenCalled();
        }
        expect(onProviderError).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(["context", "reservation"])(
    "does not classify a local %s rejection by its deadline-like text",
    async (phase) => {
      const localError = new Error("Model request deadline expired before dispatch");
      const fetcher = vi.fn();
      const onRequestDeadlineExceeded = vi.fn();
      const onProviderError = vi.fn();
      const afterCall = vi.fn();
      const beforeCall = vi.fn(async () => {
        if (phase === "reservation") throw localError;
        return "reservation";
      });
      const result = observedPiStream(
        builtinModels(),
        model,
        { messages: [] },
        { fetch: fetcher },
        vi.fn(),
        { beforeCall, afterCall },
        undefined,
        {
          requestDeadline: Date.now() - 1,
          prepareContext: (context) => {
            if (phase === "context") throw localError;
            return context;
          },
          onRequestDeadlineExceeded,
          onProviderError,
        },
      );
      for await (const _event of result) {
      }
      expect((await result.result()).errorMessage).toBe(localError.message);
      expect(fetcher).not.toHaveBeenCalled();
      expect(afterCall).not.toHaveBeenCalled();
      expect(onRequestDeadlineExceeded).not.toHaveBeenCalled();
      expect(onProviderError).not.toHaveBeenCalled();
    },
  );

  it("settles an expired reservation before exposing its local deadline termination", async () => {
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const afterCall = vi.fn(() => settlement);
    const fetcher = vi.fn();
    const push = vi.fn();
    const onRequestDeadlineExceeded = vi.fn();
    const onProviderError = vi.fn();
    const result = observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { fetch: fetcher },
      push,
      { beforeCall: async () => "reservation", afterCall },
      undefined,
      { requestDeadline: Date.now() - 1, onRequestDeadlineExceeded, onProviderError },
    );
    let terminated = false;
    const terminal = result.result().then((message) => {
      terminated = true;
      return message;
    });
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(afterCall).toHaveBeenCalledOnce();
    expect(afterCall).toHaveBeenCalledWith("reservation", null);
    expect(terminated).toBe(false);
    expect(onRequestDeadlineExceeded).not.toHaveBeenCalled();
    settle();
    expect((await terminal).errorMessage).toContain("deadline expired");
    expect(onRequestDeadlineExceeded).toHaveBeenCalledOnce();
    expect(onProviderError).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
