import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { NativeAppConfig } from "@rakazo/db";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, it } from "vitest";
import type { NativeAuthorization } from "../authorities.js";
import { MicrosoftAuthorities } from "./auth.js";
import { MICROSOFT_CONSUMER_TENANT } from "./metadata.js";

const tenant = "11111111-1111-4111-8111-111111111111",
  oid = "22222222-2222-4222-8222-222222222222",
  verifier = "fixture-verifier-0123456789abcdefghijklmnopqrstuvwxyz",
  client = "fixture-client";
const keys = generateKeyPair("RS256", { extractable: true });
const instances: MicrosoftAuthorities[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((a) => a.close()));
});
const config = (extra: Record<string, unknown> = {}): NativeAppConfig => ({
  id: "config-fixture",
  appId: "outlook-mail",
  label: "Fixture",
  ownership: "byo",
  credentialKind: "oauth",
  enabled: true,
  callbackUri: "https://api.example.test/api/connectors/oauth/callback",
  revision: 1,
  ciphertext: "opaque",
  secretRecordId: "secret-fixture",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  config: {
    clientId: client,
    actor: "user",
    scopes: ["openid", "profile", "offline_access", "User.Read", "Mail.Read"],
    capabilities: [],
    knowledgeBaseIds: [],
    ...extra,
  },
});
const signal = () => AbortSignal.timeout(10000);
function setup(values: Array<unknown | Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const authority = new MicrosoftAuthorities({
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      assert.ok(values.length, "Unexpected authorization HTTP");
      const next = values.shift();
      if (next instanceof Error) throw next;
      return next instanceof Response ? next : new Response(JSON.stringify(next));
    },
  });
  instances.push(authority);
  return { authority, calls, values };
}
async function authorizationValues(
  extra: Record<string, unknown> = {},
  meId = oid,
  claims: Record<string, unknown> = {},
) {
  const pair = await keys,
    jwk = await exportJWK(pair.publicKey);
  jwk.kid = "fixture-key";
  jwk.alg = "RS256";
  const tid = typeof claims.tid === "string" ? claims.tid : tenant;
  const jwt = await new SignJWT({
    oid,
    tid,
    nonce: createHash("sha256").update(`native-microsoft:${verifier}`).digest("base64url"),
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
    .setIssuer(`https://login.microsoftonline.com/${tid}/v2.0`)
    .setAudience(client)
    .setSubject("pairwise-fixture-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  return [
    {
      access_token: "fixture-opaque-access",
      refresh_token: "fixture-refresh",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "User.Read Mail.Read",
      id_token: jwt,
      ...extra,
    },
    { keys: [jwk] },
    { sub: "pairwise-fixture-subject" },
    { id: meId, displayName: "Fixture Person" },
  ];
}
const previous: NativeAuthorization = {
  tokens: { accessToken: "fixture-old-access", refreshToken: "fixture-old-refresh" },
  identity: {
    authority: "https://login.microsoftonline.com",
    subject: oid,
    tenant,
    displayName: "Fixture",
    context: {
      oid,
      actorType: "user",
      credentialType: "oauth",
      tenantId: tenant,
      accountType: "organization",
    },
  },
  scopes: ["User.Read", "Mail.Read"],
  expiresAt: new Date(0),
};
describe("Microsoft delegated authority", () => {
  it("uses PKCE, nonce, confidential callback and the configured audience without inventing account scopes", () => {
    const s = setup([]),
      url = new URL(
        s.authority.authorizationUrl(
          config({ tenantId: "organizations" }),
          "state-fixture",
          verifier,
        ),
      );
    assert.equal(url.origin, "https://login.microsoftonline.com");
    assert.equal(url.pathname, "/organizations/oauth2/v2.0/authorize");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("state"), "state-fixture");
    assert.equal(
      url.searchParams.get("nonce"),
      createHash("sha256").update(`native-microsoft:${verifier}`).digest("base64url"),
    );
    assert.equal(
      url.searchParams.get("scope"),
      "openid profile offline_access User.Read Mail.Read",
    );
    assert.equal(s.calls.length, 0);
  });
  it("verifies signed ID token, tenant, access-token UserInfo subject and Graph profile", async () => {
    const s = setup(await authorizationValues());
    const auth = await s.authority.exchange(
      config(),
      "fixture-client-secret",
      "fixture-code",
      verifier,
      signal(),
    );
    assert.equal(auth.identity.subject, oid);
    assert.equal(auth.identity.tenant, tenant);
    assert.equal(auth.identity.context.actorType, "user");
    assert.deepEqual(auth.scopes, ["User.Read", "Mail.Read"]);
    assert.equal(s.values.length, 0);
    assert.equal(
      s.calls[1]?.url,
      `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
    );
    const form = s.calls[0]?.init?.body as URLSearchParams;
    assert.equal(form.get("code_verifier"), verifier);
    assert.equal(form.get("client_secret"), "fixture-client-secret");
    assert.equal(
      s.calls.some((c) => c.url.includes("fixture-client-secret")),
      false,
    );
  });
  it("supports an opaque consumer access token without assuming Graph me id equals oid", async () => {
    const s = setup(
      await authorizationValues({}, "0123456789abcdef", { tid: MICROSOFT_CONSUMER_TENANT }),
    );
    const auth = await s.authority.exchange(
      config({ tenantId: "consumers" }),
      "fixture-secret",
      "fixture-code",
      verifier,
      signal(),
    );
    assert.equal(auth.identity.subject, "0123456789abcdef");
    assert.equal(auth.identity.tenant, MICROSOFT_CONSUMER_TENANT);
    assert.equal(auth.identity.context.accountType, "personal");
  });
  it("rejects mismatched ID token nonce", async () => {
    const s = setup(await authorizationValues({}, oid, { nonce: "another-fixture-nonce" }));
    await assert.rejects(
      s.authority.exchange(config(), "fixture-secret", "code", verifier, signal()),
      { kind: "authorization_required" },
    );
    assert.equal(s.calls.length, 2);
  });
  it("rejects a signed identity with the wrong Graph access-token subject", async () => {
    const values = await authorizationValues();
    values[2] = { sub: "different-fixture-subject" };
    const s = setup(values);
    await assert.rejects(
      s.authority.exchange(config(), "fixture-secret", "code", verifier, signal()),
      { kind: "authorization_required" },
    );
    assert.equal(s.calls.length, 3);
  });
  it("rejects a Graph profile from another organizational object", async () => {
    const s = setup(await authorizationValues({}, "other-graph-id"));
    await assert.rejects(
      s.authority.exchange(config(), "fixture-secret", "code", verifier, signal()),
      { kind: "authorization_required" },
    );
  });
  it("rejects a consumer for organization-only Excel before Graph requests", async () => {
    const c = config({ tenantId: "organizations" });
    c.appId = "excel";
    const s = setup(await authorizationValues({}, oid, { tid: MICROSOFT_CONSUMER_TENANT }));
    await assert.rejects(s.authority.exchange(c, "fixture-secret", "code", verifier, signal()), {
      kind: "authorization_required",
    });
    assert.equal(s.calls.length, 2);
  });
  it("rejects a different fixed tenant", async () => {
    const s = setup(await authorizationValues());
    await assert.rejects(
      s.authority.exchange(
        config({ tenantId: "33333333-3333-4333-8333-333333333333" }),
        "fixture-secret",
        "code",
        verifier,
        signal(),
      ),
      { kind: "authorization_required" },
    );
  });
  it("rejects unsigned identity tokens instead of decoding them as verified identity", async () => {
    const values = await authorizationValues();
    const token = values[0] as Record<string, unknown>;
    token.id_token = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ tid: tenant, oid, sub: "fixture" })).toString("base64url")}.`;
    const s = setup(values);
    await assert.rejects(
      s.authority.exchange(config(), "fixture-secret", "code", verifier, signal()),
      { kind: "authorization_required" },
    );
  });
  it("refreshes within the exact account and retains a refresh token when Microsoft omits a replacement", async () => {
    const s = setup([
      {
        access_token: "fixture-refreshed-opaque",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "https://graph.microsoft.com/User.Read Mail.Read",
      },
      { id: oid, displayName: "Fixture" },
    ]);
    const auth = await s.authority.refresh(config(), "fixture-secret", previous, signal());
    assert.equal(auth.tokens.refreshToken, "fixture-old-refresh");
    assert.equal(auth.identity.subject, oid);
    assert.deepEqual(auth.scopes, ["User.Read", "Mail.Read"]);
  });
  it("does not switch accounts when refreshing", async () => {
    const s = setup([
      {
        access_token: "fixture-new",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "User.Read Mail.Read",
      },
      { id: "other-fixture-user" },
    ]);
    await assert.rejects(s.authority.refresh(config(), "fixture-secret", previous, signal()), {
      kind: "authorization_required",
    });
  });
  it("accepts Microsoft's omitted scope as exactly this frozen authorization request scope", async () => {
    const s = setup(await authorizationValues({ scope: undefined }));
    const auth = await s.authority.exchange(config(), "fixture-secret", "code", verifier, signal());
    assert.deepEqual(auth.scopes, [
      "openid",
      "profile",
      "offline_access",
      "User.Read",
      "Mail.Read",
    ]);
  });
  it("accepts omitted refresh scope only from the same explicit configured request", async () => {
    const s = setup([
      { access_token: "fixture-refreshed", token_type: "Bearer", expires_in: 3600 },
      { id: oid, displayName: "Fixture" },
    ]);
    const auth = await s.authority.refresh(config(), "fixture-secret", previous, signal());
    assert.deepEqual(auth.scopes, [
      "openid",
      "profile",
      "offline_access",
      "User.Read",
      "Mail.Read",
    ]);
  });
  for (const [error, kind] of [
    ["temporarily_unavailable", "temporarily_unavailable"],
    ["invalid_scope", "not_configured"],
    ["invalid_grant", "authorization_expired"],
  ])
    it(`preserves the precise OAuth ${error} error instead of invalidating every grant`, async () => {
      const s = setup([new Response(JSON.stringify({ error }), { status: 400 })]);
      await assert.rejects(s.authority.refresh(config(), "fixture-secret", previous, signal()), {
        kind,
      });
      assert.equal(s.calls.length, 1);
    });

  it("never uses an application credential as a personal account static token", async () => {
    const s = setup([]);
    await assert.rejects(s.authority.verifyStatic(config(), "fixture-static-token", signal()), {
      kind: "invalid_input",
    });
    assert.equal(s.calls.length, 0);
  });
  for (const audience of [
    "https://example.test",
    "../common",
    "common/oauth2",
    "",
    "example.onmicrosoft.com",
  ])
    it(`rejects unsafe tenant selector ${JSON.stringify(audience)}`, () => {
      const s = setup([]);
      assert.throws(
        () => s.authority.authorizationUrl(config({ tenantId: audience }), "state", verifier),
        { kind: "not_configured" },
      );
      assert.equal(s.calls.length, 0);
    });
  it("requires profile and openid rather than assuming oid is always present", () => {
    const s = setup([]);
    assert.throws(
      () =>
        s.authority.authorizationUrl(
          config({ scopes: ["openid", "offline_access", "User.Read"] }),
          "state",
          verifier,
        ),
      { kind: "not_configured" },
    );
  });
  it("preserves HTTP 429 rate limiting even when Microsoft's OAuth body says temporarily_unavailable", async () => {
    const s = setup([
      new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 429 }),
    ]);
    await assert.rejects(s.authority.refresh(config(), "fixture-secret", previous, signal()), {
      kind: "rate_limited",
    });
  });
});
