import { createHash } from "node:crypto";
import type { NativeAppConfig } from "@rakazo/db";
import type { JSONWebKeySet } from "jose";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { asRecord, readBoundedText } from "../../connector-http.js";
import { combineSignals } from "../../connector-safety.js";
import type { RemoteTransportDependencies, SafeRemoteFetch } from "../../remote-mcp.js";
import { NativeActionError } from "../action.js";
import type { NativeAuthorization } from "../authorities.js";
import { NativeConfigSettingsSchema } from "../config.js";
import { createNativeFetch, nativeAbortable } from "../network.js";
import { isMicrosoftApp, MICROSOFT_APP_METADATA, MICROSOFT_CONSUMER_TENANT } from "./metadata.js";

type Data = Record<string, unknown>;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function required(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new NativeActionError(
      "incomplete_response",
      "Microsoft omitted required authorization data.",
    );
  return value;
}
function settings(config: NativeAppConfig) {
  const settings = NativeConfigSettingsSchema.parse(config.config);
  if (
    !isMicrosoftApp(config.appId) ||
    config.credentialKind !== "oauth" ||
    settings.actor !== "user"
  )
    throw new NativeActionError(
      "not_configured",
      "Select a delegated Microsoft user OAuth application.",
    );
  const tenant =
    settings.tenantId ??
    (MICROSOFT_APP_METADATA[config.appId].businessOnly ? "organizations" : "common");
  if (!guid.test(tenant) && !["common", "organizations", "consumers"].includes(tenant))
    throw new NativeActionError(
      "not_configured",
      "Select a commercial Microsoft tenant ID or supported account audience.",
    );
  if (
    !settings.scopes.includes("profile") ||
    !settings.scopes.includes("User.Read") ||
    !settings.scopes.includes("openid") ||
    !settings.scopes.includes("offline_access")
  )
    throw new NativeActionError(
      "not_configured",
      "Microsoft authorization requires User.Read, openid, profile and offline_access.",
    );
  return { ...settings, tenant, clientId: required(settings.clientId), appId: config.appId };
}
/** PKCE+nonce confidential authorization; Graph /me is checked against a signed tenant OIDC identity. */
export class MicrosoftAuthorities {
  private readonly fetch: SafeRemoteFetch;
  constructor(network: RemoteTransportDependencies = {}) {
    this.fetch = createNativeFetch(network);
  }
  close(): Promise<void> {
    return this.fetch.close();
  }
  authorizationUrl(config: NativeAppConfig, state: string, verifier: string): string {
    const s = settings(config);
    const u = new URL(`https://login.microsoftonline.com/${s.tenant}/oauth2/v2.0/authorize`);
    u.search = new URLSearchParams({
      client_id: s.clientId,
      response_type: "code",
      redirect_uri: config.callbackUri,
      response_mode: "query",
      scope: s.scopes.join(" "),
      state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      nonce: createHash("sha256").update(`native-microsoft:${verifier}`).digest("base64url"),
    }).toString();
    return u.toString();
  }
  async exchange(
    config: NativeAppConfig,
    secret: string,
    code: string,
    verifier: string,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    const body = await this.token(
      config,
      secret,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: config.callbackUri,
        code_verifier: verifier,
      },
      signal,
    );
    return this.authorization(
      config,
      body,
      signal,
      undefined,
      createHash("sha256").update(`native-microsoft:${verifier}`).digest("base64url"),
    );
  }
  async refresh(
    config: NativeAppConfig,
    secret: string,
    previous: NativeAuthorization,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    if (!previous.tokens.refreshToken)
      throw new NativeActionError("authorization_expired", "Reconnect this Microsoft account.");
    const body = await this.token(
      config,
      secret,
      { grant_type: "refresh_token", refresh_token: previous.tokens.refreshToken },
      signal,
    );
    try {
      return await this.authorization(config, body, signal, previous);
    } catch (error) {
      if (error instanceof NativeActionError && error.kind === "authorization_required")
        throw error;
      throw new NativeActionError(
        "result_unknown",
        "The refresh response requires authorization recovery; do not repeat a rotated grant blindly.",
        { uncertain: true },
      );
    }
  }
  async verifyStatic(
    _config: NativeAppConfig,
    _credential: string,
    _signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    throw new NativeActionError(
      "invalid_input",
      "Microsoft connectors support delegated browser OAuth only.",
    );
  }
  private async token(
    config: NativeAppConfig,
    secret: string,
    extra: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Data> {
    const s = settings(config);
    return this.json(
      `https://login.microsoftonline.com/${s.tenant}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: s.clientId,
          client_secret: secret,
          scope: s.scopes.join(" "),
          ...extra,
        }),
      },
      signal,
      true,
    );
  }
  private async authorization(
    config: NativeAppConfig,
    body: Data,
    signal: AbortSignal,
    previous?: NativeAuthorization,
    nonce?: string,
  ): Promise<NativeAuthorization> {
    const s = settings(config);
    if (String(body.token_type).toLowerCase() !== "bearer")
      throw new NativeActionError(
        "incomplete_response",
        "Microsoft returned an unsupported token type.",
      );
    const accessToken = required(body.access_token);
    let tenant = previous?.identity.tenant,
      oid: unknown = previous?.identity.context.oid;
    let signedSubject: unknown;
    if (body.id_token !== undefined || !previous) {
      const idToken = required(body.id_token);
      let untrusted: Data;
      try {
        untrusted = decodeJwt(idToken);
      } catch {
        throw new NativeActionError(
          "authorization_required",
          "Microsoft identity token is invalid.",
        );
      }
      if (typeof untrusted.tid !== "string" || !guid.test(untrusted.tid))
        throw new NativeActionError(
          "authorization_required",
          "Microsoft omitted a verifiable tenant.",
        );
      const tid = untrusted.tid.toLowerCase();
      const jwks = await this.json(
        `https://login.microsoftonline.com/${tid}/discovery/v2.0/keys`,
        { method: "GET" },
        signal,
      );
      try {
        const verified = await jwtVerify(
          idToken,
          createLocalJWKSet(jwks as unknown as JSONWebKeySet),
          {
            algorithms: ["RS256"],
            audience: s.clientId,
            issuer: `https://login.microsoftonline.com/${tid}/v2.0`,
            requiredClaims: ["exp", "iat", "sub", "oid", "tid"],
            clockTolerance: 30,
          },
        );
        if (
          verified.payload.tid !== tid ||
          (nonce !== undefined && verified.payload.nonce !== nonce)
        )
          throw new Error("identity mismatch");
        tenant = tid;
        oid = verified.payload.oid;
        signedSubject = verified.payload.sub;
      } catch {
        throw new NativeActionError(
          "authorization_required",
          "Microsoft identity signature or account binding is invalid.",
        );
      }
    }
    if (
      !tenant ||
      !guid.test(tenant) ||
      typeof oid !== "string" ||
      !oid ||
      (guid.test(s.tenant) && s.tenant.toLowerCase() !== tenant) ||
      (s.tenant === "organizations" && tenant === MICROSOFT_CONSUMER_TENANT) ||
      (s.tenant === "consumers" && tenant !== MICROSOFT_CONSUMER_TENANT) ||
      (MICROSOFT_APP_METADATA[s.appId].businessOnly && tenant === MICROSOFT_CONSUMER_TENANT)
    )
      throw new NativeActionError(
        "authorization_required",
        "This Microsoft account does not match the configured tenant or account type.",
      );
    if (signedSubject !== undefined) {
      const info = await this.json(
        "https://graph.microsoft.com/oidc/userinfo",
        { headers: { authorization: `Bearer ${accessToken}` } },
        signal,
      );
      if (info.sub !== signedSubject)
        throw new NativeActionError(
          "authorization_required",
          "Microsoft access token and identity token belong to different accounts.",
        );
    }
    const me = await this.json(
      "https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName",
      { headers: { authorization: `Bearer ${accessToken}` } },
      signal,
    );
    const subject = required(me.id);
    if (
      (tenant !== MICROSOFT_CONSUMER_TENANT && subject !== oid) ||
      (previous &&
        (previous.identity.subject !== subject ||
          previous.identity.context.oid !== oid ||
          previous.identity.tenant !== tenant ||
          previous.identity.context.actorType !== "user" ||
          previous.identity.authority !== "https://login.microsoftonline.com"))
    )
      throw new NativeActionError(
        "authorization_required",
        "Microsoft refreshed a different account or tenant.",
      );
    // Microsoft explicitly permits scope omission: it means the exact requested scope.
    // NativeOAuthSession/config revision already freezes this request; never inspect Graph access tokens.
    const granted = (body.scope === undefined ? s.scopes.join(" ") : required(body.scope))
      .split(/\s+/)
      .filter(Boolean)
      .map((scope) => scope.replace(/^https:\/\/graph\.microsoft\.com\//i, ""));
    if (!granted.includes("User.Read"))
      throw new NativeActionError(
        "insufficient_scope",
        "The Microsoft token lacks verified profile permission.",
      );
    const expires = body.expires_in;
    if (
      typeof expires !== "number" ||
      !Number.isSafeInteger(expires) ||
      expires <= 0 ||
      expires > 86400
    )
      throw new NativeActionError(
        "incomplete_response",
        "Microsoft omitted a valid token lifetime.",
      );
    return {
      tokens: {
        accessToken,
        refreshToken:
          body.refresh_token === undefined && previous
            ? previous.tokens.refreshToken
            : required(body.refresh_token),
      },
      scopes: [...new Set(granted)],
      expiresAt: new Date(Date.now() + expires * 1000),
      identity: {
        authority: "https://login.microsoftonline.com",
        subject,
        tenant,
        displayName:
          typeof me.displayName === "string" && me.displayName
            ? me.displayName
            : "Microsoft account",
        context: {
          oid,
          actorType: "user",
          credentialType: "oauth",
          tenantId: tenant,
          accountType: tenant === MICROSOFT_CONSUMER_TENANT ? "personal" : "organization",
        },
      },
    };
  }
  private async json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    mutation = false,
  ): Promise<Data> {
    const bounded = combineSignals(signal, AbortSignal.timeout(20000));
    let response: Response;
    try {
      response = await this.fetch(url, { ...init, redirect: "manual", signal: bounded });
    } catch {
      throw new NativeActionError(
        "temporarily_unavailable",
        "Microsoft authorization is unavailable.",
        { uncertain: mutation },
      );
    }
    let body: Data | undefined;
    try {
      const read = await nativeAbortable(readBoundedText(response, 512000), bounded);
      if (!read.truncated) body = asRecord(JSON.parse(read.text));
    } catch {
      /* Never expose Microsoft response diagnostics or secrets. */
    }
    if (!response.ok || body?.error)
      throw new NativeActionError(
        [
          "invalid_client",
          "unauthorized_client",
          "invalid_scope",
          "invalid_request",
          "unsupported_grant_type",
        ].includes(String(body?.error))
          ? "not_configured"
          : ["temporarily_unavailable", "server_error"].includes(String(body?.error)) ||
              response.status >= 500
            ? "temporarily_unavailable"
            : response.status === 429
              ? "rate_limited"
              : ["invalid_grant", "interaction_required", "consent_required"].includes(
                    String(body?.error),
                  ) || response.status === 401
                ? "authorization_expired"
                : "authorization_required",
        "Microsoft rejected the authorization request.",
        { uncertain: mutation && (response.status === 408 || response.status >= 500) },
      );
    if (!body)
      throw new NativeActionError(
        "incomplete_response",
        "Microsoft returned incomplete authorization data.",
        { uncertain: mutation },
      );
    return body;
  }
}
