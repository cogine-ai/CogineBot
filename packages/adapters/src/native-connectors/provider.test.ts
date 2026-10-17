import type { AdapterContext, ArtifactStore, ConnectedConnector } from "@rakazo/adapter-kit";
import type { NativeAppConfig, PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import { NativeActionError } from "./action.js";
import { CALENDAR_SCOPES } from "./config.js";
import type { NativeOAuthStore } from "./oauth.js";
import { NativeConnectorProvider } from "./provider.js";

const selected: ConnectedConnector = {
  id: "connection-a",
  connectorId: "native",
  externalId: "google-calendar",
  displayName: "Fixture",
  providerRef: "grant-a",
  revision: "grant-a:1",
};
const context: AdapterContext = {
  userId: "user-a",
  spaceId: "space-a",
  botId: "bot-a",
  operationId: "trace-a",
  traceId: "trace-a",
  signal: new AbortController().signal,
  connectedConnections: [selected],
};
const configs = (appId = "google-calendar"): NativeAppConfig => ({
  id: "config-a",
  appId,
  label: "Fixture source",
  credentialKind: appId === "knowai" ? "machine_key" : "oauth",
  ownership: "byo",
  enabled: true,
  revision: 1,
  callbackUri: "https://api.example.test/api/connectors/oauth/callback",
  ciphertext: "opaque",
  secretRecordId: "app-material",
  createdAt: new Date(),
  updatedAt: new Date(),
  config: {
    endpoint: "https://knowai.example.test",
    tenantId: "42",
    capabilities: ["retrieve", "ingest", "chat"],
    knowledgeBaseIds: ["kb-a"],
    scopes: [...CALENDAR_SCOPES],
    clientId: "fake-client",
  },
});
const live = () =>
  ({
    connection: {
      id: selected.id,
      provider: selected.externalId,
      providerRef: selected.providerRef,
      displayName: selected.displayName,
      metadata: { authRevision: selected.revision },
    },
    config: configs(),
    grant: {
      id: "grant-a",
      scopes: [...CALENDAR_SCOPES],
      tokenVersion: 1,
      subject: "google-sub-a",
      tenant: null,
    },
    auth: {
      tokens: { accessToken: "fake-access", refreshToken: "fake-refresh" },
      identity: { context: {} },
    },
  }) as unknown as Awaited<ReturnType<NativeOAuthStore["authorization"]>>;
const providers: NativeConnectorProvider[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
});
function setup(body: unknown = { items: [] }) {
  const fetch = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body)),
  );
  const artifacts = { get: vi.fn() } as unknown as ArtifactStore;
  const provider = new NativeConnectorProvider(
    {} as PrismaClient,
    new EncryptedSecretStore("fixture-key"),
    "https://api.example.test",
    {
      artifacts,
      network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    },
  );
  providers.push(provider);
  const authorization = vi
    .spyOn(provider.oauth, "authorization")
    .mockImplementation(async () => live());
  return { provider, fetch, authorization };
}
describe("native provider composition", () => {
  it("reports the provider Retry-After to callers without replaying a rate-limited request", async () => {
    const { provider, fetch } = setup();
    fetch.mockImplementation(
      async () =>
        new Response("<html>rate limited</html>", {
          status: 429,
          headers: { "retry-after": "3600" },
        }),
    );
    const tool = (await provider.discoverTools(context)).find(
      (entry) => entry.route?.toolName === "calendar.calendars.list",
    )!;
    const events = await collect(
      provider.execute(
        { tool: tool.name, route: tool.route, args: {}, executionId: "rate-limit-effect" },
        context,
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "rate_limited",
      message: expect.stringContaining("Service backoff: 3600 seconds"),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("executes Calendar through the full fixed API prefix and current account token", async () => {
    const { provider, fetch } = setup();
    const tools = await provider.discoverTools(context);
    expect(tools).toHaveLength(12);
    const tool = tools.find((tool) => tool.route?.toolName === "calendar.calendars.list")!;
    const events = await collect(
      provider.execute(
        { tool: tool.name, route: tool.route, args: {}, executionId: "stable-effect" },
        context,
      ),
    );
    expect(events.at(-1)?.type).toBe("result");
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).origin + new URL(String(url)).pathname).toBe(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-access");
  });
  it("rejects caller credential fields before outbound execution", async () => {
    const { provider, fetch } = setup();
    const tools = await provider.discoverTools(context);
    const tool = tools.find((tool) => tool.route?.toolName === "calendar.calendars.list")!;
    const events = await collect(
      provider.execute(
        {
          tool: tool.name,
          route: tool.route,
          args: { access_token: "model-token" },
          executionId: "effect",
        },
        context,
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not silently discover or execute a sibling account", async () => {
    const { provider, authorization, fetch } = setup();
    const tools = await provider.discoverTools(context);
    const tool = tools[0]!;
    authorization.mockRejectedValue(
      new NativeActionError("authorization_expired", "Reconnect this account."),
    );
    expect(await provider.discoverTools(context)).toEqual([]);
    const events = await collect(
      provider.execute(
        { tool: tool.name, route: tool.route, args: {}, executionId: "effect" },
        context,
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", code: "authorization_expired" });
    expect(fetch).not.toHaveBeenCalled();
    expect(authorization.mock.calls.every(([id]) => id === selected.id)).toBe(true);
  });
  it("verifies Knowai active tenant with the actual machine key and keeps upstream scope unknown", async () => {
    const { provider, fetch } = setup({
      success: true,
      data: {
        tenant: { id: 42, secret_config: "private" },
        user: { email: "not-a-delegated-user@example.test" },
        tenant_required: false,
      },
    });
    vi.spyOn(provider.configurations, "require").mockResolvedValue(configs("knowai"));
    const connect = vi
      .spyOn(provider.oauth, "connectKnowaiMachine")
      .mockResolvedValue({ connectionId: "new-machine" });
    await expect(
      provider.connect({ configId: "config-a", credential: "fixture-machine-key" }, context),
    ).resolves.toEqual({ connectionId: "new-machine", authorizationUrl: null });
    const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
    expect(headers.get("X-API-Key")).toBe("fixture-machine-key");
    expect(headers.get("X-Tenant-ID")).toBe("42");
    expect(String(fetch.mock.calls[0]![0])).toBe("https://knowai.example.test/api/v1/auth/me");
    const identity = connect.mock.calls[0]![2];
    expect(identity.tenant).toBe("42");
    expect(identity.context).toEqual({
      credentialKind: "machine_key",
      scopeAuthority: "local_configuration",
      upstreamKeyScopeVerified: false,
    });
    expect(JSON.stringify(identity)).not.toContain("not-a-delegated-user");
    expect(JSON.stringify(identity)).not.toContain("private");
  });
  it("rejects a Knowai key for another tenant before persisting a grant", async () => {
    const { provider } = setup({ success: true, data: { tenant: { id: 99 } } });
    vi.spyOn(provider.configurations, "require").mockResolvedValue(configs("knowai"));
    const connect = vi.spyOn(provider.oauth, "connectKnowaiMachine");
    await expect(
      provider.connect({ configId: "config-a", credential: "fixture-machine-key" }, context),
    ).rejects.toMatchObject({ kind: "authorization_required" });
    expect(connect).not.toHaveBeenCalled();
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
