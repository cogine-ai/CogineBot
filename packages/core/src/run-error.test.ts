import { describe, expect, it } from "vitest";
import {
  MISSING_TOOL_FINAL_RESPONSE_ERROR,
  normalizeRunError,
  sanitizeRunErrorDetails,
} from "./run-error.js";
import { stuckWorkStatusMessages } from "./stuck-work.js";

describe("run failure diagnostics", () => {
  it.each([
    [
      "Anthropic",
      "max_tokens: 4096 exceeds the maximum tokens allowed for model claude-example: 2048. Reduce max_tokens.",
    ],
    [
      "OpenAI",
      "Rate limit reached for gpt-example on tokens per min. Limit: 10000 / min. Requested: 15000. Please try again in 30s.",
    ],
  ])(
    "retains the complete %s limit diagnosis while masking a real credential field",
    (provider, message) => {
      const normalized = normalizeRunError(
        JSON.stringify({
          error: {
            type: "rate_limit_error",
            message,
            metadata: { provider_name: provider, api_key: "SYNTHETIC_PROVIDER_CREDENTIAL" },
          },
        }),
      );
      expect(normalized.summary).toBe(
        `Your ${provider} is rate limiting requests. Try again shortly.`,
      );
      const parsed = JSON.parse(normalized.details);
      expect(parsed.error.message).toBe(message);
      expect(parsed.error.metadata.api_key).toBe("[Redacted]");
      expect(normalized.details).not.toContain("SYNTHETIC_PROVIDER_CREDENTIAL");
      expect(sanitizeRunErrorDetails(normalized.details)).toBe(normalized.details);
    },
  );

  it("summarizes a provider key limit without placing its diagnostic URL in the summary", () => {
    const details =
      '403: {"message":"Key limit exceeded (weekly); resets 2026-10-12T00:00:00.000Z. Manage https://openrouter.ai/keys/fake-id","metadata":{"limit_source":"openrouter_key_limit"}}';
    expect(normalizeRunError(details)).toEqual({
      summary: "Your OpenRouter key hit its weekly limit. Resets Oct 12.",
      details,
    });
  });
  it("redacts full diagnostics before the byte budget can split a bare credential", () => {
    const secret = "sk-synthetic-only-credential-value-0123456789";
    const details = `${"x".repeat(8155)} ${secret}${"diagnostic ".repeat(20)}`;
    const normalized = normalizeRunError(details);
    expect(normalized.summary).toBe("The model provider returned an error.");
    expect(normalized.details).not.toContain("sk-synthetic");
    expect(new TextEncoder().encode(normalized.details).length).toBeLessThanOrEqual(8192);
    expect(normalized.details).toContain("[Diagnostics truncated at 8 KiB]");
  });

  it.each(["A", "-", "_"])(
    "cleans bare Google keys ending in %s before diagnostic and Unicode clipping",
    (suffix) => {
      const key = `AIza${"SYNTHETIC_ONLY_".padEnd(34, "A")}${suffix}`;
      for (const prefix of [350, 8100, 8140, 8155, 8180, 8200]) {
        const raw = `${"界".repeat(Math.floor(prefix / 3))} (${key})\n${"😀".repeat(200)}`;
        for (const diagnostic of [
          raw,
          JSON.stringify({ response_body: JSON.stringify({ message: raw }) }),
        ]) {
          const normalized = normalizeRunError(diagnostic);
          expect(normalized.summary).toBe("The model provider returned an error.");
          expect(normalized.details).not.toContain("AIza");
          expect(normalized.details).not.toContain("SYNTHETIC_ONLY_");
          expect(new TextEncoder().encode(normalized.details).length).toBeLessThanOrEqual(8192);
          expect(normalized.details).not.toMatch(
            /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
          );
          expect(sanitizeRunErrorDetails(normalized.details)).toBe(normalized.details);
        }
      }
    },
  );

  it.each(["Secret Access Key", "Secret Access Key Material"])(
    "cleans a %s after 300 characters before Unicode clipping",
    (label) => {
      for (const prefix of [350, 8100, 8155, 8190, 8200]) {
        const raw = `${"界".repeat(Math.floor(prefix / 3))}\n${label}: SYNTHETIC_SECRET_ACCESS_VALUE\n${"😀".repeat(200)}`;
        for (const diagnostic of [
          raw,
          JSON.stringify({ response_body: JSON.stringify({ message: raw }) }),
        ]) {
          const cleaned = sanitizeRunErrorDetails(diagnostic);
          expect(cleaned).not.toContain("SYNTHETIC_SECRET_ACCESS_VALUE");
          expect(new TextEncoder().encode(cleaned).length).toBeLessThanOrEqual(8192);
          expect(sanitizeRunErrorDetails(cleaned)).toBe(cleaned);
        }
      }
    },
  );

  it.each(
    ["gsk_", "xai-", "hf_", "csk-", "nvapi-", "fw_"].flatMap((prefix) =>
      [8, 43, 48, 52].map((length) => [prefix, length] as const),
    ),
  )("cleans a bare %s candidate with %s tail characters before clipping", (prefix, length) => {
    const key = `${prefix}${"SYNTHETICPROVIDERONLY".padEnd(length - 1, "A").slice(0, length - 1)}_`;
    for (const prefixBytes of [350, 8100, 8140, 8180, 8200]) {
      const raw = `${"界".repeat(Math.floor(prefixBytes / 3))} (${key})\n${"😀".repeat(200)}`;
      for (const diagnostic of [
        raw,
        JSON.stringify({ response_body: JSON.stringify({ message: raw }) }),
      ]) {
        const cleaned = sanitizeRunErrorDetails(diagnostic);
        expect(cleaned).not.toContain(prefix);
        expect(new TextEncoder().encode(cleaned).length).toBeLessThanOrEqual(8192);
        expect(sanitizeRunErrorDetails(cleaned)).toBe(cleaned);
      }
    }
  });

  it.each([
    [
      '{"error":{"message":"Insufficient credits","code":402,"metadata":{"provider_name":"OpenAI"}}}',
      "Your OpenAI reached its credit limit.",
    ],
    [
      '403: {"message":"Monthly spending limit exceeded","metadata":{"reset_at":"2026-11-01T00:00:00Z"}}',
      "Your model provider reached its monthly spending limit. Resets Nov 1.",
    ],
    [
      '429: {"message":"Too many requests"}',
      "Your model provider is rate limiting requests. Try again shortly.",
    ],
    [
      '{"error":{"type":"rate_limit_error","message":"Slow down","metadata":{"provider":"Anthropic"}}}',
      "Your Anthropic is rate limiting requests. Try again shortly.",
    ],
    [
      '401: {"message":"Incorrect API key; OpenAI"}',
      "Your OpenAI rejected the API key. Check your connection settings.",
    ],
    [
      '403: {"message":"Unauthorized API key"}',
      "Your model provider rejected the API key. Check your connection settings.",
    ],
    [
      '{"error":{"type":"authentication_error","message":"Invalid key"}}',
      "Your model provider rejected the API key. Check your connection settings.",
    ],
    [
      '404: {"error":{"message":"Model fake-model does not exist"}}',
      "Your model provider could not find the requested model.",
    ],
    [
      '{"error":{"code":"model_not_found"}}',
      "Your model provider could not find the requested model.",
    ],
    ["Request timed out", "Your model provider took too long to respond. Try again."],
    [
      '504: {"message":"Gateway error"}',
      "Your model provider took too long to respond. Try again.",
    ],
    ['403: {"message":"Policy blocked the request"}', "The model provider returned an error."],
    ['404: {"message":"Route not found"}', "The model provider returned an error."],
    ["500: {malformed https://example.test/keys/fake-id", "The model provider returned an error."],
    [
      "Provider diagnostic: https://example.test/keys/fake-id",
      "The model provider returned an error.",
    ],
    ["", "The model provider returned an error."],
  ])("keeps diagnostics separate from a controlled summary for %s", (details, summary) => {
    expect(normalizeRunError(details).summary).toBe(summary);
  });

  it.each([
    '429: {"message":"API key rate limit exceeded"}',
    '403: {"message":"API key rate limit exceeded"}',
    '429: {"error":{"type":"rate_limit_error","message":"API key rate limit exceeded"}}',
  ])("keeps per-key rate limits distinct from exhausted quota: %s", (details) => {
    expect(normalizeRunError(details).summary).toBe(
      "Your model provider is rate limiting requests. Try again shortly.",
    );
  });

  it("recognizes exhausted quota even when the response status is 429", () => {
    expect(
      normalizeRunError(
        '429: {"error":{"type":"rate_limit_error","code":"insufficient_quota","message":"Insufficient quota"}}',
      ).summary,
    ).toBe("Your model provider reached its credit limit.");
  });

  it.each([MISSING_TOOL_FINAL_RESPONSE_ERROR, ...stuckWorkStatusMessages()])(
    "retains known application recovery advice: %s",
    (details) => {
      expect(normalizeRunError(details)).toEqual({ summary: details, details });
    },
  );

  it("redacts JSON fields, bearer headers, email addresses and bare credentials", () => {
    const diagnostic =
      '401: {"message":"OpenAI rejected sk-synthetic-only-credential-value","token":"synthetic-token-value","email":"reader@example.test","authorization":"Bearer synthetic-bearer-value"}';
    const normalized = normalizeRunError(diagnostic);
    expect(normalized.summary).toBe(
      "Your OpenAI rejected the API key. Check your connection settings.",
    );
    expect(normalized.details).toBe(
      '401: {"message":"OpenAI rejected [Redacted]","token":"[Redacted]","email":"[Redacted]","authorization":"[Redacted]"}',
    );
    expect(sanitizeRunErrorDetails("Authorization: Bearer synthetic-bearer-value")).toBe(
      "Authorization=[Redacted]",
    );
  });

  it.each([
    ["Authorization: Basic dXNlcjpzeW50aGV0aWMtcGFzcw==", "dXNlcjpzeW50aGV0aWMtcGFzcw=="],
    ["Cookie: session=synthetic-session-only", "synthetic-session-only"],
    ['{"x-api-key":"synthetic-header-key-only"}', "synthetic-header-key-only"],
  ])(
    "cleans standard credential representations before both normal and capped diagnostic display: %s",
    (header, secret) => {
      const normal = normalizeRunError(`Provider failed\n${header}`);
      expect(normal.summary).toBe("The model provider returned an error.");
      expect(normal.details).toContain("[Redacted]");
      expect(normal.details).not.toContain(secret);
      const capped = sanitizeRunErrorDetails(
        `${"界".repeat(2715)}\n${header}\n${"x".repeat(1000)}`,
      );
      expect(capped).not.toContain(secret.slice(0, 8));
      expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(8192);
      expect(capped.endsWith("\n[Diagnostics truncated at 8 KiB]")).toBe(true);
      expect(sanitizeRunErrorDetails(capped)).toBe(capped);
    },
  );

  it.each([
    "client_secret",
    "client-secret",
    "api_key",
    "api-key",
    "api key",
    "access_token",
    "private_key",
    "session_cookie",
  ])(
    "cleans compound %s credentials before Unicode budgeting without erasing classification",
    (key) => {
      const secret = "AIzaSyntheticCredentialOnly0123456789";
      const diagnostic = `401: ${JSON.stringify({ error: { message: "OpenAI rejected the API key", metadata: { [key]: secret } } })}`;
      const normalized = normalizeRunError(diagnostic);
      expect(normalized.summary).toBe(
        "Your OpenAI rejected the API key. Check your connection settings.",
      );
      expect(normalized.details).toContain("OpenAI rejected the API key");
      expect(normalized.details).not.toContain(secret);
      const capped = sanitizeRunErrorDetails(
        `${"界".repeat(2710)}\n${key}: ${secret}\n${"😀".repeat(1000)}`,
      );
      expect(capped).not.toContain("AIzaSynthetic");
      expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(8192);
      expect(capped.endsWith("\n[Diagnostics truncated at 8 KiB]")).toBe(true);
      expect(sanitizeRunErrorDetails(capped)).toBe(capped);
    },
  );

  it("keeps repeated cleanup stable when the budget cuts a redacted JSON field", () => {
    for (let prefix = 8120; prefix < 8200; prefix += 1) {
      const input = `${"x".repeat(prefix)} {"client_secret":"AIzaSyntheticCredentialOnly"} ${"y".repeat(200)}`;
      const once = sanitizeRunErrorDetails(input);
      expect(sanitizeRunErrorDetails(once), `prefix ${prefix}`).toBe(once);
      expect(once).not.toContain("AIzaSynthetic");
      expect(new TextEncoder().encode(once).length).toBeLessThanOrEqual(8192);
    }
  });

  it.each([
    [
      "private PEM",
      "private_key=-----BEGIN DSA PRIVATE KEY-----\nSYNTHETIC_LOGICAL_SECRET_FIRST\n-----END DSA PRIVATE KEY-----",
    ],
    [
      "authorization",
      'Authorization: Digest username="SYNTHETIC_LOGICAL_SECRET_FIRST",\r\n nonce="SYNTHETIC_LOGICAL_SECRET_SECOND"',
    ],
    [
      "block scalar",
      "private_key: >-\n  SYNTHETIC_LOGICAL_SECRET_FIRST\n  SYNTHETIC_LOGICAL_SECRET_SECOND",
    ],
    [
      "plain scalar",
      "client_secret:\n  SYNTHETIC_LOGICAL_SECRET_FIRST\n\n  SYNTHETIC_LOGICAL_SECRET_SECOND",
    ],
    [
      "YAML escaped quote",
      "client_secret: 'SYNTHETIC_LOGICAL_SECRET_FIRST\\''SYNTHETIC_LOGICAL_SECRET_SECOND'",
    ],
    ["pass phrase", "password=SYNTHETIC_LOGICAL_SECRET_FIRST SYNTHETIC_LOGICAL_SECRET_SECOND"],
    [
      "explicit continuation",
      "api-key=SYNTHETIC_LOGICAL_SECRET_FIRST\\\nSYNTHETIC_LOGICAL_SECRET_SECOND",
    ],
    [
      "triple quote",
      'private_key="""\nSYNTHETIC_LOGICAL_SECRET_FIRST\nSYNTHETIC_LOGICAL_SECRET_SECOND\n"""',
    ],
  ])(
    "cleans full %s values before nested decoding and every diagnostic budget boundary",
    (_name, fixture) => {
      for (const material of [
        fixture!,
        JSON.stringify({ response_body: JSON.stringify({ message: fixture }) }),
      ]) {
        const normal = normalizeRunError(
          `401: {"message":"OpenAI rejected the API key"}\n${material}\nretry_after: 30`,
        );
        expect(normal.summary).toBe(
          "Your OpenAI rejected the API key. Check your connection settings.",
        );
        expect(normal.details).not.toContain("SYNTHETIC_LOGICAL_SECRET_");
        expect(normal.details).toContain("retry_after: 30");
        for (let prefix = 8100; prefix < 8200; prefix += 5) {
          const cleaned = sanitizeRunErrorDetails(
            `${"x".repeat(prefix)}\n${material}\n${"😀".repeat(1000)}`,
          );
          expect(cleaned).not.toContain("SYNTHETIC_LOGICAL_SECRET_");
          expect(new TextEncoder().encode(cleaned).length).toBeLessThanOrEqual(8192);
          expect(cleaned.endsWith("\n[Diagnostics truncated at 8 KiB]")).toBe(true);
          expect(sanitizeRunErrorDetails(cleaned), `${_name} at ${prefix}`).toBe(cleaned);
        }
      }
    },
  );

  it("keeps nested SDK-string details and truncation markers safe across repeated cleanup", () => {
    const payload = JSON.stringify({
      error: {
        message: JSON.stringify({
          message: "OpenAI rejected the API key",
          client_secret: "SYNTHETIC_NESTED_CREDENTIAL_ONLY",
        }),
      },
    });
    const normalized = normalizeRunError(`401: ${payload}`);
    expect(normalized.summary).toBe(
      "Your OpenAI rejected the API key. Check your connection settings.",
    );
    expect(normalized.details).not.toContain("SYNTHETIC_NESTED_CREDENTIAL_ONLY");
    for (let prefix = 8090; prefix < 8200; prefix += 1) {
      const once = sanitizeRunErrorDetails(
        `${"x".repeat(prefix)} ${payload} ${"界😀".repeat(200)}`,
      );
      expect(once).not.toContain("SYNTHETIC_NESTED_CREDENTIAL_ONLY");
      expect(new TextEncoder().encode(once).length).toBeLessThanOrEqual(8192);
      expect(sanitizeRunErrorDetails(once), `prefix ${prefix}`).toBe(once);
      expect(once.endsWith("\n[Diagnostics truncated at 8 KiB]")).toBe(true);
    }
  });

  it("does not trust a supplied truncation marker to bypass credential cleanup", () => {
    const cleaned = sanitizeRunErrorDetails(
      '{"client_secret":"AIzaSyntheticMarkerBypass"}\n[Diagnostics truncated at 8 KiB]',
    );
    expect(cleaned).not.toContain("AIzaSyntheticMarkerBypass");
    expect(cleaned).toContain('"client_secret":"[Redacted]"');
    expect(cleaned.endsWith("\n[Diagnostics truncated at 8 KiB]")).toBe(true);
    expect(sanitizeRunErrorDetails(cleaned)).toBe(cleaned);
  });

  it("does not truncate a long secret that redaction shrinks within the budget", () => {
    expect(sanitizeRunErrorDetails(`api_key=${"a".repeat(10000)}`)).toBe("api_key=[Redacted]");
  });

  it("preserves an exact byte-budget diagnostic and marks only an oversized one", () => {
    expect(sanitizeRunErrorDetails("a".repeat(8192))).toBe("a".repeat(8192));
    const oversized = sanitizeRunErrorDetails("a".repeat(8193));
    expect(new TextEncoder().encode(oversized)).toHaveLength(8192);
    expect(oversized.endsWith("\n[Diagnostics truncated at 8 KiB]")).toBe(true);
    expect(sanitizeRunErrorDetails(oversized)).toBe(oversized);
  });

  it("keeps Unicode code points intact and replaces an unpaired surrogate", () => {
    const diagnostic = sanitizeRunErrorDetails(`\uD800a${"界😀".repeat(3000)}`);
    expect(diagnostic.startsWith("\uFFFDa界😀")).toBe(true);
    expect(new TextEncoder().encode(diagnostic).length).toBeLessThanOrEqual(8192);
    expect(
      Array.from(diagnostic).some((character) => {
        const point = character.codePointAt(0)!;
        return point >= 0xd800 && point <= 0xdfff;
      }),
    ).toBe(false);
    expect(diagnostic.endsWith("\n[Diagnostics truncated at 8 KiB]")).toBe(true);
  });

  it("uses a safe generic summary for a truncated JSON envelope", () => {
    const details = `{"message":"${"x".repeat(9000)}","token":"synthetic-secret-value"}`;
    const normalized = normalizeRunError(details);
    expect(normalized.summary).toBe("The model provider returned an error.");
    expect(normalized.details).not.toContain("synthetic-secret-value");
    expect(normalized.details.endsWith("\n[Diagnostics truncated at 8 KiB]")).toBe(true);
  });

  it("caps translated summaries at 500 code points and sanitizes their contents", () => {
    const normalized = normalizeRunError(
      "failure",
      () => `token="synthetic-secret-value"\n${"界😀".repeat(600)}`,
    );
    expect(normalized.summary.startsWith("token=[Redacted]\n")).toBe(true);
    expect(Array.from(normalized.summary)).toHaveLength(500);
    expect(normalized.summary.endsWith("…")).toBe(true);
    expect(normalized.summary).not.toContain("synthetic-secret-value");
  });

  it("uses the translator and selected locale for a known reset date", () => {
    const translate = (message: string, values?: Record<string, string | number>) => {
      const template =
        (
          {
            "Your model provider": "Dein Modellanbieter",
            "{provider} key hit its weekly limit.":
              "{provider}: wöchentliches Schlüssellimit erreicht.",
            "{summary} Resets {date}.": "{summary} Zurückgesetzt am {date}.",
          } as Record<string, string>
        )[message] ?? message;
      return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key]));
    };
    expect(
      normalizeRunError(
        '403: {"message":"Key limit exceeded (weekly); resets 2026-10-12"}',
        translate,
        "de",
      ).summary,
    ).toBe(
      "Dein Modellanbieter: wöchentliches Schlüssellimit erreicht. Zurückgesetzt am 12. Okt..",
    );
  });

  it("ignores a malformed reset date", () => {
    expect(
      normalizeRunError('403: {"message":"Key limit exceeded; resets not-a-date"}').summary,
    ).toBe("Your model provider key hit its limit.");
  });
});
