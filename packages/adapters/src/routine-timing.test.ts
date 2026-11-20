import { describe, expect, it } from "vitest";
import { patchRoutineTiming } from "./routine-timing.js";

const now = new Date("2027-03-01T00:00:00Z");
const delayed = {
  active: true,
  crons: ["0 4 * * *", "0 9 * * *"],
  startAt: new Date("2027-03-04T08:00:00Z"),
  nextRunAt: new Date("2027-03-04T09:00:00Z"),
  timezone: "UTC",
  intervalBased: false,
  intervalAnchorAt: null,
};

describe("routine timing edits", () => {
  it("never schedules before the moved first date across multiple cron slots", () => {
    const zone = "America/Chicago";
    const moved = patchRoutineTiming(delayed, { timezone: zone }, now).data;
    expect(moved).toMatchObject({
      startAt: new Date("2027-03-04T14:00:00Z"),
      nextRunAt: new Date("2027-03-04T15:00:00Z"),
    });
    const paused = patchRoutineTiming(moved, { active: false }, now).data;
    expect(patchRoutineTiming(paused, { active: true }, now).data.nextRunAt).toEqual(
      moved.nextRunAt,
    );
  });

  it("keeps the absolute floor and already pending anchor for an elapsed interval", () => {
    const anchor = new Date("2027-03-04T08:00:00Z");
    const interval = {
      ...delayed,
      crons: ["*/7 * * * *"],
      intervalBased: true,
      intervalAnchorAt: anchor,
      nextRunAt: anchor,
    };
    const zone = "Asia/Kolkata";
    expect(patchRoutineTiming(interval, { timezone: zone }, now).data).toMatchObject({
      startAt: interval.startAt,
      nextRunAt: interval.nextRunAt,
    });
    const paused = patchRoutineTiming(interval, { active: false }, now).data;
    const moved = patchRoutineTiming(paused, { timezone: zone }, now).data;
    expect(patchRoutineTiming(moved, { active: true }, now).data.nextRunAt).toEqual(anchor);
    expect(
      patchRoutineTiming(moved, { active: true }, new Date("2027-03-04T08:01:00Z")).data.nextRunAt,
    ).toEqual(new Date("2027-03-04T08:07:00Z"));
  });

  it("shifts a skipped local first date consistently on timezone-only edits", () => {
    const before = new Date("2027-03-13T00:00:00Z");
    const source = {
      ...delayed,
      crons: ["15 3 * * *"],
      startAt: new Date("2027-03-14T02:30:00Z"),
      nextRunAt: new Date("2027-03-14T03:15:00Z"),
    };
    const timezone = "America/New_York";
    const moved = patchRoutineTiming(source, { timezone }, before).data;
    const entered = patchRoutineTiming(
      source,
      { timezone, startAt: "2027-03-14T02:30" },
      before,
    ).data;
    expect(moved).toEqual(entered);
    expect(moved.nextRunAt).toEqual(new Date("2027-03-15T07:15:00Z"));
  });

  it("cannot save an unused one-shot time without resuming the plan", () => {
    const stopped = { ...delayed, crons: ["@once"], active: false, startAt: null, nextRunAt: null };
    const runAt = new Date("2027-03-02T12:00:00Z");
    expect(() => patchRoutineTiming(stopped, { runAt }, now)).toThrow("Resume this one-shot");
    expect(() => patchRoutineTiming(stopped, { active: true }, now)).toThrow("Add a run time");
    expect(patchRoutineTiming(stopped, { active: true, runAt }, now).data).toMatchObject({
      active: true,
      nextRunAt: runAt,
    });
  });

  it("keeps the interval phase when the pending local day passes during a timezone move", () => {
    const source = {
      ...delayed,
      crons: ["0 0 */7 * *"],
      intervalBased: true,
      startAt: null,
      intervalAnchorAt: new Date("2027-05-01T00:00:00Z"),
      nextRunAt: new Date("2027-06-05T00:00:00Z"),
    };
    const before = new Date("2027-06-04T23:00:00Z");
    const timezone = "Asia/Tokyo";
    expect(patchRoutineTiming(source, { timezone }, before).data.nextRunAt).toEqual(
      new Date("2027-06-11T15:00:00Z"),
    );
  });

  it("preserves the midnight cadence of an interval originally moved by a DST gap", () => {
    const anchor = new Date("2027-09-05T04:00:00Z");
    const source = {
      ...delayed,
      crons: ["0 0 */2 * *"],
      intervalBased: true,
      startAt: null,
      active: false,
      nextRunAt: null,
      intervalAnchorAt: anchor,
      timezone: "America/Santiago",
    };
    const before = new Date("2027-09-06T00:00:00Z");
    const moved = patchRoutineTiming(source, { timezone: "UTC" }, before).data;
    expect(patchRoutineTiming(moved, { active: true }, before).data.nextRunAt).toEqual(
      new Date("2027-09-07T00:00:00Z"),
    );
  });

  it("carries the pending local day without replaying the earlier occurrence", () => {
    const source = {
      ...delayed,
      crons: ["0 0 */2 * *"],
      intervalBased: true,
      startAt: null,
      intervalAnchorAt: new Date("2027-01-01T00:00:00Z"),
      nextRunAt: new Date("2027-01-07T00:00:00Z"),
    };
    const now = new Date("2027-01-05T00:01:00Z");
    const timezone = "America/Los_Angeles";
    const moved = patchRoutineTiming(source, { timezone }, now).data;
    expect(moved.nextRunAt).toEqual(new Date("2027-01-07T08:00:00Z"));
    const paused = patchRoutineTiming(source, { active: false }, now).data;
    const pausedMoved = patchRoutineTiming(paused, { timezone }, now).data;
    expect(patchRoutineTiming(pausedMoved, { active: true }, now).data.nextRunAt).toEqual(
      moved.nextRunAt,
    );
  });
});
