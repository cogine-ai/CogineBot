import { describe, expect, it } from "vitest";
import { redactBindings, redactSensitiveText } from "./redaction.js";

describe("redaction", () => {
  it.each([
    "max_tokens: 4096 exceeds the maximum tokens allowed for model claude-example: 2048. Reduce max_tokens.",
    "Rate limit reached for gpt-example on tokens per min. Limit: 10000 / min. Requested: 15000. Please try again in 30s.",
    "Rate limit reached for gpt-example on tokens per min. Limit=10000; retry_after=30",
    "Daily token quota: 1000; resets 2026-10-25",
    "token limit: 1024",
    "input_tokens=120 output_tokens=80 total_tokens=200",
    "OpenAI API token rejected; error_code: 401; check connection settings",
    "OpenAI token quota reset: 2026-11-01",
    "The token bucket is empty. Retry-After: 60",
  ])("preserves numeric token limits and ordinary provider diagnostics: %s", (input) => {
    expect(redactSensitiveText(input)).toBe(input);
    expect(redactSensitiveText(JSON.stringify({ response_body: input }))).toBe(
      JSON.stringify({ response_body: input }),
    );
  });

  it.each([
    "API key value",
    "private key material",
    "authorization header value",
    "access token",
    "client secret",
  ])("keeps a complete spaced %s credential private beside ordinary limit prose", (key) => {
    const input = `Rate limit reached. ${key}: SYNTHETIC_SPACED_CREDENTIAL\nnext: safe`;
    expect(redactSensitiveText(input)).not.toContain("SYNTHETIC_SPACED_CREDENTIAL");
    expect(redactSensitiveText(input)).toContain("next: safe");
  });

  it.each([
    "max_tokens",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "token_count",
    "tokens_used",
  ])(
    "preserves only actual numeric raw %s counts while keeping credential-shaped values private",
    (key) => {
      expect(redactSensitiveText(`${key}=4096; retry_after=30`)).toBe(
        `${key}=4096; retry_after=30`,
      );
      expect(redactSensitiveText(`${key}=SYNTHETIC_OPAQUE_COUNT_VALUE\nnext: safe`)).not.toContain(
        "SYNTHETIC_OPAQUE_COUNT_VALUE",
      );
      expect(
        redactSensitiveText(`${key}=4096SYNTHETIC_OPAQUE_COUNT_VALUE\nnext: safe`),
      ).not.toContain("SYNTHETIC_OPAQUE_COUNT_VALUE");
      expect(redactSensitiveText("token=12345\nnext: safe")).toBe("token=[Redacted]\nnext: safe");
    },
  );

  it("retains the existing structured binding policy for token counters", () => {
    expect(redactBindings({ max_tokens: 4096, token: 12345, safe_count: 60 })).toEqual({
      max_tokens: "[Redacted]",
      token: "[Redacted]",
      safe_count: 60,
    });
    expect(JSON.parse(redactSensitiveText('{"max_tokens":4096,"next":"safe"}'))).toEqual({
      max_tokens: "[Redacted]",
      next: "safe",
    });
  });

  it("redacts secrets, credentials, and message bodies", () => {
    const redacted = redactBindings({
      "user.id": "user-1",
      email: "person@example.com",
      authorization: "Bearer secret",
      cookie: "session=abc",
      prompt: "do not log",
      messages: [{ role: "user", content: "hi" }],
      body: { text: "payload" },
      query: { q: "search" },
      apiKey: "sk-live",
      nested: { password: "hunter2", token: "abc", safe: true },
    });
    expect(redacted["user.id"]).toBe("user-1");
    expect(redacted.email).toBe("[Redacted]");
    expect(redacted.authorization).toBe("[Redacted]");
    expect(redacted.cookie).toBe("[Redacted]");
    expect(redacted.prompt).toBe("[Redacted]");
    expect(redacted.messages).toBe("[Redacted]");
    expect(redacted.body).toBe("[Redacted]");
    expect(redacted.query).toBe("[Redacted]");
    expect(redacted.apiKey).toBe("[Redacted]");
    expect(redacted.nested).toEqual({ password: "[Redacted]", token: "[Redacted]", safe: true });
  });

  it("replaces circular values", () => {
    const cycle: Record<string, unknown> = { "request.id": "r1" };
    cycle.self = cycle;
    const redacted = redactBindings(cycle);
    expect(redacted["request.id"]).toBe("r1");
    expect(redacted.self).toBe("[Circular]");
  });

  it("redacts Error values nested in bindings", () => {
    const cause = new Error("password=inner-secret");
    const error = new Error("request failed with token=outer-secret", { cause });

    const redacted = redactBindings({ detail: error });

    expect(redacted.detail).toMatchObject({
      name: "Error",
      message: "request failed with token=[Redacted]",
      cause: { name: "Error", message: "password=[Redacted]" },
    });
    expect(JSON.stringify(redacted.detail)).not.toMatch(/inner-secret|outer-secret/);
  });

  it("redacts string Error causes", () => {
    const error = new Error("request failed", { cause: "token=cause-secret" });

    const redacted = redactBindings({ detail: error });

    expect(redacted.detail).toMatchObject({
      name: "Error",
      message: "request failed",
      cause: "token=[Redacted]",
    });
    expect(JSON.stringify(redacted.detail)).not.toContain("cause-secret");
  });

  it("redacts secrets embedded in string binding values", () => {
    const redacted = redactBindings({
      detail: "token=binding-secret",
      nested: { note: "Bearer nested-secret" },
    });

    expect(redacted).toEqual({
      detail: "token=[Redacted]",
      nested: { note: "Bearer [Redacted]" },
    });
  });

  it("redacts secrets embedded in free text", () => {
    const redacted = redactSensitiveText(
      "user person@example.com used Bearer supersecret and token=abc123",
    );
    expect(redacted).toContain("[Redacted]");
    expect(redacted).not.toContain("person@example.com");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).not.toContain("abc123");
  });

  it("redacts bare API keys and JWTs in free text", () => {
    const redacted = redactSensitiveText(
      "key sk-or-v1-abc123456789 and sk-live-secret99 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig ak_secretvaluehere",
    );
    expect(redacted).not.toMatch(
      /sk-or-v1-abc123456789|sk-live-secret99|eyJhbGciOiJIUzI1NiJ9|ak_secretvaluehere/,
    );
    expect(redacted).toContain("[Redacted]");
  });

  it.each(["sk_live", "sk_test", "rk_live", "rk_test"])(
    "redacts bare %s payment keys",
    (prefix) => {
      const key = `${prefix}_0123456789ABCDEF`;

      expect(redactSensitiveText(`Payment failed (${key}).`)).toBe("Payment failed ([Redacted]).");
      expect(redactSensitiveText(`Processor retry: ${key}_retry`)).toBe(
        "Processor retry: [Redacted]_retry",
      );
    },
  );

  it("preserves short payment-key placeholders and publishable keys", () => {
    const text =
      "sk_live_0123456789ABCDE rk_test_config pk_live_0123456789ABCDEF payment succeeded";

    expect(redactSensitiveText(text)).toBe(text);
  });

  it.each([
    ["Authorization: Basic dXNlcjpzeW50aGV0aWMtcGFzcw==", "Authorization=[Redacted]"],
    ["Proxy-Authorization: Basic c3ludGhldGljOmNyZWRlbnRpYWw=", "Proxy-Authorization=[Redacted]"],
    ["Cookie: session=synthetic-session-only; preference=private", "Cookie=[Redacted]"],
    ["Set-Cookie: session=synthetic-session-only; HttpOnly; Secure", "Set-Cookie=[Redacted]"],
    ['{"x-api-key":"synthetic-header-key-only"}', '{"x-api-key":"[Redacted]"}'],
    ["X-API-Key: synthetic-header-key-only", "X-API-Key=[Redacted]"],
  ])("redacts standard credential headers in free text: %s", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
    expect(redactSensitiveText(expected)).toBe(expected);
  });

  it("redacts the complete unquoted private PEM key without consuming the next diagnostic", () => {
    const input =
      "OpenAI rejected the API key\nprivate_key=-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_PEM_BODY_ONLY\n-----END PRIVATE KEY-----\nRetry-After: 30";
    const cleaned = redactSensitiveText(input);
    expect(cleaned).not.toContain("SYNTHETIC_PRIVATE_PEM_BODY_ONLY");
    expect(cleaned).toContain("OpenAI rejected the API key");
    expect(cleaned).toContain("Retry-After: 30");
    expect(redactSensitiveText(cleaned)).toBe(cleaned);
  });

  it("redacts an entire authorization header with an arbitrary scheme and folded fields", () => {
    const input =
      'OpenAI rejected the API key\nAuthorization: Digest username="SYNTHETIC_AUTH_USER",\r\n nonce="SYNTHETIC_AUTH_NONCE", response="SYNTHETIC_AUTH_RESPONSE"\r\nRetry-After: 30';
    const cleaned = redactSensitiveText(input);
    expect(cleaned).not.toMatch(/SYNTHETIC_AUTH_/);
    expect(cleaned).toContain("OpenAI rejected the API key");
    expect(cleaned).toContain("Retry-After: 30");
    expect(redactSensitiveText(cleaned)).toBe(cleaned);
  });

  it("redacts every indented line in an explicitly declared credential block", () => {
    const input =
      "OpenAI rejected the API key\nprivate_key: |-\n  SYNTHETIC_BLOCK_FIRST_LINE\n  SYNTHETIC_BLOCK_SECOND_LINE\nretry_after: 30";
    const cleaned = redactSensitiveText(input);
    expect(cleaned).not.toMatch(/SYNTHETIC_BLOCK_/);
    expect(cleaned).toContain("OpenAI rejected the API key");
    expect(cleaned).toContain("retry_after: 30");
    expect(redactSensitiveText(cleaned)).toBe(cleaned);
  });

  it.each([
    "api-key=SYNTHETIC_CONTINUED_FIRST\\\n  SYNTHETIC_CONTINUED_SECOND\nretry_after: 30",
    'private_key = """\nSYNTHETIC_CONTINUED_FIRST\nSYNTHETIC_CONTINUED_SECOND\n"""\nretry_after: 30',
  ])("redacts a complete explicitly continued or triple-quoted credential value", (input) => {
    const cleaned = redactSensitiveText(input);
    expect(cleaned).not.toMatch(/SYNTHETIC_CONTINUED_/);
    expect(cleaned).toContain("retry_after: 30");
    expect(redactSensitiveText(cleaned)).toBe(cleaned);
  });

  it("redacts an explicitly continued authorization header even without folding indentation", () => {
    const input =
      "Authorization: Custom SYNTHETIC_HEADER_FIRST\\\nSYNTHETIC_HEADER_SECOND\nRetry-After: 30";
    const cleaned = redactSensitiveText(input);
    expect(cleaned).not.toMatch(/SYNTHETIC_HEADER_/);
    expect(cleaned).toContain("Retry-After: 30");
    expect(redactSensitiveText(cleaned)).toBe(cleaned);
  });

  it("preserves ordinary Basic prose and nonsecret response headers", () => {
    const text = "Basic usage is documented.\nContent-Type: application/json\nRetry-After: 60";
    expect(redactSensitiveText(text)).toBe(text);
  });

  it.each([
    "client_secret:\n  SYNTHETIC_PLAIN_SECRET_ONLY\nnext: safe",
    "client_secret:\n  SYNTHETIC_PLAIN_SECRET_FIRST\n  SYNTHETIC_PLAIN_SECRET_SECOND\nnext: safe",
    "password=SYNTHETIC_PLAIN_SECRET_FIRST SYNTHETIC_PLAIN_SECRET_SECOND\nnext: safe",
    'metadata:\n  "client-secret":\n    SYNTHETIC_PLAIN_SECRET_FIRST\n\n    SYNTHETIC_PLAIN_SECRET_SECOND\n  next: safe',
  ])("cleans the full logical value of an explicitly named plain credential", (input) => {
    const cleaned = redactSensitiveText(input);
    expect(cleaned).not.toMatch(/SYNTHETIC_PLAIN_SECRET_/);
    expect(cleaned).toContain("next: safe");
    expect(redactSensitiveText(cleaned)).toBe(cleaned);
  });

  it.each([
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "DSA PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
  ])("cleans the complete %s armor in raw, quoted and encoded diagnostics", (label) => {
    const secret = "SYNTHETIC_PRIVATE_ARMOR_PAYLOAD_ONLY";
    const block = `-----BEGIN ${label}-----\n${secret}\n-----END ${label}-----`;
    for (const input of [
      block,
      `private_key=${block}`,
      `private_key=${block.replaceAll("\n", "\\n")}`,
      JSON.stringify({ private_key: block }),
      JSON.stringify({ message: `OpenAI provider failure\n${block}` }),
      JSON.stringify({ response_body: JSON.stringify({ message: block }) }),
    ]) {
      const cleaned = redactSensitiveText(input);
      expect(cleaned).not.toContain(secret);
      expect(cleaned).toContain("[Redacted]");
      expect(redactSensitiveText(cleaned)).toBe(cleaned);
    }
    for (const end of ["", "\n-----END PUBLIC KEY-----"]) {
      const cleaned = redactSensitiveText(
        `OpenAI failed\n-----BEGIN ${label}-----\n${secret}${end}`,
      );
      expect(cleaned).not.toContain(secret);
      expect(cleaned).toContain("OpenAI failed");
      expect(redactSensitiveText(cleaned)).toBe(cleaned);
    }
  });

  it.each(["PUBLIC KEY", "RSA PUBLIC KEY", "CERTIFICATE", "CERTIFICATE REQUEST"])(
    "preserves public %s armor outside a declared credential field",
    (label) => {
      const text = `-----BEGIN ${label}-----\nSYNTHETIC_PUBLIC_PAYLOAD_ONLY\n-----END ${label}-----`;
      expect(redactSensitiveText(text)).toBe(text);
      expect(redactSensitiveText(JSON.stringify({ message: text }))).toBe(
        JSON.stringify({ message: text }),
      );
    },
  );

  it.each([
    "Token",
    "ApiKey",
    "Digest",
    "Negotiate",
    "AWS4-HMAC-SHA256",
    "Custom",
    "Unlisted-Scheme",
  ])("cleans the entire %s authorization value independent of the scheme name", (scheme) => {
    for (const name of ["Authorization", "Proxy-Authorization", "x_authorization"]) {
      const value = `${scheme} SYNTHETIC_HEADER_BODY, part="SYNTHETIC_HEADER_PARAMETER"`;
      for (const input of [
        `${name}: ${value}\nRetry-After: 30`,
        `${name}: ${value}\r\n\tSYNTHETIC_HEADER_CONTINUATION\r\nRetry-After: 30`,
        `${name}: ${value}\\\nSYNTHETIC_HEADER_CONTINUATION\nRetry-After: 30`,
        `${name}: |\n  ${value}\n  SYNTHETIC_HEADER_CONTINUATION\nRetry-After: 30`,
        JSON.stringify({
          [name]: value,
          message: "OpenAI rejected the API key",
        }),
        JSON.stringify({
          response_body: JSON.stringify({
            message: `${name}: ${value}\n SYNTHETIC_HEADER_CONTINUATION`,
          }),
        }),
      ]) {
        const cleaned = redactSensitiveText(input);
        expect(cleaned).not.toMatch(/SYNTHETIC_HEADER_/);
        expect(cleaned).toContain("[Redacted]");
        expect(redactSensitiveText(cleaned)).toBe(cleaned);
        if (input.includes("Retry-After: 30")) expect(cleaned).toContain("Retry-After: 30");
      }
    }
  });

  it.each(["|", "|-", "|+", ">", ">-", ">+", "|2-", ">+2"])(
    "consumes every line in a declared %s credential scalar",
    (indicator) => {
      for (const name of ["private_key", "api-key", '"client_secret"']) {
        const input = `metadata:\n  ${name}: ${indicator} # private value\n    SYNTHETIC_SCALAR_FIRST\n\n    SYNTHETIC_SCALAR_SECOND\n  retry_after: 30`;
        const cleaned = redactSensitiveText(input);
        expect(cleaned).not.toMatch(/SYNTHETIC_SCALAR_/);
        expect(cleaned).toContain("retry_after: 30");
        expect(redactSensitiveText(cleaned)).toBe(cleaned);
      }
      const ordinary = `message: ${indicator}\n  ordinary provider diagnostic\nretry_after: 30`;
      expect(redactSensitiveText(ordinary)).toBe(ordinary);
    },
  );

  it.each(['"""', "'''"])("cleans complete and unterminated %s credential strings", (quote) => {
    const full = `private_key=${quote}\nSYNTHETIC_TRIPLE_FIRST\nSYNTHETIC_TRIPLE_SECOND\n${quote}\nretry_after: 30`;
    const cleaned = redactSensitiveText(full);
    expect(cleaned).not.toMatch(/SYNTHETIC_TRIPLE_/);
    expect(cleaned).toContain("retry_after: 30");
    expect(redactSensitiveText(cleaned)).toBe(cleaned);
    expect(redactSensitiveText(`private_key=${quote}\nSYNTHETIC_TRIPLE_FIRST`)).not.toContain(
      "SYNTHETIC_TRIPLE_",
    );
  });

  it.each([
    "client_secret: 'SYNTHETIC_YAML_FIRST''SYNTHETIC_YAML_SECOND'\nnext: safe",
    "'client_secret': 'SYNTHETIC_YAML_FIRST''SYNTHETIC_YAML_SECOND'\nnext: safe",
    "client_secret: 'SYNTHETIC_YAML_FIRST''\n  SYNTHETIC_YAML_SECOND'\nnext: safe",
    "'api''key': 'SYNTHETIC_YAML_FIRST''SYNTHETIC_YAML_SECOND'\nnext: safe",
    "{client_secret: 'SYNTHETIC_YAML_FIRST\nSYNTHETIC_YAML_SECOND',\nnext: safe}",
    "{client_secret: 'SYNTHETIC_YAML_FIRST\\''\nSYNTHETIC_YAML_SECOND',\nnext: safe}",
  ])("cleans the whole YAML quoted credential with doubled-quote escapes", (input) => {
    for (const diagnostic of [input, JSON.stringify({ response_body: input })]) {
      const cleaned = redactSensitiveText(diagnostic);
      expect(cleaned).not.toMatch(/SYNTHETIC_YAML_/);
      expect(cleaned).toContain("next: safe");
      expect(redactSensitiveText(cleaned)).toBe(cleaned);
    }
  });

  it.each([0, 1, 2, 3, 4, 5])(
    "cleans declared single-quoted credentials with %i literal backslashes before doubled quotes",
    (count) => {
      const escapedQuote = `${"\\".repeat(count)}''`;
      for (const input of [
        `client_secret: 'SYNTHETIC_AMBIGUOUS_FIRST${escapedQuote}SYNTHETIC_AMBIGUOUS_SECOND'\nnext: safe`,
        `'api${escapedQuote}key': 'SYNTHETIC_AMBIGUOUS_FIRST''SYNTHETIC_AMBIGUOUS_SECOND'\nnext: safe`,
      ]) {
        for (const diagnostic of [input, JSON.stringify({ response_body: input })]) {
          const cleaned = redactSensitiveText(diagnostic);
          expect(cleaned).not.toMatch(/SYNTHETIC_AMBIGUOUS_/);
          expect(cleaned).toContain("next: safe");
          expect(redactSensitiveText(cleaned)).toBe(cleaned);
        }
      }
    },
  );

  it("preserves valid JSON siblings and cannot hide appended secrets behind a cleanup marker", () => {
    const input = JSON.stringify({
      client_secret: "SYNTHETIC_JSON_PRIVATE",
      next: "safe",
      message: "OpenAI rejected the API key",
    });
    expect(JSON.parse(redactSensitiveText(input))).toEqual({
      client_secret: "[Redacted]",
      next: "safe",
      message: "OpenAI rejected the API key",
    });
    expect(redactSensitiveText("Authorization=[Redacted]\\")).toBe("Authorization=[Redacted]");
    expect(
      redactSensitiveText("Authorization=[Redacted] SYNTHETIC_APPENDED_PRIVATE\nnext: safe"),
    ).toBe("Authorization=[Redacted]\nnext: safe");
  });

  it.each(["client_secret", "private_key", "api-key", "password"])(
    "treats a cleanup marker as untrusted content in every raw %s value",
    (key) => {
      for (const name of [key, `'${key}'`, `"${key}"`]) {
        for (const separator of [":", "="]) {
          for (const suffix of [
            "SYNTHETIC_MARKER_PAYLOAD",
            ",SYNTHETIC_MARKER_PAYLOAD",
            "\\nSYNTHETIC_MARKER_PAYLOAD",
          ]) {
            const raw = `${name}${separator}[Redacted]${suffix}\nnext: safe`;
            for (const input of [raw, JSON.stringify({ response_body: raw })]) {
              const cleaned = redactSensitiveText(input);
              expect(cleaned).not.toContain("SYNTHETIC_MARKER_PAYLOAD");
              expect(cleaned).toContain("next: safe");
              expect(redactSensitiveText(cleaned)).toBe(cleaned);
            }
            const json = JSON.stringify({ [key]: `[Redacted]${suffix}`, next: "safe" });
            expect(JSON.parse(redactSensitiveText(json))).toEqual({
              [key]: "[Redacted]",
              next: "safe",
            });
          }
        }
      }
    },
  );

  it.each([1, 3, 5])(
    "reads complete literal and escaped triple-quote boundaries with %i backslashes",
    (count) => {
      for (const quote of ["'", '"']) {
        const delimiter = quote.repeat(3);
        for (const newline of ["", "\n"]) {
          const raw = `private_key=${delimiter}SYNTHETIC_TRIPLE_PRIVATE_FIRST${"\\".repeat(count)}${delimiter}${newline}SYNTHETIC_TRIPLE_PRIVATE_SECOND${delimiter}\nnext: safe`;
          for (const input of [raw, JSON.stringify({ response_body: raw })]) {
            const cleaned = redactSensitiveText(input);
            expect(cleaned).not.toContain("SYNTHETIC_TRIPLE_PRIVATE_");
            expect(cleaned).toContain("next: safe");
            expect(redactSensitiveText(cleaned)).toBe(cleaned);
          }
        }
      }
    },
  );

  it("does not borrow a later field to close an invalid escaped-quote candidate", () => {
    for (const input of [
      "private_key='SYNTHETIC_LITERAL_END\\'\nnext: 'safe'",
      "private_key='''SYNTHETIC_LITERAL_END\\'''\nnext: 'safe'",
    ]) {
      const cleaned = redactSensitiveText(input);
      expect(cleaned).not.toContain("SYNTHETIC_LITERAL_END");
      expect(cleaned).toContain("next: 'safe'");
      expect(redactSensitiveText(cleaned)).toBe(cleaned);
    }
  });

  it.each([
    "client_secret",
    "client-secret",
    "client secret",
    "api_key",
    "api-key",
    "api key",
    "access_token",
    "access-token",
    "private_key",
    "private-key",
    "session_cookie",
    "session-cookie",
  ])("uses consistent compound credential names for bindings, JSON and text: %s", (key) => {
    const secret = "AIzaSyntheticCredentialOnly0123456789";
    expect(redactBindings({ [key]: secret })).toEqual({ [key]: "[Redacted]" });
    const json = redactSensitiveText(JSON.stringify({ [key]: secret }));
    expect(JSON.parse(json)).toEqual({ [key]: "[Redacted]" });
    expect(redactSensitiveText(`${key}: ${secret}`)).toBe(`${key}=[Redacted]`);
    expect(redactSensitiveText(`{'${key}':'${secret}'}`)).not.toContain(secret);
    expect(redactSensitiveText(`"${key}" = "${secret}"`)).not.toContain(secret);
    expect(redactSensitiveText(json)).toBe(json);
    expect(redactSensitiveText(`${key}=[Redacted]`)).toBe(`${key}=[Redacted]`);
  });

  it("decodes escaped JSON key names while preserving provider error content", () => {
    const input = String.raw`{"error":{"message":"OpenAI rejected the API key","metadata":{"client\u005fsecret":"AIzaSyntheticOnly","api\u002dkey":"opaque-api-value","private_key":"line1\nline2"}},"retry_after":30}`;
    const output = redactSensitiveText(input);
    expect(JSON.parse(output)).toEqual({
      error: {
        message: "OpenAI rejected the API key",
        metadata: {
          client_secret: "[Redacted]",
          "api-key": "[Redacted]",
          private_key: "[Redacted]",
        },
      },
      retry_after: 30,
    });
    expect(redactSensitiveText(output)).toBe(output);
  });

  it("cleans nested raw assignments and quoted values without hiding ordinary text", () => {
    expect(redactSensitiveText("Provider error: api-key: AIzaSyntheticOnly")).toBe(
      "Provider error: api-key=[Redacted]",
    );
    expect(redactSensitiveText("client-secret='opaque value with spaces' retry_after=30")).toBe(
      "client-secret=[Redacted]",
    );
    expect(redactSensitiveText("client-secret='opaque value with spaces'\nretry_after=30")).toBe(
      "client-secret=[Redacted]\nretry_after=30",
    );
    const normal =
      '{"error":{"message":"Provider is overloaded","retry_after":30},"model":"example-model","monkey":"normal","key":"not a credential declaration"}';
    expect(redactSensitiveText(normal)).toBe(normal);
    expect(redactSensitiveText("Basic usage. Content-Type: application/json; model=example")).toBe(
      "Basic usage. Content-Type: application/json; model=example",
    );
  });

  it("redacts whole compound credential values and cookie lines", () => {
    expect(
      redactSensitiveText(
        '{"client_credentials":{"value":"opaque-one"},"private_key":["opaque-two"],"access_token":12345,"message":"retain classification"}',
      ),
    ).toBe(
      '{"client_credentials":"[Redacted]","private_key":"[Redacted]","access_token":"[Redacted]","message":"retain classification"}',
    );
    expect(
      redactSensitiveText("session-cookie: sid=opaque-one; other=opaque-two\nretry_after: 30"),
    ).toBe("session-cookie=[Redacted]\nretry_after: 30");
  });

  it("preserves a long ordinary diagnostic without speculative credential matching", () => {
    const text = "ordinary diagnostic context ".repeat(20_000);
    expect(redactSensitiveText(text)).toBe(text);
  });

  it("cleans malformed credential containers conservatively", () => {
    for (const text of [
      '{"client_credentials":{"value":"opaque-private-value",',
      '{"private_key":["opaque-private-value"',
      '{"client_secret":"opaque-private-value',
    ]) {
      const cleaned = redactSensitiveText(text);
      expect(cleaned).not.toContain("opaque-private-value");
      expect(cleaned).toContain("[Redacted]");
      expect(redactSensitiveText(cleaned)).toBe(cleaned);
    }
  });

  it.each([
    (secret: string) =>
      JSON.stringify({
        error: {
          message: JSON.stringify({
            message: "OpenAI rejected the API key",
            client_secret: secret,
          }),
        },
      }),
    (secret: string) => JSON.stringify({ response_body: JSON.stringify({ "api-key": secret }) }),
    (secret: string) =>
      JSON.stringify({ metadata: { body: JSON.stringify({ "API key": secret }) } }),
    (secret: string) =>
      `SDK raw response: ${JSON.stringify({ response_body: JSON.stringify({ private_key: secret }) })}`,
    (secret: string) =>
      JSON.stringify({
        response: JSON.stringify({ response_body: JSON.stringify({ "client-secret": secret }) }),
      }),
  ])("cleans SDK JSON strings using the same credential rules", (fixture) => {
    const secret = "SYNTHETIC_NESTED_CREDENTIAL_ONLY";
    const output = redactSensitiveText(fixture(secret));
    expect(output).not.toContain(secret);
    expect(output).toContain("[Redacted]");
    expect(redactSensitiveText(output)).toBe(output);
    if (fixture(secret).includes("OpenAI rejected the API key"))
      expect(output).toContain("OpenAI rejected the API key");
  });

  it("bounds encoded-string recursion while leaving ordinary provider messages intact", () => {
    const secret = "SYNTHETIC_DEEP_CREDENTIAL_ONLY";
    let encoded = JSON.stringify({ client_secret: secret });
    for (let depth = 0; depth < 12; depth += 1)
      encoded = JSON.stringify({ response_body: encoded });
    const cleaned = redactSensitiveText(encoded);
    expect(cleaned).not.toContain(secret);
    expect(() => JSON.parse(cleaned)).not.toThrow();
    expect(redactSensitiveText(cleaned)).toBe(cleaned);
    expect(redactSensitiveText('{"error":{"message":"OpenAI rejected the API key"}}')).toBe(
      '{"error":{"message":"OpenAI rejected the API key"}}',
    );
  });

  it("redacts quoted JSON credential fields", () => {
    const redacted = redactSensitiveText(
      '{"password":"hunter2","token":"abc","authorization":"Bearer secret"}',
    );
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain('"token":"abc"');
    expect(redacted).not.toContain("Bearer secret");
    expect(redacted).toContain('"password":"[Redacted]"');
    expect(redacted).toContain('"token":"[Redacted]"');
    expect(redacted).toContain('"authorization":"[Redacted]"');
  });
});
