import { CronDate } from "croner";

export const DAY_MS = 86_400_000;

export function validRoutineTimezone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

function wallTimestamp(
  year: number,
  month: number,
  day: number,
  h: number,
  m: number,
  s: number,
  ms: number,
): number {
  const wall = new Date(0);
  wall.setUTCFullYear(year, month, day);
  wall.setUTCHours(h, m, s, ms);
  return wall.getTime();
}

/** A wall-clock reading represented on the UTC clock for calendar arithmetic. */
export function routineWallTime(instant: number, zone: string): number {
  const d = new CronDate(new Date(instant), zone);
  return wallTimestamp(d.year, d.month, d.day, d.hour, d.minute, d.second, d.ms);
}

/** Repeated readings use the first instant. A skipped cron reading fires at the end of the gap. */
export function routineWallInstant(wall: number, zone: string): number {
  const offset = (time: number) => routineWallTime(time, zone) - time;
  const before = wall - offset(wall - DAY_MS);
  const after = wall - offset(wall + DAY_MS);
  let first = Math.min(before, after);
  let last = Math.max(before, after);
  if (routineWallTime(first, zone) === wall) return first;
  if (routineWallTime(last, zone) === wall) return last;
  const previousOffset = offset(first);
  while (last - first > 1) {
    const middle = Math.floor((first + last) / 2);
    if (offset(middle) === previousOffset) first = middle;
    else last = middle;
  }
  return last;
}

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/** Offset-bearing values are absolute; local dates and times belong to the Routine's zone. */
export function parseRoutineDateTime(value: string, zone: string): Date | null {
  const match = ISO_DATE_TIME.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h = "00", m = "00", s = "00", fraction = "", offset] = match;
  const ms = fraction.padEnd(3, "0").slice(0, 3);
  const wallText = `${y}-${mo}-${d}T${h}:${m}:${s}.${ms}`;
  const wall = new Date(`${wallText}Z`);
  if (!Number.isFinite(wall.getTime()) || wall.toISOString() !== `${wallText}Z`) return null;
  if (offset) {
    const suffix = offset.length === 3 ? `${offset}:00` : offset;
    const parsed = new Date(wallText + suffix);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  zone = validRoutineTimezone(zone);
  return new Date(resolveLocalStart(wall.getTime(), zone));
}

function resolveLocalStart(wall: number, zone: string): number {
  const instant = routineWallInstant(wall, zone);
  // A selected local time in a DST gap moves forward by the size of that gap.
  const shifted = routineWallTime(instant, zone);
  if (shifted > wall) {
    return instant + wall - routineWallTime(instant - 1, zone) - 1;
  }
  return instant;
}

/** Format a value for a datetime-local control in the Routine's timezone. */
export function routineDateTimeLocal(value: Date, zone: string): string {
  return new Date(routineWallTime(value.getTime(), validRoutineTimezone(zone)))
    .toISOString()
    .slice(0, 16);
}

export function formatRoutineTime(value: string, zone: string, locale?: string): string {
  const date = new Date(value);
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(date);
  }
}

export function moveRoutineWallTime(
  value: Date,
  fromZone: string,
  toZone: string,
  localStart = false,
): Date {
  const wall = routineWallTime(value.getTime(), validRoutineTimezone(fromZone));
  const zone = validRoutineTimezone(toZone);
  return new Date(localStart ? resolveLocalStart(wall, zone) : routineWallInstant(wall, zone));
}
