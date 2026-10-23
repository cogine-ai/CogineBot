import { afterEach, describe, expect, it, vi } from "vitest";
import { MeSchema, TimeZoneSchema } from "./domain.js";
import { detectedTimezone, timezoneOptions } from "./index.js";
import { appContract } from "./rpc.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("runtime timezone helpers", () => {
  it("reports an actual UTC device without applying a display fallback", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "UTC",
    } as Intl.ResolvedDateTimeFormatOptions);
    expect(detectedTimezone()).toBe("UTC");
  });

  it("does not coerce a malformed device value into a timezone", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: { toString: () => "UTC" },
    } as unknown as Intl.ResolvedDateTimeFormatOptions);
    expect(detectedTimezone()).toBeNull();
  });

  it("keeps UTC and a saved alias when runtime timezone enumeration fails", () => {
    vi.spyOn(Intl, "supportedValuesOf").mockImplementation(() => {
      throw new RangeError("unavailable");
    });
    expect(timezoneOptions("Asia/Calcutta")).toEqual(["Asia/Calcutta", "UTC"]);
  });

  it("keeps UTC and a saved alias when runtime timezone enumeration is absent", () => {
    const runtimeIntl = Object.create(Intl) as typeof Intl;
    Object.defineProperty(runtimeIntl, "supportedValuesOf", { value: undefined });
    vi.stubGlobal("Intl", runtimeIntl);
    expect(timezoneOptions("Asia/Calcutta")).toEqual(["Asia/Calcutta", "UTC"]);
    expect(timezoneOptions()).toEqual(["UTC"]);
    expect(timezoneOptions(null)).toEqual(["UTC"]);
  });

  it("offers supported zones once alongside UTC and a saved alias", () => {
    vi.spyOn(Intl, "supportedValuesOf").mockReturnValue([
      "Asia/Taipei",
      "America/New_York",
      "UTC",
      "Asia/Taipei",
    ]);
    expect(timezoneOptions("Asia/Calcutta")).toEqual([
      "America/New_York",
      "Asia/Calcutta",
      "Asia/Taipei",
      "UTC",
    ]);
  });
});

describe("account timezone", () => {
  it("accepts named zones and UTC but rejects invalid and fixed-offset zones", () => {
    for (const value of ["Asia/Taipei", "America/New_York", "Asia/Kolkata", "UTC"])
      expect(TimeZoneSchema.safeParse(value).success).toBe(true);
    for (const value of ["", "+08:00", "-05", "Invalid/Place", "X".repeat(65)])
      expect(TimeZoneSchema.safeParse(value).success).toBe(false);
  });
  it("keeps absent timezone compatible with old servers and explicit null distinct", () => {
    const field = MeSchema.shape.timezone;
    expect(field.parse(undefined)).toBeUndefined();
    expect(field.parse(null)).toBeNull();
    expect(field.parse("UTC")).toBe("UTC");
  });
  it("supports timezone-only preference writes without accepting empty writes", async () => {
    const schema = appContract.preferences.update["~orpc"].inputSchema;
    expect(await schema?.["~standard"].validate({ timezone: "Asia/Taipei" })).not.toHaveProperty(
      "issues",
    );
    expect(await schema?.["~standard"].validate({ timezone: null })).not.toHaveProperty("issues");
    expect(await schema?.["~standard"].validate({})).toHaveProperty("issues");
  });
});
