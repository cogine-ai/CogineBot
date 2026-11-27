import { afterEach, describe, expect, it, vi } from "vitest";
import { probeModelInference } from "./model-inference-probe.js";
import { listPiCatalog } from "./pi-models.js";

const model = listPiCatalog().find((entry) => entry.provider === "openai" && entry.inferenceProbe)!;
const input = { provider: model.provider, modelId: model.id, apiKey: "fixture-inference-key" };
const openRouterModel = listPiCatalog().find(
  (entry) => entry.provider === "openrouter" && entry.id === "openai/gpt-oss-120b",
)!;
const openRouterInput = {
  provider: openRouterModel.provider,
  modelId: openRouterModel.id,
  apiKey: "fixture-gateway-key",
};
const openRouterMessagesInput = { ...openRouterInput, modelId: "anthropic/claude-sonnet-4.6" };
const groqInput = { provider: "groq", modelId: "openai/gpt-oss-120b", apiKey: "fixture-groq-key" };
const togetherInput = {
  provider: "together",
  modelId: "openai/gpt-oss-120b",
  apiKey: "fixture-together-key",
};
const groqDirectoryInput = {
  ...groqInput,
  modelId: "fixture-vendor/chat-new",
  providerCatalogModel: true,
} as const;
const deepseekInput = {
  provider: "deepseek",
  modelId: "deepseek-flash",
  apiKey: "fixture-deepseek-key",
};
const geminiInput = {
  provider: "google",
  modelId: "gemini-3.8-flash",
  apiKey: "fixture-gemini-key",
};
const geminiEndpoint =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse";
const xaiInput = { provider: "xai", modelId: "grok-4.7", apiKey: "fixture-grok-key" };
const xaiApiModels = listPiCatalog().filter((entry) => entry.provider === "xai");
const anthropicInput = {
  provider: "anthropic",
  modelId: "claude-haiku-5-5",
  apiKey: "fixture-claude-key",
};
const anthropicStart =
  'event: message_start\ndata: {"type":"message_start","message":{"type":"message","id":"msg-fixture","role":"assistant","model":"claude-haiku-5-5"}}\n\n';

function chatChunk(choices: unknown[], extra: Record<string, unknown> = {}) {
  return `data: ${JSON.stringify({ id: "gen-fixture", object: "chat.completion.chunk", choices, ...extra })}\n\n`;
}

function geminiCandidate(content: unknown, finishReason?: string) {
  return { candidates: [{ content, finishReason }] };
}

