import { createRouterClient } from "@orpc/server";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { McpOAuthBroker } from "@rakazo/adapters";
import type { Actor, McpStdioOAuthClient } from "@rakazo/contracts";
import { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "user",
  spaceId: "space",
  email: "fixture@example.test",
  isDeploymentOwner: true,
};

function fixture({ stdio = false, stdioEnabled = true } = {}) {
  const server = {
    id: "server",
    userId: actor.userId,
    spaceId: actor.spaceId,
    installId: stdio ? null : "plugin",
    slug: "demo",
    name: "Demo",
    description: "",
    transport: stdio ? "stdio" : "streamable_http",
    endpoint: "https://tools.example.test/mcp",
    command: stdio ? "/opt/example-mcp" : null,
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
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(server, data);
        return structuredClone(server);
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        scoped(where) ? structuredClone(server) : null,
      ),
      update: vi.fn(
        async ({ data }: { data: Record<string, unknown>; where?: { revision?: number } }) => {
          Object.assign(server, data, { revision: server.revision + 1 });
          return structuredClone(server);
        },
      ),
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
    remoteConnectors: {
      resolveHostname: async (hostname: string) => [
        { address: hostname === "private.example.test" ? "10.0.0.8" : "203.0.113.10", family: 4 },
      ],
    },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fixture",
      sandboxProvider: "fake",
      mcpStdioEnabled: stdioEnabled,
      mcpStdioAllowedCommands: ["/opt/example-mcp", "/opt/example-mcp-v2"],
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

describe("deployment-managed MCP stdio registration", () => {
  const config = {
    transport: "stdio" as const,
    slug: "fixture",
    name: "Fixture",
    command: "/opt/example-mcp",
    enabled: false,
  };
  const oauthClient = {
    authorizationServer: "https://login.example.test/issuer",
    clientId: "fixture-client",
    clientSecret: "fixture-client-secret",
  };
  const files = { CONFIG_FILE: '{"token":"{{oauth.access_token}}","tag":"fixture-private"}' };
  const env = { MCP_TOKEN: "Bearer {{oauth.access_token}}" };

  it("stores the declaration in the scoped secret without returning its values", async () => {
    const f = fixture({ stdio: true });
    const saved = await f.client.mcp.servers.create({ ...config, env, files, oauthClient });
    expect(saved).toMatchObject({ enabled: false, envKeys: ["MCP_TOKEN"], hasSecret: true });
    expect(JSON.stringify(saved)).not.toMatch(/fixture-client|fixture-private|oauth\.access_token/);
    expect(f.rows.get(f.server.secretId!)).toMatchObject({
      userId: actor.userId,
      spaceId: actor.spaceId,
    });
    expect(JSON.parse(f.values.get(f.server.secretId!)!)).toMatchObject({
      env,
      files,
      oauthClient,
    });
  });

  it("keeps a declaration on metadata edits and discards its grant when the client rotates", async () => {
    const f = fixture({ stdio: true });
    await f.client.mcp.servers.create({ ...config, env, files, oauthClient, args: ["--serve"] });
    f.values.set(
      f.server.secretId!,
      JSON.stringify({ env, files, oauthClient, oauth: f.material.oauth }),
    );
    const save = (patch: Partial<typeof config> & { oauthClient?: McpStdioOAuthClient }) =>
      f.client.mcp.servers.update({ id: f.server.id, config: { ...config, ...patch } });
    await save({ name: "Renamed" });
    expect(f.secrets.put).toHaveBeenCalledTimes(1);
    expect(f.server.args).toEqual(["--serve"]);
    expect(JSON.parse(f.values.get(f.server.secretId!)!)).toEqual({
      env,
      files,
      oauthClient,
      oauth: f.material.oauth,
    });
    await save({
      oauthClient: {
        clientId: oauthClient.clientId,
        authorizationServer: oauthClient.authorizationServer,
      },
    });
    expect(f.secrets.put).toHaveBeenCalledTimes(1);
    const rotated = { ...oauthClient, clientSecret: "fixture-next-secret" };
    await save({ oauthClient: rotated });
    expect(JSON.parse(f.values.get(f.server.secretId!)!)).toEqual({
      env,
      files,
      oauthClient: rotated,
    });
    f.server.allowAllTools = true;
    f.server.allowedTools.push("old-tool");
    await save({ command: "/opt/example-mcp-v2" });
    expect(f.server).toMatchObject({
      args: [],
      env: {},
      secretId: null,
      allowAllTools: false,
      allowedTools: [],
    });
  });

  it("does not copy an omitted secret to a new issuer for the same client ID", async () => {
    const f = fixture({ stdio: true });
    await f.client.mcp.servers.create({ ...config, oauthClient });
    const rebound = {
      clientId: oauthClient.clientId,
      authorizationServer: "https://other.example.test",
    };
    await f.client.mcp.servers.update({
      id: f.server.id,
      config: { ...config, oauthClient: rebound },
    });
    expect(JSON.parse(f.values.get(f.server.secretId!)!)).toEqual({ oauthClient: rebound });
  });

  it("clears the remote server's credentials and approval when switching it to stdio", async () => {
    const f = fixture();
    f.server.installId = null;
    f.server.allowAllTools = true;
    f.server.allowedTools.push("old-tool");
    await f.client.mcp.servers.update({
      id: f.server.id,
      config: { ...config, enabled: true },
    });
    expect(f.server).toMatchObject({
      transport: "stdio",
      secretId: null,
      allowAllTools: false,
      allowedTools: [],
    });
    expect(f.rows.has("old")).toBe(false);
    expect(f.prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          blocks: { array_contains: [{ kind: "mcp_approval", serverId: f.server.id }] },
        }),
      }),
    );
  });

  it("can disable a legacy server after the deployment withdraws stdio", async () => {
    const f = fixture({ stdio: true, stdioEnabled: false });
    f.server.enabled = true;
    f.values.set(
      "old-ref",
      JSON.stringify({ env: { KEEP: "legacy\0value" }, headers: { Host: "legacy" } }),
    );
    f.secrets.load.mockRejectedValue(new Error("Secret storage unavailable"));
    f.mcpOAuth.statusFor.mockRejectedValue(new Error("Secret storage unavailable"));
    const result = await f.client.mcp.servers.update({ id: f.server.id, config });
    expect(result).toMatchObject({
      enabled: false,
      envKeys: ["KEEP"],
      hasSecret: true,
      oauthStatus: "unknown",
    });
    expect(f.secrets.load).not.toHaveBeenCalled();
    expect(f.mcpOAuth.statusFor).not.toHaveBeenCalled();
    expect(f.secrets.put).not.toHaveBeenCalled();
  });

  it.each(["missing record", "unreadable blob", "store read failure", "store write failure"])(
    "disables the server and reports incomplete clearing after %s",
    async (failure) => {
      const f = fixture({ stdio: true });
      f.server.enabled = true;
      f.values.set("old-ref", JSON.stringify({ env, files, oauthClient, oauth: f.material.oauth }));
      if (failure === "missing record") f.rows.delete("old");
      if (failure === "unreadable blob") f.values.set("old-ref", "broken");
      if (failure === "store read failure")
        f.secrets.load.mockRejectedValue(new SecretStoreUnavailableError());
      if (failure === "store write failure")
        f.secrets.put.mockRejectedValue(new Error("Write failed"));
      await expect(
        f.client.mcp.servers.update({
          id: f.server.id,
          revision: f.server.revision,
          config: { ...config, clearCredential: true, verbatimResults: false },
        }),
      ).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message: failure.startsWith("store")
          ? "MCP server was disabled. Its credentials could not be cleared. Reload the server and try again."
          : "MCP server was disabled. Its stored credentials are missing or unreadable. Remove and add the server again to replace its credentials.",
      });
      expect(f.server).toMatchObject({
        enabled: false,
        secretId: "old",
        revision: 2,
        verbatimResults: true,
      });
      expect(f.prisma.secret.deleteMany).not.toHaveBeenCalled();
      expect(f.mcpOAuth.statusFor).not.toHaveBeenCalled();
    },
  );

  it("requires a revision for stdio clearing and rejects a retry after another edit", async () => {
    const f = fixture({ stdio: true });
    f.server.enabled = true;
    const request = { id: f.server.id, config: { ...config, clearCredential: true } };
    await expect(f.client.mcp.servers.update(request)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(f.secrets.load).not.toHaveBeenCalled();
    const original = { ...request, revision: f.server.revision };
    f.secrets.load.mockRejectedValueOnce(new SecretStoreUnavailableError());
    await expect(f.client.mcp.servers.update(original)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    const saved = await f.client.mcp.servers.update({
      id: f.server.id,
      config: { ...config, env: { API_KEY: "fixture-new-credential" } },
    });
    await expect(f.client.mcp.servers.update(original)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.server.revision).toBe(saved.revision);
    expect(JSON.parse(f.values.get(f.server.secretId!)!)).toMatchObject({
      env: { API_KEY: "fixture-new-credential" },
    });
  });

  it("checks the requested revision in the final write when another action changes the row", async () => {
    const f = fixture({ stdio: true });
    f.server.enabled = true;
    f.prisma.mcpServer.update.mockImplementationOnce(async ({ where }) => {
      f.server.revision++;
      expect(where).toMatchObject({ revision: 1 });
      throw new Prisma.PrismaClientKnownRequestError("The revision no longer matches", {
        code: "P2025",
        clientVersion: "fixture",
      });
    });
    await expect(
      f.client.mcp.servers.update({
        id: f.server.id,
        revision: 1,
        config: { ...config, clearCredential: true, oauthClient: null },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.server).toMatchObject({ enabled: true, secretId: "old", revision: 2 });
    expect(f.prisma.secret.deleteMany).not.toHaveBeenCalled();
  });

  it("can disable and explicitly remove all credentials without reading the old blob", async () => {
    const f = fixture({ stdio: true, stdioEnabled: false });
    f.server.enabled = true;
    f.secrets.load.mockRejectedValue(new SecretStoreUnavailableError());
    const result = await f.client.mcp.servers.update({
      id: f.server.id,
      revision: 1,
      config: { ...config, clearCredential: true, oauthClient: null },
    });
    expect(result).toMatchObject({ enabled: false, hasSecret: false, oauthStatus: "none" });
    expect(f.secrets.load).not.toHaveBeenCalled();
    expect(f.rows.has("old")).toBe(false);
  });

  it("edits valid legacy stdio material without rotating a token or validating unused headers", async () => {
    const f = fixture({ stdio: true });
    f.values.set(
      "old-ref",
      JSON.stringify({ secret: "fixture", env: {}, headers: { Host: "legacy" } }),
    );
    await f.client.mcp.servers.update({ id: f.server.id, config: { ...config, enabled: true } });
    expect(f.server.secretId).toBe("old");
    expect(f.secrets.put).not.toHaveBeenCalled();
  });

  it("removes a legacy secret containing only unused headers on explicit clear", async () => {
    const f = fixture({ stdio: true });
    f.values.set("old-ref", JSON.stringify({ env: {}, headers: { Host: "legacy" } }));
    await f.client.mcp.servers.update({
      id: f.server.id,
      revision: f.server.revision,
      config: { ...config, clearCredential: true },
    });
    expect(f.server.secretId).toBeNull();
    expect(f.rows.has("old")).toBe(false);
    expect(f.secrets.put).not.toHaveBeenCalled();
  });

  it.each([{ oauthClient }, { files }, { args: ["--new-mode"] }])(
    "refuses new registration data for an excluded command even while disabled",
    async (patch) => {
      const f = fixture({ stdio: true, stdioEnabled: false });
      await expect(
        f.client.mcp.servers.update({ id: f.server.id, config: { ...config, ...patch } }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(f.secrets.load).not.toHaveBeenCalled();
      expect(f.secrets.put).not.toHaveBeenCalled();
    },
  );

  it("requires removal of references when the registered client is removed", async () => {
    const f = fixture({ stdio: true });
    await f.client.mcp.servers.create({ ...config, env, files, oauthClient });
    f.secrets.put.mockClear();
    await expect(
      f.client.mcp.servers.update({
        id: f.server.id,
        config: { ...config, oauthClient: null },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.secrets.put).not.toHaveBeenCalled();
    await f.client.mcp.servers.update({
      id: f.server.id,
      config: { ...config, oauthClient: null, env: {}, files: {} },
    });
    expect(f.server.secretId).toBeNull();
  });

  it("rejects a member's create and update before reading or writing secrets", async () => {
    const f = fixture({ stdio: true });
    const member = f.clientFor({ ...actor, isDeploymentOwner: false });
    await expect(member.mcp.servers.create({ ...config, oauthClient })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(member.mcp.servers.update({ id: f.server.id, config })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(f.secrets.put).not.toHaveBeenCalled();
    expect(f.secrets.load).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: true, files, oauthClient },
    { command: "/opt/disallowed-mcp", files },
    { oauthClient: { ...oauthClient, authorizationServer: "https://private.example.test" } },
    { oauthClient: { ...oauthClient, authorizationServer: "https://login.example.test?" } },
    { oauthClient: { ...oauthClient, authorizationServer: "http://login.example.test" } },
    { files },
    { files: { CONFIG_FILE: "{{oauth.unknown}}" }, oauthClient },
    { files: { CONFIG_FILE: "{{oauth.access_token}" }, oauthClient },
    { files: { "../CONFIG_FILE": "fixture" } },
    { env: { CONFIG_FILE: "fixture" }, files, oauthClient },
    { args: ["{{oauth.client_secret}}"], oauthClient },
    { args: ["fixture\0argument"] },
    { env: { KEY: "fixture\0value" } },
  ])("rejects an unsafe declaration before saving it (%j)", async (patch) => {
    const f = fixture({ stdio: true });
    await expect(f.client.mcp.servers.create({ ...config, ...patch })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(f.secrets.put).not.toHaveBeenCalled();
    expect(f.prisma.mcpServer.create).not.toHaveBeenCalled();
  });

  it("keeps legacy static stdio available only where the deployment allows it", async () => {
    const f = fixture({ stdio: true });
    await expect(
      f.client.mcp.servers.create({ ...config, enabled: true, env: { KEY: "fixture" } }),
    ).resolves.toMatchObject({ enabled: true });
    const disabled = fixture({ stdio: true, stdioEnabled: false });
    await expect(disabled.client.mcp.servers.create(config)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(disabled.prisma.mcpServer.create).not.toHaveBeenCalled();
  });
});

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
