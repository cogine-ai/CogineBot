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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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
      fetcher: typeof fetch = network.fetch,
    ) => {
      const broker = new McpOAuthBroker(
        withSecretPersistence(db.prisma, store),
        store,
        { fetch: fetcher, resolveHostname },
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
    const requested = deferred<void>();
    const release = deferred<void>();
    f.refresh.mockImplementationOnce(async (input, init) => {
      requested.resolve();
      await release.promise;
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
        requested.promise,
        first.then(() => {
          throw new Error("Refresh request did not start");
        }),
      ]);
      second = runAsTenant(f.context, () => other!.tokens());
      void second.catch(() => undefined);
      expect(await f.prisma.mcpServer.findUnique({ where: { id: f.server.id } })).not.toBeNull();
      await expect
        .poll(
          async () => {
            const result = await f.db.pool.query<{ waiting: boolean }>(
              `SELECT EXISTS (
               SELECT 1 FROM pg_locks
               WHERE locktype = 'advisory' AND NOT granted AND objsubid = 2
                 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                 AND classid::bigint = (hashtext('mcp-stdio-oauth-refresh')::bigint & 4294967295)
                 AND objid::bigint = (hashtext($1)::bigint & 4294967295)
             ) AS waiting`,
              [f.server.id],
            );
            return result.rows[0]?.waiting;
          },
          { timeout: 3_000 },
        )
        .toBe(true);
    } finally {
      release.resolve();
    }
    const [one, two] = await Promise.all([first, second]);
    expect(one).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
    expect(two).toEqual(one);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(adopted).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: (await f.read()).row.id }),
    );
  });

  it("refreshes a different stdio server while one issuer request is still pending", async () => {
    const f = await fixture({ stdio: true, poolMax: 1 });
    const firstMaterial = await f.read();
    const stored = await f.store.put(JSON.stringify(firstMaterial.material), {
      ...f.context,
      operationId: "fixture",
      traceId: "fixture",
      signal: new AbortController().signal,
    });
    await f.prisma.secret.create({ data: { ...stored, ...f.context, kind: "mcp" } });
    const sibling = await f.prisma.mcpServer.create({
      data: {
        ...f.context,
        slug: "sibling-oauth",
        name: "Sibling OAuth test",
        transport: "stdio",
        command: "fixture-mcp",
        secretId: stored.id,
      },
    });
    const provider = await runAsTenant(f.context, () => f.broker.providerFor(sibling, f.context));
    const refreshFixture = f.refresh.getMockImplementation()!;
    const requested = deferred<void>();
    const release = deferred<void>();
    f.refresh.mockImplementationOnce(async (input, init) => {
      requested.resolve();
      await release.promise;
      return refreshFixture(input, init);
    });
    const first = runAsTenant(f.context, () => f.provider.tokens());
    void first.catch(() => undefined);
    let second: typeof first | undefined;
    try {
      await Promise.race([
        requested.promise,
        first.then(() => {
          throw new Error("First refresh request did not start");
        }),
      ]);
      second = runAsTenant(f.context, () => provider!.tokens());
      void second.catch(() => undefined);
      await expect.poll(() => f.refresh.mock.calls.length, { timeout: 3_000 }).toBe(2);
      expect(await second).toMatchObject({ access_token: "access-1" });
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
    expect(await first).toMatchObject({ access_token: "access-1" });
  });

  it("returns a stdio authorization receipt only for the committed replacement", async () => {
    const f = await fixture({ stdio: true });
    const where = { id: "default" };
    const previous = await f.prisma.deploymentSettings.findUnique({ where });
    await f.prisma.deploymentSettings.upsert({
      where,
      create: { ...where, ownerUserId: f.context.userId },
      update: { ownerUserId: f.context.userId },
    });
    try {
      const broker = f.makeBroker(f.db, undefined, async (input) =>
        new URL(new Request(input).url).pathname === "/token"
          ? Response.json({ access_token: "fixture-new-grant", token_type: "Bearer" })
          : Response.json({
              issuer,
              authorization_endpoint: `${issuer}/authorize`,
              token_endpoint: `${issuer}/token`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            }),
      );
      const started = await runAsTenant(f.context, () =>
        broker.begin({
          ...f.context,
          serverId: f.server.id,
          redirectUri: "https://app.example.test/callback",
        }),
      );
      if (started.status !== "authorization_required") throw new Error("Expected authorization");
      const complete = () =>
        runAsTenant(f.context, () =>
          broker.complete({
            ...f.context,
            sessionId: started.sessionId,
            state: started.sessionId,
            code: "fixture-code",
          }),
        );
      await expect(complete()).resolves.toEqual({
        serverId: f.server.id,
        action: "credential.changed",
      });
      expect((await f.read()).material.oauth?.tokens?.access_token).toBe("fixture-new-grant");
      await expect(complete()).rejects.toThrow("MCP OAuth session is invalid or expired");
    } finally {
      if (previous)
        await f.prisma.deploymentSettings.update({
          where,
          data: { ownerUserId: previous.ownerUserId },
        });
      else await f.prisma.deploymentSettings.deleteMany({ where });
    }
  });

  it("serializes stdio callback persistence with deployment ownership changes", async () => {
    const f = await fixture({ stdio: true });
    const where = { id: "default" };
    const previous = await f.prisma.deploymentSettings.findUnique({ where });
    await f.prisma.deploymentSettings.upsert({
      where,
      create: { ...where, ownerUserId: f.context.userId },
      update: { ownerUserId: f.context.userId },
    });
    const fetcher: typeof fetch = async (input) => {
      const request = new Request(input);
      if (new URL(request.url).pathname === "/token")
        return Response.json({ access_token: "fixture-new-grant", token_type: "Bearer" });
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    };
    try {
      const broker = f.makeBroker(openDb(), undefined, fetcher);
      const begin = await runAsTenant(f.context, () =>
        broker.begin({
          ...f.context,
          serverId: f.server.id,
          redirectUri: "https://app.example.test/callback",
        }),
      );
      if (begin.status !== "authorization_required") throw new Error("Expected authorization URL");
      const blocked = deferred<number>();
      const release = deferred<void>();
      const grantPrepared = deferred<string>();
      const returnGrant = deferred<void>();
      const prepare = f.store.put.bind(f.store);
      const put = vi.spyOn(f.store, "put").mockImplementationOnce(async (...input) => {
        const record = await prepare(...input);
        grantPrepared.resolve(record.ciphertext);
        await returnGrant.promise;
        return record;
      });
      const callback = runAsTenant(f.context, () =>
        broker.complete({
          ...f.context,
          sessionId: begin.sessionId,
          state: begin.sessionId,
          code: "fixture-code",
        }),
      );
      void callback.catch(() => undefined);
      let ownerChange: Promise<void> | undefined;
      try {
        const ref = await Promise.race([
          grantPrepared.promise,
          callback.then(() => {
            throw new Error("Callback did not prepare the granted credentials");
          }),
        ]);
        ownerChange = f.prisma.$transaction(async (tx) => {
          await tx.deploymentSettings.update({ where, data: { ownerUserId: null } });
          const [process] = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          blocked.resolve(process!.pid);
          await release.promise;
        });
        void ownerChange.catch(blocked.reject);
        const pid = await blocked.promise;
        returnGrant.resolve();
        await expect
          .poll(
            async () => {
              const result = await f.db.pool.query<{ waiting: boolean }>(
                `SELECT EXISTS (
                 SELECT 1 FROM pg_stat_activity
                 WHERE $1 = ANY(pg_blocking_pids(pid))
                   AND query LIKE '%deployment_settings%FOR SHARE%'
               ) AS waiting`,
                [pid],
              );
              return result.rows[0]?.waiting;
            },
            { timeout: 3_000 },
          )
          .toBe(true);
        release.resolve();
        await ownerChange;
        await expect(callback).rejects.toThrow(
          "MCP stdio authorization requires the deployment owner",
        );
        expect((await f.read()).row.id).toBe(f.server.secretId);
        expect(f.entries.has(ref)).toBe(false);
      } finally {
        returnGrant.resolve();
        release.resolve();
        await Promise.allSettled([ownerChange, callback]);
        put.mockRestore();
      }
    } finally {
      await f.prisma.deploymentSettings.update({
        where,
        data: { ownerUserId: previous?.ownerUserId ?? null },
      });
    }
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

  it.each([true, false])(
    "preserves a rotated stdio grant across a revision change with enabled=%s",
    async (enabled) => {
      const f = await fixture({ stdio: true });
      const allowAllTools = !f.server.allowAllTools;
      const original = f.refresh.getMockImplementation()!;
      f.refresh.mockImplementationOnce(async (input, init) => {
        await f.prisma.mcpServer.update({
          where: { id: f.server.id },
          data: { enabled, allowAllTools, revision: { increment: 1 } },
        });
        return original(input, init);
      });
      const tokens = await runAsTenant(f.context, () => f.provider.tokens());
      expect(tokens?.refresh_token).toBe("refresh-1");
      expect((await f.read()).material.oauth?.tokens?.refresh_token).toBe("refresh-1");
      expect(await f.prisma.mcpServer.findUnique({ where: { id: f.server.id } })).toMatchObject({
        enabled,
        allowAllTools,
        revision: f.server.revision + 1,
      });
    },
  );

  it("does not restore a stdio grant disconnected after refresh dispatch", async () => {
    const f = await fixture({ stdio: true });
    const original = f.refresh.getMockImplementation()!;
    f.refresh.mockImplementationOnce(async (input, init) => {
      await runAsTenant(f.context, () =>
        f.broker.disconnect({ ...f.context, serverId: f.server.id }),
      );
      return original(input, init);
    });
    await expect(runAsTenant(f.context, () => f.provider.tokens())).rejects.toThrow();
    expect((await f.read()).material.oauth?.tokens).toBeUndefined();
  });

  it.each([true, false])(
    "handles an unavailable stdio issuer with expired=%s without losing the saved grant",
    async (expired) => {
      const f = await fixture({ stdio: true, expired, expiresIn: 30 });
      f.refresh.mockRejectedValueOnce(new Error("Fixture issuer did not respond"));
      const result = runAsTenant(f.context, () => f.provider.tokens());
      if (expired) await expect(result).rejects.toThrow("MCP OAuth refresh is unavailable");
      else await expect(result).resolves.toMatchObject({ access_token: "access-0" });
      expect(f.refresh).toHaveBeenCalledOnce();
      expect((await f.read()).material.oauth?.tokens?.refresh_token).toBe("refresh-0");
    },
  );

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

  it.each(["confirmed", "lost-reply", "rolled-back"] as const)(
    "reports a restored sign-in according to its %s save acknowledgement",
    async (outcome) => {
      const f = await fixture({ expired: false, poolMax: 1, withStaticCredential: false });
      const previous = await f.read();
      const redirectUri = "https://app.example.test/callback";
      const oauth = {
        clientInformation: previous.material.oauth!.clientInformation,
        discoveryState: previous.material.oauth!.discoveryState,
        codeVerifier: "fixture-persisted-verifier",
        redirectUri,
      };
      f.entries.set(previous.row.ciphertext, JSON.stringify({ oauth }));
      const sessionId = randomUUID();
      const sessionRef = `fixture-session-${sessionId}`;
      f.entries.set(sessionRef, JSON.stringify({ oauth, revision: f.server.revision }));
      await f.prisma.mcpOAuthSession.create({
        data: {
          id: sessionId,
          serverId: f.server.id,
          ...f.context,
          endpoint: f.server.endpoint!,
          redirectUri,
          oauthCiphertext: sessionRef,
        },
      });
      const requests: Array<{ url: string; verifier: string | null }> = [];
      const exchange = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === "GET") return new Response(null, { status: 404 });
        requests.push({
          url: request.url,
          verifier: new URLSearchParams(await request.text()).get("code_verifier"),
        });
        return Response.json({
          access_token: "fixture-new-access",
          refresh_token: "fixture-new-refresh",
          token_type: "Bearer",
          expires_in: 1,
        });
      };
      const restarted = f.makeBroker(f.db, undefined, exchange);
      const fault = outcome === "confirmed" ? null : failSecretCommit(f.db.pool, outcome);
      const complete = runAsTenant(f.context, () =>
        restarted.complete({ ...f.context, sessionId, state: sessionId, code: "fixture-code" }),
      );
      if (outcome === "confirmed")
        await expect(complete).resolves.toEqual({
          serverId: f.server.id,
          action: "credential.created",
        });
      else await expect(complete).rejects.toThrow();
      expect(requests).toEqual([{ url: `${issuer}/token`, verifier: oauth.codeVerifier }]);
      if (fault) expect(fault.failures()).toBe(1);
      expect((await f.read()).material.oauth?.tokens?.access_token).toBe(
        outcome === "rolled-back" ? undefined : "fixture-new-access",
      );
      const current = await f.prisma.mcpServer.findUniqueOrThrow({ where: { id: f.server.id } });
      expect(current.revision).toBe(f.server.revision + (outcome === "rolled-back" ? 0 : 1));
      expect(await f.prisma.mcpOAuthSession.findUnique({ where: { id: sessionId } })).toBeNull();
    },
    30_000,
  );

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
