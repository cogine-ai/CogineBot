import { describe, expect, it } from "vitest";
import {
  providerErrorQuotaResetAt,
  providerResetAt,
  providerRetryAfterAt,
} from "./provider-quota-reset.js";

const receivedAt = Date.UTC(2026, 10, 9, 9);
const resetAt = receivedAt + 7_200_000;

describe("provider quota reset evidence", () => {
  it("anchors delta-seconds and honors an absolute HTTP date", () => {
    expect(providerRetryAfterAt("7200", receivedAt)).toBe(resetAt);
    expect(providerRetryAfterAt(new Date(resetAt).toUTCString(), receivedAt)).toBe(resetAt);
  });

  it.each(["0", "-1", "1.5", "2026-11-09", "Fri, 09 Nov 2026 11:00:00 GMT", "9999999999999999"])(
    "rejects malformed or non-future Retry-After %s",
    (value) => expect(providerRetryAfterAt(value, receivedAt)).toBeUndefined(),
  );

  it("checks structured reset timestamps for validity and future time", () => {
    expect(providerResetAt(resetAt / 1_000, receivedAt)).toBe(resetAt);
    expect(providerResetAt(resetAt, receivedAt)).toBe(resetAt);
    expect(providerResetAt(new Date(resetAt).toISOString(), receivedAt)).toBe(resetAt);
    expect(providerResetAt("2026-11-31T11:00:00Z", receivedAt)).toBeUndefined();
    expect(providerResetAt(receivedAt - 1, receivedAt)).toBeUndefined();
    expect(providerResetAt("2026-11-10", receivedAt)).toBeUndefined();
  });

  it("honors gateway reset evidence only alongside a verified 429", () => {
    const gateway = JSON.stringify({
      error: {
        metadata: { headers: { "Retry-After": "60", "X-RateLimit-Reset": resetAt / 1_000 } },
      },
    });
    expect(providerErrorQuotaResetAt(`429 ${gateway}`, 429, receivedAt)).toBe(resetAt);
    expect(providerErrorQuotaResetAt(gateway, 429, receivedAt)).toBe(resetAt);
    expect(providerErrorQuotaResetAt(`429 ${gateway}`, undefined, receivedAt)).toBeUndefined();
    expect(providerErrorQuotaResetAt(`429 ${gateway}`, 503, receivedAt)).toBeUndefined();
    expect(providerErrorQuotaResetAt(`503 ${gateway}`, 429, receivedAt)).toBeUndefined();
    expect(
      providerErrorQuotaResetAt('429 rate limit, retry-after: "7200"', 429, receivedAt),
    ).toBeUndefined();
  });
});
