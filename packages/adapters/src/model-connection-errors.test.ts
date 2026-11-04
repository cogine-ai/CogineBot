import { describe, expect, it } from "vitest";
import { modelConnectionErrorMessage } from "./model-connection-errors.js";

describe("connection-scoped diagnostics", () => {
  it.each(["1", " en ", " xy9 ", 'q"\\z'])(
    "drops raw, normalized and encoded reflected %s while retaining status",
    (value) => {
      for (const reflected of [
        value,
        value.trim(),
        JSON.stringify(value).slice(1, -1),
        JSON.stringify(JSON.stringify(value)).slice(1, -1),
      ]) {
        const error = Object.assign(
          new Error(`429: rate_limit_error private reflection ${reflected}`),
          { status: 429 },
        );
        expect(modelConnectionErrorMessage(error, { headers: { "X-Key": value } })).toBe(
          "429: rate_limit_error",
        );
        expect(error.message).toContain(reflected);
        expect(error.status).toBe(429);
      }
    },
  );
  it("does not replace empty values or affect unrelated diagnostics", () => {
    expect(
      modelConnectionErrorMessage(new Error("A connection failed"), { headers: { "X-Key": " " } }),
    ).toBe("A connection failed");
    expect(
      modelConnectionErrorMessage(new Error("A connection failed"), {
        headers: { "X-Key": "xy9" },
      }),
    ).toBe("A connection failed");
  });
});
