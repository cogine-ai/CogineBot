import { createHash } from "node:crypto";
import type { AdapterContext, ArtifactStore, ConnectedConnector } from "@rakazo/adapter-kit";
import type { NativeAppConfig, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import type { NativeAuthorization } from "./authorities.js";
import { assertNativeXContext, NATIVE_X_TOOLS, NativeMcpProtocol } from "./mcp.js";
import { NativeConnectorProvider } from "./provider.js";

const base = "https://mcp.example.test";
const endpoint = `${base}/mcp`;
const config = (): NativeAppConfig => ({
  id: "source-a",
  appId: "coginex",
  label: "X fixture",
  ownership: "byo",
  enabled: true,
  revision: 1,
  credentialKind: "mcp_oauth",
  callbackUri: "https://bot.example.test/api/connectors/oauth/callback",
  secretRecordId: null,
  ciphertext: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  config: { endpoint, scopes: ["mcp"], capabilities: [], knowledgeBaseIds: [] },
});
const context = () => ({
  schemaVersion: 2,
  resource: endpoint,
  accountIssuer: "https://account.example.test",
  accountSubject: "11111111-1111-4111-8111-111111111111",
  principal: "fixture-principal",
  organizationId: 42,
  teamContext: {
    state: "available",
    teamId: "22222222-2222-4222-8222-222222222222",
  },
});
const signal = () => new AbortController().signal;
function setup(
  options: {
    resource?: string;
    authority?: string;
    issuer?: string;
    context?: unknown;
    refresh?: Response;
    exchange?: Response;
    rejectOnce?: boolean;
  } = {},
) {
  const calls: {
    url: string;
    method: string;
    headers: Headers;
    body: Record<string, unknown> | null;
  }[] = [];
  let firstBusiness = true;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    const text = request.method === "POST" ? await request.text() : "";
    const body =
      text && request.headers.get("content-type")?.includes("json")
        ? (JSON.parse(text) as Record<string, unknown>)
        : null;
    calls.push({
      url: url.toString(),
      method: request.method,
      headers: request.headers,
      body,
    });
    if (url.pathname.includes(".well-known/oauth-protected-resource"))
      return Response.json({
        resource: options.resource ?? endpoint,
        authorization_servers: [options.authority ?? base],
        scopes_supported: ["mcp"],
      });
    if (url.pathname.includes(".well-known/oauth-authorization-server"))
      return Response.json({
        issuer: options.issuer ?? base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/register")
      return Response.json({ client_id: "fixture-public-client", ...body });
    if (url.pathname === "/token") {
      const params = new URLSearchParams(text);
      if (params.get("grant_type") === "authorization_code" && options.exchange)
        return options.exchange.clone();
      if (params.get("grant_type") === "refresh_token" && options.refresh) return options.refresh;
      return Response.json({
        access_token: params.get("grant_type") === "refresh_token" ? "access-2" : "access-1",
        refresh_token: params.get("grant_type") === "refresh_token" ? "refresh-2" : "refresh-1",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "mcp",
      });
    }
    if (url.pathname === "/mcp") {
      if (body?.method === "initialize")
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
        });
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body?.method === "tools/call") {
        const params = body.params as Record<string, unknown>;
        if (params.name !== "GetXConnectionContext" && options.rejectOnce && firstBusiness) {
          firstBusiness = false;
          return new Response(null, { status: 401 });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [],
            structuredContent:
              params.name === "GetXConnectionContext"
                ? (options.context ?? context())
                : { items: [], hasMore: false },
            isError: false,
          },
        });
      }
      return new Response(null, { status: 202 });
    }
    return new Response(null, { status: 404 });
  });
  const protocol = new NativeMcpProtocol({
    fetch,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  return { protocol, calls, fetch };
}
async function connected(protocol: NativeMcpProtocol) {
  const pending = await protocol.begin(config(), "fixture-state", signal());
  const auth = await protocol.exchange(
    config(),
    pending,
    "fixture-code",
    "fixture-state",
    signal(),
  );
  return { pending, auth };
}
describe("native CogineX detached MCP authorization", () => {
  it("uses existing SDK DCR/S256, persists opaque grant material and trusts authenticated v2 identity", async () => {
    const { protocol, calls } = setup();
    const { pending, auth } = await connected(protocol);
    const url = new URL(pending.authorizationUrl);
    expect(url.searchParams.get("state")).toBe("fixture-state");
    expect(url.searchParams.get("scope")).toBe("mcp");
    expect(url.searchParams.get("resource")).toBe(endpoint);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(pending.material.oauth!.codeVerifier!).digest("base64url"),
    );
    const register = calls.find((call) => call.url.endsWith("/register"))!;
    expect(register.body).toMatchObject({
      client_name: "CogineBot",
      token_endpoint_auth_method: "none",
      scope: "mcp",
      redirect_uris: [config().callbackUri],
    });
    expect(auth.identity).toMatchObject({
      authority: base,
      subject: context().accountSubject,
      tenant: "42",
      context: {
        xConnectionContext: context(),
        allowedEntityTypes: ["document"],
      },
    });
    expect(auth.tokens).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
    expect(auth.tokens.mcp?.oauth?.codeVerifier).toBeUndefined();
  });
  it("rejects a different advertised resource before registration", async () => {
    const { protocol, calls } = setup({ resource: `${base}/other` });
    await expect(protocol.begin(config(), "state", signal())).rejects.toMatchObject({
      kind: "authorization_required",
    });
    expect(calls.some((call) => call.url.endsWith("/register"))).toBe(false);
  });
  it("never sends discovery/registration/token traffic to a different authority", async () => {
    const { protocol, calls } = setup({
      authority: "https://attacker.example.test",
    });
    await expect(protocol.begin(config(), "state", signal())).rejects.toBeInstanceOf(Error);
    expect(calls.every((call) => new URL(call.url).origin === base)).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/register"))).toBe(false);
  });
  it("does not confuse account issuer with the MCP authorization-server issuer", async () => {
    const { protocol } = setup();
    const { auth } = await connected(protocol);
    expect(auth.identity.authority).not.toBe(context().accountIssuer);
    expect(auth.identity.context.xConnectionContext).toMatchObject({
      accountIssuer: context().accountIssuer,
    });
  });
  it("requires the complete authenticated v2 identity and an available Team fact", async () => {
    for (const value of [
      { ...context(), schemaVersion: 1 },
      { ...context(), accountSubject: "email@example.test" },
      { ...context(), resource: `${base}/other` },
      { ...context(), teamContext: { state: "temporarilyUnavailable" } },
    ]) {
      const { protocol } = setup({ context: value });
      await expect(connected(protocol)).rejects.toBeInstanceOf(Error);
    }
  });
  it("renews only through explicit refresh protocol; successor pair keeps identity fixed", async () => {
    const { protocol, calls } = setup();
    const { auth } = await connected(protocol);
    const next = await protocol.refresh(config(), auth, signal());
    expect(next.tokens).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
    expect(next.identity).toEqual(auth.identity);
    expect(calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(2);
  });
  it("does not retain an old rotating token when the successor response omits it", async () => {
    const { protocol } = setup({
      refresh: Response.json({
        access_token: "access-2",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "mcp",
      }),
    });
    const { auth } = await connected(protocol);
    await expect(protocol.refresh(config(), auth, signal())).rejects.toMatchObject({
      options: { uncertain: true },
    });
  });
  it("marks an unknown rotating response uncertain and a definite invalid grant expired", async () => {
    for (const [response, expected] of [
      [
        new Response(null, { status: 503 }),
        { kind: "temporarily_unavailable", options: { uncertain: true } },
      ],
      [
        Response.json({ error: "invalid_grant" }, { status: 400 }),
        { kind: "authorization_expired" },
      ],
    ] as const) {
      const { protocol } = setup({ refresh: response });
      const { auth } = await connected(protocol);
      await expect(protocol.refresh(config(), auth, signal())).rejects.toMatchObject(expected);
    }
  });
  it("allows exactly the 13 business tools; never exposes identity or execution tools", async () => {
    const { protocol, fetch } = setup();
    const load = vi.fn<() => Promise<NativeAuthorization>>();
    for (const tool of ["Subagent", "GetXConnectionContext", "tools/list", "ExecuteCode"])
      await expect(protocol.call(config(), load, tool, {}, signal())).rejects.toMatchObject({
        kind: "invalid_input",
      });
    expect(NATIVE_X_TOOLS.size).toBe(13);
    expect(fetch).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
  it("rechecks exact context before a business call and never executes after a changed Team", async () => {
    const good = setup();
    const { auth } = await connected(good.protocol);
    const changed = setup({
      context: { ...context(), teamContext: { state: "none" } },
    });
    await expect(
      changed.protocol.call(config(), async () => auth, "ListEntities", {}, signal()),
    ).rejects.toMatchObject({ kind: "authorization_expired" });
    expect(
      changed.calls.some(
        (call) =>
          (call.body?.params as Record<string, unknown> | undefined)?.name === "ListEntities",
      ),
    ).toBe(false);
  });
  it("a definitive 401 refreshes only the rejected request with the DB-authorized successor", async () => {
    const good = setup();
    const { auth } = await connected(good.protocol);
    const { protocol, calls } = setup({ rejectOnce: true });
    let current = auth;
    const load = vi.fn(async (force?: boolean) => {
      if (force)
        current = {
          ...auth,
          tokens: { ...auth.tokens, accessToken: "access-2" },
        };
      return current;
    });
    await expect(protocol.call(config(), load, "ListEntities", {}, signal())).resolves.toEqual({
      items: [],
      hasMore: false,
    });
    const callsToTool = calls.filter(
      (call) => (call.body?.params as Record<string, unknown> | undefined)?.name === "ListEntities",
    );
    expect(callsToTool).toHaveLength(2);
    expect(callsToTool.map((call) => call.headers.get("Authorization"))).toEqual([
      "Bearer access-1",
      "Bearer access-2",
    ]);
    expect(load.mock.calls.filter(([force]) => force)).toHaveLength(1);
    expect(calls.some((call) => call.url.endsWith("/token"))).toBe(false);
  });
  it("does not reuse an account if issuer, subject, organization, principal or Team changes", () => {
    for (const value of [
      { ...context(), accountIssuer: "other.example.test" },
      { ...context(), accountSubject: "33333333-3333-4333-8333-333333333333" },
      { ...context(), organizationId: 99 },
      { ...context(), principal: "other" },
      { ...context(), teamContext: { state: "none" } },
    ])
      expect(() => assertNativeXContext(value, endpoint, context())).toThrow();
  });
});

it("rejects changed saved authorization parameters before exchanging a code", async () => {
  const { protocol, calls } = setup();
  const pending = await protocol.begin(config(), "fixture-state", signal());
  for (const [key, value] of [
    ["state", "other-state"],
    ["client_id", "other-client"],
    ["redirect_uri", "https://attacker.example.test/callback"],
    ["resource", `${base}/other`],
    ["scope", "mcp extra"],
    ["code_challenge", "other-challenge"],
  ]) {
    const url = new URL(pending.authorizationUrl);
    url.searchParams.set(key!, value!);
    await expect(
      protocol.exchange(
        config(),
        { ...pending, authorizationUrl: url.toString() },
        "code",
        "fixture-state",
        signal(),
      ),
    ).rejects.toMatchObject({ kind: "authorization_required" });
  }
  expect(calls.some((call) => call.url.endsWith("/token"))).toBe(false);
});

it("requires account reauthorization for a lost DCR client and keeps rate limits separate", async () => {
  for (const [response, expected] of [
    [
      Response.json({ error: "invalid_client" }, { status: 401 }),
      { kind: "authorization_expired" },
    ],
    [
      new Response("limited", { status: 429, headers: { "Retry-After": "3600" } }),
      { kind: "rate_limited", options: { retryAfterSeconds: 3600 } },
    ],
  ] as const) {
    const { protocol } = setup({ refresh: response });
    const { auth } = await connected(protocol);
    await expect(protocol.refresh(config(), auth, signal())).rejects.toMatchObject(expected);
  }
});

it("closes repeatedly and rejects new operations before any fetch", async () => {
  const { protocol, fetch } = setup();
  await protocol.close();
  await protocol.close();
  await expect(protocol.begin(config(), "state", signal())).rejects.toMatchObject({
    kind: "temporarily_unavailable",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("never exchanges the same authorization code twice after a definite invalid_grant", async () => {
  const { protocol, calls } = setup({
    exchange: Response.json({ error: "invalid_grant" }, { status: 400 }),
  });
  const pending = await protocol.begin(config(), "fixture-state", signal());
  await expect(
    protocol.exchange(config(), pending, "rejected-code", "fixture-state", signal()),
  ).rejects.toMatchObject({ kind: "authorization_required" });
  expect(calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(1);
  await protocol.close();
});

it("composes exactly the native X actions and executes the selected account through bound MCP", async () => {
  const good = setup();
  const { auth } = await connected(good.protocol);
  const runtime = setup();
  const selected: ConnectedConnector = {
    id: "connection-a",
    connectorId: "native",
    externalId: "coginex",
    displayName: "Fixture X",
    providerRef: "grant-a",
    revision: "grant-a:1",
  };
  const actor: AdapterContext = {
    userId: "user-a",
    spaceId: "space-a",
    operationId: "native.test",
    traceId: "native.test",
    signal: signal(),
    connectedConnections: [selected],
  };
  const provider = new NativeConnectorProvider(
    {} as PrismaClient,
    new EncryptedSecretStore("fixture-master"),
    "https://bot.example.test",
    {
      artifacts: {} as ArtifactStore,
      network: {
        fetch: runtime.fetch,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      },
    },
  );
  vi.spyOn(provider.oauth, "authorization").mockResolvedValue({
    connection: {
      id: selected.id,
      provider: "coginex",
      providerRef: "grant-a",
      displayName: "Fixture X",
      metadata: { authRevision: "grant-a:1" },
    },
    config: config(),
    grant: {
      scopes: ["mcp"],
      subject: auth.identity.subject,
      tenant: auth.identity.tenant,
      tokenVersion: 1,
    },
    auth,
  } as never);
  try {
    const tools = await provider.discoverTools(actor);
    expect(tools).toHaveLength(12);
    expect(tools.every((tool) => tool.route?.connectionId === selected.id)).toBe(true);
    const tool = tools.find((tool) => tool.route?.toolName === "coginex.entities.list")!;
    const result = [];
    for await (const event of provider.execute(
      {
        tool: tool.name,
        route: tool.route,
        args: { includeTypes: ["document"] },
        executionId: "stable-effect",
      },
      actor,
    ))
      result.push(event);
    expect(result.at(-1)).toMatchObject({ type: "result", data: { items: [], hasMore: false } });
    const business = runtime.calls.filter(
      (call) => (call.body?.params as Record<string, unknown> | undefined)?.name === "ListEntities",
    );
    expect(business).toHaveLength(1);
    expect(business[0]?.headers.get("Authorization")).toBe("Bearer access-1");
    expect(
      runtime.calls.some(
        (call) => (call.body?.params as Record<string, unknown> | undefined)?.name === "Subagent",
      ),
    ).toBe(false);
  } finally {
    await provider.close();
    await good.protocol.close();
    await runtime.protocol.close();
  }
});
