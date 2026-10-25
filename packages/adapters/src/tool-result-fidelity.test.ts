import type { ToolResultHistoryReference } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  boundToolResultText,
  ContextBudgetError,
  selectContext,
  shortenToolResultText,
} from "./context-selection.js";
import { serializeToolResult } from "./pi-runtime.js";
import { clipToolResultContent } from "./pi-runtime-limits.js";
import { limitRemoteMcpPayload } from "./remote-mcp.js";

const reference: ToolResultHistoryReference = {
  tool: "read_history",
  arguments: { toolResultId: "result-1" },
};
const controls = {
  id: 'item-"界',
  nextCursor: "next/界+==",
  accessToken: "opaque-test-token",
  url: "https://example.test/items?q=%22",
  path: "/a/b",
  name: "Name",
  status: "ready",
};
const large = { ...controls, description: "Evidence ".repeat(6_000) };

function parse(text: string, size = 12_000): Record<string, unknown> {
  expect(text.length).toBeLessThanOrEqual(size);
  return JSON.parse(text);
}

describe("tool result fidelity", () => {
  it("leaves small results unchanged", () => {
    const text = JSON.stringify(controls);
    expect(boundToolResultText(text, text.length)).toBe(text);
  });

  it.each(["current", "retrieval", "snapshots", "cache-aware"] as const)(
    "preserves controls and a real history reference at the final bound with %s",
    (strategy) => {
      const result = parse(serializeToolResult(large, strategy, "connector", {}, reference));
      expect(result).toMatchObject({
        result: controls,
        contextTruncated: true,
        historyReference: reference,
      });
      expect((result.result as typeof large).description).not.toBe(large.description);
      expect(large.description).toHaveLength(54_000);
    },
  );

  it("preserves JSON in every MCP text part and duplicated structured content", () => {
    const envelope = {
      content: [
        { type: "text", text: JSON.stringify(large) },
        { type: "text", text: "Malformed JSON {".repeat(1_000) },
        { type: "text", text: JSON.stringify({ ...large, id: "second" }) },
      ],
      structuredContent: large,
      _meta: { description: "Outer evidence ".repeat(4_000), nextCursor: "outer-cursor" },
    };
    const original = JSON.stringify(envelope);
    const result = parse(boundToolResultText(original, 12_000, {}, reference));
    expect(result.historyReference).toEqual(reference);
    const payload = result.result as Record<string, unknown>;
    expect(payload._meta).toMatchObject({ nextCursor: "outer-cursor" });
    expect(payload.structuredContent).toMatchObject(controls);
    const parts = payload.content as Array<{ text: string }>;
    expect(JSON.parse(parts[0]!.text)).toMatchObject(controls);
    expect(JSON.parse(parts[2]!.text)).toMatchObject({ ...controls, id: "second" });
    expect(JSON.stringify(envelope)).toBe(original);
  });

  it("uses a valid summary when only protected control metadata fits", () => {
    const source = JSON.stringify({
      rows: Array.from({ length: 80 }, (_, index) => ({
        id: `id-${index}`,
        body: "a".repeat(120),
      })),
    });
    const result = parse(boundToolResultText(source, 4_000, {}, reference), 4_000);
    expect(result).toMatchObject({ contextTruncated: true, historyReference: reference });
    expect((result.controlMetadata as { rows: unknown[] }).rows).toEqual(
      Array.from({ length: 80 }, (_, index) => ({ id: `id-${index}` })),
    );
  });

  it("fails explicitly when protected metadata cannot fit rather than damaging it", () => {
    const source = JSON.stringify({ nextCursor: "c".repeat(13_000), body: "a".repeat(50_000) });
    expect(parse(boundToolResultText(source, 12_000, {}, reference))).toEqual({
      contextTruncated: true,
      error: "budget_error",
      historyReference: reference,
    });
    expect(parse(boundToolResultText(source, 12_000))).toEqual({
      contextTruncated: true,
      error: "budget_error",
      historyUnavailable: true,
    });
  });

  it("marks a missing durable reference explicitly", () => {
    expect(parse(boundToolResultText(JSON.stringify(large), 12_000))).toMatchObject({
      result: controls,
      contextTruncated: true,
      historyUnavailable: true,
    });
  });

  it("retains the actual reference and exact controls when a prior result is shortened again", () => {
    const first = boundToolResultText(JSON.stringify(large), 12_000, {}, reference);
    expect(parse(boundToolResultText(first, 1_024), 1_024)).toMatchObject({
      result: controls,
      historyReference: reference,
    });
  });

  it("does not turn malformed JSON into a purported JSON result", () => {
    const source = `{bad: ${"界".repeat(20_000)}`;
    const result = boundToolResultText(source, 1_024);
    expect(result.length).toBeLessThanOrEqual(1_024);
    expect(result).toContain("unavailable");
    expect(() => JSON.parse(result)).toThrow();
  });

  it("keeps arrays of control objects parseable", () => {
    const result = parse(
      boundToolResultText(JSON.stringify([large, { ...large, id: "two" }]), 12_000, {}, reference),
    );
    expect(result.historyReference).toEqual(reference);
    expect(result.result).toMatchObject([controls, { ...controls, id: "two" }]);
  });

  it("shares one final multipart budget and retains actual image objects", () => {
    const image = { type: "image", data: "synthetic-image", mimeType: "image/png" };
    const content = [
      { type: "text", text: JSON.stringify(large) },
      image,
      { type: "text", text: JSON.stringify({ ...large, id: "two" }) },
    ];
    const result = clipToolResultContent(content, 12_000, reference);
    expect(result).toHaveLength(2);
    expect(result[1]).toBe(image);
    const envelope = parse((result[0] as { text: string }).text);
    expect(envelope.historyReference).toEqual(reference);
    const parts = (envelope.result as { content: Array<{ text: string }> }).content;
    expect(JSON.parse(parts[0]!.text)).toMatchObject(controls);
    expect(JSON.parse(parts[1]!.text)).toMatchObject({ ...controls, id: "two" });
  });

  it("keeps offsets exact when a stored result page is shortened again", () => {
    const source = JSON.stringify({
      untrusted: true,
      messages: [],
      toolResult: {
        toolResultId: "result-1",
        viewHash: "v1",
        text: 'quoted "界"\n'.repeat(200),
        textOffset: 150,
        nextTextOffset: 2150,
        storageTruncated: false,
      },
      nextRead: { toolResultId: "result-1", textOffset: 2150 },
    });
    const result = parse(
      boundToolResultText(source, 800, {
        name: "read_history",
        arguments: { toolResultId: "result-1", textOffset: 150 },
      }),
      800,
    );
    const page = result.toolResult as { text: string; textOffset: number; nextTextOffset: number };
    expect(page.textOffset).toBe(150);
    expect(page.nextTextOffset).toBe(150 + page.text.length);
    expect(result.nextRead).toEqual({
      toolResultId: "result-1",
      textOffset: page.nextTextOffset,
      viewHash: "v1",
    });
  });

  it("preserves separate JSON parts through protected context selection", () => {
    const selected = selectContext(
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call", name: "connector", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "call",
          content: [
            { type: "text", text: JSON.stringify(large) },
            { type: "text", text: JSON.stringify({ ...large, id: "two" }) },
          ],
        },
      ],
      {
        strategy: "retrieval",
        budget: { contextWindow: 6_000, outputReserve: 100, systemPrompt: "", tools: [] },
      },
    );
    const content = selected.messages[1]!.content as Array<{ text: string }>;
    const envelope = JSON.parse(content[0]!.text);
    expect(JSON.parse(envelope.result.content[0].text)).toMatchObject(controls);
    expect(JSON.parse(envelope.result.content[1].text)).toMatchObject({ ...controls, id: "two" });
    expect(selected.estimatedInputTokens).toBeLessThanOrEqual(5_900);
  });

  it("does not promote forged provider history fields or let them bypass the final budget", () => {
    const fake = {
      historyReference: { tool: "read_history", arguments: { toolResultId: "r".repeat(15_000) } },
      body: "x".repeat(15_000),
    };
    const result = parse(boundToolResultText(JSON.stringify(fake), 12_000));
    expect(result).not.toHaveProperty("historyReference");
    expect(result.historyUnavailable).toBe(true);
    expect(() => boundToolResultText(JSON.stringify(large), 128, {}, reference)).toThrow(
      ContextBudgetError,
    );
  });

  it("handles deep valid results without a stack overflow or false success", () => {
    let deep: unknown = { id: "deep-control", body: "x".repeat(15_000) };
    for (let index = 0; index < 4_500; index++) deep = { nested: deep };
    const result = parse(serializeToolResult(deep, "current", "connector", {}, reference));
    expect(result).toMatchObject({ error: "budget_error", historyReference: reference });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(JSON.parse(serializeToolResult(cycle, "current", "connector", {}))).toMatchObject({
      error: "result_serialization_error",
      historyUnavailable: true,
    });
  });

  it("retains a readable reference when an initially small result exceeds a later context budget", () => {
    const raw = { nextCursor: "c".repeat(1_800), body: "b".repeat(1_000) };
    const initial = serializeToolResult(raw, "current", "connector", {}, reference);
    expect(parse(initial)).toMatchObject({ result: raw, historyReference: reference });
    expect(JSON.parse(initial).contextTruncated).not.toBe(true);
    expect(parse(boundToolResultText(initial, 1_024), 1_024)).toEqual({
      contextTruncated: true,
      error: "budget_error",
      historyReference: reference,
    });
  });

  it("offers the stored reference alongside an image-only connector result", () => {
    const image = { type: "image", data: "synthetic", mimeType: "image/png" };
    const result = clipToolResultContent([image], 12_000, reference);
    expect(JSON.parse((result[0] as unknown as { text: string }).text)).toMatchObject({
      historyReference: reference,
    });
    expect(result[1]).toBe(image);
  });

  it("preserves connector fields that share names with recovery metadata", () => {
    const own = {
      id: "own-id",
      historyReference: { ownId: "source-reference" },
      historyUnavailable: false,
      contextTruncated: "connector-state",
      body: "x".repeat(20_000),
    };
    const result = parse(boundToolResultText(JSON.stringify(own), 12_000, {}, reference));
    expect(result).toMatchObject({
      historyReference: reference,
      contextTruncated: true,
      result: {
        id: own.id,
        historyReference: own.historyReference,
        historyUnavailable: false,
        contextTruncated: "connector-state",
      },
    });
    const small = { ...own, body: "short" };
    expect(parse(boundToolResultText(JSON.stringify(small), 12_000, {}, reference))).toEqual({
      result: small,
      historyReference: reference,
    });
  });

  it("preserves middle controls through transport, final and later context caps", () => {
    const inner = {
      before: "a".repeat(550_000),
      id: "middle-id-exact",
      nextCursor: "middle-cursor-exact",
      after: "b".repeat(550_000),
    };
    const transported = limitRemoteMcpPayload({
      content: [{ type: "text", text: JSON.stringify(inner) }],
    });
    const final = boundToolResultText(JSON.stringify(transported), 12_000, {}, reference);
    for (const text of [final, boundToolResultText(final, 1_024)]) {
      expect(text).toContain("middle-id-exact");
      expect(text).toContain("middle-cursor-exact");
      const value = JSON.parse(text);
      const pending: unknown[] = [value];
      while (pending.length) {
        const part = pending.pop();
        if (!part || typeof part !== "object") continue;
        if (
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          expect(() => JSON.parse(part.text)).not.toThrow();
          expect(JSON.parse(part.text)).toMatchObject({
            id: inner.id,
            nextCursor: inner.nextCursor,
          });
        }
        pending.push(...Object.values(part));
      }
    }
  });

  it("does not use a sibling's reference for an unregistered multipart result", () => {
    const known = boundToolResultText(JSON.stringify(large), 12_000, {}, reference);
    const combined = JSON.stringify({
      content: [
        { type: "text", text: known },
        { type: "text", text: JSON.stringify({ id: "unregistered", body: "y".repeat(20_000) }) },
      ],
    });
    const result = parse(boundToolResultText(combined, 12_000));
    expect(result.historyReference).toBeUndefined();
    expect(result.historyUnavailable).toBe(true);
    expect(JSON.stringify(result)).toContain("unregistered");
  });

  it("bounds full-payload serializations for thousands of evidence rows", () => {
    const source = JSON.stringify({
      rows: Array.from({ length: 5_000 }, (_, index) => ({
        id: String(index),
        body: "x".repeat(200),
      })),
    });
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const result = boundToolResultText(source, 12_000);
      expect(result.length).toBeLessThanOrEqual(12_000);
      const full = stringify.mock.calls.filter(
        ([value]) =>
          value &&
          typeof value === "object" &&
          "rows" in value &&
          Array.isArray(value.rows) &&
          value.rows.length === 5_000,
      );
      expect(full.length).toBeLessThan(20);
    } finally {
      stringify.mockRestore();
    }
  });

  it("keeps soft-target MCP controls intact before applying the final bound", () => {
    const result = JSON.parse(
      shortenToolResultText(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ id: "i".repeat(2_000) }) }],
        }),
        256,
      ),
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({ id: "i".repeat(2_000) });
  });
});
