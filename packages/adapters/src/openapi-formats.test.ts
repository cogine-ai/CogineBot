import { describe, expect, it, vi } from "vitest";
import { InstalledConnectorProvider } from "./installed-connectors.js";
import { assertOpenApiArguments, compileOpenApiDocument } from "./openapi-import.js";
import { parametersFor } from "./pi-runtime.js";

const source = "https://93.184.216.34";
const context = {
  userId: "user-1",
  spaceId: "space-1",
  workspaceId: "workspace-1",
  signal: new AbortController().signal,
} as never;
const formats = [
  ["date", "2024-02-29", "2023-02-29"],
  ["time", "12:34:56Z", "25:34:56Z"],
  ["date-time", "2024-02-29T12:34:56Z", "2023-02-29T12:34:56Z"],
  ["uuid", "123e4567-e89b-12d3-a456-426614174000", "not-a-uuid"],
  ["email", "person@example.test", "person@@example.test"],
  ["uri", "https://example.test/a?b=c", "https://exa mple.test"],
  ["uri-reference", "/items/123?version=1#body", "%not-a-reference"],
  ["hostname", "api.example.test", "bad..example.test"],
  ["ipv4", "192.0.2.1", "256.0.2.1"],
  ["ipv6", "2001:db8::1", "2001:db8::wrong"],
] as const;

function compile(schema: Record<string, unknown>, count = 1) {
  return compileOpenApiDocument({
    servers: [{ url: source }],
    paths: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `/items/${index}`,
        {
          post: {
            operationId: `create_${index}`,
            requestBody: { required: true, content: { "application/json": { schema } } },
          },
        },
      ]),
    ),
  });
}

