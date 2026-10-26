import { describe, expect, it } from "vitest";
import { importOpenApiDocument } from "./installed-connectors.js";
import { compileOpenApiDocument, parseOpenApiText } from "./openapi-import.js";

describe("OpenAPI document parsing", () => {
  it("keeps shared YAML anchors and refuses circular or excessive literal nesting", () => {
    expect(parseOpenApiText("one: &shared { value: 1 }\ntwo: *shared\n")).toEqual({
      one: { value: 1 },
      two: { value: 1 },
    });
    expect(() => parseOpenApiText("loop: &loop { child: *loop }\n")).toThrow("invalid_document");
    expect(() => parseOpenApiText(`${'{"child":'.repeat(66)}{}${"}".repeat(66)}`)).toThrow(
      "document_limit",
    );
  });
  it("parses one JSON or YAML mapping and refuses extra documents or non-object JSON", () => {
    expect(parseOpenApiText('{"paths":{}}')).toEqual({ paths: {} });
    expect(parseOpenApiText("paths: {}\n")).toEqual({ paths: {} });
    for (const text of ["null", "[]", "42", '"paths: {}"']) {
      expect(() => parseOpenApiText(text)).toThrow("invalid_document");
    }
    for (const text of ["paths: {}\n---\n", "---\npaths: {}\n---\npaths: {}\n"]) {
      expect(() => parseOpenApiText(text)).toThrow("multiple_documents");
    }
  });
});

