import { createRouterClient } from "@orpc/server";
import { McpOAuthBroker } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "user",
  spaceId: "space",
  email: "fixture@example.test",
  isDeploymentOwner: true,
};

function fixture() {
  const server = {
    id: "server",
    userId: actor.userId,
    spaceId: actor.spaceId,
    installId: "plugin",
    slug: "demo",
    name: "Demo",
    description: "",
    transport: "streamable_http",
    endpoint: "https://tools.example.test/mcp",
    command: null,
    args: [],
    env: { KEEP: true },
    headers: { Authorization: true, "X-Static": true },
    secretId: "old" as string | null,
    enabled: false,
    verbatimResults: true,
    allowAllTools: false,
    allowedTools: [] as string[],
    revision: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const parent = {
    id: "plugin",
    userId: actor.userId,
    spaceId: actor.spaceId,
    kind: "plugin",
    clientNonce: "fixture-nonce",
    status: "installed",
    cleanupRefs: [],
  };
  const material = {
    secret: "fixture-bearer",
    env: { KEEP: "env" },
    headers: { Authorization: "old", "X-Static": "preserved" },
    oauth: { tokens: { access_token: "fixture-oauth", token_type: "bearer" } },
  };
  const rows = new Map([["old", { id: "old", ciphertext: "old-ref" }]]);
  const values = new Map([["old-ref", JSON.stringify(material)]]);
  let active = false;
  let member = true;
  let session = true;
  let count = 0;
  const scoped = (where: Record<string, unknown>) =>
    where.id === server.id && where.spaceId === actor.spaceId && where.userId === actor.userId;
  const prisma = {
    mcpServer: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        scoped(where) ? structuredClone(server) : null,
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(server, data, { revision: server.revision + 1 });
        return structuredClone(server);
      }),
    },
    capabilityInstall: {
      findFirst: vi.fn(async () => structuredClone(parent)),
      update: vi.fn(async ({ data }: { data: { cleanupRefs: [] } }) => Object.assign(parent, data)),
    },
    secret: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      create: vi.fn(async ({ data }: { data: { id: string; ciphertext: string } }) => {
        rows.set(data.id, data);
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows.delete(where.id);
        return { count: 1 };
      }),
      count: vi.fn(
        async ({ where }: { where: { ciphertext: string } }) =>
          [...rows.values()].filter((row) => row.ciphertext === where.ciphertext).length,
      ),
    },
    botSecret: { count: async () => 0 },
    integrationProviderConfig: { count: async () => 0 },
    nativeAppConfig: { count: async () => 0 },
    deploymentIdentity: { count: async () => 0 },
    deploymentTransferSession: { count: async () => 0 },
    deploymentTransferItem: { count: async () => 0 },
    message: { findMany: vi.fn(async () => []) },
    thread: { findMany: vi.fn(async () => []) },
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      const sql = Array.isArray(query) ? query.join("") : "";
      if (sql.includes("space_members") && !member) return [];
      if (sql.includes('FROM "session"') && !session) return [];
      return [{ id: "scope", deletingAt: null, referenced: false }];
    }),
    async $transaction<T>(effect: (tx: typeof prisma) => Promise<T>): Promise<T> {
      active = true;
      try {
        return await effect(prisma);
      } finally {
        active = false;
      }
    },
  };
  const secrets = {
    load: vi.fn(async (ref: string) => {
      expect(active).toBe(false);
      return values.get(ref)!;
    }),
    put: vi.fn(async (value: string) => {
      expect(active).toBe(false);
      const id = `new-${++count}`;
      values.set(id, value);
      return { id, ref: id, ciphertext: id };
    }),
    delete: vi.fn(async (ref: string) => {
      expect(active).toBe(false);
      values.delete(ref);
    }),
  };
  const materialStatus = new McpOAuthBroker(prisma as never, secrets as never);
  const mcpOAuth = {
    statusFor: vi.fn(async () => "connected"),
    statusForMaterial: vi.fn((value: unknown) => materialStatus.statusForMaterial(value)),
    reservePluginCredential: vi.fn(async () => undefined),
    resolvePluginCredential: vi.fn(),
    releasePluginCredential: vi.fn(),
  };
  const deps = {
    prisma,
    secrets,
    mcpOAuth,
    events: { notify: vi.fn() },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fixture",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/mcp-connection-fixture",
  } as unknown as RouterDeps;
  const clientFor = (currentActor = actor, stillAuthorized?: () => Promise<boolean>) =>
    createRouterClient(createRouter(deps), {
      context: { actor: currentActor, sessionId: "session", stillAuthorized } as never,
    });
  return {
    server,
    parent,
    material,
    rows,
    values,
    secrets,
    prisma,
    mcpOAuth,
    client: clientFor(),
    clientFor,
    revokeMember: () => {
      member = false;
    },
    revokeSession: () => {
      session = false;
    },
  };
}

