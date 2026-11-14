import { createRouterClient } from "@orpc/server";
import type { SecretContext } from "@rakazo/adapter-kit";
import { SecretNotFoundError } from "@rakazo/adapter-kit";
import { EncryptedSecretStore } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "user",
  spaceId: "space",
  email: "fixture@example.test",
  isDeploymentOwner: false,
};

it("checks only an owned enabled MCP server and rejects a result for an edited revision", async () => {
  const server = {
    id: "server",
    spaceId: actor.spaceId,
    userId: actor.userId,
    enabled: true,
    revision: 3,
  };
  const findFirst = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(server)
    .mockResolvedValueOnce(null);
  const check = vi.fn().mockResolvedValue({
    status: "ok",
    message: null,
    code: null,
    toolCount: 1,
    checkedAt: new Date(0).toISOString(),
  });
  const deps = {
    prisma: { mcpServer: { findFirst } },
    mcpConnector: { check },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
    },
    dataDir: "/tmp/mcp-status-fixture",
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  await expect(client.mcp.servers.check({ id: "foreign" })).rejects.toThrow();
  expect(check).not.toHaveBeenCalled();
  await expect(client.mcp.servers.check({ id: server.id })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(check).toHaveBeenCalledWith(
    server,
    expect.objectContaining({
      spaceId: actor.spaceId,
      userId: actor.userId,
    }),
  );
  expect(findFirst).toHaveBeenLastCalledWith({
    where: {
      id: server.id,
      spaceId: actor.spaceId,
      userId: actor.userId,
      enabled: true,
      revision: 3,
    },
    select: { id: true },
  });
});

describe("MCP list preserves unknown credential status", () => {
  it.each(["not-found", "bad-ref", "aad", "json", "structure"])(
    "isolates a %s secret failure from healthy and credentialless servers",
    async (fault) => {
      const store = new EncryptedSecretStore("fixture-list-status-key");
      const context = {
        ...actor,
        operationId: "fixture-status",
        traceId: "fixture",
        botId: "fixture",
        signal: new AbortController().signal,
      };
      const staticRecord = await store.put(
        JSON.stringify({ headers: { "X-Key": "fixture-key" } }),
        context,
        { recordId: "static" },
      );
      const oauthRecord = await store.put(
        JSON.stringify({
          oauth: { tokens: { access_token: "fixture-token", token_type: "bearer" } },
        }),
        context,
        { recordId: "oauth" },
      );
      const faultyRecord = await store.put(
        fault === "json" ? "not json" : fault === "structure" ? '{"oauth":false}' : "{}",
        context,
        { recordId: fault === "aad" ? "another-record" : "bad" },
      );
      const badRef =
        fault === "not-found"
          ? "remote-missing"
          : fault === "bad-ref"
            ? "v2:broken"
            : faultyRecord.ref;
      const records = [
        { id: "bad", ciphertext: badRef },
        { id: "static", ciphertext: staticRecord.ref },
        { id: "oauth", ciphertext: oauthRecord.ref },
      ];
      const rows = ["bad", "static", "oauth", "no-credential"].map((id) => ({
        id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        slug: id,
        name: id,
        description: "",
        transport: "streamable_http",
        endpoint: `https://tools.example.test/${id}`,
        command: null,
        args: [],
        env: {},
        headers: id === "static" ? { "X-Key": true } : {},
        secretId: id === "no-credential" ? null : id,
        enabled: true,
        allowAllTools: false,
        allowedTools: [],
        revision: 1,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }));
      const secrets = {
        load: vi.fn(async (ref: string, record: SecretContext) => {
          if (ref === "remote-missing") throw new SecretNotFoundError();
          return store.load(ref, record);
        }),
        put: vi.fn(),
        delete: vi.fn(),
      };
      const deps = {
        prisma: {
          mcpServer: { findMany: vi.fn(async () => rows) },
          secret: { findMany: vi.fn(async () => records) },
        },
        secrets,
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fixture",
          sandboxProvider: "fake",
        },
        dataDir: "/tmp/mcp-status-fixture",
      } as unknown as RouterDeps;
      const client = createRouterClient(createRouter(deps), { context: { actor } as never });
      const result = await client.mcp.servers.list();
      expect(result.map(({ id, oauthStatus }) => ({ id, oauthStatus }))).toEqual([
        { id: "bad", oauthStatus: "unknown" },
        { id: "static", oauthStatus: "none" },
        { id: "oauth", oauthStatus: "connected" },
        { id: "no-credential", oauthStatus: "none" },
      ]);
      expect(result[0]).toMatchObject({ revision: 1, enabled: true });
      expect(JSON.stringify(result)).not.toContain("fixture-key");
      expect(JSON.stringify(result)).not.toContain("fixture-token");
      expect(secrets.put).not.toHaveBeenCalled();
    },
  );
});

