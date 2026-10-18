import { createHash } from "node:crypto";
import type { NativeAppConfig } from "@rakazo/db";
import { asRecord, readBoundedText } from "../../connector-http.js";
import { combineSignals } from "../../connector-safety.js";
import type { RemoteTransportDependencies, SafeRemoteFetch } from "../../remote-mcp.js";
import { NativeActionError } from "../action.js";
import type { NativeAuthorization, NativeTokenMaterial } from "../authorities.js";
import { NativeConfigSettingsSchema } from "../config.js";
import { enterpriseConfigSecret } from "../enterprise-config-secret.js";
import { createNativeFetch, nativeAbortable } from "../network.js";
import { enterpriseBase, isEnterpriseApp } from "./metadata.js";

type Data = Record<string, unknown>;
function required(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 8192)
    throw new NativeActionError(
      "incomplete_response",
      "The enterprise service omitted required authorization data.",
    );
  return value;
}
function obj(value: unknown): Data {
  const result = asRecord(value);
  if (!result)
    throw new NativeActionError(
      "incomplete_response",
      "The enterprise service omitted authorization data.",
    );
  return result;
}
function configured(condition: unknown): asserts condition {
  if (!condition)
    throw new NativeActionError(
      "not_configured",
      "Configure the exact enterprise application, organization and actor before connecting.",
    );
}
function expiry(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 31_536_000)
    throw new NativeActionError(
      "incomplete_response",
      "The enterprise service returned an invalid token lifetime.",
    );
  return new Date(Date.now() + value * 1000);
}
function settings(config: NativeAppConfig) {
  const s = NativeConfigSettingsSchema.parse(config.config);
  configured(isEnterpriseApp(config.appId));
  configured(["oauth", "machine_key"].includes(config.credentialKind));
  if (config.credentialKind === "machine_key") configured(s.actor === "app" && s.boundSpaceId);
  if (config.appId === "feishu-lark") configured(["feishu", "lark"].includes(String(s.region)));
  if (config.appId !== "wecom" || config.credentialKind === "oauth") configured(s.clientId);
  if (config.appId === "wecom")
    configured(s.actor === "app" && s.agentId && /^\d+$/.test(s.agentId));
  else if (config.credentialKind === "oauth") configured(s.actor === "user");
  if (config.credentialKind === "machine_key" && config.appId !== "feishu-lark")
    configured(s.tenantId);
  if (config.appId === "wecom" && config.credentialKind === "machine_key")
    configured(!s.clientId || s.clientId === s.tenantId);
  return { ...s, appId: config.appId, clientId: s.clientId ?? s.tenantId ?? "" };
}
function preserve(previous: NativeAuthorization, next: NativeAuthorization): NativeAuthorization {
  if (
    previous.identity.authority !== next.identity.authority ||
    previous.identity.subject !== next.identity.subject ||
    previous.identity.tenant !== next.identity.tenant ||
    ["provider", "appId", "tenantId", "actorType", "credentialType", "region", "agentId"].some(
      (k) => previous.identity.context[k] !== next.identity.context[k],
    )
  )
    throw new NativeActionError(
      "authorization_required",
      "The enterprise application, actor or organization changed. Reconnect this account.",
    );
  return next;
}
/** Fixed regional OAuth and provider-verified organization credentials. Never decode opaque access tokens. */
export class EnterpriseAuthorities {
  private readonly fetch: SafeRemoteFetch;
  constructor(network: RemoteTransportDependencies = {}) {
    this.fetch = createNativeFetch(network);
  }
  close(): Promise<void> {
    return this.fetch.close();
  }
  authorizationUrl(config: NativeAppConfig, state: string, verifier: string): string {
    const s = settings(config);
    configured(config.credentialKind === "oauth" && config.appId !== "wecom");
    const u = new URL(
      config.appId === "feishu-lark"
        ? `https://accounts.${s.region === "feishu" ? "feishu.cn" : "larksuite.com"}/open-apis/authen/v1/authorize`
        : "https://login.dingtalk.com/oauth2/auth",
    );
    u.search = new URLSearchParams({
      client_id: s.clientId,
      response_type: "code",
      redirect_uri: config.callbackUri,
      state,
      scope: s.scopes.join(" "),
      ...(config.appId === "feishu-lark"
        ? {
            code_challenge_method: "S256",
            code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          }
        : { prompt: "consent" }),
    }).toString();
    return u.toString();
  }
  async begin(
    config: NativeAppConfig,
    secret: string,
    state: string,
    verifier: string,
    signal: AbortSignal,
  ): Promise<{ authorizationUrl: string; pending: Data }> {
    const s = settings(config);
    if (config.appId !== "wecom")
      return {
        authorizationUrl: this.authorizationUrl(config, state, verifier),
        pending: { protocol: config.appId, region: s.region ?? null },
      };
    configured(config.credentialKind === "oauth");
    const suite = await this.suite(config, secret, signal);
    const pre = await this.json(
      `https://qyapi.weixin.qq.com/cgi-bin/service/get_pre_auth_code?suite_access_token=${encodeURIComponent(suite)}`,
      {},
      signal,
      "wecom",
    );
    const preAuth = required(pre.pre_auth_code);
    const expiresAt = expiry(pre.expires_in);
    const url = new URL("https://open.work.weixin.qq.com/3rdapp/install");
    url.search = new URLSearchParams({
      suite_id: s.clientId,
      pre_auth_code: preAuth,
      redirect_uri: config.callbackUri,
      state,
    }).toString();
    return {
      authorizationUrl: url.toString(),
      pending: {
        protocol: "wecom_suite",
        suiteId: s.clientId,
        preAuthCode: preAuth,
        expiresAt: expiresAt.toISOString(),
      },
    };
  }
  async exchange(
    config: NativeAppConfig,
    secret: string,
    code: string,
    verifier: string,
    signal: AbortSignal,
    pending?: Data,
  ): Promise<NativeAuthorization> {
    const s = settings(config),
      owner = enterpriseConfigSecret(secret);
    configured(config.credentialKind === "oauth");
    if (config.appId === "wecom") {
      configured(
        pending?.protocol === "wecom_suite" &&
          pending.suiteId === s.clientId &&
          typeof pending.preAuthCode === "string" &&
          typeof pending.expiresAt === "string" &&
          Date.parse(pending.expiresAt) > Date.now(),
      );
      const suite = await this.suite(config, secret, signal);
      const install = await this.json(
        `https://qyapi.weixin.qq.com/cgi-bin/service/v2/get_permanent_code?suite_access_token=${encodeURIComponent(suite)}`,
        this.post({ auth_code: code }),
        signal,
        "wecom",
        true,
      );
      const corp = required(obj(install.auth_corp_info).corpid);
      configured(!s.tenantId || s.tenantId === corp);
      this.agent(install, s.agentId ?? "");
      const permanentCode = required(install.permanent_code);
      return this.wecomGrant(
        config,
        suite,
        {
          kind: "wecom_suite",
          suiteId: s.clientId,
          corpId: corp,
          agentId: s.agentId ?? "",
          permanentCode,
          ...(typeof install.auth_mode === "number" ? { authMode: install.auth_mode } : {}),
        },
        signal,
      );
    }
    if (config.appId === "feishu-lark") {
      const body = await this.json(
        `https://accounts.${s.region === "feishu" ? "feishu.cn" : "larksuite.com"}/oauth/v3/token`,
        this.post({
          grant_type: "authorization_code",
          client_id: s.clientId,
          client_secret: owner.clientSecret,
          code,
          redirect_uri: config.callbackUri,
          code_verifier: verifier,
          scope: s.scopes.join(" "),
        }),
        signal,
        "feishu",
        true,
      );
      return this.user(config, body, signal);
    }
    const body = await this.json(
      "https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
      this.post({
        clientId: s.clientId,
        clientSecret: owner.clientSecret,
        code,
        grantType: "authorization_code",
      }),
      signal,
      "dingtalk",
      true,
    );
    return this.user(config, body, signal);
  }
  async refresh(
    config: NativeAppConfig,
    secret: string,
    previous: NativeAuthorization,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    const s = settings(config);
    if (config.credentialKind === "machine_key")
      return preserve(previous, await this.verifyStatic(config, secret, signal));
    if (config.appId === "wecom") {
      const install = previous.tokens.enterpriseInstallation;
      configured(
        install?.kind === "wecom_suite" &&
          install.suiteId === s.clientId &&
          install.agentId === s.agentId &&
          (!s.tenantId || s.tenantId === install.corpId),
      );
      const suite = await this.suite(config, secret, signal);
      return preserve(previous, await this.wecomGrant(config, suite, install, signal));
    }
    if (!previous.tokens.refreshToken)
      throw new NativeActionError("authorization_expired", "Reconnect this enterprise account.");
    const owner = enterpriseConfigSecret(secret);
    const body = await this.json(
      config.appId === "feishu-lark"
        ? `https://accounts.${s.region === "feishu" ? "feishu.cn" : "larksuite.com"}/oauth/v3/token`
        : "https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
      this.post(
        config.appId === "feishu-lark"
          ? {
              grant_type: "refresh_token",
              client_id: s.clientId,
              client_secret: owner.clientSecret,
              refresh_token: previous.tokens.refreshToken,
            }
          : {
              grantType: "refresh_token",
              clientId: s.clientId,
              clientSecret: owner.clientSecret,
              refreshToken: previous.tokens.refreshToken,
            },
      ),
      signal,
      config.appId === "feishu-lark" ? "feishu" : "dingtalk",
      true,
    );
    try {
      return preserve(previous, await this.user(config, body, signal, previous));
    } catch (error) {
      if (error instanceof NativeActionError && error.kind === "authorization_required")
        throw error;
      throw new NativeActionError(
        "result_unknown",
        "The rotated enterprise grant requires recovery; do not repeat refresh blindly.",
        { uncertain: true },
      );
    }
  }
  async verifyStatic(
    config: NativeAppConfig,
    credential: string,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    const s = settings(config),
      owner = enterpriseConfigSecret(credential);
    configured(config.credentialKind === "machine_key");
    if (config.appId === "feishu-lark") {
      configured(config.ownership !== "official");
      const base = enterpriseBase(config.appId, s.region);
      const body = await this.json(
        `${base}/auth/v3/tenant_access_token/internal`,
        this.post({ app_id: s.clientId, app_secret: owner.clientSecret }),
        signal,
        "feishu",
      );
      const token = required(body.tenant_access_token);
      const info = await this.json(
        `${base}/tenant/v2/tenant/query`,
        { headers: { authorization: `Bearer ${token}` } },
        signal,
        "feishu",
      );
      const tenant = obj(obj(info.data).tenant),
        tenantId = required(tenant.tenant_key);
      configured(!s.tenantId || s.tenantId === tenantId);
      return this.authorization(
        config,
        token,
        null,
        tenantId,
        `app:${s.clientId}:${tenantId}`,
        typeof tenant.name === "string" ? tenant.name : "Feishu application",
        expiry(body.expire),
        [],
      );
    }
    if (config.appId === "dingtalk") {
      const body = await this.json(
        `https://api.dingtalk.com/v1.0/oauth2/${encodeURIComponent(s.tenantId ?? "")}/token`,
        this.post({
          client_id: s.clientId,
          client_secret: owner.clientSecret,
          grant_type: "client_credentials",
        }),
        signal,
        "dingtalk",
      );
      return this.authorization(
        config,
        required(body.access_token),
        null,
        s.tenantId ?? "",
        `app:${s.clientId}:${s.tenantId}`,
        "DingTalk application",
        expiry(body.expires_in),
        [],
      );
    }
    const body = await this.json(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(s.tenantId ?? "")}&corpsecret=${encodeURIComponent(owner.clientSecret)}`,
      {},
      signal,
      "wecom",
    );
    const token = required(body.access_token);
    const info = await this.json(
      `https://qyapi.weixin.qq.com/cgi-bin/agent/get?access_token=${encodeURIComponent(token)}&agentid=${encodeURIComponent(s.agentId ?? "")}`,
      {},
      signal,
      "wecom",
    );
    configured(String(info.agentid) === s.agentId);
    return this.authorization(
      config,
      token,
      null,
      s.tenantId ?? "",
      `app:${s.tenantId}:${s.agentId}`,
      typeof info.name === "string" ? info.name : "WeCom application",
      expiry(body.expires_in),
      [],
    );
  }
  private authorization(
    config: NativeAppConfig,
    accessToken: string,
    refreshToken: string | null,
    tenant: string,
    subject: string,
    displayName: string,
    expiresAt: Date,
    scopes: string[],
    installation?: NativeTokenMaterial["enterpriseInstallation"],
  ): NativeAuthorization {
    const s = settings(config);
    return {
      tokens: {
        accessToken,
        refreshToken,
        ...(installation ? { enterpriseInstallation: installation } : {}),
      },
      identity: {
        authority: enterpriseBase(config.appId, s.region),
        subject,
        tenant,
        displayName,
        context: {
          provider: config.appId,
          appId: s.clientId,
          tenantId: tenant,
          actorType: s.actor,
          credentialType: config.credentialKind,
          ...(s.region ? { region: s.region } : {}),
          ...(s.agentId ? { agentId: s.agentId } : {}),
        },
      },
      scopes,
      expiresAt,
    };
  }
  private async user(
    config: NativeAppConfig,
    body: Data,
    signal: AbortSignal,
    previous?: NativeAuthorization,
  ): Promise<NativeAuthorization> {
    const s = settings(config);
    if (config.appId === "feishu-lark") {
      const token = required(body.access_token);
      const info = await this.json(
        `${enterpriseBase(config.appId, s.region)}/authen/v1/user_info`,
        { headers: { authorization: `Bearer ${token}` } },
        signal,
        "feishu",
      );
      const user = obj(info.data),
        tenant = required(user.tenant_key);
      configured(!s.tenantId || s.tenantId === tenant);
      const scope = required(body.scope).split(/\s+/).filter(Boolean);
      if (scope.some((v) => !s.scopes.includes(v)))
        throw new NativeActionError(
          "insufficient_scope",
          "The enterprise token includes permissions outside this connection configuration.",
        );
      return this.authorization(
        config,
        token,
        typeof body.refresh_token === "string" && body.refresh_token
          ? body.refresh_token
          : (previous?.tokens.refreshToken ?? null),
        tenant,
        required(user.open_id),
        typeof user.name === "string" ? user.name : "Feishu account",
        expiry(body.expires_in),
        [...new Set(scope)],
      );
    }
    const token = required(body.accessToken),
      tenant = required(body.corpId);
    configured(!s.tenantId || s.tenantId === tenant);
    const user = await this.json(
      "https://api.dingtalk.com/v1.0/contact/users/me",
      { headers: { "x-acs-dingtalk-access-token": token } },
      signal,
      "dingtalk",
    );
    return this.authorization(
      config,
      token,
      typeof body.refreshToken === "string" && body.refreshToken
        ? body.refreshToken
        : (previous?.tokens.refreshToken ?? null),
      tenant,
      required(user.unionId),
      typeof user.nick === "string" ? user.nick : "DingTalk account",
      expiry(body.expireIn),
      [],
    );
  }
  private async suite(
    config: NativeAppConfig,
    secret: string,
    signal: AbortSignal,
  ): Promise<string> {
    const s = settings(config),
      owner = enterpriseConfigSecret(secret);
    configured(
      owner.suiteTicket &&
        owner.suiteTicket.issuedAt <= Math.floor(Date.now() / 1000) + 300 &&
        owner.suiteTicket.issuedAt > Math.floor(Date.now() / 1000) - 1800,
    );
    const body = await this.json(
      "https://qyapi.weixin.qq.com/cgi-bin/service/get_suite_token",
      this.post({
        suite_id: s.clientId,
        suite_secret: owner.clientSecret,
        suite_ticket: owner.suiteTicket.value,
      }),
      signal,
      "wecom",
    );
    expiry(body.expires_in);
    return required(body.suite_access_token);
  }
  private agent(body: Data, agentId: string): void {
    const agents = obj(body.auth_info).agent;
    if (!Array.isArray(agents) || !agents.some((v) => String(obj(v).agentid) === agentId))
      throw new NativeActionError(
        "authorization_required",
        "The selected WeCom agent is absent from this verified installation.",
      );
  }
  private async wecomGrant(
    config: NativeAppConfig,
    suite: string,
    install: Extract<
      NonNullable<NativeTokenMaterial["enterpriseInstallation"]>,
      { kind: "wecom_suite" }
    >,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    const s = settings(config);
    configured(
      s.clientId === install.suiteId &&
        s.agentId === install.agentId &&
        (!s.tenantId || s.tenantId === install.corpId),
    );
    const info = await this.json(
      `https://qyapi.weixin.qq.com/cgi-bin/service/v2/get_auth_info?suite_access_token=${encodeURIComponent(suite)}`,
      this.post({ auth_corpid: install.corpId, permanent_code: install.permanentCode }),
      signal,
      "wecom",
    );
    if (info.auth_corp_info !== undefined)
      configured(obj(info.auth_corp_info).corpid === install.corpId);
    this.agent(info, install.agentId);
    const token = await this.json(
      `https://qyapi.weixin.qq.com/cgi-bin/service/get_corp_token?suite_access_token=${encodeURIComponent(suite)}`,
      this.post({ auth_corpid: install.corpId, permanent_code: install.permanentCode }),
      signal,
      "wecom",
    );
    return this.authorization(
      config,
      required(token.access_token),
      null,
      install.corpId,
      `app:${install.suiteId}:${install.corpId}:${install.agentId}`,
      "WeCom installed application",
      expiry(token.expires_in),
      [],
      install,
    );
  }
  private post(body: Data): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }
  private async json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    family: "feishu" | "dingtalk" | "wecom",
    consuming = false,
  ): Promise<Data> {
    const bounded = combineSignals(signal, AbortSignal.timeout(20000));
    let response: Response;
    try {
      response = await this.fetch(url, { ...init, redirect: "manual", signal: bounded });
    } catch {
      throw new NativeActionError(
        "temporarily_unavailable",
        "Enterprise authorization is unavailable.",
        { uncertain: consuming },
      );
    }
    let body: Data | undefined;
    try {
      const read = await nativeAbortable(readBoundedText(response, 512000), bounded);
      if (!read.truncated) body = asRecord(JSON.parse(read.text));
    } catch {
      /* Provider diagnostics and secrets are never surfaced. */
    }
    const code = family === "wecom" ? body?.errcode : body?.code;
    const failed = code !== undefined && code !== 0 && code !== "0";
    if (!response.ok || failed || body?.error) {
      const raw = String(code ?? body?.error);
      const expired = [
        "invalid_grant",
        "40014",
        "42001",
        "40029",
        "40082",
        "99991663",
        "99991664",
        "99991669",
      ].includes(raw);
      throw new NativeActionError(
        response.status === 429
          ? "rate_limited"
          : response.status >= 500 || raw === "temporarily_unavailable" || raw === "-1"
            ? "temporarily_unavailable"
            : expired || response.status === 401
              ? "authorization_expired"
              : [
                    "invalid_client",
                    "invalid_scope",
                    "99991401",
                    "unauthorized_client",
                    "40001",
                    "40013",
                  ].includes(raw)
                ? "not_configured"
                : "authorization_required",
        "The enterprise service rejected authorization.",
        { uncertain: consuming && (response.status === 408 || response.status >= 500) },
      );
    }
    if (!body)
      throw new NativeActionError(
        "incomplete_response",
        "The enterprise service returned incomplete authorization data.",
        { uncertain: consuming },
      );
    return body;
  }
}
