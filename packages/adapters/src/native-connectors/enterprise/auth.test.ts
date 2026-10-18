import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { NativeAppConfig } from "@rakazo/db";
import { afterEach, describe, it } from "vitest";
import { NativeActionError } from "../action.js";
import { EnterpriseAuthorities } from "./auth.js";

const instances: EnterpriseAuthorities[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((a) => a.close()));
});
const signal = () => AbortSignal.timeout(10000),
  verifier = "fixture-pkce-0123456789abcdefghijklmnopqrstuvwxyz",
  owner = JSON.stringify({
    version: 1,
    clientSecret: "fixture-secret",
    suiteTicket: { value: "fixture-ticket", issuedAt: Math.floor(Date.now() / 1000) },
  });
function config(
  appId = "feishu-lark",
  extra: Record<string, unknown> = {},
  kind = "oauth",
): NativeAppConfig {
  return {
    id: "cfg-fixture",
    appId,
    label: "Fixture",
    ownership: "byo",
    credentialKind: kind,
    enabled: true,
    callbackUri: "https://api.example.test/callback",
    revision: 1,
    ciphertext: "opaque",
    secretRecordId: "fixture",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    config: {
      clientId: "client-fixture",
      tenantId: "corp-fixture",
      agentId: "1000001",
      actor: kind === "oauth" && appId !== "wecom" ? "user" : "app",
      region: "feishu",
      scopes: ["offline_access", "contact:user.base:readonly"],
      capabilities: [],
      knowledgeBaseIds: [],
      boundSpaceId: "space-fixture",
      ...extra,
    },
  } as NativeAppConfig;
}
function setup(values: Array<unknown | Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const authority = new EnterpriseAuthorities({
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      assert.ok(values.length, "Unexpected enterprise auth request");
      const next = values.shift();
      if (next instanceof Error) throw next;
      return next instanceof Response ? next : new Response(JSON.stringify(next));
    },
  });
  instances.push(authority);
  return { authority, calls, values };
}
const feishuToken = {
    access_token: "fixture-access",
    refresh_token: "fixture-refresh",
    expires_in: 7200,
    scope: "contact:user.base:readonly offline_access",
  },
  feishuUser = {
    code: 0,
    data: { open_id: "user-fixture", tenant_key: "corp-fixture", name: "Fixture" },
  };
const dingToken = {
    accessToken: "fixture-access",
    refreshToken: "fixture-refresh",
    expireIn: 7200,
    corpId: "corp-fixture",
  },
  dingUser = { unionId: "union-fixture", nick: "Fixture" };
const suite = { suite_access_token: "fixture-suite", expires_in: 7200 },
  installed = {
    permanent_code: "fixture-permanent",
    auth_corp_info: { corpid: "corp-fixture" },
    auth_info: { agent: [{ agentid: 1000001 }] },
  },
  authInfo = {
    auth_corp_info: { corpid: "corp-fixture" },
    auth_info: { agent: [{ agentid: 1000001 }] },
  },
  corpToken = { access_token: "fixture-corp", expires_in: 7200 };
