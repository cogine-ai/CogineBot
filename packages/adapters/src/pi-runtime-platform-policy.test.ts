import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { PlatformModelForbiddenError } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function completion(text = "Fixture complete.", tool?: { name: string; args: object }) {
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "fixture-tool",
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          },
        ],
      }
    : { role: "assistant", content: text };
  return new Response(
    `data: ${JSON.stringify({
      id: "fixture-completion",
      choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }],
    })}\n\ndata: ${JSON.stringify({
      id: "fixture-completion",
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function request(authorize?: () => Promise<void>): AgentRunRequest {
  return {
    botId: "policy-fixture-bot",
    threadId: "policy-fixture-thread",
    runId: "policy-fixture-run",
    prompt: "Complete the fixture task.",
    instructions: "Fixture",
    history: [],
    tools: [],
    model: {
      provider: "openai-compatible",
      id: "policy-fixture-model",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "fixture-key",
      ...(authorize ? { authorize } : {}),
    },
  };
}

async function consume(runtime: PiAgentRuntime, input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  let failure: unknown;
  try {
    for await (const event of runtime.run(input, { signal: AbortSignal.timeout(5_000) })) {
      events.push(event);
    }
  } catch (error) {
    failure = error;
  }
  return { events, failure };
}

function pendingTransport() {
  const entered = deferred<void>();
  const reply = deferred<Response>();
  let signal: AbortSignal | undefined;
  let aborted = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const onAbort = () => {
      aborted = true;
      reply.reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    entered.resolve();
    try {
      return await reply.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  });
  return {
    fetch,
    entered: entered.promise,
    complete: () => reply.resolve(completion()),
    get signal() {
      return signal;
    },
    get aborted() {
      return aborted;
    },
  };
}

describe("Pi deployment model authorization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("refuses a revoked model before dispatching any provider HTTP request", async () => {
    const authorize = vi.fn(async () => {
      throw new PlatformModelForbiddenError();
    });
    const modelFetch = vi.fn<typeof fetch>(async () => completion());
    const result = await consume(new PiAgentRuntime({ modelFetch }), request(authorize));

    expect(modelFetch).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledOnce();
    expect(result.failure).toBeInstanceOf(Error);
    expect((result.failure as Error).message).toContain("platform_model_forbidden");
    expect(result.events.some((event) => event.type === "done")).toBe(false);
  });

  it("rechecks after an executed tool and keeps the first request's observed usage", async () => {
    let allowed = true;
    const authorize = vi.fn(async () => {
      if (!allowed) throw new PlatformModelForbiddenError();
    });
    let requests = 0;
    const modelFetch = vi.fn<typeof fetch>(async () =>
      ++requests === 1 ? completion("", { name: "fixture_effect", args: {} }) : completion(),
    );
    const input = request(authorize);
    input.tools = [
      {
        name: "fixture_effect",
        description: "Execute one fixture action.",
        inputSchema: { type: "object", properties: {} },
        readOnly: false,
      },
    ];
    input.executeTool = vi.fn(async () => {
      allowed = false;
      return { ok: true };
    });
    input.onUsage = vi.fn(async () => undefined);
    const result = await consume(new PiAgentRuntime({ modelFetch }), input);

    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(modelFetch).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(input.onUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ inputTokens: 7, outputTokens: 1 }),
    );
    expect((result.failure as Error).message).toContain("platform_model_forbidden");
    expect(result.events.some((event) => event.type === "done")).toBe(false);
  });

  it("checks the inherited model before a nested helper can send HTTP", async () => {
    const authorize = vi.fn(async () => {
      if (authorize.mock.calls.length > 1) throw new PlatformModelForbiddenError();
    });
    let requests = 0;
    const modelFetch = vi.fn<typeof fetch>(async () =>
      ++requests === 1
        ? completion("", {
            name: "run_subagent",
            args: { name: "fixture-helper", task: "Inspect the fixture." },
          })
        : completion(),
    );
    const input = request(authorize);
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a fixture helper.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
        readOnly: true,
      },
    ];
    const result = await consume(new PiAgentRuntime({ modelFetch }), input);

    expect(modelFetch).toHaveBeenCalledOnce();
    expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        status: "failed",
        result: expect.stringContaining("platform_model_forbidden"),
      }),
    );
    expect((result.failure as Error).message).toContain("platform_model_forbidden");
  });

  it("aborts a revoked active request without retrying or using its configured backup", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let allowed = true;
    const authorize = vi.fn(async () => {
      if (!allowed) throw new PlatformModelForbiddenError();
    });
    const transport = pendingTransport();
    const input = request(authorize);
    input.fallbackModels = [
      {
        provider: "openai-compatible",
        id: "backup-fixture-model",
        modelCredentialId: "fixture-backup-credential",
      },
    ];
    input.resolveFallbackModel = vi.fn(async () => ({
      ...input.fallbackModels![0]!,
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "fixture-backup-key",
    }));
    input.onModelChange = vi.fn(async () => undefined);
    const running = consume(new PiAgentRuntime({ modelFetch: transport.fetch }), input);
    try {
      await transport.entered;
      expect(transport.signal).toBeInstanceOf(AbortSignal);
      allowed = false;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(transport.aborted).toBe(true);
      const result = await running;

      expect((result.failure as Error).message).toContain("platform_model_forbidden");
      expect(transport.fetch).toHaveBeenCalledOnce();
      expect(input.resolveFallbackModel).not.toHaveBeenCalled();
      expect(input.onModelChange).not.toHaveBeenCalled();
      expect(result.events.some((event) => event.type === "done")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      transport.complete();
      await running;
    }
  });

  it("does not overlap rechecks or rewrite a completed result when a late check rejects", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const recheck = deferred<void>();
    const authorize = vi.fn(async () => {
      if (authorize.mock.calls.length > 1) await recheck.promise;
    });
    const transport = pendingTransport();
    const running = consume(
      new PiAgentRuntime({ modelFetch: transport.fetch }),
      request(authorize),
    );
    try {
      await transport.entered;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(authorize).toHaveBeenCalledTimes(2);
      transport.complete();
      const result = await running;
      expect(result.failure).toBeUndefined();
      expect(result.events.at(-1)).toEqual({ type: "done", text: "Fixture complete." });
      const completedAbortReason = transport.signal?.reason;

      recheck.reject(new PlatformModelForbiddenError());
      await vi.advanceTimersByTimeAsync(2_000);
      expect(transport.signal?.reason).toBe(completedAbortReason);
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(transport.fetch).toHaveBeenCalledOnce();
      expect(result.events.filter((event) => event.type === "done")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      recheck.resolve();
      transport.complete();
      await running;
    }
  });

  it("keeps a model without a policy callback free of authorization polling", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const modelFetch = vi.fn<typeof fetch>(async () => completion());
    const result = await consume(new PiAgentRuntime({ modelFetch }), request());

    expect(result.failure).toBeUndefined();
    expect(result.events.at(-1)).toEqual({ type: "done", text: "Fixture complete." });
    expect(modelFetch).toHaveBeenCalledOnce();
    expect(interval).not.toHaveBeenCalled();
  });

  it("revalidates before a hidden SDK retry sends another HTTP request", async () => {
    vi.stubEnv("MODEL_STREAM_MAX_RETRIES", "1");
    let allowed = true;
    const authorize = vi.fn(async () => {
      if (!allowed) throw new PlatformModelForbiddenError();
    });
    let requests = 0;
    const modelFetch = vi.fn<typeof fetch>(async () => {
      if (++requests === 1) {
        allowed = false;
        return Response.json(
          { error: { message: "Fixture unavailable" } },
          { status: 503, headers: { "retry-after-ms": "1" } },
        );
      }
      return completion();
    });
    const result = await consume(new PiAgentRuntime({ modelFetch }), request(authorize));

    expect(modelFetch).toHaveBeenCalledOnce();
    expect((result.failure as Error).message).toContain("platform_model_forbidden");
    expect(result.events.some((event) => event.type === "done")).toBe(false);
  });

  it("does not dispatch a backup revoked while its credential is resolving", async () => {
    vi.stubEnv("MODEL_STREAM_MAX_RETRIES", "0");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let allowed = true;
    const authorize = vi.fn(async () => {
      if (!allowed) throw new PlatformModelForbiddenError();
    });
    const input = request(authorize);
    input.fallbackModels = [
      {
        provider: "openai-compatible",
        id: "backup-fixture-model",
        modelCredentialId: "backup-fixture-credential",
      },
    ];
    const backupEntered = deferred<void>();
    const backup = deferred<AgentRunRequest["model"]>();
    const backupModel: AgentRunRequest["model"] = {
      ...input.fallbackModels[0]!,
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "fixture-backup-key",
    };
    input.resolveFallbackModel = async () => {
      backupEntered.resolve();
      return backup.promise;
    };
    input.onModelChange = vi.fn(async () => undefined);
    let requests = 0;
    const modelFetch = vi.fn<typeof fetch>(async () =>
      ++requests === 1
        ? Response.json({ error: { message: "Fixture unavailable" } }, { status: 503 })
        : completion(),
    );
    const running = consume(new PiAgentRuntime({ modelFetch }), input);
    try {
      await backupEntered.promise;
      allowed = false;
      await vi.advanceTimersByTimeAsync(1_000);
      backup.resolve(backupModel);
      const result = await running;

      expect(modelFetch).toHaveBeenCalledOnce();
      expect(input.onModelChange).not.toHaveBeenCalled();
      expect((result.failure as Error).message).toContain("platform_model_forbidden");
      expect(result.events.some((event) => event.type === "done")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      backup.resolve(backupModel);
      await running;
    }
  });

  it("retains reported usage when revocation aborts an active SSE response", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let allowed = true;
    const authorize = vi.fn(async () => {
      if (!allowed) throw new PlatformModelForbiddenError();
    });
    const observedText = deferred<void>();
    const modelFetch = vi.fn<typeof fetch>(async (input, init) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // The measured frame precedes text, so seeing text proves the parser read usage.
          const usage = {
            id: "usage-fixture",
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
          };
          const text = {
            id: "usage-fixture",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Partial fixture" },
                finish_reason: null,
              },
            ],
          };
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(usage)}\n\ndata: ${JSON.stringify(text)}\n\n`,
            ),
          );
          signal?.addEventListener("abort", () => controller.error(signal.reason), {
            once: true,
          });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const input = request(authorize);
    input.onUsage = vi.fn(async () => undefined);
    const stopped = new AbortController();
    const running = (async () => {
      const events: AgentRuntimeEvent[] = [];
      let failure: unknown;
      try {
        for await (const event of new PiAgentRuntime({ modelFetch }).run(input, {
          signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(5_000)]),
        })) {
          events.push(event);
          if (event.type === "text" && event.text.includes("Partial fixture")) {
            observedText.resolve();
          }
        }
      } catch (error) {
        failure = error;
      }
      return { events, failure };
    })();
    try {
      await Promise.race([
        observedText.promise,
        running.then(() => {
          throw new Error("The fixture ended before reporting partial text.");
        }),
      ]);
      allowed = false;
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await running;

      expect((result.failure as Error).message).toContain("platform_model_forbidden");
      expect(input.onUsage).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 7, outputTokens: 1, totalTokens: 8 }),
      );
      expect(result.events.some((event) => event.type === "done")).toBe(false);
      expect(modelFetch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stopped.abort();
      await running;
    }
  });
});
