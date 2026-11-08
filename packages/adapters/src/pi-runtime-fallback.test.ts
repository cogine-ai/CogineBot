import type * as AgentCore from "@earendil-works/pi-agent-core";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Context,
  CredentialStore,
  Model,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent, ModelCallObserver } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  credentialStores: [] as unknown[],
  stream: vi.fn(),
  agentOptions: undefined as AgentOptions | undefined,
  agent: undefined as AgentCore.Agent | undefined,
  delay: vi.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>(),
}));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  abortableDelay: providerState.delay,
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentCore>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: AgentOptions) {
        super(options);
        providerState.agentOptions = options;
        providerState.agent = this;
      }
    },
  };
});

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: (options?: { credentials?: unknown }) => {
    if (options?.credentials) providerState.credentialStores.push(options.credentials);
    return {
      getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
      streamSimple: (...args: unknown[]) => providerState.stream(...args),
    };
  },
}));

vi.mock("./pi-current-models.js", () => ({ supplementPiModels: (models: unknown) => models }));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { estimateModelContextTokens } from "./model-context.js";
import { ModelOutputRecoveryError } from "./model-output-recovery.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS } from "./model-vision.js";
import { isRetryableProviderUnavailable, PiAgentRuntime } from "./pi-runtime.js";
import { MODEL_STREAM_IDLE_TIMEOUT_MS } from "./pi-runtime-limits.js";
import { PiJsonlSessionRecorder } from "./pi-session.js";

const primary = model("provider-a", "primary", 32_768);
const backupA = model("provider-b", "backup-a", 8_192);
const backupB = model("provider-c", "backup-b", 16_384);

function model(provider: string, id: string, contextWindow: number): Model<"openai-completions"> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://models.invalid/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(4_096, contextWindow),
  };
}

function message(
  target: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: target.api,
    provider: target.provider,
    model: target.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function stream(_target: Model<Api>, response: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [], stopReason: "stop" } });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    result.push({
      type: "error",
      reason: response.stopReason,
      error: response,
    });
  } else if (response.content.some((part) => part.type === "toolCall")) {
    const call = response.content.find((part) => part.type === "toolCall");
    if (call?.type === "toolCall") {
      result.push({
        type: "toolcall_start",
        contentIndex: 0,
        partial: { ...response, content: [] },
      });
      result.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: call,
        partial: response,
      });
    }
    result.push({ type: "done", reason: "toolUse", message: response });
  } else {
    result.push({ type: "done", reason: "stop", message: response });
  }
  result.end(response);
  return result;
}

function countContextImages(context: { messages?: unknown[] }): number {
  let count = 0;
  for (const message of context.messages ?? []) {
    if (!message || typeof message !== "object" || !("content" in message)) continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    count += content.filter(
      (part) =>
        part !== null && typeof part === "object" && (part as { type?: unknown }).type === "image",
    ).length;
  }
  return count;
}

function request(fallbackModels: AgentRunRequest["model"][] = []): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Write the requested result",
    instructions: "Use tools when useful.",
    history: [],
    tools: [
      {
        name: "write_effect",
        description: "Write one external effect.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        readOnly: false,
      },
    ],
    model: { provider: primary.provider, id: primary.id, apiKey: "fake-primary-key" },
    fallbackModels,
    executeTool: vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(
      async (name, args, _id, _route, observer) =>
        name === "run_subagent" ? observer!.runSubagent!(args) : { ok: true },
    ),
  } as unknown as AgentRunRequest;
}

async function run(
  input: AgentRunRequest,
  events: AgentRuntimeEvent[] = [],
  runtime = new PiAgentRuntime(),
) {
  for await (const event of runtime.run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  providerState.models.clear();
  providerState.credentialStores.length = 0;
  for (const candidate of [primary, backupA, backupB]) {
    providerState.models.set(
      `${candidate.provider}/${candidate.id}`,
      candidate as unknown as Record<string, unknown>,
    );
  }
  providerState.stream.mockReset();
  providerState.agentOptions = undefined;
  providerState.agent = undefined;
  vi.restoreAllMocks();
  providerState.delay.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

describe("Pi runtime completion recovery", () => {
  it("uses each current target's image policy for candidate admission and switched reservations", async () => {
    const astra = {
      ...model("openai", "gpt-6-astra", 65_536),
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    const sonnet = {
      ...model("anthropic", "claude-sonnet-5-5", 65_536),
      api: "anthropic-messages" as const,
      baseUrl: "https://api.anthropic.com",
    };
    for (const target of [astra, sonnet])
      providerState.models.set(
        `${target.provider}/${target.id}`,
        target as unknown as Record<string, unknown>,
      );
    const image = await sharp({
      create: { width: 4096, height: 4096, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const input = request([
      { provider: astra.provider, id: astra.id, modelCredentialId: "small-vision" },
      { provider: sonnet.provider, id: sonnet.id, modelCredentialId: "fitting-vision" },
    ]);
    input.model = {
      provider: astra.provider,
      id: astra.id,
      apiKey: "fake-primary-key",
      modelCredentialId: "primary-vision",
      maxTokens: 1024,
    };
    input.currentTurnImages = [{ name: "synthetic.png", mimeType: "image/png", data: image }];
    input.resolveFallbackModel = vi.fn(async (provider, id, modelCredentialId) => ({
      provider,
      id,
      modelCredentialId,
      apiKey: "fake-backup-key",
      maxTokens: 1024,
      contextWindow: modelCredentialId === "small-vision" ? 16_384 : 65_536,
    }));
    input.onModelChange = vi.fn(async () => undefined);
    let sonnetCalls = 0;
    const reservationInputs: Array<{ provider: string; inputTokensEstimate: number }> = [];
    const observer: ModelCallObserver = {
      beforeCall: vi.fn(async (call) => {
        reservationInputs.push(call);
        return `image-reservation-${reservationInputs.length}`;
      }),
      afterCall: vi.fn(async () => undefined),
    };
    providerState.stream.mockImplementation((target: Model<Api>, context: Context) => {
      expect(JSON.stringify(context.messages)).toContain(image.toString("base64"));
      if (target.provider === astra.provider)
        return stream(target, message(target, [], "error", "429 rate_limit_error"));
      if (++sonnetCalls === 1)
        return stream(
          target,
          message(
            target,
            [
              {
                type: "toolCall",
                id: "image-effect-once",
                name: "write_effect",
                arguments: { value: "once" },
              },
            ],
            "toolUse",
          ),
        );
      return stream(
        target,
        message(target, [{ type: "text", text: "Current image policy fits." }], "stop"),
      );
    });
    const events = await run(input, [], new PiAgentRuntime({ modelCallObserver: observer }));
    expect(
      providerState.stream.mock.calls.map(([target]) => (target as Model<Api>).provider),
    ).toEqual([astra.provider, sonnet.provider, sonnet.provider]);
    expect(input.onModelChange).toHaveBeenCalledExactlyOnceWith(
      sonnet.provider,
      sonnet.id,
      "fitting-vision",
    );
    expect(reservationInputs.map((call) => call.provider)).toEqual([
      astra.provider,
      sonnet.provider,
      sonnet.provider,
    ]);
    expect(reservationInputs[0]!.inputTokensEstimate).toBeGreaterThanOrEqual(19_661);
    for (const call of reservationInputs.slice(1)) {
      expect(call.inputTokensEstimate).toBeGreaterThanOrEqual(4784);
      expect(call.inputTokensEstimate).toBeLessThan(8000);
    }
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(providerState.delay).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "done", text: "Current image policy fits." });
  });

  it("recovers from an empty truncated completion without configured backups", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [], "error", "Stream ended without finish_reason")),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Recovered." }], "stop")),
      );
    const events = await run(request());
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Recovered." },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Recovered." });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000]);
  });

  it("recovers a helper completion without restarting the parent tool call", async () => {
    const input = request();
    input.tools.push({
      name: "run_subagent",
      description: "Run a fixture helper.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, task: { type: "string" } },
        required: ["name", "task"],
      },
      readOnly: true,
    });
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              {
                type: "toolCall",
                id: "helper-once",
                name: "run_subagent",
                arguments: { name: "helper", task: "Report the fixture." },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [], "error", "Stream ended without finish_reason")),
      )
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [{ type: "text", text: "Helper recovered." }], "stop")),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Parent complete." }], "stop")),
      );
    const events = await run(input);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        status: "completed",
        result: "Helper recovered.",
      }),
    );
    expect(events.at(-1)).toEqual({ type: "done", text: "Parent complete." });
    expect(providerState.stream).toHaveBeenCalledTimes(4);
    expect(vi.mocked(input.executeTool!).mock.calls.map(([name]) => name)).toEqual([
      "run_subagent",
    ]);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000]);
  });

  it("limits each completion to three retries and preserves the first eligible error", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [], "error", "HTTP 503 initial provider failure")),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [], "error", "HTTP 503 unavailable")),
      );
    await expect(run(request())).rejects.toThrow("HTTP 503 initial provider failure");
    expect(providerState.stream).toHaveBeenCalledTimes(4);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000, 8_000, 20_000]);
  });

  it("starts a fresh completion budget after one completed tool without replaying it", async () => {
    let calls = 0;
    providerState.stream.mockImplementation(() => {
      calls += 1;
      if (calls === 4)
        return stream(
          primary,
          message(
            primary,
            [
              {
                type: "toolCall",
                id: "effect-once",
                name: "write_effect",
                arguments: { value: "once" },
              },
            ],
            "toolUse",
          ),
        );
      if (calls === 8)
        return stream(primary, message(primary, [{ type: "text", text: "Saved once." }], "stop"));
      return stream(primary, message(primary, [], "error", "Stream ended without finish_reason"));
    });
    const input = request();
    const events = await run(input);
    expect(events.at(-1)).toEqual({ type: "done", text: "Saved once." });
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(providerState.stream).toHaveBeenCalledTimes(8);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([
      2_000, 8_000, 20_000, 2_000, 8_000, 20_000,
    ]);
    for (const call of providerState.stream.mock.calls.slice(4)) {
      expect((call[1] as Context).messages).toContainEqual(
        expect.objectContaining({ role: "toolResult", toolCallId: "effect-once" }),
      );
    }
  });

  it.each([
    "HTTP 401; 503 service unavailable",
    "HTTP 403; 429 rate limit",
    "invalid api key; terminated",
    "context_length_exceeded; 503 overloaded",
    "user declined consent; 429 rate limit",
    "Codex stream idle timeout",
    "HTTP 402 quota exhausted",
    "HTTP 429 insufficient_quota",
    "quota temporarily exceeded",
    "HTTP 429 insufficient credit balance",
    "HTTP 429 billing limit reached",
    "HTTP 429 usage limit reached",
    "HTTP 503 insufficient funds",
  ])("does not add same-model retries for %s", async (error) => {
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", error)),
    );
    await expect(run(request())).rejects.toThrow(error);
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it.each([
    "HTTP 408",
    "HTTP 504",
    "HTTP 402 quota exhausted",
    "HTTP 429 insufficient_quota",
    "quota temporarily exceeded",
  ])("preserves configured backup eligibility without same-model repeats for %s", async (error) => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(
        target,
        target.provider === primary.provider
          ? message(target, [], "error", error)
          : message(target, [{ type: "text", text: "Backup succeeds." }], "stop"),
      ),
    );
    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
    );
    expect(events.at(-1)).toEqual({ type: "done", text: "Backup succeeds." });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it("waits for every bounded delay before starting its next request", async () => {
    vi.useFakeTimers();
    const { abortableDelay } = await vi.importActual<typeof Core>("@rakazo/core");
    providerState.delay.mockImplementation(abortableDelay);
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", "429 rate limit")),
    );
    const outcome = run(request()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(providerState.stream).toHaveBeenCalledOnce();
    for (const [index, delay] of [2_000, 8_000, 20_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(providerState.stream).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(providerState.stream).toHaveBeenCalledTimes(index + 2);
    }
    expect(await outcome).toEqual(expect.objectContaining({ message: "429 rate limit" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["run", "turn"])(
    "cancels the %s during backoff without another model request",
    async (source) => {
      vi.useFakeTimers();
      const { abortableDelay } = await vi.importActual<typeof Core>("@rakazo/core");
      providerState.delay.mockImplementation(abortableDelay);
      providerState.stream.mockImplementation(() =>
        stream(primary, message(primary, [], "error", "429 rate limit")),
      );
      const controller = new AbortController();
      const events: AgentRuntimeEvent[] = [];
      const consume = async () => {
        for await (const event of new PiAgentRuntime().run(request(), {
          signal: controller.signal,
        }))
          events.push(event);
      };
      const outcome = consume().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(providerState.delay).toHaveBeenCalledOnce();
      if (source === "run") controller.abort();
      else providerState.agent?.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/abort|stop/i) }),
      );
      expect(providerState.stream).toHaveBeenCalledOnce();
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["text", "toolCall"])(
    "does not retry after a %s event even if the error loses its content",
    async (kind) => {
      const failure = message(primary, [], "error", "Stream ended without finish_reason");
      providerState.stream.mockImplementation(() => {
        const result = new AssistantMessageEventStream();
        const partial = message(primary, [], "stop");
        result.push({ type: "start", partial });
        if (kind === "toolCall") result.push({ type: "toolcall_start", contentIndex: 0, partial });
        else result.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
        result.push({ type: "error", reason: "error", error: failure });
        result.end(failure);
        return result;
      });
      const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
      await expect(run(input)).rejects.toThrow("Stream ended without finish_reason");
      expect(providerState.stream).toHaveBeenCalledOnce();
      expect(providerState.delay).not.toHaveBeenCalled();
      expect(input.executeTool).not.toHaveBeenCalled();
    },
  );

  it.each(["reservation", "accounting", "settlement"])(
    "does not retry a local %s failure that resembles a provider outage",
    async (phase) => {
      const input = request();
      const localError = new Error("503 local service unavailable");
      const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => {
        if (phase === "reservation") throw localError;
        return "reservation";
      });
      const afterCall = vi.fn<ModelCallObserver["afterCall"]>(async () => {
        if (phase === "settlement") throw localError;
      });
      if (phase === "accounting")
        input.onUsage = async () => {
          throw localError;
        };
      providerState.stream.mockImplementation(() =>
        stream(primary, message(primary, [], "error", "429 provider rate limit")),
      );
      await expect(
        run(input, [], new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall } })),
      ).rejects.toThrow("503 local service unavailable");
      expect(beforeCall).toHaveBeenCalledOnce();
      expect(providerState.stream).toHaveBeenCalledTimes(phase === "reservation" ? 0 : 1);
      expect(providerState.delay).not.toHaveBeenCalled();
    },
  );
});

