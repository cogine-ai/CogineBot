import {
  GENERATED_SECRET_SYMBOLS,
  GenerateCommandSecretInput,
  GeneratedSecretRules,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { generateSecretValue } from "./secret-generator.js";

describe("generated command credential rules", () => {
  it("uses every enabled character class and defaults to 20 characters", () => {
    const rules = GeneratedSecretRules.parse({});
    for (let sample = 0; sample < 32; sample++) {
      const value = generateSecretValue(rules);
      expect(value).toHaveLength(20);
      expect(value).toMatch(/[a-z]/);
      expect(value).toMatch(/[A-Z]/);
      expect(value).toMatch(/[0-9]/);
      expect([...value].some((character) => GENERATED_SECRET_SYMBOLS.includes(character))).toBe(
        true,
      );
    }
  });

  it("honors the minimum, maximum and restricted alphabet", () => {
    const digits = GeneratedSecretRules.parse({
      length: 8,
      lowercase: false,
      uppercase: false,
      symbols: false,
    });
    const restricted = GeneratedSecretRules.parse({
      length: 128,
      uppercase: false,
      allowedSymbols: "!_",
    });
    expect(generateSecretValue(digits)).toMatch(/^[0-9]{8}$/);
    const value = generateSecretValue(restricted);
    expect(value).toMatch(/^[a-z0-9!_]{128}$/);
    expect(value).toMatch(/[!_]/);
    expect(value).toMatch(/[0-9]/);
  });

  it.each([
    { rules: { length: 7 } },
    { rules: { length: 129 } },
    { rules: { length: 12.5 } },
    { rules: { allowedSymbols: "a!" } },
    { rules: { allowedSymbols: "!\n" } },
    { rules: { allowedSymbols: "!".repeat(33) } },
    { rules: { lowercase: false, uppercase: false, digits: false, symbols: false } },
    { rules: { lowercase: false, uppercase: false, digits: false, allowedSymbols: "!!!" } },
    { rules: { seed: "caller-supplied" } },
    { purpose: " " },
    { purpose: undefined },
    { purpose: "x".repeat(61) },
    { value: "caller-supplied" },
    { origin: "https://example.test" },
    { type: "login" },
    { name: "bash-env" },
    { name: "node-options" },
  ])("rejects invalid or unsupported inputs %j", (extra) => {
    expect(
      GenerateCommandSecretInput.safeParse({
        name: "test-db",
        type: "command",
        purpose: "Set up the test database",
        ...extra,
      }).success,
    ).toBe(false);
  });
});
