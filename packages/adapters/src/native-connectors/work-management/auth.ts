import { createHash } from "node:crypto";
import type { NativeAppConfig } from "@rakazo/db";
import { asRecord, readBoundedText } from "../../connector-http.js";
import { combineSignals } from "../../connector-safety.js";
import type { RemoteTransportDependencies, SafeRemoteFetch } from "../../remote-mcp.js";
import { NativeActionError } from "../action.js";
import type { NativeAuthorization, NativeIdentity, NativeTokenMaterial } from "../authorities.js";
import type { Data } from "../collaboration-action.js";
import { NativeConfigSettingsSchema } from "../config.js";
import { createNativeFetch, nativeAbortable } from "../network.js";
import { gitlabOrigin, isWorkManagementApp, WORK_MANAGEMENT_METADATA } from "./metadata.js";

function required(value: unknown, label = "authorization data"): string {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value))
    throw new NativeActionError("incomplete_response", `The service omitted ${label}.`);
  return value;
}
function record(value: unknown): Data {
  const row = asRecord(value);
  if (!row)
    throw new NativeActionError(
      "incomplete_response",
      "The authorization response was incomplete.",
    );
  return row;
}
function stableId(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : required(value, "verified identity");
}
function scopeList(value: unknown): string[] {
  const values = typeof value === "string" ? value.split(/[ ,]+/).filter(Boolean) : value;
  if (!Array.isArray(values) || values.some((s) => typeof s !== "string" || !s))
    throw new NativeActionError(
      "incomplete_response",
      "The service omitted actual granted scopes.",
    );
  return [...new Set(values as string[])];
}
function expires(value: unknown, compatibility = false): Date | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > (compatibility ? 315_360_000 : 31_536_000)
  )
    throw new NativeActionError(
      "incomplete_response",
      "The service returned an invalid token lifetime.",
    );
  return new Date(Date.now() + value * 1000);
}
function actor(config: NativeAppConfig): void {
  const settings = NativeConfigSettingsSchema.parse(config.config);
  if (settings.actor !== "user" || !isWorkManagementApp(config.appId))
    throw new NativeActionError("not_configured", "This connection needs an explicit user actor.");
  const meta = WORK_MANAGEMENT_METADATA[config.appId];
  if (!(meta.authKinds as readonly string[]).includes(config.credentialKind))
    throw new NativeActionError(
      "not_configured",
      "This credential kind is not supported by this application.",
    );
  if (settings.scopes.some((s) => !(meta.scopes as readonly string[]).includes(s)))
    throw new NativeActionError("not_configured", "This application has an unsupported scope.");
  if (
    config.appId === "asana" &&
    settings.scopes.includes("default") &&
    settings.scopes.length !== 1
  )
    throw new NativeActionError(
      "not_configured",
      "Asana Full permissions cannot be combined with granular scopes.",
    );
  if (!meta.tenantSelection && settings.tenantId)
    throw new NativeActionError(
      "not_configured",
      "This application uses the selected user's resource permissions rather than a configured tenant.",
    );
  if (
    meta.tenantSelection &&
    (!settings.tenantId || !/^[A-Za-z0-9-]{1,128}$/.test(settings.tenantId))
  )
    throw new NativeActionError(
      "not_configured",
      "Select an explicit Atlassian cloud ID before connecting an account.",
    );
}
const mismatch = (): never => {
  throw new NativeActionError(
    "authorization_required",
    "The verified account or site does not match this connection.",
  );
};
function same(previous: NativeAuthorization, next: NativeAuthorization): NativeAuthorization {
  if (
    previous.identity.authority !== next.identity.authority ||
    previous.identity.subject !== next.identity.subject ||
    previous.identity.tenant !== next.identity.tenant ||
    previous.identity.context.actorType !== next.identity.context.actorType
  )
    mismatch();
  return next;
}

