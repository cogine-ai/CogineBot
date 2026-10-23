import { isValidTimeZone } from "./domain.js";

/** Detect a valid device zone; an unavailable zone must not become an adopted UTC preference. */
export function detectedTimezone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone && isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** Offer runtime IANA zones, preserving UTC and a saved alias on older runtimes. */
export function timezoneOptions(current?: string | null): string[] {
  let supported: string[] = [];
  try {
    if (typeof Intl.supportedValuesOf === "function")
      supported = Intl.supportedValuesOf("timeZone");
  } catch {
    // Runtime enumeration can be absent or unavailable in embedded clients.
  }
  const zones = new Set(supported);
  zones.add("UTC");
  if (current) zones.add(current);
  return [...zones].sort((a, b) => a.localeCompare(b));
}
