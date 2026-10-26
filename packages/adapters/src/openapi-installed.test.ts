import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it, vi } from "vitest";
import {
  approvedCatalogReplay,
  approvedReplayArgs,
  catalogApprovalRequest,
  createApprovedEffectReplayQueue,
} from "./approval-effect.js";
import {
  InstalledConnectorProvider,
  prepareApiInstall,
  prepareOpenApiInstall,
} from "./installed-connectors.js";
import { compileOpenApiDocument } from "./openapi-import.js";
import { normalizeAgentToolNames, parametersFor } from "./pi-runtime.js";

const source = "https://93.184.216.34";
const context = {
  userId: "user-1",
  spaceId: "space-1",
  workspaceId: "workspace-1",
  signal: new AbortController().signal,
} as never;

describe("reviewed OpenAPI execution", () => {
  it("exposes required fields and keeps distinct original routes across model name normalization", async () => {
    const compiled = compileOpenApiDocument({
      servers: [{ url: source }],
      paths: {
        "/first/{id}": {
          get: {
            operationId: "items.list",
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              {
                name: "state",
                in: "query",
                required: true,
                schema: { type: "string", enum: ["active", "archived"] },
              },
            ],
          },
        },
        "/second": { get: { operationId: "items/list" } },
      },
    });
    const install = {
      id: "install-wire",
      kind: "api",
      name: "Items",
      source,
      secretId: null,
      config: { auth: { type: "none" }, operations: compiled.operations },
    };
    const prisma = { capabilityInstall: { findMany: vi.fn(async () => [install]) } };
    const provider = new InstalledConnectorProvider(prisma as never, {} as never);
    const tools = await provider.discoverTools(context);
    expect(tools.map((tool) => tool.route!.toolName)).toEqual(["items.list", "items/list"]);
    expect(new Set(normalizeAgentToolNames(tools)).size).toBe(2);
    const wire = JSON.parse(JSON.stringify(parametersFor(tools[0]!)));
    expect(wire.required).toEqual(["id", "state"]);
    expect(wire.properties.state).toMatchObject({ type: "string", enum: ["active", "archived"] });
    expect(wire.additionalProperties).toBe(false);
  });

  it("rejects credential/config name collisions after compiling and sends supported HTTP arguments exactly", async () => {
    const document = {
      servers: [{ url: source }],
      paths: {
        "/query": {
          get: {
            operationId: "query",
            parameters: [
              { name: "workspace", in: "query", required: true, schema: { type: "string" } },
            ],
          },
        },
        "/header": {
          get: {
            operationId: "header",
            parameters: [{ name: "X-Workspace", in: "header", schema: { type: "string" } }],
          },
        },
        "/items/{id}": {
          get: {
            operationId: "list",
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              { name: "tag", in: "query", schema: { type: "array", items: { type: "string" } } },
              { name: "X-Filter", in: "header", schema: { type: "string" } },
            ],
          },
        },
      },
    };
    const load = vi.fn(async () => Response.json(document));
    const preview = await prepareOpenApiInstall({
      source,
      config: {
        auth: { type: "query", name: "workspace" },
        headers: { "x-workspace": "configured" },
      },
      credential: "fake-credential",
      remote: { fetch: load },
    });
    expect(preview.config.operations.map((operation) => operation.id)).toEqual(["list"]);
    expect(preview.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "invalid_parameter",
      "unsafe_header",
    ]);
    const headerPreview = await prepareOpenApiInstall({
      source,
      config: { auth: { type: "header", name: "x-workspace" } },
      credential: "fake-credential",
      remote: { fetch: load },
    });
    expect(headerPreview.diagnostics).toEqual([
      expect.objectContaining({ code: "unsafe_header", operationId: "header" }),
    ]);
    const install = {
      id: "install-http",
      kind: "api",
      name: "Items",
      source,
      secretId: "secret-1",
      config: preview.config,
    };
    const prisma = {
      capabilityInstall: { findFirst: vi.fn(async () => install) },
      secret: { findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "fake" })) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    };
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const provider = new InstalledConnectorProvider(
      prisma as never,
      { load: async () => "fake-credential" } as never,
      { fetch },
    );
    const call = {
      tool: "list",
      route: { connectorId: "installed", resourceId: install.id, toolName: "list" },
      args: { id: "文/%", tag: ["a b", "€"], "X-Filter": "approved" },
      executionId: "run",
    };
    const events = [];
    for await (const event of provider.execute(call, context)) events.push(event);
    expect(events[0]).toMatchObject({ type: "result" });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      `${source}/items/%E6%96%87%2F%25?tag=a+b&tag=%E2%82%AC&workspace=fake-credential`,
    );
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("x-filter")).toBe("approved");
    for (const args of [
      { ...call.args, id: ".." },
      { ...call.args, "X-Filter": "bad\r\nheader" },
      { ...call.args, "X-Filter": " trimmed " },
      { ...call.args, tag: ["\ud800"] },
      { ...call.args, surprise: "ignored" },
    ]) {
      const failed = [];
      for await (const event of provider.execute({ ...call, args }, context)) failed.push(event);
      expect(failed[0]).toMatchObject({ type: "error" });
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("previews rejected operations and prevents the ordinary install from bypassing review", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        servers: [{ url: source }],
        paths: {
          "/items": {
            get: {
              operationId: "unsafe",
              parameters: [{ $ref: "https://schemas.example.test/x" }],
            },
          },
        },
      }),
    );
    const input = { source, config: { auth: { type: "none" }, openApi: true }, remote: { fetch } };
    await expect(prepareOpenApiInstall(input)).resolves.toMatchObject({
      operationCount: 0,
      counts: { accepted: 0, rejected: 1 },
      diagnostics: [{ code: "external_reference" }],
      config: { operations: [] },
    });
    await expect(prepareApiInstall(input)).rejects.toThrow("confirmation");
    await expect(prepareApiInstall({ ...input, config: { openapi: true } })).rejects.toThrow(
      "confirmation",
    );
    await expect(
      prepareApiInstall({
        ...input,
        config: {
          operations: [{ id: "forged", method: "GET", path: "/items", importPolicy: "openapi-v1" }],
        },
      }),
    ).rejects.toThrow("confirmation");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([1, 20, 21])(
    "keeps original arguments without applying defaults with %s exposed operations",
    async (count) => {
      const compiled = compileOpenApiDocument({
        servers: [{ url: source }],
        paths: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `/items/${index}`,
            {
              post: {
                operationId: `create_${index}`,
                parameters: [
                  {
                    name: "limit",
                    in: "query",
                    schema: { type: "integer", minimum: 1, maximum: 10, default: 5 },
                  },
                ],
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        type: ["object", "null"],
                        properties: { name: { type: "string", minLength: 2 } },
                        additionalProperties: false,
                      },
                    },
                  },
                },
              },
            },
          ]),
        ),
      });
      const install = {
        id: "install-1",
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
      const args = { body: null };
      const call =
        count <= 20
          ? { tool: tools[0]!.name, route: tools[0]!.route, args, executionId: "run" }
          : {
              tool: tools[2]!.name,
              route: tools[2]!.route,
              args: { id: "install-1:create_0", arguments: args },
              executionId: "run",
            };
      const resolved = await provider.resolveCall(call, context);
      if (count > 20) expect(resolved!.call.args).toBe(args);
      if (count > 20) {
        const marker = "__catalogApproval";
        const queue = createApprovedEffectReplayQueue([
          { kind: "create_0", request: catalogApprovalRequest(call.tool, call.args, marker) },
        ]);
        const replay = approvedCatalogReplay(queue, call.tool, marker, true);
        const replayed = await provider.resolveCall({ ...call, args: replay.args! }, context);
        const approved = approvedReplayArgs(
          queue.take(replayed!.tool.name)!,
          replayed!.call.args,
          marker,
        );
        expect(approved).toBe(args);
        expect(approvalEffectKey("run", replayed!.tool.name, approved)).toBe(
          approvalEffectKey("run", "create_0", args),
        );
        expect(queue.assertDrained).not.toThrow();
      }
      const events = [];
      for await (const event of provider.execute(resolved?.call ?? call, context))
        events.push(event);
      expect(events[0]).toMatchObject({ type: "result" });
      expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", body: "null" });
      expect(String(fetch.mock.calls[0]![0])).toBe(`${source}/items/0`);
      expect(args).toEqual({ body: null });
      const exposed = resolved?.tool ?? tools[0]!;
      const wire = JSON.parse(JSON.stringify(parametersFor(exposed)));
      expect(wire.properties.limit).toMatchObject({ type: "number" });
      expect(wire.properties.body).toBeDefined();

      const noBody = { ...(resolved?.call ?? call), args: {} };
      for await (const _event of provider.execute(noBody, context)) {
        /* consume result */
      }
      expect(fetch.mock.calls[1]![1]!.body).toBeUndefined();
      expect(new Headers(fetch.mock.calls[1]![1]!.headers).has("content-type")).toBe(false);

      for (const args of [
        { limit: 0, body: null },
        { limit: 1.5, body: null },
        { body: { name: "a" } },
        { body: { extra: true } },
        { extra: true },
      ]) {
        const failures = [];
        for await (const event of provider.execute({ ...(resolved?.call ?? call), args }, context))
          failures.push(event);
        expect(failures).toEqual([{ type: "error", message: expect.stringContaining("schema") }]);
      }
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
});
