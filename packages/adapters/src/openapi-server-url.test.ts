import { describe, expect, it, vi } from "vitest";
import { InstalledConnectorProvider, prepareOpenApiInstall } from "./installed-connectors.js";
import { compileOpenApiDocument, OpenApiCompileError } from "./openapi-import.js";

const documentSource = "https://93.184.216.34/spec.json";
const context = {
  userId: "user-1",
  spaceId: "space-1",
  workspaceId: "workspace-1",
  signal: new AbortController().signal,
} as never;
const invalidServers = [
  ...[".", "..", "%2e", "%2E%2e", ".%2E", "%2e."].map((segment) => ({
    label: `dot segment ${segment}`,
    server: `https://api.example.test/safe/${segment}/admin`,
  })),
  { label: "terminal dot segment", server: "https://api.example.test/safe/%2e%2e" },
  { label: "path backslash", server: "https://api.example.test/safe\\admin" },
  { label: "authority backslash", server: "https://api.example.test\\other.example.test/safe" },
  { label: "missing authority slashes", server: "https:api.example.test/safe" },
  { label: "one authority slash", server: "https:/api.example.test/safe" },
  { label: "three authority slashes", server: "https:///api.example.test/safe" },
  { label: "four authority slashes", server: "https:////api.example.test/safe" },
  { label: "relative authority", server: "//api.example.test/safe" },
  { label: "unsupported scheme", server: "ftp://api.example.test/safe" },
  { label: "leading space", server: " https://api.example.test/safe" },
  { label: "trailing space", server: "https://api.example.test/safe " },
  { label: "leading tab", server: "\thttps://api.example.test/safe" },
  { label: "embedded newline", server: "https://api.example.test/sa\nfe" },
  { label: "embedded DEL", server: "https://api.example.test/sa\x7ffe" },
  { label: "empty query", server: "https://api.example.test/safe?" },
  { label: "empty fragment", server: "https://api.example.test/safe#" },
  { label: "empty query and fragment", server: "https://api.example.test/safe?#" },
  { label: "query", server: "https://api.example.test/safe?view=1" },
  { label: "fragment", server: "https://api.example.test/safe#section" },
  { label: "malformed Unicode", server: "https://api.example.test/safe/\ud800" },
];
const validServers = [
  { server: "HTTPS://API.EXAMPLE.TEST:443", canonical: "https://api.example.test/" },
  { server: "https://api.example.test/v1", canonical: "https://api.example.test/v1" },
  { server: "https://api.example.test/v1/", canonical: "https://api.example.test/v1/" },
  { server: "https://api.example.test/v1//", canonical: "https://api.example.test/v1//" },
  {
    server: "https://api.example.test/safe/%61/%2f/%5c/%252e%252e/%2e%2e%2fadmin",
    canonical: "https://api.example.test/safe/%61/%2f/%5c/%252e%252e/%2e%2e%2fadmin",
  },
  {
    server: "https://api.example.test/路径/é",
    canonical: "https://api.example.test/%E8%B7%AF%E5%BE%84/%C3%A9",
  },
  { server: "https://api.example.test/a b", canonical: "https://api.example.test/a%20b" },
  {
    server: "https://api.example.test/path\u00a0",
    canonical: "https://api.example.test/path%C2%A0",
  },
];

function documentFor(server: string, count = 1) {
  return {
    servers: [{ url: server }],
    paths: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        index === 0 ? "/items" : `/items${index}`,
        { get: { operationId: `list${index}` } },
      ]),
    ),
  };
}

async function reviewAndExecute(outbound: typeof fetch, load: typeof fetch, count = 1) {
  const resolveHostname = async () => [{ address: "93.184.216.34", family: 4 as const }];
  const prepared = await prepareOpenApiInstall({
    source: documentSource,
    config: { auth: { type: "none" } },
    remote: { fetch: load, resolveHostname },
  });
  const install = {
    id: "server-review",
    kind: "api",
    name: "Reviewed API",
    source: prepared.source,
    secretId: null,
    config: prepared.config,
  };
  const provider = new InstalledConnectorProvider(
    {
      capabilityInstall: {
        findFirst: async () => install,
        findMany: async () => [install],
      },
      deploymentSettings: { findUnique: async () => null },
    } as never,
    {} as never,
    { fetch: outbound, resolveHostname },
  );
  const tools = await provider.discoverTools(context);
  const call =
    count <= 20
      ? { tool: tools[0]!.name, route: tools[0]!.route, args: {}, executionId: "run" }
      : {
          tool: tools[2]!.name,
          route: tools[2]!.route,
          args: { id: `${install.id}:list0`, arguments: {} },
          executionId: "run",
        };
  const events = [];
  for await (const event of provider.execute(call, context)) events.push(event);
  return { prepared, events };
}

describe("reviewed OpenAPI server URLs", () => {
  it.each(invalidServers)("rejects $label before creating operations", ({ server }) => {
    expect(() => compileOpenApiDocument(documentFor(server))).toThrow("invalid_server");
  });

  it.each(invalidServers)("does not send a request after reviewing $label", async ({ server }) => {
    const load = vi.fn(async () => Response.json(documentFor(server)));
    const outbound = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const result = await reviewAndExecute(outbound, load).then(
      (value) => ({ target: value.prepared.source, error: undefined }),
      (error: unknown) => ({
        target: undefined,
        error: error instanceof OpenApiCompileError ? error.code : String(error),
      }),
    );
    expect({ ...result, requests: outbound.mock.calls.map(([url]) => String(url)) }).toEqual({
      target: undefined,
      error: "invalid_server",
      requests: [],
    });
    expect(load).toHaveBeenCalledOnce();
  });

  it.each(validServers)(
    "reviews the canonical server and sends the same prefix for $server",
    async ({ server, canonical }) => {
      expect(compileOpenApiDocument(documentFor(server)).baseUrl).toBe(canonical);
      for (const count of [1, 21]) {
        const load = vi.fn(async () => Response.json(documentFor(server, count)));
        const outbound = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
          Response.json({ ok: true }),
        );
        const { prepared, events } = await reviewAndExecute(outbound, load, count);
        expect(prepared.source).toBe(canonical);
        expect(events[0]).toMatchObject({ type: "result" });
        expect(outbound).toHaveBeenCalledOnce();
        expect(String(outbound.mock.calls[0]![0])).toBe(`${canonical.replace(/\/$/, "")}/items`);
        expect(load).toHaveBeenCalledOnce();
      }
    },
  );
});