const pending = {
  protocol: "wecom_suite",
  suiteId: "client-fixture",
  preAuthCode: "fixture-pre-auth",
  expiresAt: new Date(Date.now() + 100000).toISOString(),
};
describe("Enterprise native authorization", () => {
  for (const region of ["feishu", "lark"])
    it(`binds ${region} browser PKCE and fixed v3 authority`, async () => {
      const { authority, calls } = setup([feishuToken, feishuUser]);
      const cfg = config("feishu-lark", { region });
      const url = new URL(authority.authorizationUrl(cfg, "state-fixture", verifier));
      assert.equal(url.host, region === "feishu" ? "accounts.feishu.cn" : "accounts.larksuite.com");
      assert.equal(
        url.searchParams.get("code_challenge"),
        createHash("sha256").update(verifier).digest("base64url"),
      );
      assert.equal(url.searchParams.get("state"), "state-fixture");
      const grant = await authority.exchange(cfg, owner, "code-fixture", verifier, signal());
      assert.equal(grant.identity.subject, "user-fixture");
      assert.equal(grant.identity.context.region, region);
      assert.equal(calls[0]?.url, `https://${url.host}/oauth/v3/token`);
      assert.equal(JSON.parse(String(calls[0]?.init?.body)).code_verifier, verifier);
      assert.equal(calls.length, 2);
    });
  it("requires explicit regional authority", () => {
    const { authority, calls } = setup([]);
    assert.throws(() =>
      authority.authorizationUrl(config("feishu-lark", { region: undefined }), "s", verifier),
    );
    assert.equal(calls.length, 0);
  });
  it("verifies Feishu self-build app tenant and never invents user scopes", async () => {
    const { authority } = setup([
      { code: 0, tenant_access_token: "fixture-access", expire: 7200 },
      { code: 0, data: { tenant: { tenant_key: "corp-fixture", name: "Fixture organization" } } },
    ]);
    const g = await authority.verifyStatic(
      config("feishu-lark", {}, "machine_key"),
      owner,
      signal(),
    );
    assert.deepEqual(g.scopes, []);
    assert.equal(g.tokens.refreshToken, null);
    assert.equal(g.identity.context.actorType, "app");
    assert.equal(g.identity.tenant, "corp-fixture");
  });
  it("refuses machine credentials without an owner Space binding", async () => {
    const { authority, calls } = setup([]);
    await assert.rejects(
      authority.verifyStatic(
        config("feishu-lark", { boundSpaceId: undefined }, "machine_key"),
        owner,
        signal(),
      ),
    );
    assert.equal(calls.length, 0);
  });
  it("does not pretend a Feishu marketplace machine installation exists", async () => {
    const { authority, calls } = setup([]);
    await assert.rejects(
      authority.verifyStatic(
        { ...config("feishu-lark", {}, "machine_key"), ownership: "official" },
        owner,
        signal(),
      ),
    );
    assert.equal(calls.length, 0);
  });
  it("denies Feishu tenant mismatch after server identity", async () => {
    const { authority } = setup([
      feishuToken,
      { code: 0, data: { open_id: "u", tenant_key: "other-corp" } },
    ]);
    await assert.rejects(authority.exchange(config(), owner, "code", verifier, signal()));
  });
  it("explicit Feishu scope response cannot exceed frozen config", async () => {
    const { authority } = setup([
      { ...feishuToken, scope: "offline_access calendar:calendar" },
      feishuUser,
    ]);
    await assert.rejects(
      authority.exchange(config(), owner, "code", verifier, signal()),
      (e: unknown) => (e as { kind: string }).kind === "insufficient_scope",
    );
  });
  it("does not infer scopes from an opaque Feishu access token", async () => {
    const { authority } = setup([{ ...feishuToken, scope: undefined }, feishuUser]);
    await assert.rejects(authority.exchange(config(), owner, "code", verifier, signal()));
  });
  it("refreshes Feishu through same regional protocol and retains rotated material", async () => {
    const { authority, calls } = setup([
      feishuToken,
      feishuUser,
      { ...feishuToken, access_token: "new", refresh_token: "rotated" },
      feishuUser,
    ]);
    const cfg = config(),
      previous = await authority.exchange(cfg, owner, "code", verifier, signal());
    const next = await authority.refresh(cfg, owner, previous, signal());
    assert.equal(next.tokens.refreshToken, "rotated");
    assert.equal(JSON.parse(String(calls[2]?.init?.body)).grant_type, "refresh_token");
  });
  for (const region of ["feishu", "lark"])
    it.each([undefined, null, "", 123])(
      `${region} refresh without a replacement token is uncertain while offline access remains granted (%s)`,
      async (refreshToken) => {
        const { authority, calls } = setup([
          feishuToken,
          feishuUser,
          { ...feishuToken, access_token: "new-access", refresh_token: refreshToken },
          feishuUser,
        ]);
        const cfg = config("feishu-lark", { region });
        const previous = await authority.exchange(cfg, owner, "code", verifier, signal());
        await assert.rejects(
          authority.refresh(cfg, owner, previous, signal()),
          (error: unknown) =>
            error instanceof NativeActionError &&
            error.kind === "result_unknown" &&
            error.options.uncertain === true,
        );
        assert.equal(
          calls.filter(
            (call) => JSON.parse(String(call.init?.body ?? "{}")).grant_type === "refresh_token",
          ).length,
          1,
        );
      },
    );
  for (const region of ["feishu", "lark"]) {
    it.each([
      { name: "spaces", refreshToken: "   " },
      { name: "line break", refreshToken: "\n" },
    ])(`${region} refuses a blank rotated refresh token ($name)`, async ({ refreshToken }) => {
      const { authority, calls } = setup([
        feishuToken,
        feishuUser,
        { ...feishuToken, access_token: "new-access", refresh_token: refreshToken },
        feishuUser,
      ]);
      const cfg = config("feishu-lark", { region });
      const previous = await authority.exchange(cfg, owner, "code", verifier, signal());
      await assert.rejects(
        authority.refresh(cfg, owner, previous, signal()),
        (error: unknown) =>
          error instanceof NativeActionError &&
          error.kind === "result_unknown" &&
          error.options.uncertain === true,
      );
      assert.equal(
        calls.filter(
          (call) => JSON.parse(String(call.init?.body ?? "{}")).grant_type === "refresh_token",
        ).length,
        1,
      );
    });
    it(`${region} preserves the original bytes of a nonblank rotated refresh token`, async () => {
      const replacement = " \tfixture-rotated \r\n";
      const { authority } = setup([
        feishuToken,
        feishuUser,
        { ...feishuToken, access_token: "new-access", refresh_token: replacement },
        feishuUser,
      ]);
      const cfg = config("feishu-lark", { region });
      const previous = await authority.exchange(cfg, owner, "code", verifier, signal());
      const next = await authority.refresh(cfg, owner, previous, signal());
      assert.equal(next.tokens.refreshToken, replacement);
    });
    it(`${region} leaves initial exchange refresh token handling unchanged`, async () => {
      const initialRefresh = " \t\n";
      const { authority } = setup([{ ...feishuToken, refresh_token: initialRefresh }, feishuUser]);
      const grant = await authority.exchange(
        config("feishu-lark", { region }),
        owner,
        "code",
        verifier,
        signal(),
      );
      assert.equal(grant.tokens.refreshToken, initialRefresh);
    });
  }
  for (const region of ["feishu", "lark"])
    it(`${region} keeps an access-only refresh grant when actual scopes remove offline access`, async () => {
      const { authority, calls } = setup([
        feishuToken,
        feishuUser,
        {
          access_token: "access-only",
          expires_in: 1800,
          scope: "contact:user.base:readonly",
        },
        feishuUser,
      ]);
      const cfg = config("feishu-lark", { region });
      const previous = await authority.exchange(cfg, owner, "code", verifier, signal());
      const before = Date.now();
      const next = await authority.refresh(cfg, owner, previous, signal());
      assert.deepEqual(next.tokens, { accessToken: "access-only", refreshToken: null });
      assert.deepEqual(next.scopes, ["contact:user.base:readonly"]);
      assert.equal(next.identity.subject, previous.identity.subject);
      assert.ok(next.expiresAt && next.expiresAt.getTime() >= before + 1_800_000);
      assert.ok(next.expiresAt.getTime() <= Date.now() + 1_800_000);
      const completedRequests = calls.length;
      await assert.rejects(
        authority.refresh(cfg, owner, { ...next, expiresAt: new Date(0) }, signal()),
        (error: unknown) =>
          error instanceof NativeActionError && error.kind === "authorization_expired",
      );
      assert.equal(calls.length, completedRequests);
    });
  it("refresh identity cannot switch Feishu user", async () => {
    const { authority } = setup([
      feishuToken,
      feishuUser,
      feishuToken,
      { code: 0, data: { ...feishuUser.data, open_id: "other-user" } },
    ]);
    const previous = await authority.exchange(config(), owner, "code", verifier, signal());
    await assert.rejects(
      authority.refresh(config(), owner, previous, signal()),
      (e: unknown) => (e as { kind: string }).kind === "authorization_required",
    );
  });
  it("DingTalk user OAuth verifies actual user and corp without fake scope claims", async () => {
    const { authority, calls } = setup([dingToken, dingUser]);
    const cfg = config("dingtalk", { scopes: ["openid", "corpid"] }),
      url = new URL(authority.authorizationUrl(cfg, "s", verifier));
    assert.equal(url.host, "login.dingtalk.com");
    assert.equal(url.searchParams.get("prompt"), "consent");
    const g = await authority.exchange(cfg, owner, "authCode", verifier, signal());
    assert.equal(g.identity.subject, "union-fixture");
    assert.deepEqual(g.scopes, []);
    assert.equal(
      new Headers(calls[1]?.init?.headers).get("x-acs-dingtalk-access-token"),
      "fixture-access",
    );
    assert.equal(JSON.parse(String(calls[0]?.init?.body)).grantType, "authorization_code");
  });
  it("DingTalk rejects different selected corp", async () => {
    const { authority } = setup([{ ...dingToken, corpId: "other" }]);
    await assert.rejects(authority.exchange(config("dingtalk"), owner, "code", verifier, signal()));
  });
  it("DingTalk modern app credentials use server-validated organization endpoint", async () => {
    const { authority, calls } = setup([{ access_token: "app-token", expires_in: 7200 }]);
    const g = await authority.verifyStatic(config("dingtalk", {}, "machine_key"), owner, signal());
    assert.equal(calls[0]?.url, "https://api.dingtalk.com/v1.0/oauth2/corp-fixture/token");
    assert.equal(JSON.parse(String(calls[0]?.init?.body)).grant_type, "client_credentials");
    assert.equal(g.tokens.refreshToken, null);
    assert.deepEqual(g.scopes, []);
  });
  it("DingTalk machine refresh remints without pretending to have a refresh token", async () => {
    const { authority } = setup([
      { access_token: "first", expires_in: 7200 },
      { access_token: "second", expires_in: 7200 },
    ]);
    const cfg = config("dingtalk", {}, "machine_key"),
      first = await authority.verifyStatic(cfg, owner, signal());
    assert.equal(
      (await authority.refresh(cfg, owner, first, signal())).tokens.accessToken,
      "second",
    );
  });
  it("DingTalk user refresh uses actual provider refresh protocol", async () => {
    const { authority, calls } = setup([
      dingToken,
      dingUser,
      { ...dingToken, refreshToken: "rotated" },
      dingUser,
    ]);
    const cfg = config("dingtalk"),
      first = await authority.exchange(cfg, owner, "code", verifier, signal());
    assert.equal(
      (await authority.refresh(cfg, owner, first, signal())).tokens.refreshToken,
      "rotated",
    );
    assert.equal(JSON.parse(String(calls[2]?.init?.body)).grantType, "refresh_token");
  });
  it("WeCom internal app has CorpID and AgentID, no fabricated ClientID", async () => {
    const { authority, calls } = setup([
      { errcode: 0, ...corpToken },
      { errcode: 0, agentid: 1000001, name: "Fixture" },
    ]);
    const g = await authority.verifyStatic(
      config("wecom", { clientId: undefined }, "machine_key"),
      owner,
      signal(),
    );
    assert.equal(g.identity.context.appId, "corp-fixture");
    assert.equal(g.identity.context.agentId, "1000001");
    assert.equal(new URL(calls[0]!.url).searchParams.get("corpid"), "corp-fixture");
  });
  it("WeCom internal app rejects another AgentID", async () => {
    const { authority } = setup([corpToken, { errcode: 0, agentid: 2000002 }]);
    await assert.rejects(
      authority.verifyStatic(
        config("wecom", { clientId: undefined }, "machine_key"),
        owner,
        signal(),
      ),
    );
  });
  it("WeCom suite begin obtains provider preauth and retains encrypted pending fact", async () => {
    const { authority, calls } = setup([
      suite,
      { pre_auth_code: "fixture-pre-auth", expires_in: 600 },
    ]);
    const result = await authority.begin(config("wecom"), owner, "bound-state", verifier, signal());
    const url = new URL(result.authorizationUrl);
    assert.equal(url.host, "open.work.weixin.qq.com");
    assert.equal(url.searchParams.get("state"), "bound-state");
    assert.equal(url.searchParams.get("pre_auth_code"), "fixture-pre-auth");
    assert.equal(result.pending.suiteId, "client-fixture");
    assert.equal(calls.length, 2);
  });
  it("WeCom suite exchange stores actual permanent install only inside token material", async () => {
    const { authority, calls } = setup([suite, installed, authInfo, corpToken]);
    const g = await authority.exchange(
      config("wecom"),
      owner,
      "auth-code",
      verifier,
      signal(),
      pending,
    );
    assert.equal(g.tokens.enterpriseInstallation?.kind, "wecom_suite");
    assert.equal(g.tokens.refreshToken, null);
    assert.deepEqual(g.scopes, []);
    assert.equal(g.identity.tenant, "corp-fixture");
    assert.ok(calls[1]!.url.includes("/service/v2/get_permanent_code?"));
    assert.equal(g.identity.context.permanentCode, undefined);
  });
  it("WeCom never exchanges an unbound or expired browser pending session", async () => {
    const { authority, calls } = setup([]);
    await assert.rejects(
      authority.exchange(config("wecom"), owner, "code", verifier, signal(), {
        ...pending,
        expiresAt: new Date(0).toISOString(),
      }),
    );
    assert.equal(calls.length, 0);
  });
  it("WeCom rejects a different installed corp", async () => {
    const { authority } = setup([suite, { ...installed, auth_corp_info: { corpid: "other" } }]);
    await assert.rejects(
      authority.exchange(config("wecom"), owner, "code", verifier, signal(), pending),
    );
  });
  it("WeCom refuses to silently pick another installed agent", async () => {
    const { authority } = setup([
      suite,
      { ...installed, auth_info: { agent: [{ agentid: 2000002 }] } },
    ]);
    await assert.rejects(
      authority.exchange(config("wecom"), owner, "code", verifier, signal(), pending),
    );
  });
  it("WeCom permanent install refresh rechecks authorization then mints a corp token", async () => {
    const { authority, calls } = setup([
      suite,
      installed,
      authInfo,
      corpToken,
      suite,
      authInfo,
      { ...corpToken, access_token: "new-corp" },
    ]);
    const cfg = config("wecom"),
      previous = await authority.exchange(cfg, owner, "code", verifier, signal(), pending);
    const next = await authority.refresh(cfg, owner, previous, signal());
    assert.equal(next.tokens.accessToken, "new-corp");
    assert.ok(calls[5]!.url.includes("/service/v2/get_auth_info?"));
    assert.equal(JSON.parse(String(calls[6]?.init?.body)).permanent_code, "fixture-permanent");
  });
  it("WeCom stale suite ticket cannot mint tokens", async () => {
    const { authority, calls } = setup([]);
    await assert.rejects(
      authority.begin(
        config("wecom"),
        JSON.stringify({
          version: 1,
          clientSecret: "fixture",
          suiteTicket: { value: "ticket", issuedAt: 1 },
        }),
        "s",
        verifier,
        signal(),
      ),
    );
    assert.equal(calls.length, 0);
  });
  for (const [response, kind] of [
    [
      new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 429 }),
      "rate_limited",
    ],
    [new Response(JSON.stringify({ error: "invalid_scope" }), { status: 400 }), "not_configured"],
    [
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      "authorization_expired",
    ],
    [new Response("{}", { status: 503 }), "temporarily_unavailable"],
  ] as const)
    it(`preserves OAuth ${kind} without leaking response secrets`, async () => {
      const { authority } = setup([response]);
      await assert.rejects(
        authority.exchange(config(), owner, "code", verifier, signal()),
        (e: unknown) => (e as { kind: string }).kind === kind,
      );
    });
  it("Feishu IP policy rejection on the actual token path requires configuration repair", async () => {
    const { authority } = setup([{ code: 99991401 }]);
    await assert.rejects(
      authority.exchange(config(), owner, "code", verifier, signal()),
      (e: unknown) => (e as { kind: string }).kind === "not_configured",
    );
  });
  it("consumed code with a lost transport response is explicitly uncertain", async () => {
    const { authority } = setup([new Error("fixture")]);
    await assert.rejects(
      authority.exchange(config(), owner, "code", verifier, signal()),
      (e: unknown) => (e as { options: { uncertain: boolean } }).options.uncertain === true,
    );
  });
});
