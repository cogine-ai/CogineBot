import type { Routine } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { needsOneShotTime, routineActivation, routineFields } from "./routine-editor";

const imported = { active: false, crons: ["@once"], nextRunAt: null, lastRunAt: null } as Routine;
const now = Date.parse("2030-01-01T00:00:00Z");

describe("routine activation", () => {
  it("arms an imported one-shot with the chosen instant in the same update", () => {
    expect(needsOneShotTime(imported)).toBe(true);
    expect(routineActivation(imported, "2030-01-01T10:00:00+08:00", now)).toEqual({
      active: true,
      runAt: "2030-01-01T02:00:00.000Z",
    });
  });
  it.each(["", "invalid", "2029-12-31T23:59:59Z", "2030-01-01T00:00:00Z"])(
    "rejects missing, invalid or nonfuture time: %s",
    (runAt) => {
      expect(() => routineActivation(imported, runAt, now)).toThrow("future");
    },
  );
  it("lets recurring imports resume without a one-shot time", () => {
    expect(routineActivation({ ...imported, crons: ["0 9 * * *"] }, "", now)).toEqual({
      active: true,
    });
  });
  it("does not re-arm scheduled or completed one-shots", () => {
    for (const routine of [
      { ...imported, nextRunAt: "2030-01-02T00:00:00Z" },
      { ...imported, lastRunAt: "2029-12-31T00:00:00Z" },
    ]) {
      expect(needsOneShotTime(routine)).toBe(false);
      expect(routineActivation(routine, "2030-01-03T00:00:00Z", now)).toEqual({ active: true });
    }
  });
  it("does not require a future date to pause", () => {
    expect(routineActivation({ ...imported, active: true }, "", now)).toEqual({ active: false });
  });
});

it("ordinary fields preserve exact cron expressions and omit external triggers, model and timezone", () => {
  expect(routineFields(" Daily ", " Review ", ["0 0 9 * * MON-FRI"])).toEqual({
    name: "Daily",
    prompt: "Review",
    crons: ["0 0 9 * * MON-FRI"],
  });
});
it.each([
  ["", "Review"],
  ["Daily", " "],
  ["x".repeat(81), "Review"],
])("rejects invalid name or prompt", (name, prompt) => {
  expect(() => routineFields(name, prompt, [])).toThrow();
});
