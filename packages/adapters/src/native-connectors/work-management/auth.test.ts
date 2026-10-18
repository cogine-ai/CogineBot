import assert from "node:assert/strict";
import dns from "node:dns";
import type { NativeAppConfig } from "@rakazo/db";
import { afterEach, it as test, vi } from "vitest";
import { NativeActionError } from "../action.js";
import type { NativeAuthorization } from "../authorities.js";
import { WorkManagementAuthorities } from "./auth.js";
import { gitlabOrigin, WORK_MANAGEMENT_METADATA, workManagementBase } from "./metadata.js";

const open: WorkManagementAuthorities[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((a) => a.close()));
});
const signal = () => new AbortController().signal;
const config = (
  appId: keyof typeof WORK_MANAGEMENT_METADATA,
  extra: Record<string, unknown> = {},
  credentialKind = "oauth",
): NativeAppConfig => ({
  id: "fixture-config",
  appId,
  label: "Fixture",
  ownership: "byo",
  credentialKind,
  enabled: true,
  callbackUri: "https://api.example.test/callback",
  revision: 1,
  ciphertext: "opaque",
  secretRecordId: "fixture-secret",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  config: {
    clientId: "fixture-client",
    actor: "user",
    scopes: [...WORK_MANAGEMENT_METADATA[appId].scopes].filter((scope) => scope !== "default"),
    capabilities: [],
    knowledgeBaseIds: [],
    ...extra,
  },
});
function setup(values: Array<unknown | Response | Error>) {
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      assert.ok(values.length, "Unexpected authorization request");
      const value = values.shift();
      if (value instanceof Error) throw value;
      return value instanceof Response ? value : new Response(JSON.stringify(value));
    },
  );
  const authority = new WorkManagementAuthorities({
    fetch,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  open.push(authority);
  return { authority, fetch, values };
}
const token = {
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  token_type: "bearer",
  expires_in: 3600,
};
const asanaInfo = {
  active: true,
  token_type: "bearer",
  scope: "users:read tasks:read",
  client_id: "fixture-client",
  expires_in: 3600,
};
const asanaMe = { data: { gid: "fixture-user", name: "Fixture User" } };
function previous(
  _app: string,
  authority: string,
  tenant: string | null = null,
): NativeAuthorization {
  return {
    tokens: { accessToken: "old-access", refreshToken: "old-refresh" },
    identity: {
      authority,
      subject: "fixture-user",
      tenant,
      displayName: "Fixture User",
      context: { actorType: "user", credentialType: "oauth" },
    },
    scopes: [],
    expiresAt: new Date(0),
  };
}
const failure = (kind: string, uncertain?: boolean) => (e: unknown) =>
  e instanceof NativeActionError &&
  e.kind === kind &&
  (uncertain === undefined || e.options.uncertain === uncertain);

test("Asana exchange permits no scope in token response; token_info alone proves actual scopes", async () => {
  const { authority, fetch } = setup([token, asanaInfo, asanaMe]);
  const result = await authority.exchange(
    config("asana"),
    "fixture-secret",
    "fixture-code",
    "fixture-verifier",
    signal(),
  );
  assert.deepEqual(result.scopes, ["users:read", "tasks:read"]);
  assert.equal(result.identity.subject, "fixture-user");
  assert.equal(String(fetch.mock.calls[1]![0]), "https://app.asana.com/-/token_info");
});
test("Asana refresh permits no token response scope and preserves the documented nonrotating refresh token", async () => {
  const { refresh_token: _unused, ...withoutRefresh } = token;
  const { authority } = setup([withoutRefresh, asanaInfo, asanaMe]);
  const result = await authority.refresh(
    config("asana"),
    "fixture-secret",
    previous("asana", "https://app.asana.com"),
    signal(),
  );
  assert.deepEqual(result.scopes, ["users:read", "tasks:read"]);
  assert.equal(result.tokens.refreshToken, "old-refresh");
});
for (const [name, info] of [
  ["missing actual scope", { ...asanaInfo, scope: undefined }],
  ["inactive token", { ...asanaInfo, active: false }],
  ["wrong client", { ...asanaInfo, client_id: "another-client" }],
] as const)
  test(`Asana ${name} after exchange fails closed and marks consumed-code uncertainty`, async () => {
    const { authority } = setup([{ ...token, scope: "users:read tasks:read" }, info]);
    await assert.rejects(
      authority.exchange(
        config("asana"),
        "fixture-secret",
        "fixture-code",
        "fixture-verifier",
        signal(),
      ),
      (e: unknown) => e instanceof NativeActionError && e.options.uncertain === true,
    );
  });

const gitlabUser = {
  id: 42,
  name: "Fixture User",
  username: "fixture",
  state: "active",
  bot: false,
};
const gitlabInfo = {
  resource_owner_id: 42,
  scope: ["read_api"],
  application: { uid: "fixture-client" },
};
test("GitLab scopes come from token introspection, not requested configuration or token response", async () => {
  const { authority, fetch } = setup([token, gitlabUser, gitlabInfo]);
  const result = await authority.exchange(
    config("gitlab", { endpoint: "https://gitlab.example.test" }),
    "fixture-secret",
    "fixture-code",
    "fixture-verifier",
    signal(),
  );
  assert.deepEqual(result.scopes, ["read_api"]);
  assert.equal(result.identity.authority, "https://gitlab.example.test");
  assert.deepEqual(
    fetch.mock.calls.map((c) => String(c[0])),
    [
      "https://gitlab.example.test/oauth/token",
      "https://gitlab.example.test/api/v4/user",
      "https://gitlab.example.test/oauth/token/info",
    ],
  );
});
test("GitLab refresh replaces the old pair and uses the original callback", async () => {
  const { authority, fetch } = setup([token, gitlabUser, gitlabInfo]);
  const old = previous("gitlab", "https://gitlab.com");
  old.identity.subject = "42";
  const result = await authority.refresh(config("gitlab"), "fixture-secret", old, signal());
  assert.equal(result.tokens.refreshToken, "fixture-refresh");
  assert.notEqual(result.tokens.accessToken, old.tokens.accessToken);
  assert.equal(
    new URLSearchParams(String(fetch.mock.calls[0]![1]?.body)).get("redirect_uri"),
    "https://api.example.test/callback",
  );
});
for (const [name, info] of [
  ["wrong app", { ...gitlabInfo, application: { uid: "another-client" } }],
  ["wrong owner", { ...gitlabInfo, resource_owner_id: 43 }],
  ["missing scope", { ...gitlabInfo, scope: undefined }],
] as const)
  test(`GitLab ${name} cannot adopt exchanged tokens`, async () => {
    const { authority } = setup([token, gitlabUser, info]);
    await assert.rejects(
      authority.exchange(
        config("gitlab"),
        "fixture-secret",
        "fixture-code",
        "fixture-verifier",
        signal(),
      ),
      (e: unknown) => e instanceof NativeActionError && e.options.uncertain === true,
    );
  });
test("GitLab PAT verifies token state, actual scopes and owner", async () => {
  const { authority } = setup([
    gitlabUser,
    { user_id: 42, scopes: ["api"], active: true, revoked: false, expires_at: null },
  ]);
  const result = await authority.verifyStatic(
    config("gitlab", {}, "personal_token"),
    "fixture-personal",
    signal(),
  );
  assert.deepEqual(result.scopes, ["api"]);
  assert.equal(result.tokens.refreshToken, null);
  assert.equal(result.identity.subject, "42");
});
for (const info of [
  { user_id: 43, scopes: ["api"], active: true, revoked: false },
  { user_id: 42, scopes: ["api"], active: false, revoked: false },
  { user_id: 42, scopes: ["api"], active: true, revoked: true },
])
  test(`GitLab invalid PAT ${JSON.stringify(info)} rejected`, async () => {
    const { authority } = setup([gitlabUser, info]);
    await assert.rejects(
      authority.verifyStatic(config("gitlab", {}, "personal_token"), "fixture-personal", signal()),
      failure("authorization_required"),
    );
  });

const site = (id: string, scopes: string[]) => ({
  id,
  name: "Fixture Site",
  url: "https://fixture.atlassian.net",
  scopes,
});
const atlassianMe = { account_id: "fixture-user", name: "Fixture User" };
for (const app of ["jira", "confluence"] as const) {
  const scope = app === "jira" ? "read:jira-work" : "read:page:confluence";
  test(`${app} exact selected site and its actual scopes are verified, never first-site fallback`, async () => {
    const { authority } = setup([
      { ...token, scope: `read:me offline_access ${scope} write:ungranted` },
      [site("another-cloud", [scope]), site("fixture-cloud", [scope])],
      atlassianMe,
    ]);
    const result = await authority.exchange(
      config(app, { tenantId: "fixture-cloud" }),
      "fixture-secret",
      "fixture-code",
      "fixture-verifier",
      signal(),
    );
    assert.equal(result.identity.tenant, "fixture-cloud");
    assert.deepEqual(result.scopes, ["read:me", "offline_access", scope]);
    assert.equal(
      workManagementBase(config(app), result.identity.tenant),
      `https://api.atlassian.com/ex/${app}/fixture-cloud`,
    );
  });
  test(`${app} missing configured site fails before token dispatch`, async () => {
    const { authority, fetch } = setup([]);
    await assert.rejects(
      authority.exchange(
        config(app),
        "fixture-secret",
        "fixture-code",
        "fixture-verifier",
        signal(),
      ),
      failure("not_configured"),
    );
    assert.equal(fetch.mock.calls.length, 0);
  });
  test(`${app} absent selected resource is not replaced by another authorized site`, async () => {
    const { authority } = setup([{ ...token, scope }, [site("another-cloud", [scope])]]);
    await assert.rejects(
      authority.exchange(
        config(app, { tenantId: "fixture-cloud" }),
        "fixture-secret",
        "fixture-code",
        "fixture-verifier",
        signal(),
      ),
      failure("authorization_required", true),
    );
  });
  test(`${app} refresh rotates pair while preserving account and selected site`, async () => {
    const { authority } = setup([
      { ...token, scope },
      [site("fixture-cloud", [scope])],
      atlassianMe,
    ]);
    const result = await authority.refresh(
      config(app, { tenantId: "fixture-cloud" }),
      "fixture-secret",
      previous(app, "https://auth.atlassian.com", "fixture-cloud"),
      signal(),
    );
    assert.equal(result.tokens.refreshToken, "fixture-refresh");
  });
}

const todoistMe = { id: "fixture-user", full_name: "Fixture User" };
test("Todoist current OAuth exchange and refresh require actual scopes and replacement refresh token", async () => {
  const { authority, fetch } = setup([
    { ...token, scope: "data:read" },
    todoistMe,
    { ...token, scope: "data:read_write" },
    todoistMe,
  ]);
  const initial = await authority.exchange(
    config("todoist"),
    "fixture-secret",
    "fixture-code",
    "fixture-verifier",
    signal(),
  );
  assert.deepEqual(initial.scopes, ["data:read"]);
  const result = await authority.refresh(config("todoist"), "fixture-secret", initial, signal());
  assert.deepEqual(result.scopes, ["data:read_write"]);
  assert.equal(result.tokens.refreshToken, "fixture-refresh");
  assert.equal(String(fetch.mock.calls[0]![0]), "https://api.todoist.com/oauth/access_token");
});
test("Todoist legacy 10-year compatibility token is distinct from missing replacement refresh", async () => {
  const { refresh_token: _unused, ...withoutRefresh } = token;
  const { authority } = setup([
    { ...withoutRefresh, expires_in: 315360000, scope: "data:read" },
    todoistMe,
  ]);
  const result = await authority.exchange(
    config("todoist"),
    "fixture-secret",
    "fixture-code",
    "fixture-verifier",
    signal(),
  );
  assert.equal(result.tokens.refreshToken, null);
  assert.ok(result.expiresAt);
});
test("Todoist modern exchange cannot silently adopt a short-lived token with no refresh", async () => {
  const { refresh_token: _unused, ...withoutRefresh } = token;
  const { authority } = setup([{ ...withoutRefresh, scope: "data:read" }]);
  await assert.rejects(
    authority.exchange(
      config("todoist"),
      "fixture-secret",
      "fixture-code",
      "fixture-verifier",
      signal(),
    ),
    failure("authorization_required", true),
  );
});
test("Todoist grace-window response with no replacement refresh cannot reuse old consumed token", async () => {
  const { refresh_token: _unused, ...withoutRefresh } = token;
  const { authority, fetch } = setup([{ ...withoutRefresh, scope: "data:read" }]);
  await assert.rejects(
    authority.refresh(
      config("todoist"),
      "fixture-secret",
      previous("todoist", "https://app.todoist.com"),
      signal(),
    ),
    failure("authorization_required", true),
  );
  assert.equal(fetch.mock.calls.length, 1);
});
test("Todoist PAT establishes real user identity without invented OAuth scopes", async () => {
  const { authority } = setup([todoistMe]);
  const result = await authority.verifyStatic(
    config("todoist", {}, "personal_token"),
    "fixture-personal",
    signal(),
  );
  assert.deepEqual(result.scopes, []);
  assert.equal(result.identity.subject, "fixture-user");
  assert.equal(result.identity.context.credentialType, "personal_token");
});

test("Trello uses documented canonical token endpoint once with PKCE and then Bearer member proof", async () => {
  const { token_type: _unused, ...withoutType } = token;
  const { authority, fetch } = setup([
    { ...withoutType, scope: "read:member:trello read:board:trello offline_access" },
    { id: "fixture-user", fullName: "Fixture User" },
  ]);
  const cfg = config("trello");
  const url = new URL(authority.authorizationUrl(cfg, "fixture-state", "fixture-verifier"));
  assert.equal(url.origin + url.pathname, "https://auth.atlassian.com/authorize");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "fixture-state");
  const result = await authority.exchange(
    cfg,
    "fixture-secret",
    "fixture-code",
    "fixture-verifier",
    signal(),
  );
  assert.equal(result.identity.subject, "fixture-user");
  assert.equal(String(fetch.mock.calls[0]![0]), "https://auth.atlassian.com/oauth/token");
  assert.equal(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).code_verifier, "fixture-verifier");
  assert.equal(
    new Headers(fetch.mock.calls[1]![1]?.headers).get("Authorization"),
    "Bearer fixture-access",
  );
});
test("Trello canonical endpoint rejection never probes the contradictory prose endpoint", async () => {
  const { authority, fetch } = setup([
    new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 }),
  ]);
  await assert.rejects(
    authority.exchange(
      config("trello"),
      "fixture-secret",
      "fixture-code",
      "fixture-verifier",
      signal(),
    ),
    failure("not_configured"),
  );
  assert.equal(fetch.mock.calls.length, 1);
});
test("Trello refresh requires a rotated refresh token and preserves verified member", async () => {
  const { authority } = setup([
    { ...token, scope: "read:member:trello read:board:trello" },
    { id: "fixture-user", fullName: "Fixture User" },
  ]);
  const result = await authority.refresh(
    config("trello"),
    "fixture-secret",
    previous("trello", "https://trello.com"),
    signal(),
  );
  assert.equal(result.tokens.refreshToken, "fixture-refresh");
});
for (const app of ["gitlab", "jira", "confluence", "todoist", "trello", "asana"] as const) {
  test(`${app} token transport loss is uncertain and not automatically retried`, async () => {
    const { authority, fetch } = setup([Error("Fixture response loss")]);
    await assert.rejects(
      authority.refresh(
        config(app, {
          ...(["jira", "confluence"].includes(app) ? { tenantId: "fixture-cloud" } : {}),
        }),
        "fixture-secret",
        previous(app, "https://fixture.example"),
        signal(),
      ),
      failure("temporarily_unavailable", true),
    );
    assert.equal(fetch.mock.calls.length, 1);
  });
  test(`${app} explicit invalid_grant is definite expiration`, async () => {
    const { authority } = setup([
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    ]);
    await assert.rejects(
      authority.refresh(
        config(app, {
          ...(["jira", "confluence"].includes(app) ? { tenantId: "fixture-cloud" } : {}),
        }),
        "fixture-secret",
        previous(app, "https://fixture.example"),
        signal(),
      ),
      failure("authorization_expired", false),
    );
  });
}
test("Untrusted GitLab origin shapes are rejected before any network call", () => {
  for (const endpoint of [
    "http://gitlab.example.test",
    "https://person:secret@gitlab.example.test",
    "https://gitlab.example.test/prefix",
    "https://gitlab.example.test?token=forbidden",
    "https://gitlab.example.test/#fragment",
  ])
    assert.throws(() => gitlabOrigin(config("gitlab", { endpoint })), failure("not_configured"));
});
test("Private GitLab address remains blocked by existing DNS-pinned transport policy", async () => {
  const fetch = vi.fn(async () => new Response("{}"));
  const authority = new WorkManagementAuthorities({
    fetch,
    resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  open.push(authority);
  await assert.rejects(
    authority.verifyStatic(
      config("gitlab", { endpoint: "https://gitlab.example.test" }, "personal_token"),
      "fixture-personal",
      signal(),
    ),
    failure("temporarily_unavailable"),
  );
  assert.equal(fetch.mock.calls.length, 0);
});
test("Explicit private GitLab authority preserves TLS host and pins the already-validated private DNS address", async () => {
  let calls = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URL(String(input)).hostname, "gitlab.example.test");
    assert.equal(init?.redirect, "manual");
    const found = await new Promise<{ address: string; family: number }>((resolve, reject) =>
      dns.lookup("gitlab.example.test", { family: 4 }, (error, address, family) =>
        error ? reject(error) : resolve({ address, family }),
      ),
    );
    assert.deepEqual(found, { address: "10.20.30.40", family: 4 });
    return new Response(
      JSON.stringify(
        calls++ === 0
          ? gitlabUser
          : { user_id: 42, scopes: ["read_api"], active: true, revoked: false, expires_at: null },
      ),
    );
  });
  const authority = new WorkManagementAuthorities(
    { fetch, resolveHostname: async () => [{ address: "10.20.30.40", family: 4 }] },
    true,
  );
  open.push(authority);
  const result = await authority.verifyStatic(
    config("gitlab", { endpoint: "https://gitlab.example.test" }, "personal_token"),
    "fixture-personal",
    signal(),
  );
  assert.equal(result.identity.subject, "42");
  assert.equal(fetch.mock.calls.length, 2);
});
test("Private authority instance cannot be used for SaaS even when caller dispatches incorrectly", async () => {
  const fetch = vi.fn(async () => new Response("{}"));
  const authority = new WorkManagementAuthorities(
    { fetch, resolveHostname: async () => [{ address: "10.20.30.40", family: 4 }] },
    true,
  );
  open.push(authority);
  await assert.rejects(
    authority.verifyStatic(config("asana", {}, "personal_token"), "fixture-personal", signal()),
    failure("not_configured"),
  );
  assert.equal(fetch.mock.calls.length, 0);
});

test("Asana actual Full permissions stays default and is never expanded into granular scopes", async () => {
  const { authority } = setup([{ ...asanaInfo, scope: "default", client_id: undefined }, asanaMe]);
  const result = await authority.verifyStatic(
    config("asana", { scopes: ["default"] }, "personal_token"),
    "fixture-personal",
    signal(),
  );
  assert.deepEqual(result.scopes, ["default"]);
});
test("Asana rejects mixed Full permissions and granular requested configuration", async () => {
  const { authority, fetch } = setup([]);
  await assert.rejects(
    authority.exchange(
      config("asana", { scopes: ["default", "tasks:read"] }),
      "fixture-secret",
      "fixture-code",
      "fixture-verifier",
      signal(),
    ),
    failure("not_configured"),
  );
  assert.equal(fetch.mock.calls.length, 0);
});
