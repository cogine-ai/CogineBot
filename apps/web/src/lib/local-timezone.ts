/** Detect an actual device zone. A display fallback must never become an adopted preference. */
export function detectedTimezone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || /^[+-]/.test(zone)) return null;
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    return zone;
  } catch {
    return null;
  }
}

/** Timestamp inputs remain usable when the runtime cannot report its timezone. */
export function localTimezone(): string {
  return detectedTimezone() ?? "UTC";
}

/** Offer the runtime's IANA zones, including UTC and a saved alias. */
export function timezoneOptions(current?: string | null): string[] {
  let supported: string[] = [];
  try {
    if (typeof Intl.supportedValuesOf === "function")
      supported = Intl.supportedValuesOf("timeZone");
  } catch {
    // Older embedded runtimes can still edit UTC or their current saved zone.
  }
  const zones = new Set(supported);
  zones.add("UTC");
  if (current) zones.add(current);
  return [...zones].sort((a, b) => a.localeCompare(b));
}