describe("OpenAPI operation compilation", () => {
  it.each([
    { type: "string", description: 42 },
    { type: "object", properties: { id: { type: "string" } }, required: ["id", "id"] },
    { type: "string", enum: [1, 2] },
    { type: "number", minimum: 5, exclusiveMaximum: 5 },
    { oneOf: [{ type: "string" }], anyOf: [{ type: "number" }] },
    { type: "string", pattern: "(a+)+$" },
    { type: "object", additionalProperties: { type: "string" } },
  ])("rejects unsupported or impossible schema constraints before install (%j)", (schema) => {
    const compiled = compileOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/items": {
          post: {
            operationId: "create",
            requestBody: { content: { "application/json": { schema } } },
          },
        },
      },
    });
    expect(compiled.operations).toEqual([]);
    expect(compiled.diagnostics[0]!.code).toBe("unsafe_schema");
  });

  it("rejects static paths that URL normalization would change", () => {
    const compiled = compileOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/items/../other": { get: { operationId: "dot" } },
        "/items/%2E/other": { get: { operationId: "escaped" } },
        "/items\\other": { get: { operationId: "backslash" } },
        "/items/\nother": { get: { operationId: "control" } },
        "/items/\ud800": { get: { operationId: "surrogate" } },
        "/safe": { get: { operationId: "safe" } },
      },
    });
    expect(compiled.operations.map((operation) => operation.id)).toEqual(["safe"]);
    expect(compiled.counts).toMatchObject({ accepted: 1, rejected: 5 });
  });

  it("charges repeated expansions and UTF-8 bytes, and diagnoses nested cycles", () => {
    const compile = (schema: unknown, parameters = 1) =>
      compileOpenApiDocument({
        servers: [{ url: "https://api.example.test" }],
        components: { schemas: { Value: schema } },
        paths: {
          "/items": {
            get: {
              operationId: "list",
              parameters: Array.from({ length: parameters }, (_, index) => ({
                name: `value${index}`,
                in: "query",
                schema: { $ref: "#/components/schemas/Value" },
              })),
            },
          },
        },
      });
    expect(compile({ type: "string", description: "a".repeat(8000) }, 2).counts.accepted).toBe(1);
    expect(compile({ type: "string", description: "a".repeat(8000) }, 3).diagnostics[0]!.code).toBe(
      "schema_limit",
    );
    expect(compile({ type: "string", description: "€".repeat(7000) }).diagnostics[0]!.code).toBe(
      "schema_limit",
    );
    expect(
      compile({ type: "object", properties: { child: { $ref: "#/components/schemas/Value" } } })
        .diagnostics[0]!.code,
    ).toBe("reference_cycle");
  });

  it("diagnoses unsupported methods, ignored path references and unsafe property names", () => {
    const compiled = compileOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/head": { head: { operationId: "head" } },
        "/ref": { $ref: "https://schemas.example.test/path" },
        "/prototype": {
          get: {
            operationId: "prototype",
            parameters: [{ name: "__proto__", in: "query", schema: { type: "string" } }],
          },
        },
      },
    });
    expect(compiled.counts).toMatchObject({ discovered: 3, rejected: 3, accepted: 0 });
    expect(compiled.diagnostics.map((item) => item.code)).toEqual([
      "unsupported_method",
      "external_reference",
      "invalid_parameter",
    ]);
  });

  it("resolves escaped own-property pointers and leaves literal reference data untouched", () => {
    const literal = { $ref: "https://schemas.example.test/unused" };
    const compiled = compileOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: {
        schemas: { "A/B~C €": { type: "string", default: literal, examples: [literal] } },
      },
      paths: {
        "/valid": {
          get: {
            operationId: "valid",
            parameters: [
              {
                name: "value",
                in: "query",
                schema: { $ref: "#/components/schemas/A~1B~0C%20%E2%82%AC" },
              },
            ],
          },
        },
        "/inherited": {
          get: {
            operationId: "inherited",
            parameters: [
              { name: "value", in: "query", schema: { $ref: "#/components/schemas/toString" } },
            ],
          },
        },
      },
    });
    expect(compiled.operations[0]!.inputSchema.properties).toEqual({
      value: { type: "string", default: literal, examples: [literal] },
    });
    expect(compiled.diagnostics).toEqual([
      expect.objectContaining({ code: "unresolved_reference", operationId: "inherited" }),
    ]);
  });
  it.each([8, 9])("bounds reference chains at eight hops (%s)", (hops) => {
    const schemas = Object.fromEntries(
      Array.from({ length: hops }, (_, index) => [
        `S${index}`,
        index === hops - 1 ? { type: "string" } : { $ref: `#/components/schemas/S${index + 1}` },
      ]),
    );
    const compiled = compileOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: { schemas },
      paths: {
        "/items": {
          get: {
            operationId: "list",
            parameters: [{ name: "id", in: "query", schema: { $ref: "#/components/schemas/S0" } }],
          },
        },
      },
    });
    expect(compiled.counts.accepted).toBe(hops === 8 ? 1 : 0);
    if (hops === 9) expect(compiled.diagnostics[0]!.code).toBe("reference_depth");
  });

  it("charges the complete independent UTF-8 schema and accepts the exact byte boundary", () => {
    const compile = (padding: number) =>
      compileOpenApiDocument({
        servers: [{ url: "https://api.example.test" }],
        paths: {
          "/items": {
            get: {
              operationId: "list",
              parameters: [
                {
                  name: "id",
                  in: "query",
                  required: true,
                  schema: { type: "string", description: "a".repeat(padding) },
                },
              ],
            },
          },
        },
      });
    const fixed = Buffer.byteLength(
      JSON.stringify({
        type: "object",
        properties: { id: { type: "string", description: "" } },
        required: ["id"],
        additionalProperties: false,
      }),
      "utf8",
    );
    expect(compile(20_000 - fixed).counts.accepted).toBe(1);
    expect(compile(20_001 - fixed).diagnostics[0]!.code).toBe("schema_limit");
  });

  it("rejects both duplicate identities and counts operations beyond its accepted and diagnostic caps", () => {
    const duplicate = compileOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/first": { get: { operationId: "same" } },
        "/second": { post: { operationId: "same" } },
      },
    });
    expect(duplicate.operations).toEqual([]);
    expect(duplicate.diagnostics.map((item) => item.code)).toEqual([
      "duplicate_operation",
      "duplicate_operation",
    ]);
    const capped = compileOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      paths: Object.fromEntries(
        Array.from({ length: 205 }, (_, index) => [
          `/item/${index}`,
          { get: { operationId: `item_${index}` } },
        ]),
      ),
    });
    expect(capped.counts).toEqual({
      discovered: 205,
      accepted: 100,
      rejected: 105,
      omittedDiagnostics: 5,
    });
    expect(capped.diagnostics).toHaveLength(100);
  });

  it("rejects inputs the flat HTTP transport cannot represent and reports the full scan", () => {
    const operations = [
      { parameters: [{ name: "id", in: "query", schema: { type: "object", properties: {} } }] },
      { parameters: [{ name: "id", in: "cookie", schema: { type: "string" } }] },
      {
        parameters: [
          {
            name: "id",
            in: "query",
            style: "pipeDelimited",
            schema: { type: "array", items: { type: "string" } },
          },
        ],
      },
      {
        parameters: [
          { name: "id", in: "header", schema: { type: "string" } },
          { name: "id", in: "query", schema: { type: "string" } },
        ],
      },
      { requestBody: { content: { "application/json": { schema: { type: "string" } } } } },
      { servers: [{ url: "https://other.example.test" }] },
    ];
    const compiled = compileOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      paths: Object.fromEntries(
        operations.map((operation, index) => [
          `/items/${index}`,
          { get: { operationId: `operation_${index}`, ...operation } },
        ]),
      ),
    });
    expect(compiled.operations).toEqual([]);
    expect(compiled.counts).toEqual({
      discovered: 6,
      accepted: 0,
      rejected: 6,
      omittedDiagnostics: 0,
    });
    expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "unsupported_parameter",
      "unsupported_parameter",
      "unsupported_parameter",
      "invalid_parameter",
      "unsupported_parameter",
      "invalid_server",
    ]);
  });

  it("intersects referenced constraints without confusing parameter override with allOf", () => {
    const compiled = compileOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: { schemas: { State: { type: "string", enum: ["draft", "active"] } } },
      paths: {
        "/items": {
          parameters: [{ name: "state", in: "query", required: true, schema: { type: "string" } }],
          get: {
            operationId: "list",
            parameters: [
              {
                name: "state",
                in: "query",
                schema: {
                  allOf: [{ $ref: "#/components/schemas/State" }, { enum: ["active", "archived"] }],
                  default: "active",
                },
              },
            ],
          },
          post: {
            operationId: "conflict",
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/State", enum: ["archived"] },
                },
              },
            },
          },
        },
      },
    });
    expect(compiled.operations.map((operation) => operation.id)).toEqual(["list"]);
    expect(compiled.operations[0]!.inputSchema).toEqual({
      type: "object",
      properties: { state: { type: "string", enum: ["active"], default: "active" } },
      additionalProperties: false,
    });
    expect(compiled.diagnostics).toEqual([
      expect.objectContaining({ code: "unsafe_schema", operationId: "conflict" }),
    ]);
  });

  it("keeps safe operations and diagnoses an unresolved required input", () => {
    const compiled = importOpenApiDocument({
      servers: [{ url: "https://api.example.test/v1" }],
      paths: {
        "/safe": { get: { operationId: "safe" } },
        "/unsafe": {
          get: {
            operationId: "unsafe",
            parameters: [{ $ref: "https://schemas.example.test/parameter.json" }],
          },
        },
      },
    });

    expect(compiled.operations.map((operation) => operation.id)).toEqual(["safe"]);
    expect(compiled).toMatchObject({
      counts: { discovered: 2, accepted: 1, rejected: 1, omittedDiagnostics: 0 },
      diagnostics: [{ scope: "operation", code: "external_reference", operationId: "unsafe" }],
    });
  });
});
