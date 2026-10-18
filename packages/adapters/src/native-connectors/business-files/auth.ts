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
import { stringList } from "./common.js";
import { BUSINESS_FILES_APPS, isBusinessFilesApp } from "./metadata.js";

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw new NativeActionError(
      "incomplete_response",
      `The authorization service omitted ${name}.`,
    );
  return value;
}
function record(value: unknown): Data {
  const row = asRecord(value);
  if (!row)
    throw new NativeActionError(
      "incomplete_response",
      "The authorization service omitted identity metadata.",
    );
  return row;
}
function id(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return required(value, "a stable identity");
}
function lifetime(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 31_536_000)
    throw new NativeActionError(
      "incomplete_response",
      "The authorization service omitted a valid token lifetime.",
    );
  return new Date(Date.now() + value * 1000);
}
function parseScopes(value: unknown): string[] {
  return stringList(
    typeof value === "string" ? value.split(/[ ,]+/).filter(Boolean) : value,
    "actual granted scopes",
  );
}
function same(previous: NativeAuthorization, next: NativeAuthorization): NativeAuthorization {
  if (
    previous.identity.authority !== next.identity.authority ||
    previous.identity.subject !== next.identity.subject ||
    previous.identity.tenant !== next.identity.tenant ||
    previous.identity.context.actorType !== next.identity.context.actorType ||
    previous.identity.context.credentialType !== next.identity.context.credentialType ||
    previous.identity.context.appId !== next.identity.context.appId ||
    previous.identity.context.hubspotAccessLevel !== next.identity.context.hubspotAccessLevel
  )
    throw new NativeActionError(
      "authorization_required",
      "The refreshed authorization belongs to another account, application or actor.",
    );
  return next;
}
function material(body: Data, prior?: NativeTokenMaterial, rotating = false): NativeTokenMaterial {
  if (required(body.token_type, "the token type").trim().toLowerCase() !== "bearer")
    throw new NativeActionError(
      "incomplete_response",
      "The authorization service returned an unsupported token type.",
    );
  return {
    accessToken: required(body.access_token, "an access token"),
    refreshToken:
      body.refresh_token === undefined && !rotating
        ? (prior?.refreshToken ?? null)
        : required(body.refresh_token, "a refresh token"),
  };
}
function selected(config: NativeAppConfig): {
  settings: ReturnType<typeof NativeConfigSettingsSchema.parse>;
  app: keyof typeof BUSINESS_FILES_APPS;
} {
  if (!isBusinessFilesApp(config.appId))
    throw new NativeActionError("invalid_input", "Unsupported application authorization.");
  const app = config.appId,
    settings = NativeConfigSettingsSchema.parse(config.config),
    meta = BUSINESS_FILES_APPS[app];
  if (
    !(meta.credentialKinds as readonly string[]).includes(config.credentialKind) ||
    !settings.actor ||
    !(meta.actors as readonly string[]).includes(settings.actor)
  )
    throw new NativeActionError(
      "not_configured",
      "Select a supported credential and actor for this application.",
    );
  if (settings.scopes.some((scope) => !(meta.scopes as readonly string[]).includes(scope)))
    throw new NativeActionError(
      "not_configured",
      "This connection source contains unsupported scopes.",
    );
  if (["clickup", "airtable", "figma"].includes(app) && settings.tenantId)
    throw new NativeActionError(
      "not_configured",
      "This application authorizes resources through the selected account, without a verified tenant selector.",
    );
  if (settings.endpoint)
    throw new NativeActionError("not_configured", "This application uses a fixed API authority.");
  if (app === "hubspot" && config.credentialKind === "personal_token" && settings.actor !== "app")
    throw new NativeActionError(
      "not_configured",
      "A HubSpot private app token is an account-level application credential.",
    );
  return { app, settings };
}

