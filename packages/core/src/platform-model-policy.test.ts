import { describe, expect, it } from "vitest";
import { parsePlatformModelAllowlist, platformModelAllowed } from "./signup-policy.js";

describe("platform model policy", () => {
  it.each([undefined, "", " \t ", ", ,"])("keeps an unset policy unrestricted (%j)", (raw) => {
    const allowlist = parsePlatformModelAllowlist(raw);
    expect(allowlist).toEqual([]);
    expect(
      platformModelAllowed({
        allowlist,
        email: "member@example.test",
        emailVerified: false,
        isOwner: false,
      }),
    ).toBe(true);
  });

  it.each(["none", " NONE "])("reserves %j for the current owner", (raw) => {
    const allowlist = parsePlatformModelAllowlist(raw);
    expect(allowlist).toBe("owner_only");
    expect(
      platformModelAllowed({
        allowlist,
        email: "member@example.test",
        emailVerified: true,
        isOwner: false,
      }),
    ).toBe(false);
    expect(
      platformModelAllowed({
        allowlist,
        email: "owner@messaging.invalid",
        emailVerified: false,
        isOwner: true,
      }),
    ).toBe(true);
  });

  it("normalizes configured mailboxes and domains without widening either", () => {
    expect(parsePlatformModelAllowlist(" Member@Example.Test, @TEAM.Test, ")).toEqual([
      "member@example.test",
      "@team.test",
    ]);
    expect(
      platformModelAllowed({
        allowlist: ["member@example.test"],
        email: "other@example.test",
        emailVerified: true,
        isOwner: false,
      }),
    ).toBe(false);
  });

  it.each([
    { email: "member@example.test", verified: false, allowed: false },
    { email: "member@example.test", verified: true, allowed: true },
    { email: " Member@EXAMPLE.TEST ", verified: true, allowed: true },
    { email: "member+tag@example.test", verified: true, allowed: true },
    { email: "member@sub.example.test", verified: true, allowed: false },
    { email: "member@example.test.attacker.invalid", verified: true, allowed: false },
    { email: "member@not-example.test", verified: true, allowed: false },
    { email: "member@example.test@attacker.invalid", verified: true, allowed: false },
    { email: "member@@example.test", verified: true, allowed: false },
    { email: "@example.test", verified: true, allowed: false },
    { email: "member name@example.test", verified: true, allowed: false },
  ])(
    "matches one verified mailbox domain: $email / proof=$verified",
    ({ email, verified, allowed }) => {
      expect(
        platformModelAllowed({
          allowlist: ["@example.test"],
          email,
          emailVerified: verified,
          isOwner: false,
        }),
      ).toBe(allowed);
    },
  );

  it("does not treat a messaging identity as mailbox proof", () => {
    expect(
      platformModelAllowed({
        allowlist: ["@messaging.invalid"],
        email: "sender@messaging.invalid",
        emailVerified: true,
        isOwner: false,
      }),
    ).toBe(false);
  });
});