describe("revision-bound MCP connection patches", () => {
  it.each([undefined, false, true])(
    "preserves omitted result retention and accepts explicit full-config values (%s)",
    async (verbatimResults) => {
      const f = fixture();
      const result = await f.client.mcp.servers.update({
        id: f.server.id,
        config: {
          slug: f.server.slug,
          name: f.server.name,
          transport: "streamable_http",
          endpoint: f.server.endpoint,
          headers: {},
          enabled: false,
          verbatimResults,
        },
      });
      expect(result.verbatimResults).toBe(verbatimResults ?? true);
      expect(f.server.verbatimResults).toBe(verbatimResults ?? true);
      expect(result).toMatchObject({ allowAllTools: false, allowedTools: [], revision: 2 });
    },
  );

  it.each([undefined, {}])(
    "enables without rewriting encrypted credentials or tool permission (%s)",
    async (headerUpdates) => {
      const f = fixture();
      f.secrets.load.mockRejectedValue(new Error("offline provider"));
      const result = await f.client.mcp.servers.update({
        id: "server",
        connection: { revision: 1, enabled: true, headerUpdates },
      });
      expect(result).toMatchObject({
        enabled: true,
        verbatimResults: true,
        revision: 2,
        hasSecret: true,
        oauthStatus: "unknown",
        headerKeys: ["Authorization", "X-Static"],
        allowAllTools: false,
        allowedTools: [],
      });
      expect(f.server).toMatchObject({
        secretId: "old",
        env: { KEEP: true },
        headers: { Authorization: true, "X-Static": true },
        endpoint: "https://tools.example.test/mcp",
      });
      expect(f.secrets.load).not.toHaveBeenCalled();
      expect(f.secrets.put).not.toHaveBeenCalled();
      expect(f.mcpOAuth.statusFor).not.toHaveBeenCalled();
    },
  );

  it("merges named encrypted headers and retains OAuth/env/bearer and shared tool settings", async () => {
    const f = fixture();
    f.server.allowAllTools = false;
    f.server.allowedTools = ["read"];
    const result = await f.client.mcp.servers.update({
      id: "server",
      connection: {
        revision: 1,
        enabled: false,
        headerUpdates: { authorization: "replacement", "X-New": "value" },
      },
    });
    expect(JSON.parse(f.values.get(f.server.secretId!)!)).toEqual({
      ...f.material,
      headers: { authorization: "replacement", "X-Static": "preserved", "X-New": "value" },
    });
    expect(result).toMatchObject({
      revision: 2,
      enabled: false,
      allowedTools: ["read"],
      allowAllTools: false,
      oauthStatus: "connected",
    });
    expect(JSON.stringify(result)).not.toContain("replacement");
    expect(f.secrets.put).toHaveBeenCalledTimes(1);
  });

  it("rejects an acknowledged edit's replay before any new credential write", async () => {
    const f = fixture();
    const input = {
      id: "server",
      connection: { revision: 1, enabled: false, headerUpdates: { "X-Key": "value" } },
    };
    await f.client.mcp.servers.update(input);
    await expect(f.client.mcp.servers.update(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.secrets.put).toHaveBeenCalledTimes(1);
    expect(f.server.revision).toBe(2);
  });

  it("does not retry a stale client revision after a concurrent credential edit", async () => {
    const f = fixture();
    f.secrets.put.mockImplementationOnce(async (value) => {
      f.server.revision++;
      f.values.set("late", value);
      return { id: "late", ref: "late", ciphertext: "late" };
    });
    await expect(
      f.client.mcp.servers.update({
        id: "server",
        connection: {
          revision: 1,
          enabled: true,
          headerUpdates: { "X-Key": "value" },
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.secrets.put).toHaveBeenCalledTimes(1);
    expect(f.values.has("late")).toBe(false);
    expect(f.server).toMatchObject({ enabled: false, secretId: "old", revision: 2 });
  });

  it.each(["unloadable", "malformed", "missing"])(
    "fails closed for %s stored material",
    async (fault) => {
      const f = fixture();
      if (fault === "unloadable")
        f.secrets.load.mockRejectedValue(new Error("private raw failure"));
      if (fault === "malformed") f.values.set("old-ref", '{"headers":{"X-Key":false}}');
      if (fault === "missing") f.rows.delete("old");
      await expect(
        f.client.mcp.servers.update({
          id: "server",
          connection: {
            revision: 1,
            enabled: true,
            headerUpdates: { "X-Key": "value" },
          },
        }),
      ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect(f.secrets.put).not.toHaveBeenCalled();
      expect(f.server.revision).toBe(1);
    },
  );

  it.each(["member", "session", "parent"])(
    "rejects a revoked %s after slow provider I/O and compensates its known ref",
    async (fault) => {
      const f = fixture();
      f.secrets.put.mockImplementationOnce(async (value) => {
        f.values.set("late", value);
        if (fault === "member") f.revokeMember();
        if (fault === "session") f.revokeSession();
        if (fault === "parent") f.parent.status = "removed";
        return { id: "late", ref: "late", ciphertext: "late" };
      });
      await expect(
        f.client.mcp.servers.update({
          id: "server",
          connection: {
            revision: 1,
            enabled: true,
            headerUpdates: { "X-Key": "value" },
          },
        }),
      ).rejects.toThrow();
      expect(f.values.has("late")).toBe(false);
      expect(f.server).toMatchObject({ enabled: false, secretId: "old", revision: 1 });
    },
  );

  it.each([
    { ...actor, userId: "other" },
    { ...actor, spaceId: "other" },
  ])("rejects another actor/Space", async (foreign) => {
    const f = fixture();
    await expect(
      f.clientFor(foreign).mcp.servers.update({
        id: "server",
        connection: {
          revision: 1,
          enabled: true,
          headerUpdates: { "X-Key": "value" },
        },
      }),
    ).rejects.toThrow();
    expect(f.secrets.put).not.toHaveBeenCalled();
  });

  it("rejects stdio without running or rewriting it", async () => {
    const f = fixture();
    f.server.transport = "stdio";
    await expect(
      f.client.mcp.servers.update({ id: "server", connection: { revision: 1, enabled: true } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.secrets.put).not.toHaveBeenCalled();
  });
});
