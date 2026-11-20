import { getLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { McpOAuthBroker } from "./mcp-oauth.js";
import { EncryptedSecretStore } from "./secrets.js";

const scope = { userId: "fixture-owner", spaceId: "fixture-space" };
const client = {
  authorizationServer: "https://login.example.test",
  clientId: "fixture-client",
  clientSecret: "fixture-client-secret",
  scope: "offline_access read",
  authorizationParams: "access_type=offline&prompt=consent",
};
const redirectUri = "https://app.example.test/mcp/oauth/callback";

async function fixture({
  metadataIssuer = client.authorizationServer,
  rejectGrant = false,
  tokenEndpoint = `${client.authorizationServer}/token`,
} = {}) {
  const store = new EncryptedSecretStore("fixture-stdio-encryption-key");
  const stored = await store.put(JSON.stringify({ oauthClient: client }), {
    ...scope,
    operationId: "fixture",
    traceId: "fixture",
    signal: new AbortController().signal,
  });
  const server = {
    ...scope,
    id: "fixture-server",
    transport: "stdio",
    command: "fixture-mcp",
    endpoint: null,
    enabled: true,
    secretId: stored.id,
    revision: 1,
  };
  const secretRows = new Map([[stored.id, stored]]);
  type Session = typeof scope & {
    id: string;
    serverId: string;
    endpoint: string;
    redirectUri: string;
    oauthCiphertext: string;
    createdAt: Date;
  };
  const pending = new Map<string, Session>();
  let deploymentOwner = scope.userId;
  const prisma = {
    deploymentSettings: { findUnique: async () => ({ ownerUserId: deploymentOwner }) },
    mcpServer: {
      findFirst: async ({ where }: { where: Partial<typeof server> }) =>
        Object.entries(where).every(([key, value]) => Reflect.get(server, key) === value)
          ? { ...server }
          : null,
      update: async ({
        data,
      }: {
        data: { secretId: string; revision?: { increment: number } };
      }) => {
        server.secretId = data.secretId;
        server.revision += data.revision?.increment ?? 0;
        return { ...server };
      },
    },
    mcpOAuthSession: {
      count: async () => pending.size,
      create: async ({ data }: { data: Omit<Session, "createdAt"> }) => {
        pending.set(data.id, { ...data, createdAt: new Date() });
      },
      findFirst: async ({
        where,
      }: {
        where: typeof scope & { id: string; createdAt: { gte: Date } };
      }) => {
        const session = pending.get(where.id);
        return session?.userId === where.userId &&
          session.spaceId === where.spaceId &&
          session.createdAt >= where.createdAt.gte
          ? session
          : null;
      },
      deleteMany: async ({ where }: { where: { id?: string; createdAt?: { lt: Date } } }) => {
        if (where.id) return { count: pending.delete(where.id) ? 1 : 0 };
        for (const [id, session] of pending) {
          if (where.createdAt && session.createdAt < where.createdAt.lt) pending.delete(id);
        }
        return { count: 0 };
      },
    },
    secret: {
      findFirst: async ({ where }: { where: { id: string } }) => secretRows.get(where.id) ?? null,
      create: async ({ data }: { data: typeof stored }) => secretRows.set(data.id, data),
      deleteMany: async ({ where }: { where: { id: string } }) => secretRows.delete(where.id),
      count: async () => 1,
    },
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
    $transaction: async (effect: (tx: unknown) => Promise<unknown>) => effect(prisma),
  };
  const exchange = vi.fn(async (request: Request) => {
    const body = new URLSearchParams(await request.text());
    expect(body.get("code")).toBe("fixture-code");
    expect(/^[A-Za-z0-9._~-]{43,128}$/.test(body.get("code_verifier") ?? "")).toBe(true);
    expect(body.get("redirect_uri")).toBe(redirectUri);
    expect(body.get("client_secret")).toBe(client.clientSecret);
    expect(body.has("resource")).toBe(false);
    if (rejectGrant) {
      return Response.json(
        {
          error: "invalid_grant",
          error_description: `Rejected ${body.get("code")}, verifier ${body.get("code_verifier")}, client ${body.get("client_secret")}`,
        },
        { status: 400 },
      );
    }
    return Response.json({
      access_token: "fixture-access",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: metadataIssuer,
        authorization_endpoint: `${client.authorizationServer}/authorize`,
        token_endpoint: tokenEndpoint,
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (path === "/token") return exchange(request);
    throw new Error("Unexpected request in the stdio OAuth fixture");
  };
  const newBroker = (enabled = true) =>
    new McpOAuthBroker(
      prisma as never,
      store,
      {
        fetch: fetcher,
        resolveHostname: async (name) => [
          { address: name === "private.example.test" ? "10.0.0.8" : "203.0.113.10", family: 4 },
        ],
      },
      false,
      { enabled, allowedCommands: ["fixture-mcp"] },
    );
  const broker = newBroker();
  const begin = async () => {
    const result = await broker.begin({ ...scope, serverId: server.id, redirectUri });
    if (result.status !== "authorization_required")
      throw new Error("Expected OAuth authorization URL");
    return result;
  };
  const complete = (sessionId: string, broker = newBroker(), actor = scope) =>
    broker.complete({ ...actor, sessionId, state: sessionId, code: "fixture-code" });
  return {
    begin,
    complete,
    exchange,
    pending,
    server,
    broker,
    newBroker,
    changeDeploymentOwner: () => {
      deploymentOwner = "another-fixture-owner";
    },
  };
}

describe("deployment-managed stdio OAuth", () => {
  it("exchanges the declared client once across brokers and persists its bound grant", async () => {
    const f = await fixture();
    const started = await f.begin();
    const url = new URL(started.authorizationUrl);
    expect(url.origin).toBe(client.authorizationServer);
    expect(url.searchParams.get("state")).toBe(started.sessionId);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(client.scope);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.getAll("prompt")).toEqual(["consent"]);
    expect(started.authorizationUrl).not.toContain(client.clientSecret);
    const results = await Promise.allSettled([
      f.complete(started.sessionId),
      f.complete(started.sessionId),
    ]);
    expect(
      results.map((result) => (result.status === "fulfilled" ? "granted" : String(result.reason))),
    ).toEqual(
      expect.arrayContaining([
        "granted",
        expect.stringMatching(/MCP OAuth session is invalid or expired/),
      ]),
    );
    expect(f.exchange).toHaveBeenCalledOnce();
    expect(f.pending.size).toBe(0);
    expect(f.server.revision).toBe(2);
    expect(await f.newBroker().statusFor(f.server, scope)).toBe("connected");
    const provider = await f.newBroker().providerFor(f.server, scope);
    expect(await provider?.tokens()).toMatchObject({
      access_token: "fixture-access",
      issuer: `${client.authorizationServer}/`,
    });
  });

  it("refuses a token endpoint that resolves to a private address before returning a login URL", async () => {
    const f = await fixture({ tokenEndpoint: "https://private.example.test/token" });
    await expect(f.begin()).rejects.toThrow(/Could not start MCP OAuth/);
    expect(f.pending.size).toBe(0);
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it("rejects a different Space, changed revision, or withdrawn deployment ownership before exchange", async () => {
    const f = await fixture();
    const { sessionId } = await f.begin();
    await expect(
      f.complete(sessionId, f.newBroker(), { ...scope, spaceId: "foreign-space" }),
    ).rejects.toThrow(/invalid or expired/);
    await expect(f.complete(sessionId, f.newBroker(false))).rejects.toThrow(/stdio is disabled/);
    f.server.revision++;
    await expect(f.complete(sessionId)).rejects.toThrow(/invalid or expired/);
    f.changeDeploymentOwner();
    await expect(f.complete(sessionId)).rejects.toThrow(/deployment owner/);
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it("refuses issuer metadata that identifies a different authorization server", async () => {
    const f = await fixture({ metadataIssuer: "https://different.example.test" });
    await expect(f.begin()).rejects.toThrow(/Could not start MCP OAuth/);
    expect(f.pending.size).toBe(0);
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it("redacts echoed exchange credentials from both the error and diagnostic log", async () => {
    const f = await fixture({ rejectGrant: true });
    const { sessionId } = await f.begin();
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
    try {
      await expect(f.complete(sessionId)).rejects.toThrow(
        /Rejected \[redacted\], verifier \[redacted\], client \[redacted\]/,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Rejected [redacted], verifier [redacted], client [redacted]"),
      );
      expect(f.pending.size).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
