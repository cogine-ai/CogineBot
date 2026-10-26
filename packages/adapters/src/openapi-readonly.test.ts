import { describe, expect, it, vi } from "vitest";
import { InstalledConnectorProvider, prepareOpenApiInstall } from "./installed-connectors.js";
import { assertOpenApiArguments, compileOpenApiDocument } from "./openapi-import.js";
import { parametersFor } from "./pi-runtime.js";

const source = "https://93.184.216.34/v1";
const context = {
  userId: "user-1",
  spaceId: "space-1",
  workspaceId: "workspace-1",
  signal: new AbortController().signal,
} as never;

function documentFor(schema: unknown, version: string | null = "3.0.3", count = 1) {
  return {
    ...(version === null ? {} : { openapi: version }),
    servers: [{ url: source }],
    paths: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `/items${index}`,
        {
          post: {
            operationId: `create${index}`,
            requestBody: {
              required: true,
              content: { "application/json": { schema } },
            },
          },
        },
      ]),
    ),
  };
}

function compile(schema: unknown, version: string | null = "3.0.3") {
  return compileOpenApiDocument(documentFor(schema, version));
}

function schemaOf(result: ReturnType<typeof compile>) {
  expect(result.diagnostics).toEqual([]);
  expect(result.operations).toHaveLength(1);
  return result.operations[0]!.inputSchema;
}

function bodyOf(schema: Record<string, unknown>) {
  return (schema.properties as Record<string, Record<string, unknown>>).body!;
}

const dto = {
  type: "object",
  properties: {
    id: { type: "integer", readOnly: true },
    stamp: { type: "string", readOnly: true },
    name: { type: "string" },
    password: { type: "string", writeOnly: true },
  },
  required: ["id", "name", "password"],
};

