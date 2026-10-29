import { describe, expect, it } from "vitest";
import { accessRecoveryState } from "./access-recovery.js";

describe("access recovery projection", () => {
  it.each([
    [{ status: 401 }, "session_expired"],
    [{ code: "FORBIDDEN" }, "space_forbidden"],
    [{ status: 402 }, "subscription_required"],
    [{ code: "PAYMENT_REQUIRED" }, "subscription_required"],
    [{ data: { reason: "subscription_required" } }, "subscription_required"],
    [{ data: { reason: "billing_unavailable" }, status: 503 }, "billing_unavailable"],
    [new Error("transport unavailable"), null],
    [{ status: 500 }, null],
    [{ cause: { code: "UNAUTHORIZED" } }, "session_expired"],
  ])("classifies authoritative signals without guessing from copy", (error, state) => {
    expect(accessRecoveryState(error)).toBe(state);
  });
  it("does not infer an unpaid subscription from an ordinary outage", () => {
    expect(accessRecoveryState(new Error("Subscription required"))).toBeNull();
  });
});
