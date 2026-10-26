import { describe, expect, it, vi } from "vitest";
import {
  InstalledConnectorProvider,
  prepareApiInstall,
  prepareOpenApiInstall,
} from "./installed-connectors.js";

const source = "https://93.184.216.34";
const document = {
  servers: [{ url: source }],
  paths: {
    "/items": {
      post: {
        operationId: "create",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { id: { type: "integer" } },
                required: ["id"],
                additionalProperties: false,
              },
            },
          },
        },
      },
    },
    "/health": { get: { operationId: "health" } },
  },
};

describe("strict OpenAPI JSON content type", () => {
  it.each(["content-type", "Content-Type"])(
    "locally rejects a JSON operation with %s authentication",
    async (name) => {
      const preview = await prepareOpenApiInstall({
        source,
        config: { auth: { type: "header", name } },
        credential: "synthetic-auth-value",
        remote: { fetch: async () => Response.json(document) },
      });
      expect(preview.config.operations.map((operation) => operation.id)).toEqual(["health"]);
      expect(preview.config.auth).toEqual({ type: "header", name });
      expect(preview.diagnostics).toEqual([
        expect.objectContaining({ code: "unsafe_header", operationId: "create" }),
      ]);
      expect(preview.counts).toMatchObject({ accepted: 1, rejected: 1 });
    },
  );

  it.each([
    { "Content-Type": "text/plain" },
    { "content-type": "text/plain" },
    { "Content-Type": "application/json; charset=utf-16" },
    { "Content-Type": "application/json; profile=custom" },
    { "Content-Type": "application/problem+json" },
    { "Content-Type": "application/json", "content-type": "text/plain" },
  ])(
    "rejects incompatible static media types while preserving safe sibling configuration (%j)",
    async (headers) => {
      const preview = await prepareOpenApiInstall({
        source,
        config: { auth: { type: "none" }, headers },
        remote: { fetch: async () => Response.json(document) },
      });
      expect(preview.config.operations.map((operation) => operation.id)).toEqual(["health"]);
      expect(preview.config.headers).toEqual(headers);
      expect(preview.diagnostics).toEqual([
        expect.objectContaining({ code: "unsafe_header", operationId: "create" }),
      ]);
    },
  );

  it.each([
    { "Content-Type": "application/json" },
    { "content-type": "Application/JSON; charset=UTF-8" },
    { "Content-Type": "application/json", "content-type": "application/json" },
  ])(
    "normalizes equivalent static JSON headers to one outbound media type (%j)",
    async (headers) => {
      const preview = await prepareOpenApiInstall({
        source,
        config: { auth: { type: "none" }, headers },
        remote: { fetch: async () => Response.json(document) },
      });
      expect(preview.operationCount).toBe(2);
      expect(preview.config.headers).toEqual({ "content-type": "application/json" });
      const install = {
        id: "install-json",
        kind: "api",
        name: "Items",
        source,
        secretId: null,
        config: preview.config,
      };
      const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ ok: true }),
      );
      const provider = new InstalledConnectorProvider(
        {
          capabilityInstall: { findFirst: async () => install },
          deploymentSettings: { findUnique: async () => null },
        } as never,
        {} as never,
        { fetch },
      );
      const events = [];
      for await (const event of provider.execute(
        {
          tool: "create",
          route: { connectorId: "installed", resourceId: install.id, toolName: "create" },
          args: { body: { id: 1 } },
          executionId: "run",
        },
        { userId: "user-1", spaceId: "space-1", signal: new AbortController().signal } as never,
      ))
        events.push(event);
      expect(events[0]).toMatchObject({ type: "result" });
      expect(fetch).toHaveBeenCalledOnce();
      const actual = new Headers(fetch.mock.calls[0]![1]!.headers);
      expect(actual.get("content-type")).toBe("application/json");
      expect([...actual].filter(([name]) => name === "content-type")).toHaveLength(1);
      expect(fetch.mock.calls[0]![1]!.body).toBe('{"id":1}');
    },
  );

  it("retains the manual API authentication and static-header contract", async () => {
    const config = {
      auth: { type: "header", name: "Content-Type" },
      headers: { "Content-Type": "text/plain" },
      operations: [{ id: "manual", method: "POST", path: "/items" }],
    };
    await expect(
      prepareApiInstall({ source, config, credential: "synthetic-auth-value" }),
    ).resolves.toMatchObject({ config: { auth: config.auth, headers: config.headers } });
  });
});
