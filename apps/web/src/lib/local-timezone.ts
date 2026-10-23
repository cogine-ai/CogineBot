import { detectedTimezone } from "@rakazo/contracts";

export { detectedTimezone, timezoneOptions } from "@rakazo/contracts";

/** Timestamp inputs remain usable when the runtime cannot report its timezone. */
export function localTimezone(): string {
  return detectedTimezone() ?? "UTC";
}
