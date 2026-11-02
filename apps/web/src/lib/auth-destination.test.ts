import { describe, expect, it } from "vitest";
import { authDestination, isNativeAuthDestination } from "./auth-destination";

describe("post-sign-in destinations", () => {
  const state = "a".repeat(43);
  const kickoff = `/api/connectors/oauth/start?state=${state}`;
  it("resumes only the exact native kickoff with its opaque attempt state", () => {
    expect(authDestination(kickoff)).toBe(kickoff);
    expect(isNativeAuthDestination(kickoff)).toBe(true);
    expect(authDestination("/integrations/setup")).toBe("/integrations/setup");
    expect(isNativeAuthDestination("/integrations/setup")).toBe(false);
  });
  it("retains an exact transfer invitation or owned status page after login", () => {
    const invitation = `/transfers/source?targetOrigin=https%3A%2F%2Ftarget.example.test&locator=${state}`;
    for (const path of [
      invitation,
      `/transfers/receive/${state}`,
      `/transfers/source/${state}`,
      "/transfers/receive/request/intent-one",
      "/transfers/source/request/intent-one",
    ]) {
      expect(authDestination(path)).toBe(path);
      expect(isNativeAuthDestination(path)).toBe(false);
    }
    expect(authDestination(`${invitation}&token=untrusted`)).toBe("/app");
    for (const path of [
      "/transfers/receive/request/intent-one?token=untrusted",
      "/transfers/source/request/intent-one#",
      "/transfers/source/request/..%2fapp",
      "/transfers/receive/request/%00",
    ])
      expect(authDestination(path)).toBe("/app");
  });
  it.each([
    null,
    "https://example.test/steal",
    "//example.test/steal",
    `/api/connectors/oauth/callback?state=${state}&code=untrusted`,
    `/api/connectors/oauth/start?state=${state}&next=https://example.test`,
    "/api/connectors/oauth/start?state=short",
    `/api/connectors/oauth/start?state=${state}%0a`,
    `/api/connectors/oauth/start?state=${state}#fragment`,
  ])("does not navigate to unsupported or injected destination %s", (value) => {
    expect(authDestination(value)).toBe("/app");
  });
});
