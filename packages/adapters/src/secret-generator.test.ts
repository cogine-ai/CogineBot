import {
  GENERATED_SECRET_SYMBOLS,
  GenerateCommandSecretInput,
  GeneratedSecretRules,
  GenerateSecretInput,
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

  it("honors narrow alphabets at sufficient lengths and the maximum length", () => {
    const digits = GeneratedSecretRules.parse({
      length: 20,
      lowercase: false,
      uppercase: false,
      symbols: false,
    });
    const restricted = GeneratedSecretRules.parse({
      length: 128,
      uppercase: false,
      allowedSymbols: "!_",
    });
    expect(generateSecretValue(digits)).toMatch(/^[0-9]{20}$/);
    const value = generateSecretValue(restricted);
    expect(value).toMatch(/^[a-z0-9!_]{128}$/);
    expect(value).toMatch(/[!_]/);
    expect(value).toMatch(/[0-9]/);
  });

  it("uses distinct characters to enforce the exact minimum for a two-character alphabet", () => {
    const options = {
      lowercase: false,
      uppercase: false,
      digits: false,
      allowedSymbols: "!!?",
    };
    expect(GeneratedSecretRules.safeParse({ ...options, length: 63 }).success).toBe(false);
    const rules = GeneratedSecretRules.parse({ ...options, length: 64 });
    expect(generateSecretValue(rules)).toMatch(/^[!?]{64}$/);
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
    {
      rules: { length: 8, lowercase: false, uppercase: false, digits: false, allowedSymbols: "!?" },
    },
    { rules: { length: 19, lowercase: false, uppercase: false, symbols: false } },
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

describe("generated website login input", () => {
  const login = {
    type: "login",
    name: "site-account",
    purpose: "Set up the website login",
    origin: "https://LOGIN.example.test:443/",
    username: "  fixture@example.test  ",
  };

  it("normalizes the site and username and permits a command pairing", () => {
    expect(GenerateSecretInput.parse({ ...login, command: true })).toEqual({
      ...login,
      origin: "https://login.example.test",
      username: "fixture@example.test",
      command: true,
    });
    expect(
      GenerateSecretInput.safeParse({ ...login, name: "a".repeat(55), command: true }).success,
    ).toBe(true);
    expect(GenerateSecretInput.safeParse({ ...login, name: "a".repeat(64) }).success).toBe(true);
  });

  it.each([
    { origin: "http://login.example.test" },
    { origin: "https://login.example.test/path" },
    { origin: "https://login.example.test?query=1" },
    { origin: "https://username:password@login.example.test" },
    { username: " " },
    { name: "ld", command: true },
    { name: "a".repeat(56), command: true },
    { value: "caller-supplied" },
  ])("rejects unsafe or incompatible login input %j", (overrides) => {
    expect(GenerateSecretInput.safeParse({ ...login, ...overrides }).success).toBe(false);
  });
});
