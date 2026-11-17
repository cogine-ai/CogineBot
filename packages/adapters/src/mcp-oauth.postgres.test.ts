import { randomUUID } from "node:crypto";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretNotFoundError } from "@rakazo/adapter-kit";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import type { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { McpConnector } from "./mcp-connector.js";
import type { OAuthMaterial } from "./mcp-oauth.js";
import { McpOAuthBroker } from "./mcp-oauth.js";
import { withSecretPersistence } from "./secret-persistence.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const issuer = "https://auth.example.test";

describePostgres("MCP OAuth save recovery (PostgreSQL)", () => {
  const databases: ReturnType<typeof createDb>[] = [];
  const users: string[] = [];

  function openDb() {
    const db = createDb(databaseUrl!);
    databases.push(db);
    return db;
  }

  afterAll(async () => {
    if (databases[0]) {
      const prisma = asSystem(databases[0].prisma);
      await prisma.organization.deleteMany({ where: { id: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    for (const db of databases) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function fixture({ withStaticCredential = true, expired = true } = {}) {
    const db = openDb();
    const entries = new Map<string, string>();
    const listeners = new Set<(ref: string) => void>();
    const store = {
      put: async (plaintext: string) => {
        const id = randomUUID();
        const ciphertext = `remote:${id}`;
        entries.set(ciphertext, plaintext);
        return { id, ciphertext };
      },
      load: async (ref: string) => {
        const value = entries.get(ref);
        if (value === undefined) throw new SecretNotFoundError();
        return value;
      },
      delete: async (ref: string) => {
        entries.delete(ref);
        for (const listener of listeners) listener(ref);
      },
      onChange: (listener: (ref: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isRemote: () => true,
    } as unknown as SecretStore;
    const prisma = asSystem(db.prisma);
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "OAuth test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "OAuth test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "OAuth test", isDefault: true },
    });
    const context = { userId: id, spaceId: id };
    const material: OAuthMaterial = {
      ...(withStaticCredential ? { secret: "synthetic-static-credential" } : {}),
      oauth: {
        redirectUri: "https://app.example.test/callback",
        tokens: {
          access_token: "access-0",
          refresh_token: "refresh-0",
          token_type: "Bearer",
          expires_in: 3600,
          issuer,
        },
        obtainedAt: Date.now() - (expired ? 2 * 60 * 60 * 1000 : 0),
        clientInformation: { client_id: "synthetic-client", issuer },
        discoveryState: {
          authorizationServerUrl: issuer,
          authorizationServerMetadata: {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            response_types_supported: ["code"],
          },
        },
      },
    };
    const stored = await store.put(JSON.stringify(material), {
      operationId: "test",
      traceId: "test",
      ...context,
      signal: new AbortController().signal,
    });
    await prisma.secret.create({ data: { ...stored, ...context, kind: "mcp" } });
    const server = await prisma.mcpServer.create({
      data: {
        ...context,
        slug: "oauth",
        name: "OAuth",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        secretId: stored.id,
      },
    });
    const refresh = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${issuer}/token`);
      expect(new URLSearchParams(await request.text()).get("refresh_token")).toBe("refresh-0");
      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "Bearer",
        expires_in: 3600,
      });
    });
    const broker = new McpOAuthBroker(withSecretPersistence(db.prisma, store), store, {
      fetch: refresh,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    });
    const adopted = vi.fn<(record: { id: string; ref: string; material: OAuthMaterial }) => void>();
    const provider = await runAsTenant(context, () =>
      broker.providerFor(server, context, undefined, adopted),
    );
    if (!provider) throw new Error("Expected an OAuth provider");
    const read = async () => {
      const row = await prisma.secret.findFirstOrThrow({
        where: { mcpServers: { some: { id: server.id } } },
      });
      return {
        row,
        material: JSON.parse(await store.load(row.ciphertext, row.id)) as OAuthMaterial,
      };
    };
    return {
      db,
      entries,
      store,
      prisma,
      server,
      context,
      refresh,
      adopted,
      provider,
      read,
      broker,
    };
  }

  /** Execute the physical outcome, then lose the database acknowledgement. */
  function failSecretCommit(
    pool: Pool,
    outcome: "lost-reply" | "rolled-back",
    options: { always?: boolean; afterFault?: () => Promise<void>; when?: () => boolean } = {},
  ) {
    type Query = (...args: unknown[]) => Promise<unknown>;
    let failures = 0;
    const wrapped = new WeakSet<object>();
    const connect = pool.connect.bind(pool) as (callback?: unknown) => Promise<{ query: Query }>;
    pool.connect = (async (callback?: unknown) => {
      if (callback) return connect(callback);
      const client = await connect();
      if (wrapped.has(client)) return client;
      wrapped.add(client);
      const query = client.query.bind(client);
      let wroteSecret = false;
      client.query = async (...args) => {
        const [first] = args;
        const text = typeof first === "string" ? first : (first as { text: string }).text;
        if (text === "BEGIN") wroteSecret = false;
        if (/^INSERT INTO "public"\."secrets"/.test(text)) wroteSecret = true;
        if (
          text !== "COMMIT" ||
          !wroteSecret ||
          (failures > 0 && !options.always) ||
          options.when?.() === false
        )
          return query(...args);
        await query(outcome === "lost-reply" ? "COMMIT" : "ROLLBACK");
        failures++;
        await options.afterFault?.();
        throw new Error("Connection terminated unexpectedly");
      };
      return client;
    }) as unknown as Pool["connect"];
    return { failures: () => failures };
  }

  it.each(["lost-reply", "rolled-back"] as const)(
    "recovers the issued grant after a %s save without refreshing twice",
    async (outcome) => {
      const f = await fixture();
      const fault = failSecretCommit(f.db.pool, outcome);
      const tokens = await runAsTenant(f.context, () => f.provider.tokens());
      expect(fault.failures()).toBe(1);
      expect(tokens).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
      const current = await f.read();
      expect(f.entries.has(current.row.ciphertext)).toBe(true);
      expect(current.material.oauth?.tokens).toMatchObject(tokens!);
      expect(current.material.secret).toBe("synthetic-static-credential");
      expect(f.adopted).toHaveBeenLastCalledWith({
        id: current.row.id,
        ref: current.row.ciphertext,
        material: current.material,
      });
      expect(await f.provider.tokens()).toEqual(tokens);
      expect(f.refresh).toHaveBeenCalledTimes(1);
    },
    30_000,
  );

  it.each(["lost-reply", "rolled-back"] as const)(
    "continues the current connection after a %s save with retirement notifications",
    async (outcome) => {
      const f = await fixture({ withStaticCredential: false });
      await f.prisma.mcpServer.update({
        where: { id: f.server.id },
        data: { allowAllTools: true },
      });
      const fault = failSecretCommit(f.db.pool, outcome);
      let initializations = 0;
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe(f.server.endpoint);
        expect(request.headers.get("authorization")).toBe("Bearer access-1");
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const message = JSON.parse(await request.text());
        if (message.method === "initialize") {
          initializations++;
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
          });
        }
        if (message.method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
          });
        return new Response(null, { status: 202 });
      });
      const connector = new McpConnector(
        f.db.prisma,
        f.store,
        {
          network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
        },
        f.broker,
      );
      const context = {
        ...f.context,
        operationId: "test",
        traceId: "test",
        botId: "test",
        signal: new AbortController().signal,
      };
      try {
        const tools = await runAsTenant(f.context, () => connector.discoverTools(context));
        expect(
          tools.map((tool) => tool.name),
          JSON.stringify(
            await f.prisma.mcpServer.findUnique({
              where: { id: f.server.id },
              select: { healthMessage: true },
            }),
          ),
        ).toEqual(["mcp__oauth__echo"]);
        expect(fault.failures()).toBe(1);
        expect(initializations).toBe(1);
        expect(await runAsTenant(f.context, () => connector.discoverTools(context))).toEqual(tools);
        expect(initializations).toBe(1);
        expect(f.refresh).toHaveBeenCalledTimes(1);
        const current = await f.read();
        expect(current.material.oauth?.tokens?.refresh_token).toBe("refresh-1");
        expect(f.entries.has(current.row.ciphertext)).toBe(true);
      } finally {
        await connector.close();
      }
    },
    30_000,
  );

  it.each(["lost-reply", "rolled-back"] as const)(
    "recovers the SDK's runtime refresh after a %s save",
    async (outcome) => {
      const f = await fixture({ withStaticCredential: false, expired: false });
      let issued = false;
      const fault = failSecretCommit(f.db.pool, outcome, { when: () => issued });
      const result = await runAsTenant(f.context, () =>
        auth(f.provider, {
          serverUrl: f.server.endpoint!,
          fetchFn: async (input, init) => {
            const request = new Request(input, init);
            if (new URL(request.url).pathname.includes("oauth-protected-resource"))
              return Response.json({
                resource: f.server.endpoint,
                authorization_servers: [issuer],
              });
            const response = await f.refresh(input, init);
            issued = true;
            return response;
          },
        }),
      );
      expect(result).toBe("AUTHORIZED");
      expect(fault.failures()).toBe(1);
      expect(f.refresh).toHaveBeenCalledTimes(1);
      const current = await f.read();
      expect(current.material.oauth?.tokens?.refresh_token).toBe("refresh-1");
      expect(f.adopted).toHaveBeenLastCalledWith({
        id: current.row.id,
        ref: current.row.ciphertext,
        material: current.material,
      });
    },
    30_000,
  );

  it("fails rather than adopting an uncommitted grant when saves keep rolling back", async () => {
    const f = await fixture();
    const fault = failSecretCommit(f.db.pool, "rolled-back", { always: true });
    await expect(runAsTenant(f.context, () => f.provider.tokens())).rejects.toThrow(
      "Connection terminated unexpectedly",
    );
    expect(fault.failures()).toBeGreaterThan(0);
    expect(fault.failures()).toBeLessThan(10);
    const current = await f.read();
    expect(current.material.oauth?.tokens?.refresh_token).toBe("refresh-0");
    expect(f.entries.has(current.row.ciphertext)).toBe(true);
    expect(f.adopted).not.toHaveBeenCalled();
    expect(f.refresh).toHaveBeenCalledTimes(1);
  }, 30_000);

  it.each(["disconnect", "new authorization", "endpoint change"] as const)(
    "keeps %s authoritative during save recovery",
    async (change) => {
      const f = await fixture();
      const control = openDb();
      const controlPrisma = asSystem(control.prisma);
      const peer = new McpOAuthBroker(withSecretPersistence(control.prisma, f.store), f.store);
      let expected: OAuthMaterial | undefined;
      const fault = failSecretCommit(f.db.pool, "rolled-back", {
        afterFault: async () => {
          await runAsTenant(f.context, async () => {
            if (change === "disconnect")
              await peer.disconnect({ serverId: f.server.id, ...f.context });
            else if (change === "endpoint change")
              await controlPrisma.mcpServer.update({
                where: { id: f.server.id },
                data: { endpoint: "https://other.example.test/mcp", revision: { increment: 1 } },
              });
            else {
              const server = await controlPrisma.mcpServer.findUniqueOrThrow({
                where: { id: f.server.id },
              });
              const provider = await peer.providerFor(server, f.context);
              await provider!.saveTokens({
                access_token: "new-login-access",
                refresh_token: "new-login-refresh",
                token_type: "Bearer",
                issuer,
              });
            }
          });
          expected = (await f.read()).material;
        },
      });
      await expect(runAsTenant(f.context, () => f.provider.tokens())).rejects.toThrow(
        /reconnect|changed|unavailable/i,
      );
      expect(fault.failures()).toBe(1);
      expect((await f.read()).material).toEqual(expected);
      expect(f.adopted).not.toHaveBeenCalled();
      expect(f.refresh).toHaveBeenCalledTimes(1);
    },
    30_000,
  );
});
