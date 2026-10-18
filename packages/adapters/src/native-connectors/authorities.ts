import { createHash } from "node:crypto";
import type { NativeAppConfig } from "@rakazo/db";
import { asRecord, readBoundedText } from "../connector-http.js";
import { combineSignals } from "../connector-safety.js";
import type { OAuthMaterial } from "../mcp-oauth.js";
import type { RemoteTransportDependencies, SafeRemoteFetch } from "../remote-mcp.js";
import { NativeActionError } from "./action.js";
import { NativeConfigSettingsSchema } from "./config.js";
import type { NativeMcpPending } from "./mcp.js";
import { NativeMcpProtocol } from "./mcp.js";
import { createNativeFetch, nativeAbortable } from "./network.js";

export const NOTION_VERSION = "2026-03-11";
export interface NativeTokenMaterial {
  accessToken: string;
  refreshToken: string | null;
  /** Encrypted with the same account grant; never returned in a frontend DTO. */
  mcp?: OAuthMaterial;
}
export interface NativeIdentity {
  authority: string;
  subject: string;
  tenant: string | null;
  displayName: string;
  context: Record<string, unknown>;
}
export interface NativeAuthorization {
  tokens: NativeTokenMaterial;
  identity: NativeIdentity;
  scopes: string[];
  expiresAt: Date | null;
}
function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.length)
    throw new NativeActionError(
      "incomplete_response",
      `The authorization service did not return ${name}.`,
    );
  return value;
}
function expiry(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 31_536_000)
    throw new NativeActionError(
      "incomplete_response",
      "The authorization service returned an invalid token lifetime.",
    );
  return new Date(Date.now() + value * 1000);
}
function tokenMaterial(
  body: Record<string, unknown>,
  previous?: NativeTokenMaterial,
): NativeTokenMaterial {
  const type = body.token_type;
  if (typeof type !== "string" || type.toLowerCase() !== "bearer")
    throw new NativeActionError(
      "incomplete_response",
      "The authorization service returned an unsupported token type.",
    );
  const refresh = body.refresh_token;
  if (refresh !== undefined && refresh !== null && typeof refresh !== "string")
    throw new NativeActionError(
      "incomplete_response",
      "The authorization service returned an invalid refresh token.",
    );
  return {
    accessToken: required(body.access_token, "an access token"),
    refreshToken:
      refresh === undefined ? (previous?.refreshToken ?? null) : (refresh as string | null),
  };
}

/** These two SaaS authorities are fixed code, never model/configuration URLs. */
export class NativeOAuthAuthorities {
  private readonly fetch: SafeRemoteFetch;
  readonly mcp: NativeMcpProtocol;
  constructor(network: RemoteTransportDependencies = {}) {
    this.fetch = createNativeFetch(network);
    this.mcp = new NativeMcpProtocol(network);
  }
  close(): Promise<void> {
    return Promise.all([this.fetch.close(), this.mcp.close()]).then(() => undefined);
  }

  authorizationUrl(config: NativeAppConfig, state: string, verifier: string): string {
    const settings = NativeConfigSettingsSchema.parse(config.config);
    const clientId = required(settings.clientId, "an application client ID");
    if (config.appId === "google-calendar") {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      for (const [key, value] of Object.entries({
        client_id: clientId,
        redirect_uri: config.callbackUri,
        response_type: "code",
        state,
        scope: settings.scopes.join(" "),
        access_type: "offline",
        prompt: "consent select_account",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      }))
        url.searchParams.set(key, value);
      return url.toString();
    }
    if (config.appId === "notion") {
      const url = new URL("https://api.notion.com/v1/oauth/authorize");
      for (const [key, value] of Object.entries({
        client_id: clientId,
        redirect_uri: config.callbackUri,
        response_type: "code",
        owner: "user",
        state,
      }))
        url.searchParams.set(key, value);
      // Notion's published protocol has no PKCE parameters. Its confidential
      // client secret remains in the instance API and the one-use state is DB-bound.
      return url.toString();
    }
    throw new NativeActionError("invalid_input", "This application does not use SaaS OAuth.");
  }

