import assert from "node:assert/strict";
import type { NativeAppConfig } from "@rakazo/db";
import { afterEach, it as test, vi } from "vitest";
import { NativeActionError } from "../action.js";
import type { NativeAuthorization } from "../authorities.js";
import { BusinessFilesAuthorities } from "./auth.js";
import { BUSINESS_FILES_APPS } from "./metadata.js";

const owned: BusinessFilesAuthorities[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((value) => value.close()));
  vi.restoreAllMocks();
});
const signal = () => new AbortController().signal;
function config(
  appId: keyof typeof BUSINESS_FILES_APPS,
  credentialKind = "oauth",
  extra = {},
): NativeAppConfig {
  return {
    id: "fixture-config",
    appId,
    label: "Fixture",
    ownership: "byo",
    credentialKind,
    enabled: true,
    callbackUri: "https://api.example.test/api/connectors/oauth/callback",
    revision: 1,
    ciphertext: "opaque",
    secretRecordId: "fixture-material",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    config: {
      clientId: "fixture-client",
      scopes: [...BUSINESS_FILES_APPS[appId].defaultScopes],
      capabilities: [],
      knowledgeBaseIds: [],
      actor: appId === "hubspot" ? "app" : "user",
      ...extra,
    },
  };
}
function setup(values: (unknown | Response | Error)[]) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    assert.ok(values.length, "Unexpected HTTP request");
    const value = values.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : new Response(JSON.stringify(value));
  });
  const authority = new BusinessFilesAuthorities({
    fetch,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  owned.push(authority);
  return { authority, fetch };
}
const failure = (kind: string) => (e: unknown) => e instanceof NativeActionError && e.kind === kind;
const uncertain = (e: unknown) => e instanceof NativeActionError && e.options.uncertain === true;
const clickMe = { user: { id: 123, username: "Fixture" } },
  teams = { teams: [{ id: "W1" }, { id: "W2" }] };
const airMe = { id: "usrFixture", scopes: ["schema.bases:read", "data.records:read"] };
const dropMe = {
  account_id: "dbid:fixture",
  name: { display_name: "Fixture" },
  root_info: { ".tag": "user", root_namespace_id: "1", home_namespace_id: "1" },
};
const figMe = { id: "900719925474099399", handle: "Fixture" };
const baseToken = {
  token_type: "Bearer",
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  expires_in: 3600,
};
const hubInfo = (userLevel = false) => ({
  active: true,
  token_use: "access_token",
  client_id: "fixture-client",
  hub_id: 11,
  user_id: 22,
  app_id: 33,
  hub_domain: "example.test",
  scopes: [...BUSINESS_FILES_APPS.hubspot.defaultScopes],
  signed_access_token: { hubId: 11, userId: 22, appId: 33, isUserLevel: userLevel },
});
function previous(
  app: keyof typeof BUSINESS_FILES_APPS,
  subject: string,
  extra: Record<string, unknown> = {},
): NativeAuthorization {
  return {
    tokens: { accessToken: "old-access", refreshToken: "old-refresh" },
    identity: {
      authority: BUSINESS_FILES_APPS[app].authority,
      subject,
      tenant: app === "hubspot" ? "11" : null,
      displayName: "Fixture",
      context: {
        actorType: app === "hubspot" ? "app" : "user",
        credentialType: "oauth",
        ...(app === "hubspot" ? { appId: "33", hubspotAccessLevel: "account" } : {}),
        ...extra,
      },
    },
    scopes: [...BUSINESS_FILES_APPS[app].defaultScopes],
    expiresAt: new Date(0),
  };
}
for (const app of Object.keys(BUSINESS_FILES_APPS) as (keyof typeof BUSINESS_FILES_APPS)[]) {
  test(`${app}: fixed authorization URL carries state/callback without secret`, () => {
    const { authority, fetch } = setup([]),
      url = new URL(authority.authorizationUrl(config(app), "opaque-state", "opaque-verifier"));
    assert.equal(url.searchParams.get("state"), "opaque-state");
    assert.equal(url.searchParams.get("redirect_uri"), config(app).callbackUri);
    assert.equal(url.searchParams.get("client_id"), "fixture-client");
    assert.equal(url.searchParams.get("client_secret"), null);
    assert.equal(url.searchParams.get("code_verifier"), null);
    assert.equal(
      url.searchParams.get("code_challenge_method"),
      ["airtable", "dropbox", "figma"].includes(app) ? "S256" : null,
    );
    assert.equal(fetch.mock.calls.length, 0);
    if (app === "clickup") assert.equal(url.searchParams.get("scope"), null);
    if (app === "dropbox") assert.equal(url.searchParams.get("token_access_type"), "offline");
  });
  test(`${app}: token request network/5xx is uncertain and diagnostics remain private`, async () => {
    for (const failureResponse of [
      new Error("private-diagnostic"),
      new Response(JSON.stringify({ error_description: "private-diagnostic" }), { status: 503 }),
    ]) {
      const { authority } = setup([failureResponse]);
      await assert.rejects(
        authority.exchange(
          config(app),
          "private-client-secret",
          "private-code",
          "verifier",
          signal(),
        ),
        (e) => uncertain(e) && e instanceof Error && !e.message.includes("private"),
      );
    }
  });
  test(`${app}: credential or unsupported actor cannot skip protocol validation`, async () => {
    const { authority, fetch } = setup([]);
    await assert.rejects(
      authority.verifyStatic(config(app, "bot_token"), "fixture-token", signal()),
      failure("not_configured"),
    );
    assert.throws(
      () => authority.authorizationUrl(config(app, "oauth", { actor: "bot" }), "state", "verifier"),
      failure("not_configured"),
    );
    assert.equal(fetch.mock.calls.length, 0);
  });
}
test("ClickUp: actual user plus all authorized workspaces, no invented scope/expiry/refresh", async () => {
  const { authority, fetch } = setup([{ access_token: "click-access" }, clickMe, teams]);
  const auth = await authority.exchange(
    config("clickup"),
    "client-secret",
    "code",
    "verifier",
    signal(),
  );
  assert.equal(auth.identity.subject, "123");
  assert.equal(auth.identity.tenant, null);
  assert.deepEqual(auth.identity.context.workspaceIds, ["W1", "W2"]);
  assert.deepEqual(auth.scopes, []);
  assert.equal(auth.expiresAt, null);
  assert.equal(auth.tokens.refreshToken, null);
  assert.equal(String(fetch.mock.calls[0]![0]), "https://api.clickup.com/api/v2/oauth/token");
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[0]![1]?.body)), {
    client_id: "fixture-client",
    client_secret: "client-secret",
    code: "code",
  });
  await assert.rejects(
    authority.refresh(config("clickup"), "secret", auth, signal()),
    failure("authorization_expired"),
  );
  assert.equal(fetch.mock.calls.length, 3);
});
test("ClickUp: PAT uses actual raw header and cannot accept an unverified tenant selector", async () => {
  const { authority, fetch } = setup([clickMe, teams]);
  await authority.verifyStatic(config("clickup", "personal_token"), "pk_fixture", signal());
  assert.equal(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization"), "pk_fixture");
  await assert.rejects(
    authority.verifyStatic(
      config("clickup", "personal_token", { tenantId: "W1" }),
      "pk_fixture",
      signal(),
    ),
    failure("not_configured"),
  );
});
test("Airtable: official Bearer trailing-space success requires actual whoami scopes", async () => {
  const { authority, fetch } = setup([
    { ...baseToken, token_type: "Bearer ", scope: airMe.scopes.join(" ") },
    airMe,
  ]);
  const result = await authority.exchange(
    config("airtable"),
    "secret",
    "code",
    "verifier",
    signal(),
  );
  assert.equal(result.identity.subject, "usrFixture");
  assert.deepEqual(result.scopes, airMe.scopes);
  assert.equal(String(fetch.mock.calls[0]![0]), "https://airtable.com/oauth2/v1/token");
  assert.equal(
    new URLSearchParams(fetch.mock.calls[0]![1]?.body as string).get("code_verifier"),
    "verifier",
  );
  const incomplete = setup([{ ...baseToken, scope: airMe.scopes.join(" ") }, { id: "usrFixture" }]);
  await assert.rejects(
    incomplete.authority.exchange(config("airtable"), "secret", "code", "verifier", signal()),
    uncertain,
  );
});
const basicHeaderVectors = [
  {
    name: "padding",
    secret: "secretx",
    airtable: "Basic Zml4dHVyZS1jbGllbnQ6c2VjcmV0eA",
    figma: "Basic Zml4dHVyZS1jbGllbnQ6c2VjcmV0eA==",
  },
  {
    name: "plus versus minus",
    secret: "~~~",
    airtable: "Basic Zml4dHVyZS1jbGllbnQ6fn5-",
    figma: "Basic Zml4dHVyZS1jbGllbnQ6fn5+",
  },
  {
    name: "slash versus underscore",
    secret: "???",
    airtable: "Basic Zml4dHVyZS1jbGllbnQ6Pz8_",
    figma: "Basic Zml4dHVyZS1jbGllbnQ6Pz8/",
  },
] as const;
for (const app of ["airtable", "figma"] as const) {
  test.each(basicHeaderVectors)(
    `${app}: exchange and refresh use the provider's Basic encoding ($name)`,
    async (vector) => {
      const me = app === "airtable" ? airMe : figMe;
      const token = {
        ...baseToken,
        scope: airMe.scopes.join(" "),
        ...(app === "figma" ? { user_id_string: figMe.id } : {}),
      };
      const { authority, fetch } = setup([
        token,
        me,
        {
          ...token,
          access_token: "fixture-refreshed-access",
          refresh_token: "fixture-refreshed-refresh",
        },
        me,
      ]);
      const first = await authority.exchange(
        config(app),
        vector.secret,
        "code",
        "verifier",
        signal(),
      );
      const refreshed = await authority.refresh(config(app), vector.secret, first, signal());
      assert.equal(fetch.mock.calls.length, 4);
      for (const [index, grantType] of [
        [0, "authorization_code"],
        [2, "refresh_token"],
      ] as const) {
        const request = fetch.mock.calls[index]![1];
        assert.equal(new Headers(request?.headers).get("authorization"), vector[app]);
        assert.equal(new URLSearchParams(request?.body as string).get("grant_type"), grantType);
      }
      assert.equal(refreshed.identity.subject, me.id);
      assert.equal(refreshed.tokens.accessToken, "fixture-refreshed-access");
      assert.equal(refreshed.tokens.refreshToken, "fixture-refreshed-refresh");
    },
  );
}
test("Airtable: PAT whoami without scope stays provider-enforced and does not gain declared grant scopes", async () => {
  const { authority } = setup([{ id: "usrFixture" }]);
  const result = await authority.verifyStatic(
    config("airtable", "personal_token"),
    "opaque-token",
    signal(),
  );
  assert.deepEqual(result.scopes, []);
  assert.equal(result.identity.context.scopeAuthority, "provider_enforced");
  assert.deepEqual(
    result.identity.context.configuredScopes,
    BUSINESS_FILES_APPS.airtable.defaultScopes,
  );
});
test("Airtable: refresh replaces pair, missing new refresh and 409 do not reuse old pair", async () => {
  const { authority, fetch } = setup([{ ...baseToken, scope: airMe.scopes.join(" ") }, airMe]);
  const result = await authority.refresh(
    config("airtable"),
    "secret",
    previous("airtable", "usrFixture"),
    signal(),
  );
  assert.equal(result.tokens.refreshToken, "fixture-refresh");
  assert.equal(
    new URLSearchParams(fetch.mock.calls[0]![1]?.body as string).get("grant_type"),
    "refresh_token",
  );
  const missing = setup([
    { token_type: "Bearer", access_token: "new", expires_in: 3600, scope: airMe.scopes.join(" ") },
  ]);
  await assert.rejects(
    missing.authority.refresh(
      config("airtable"),
      "secret",
      previous("airtable", "usrFixture"),
      signal(),
    ),
    uncertain,
  );
  assert.equal(missing.fetch.mock.calls.length, 1);
  const conflict = setup([new Response("{}", { status: 409 })]);
  await assert.rejects(
    conflict.authority.refresh(
      config("airtable"),
      "secret",
      previous("airtable", "usrFixture"),
      signal(),
    ),
    failure("authorization_required"),
  );
  assert.equal(conflict.fetch.mock.calls.length, 1);
});
test("Dropbox: actual account, namespace and scopes are verified, refresh may keep original reusable refresh", async () => {
  const first = setup([
    {
      ...baseToken,
      account_id: "dbid:fixture",
      scope: BUSINESS_FILES_APPS.dropbox.defaultScopes.join(" "),
    },
    dropMe,
  ]);
  const initial = await first.authority.exchange(
    config("dropbox"),
    "secret",
    "code",
    "verifier",
    signal(),
  );
  assert.equal(initial.identity.subject, "dbid:fixture");
  assert.equal(initial.identity.context.rootNamespaceId, "1");
  const refreshed = setup([
    { token_type: "Bearer", access_token: "new", expires_in: 3600 },
    dropMe,
  ]);
  const result = await refreshed.authority.refresh(config("dropbox"), "secret", initial, signal());
  assert.equal(result.tokens.refreshToken, "fixture-refresh");
  assert.deepEqual(result.scopes, initial.scopes);
});
test("Dropbox: token/account mismatch and team mismatch cannot authorize another actor", async () => {
  const mismatch = setup([
    { ...baseToken, account_id: "dbid:other", scope: "account_info.read" },
    dropMe,
  ]);
  await assert.rejects(
    mismatch.authority.exchange(config("dropbox"), "secret", "code", "verifier", signal()),
    failure("authorization_required"),
  );
  const tenant = setup([
    { ...baseToken, scope: "account_info.read" },
    { ...dropMe, team: { id: "team-actual" } },
  ]);
  await assert.rejects(
    tenant.authority.exchange(
      config("dropbox", "oauth", { tenantId: "team-other" }),
      "secret",
      "code",
      "verifier",
      signal(),
    ),
    failure("authorization_required"),
  );
});
test("HubSpot: date-based token/introspection use bodies on fixed auth host and verify account-level app", async () => {
  const { authority, fetch } = setup([
    { ...baseToken, hub_id: 11, scopes: hubInfo().scopes },
    hubInfo(),
  ]);
  const result = await authority.exchange(
    config("hubspot"),
    "client-secret",
    "code",
    "verifier",
    signal(),
  );
  assert.equal(result.identity.tenant, "11");
  assert.equal(result.identity.context.actorType, "app");
  assert.equal(result.identity.context.hubspotAccessLevel, "account");
  assert.equal(result.identity.subject, "app:33:user:22");
  assert.deepEqual(
    fetch.mock.calls.map((c) => String(c[0])),
    [
      "https://api.hubspot.com/oauth/2026-09/token",
      "https://api.hubspot.com/oauth/2026-09/token/introspect",
    ],
  );
  for (const [url] of fetch.mock.calls) assert.equal(new URL(String(url)).search, "");
  assert.equal(
    new URLSearchParams(fetch.mock.calls[1]![1]?.body as string).get("token"),
    "fixture-access",
  );
});
test("HubSpot: user-level must be proved; account scopes do not imply user row ACL", async () => {
  for (const [requested, actual] of [
    ["user", false],
    ["app", true],
  ] as const) {
    const { authority } = setup([baseToken, hubInfo(actual)]);
    await assert.rejects(
      authority.exchange(
        config("hubspot", "oauth", { actor: requested }),
        "secret",
        "code",
        "verifier",
        signal(),
      ),
      failure("authorization_required"),
    );
  }
  const { authority } = setup([baseToken, hubInfo(true)]);
  const result = await authority.exchange(
    config("hubspot", "oauth", { actor: "user" }),
    "secret",
    "code",
    "verifier",
    signal(),
  );
  assert.equal(result.identity.subject, "22");
  assert.equal(result.identity.context.hubspotAccessLevel, "user");
});
test("HubSpot: private app uses verified portal/app identity and cannot impersonate creator user", async () => {
  const { authority, fetch } = setup([
    { hubId: 11, appId: 33, userId: 22, scopes: ["crm.objects.contacts.read"] },
  ]);
  const result = await authority.verifyStatic(
    config("hubspot", "personal_token"),
    "private-app-token",
    signal(),
  );
  assert.equal(result.identity.subject, "app:33");
  assert.equal(result.identity.context.actorType, "app");
  assert.equal(result.identity.context.authorizingUserId, "22");
  assert.deepEqual(result.scopes, ["crm.objects.contacts.read"]);
  assert.equal(
    String(fetch.mock.calls[0]![0]),
    "https://api.hubapi.com/oauth/v2/private-apps/get/access-token-info",
  );
  const wrong = setup([]);
  await assert.rejects(
    wrong.authority.verifyStatic(
      config("hubspot", "personal_token", { actor: "user" }),
      "private",
      signal(),
    ),
    failure("not_configured"),
  );
});
test("HubSpot: introspection inactive, client/portal mismatch and app switch fail closed", async () => {
  for (const info of [
    { ...hubInfo(), active: false },
    { ...hubInfo(), client_id: "another-client" },
    { ...hubInfo(), hub_id: 12 },
  ]) {
    const { authority } = setup([baseToken, info]);
    await assert.rejects(
      authority.exchange(
        config("hubspot", "oauth", { tenantId: "11" }),
        "secret",
        "code",
        "verifier",
        signal(),
      ),
      (e) =>
        e instanceof NativeActionError &&
        ["authorization_required", "incomplete_response"].includes(e.kind),
    );
  }
});
test("Figma: OAuth uses user_id_string without precision loss and reports scope introspection unavailable", async () => {
  const { authority, fetch } = setup([
    { ...baseToken, user_id: Number("900719925474099400"), user_id_string: figMe.id },
    figMe,
  ]);
  const result = await authority.exchange(config("figma"), "secret", "code", "verifier", signal());
  assert.equal(result.identity.subject, figMe.id);
  assert.deepEqual(result.scopes, []);
  assert.equal(result.identity.context.scopeAuthority, "provider_enforced");
  assert.equal(result.identity.context.remoteTokenMultiplicity, "one_per_app_user");
  assert.equal(
    new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization"),
    `Basic ${Buffer.from("fixture-client:secret").toString("base64")}`,
  );
  const numeric = setup([
    { ...baseToken, user_id: 123 },
    { ...figMe, id: "123" },
  ]);
  await assert.rejects(
    numeric.authority.exchange(config("figma"), "secret", "code", "verifier", signal()),
    uncertain,
  );
});
test("Figma: PAT uses X-Figma-Token, no fabricated scopes or permanent-lifetime claim", async () => {
  const { authority, fetch } = setup([figMe]);
  const result = await authority.verifyStatic(
    config("figma", "personal_token"),
    "fig-pat",
    signal(),
  );
  assert.equal(new Headers(fetch.mock.calls[0]![1]?.headers).get("x-figma-token"), "fig-pat");
  assert.equal(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization"), null);
  assert.deepEqual(result.scopes, []);
  assert.equal(result.identity.context.tokenExpiryKnown, false);
});
test("Figma: refresh uses new token endpoint, keeps reusable refresh and verifies exact same user", async () => {
  const { authority, fetch } = setup([
    { token_type: "Bearer", access_token: "new", expires_in: 3600 },
    figMe,
  ]);
  const result = await authority.refresh(
    config("figma"),
    "secret",
    previous("figma", figMe.id),
    signal(),
  );
  assert.equal(result.tokens.refreshToken, "old-refresh");
  assert.equal(String(fetch.mock.calls[0]![0]), "https://api.figma.com/v1/oauth/token");
  assert.equal(
    new URLSearchParams(fetch.mock.calls[0]![1]?.body as string).get("grant_type"),
    "refresh_token",
  );
  const wrong = setup([
    { token_type: "Bearer", access_token: "new", expires_in: 3600 },
    { ...figMe, id: "another" },
  ]);
  await assert.rejects(
    wrong.authority.refresh(config("figma"), "secret", previous("figma", figMe.id), signal()),
    failure("authorization_required"),
  );
});
test("Figma: same app/user two local authorizations explicitly preserve remote single-token semantics", async () => {
  const { authority } = setup([
    { ...baseToken, user_id_string: figMe.id },
    figMe,
    { ...baseToken, access_token: "second-access", user_id_string: figMe.id },
    figMe,
  ]);
  const first = await authority.exchange(
      config("figma"),
      "secret",
      "code-one",
      "verifier",
      signal(),
    ),
    second = await authority.exchange(config("figma"), "secret", "code-two", "verifier", signal());
  assert.equal(first.identity.subject, second.identity.subject);
  assert.equal(first.identity.context.remoteTokenMultiplicity, "one_per_app_user");
  assert.equal(second.identity.context.remoteTokenMultiplicity, "one_per_app_user");
  assert.notEqual(first.tokens.accessToken, second.tokens.accessToken);
});
test("Dropbox: official personal account team:null code exchange succeeds without fabricating a tenant", async () => {
  const { authority } = setup([
    {
      ...baseToken,
      account_id: "dbid:fixture",
      scope: BUSINESS_FILES_APPS.dropbox.defaultScopes.join(" "),
    },
    { ...dropMe, team: null },
  ]);
  const result = await authority.exchange(
    config("dropbox"),
    "secret",
    "code",
    "verifier",
    signal(),
  );
  assert.equal(result.identity.subject, "dbid:fixture");
  assert.equal(result.identity.tenant, null);
});