/** Provider wire protocols only. Existing NativeOAuthStore owns encryption, lease and generation CAS. */
export class BusinessFilesAuthorities {
  private readonly fetch: SafeRemoteFetch;
  constructor(network: RemoteTransportDependencies = {}) {
    this.fetch = createNativeFetch(network);
  }
  close(): Promise<void> {
    return this.fetch.close();
  }
  authorizationUrl(config: NativeAppConfig, state: string, verifier: string): string {
    const { app, settings } = selected(config);
    if (config.credentialKind !== "oauth")
      throw new NativeActionError("invalid_input", "This credential does not use OAuth.");
    const clientId = required(settings.clientId, "an OAuth client ID"),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    const paths = {
      clickup: "https://app.clickup.com/api",
      airtable: "https://airtable.com/oauth2/v1/authorize",
      dropbox: "https://www.dropbox.com/oauth2/authorize",
      hubspot: "https://app.hubspot.com/oauth/authorize",
      figma: "https://www.figma.com/oauth",
    };
    const url = new URL(paths[app]);
    for (const [name, value] of Object.entries({
      client_id: clientId,
      redirect_uri: config.callbackUri,
      state,
    }))
      url.searchParams.set(name, value);
    if (app !== "clickup") {
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", settings.scopes.join(" "));
    }
    if (["airtable", "dropbox", "figma"].includes(app)) {
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    if (app === "dropbox") url.searchParams.set("token_access_type", "offline");
    return url.toString();
  }
  async exchange(
    config: NativeAppConfig,
    secret: string,
    code: string,
    verifier: string,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    const { app, settings } = selected(config);
    if (config.credentialKind !== "oauth")
      throw new NativeActionError("invalid_input", "This credential does not use OAuth.");
    const clientId = required(settings.clientId, "an OAuth client ID");
    let body: Data;
    if (app === "clickup")
      body = await this.json(
        "https://api.clickup.com/api/v2/oauth/token",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_id: clientId, client_secret: secret, code }),
        },
        signal,
        true,
      );
    else if (app === "airtable" || app === "figma")
      body = await this.form(
        app === "airtable"
          ? "https://airtable.com/oauth2/v1/token"
          : "https://api.figma.com/v1/oauth/token",
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: config.callbackUri,
          code_verifier: verifier,
        },
        signal,
        this.basic(clientId, secret, app === "airtable"),
      );
    else
      body = await this.form(
        app === "dropbox"
          ? "https://api.dropboxapi.com/oauth2/token"
          : "https://api.hubspot.com/oauth/2026-09/token",
        {
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: secret,
          redirect_uri: config.callbackUri,
          ...(app === "dropbox" ? { code_verifier: verifier } : {}),
        },
        signal,
      );
    try {
      return await this.authorization(config, secret, body, undefined, signal);
    } catch (error) {
      return this.uncertain(error, app);
    }
  }
  async refresh(
    config: NativeAppConfig,
    secret: string,
    previous: NativeAuthorization,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    const { app, settings } = selected(config);
    if (app === "clickup" || config.credentialKind !== "oauth" || !previous.tokens.refreshToken)
      throw new NativeActionError(
        "authorization_expired",
        "This account requires a new authorization.",
      );
    const clientId = required(settings.clientId, "an OAuth client ID");
    const endpoint =
      app === "airtable"
        ? "https://airtable.com/oauth2/v1/token"
        : app === "figma"
          ? "https://api.figma.com/v1/oauth/token"
          : app === "dropbox"
            ? "https://api.dropboxapi.com/oauth2/token"
            : "https://api.hubspot.com/oauth/2026-09/token";
    const basic = app === "airtable" || app === "figma";
    const body = await this.form(
      endpoint,
      {
        grant_type: "refresh_token",
        refresh_token: previous.tokens.refreshToken,
        ...(basic ? {} : { client_id: clientId, client_secret: secret }),
      },
      signal,
      basic ? this.basic(clientId, secret, app === "airtable") : undefined,
    );
    try {
      return same(previous, await this.authorization(config, secret, body, previous, signal));
    } catch (error) {
      return this.uncertain(error, app);
    }
  }
  async verifyStatic(
    config: NativeAppConfig,
    credential: string,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    const { app } = selected(config);
    if (config.credentialKind !== "personal_token" || !credential || /[\r\n]/.test(credential))
      throw new NativeActionError(
        "invalid_input",
        "Enter a valid credential for this connection source.",
      );
    const tokens = { accessToken: credential, refreshToken: null };
    if (app === "clickup")
      return {
        tokens,
        identity: await this.clickupIdentity(config, credential, signal),
        scopes: [],
        expiresAt: null,
      };
    if (app === "airtable") {
      const me = await this.bearer("https://api.airtable.com/v0/meta/whoami", credential, signal);
      const identity = this.identity(
        config,
        id(me.id),
        null,
        typeof me.email === "string" ? me.email : id(me.id),
        { scopeAuthority: "provider_enforced" },
      );
      return { tokens, identity, scopes: [], expiresAt: null };
    }
    if (app === "hubspot") {
      const info = await this.json(
        "https://api.hubapi.com/oauth/v2/private-apps/get/access-token-info",
        {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${credential}` },
          body: JSON.stringify({ tokenKey: credential }),
        },
        signal,
      );
      const tenant = id(info.hubId),
        appId = id(info.appId),
        userId = id(info.userId);
      const identity = this.identity(config, `app:${appId}`, tenant, `HubSpot ${tenant}`, {
        hubId: tenant,
        appId,
        authorizingUserId: userId,
        hubspotAccessLevel: "account",
        actorType: "app",
      });
      return { tokens, identity, scopes: parseScopes(info.scopes), expiresAt: null };
    }
    if (app === "figma") {
      const me = await this.json(
        "https://api.figma.com/v1/me",
        { headers: { "X-Figma-Token": credential } },
        signal,
      );
      return {
        tokens,
        identity: this.identity(
          config,
          required(me.id, "a string Figma user ID"),
          null,
          required(me.handle, "a user handle"),
          {
            scopeAuthority: "provider_enforced",
            tokenExpiryKnown: false,
            credentialMaxLifetimeDays: 90,
          },
        ),
        scopes: [],
        expiresAt: null,
      };
    }
    throw new NativeActionError(
      "invalid_input",
      "This application does not accept a static token.",
    );
  }
  private async authorization(
    config: NativeAppConfig,
    secret: string,
    body: Data,
    previous: NativeAuthorization | undefined,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    const { app, settings } = selected(config);
    if (app === "clickup") {
      const tokens = {
        accessToken: required(body.access_token, "an access token"),
        refreshToken: null,
      };
      return {
        tokens,
        identity: await this.clickupIdentity(config, tokens.accessToken, signal),
        scopes: [],
        expiresAt: null,
      };
    }
    const tokens = material(body, previous?.tokens, app === "airtable" || !previous);
    const expiresAt = lifetime(body.expires_in);
    if (app === "airtable") {
      const me = await this.bearer(
          "https://api.airtable.com/v0/meta/whoami",
          tokens.accessToken,
          signal,
        ),
        granted = parseScopes(me.scopes);
      const claimed = parseScopes(body.scope);
      if (granted.length !== claimed.length || granted.some((scope) => !claimed.includes(scope)))
        throw new NativeActionError(
          "incomplete_response",
          "Airtable token and identity scopes disagree.",
        );
      return {
        tokens,
        expiresAt,
        scopes: granted,
        identity: this.identity(
          config,
          id(me.id),
          null,
          typeof me.email === "string" ? me.email : id(me.id),
        ),
      };
    }
    if (app === "dropbox") {
      const me = await this.json(
        "https://api.dropboxapi.com/2/users/get_current_account",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            "content-type": "application/json",
          },
          body: "null",
        },
        signal,
      );
      const accountId = required(me.account_id, "a Dropbox account ID");
      if (body.account_id !== undefined && body.account_id !== accountId)
        throw new NativeActionError("authorization_required", "Dropbox returned another account.");
      const team = me.team === undefined || me.team === null ? null : record(me.team),
        tenant = team ? required(team.id, "a Dropbox team ID") : null,
        root = record(me.root_info);
      const identity = this.identity(
        config,
        accountId,
        tenant,
        required(record(me.name).display_name, "an account name"),
        {
          accountId,
          rootNamespaceId: required(root.root_namespace_id, "a root namespace ID"),
          homeNamespaceId: required(root.home_namespace_id, "a home namespace ID"),
        },
      );
      return {
        tokens,
        expiresAt,
        scopes:
          body.scope === undefined && previous ? [...previous.scopes] : parseScopes(body.scope),
        identity,
      };
    }
    if (app === "figma") {
      const me = await this.bearer("https://api.figma.com/v1/me", tokens.accessToken, signal),
        subject = required(me.id, "a string Figma user ID");
      if (
        (!previous && required(body.user_id_string, "the string OAuth user ID") !== subject) ||
        (body.user_id_string !== undefined && body.user_id_string !== subject)
      )
        throw new NativeActionError(
          "authorization_required",
          "Figma token and identity belong to different users.",
        );
      return {
        tokens,
        expiresAt,
        scopes: [],
        identity: this.identity(config, subject, null, required(me.handle, "a user handle"), {
          scopeAuthority: "provider_enforced",
          remoteTokenMultiplicity: "one_per_app_user",
        }),
      };
    }
    const info = await this.form(
      "https://api.hubspot.com/oauth/2026-09/token/introspect",
      {
        client_id: required(settings.clientId, "an OAuth client ID"),
        client_secret: secret,
        token_type_hint: "access_token",
        token: tokens.accessToken,
      },
      signal,
      undefined,
      false,
    );
    if (
      info.active !== true ||
      info.token_use !== "access_token" ||
      info.client_id !== settings.clientId
    )
      throw new NativeActionError(
        "authorization_required",
        "HubSpot did not confirm this application's active access token.",
      );
    const tenant = id(info.hub_id),
      userId = id(info.user_id),
      appId = id(info.app_id),
      signed = record(info.signed_access_token);
    if (
      typeof signed.isUserLevel !== "boolean" ||
      id(signed.hubId) !== tenant ||
      id(signed.userId) !== userId ||
      id(signed.appId) !== appId ||
      (body.hub_id !== undefined && id(body.hub_id) !== tenant)
    )
      throw new NativeActionError(
        "incomplete_response",
        "HubSpot token identity metadata disagrees.",
      );
    const level = signed.isUserLevel ? "user" : "account",
      expectedActor = level === "user" ? "user" : "app";
    if (settings.actor !== expectedActor)
      throw new NativeActionError(
        "authorization_required",
        "HubSpot returned a different user-level or account-level authorization than selected.",
      );
    const actual = parseScopes(info.scopes);
    if (body.scopes !== undefined) {
      const returned = parseScopes(body.scopes);
      if (actual.length !== returned.length || actual.some((scope) => !returned.includes(scope)))
        throw new NativeActionError(
          "incomplete_response",
          "HubSpot token and introspection scopes disagree.",
        );
    }
    return {
      tokens,
      expiresAt,
      scopes: actual,
      identity: this.identity(
        config,
        level === "user" ? userId : `app:${appId}:user:${userId}`,
        tenant,
        typeof info.hub_domain === "string" ? info.hub_domain : `HubSpot ${tenant}`,
        {
          hubId: tenant,
          appId,
          authorizingUserId: userId,
          hubspotAccessLevel: level,
          actorType: expectedActor,
        },
      ),
    };
  }
  private identity(
    config: NativeAppConfig,
    subject: string,
    tenant: string | null,
    displayName: string,
    extra: Data = {},
  ): NativeIdentity {
    const { app, settings } = selected(config);
    if (settings.tenantId && settings.tenantId !== tenant)
      throw new NativeActionError(
        "authorization_required",
        "The authorization belongs to another workspace or account.",
      );
    return {
      authority: BUSINESS_FILES_APPS[app].authority,
      subject,
      tenant,
      displayName,
      context: {
        businessFilesApp: app,
        actorType: settings.actor,
        credentialType: config.credentialKind,
        configuredScopes: [...settings.scopes],
        ...extra,
      },
    };
  }
  private async clickupIdentity(
    config: NativeAppConfig,
    token: string,
    signal: AbortSignal,
  ): Promise<NativeIdentity> {
    const authorization = config.credentialKind === "personal_token" ? token : `Bearer ${token}`;
    const me = record(
        (
          await this.json(
            "https://api.clickup.com/api/v2/user",
            { headers: { Authorization: authorization } },
            signal,
          )
        ).user,
      ),
      body = await this.json(
        "https://api.clickup.com/api/v2/team",
        { headers: { Authorization: authorization } },
        signal,
      );
    if (!Array.isArray(body.teams))
      throw new NativeActionError(
        "incomplete_response",
        "ClickUp omitted authorized workspace identities.",
      );
    const workspaceIds = [...new Set(body.teams.map((team) => id(record(team).id)))];
    return this.identity(config, id(me.id), null, required(me.username, "a user name"), {
      workspaceIds,
      scopeAuthority: "provider_enforced",
    });
  }
  private bearer(url: string, token: string, signal: AbortSignal): Promise<Data> {
    return this.json(url, { headers: { Authorization: `Bearer ${token}` } }, signal);
  }
  private basic(clientId: string, secret: string, urlSafe = false): string {
    return `Basic ${Buffer.from(`${clientId}:${secret}`).toString(urlSafe ? "base64url" : "base64")}`;
  }
  private form(
    url: string,
    args: Record<string, string>,
    signal: AbortSignal,
    authorization?: string,
    mutation = true,
  ): Promise<Data> {
    return this.json(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: new URLSearchParams(args),
      },
      signal,
      mutation,
    );
  }
  private uncertain(error: unknown, app: string): never {
    throw new NativeActionError(
      error instanceof NativeActionError ? error.kind : "incomplete_response",
      "The authorization credential was issued but could not be safely verified. Connect again before using this account.",
      { uncertain: true, recovery: { authority: app } },
    );
  }
  private async json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    mutation = false,
  ): Promise<Data> {
    const bounded = combineSignals(signal, AbortSignal.timeout(20_000));
    let response: Response;
    try {
      response = await this.fetch(url, { ...init, redirect: "manual", signal: bounded });
    } catch {
      throw new NativeActionError(
        "temporarily_unavailable",
        "The authorization service could not be reached.",
        { uncertain: mutation },
      );
    }
    let body: Data | undefined;
    try {
      const read = await nativeAbortable(readBoundedText(response, 1_000_000), bounded);
      if (!read.truncated) body = asRecord(JSON.parse(read.text));
    } catch {
      /* Never expose upstream payloads or credentials. */
    }
    if (!response.ok || body?.error !== undefined) {
      const code = body?.error,
        retry = Number(response.headers.get("retry-after"));
      throw new NativeActionError(
        code === "invalid_client"
          ? "not_configured"
          : response.status === 401 ||
              ["invalid_grant", "expired_access_token", "invalid_refresh_token"].includes(
                String(code),
              )
            ? "authorization_expired"
            : response.status === 429
              ? "rate_limited"
              : response.status >= 500
                ? "temporarily_unavailable"
                : "authorization_required",
        "The authorization service rejected this request.",
        {
          uncertain: mutation && (response.status === 408 || response.status >= 500),
          ...(response.status === 429 && Number.isFinite(retry) && retry > 0
            ? { retryAfterSeconds: retry }
            : {}),
        },
      );
    }
    if (!body)
      throw new NativeActionError(
        "incomplete_response",
        "The authorization response was incomplete.",
        { uncertain: mutation },
      );
    return body;
  }
}