function geminiSse(...frames: unknown[]) {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function xaiStarted(modelId: string) {
  const response = { id: "resp-fixture", status: "in_progress", model: modelId, error: null };
  return `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response })}\n\n`;
}

describe("model inference check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("checks a Together model on the pinned endpoint without deployment headers", async () => {
    vi.stubEnv("TOGETHER_API_KEY", "fixture-deployed-provider-key");
    vi.stubEnv("OPENAI_CUSTOM_HEADERS", "X-Gateway-Token: fixture-ambient-header");
    const entry = listPiCatalog().find(
      (model) => model.provider === togetherInput.provider && model.id === togetherInput.modelId,
    );
    expect(entry?.inferenceProbe).toBe(true);
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  chatChunk([{ delta: { role: "assistant", content: "" } }], {
                    model: togetherInput.modelId,
                  }) +
                    chatChunk([{ delta: { content: "OK" }, finish_reason: "eos" }], {
                      model: togetherInput.modelId,
                    }),
                ),
              );
            },
            cancel,
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await expect(probeModelInference(togetherInput, { fetch })).resolves.toBe("accepted");
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    const request = new Request(...fetch.mock.calls[0]!);
    expect(request.url).toBe("https://api.together.ai/v1/chat/completions");
    expect(request.redirect).toBe("error");
    expect(Object.fromEntries(request.headers)).toEqual({
      authorization: `Bearer ${togetherInput.apiKey}`,
      "content-type": "application/json",
    });
    expect(await request.json()).toEqual({
      model: togetherInput.modelId,
      messages: [
        { role: "system", content: "Reply with OK." },
        { role: "user", content: "OK?" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "noop",
            description: "Does nothing.",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      max_tokens: 1024,
      stream: true,
    });
  });

  it.each([
    [401, "auth"],
    [402, "credit"],
    [403, "model"],
    [404, "model"],
    [429, "rate"],
    [504, "timeout"],
    [524, "timeout"],
    [503, "unavailable"],
    [529, "unavailable"],
    [400, "unavailable"],
  ] as const)("classifies Together HTTP %i as %s", async (status, expected) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { message: "Request failed", code: null } }, { status }),
    );
    expect(await probeModelInference(togetherInput, { fetch })).toBe(expected);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [chatChunk([{ delta: { content: "OK" } }], { model: "fixture/other-model" }), "unavailable"],
    [
      chatChunk([{ delta: { role: "assistant" } }], { model: "fixture/other-model" }) +
        chatChunk([{ delta: { content: "OK" } }]),
      "unavailable",
    ],
    [chatChunk([{ delta: { content: "OK" } }]), "accepted"],
    [
      chatChunk([{ delta: { role: "assistant" } }], { model: togetherInput.modelId }),
      "unavailable",
    ],
    [
      chatChunk([{ delta: { role: "assistant" } }], { model: togetherInput.modelId }) +
        'event: error\ndata: {"error":{"code":"402","message":"Request failed"}}\n\n',
      "credit",
    ],
    [
      chatChunk([{ delta: { tool_calls: [{ type: "function", function: { name: "noop" } }] } }], {
        model: togetherInput.modelId,
      }),
      "accepted",
    ],
  ] as const)(
    "checks the Together stream acceptance and refusal boundary (%#)",
    async (body, expected) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      );
      expect(await probeModelInference(togetherInput, { fetch })).toBe(expected);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("does not test a Together model outside the built-in catalog", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      probeModelInference(
        { ...togetherInput, modelId: "fixture/unknown-model", providerCatalogModel: true },
        { fetch },
      ),
    ).resolves.toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the selected Gemini model with the draft key and closes the stream on output", async () => {
    vi.stubEnv("GEMINI_API_KEY", "fixture-deployment-key");
    const selected = listPiCatalog().find(
      (entry) => entry.provider === geminiInput.provider && entry.id === geminiInput.modelId,
    );
    expect(selected?.inferenceProbe).toBe(true);
    expect(selected?.catalogProbe).toBe(true);
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const frames = [
        geminiCandidate({ role: "model", parts: [{ text: "" }] }),
        geminiCandidate({ role: "model", parts: [{ functionCall: { name: "noop", args: {} } }] }),
      ];
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const frame of frames)
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    expect(await probeModelInference(geminiInput, { fetch })).toBe("accepted");
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    const request = new Request(...fetch.mock.calls[0]!);
    expect(request.url).toBe(geminiEndpoint);
    expect(request.redirect).toBe("error");
    expect(request.headers.get("x-goog-api-key")).toBe(geminiInput.apiKey);
    expect(request.headers.has("authorization")).toBe(false);
    expect(await request.json()).toEqual({
      systemInstruction: { parts: [{ text: "Reply with OK." }] },
      contents: [{ role: "user", parts: [{ text: "OK?" }] }],
      tools: [{ functionDeclarations: [{ name: "noop", description: "Does nothing." }] }],
      generationConfig: { maxOutputTokens: 1024 },
    });
  });

  it("only tests a dynamic Gemini model with a confirmed directory route", async () => {
    const target = { ...geminiInput, modelId: "gemini-fixture-directory-model" };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      geminiSse(geminiCandidate({ role: "model", parts: [{ text: "OK" }] }, "STOP")),
    );
    await expect(probeModelInference(target, { fetch })).resolves.toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      probeModelInference({ ...target, providerCatalogModel: true }, { fetch }),
    ).resolves.toBe("accepted");
    expect(fetch).toHaveBeenCalledOnce();
    const request = new Request(...fetch.mock.calls[0]!);
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture-directory-model:streamGenerateContent?alt=sse",
    );
    expect(request.headers.get("x-goog-api-key")).toBe(target.apiKey);
    expect(await request.json()).toMatchObject({ generationConfig: { maxOutputTokens: 1024 } });
  });

  it.each([
    [geminiCandidate({ parts: [{ text: "OK" }] }, "STOP"), "accepted"],
    [geminiCandidate({ role: "model", parts: [] }, "STOP"), "unavailable"],
    [geminiCandidate({ role: "user", parts: [{ text: "OK" }] }, "STOP"), "unavailable"],
    [geminiCandidate({ parts: [{ functionCall: { name: "other" } }] }, "STOP"), "unavailable"],
    [geminiCandidate({ parts: [{ text: "OK" }] }, "SAFETY"), "unavailable"],
    [{ promptFeedback: { blockReason: "SAFETY" } }, "unavailable"],
    [{ error: { code: 402, status: "RESOURCE_EXHAUSTED" } }, "credit"],
  ])("requires real Gemini output or a definitive error in %j", async (frame, outcome) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => geminiSse(frame));
    expect(await probeModelInference(geminiInput, { fetch })).toBe(outcome);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [
      400,
      {
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
        ],
      },
      "auth",
    ],
    [
      403,
      {
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "API_KEY_SERVICE_BLOCKED",
          },
        ],
      },
      "auth",
    ],
    [
      403,
      {
        status: "PERMISSION_DENIED",
        message: "Your API key was reported as leaked. Please use another API key.",
      },
      "auth",
    ],
    [403, { message: "Permission denied for this model" }, "model"],
    [404, { message: "Model not found" }, "model"],
    [402, { status: "RESOURCE_EXHAUSTED" }, "credit"],
    [
      429,
      {
        status: "RESOURCE_EXHAUSTED",
        message: "You exceeded your current quota, check your plan and billing",
      },
      "rate",
    ],
    [
      429,
      { status: "RESOURCE_EXHAUSTED", message: "You have exceeded your monthly spend cap." },
      "spending",
    ],
    [
      429,
      {
        status: "RESOURCE_EXHAUSTED",
        message: "Your billing account has exceeded its monthly spending cap.",
      },
      "spending",
    ],
    [503, { code: 402, message: "Credits depleted" }, "unavailable"],
    [504, {}, "timeout"],
  ] as const)(
    "classifies Gemini HTTP %i without leaking its error",
    async (status, error, outcome) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ error, request: geminiInput.apiKey }, { status }),
      );
      expect(await probeModelInference(geminiInput, { fetch })).toBe(outcome);
    },
  );

  it.each([
    "gemini-fixture-unregistered",
    "gemini-3.1-flash-live-preview",
    "gemini-3.1-flash-lite-image",
    "gemini-3.1-pro-preview-customtools",
    "gemini-2.5-computer-use-preview-10-2025",
    "deep-research-preview-04-2026",
    "gemma-4-31b-it",
  ])("does not offer or run this Gemini chat check for %s", async (modelId) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(
      listPiCatalog().find((entry) => entry.provider === "google" && entry.id === modelId)
        ?.inferenceProbe,
    ).toBeUndefined();
    expect(await probeModelInference({ ...geminiInput, modelId }, { fetch })).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["deadline", "caller"] as const)(
    "stops reading Gemini output when %s aborts",
    async (source) => {
      const caller = new AbortController();
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
      const cancel = vi.fn();
      let startedReading = () => {};
      const reading = new Promise<void>((resolve) => {
        startedReading = resolve;
      });
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(
            new ReadableStream(
              {
                pull() {
                  startedReading();
                },
                cancel,
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const pending = probeModelInference(geminiInput, { fetch, signal: caller.signal });
      const verified =
        source === "caller"
          ? expect(pending).rejects.toMatchObject({ name: "AbortError" })
          : expect(pending).resolves.toBe("timeout");
      await reading;
      (source === "caller" ? caller : deadline).abort();
      await verified;
      expect(timeout).toHaveBeenCalledWith(15000);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [geminiInput, 401, "auth"],
    [geminiInput, 402, "credit"],
    [geminiInput, 404, "model"],
    [geminiInput, 429, "timeout"],
    [geminiInput, 503, "timeout"],
    [input, 401, "auth"],
    [input, 402, "credit"],
    [openRouterInput, 402, "timeout"],
    [deepseekInput, 403, "model"],
    [deepseekInput, 429, "timeout"],
    [geminiInput, 401, "caller abort"],
    [input, 401, "caller abort"],
  ] as const)(
    "classifies a stalled error body from %j (%i) as %s",
    async (target, status, outcome) => {
      const deadline = new AbortController();
      const caller = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
      let startedReading = () => {};
      const reading = new Promise<void>((resolve) => {
        startedReading = resolve;
      });
      const cancel = vi.fn();
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(new ReadableStream({ pull: startedReading, cancel }, { highWaterMark: 0 }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      );
      const pending = probeModelInference(target, { fetch, signal: caller.signal });
      const verified =
        outcome === "caller abort"
          ? expect(pending).rejects.toMatchObject({ name: "AbortError" })
          : expect(pending).resolves.toBe(outcome);
      await reading;
      (outcome === "caller abort" ? caller : deadline).abort();
      await verified;
      expect(fetch).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each(["deepseek-flash", "deepseek-v4-pro"])(
    "probes the registered DeepSeek model %s",
    async (modelId) => {
      vi.stubEnv("DEEPSEEK_API_KEY", "fixture-deployment-key");
      const entry = listPiCatalog().find(
        (model) => model.provider === "deepseek" && model.id === modelId,
      );
      expect(entry).toMatchObject({ inferenceProbe: true, catalogProbe: true });
      const cancel = vi.fn();
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                const header = chatChunk(
                  [{ index: 0, delta: { role: "assistant", content: "" } }],
                  { model: modelId },
                );
                const delta = chatChunk([{ index: 0, delta: { reasoning_content: "Thinking" } }], {
                  model: modelId,
                });
                for (const frame of [": keep-alive\n\n", header, delta])
                  controller.enqueue(new TextEncoder().encode(frame));
              },
              cancel,
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      expect(await probeModelInference({ ...deepseekInput, modelId }, { fetch })).toBe("accepted");
      expect(fetch).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      const request = new Request(...fetch.mock.calls[0]!);
      expect(request.url).toBe("https://api.deepseek.com/chat/completions");
      expect(request.headers.get("authorization")).toBe(`Bearer ${deepseekInput.apiKey}`);
      expect(request.redirect).toBe("error");
      const body = await request.json();
      expect(body).toMatchObject({
        model: modelId,
        stream: true,
        tools: [
          expect.objectContaining({
            type: "function",
            function: expect.objectContaining({ name: "noop" }),
          }),
        ],
      });
      expect(body.max_tokens).toBeGreaterThan(0);
      expect(body.max_tokens).toBeLessThanOrEqual(1024);
      expect(body).not.toHaveProperty("max_completion_tokens");
    },
  );

  it.each([
    [401, "Wrong API key", "auth"],
    [402, "Insufficient Balance", "credit"],
    [404, "Model not found", "model"],
    [429, "Concurrency limit exceeded", "rate"],
    [503, "Insufficient Balance", "unavailable"],
    [504, "Gateway timeout", "timeout"],
  ] as const)("classifies DeepSeek HTTP %i without retrying", async (status, message, expected) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { message } }, { status }),
    );
    expect(await probeModelInference(deepseekInput, { fetch })).toBe(expected);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [chatChunk([]), "unavailable"],
    [chatChunk([{ delta: { role: "assistant", content: "" } }]), "unavailable"],
    [chatChunk([{ delta: { tool_calls: [{}] } }]), "unavailable"],
    [
      chatChunk([{ delta: { tool_calls: [{ type: "function", function: { name: "noop" } }] } }]),
      "accepted",
    ],
    [
      chatChunk([{ delta: { content: "OK" }, finish_reason: "insufficient_system_resource" }]),
      "unavailable",
    ],
    [chatChunk([], { error: { message: "Insufficient Balance" } }), "credit"],
    [
      chatChunk([], { status: "503", error: { code: "402", message: "Insufficient Balance" } }),
      "unavailable",
    ],
  ] as const)("reads DeepSeek model output and terminal errors (%s)", async (suffix, expected) => {
    const preface = chatChunk([{ delta: { role: "assistant", content: "" } }]);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(preface + suffix, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    expect(await probeModelInference(deepseekInput, { fetch })).toBe(expected);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends a confirmed DeepSeek directory model on the official route with thinking off", async () => {
    const modelId = "deepseek-fixture-verified";
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(chatChunk([{ delta: { content: "OK" } }]), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    expect(
      await probeModelInference(
        { ...deepseekInput, modelId, providerCatalogModel: true },
        { fetch },
      ),
    ).toBe("accepted");
    expect(fetch).toHaveBeenCalledOnce();
    const request = new Request(...fetch.mock.calls[0]!);
    expect(request.url).toBe("https://api.deepseek.com/chat/completions");
    expect(request.headers.get("authorization")).toBe(`Bearer ${deepseekInput.apiKey}`);
    expect(request.redirect).toBe("error");
    expect(await request.json()).toMatchObject({
      model: modelId,
      stream: true,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      tools: [expect.objectContaining({ function: expect.objectContaining({ name: "noop" }) })],
    });
  });

  it("does not probe unconfirmed DeepSeek or similarly named gateway models", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(
      await probeModelInference(
        { ...deepseekInput, modelId: "deepseek-fixture-unlisted" },
        { fetch },
      ),
    ).toBe("unavailable");
    for (const modelId of [
      "deepseek-fixture-voice",
      "deepseek/deepseek-v4-pro",
      openRouterInput.modelId,
    ]) {
      expect(
        await probeModelInference(
          { ...deepseekInput, modelId, providerCatalogModel: true },
          { fetch },
        ),
      ).toBe("unavailable");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    input,
    { ...input, modelId: "gpt-fixture-discovered", providerCatalogModel: true as const },
  ])("sends one bounded tool request for $modelId and aborts on acceptance", async (input) => {
    vi.stubEnv("OPENAI_ORG_ID", "org-fixture");
    vi.stubEnv("OPENAI_PROJECT_ID", "project-fixture");
    const fetch = vi.fn<typeof globalThis.fetch>(async (_request, init) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.created","response":{"id":"fixture"}}\n\n',
            ),
          );
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    expect(await probeModelInference(input, { fetch })).toBe("accepted");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    const request = new Request(url, init);
    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers.get("authorization")).toBe(`Bearer ${input.apiKey}`);
    expect(request.headers.has("openai-organization")).toBe(false);
    expect(request.headers.has("openai-project")).toBe(false);
    expect(request.redirect).toBe("error");
    expect(init?.signal?.aborted).toBe(true);
    expect(await request.json()).toMatchObject({
      model: input.modelId,
      stream: true,
      max_output_tokens: expect.any(Number),
      tools: [expect.objectContaining({ name: "noop" })],
    });
    expect(JSON.parse(String(init?.body)).max_output_tokens).toBeLessThanOrEqual(1024);
  });

  it("advertises the registered Grok chat models without enabling live model guessing", () => {
    expect(xaiApiModels.map((entry) => entry.id)).toContain(xaiInput.modelId);
    expect(xaiApiModels.every((entry) => entry.inferenceProbe && entry.catalogProbe)).toBe(true);
  });

  const xaiProbeTargets = [
    ...xaiApiModels.map(({ id }) => ({ id, confirmed: false })),
    { id: "grok-fixture-catalog-model", confirmed: true },
  ];
  it.each(xaiProbeTargets)(
    "sends one bounded Responses request with the selected $id key",
    async ({ id, confirmed }) => {
      vi.stubEnv("XAI_API_KEY", "fixture-deployment-key");
      vi.stubEnv("OPENAI_ORG_ID", "fixture-openai-organization");
      vi.stubEnv("OPENAI_PROJECT_ID", "fixture-openai-project");
      const cancel = vi.fn();
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                const delta = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\n';
                controller.enqueue(
                  new TextEncoder().encode(`: warming up\n\n${xaiStarted(id)}${delta}`),
                );
              },
              cancel,
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      expect(
        await probeModelInference(
          { ...xaiInput, modelId: id, ...(confirmed && { providerCatalogModel: true }) },
          { fetch },
        ),
      ).toBe("accepted");
      expect(fetch).toHaveBeenCalledOnce();
      const request = new Request(...fetch.mock.calls[0]!);
      expect(request.url).toBe("https://api.x.ai/v1/responses");
      expect(request.headers.get("authorization")).toBe(`Bearer ${xaiInput.apiKey}`);
      expect(request.headers.has("openai-organization")).toBe(false);
      expect(request.headers.has("openai-project")).toBe(false);
      expect(request.redirect).toBe("error");
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      const payload = await request.json();
      expect(payload).toMatchObject({
        model: id,
        store: false,
        stream: true,
        tools: [expect.objectContaining({ type: "function", name: "noop" })],
      });
      expect(payload.max_output_tokens).toBeGreaterThan(0);
      expect(payload.max_output_tokens).toBeLessThanOrEqual(1024);
    },
  );

  it.each([
    [400, { error: "Invalid API key" }, "auth"],
    [400, { error: "Invalid request parameter" }, "unavailable"],
    [401, { error: "Unauthorized" }, "auth"],
    [402, { error: "Payment required" }, "credit"],
    [
      403,
      {
        code: "Forbidden",
        error: "Your newly created team doesn't have any credits or licenses yet.",
      },
      "credit",
    ],
    [403, { error: { code: "permission_denied" } }, "model"],
    [403, { error: "The team has reached its spending limit." }, "spending"],
    [404, { error: "Model does not exist" }, "model"],
    [429, { error: "Too many requests" }, "rate"],
    [
      503,
      { error: "Your newly created team doesn't have any credits or licenses yet." },
      "unavailable",
    ],
    [504, { error: "Gateway timeout" }, "timeout"],
  ] as const)("classifies Grok HTTP %i with %j", async (status, body, outcome) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status }));
    expect(await probeModelInference(xaiInput, { fetch })).toBe(outcome);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [": ping\n\n", "unavailable"],
    [xaiStarted(xaiInput.modelId), "unavailable"],
    [`${xaiStarted(xaiInput.modelId)}data: {"type":"response.in_progress"}\n\n`, "unavailable"],
    [
      `${xaiStarted(xaiInput.modelId)}data: {"type":"error","code":529,"message":"Overloaded"}\n\n`,
      "unavailable",
    ],
    ['data: {"type":"response.output_text.delta","delta":""}\n\n', "unavailable"],
    [
      'data: {"type":"response.created","response":{"id":"resp-fixture","status":"failed"}}\n\n',
      "unavailable",
    ],
    [
      'data: {"type":"response.created","response":{"id":"resp-fixture","status":"cancelled"}}\n\n',
      "unavailable",
    ],
    [
      'data: {"type":"response.failed","response":{"error":{"code":"model_not_found"}}}\n\n',
      "model",
    ],
    [
      'event: error\ndata: {"type":"error","error":"Your newly created team doesn\'t have any credits or licenses yet."}\n\n',
      "credit",
    ],
    ['data: {"type":"error","code":"rate_limit_exceeded"}\n\n', "rate"],
  ] as const)(
    "does not accept a Grok stream without a valid acceptance frame (%s)",
    async (body, outcome) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      expect(await probeModelInference(xaiInput, { fetch })).toBe(outcome);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [{ code: 402, message: "No credit remains" }, "credit"],
    [{ status: 402, error: { message: "Payment required" } }, "credit"],
    [{ status: "402", error: { message: "Payment required" } }, "credit"],
    [{ status: 401, error: { message: "Unauthorized" } }, "auth"],
    [{ status: 403, error: { message: "Permission denied" } }, "model"],
    [{ code: "403", message: "Permission denied" }, "model"],
    [{ code: 404, message: "Not found" }, "model"],
    [{ status: 429, error: { message: "Please retry later" } }, "rate"],
    [{ error: { code: 504, message: "Gateway timeout" } }, "timeout"],
    [{ status: 503, error: { code: 402, message: "Team spending limit exceeded" } }, "unavailable"],
    [
      { status: "503", error: { code: "402", message: "Team spending limit exceeded" } },
      "unavailable",
    ],
  ] as const)("preserves Grok stream status in %j", async (error, outcome) => {
    const body = `${xaiStarted(xaiInput.modelId)}event: error\ndata: ${JSON.stringify({ type: "error", ...error })}\n\n`;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    expect(await probeModelInference(xaiInput, { fetch })).toBe(outcome);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { type: "response.reasoning_summary_text.delta", delta: "Thinking" },
    { type: "response.function_call_arguments.delta", delta: "{}" },
    { type: "response.completed", response: { status: "completed", id: "resp-fixture" } },
  ])("accepts Grok model progress from $type", async (event) => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(`${xaiStarted(xaiInput.modelId)}data: ${JSON.stringify(event)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    expect(await probeModelInference(xaiInput, { fetch })).toBe("accepted");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("recognizes the provider's SSE event name without requiring it in the JSON payload", async () => {
    const body = 'event: response.output_text.delta\ndata: {"delta":"OK"}\n\n';
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    expect(await probeModelInference(xaiInput, { fetch })).toBe("accepted");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("only checks an eligible Grok catalog ID with confirmation and never falls back to a gateway", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(
      await probeModelInference({ ...xaiInput, modelId: "grok-fixture-unknown" }, { fetch }),
    ).toBe("unavailable");
    for (const modelId of [
      "grok-imagine-fixture",
      "grok-imagine.preview",
      "grok-fixture-live",
      "grok-fixture_live",
      "grok-fixture-voice",
      "grok-voice_preview",
      openRouterInput.modelId,
    ]) {
      expect(
        await probeModelInference({ ...xaiInput, modelId, providerCatalogModel: true }, { fetch }),
      ).toBe("unavailable");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [openRouterInput, "https://openrouter.ai/api/v1/chat/completions"],
    [groqInput, "https://api.groq.com/openai/v1/chat/completions"],
    [groqDirectoryInput, "https://api.groq.com/openai/v1/chat/completions"],
  ] as const)(
    "waits for a model chunk on $0.provider and aborts a single bounded tool request",
    async (input, endpoint) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        return new Response(
          new ReadableStream({
            start(controller) {
              const frames = [
                ": processing\n\n",
                chatChunk([]),
                chatChunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]),
              ];
              for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
                once: true,
              });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      expect(await probeModelInference(input, { fetch })).toBe("accepted");
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0]!;
      const request = new Request(url, init);
      expect(request.url).toBe(endpoint);
      expect(request.headers.get("authorization")).toBe(`Bearer ${input.apiKey}`);
      expect(request.redirect).toBe("error");
      expect(init?.signal?.aborted).toBe(true);
      const payload = await request.json();
      expect(payload).toMatchObject({
        model: input.modelId,
        stream: true,
        tools: [expect.objectContaining({ function: expect.objectContaining({ name: "noop" }) })],
      });
      const limit = payload.max_completion_tokens ?? payload.max_tokens;
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(1024);
      if (input === groqDirectoryInput) {
        expect(payload.max_completion_tokens).toBe(1024);
        expect(payload).not.toHaveProperty("store");
        expect(payload).not.toHaveProperty("reasoning_effort");
      }
    },
  );

  it.each([
    [401, "auth"],
    [498, "rate"],
  ] as const)("classifies Groq HTTP %i as %s without a retry", async (status, outcome) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { message: "Request failed" } }, { status }),
    );
    expect(await probeModelInference(groqInput, { fetch })).toBe(outcome);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends one bounded Claude Messages tool request and stops at message_start", async () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "fixture-deployment-bearer");
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const frames = ['event: ping\ndata: {"type":"ping"}\n\n', anthropicStart];
              for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
            },
            cancel,
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const models = listPiCatalog().filter((entry) => entry.provider === "anthropic");
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((entry) => entry.inferenceProbe && entry.catalogProbe)).toBe(true);
    expect(await probeModelInference(anthropicInput, { fetch })).toBe("accepted");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    const request = new Request(url, init);
    expect(request.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(request.headers.get("x-api-key")).toBe(anthropicInput.apiKey);
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.redirect).toBe("error");
    expect(init?.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    const payload = await request.json();
    expect(payload).toMatchObject({
      model: anthropicInput.modelId,
      stream: true,
    });
    expect(
      payload.tools.filter((tool: { defer_loading?: boolean }) => !tool.defer_loading),
    ).toEqual([expect.objectContaining({ name: "noop" })]);
    expect(payload.max_tokens).toBeGreaterThan(0);
    expect(payload.max_tokens).toBeLessThanOrEqual(1024);
  });

  it.each([
    ["claude-fable-5", "claude-opus-4-8", "unavailable"],
    ["claude-fable-5", "claude-fable-5", "accepted"],
    ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "accepted"],
    ["claude-haiku-5-5", "claude-haiku-5-5-20251001", "unavailable"],
  ] as const)(
    "probes only %s when the response names %s",
    async (modelId, servedModel, outcome) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(anthropicStart.replace("claude-haiku-5-5", servedModel), {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      expect(await probeModelInference({ ...anthropicInput, modelId }, { fetch })).toBe(outcome);
      expect(fetch).toHaveBeenCalledOnce();
      const request = new Request(...fetch.mock.calls[0]!);
      expect(request.headers.get("anthropic-beta") ?? "").not.toContain("fallback");
      const payload = await request.json();
      expect(payload.model).toBe(modelId);
      expect(payload).not.toHaveProperty("fallbacks");
    },
  );

  it("checks a confirmed Claude directory ID without using a fallback model", async () => {
    const modelId = "claude-fixture-next";
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(anthropicStart.replace("claude-haiku-5-5", modelId), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const target = { ...anthropicInput, modelId };
    await expect(probeModelInference(target, { fetch })).resolves.toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      probeModelInference({ ...target, providerCatalogModel: true }, { fetch }),
    ).resolves.toBe("accepted");
    expect(fetch).toHaveBeenCalledOnce();
    const request = new Request(...fetch.mock.calls[0]!);
    expect(request.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(request.headers.get("x-api-key")).toBe(anthropicInput.apiKey);
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.redirect).toBe("error");
    const body = await request.json();
    expect(body).toMatchObject({ model: modelId, max_tokens: 1024 });
    expect(body).not.toHaveProperty("fallbacks");
  });

  it.each([
    [401, "authentication_error", "Rejected", undefined, "auth"],
    [403, "permission_error", "Model access denied", undefined, "model"],
    [404, "not_found_error", "Model missing", undefined, "model"],
    [402, "billing_error", "Billing required", undefined, "credit"],
    [
      400,
      "invalid_request_error",
      "Your credit balance is too low to access the API.",
      undefined,
      "credit",
    ],
    [
      400,
      "invalid_request_error",
      "You have reached your specified API usage limits.",
      undefined,
      "spending",
    ],
    [
      400,
      "invalid_request_error",
      "You have reached your specified workspace API usage limits.",
      undefined,
      "spending",
    ],
    [400, "invalid_request_error", "Invalid parameter: credit_balance", undefined, "unavailable"],
    [400, "invalid_request_error", "Request denied", "claude_code_key_creator_not_member", "auth"],
    [400, "invalid_request_error", "Request denied", "organization_on_hold", "model"],
    [400, "invalid_request_error", "Unrecognized field", undefined, "unavailable"],
    [429, "rate_limit_error", "Usage limit reached", "enforced_spend_limit_reached", "spending"],
    [429, "rate_limit_error", "Usage limit reached", "contract_spend_limit_reached", "spending"],
    [429, "rate_limit_error", "Usage limit reached", undefined, "rate"],
    [500, "timeout_error", "Request failed", undefined, "timeout"],
    [529, "overloaded_error", "Overloaded", undefined, "unavailable"],
    [529, "overloaded_error", "Overloaded", "enforced_spend_limit_reached", "unavailable"],
  ] as const)("classifies Claude HTTP %i %s (%s)", async (status, type, message, code, outcome) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          type: "error",
          error: { type, message, ...(code ? { details: { error_code: code } } : {}) },
        },
        { status },
      ),
    );
    expect(await probeModelInference(anthropicInput, { fetch })).toBe(outcome);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['event: ping\ndata: {"type":"ping"}\n\n', "unavailable"],
    [
      'event: message_start\ndata: {"type":"message_start","message":{"type":"message","role":"assistant","id":""}}\n\n',
      "unavailable",
    ],
    [
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n' +
        anthropicStart,
      "unavailable",
    ],
    ['event: error\ndata: {"type":"error","error":{"type":"permission_error"}}\n\n', "model"],
    ['event: error\ndata: {"type":"error","error":{"type":"billing_error"}}\n\n', "credit"],
    [
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","details":{"error_code":"enforced_spend_limit_reached"}}}\n\n',
      "spending",
    ],
  ] as const)(
    "requires a Claude message frame and accounts for stream errors (%s)",
    async (body, outcome) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      expect(await probeModelInference(anthropicInput, { fetch })).toBe(outcome);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("does not send subscription credentials or guess a Claude route for unregistered models", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const input of [
      { ...anthropicInput, apiKey: "sk-ant-oat-fixture-only" },
      { ...anthropicInput, modelId: "claude-fixture-unknown" },
      { ...anthropicInput, modelId: openRouterInput.modelId },
    ]) {
      expect(await probeModelInference(input, { fetch })).toBe("unavailable");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [400, "blocked_api_access", "spending"],
    [400, "model_decommissioned", "model"],
    [403, "model_terms_required", "model"],
    [403, "model_permission_blocked_org", "model"],
    [403, "model_permission_blocked_project", "model"],
    [429, "model_decommissioned", "rate"],
    [503, "blocked_api_access", "unavailable"],
  ] as const)(
    "classifies Groq HTTP %i %s as %s from its structured code",
    async (status, code, outcome) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ error: { code, message: "Request failed" } }, { status }),
      );
      expect(await probeModelInference(groqInput, { fetch })).toBe(outcome);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [400, "Unsupported model fixture-model", "model"],
    [400, "Unsupported model parameter", "unavailable"],
    [503, "Unsupported model fixture-model", "unavailable"],
  ] as const)("classifies Groq HTTP %i %s as %s", async (status, message, outcome) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { code: String(status), message } }, { status }),
    );
    expect(await probeModelInference(groqInput, { fetch })).toBe(outcome);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the Groq status from a stream error before the first model response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(chatChunk([], { error: { code: 404, message: "Request failed" } }), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    expect(await probeModelInference(groqInput, { fetch })).toBe("model");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("tests a registered OpenRouter Claude model on its Messages route with the selected key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "fixture-deployment-gateway-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-deployment-messages-key");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "X-Gateway-Token: fixture-ambient-header");
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const selected = listPiCatalog().find(
      (entry) => entry.provider === "openrouter" && entry.id === openRouterMessagesInput.modelId,
    );
    expect(selected?.inferenceProbe).toBe(true);
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `: processing\n\n${anthropicStart.replace(anthropicInput.modelId, openRouterMessagesInput.modelId)}`,
          ),
        );
      },
      cancel,
    });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    expect(await probeModelInference(openRouterMessagesInput, { fetch })).toBe("accepted");
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    const request = new Request(...fetch.mock.calls[0]!);
    expect(request.url).toBe("https://openrouter.ai/api/v1/messages");
    expect(request.redirect).toBe("error");
    expect(Object.fromEntries(request.headers)).toEqual({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": openRouterMessagesInput.apiKey,
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain("fixture-ambient-header");
    expect(await request.json()).toEqual({
      model: selected?.id,
      system: "Reply with OK.",
      messages: [{ role: "user", content: "OK?" }],
      stream: true,
      max_tokens: 1024,
      tools: [
        {
          name: "noop",
          description: "Does nothing.",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
  });

  it.each([
    [": processing\n\n", "unavailable"],
    [anthropicStart, "unavailable"],
    ['event: error\ndata: {"type":"error","error":{"type":"permission_error"}}\n\n', "model"],
    ['event: error\ndata: {"type":"error","error":{"type":"authentication_error"}}\n\n', "auth"],
    ['event: error\ndata: {"type":"error","error":{"type":"rate_limit_error"}}\n\n', "rate"],
    ['event: error\ndata: {"type":"error","error":{"type":"billing_error"}}\n\n', "unavailable"],
    [
      'event: error\ndata: {"type":"error","error":{"type":"billing_error","error_type":"payment_required","message":"Payment required"}}\n\n',
      "credit",
    ],
    [
      'event: error\ndata: {"type":"error","error":{"type":"billing_error","error_type":"payment_required","metadata":{"limit_source":"openrouter_in_flight_budget"}}}\n\n',
      "rate",
    ],
    [
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","error_type":"timeout","message":"Provider did not finish"}}\n\n',
      "timeout",
    ],
  ] as const)(
    "handles an OpenRouter Messages stream before a matching acceptance: %s",
    async (body, expected) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      );
      expect(await probeModelInference(openRouterMessagesInput, { fetch })).toBe(expected);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("recognizes a native OpenRouter Messages credit refusal before streaming", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { type: "error", error: { type: "billing_error", error_type: "payment_required" } },
        { status: 402 },
      ),
    );
    expect(await probeModelInference(openRouterMessagesInput, { fetch })).toBe("credit");
  });

  it.each([
    ["permission_denied", "permission_error"],
    ["refusal", "invalid_request_error"],
    ["content_policy_violation", "invalid_request_error"],
  ])(
    "treats a native OpenRouter Messages %s as a model refusal on HTTP and SSE",
    async (errorType, nativeType) => {
      const envelope = {
        type: "error",
        error: { type: nativeType, error_type: errorType, message: "Invalid prompt" },
      };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json(envelope, { status: 403 }))
        .mockResolvedValueOnce(
          new Response(`event: error\ndata: ${JSON.stringify(envelope)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
        )
        .mockResolvedValueOnce(Response.json(envelope, { status: 429 }));
      expect(await probeModelInference(openRouterMessagesInput, { fetch })).toBe("model");
      expect(await probeModelInference(openRouterMessagesInput, { fetch })).toBe("model");
      expect(await probeModelInference(openRouterMessagesInput, { fetch })).toBe("rate");
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    [402, "openrouter_in_flight_budget", "rate"],
    [402, "openrouter_credits", "credit"],
    [403, "openrouter_guardrail_budget", "spending"],
    [402, undefined, "unavailable"],
    [504, undefined, "timeout"],
  ] as const)(
    "classifies OpenRouter Messages HTTP %i with limit source %s",
    async (status, source, expected) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ error: { code: status, metadata: { limit_source: source } } }, { status }),
      );
      expect(await probeModelInference(openRouterMessagesInput, { fetch })).toBe(expected);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [401, "Invalid API key", "auth"],
    [402, "Insufficient credits", "credit"],
    [402, "This request requires more credits, or fewer max_tokens.", "credit"],
    [402, "Spending limit exceeded", "spending"],
    [402, "Team spending limit exceeded", "spending"],
    [402, "API key limit reached", "spending"],
    [402, "Workspace monthly budget of $25.00 exceeded.", "spending"],
    [403, "Key limit exceeded", "spending"],
    [404, "No endpoints found that support tool use", "model"],
    [429, "Rate limit exceeded", "rate"],
    [504, "Gateway timeout", "timeout"],
  ] as const)("classifies OpenRouter %i (%s) as %s", async (status, message, outcome) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { code: status, message } }, { status }),
    );
    expect(await probeModelInference(openRouterInput, { fetch })).toBe(outcome);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [": OPENROUTER PROCESSING\n\n", "unavailable"],
    [chatChunk([]), "unavailable"],
    [chatChunk([{ index: 0, delta: { content: { malformed: true } } }]), "unavailable"],
    [
      chatChunk([{ index: 0, delta: { role: "assistant" }, finish_reason: "network_error" }]),
      "unavailable",
    ],
    [
      chatChunk([{ index: 0, delta: { role: "assistant" }, finish_reason: "unknown" }]),
      "unavailable",
    ],
    [
      chatChunk([{ index: 0, delta: { role: "assistant" }, finish_reason: "error" }]),
      "unavailable",
    ],
    [
      [
        chatChunk([{ index: 0, delta: {}, finish_reason: "error" }]),
        chatChunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]),
      ].join(""),
      "unavailable",
    ],
    ...(
      [
        [401, "auth"],
        [402, "unavailable"],
        [403, "model"],
        [404, "model"],
        [429, "rate"],
        [504, "timeout"],
      ] as const
    ).map(
      ([code, outcome]) =>
        [chatChunk([], { error: { code, message: "Request failed" } }), outcome] as const,
    ),
    [chatChunk([{ index: 0, delta: { content: "partial" }, error: { code: 402 } }]), "unavailable"],
    ['event: error\ndata: {"code":429,"message":"Request failed"}\n\n', "rate"],
  ] as const)(
    "does not accept an OpenRouter stream without a successful model frame",
    async (frame, outcome) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(`${frame}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      expect(await probeModelInference(openRouterInput, { fetch })).toBe(outcome);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [402, "openrouter_in_flight_budget", "rate"],
    [402, "openrouter_credits", "credit"],
    [402, "openrouter_key_limit", "spending"],
    [403, "openrouter_workspace_budget", "spending"],
    [403, "openrouter_guardrail_budget", "spending"],
  ] as const)(
    "preserves the meaning of the OpenRouter %i budget source %s",
    async (status, limit_source, outcome) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json(
          {
            error: { code: status, message: "Spending limit exceeded", metadata: { limit_source } },
          },
          { status },
        ),
      );
      expect(await probeModelInference(openRouterInput, { fetch })).toBe(outcome);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("recognizes a temporary OpenRouter budget limit from its reason", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          error: {
            code: 402,
            message: "Spending limit exceeded",
            metadata: { reason: "in_flight_budget_exhausted" },
          },
        },
        { status: 402 },
      ),
    );
    expect(await probeModelInference(openRouterInput, { fetch })).toBe("rate");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    {},
    { error: {} },
    { error: { code: 402 } },
    { error: "Payment Required" },
    { error: { code: 402, message: "Quota information is temporarily unavailable." } },
    { error: { code: 402, message: "Spending limit information is temporarily unavailable." } },
    {
      error: {
        code: 402,
        message:
          "This request would exceed your available credits given your current in-flight requests.",
      },
    },
  ])("keeps OpenRouter HTTP 402 without a diagnostic inconclusive: %j", async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status: 402 }));
    expect(await probeModelInference(openRouterInput, { fetch })).toBe("unavailable");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops reading OpenRouter responses at the probe byte limit", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const heartbeat = `:${" ".repeat(64 * 1024)}\n\n`;
              const accepted = chatChunk([{ index: 0, delta: { content: "OK" } }]);
              controller.enqueue(new TextEncoder().encode(`${heartbeat}${accepted}`));
            },
            cancel,
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    expect(await probeModelInference(openRouterInput, { fetch })).toBe("unavailable");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps OpenRouter stream read errors out of SDK diagnostics", async () => {
    vi.stubEnv("OPENAI_LOG", "debug");
    const logs = (["debug", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const diagnostic = "fixture-stream-diagnostic";
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error(`${diagnostic} ${openRouterInput.apiKey}`));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    expect(await probeModelInference(openRouterInput, { fetch })).toBe("unavailable");
    expect(logs[0]?.mock.calls.length).toBeGreaterThan(0);
    const recorded = JSON.stringify(logs.flatMap((log) => log.mock.calls));
    expect(recorded).not.toContain(diagnostic);
    expect(recorded).not.toContain(openRouterInput.apiKey);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [401, "invalid_api_key", "auth"],
    [403, "insufficient_permissions", "model"],
    [404, "model_not_found", "model"],
    [429, "insufficient_quota", "credit"],
    [429, "organization_usage_limit_exceeded", "spending"],
    [402, "account_spending_limit_exceeded", "spending"],
    [429, "rate_limit_exceeded", "rate"],
    [504, "gateway_timeout", "timeout"],
    [503, "upstream_unavailable", "unavailable"],
  ] as const)("classifies %i %s as %s without retrying", async (status, code, outcome) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { code, message: `Provider detail ${input.apiKey}` } }, { status }),
    );
    expect(await probeModelInference(input, { fetch })).toBe(outcome);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["", "unavailable"],
    [
      'data: {"type":"error","code":"rate_limit_exceeded","message":"Rate limit exceeded"}\n\n',
      "rate",
    ],
    [
      'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"model_not_found","message":"Model not found"}}}\n\n',
      "model",
    ],
  ] as const)("does not mistake HTTP success for acceptance (%s)", async (body, status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    expect(await probeModelInference(input, { fetch })).toBe(status);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps provider diagnostics out of SDK debug logs", async () => {
    vi.stubEnv("OPENAI_LOG", "debug");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(`Reflected key ${input.apiKey}`, {
          status: 401,
          headers: { "x-fixture-reflection": input.apiKey },
        }),
    );
    expect(await probeModelInference(input, { fetch })).toBe("auth");
    expect(debug).toHaveBeenCalled();
    expect(JSON.stringify(debug.mock.calls)).not.toContain(input.apiKey);
  });

  it("reports deadline expiry and propagates caller cancellation", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>((_request, init) => {
      entered();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const pending = probeModelInference(input, { fetch });
    await started;
    expect(timeout).toHaveBeenCalledWith(15_000);
    deadline.abort(new DOMException("Too slow", "TimeoutError"));
    expect(await pending).toBe("timeout");

    const caller = new AbortController();
    caller.abort();
    await expect(probeModelInference(input, { fetch, signal: caller.signal })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([input, openRouterInput, anthropicInput])(
    "times out an idle $provider event stream",
    async (input) => {
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      const fetch = vi.fn<typeof globalThis.fetch>(async (_request, init) => {
        const body = new ReadableStream({
          start(controller) {
            if (input.provider === "openai")
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
                once: true,
              });
          },
          pull: () => open(),
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      });
      const settled = vi.fn();
      const pending = probeModelInference(input, { fetch });
      void pending.then(settled);
      await opened;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).not.toHaveBeenCalled();
      deadline.abort(new DOMException("Too slow", "TimeoutError"));
      expect(await pending).toBe("timeout");
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("does not contact another provider or guess a dynamic model", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const safeguard = "openai/gpt-oss-safeguard-20b";
    expect(
      listPiCatalog().find((entry) => entry.provider === "groq" && entry.id === safeguard)
        ?.inferenceProbe,
    ).toBeUndefined();
    expect(await probeModelInference({ ...groqInput, modelId: safeguard }, { fetch })).toBe(
      "unavailable",
    );
    expect(
      await probeModelInference({ ...groqInput, modelId: "fixture/unknown-model" }, { fetch }),
    ).toBe("unavailable");
    for (const modelId of [
      safeguard,
      "fixture-vendor/prompt-guard-2",
      "groq/compound-mini",
      "canopylabs/orpheus-arabic-saudi",
      "canopylabs/orpheus-v1-english",
      "whisper-large-v3-turbo",
    ]) {
      expect(await probeModelInference({ ...groqDirectoryInput, modelId }, { fetch })).toBe(
        "unavailable",
      );
    }
    expect(await probeModelInference({ ...input, provider: "openrouter" }, { fetch })).toBe(
      "unavailable",
    );
    expect(await probeModelInference({ ...input, modelId: "gpt-unlisted-probe" }, { fetch })).toBe(
      "unavailable",
    );
    expect(
      await probeModelInference({ ...openRouterInput, provider: "anthropic" }, { fetch }),
    ).toBe("unavailable");
    vi.stubEnv("PI_DEFAULT_MODEL", "fixture/not-in-router-catalog");
    expect(
      await probeModelInference(
        { ...openRouterInput, modelId: "fixture/not-in-router-catalog" },
        { fetch },
      ),
    ).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
});
