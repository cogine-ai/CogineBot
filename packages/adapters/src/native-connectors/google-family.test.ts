import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import { NativeConfigInputSchema } from "@rakazo/contracts";
import type { NativeAppConfig, PrismaClient } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import { NativeActionError } from "./action.js";
import { NativeOAuthAuthorities } from "./authorities.js";
import { NativeConfigStore } from "./config.js";
import type { GoogleNativeApp } from "./google.js";
import { GOOGLE_NATIVE_APPS, googleServiceBase, isGoogleNativeApp } from "./google.js";
import type { NativeOAuthStore } from "./oauth.js";
import { NativeConnectorProvider } from "./provider.js";
import { nativeServiceBase } from "./service-bases.js";

const PREFIX = "https://www.googleapis.com/auth/";
const READ: Record<GoogleNativeApp, string> = {
  "google-calendar": "calendar.events.readonly",
  gmail: "gmail.readonly",
  "google-drive": "drive.metadata.readonly",
  "google-docs": "documents.readonly",
  "google-sheets": "spreadsheets.readonly",
  "google-slides": "presentations.readonly",
  "google-tasks": "tasks.readonly",
};
const APPS = Object.keys(READ) as GoogleNativeApp[];
const context: AdapterContext = {
  userId: "fixture-owner",
  spaceId: "fixture-space",
  operationId: "fixture-configure",
  traceId: "fixture-configure",
  signal: new AbortController().signal,
};
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(close.splice(0).map((run) => run()));
});
function config(
  app: GoogleNativeApp,
  scopes = ["openid", "email", PREFIX + READ[app]],
): NativeAppConfig {
  return {
    id: "fixture-config",
    appId: app,
    label: "Fixture",
    ownership: "byo",
    credentialKind: "oauth",
    enabled: true,
    revision: 1,
    config: { clientId: "fixture-client", scopes, capabilities: [], knowledgeBaseIds: [] },
    callbackUri: "https://instance.example.test/api/connectors/oauth/callback",
    ciphertext: "fixture-opaque",
    secretRecordId: "fixture-secret-ref",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}
function authority(responses: unknown[] = []) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected OAuth fixture request");
    return new Response(JSON.stringify(response));
  });
  const service = new NativeOAuthAuthorities({
    fetch,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  close.push(() => service.close());
  return { service, fetch };
}
for (const app of APPS) {
  it(`${app} sends only its explicitly configured scopes and preserves PKCE/account selection`, () => {
    const { service, fetch } = authority(),
      saved = config(app);
    const url = new URL(service.authorizationUrl(saved, "fixture-state", "fixture-verifier"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([
      "openid",
      "email",
      PREFIX + READ[app],
    ]);
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.searchParams.get("prompt")).toContain("select_account");
    expect(url.searchParams.get("state")).toBe("fixture-state");
    expect(url.searchParams.get("redirect_uri")).toBe(saved.callbackUri);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(url.searchParams.has("code_verifier")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it(`${app} rejects a sibling app scope before storing or contacting a provider`, async () => {
    const transaction = vi.fn(async () => {
      throw new Error("Must reject before any database mutation");
    });
    const store = new NativeConfigStore(
      { $transaction: transaction } as unknown as PrismaClient,
      new EncryptedSecretStore("fixture-key"),
      "https://instance.example.test",
    );
    const foreign = app === "google-tasks" ? "gmail.readonly" : "tasks.readonly";
    await expect(
      store.save(
        {
          appId: app,
          label: "Fixture",
          ownership: "byo",
          credentialKind: "oauth",
          enabled: true,
          clientId: "fixture-client",
          scopes: ["openid", "email", PREFIX + foreign],
          capabilities: [],
          knowledgeBaseIds: [],
        },
        context,
        true,
      ),
    ).rejects.toThrow("Unsupported");
    expect(transaction).not.toHaveBeenCalled();
  });
  it(`${app} uses its fixed API base despite caller-supplied endpoint text`, () => {
    expect(isGoogleNativeApp(app)).toBe(true);
    expect(nativeServiceBase(app, "https://unexpected.example.test")).toBe(
      GOOGLE_NATIVE_APPS[app].baseUrl,
    );
    expect(googleServiceBase(app)).toBe(GOOGLE_NATIVE_APPS[app].baseUrl);
    for (const endpoint of [
      "https://unexpected.example.test",
      "https://user:secret@unexpected.example.test",
    ]) {
      expect(
        NativeConfigInputSchema.safeParse({
          appId: app,
          label: "Fixture",
          ownership: "byo",
          credentialKind: "oauth",
          clientId: "fixture-client",
          scopes: ["openid", "email"],
          endpoint,
        }).success,
      ).toBe(false);
    }
    expect(
      NativeConfigInputSchema.safeParse({
        appId: app,
        label: "Fixture",
        ownership: "byo",
        credentialKind: "bot_token",
      }).success,
    ).toBe(false);
  });
}
it("Drive secondary APIs are narrowly assigned to app families", () => {
  for (const app of ["google-drive", "google-docs", "google-sheets", "google-slides"] as const)
    expect(googleServiceBase(app, "drive")).toBe("https://www.googleapis.com/drive/v3");
  expect(googleServiceBase("google-drive", "drive-upload")).toBe(
    "https://www.googleapis.com/upload/drive/v3",
  );
  for (const app of ["gmail", "google-calendar", "google-tasks"] as const)
    expect(() => googleServiceBase(app, "drive")).toThrow();
  for (const app of ["google-docs", "google-sheets", "google-slides"] as const)
    expect(() => googleServiceBase(app, "drive-upload")).toThrow();
  expect(() => nativeServiceBase("slack", undefined, "drive")).toThrow();
});
it.each([true, false, "true", undefined])(
  "only authoritative boolean email_verified=%s supplies a mail identity",
  async (verified) => {
    const { service, fetch } = authority([
      {
        access_token: "fixture-access",
        token_type: "Bearer",
        refresh_token: "fixture-refresh",
        expires_in: 3600,
        scope: `openid email ${PREFIX}gmail.readonly`,
      },
      { sub: "fixture-subject", email: "fixture@example.test", email_verified: verified },
    ]);
    const result = await service.exchange(
      config("gmail"),
      "fixture-client-secret",
      "fixture-code",
      "fixture-verifier",
      new AbortController().signal,
    );
    expect(result.identity.subject).toBe("fixture-subject");
    expect(result.identity.context.email).toBe(
      verified === true ? "fixture@example.test" : undefined,
    );
    expect(String(fetch.mock.calls[1]![0])).toBe(
      "https://openidconnect.googleapis.com/v1/userinfo",
    );
    expect(new Headers(fetch.mock.calls[1]![1]!.headers).get("authorization")).toBe(
      "Bearer fixture-access",
    );
  },
);
const base = {
  label: "Fixture",
  ownership: "byo" as const,
  scopes: [],
  clientId: "fixture-client",
};
it.each([
  ["github", "personal_token", "user"],
  ["github", "oauth", "user"],
  ["github", "github_app_installation", "installation"],
  ["linear", "personal_token", "user"],
  ["linear", "oauth", "user"],
  ["linear", "oauth", "app"],
  ["slack", "bot_token", "bot"],
  ["slack", "personal_token", "user"],
  ["slack", "oauth", "bot"],
  ["slack", "oauth", "user"],
] as const)("accepts only the declared %s %s %s config actor", (appId, credentialKind, actor) => {
  expect(
    NativeConfigInputSchema.safeParse({
      ...base,
      appId,
      credentialKind,
      actor,
      ...(credentialKind === "github_app_installation"
        ? { githubAppId: "123", githubInstallationId: "456" }
        : {}),
    }).success,
  ).toBe(true);
});
it.each([
  { appId: "github", credentialKind: "personal_token", actor: "installation" },
  {
    appId: "github",
    credentialKind: "github_app_installation",
    actor: "user",
    githubAppId: "123",
    githubInstallationId: "456",
  },
  { appId: "github", credentialKind: "github_app_installation", actor: "installation" },
  { appId: "linear", credentialKind: "personal_token", actor: "app" },
  { appId: "linear", credentialKind: "oauth", actor: "bot" },
  { appId: "slack", credentialKind: "bot_token", actor: "user" },
  { appId: "slack", credentialKind: "personal_token", actor: "bot" },
  { appId: "slack", credentialKind: "oauth", actor: "app" },
])("rejects incompatible actor or missing identity %j", (input) => {
  expect(NativeConfigInputSchema.safeParse({ ...base, ...input }).success).toBe(false);
});
it("rejects Google scopes in collaboration configurations and does not persist signing keys as app settings", async () => {
  for (const [appId, credentialKind, actor] of [
    ["github", "personal_token", "user"],
    ["linear", "personal_token", "user"],
    ["slack", "bot_token", "bot"],
  ] as const) {
    const transaction = vi.fn(async () => {
      throw new Error("No mutation expected");
    });
    const store = new NativeConfigStore(
      { $transaction: transaction } as unknown as PrismaClient,
      new EncryptedSecretStore("fixture-key"),
      "https://instance.example.test",
    );
    await expect(
      store.save(
        NativeConfigInputSchema.parse({
          ...base,
          appId,
          credentialKind,
          actor,
          scopes: [`${PREFIX}gmail.readonly`],
        }),
        context,
        true,
      ),
    ).rejects.toThrow("Unsupported");
    expect(transaction).not.toHaveBeenCalled();
  }
  expect(
    NativeConfigInputSchema.safeParse({
      ...base,
      appId: "github",
      credentialKind: "github_app_installation",
      actor: "installation",
      githubAppId: "123",
      githubInstallationId: "456",
      clientSecret: "fixture-private-key",
    }).success,
  ).toBe(false);
});
it("unconfigured or absent selected accounts expose no native tools and make no network request", async () => {
  const fetch = vi.fn(async () => {
    throw new Error("No network expected");
  });
  const provider = new NativeConnectorProvider(
    {} as PrismaClient,
    new EncryptedSecretStore("fixture-key"),
    "https://instance.example.test",
    {
      artifacts: {} as ArtifactStore,
      network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    },
  );
  close.push(() => provider.close());
  expect(await provider.discoverTools(context)).toEqual([]);
  const authorization = vi
    .spyOn(provider.oauth, "authorization")
    .mockRejectedValue(new NativeActionError("not_configured", "Fixture source is not configured"));
  for (const externalId of APPS) {
    expect(
      await provider.discoverTools({
        ...context,
        connectedConnections: [
          {
            id: "fixture-connection",
            connectorId: "native",
            displayName: "Fixture Google account",
            externalId,
            providerRef: "fixture-grant",
            revision: "fixture-grant:1",
          },
        ],
      }),
    ).toEqual([]);
  }
  expect(authorization).toHaveBeenCalledTimes(7);
  expect(fetch).not.toHaveBeenCalled();
});
for (const app of APPS)
  it(`${app} tools intersect actual scopes with this app configuration and never expose siblings`, async () => {
    const provider = new NativeConnectorProvider(
      {} as PrismaClient,
      new EncryptedSecretStore("fixture-key"),
      "https://instance.example.test",
      { artifacts: {} as ArtifactStore },
    );
    close.push(() => provider.close());
    const selected = {
      id: "fixture-connection",
      connectorId: "native",
      externalId: app,
      displayName: "Fixture account",
      providerRef: "fixture-grant",
      revision: "fixture-auth",
    };
    vi.spyOn(provider.oauth, "authorization").mockResolvedValue({
      connection: {
        id: selected.id,
        provider: app,
        providerRef: selected.providerRef,
        displayName: selected.displayName,
        metadata: { authRevision: "fixture-auth" },
      },
      config: config(app),
      grant: {
        id: "fixture-grant",
        authGeneration: 1,
        tokenVersion: 1,
        subject: "fixture-subject",
        tenant: null,
        scopes: [...new Set(Object.values(GOOGLE_NATIVE_APPS).flatMap((entry) => entry.scopes))],
      },
      auth: {
        tokens: { accessToken: "fixture-access", refreshToken: "fixture-refresh" },
        identity: { context: { email: "fixture@example.test" } },
      },
    } as unknown as Awaited<ReturnType<NativeOAuthStore["authorization"]>>);
    const tools = await provider.discoverTools({ ...context, connectedConnections: [selected] });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => tool.route?.resourceId === app)).toBe(true);
    expect(tools.every((tool) => tool.readOnly)).toBe(true);
  });
