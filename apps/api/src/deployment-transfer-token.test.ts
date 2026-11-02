import { describe, expect, it } from "vitest";
import { transferHash, transferTokenMatches } from "./deployment-transfer-store.js";

describe("fixed-size transfer bearer authentication", () => {
  it("matches only the original bearer against its 32-byte digest", () => {
    const token = "a".repeat(43);
    expect(transferTokenMatches(transferHash(token), token)).toBe(true);
    expect(transferTokenMatches(transferHash(token), "b".repeat(43))).toBe(false);
  });
  it("fails closed for absent or malformed stored digests without length errors", () => {
    for (const digest of [null, "", "a".repeat(63), "a".repeat(65), "X".repeat(64)])
      expect(transferTokenMatches(digest, "a".repeat(43))).toBe(false);
  });
});
