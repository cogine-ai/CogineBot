import { describe, expect, it } from "vitest";
import { formatLegacyRunQueueFailure } from "./legacy-run-queue-error.js";

const hidden = "postgresql://fixture-user:private-canary@private-host.invalid/private-db";
const fallback = "Legacy Run queue rebuild failed; no downgrade should proceed.\n";

describe("legacy queue command diagnostics", () => {
  it.each([
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
  ])("preserves the safe command failure: %s", (message) => {
    expect(formatLegacyRunQueueFailure(new Error(message))).toBe(
      `Legacy Run queue rebuild failed: ${message}; no downgrade should proceed.\n`,
    );
  });

  it.each(["40001", "57P01"])("reports database code %s without its message or details", (code) => {
    const error = Object.assign(new Error(hidden, { cause: new Error(hidden) }), {
      code,
      detail: hidden,
      where: hidden,
    });
    expect(formatLegacyRunQueueFailure(error)).toBe(
      `Legacy Run queue rebuild failed (SQLSTATE ${code}); no downgrade should proceed.\n`,
    );
  });

  it.each([hidden, `Legacy run queue readback failed: ${hidden}`, `Invalid ${hidden}`])(
    "hides unrecognized error text even when it has a familiar prefix",
    (message) => {
      expect(formatLegacyRunQueueFailure(new Error(message))).toBe(fallback);
    },
  );

  it.each([hidden, "40001\n", `40001\n${hidden}`, "ECONNREFUSED", "bad", 40001, null])(
    "does not print an unvalidated error code",
    (code) => {
      expect(formatLegacyRunQueueFailure(Object.assign(new Error(hidden), { code }))).toBe(
        fallback,
      );
    },
  );

  it.each([undefined, null, hidden, { message: hidden }])("hides unknown throw values", (error) => {
    expect(formatLegacyRunQueueFailure(error)).toBe(fallback);
  });
});