describe("Pi runtime early connection timeout recovery", () => {
  it.each(["Request timed out.", "HTTP 408", "HTTP 504", "Connection error."])(
    "retries an early provider failure within the remaining budget: %s",
    async (failure) => {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      providerState.delay.mockImplementation(async (delay) => {
        now += delay;
      });
      providerState.stream
        .mockImplementationOnce(() => {
          now += 30_000;
          return stream(primary, message(primary, [], "error", failure));
        })
        .mockImplementation(() =>
          stream(primary, message(primary, [{ type: "text", text: "Recovered." }], "stop")),
        );
      const input = request();
      expect((await run(input)).at(-1)).toEqual({ type: "done", text: "Recovered." });
      expect(providerState.stream).toHaveBeenCalledTimes(2);
      expect(providerState.stream.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 120_000 });
      expect(providerState.stream.mock.calls[1]?.[2]).toMatchObject({ timeoutMs: 88_000 });
      expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000]);
      expect(input.executeTool).not.toHaveBeenCalled();
    },
  );

  it.each([118_000, 120_000, 180_000])(
    "does not start a retry with no budget after backoff at %dms",
    async (elapsed) => {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      providerState.stream.mockImplementation(() => {
        now += elapsed;
        return stream(primary, message(primary, [], "error", "Request timed out."));
      });
      await expect(run(request())).rejects.toThrow("Request timed out.");
      expect(providerState.stream).toHaveBeenCalledOnce();
      expect(providerState.delay).not.toHaveBeenCalled();
    },
  );

  it("rechecks the budget when backoff resumes after a long suspension", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    providerState.delay.mockImplementation(async () => {
      now += 130_000;
    });
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", "Connection error.")),
    );
    await expect(run(request())).rejects.toThrow("Connection error.");
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(providerState.delay).toHaveBeenCalledOnce();
  });

  it("keeps later attempts and their delays inside the first completion budget", async () => {
    let now = 10_000;
    let calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    providerState.delay.mockImplementation(async (delay) => {
      now += delay;
    });
    providerState.stream.mockImplementation(() => {
      now += [40_000, 50_000, 25_000][calls++] ?? 0;
      return stream(
        primary,
        message(
          primary,
          [],
          "error",
          calls === 1 ? "HTTP 503 first failure" : "Request timed out.",
        ),
      );
    });
    await expect(run(request())).rejects.toThrow("HTTP 503 first failure");
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(providerState.stream.mock.calls.map(([, , options]) => options.timeoutMs)).toEqual([
      120_000, 78_000, 20_000,
    ]);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([2_000, 8_000]);
  });
});

