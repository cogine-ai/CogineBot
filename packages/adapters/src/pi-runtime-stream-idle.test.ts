import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Models,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";
import {
  isModelStreamIdleTimeout,
  isRetryableProviderUnavailable,
  MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
  modelStreamIdleWatchdog,
  PiAgentRuntime,
  reliableModelStream,
} from "./pi-runtime.js";
import { MODEL_STREAM_IDLE_TIMEOUT_MS, MODEL_STREAM_TIMEOUT_MS } from "./pi-runtime-limits.js";
import { observedPiStream } from "./pi-usage.js";

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.1-codex",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function abortedByPi(): Parameters<AssistantMessageEventStream["push"]>[0] {
  // pi surfaces any request-signal abort as this generic terminal event.
  return {
    type: "error",
    reason: "aborted",
    error: assistantMessage({ stopReason: "aborted", errorMessage: "Request was aborted" }),
  };
}

const codexModel = { provider: "openai-codex", api: "openai-codex-responses" } as Model<Api>;
const compatibleModel = { provider: "openrouter", api: "openai-completions" } as Model<Api>;
const context = { messages: [] } as Context;

function httpModel<T extends Api>(api: T, provider: string): Model<T> {
  return {
    provider,
    api,
    id: "fixture-model",
    name: "Fixture",
    baseUrl: "https://models.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
  };
}

