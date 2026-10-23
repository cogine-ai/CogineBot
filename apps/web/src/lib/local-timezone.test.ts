import { afterEach, describe, expect, it, vi } from "vitest";
import { detectedTimezone, localTimezone, timezoneOptions } from "./local-timezone";

afterEach(() => vi.restoreAllMocks());
describe("device timezone", () => {
  it("returns the runtime's actual IANA zone when available", () => {
    expect(localTimezone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });
  it("accepts an actual UTC device", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "UTC",
    } as Intl.ResolvedDateTimeFormatOptions);
    expect(detectedTimezone()).toBe("UTC");
  });
  it.each(["", "+05:30", "Not/AZone"])("does not adopt invalid device value %s", (timeZone) => {
    const original = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      function DateTimeFormatStub(locales, options) {
        if (options?.timeZone) return new original(locales, options);
        return { resolvedOptions: () => ({ timeZone }) } as Intl.DateTimeFormat;
      },
    );
    expect(detectedTimezone()).toBeNull();
    expect(localTimezone()).toBe("UTC");
  });
  it("skips detection failures while retaining UTC display fallback", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(detectedTimezone()).toBeNull();
    expect(localTimezone()).toBe("UTC");
  });
  it("keeps UTC and saved aliases in a deterministic picker list", () => {
    const zones = timezoneOptions("Asia/Calcutta");
    expect(zones).toContain("UTC");
    expect(zones).toContain("Asia/Calcutta");
    expect(new Set(zones).size).toBe(zones.length);
  });
});
