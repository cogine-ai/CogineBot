import { spawnSync } from "node:child_process";
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

  it.each([
    "--token '--password first SYNTHETIC_PRIVATE_VALUE'",
    "--token '--password=first SYNTHETIC_PRIVATE_VALUE'",
    "--token='--password first SYNTHETIC_PRIVATE_VALUE'",
    "--secret '--api-key=first SYNTHETIC_PRIVATE_VALUE'",
    "--password '--token first SYNTHETIC_PRIVATE_VALUE'",
    "--token '\t--password first --api-key second SYNTHETIC_PRIVATE_VALUE'",
    "--token '--PASSWORD\tfirst SYNTHETIC_PRIVATE_VALUE'",
    "--token '''--password first SYNTHETIC_PRIVATE_VALUE'''",
    "--token 'before\\' --password first SYNTHETIC_PRIVATE_VALUE'",
    "--token '--password \"first SYNTHETIC_PRIVATE_VALUE\"'",
    '--token "--password first SYNTHETIC_PRIVATE_VALUE"',
  ])("does not restore a consumed credential value containing another flag: %s", (raw) => {
    const value = `${raw}\nnext: safe`;
    for (const input of [
      value,
      JSON.stringify({ note: value }),
      JSON.stringify({ note: JSON.stringify({ note: value }) }),
    ]) {
      const cleaned = redactSecretText(input);
      expect(cleaned).not.toContain("SYNTHETIC_PRIVATE_VALUE");
      expect(cleaned).toContain("next: safe");
      expect(redactSecretText(cleaned)).toBe(cleaned);
    }
  });

  it("still redacts separate credential flags after a consumed value", () => {
    const value =
      "--token '--password first SYNTHETIC_PRIVATE_VALUE'--api-key=SECOND_PRIVATE_VALUE\nnext: safe";
    expect(redactSecretText(value)).toBe("--token [Redacted]--api-key=[Redacted]\nnext: safe");
  });

  it.each([
    ["token: 123456", "123456"],
    ["token=123456", "123456"],
    ["TOKEN is 123456", "123456"],
    ["token -> 123456", "123456"],
    ['"token": 123456', "123456"],
    ["'token': 123456", "123456"],
    ['{"token":123456,"next":"safe"}', "123456"],
    ['{"to\\u006ben":123456,"next":"safe"}', "123456"],
    ['"token": "123456"', "123456"],
    ["token: 0", "0"],
    ["token: +.5", "+.5"],
    ["token: -1e3", "-1e3"],
  ])(
    "masks singular numeric token credentials rather than treating them as counts: %s",
    (raw, secret) => {
      for (const redact of [redactSecretText, redactSensitiveText]) {
        for (const input of [
          raw,
          JSON.stringify({ note: raw }),
          JSON.stringify({ note: JSON.stringify({ note: raw }) }),
        ]) {
          const cleaned = redact(input);
          expect(cleaned).toContain("[Redacted]");
          expect(cleaned).not.toContain(secret);
          expect(redact(cleaned)).toBe(cleaned);
        }
      }
    },
  );

  it.each([
    "max_tokens",
    "minimumTokens",
    "prompt_tokens",
    "completionTokens",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "reasoning_tokens",
    "cached_tokens",
    "tokenCount",
    "tokens_limit",
    "tokens_used",
    "token_usage",
    "tokens",
    "usage",
  ])("preserves ordinary portable numeric %s counters", (key) => {
    const raw = `${key}=123456; next=safe`;
    const json = JSON.stringify({ [key]: 123456, next: "safe" });
    expect(redactSecretText(raw)).toBe(raw);
    expect(redactSecretText(json)).toBe(json);
  });

  it("preserves short prefix examples and ordinary key names", () => {
    const value = `npm_${"a".repeat(19)} AIza${"a".repeat(29)} hotkey=example keyboard=example`;
    expect(redactSecretText(value)).toBe(value);
  });

  it.each([
    "'pa''ssword'",
    "'pass\\u0077ord'",
    '"pass\\u0077ord"',
    String.fromCharCode(39) + "password" + String.fromCharCode(92, 39, 39),
    `"x'y": ''password'`,
  ])("retains quoted credential-key coverage for %s", (key) => {
    for (const redact of [redactSecretText, redactSensitiveText]) {
      const raw = `${key}: SYNTHETIC_PRIVATE_VALUE\nnext: safe`;
      for (const input of [
        raw,
        JSON.stringify({ note: raw }),
        JSON.stringify({ note: JSON.stringify({ note: raw }) }),
      ]) {
        const cleaned = redact(input);
        expect(cleaned).not.toContain("SYNTHETIC_PRIVATE_VALUE");
        expect(cleaned).toContain("next: safe");
        expect(redact(cleaned)).toBe(cleaned);
      }
    }
  });

  it.each(
    [
      ["LF", "\n"],
      ["CR", "\r"],
      ["CRLF", "\r\n"],
      ["LS", "\u2028"],
      ["PS", "\u2029"],
    ].flatMap(([kind, lineBreak]) =>
      [1, 2, 3, 4].map((count) => [`${kind}/${count}`, lineBreak!, count] as const),
    ),
  )("masks declared multiline single-quoted credentials: %s", (label, lineBreak, count) => {
    const raw = `? 'pass${"\\".repeat(count)}${lineBreak}  word'\n: SYNTHETIC_PRIVATE_VALUE\nnext: safe`;
    const ordinary = raw
      .replace("pass", "audit")
      .replace("word", "label")
      .replace("SYNTHETIC_PRIVATE_VALUE", "VISIBLE_NOTE");
    for (const redact of [redactSecretText, redactSensitiveText]) {
      for (const input of [
        raw,
        JSON.stringify({ note: raw }),
        JSON.stringify({ note: JSON.stringify({ note: raw }) }),
      ]) {
        const cleaned = redact(input);
        expect(cleaned, label).not.toContain("SYNTHETIC_PRIVATE_VALUE");
        expect(cleaned).toContain("next: safe");
        expect(redact(cleaned)).toBe(cleaned);
      }
      expect(redact(ordinary), label).toBe(ordinary);
    }
  });

  it("preserves prior inner redactions when recognizing an outer multiline key", () => {
    const raw = `? 'context\\\n  "password": "SYNTHETIC_PRIVATE_VALUE" tail'\n: visible\nnext: safe`;
    for (const redact of [redactSecretText, redactSensitiveText]) {
      for (const input of [
        raw,
        JSON.stringify({ note: raw }),
        JSON.stringify({ note: JSON.stringify({ note: raw }) }),
      ]) {
        const cleaned = redact(input);
        expect(cleaned).not.toContain("SYNTHETIC_PRIVATE_VALUE");
        expect(cleaned).toContain("next: safe");
        expect(redact(cleaned)).toBe(cleaned);
      }
    }
  });

  it.each([
    "single-quotes",
    "escaped-quotes",
    "jwt-without-dots",
    "scheme-without-delimiter",
    "email-without-at",
    "lf-assignments",
    "cr-assignments",
    "quote-prefix-before-field",
    "single-quote-fallbacks",
    "multiline-keys",
    "nested-secret-flags",
  ])("bounds synchronous work for large %s input without changing its meaning", (kind) => {
    const moduleUrl = new URL("./redaction.ts", import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import { redactSecretText, redactSensitiveText } from ${JSON.stringify(moduleUrl)};
      const kind = process.argv[1];
      const inputs = {
        'single-quotes': "'".repeat(200001),
        'escaped-quotes': String.fromCharCode(34) + String.fromCharCode(92, 34).repeat(100000),
        'jwt-without-dots': 'eyJ-'.repeat(50000),
        'scheme-without-delimiter': 'scheme-'.repeat(30000),
        'email-without-at': 'local-'.repeat(35000),
        'lf-assignments': 'token=x' + String.fromCharCode(10),
        'cr-assignments': 'token=x' + String.fromCharCode(13),
        'quote-prefix-before-field': "'".repeat(200000) + String.fromCharCode(10) +
          '"password":"SYNTHETIC_PRIVATE_VALUE"' + String.fromCharCode(10) + 'next: safe',
        'single-quote-fallbacks': String.fromCharCode(39) + 'password' +
          String.fromCharCode(92,39,39).repeat(50000) + ': SYNTHETIC_PRIVATE_VALUE' +
          String.fromCharCode(10) + 'next: safe',
        'multiline-keys': "? 'pass" + String.fromCharCode(92,10) + "  word'" +
          String.fromCharCode(10) + ': SYNTHETIC_PRIVATE_VALUE' + String.fromCharCode(10) +
          'next: safe' + String.fromCharCode(10),
        'nested-secret-flags': "--token '" + '--password first '.repeat(12000) +
          "SYNTHETIC_PRIVATE_VALUE'" + String.fromCharCode(10) + 'next: safe',
      };
      const assignments = kind.endsWith('-assignments');
      const input = assignments ? inputs[kind].repeat(25000) :
        kind === 'multiline-keys' ? inputs[kind].repeat(3000) : inputs[kind];
      const policies = kind === 'nested-secret-flags' ? [redactSecretText] :
        [redactSecretText, redactSensitiveText];
      for (const redact of policies) {
        const output = redact(input);
        if (assignments) {
          const newline = kind.startsWith('lf') ? String.fromCharCode(10) : String.fromCharCode(13);
          assert.equal(output, ('token=[Redacted]' + newline).repeat(25000));
        } else if (['quote-prefix-before-field','single-quote-fallbacks','multiline-keys','nested-secret-flags'].includes(kind)) {
          assert.ok(!output.includes('SYNTHETIC_PRIVATE_VALUE'));
          assert.ok(output.includes('next: safe'));
        } else {
          assert.equal(output, input);
        }
      }
      process.stdout.write('bounded and faithful');
    `;
    const child = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script, kind],
      { encoding: "utf8", timeout: 8000, maxBuffer: 1024 * 1024 },
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("bounded and faithful");
  });
});
