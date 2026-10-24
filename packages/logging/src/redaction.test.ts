import { describe, expect, it } from "vitest";
import { redactBindings, redactSensitiveText } from "./redaction.js";

describe("redaction", () => {
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

  it("preserves ordinary Basic prose and nonsecret response headers", () => {
    const text = "Basic usage is documented.\nContent-Type: application/json\nRetry-After: 60";
    expect(redactSensitiveText(text)).toBe(text);
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
      "client-secret=[Redacted] retry_after=30",
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
