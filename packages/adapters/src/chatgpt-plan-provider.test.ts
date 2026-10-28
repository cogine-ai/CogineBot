import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { createModels, Type } from "@earendil-works/pi-ai";
import { normalizeRunError } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildPiChatGPTPlanModel,
  CHATGPT_PLAN_CATALOG_MODEL_ID,
  CHATGPT_PLAN_PROVIDER_ID,
  createChatGPTPlanFetch,
  discoverChatGPTPlanModels,
  registerChatGPTPlanCatalog,
  registerChatGPTPlanRuntime,
  sanitizeChatGPTPlanPayload,
} from "./chatgpt-plan-provider.js";

const descriptor = {
  id: "fixture-model",
  name: "Fixture model",
  contextWindow: 120_000,
  maxTokens: 8192,
};
const model = buildPiChatGPTPlanModel(descriptor);
const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
const usage = {
  input_tokens: 12,
  output_tokens: 3,
  total_tokens: 15,
  input_tokens_details: { cached_tokens: 2 },
};
const message = {
  type: "message",
  id: "msg_fixture",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [{ type: "output_text", text: "Hello", annotations: [] }],
};
const textEvents = [
  { type: "response.created", response: { id: "resp_fixture" } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...message, content: [], status: "in_progress" },
  },
  { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello" },
  { type: "response.output_item.done", output_index: 0, item: message },
];
const complete = {
  type: "response.completed",
  response: { id: "resp_fixture", status: "completed", output: [message], usage },
};

function sse(
  events: unknown[],
  options: { chunkSize?: number; contentType?: string } = {},
): Response {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.length, offset + (options.chunkSize ?? bytes.length));
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    }),
    { headers: { "content-type": options.contentType ?? "text/event-stream" } },
  );
}

function runtime() {
  return registerChatGPTPlanRuntime(createModels(), {
    models: [descriptor],
    auth: {
      apiKey: {
        name: "Fixture",
        resolve: async () => ({ auth: { apiKey: "fake-oauth-token" }, source: "fixture" }),
      },
    },
  });
}

describe("ChatGPT plan model catalog", () => {
  it("exposes a disconnected placeholder and only registers the selected account's models", async () => {
    const registry = registerChatGPTPlanCatalog(createModels());
    expect(
      registry.getModel(CHATGPT_PLAN_PROVIDER_ID, CHATGPT_PLAN_CATALOG_MODEL_ID),
    ).toBeDefined();
    expect(await registry.getAvailable(CHATGPT_PLAN_PROVIDER_ID)).toEqual([]);
    const placeholder = registry.getModel(CHATGPT_PLAN_PROVIDER_ID, CHATGPT_PLAN_CATALOG_MODEL_ID);
    const rejected = await registry.complete(placeholder!, context, { apiKey: "fake-token" });
    expect(rejected.stopReason).toBe("error");
    expect(rejected.errorMessage).toContain("not configured");
    registerChatGPTPlanRuntime(registry, { models: [descriptor] });
    expect(registry.getModels(CHATGPT_PLAN_PROVIDER_ID).map((entry) => entry.id)).toEqual([
      "fixture-model",
    ]);
    expect(
      registry.getModel(CHATGPT_PLAN_PROVIDER_ID, CHATGPT_PLAN_CATALOG_MODEL_ID),
    ).toBeUndefined();
    expect(model).toMatchObject({
      provider: "chatgpt-plan",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 120_000,
    });
  });

  it("discovers only visible account models, preserves order and explicit capabilities", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-token");
      expect(init?.redirect).toBe("error");
      return Response.json({
        models: [
          { slug: "hidden", display_name: "Hidden", visibility: "hide" },
          {
            slug: "visible-b",
            display_name: "Visible B",
            visibility: "list",
            context_window: 64000,
            max_output_tokens: 8000,
            reasoning: true,
            input_modalities: ["text", "image"],
          },
          { slug: "visible-a", display_name: "Visible A", visibility: "list" },
          { slug: "visible-b", display_name: "Duplicate", visibility: "list" },
        ],
      });
    });
    expect(await discoverChatGPTPlanModels("fake-token", { fetch })).toEqual([
      {
        id: "visible-b",
        name: "Visible B",
        contextWindow: 64000,
        maxTokens: 8000,
        reasoning: true,
        input: ["text", "image"],
      },
      { id: "visible-a", name: "Visible A", input: ["text"] },
    ]);
  });

  it("never substitutes a bundled catalog after malformed, oversized or empty account results", async () => {
    await expect(
      discoverChatGPTPlanModels("fake-token", {
        fetch: async () => Response.json({ data: [{ id: "fallback" }] }),
      }),
    ).rejects.toThrow(/catalog/);
    await expect(
      discoverChatGPTPlanModels("fake-token", {
        fetch: async () => Response.json({ models: Array.from({ length: 501 }, () => ({})) }),
      }),
    ).rejects.toThrow(/too many/);
    await expect(
      discoverChatGPTPlanModels("fake-token", {
        fetch: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
      }),
    ).rejects.toThrow(/too large/);
    expect(
      await discoverChatGPTPlanModels("fake-token", {
        fetch: async () => Response.json({ models: [] }),
      }),
    ).toEqual([]);
  });
});