describe("OpenAPI request readOnly properties", () => {
  it.each([undefined, true, false])(
    "projects 3.0 properties without changing additionalProperties=%s",
    (additionalProperties) => {
      const schema = schemaOf(
        compile({
          ...dto,
          ...(additionalProperties === undefined ? {} : { additionalProperties }),
        }),
      );
      const body = bodyOf(schema);
      expect(Object.keys(body.properties as object)).toEqual(["name", "password"]);
      expect(body.required).toEqual(["name", "password"]);
      expect(body.additionalProperties).toBe(additionalProperties);
      expect(body.not).toEqual({
        type: "object",
        anyOf: [{ required: ["id"] }, { required: ["stamp"] }],
      });
      const valid = { body: { name: "Approved", password: "unchanged" } };
      expect(() => assertOpenApiArguments(schema, valid)).not.toThrow();
      for (const field of [{ id: 1 }, { stamp: "server" }, { id: 1, stamp: "server" }])
        expect(() =>
          assertOpenApiArguments(schema, { body: { ...valid.body, ...field } }),
        ).toThrow();
      expect(() => assertOpenApiArguments(schema, { body: { name: "Approved" } })).toThrow();
      const extra = { body: { ...valid.body, businessKey: "kept" } };
      if (additionalProperties === false)
        expect(() => assertOpenApiArguments(schema, extra)).toThrow();
      else expect(() => assertOpenApiArguments(schema, extra)).not.toThrow();
    },
  );

  it.each(["3.1.1", null])("keeps original required for version %s", (version) => {
    const schema = schemaOf(compile(dto, version));
    const body = bodyOf(schema);
    expect(body.properties as object).toHaveProperty("id");
    expect(body.required).toEqual(["id", "name", "password"]);
    expect(body.not).toBeUndefined();
    expect(() =>
      assertOpenApiArguments(schema, { body: { name: "Approved", password: "unchanged" } }),
    ).toThrow();
    expect(() =>
      assertOpenApiArguments(schema, { body: { id: 1, name: "Approved", password: "unchanged" } }),
    ).not.toThrow();
  });

  it("retains the required body wrapper when all its properties are readOnly", () => {
    const schema = schemaOf(
      compile({ type: "object", properties: { id: dto.properties.id }, required: ["id"] }),
    );
    expect(() => assertOpenApiArguments(schema, { body: {} })).not.toThrow();
    expect(() => assertOpenApiArguments(schema, {})).toThrow();
    expect(() => assertOpenApiArguments(schema, { body: { id: 1 } })).toThrow();
  });

  it("projects nested objects and array properties while preserving nullable values", () => {
    const schema = schemaOf(
      compile({
        type: ["object", "null"],
        properties: {
          id: dto.properties.id,
          user: {
            type: ["object", "null"],
            properties: { stamp: dto.properties.stamp, name: dto.properties.name },
            required: ["stamp", "name"],
          },
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: { id: dto.properties.id, name: dto.properties.name },
              required: ["id", "name"],
            },
          },
        },
        required: ["id", "rows"],
      }),
    );
    for (const body of [
      null,
      { rows: [{ name: "A" }], user: null },
      { rows: [], user: { name: "A" } },
    ])
      expect(() => assertOpenApiArguments(schema, { body })).not.toThrow();
    for (const body of [
      { rows: [], id: 1 },
      { rows: [], user: { name: "A", stamp: "server" } },
      { rows: [{ name: "A", id: 1 }] },
    ])
      expect(() => assertOpenApiArguments(schema, { body })).toThrow();
  });

  it("does not treat root or array-item readOnly annotations as a forbidden payload", () => {
    const schema = schemaOf(
      compile({
        type: "array",
        readOnly: true,
        items: {
          type: "object",
          readOnly: true,
          properties: { id: dto.properties.id, name: dto.properties.name },
          required: ["id", "name"],
        },
      }),
    );
    expect(() => assertOpenApiArguments(schema, { body: [{ name: "A" }] })).not.toThrow();
    expect(() => assertOpenApiArguments(schema, { body: [{ name: "A", id: 1 }] })).toThrow();
  });

  it.each([
    [true, false],
    [false, true],
  ])("does not erase readOnly across references and allOf (%j)", (first, second) => {
    const document = {
      ...documentFor({
        allOf: [
          {
            type: "object",
            properties: { id: { $ref: "#/components/schemas/Id" } },
            required: ["id"],
          },
          { type: "object", properties: { name: dto.properties.name }, required: ["name"] },
        ],
      }),
      components: {
        schemas: { Id: { allOf: [{ type: "integer", readOnly: first }, { readOnly: second }] } },
      },
    };
    const schema = schemaOf(compileOpenApiDocument(document));
    expect(() => assertOpenApiArguments(schema, { body: { name: "A" } })).not.toThrow();
    expect(() => assertOpenApiArguments(schema, { body: { name: "A", id: 1 } })).toThrow();
  });

  it.each([true, false])("preserves readOnly across a reference sibling (%s)", (referenced) => {
    const document = {
      ...documentFor({
        type: "object",
        properties: {
          id: { $ref: "#/components/schemas/Id", readOnly: !referenced },
          name: dto.properties.name,
        },
        required: ["id", "name"],
      }),
      components: { schemas: { Id: { type: "integer", readOnly: referenced } } },
    };
    const schema = schemaOf(compileOpenApiDocument(document));
    expect(() => assertOpenApiArguments(schema, { body: { name: "A" } })).not.toThrow();
    expect(() => assertOpenApiArguments(schema, { body: { name: "A", id: 1 } })).toThrow();
  });

  it("does not project parameter schemas outside JSON request bodies", () => {
    const compiled = compileOpenApiDocument({
      openapi: "3.0.3",
      servers: [{ url: source }],
      paths: {
        "/items": {
          get: {
            operationId: "list",
            parameters: [{ name: "id", in: "query", required: true, schema: dto.properties.id }],
          },
        },
      },
    });
    const schema = schemaOf(compiled);
    expect(schema.required).toEqual(["id"]);
    expect(() => assertOpenApiArguments(schema, { id: 1 })).not.toThrow();
    expect(() => assertOpenApiArguments(schema, {})).toThrow();
  });

  it.each([
    { type: "integer", readOnly: "true" },
    { type: "integer", writeOnly: null },
    { type: "integer", readOnly: true, writeOnly: true },
    { allOf: [{ type: "integer", readOnly: "bad" }, { readOnly: false }] },
    { allOf: [{ type: "integer", readOnly: true }, { writeOnly: true }] },
    { oneOf: [{ type: "integer", readOnly: true }, { type: "string" }] },
  ])("locally diagnoses invalid or conditional property flags (%j)", (property) => {
    const document = documentFor({
      type: "object",
      properties: { id: property },
      required: ["id"],
    });
    const compiled = compileOpenApiDocument({
      ...document,
      paths: { ...document.paths, "/health": { get: { operationId: "health" } } },
    });
    expect(compiled.operations.map((operation) => operation.id)).toEqual(["health"]);
    expect(compiled.diagnostics).toEqual([
      expect.objectContaining({ code: "unsafe_schema", operationId: "create0" }),
    ]);
  });

  it("keeps oneOf exclusive while projecting its object branches independently", () => {
    const schema = schemaOf(
      compile({
        oneOf: [
          {
            type: "object",
            properties: { id: dto.properties.id, name: dto.properties.name },
            required: ["id", "name"],
          },
          {
            type: "object",
            properties: { id: dto.properties.id, count: { type: "integer" } },
            required: ["id", "count"],
          },
        ],
      }),
    );
    for (const body of [{ name: "A" }, { count: 1 }])
      expect(() => assertOpenApiArguments(schema, { body })).not.toThrow();
    for (const body of [{ name: "A", count: 1 }, { name: "A", id: 1 }, {}])
      expect(() => assertOpenApiArguments(schema, { body })).toThrow();
    expect(bodyOf(schema).oneOf).toHaveLength(2);
  });

  it("does not interpret annotations inside default or example values", () => {
    const literal = { readOnly: true, properties: { id: { readOnly: true } }, $ref: "literal" };
    const schema = schemaOf(
      compile({
        type: "object",
        properties: { name: dto.properties.name },
        default: literal,
        example: literal,
      }),
    );
    expect(bodyOf(schema).default).toEqual(literal);
    expect(bodyOf(schema).example).toEqual(literal);
    expect(() => assertOpenApiArguments(schema, { body: { name: "A" } })).not.toThrow();
  });

  it("includes generated presence constraints in the complete UTF-8 schema cap", () => {
    const fixture = { ...dto, description: "" };
    const initial = schemaOf(compile(fixture));
    expect(bodyOf(initial)).toHaveProperty("not");
    const remaining = 20_000 - Buffer.byteLength(JSON.stringify(initial), "utf8");
    const exact = schemaOf(compile({ ...fixture, description: "a".repeat(remaining) }));
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(20_000);
    expect(
      compile({ ...fixture, description: "a".repeat(remaining + 1) }).diagnostics[0]?.code,
    ).toBe("schema_limit");
  });

  it("still refuses provider-supplied arbitrary not schemas", () => {
    expect(compile({ ...dto, not: { required: ["name"] } }).diagnostics[0]?.code).toBe(
      "unsafe_schema",
    );
  });

  it.each([1, 21])(
    "keeps effective model and HTTP arguments consistent for %s operations",
    async (count) => {
      const document = documentFor(dto, "3.0.3", count);
      const prepared = await prepareOpenApiInstall({
        source,
        config: { auth: { type: "none" } },
        remote: { fetch: async () => Response.json(document) },
      });
      const install = {
        id: "readonly-review",
        kind: "api",
        name: "Items",
        source: prepared.source,
        secretId: null,
        config: prepared.config,
      };
      const outbound = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ ok: true }),
      );
      const provider = new InstalledConnectorProvider(
        {
          capabilityInstall: { findMany: async () => [install], findFirst: async () => install },
          deploymentSettings: { findUnique: async () => null },
        } as never,
        {} as never,
        { fetch: outbound },
      );
      const tools = await provider.discoverTools(context);
      if (count === 1) {
        const wire = JSON.parse(JSON.stringify(parametersFor(tools[0]!)));
        expect(wire.properties.body.properties).not.toHaveProperty("id");
        expect(wire.properties.body.required).toEqual(["name", "password"]);
      }
      const call = (body: Record<string, unknown>) =>
        count === 1
          ? { tool: tools[0]!.name, route: tools[0]!.route, args: { body }, executionId: "run" }
          : {
              tool: tools[2]!.name,
              route: tools[2]!.route,
              args: { id: `${install.id}:create0`, arguments: { body } },
              executionId: "run",
            };
      const valid = { name: "Approved", password: "unchanged", businessKey: "kept" };
      const events = [];
      for await (const event of provider.execute(call(valid), context)) events.push(event);
      expect(events[0]).toMatchObject({ type: "result" });
      expect(outbound).toHaveBeenCalledOnce();
      expect(outbound.mock.calls[0]![1]!.body).toBe(JSON.stringify(valid));
      for (const field of [{ id: 1 }, { stamp: "server" }]) {
        const invalid = [];
        for await (const event of provider.execute(call({ ...valid, ...field }), context))
          invalid.push(event);
        expect(invalid[0]).toMatchObject({ type: "error" });
      }
      expect(outbound).toHaveBeenCalledOnce();
    },
  );
});