describe("Pi runtime ordered model fallback", () => {
  it.each(["absent", "empty"])(
    "passes the original stream options and terminal content through with %s backups",
    async (backups) => {
      const initialStream = new AssistantMessageEventStream();
      providerState.stream.mockReturnValue(initialStream);
      const input = request();
      if (backups === "absent") delete input.fallbackModels;
      const initialRun = run(input);
      await vi.waitFor(() => expect(providerState.stream).toHaveBeenCalledOnce());
      const agentOptions = providerState.agentOptions;
      if (!agentOptions) throw new Error("Agent was not created");
      expect(await agentOptions.getApiKey?.(primary.provider)).toBe("fake-primary-key");

      const upstream = new AssistantMessageEventStream();
      providerState.stream.mockReturnValue(upstream);
      const signal = new AbortController().signal;
      const options = {
        apiKey: "caller-key",
        reasoning: "high" as const,
        maxTokens: 123,
        timeoutMs: 456,
        maxRetries: 2,
        headers: { "x-fixture": "unchanged" },
        signal,
      };
      const response = await agentOptions.streamFn(
        primary,
        { messages: [] } as unknown as TranscriptContext,
        options,
      );
      const iterator = response[Symbol.asyncIterator]();
      const first = iterator.next();
      const failure = message(
        primary,
        [{ type: "text", text: "partial result" }],
        "error",
        "503 overloaded",
      );
      const start = { type: "start" as const, partial: { ...failure, content: [] } };
      upstream.push(start);
      let started = false;
      void first.then(() => {
        started = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(started).toBe(false);
      expect(providerState.stream.mock.lastCall?.[2]).toMatchObject(options);
      upstream.push({ type: "error", reason: "error", error: failure });
      upstream.end(failure);
      expect((await first).value).toBe(start);
      expect((await iterator.next()).value).toEqual({
        type: "error",
        reason: "error",
        error: failure,
      });
      expect(await response.result()).toBe(failure);
      const healthy = message(primary, [{ type: "text", text: "healthy" }], "stop");
      initialStream.push({ type: "done", reason: "stop", message: healthy });
      initialStream.end(healthy);
      await initialRun;
    },
  );

  it("preserves OAuth getApiKey behavior with no backup list", async () => {
    const input = request();
    delete input.fallbackModels;
    delete input.model.apiKey;
    input.model.oauth = {
      credential: {
        type: "oauth",
        access: "fake-user-access",
        refresh: "fake-user-refresh",
        expires: Date.now() + 60_000,
      },
    };
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [{ type: "text", text: "answer" }], "stop")),
    );
    await run(input);
    expect(await providerState.agentOptions?.getApiKey?.(primary.provider)).toBeUndefined();
    expect(providerState.stream.mock.lastCall?.[2]).toMatchObject({ apiKey: undefined });
  });

  it("skips a backup with no user credential even when a process key is set", async () => {
    const unconnected = model("openrouter", "unconnected", 16_384);
    providerState.models.set(
      `${unconnected.provider}/${unconnected.id}`,
      unconnected as unknown as Record<string, unknown>,
    );
    vi.stubEnv("OPENROUTER_API_KEY", "fake-process-key");
    try {
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        target.provider === primary.provider
          ? stream(target, message(target, [], "error", "429 rate limit"))
          : stream(target, message(target, [{ type: "text", text: "backup" }], "stop")),
      );
      await run(
        request([
          { provider: unconnected.provider, id: unconnected.id },
          { provider: backupB.provider, id: backupB.id, apiKey: "fake-user-backup-key" },
        ]),
      );
      expect(
        providerState.stream.mock.calls.map(
          ([target]) => (target as Model<"openai-completions">).provider,
        ),
      ).toEqual([primary.provider, backupB.provider]);
      expect(providerState.stream.mock.lastCall?.[2]).toMatchObject({
        apiKey: "fake-user-backup-key",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects diagnostic fallback tool growth before reserving or sending an oversized request", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "fixture-growth-backup-key" },
    ]);
    input.contextStrategy = "current";
    input.contextRestored = false;
    input.executeTool = vi.fn(async () => ({ payload: "0".repeat(20_000) }));
    const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => "growth-reservation");
    const afterCall = vi.fn<ModelCallObserver["afterCall"]>(async () => undefined);
    let backupCalls = 0;
    providerState.stream.mockImplementation((target: Model<Api>, context: Context) => {
      if (target.provider === primary.provider)
        return stream(target, message(target, [], "error", "HTTP 402 quota exhausted"));
      expect(target.id).toBe(backupA.id);
      if (++backupCalls > 1) throw new Error("Oversized fallback context reached the provider");
      const tokens = estimateModelContextTokens(context);
      expect(tokens + 4096 + Math.max(256, Math.ceil(tokens * 0.1))).toBeLessThan(8192);
      return stream(
        target,
        message(
          target,
          [
            {
              type: "toolCall",
              id: "diagnostic-growth-once",
              name: "write_effect",
              arguments: { value: "once" },
            },
          ],
          "toolUse",
        ),
      );
    });
    const failure = await run(
      input,
      [],
      new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall } }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect.soft(providerState.stream).toHaveBeenCalledTimes(2);
    expect.soft(input.executeTool).toHaveBeenCalledTimes(1);
    expect.soft(beforeCall).toHaveBeenCalledTimes(2);
    expect(failure).toMatchObject({
      message: expect.stringContaining("Required context exceeds"),
    });
  });

  it.each([false, true])(
    "bills configured model ids with switched=%s despite provider response ids",
    async (switched) => {
      const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => "reservation");
      const afterCall = vi.fn<ModelCallObserver["afterCall"]>(async () => undefined);
      const onUsage = vi.fn<NonNullable<AgentRunRequest["onUsage"]>>(async () => undefined);
      const input = request(
        switched ? [{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }] : [],
      );
      input.onUsage = onUsage;
      providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
        const failure = switched && target.provider === primary.provider;
        const result = message(
          target,
          failure ? [] : [{ type: "text", text: "answer" }],
          failure ? "error" : "stop",
          failure ? "429 rate limit" : undefined,
        );
        result.provider = "reported-provider";
        result.model = "reported-model";
        result.responseModel = "reported-model-2026-10-08";
        return stream(target, result);
      });
      const events = await run(
        input,
        [],
        new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall } }),
      );
      const targets = switched ? [primary, backupA] : [primary];
      expect(beforeCall.mock.calls.map(([call]) => call)).toEqual(
        targets.map((target) =>
          expect.objectContaining({ provider: target.provider, modelId: target.id }),
        ),
      );
      expect(onUsage.mock.calls.map(([event]) => event)).toEqual(
        targets.map((target) =>
          expect.objectContaining({
            provider: target.provider,
            model: target.id,
            inputTokens: 4,
            outputTokens: 2,
          }),
        ),
      );
      expect(afterCall).toHaveBeenCalledTimes(targets.length);
      expect(events.filter((event) => event.type === "usage")).toEqual(
        targets.map((target) =>
          expect.objectContaining({ provider: target.provider, model: target.id, accounted: true }),
        ),
      );
    },
  );

  it.each(["reservation", "accounting"])(
    "does not fail over on a local %s timeout",
    async (phase) => {
      const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
      const localError = new Error("503 local billing timeout");
      const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => {
        if (phase === "reservation") throw localError;
        return "reservation";
      });
      if (phase === "accounting")
        input.onUsage = async () => {
          throw localError;
        };
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        stream(target, message(target, [], "error", "429 provider rate limit")),
      );
      await expect(
        run(
          input,
          [],
          new PiAgentRuntime({
            modelCallObserver: { beforeCall, afterCall: async () => undefined },
          }),
        ),
      ).rejects.toThrow(/local billing timeout/);
      expect(providerState.stream).toHaveBeenCalledTimes(phase === "reservation" ? 0 : 1);
      expect(beforeCall).toHaveBeenCalledTimes(1);
    },
  );

  it("advances after a provider stream throws before output", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider === primary.provider) throw new Error("503 provider unavailable");
      return stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop"));
    });
    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
    );
    expect(events).toContainEqual({ type: "text", text: "backup answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("switches after a Codex idle timeout before output", async () => {
    vi.useFakeTimers();
    try {
      const codex = {
        ...primary,
        provider: "openai-codex",
        api: "openai-codex-responses" as const,
      };
      providerState.models.set(`${codex.provider}/${codex.id}`, codex);
      providerState.stream.mockImplementation(
        (
          target: Model<"openai-completions">,
          _ctx: unknown,
          options: {
            signal: AbortSignal;
            onResponse: (response: Response, model: Model<"openai-completions">) => void;
          },
        ) => {
          if (target.provider !== codex.provider)
            return stream(target, message(target, [{ type: "text", text: "recovered" }], "stop"));
          const result = new AssistantMessageEventStream();
          options.onResponse(new Response(null, { status: 200 }), target);
          options.signal.addEventListener("abort", () => {
            const failure = message(target, [], "aborted", "aborted");
            result.push({ type: "error", reason: "aborted", error: failure });
            result.end(failure);
          });
          return result;
        },
      );
      const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
      input.model.provider = codex.provider;
      const pending = run(input);
      await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS + 1);
      expect(await pending).toContainEqual({ type: "text", text: "recovered" });
      expect(providerState.stream).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records streamed content when the provider iterator throws after output", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "keep this text" }],
      "error",
      "503 timeout",
    );
    providerState.stream.mockImplementation(() => {
      class ThrowingStream extends AssistantMessageEventStream {
        override async *[Symbol.asyncIterator]() {
          yield { type: "start" as const, partial: { ...failure, content: [] } };
          yield {
            type: "text_delta" as const,
            contentIndex: 0,
            delta: "keep this text",
            partial: failure,
          };
          throw new Error("503 timeout");
        }
      }
      return new ThrowingStream();
    });
    const appendMessage = vi.fn(async () => undefined);
    vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
    const events: AgentRuntimeEvent[] = [];
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    input.reserveSelfRecovery = async () => false;
    await expect(
      run(input, events, new PiAgentRuntime({ sessionRoot: "fixture-sessions" })),
    ).rejects.toThrow(/503 timeout/);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: failure.content }),
    );
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("keep this text");
  });

  it("keeps terminal-only partial text even when usage accounting fails", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "terminal answer" }],
      "error",
      "503 unavailable",
    );
    providerState.stream.mockImplementation(() => stream(primary, failure));
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    input.onUsage = async () => {
      throw new Error("local accounting timeout");
    };
    const appendMessage = vi.fn(async () => undefined);
    vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
    const events: AgentRuntimeEvent[] = [];
    await expect(
      run(input, events, new PiAgentRuntime({ sessionRoot: "fixture-sessions" })),
    ).rejects.toThrow(/local accounting timeout/);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: failure.content }),
    );
    expect(events).toContainEqual({ type: "text", text: "terminal answer" });
  });

  it("continues after a long-retry 429 on a smaller backup without replaying a completed tool effect", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
    ]);
    const executeTool = vi.mocked(input.executeTool!);
    let primaryCalls = 0;
    let backupContext: { messages?: unknown[] } | undefined;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: { messages?: unknown[] }) => {
        if (target.provider === primary.provider) {
          primaryCalls += 1;
          if (primaryCalls === 1) {
            const call = {
              type: "toolCall" as const,
              id: "write-once",
              name: "write_effect",
              arguments: { value: "persist this once" },
            };
            return stream(target, message(target, [call], "toolUse"));
          }
          return stream(
            target,
            message(
              target,
              [],
              "error",
              "Server requested 3301s retry delay (max:60s). 429 rate_limit_error",
            ),
          );
        }
        backupContext = context;
        return stream(
          target,
          message(target, [{ type: "text", text: "Finished safely." }], "stop"),
        );
      },
    );

    const events = await run(input);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(primaryCalls).toBe(2);
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, primary.provider, backupA.provider]);
    expect(JSON.stringify(backupContext?.messages)).toContain("write-once");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text", text: "Finished safely." }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage", provider: backupA.provider, model: backupA.id }),
    );
  });

  it("keeps the primary on a healthy response and leaves an empty chain unchanged", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [{ type: "text", text: "Primary response." }], "stop")),
    );

    const events = await run(request());

    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(providerState.stream.mock.calls[0]?.[0]).toMatchObject({ provider: primary.provider });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage", provider: primary.provider, model: primary.id }),
    );
  });

  it("keeps helper-model selection on the active backup after the primary fails", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "backup-fixture-key" },
    ]);
    input.model.apiKey = "primary-fixture-key";
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a helper agent.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
        readOnly: true,
      },
    ];
    const providers: string[] = [];
    const apiKeys: Array<string | undefined> = [];
    let backupCalls = 0;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        providers.push(target.provider);
        apiKeys.push(options?.apiKey);
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        backupCalls += 1;
        if (backupCalls === 1) {
          return stream(
            target,
            message(
              target,
              [
                {
                  type: "toolCall",
                  id: "helper-call",
                  name: "run_subagent",
                  arguments: { name: "helper", task: "Summarize the fixture." },
                },
              ],
              "toolUse",
            ),
          );
        }
        return stream(target, message(target, [{ type: "text", text: "Complete." }], "stop"));
      },
    );

    await run(input);

    expect(providers).toEqual([
      primary.provider,
      backupA.provider,
      backupA.provider,
      backupA.provider,
    ]);
    expect(apiKeys).toEqual([
      "primary-fixture-key",
      "backup-fixture-key",
      "backup-fixture-key",
      "backup-fixture-key",
    ]);
  });

  it("keeps a refreshed backup OAuth token for later helper calls", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a helper agent.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
        readOnly: true,
      },
    ];
    input.resolveFallbackModel = vi.fn(async () => ({
      provider: backupA.provider,
      id: backupA.id,
      oauth: {
        credential: {
          type: "oauth" as const,
          access: "backup-access-before-refresh",
          refresh: "backup-refresh",
          expires: Date.now() + 60_000,
        },
      },
    }));
    const backupKeys: Array<string | undefined> = [];
    let backupCalls = 0;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        backupCalls += 1;
        backupKeys.push(options?.apiKey);
        if (backupCalls !== 1) {
          return stream(target, message(target, [{ type: "text", text: "Complete." }], "stop"));
        }
        const credentialStore = providerState.credentialStores[0] as CredentialStore;
        const response = message(
          target,
          [
            {
              type: "toolCall",
              id: "oauth-helper-call",
              name: "run_subagent",
              arguments: { name: "helper", task: "Summarize the fixture." },
            },
          ],
          "toolUse",
        );
        const output = new AssistantMessageEventStream();
        void (async () => {
          await credentialStore.modify(backupA.provider, async (current) => {
            if (current?.type !== "oauth") throw new Error("OAuth credential missing in fixture");
            return { ...current, access: "backup-access-after-refresh" };
          });
          for await (const event of stream(target, response)) output.push(event);
          output.end(response);
        })();
        return output;
      },
    );

    const events = await run(input);

    expect(backupKeys).toEqual([
      "backup-access-before-refresh",
      "backup-access-after-refresh",
      "backup-access-after-refresh",
    ]);
    expect(JSON.stringify(events)).not.toContain("backup-access-before-refresh");
    expect(JSON.stringify(events)).not.toContain("backup-access-after-refresh");
  });

  it("falls back between explicitly selected connections serving the same model id", async () => {
    const input = request([
      { provider: primary.provider, id: primary.id, modelCredentialId: "connection-b" },
    ]);
    input.model.modelCredentialId = "connection-a";
    input.resolveFallbackModel = vi.fn(async (provider, id, modelCredentialId) => ({
      provider,
      id,
      modelCredentialId,
      apiKey: "fake-backup-key",
    }));
    input.onModelChange = vi.fn(async () => undefined);
    const keys: Array<string | undefined> = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        keys.push(options?.apiKey);
        return options?.apiKey === "fake-primary-key"
          ? stream(target, message(target, [], "error", "429 rate_limit_error"))
          : stream(target, message(target, [{ type: "text", text: "backup response" }], "stop"));
      },
    );
    const events = await run(input);
    expect(input.resolveFallbackModel).toHaveBeenCalledExactlyOnceWith(
      primary.provider,
      primary.id,
      "connection-b",
    );
    expect(input.onModelChange).toHaveBeenCalledExactlyOnceWith(
      primary.provider,
      primary.id,
      "connection-b",
    );
    expect(keys).toContain("fake-primary-key");
    expect(keys.at(-1)).toBe("fake-backup-key");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text", text: "backup response" }),
    );
  });

  it("does not accept a resolver returning a different credential for an explicit backup", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, modelCredentialId: "selected-connection" },
    ]);
    input.resolveFallbackModel = vi.fn(async () => ({
      provider: backupA.provider,
      id: backupA.id,
      modelCredentialId: "wrong-connection",
      apiKey: "wrong-key",
    }));
    input.onModelChange = vi.fn(async () => undefined);
    const keys: Array<string | undefined> = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        keys.push(options?.apiKey);
        return stream(target, message(target, [], "error", "429 rate_limit_error"));
      },
    );
    await expect(run(input)).rejects.toThrow("429 rate_limit_error");
    expect(input.resolveFallbackModel).toHaveBeenCalledExactlyOnceWith(
      backupA.provider,
      backupA.id,
      "selected-connection",
    );
    expect(input.onModelChange).not.toHaveBeenCalled();
    expect(keys).not.toContain("wrong-key");
  });

  it("persists the selected model before streaming from the backup", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    let modelChangePersisted = false;
    input.onModelChange = vi.fn(async () => {
      await Promise.resolve();
      modelChangePersisted = true;
    });
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider === primary.provider) {
        return stream(target, message(target, [], "error", "429 rate_limit_error"));
      }
      expect(modelChangePersisted).toBe(true);
      return stream(target, message(target, [{ type: "text", text: "backup response" }], "stop"));
    });

    const events = await run(input);

    expect(input.onModelChange).toHaveBeenCalledExactlyOnceWith(backupA.provider, backupA.id);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "progress",
        text: expect.stringContaining(backupA.id),
      }),
    );
  });

  it.each([
    ["mcp__mail__read.events", { id: "record" }, false],
    ["connectors_execute_tool", { id: "mail-server:read", arguments: {} }, false],
    ["mcp__mail__read.events", { id: "record" }, true],
  ] as const)(
    "selects a backup without cropping a whole opted-in image result from %s %j (already read: %s)",
    async (name, args, alreadyRead) => {
      const input = request([
        {
          provider: backupA.provider,
          id: backupA.id,
          apiKey: "backup-a-key",
          maxImagesPerPrompt: 2,
        },
        {
          provider: backupB.provider,
          id: backupB.id,
          apiKey: "backup-b-key",
          maxImagesPerPrompt: 3,
        },
      ]);
      input.model = { ...input.model, maxImagesPerPrompt: 3 };
      input.verbatimMcpServers = { ids: ["mail-server"], slugs: ["mail"] };
      input.tools = [
        {
          name,
          description: "Read evidence images",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" }, arguments: { type: "object" } },
          },
          route: {
            connectorId: "mcp",
            toolName: "read",
            resourceId: "mail-server",
            catalogGroup: "mail",
            connectionId: "mail-connection",
          },
        },
      ];
      if (alreadyRead) input.tools.push(request().tools[0]!);
      const images = [0, 1, 2].map((index) => ({
        type: "image" as const,
        data: `synthetic-evidence-${index}`,
        mimeType: "image/png",
      }));
      const raw = {
        kind: "agent_tool_result" as const,
        content: [
          { type: "text" as const, text: JSON.stringify({ id: "exact-id", complete: true }) },
          ...images,
          { type: "text" as const, text: "Final original evidence block." },
        ],
        details: { frameId: "synthetic-frame" },
      };
      input.executeTool = vi.fn(async (toolName) => (toolName === name ? raw : { ok: true }));
      let primaryCalls = 0;
      const attempted: string[] = [];
      providerState.stream.mockImplementation(
        (target: Model<"openai-completions">, context: Context) => {
          attempted.push(target.provider);
          if (target.provider === primary.provider && ++primaryCalls === 1) {
            const offered =
              context.tools?.[0] ??
              context.messages.find((item) => item.role === "system")?.toolsAdded?.[0];
            if (!offered) throw new Error("Synthetic tool was not offered");
            return stream(
              target,
              message(
                target,
                [{ type: "toolCall", id: "evidence-once", name: offered.name, arguments: args }],
                "toolUse",
              ),
            );
          }
          if (target.provider === primary.provider && alreadyRead && primaryCalls === 2) {
            expect(countContextImages(context)).toBe(3);
            return stream(
              target,
              message(
                target,
                [
                  {
                    type: "toolCall",
                    id: "effect-once",
                    name: "write_effect",
                    arguments: { value: "once" },
                  },
                ],
                "toolUse",
              ),
            );
          }
          if (target.provider === primary.provider)
            return stream(target, message(target, [], "error", "HTTP 402 quota exhausted"));
          const result = context.messages.find(
            (item): item is Extract<Context["messages"][number], { role: "toolResult" }> =>
              item.role === "toolResult" && item.toolCallId === "evidence-once",
          );
          if (alreadyRead) {
            expect(result).toBeUndefined();
            expect(
              context.messages.some(
                (item) =>
                  item.role === "assistant" &&
                  item.content.some(
                    (part) => part.type === "toolCall" && part.id === "evidence-once",
                  ),
              ),
            ).toBe(false);
            expect(context.messages).toContainEqual(
              expect.objectContaining({ role: "toolResult", toolCallId: "effect-once" }),
            );
          } else {
            expect(result?.content.filter((part) => part.type === "image")).toEqual(images);
            expect(
              result?.content.filter(
                (part) => part.type !== "text" || !part.text.startsWith("[Automated message"),
              ),
            ).toEqual(raw.content);
          }
          return stream(
            target,
            message(target, [{ type: "text", text: "Evidence read." }], "stop"),
          );
        },
      );

      const events = await run(input);

      expect(attempted).toEqual(
        alreadyRead
          ? [primary.provider, primary.provider, primary.provider, backupA.provider]
          : [primary.provider, primary.provider, backupB.provider],
      );
      expect(input.executeTool).toHaveBeenCalledWith(
        name,
        args,
        expect.any(String),
        expect.any(Object),
        expect.any(Object),
      );
      expect(input.executeTool).toHaveBeenCalledTimes(alreadyRead ? 2 : 1);
      expect(providerState.delay).not.toHaveBeenCalled();
      expect(events.at(-1)).toEqual({ type: "done", text: "Evidence read." });
    },
  );

  it("keeps the configured output room when optional history moves to a backup", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "backup-key", maxTokens: 1024 },
    ]);
    input.model = { ...input.model, contextWindow: 8192, maxTokens: 1024 };
    input.history = Array.from({ length: 100 }, (_, index) => ({
      id: `old-${index}`,
      role: "user" as const,
      content: `Old message ${index} ${"filler ".repeat(80)}`,
    }));
    input.onModelChange = vi.fn();
    const caps: number[] = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: Context, options?: { maxTokens?: number }) => {
        caps.push(options?.maxTokens ?? 0);
        expect(JSON.stringify(context.messages)).toContain(input.prompt);
        return target.provider === primary.provider
          ? stream(target, message(target, [], "error", "HTTP 402 quota exhausted"))
          : stream(target, message(target, [{ type: "text", text: "Backup complete." }], "stop"));
      },
    );

    const events = await run(input);

    expect(caps).toEqual([1024, 1024]);
    expect(input.onModelChange).toHaveBeenCalledExactlyOnceWith(backupA.provider, backupA.id);
    expect(input.executeTool).not.toHaveBeenCalled();
    expect(providerState.delay).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "done", text: "Backup complete." });
  });

  it("prunes new screenshots using the active backup image limit", async () => {
    const visionBackup = { ...backupA, input: ["text", "image"] };
    providerState.models.set(`${backupA.provider}/${backupA.id}`, visionBackup);
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    input.resolveFallbackModel = async () => ({
      provider: backupA.provider,
      id: backupA.id,
      apiKey: "test-key",
      maxImagesPerPrompt: 1,
    });
    input.tools = [
      {
        name: "computer_observe",
        description: "Read the screen",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ];
    input.executeTool = vi.fn(async () => ({
      kind: "agent_tool_result",
      content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      details: { frameId: "test-frame" },
    }));
    let calls = 0;
    const counts: number[] = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: Context) => {
        if (target.provider === primary.provider)
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        for (const result of context.messages) {
          if (result.role !== "toolResult") continue;
          const text = result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          if (result.content.some((part) => part.type === "image")) {
            expect(text).toContain(
              "[Automated message from CogineBot, not from the user] Screenshot(s) returned by this tool call.",
            );
          } else expect(text).not.toContain("Screenshot(s) returned by this tool call.");
        }
        counts.push(
          context.messages.reduce(
            (total, item) =>
              total +
              (typeof item.content === "string"
                ? 0
                : item.content.filter((part) => part.type === "image").length),
            0,
          ),
        );
        calls += 1;
        return calls <= 2
          ? stream(
              target,
              message(
                target,
                [
                  {
                    type: "toolCall",
                    id: `frame-${calls}`,
                    name: "computer_observe",
                    arguments: {},
                  },
                ],
                "toolUse",
              ),
            )
          : stream(target, message(target, [{ type: "text", text: "Done" }], "stop"));
      },
    );
    await run(input);
    expect(counts).toEqual([0, 1, 1]);
    expect(input.executeTool).toHaveBeenCalledTimes(2);
  });

  it("preserves terminal partial text while refusing unsafe failover", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "partial answer" }],
      "error",
      "429 rate_limit_error",
    );
    providerState.stream.mockImplementation(() => stream(primary, failure));
    const events: AgentRuntimeEvent[] = [];
    await expect(run(request(), events)).rejects.toThrow(/429 rate_limit_error/);
    expect(events).toContainEqual({ type: "text", text: "partial answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "records streamed output and terminal suffixes with emptyTerminal=%s",
    async (emptyTerminal) => {
      const targetMessage = message(
        primary,
        [{ type: "text", text: "partial plus terminal suffix" }],
        "error",
        "429 rate_limit_error",
      );
      providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
        if (target.provider === primary.provider) {
          const result = new AssistantMessageEventStream();
          const partial = { ...targetMessage, content: [] };
          result.push({ type: "start", partial });
          result.push({ type: "text_start", contentIndex: 0, partial });
          result.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "partial",
            partial: { ...targetMessage, content: [{ type: "text", text: "partial" }] },
          });
          const terminal = emptyTerminal ? { ...targetMessage, content: [] } : targetMessage;
          result.push({ type: "error", reason: "error", error: terminal });
          result.end(terminal);
          return result;
        }
        return stream(target, message(target, [{ type: "text", text: "must not run" }], "stop"));
      });

      const appendMessage = vi.fn(async () => undefined);
      vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
      const events: AgentRuntimeEvent[] = [];
      await expect(
        run(
          request([{ provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" }]),
          events,
          new PiAgentRuntime({ sessionRoot: "fixture-sessions" }),
        ),
      ).rejects.toThrow(/429 rate_limit_error/);

      expect(providerState.stream).toHaveBeenCalledTimes(1);
      expect(appendMessage).toHaveBeenCalledWith(
        expect.objectContaining(
          emptyTerminal
            ? { ...targetMessage, content: [{ type: "text", text: "partial" }] }
            : targetMessage,
        ),
      );
      expect(
        events
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join(""),
      ).toBe(emptyTerminal ? "partial" : "partial plus terminal suffix");
    },
  );

  it("keeps terminal error text when nothing was streamed and does not switch", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "terminal partial" }],
      "error",
      "429 rate_limit_error",
    );
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, failure)
        : stream(target, message(target, [{ type: "text", text: "must not run" }], "stop")),
    );
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    const events: Array<{ type: string; text?: string }> = [];
    const runtime = new PiAgentRuntime();
    const consume = async () => {
      for await (const event of runtime.run(input, {
        operationId: "operation",
        traceId: "trace",
        spaceId: "space",
        userId: "user",
        signal: new AbortController().signal,
      })) {
        events.push(event);
      }
    };

    await expect(consume()).rejects.toThrow(/429 rate_limit_error/);

    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text", text: "terminal partial" }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "text", text: "must not run" }),
    );
  });

  it("prunes later screenshots with the active backup image limit", async () => {
    const input = request([
      {
        provider: backupA.provider,
        id: backupA.id,
        apiKey: "backup-key",
        maxImagesPerPrompt: 1,
      },
    ]);
    input.model = { ...input.model, maxImagesPerPrompt: 3 };
    input.tools = [
      {
        name: "computer_observe",
        description: "Observe the computer",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    let shots = 0;
    input.executeTool = vi.fn(async () => {
      shots += 1;
      return {
        kind: "agent_tool_result" as const,
        content: [
          { type: "text" as const, text: `frame ${shots}` },
          { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" as const },
        ],
        details: { frameId: `frame-${shots}` },
      };
    });
    const backupImageCounts: number[] = [];
    let backupCalls = 0;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: { messages?: unknown[] }) => {
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        backupCalls += 1;
        backupImageCounts.push(countContextImages(context));
        if (backupCalls <= 3) {
          const call = {
            type: "toolCall" as const,
            id: `observe-${backupCalls}`,
            name: "computer_observe",
            arguments: {},
          };
          return stream(target, message(target, [call], "toolUse"));
        }
        return stream(target, message(target, [{ type: "text", text: "done looking" }], "stop"));
      },
    );

    await run(input);

    expect(backupCalls).toBe(4);
    expect(backupImageCounts[0]).toBe(0);
    expect(backupImageCounts.at(-1)).toBe(1);
  });

  it.each(["thinking", "tool call"] as const)(
    "retries a transient terminal $0 cut only when no text or tool was exposed",
    async (kind) => {
      const content: AssistantMessage["content"] =
        kind === "thinking"
          ? [{ type: "thinking", thinking: "terminal reasoning" }]
          : [
              {
                type: "toolCall",
                id: "terminal-call",
                name: "write_effect",
                arguments: { value: "must not execute" },
              },
            ];
      const failure = message(primary, content, "error", "429 rate_limit_error");
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        target.provider === primary.provider
          ? stream(target, failure)
          : stream(target, message(target, [{ type: "text", text: "Backup answered." }], "stop")),
      );
      const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);

      if (kind === "thinking") {
        expect(await run(input)).toContainEqual({ type: "text", text: "Backup answered." });
        expect(providerState.stream).toHaveBeenCalledTimes(2);
      } else {
        await expect(run(input)).rejects.toThrow("429 rate_limit_error");
        expect(providerState.stream).toHaveBeenCalledOnce();
      }
      expect(input.executeTool).not.toHaveBeenCalled();
    },
  );

  it("does not switch because a tool failed", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
    ]);
    input.executeTool = vi.fn(async () => {
      throw new Error("tool permission denied");
    });
    let primaryCalls = 0;
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      primaryCalls += 1;
      if (primaryCalls === 1) {
        const call = {
          type: "toolCall" as const,
          id: "failed-tool",
          name: "write_effect",
          arguments: { value: "denied" },
        };
        return stream(target, message(target, [call], "toolUse"));
      }
      return stream(
        target,
        message(target, [{ type: "text", text: "The tool was denied." }], "stop"),
      );
    });

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, primary.provider]);
  });

  it("tries each backup in order, then retries the last model before surfacing exhaustion", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [], "error", "529 overloaded_error")),
    );

    await expect(
      run(
        request([
          { provider: primary.provider, id: primary.id, apiKey: "duplicate-primary" },
          { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
          { provider: backupA.provider, id: backupA.id, apiKey: "duplicate-backup" },
          { provider: backupB.provider, id: backupB.id, apiKey: "fake-backup-b" },
        ]),
      ),
    ).rejects.toThrow(/overloaded_error/);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupA.provider, ...Array<string>(4).fill(backupB.provider)]);
  });

  it("skips a backup that cannot fit the actual prompt and selects the next smaller-than-primary fit", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "small...key" },
      { provider: backupB.provider, id: backupB.id, apiKey: "fitti...key" },
    ]);
    input.prompt = "0".repeat(8_000);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "fit" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupB.provider]);
  });

  it("uses a small-context backup when the actual input and configured output fit", async () => {
    const smallContextBackup = model("provider-small", "small-context", 2_048);
    providerState.models.set(
      `${smallContextBackup.provider}/${smallContextBackup.id}`,
      smallContextBackup as unknown as Record<string, unknown>,
    );
    const input = request([
      {
        provider: smallContextBackup.provider,
        id: smallContextBackup.id,
        apiKey: "small...key",
        maxTokens: 512,
      },
    ]);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "fits" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, smallContextBackup.provider]);
  });

  it("leaves framing room by omitting optional history before accepting a small backup", async () => {
    const smallBackup = model("provider-small", "framing-fit", 2048);
    providerState.models.set(
      `${smallBackup.provider}/${smallBackup.id}`,
      smallBackup as unknown as Record<string, unknown>,
    );
    const input = request([
      { provider: smallBackup.provider, id: smallBackup.id, apiKey: "backup-key", maxTokens: 512 },
    ]);
    input.history = [{ id: "optional-old", role: "user", content: "0".repeat(1200) }];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: Context) => {
        if (target.provider === primary.provider)
          return stream(target, message(target, [], "error", "HTTP 402 quota exhausted"));
        const sent = JSON.stringify(context.messages);
        expect(sent).toContain(input.prompt);
        expect(sent).not.toContain("0".repeat(1200));
        return stream(target, message(target, [{ type: "text", text: "Framing fits." }], "stop"));
      },
    );

    const events = await run(input);

    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(input.executeTool).not.toHaveBeenCalled();
    expect(providerState.delay).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "done", text: "Framing fits." });
  });

  it.each([
    { window: 2048, api: "openai-completions" as const },
    { window: 8192, api: "openai-responses" as const },
  ])(
    "reserves the fallback input safety margin in the actual $window-token request",
    async ({ window, api }) => {
      const backup = { ...model("provider-margin", `margin-${window}`, window), api };
      providerState.models.set(
        `${backup.provider}/${backup.id}`,
        backup as unknown as Record<string, unknown>,
      );
      const input = request([
        { provider: backup.provider, id: backup.id, apiKey: "fixture-backup-key", maxTokens: 512 },
      ]);
      input.history = Array.from({ length: 60 }, (_, index) => ({
        id: `optional-${index}`,
        role: "user" as const,
        content: `optional-${index}: ${"0".repeat(400)}`,
      }));
      let backupCalls = 0;
      providerState.stream.mockImplementation((target: Model<Api>, context: Context) => {
        if (target.provider === primary.provider)
          return stream(target, message(target, [], "error", "HTTP 402 quota exhausted"));
        const tokens = estimateModelContextTokens(context);
        expect(tokens + 512 + Math.max(256, Math.ceil(tokens * 0.1))).toBeLessThan(window);
        expect(JSON.stringify(context.messages)).toContain(input.prompt);
        expect(JSON.stringify(context.messages)).not.toContain("optional-0:");
        if (++backupCalls === 1)
          return stream(
            target,
            message(
              target,
              [
                {
                  type: "toolCall",
                  id: "margin-effect-once",
                  name: "write_effect",
                  arguments: { value: "once" },
                },
              ],
              "toolUse",
            ),
          );
        expect(JSON.stringify(context.messages)).toContain('"ok":true');
        return stream(
          target,
          message(target, [{ type: "text", text: "Backup margin fits." }], "stop"),
        );
      });
      const events = await run(input);
      expect(providerState.stream).toHaveBeenCalledTimes(3);
      expect(input.executeTool).toHaveBeenCalledTimes(1);
      expect(providerState.delay).not.toHaveBeenCalled();
      expect(events.at(-1)).toEqual({ type: "done", text: "Backup margin fits." });
    },
  );

  it.each([false, true])(
    "preserves diagnostic history unless the trusted restored hint is set (%s)",
    async (contextRestored) => {
      const small = model("provider-diagnostic", "diagnostic-small", 2048);
      const large = model("provider-diagnostic-large", "diagnostic-large", 65_536);
      providerState.models.set(
        `${small.provider}/${small.id}`,
        small as unknown as Record<string, unknown>,
      );
      providerState.models.set(
        `${large.provider}/${large.id}`,
        large as unknown as Record<string, unknown>,
      );
      const input = request([
        { provider: small.provider, id: small.id, apiKey: "small-key", maxTokens: 512 },
        { provider: large.provider, id: large.id, apiKey: "large-key", maxTokens: 512 },
      ]);
      input.contextStrategy = "current";
      input.contextRestored = contextRestored;
      input.history = Array.from({ length: 60 }, (_, index) => ({
        id: `optional-${index}`,
        role: "user" as const,
        content: `optional-${index}: ${"0".repeat(400)}`,
      }));
      providerState.stream.mockImplementation((target: Model<Api>, context: Context) => {
        if (target.provider === primary.provider)
          return stream(target, message(target, [], "error", "HTTP 402 quota exhausted"));
        expect(target.id).toBe(contextRestored ? small.id : large.id);
        const tokens = estimateModelContextTokens(context);
        expect(tokens + 512 + Math.max(256, Math.ceil(tokens * 0.1))).toBeLessThan(
          target.contextWindow,
        );
        expect(JSON.stringify(context.messages).includes("optional-0:")).toBe(!contextRestored);
        return stream(
          target,
          message(target, [{ type: "text", text: "Diagnostic contract kept." }], "stop"),
        );
      });
      const events = await run(input);
      expect(providerState.stream).toHaveBeenCalledTimes(2);
      expect(input.executeTool).not.toHaveBeenCalled();
      expect(events.at(-1)).toEqual({ type: "done", text: "Diagnostic contract kept." });
    },
  );

  it("skips backups unable to meet their own explicit reasoning setting", async () => {
    const reasoningPrimary = { ...primary, reasoning: true };
    const textOnlyBackup = { ...backupA, reasoning: false };
    const reasoningBackup = { ...backupB, reasoning: true };
    providerState.models.set(`${primary.provider}/${primary.id}`, reasoningPrimary);
    providerState.models.set(`${backupA.provider}/${backupA.id}`, textOnlyBackup);
    providerState.models.set(`${backupB.provider}/${backupB.id}`, reasoningBackup);
    const input = request([
      {
        provider: backupA.provider,
        id: backupA.id,
        apiKey: "text-only-key",
        thinkingLevel: "high",
      },
      { provider: backupB.provider, id: backupB.id, apiKey: "reasoning-key", thinkingLevel: "low" },
    ]);
    input.model.reasoning = true;
    input.model.thinkingLevel = "high";
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "reasoned" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupB.provider]);
  });

  it.each([
    { reasoning: false, own: undefined, effective: "off" },
    { reasoning: true, own: "low", effective: "low" },
    { reasoning: true, own: "off", effective: "off" },
    { reasoning: true, own: undefined, effective: "medium" },
  ] as const)(
    "uses backup own thinking=$own reasoning=$reasoning for eligibility, Agent and both wire turns",
    async ({ reasoning, own, effective }) => {
      const reasoningPrimary = { ...primary, reasoning: true };
      const ownBackup = { ...backupA, reasoning };
      providerState.models.set(`${primary.provider}/${primary.id}`, reasoningPrimary);
      providerState.models.set(`${backupA.provider}/${backupA.id}`, ownBackup);
      const input = request([
        { provider: backupA.provider, id: backupA.id, apiKey: "backup-key", thinkingLevel: own },
      ]);
      input.model.reasoning = true;
      input.model.thinkingLevel = "high";
      let backupCalls = 0;
      providerState.stream.mockImplementation(
        (target: Model<Api>, _context: Context, options: { reasoning?: string }) => {
          if (target.provider === primary.provider)
            return stream(target, message(target, [], "error", "402 insufficient_quota"));
          backupCalls++;
          expect(options.reasoning).toBe(effective === "off" ? undefined : effective);
          expect(providerState.agent?.state.thinkingLevel).toBe(effective);
          return stream(
            target,
            message(
              target,
              backupCalls === 1
                ? [
                    {
                      type: "toolCall",
                      id: "own-thinking-write",
                      name: "write_effect",
                      arguments: { value: "one" },
                    },
                  ]
                : [{ type: "text", text: "Backup completed." }],
              backupCalls === 1 ? "toolUse" : "stop",
            ),
          );
        },
      );
      const events = await run(input);
      expect(providerState.stream).toHaveBeenCalledTimes(3);
      expect(backupCalls).toBe(2);
      expect(input.executeTool).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toEqual({ type: "done", text: "Backup completed." });
    },
  );

  it("resolves a legacy Azure backup without changing its credential identity or own thinking", async () => {
    const azure = { ...model("azure", "legacy-azure-backup", 16_384), reasoning: true };
    providerState.models.set("azure/legacy-azure-backup", azure);
    providerState.models.set(`${primary.provider}/${primary.id}`, { ...primary, reasoning: true });
    const input = request([
      { provider: "azure-openai-responses", id: azure.id, modelCredentialId: "azure-credential" },
    ]);
    input.model.thinkingLevel = "high";
    input.resolveFallbackModel = vi.fn(async () => ({
      provider: "azure-openai-responses",
      id: azure.id,
      modelCredentialId: "azure-credential",
      apiKey: "azure-account-key",
      thinkingLevel: "low" as const,
    }));
    let calls = 0;
    providerState.stream.mockImplementation(
      (target: Model<Api>, _context: Context, options: { reasoning?: string; apiKey?: string }) => {
        if (target.provider === primary.provider)
          return stream(target, message(target, [], "error", "402 insufficient_quota"));
        calls++;
        expect(target.provider).toBe("azure");
        expect(options.apiKey).toBe("azure-account-key");
        expect(options.reasoning).toBe("low");
        expect(providerState.agent?.state.thinkingLevel).toBe("low");
        return stream(
          target,
          message(
            target,
            calls === 1
              ? [
                  {
                    type: "toolCall",
                    id: "azure-write",
                    name: "write_effect",
                    arguments: { value: "approved" },
                  },
                ]
              : [{ type: "text", text: "Azure backup completed." }],
            calls === 1 ? "toolUse" : "stop",
          ),
        );
      },
    );
    const events = await run(input);
    expect(input.resolveFallbackModel).toHaveBeenCalledExactlyOnceWith(
      "azure-openai-responses",
      azure.id,
      "azure-credential",
    );
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ type: "done", text: "Azure backup completed." });
  });

  it.each([...IMAGE_RETURNING_COMPUTER_TOOLS, "write_effect"])(
    "requires image-capable backups only when %s can return screenshots",
    async (toolName) => {
      providerState.models.set(`${backupA.provider}/${backupA.id}`, {
        ...backupA,
        input: ["text"],
      });
      const input = request([
        { provider: backupA.provider, id: backupA.id, apiKey: "text-only-key" },
        { provider: backupB.provider, id: backupB.id, apiKey: "image-backup-key" },
      ]);
      input.tools = [{ ...input.tools[0]!, name: toolName }];
      providerState.stream.mockImplementation(
        (target: Model<"openai-completions">, context: Context) => {
          expect(countContextImages(context)).toBe(0);
          return target.provider === primary.provider
            ? stream(target, message(target, [], "error", "429 rate_limit_error"))
            : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop"));
        },
      );

      await run(input);

      expect(
        providerState.stream.mock.calls.map(
          ([target]) => (target as Model<"openai-completions">).provider,
        ),
      ).toEqual([
        primary.provider,
        IMAGE_RETURNING_COMPUTER_TOOLS.has(toolName) ? backupB.provider : backupA.provider,
      ]);
    },
  );

  it("skips backups that cannot accept the current image input", async () => {
    const textOnlyBackup = { ...backupA, input: ["text"] as ["text"] };
    providerState.models.set(`${backupA.provider}/${backupA.id}`, textOnlyBackup);
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "text-only-key" },
      { provider: backupB.provider, id: backupB.id, apiKey: "image-backup-key" },
    ]);
    input.currentTurnImages = [
      { name: "fixture.png", mimeType: "image/png", data: new Uint8Array([1]) },
    ];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "image understood" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupB.provider]);
  });

  it("does not persist or start a backup when cancellation wins during credential resolution", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    let releaseResolution: ((model: AgentRunRequest["model"]) => void) | undefined;
    input.resolveFallbackModel = vi.fn(
      () =>
        new Promise<AgentRunRequest["model"]>((resolve) => {
          releaseResolution = resolve;
        }),
    );
    const onModelChange = vi.fn(async () => undefined);
    input.onModelChange = onModelChange;
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(
        target,
        target.provider === primary.provider
          ? message(target, [], "error", "429 rate_limit_error")
          : message(target, [{ type: "text", text: "must not start" }], "stop"),
      ),
    );
    const controller = new AbortController();
    const runtime = new PiAgentRuntime();
    const consume = async () => {
      try {
        for await (const _event of runtime.run(input, {
          operationId: "operation",
          traceId: "trace",
          spaceId: "space",
          userId: "user",
          signal: controller.signal,
        })) {
          // Drain the runtime stream while cancellation is tested.
        }
      } catch {
        // Cancellation is surfaced as a stopped run by the outer runtime.
      }
    };
    const running = consume();
    await vi.waitFor(() => expect(input.resolveFallbackModel).toHaveBeenCalledOnce());
    controller.abort();
    releaseResolution?.({ provider: backupA.provider, id: backupA.id, apiKey: "test-backup-key" });
    await running;

    expect(onModelChange).not.toHaveBeenCalled();
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider]);
  });

  it("skips a backup with changed credentials and uses only the next backup's credential", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id },
      { provider: backupB.provider, id: backupB.id },
    ]);
    const resolveFallbackModel = vi.fn(async (provider: string, id: string) => {
      if (provider === backupA.provider) throw new Error("connected credential changed");
      return { provider, id, apiKey: "backup-only-key" };
    });
    input.resolveFallbackModel = resolveFallbackModel;
    const requestKeys: Array<string | undefined> = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        requestKeys.push(options?.apiKey);
        return stream(target, message(target, [{ type: "text", text: "safe" }], "stop"));
      },
    );

    const events = await run(input);

    expect(resolveFallbackModel).toHaveBeenNthCalledWith(1, backupA.provider, backupA.id);
    expect(resolveFallbackModel).toHaveBeenNthCalledWith(2, backupB.provider, backupB.id);
    expect(requestKeys).toEqual(["backup-only-key"]);
    expect(JSON.stringify(events)).not.toContain("backup-only-key");
  });
});