describe("ChatGPT plan request boundary", () => {
  it("sanitizes final Pi payload after hooks and does not inherit API-key tenant headers", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer fake-oauth-token");
      expect(headers.get("openai-project")).toBeNull();
      expect(headers.get("openai-organization")).toBeNull();
      expect(init?.redirect).toBe("error");
      return sse([...textEvents, complete], { chunkSize: 7 });
    });
    const result = await runtime().complete(model, context, {
      fetch,
      temperature: 1,
      maxTokens: 100,
      headers: {
        authorization: "Bearer wrong-token",
        "openai-project": "wrong-project",
        "openai-organization": "wrong-org",
      },
      onPayload: (payload) => ({
        ...(payload as object),
        store: true,
        stream: false,
        input: [{ type: "message", role: "system", content: "Guide" }],
        max_output_tokens: 100,
        previous_response_id: "old",
        temperature: 2,
        metadata: { secret: "never" },
        top_p: 0.5,
        background: true,
      }),
    });
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toMatchObject([{ type: "text", text: "Hello" }]);
    expect(result.usage).toMatchObject({ input: 10, cacheRead: 2, output: 3 });
    expect(sent).toMatchObject({
      store: false,
      stream: true,
      input: [{ type: "message", role: "developer", content: "Guide" }],
    });
    for (const name of [
      "max_output_tokens",
      "previous_response_id",
      "temperature",
      "metadata",
      "top_p",
      "background",
    ])
      expect(sent).not.toHaveProperty(name);
  });

  it("blocks model host changes, credentials in URLs and redirects before forwarding tokens", async () => {
    const fetch = vi.fn(async () => sse([complete]));
    const boundary = createChatGPTPlanFetch(fetch, "fake-token");
    for (const url of [
      "https://other.example/v1/responses",
      "https://api.openai.com/backend-api/responses",
      "https://fake-token@api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses?token=fake-token",
    ]) {
      await expect(boundary(url, { method: "POST", body: "{}" })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
    const redirectFetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://other.example" } }),
    );
    await expect(
      createChatGPTPlanFetch(redirectFetch, "fake-token")("https://api.openai.com/v1/models"),
    ).rejects.toThrow(/redirects/);
  });

  it("rejects unsupported hosted tools rather than silently pretending to execute them", () => {
    for (const type of [
      "tool_search",
      "programmatic_tool_calling",
      "mcp",
      "computer",
      "image_generation",
      "file_search",
      "code_interpreter",
    ]) {
      expect(() => sanitizeChatGPTPlanPayload({ input: [], tools: [{ type }] })).toThrow(
        /not supported/,
      );
    }
    expect(() =>
      sanitizeChatGPTPlanPayload({
        input: [{ type: "additional_tools", tools: [{ type: "mcp" }] }],
      }),
    ).toThrow(/not supported/);
  });

  it("keeps safe structured usage-limit errors without leaking response text", async () => {
    const result = await runtime().complete(model, context, {
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "fake-secret request echo",
            },
          },
          { status: 429 },
        ),
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("subscription_sharing_usage_limit_exceeded");
    expect(normalizeRunError(result.errorMessage!)).toMatchObject({
      summary: "Your ChatGPT plan usage limit was reached. Review your usage settings.",
      action: "chatgpt-usage",
    });
    expect(result.errorMessage).not.toContain("fake-secret");
  });

  it("does not surface token-bearing transport diagnostics", async () => {
    const result = await runtime().complete(model, context, {
      fetch: async () => {
        throw new Error("Authorization: Bearer fake-sensitive-token");
      },
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toContain("fake-sensitive-token");
  });
});