/** Each authority and identity endpoint is provider code, never a business URL. */
export class WorkManagementAuthorities {
  private readonly fetch: SafeRemoteFetch;
  constructor(
    network: RemoteTransportDependencies = {},
    private readonly allowPrivateEndpoint = false,
  ) {
    this.fetch = createNativeFetch(network, { allowPrivateEndpoint });
  }
  close(): Promise<void> {
    return this.fetch.close();
  }
  private check(config: NativeAppConfig): void {
    actor(config);
    if (this.allowPrivateEndpoint && config.appId !== "gitlab")
      throw new NativeActionError(
        "not_configured",
        "Private authority transport is restricted to a configured GitLab instance.",
      );
  }
  authorizationUrl(config: NativeAppConfig, state: string, verifier: string): string {
    this.check(config);
    if (config.credentialKind !== "oauth")
      throw new NativeActionError("invalid_input", "This connection does not use OAuth.");
    const settings = NativeConfigSettingsSchema.parse(config.config);
    const endpoint =
      config.appId === "gitlab"
        ? `${gitlabOrigin(config)}/oauth/authorize`
        : ["jira", "confluence", "trello"].includes(config.appId)
          ? "https://auth.atlassian.com/authorize"
          : config.appId === "todoist"
            ? "https://app.todoist.com/oauth/authorize"
            : "https://app.asana.com/-/oauth_authorize";
    const url = new URL(endpoint);
    const values: Record<string, string> = {
      client_id: required(settings.clientId, "client ID"),
      redirect_uri: config.callbackUri,
      response_type: "code",
      state,
      scope: settings.scopes.join(config.appId === "todoist" ? "," : " "),
    };
    if (["jira", "confluence"].includes(config.appId)) {
      values.audience = "api.atlassian.com";
      values.prompt = "consent";
    } else {
      values.code_challenge_method = "S256";
      values.code_challenge = createHash("sha256").update(verifier).digest("base64url");
    }
    if (config.appId === "trello") values.prompt = "consent";
    for (const [k, v] of Object.entries(values)) url.searchParams.set(k, v);
    return url.toString();
  }
  async exchange(
    config: NativeAppConfig,
    secret: string,
    code: string,
    verifier: string,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    this.check(config);
    const body = await this.exchangeToken(
      config,
      secret,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: config.callbackUri,
        ...(["jira", "confluence"].includes(config.appId) ? {} : { code_verifier: verifier }),
      },
      signal,
    );
    // Even exchange may consume the one-use authorization code before identity verification fails.
    return this.afterToken(config, body, undefined, signal, false);
  }
  async refresh(
    config: NativeAppConfig,
    secret: string,
    previous: NativeAuthorization,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    this.check(config);
    if (!previous.tokens.refreshToken)
      throw new NativeActionError(
        "authorization_expired",
        "Reconnect this account to obtain a refresh token.",
      );
    const body = await this.exchangeToken(
      config,
      secret,
      {
        grant_type: "refresh_token",
        refresh_token: previous.tokens.refreshToken,
        ...(config.appId === "gitlab" ? { redirect_uri: config.callbackUri } : {}),
      },
      signal,
    );
    try {
      return same(previous, await this.afterToken(config, body, previous, signal, true));
    } catch (error) {
      return this.consumed(error);
    }
  }
  async verifyStatic(
    config: NativeAppConfig,
    credential: string,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    this.check(config);
    if (
      config.credentialKind !== "personal_token" ||
      !["gitlab", "todoist", "asana"].includes(config.appId)
    )
      throw new NativeActionError("invalid_input", "Use the supported OAuth connection.");
    required(credential, "personal token");
    return this.identify(
      config,
      { accessToken: credential, refreshToken: null },
      [],
      null,
      signal,
      true,
    );
  }
  private consumed(error: unknown): never {
    if (error instanceof NativeActionError)
      throw new NativeActionError(
        error.kind,
        "The token exchange may have consumed its prior credential. Reconnect before retrying.",
        { ...error.options, uncertain: true },
      );
    throw new NativeActionError(
      "temporarily_unavailable",
      "The token exchange outcome could not be verified. Reconnect this account.",
      { uncertain: true },
    );
  }
  private async afterToken(
    config: NativeAppConfig,
    body: Data,
    previous: NativeAuthorization | undefined,
    signal: AbortSignal,
    refreshing: boolean,
  ): Promise<NativeAuthorization> {
    try {
      // Trello's published token response omits token_type; its documented protocol is fixed Bearer.
      if (body.token_type !== undefined && String(body.token_type).toLowerCase() !== "bearer")
        throw new NativeActionError("incomplete_response", "Unsupported token type.");
      if (body.token_type === undefined && config.appId !== "trello")
        throw new NativeActionError("incomplete_response", "The service omitted token type.");
      const mustRotate =
        ["gitlab", "jira", "confluence", "trello"].includes(config.appId) ||
        (config.appId === "todoist" &&
          (refreshing || body.refresh_token !== undefined || body.expires_in !== 315_360_000)) ||
        (config.appId === "asana" && !refreshing);
      const refresh = body.refresh_token;
      if (refresh !== undefined && (typeof refresh !== "string" || !refresh))
        throw new NativeActionError(
          "incomplete_response",
          "The service returned invalid refresh-token material.",
        );
      if (mustRotate && (typeof refresh !== "string" || !refresh))
        throw new NativeActionError(
          "authorization_required",
          "The service did not return the replacement refresh token. Reconnect this account.",
        );
      const tokens = {
        accessToken: required(body.access_token, "access token"),
        refreshToken:
          typeof refresh === "string" && refresh
            ? refresh
            : config.appId === "asana"
              ? (previous?.tokens.refreshToken ?? null)
              : null,
      };
      // These providers expose an authenticated introspection endpoint. Their token
      // responses need not include scope; requested scopes are never substituted.
      const actualScopes = ["gitlab", "asana"].includes(config.appId) ? [] : scopeList(body.scope);
      const lifetime = expires(body.expires_in, config.appId === "todoist");
      if (!lifetime && (refreshing || tokens.refreshToken))
        throw new NativeActionError(
          "incomplete_response",
          "The service omitted access token expiry.",
        );
      return await this.identify(config, tokens, actualScopes, lifetime, signal, false);
    } catch (error) {
      return this.consumed(error);
    }
  }
  private async identify(
    config: NativeAppConfig,
    tokens: NativeTokenMaterial,
    actualScopes: string[],
    expiresAt: Date | null,
    signal: AbortSignal,
    personal: boolean,
  ): Promise<NativeAuthorization> {
    const settings = NativeConfigSettingsSchema.parse(config.config),
      headers = { Authorization: `Bearer ${tokens.accessToken}` };
    let identity: NativeIdentity;
    if (config.appId === "gitlab") {
      const origin = gitlabOrigin(config),
        user = record(await this.json(`${origin}/api/v4/user`, { headers }, signal));
      if (user.bot === true || user.state !== "active") mismatch();
      const info = record(
        await this.json(
          `${origin}${personal ? "/api/v4/personal_access_tokens/self" : "/oauth/token/info"}`,
          { headers },
          signal,
        ),
      );
      actualScopes = scopeList(personal ? info.scopes : info.scope);
      if (stableId(personal ? info.user_id : info.resource_owner_id) !== stableId(user.id))
        mismatch();
      if (!personal && record(info.application).uid !== settings.clientId) mismatch();
      if (personal && (info.active !== true || info.revoked !== false)) mismatch();
      if (personal && info.expires_at !== null && info.expires_at !== undefined) {
        expiresAt = new Date(`${required(info.expires_at)}T23:59:59.999Z`);
        if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) mismatch();
      }
      identity = {
        authority: origin,
        subject: stableId(user.id),
        tenant: null,
        displayName: required(user.name ?? user.username),
        context: {
          actorType: "user",
          credentialType: personal ? "personal_token" : "oauth",
          gitlabOrigin: origin,
        },
      };
    } else if (config.appId === "jira" || config.appId === "confluence") {
      const rows = await this.json(
        "https://api.atlassian.com/oauth/token/accessible-resources",
        { headers },
        signal,
      );
      if (!Array.isArray(rows))
        throw new NativeActionError("incomplete_response", "Atlassian omitted accessible sites.");
      const tenant = required(settings.tenantId, "selected Atlassian cloud ID");
      const matches = rows
        .map(record)
        .filter(
          (row) =>
            row.id === tenant &&
            scopeList(row.scopes).some(
              (scope) =>
                scope.endsWith(config.appId === "jira" ? ":jira" : ":confluence") ||
                (config.appId === "jira" && scope.includes(":jira-")),
            ),
        );
      if (matches.length !== 1) mismatch();
      const site = matches[0]!,
        siteScopes = scopeList(site.scopes);
      actualScopes = actualScopes.filter(
        (scope) => scope === "read:me" || scope === "offline_access" || siteScopes.includes(scope),
      );
      const user = record(await this.json("https://api.atlassian.com/me", { headers }, signal));
      identity = {
        authority: "https://auth.atlassian.com",
        subject: required(user.account_id),
        tenant,
        displayName: required(user.name),
        context: {
          actorType: "user",
          credentialType: "oauth",
          cloudId: tenant,
          siteName: required(site.name),
        },
      };
    } else if (config.appId === "todoist") {
      const user = record(
        await this.json("https://api.todoist.com/api/v1/user", { headers }, signal),
      );
      identity = {
        authority: "https://app.todoist.com",
        subject: stableId(user.id),
        tenant: null,
        displayName: required(user.full_name),
        context: { actorType: "user", credentialType: personal ? "personal_token" : "oauth" },
      };
    } else if (config.appId === "trello") {
      const user = record(
        await this.json(
          "https://api.trello.com/1/members/me?fields=id,username,fullName",
          { headers },
          signal,
        ),
      );
      identity = {
        authority: "https://trello.com",
        subject: required(user.id),
        tenant: null,
        displayName: required(user.fullName ?? user.username),
        context: { actorType: "user", credentialType: "oauth" },
      };
    } else {
      const info = record(
        await this.json(
          "https://app.asana.com/-/token_info",
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: tokens.accessToken }).toString(),
          },
          signal,
        ),
      );
      if (info.active !== true || String(info.token_type).toLowerCase() !== "bearer") mismatch();
      const introspected = scopeList(info.scope);
      if (!personal && info.client_id !== settings.clientId) mismatch();
      actualScopes = introspected;
      const user = record(
        record(
          await this.json(
            "https://app.asana.com/api/1.0/users/me?opt_fields=gid,name",
            { headers },
            signal,
          ),
        ).data,
      );
      identity = {
        authority: "https://app.asana.com",
        subject: required(user.gid),
        tenant: null,
        displayName: required(user.name),
        context: { actorType: "user", credentialType: personal ? "personal_token" : "oauth" },
      };
      expiresAt ??= expires(info.expires_in, true);
    }
    return { tokens, identity, scopes: actualScopes, expiresAt };
  }
  private async exchangeToken(
    config: NativeAppConfig,
    secret: string,
    fields: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Data> {
    const settings = NativeConfigSettingsSchema.parse(config.config);
    const url =
      config.appId === "gitlab"
        ? `${gitlabOrigin(config)}/oauth/token`
        : ["jira", "confluence", "trello"].includes(config.appId)
          ? "https://auth.atlassian.com/oauth/token"
          : config.appId === "todoist"
            ? "https://api.todoist.com/oauth/access_token"
            : "https://app.asana.com/-/oauth_token";
    const body = {
      client_id: required(settings.clientId, "client ID"),
      client_secret: required(secret, "client secret"),
      ...fields,
    };
    const json = ["jira", "confluence", "trello"].includes(config.appId);
    return record(
      await this.json(
        url,
        {
          method: "POST",
          headers: {
            "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
          },
          body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
        },
        signal,
        true,
      ),
    );
  }
  private async json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    tokenMutation = false,
  ): Promise<unknown> {
    const bounded = combineSignals(signal, AbortSignal.timeout(20_000));
    let response: Response;
    try {
      response = await this.fetch(url, { ...init, redirect: "manual", signal: bounded });
    } catch {
      throw new NativeActionError(
        "temporarily_unavailable",
        "The authorization service could not be reached.",
        { uncertain: tokenMutation },
      );
    }
    let body: unknown;
    try {
      const read = await nativeAbortable(readBoundedText(response, 1_000_000), bounded);
      if (!read.truncated) body = JSON.parse(read.text);
    } catch {
      /* Upstream payloads and secrets are never diagnostic output. */
    }
    const error = asRecord(body)?.error;
    if (!response.ok || error !== undefined)
      throw new NativeActionError(
        error === "invalid_client"
          ? "not_configured"
          : response.status === 401 || error === "invalid_grant"
            ? "authorization_expired"
            : response.status === 429
              ? "rate_limited"
              : response.status >= 500
                ? "temporarily_unavailable"
                : "authorization_required",
        "The authorization service rejected this request.",
        { uncertain: tokenMutation && (response.status >= 500 || response.status === 408) },
      );
    if (!body || typeof body !== "object")
      throw new NativeActionError(
        "incomplete_response",
        "The authorization service returned an incomplete response.",
        { uncertain: tokenMutation },
      );
    return body;
  }
}