describe("provider availability classification", () => {
  it.each([
    [
      "HTTP 400 before retry text",
      { status: 400, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "HTTP 401 before retry text",
      { statusCode: 401, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "HTTP 403 before retry text",
      { httpStatus: 403, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "unprocessable input before retry text",
      { status: 422, message: "The request cannot be processed; 429 rate limit" },
      false,
    ],
    [
      "cancellation",
      new Error("user cancelled request; retry after 3301 seconds; 429 rate limit"),
      false,
    ],
    [
      "consent refusal",
      new Error("user declined consent; retry after 3301 seconds; 429 rate limit"),
      false,
    ],
    ["quota exhaustion", { status: 402, message: "provider quota exhausted" }, true],
    [
      "ChatGPT plan limit",
      { status: 429, message: "subscription_sharing_usage_limit_exceeded" },
      false,
    ],
    [
      "ChatGPT plan permission",
      { status: 429, message: "subscription_sharing_usage_unavailable" },
      false,
    ],
    ["plain status", new Error("503 provider unavailable"), true],
    ["HTTP server status", new Error("HTTP 500"), true],
    ["context overflow", new Error("context_length_exceeded; retry after 60s"), false],
    ["transient server failure", { status: 503, message: "service unavailable" }, true],
  ])("classifies %s", (_label, error, expected) => {
    expect(isRetryableProviderUnavailable(error)).toBe(expected);
  });
});

describe("Pi runtime signature recovery guards", () => {
  const mismatch = "Invalid signature in thinking block";

  it.each(["HTTP 400 insufficient_quota", "HTTP 402 billing_limit_exceeded"])(
    "does not repair signatures through %s",
    async (refusal) => {
      providerState.stream.mockImplementation(() =>
        stream(primary, message(primary, [], "error", `${refusal}: ${mismatch}`)),
      );
      await expect(run(request())).rejects.toThrow(/signature in thinking block/);
      expect(providerState.stream).toHaveBeenCalledOnce();
      expect(providerState.delay).not.toHaveBeenCalled();
    },
  );

  it("preserves a configured backup for a quota failure without retrying the primary signature", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(
            target,
            message(target, [], "error", `HTTP 402 billing_limit_exceeded: ${mismatch}`),
          )
        : stream(target, message(target, [{ type: "text", text: "Backup answered" }], "stop")),
    );
    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-key" }]),
    );
    expect(events.at(-1)).toEqual({ type: "done", text: "Backup answered" });
    expect(providerState.stream.mock.calls.map(([target]) => target.provider)).toEqual([
      primary.provider,
      backupA.provider,
    ]);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it.each([
    "HTTP 401 authentication_error",
    "HTTP 403 permission_error",
    "HTTP 400 invalid_api_key",
    "HTTP 400 subscription_sharing_usage_limit_exceeded",
    "HTTP 400 subscription_sharing_usage_unavailable",
  ])("keeps %s above signature repair and configured backups", async (refusal) => {
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", `${refusal}: ${mismatch}`)),
    );
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-key" },
    ]);
    await expect(run(input)).rejects.toThrow(/signature in thinking block/);
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(providerState.delay).not.toHaveBeenCalled();
    expect(input.executeTool).not.toHaveBeenCalled();
  });

  it.each([30_000, 120_000])(
    "keeps signature recovery inside the completion budget after %dms",
    async (elapsed) => {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      providerState.stream
        .mockImplementationOnce(() => {
          now += elapsed;
          return stream(primary, message(primary, [], "error", mismatch));
        })
        .mockImplementation(() =>
          stream(primary, message(primary, [{ type: "text", text: "Recovered" }], "stop")),
        );
      if (elapsed === 120_000) {
        await expect(run(request())).rejects.toThrow(mismatch);
        expect(providerState.stream).toHaveBeenCalledOnce();
      } else {
        await run(request());
        expect(providerState.stream.mock.calls[1]?.[2]).toMatchObject({ timeoutMs: 90_000 });
      }
      expect(providerState.delay).not.toHaveBeenCalled();
    },
  );

  it.each(["text", "thinking", "toolCall"])(
    "never restarts after partial %s output",
    async (kind) => {
      const failure = message(primary, [], "error", mismatch);
      providerState.stream.mockImplementation(() => {
        const result = new AssistantMessageEventStream();
        const partial = message(primary, [], "stop");
        result.push({ type: "start", partial });
        if (kind === "toolCall") result.push({ type: "toolcall_start", contentIndex: 0, partial });
        else if (kind === "thinking")
          result.push({ type: "thinking_delta", contentIndex: 0, delta: "partial", partial });
        else result.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
        result.push({ type: "error", reason: "error", error: failure });
        result.end(failure);
        return result;
      });
      const input = request();
      await expect(run(input)).rejects.toThrow(mismatch);
      expect(providerState.stream).toHaveBeenCalledOnce();
      expect(providerState.delay).not.toHaveBeenCalled();
      expect(input.executeTool).not.toHaveBeenCalled();
    },
  );

  it("does not strip context for a local accounting error with signature-like words", async () => {
    const input = request();
    input.onUsage = async () => {
      throw new Error(mismatch);
    };
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", mismatch)),
    );
    await expect(run(input)).rejects.toThrow(mismatch);
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it("passes an explicit transport through the main and helper completion", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("fixture"));
    const input = request();
    input.tools.push({
      name: "run_subagent",
      description: "Run a helper",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, task: { type: "string" } },
        required: ["name", "task"],
      },
      readOnly: true,
    });
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              {
                type: "toolCall",
                id: "helper-once",
                name: "run_subagent",
                arguments: { name: "helper", task: "Check fixture" },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [{ type: "text", text: "Helper done" }], "stop")),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Done" }], "stop")),
      );
    await run(input, [], new PiAgentRuntime({ modelFetch: transport }));
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    for (const [, , options] of providerState.stream.mock.calls) {
      expect(options.fetch).toEqual(expect.any(Function));
      await options.fetch("https://models.invalid/v1/responses");
    }
    expect(transport).toHaveBeenCalledTimes(3);
    expect(vi.mocked(input.executeTool!).mock.calls.map(([name]) => name)).toEqual([
      "run_subagent",
    ]);
  });
});

