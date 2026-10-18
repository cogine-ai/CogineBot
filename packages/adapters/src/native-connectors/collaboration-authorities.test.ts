import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import type { NativeAppConfig } from "@rakazo/db";
import { afterEach, it as test, vi } from "vitest";
import { NativeActionError } from "./action.js";
import type { NativeAuthorization } from "./authorities.js";
import { CollaborationOAuthAuthorities } from "./collaboration-authorities.js";

const authorities: CollaborationOAuthAuthorities[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(authorities.splice(0).map((a) => a.close()));
});
const signal = () => new AbortController().signal;
const config = (
  appId: string,
  actor: string,
  credentialKind = "oauth",
  extra = {},
): NativeAppConfig => ({
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
    actor,
    scopes:
      appId === "linear"
        ? ["read", "comments:create"]
        : appId === "slack"
          ? ["chat:write"]
          : ["offline_access"],
    capabilities: [],
    knowledgeBaseIds: [],
    ...extra,
  },
});
function setup(values: Array<unknown | Response | Error>) {
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      assert.ok(values.length, "Unexpected protocol request");
      const value = values.shift();
      if (value instanceof Error) throw value;
      return value instanceof Response ? value : new Response(JSON.stringify(value));
    },
  );
  const authority = new CollaborationOAuthAuthorities({
    fetch,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  authorities.push(authority);
  return { authority, fetch };
}
const ghUser = { id: 123, type: "User", login: "fixture-user" };
const ghToken = {
  access_token: "ghu_fixture-access",
  refresh_token: "ghr_fixture-refresh",
  token_type: "bearer",
  expires_in: 28800,
  scope: "",
};
const linearMe = (app = false, organizationId = "fixture-org") => ({
  data: {
    viewer: {
      id: "fixture-viewer",
      name: "Fixture",
      app,
      organization: { id: organizationId, name: "Fixture org" },
    },
  },
});
const linearToken = {
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  token_type: "Bearer",
  expires_in: 86399,
  scope: "read comments:create",
};
const slackMe = (bot = true, teamId = "T123FIXTURE") => ({
  ok: true,
  team_id: teamId,
  user_id: bot ? "UBOTFIXTURE" : "UUSERFIXTURE",
  user: "fixture",
  ...(bot ? { bot_id: "B123FIXTURE" } : {}),
});
const slackToken = {
  ok: true,
  token_type: "bot",
  access_token: "xoxe.xoxb-fixture",
  refresh_token: "fixture-bot-refresh",
  expires_in: 43200,
  scope: "chat:write",
  bot_user_id: "UBOTFIXTURE",
  team: { id: "T123FIXTURE" },
  authed_user: {
    id: "UUSERFIXTURE",
    token_type: "user",
    access_token: "xoxe.xoxp-fixture",
    refresh_token: "fixture-user-refresh",
    expires_in: 43200,
    scope: "search:read,files:read",
  },
};
const failure = (kind: string) => (e: unknown) => e instanceof NativeActionError && e.kind === kind;
const uncertain = (e: unknown) => e instanceof NativeActionError && e.options.uncertain === true;
const previous = (
  app: string,
  actorType: string,
  tokens = { accessToken: "old-access", refreshToken: "old-refresh" },
): NativeAuthorization => ({
  tokens,
  identity: {
    authority:
      app === "github"
        ? "https://github.com"
        : app === "slack"
          ? "https://slack.com"
          : "https://linear.app",
    subject: app === "github" ? "123" : app === "slack" ? "UBOTFIXTURE" : "fixture-viewer",
    tenant: app === "github" ? null : app === "slack" ? "T123FIXTURE" : "fixture-org",
    displayName: "Fixture",
    context: app === "slack" ? { tokenType: actorType } : { actorType },
  },
  scopes: [],
  expiresAt: new Date(0),
});

test("GitHub App URL freezes S256, state, callback and only offline_access", () => {
  const { authority } = setup([]),
    url = new URL(
      authority.authorizationUrl(config("github", "user"), "fixture-state", "fixture-verifier"),
    );
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("scope"), "offline_access");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "fixture-state");
  assert.equal(url.searchParams.get("code_verifier"), null);
  assert.equal(url.searchParams.get("client_secret"), null);
});
test("GitHub App user exchange verifies remote identity and has no fabricated permission scopes", async () => {
  const { authority, fetch } = setup([ghToken, ghUser]);
  const auth = await authority.exchange(
    config("github", "user"),
    "fixture-secret",
    "fixture-code",
    "fixture-verifier",
    signal(),
  );
  assert.equal(auth.identity.subject, "123");
  assert.deepEqual(auth.scopes, []);
  assert.equal(auth.tokens.refreshToken, "ghr_fixture-refresh");
  const body = new URLSearchParams(String(fetch.mock.calls[0]![1]!.body));
  assert.equal(body.get("code_verifier"), "fixture-verifier");
  assert.equal(body.get("redirect_uri"), config("github", "user").callbackUri);
});
test("GitHub App user refresh rotates pair and checks unchanged subject", async () => {
  const { authority, fetch } = setup([ghToken, ghUser]);
  const auth = await authority.refresh(
    config("github", "user"),
    "fixture-secret",
    previous("github", "user"),
    signal(),
  );
  assert.equal(auth.tokens.accessToken, "ghu_fixture-access");
  assert.equal(
    new URLSearchParams(String(fetch.mock.calls[0]![1]!.body)).get("grant_type"),
    "refresh_token",
  );
  const other = setup([ghToken, { ...ghUser, id: 999 }]);
  await assert.rejects(
    other.authority.refresh(
      config("github", "user"),
      "fixture-secret",
      previous("github", "user"),
      signal(),
    ),
    uncertain,
  );
});
test("GitHub fine-grained PAT checks /user and never infers permissions from headers", async () => {
  const { authority } = setup([
    new Response(JSON.stringify(ghUser), {
      headers: { "x-accepted-github-permissions": "issues=write" },
    }),
  ]);
  const auth = await authority.verifyStatic(
    config("github", "user", "personal_token"),
    "github_pat_fixture000000",
    signal(),
  );
  assert.equal(auth.identity.context.actorType, "fine_grained_pat");
  assert.deepEqual(auth.scopes, []);
  assert.equal(auth.identity.context.githubPermissions, undefined);
});
test("GitHub classic token and token-to-org identity are refused", async () => {
  const { authority } = setup([]);
  await assert.rejects(
    authority.verifyStatic(
      config("github", "user", "personal_token"),
      "ghp_fixture0000000000",
      signal(),
    ),
    failure("invalid_input"),
  );
  const other = setup([{ ...ghUser, type: "Organization" }]);
  await assert.rejects(
    other.authority.verifyStatic(
      config("github", "user", "personal_token"),
      "github_pat_fixture000000",
      signal(),
    ),
    failure("authorization_required"),
  );
});
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const installationInput = { appId: "42", installationId: "88", privateKeyPem };
const installBody = {
  id: 88,
  app_id: 42,
  account: { id: 77, login: "fixture-org" },
  suspended_at: null,
};
function installationResponses() {
  return [
    { id: 42 },
    installBody,
    {
      token: "ghs_fixture-access",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      permissions: { issues: "write", metadata: "read", contents: "read" },
    },
  ];
}
test("GitHub installation proves private key/app/install and issues short-lived token", async () => {
  const { authority, fetch } = setup(installationResponses()),
    cfg = config("github", "installation", "github_app_installation", {
      githubAppId: "42",
      githubInstallationId: "88",
    });
  const auth = await authority.verifyStatic(cfg, JSON.stringify(installationInput), signal());
  assert.equal(auth.identity.subject, "installation:88");
  assert.equal(auth.identity.tenant, "77");
  assert.deepEqual(auth.identity.context.githubPermissions, {
    issues: "write",
    metadata: "read",
    contents: "read",
  });
  assert.equal(auth.tokens.githubInstallation!.privateKeyPem, privateKeyPem);
  assert.equal(JSON.stringify(auth.identity).includes("PRIVATE KEY"), false);
  const header = new Headers(fetch.mock.calls[0]![1]!.headers).get("authorization")!,
    jwt = header.slice(7),
    pieces = jwt.split(".");
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${pieces[0]}.${pieces[1]}`),
      key.publicKey,
      Buffer.from(pieces[2]!, "base64url"),
    ),
    true,
  );
  const claims = JSON.parse(Buffer.from(pieces[1]!, "base64url").toString());
  assert.equal(claims.iss, "42");
  assert.equal(claims.exp - claims.iat, 600);
  assert.equal(
    String(fetch.mock.calls[2]![0]),
    "https://api.github.com/app/installations/88/access_tokens",
  );
});
test("GitHub installation refresh remints from encrypted key without refresh_token", async () => {
  const cfg = config("github", "installation", "github_app_installation", {
    githubAppId: "42",
    githubInstallationId: "88",
  });
  const first = setup(installationResponses());
  const old = await first.authority.verifyStatic(cfg, JSON.stringify(installationInput), signal());
  const second = setup(installationResponses());
  const next = await second.authority.refresh(cfg, "unused", old, signal());
  assert.equal(next.identity.subject, old.identity.subject);
  assert.equal(next.tokens.refreshToken, null);
  assert.equal(second.fetch.mock.calls.length, 3);
});
test("GitHub installation cannot be minted from visible ID or mismatched key/app", async () => {
  const cfg = config("github", "installation", "github_app_installation");
  const { authority, fetch } = setup([]);
  await assert.rejects(
    authority.verifyStatic(cfg, JSON.stringify({ appId: "42", installationId: "88" }), signal()),
    failure("incomplete_response"),
  );
  assert.equal(fetch.mock.calls.length, 0);
  const mismatch = setup([{ id: 99 }]);
  await assert.rejects(
    mismatch.authority.verifyStatic(cfg, JSON.stringify(installationInput), signal()),
    failure("authorization_required"),
  );
  assert.equal(mismatch.fetch.mock.calls.length, 1);
});
test("GitHub install suspension is checked before mint", async () => {
  const { authority, fetch } = setup([
    { id: 42 },
    { ...installBody, suspended_at: "2026-01-01T00:00:00Z" },
  ]);
  await assert.rejects(
    authority.verifyStatic(
      config("github", "installation", "github_app_installation"),
      JSON.stringify(installationInput),
      signal(),
    ),
    failure("authorization_required"),
  );
  assert.equal(fetch.mock.calls.length, 2);
});
test("Linear URL fixes user/app actor and S256 rather than impersonation fields", () => {
  const { authority } = setup([]);
  const url = new URL(
    authority.authorizationUrl(config("linear", "app"), "fixture-state", "fixture-verifier"),
  );
  assert.equal(url.searchParams.get("actor"), "app");
  assert.equal(url.searchParams.get("scope"), "read,comments:create");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.has("createAsUser"), false);
});
test("Linear OAuth exchange verifies viewer.app and organization", async () => {
  const { authority, fetch } = setup([linearToken, linearMe(true)]);
  const auth = await authority.exchange(
    config("linear", "app"),
    "fixture-secret",
    "fixture-code",
    "fixture-verifier",
    signal(),
  );
  assert.equal(auth.identity.context.actorType, "app");
  assert.equal(auth.identity.tenant, "fixture-org");
  assert.deepEqual(auth.scopes, ["read", "comments:create"]);
  assert.equal(
    new Headers(fetch.mock.calls[1]![1]!.headers).get("authorization"),
    "Bearer fixture-access",
  );
});
test("Linear API key uses raw Authorization and explicit user actor", async () => {
  const { authority, fetch } = setup([linearMe(false)]);
  const auth = await authority.verifyStatic(
    config("linear", "user", "personal_token"),
    "fixture-api-key",
    signal(),
  );
  assert.equal(
    new Headers(fetch.mock.calls[0]![1]!.headers).get("authorization"),
    "fixture-api-key",
  );
  assert.deepEqual(auth.scopes, []);
  assert.equal(auth.identity.context.credentialType, "api_key");
});
test("Linear rejects actor/workspace mismatch and partial identity response", async () => {
  for (const body of [
    linearMe(true),
    linearMe(false, "other-org"),
    { ...linearMe(false), errors: [{ message: "Fixture partial" }] },
  ]) {
    const { authority } = setup([body]);
    await assert.rejects(
      authority.verifyStatic(
        config("linear", "user", "personal_token", { tenantId: "fixture-org" }),
        "fixture-key",
        signal(),
      ),
    );
  }
});
test("Linear refresh retains rotation grace only as recovery evidence", async () => {
  const success = setup([linearToken, linearMe(false)]);
  const auth = await success.authority.refresh(
    config("linear", "user"),
    "fixture-secret",
    previous("linear", "user"),
    signal(),
  );
  assert.equal(auth.tokens.refreshToken, "fixture-refresh");
  const lost = setup([Error("Fixture lost refresh")]);
  await assert.rejects(
    lost.authority.refresh(
      config("linear", "user"),
      "fixture-secret",
      previous("linear", "user"),
      signal(),
    ),
    (e) =>
      uncertain(e) &&
      (e as NativeActionError).options.recovery!.refresh_replay_grace_seconds === 1800,
  );
  assert.equal(lost.fetch.mock.calls.length, 1);
});
test("Slack OAuth never mixes bot/user scopes in authorize URL", () => {
  const { authority } = setup([]);
  for (const selected of ["bot", "user"]) {
    const url = new URL(
      authority.authorizationUrl(config("slack", selected), "fixture-state", "unused"),
    );
    assert.equal(url.searchParams.has(selected === "bot" ? "scope" : "user_scope"), true);
    assert.equal(url.searchParams.has(selected === "bot" ? "user_scope" : "scope"), false);
    assert.equal(url.searchParams.get("code_challenge"), null);
  }
});
test("Slack OAuth requires HTTPS and does not assume org-wide target", () => {
  const { authority } = setup([]);
  const cfg = config("slack", "bot");
  cfg.callbackUri = "http://localhost:1234/callback";
  assert.throws(
    () => authority.authorizationUrl(cfg, "fixture-state", "unused"),
    failure("not_configured"),
  );
});
test("Slack bot exchange selects only bot pair and verifies bot actor", async () => {
  const { authority, fetch } = setup([slackToken, slackMe(true)]);
  const auth = await authority.exchange(
    config("slack", "bot"),
    "fixture-secret",
    "fixture-code",
    "unused",
    signal(),
  );
  assert.equal(auth.tokens.accessToken, slackToken.access_token);
  assert.equal(auth.tokens.refreshToken, "fixture-bot-refresh");
  assert.deepEqual(auth.scopes, ["chat:write"]);
  assert.equal(auth.identity.subject, "UBOTFIXTURE");
  assert.equal(JSON.stringify(auth).includes("fixture-user-refresh"), false);
  assert.equal(
    new Headers(fetch.mock.calls[0]![1]!.headers).get("authorization"),
    `Basic ${Buffer.from("fixture-client:fixture-secret").toString("base64")}`,
  );
});
test("Slack user exchange selects authed_user pair and policy capability explicitly", async () => {
  const { authority } = setup([slackToken, slackMe(false)]);
  const auth = await authority.exchange(
    config("slack", "user", "oauth", {
      capabilities: ["slack_user_data_allowed", "slack_legacy_search_allowed"],
    }),
    "fixture-secret",
    "fixture-code",
    "unused",
    signal(),
  );
  assert.equal(auth.tokens.accessToken, slackToken.authed_user.access_token);
  assert.equal(auth.tokens.refreshToken, "fixture-user-refresh");
  assert.deepEqual(auth.scopes, ["search:read", "files:read"]);
  assert.equal(auth.identity.context.slackUserDataAllowed, true);
  assert.equal(JSON.stringify(auth).includes("fixture-bot-refresh"), false);
});
test("Slack exchange rejects wrong bot/user, team and enterprise instead of using hints", async () => {
  for (const [body, me] of [
    [slackToken, slackMe(false)],
    [{ ...slackToken, team: { id: "TOTHER" } }, slackMe(true)],
    [{ ...slackToken, enterprise: { id: "EOTHER" } }, slackMe(true)],
  ]) {
    const { authority } = setup([body, me]);
    await assert.rejects(
      authority.exchange(
        config("slack", "bot"),
        "fixture-secret",
        "fixture-code",
        "unused",
        signal(),
      ),
      failure("authorization_required"),
    );
  }
});
test("Slack user refresh accepts one top-level user pair and checks original actor", async () => {
  const { authority } = setup([{ ok: true, ...slackToken.authed_user }, slackMe(false)]);
  const old = previous("slack", "user");
  old.identity.subject = "UUSERFIXTURE";
  const auth = await authority.refresh(config("slack", "user"), "fixture-secret", old, signal());
  assert.equal(auth.tokens.refreshToken, "fixture-user-refresh");
  assert.equal(auth.identity.subject, "UUSERFIXTURE");
});
test("Slack static bot verification reads actual scope header and never config scopes", async () => {
  const { authority } = setup([
    new Response(JSON.stringify(slackMe(true)), {
      headers: { "x-oauth-scopes": "chat:write,channels:read" },
    }),
  ]);
  const auth = await authority.verifyStatic(
    config("slack", "bot", "bot_token"),
    "xoxb-fixture-token",
    signal(),
  );
  assert.deepEqual(auth.scopes, ["chat:write", "channels:read"]);
});
test("Slack static credentials cannot mix bot/user or silently omit scope evidence", async () => {
  const { authority, fetch } = setup([]);
  await assert.rejects(
    authority.verifyStatic(
      config("slack", "user", "personal_token"),
      "xoxb-fixture-token",
      signal(),
    ),
    failure("invalid_input"),
  );
  assert.equal(fetch.mock.calls.length, 0);
  const missing = setup([slackMe(true)]);
  await assert.rejects(
    missing.authority.verifyStatic(
      config("slack", "bot", "bot_token"),
      "xoxb-fixture-token",
      signal(),
    ),
    failure("incomplete_response"),
  );
});
test("Rotating provider missing new token/lifetime or lost identity is uncertain", async () => {
  const noRefresh = setup([{ ...linearToken, refresh_token: undefined }]);
  await assert.rejects(
    noRefresh.authority.refresh(
      config("linear", "user"),
      "fixture-secret",
      previous("linear", "user"),
      signal(),
    ),
    uncertain,
  );
  const noExpiry = setup([{ ...ghToken, expires_in: undefined }]);
  await assert.rejects(
    noExpiry.authority.refresh(
      config("github", "user"),
      "fixture-secret",
      previous("github", "user"),
      signal(),
    ),
    uncertain,
  );
  const identityLost = setup([slackToken, Error("Fixture identity lost")]);
  await assert.rejects(
    identityLost.authority.refresh(
      config("slack", "bot"),
      "fixture-secret",
      previous("slack", "bot"),
      signal(),
    ),
    uncertain,
  );
});
test("Authorization errors remain generic, redirects and partial JSON never accepted", async () => {
  for (const body of [
    new Response("{}", { status: 302, headers: { location: "https://untrusted.example.test/" } }),
    new Response("{fixture-secret", { status: 200 }),
    new Response(JSON.stringify({ error: "invalid_client", error_description: "fixture-secret" }), {
      status: 400,
    }),
  ]) {
    const { authority, fetch } = setup([body]);
    await assert.rejects(
      authority.exchange(
        config("github", "user"),
        "fixture-secret",
        "fixture-code",
        "verifier",
        signal(),
      ),
      (e) => e instanceof NativeActionError && !e.message.includes("fixture-secret"),
    );
    assert.equal(fetch.mock.calls.length, 1);
  }
});
