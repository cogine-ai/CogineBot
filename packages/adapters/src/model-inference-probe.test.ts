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
const groqInput = { provider: "groq", modelId: "openai/gpt-oss-120b", apiKey: "fixture-groq-key" };

function chatChunk(choices: unknown[], extra: Record<string, unknown> = {}) {
  return `data: ${JSON.stringify({ id: "gen-fixture", object: "chat.completion.chunk", choices, ...extra })}\n\n`;
}

describe("model inference check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

  it.each([
    [openRouterInput, "https://openrouter.ai/api/v1/chat/completions"],
    [groqInput, "https://api.groq.com/openai/v1/chat/completions"],
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

  it.each([
    [401, "Invalid API key", "auth"],
    [402, "Insufficient credits", "credit"],
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
        [402, "credit"],
        [403, "model"],
        [404, "model"],
        [429, "rate"],
        [504, "timeout"],
      ] as const
    ).map(
      ([code, outcome]) =>
        [chatChunk([], { error: { code, message: "Request failed" } }), outcome] as const,
    ),
    [chatChunk([{ index: 0, delta: { content: "partial" }, error: { code: 402 } }]), "credit"],
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
        Response.json({ error: { code: status, metadata: { limit_source } } }, { status }),
      );
      expect(await probeModelInference(openRouterInput, { fetch })).toBe(outcome);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

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

  it.each([input, openRouterInput])("times out an idle $provider event stream", async (input) => {
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
  });

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