describe("Pi runtime thinking blocks bound to a different conversation", () => {
  const mismatch =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."}}';
  const thinkingParts = (context: Context) =>
    context.messages.flatMap((entry) =>
      entry.role === "assistant" ? entry.content.filter((part) => part.type === "thinking") : [],
    );

  it("omits the primary's thinking on a direct switch and keeps thinking written by the backup", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-key", maxTokens: 512 },
    ]);
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              {
                type: "thinking",
                thinking: "Primary plan",
                thinkingSignature: "primary-signature",
              },
              {
                type: "toolCall",
                id: "primary-write",
                name: "write_effect",
                arguments: { value: "a" },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [], "error", "429 rate_limit_error")),
      )
      .mockImplementationOnce(() =>
        stream(
          backupA,
          message(
            backupA,
            [
              { type: "thinking", thinking: "Backup plan", thinkingSignature: "backup-signature" },
              {
                type: "toolCall",
                id: "backup-write",
                name: "write_effect",
                arguments: { value: "b" },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementation(() =>
        stream(backupA, message(backupA, [{ type: "text", text: "Done." }], "stop")),
      );

    expect((await run(input)).at(-1)).toEqual({ type: "done", text: "Done." });
    const contexts = providerState.stream.mock.calls.map(([, context]) => context as Context);
    expect(contexts).toHaveLength(4);
    expect(thinkingParts(contexts[1]!)).toEqual([
      { type: "thinking", thinking: "Primary plan", thinkingSignature: "primary-signature" },
    ]);
    expect(thinkingParts(contexts[2]!)).toEqual([]);
    expect(thinkingParts(contexts[3]!)).toEqual([
      { type: "thinking", thinking: "Backup plan", thinkingSignature: "backup-signature" },
    ]);
    expect(JSON.stringify(contexts[3]!.messages.slice(0, contexts[2]!.messages.length))).toBe(
      JSON.stringify(contexts[2]!.messages),
    );
    expect(
      (input.executeTool as ReturnType<typeof vi.fn>).mock.calls.map(([, args]) => args),
    ).toEqual([{ value: "a" }, { value: "b" }]);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it("retries once without earlier thinking blocks and keeps dropping them for the run", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              { type: "thinking", thinking: "Plan the write.", thinkingSignature: "sig" },
              { type: "toolCall", id: "call-1", name: "write_effect", arguments: { value: "a" } },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() => stream(primary, message(primary, [], "error", mismatch)))
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [{ type: "toolCall", id: "call-2", name: "write_effect", arguments: { value: "b" } }],
            "toolUse",
          ),
        ),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Done." }], "stop")),
      );
    const input = request();
    const events = await run(input);
    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
    expect(input.executeTool).toHaveBeenCalledTimes(2);
    expect(
      (input.executeTool as ReturnType<typeof vi.fn>).mock.calls.map(([, args]) => args),
    ).toEqual([{ value: "a" }, { value: "b" }]);
    const contexts = providerState.stream.mock.calls.map(([, context]) => context as Context);
    expect(contexts).toHaveLength(4);
    expect(thinkingParts(contexts[1]!)).toHaveLength(1);
    expect(thinkingParts(contexts[2]!)).toEqual([]);
    expect(thinkingParts(contexts[3]!)).toEqual([]);
    expect(
      contexts[2]!.messages.some(
        (entry) =>
          entry.role === "assistant" && entry.content.some((part) => part.type === "toolCall"),
      ),
    ).toBe(true);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it("surfaces the error when the retry without thinking blocks fails the same way", async () => {
    providerState.stream.mockImplementation(() =>
      stream(primary, message(primary, [], "error", mismatch)),
    );
    await expect(run(request())).rejects.toThrow("bound to a different conversation");
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("uses a backup that fits only after discarded thinking blocks are omitted", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const thinking = "x".repeat(12_000);
    providerState.models.set(`${backupA.provider}/${backupA.id}`, {
      ...backupA,
      contextWindow: 3_000,
    });
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "small-backup-key", maxTokens: 512 },
    ]);
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              { type: "thinking", thinking, thinkingSignature: "sig" },
              { type: "toolCall", id: "call-1", name: "write_effect", arguments: { value: "a" } },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() => {
        now += 30_000;
        return stream(primary, message(primary, [], "error", mismatch));
      })
      .mockImplementation((target: Model<"openai-completions">) =>
        target.provider === primary.provider
          ? stream(target, message(target, [], "error", "429 rate_limit_error"))
          : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop")),
      );

    const events = await run(input);

    expect(events.at(-1)).toEqual({ type: "done", text: "backup answer" });
    expect(providerState.stream.mock.lastCall?.[2]).toMatchObject({ timeoutMs: 120_000 });
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, primary.provider, primary.provider, backupA.provider]);
    const contexts = providerState.stream.mock.calls.map(([, context]) => context as Context);
    expect(thinkingParts(contexts[1]!)).toHaveLength(1);
    expect(thinkingParts(contexts[2]!)).toEqual([]);
    expect(thinkingParts(contexts[3]!)).toEqual([]);
    expect(providerState.delay).not.toHaveBeenCalled();
  });
});

