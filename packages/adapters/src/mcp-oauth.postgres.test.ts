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
  const brokers: McpOAuthBroker[] = [];
  const users: string[] = [];

  function openDb(poolMax?: number) {
    const db = createDb(databaseUrl!, { poolMax });
    databases.push(db);
    return db;
  }

  afterAll(async () => {
    await Promise.all(brokers.map((broker) => broker.close()));
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

  async function fixture({
    withStaticCredential = true,
    expired = true,
    expiresIn = 3600,
    stdio = false,
    poolMax = undefined as number | undefined,
    basic = false,
  } = {}) {
    const db = openDb(poolMax);
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
    const credential = basic
      ? { clientId: "team:fixture", clientSecret: "fixture+secret %" }
      : { clientId: "synthetic-client" };
    const material: OAuthMaterial = {
      ...(withStaticCredential ? { secret: "synthetic-static-credential" } : {}),
      ...(stdio
        ? {
            oauthClient: { authorizationServer: issuer, ...credential },
            files: { CONFIG_FILE: "{{oauth.access_token}}" },
          }
        : {}),
      oauth: {
        redirectUri: "https://app.example.test/callback",
        tokens: {
          access_token: "access-0",
          refresh_token: "refresh-0",
          token_type: "Bearer",
          expires_in: expiresIn,
          issuer,
          ...(stdio ? { scope: "fixture-granted-scope" } : {}),
        },
        obtainedAt: Date.now() - (expired ? 2 * 60 * 60 * 1000 : 0),
        clientInformation: {
          client_id: credential.clientId,
          ...(credential.clientSecret ? { client_secret: credential.clientSecret } : {}),
          issuer,
        },
        discoveryState: {
          authorizationServerUrl: issuer,
          authorizationServerMetadata: {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            response_types_supported: ["code"],
            ...(basic ? { token_endpoint_auth_methods_supported: ["client_secret_basic"] } : {}),
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
        transport: stdio ? "stdio" : "streamable_http",
        endpoint: stdio ? null : "https://mcp.example.test/mcp",
        ...(stdio ? { command: "fixture-mcp" } : {}),
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
    const network = {
      fetch: refresh,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    };
    const stdioConfig = { enabled: true, allowedCommands: ["fixture-mcp"], databaseUrl };
    const makeBroker = (
      db: ReturnType<typeof createDb>,
      resolveHostname = network.resolveHostname,
    ) => {
      const broker = new McpOAuthBroker(
        withSecretPersistence(db.prisma, store),
        store,
        { ...network, resolveHostname },
        false,
        stdio ? stdioConfig : undefined,
      );
      brokers.push(broker);
      return broker;
    };
    const broker = makeBroker(db);
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
      makeBroker,
    };
  }

  it.each([3600, 0])("renews a stdio grant with a lifetime of %s seconds", async (expiresIn) => {
    const f = await fixture({
      stdio: true,
      withStaticCredential: false,
      expired: expiresIn !== 0,
      expiresIn,
    });
    const tokens = await runAsTenant(f.context, () => f.provider.tokens());
    expect(tokens).toMatchObject({
      access_token: "access-1",
      refresh_token: "refresh-1",
      issuer,
      scope: "fixture-granted-scope",
    });
    expect(f.refresh).toHaveBeenCalledOnce();
    const { material } = await f.read();
    expect(material).toMatchObject({
      oauthClient: { authorizationServer: issuer, clientId: "synthetic-client" },
      files: { CONFIG_FILE: "{{oauth.access_token}}" },
      oauth: { tokens },
    });
  });

  it("serializes stdio refresh across brokers with a single connection in the main pool", async () => {
    const f = await fixture({ stdio: true, poolMax: 1, basic: true });
    const peer = f.makeBroker(openDb(1));
    const adopted = vi.fn();
    const runtimeContext = {
      ...f.context,
      traceId: "stdio-fixture",
      signal: new AbortController().signal,
    };
    const other = await runAsTenant(f.context, () =>
      peer.providerFor(f.server, runtimeContext, undefined, adopted),
    );
    const refreshFixture = f.refresh.getMockImplementation()!;
    let receiveRequest = () => {};
    const requested = new Promise<void>((resolve) => {
      receiveRequest = resolve;
    });
    let releaseRequest = () => {};
    const release = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    f.refresh.mockImplementationOnce(async (input, init) => {
      receiveRequest();
      await release;
      const authorization = new Headers(init?.headers).get("authorization");
      expect(Buffer.from(authorization!.slice(6), "base64").toString()).toBe(
        "team%3Afixture:fixture%2Bsecret+%25",
      );
      return refreshFixture(input, init);
    });
    const first = runAsTenant(f.context, () => f.provider.tokens());
    void first.catch(() => undefined);
    let second: typeof first | undefined;
    try {
      await Promise.race([
        requested,
        first.then(() => {
          throw new Error("Refresh request did not start");
        }),
      ]);
      second = runAsTenant(f.context, () => other!.tokens());
      void second.catch(() => undefined);
      expect(await f.prisma.mcpServer.findUnique({ where: { id: f.server.id } })).not.toBeNull();
    } finally {
      releaseRequest();
    }
    const [one, two] = await Promise.all([first, second]);
    expect(one).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
    expect(two).toEqual(one);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(adopted).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: (await f.read()).row.id }),
    );
  });

  it("skips stdio refresh when the server is disabled while its grant is loading", async () => {
    const f = await fixture({ stdio: true });
    const read = f.store.load.bind(f.store);
    const load = vi.spyOn(f.store, "load").mockImplementationOnce(async (...args) => {
      await f.prisma.mcpServer.update({
        where: { id: f.server.id },
        data: { enabled: false, revision: { increment: 1 } },
      });
      return read(...args);
    });
    try {
      await expect(runAsTenant(f.context, () => f.provider.tokens())).rejects.toThrow();
      expect(f.refresh).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it("cancels a pending token request while retaining a grant issued after dispatch", async () => {
    const f = await fixture({ stdio: true });
    const before = new AbortController();
    const preparing = f.makeBroker(openDb(), async () => {
      before.abort();
      return [{ address: "203.0.113.10", family: 4 }];
    });
    const context = { ...f.context, signal: before.signal };
    const pending = await runAsTenant(f.context, () => preparing.providerFor(f.server, context));
    await expect(runAsTenant(f.context, () => pending!.tokens())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(f.refresh).not.toHaveBeenCalled();

    const after = new AbortController();
    const fetch = f.refresh.getMockImplementation()!;
    f.refresh.mockImplementationOnce(async (input, init) => {
      after.abort();
      return fetch(input, init);
    });
    const dispatched = await runAsTenant(f.context, () =>
      f.broker.providerFor(f.server, { ...f.context, signal: after.signal }),
    );
    await expect(runAsTenant(f.context, () => dispatched!.tokens())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(f.refresh).toHaveBeenCalledOnce();
    expect((await f.read()).material.oauth?.tokens).toMatchObject({ refresh_token: "refresh-1" });
  });

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

  it.each([
    { outcome: "lost-reply", stdio: false },
    { outcome: "rolled-back", stdio: false },
    { outcome: "lost-reply", stdio: true },
  ] as const)(
    "recovers the issued grant after $outcome (stdio $stdio)",
    async ({ outcome, stdio }) => {
      const f = await fixture({ stdio });
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

  it("does not invalidate authorization when both SDK refresh saves fail", async () => {
    const f = await fixture({ withStaticCredential: false, expired: false });
    let issued = false;
    const fault = failSecretCommit(f.db.pool, "rolled-back", {
      always: true,
      when: () => issued && fault.failures() < 2,
    });
    await expect(
      runAsTenant(f.context, () =>
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
      ),
    ).rejects.toMatchObject({ name: "TemporarilyUnavailableError" });
    expect(fault.failures()).toBe(2);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    const current = await f.read();
    expect(current.material.oauth?.tokens?.refresh_token).toBe("refresh-0");
    expect(current.material.oauth?.codeVerifier).toBeUndefined();
  }, 30_000);

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