describe("Model stream idle watchdog", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts the composed signal after the idle bound and relabels the terminal error", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();

    // No idle budget burns before response headers land: the pre-headers
    // window is bounded per attempt by timeoutMs, so this wait must never
    // abort.
    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(watchdog.signal.aborted).toBe(false);

    inner.push({ type: "start", partial: assistantMessage() });
    await pending;

    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(watchdog.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.signal.reason).toBeInstanceOf(Error);
    expect((watchdog.signal.reason as Error).message).toBe(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE);

    const errored = iterator.next();
    inner.push(abortedByPi());
    inner.end();
    const { value } = await errored;
    expect(value).toEqual({
      type: "error",
      reason: "error",
      error: expect.objectContaining({
        stopReason: "error",
        errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
      }),
    });
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
    });
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds silence once response headers land, even before the first event", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();

    // Pre-headers wait consumes no idle budget.
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(watchdog.signal.aborted).toBe(false);

    // Headers landed — pi's onResponse seam pings the watchdog — but the body
    // then stays silent: the idle bound applies from here.
    watchdog.ping();
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(watchdog.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(watchdog.signal.aborted).toBe(true);
    expect((watchdog.signal.reason as Error).message).toBe(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE);

    inner.push(abortedByPi());
    inner.end();
    expect((await pending).value).toMatchObject({
      reason: "error",
      error: { errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE },
    });
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE,
    });
  });

  it("never aborts a retry that succeeds after an earlier attempt stalled out", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();

    // Attempt one burns its full headers timeout plus the retry backoff; a
    // second attempt then needs its own timeoutMs to deliver headers. No
    // leftover idle budget may kill it.
    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_TIMEOUT_MS + MODEL_STREAM_IDLE_TIMEOUT_MS);
    expect(watchdog.signal.aborted).toBe(false);

    // The retried attempt's headers arrive: the first event arms the timer.
    inner.push({ type: "start", partial: assistantMessage() });
    expect((await pending).value).toMatchObject({ type: "start" });
    expect(watchdog.signal.aborted).toBe(false);

    const done = iterator.next();
    inner.push({ type: "done", reason: "stop", message: assistantMessage() });
    inner.end();
    expect((await done).value).toMatchObject({ type: "done" });
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "stop" });
  });

  it("re-arms on every delivered event so a busy stream never aborts", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();

    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    let pending = iterator.next();
    inner.push({ type: "start", partial: assistantMessage() });
    await pending;

    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(watchdog.signal.aborted).toBe(false);

    pending = iterator.next();
    inner.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: assistantMessage() });
    expect((await pending).value).toMatchObject({ type: "text_delta", delta: "x" });

    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(watchdog.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(watchdog.signal.aborted).toBe(true);
  });

  it("propagates a caller abort without relabeling it", async () => {
    vi.useFakeTimers();
    const upstream = new AbortController();
    const watchdog = modelStreamIdleWatchdog(upstream.signal);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();

    watchdog.ping();
    expect(vi.getTimerCount()).toBe(1);
    upstream.abort("caller stop");
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.signal.reason).toBe("caller stop");
    expect(vi.getTimerCount()).toBe(0);

    inner.push(abortedByPi());
    inner.end();
    expect((await pending).value).toMatchObject({
      reason: "aborted",
      error: { errorMessage: "Request was aborted" },
    });
    const result = await stream.result();
    expect(result.stopReason).toBe("aborted");
    expect(isModelStreamIdleTimeout(result)).toBe(false);
  });

  it("clears the watchdog once the stream completes", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);

    const eventTypes: string[] = [];
    const done = (async () => {
      for await (const event of stream) eventTypes.push(event.type);
    })();
    inner.push({ type: "start", partial: assistantMessage() });
    inner.push({ type: "done", reason: "stop", message: assistantMessage() });
    inner.end();
    await done;

    expect(eventTypes).toEqual(["start", "done"]);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(watchdog.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up when the consumer stops iterating early", async () => {
    vi.useFakeTimers();
    const watchdog = modelStreamIdleWatchdog(undefined);
    const inner = new AssistantMessageEventStream();
    const stream = watchdog.wrap(inner);
    const iterator = stream[Symbol.asyncIterator]();

    inner.push({ type: "start", partial: assistantMessage() });
    await iterator.next();
    await iterator.return?.(undefined);

    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(watchdog.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("reliableModelStream idle gating", () => {
  afterEach(() => vi.useRealTimers());

  it.each([codexModel, compatibleModel])("bounds post-header silence for $api", async (model) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const inner = new AssistantMessageEventStream();
    const streamSimple = vi.fn(
      (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => inner,
    );
    const models = { streamSimple } as unknown as Models;
    const callerFetch = vi.fn<NonNullable<SimpleStreamOptions["fetch"]>>();
    const options: SimpleStreamOptions = { signal: caller.signal, fetch: callerFetch };

    const guarded = reliableModelStream(models, model, context, options, undefined);
    const guardedOptions = streamSimple.mock.calls[0]?.[2];
    expect(guardedOptions?.signal).not.toBe(caller.signal);
    expect(guardedOptions?.fetch).not.toBe(callerFetch);
    expect(guardedOptions?.timeoutMs).toBe(MODEL_STREAM_TIMEOUT_MS);
    expect(guardedOptions?.transport).toBe(model === codexModel ? "sse" : undefined);
    expect(guarded).not.toBe(inner);

    // Before the first event the idle budget stays unarmed, so a headers
    // timeout leaves a retried attempt its own full timeoutMs.
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(guardedOptions?.signal?.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);

    // Once events flow, silence is bounded — and the watchdog aborts only its
    // own request signal, never the caller's.
    const iterator = guarded[Symbol.asyncIterator]();
    const pending = iterator.next();
    inner.push({ type: "start", partial: assistantMessage() });
    await pending;
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS);
    expect(guardedOptions?.signal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    await iterator.return?.(undefined);
  });

  it("arms only on successful responses, leaving retry backoff uncovered", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const inner = new AssistantMessageEventStream();
    const streamSimple = vi.fn(
      (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => inner,
    );
    const models = { streamSimple } as unknown as Models;
    const onResponse = vi.fn();

    reliableModelStream(
      models,
      codexModel,
      context,
      { signal: caller.signal, onResponse },
      undefined,
    );
    const guardedOptions = streamSimple.mock.calls[0]?.[2];
    expect(guardedOptions?.onResponse).not.toBe(onResponse);

    // Attempt 1 stalls until its headers timeout and pi retries: no response
    // callback has fired, so no idle budget has been spent.
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_TIMEOUT_MS + MODEL_STREAM_IDLE_TIMEOUT_MS);
    expect(guardedOptions?.signal?.aborted).toBe(false);

    // A retryable response's headers must not arm the watchdog: error
    // responses emit no stream events, and pi's backoff sleep sits outside the
    // idle bound. The caller's own onResponse still observes every response.
    await guardedOptions?.onResponse?.({ status: 429, headers: {} }, codexModel);
    expect(onResponse).toHaveBeenCalledWith({ status: 429, headers: {} }, codexModel);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS * 2);
    expect(guardedOptions?.signal?.aborted).toBe(false);

    // The retried attempt's 2xx headers arm a fresh full budget; a body that
    // then stays silent aborts at the idle bound.
    await guardedOptions?.onResponse?.({ status: 200, headers: {} }, codexModel);
    expect(onResponse).toHaveBeenCalledWith({ status: 200, headers: {} }, codexModel);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(guardedOptions?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(guardedOptions?.signal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });

  it("fails a stalled retryable error body without aborting the request", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const inner = new AssistantMessageEventStream();
    const callerFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise<void>(() => undefined),
          }),
          { status: 429, headers: { "retry-after": "30" } },
        ),
    );
    const streamSimple = vi.fn(
      (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => inner,
    );
    reliableModelStream(
      { streamSimple } as unknown as Models,
      compatibleModel,
      context,
      { signal: caller.signal, fetch: callerFetch },
      undefined,
    );
    const guardedOptions = streamSimple.mock.calls[0]?.[2];
    const response = await guardedOptions!.fetch!("https://example.test/codex", { method: "POST" });
    expect(callerFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");

    let settled = false;
    const outcome = response.text().then(
      (text) => {
        settled = true;
        return { text };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(guardedOptions?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(outcome).resolves.toEqual({
      error: expect.objectContaining({ message: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE }),
    });
    expect(guardedOptions?.signal?.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a finished error body and leaves successful responses unwrapped", async () => {
    const caller = new AbortController();
    const inner = new AssistantMessageEventStream();
    const ok = new Response("event: done\n\n", { status: 200 });
    const callerFetch = vi
      .fn<NonNullable<SimpleStreamOptions["fetch"]>>()
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(ok);
    const streamSimple = vi.fn(
      (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => inner,
    );
    reliableModelStream(
      { streamSimple } as unknown as Models,
      codexModel,
      context,
      { signal: caller.signal, fetch: callerFetch },
      undefined,
    );
    const guardedOptions = streamSimple.mock.calls[0]?.[2];
    const retryable = await guardedOptions!.fetch!("https://example.test/codex", {});
    expect(retryable.status).toBe(429);
    expect(retryable.headers.get("retry-after")).toBe("2");
    await expect(retryable.text()).resolves.toBe("slow down");

    const succeeded = await guardedOptions!.fetch!("https://example.test/codex", {});
    expect(succeeded).toBe(ok);
    expect(guardedOptions?.signal?.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);
  });

  it("disposes the watchdog when streamSimple throws synchronously", () => {
    vi.useFakeTimers();
    const models = {
      streamSimple: vi.fn(() => {
        throw new Error("no api key");
      }),
    } as unknown as Models;

    expect(() => reliableModelStream(models, codexModel, context, undefined, undefined)).toThrow(
      "no api key",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each([
  { api: "google-generative-ai", provider: "google" },
  { api: "google-vertex", provider: "google-vertex" },
] as const)("native $api streaming", ({ api, provider }) => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([false, true])("preserves caller fetch identity (supplied: %s)", async (supplied) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetch = supplied ? vi.fn<NonNullable<SimpleStreamOptions["fetch"]>>() : undefined;
    const inner = new AssistantMessageEventStream();
    const streamSimple = vi.fn(
      (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => inner,
    );
    const stream = reliableModelStream(
      { streamSimple } as unknown as Models,
      httpModel(api, provider),
      context,
      { signal: caller.signal, fetch },
      undefined,
    );
    const options = streamSimple.mock.calls[0]![2]!;
    expect(options.fetch).toBe(fetch);
    expect(options.signal).not.toBe(caller.signal);

    // These SDK adapters expose their response boundary as the start event.
    const iterator = stream[Symbol.asyncIterator]();
    const started = iterator.next();
    inner.push({ type: "start", partial: assistantMessage() });
    await started;
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS);
    expect(options.signal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    await iterator.return?.(undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads real SDK SSE without injecting an unsupported transport", async () => {
    const fetch = vi.fn(async () => {
      const chunk = {
        candidates: [{ content: { parts: [{ text: "hi" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const stream = reliableModelStream(
      builtinModels(),
      httpModel(api, provider),
      { messages: [{ role: "user", content: "Fixture", timestamp: 0 }] },
      { apiKey: "fixture-key", maxRetries: 0 },
      undefined,
    );
    const events = [];
    for await (const event of stream) events.push(event.type);
    expect(events).toContain("text_delta");
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "hi" }],
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

it("uses the package dispatcher for a compatible provider's DNS guard", async () => {
  const streamSimple = vi.fn(
    (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) =>
      new AssistantMessageEventStream(),
  );
  reliableModelStream(
    { streamSimple } as unknown as Models,
    httpModel("openai-completions", "openai-compatible"),
    context,
    undefined,
    undefined,
  );
  const resolve = vi.fn(async () => [{ address: "10.0.0.8", family: 4 }]);
  const fetch = createOpenAiCompatibleFetch(streamSimple.mock.calls[0]![2]?.fetch, resolve, {
    allowPublic: true,
  });

  await expect(fetch("https://models.example.test/v1/models")).rejects.toMatchObject({
    cause: { message: "Public model server hostname resolved to a private address" },
  });
  expect(resolve).toHaveBeenCalledOnce();
});

it("terminates a silent SDK response and retains observed failure provenance", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  let receivedHeaders!: () => void;
  const headers = new Promise<void>((resolve) => {
    receivedHeaders = resolve;
  });
  let providerSignal: AbortSignal | null | undefined;
  const fetch = vi.fn<NonNullable<SimpleStreamOptions["fetch"]>>(async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    providerSignal = signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  const models = builtinModels();
  const model = httpModel("openai-completions", "openrouter");
  const context: Context = { messages: [{ role: "user", content: "Fixture", timestamp: 0 }] };
  const onProviderError = vi.fn<(message: AssistantMessage) => void>();
  const stream = reliableModelStream(
    models,
    model,
    context,
    { apiKey: "fixture-key", signal: caller.signal, fetch, onResponse: receivedHeaders },
    undefined,
    undefined,
    (options) =>
      observedPiStream(models, model, context, options, () => undefined, undefined, undefined, {
        onProviderError,
      }),
  );
  const events: AssistantMessageEvent[] = [];
  const consume = (async () => {
    for await (const event of stream) events.push(event);
  })();
  try {
    await headers;
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS);
    expect(providerSignal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    await consume;

    const terminal = events.at(-1);
    expect(events.map(({ type }) => type)).toEqual(["start", "error"]);
    if (terminal?.type !== "error") throw new Error("Expected a terminal idle error");
    expect(terminal).toMatchObject({
      reason: "error",
      error: { errorMessage: MODEL_STREAM_IDLE_TIMEOUT_MESSAGE },
    });
    expect(onProviderError).toHaveBeenCalledOnce();
    expect(terminal.error.content).toBe(onProviderError.mock.calls[0]![0].content);
    expect(isModelStreamIdleTimeout(terminal.error)).toBe(true);
    expect(isModelStreamIdleTimeout({ ...terminal.error })).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    caller.abort();
    await consume;
    vi.useRealTimers();
  }
});

function stalledErrorBody(status: number) {
  let readingBody!: () => void;
  const reading = new Promise<void>((resolve) => {
    readingBody = resolve;
  });
  const cancel = vi.fn();
  const fetch = vi.fn<NonNullable<SimpleStreamOptions["fetch"]>>(async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        readingBody();
        return new Promise<void>(() => undefined);
      },
      cancel,
    });
    return new Response(body, { status });
  });
  return { fetch, reading, cancel };
}

it.each([401, 403, 429])("classifies an SDK error when its HTTP %i body stalls", async (status) => {
  vi.useFakeTimers();
  try {
    const { fetch, reading, cancel } = stalledErrorBody(status);
    const stream = reliableModelStream(
      builtinModels(),
      httpModel("mistral-conversations", "mistral"),
      { messages: [{ role: "user", content: "Fixture", timestamp: 0 }] },
      { apiKey: "fixture-key", fetch, maxRetries: 0 },
      undefined,
    );
    const result = stream.result();
    await reading;
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS);

    const terminal = await result;
    expect(terminal.stopReason).toBe("error");
    expect(terminal.errorMessage).toBeDefined();
    expect(terminal.errorMessage).toContain(
      status === 429 ? MODEL_STREAM_IDLE_TIMEOUT_MESSAGE : String(status),
    );
    expect(isRetryableProviderUnavailable(terminal)).toBe(status === 429);
    expect(isModelStreamIdleTimeout(terminal)).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("stops an actual SDK error-body read without waiting for idle or resolving a backup", async () => {
  vi.useFakeTimers();
  const { fetch: modelFetch, reading, cancel } = stalledErrorBody(503);
  const stop = new AbortController();
  const runtime = new PiAgentRuntime({ modelFetch });
  const backup = { provider: "mistral", id: "ministral-8b-latest", apiKey: "fixture-backup-key" };
  const resolveFallbackModel = vi.fn(async () => backup);
  let settled = false;
  const outcome = (async () => {
    for await (const _event of runtime.run(
      {
        botId: "body-stop-fixture-bot",
        threadId: "body-stop-fixture-thread",
        runId: "body-stop-fixture-run",
        prompt: "Complete the fixture task.",
        instructions: "Be brief.",
        history: [],
        tools: [],
        model: { provider: "mistral", id: "mistral-large-latest", apiKey: "fixture-key" },
        fallbackModels: [backup],
        resolveFallbackModel,
      },
      { signal: stop.signal },
    )) {
    }
  })()
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await Promise.race([
      reading,
      outcome.then(() => {
        throw new Error("The runtime ended before opening the error body");
      }),
    ]);
    // Let the Mistral SDK receive headers and detach its temporary header signal.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(modelFetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(resolveFallbackModel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    stop.abort();
    if (!settled) await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS);
    await outcome;
    vi.useRealTimers();
  }
});

it("keeps Retry-After from an actual OpenAI-compatible SDK error response", async () => {
  const fetcher = vi.fn(async () =>
    Response.json(
      { error: { message: "Rate limit reached" } },
      { status: 429, headers: { "Retry-After": "7200" } },
    ),
  );
  const onProviderError = vi.fn();
  const sdkStream = observedPiStream(
    builtinModels(),
    httpModel("openai-completions", "openrouter"),
    { messages: [{ role: "user", content: "Fixture", timestamp: 0 }] },
    { apiKey: "fixture-key", fetch: fetcher, maxRetries: 0 },
    () => undefined,
    undefined,
    undefined,
    { onProviderError },
  );

  expect(await sdkStream.result()).toMatchObject({ stopReason: "error" });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(onProviderError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ errorMessage: expect.stringContaining("Rate limit reached") }),
    expect.objectContaining({ providerRetryAfterMs: 7_200_000 }),
  );
});