describe("Pi provider-reported budget recovery", () => {
  function router() {
    const target = model("openrouter", "synthetic-budget-target", 32_768);
    providerState.models.set(
      `${target.provider}/${target.id}`,
      target as unknown as Record<string, unknown>,
    );
    const input = request();
    input.model = {
      provider: target.provider,
      id: target.id,
      apiKey: "fake-budget-primary",
      modelCredentialId: "budget-primary",
      maxTokens: 1_024,
    };
    return { target, input };
  }

  function creditLimit(requested = 1_024, affordable = 256, context?: string) {
    return `402 ${JSON.stringify({
      error: {
        message: `This request requires more credits, or fewer max_tokens. You requested up to ${requested} tokens, but can only afford ${affordable}.`,
        metadata: { limit_source: "openrouter_credits", context },
      },
    })}`;
  }

  it("corrects a backup within the shared budget without carrying the primary cap", async () => {
    const { target, input } = router();
    const backup = {
      ...input.model,
      apiKey: "fake-budget-backup",
      modelCredentialId: "budget-backup",
      maxTokens: 768,
    };
    input.fallbackModels = [backup];
    input.resolveFallbackModel = vi.fn(async () => backup);
    input.onModelChange = vi.fn();
    providerState.stream
      .mockImplementationOnce(() => stream(target, message(target, [], "error", creditLimit())))
      .mockImplementationOnce(() =>
        stream(target, message(target, [], "error", "503 service unavailable")),
      )
      .mockImplementationOnce(() =>
        stream(target, message(target, [], "error", creditLimit(768, 192))),
      )
      .mockImplementation(() =>
        stream(target, message(target, [{ type: "text", text: "Backup answered." }], "stop")),
      );
    const events = await run(input);
    expect(events.at(-1)).toEqual({ type: "done", text: "Backup answered." });
    expect(providerState.stream.mock.calls.map(([, , options]) => options.maxTokens)).toEqual([
      1_024, 256, 768, 192,
    ]);
    expect(providerState.stream.mock.calls.map(([, , options]) => options.apiKey)).toEqual([
      "fake-budget-primary",
      "fake-budget-primary",
      "fake-budget-backup",
      "fake-budget-backup",
    ]);
    expect(
      providerState.stream.mock.calls.slice(1).map(([, , options]) => options.maxRetries),
    ).toEqual([0, 0, 0]);
    expect(input.onModelChange).toHaveBeenCalledExactlyOnceWith(
      target.provider,
      target.id,
      "budget-backup",
    );
    expect(providerState.delay).not.toHaveBeenCalled();
    expect(target.maxTokens).toBe(4_096);
    expect(input.model.maxTokens).toBe(1_024);
  });

  it("charges a corrective attempt to the shared completion retry allowance", async () => {
    const { target, input } = router();
    providerState.stream
      .mockImplementationOnce(() => stream(target, message(target, [], "error", creditLimit())))
      .mockImplementation(() =>
        stream(target, message(target, [], "error", "503 service unavailable")),
      );
    await expect(run(input)).rejects.toThrow("503 service unavailable");
    expect(providerState.stream.mock.calls.map(([, , options]) => options.maxTokens)).toEqual([
      1_024, 256, 256, 256,
    ]);
    expect(providerState.delay.mock.calls.map(([delay]) => delay)).toEqual([8_000, 20_000]);
  });

  it("uses the learned cap on the next completion without replaying the tool", async () => {
    const { target, input } = router();
    input.onModelChange = vi.fn();
    providerState.stream
      .mockImplementationOnce(() => stream(target, message(target, [], "error", creditLimit())))
      .mockImplementationOnce(() =>
        stream(
          target,
          message(
            target,
            [
              {
                type: "toolCall",
                id: "bounded-effect-once",
                name: "write_effect",
                arguments: { value: "once" },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementation(() =>
        stream(target, message(target, [{ type: "text", text: "Result saved." }], "stop")),
      );
    const events = await run(input);
    expect(events.at(-1)).toEqual({ type: "done", text: "Result saved." });
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(input.onModelChange).not.toHaveBeenCalled();
    expect(providerState.stream.mock.calls.map(([, , options]) => options.maxTokens)).toEqual([
      1_024, 256, 256,
    ]);
    expect((providerState.stream.mock.calls[2]![1] as Context).messages).toContainEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "bounded-effect-once" }),
    );
  });

  it("honors Stop while settling the rejected request before another dispatch", async () => {
    const { target, input } = router();
    const controller = new AbortController();
    const events: AgentRuntimeEvent[] = [];
    const runtime = new PiAgentRuntime({
      modelCallObserver: {
        beforeCall: vi.fn(async () => "first-reservation"),
        afterCall: vi.fn(async () => {
          controller.abort();
        }),
      },
    });
    providerState.stream.mockImplementation(() =>
      stream(target, message(target, [], "error", creditLimit())),
    );
    async function consume() {
      for await (const event of runtime.run(input, { signal: controller.signal }))
        events.push(event);
    }
    await expect(consume()).rejects.toThrow("can only afford 256");
    expect(controller.signal.aborted).toBe(true);
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("reauthorizes a corrective request and respects revocation before dispatch", async () => {
    const { target, input } = router();
    input.model.authorize = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("Model connection authorization denied"));
    providerState.stream.mockImplementation(() =>
      stream(target, message(target, [], "error", creditLimit())),
    );
    await expect(run(input)).rejects.toThrow("Model connection authorization denied");
    expect(input.model.authorize).toHaveBeenCalledTimes(2);
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it("keeps the original provider error when budget correction runs out of time", async () => {
    const { target, input } = router();
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    providerState.stream.mockImplementation(() =>
      stream(target, message(target, [], "error", creditLimit())),
    );
    const beforeCall = vi
      .fn()
      .mockResolvedValueOnce("first-reservation")
      .mockImplementationOnce(async () => {
        await Promise.resolve();
        now += 120_000;
        return "corrective-reservation";
      });
    const afterCall = vi.fn(async () => undefined);
    await expect(
      run(input, [], new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall } })),
    ).rejects.toThrow("can only afford 256");
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(afterCall.mock.calls[1]).toEqual(["corrective-reservation", null]);
  });

  it.each([
    { label: "provider authorization refusal", detail: "authorization denied" },
    { label: "partial assistant output", partial: true },
    { label: "local reservation failure", reservation: true },
  ])("does not correct the budget after $label", async ({ detail, partial, reservation }) => {
    const { target, input } = router();
    const rejection = creditLimit(1_024, 256, detail);
    const content: AssistantMessage["content"] = partial
      ? [{ type: "thinking", thinking: "Existing private work" }]
      : [];
    providerState.stream.mockImplementation(() =>
      stream(target, message(target, content, "error", rejection)),
    );
    const observer = reservation
      ? {
          beforeCall: vi.fn(async () => {
            throw new Error(rejection);
          }),
          afterCall: vi.fn(async () => undefined),
        }
      : undefined;
    await expect(
      run(input, [], new PiAgentRuntime({ modelCallObserver: observer })),
    ).rejects.toThrow("can only afford 256");
    expect(providerState.stream).toHaveBeenCalledTimes(reservation ? 0 : 1);
    expect(providerState.delay).not.toHaveBeenCalled();
  });

  it("does not dispatch when a reported window changes neither input nor output", async () => {
    const target = model("openai-compatible", "synthetic-window-target", 32_768);
    providerState.models.set(
      `${target.provider}/${target.id}`,
      target as unknown as Record<string, unknown>,
    );
    const input = request();
    input.model = {
      provider: target.provider,
      id: target.id,
      apiKey: "fake-window-key",
      maxTokens: 1_024,
    };
    providerState.stream.mockImplementation(() =>
      stream(target, message(target, [], "error", "400 maximum context length is 30000 tokens")),
    );
    await expect(run(input)).rejects.toThrow("leaves no smaller request to send");
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(providerState.delay).not.toHaveBeenCalled();
  });
});

describe("Pi runtime corrective dispatch deadlines", () => {
  const failures = [
    { label: "availability", message: "Connection error.", waitMs: 90_000 },
    { label: "signature", message: "Invalid signature in thinking block", waitMs: 91_000 },
  ];

  it.each(failures)(
    "does not dispatch $label recovery after an asynchronous reservation exhausts its budget",
    async ({ message: failure, waitMs }) => {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      providerState.delay.mockImplementation(async (delay) => {
        now += delay;
      });
      providerState.stream
        .mockImplementationOnce(() => {
          now += 30_000;
          return stream(primary, message(primary, [], "error", failure));
        })
        .mockImplementation(() =>
          stream(primary, message(primary, [{ type: "text", text: "Too late" }], "stop")),
        );
      let reservations = 0;
      const beforeCall = vi.fn(async () => {
        reservations += 1;
        if (reservations === 2) {
          await Promise.resolve();
          now += waitMs;
        }
        return `reservation-${reservations}`;
      });
      const afterCall = vi.fn(async () => undefined);
      const events: AgentRuntimeEvent[] = [];
      await expect(
        run(
          request(),
          events,
          new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall } }),
        ),
      ).rejects.toThrow(failure);
      expect(providerState.stream).toHaveBeenCalledOnce();
      expect(beforeCall).toHaveBeenCalledTimes(2);
      expect(afterCall).toHaveBeenCalledTimes(2);
      expect(afterCall.mock.calls[1]).toEqual(["reservation-2", null]);
      expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
    },
  );

  it("deducts reservation time and starts a new budget after a completed tool", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    providerState.delay.mockImplementation(async (delay) => {
      now += delay;
    });
    providerState.stream
      .mockImplementationOnce(() => {
        now += 30_000;
        return stream(primary, message(primary, [], "error", "Connection error."));
      })
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              {
                type: "toolCall",
                id: "effect-once",
                name: "write_effect",
                arguments: { value: "once" },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Done" }], "stop")),
      );
    let calls = 0;
    const beforeCall = async () => {
      if (++calls === 2) {
        await Promise.resolve();
        now += 40_000;
      }
      return `reservation-${calls}`;
    };
    const input = request();
    await run(
      input,
      [],
      new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall: vi.fn() } }),
    );
    expect(providerState.stream.mock.calls.map(([, , options]) => options.timeoutMs)).toEqual([
      120_000, 48_000, 120_000,
    ]);
    expect(input.executeTool).toHaveBeenCalledOnce();
    for (const [, , options] of providerState.stream.mock.calls) {
      expect(options).not.toHaveProperty("requestDeadline");
      expect(options).not.toHaveProperty("onRequestDeadlineExceeded");
    }
  });

  it("retains the first backup's header window after a slow reservation", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    providerState.stream
      .mockImplementationOnce(() => {
        now += 30_000;
        return stream(primary, message(primary, [], "error", "HTTP 503 unavailable"));
      })
      .mockImplementation(() =>
        stream(backupA, message(backupA, [{ type: "text", text: "Backup" }], "stop")),
      );
    let calls = 0;
    const beforeCall = async () => {
      if (++calls === 2) {
        await Promise.resolve();
        now += 130_000;
      }
      return `reservation-${calls}`;
    };
    await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "fixture-backup" }]),
      [],
      new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall: vi.fn() } }),
    );
    expect(providerState.stream).toHaveBeenCalledTimes(2);
    expect(providerState.stream.mock.calls[1]?.[2].timeoutMs).toBe(120_000);
  });

  it.each(["reservation", "settlement"])(
    "keeps a local %s failure above the original provider error",
    async (phase) => {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      providerState.delay.mockImplementation(async (delay) => {
        now += delay;
      });
      providerState.stream
        .mockImplementationOnce(() => {
          now += 30_000;
          return stream(primary, message(primary, [], "error", "Connection error."));
        })
        .mockImplementation(() =>
          stream(primary, message(primary, [], "error", "HTTP 503 unavailable")),
        );
      let calls = 0;
      const localError = new Error(`503 local ${phase} rejected`);
      const beforeCall = async () => {
        if (++calls === 2 && phase === "reservation") {
          now += 130_000;
          throw localError;
        }
        return `reservation-${calls}`;
      };
      const afterCall = vi.fn(async (id: string) => {
        if (id === "reservation-2" && phase === "settlement") throw localError;
      });
      await expect(
        run(request(), [], new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall } })),
      ).rejects.toThrow(localError);
      expect(providerState.stream).toHaveBeenCalledTimes(phase === "reservation" ? 1 : 2);
      expect(providerState.delay).toHaveBeenCalledOnce();
      expect(afterCall).toHaveBeenCalledTimes(phase === "reservation" ? 1 : 2);
    },
  );

  it("does not replace deadline termination with a secondary cleanup failure", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    providerState.delay.mockImplementation(async (delay) => {
      now += delay;
    });
    providerState.stream.mockImplementation(() => {
      now += 30_000;
      return stream(primary, message(primary, [], "error", "Connection error."));
    });
    let calls = 0;
    const beforeCall = async () => {
      if (++calls === 2) now += 90_000;
      return `reservation-${calls}`;
    };
    const afterCall = vi.fn(async (id: string) => {
      if (id === "reservation-2") throw new Error("Secondary cleanup failure");
    });
    await expect(
      run(request(), [], new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall } })),
    ).rejects.toThrow("Connection error.");
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(afterCall.mock.calls).toHaveLength(2);
    expect(afterCall.mock.calls[1]).toEqual(["reservation-2", null]);
  });

  it("gives cancellation priority when a late reservation completes", async () => {
    let now = 10_000;
    const controller = new AbortController();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    providerState.delay.mockImplementation(async (delay) => {
      now += delay;
    });
    providerState.stream.mockImplementation(() => {
      now += 30_000;
      return stream(primary, message(primary, [], "error", "Connection error."));
    });
    let calls = 0;
    const beforeCall = async () => {
      if (++calls === 2) {
        now += 90_000;
        controller.abort(new Error("Synthetic cancellation"));
      }
      return `reservation-${calls}`;
    };
    const afterCall = vi.fn();
    const operation = async () => {
      for await (const _event of new PiAgentRuntime({
        modelCallObserver: { beforeCall, afterCall },
      }).run(request(), { signal: controller.signal })) {
        /* Consume cancellation. */
      }
    };
    await operation().catch(() => undefined);
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(afterCall.mock.calls[1]).toEqual(["reservation-2", null]);
  });

  it("bounds a helper retry after reservation without replaying its parent call", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    providerState.delay.mockImplementation(async (delay) => {
      now += delay;
    });
    const input = request();
    input.tools.push({
      name: "run_subagent",
      description: "Run helper",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, task: { type: "string" } },
        required: ["name", "task"],
      },
      readOnly: true,
    });
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          primary,
          message(
            primary,
            [
              {
                type: "toolCall",
                id: "helper-once",
                name: "run_subagent",
                arguments: { name: "helper", task: "Report fixture" },
              },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() => {
        now += 30_000;
        return stream(primary, message(primary, [], "error", "Connection error."));
      })
      .mockImplementation(() =>
        stream(primary, message(primary, [{ type: "text", text: "Parent complete" }], "stop")),
      );
    let calls = 0;
    const beforeCall = async () => {
      if (++calls === 3) {
        await Promise.resolve();
        now += 90_000;
      }
      return `reservation-${calls}`;
    };
    const afterCall = vi.fn();
    const events = await run(
      input,
      [],
      new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall } }),
    );
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "subagent", status: "failed", result: "Connection error." }),
    );
    expect(afterCall.mock.calls[2]).toEqual(["reservation-3", null]);
    expect(providerState.stream.mock.calls[2]?.[2].timeoutMs).toBe(120_000);
    expect(vi.mocked(input.executeTool!).mock.calls.map(([name]) => name)).toEqual([
      "run_subagent",
    ]);
  });
});