  async exchange(
    config: NativeAppConfig,
    secret: string,
    code: string,
    verifier: string,
    signal: AbortSignal,
    mcpPending?: NativeMcpPending,
    mcpState?: string,
    allowPrivateEndpoint = false,
  ): Promise<NativeAuthorization> {
    if (config.appId === "coginex") {
      if (!mcpPending || !mcpState)
        throw new NativeActionError(
          "authorization_required",
          "The CogineX authorization attempt is unavailable.",
        );
      return this.mcp.exchange(config, mcpPending, code, mcpState, signal, allowPrivateEndpoint);
    }
    const settings = NativeConfigSettingsSchema.parse(config.config);
    const clientId = required(settings.clientId, "an application client ID");
    if (config.appId === "google-calendar") {
      const body = await this.json(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            client_secret: secret,
            redirect_uri: config.callbackUri,
            code,
            code_verifier: verifier,
          }),
        },
        signal,
      );
      const tokens = tokenMaterial(body);
      const scopes = required(body.scope, "the granted scopes").split(/\s+/).filter(Boolean);
      if (!scopes.includes("openid"))
        throw new NativeActionError("insufficient_scope", "Identity permission was not granted.");
      return {
        tokens,
        scopes,
        expiresAt: expiry(body.expires_in),
        identity: await this.googleIdentity(tokens.accessToken, signal),
      };
    }
    if (config.appId === "notion") {
      const body = await this.notionToken(
        clientId,
        secret,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: config.callbackUri,
        },
        signal,
      );
      const tokens = tokenMaterial(body);
      const identity = this.notionIdentity(body);
      const me = await this.notionMe(tokens.accessToken, signal);
      if (me.id !== body.bot_id)
        throw new NativeActionError(
          "authorization_required",
          "The Notion authorization identity did not match its token.",
        );
      return {
        tokens,
        identity,
        scopes: [],
        expiresAt: expiry(body.expires_in),
      };
    }
    throw new NativeActionError("invalid_input", "This application does not use SaaS OAuth.");
  }

  async refresh(
    config: NativeAppConfig,
    secret: string,
    previous: NativeAuthorization,
    signal: AbortSignal,
    allowPrivateEndpoint = false,
  ): Promise<NativeAuthorization> {
    if (config.appId === "coginex")
      return this.mcp.refresh(config, previous, signal, allowPrivateEndpoint);
    const settings = NativeConfigSettingsSchema.parse(config.config);
    const clientId = required(settings.clientId, "an application client ID");
    if (!previous.tokens.refreshToken)
      throw new NativeActionError(
        "authorization_expired",
        "This account requires a new authorization.",
      );
    if (config.appId === "google-calendar") {
      const body = await this.json(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: previous.tokens.refreshToken,
            client_id: clientId,
            client_secret: secret,
          }),
        },
        signal,
      );
      return this.afterRotation(async () => {
        const tokens = tokenMaterial(body, previous.tokens);
        const identity = await this.googleIdentity(tokens.accessToken, signal);
        if (identity.subject !== previous.identity.subject)
          throw new NativeActionError(
            "authorization_expired",
            "The refreshed authorization belongs to another account.",
          );
        const scopes =
          typeof body.scope === "string"
            ? body.scope.split(/\s+/).filter(Boolean)
            : previous.scopes;
        return { tokens, identity, scopes, expiresAt: expiry(body.expires_in) };
      });
    }
    if (config.appId === "notion") {
      const body = await this.notionToken(
        clientId,
        secret,
        {
          grant_type: "refresh_token",
          refresh_token: previous.tokens.refreshToken,
        },
        signal,
      );
      // This provider rotates pairs. A missing/null new refresh token is not
      // replaced with the old one, whose continued usability is unproven.
      return this.afterRotation(async () => {
        const tokens = tokenMaterial(body);
        const me = await this.notionMe(tokens.accessToken, signal);
        if (
          me.id !== previous.identity.context.botId ||
          (body.workspace_id !== undefined && body.workspace_id !== previous.identity.tenant)
        )
          throw new NativeActionError(
            "authorization_expired",
            "The refreshed authorization belongs to another account.",
          );
        if (
          body.owner !== undefined &&
          this.notionIdentity(body).subject !== previous.identity.subject
        )
          throw new NativeActionError(
            "authorization_expired",
            "The refreshed authorization owner changed.",
          );
        return {
          tokens,
          identity: previous.identity,
          scopes: [],
          expiresAt: expiry(body.expires_in),
        };
      });
    }
    throw new NativeActionError(
      "invalid_input",
      "This application does not support token refresh.",
    );
  }

  async verifyNotionToken(
    token: string,
    kind: "internal_token" | "personal_token",
    signal: AbortSignal,
  ): Promise<NativeIdentity> {
    const me = await this.notionMe(token, signal);
    const bot = asRecord(me.bot);
    const owner = asRecord(bot?.owner);
    const user = asRecord(owner?.user);
    // Static tokens are deliberately labelled as internal/PAT by the user;
    // /users/me does not prove an OAuth grant or expose every workspace ID.
    return {
      authority: "https://api.notion.com",
      subject: required(me.id, "a Notion bot identity"),
      tenant: typeof bot?.workspace_id === "string" ? bot.workspace_id : null,
      displayName: typeof me.name === "string" ? me.name : "Notion",
      context: {
        botId: me.id,
        credentialKind: kind,
        ...(owner?.type ? { ownerType: owner.type } : {}),
        ...(typeof user?.id === "string" ? { ownerUserId: user.id } : {}),
      },
    };
  }

  /** Exact Notion token revoke; Google project-wide revocation is never automatic. */
  async revokeNotion(
    config: NativeAppConfig,
    secret: string,
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    const settings = NativeConfigSettingsSchema.parse(config.config);
    await this.json(
      "https://api.notion.com/v1/oauth/revoke",
      {
        method: "POST",
        headers: {
          authorization: this.basic(
            required(settings.clientId, "an application client ID"),
            secret,
          ),
          "content-type": "application/json",
          "Notion-Version": NOTION_VERSION,
        },
        body: JSON.stringify({ token }),
      },
      signal,
    );
  }

  private async googleIdentity(token: string, signal: AbortSignal): Promise<NativeIdentity> {
    // HTTPS userinfo verifies sub at Google's authority; an unsigned id_token
    // payload and a mutable email address are not accepted as the account key.
    const body = await this.json(
      "https://openidconnect.googleapis.com/v1/userinfo",
      {
        headers: { authorization: `Bearer ${token}` },
      },
      signal,
    );
    const subject = required(body.sub, "a Google subject");
    return {
      authority: "https://accounts.google.com",
      subject,
      tenant: null,
      displayName:
        typeof body.email === "string"
          ? body.email
          : typeof body.name === "string"
            ? body.name
            : "Google Calendar",
      context: {
        ...(typeof body.email === "string" && body.email_verified === true
          ? { email: body.email }
          : {}),
      },
    };
  }
  private notionIdentity(body: Record<string, unknown>): NativeIdentity {
    const owner = asRecord(body.owner);
    const user = asRecord(owner?.user);
    if (owner?.type !== "user" || typeof user?.id !== "string")
      throw new NativeActionError(
        "authorization_required",
        "Connect Notion with an individual user's authorization.",
      );
    const workspaceId = required(body.workspace_id, "a Notion workspace identity");
    const botId = required(body.bot_id, "a Notion bot identity");
    return {
      authority: "https://api.notion.com",
      subject: `${workspaceId}:${user.id}:${botId}`,
      tenant: workspaceId,
      displayName: typeof body.workspace_name === "string" ? body.workspace_name : "Notion",
      context: {
        botId,
        ownerUserId: user.id,
        ownerType: "user",
        credentialKind: "oauth",
      },
    };
  }
  private notionMe(token: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.json(
      "https://api.notion.com/v1/users/me",
      {
        headers: {
          authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
        },
      },
      signal,
    );
  }
  private notionToken(
    clientId: string,
    secret: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.json(
      "https://api.notion.com/v1/oauth/token",
      {
        method: "POST",
        headers: {
          authorization: this.basic(clientId, secret),
          "content-type": "application/json",
          "Notion-Version": NOTION_VERSION,
        },
        body: JSON.stringify(body),
      },
      signal,
    );
  }
  private basic(clientId: string, secret: string): string {
    return `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
  }
  private async afterRotation(
    operation: () => Promise<NativeAuthorization>,
  ): Promise<NativeAuthorization> {
    try {
      return await operation();
    } catch (error) {
      const failure =
        error instanceof NativeActionError
          ? error
          : new NativeActionError(
              "incomplete_response",
              "The renewed authorization could not be verified.",
            );
      throw new NativeActionError(failure.kind, failure.message, {
        ...failure.options,
        uncertain: true,
      });
    }
  }
  private async json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const bounded = combineSignals(signal, AbortSignal.timeout(20_000));
    let response: Response;
    try {
      response = await this.fetch(url, { ...init, signal: bounded });
    } catch {
      throw new NativeActionError(
        "temporarily_unavailable",
        "The authorization service could not be reached.",
        { uncertain: init.method === "POST" },
      );
    }
    const read = await nativeAbortable(readBoundedText(response, 1_000_000), bounded).catch(() => {
      throw new NativeActionError(
        "incomplete_response",
        "The authorization response was incomplete.",
        { uncertain: init.method === "POST" },
      );
    });
    if (read.truncated)
      throw new NativeActionError(
        "incomplete_response",
        "The authorization response was incomplete.",
        { uncertain: init.method === "POST" },
      );
    let body: Record<string, unknown> | undefined;
    try {
      body = asRecord(read.text ? JSON.parse(read.text) : {});
    } catch {
      /* generic error below */
    }
    if (!response.ok) {
      const code = body?.error ?? body?.code;
      if (code === "invalid_client")
        throw new NativeActionError(
          "not_configured",
          "The OAuth application configuration was rejected. Ask the deployment administrator to check it.",
        );
      if (code === "invalid_grant" || response.status === 401)
        throw new NativeActionError(
          "authorization_expired",
          "This authorization is no longer valid. Reauthorize this account.",
        );
      throw new NativeActionError(
        response.status === 429
          ? "rate_limited"
          : response.status >= 500
            ? "temporarily_unavailable"
            : "authorization_required",
        "The authorization service rejected this request.",
        {
          uncertain: init.method === "POST" && (response.status === 408 || response.status >= 500),
        },
      );
    }
    if (!body)
      throw new NativeActionError(
        "incomplete_response",
        "The authorization service returned an invalid response.",
        { uncertain: init.method === "POST" },
      );
    return body;
  }
}
