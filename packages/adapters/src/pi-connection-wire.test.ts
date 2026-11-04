import { createModels } from "@earendil-works/pi-ai";
import type { ModelApiProtocol } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenAiCompatibleFetch,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  probeOpenAiCompatibleModels,
  registerOpenAiCompatibleRuntime,
} from "./pi-openai-compatible-provider.js";
import { observedPiStream } from "./pi-usage.js";

const protocols = ["chat-completions", "responses", "anthropic-messages"] as const;
const frame = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
function sseError(protocol: ModelApiProtocol, secret: string) {
  const error = {
    type: "authentication_error",
    message: `Private reflection: ${JSON.stringify(secret)}`,
  };
  if (protocol === "responses")
    return frame({
      type: "response.failed",
      response: { status: "failed", error: { ...error, code: "authentication_error" } },
    });
  if (protocol === "anthropic-messages") return `event: error\n${frame({ type: "error", error })}`;
  return frame({ error });
}

describe("connection wire boundaries", () => {
  it.each(["X-Api-Key", "x-api-key", "X-API-KEY"])(
    "enforces the existing HTTPS boundary for Request and init %s",
    async (name) => {
      const fetcher = vi.fn(async () => new Response("{}"));
      const safe = createOpenAiCompatibleFetch(fetcher, undefined, { allowPublic: true });
      await expect(
        safe(new Request("http://model.example/v1", { headers: { [name]: "xy9" } })),
      ).rejects.toThrow("HTTPS");
      await expect(safe("http://model.example/v1", { headers: [[name, "xy9"]] })).rejects.toThrow(
        "HTTPS",
      );
      expect(fetcher).not.toHaveBeenCalled();
      await expect(
        safe(new Request("http://model.example/v1", { headers: { [name]: "xy9" } }), {
          headers: {},
        }),
      ).resolves.toMatchObject({ status: 200 });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it("requires HTTPS for keyless custom headers and applies validated custom headers last", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("xy9");
      expect(headers.get("anthropic-version")).toBe("custom-version");
      return new Response("{}");
    });
    const safe = createOpenAiCompatibleFetch(fetcher, undefined, {
      allowPublic: true,
      headers: { "X-Api-Key": " xy9 ", "anthropic-version": "custom-version" },
    });
    await expect(safe("http://model.example/v1")).rejects.toThrow("HTTPS");
    await safe("https://127.0.0.1/v1", {
      headers: { "x-api-key": "default-key", "anthropic-version": "2023-06-01" },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(protocols)(
    "probes %s with the same private custom headers and bounded discovery",
    async (apiProtocol) => {
      const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("X-Private")).toBe("xy9");
        if (apiProtocol === "anthropic-messages") {
          expect(headers.get("x-api-key")).toBe("synthetic-key");
          expect(headers.get("anthropic-version")).toBe("2023-06-01");
        } else expect(headers.get("authorization")).toBe("Bearer synthetic-key");
        return Response.json({
          data: Array.from({ length: 4000 }, (_, index) => ({ id: `synthetic-${index}` })),
        });
      });
      expect(
        await probeOpenAiCompatibleModels(
          {
            baseUrl: "https://127.0.0.1/v1",
            apiProtocol,
            apiKey: "synthetic-key",
            headers: { "X-Private": " xy9 " },
          },
          fetcher,
        ),
      ).toHaveLength(4000);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it.each(
    protocols.flatMap((apiProtocol) =>
      ["1", " en ", " xy9 ", 'q"\\z'].map((secret) => ({ apiProtocol, secret })),
    ),
  )(
    "sanitizes actual $apiProtocol SSE errors for $secret before observers",
    async ({ apiProtocol, secret }) => {
      const models = registerOpenAiCompatibleRuntime(createModels(), {
        modelId: "same-model",
        baseUrl: "https://127.0.0.1/v1",
        apiProtocol,
        headers: { "X-Private": secret },
      });
      const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "same-model")!;
      const onProviderError = vi.fn();
      const stream = observedPiStream(
        models,
        model,
        { messages: [{ role: "user", content: "A task", timestamp: 1 }] },
        {
          apiKey: "synthetic-key",
          maxTokens: 256,
          fetch: async () =>
            new Response(sseError(apiProtocol, secret), {
              headers: { "content-type": "text/event-stream" },
            }),
        },
        vi.fn(),
        undefined,
        undefined,
        { onProviderError },
      );
      for await (const _event of stream) {
        /* Actual SDK parser. */
      }
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).not.toContain("Private reflection");
      // The CC SDK drops parsed error.type when SSE has no HTTP error status.
      if (apiProtocol === "chat-completions")
        expect(result.errorMessage).toBe("500: Model request failed.");
      else expect(result.errorMessage).toContain("authentication_error");
      expect(onProviderError).toHaveBeenCalledOnce();
      expect(JSON.stringify(onProviderError.mock.calls)).not.toContain("Private reflection");
    },
  );
  it("keeps same-id connection diagnostics isolated while calls interleave", async () => {
    const calls = ["first-secret", "second-secret"].map((secret) => {
      const models = registerOpenAiCompatibleRuntime(createModels(), {
        modelId: "same-model",
        baseUrl: "https://127.0.0.1/v1",
        headers: { "X-Private": secret },
      });
      const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "same-model")!;
      return observedPiStream(
        models,
        model,
        { messages: [] },
        {
          apiKey: "synthetic-key",
          fetch: async () =>
            Response.json(
              { error: { message: `Private reflection ${secret}`, type: "authentication_error" } },
              { status: 401 },
            ),
        },
        vi.fn(),
      );
    });
    const results = await Promise.all(
      calls.map(async (stream) => {
        for await (const _event of stream) {
          /* drain */
        }
        return stream.result();
      }),
    );
    for (const result of results) expect(result.errorMessage).toBe("401: authentication_error");
  });
});
