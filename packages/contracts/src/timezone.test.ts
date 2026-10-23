import { describe, expect, it } from "vitest";
import { MeSchema, TimeZoneSchema } from "./domain.js";
import { appContract } from "./rpc.js";

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
