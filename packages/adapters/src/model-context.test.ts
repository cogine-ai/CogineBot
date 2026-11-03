import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateContextTokens, providerContextPrefix } from "./context-selection.js";
import { estimateModelContextTokens, MODEL_CONTEXT_FRAMING_TOKENS } from "./model-context.js";

describe("provider input planning", () => {
  function fixture(): Context {
    return {
      systemPrompt: "Complete the task",
      tools: [],
      messages: [
        { role: "user", content: "Read evidence", timestamp: 1 },
        fauxAssistantMessage([{ type: "toolCall", id: "read", name: "read", arguments: {} }]),
        {
          role: "toolResult",
          toolCallId: "read",
          toolName: "read",
          content: [{ type: "text", text: "Bounded evidence" }],
          details: { original: "small" },
          isError: false,
          timestamp: 2,
        },
      ],
    };
  }
  it("counts provider content and framing while excluding local SDK and raw result metadata", () => {
    const context = fixture();
    const originalEstimate = estimateModelContextTokens(context);
    const result = context.messages[2]!;
    if (result.role !== "toolResult") throw new Error("Expected fixture result");
    result.details = {
      original: "😀".repeat(30000),
      historyReference: { toolResultId: "raw-result" },
    };
    const assistant = context.messages[1]!;
    if (assistant.role !== "assistant") throw new Error("Expected fixture assistant");
    assistant.model = "local-catalog-identity".repeat(1000);
    assistant.usage.input = 999999;
    const raw = structuredClone(context);
    expect(estimateModelContextTokens(context)).toBe(originalEstimate);
    expect(estimateModelContextTokens(context)).toBe(
      estimateContextTokens(
        providerContextPrefix(context.systemPrompt!, context.tools!, context.messages),
      ) + MODEL_CONTEXT_FRAMING_TOKENS,
    );
    expect(context).toEqual(raw);
  });
  it.each(["content", "arguments"] as const)(
    "still counts actual provider %s whose evidence field is named details",
    (where) => {
      const context = fixture();
      const originalEstimate = estimateModelContextTokens(context);
      const evidence = { details: "0123456789".repeat(500) };
      if (where === "content") {
        const result = context.messages[2]!;
        if (result.role !== "toolResult") throw new Error("Expected fixture result");
        result.content = [{ type: "text", text: JSON.stringify(evidence) }];
      } else
        context.messages[1] = fauxAssistantMessage([
          { type: "toolCall", id: "read", name: "read", arguments: evidence },
        ]);
      expect(estimateModelContextTokens(context)).toBeGreaterThan(originalEstimate + 4000);
    },
  );
});
