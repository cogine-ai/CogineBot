const safeCommandErrors = new Set([
  "Expected no arguments or --apply",
  "DATABASE_URL is required",
  "Invalid batch size",
  "Invalid queue clock",
  "Queue clock unavailable",
  "Invalid run pagination timestamp",
  "Legacy run queue changed during creation",
  "Legacy run task unavailable",
  "Legacy run queue changed during repair",
  "Legacy run queue readback failed",
  "Legacy run queue budget changed during repair",
]);

/** Keep actionable command diagnostics without echoing connection or server error text. */
export function formatLegacyRunQueueFailure(error: unknown): string {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length === 5 &&
    /^[0-9A-Z]{5}$/.test(error.code)
      ? ` (SQLSTATE ${error.code})`
      : "";
  const message =
    error instanceof Error && safeCommandErrors.has(error.message) ? `: ${error.message}` : "";
  return `Legacy Run queue rebuild failed${code}${message}; no downgrade should proceed.\n`;
}
