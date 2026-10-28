import { once } from "node:events";
import { createServer } from "node:http";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import { observedPiStream } from "./pi-usage.js";

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

describe("Pi corrective deadline through SDK setup and headers", () => {
  it("stops after real asynchronous SDK auth before invoking its model transport", async () => {
    let now = 20_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const models = createModels();
    const sdk = builtinModels().getProvider(model.provider);
    if (!sdk) throw new Error("Fixture provider missing");
    models.setProvider(
      createProvider({
        id: model.provider,
        models: [model],
        api: sdk,
        auth: {
          apiKey: {
            name: "Fixture",
            resolve: async () => {
              await Promise.resolve();
              now += 90_000;
              return { auth: { apiKey: "fixture" }, source: "fixture" };
            },
          },
        },
      }),
    );
    const fetcher = vi.fn(
      async () => new Response(sse(), { headers: { "content-type": "text/event-stream" } }),
    );
    const push = vi.fn();
    const afterCall = vi.fn();
    const onRequestDeadlineExceeded = vi.fn();
    const onProviderError = vi.fn();
    try {
      const result = observedPiStream(
        models,
        model,
        { messages: [] },
        { fetch: fetcher },
        push,
        { beforeCall: () => "reservation", afterCall },
        undefined,
        { requestDeadline: 100_000, onRequestDeadlineExceeded, onProviderError },
      );
      for await (const _event of result) {
      }
      expect(fetcher).not.toHaveBeenCalled();
      expect(afterCall).toHaveBeenCalledExactlyOnceWith("reservation", null);
      expect(push).not.toHaveBeenCalled();
      expect(onRequestDeadlineExceeded).toHaveBeenCalledOnce();
      expect(onProviderError).not.toHaveBeenCalled();
      expect((await result.result()).errorMessage).toContain("deadline expired");
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps an already dispatched request's pre-header timeout usage unknown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let dispatched!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      dispatched();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const afterCall = vi.fn();
    const push = vi.fn();
    const onRequestDeadlineExceeded = vi.fn();
    const onProviderError = vi.fn();
    try {
      const result = observedPiStream(
        builtinModels(),
        model,
        { messages: [] },
        { apiKey: "fixture", fetch: fetcher, maxRetries: 0 },
        push,
        { beforeCall: () => "reservation", afterCall },
        undefined,
        { requestDeadline: Date.now() + 1_000, onRequestDeadlineExceeded, onProviderError },
      );
      await requestStarted;
      await vi.advanceTimersByTimeAsync(1_000);
      for await (const _event of result) {
      }
      expect(fetcher).toHaveBeenCalledOnce();
      expect(afterCall).toHaveBeenCalledExactlyOnceWith("reservation", null);
      expect(push).toHaveBeenCalledOnce();
      expect(push.mock.calls[0]?.[0]).toMatchObject({
        type: "usage",
        inputTokens: null,
        outputTokens: null,
      });
      expect(onRequestDeadlineExceeded).toHaveBeenCalledOnce();
      expect(onProviderError).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["google", "google-vertex"])(
    "clears %s's deadline at its real post-header start without injecting fetch",
    async (provider) => {
      const models = builtinModels();
      const catalog = models.getModel(provider, "gemini-2.5-flash");
      if (!catalog) throw new Error("Fixture Google model missing");
      let finishResponse!: () => void;
      let requestCount = 0;
      const server = createServer(async (request, response) => {
        for await (const _chunk of request) {
          /* Read the native SDK body. */
        }
        requestCount += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        finishResponse = () =>
          response.end(
            `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Fixture complete" }] }, finishReason: "STOP" }] })}\n\n`,
          );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture port missing");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let observedStart!: () => void;
      const start = new Promise<void>((resolve) => {
        observedStart = resolve;
      });
      const target = { ...catalog, baseUrl: `http://127.0.0.1:${address.port}/v1` };
      const afterCall = vi.fn();
      const onRequestDeadlineExceeded = vi.fn();
      const result = observedPiStream(
        models,
        target,
        { messages: [{ role: "user", content: "Fixture", timestamp: 1 }] },
        { apiKey: "fixture", maxRetries: 0 },
        vi.fn(),
        { beforeCall: () => "reservation", afterCall },
        undefined,
        { requestDeadline: Date.now() + 1_000, onRequestDeadlineExceeded },
      );
      const consumed = (async () => {
        for await (const event of result) {
          if (event.type === "start") observedStart();
        }
      })();
      try {
        await Promise.race([
          start,
          consumed.then(async () => {
            throw new Error(
              `Stream stopped before headers: ${(await result.result()).errorMessage}`,
            );
          }),
        ]);
        expect(requestCount).toBe(1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(onRequestDeadlineExceeded).not.toHaveBeenCalled();
        finishResponse();
        await consumed;
        expect((await result.result()).stopReason).toBe("stop");
        expect(afterCall).toHaveBeenCalledOnce();
        expect(onRequestDeadlineExceeded).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
      }
    },
  );
});

it("clears the corrective deadline after real SDK response headers and leaves its body alive", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start: (controller) => {
      body = controller;
    },
  });
  let seenHeaders!: () => void;
  const headers = new Promise<void>((resolve) => {
    seenHeaders = resolve;
  });
  let requestSignal: AbortSignal | undefined;
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    requestSignal = init?.signal ?? undefined;
    return new Response(source, { headers: { "content-type": "text/event-stream" } });
  });
  const onResponse = vi.fn(() => {
    seenHeaders();
  });
  const onRequestDeadlineExceeded = vi.fn();
  try {
    const result = observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { apiKey: "fixture", fetch: fetcher, onResponse },
      vi.fn(),
      undefined,
      undefined,
      { requestDeadline: Date.now() + 1_000, onRequestDeadlineExceeded },
    );
    const consumed = (async () => {
      for await (const _event of result) {
      }
    })();
    await headers;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestSignal?.aborted).toBe(false);
    expect(onRequestDeadlineExceeded).not.toHaveBeenCalled();
    body.enqueue(new TextEncoder().encode(sse()));
    body.close();
    await consumed;
    expect((await result.result()).stopReason).toBe("stop");
    expect(onResponse).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["auth-first", "deadline-first-reject", "deadline-first-resolve", "caller-first"])(
  "preserves actual SDK auth/deadline ordering for %s",
  async (order) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const caller = new AbortController();
    let authStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authStarted = resolve;
    });
    let rejectAuth!: (error: Error) => void;
    let resolveAuth!: (value: { auth: { apiKey: string }; source: string }) => void;
    const pendingAuth = new Promise<{ auth: { apiKey: string }; source: string }>(
      (resolve, reject) => {
        resolveAuth = resolve;
        rejectAuth = reject;
      },
    );
    const models = createModels();
    const sdk = builtinModels().getProvider(model.provider);
    if (!sdk) throw new Error("Fixture provider missing");
    models.setProvider(
      createProvider({
        id: model.provider,
        models: [model],
        api: sdk,
        auth: {
          apiKey: {
            name: "Fixture",
            resolve: async () => {
              authStarted();
              return pendingAuth;
            },
          },
        },
      }),
    );
    const fetcher = vi.fn(
      async () => new Response(sse(), { headers: { "content-type": "text/event-stream" } }),
    );
    const push = vi.fn();
    const afterCall = vi.fn();
    const onRequestDeadlineExceeded = vi.fn();
    try {
      const result = observedPiStream(
        models,
        model,
        { messages: [] },
        { fetch: fetcher, signal: caller.signal },
        push,
        { beforeCall: () => "reservation", afterCall },
        undefined,
        { requestDeadline: Date.now() + 1_000, onRequestDeadlineExceeded },
      );
      const consumed = (async () => {
        for await (const _event of result) {
        }
      })();
      await started;
      if (order === "auth-first") {
        await vi.advanceTimersByTimeAsync(500);
        rejectAuth(new Error("403 Synthetic auth refusal"));
        await consumed;
        expect((await result.result()).errorMessage).toContain("API key auth failed");
        expect(onRequestDeadlineExceeded).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
      } else if (order === "caller-first") {
        caller.abort(new Error("Synthetic caller cancellation"));
        await consumed;
        expect((await result.result()).errorMessage).toContain("Synthetic caller cancellation");
        expect(onRequestDeadlineExceeded).not.toHaveBeenCalled();
        rejectAuth(new Error("403 Late auth refusal"));
        await vi.advanceTimersByTimeAsync(1_000);
      } else {
        await vi.advanceTimersByTimeAsync(1_000);
        await consumed;
        expect((await result.result()).errorMessage).toContain("deadline expired");
        expect(onRequestDeadlineExceeded).toHaveBeenCalledOnce();
        expect(afterCall).toHaveBeenCalledExactlyOnceWith("reservation", null);
        expect(push).not.toHaveBeenCalled();
        if (order === "deadline-first-resolve")
          resolveAuth({ auth: { apiKey: "fixture" }, source: "fixture" });
        else rejectAuth(new Error("403 Late auth refusal"));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fetcher).not.toHaveBeenCalled();
      expect(afterCall).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
