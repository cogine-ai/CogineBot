import type { AdapterContext, ConnectorEvent } from "@rakazo/adapter-kit";
import type * as DatabaseModule from "@rakazo/db";
import { storeToolResultHistory } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeConnectorToolResultHistory } from "./executor.js";
import { InstalledConnectorProvider } from "./installed-connectors.js";
import { McpConnector } from "./mcp-connector.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof DatabaseModule>()),
  storeToolResultHistory: vi.fn(),
}));

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  runId: "run",
  signal: new AbortController().signal,
};
const scope = {
  spaceId: "space",
  userId: "user",
  threadId: "thread",
  botId: "bot",
  activeRunId: "run",
};
const reference = { tool: "read_history" as const, arguments: { toolResultId: "stored-result" } };

function network(raw: unknown) {
  const headers: Headers[] = [];
  return {
    headers,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      headers.push(request.headers);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = JSON.parse(await request.text()) as { id?: number; method?: string };
      if (message.method === "initialize")
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "synthetic", version: "1" },
          },
        });
      if (message.method === "tools/call")
        return Response.json({ jsonrpc: "2.0", id: message.id, result: raw });
      return new Response(null, { status: 202 });
    }),
  };
}

describe("provider-local credential redaction before history storage", () => {
  beforeEach(() => vi.mocked(storeToolResultHistory).mockReset().mockResolvedValue(reference));
  it.each(
    (["installed", "mcp"] as const).flatMap((kind) => [
      { kind, credential: 'synthetic"quoted\\credential' },
      { kind, credential: "37" },
    ]),
  )(
    "redacts $kind MCP JSON text using its local credential before writer capture",
    async ({ kind, credential }) => {
      const payload = {
        id: "exact-id",
        cursor: "exact-cursor",
        echo: credential,
        count: credential === "37" ? 37 : 42,
        body: "safe filler ".repeat(300),
      };
      const expected = {
        ...payload,
        echo: "[redacted]",
        count: credential === "37" ? "[redacted]" : 42,
      };
      const raw = {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
      const remote = network(raw);
      const secret = { id: "secret", ciphertext: "encrypted-reference" };
      let close = async () => {};
      let events: AsyncIterable<ConnectorEvent>;
      const route = {
        connectorId: kind,
        resourceId: "resource",
        resourceRevision: 1,
        toolName: "echo",
      };
      const call = { tool: "echo", args: {}, executionId: "call", route };
      if (kind === "installed") {
        const prisma = {
          capabilityInstall: {
            findFirst: vi.fn().mockResolvedValue({
              id: "resource",
              kind: "mcp",
              source: "https://mcp.example.test/mcp",
              config: { auth: { type: "header", name: "x-api-key" }, headers: {} },
              secretId: "secret",
            }),
          },
          secret: { findFirst: vi.fn().mockResolvedValue(secret) },
        };
        const provider = new InstalledConnectorProvider(
          prisma as never,
          { load: async () => credential } as never,
          remote,
        );
        events = provider.execute(call, context);
      } else {
        const prisma = {
          mcpServer: {
            findFirst: vi.fn().mockResolvedValue({
              id: "resource",
              slug: "synthetic",
              transport: "streamable_http",
              endpoint: "https://mcp.example.test/mcp",
              args: [],
              secretId: "secret",
              enabled: true,
              revision: 1,
              allowAllTools: true,
              allowedTools: [],
            }),
          },
          secret: { findFirst: vi.fn().mockResolvedValue(secret) },
        };
        const provider = new McpConnector(
          prisma as never,
          { load: async () => JSON.stringify({ headers: { "X-Api-Key": credential } }) } as never,
          { network: remote },
        );
        close = () => provider.close();
        events = provider.execute(call, context);
      }
      try {
        const results: unknown[] = [];
        for await (const event of events) {
          expect(event.type).not.toBe("error");
          if (event.type === "result") results.push(event.data);
        }
        expect(results).toHaveLength(1);
        const result = results[0] as typeof raw;
        expect(remote.headers.some((headers) => headers.get("x-api-key") === credential)).toBe(
          true,
        );
        expect(JSON.parse(result.content[0]!.text)).toEqual(expected);
        expect(result.structuredContent).toEqual(expected);
        // The executor has no connector-local credential; the provider boundary already removed it.
        expect(
          await storeConnectorToolResultHistory(
            {} as never,
            scope,
            { name: "synthetic_echo", executionId: "call", route, result },
            [],
          ),
        ).toEqual(reference);
        const captured = vi.mocked(storeToolResultHistory).mock.calls[0]![2].text;
        expect(captured).not.toContain("quoted");
        const stored = JSON.parse(captured) as typeof raw;
        expect(JSON.parse(stored.content[0]!.text)).toEqual(expected);
        expect(raw.structuredContent.echo).toBe(credential);
      } finally {
        await close();
      }
    },
  );
});
