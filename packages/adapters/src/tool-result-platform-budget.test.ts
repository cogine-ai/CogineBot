import type { ToolResultHistoryReference } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { boundToolResultText } from "./context-selection.js";
import { serializeToolResult } from "./pi-runtime.js";

const reference: ToolResultHistoryReference = {
  tool: "read_history",
  arguments: { toolResultId: "stored-deep-result" },
};

describe("platform-independent result budget failures", () => {
  it("bounds deeply nested valid JSON without relying on native stringify stack depth", () => {
    const source = `${'{"nested":'.repeat(4_500)}${JSON.stringify({ id: "deep-id", body: "x".repeat(15_000) })}${"}".repeat(4_500)}`;
    const text = boundToolResultText(source, 12_000, {}, reference);
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(JSON.parse(text)).toMatchObject({
      contextTruncated: true,
      error: "budget_error",
      historyReference: reference,
    });
  });

  it.each([reference, { ...reference, arguments: { toolResultId: "x".repeat(15_000) } }])(
    "keeps a validated recovery reference when the native serializer exhausts its stack",
    (candidate) => {
      const raw = { id: "deep-result" };
      const nativeStringify = JSON.stringify;
      const spy = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
        if (value === raw) throw new RangeError("Maximum call stack size exceeded");
        return nativeStringify(value);
      });
      try {
        const text = serializeToolResult(raw, "current", "connector", {}, candidate);
        expect(text.length).toBeLessThanOrEqual(12_000);
        const result = JSON.parse(text);
        expect(result).toMatchObject({ contextTruncated: true, error: "budget_error" });
        if (candidate === reference) expect(result.historyReference).toEqual(reference);
        else expect(result).toMatchObject({ historyUnavailable: true });
      } finally {
        spy.mockRestore();
      }
    },
  );
});
