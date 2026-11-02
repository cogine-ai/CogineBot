import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { OAuthMaterial } from "./mcp-oauth.js";
import { McpOAuthBroker, McpReauthorizationRequiredError } from "./mcp-oauth.js";

const actor = { spaceId: "fixture-space", userId: "fixture-user" };
const endpoint = "https://mcp.example.test/mcp";
const issuer = "https://auth.example.test/tenant";
const discovery: OAuthDiscoveryState = {
  authorizationServerUrl: issuer,
  authorizationServerMetadata: {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    response_types_supported: ["code"],
  },
};

function fixture(material: OAuthMaterial, fetch?: typeof globalThis.fetch) {
  let seq = 0;
  let transactionDepth = 0;
  const rows = new Map<string, { id: string; ciphertext: string }>();
  const plaintexts = new Map<string, string>();
  const sessions = new Map<string, Record<string, unknown>>();
  const server = {
    id: "fixture-server",
    ...actor,
    endpoint,
    enabled: true,
    revision: 1,
    secretId: null as string | null,
  };
  function replace(value: OAuthMaterial) {
    const record = {
      id: `fixture-secret-${++seq}`,
      ciphertext: `fixture-ref-${seq}`,
    };
    plaintexts.set(record.ciphertext, JSON.stringify(value));
    rows.set(record.id, record);
    server.secretId = record.id;
  }
  replace(material);
  const secrets = {
    load: vi.fn(async (ref: string) => {
      const value = plaintexts.get(ref);
      if (value === undefined) throw new Error("Unknown fixture credential");
      return value;
    }),
    put: vi.fn(async (value: string) => {
      expect(transactionDepth).toBe(0);
      const record = {
        id: `fixture-secret-${++seq}`,
        ciphertext: `fixture-ref-${seq}`,
      };
      plaintexts.set(record.ciphertext, value);
      return record;
    }),
    delete: vi.fn(async (ref: string) => {
      plaintexts.delete(ref);
    }),
  };
  const count = () => ({ count: vi.fn(async () => 0) });
  const prisma = {
    mcpServer: {
      findFirst: vi.fn(async () => ({ ...server })),
      update: vi.fn(
        async ({
          data,
        }: {
          data: { secretId?: string | null; revision?: { increment: number } };
        }) => {
          if (data.secretId !== undefined) server.secretId = data.secretId;
          if (data.revision) server.revision += data.revision.increment;
          return { ...server };
        },
      ),
    },
    secret: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      create: vi.fn(async ({ data }: { data: { id: string; ciphertext: string } }) => {
        rows.set(data.id, { id: data.id, ciphertext: data.ciphertext });
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => ({
        count: Number(rows.delete(where.id)),
      })),
      count: vi.fn(
        async ({ where }: { where: { ciphertext: string } }) =>
          [...rows.values()].filter((row) => row.ciphertext === where.ciphertext).length,
      ),
    },
    botSecret: count(),
    integrationProviderConfig: count(),
    nativeAppConfig: count(),
    deploymentIdentity: count(),
    deploymentTransferSession: count(),
    deploymentTransferItem: count(),
    mcpOAuthSession: {
      count: vi.fn(async () => sessions.size),
      create: vi.fn(async ({ data }: { data: { id: string } }) => {
        sessions.set(data.id, { ...data, createdAt: new Date() });
        return data;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) => sessions.get(where.id) ?? null,
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id?: string } }) => ({
        count: where.id ? Number(sessions.delete(where.id)) : 0,
      })),
    },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      transactionDepth++;
      try {
        return await run(prisma);
      } finally {
        transactionDepth--;
      }
    }),
  };
  const broker = new McpOAuthBroker(prisma as never, secrets as never, {
    fetch,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  return {
    broker,
    server,
    secrets,
    prisma,
    replace,
    provider: async (onPersisted?: () => void) => {
      const provider = await broker.providerFor({ ...server }, actor, undefined, onPersisted);
      if (!provider) throw new Error("Expected fixture OAuth provider");
      return provider;
    },
    current: () =>
      JSON.parse(plaintexts.get(rows.get(server.secretId!)!.ciphertext)!) as OAuthMaterial,
  };
}

function granted(refreshToken?: string): OAuthMaterial {
  return {
    secret: "fixture-static-token",
    oauth: {
      tokens: {
        access_token: "fixture-access-1",
        token_type: "bearer",
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
      },
      clientInformation: {
        client_id: "fixture-client",
        client_secret: "fixture-client-secret",
      },
    },
  };
}

describe("MCP OAuth persistence across SDK callbacks", () => {
  it("persists discovery, client issuer and token issuer as separate callbacks on one provider", async () => {
    const f = fixture({
      oauth: {
        redirectUri: "https://app.example.test/callback",
        codeVerifier: "fixture-verifier",
        clientInformation: { client_id: "fixture-client" },
      },
    });
    const provider = await f.provider();
    const result = await auth(provider, {
      serverUrl: endpoint,
      authorizationCode: "fixture-code",
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes("oauth-protected-resource"))
          return Response.json({
            resource: endpoint,
            authorization_servers: [issuer],
          });
        if (url.includes("oauth-authorization-server"))
          return Response.json(discovery.authorizationServerMetadata);
        if (url === `${issuer}/token`)
          return Response.json({
            access_token: "fixture-access-2",
            token_type: "bearer",
            issuer: "https://untrusted.example.test",
          });
        throw new Error("Unexpected fixture request");
      },
    });
    expect(result).toBe("AUTHORIZED");
    const writes = f.secrets.put.mock.calls.map(([text]) => JSON.parse(text) as OAuthMaterial);
    expect(writes).toHaveLength(3);
    expect(writes[0]?.oauth?.discoveryState?.authorizationServerUrl).toBe(issuer);
    expect(writes[0]?.oauth?.clientInformation?.issuer).toBeUndefined();
    expect(writes[1]?.oauth?.clientInformation?.issuer).toBe(issuer);
    expect(writes[1]?.oauth?.tokens).toBeUndefined();
    expect(f.current().oauth).toMatchObject({
      clientInformation: { issuer },
      tokens: { access_token: "fixture-access-2", issuer },
    });
  });

  it.each([undefined, "fixture-refresh-1"])(
    "rejects old callbacks after another provider updates the grant (refresh: %s)",
    async (refreshToken) => {
      for (const change of ["discovery", "client", "tokens", "invalidate"] as const) {
        const f = fixture(granted(refreshToken));
        const current = await f.provider();
        const stale = await f.provider();
        await current.saveTokens({
          access_token: "fixture-access-2",
          token_type: "bearer",
        });
        const updated = f.current();
        const writes = f.secrets.put.mock.calls.length;
        const action =
          change === "discovery"
            ? stale.saveDiscoveryState!(discovery)
            : change === "client"
              ? stale.saveClientInformation!({ client_id: "stale-client" })
              : change === "tokens"
                ? stale.saveTokens({
                    access_token: "stale-access",
                    token_type: "bearer",
                  })
                : stale.invalidateCredentials!("tokens");
        await expect(action).rejects.toBeInstanceOf(McpReauthorizationRequiredError);
        await expect(stale.tokens()).rejects.toBeInstanceOf(McpReauthorizationRequiredError);
        expect(f.current()).toEqual(updated);
        expect(f.secrets.put).toHaveBeenCalledTimes(writes);
        const fresh = await f.provider();
        await fresh.saveDiscoveryState!(discovery);
        expect(f.current().oauth?.tokens?.access_token).toBe("fixture-access-2");
      }
    },
  );

  it.each([undefined, "fixture-refresh-1"])(
    "does not restore disconnected credentials (refresh: %s)",
    async (refreshToken) => {
      for (const change of ["discovery", "client", "tokens"] as const) {
        const f = fixture(granted(refreshToken));
        const stale = await f.provider();
        await f.broker.disconnect({ serverId: f.server.id, ...actor });
        const action =
          change === "discovery"
            ? stale.saveDiscoveryState!(discovery)
            : change === "client"
              ? stale.saveClientInformation!({
                  client_id: "stale-client",
                  client_secret: "stale-secret",
                })
              : stale.saveTokens({
                  access_token: "stale-access",
                  token_type: "bearer",
                });
        await expect(action).rejects.toBeInstanceOf(McpReauthorizationRequiredError);
        expect(f.current()).toEqual({ secret: "fixture-static-token" });
      }
    },
  );

  it("does not restore a revoked client that has no grant", async () => {
    const f = fixture({
      secret: "fixture-static-token",
      oauth: {
        clientInformation: {
          client_id: "fixture-client",
          client_secret: "fixture-secret",
        },
      },
    });
    const stale = await f.provider();
    await f.broker.disconnect({ serverId: f.server.id, ...actor });
    await expect(
      stale.saveClientInformation!({
        client_id: "fixture-client",
        client_secret: "fixture-secret",
        issuer,
      }),
    ).rejects.toBeInstanceOf(McpReauthorizationRequiredError);
    expect(f.current().oauth).toBeUndefined();
  });

  it("advances explicit disconnect revision when OAuth is already absent", async () => {
    const f = fixture({ secret: "fixture-static-token" });
    const initialRevision = f.server.revision;
    const initialSecretId = f.server.secretId;
    await f.broker.disconnect({ serverId: f.server.id, ...actor });
    expect(f.current()).toEqual({ secret: "fixture-static-token" });
    expect(f.server.revision).toBe(initialRevision + 1);
    expect(f.server.secretId).toBe(initialSecretId);
    expect(f.secrets.put).not.toHaveBeenCalled();
  });

  it.each([
    "empty",
    "malformed",
    "null",
    "primitive",
    "array",
    "provider-missing",
    "generic-failure",
  ] as const)(
    "disconnect removes an empty or unreadable credential reference (%s)",
    async (failure) => {
      const f = fixture({});
      const initialSecretId = f.server.secretId;
      if (failure === "malformed") f.secrets.load.mockResolvedValue("not valid JSON");
      if (failure === "null") f.secrets.load.mockResolvedValue("null");
      if (failure === "primitive") f.secrets.load.mockResolvedValue('"fixture-string"');
      if (failure === "array") f.secrets.load.mockResolvedValue("[]");
      if (failure === "provider-missing")
        f.secrets.load.mockRejectedValue(new SecretNotFoundError());
      if (failure === "generic-failure")
        f.secrets.load.mockRejectedValue(new Error("Fixture decryption failed"));

      await f.broker.disconnect({ serverId: f.server.id, ...actor });

      expect(f.server.secretId).toBeNull();
      expect(f.server.revision).toBe(2);
      expect(f.prisma.secret.deleteMany).toHaveBeenCalledWith({ where: { id: initialSecretId } });
      expect(f.secrets.put).not.toHaveBeenCalled();
    },
  );

  it("keeps disconnect state intact when secret storage is unavailable", async () => {
    const f = fixture(granted("fixture-refresh-1"));
    const initialServer = { ...f.server };
    const unavailable = new SecretStoreUnavailableError(503);
    f.secrets.load.mockRejectedValue(unavailable);

    await expect(f.broker.disconnect({ serverId: f.server.id, ...actor })).rejects.toBe(
      unavailable,
    );

    expect(f.server).toEqual(initialServer);
    expect(f.prisma.secret.deleteMany).not.toHaveBeenCalled();
    expect(f.prisma.mcpServer.update).not.toHaveBeenCalled();
    expect(f.secrets.put).not.toHaveBeenCalled();
  });

  it.each(["tokens", "clientInformation"] as const)(
    "recovers the next explicit SDK authorization after an expired issuer mismatch (%s)",
    async (field) => {
      const material = granted("fixture-refresh-1");
      Object.assign(material.oauth!, {
        obtainedAt: 1,
        redirectUri: "https://app.example.test/callback",
        discoveryState: {
          ...discovery,
          resourceMetadata: { resource: endpoint, authorization_servers: [issuer] },
          authorizationServerMetadata: {
            ...discovery.authorizationServerMetadata,
            registration_endpoint: `${issuer}/register`,
            code_challenge_methods_supported: ["S256"],
          },
        },
      });
      material.oauth!.tokens!.expires_in = 60;
      material.oauth!.tokens!.issuer = issuer;
      material.oauth!.clientInformation!.issuer = issuer;
      material.oauth![field]!.issuer = "https://auth.example.test/other-tenant";
      const calls: { url: string; method: string; body: string }[] = [];
      const f = fixture(material, async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        calls.push({ url: url.href, method: request.method, body: await request.text() });
        if (url.href === endpoint)
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        if (url.pathname.includes("oauth-protected-resource"))
          return Response.json({ resource: endpoint, authorization_servers: [issuer] });
        if (url.pathname.includes("oauth-authorization-server"))
          return Response.json(material.oauth!.discoveryState!.authorizationServerMetadata);
        if (url.href === `${issuer}/register`)
          return Response.json(
            {
              client_id: "fixture-new-client",
              redirect_uris: ["https://app.example.test/callback"],
            },
            { status: 201 },
          );
        if (url.href === `${issuer}/token`)
          return Response.json({
            access_token: "fixture-reauthorized",
            refresh_token: "fixture-refresh-2",
            token_type: "bearer",
            expires_in: 7200,
          });
        throw new Error("Unexpected fixture request");
      });
      await expect(
        f.broker.begin({
          serverId: f.server.id,
          ...actor,
          redirectUri: "https://app.example.test/callback",
        }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
      expect(await f.broker.statusFor({ ...f.server }, actor)).toBe("reconnect");
      expect(f.current().oauth?.tokens).toBeUndefined();

      const next = await f.broker.begin({
        serverId: f.server.id,
        ...actor,
        redirectUri: "https://app.example.test/callback",
      });
      if (next.status !== "authorization_required")
        throw new Error("Expected authorization recovery");
      expect(new URL(next.authorizationUrl).origin).toBe(new URL(issuer).origin);
      expect(new URL(next.authorizationUrl).searchParams.get("client_id")).toBe(
        field === "clientInformation" ? "fixture-new-client" : "fixture-client",
      );
      await f.broker.complete({
        sessionId: next.sessionId,
        state: next.sessionId,
        code: "fixture-new-code",
        ...actor,
      });
      expect(f.current().oauth).toMatchObject({
        tokens: { access_token: "fixture-reauthorized", issuer },
        clientInformation: { issuer },
      });
      expect(await f.broker.statusFor({ ...f.server }, actor)).toBe("connected");
      expect(calls.filter((call) => call.url === `${issuer}/register`)).toHaveLength(
        field === "clientInformation" ? 1 : 0,
      );
      expect(
        calls.some((call) => call.url.startsWith("https://auth.example.test/other-tenant")),
      ).toBe(false);
      expect(calls.filter((call) => call.url === `${issuer}/token`)).toHaveLength(1);
      expect(
        new URLSearchParams(calls.find((call) => call.url === `${issuer}/token`)!.body).get(
          "grant_type",
        ),
      ).toBe("authorization_code");
    },
  );

  it.each(["tokens", "clientInformation"] as const)(
    "does not clear an issuer-mismatched grant while secret storage is unavailable (%s)",
    async (field) => {
      const material = granted("fixture-refresh-1");
      Object.assign(material.oauth!, { obtainedAt: 1, discoveryState: discovery });
      material.oauth!.tokens!.expires_in = 60;
      material.oauth![field]!.issuer = "https://auth.example.test/other-tenant";
      const f = fixture(material);
      const provider = await f.provider();
      const before = f.current();
      const initialServer = { ...f.server };
      const unavailable = new SecretStoreUnavailableError(503);
      f.secrets.load.mockRejectedValueOnce(unavailable);

      await expect(provider.tokens()).rejects.toBe(unavailable);

      expect(f.current()).toEqual(before);
      expect(f.server).toEqual(initialServer);
      expect(f.secrets.put).not.toHaveBeenCalled();
      expect(f.prisma.mcpServer.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["tokens", "new grant"],
    ["tokens", "disconnect"],
    ["clientInformation", "new grant"],
    ["clientInformation", "disconnect"],
  ] as const)(
    "issuer-mismatch cleanup cannot overwrite a concurrent %s / %s",
    async (field, change) => {
      const material = granted("fixture-refresh-1");
      Object.assign(material.oauth!, { obtainedAt: 1, discoveryState: discovery });
      material.oauth!.tokens!.expires_in = 60;
      material.oauth![field]!.issuer = "https://auth.example.test/other-tenant";
      const f = fixture(material);
      const provider = await f.provider();
      let prepared!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        prepared = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const put = f.secrets.put.getMockImplementation()!;
      f.secrets.put.mockImplementationOnce(async (text) => {
        const record = await put(text);
        prepared();
        await gate;
        return record;
      });
      const clearing = Promise.allSettled([provider.tokens()]);
      await ready;
      if (change === "disconnect") await f.broker.disconnect({ serverId: f.server.id, ...actor });
      else {
        const peer = await f.provider();
        await peer.saveClientInformation!({ client_id: "fixture-new-client", issuer });
        await peer.saveTokens({
          access_token: "fixture-access-2",
          refresh_token: "fixture-refresh-2",
          token_type: "bearer",
          issuer,
        });
      }
      const updated = f.current();
      release();
      const results = await clearing;
      expect(results[0]).toMatchObject({
        status: "rejected",
        reason: expect.any(McpReauthorizationRequiredError),
      });
      expect(f.current()).toEqual(updated);
      expect(f.secrets.put).toHaveBeenCalledTimes(change === "disconnect" ? 2 : 3);
    },
  );

  it("fences a first sign-in paused before discovery when disconnected", async () => {
    let ready!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let registrations = 0;
    const f = fixture({ secret: "fixture-static-token" }, async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.href === endpoint) {
        ready();
        await gate;
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }
      if (url.pathname.includes("oauth-protected-resource"))
        return Response.json({ resource: endpoint, authorization_servers: [issuer] });
      if (url.pathname.includes("oauth-authorization-server"))
        return Response.json({
          ...discovery.authorizationServerMetadata,
          registration_endpoint: `${issuer}/register`,
          code_challenge_methods_supported: ["S256"],
        });
      if (url.href === `${issuer}/register`) {
        registrations++;
        return Response.json(
          {
            client_id: "fixture-client",
            redirect_uris: ["https://app.example.test/callback"],
          },
          { status: 201 },
        );
      }
      throw new Error("Unexpected fixture request");
    });
    const completion = Promise.allSettled([
      f.broker.begin({
        serverId: f.server.id,
        ...actor,
        redirectUri: "https://app.example.test/callback",
      }),
    ]);
    await waiting;
    try {
      await f.broker.disconnect({ serverId: f.server.id, ...actor });
    } finally {
      release();
    }
    const result = await completion;
    expect(result[0]?.status).toBe("rejected");
    expect(registrations).toBe(0);
    expect(f.current().oauth).toBeUndefined();
  });

  it("allows a fresh explicit authorization after disconnect", async () => {
    const f = fixture(granted(), async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.href === endpoint)
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      if (url.pathname.includes("oauth-protected-resource"))
        return Response.json({
          resource: endpoint,
          authorization_servers: [issuer],
        });
      if (url.pathname.includes("oauth-authorization-server"))
        return Response.json({
          ...discovery.authorizationServerMetadata,
          registration_endpoint: `${issuer}/register`,
          code_challenge_methods_supported: ["S256"],
        });
      if (url.href === `${issuer}/register`)
        return Response.json(
          {
            client_id: "fixture-new-client",
            redirect_uris: ["https://app.example.test/callback"],
          },
          { status: 201 },
        );
      if (url.href === `${issuer}/token`)
        return Response.json({
          access_token: "fixture-reauthorized",
          token_type: "bearer",
        });
      throw new Error("Unexpected fixture request");
    });
    await f.broker.disconnect({ serverId: f.server.id, ...actor });
    const started = await f.broker.begin({
      serverId: f.server.id,
      ...actor,
      redirectUri: "https://app.example.test/callback",
    });
    if (started.status !== "authorization_required")
      throw new Error("Expected a new authorization");
    await f.broker.complete({
      sessionId: started.sessionId,
      state: started.sessionId,
      code: "fixture-new-code",
      ...actor,
    });
    expect(f.current().oauth).toMatchObject({
      clientInformation: { client_id: "fixture-new-client", issuer },
      tokens: { access_token: "fixture-reauthorized", issuer },
    });
  });

  it("merges a concurrent static credential edit without losing headers or OAuth changes", async () => {
    const initial = granted();
    const f = fixture(initial);
    const provider = await f.provider();
    f.replace({
      ...initial,
      secret: "fixture-new-static",
      headers: { "X-Fixture": "fixture-header" },
    });
    await provider.saveTokens({
      access_token: "fixture-access-2",
      token_type: "bearer",
    });
    expect(f.current()).toMatchObject({
      secret: "fixture-new-static",
      headers: { "X-Fixture": "fixture-header" },
      oauth: { tokens: { access_token: "fixture-access-2" } },
    });
  });

  it("adopts an already committed identical metadata intent without another provider write", async () => {
    const f = fixture(granted());
    const first = await f.provider();
    const duplicate = await f.provider();
    await first.saveDiscoveryState!(discovery);
    const writes = f.secrets.put.mock.calls.length;
    await duplicate.saveDiscoveryState!(discovery);
    expect(f.secrets.put).toHaveBeenCalledTimes(writes);
    await duplicate.saveTokens({
      access_token: "fixture-access-2",
      token_type: "bearer",
    });
    expect(f.current().oauth?.tokens?.access_token).toBe("fixture-access-2");
  });

  it("continues the same grant intent after an issuer-binding acknowledgement is lost", async () => {
    const f = fixture({
      oauth: { discoveryState: discovery, clientInformation: { client_id: "fixture-client" } },
    });
    const acknowledged = vi.fn().mockImplementationOnce(() => {
      throw new Error("Fixture acknowledgement lost");
    });
    const provider = await f.provider(acknowledged);
    await expect(
      provider.saveClientInformation!({ client_id: "fixture-client", issuer }),
    ).rejects.toThrow("acknowledgement lost");
    expect(f.current().oauth?.clientInformation?.issuer).toBe(issuer);
    await provider.saveTokens({ access_token: "fixture-access-2", token_type: "bearer", issuer });
    expect(f.current().oauth?.tokens?.access_token).toBe("fixture-access-2");
    expect(acknowledged).toHaveBeenCalledTimes(2);
  });

  it.each(["revision", "disabled"])(
    "rejects a provider after the server's %s changes",
    async (change) => {
      const f = fixture(granted());
      const provider = await f.provider();
      if (change === "revision") f.server.revision++;
      else f.server.enabled = false;
      await expect(provider.saveDiscoveryState!(discovery)).rejects.toBeInstanceOf(
        McpReauthorizationRequiredError,
      );
      expect(f.secrets.put).not.toHaveBeenCalled();
    },
  );

  it("does not rebase a prepared token write after a concurrent disconnect and compensates its known ref", async () => {
    const f = fixture(granted());
    const provider = await f.provider();
    let release!: () => void;
    let prepared!: () => void;
    const ready = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = f.secrets.put.getMockImplementation()!;
    let lateRef: string | undefined;
    f.secrets.put.mockImplementationOnce(async (text) => {
      const result = await put(text);
      lateRef = result.ciphertext;
      prepared();
      await gate;
      return result;
    });
    const saving = provider.saveTokens({
      access_token: "late-access",
      token_type: "bearer",
    });
    await ready;
    await f.broker.disconnect({ serverId: f.server.id, ...actor });
    release();
    await expect(saving).rejects.toBeInstanceOf(McpReauthorizationRequiredError);
    expect(f.current().oauth).toBeUndefined();
    expect(f.secrets.delete.mock.calls.some(([ref]) => ref === lateRef)).toBe(true);
    expect(f.secrets.put).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["disconnect", false],
    ["disconnect", true],
    ["new grant", false],
    ["new grant", true],
  ] as const)(
    "rejects a late refresh after %s (invalid_grant: %s)",
    async (change, invalidGrant) => {
      let requested!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const initial = granted("fixture-refresh-1");
      Object.assign(initial.oauth!, { discoveryState: discovery, obtainedAt: 1 });
      initial.oauth!.tokens!.expires_in = 60;
      const f = fixture(initial, async () => {
        requested();
        await gate;
        return invalidGrant
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : Response.json({
              access_token: "late-access",
              refresh_token: "late-refresh",
              token_type: "bearer",
            });
      });
      const provider = await f.provider();
      const refreshing = provider.tokens();
      await ready;
      if (change === "disconnect") await f.broker.disconnect({ serverId: f.server.id, ...actor });
      else {
        const peer = await f.provider();
        await peer.saveTokens({
          access_token: "fixture-access-2",
          refresh_token: "fixture-refresh-2",
          token_type: "bearer",
          issuer,
        });
      }
      const updated = f.current();
      release();
      await expect(refreshing).rejects.toBeInstanceOf(McpReauthorizationRequiredError);
      expect(f.current()).toEqual(updated);
    },
  );
});
