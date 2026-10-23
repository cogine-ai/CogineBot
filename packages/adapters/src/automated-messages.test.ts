import type { Context, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeContextPolicy } from "./runtime-context.js";

const model: Model<"openai-completions"> = {
  provider: "synthetic-provider",
  id: "synthetic-model",
  name: "Synthetic vision model",
  api: "openai-completions",
  baseUrl: "https://models.invalid/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 1024,
  compat: { requiresAssistantAfterToolResult: true },
};
const image = { type: "image" as const, data: "c3ludGhldGlj", mimeType: "image/png" };
const marker = "Attached image(s) from tool result:";
const label = "[Automated message from CogineBot, not from the user]";
const human = () => ({
  role: "user" as const,
  content: [{ type: "text" as const, text: marker }, { ...image }],
  timestamp: 1,
});
function fixture() {
  const context: Context = {
    systemPrompt: "Stable instructions",
    tools: [],
    messages: [
      human(),
      fauxAssistantMessage([
        { type: "toolCall", id: "capture|one", name: "computer_observe", arguments: {} },
        { type: "toolCall", id: "capture|two", name: "computer_observe", arguments: {} },
      ]),
      ...["capture|one", "capture|two"].map((toolCallId) => ({
        role: "toolResult" as const,
        toolCallId,
        toolName: "computer_observe",
        content: [{ type: "text" as const, text: "Captured screen" }, { ...image }],
        details: { retained: toolCallId },
        isError: toolCallId.endsWith("two"),
        timestamp: 2,
      })),
      human(),
    ],
  };
  const policy = createRuntimeContextPolicy({
    botId: "image-bot",
    threadId: "image-thread",
    runId: "image-run",
    instructions: context.systemPrompt!,
    prompt: marker,
    history: [],
    tools: [],
    contextStrategy: "current",
    model: { provider: model.provider, id: model.id },
  });
  return { context, policy };
}
type WireMessage = {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string }>;
};

describe("automated tool image provenance through the real SDK", () => {
  it("labels only typed tool results while preserving identical human images and the SDK marker", async () => {
    const { context, policy } = fixture();
    const raw = structuredClone(context);
    const prepared = policy.prepareContext(context, model);
    let messages: WireMessage[] = [];
    const onPayload = vi.fn(async (payload: unknown) => payload);
    const result = await streamSimple(model, normalizeContext(prepared), {
      apiKey: "fake-fixture-key",
      onPayload,
      fetch: async (_input, init) => {
        messages = JSON.parse(String(init?.body)).messages;
        return new Response(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    }).result();

    expect(result.errorMessage).toBeUndefined();
    expect(onPayload).toHaveBeenCalledTimes(1);
    const tools = messages.filter((message) => message.role === "tool");
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      expect(tool.content).toContain(`${label} Screenshot(s) returned by this tool call.`);
      expect(tool.content).toContain("Captured screen");
    }
    expect(tools.map((message) => message.tool_call_id)).toEqual(
      messages.find((message) => message.tool_calls)!.tool_calls!.map((call) => call.id),
    );
    expect(tools.map((message) => message.tool_call_id)).toEqual(["capture_one", "capture_two"]);
    const users = messages.filter((message) => message.role === "user");
    expect(users).toHaveLength(3);
    const humanWire = [
      { type: "text", text: marker },
      { type: "image_url", image_url: { url: "data:image/png;base64,c3ludGhldGlj" } },
    ];
    expect(users[0]!.content).toEqual(humanWire);
    expect(users[2]!.content).toEqual(humanWire);
    expect(users[1]!.content).toEqual([humanWire[0], humanWire[1], humanWire[1]]);
    expect(messages).toContainEqual({
      role: "assistant",
      content: "I have processed the tool results.",
    });
    expect(context).toEqual(raw);
    expect(prepared.messages.filter((message) => message.role === "toolResult")).toEqual([
      expect.objectContaining({
        toolCallId: "capture|one",
        details: { retained: "capture|one" },
        isError: false,
      }),
      expect.objectContaining({
        toolCallId: "capture|two",
        details: { retained: "capture|two" },
        isError: true,
      }),
    ]);
  });

  it.each(["undefined", "replacement", "error"] as const)(
    "preserves an existing asynchronous onPayload hook's %s behavior",
    async (behavior) => {
      const { context, policy } = fixture();
      const prepared = policy.prepareContext(context, model);
      const calls: string[] = [];
      let sent: { model: string } | undefined;
      const onPayload = vi.fn(async (payload: unknown) => {
        calls.push("hook:start");
        await Promise.resolve();
        calls.push("hook:end");
        if (behavior === "error") throw new Error("synthetic-hook-rejected");
        return behavior === "replacement"
          ? { ...(payload as object), model: "hook-replacement" }
          : undefined;
      });
      const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
        calls.push("fetch");
        sent = JSON.parse(String(init?.body));
        return new Response(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const result = await streamSimple(model, normalizeContext(prepared), {
        apiKey: "fake-fixture-key",
        onPayload,
        fetch,
      }).result();
      expect(onPayload).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(
        behavior === "error" ? ["hook:start", "hook:end"] : ["hook:start", "hook:end", "fetch"],
      );
      if (behavior === "error") {
        expect(result.errorMessage).toContain("synthetic-hook-rejected");
        expect(fetch).not.toHaveBeenCalled();
      } else {
        expect(result.errorMessage).toBeUndefined();
        expect(sent!.model).toBe(behavior === "replacement" ? "hook-replacement" : model.id);
        expect(JSON.stringify(sent)).toContain(label);
      }
    },
  );
});
