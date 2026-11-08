import { describe, expect, it } from "vitest";
import { redactInterruptedOutput } from "./model-output-recovery.js";

describe("interrupted output redaction", () => {
  it.each(["p", "pr", "pri"])("masks a terminal %s without masking earlier prose", (prefix) => {
    expect(redactInterruptedOutput(`A prior paragraph. ${prefix}`, ["private-fixture-token"])).toBe(
      "A prior paragraph. [redacted]",
    );
  });

  it.each([
    { text: "abc", secrets: ["ab", "abcd"] },
    { text: "aaa", secrets: ["aaa"] },
    { text: "abcd", secrets: ["abc", "bcde"] },
  ])("masks overlapping exact and incomplete matches in $text", ({ text, secrets }) => {
    expect(redactInterruptedOutput(`Visible. ${text}`, secrets)).toBe("Visible. [redacted]");
  });

  it("masks the continuation of exact and interrupted matches across prior progress", () => {
    expect(redactInterruptedOutput("bc", ["abcd"], ["Visible. a"])).toBe("[redacted]");
    expect(redactInterruptedOutput("bcd. Visible.", ["abcd"], ["Earlier. a"])).toBe(
      "[redacted]. Visible.",
    );
    expect(redactInterruptedOutput("bcd", ["abcd", "bcde"], ["Earlier. a"])).toBe("[redacted]");
  });

  it("preserves unrelated text and masks a terminal surrogate that starts a known value", () => {
    expect(redactInterruptedOutput("Visible 🙂.", ["private-fixture-token"])).toBe("Visible 🙂.");
    expect(redactInterruptedOutput("Visible 🙂 \uD83D", ["🔐fixture-token"])).toBe(
      "Visible 🙂 [redacted]",
    );
  });
});