describe("ChatGPT plan stream completion", () => {
  it("accepts SSE without a Content-Type but rejects malformed or non-SSE success", async () => {
    const noContentType = sse([...textEvents, complete]);
    noContentType.headers.delete("content-type");
    expect(
      (await runtime().complete(model, context, { fetch: async () => noContentType })).stopReason,
    ).toBe("stop");
    for (const response of [
      Response.json({ text: "not a stream" }),
      new Response("data: {broken\n\n", { headers: { "content-type": "text/event-stream" } }),
    ]) {
      expect(
        (await runtime().complete(model, context, { fetch: async () => response })).stopReason,
      ).toBe("error");
    }
  });

  it("cancels a partially consumed stream without promoting its text to success", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const events = runtime().stream(model, context, {
      signal: controller.signal,
      fetch: async (_input, init) => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(
                new TextEncoder().encode(
                  textEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
                ),
              );
              signal?.addEventListener("abort", () => stream.error(new Error("aborted")), {
                once: true,
              });
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const received: string[] = [];
    for await (const event of events) {
      received.push(event.type);
      if (event.type === "text_delta") controller.abort();
    }
    const result = await events.result();
    expect(received).toContain("text_delta");
    expect(received).not.toContain("done");
    expect(result.stopReason).toBe("aborted");
    expect(cancelled || controller.signal.aborted).toBe(true);
  });
  it.each([
    ["EOF", []],
    [
      "incomplete",
      [
        {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        },
      ],
    ],
    [
      "failed",
      [
        {
          type: "response.failed",
          response: {
            status: "failed",
            error: { code: "subscription_sharing_usage_unavailable", message: "fake-secret" },
          },
        },
      ],
    ],
    [
      "wrong completed status",
      [{ type: "response.completed", response: { status: "incomplete" } }],
    ],
  ])("fails on %s even after the final text item", async (_name, terminal) => {
    const result = await runtime().complete(model, context, {
      fetch: async () => sse([...textEvents, ...terminal]),
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toContain("fake-secret");
  });

  it("preserves namespaced function calls and tool-result history through the installed Pi parser", async () => {
    const tool = {
      type: "function_call",
      id: "fc_fixture",
      call_id: "call_fixture",
      name: "lookup",
      namespace: "coginebot",
      arguments: '{"query":"hello"}',
      status: "completed",
    };
    const registry = runtime();
    let firstBody: Record<string, unknown> | undefined;
    const first = await registry.complete(
      model,
      {
        ...context,
        tools: [
          {
            name: "lookup",
            description: "Lookup a fixture",
            parameters: Type.Object({ query: Type.String() }),
          },
        ],
      },
      {
        fetch: async (_input, init) => {
          firstBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return sse(
            [
              { type: "response.created", response: { id: "resp_tool" } },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...tool, arguments: "", status: "in_progress" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                delta: '{"query":"hello"}',
              },
              { type: "response.output_item.done", output_index: 0, item: tool },
              {
                type: "response.completed",
                response: { status: "completed", output: [tool], usage },
              },
            ],
            { chunkSize: 11 },
          );
        },
      },
    );
    expect(first.stopReason).toBe("toolUse");
    expect(firstBody?.tools).toMatchObject([
      {
        type: "namespace",
        name: "coginebot",
        description: "Tools executed by CogineBot.",
        tools: [{ type: "function", name: "lookup" }],
      },
    ]);
    const call = first.content.find((item) => item.type === "toolCall");
    expect(call).toMatchObject({
      type: "toolCall",
      name: "lookup",
      namespace: "coginebot",
      arguments: { query: "hello" },
    });
    if (call?.type !== "toolCall") throw new Error("Missing fixture tool call");
    let secondBody: Record<string, unknown> | undefined;
    const second = await registry.complete(
      model,
      {
        ...context,
        messages: [
          ...context.messages,
          first as AssistantMessage,
          {
            role: "toolResult",
            toolCallId: call.id,
            toolName: "lookup",
            content: [{ type: "text", text: "fixture result" }],
            isError: false,
            timestamp: 2,
          },
        ],
      },
      {
        fetch: async (_input, init) => {
          secondBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return sse([...textEvents, complete]);
        },
      },
    );
    expect(second.stopReason).toBe("stop");
    expect(secondBody?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call", name: "lookup", namespace: "coginebot" }),
        expect.objectContaining({
          type: "function_call_output",
          output: expect.stringContaining("fixture result"),
        }),
      ]),
    );
  });
});
