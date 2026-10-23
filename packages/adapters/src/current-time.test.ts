import { describe, expect, it } from "vitest";
import { formatCurrentTimeInstruction } from "./current-time.js";

describe("formatCurrentTimeInstruction", () => {
  it("anchors the present moment in UTC with the weekday and no sub-second noise", () => {
    const line = formatCurrentTimeInstruction(new Date("2026-09-17T14:55:41.123Z"));
    expect(line).toContain("Current date and time: Thursday, 2026-09-17T14:55:41Z (UTC).");
    expect(line).not.toContain(".123");
  });

  it("tells the model not to guess the date from training data or quoted timestamps", () => {
    const line = formatCurrentTimeInstruction(new Date("2026-01-01T00:00:00Z"));
    expect(line).toContain("Never infer today's date from your training data");
    expect(line).toContain("write absolute dates");
  });

  it("anchors the user's local wall clock and the same UTC instant", () => {
    const line = formatCurrentTimeInstruction(new Date("2026-10-20T00:00:00Z"), "Asia/Taipei");
    expect(line).toContain("Tuesday, 2026-10-20 08:00 (UTC+08:00) (Asia/Taipei)");
    expect(line).toContain("2026-10-20T00:00:00Z (UTC)");
  });

  it("uses the offset at the actual instant across a daylight-saving transition", () => {
    const before = formatCurrentTimeInstruction(
      new Date("2026-11-01T05:30:00Z"),
      "America/New_York",
    );
    const after = formatCurrentTimeInstruction(
      new Date("2026-11-01T06:30:00Z"),
      "America/New_York",
    );
    expect(before).toContain("2026-11-01 01:30 (UTC-04:00)");
    expect(after).toContain("2026-11-01 01:30 (UTC-05:00)");
    expect(after).toContain("2026-11-01T06:30:00Z (UTC)");
  });

  it("formats non-hour offsets and falls back safely for missing or invalid zones", () => {
    const now = new Date("2026-10-20T00:00:00Z");
    expect(formatCurrentTimeInstruction(now, "Asia/Kolkata")).toContain(
      "2026-10-20 05:30 (UTC+05:30)",
    );
    const utc = formatCurrentTimeInstruction(now);
    expect(formatCurrentTimeInstruction(now, null)).toBe(utc);
    expect(formatCurrentTimeInstruction(now, "Invalid/Zone")).toBe(utc);
    expect(formatCurrentTimeInstruction(now, "UTC")).toContain("2026-10-20 00:00 (UTC+00:00)");
  });

  it("defaults to the real clock", () => {
    const before = Date.now();
    const line = formatCurrentTimeInstruction();
    const match = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z/.exec(line);
    expect(match).not.toBeNull();
    const stamped = Date.parse(`${match![1]}Z`);
    expect(Math.abs(stamped - before)).toBeLessThan(5_000);
  });
});