describe("bounded OpenAPI formats", () => {
  it.each([
    ["int32", -2_147_483_648, 2_147_483_648, -2_147_483_648, 2_147_483_647, "integer"],
    [
      "int64",
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      -Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      "integer",
    ],
    [
      "double",
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
      -Number.MAX_VALUE,
      Number.MAX_VALUE,
      "number",
    ],
    ["float", 1.25, 3.5e38, -3.4028234663852886e38, 3.4028234663852886e38, "number"],
  ] as const)(
    "enforces the declared JSON numeric subset for %s",
    (format, valid, invalid, minimum, maximum, type) => {
      const compiled = compile({ type: "number", format });
      expect(compiled.counts.accepted).toBe(1);
      const schema = compiled.operations[0]!.inputSchema;
      expect(schema.properties).toEqual({ body: { type, format, minimum, maximum } });
      expect(() => assertOpenApiArguments(schema, { body: valid })).not.toThrow();
      expect(() => assertOpenApiArguments(schema, { body: invalid })).toThrow("schema");
      if (type === "integer")
        expect(() => assertOpenApiArguments(schema, { body: 1.5 })).toThrow("schema");
    },
  );

  it("intersects format bounds with source bounds and diagnoses an impossible intersection", () => {
    const constrained = compile({ type: "number", format: "int32", minimum: 5, maximum: 10 });
    expect(constrained.operations[0]!.inputSchema.properties).toEqual({
      body: { type: "integer", format: "int32", minimum: 5, maximum: 10 },
    });
    expect(compile({ type: "number", format: "int32", minimum: 3e9 }).diagnostics[0]!.code).toBe(
      "unsafe_schema",
    );
    expect(compile({ type: "string", format: "uri", minLength: 4097 }).diagnostics[0]!.code).toBe(
      "unsafe_schema",
    );
    expect(
      compile({ type: "string", format: "uuid", maxLength: 36 }).operations[0]!.inputSchema
        .properties,
    ).toEqual({ body: { type: "string", format: "uuid", maxLength: 36 } });
    expect(compile({ type: "string", format: "uuid", maxLength: "36" }).diagnostics[0]!.code).toBe(
      "unsafe_schema",
    );
    expect(compile({ type: "number", format: "int32", minimum: "1" }).diagnostics[0]!.code).toBe(
      "unsafe_schema",
    );
  });

  it.each(["binary", "byte", "regex", "url", "uri-template"])(
    "diagnoses unsupported %s format semantics",
    (format) => {
      const compiled = compile({ type: "string", format });
      expect(compiled.operations).toEqual([]);
      expect(compiled.diagnostics[0]!.code).toBe("unsafe_schema");
    },
  );

  it.each(formats)(
    "enforces full %s validation without changing arguments",
    (format, valid, invalid) => {
      const compiled = compile({ type: "string", format });
      expect(compiled.counts.accepted).toBe(1);
      const schema = compiled.operations[0]!.inputSchema;
      expect(schema.properties).toEqual({ body: { type: "string", format, maxLength: 4096 } });
      const args = { body: valid };
      expect(() => assertOpenApiArguments(schema, args)).not.toThrow();
      expect(args).toEqual({ body: valid });
      expect(() => assertOpenApiArguments(schema, { body: invalid })).toThrow("schema");
      expect(() => assertOpenApiArguments(schema, { body: "a".repeat(4097) })).toThrow("schema");
    },
  );

  it.each([1, 21])("rejects invalid formats before HTTP for %s operations", async (count) => {
    const compiled = compile(
      {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          when: { type: "string", format: "date-time" },
          count: { type: "number", format: "int32" },
          serial: { type: "number", format: "int64" },
          ratio: { type: "number", format: "float" },
        },
        required: ["id", "email", "when"],
        additionalProperties: false,
      },
      count,
    );
    expect(compiled.counts.accepted).toBe(count);
    const install = {
      id: "install-formats",
      kind: "api",
      name: "Items",
      source,
      secretId: null,
      config: { auth: { type: "none" }, operations: compiled.operations },
    };
    const prisma = {
      capabilityInstall: {
        findMany: vi.fn(async () => [install]),
        findFirst: vi.fn(async () => install),
      },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    };
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const provider = new InstalledConnectorProvider(prisma as never, {} as never, { fetch });
    const tools = await provider.discoverTools(context);
    const body = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      email: "person@example.test",
      when: "2024-02-29T12:34:56Z",
      count: 1,
      serial: 123,
      ratio: 1.25,
    };
    const call = (value: unknown) =>
      count === 1
        ? {
            tool: tools[0]!.name,
            route: tools[0]!.route,
            args: { body: value },
            executionId: "run",
          }
        : {
            tool: tools[2]!.name,
            route: tools[2]!.route,
            args: { id: "install-formats:create_0", arguments: { body: value } },
            executionId: "run",
          };
    for (const invalid of [
      { ...body, id: "bad" },
      { ...body, email: "not-email" },
      { ...body, when: "2023-02-29T12:34:56Z" },
      { ...body, count: 2_147_483_648 },
      { ...body, serial: Number.MAX_SAFE_INTEGER + 1 },
      { ...body, ratio: 3.5e38 },
    ]) {
      const events = [];
      for await (const event of provider.execute(call(invalid), context)) events.push(event);
      expect(events).toEqual([{ type: "error", message: expect.stringContaining("schema") }]);
    }
    expect(fetch).not.toHaveBeenCalled();
    const requested = call(body);
    const resolved = await provider.resolveCall(requested, context);
    const exposed = resolved?.tool ?? tools[0]!;
    expect(
      JSON.parse(JSON.stringify(parametersFor(exposed))).properties.body.properties.email,
    ).toMatchObject({ type: "string" });
    for await (const _event of provider.execute(resolved?.call ?? requested, context)) {
      /* consume result */
    }
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]!.body).toBe(JSON.stringify(body));
  });

  it("retains safe siblings while diagnosing unknown or inapplicable formats", () => {
    const compiled = compileOpenApiDocument({
      servers: [{ url: source }],
      paths: {
        "/safe": {
          get: {
            operationId: "safe",
            parameters: [{ name: "id", in: "query", schema: { type: "string", format: "uuid" } }],
          },
        },
        "/unknown": {
          get: {
            operationId: "unknown",
            parameters: [
              {
                name: "id",
                in: "query",
                schema: { type: "string", format: "custom-vendor-format" },
              },
            ],
          },
        },
        "/wrong-type": {
          get: {
            operationId: "wrong",
            parameters: [{ name: "id", in: "query", schema: { type: "number", format: "uuid" } }],
          },
        },
      },
    });
    expect(compiled.operations.map((operation) => operation.id)).toEqual(["safe"]);
    expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "unsafe_schema",
      "unsafe_schema",
    ]);
  });
});
