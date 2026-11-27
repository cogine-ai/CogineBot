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
const deepseekInput = {
  provider: "deepseek",
  modelId: "deepseek-flash",
  apiKey: "fixture-deepseek-key",
};
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

function xaiStarted(modelId: string) {
  const response = { id: "resp-fixture", status: "in_progress", model: modelId, error: null };
  return `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response })}\n\n`;
}

describe("model inference check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

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

  it("does not probe unknown DeepSeek or similarly named gateway models", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const modelId of [
      "deepseek-fixture-unlisted",
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

  it.each(xaiApiModels)(
    "sends one bounded Responses request with the selected $id key",
    async ({ id }) => {
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
      expect(await probeModelInference({ ...xaiInput, modelId: id }, { fetch })).toBe("accepted");
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

  it("does not reinterpret unregistered Grok models or fall back to a gateway", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const modelId of ["grok-fixture-unknown", openRouterInput.modelId]) {
      expect(
        await probeModelInference({ ...xaiInput, modelId, providerCatalogModel: true }, { fetch }),
      ).toBe("unavailable");
    }
    expect(fetch).not.toHaveBeenCalled();
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
    expect(models.every((entry) => entry.inferenceProbe && !entry.catalogProbe)).toBe(true);
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
