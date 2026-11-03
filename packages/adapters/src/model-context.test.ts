import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateContextTokens, providerContextPrefix } from "./context-selection.js";
import {
  estimateModelContextTokens,
  fallbackContextSafetyMargin,
  MODEL_CONTEXT_FRAMING_TOKENS,
  maxFallbackInputTokens,
} from "./model-context.js";

// The original strict admission predicate is the independent oracle for both helpers.
const fallbackFits = (input: number, window: number, output: number) =>
  input + output + Math.max(256, Math.ceil(input * 0.1)) < window;

describe("fallback input capacity", () => {
  it("preserves the original minimum and ten-percent margin", () => {
    for (const input of [0, 1, 2559, 2560, 2561, 2570, 4096, 8192, 10001, 1_000_000]) {
      expect(fallbackContextSafetyMargin(input)).toBe(Math.max(256, Math.ceil(input * 0.1)));
    }
  });

  it("finds the last admitted integer through every small-window margin transition", () => {
    for (let remaining = 0; remaining <= 4096; remaining++) {
      const output = (remaining % 7) * 37;
      const window = output + remaining;
      const maximum = maxFallbackInputTokens(window, output);
      expect(Number.isInteger(maximum)).toBe(true);
      expect(maximum).toBeGreaterThanOrEqual(0);
      if (maximum > 0) expect(fallbackFits(maximum, window, output)).toBe(true);
      expect(fallbackFits(maximum + 1, window, output)).toBe(false);
    }
  });

  it.each([
    [8191, 1024],
    [8192, 2048],
    [8193, 2048],
    [9000, 4096],
    [9001, 4096],
    [16383, 4096],
    [16384, 4096],
    [16385, 4096],
    [128_000, 32_000],
    [131_071, 8192],
    [131_072, 8192],
    [1_000_000, 8192],
    [2 ** 40 + 1, 4096],
  ])("preserves the strict boundary at window=%i output=%i", (window, output) => {
    const maximum = maxFallbackInputTokens(window, output);
    expect(fallbackFits(maximum, window, output)).toBe(true);
    expect(fallbackFits(maximum + 1, window, output)).toBe(false);
  });

  it.each([1, 2559, 2560, 2561, 2570, 8192, 10001])(
    "rejects equality and admits the next window token for input=%i",
    (input) => {
      const output = 4096;
      const equalityWindow = input + output + Math.max(256, Math.ceil(input * 0.1));
      expect(fallbackFits(input, equalityWindow, output)).toBe(false);
      expect(maxFallbackInputTokens(equalityWindow, output)).toBeLessThan(input);
      expect(maxFallbackInputTokens(equalityWindow + 1, output)).toBe(input);
    },
  );

  it("returns zero for an unsatisfiable capacity without claiming zero input always fits", () => {
    expect(maxFallbackInputTokens(256, 0)).toBe(0);
    expect(fallbackFits(0, 256, 0)).toBe(false);
    expect(maxFallbackInputTokens(257, 0)).toBe(0);
    expect(fallbackFits(0, 257, 0)).toBe(true);
    expect(maxFallbackInputTokens(4096, 4096)).toBe(0);
    expect(maxFallbackInputTokens(4096, 8192)).toBe(0);
  });
});

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
