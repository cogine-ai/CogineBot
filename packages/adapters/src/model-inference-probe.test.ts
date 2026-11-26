import { afterEach, describe, expect, it, vi } from "vitest";
import { probeModelInference } from "./model-inference-probe.js";
import { listPiCatalog } from "./pi-models.js";

const model = listPiCatalog().find((entry) => entry.inferenceProbe)!;
const input = { provider: model.provider, modelId: model.id, apiKey: "fixture-inference-key" };

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

  it("reports a timeout when the opened stream never acknowledges the request", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_request, init) => {
      const body = new ReadableStream({
        start(controller) {
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
    expect(await probeModelInference({ ...input, provider: "openrouter" }, { fetch })).toBe(
      "unavailable",
    );
    expect(await probeModelInference({ ...input, modelId: "gpt-unlisted-probe" }, { fetch })).toBe(
      "unavailable",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
