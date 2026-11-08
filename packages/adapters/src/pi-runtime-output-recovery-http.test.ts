import type { AgentRunRequest, AgentRuntimeEvent, ModelCallObserver } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";

const cutText = "The first sentence ends here. The second sentence begins";
const continuation = "The second sentence begins and completes the answer.";
const joinedText = `${cutText} and completes the answer.`;

function request(): AgentRunRequest {
  return {
    botId: "recovery-fixture-bot",
    threadId: "recovery-fixture-thread",
    runId: "recovery-fixture-run",
    prompt: "Write two sentences about the fixture.",
    instructions: "Answer briefly.",
    history: [],
    tools: [
      {
        name: "lookup_fixture",
        description: "Read a named fixture.",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ],
    model: {
      provider: "openai-compatible",
      id: "fixture-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "synthetic-fixture-key",
      contextWindow: 32_768,
      maxTokens: 1_024,
    },
  };
}

const sseHeaders = { "content-type": "text/event-stream" };

function frame(delta: Record<string, unknown>, finishReason: string | null) {
  return `data: ${JSON.stringify({
    id: "fixture-completion",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function reply(text: string, finishReason?: "stop" | "length" | "content_filter") {
  const textFrame = frame({ role: "assistant", content: text }, null);
  // A response that closes without its finish frame is a connection cut.
  const terminal = finishReason ? `${frame({}, finishReason)}data: [DONE]\n\n` : "";
  return new Response(textFrame + terminal, { headers: sseHeaders });
}

type WirePayload = {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  max_completion_tokens?: number;
  max_tokens?: number;
};

function captureRequests(responses: Response[]) {
  const payloads: WirePayload[] = [];
  const modelFetch: typeof fetch = async (input, init) => {
    payloads.push((await new Request(input, init).json()) as WirePayload);
    const response = responses[payloads.length - 1];
    if (!response) throw new Error("Unexpected extra model request");
    return response;
  };
  return { modelFetch, payloads };
}

async function run(
  runtime: PiAgentRuntime,
  input: AgentRunRequest,
  onEvent?: (event: AgentRuntimeEvent) => void,
  signal = AbortSignal.timeout(5_000),
) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(input, { signal })) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

describe("Pi output recovery through the HTTP provider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("Unexpected network request outside the synthetic transport");
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { reason: "connection cut", finishReason: undefined },
    { reason: "output limit", finishReason: "length" as const },
  ])(
    "joins an answer after a $reason with no tools in the continuation",
    async ({ finishReason }) => {
      const { modelFetch, payloads } = captureRequests([
        reply(cutText, finishReason),
        reply(continuation, "stop"),
      ]);
      const input = request();
      input.reserveSelfRecovery = vi.fn(async () => true);
      input.executeTool = vi.fn();

      const events = await run(new PiAgentRuntime({ modelFetch }), input);

      expect(payloads).toHaveLength(2);
      expect(payloads[0]?.tools).toContainEqual(
        expect.objectContaining({ function: expect.objectContaining({ name: "lookup_fixture" }) }),
      );
      expect(payloads[1]?.tools ?? []).toEqual([]);
      const continuedMessages = payloads[1]!.messages;
      expect(JSON.stringify(continuedMessages.find(({ role }) => role === "assistant"))).toContain(
        cutText,
      );
      expect(JSON.stringify(continuedMessages.at(-1))).toMatch(/continue/i);
      expect(input.reserveSelfRecovery).toHaveBeenCalledOnce();
      expect(input.executeTool).not.toHaveBeenCalled();
      expect(events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("")).toBe(
        joinedText,
      );
      expect(events.at(-1)).toEqual({ type: "done", text: joinedText });
    },
  );

  it("continues a reply after the SDK surfaces a terminated HTTP body", async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new TypeError("terminated"));
        } else {
          sent = true;
          controller.enqueue(
            new TextEncoder().encode(frame({ role: "assistant", content: cutText }, null)),
          );
        }
      },
    });
    const { modelFetch, payloads } = captureRequests([
      new Response(body, { headers: sseHeaders }),
      reply(continuation, "stop"),
    ]);
    const input = request();
    input.reserveSelfRecovery = vi.fn(async () => true);

    const events = await run(new PiAgentRuntime({ modelFetch }), input);

    expect(events.at(-1)).toEqual({ type: "done", text: joinedText });
    expect(events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("")).toBe(
      joinedText,
    );
    expect(payloads).toHaveLength(2);
    expect(payloads[1]?.tools ?? []).toEqual([]);
    expect(input.reserveSelfRecovery).toHaveBeenCalledOnce();
  });

  it("raises an unconfigured compatible model's output reservation on a length cut", async () => {
    const { modelFetch, payloads } = captureRequests([
      reply(cutText, "length"),
      reply(continuation, "stop"),
    ]);
    const input = request();
    input.model.contextWindow = 65_536;
    delete input.model.maxTokens;
    input.reserveSelfRecovery = vi.fn(async () => true);
    const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(() => "fixture-reservation");
    const modelCallObserver: ModelCallObserver = { beforeCall, afterCall: vi.fn() };

    const events = await run(new PiAgentRuntime({ modelFetch, modelCallObserver }), input);

    expect(payloads.map((body) => body.max_completion_tokens ?? body.max_tokens)).toEqual([
      4_096, 8_192,
    ]);
    expect(beforeCall.mock.calls.map(([call]) => call.maxOutputTokens)).toEqual([4_096, 8_192]);
    expect(input.reserveSelfRecovery).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ type: "done", text: joinedText });
  });

  it("omits a rejected OpenRouter off value without turning on reasoning", async () => {
    const finalText = "The fixture completed with reasoning off.";
    const { modelFetch, payloads } = captureRequests([
      Response.json(
        { error: { message: "Unsupported reasoning_effort: must be one of low, medium." } },
        { status: 400 },
      ),
      reply(finalText, "stop"),
    ]);
    const input = request();
    input.model = {
      provider: "openrouter",
      id: "fixture-unlisted-model",
      apiKey: "synthetic-fixture-key",
      contextWindow: 32_768,
      maxTokens: 1_024,
      thinkingLevel: "off",
    };
    input.reserveSelfRecovery = vi.fn(async () => true);

    const events = await run(new PiAgentRuntime({ modelFetch }), input);

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ reasoning: { effort: "none" } });
    expect(payloads[1]).not.toHaveProperty("reasoning");
    expect(payloads[1]).not.toHaveProperty("reasoning_effort");
    expect(payloads[1]?.messages).toEqual(payloads[0]?.messages);
    expect(input.reserveSelfRecovery).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "done", text: finalText });
  });

  it("carries a completed tool result through text recovery without executing it again", async () => {
    const toolCall = frame(
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "fixture-tool-call",
            type: "function",
            function: { name: "lookup_fixture", arguments: "{}" },
          },
        ],
      },
      "tool_calls",
    );
    const { modelFetch, payloads } = captureRequests([
      new Response(`${toolCall}data: [DONE]\n\n`, { headers: sseHeaders }),
      reply(cutText, "length"),
      reply(continuation, "stop"),
    ]);
    const input = request();
    const toolResult = "The fixture was already read.";
    input.executeTool = vi.fn(async () => ({ result: toolResult }));
    input.reserveSelfRecovery = vi.fn(async () => true);

    const events = await run(new PiAgentRuntime({ modelFetch }), input);

    expect(payloads).toHaveLength(3);
    expect(payloads[2]?.tools ?? []).toEqual([]);
    const completedResult = payloads[2]?.messages.filter(({ role }) => role === "tool");
    expect(completedResult).toHaveLength(1);
    expect(JSON.stringify(completedResult)).toContain(toolResult);
    expect(input.executeTool).toHaveBeenCalledExactlyOnceWith(
      "lookup_fixture",
      {},
      expect.any(String),
      undefined,
      expect.any(Object),
    );
    expect(input.reserveSelfRecovery).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ type: "done", text: joinedText });
  });

  it("keeps text received before Stop without making a continuation request", async () => {
    const modelFetch = vi.fn<typeof fetch>(async (input, init) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame({ content: cutText }, null)));
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        }),
        { headers: sseHeaders },
      );
    });
    const input = request();
    input.reserveSelfRecovery = vi.fn(async () => true);
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(5_000)]);
    const visible: string[] = [];
    await expect(
      run(
        new PiAgentRuntime({ modelFetch }),
        input,
        (event) => {
          if (event.type === "text") {
            visible.push(event.text);
            stop.abort();
          }
        },
        signal,
      ),
    ).rejects.toThrow(/aborted/i);

    expect(stop.signal.aborted).toBe(true);
    expect(visible.join("")).toBe(cutText);
    expect(modelFetch).toHaveBeenCalledOnce();
    expect(input.reserveSelfRecovery).not.toHaveBeenCalled();
  });

  it("does not turn a provider content refusal into a continuation", async () => {
    const modelFetch = vi.fn<typeof fetch>(async () => reply(cutText, "content_filter"));
    const input = request();
    input.reserveSelfRecovery = vi.fn(async () => true);
    const visible: string[] = [];

    await expect(
      run(new PiAgentRuntime({ modelFetch }), input, (event) => {
        if (event.type === "text") visible.push(event.text);
      }),
    ).rejects.toThrow("content_filter");
    expect(visible.join("")).toBe(cutText);
    expect(modelFetch).toHaveBeenCalledOnce();
    expect(input.reserveSelfRecovery).not.toHaveBeenCalled();
  });
});
