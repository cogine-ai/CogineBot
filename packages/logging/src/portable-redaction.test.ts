import { describe, expect, it } from "vitest";
import { redactBindings, redactSecretText, redactSensitiveText } from "./redaction.js";

describe("portable credential redaction", () => {
  it("preserves ordinary instructions, emails, metadata and token counts", () => {
    const value =
      'Contact support@example.test.\r\n{"email":"team@example.test","max_tokens":4096}\n--token-limit 4096\n---\nname: help\n---\n';
    expect(redactSecretText(value)).toBe(value);
    expect(redactSensitiveText(value)).not.toContain("support@example.test");
    expect(redactBindings({ email: "team@example.test" })).toEqual({ email: "[Redacted]" });
  });

  it.each([
    "API key is SYNTHETIC_PORTABLE_VALUE",
    "Authorization: Bearer SYNTHETIC_PORTABLE_VALUE",
    'password="SYNTHETIC PORTABLE VALUE"',
    "--token SYNTHETIC_PORTABLE_VALUE",
    '--password "SYNTHETIC PORTABLE VALUE"',
    "--api-key=SYNTHETIC_PORTABLE_VALUE",
    "X_KEY=SYNTHETIC_PORTABLE_VALUE",
    "xai-key=SYNTHETIC_PORTABLE_VALUE",
    "https://user:SYNTHETIC_PORTABLE_VALUE@example.test/path",
    "https://:SYNTHETIC_PORTABLE_VALUE@example.test/path",
    "https://user@example.test:SYNTHETIC_PORTABLE_VALUE@host.example.test/path",
    "-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PORTABLE_VALUE\n-----END PRIVATE KEY-----",
  ])("removes known material in %s and remains stable through encoded layers", (value) => {
    for (const input of [value, JSON.stringify({ note: value, email: "keep@example.test" })]) {
      const cleaned = redactSecretText(input);
      expect(cleaned).not.toContain("SYNTHETIC_PORTABLE");
      expect(cleaned).toContain("[Redacted]");
      expect(redactSecretText(cleaned)).toBe(cleaned);
      if (input.startsWith("{")) expect(JSON.parse(cleaned).email).toBe("keep@example.test");
    }
  });

  it.each([
    `omd_${"a".repeat(43)}`,
    `omg_${"a".repeat(43)}`,
    `github_pat_${"a".repeat(22)}`,
    `ghp_${"a".repeat(22)}`,
    `xoxb-${"a".repeat(22)}`,
    "AKIAABCDEFGHIJKLMNOP",
    `LLM|123456|${"a".repeat(20)}`,
    `sk-${"a".repeat(24)}`,
    `npm_${"a".repeat(20)}`,
    `AIza${"a".repeat(30)}`,
    `AIza${"a".repeat(36)}`,
  ])("removes a recognized provider credential shape (%s)", (value) => {
    expect(redactSecretText(`Use ${value} safely.`)).toBe("Use [Redacted] safely.");
  });

  it("keeps non-values after credential flags and encodes nested JSON safely", () => {
    expect(redactSecretText('--token --help\n--token ""')).toBe('--token --help\n--token ""');
    const value = JSON.stringify({
      note: JSON.stringify({ command: '--token "SYNTHETIC SECRET"' }),
    });
    const cleaned = redactSecretText(value);
    expect(JSON.parse(JSON.parse(cleaned).note).command).toBe("--token [Redacted]");
    expect(redactSecretText(cleaned)).toBe(cleaned);
  });

  it("preserves short prefix examples and ordinary key names", () => {
    const value = `npm_${"a".repeat(19)} AIza${"a".repeat(29)} hotkey=example keyboard=example`;
    expect(redactSecretText(value)).toBe(value);
  });
});
