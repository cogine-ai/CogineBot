import { describe, expect, it } from "vitest";
import {
  CONNECTOR_REDACTION_MAX_DEPTH,
  CONNECTOR_REDACTION_MAX_NODES,
  redactConnectorPayload,
  sanitizeConnectorError,
  tryRedactConnectorPayload,
} from "./connector-safety.js";

describe("redactConnectorPayload", () => {
  it("distinguishes processing failure from a valid service error payload", () => {
    const service = { ok: false, error: "redaction_error", body: "service diagnostic" };
    expect(tryRedactConnectorPayload(service, [])).toEqual({ ok: true, value: service });
    expect(tryRedactConnectorPayload(undefined, [])).toEqual({ ok: true, value: undefined });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(tryRedactConnectorPayload(circular, [])).toEqual({
      ok: false,
      error: "redaction_error",
    });
  });
  it("preserves empty successful responses", () => {
    expect(redactConnectorPayload(undefined, ["secret"])).toBeUndefined();
    expect(redactConnectorPayload(undefined, [])).toBeUndefined();
  });

  it("redacts secrets that JSON escapes in property names and values", () => {
    const secret = 'api"key';

    expect(
      redactConnectorPayload(
        {
          [secret]: `prefix ${secret} suffix`,
          nested: { value: secret },
        },
        [secret],
      ),
    ).toEqual({
      "[redacted]": "prefix [redacted] suffix",
      nested: { value: "[redacted]" },
    });
  });

  it("reports a redaction error when the payload is not JSON serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(redactConnectorPayload(circular, ["secret"])).toEqual({ error: "redaction_error" });
    expect(redactConnectorPayload(circular, [])).toEqual({ error: "redaction_error" });
  });

  it("redacts secrets represented by non-string JSON leaves", () => {
    expect(
      redactConnectorPayload({ number: 123, boolean: true, empty: null }, ["123", "true", "null"]),
    ).toEqual({ number: "[redacted]", boolean: "[redacted]", empty: "[redacted]" });
  });
  it("keeps redacted business strings plain while keeping scalar MCP JSON parseable", () => {
    const redacted = redactConnectorPayload(
      { echo: "37", content: [{ type: "text", text: "37" }] },
      ["37"],
    ) as { echo: string; content: Array<{ text: string }> };
    expect(redacted.echo).toBe("[redacted]");
    expect(JSON.parse(redacted.content[0]!.text)).toBe("[redacted]");
  });
  it("redacts nested JSON quoted, backslash, newline, numeric and Unicode-escaped credentials", () => {
    const credentials = [
      'quoted"credential',
      "backslash\\credential",
      "line\ncredential",
      "37",
      "unicode-key",
    ];
    const value = {
      quote: credentials[0],
      slash: credentials[1],
      line: credentials[2],
      count: 37,
      unicode: "unicode-key",
    };
    const jsonText = JSON.stringify(value).replace("unicode-key", "\\u0075nicode-key");
    const raw = { content: [{ type: "text", text: jsonText }], structuredContent: value };
    const redacted = redactConnectorPayload(raw, credentials) as typeof raw;
    expect(JSON.parse(redacted.content[0]!.text)).toEqual({
      quote: "[redacted]",
      slash: "[redacted]",
      line: "[redacted]",
      count: "[redacted]",
      unicode: "[redacted]",
    });
    expect(redacted.structuredContent).toEqual(JSON.parse(redacted.content[0]!.text));
    expect(raw.content[0]!.text).toBe(jsonText);
  });
  it("keeps unchanged JSON text formatting and large opaque image data", () => {
    const text = ' { "id" : "exact-id", "count" : 37 }\n';
    const data = "synthetic-image-bytes".repeat(150000);
    const raw = {
      content: [
        { type: "text", text },
        { type: "image", data, mimeType: "image/png" },
      ],
    };
    expect(redactConnectorPayload(raw, ["unrelated-credential"])).toEqual(raw);
    expect(redactConnectorPayload(raw, [])).toEqual(raw);
  });
  it("redacts escaped credentials in malformed JSON text without claiming it is valid JSON", () => {
    const credential = 'quoted"credential';
    const text = `incomplete {"echo":${JSON.stringify(credential)}`;
    const result = redactConnectorPayload({ text }, [credential]) as { text: string };
    expect(result.text).toBe('incomplete {"echo":"[redacted]"');
  });
  it("redacts locally known credentials echoed as JSON in provider errors", () => {
    const credential = 'quoted"credential';
    const json = JSON.stringify({ echo: credential });
    expect(JSON.parse(sanitizeConnectorError(new Error(json), [credential]))).toEqual({
      echo: "[redacted]",
    });
    expect(
      sanitizeConnectorError(new Error(`upstream rejected ${json}`), [credential]),
    ).not.toContain("credential");
  });
  it("fails closed on deep or excessive JSON graphs and nested encoded JSON", () => {
    let deep: unknown = "credential";
    for (let index = 0; index <= CONNECTOR_REDACTION_MAX_DEPTH; index += 1) deep = { nested: deep };
    expect(redactConnectorPayload(deep, ["credential"])).toEqual({ error: "redaction_error" });
    expect(redactConnectorPayload(Array(CONNECTOR_REDACTION_MAX_NODES).fill(0), [])).toEqual({
      error: "redaction_error",
    });
    expect(redactConnectorPayload({ text: JSON.stringify(deep) }, ["credential"])).toEqual({
      error: "redaction_error",
    });
  });
});