describe("MCP header patch status agrees with list", () => {
  it.each([
    [{}, "unknown"],
    [{ access_token: "fixture-token", token_type: "bearer" }, "connected"],
  ] as const)(
    "keeps the committed credential while classifying its OAuth tokens (%s)",
    async (tokens, expected) => {
      const store = new EncryptedSecretStore("fixture-patch-status-key");
      const material = {
        headers: { "X-Static": "fixture-static" },
        env: { KEEP: "fixture-env" },
        oauth: { tokens },
        metadata: { version: 2 },
      };
      const context = {
        ...actor,
        operationId: "fixture-status",
        traceId: "fixture",
        botId: "fixture",
        signal: new AbortController().signal,
      };
      const original = await store.put(JSON.stringify(material), context, { recordId: "old" });
      const rows = new Map([[original.id, { id: original.id, ciphertext: original.ciphertext }]]);
      const server = {
        id: "server",
        spaceId: actor.spaceId,
        userId: actor.userId,
        installId: null,
        slug: "fixture",
        name: "Fixture",
        description: "",
        transport: "streamable_http",
        endpoint: "https://tools.example.test/mcp",
        command: null,
        args: [],
        env: { KEEP: true },
        headers: { "X-Static": true },
        secretId: original.id,
        enabled: false,
        allowAllTools: false,
        allowedTools: ["read"],
        revision: 1,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      const prisma = {
        mcpServer: {
          findFirst: async () => structuredClone(server),
          findMany: async () => [structuredClone(server)],
          update: async ({ data }: { data: Record<string, unknown> }) => {
            Object.assign(server, data, { revision: server.revision + 1 });
            return structuredClone(server);
          },
        },
        secret: {
          findFirst: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
          findMany: async () => [...rows.values()],
          create: async ({ data }: { data: { id: string; ciphertext: string } }) => {
            rows.set(data.id, data);
            return data;
          },
          deleteMany: async ({ where }: { where: { id: string } }) => {
            rows.delete(where.id);
            return { count: 1 };
          },
          count: async ({ where }: { where: { ciphertext: string } }) =>
            [...rows.values()].filter((row) => row.ciphertext === where.ciphertext).length,
        },
        botSecret: { count: async () => 0 },
        integrationProviderConfig: { count: async () => 0 },
        nativeAppConfig: { count: async () => 0 },
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ id: "scope", deletingAt: null, referenced: false }],
        async $transaction<T>(effect: (tx: typeof prisma) => Promise<T>): Promise<T> {
          return effect(prisma);
        },
      };
      const put = vi.spyOn(store, "put");
      const load = vi.spyOn(store, "load");
      const deps = {
        prisma,
        secrets: store,
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fixture",
          sandboxProvider: "fake",
        },
        dataDir: "/tmp/mcp-patch-status-fixture",
      } as unknown as RouterDeps;
      const client = createRouterClient(createRouter(deps), { context: { actor } as never });
      const saved = await client.mcp.servers.update({
        id: server.id,
        connection: { revision: 1, enabled: false, headerUpdates: { "X-New": "fixture-new" } },
      });
      const listed = await client.mcp.servers.list();
      expect({ mutation: saved.oauthStatus, list: listed[0]!.oauthStatus }).toEqual({
        mutation: expected,
        list: expected,
      });
      expect(put).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledTimes(2);
      expect(saved).toMatchObject({
        revision: 2,
        enabled: false,
        allowAllTools: false,
        allowedTools: ["read"],
        endpoint: server.endpoint,
      });
      expect(server.secretId).not.toBe(original.id);
      expect(rows.size).toBe(1);
      const stored = rows.get(server.secretId)!;
      expect(JSON.parse(await store.load(stored.ciphertext, stored.id))).toEqual({
        ...material,
        headers: { "X-Static": "fixture-static", "X-New": "fixture-new" },
      });
      expect(JSON.stringify(saved)).not.toContain("fixture-static");
      expect(JSON.stringify(saved)).not.toContain("fixture-new");
    },
  );
});

it("allows the fixed native OAuth callback while binding begin to the authenticated actor", async () => {
  const begin = vi.fn().mockResolvedValue({ status: "authorization_not_requested" });
  const deps = {
    prisma: {},
    mcpOAuth: { begin },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "https://app.example.test",
    },
    dataDir: "/tmp/mcp-status-fixture",
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  await expect(
    client.mcp.oauth.begin({ serverId: "server", redirectUri: "coginebot:///mcp" }),
  ).resolves.toEqual({ status: "authorization_not_requested" });
  expect(begin).toHaveBeenCalledWith({
    serverId: "server",
    redirectUri: "coginebot:///mcp",
    spaceId: actor.spaceId,
    userId: actor.userId,
  });
  for (const redirectUri of [
    "coginebot:///mcp?next=other",
    "coginebot://mcp",
    "https://evil.example.test/mcp/oauth/callback",
  ]) {
    await expect(client.mcp.oauth.begin({ serverId: "server", redirectUri })).rejects.toMatchObject(
      { code: "BAD_REQUEST" },
    );
  }
  expect(begin).toHaveBeenCalledTimes(1);
});
