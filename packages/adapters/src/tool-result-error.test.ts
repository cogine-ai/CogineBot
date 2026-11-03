import { describe, expect, it } from "vitest";
import { isFailedToolResult, toolResultError } from "./tool-result-error.js";

describe("tool result errors", () => {
  it("recognizes an error payload without changing the result", () => {
    const result = { error: { message: "Denied" }, value: "kept" };
    expect(isFailedToolResult(result)).toBe(true);
    expect(toolResultError(result)).toBe("Denied");
    expect(result).toEqual({ error: { message: "Denied" }, value: "kept" });
    expect(toolResultError({ error: false })).toBe(false);
    expect(toolResultError({ error: 0 })).toBe(0);
  });

  it("reads the original payload in Pi details", () => {
    const result = {
      content: [{ type: "text", text: "Bounded summary" }],
      details: { error: "Original failure" },
    };
    expect(toolResultError(result)).toBe("Original failure");
    expect(toolResultError({ details: { error: { code: "bad" } } })).toEqual({ code: "bad" });
  });

  it("joins MCP error text and ignores image and malformed parts", () => {
    const result = {
      details: {
        isError: true,
        content: [
          { type: "text", text: " First failure " },
          { type: "image", data: "ignored" },
          null,
          { type: "text", text: "Second failure" },
        ],
      },
    };
    expect(toolResultError(result)).toBe("First failure \nSecond failure");
  });

  it("supplies a failure reason for an MCP error with no text", () => {
    for (const content of [undefined, [], [{ type: "image", data: "ignored" }], [{ text: "  " }]]) {
      expect(toolResultError({ isError: true, content })).toBe("tool reported an error result");
    }
  });

  it("does not classify ordinary or absent payloads as failures", () => {
    for (const result of [
      undefined,
      null,
      false,
      "ok",
      {},
      { error: null },
      { error: undefined },
    ]) {
      expect(isFailedToolResult(result)).toBe(false);
      expect(toolResultError(result)).toBeUndefined();
    }
    expect(toolResultError({ isError: false, content: [{ text: "ok" }] })).toBeUndefined();
    expect(toolResultError({ isError: "true", content: [{ text: "ok" }] })).toBeUndefined();
  });
});
