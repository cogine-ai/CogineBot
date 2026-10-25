import { describe, expect, it } from "vitest";
import { HistoryReadInputSchema, HistorySearchInputSchema } from "./history.js";

describe("history read references", () => {
  it("retains message reads and accepts exclusive paged result references", () => {
    expect(HistoryReadInputSchema.parse({ messageId: "message", limit: 1 })).toEqual({
      messageId: "message",
      limit: 1,
    });
    expect(
      HistoryReadInputSchema.parse({
        toolResultId: "result",
        textOffset: 2000,
        viewHash: "a".repeat(64),
      }),
    ).toEqual({
      toolResultId: "result",
      textOffset: 2000,
      viewHash: "a".repeat(64),
    });
  });
  it.each([
    {},
    { messageId: "message", toolResultId: "result" },
    { toolResultId: "result", linkedRunId: "run" },
    { toolResultId: "result", direction: "older" },
    { toolResultId: "result", limit: 1 },
    { toolResultId: "result", textOffset: -1 },
    { toolResultId: "result", textOffset: 1 },
    { toolResultId: "result", viewHash: "invalid" },
    { messageId: "message", viewHash: "a".repeat(64) },
  ])("rejects mixed or invalid result navigation %j", (input) => {
    expect(HistoryReadInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("history date boundaries", () => {
  it.each([
    ["2026-01-01", "2026-01-01T00:00:00.000Z"],
    ["2024-02-29", "2024-02-29T00:00:00.000Z"],
    ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z"],
    ["2026-01-01T00:00:00+02:00", "2025-12-31T22:00:00.000Z"],
    ["2026-01-01T00:00:00-05:30", "2026-01-01T05:30:00.000Z"],
  ])("normalizes %s without changing the intended instant", (input, expected) => {
    expect(
      HistorySearchInputSchema.parse({ query: "Aurora", before: input, after: input }),
    ).toMatchObject({ before: expected, after: expected });
  });
  it.each([
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-02-29T00:00:00Z",
    "2026-01-01T00:00:00",
    "2026-01-01T00:00:00+25:00",
    "January 1, 2026",
  ])("rejects invalid or ambiguous boundary %s", (value) => {
    for (const field of ["before", "after"])
      expect(HistorySearchInputSchema.safeParse({ query: "Aurora", [field]: value }).success).toBe(
        false,
      );
  });
});
