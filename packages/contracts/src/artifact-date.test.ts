import { describe, expect, it } from "vitest";
import { matchesCalendarDateFilter } from "./artifact-date.js";

const iso = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).toISOString();

describe("artifact local calendar dates", () => {
  const now = new Date(2026, 10, 1, 12); // Sunday; month boundary and US DST transition.
  it("keeps all as the default, including unknown dates", () => {
    expect(matchesCalendarDateFilter("invalid", "all", now)).toBe(true);
  });
  it("uses local dates rather than the last 24 hours or UTC dates", () => {
    expect(matchesCalendarDateFilter(iso(2026, 10, 31, 23, 59), "today", now)).toBe(false);
    expect(matchesCalendarDateFilter(iso(2026, 11, 1), "today", now)).toBe(true);
    expect(matchesCalendarDateFilter(iso(2026, 11, 1, 23, 59), "today", now)).toBe(true);
    expect(matchesCalendarDateFilter(iso(2026, 11, 2), "today", now)).toBe(false);
  });
  it("starts the week on local Sunday midnight, including across DST", () => {
    for (const reference of [now, new Date(2026, 10, 7, 23, 59)]) {
      expect(matchesCalendarDateFilter(iso(2026, 10, 31, 23, 59), "week", reference)).toBe(false);
      expect(matchesCalendarDateFilter(iso(2026, 11, 1), "week", reference)).toBe(true);
    }
    // Preserve the Web predicate's existing lower-bound-only behavior.
    expect(matchesCalendarDateFilter(iso(2026, 12, 1), "week", now)).toBe(true);
  });
  it("uses the same month and year, not a rolling 30 days", () => {
    expect(matchesCalendarDateFilter(iso(2026, 10, 31, 23, 59), "month", now)).toBe(false);
    expect(matchesCalendarDateFilter(iso(2026, 11, 1), "month", now)).toBe(true);
    expect(matchesCalendarDateFilter(iso(2026, 11, 30, 23, 59), "month", now)).toBe(true);
    expect(matchesCalendarDateFilter(iso(2026, 12, 1), "month", now)).toBe(false);
    expect(matchesCalendarDateFilter(iso(2025, 11, 1), "month", now)).toBe(false);
    expect(matchesCalendarDateFilter(iso(2026, 12, 31), "month", new Date(2027, 0, 1))).toBe(false);
  });
  it.each(["today", "week", "month"] as const)("rejects unreadable timestamps for %s", (filter) => {
    expect(matchesCalendarDateFilter("invalid", filter, now)).toBe(false);
  });
});
