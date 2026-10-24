import { describe, expect, it } from "vitest";
import { loadFailureKind } from "./load-failure.js";

describe("load failure classification", () => {
  it.each([401, 403, 500, 502, 503, 504])(
    "keeps HTTP %s distinct from transport loss",
    (status) => {
      const error = Object.assign(new Error("Request failed"), { status });
      expect(loadFailureKind(error)).toBe(
        status === 401 ? "auth" : status === 403 ? "space" : "server",
      );
    },
  );

  it("recognizes nested transport failures without treating provider text as offline", () => {
    expect(
      loadFailureKind(new Error("Request failed", { cause: new TypeError("Failed to fetch") })),
    ).toBe("offline");
    expect(loadFailureKind(new Error("Unexpected provider payload"))).toBe("unknown");
    expect(loadFailureKind(null, false)).toBe("offline");
  });

  it("does not classify a real server answer as an offline retry", () => {
    expect(loadFailureKind({ status: 503 }, false)).toBe("server");
    expect(loadFailureKind({ code: "FORBIDDEN" })).toBe("space");
    expect(loadFailureKind({ code: "UNAUTHORIZED" })).toBe("auth");
    expect(loadFailureKind({ status: 400 })).toBe("unknown");
  });
});
