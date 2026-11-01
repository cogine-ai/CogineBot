import { once } from "node:events";
import { createServer } from "node:http";
import { streamSimple } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

describe("Bedrock explicit retry budget", () => {
  it.each([
    { maxRetries: 0, attempts: 1 },
    { maxRetries: 1, attempts: 2 },
    { maxRetries: undefined, attempts: 3 },
  ])(
    "uses $attempts SDK attempts for a retry budget of $maxRetries",
    async ({ maxRetries, attempts }) => {
      vi.stubEnv("AWS_MAX_ATTEMPTS", "3");
      for (const key of [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
      ])
        vi.stubEnv(key, "");
      let requests = 0;
      const headers: string[] = [];
      const server = createServer((request, response) => {
        requests += 1;
        headers.push(String(request.headers["amz-sdk-request"] ?? ""));
        request.resume();
        response.writeHead(503, {
          "content-type": "application/json",
          "x-amzn-errortype": "ServiceUnavailableException",
        });
        response.end(JSON.stringify({ message: "Fixture unavailable" }));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture server missing");
      try {
        const events = [];
        const stream = streamSimple(
          {
            id: "fixture-model",
            name: "Fixture",
            api: "bedrock-converse-stream",
            provider: "amazon-bedrock",
            baseUrl: `http://127.0.0.1:${address.port}`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 32,
          },
          normalizeContext({
            messages: [{ role: "user", content: "Fixture", timestamp: Date.now() }],
          }),
          {
            maxRetries,
            maxTokens: 32,
            signal: AbortSignal.timeout(10_000),
            env: {
              AWS_BEDROCK_SKIP_AUTH: "1",
              AWS_BEDROCK_FORCE_HTTP1: "1",
              AWS_REGION: "us-east-1",
            },
          },
        );
        for await (const event of stream) events.push(event);
        expect(events.at(-1)?.type).toBe("error");
        expect(requests).toBe(attempts);
        expect(headers).toEqual(
          Array.from({ length: attempts }, (_, index) => `attempt=${index + 1}; max=${attempts}`),
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