describe("Pi current-call output recovery", () => {
  const cut = "The result is ready";
  const finished = "The result is ready for review.";
  const part = (text: string) => ({ type: "text" as const, text });
  const write = (id: string, value?: string): ToolCall => ({
    type: "toolCall",
    id,
    name: "write_effect",
    arguments: value === undefined ? {} : { value },
  });
  const visible = (events: AgentRuntimeEvent[]) =>
    events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join("");
  const reply = (text: string, stopReason: AssistantMessage["stopReason"] = "stop") =>
    stream(primary, message(primary, [part(text)], stopReason));

  function disconnected(text: string, error = "Stream ended without finish_reason", tool = false) {
    const result = new AssistantMessageEventStream();
    const partial = message(primary, [part(text)], "stop");
    const terminal = message(primary, [], "error", error);
    result.push({ type: "start", partial: { ...partial, content: [] } });
    result.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
    if (tool) result.push({ type: "toolcall_start", contentIndex: 1, partial });
    result.push({ type: "error", reason: "error", error: terminal });
    result.end(terminal);
    return result;
  }

  it.each(["connection", "limit"] as const)(
    "joins a %s cut with terminal-only continuation text after one completed tool",
    async (kind) => {
      const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
      input.resolveFallbackModel = vi.fn();
      input.reserveSelfRecovery = vi.fn(async () => true);
      providerState.stream
        .mockImplementationOnce(() =>
          stream(primary, message(primary, [write("complete", "once")], "toolUse")),
        )
        .mockImplementationOnce(() =>
          kind === "connection" ? disconnected(cut) : reply(cut, "length"),
        )
        .mockImplementationOnce(() => reply("ready for review."));
      const events = await run(input);

      expect(events.at(-1)).toEqual({ type: "done", text: finished });
      expect(visible(events)).toBe(finished);
      expect(input.executeTool).toHaveBeenCalledOnce();
      expect(input.reserveSelfRecovery).toHaveBeenCalledOnce();
      expect(input.resolveFallbackModel).not.toHaveBeenCalled();
      const context = providerState.stream.mock.calls[2]![1] as Context;
      expect(context.tools).toEqual([]);
      expect(context.messages).toContainEqual(
        expect.objectContaining({ role: "toolResult", toolCallId: "complete" }),
      );
      expect(JSON.stringify(context.messages.at(-1))).toContain("Automated message");
    },
  );

  it("keeps a partial reply and refuses a tool emitted during text-only recovery", async () => {
    const input = request();
    providerState.stream
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [write("complete", "once")], "toolUse")),
      )
      .mockImplementationOnce(() => disconnected(cut))
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [write("complete", "once")], "toolUse")),
      );
    const events: AgentRuntimeEvent[] = [];

    await expect(run(input, events)).rejects.toBeInstanceOf(ModelOutputRecoveryError);
    expect(visible(events)).toBe(cut);
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(providerState.stream).toHaveBeenCalledTimes(3);
  });

  it.each([
    { error: "401 invalid api key", tool: false },
    { error: "429 rate limit", tool: false },
    { error: "503 connection reset", tool: true },
  ])("does not continue after $error with pending tool output=$tool", async ({ error, tool }) => {
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    input.reserveSelfRecovery = vi.fn(async () => true);
    providerState.stream.mockImplementationOnce(() => disconnected(cut, error, tool));
    const events: AgentRuntimeEvent[] = [];

    await expect(run(input, events)).rejects.toThrow(error);
    expect(visible(events)).toBe(cut);
    expect(providerState.stream).toHaveBeenCalledOnce();
    expect(input.executeTool).not.toHaveBeenCalled();
    expect(input.reserveSelfRecovery).not.toHaveBeenCalled();
  });

  it("uses the single post-header time allowance for a genuine idle text continuation", async () => {
    vi.useFakeTimers();
    const input = request();
    input.reserveSelfRecovery = vi.fn(async () => true);
    providerState.stream
      .mockImplementationOnce((_target, _ctx, options) => {
        const result = new AssistantMessageEventStream();
        const partial = message(primary, [part(cut)], "stop");
        options.onResponse(new Response(null, { status: 200 }), primary);
        result.push({ type: "start", partial: { ...partial, content: [] } });
        result.push({ type: "text_delta", contentIndex: 0, delta: cut, partial });
        options.signal.addEventListener("abort", () => {
          const aborted = message(primary, partial.content, "aborted", "aborted");
          result.push({ type: "error", reason: "aborted", error: aborted });
          result.end(aborted);
        });
        return result;
      })
      .mockImplementationOnce(() => reply("ready for review."));
    const outcome = run(input);
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS + 1);

    expect(visible(await outcome)).toBe(finished);
    expect(input.reserveSelfRecovery).toHaveBeenCalledOnce();
    const options = providerState.stream.mock.calls[1]![2];
    expect(options.timeoutMs).toBeLessThanOrEqual(120_000);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.maxRetries).toBe(0);
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("retries an interrupted thinking-only call without exposing private reasoning", async () => {
    const input = request();
    input.reserveSelfRecovery = vi.fn(async () => true);
    providerState.stream
      .mockImplementationOnce(() => {
        const result = new AssistantMessageEventStream();
        const partial = message(primary, [{ type: "thinking", thinking: "private" }], "stop");
        const failure = message(primary, [], "error", "Stream ended without finish_reason");
        result.push({ type: "start", partial });
        result.push({ type: "thinking_delta", contentIndex: 0, delta: "private", partial });
        result.push({ type: "error", reason: "error", error: failure });
        result.end(failure);
        return result;
      })
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [write("completed-after-retry", "once")], "toolUse")),
      )
      .mockImplementationOnce(() => reply("Done."));
    expect(visible(await run(input))).toBe("Done.");
    expect(providerState.stream).toHaveBeenCalledTimes(3);
    const finalContext = providerState.stream.mock.calls[2]![1] as Context;
    expect(JSON.stringify(finalContext.messages)).not.toContain("private");
    expect(finalContext.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "completed-after-retry",
      }),
    );
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(input.reserveSelfRecovery).not.toHaveBeenCalled();
    expect(providerState.delay).toHaveBeenCalledOnce();
  });

  it("shares the original deadline while claiming recovery and does not dispatch after expiry", async () => {
    const input = request();
    let time = 100;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    input.reserveSelfRecovery = vi.fn(async () => {
      time += 120_001;
      return true;
    });
    providerState.stream.mockImplementationOnce(() => disconnected(cut));
    const events: AgentRuntimeEvent[] = [];

    await expect(run(input, events)).rejects.toThrow("Stream ended without finish_reason");
    expect(visible(events)).toBe(cut);
    expect(providerState.stream).toHaveBeenCalledOnce();
  });

  it("honors Stop while claiming a recovery slot", async () => {
    const controller = new AbortController();
    const input = request();
    input.reserveSelfRecovery = vi.fn(async () => {
      controller.abort();
      return true;
    });
    providerState.stream.mockImplementationOnce(() => disconnected(cut));
    async function consume() {
      for await (const _event of new PiAgentRuntime().run(input, { signal: controller.signal })) {
        // Drain the exact turn.
      }
    }

    await expect(consume()).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(providerState.stream).toHaveBeenCalledOnce();
  });

  it("fails the fourth truncation and keeps each distinct visible segment", async () => {
    const input = request();
    let attempts = 0;
    providerState.stream.mockImplementation(() => reply(`Segment ${++attempts}. `, "length"));
    const events: AgentRuntimeEvent[] = [];

    await expect(run(input, events)).rejects.toThrow("before finishing its reply");
    expect(visible(events)).toBe("Segment 1. Segment 2. Segment 3. Segment 4. ");
    expect(providerState.stream).toHaveBeenCalledTimes(4);
  });

  it("does not accept a repeated-only length continuation as a completed reply", async () => {
    providerState.stream
      .mockImplementationOnce(() => reply(cut, "length"))
      .mockImplementation(() => reply(cut));
    const events: AgentRuntimeEvent[] = [];

    await expect(run(request(), events)).rejects.toThrow("before finishing its reply");
    expect(visible(events)).toBe(cut);
    expect(providerState.stream).toHaveBeenCalledTimes(4);
  });

  it("regenerates a truncated tool batch in Pi without executing any of its original calls", async () => {
    const input = request();
    input.reserveSelfRecovery = vi.fn(async () => true);
    providerState.stream
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [write("old-a", "never"), write("old-b")], "length")),
      )
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [write("new-a", "once")], "toolUse")),
      )
      .mockImplementationOnce(() => reply("Saved once."));

    const events = await run(input);

    expect(visible(events)).toBe("Saved once.");
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(input.executeTool).toHaveBeenCalledWith(
      "write_effect",
      { value: "once" },
      JSON.stringify(["pi-tool", "main", "new-a"]),
      undefined,
      expect.anything(),
    );
    expect(input.reserveSelfRecovery).toHaveBeenCalledOnce();
    const retry = providerState.stream.mock.calls[1]![1] as Context;
    expect(retry.messages.filter((item) => item.role === "toolResult")).toEqual([
      expect.objectContaining({ toolCallId: "old-a", isError: true }),
      expect.objectContaining({ toolCallId: "old-b", isError: true }),
    ]);
  });

  it("fails if a truncated tool regeneration ends without a new call or reply", async () => {
    const input = request();
    providerState.stream
      .mockImplementationOnce(() => stream(primary, message(primary, [write("cut")], "length")))
      .mockImplementationOnce(() => reply(""));
    await expect(run(input)).rejects.toThrow("before writing a response");
    expect(input.executeTool).not.toHaveBeenCalled();
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("does not continue a length stop when tool events outlive a lost terminal tool block", async () => {
    const input = request();
    input.reserveSelfRecovery = vi.fn(async () => true);
    providerState.stream.mockImplementationOnce(() => {
      const result = new AssistantMessageEventStream();
      const terminal = message(primary, [part(cut)], "length");
      result.push({ type: "start", partial: { ...terminal, content: [] } });
      result.push({ type: "toolcall_start", contentIndex: 1, partial: terminal });
      result.push({ type: "done", reason: "length", message: terminal });
      result.end(terminal);
      return result;
    });
    const events: AgentRuntimeEvent[] = [];
    await expect(run(input, events)).rejects.toThrow("before finishing its reply");
    expect(visible(events)).toBe(cut);
    expect(input.reserveSelfRecovery).not.toHaveBeenCalled();
    expect(input.executeTool).not.toHaveBeenCalled();
    expect(providerState.stream).toHaveBeenCalledOnce();
  });

  it("refuses a completed call ID repeated during tool regeneration", async () => {
    const input = request();
    providerState.stream
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [write("complete", "once")], "toolUse")),
      )
      .mockImplementationOnce(() => stream(primary, message(primary, [write("cut")], "length")))
      .mockImplementationOnce(() =>
        stream(primary, message(primary, [write("complete", "once")], "toolUse")),
      );

    await expect(run(input)).rejects.toThrow("before finishing its reply");
    expect(input.executeTool).toHaveBeenCalledOnce();
    expect(providerState.stream).toHaveBeenCalledTimes(3);
  });

  it("repeats a thinking-only length stop with less thinking and the same operator cap", async () => {
    const target = {
      ...primary,
      reasoning: true,
      thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
    };
    providerState.models.set(`${primary.provider}/${primary.id}`, target);
    const input = request();
    input.model = { ...input.model, maxTokens: 1024, thinkingLevel: "high" };
    input.reserveSelfRecovery = vi.fn(async () => true);
    providerState.stream
      .mockImplementationOnce(() =>
        stream(target, message(target, [{ type: "thinking", thinking: "not visible" }], "length")),
      )
      .mockImplementationOnce(() => stream(target, message(target, [part("Done.")], "stop")));

    const events = await run(input);
    expect(visible(events)).toBe("Done.");
    expect(input.reserveSelfRecovery).toHaveBeenCalledOnce();
    expect(
      providerState.stream.mock.calls.map(([, , options]) => [
        options.maxTokens,
        options.reasoning,
      ]),
    ).toEqual([
      [1024, "high"],
      [1024, "medium"],
    ]);
  });

  it("does not resend a reasoning effort when the listed set already accepts it", async () => {
    const target = { ...primary, reasoning: true, thinkingLevelMap: { low: "low", high: "high" } };
    providerState.models.set(`${primary.provider}/${primary.id}`, target);
    const input = request();
    input.model.thinkingLevel = "high";
    providerState.stream.mockImplementation(() =>
      stream(
        target,
        message(target, [], "error", "400 reasoning_effort must be one of low, high."),
      ),
    );

    await expect(run(input)).rejects.toThrow("reasoning_effort must be one of low, high");
    expect(providerState.stream).toHaveBeenCalledOnce();
  });

  it("narrows an explicitly rejected reasoning effort once in the existing retry loop", async () => {
    const target = {
      ...primary,
      reasoning: true,
      thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
    };
    providerState.models.set(`${primary.provider}/${primary.id}`, target);
    const input = request();
    input.model.thinkingLevel = "high";
    input.reserveSelfRecovery = vi.fn(async () => true);
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          target,
          message(target, [], "error", "400 reasoning_effort must be one of low, medium."),
        ),
      )
      .mockImplementationOnce(() => stream(target, message(target, [part("Done.")], "stop")));

    expect(visible(await run(input))).toBe("Done.");
    expect(providerState.stream.mock.calls.map(([, , options]) => options.reasoning)).toEqual([
      "high",
      "medium",
    ]);
    expect(input.reserveSelfRecovery).not.toHaveBeenCalled();
  });
});
