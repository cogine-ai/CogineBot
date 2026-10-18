import { createHash, createPrivateKey, sign } from "node:crypto";
import type { NativeAppConfig } from "@rakazo/db";
import { asRecord, readBoundedText } from "../connector-http.js";
import { combineSignals } from "../connector-safety.js";
import type { RemoteTransportDependencies, SafeRemoteFetch } from "../remote-mcp.js";
import { NativeActionError } from "./action.js";
import type { NativeAuthorization, NativeIdentity, NativeTokenMaterial } from "./authorities.js";
import { NativeConfigSettingsSchema } from "./config.js";
import { createNativeFetch, nativeAbortable } from "./network.js";

type Data = Record<string, unknown>;
const GH_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
const IDENTITY_QUERY =
  "query ConnectorIdentity { viewer { id name app organization { id name } } }";
function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new NativeActionError(
      "incomplete_response",
      `The authorization service omitted ${label}.`,
    );
  return value;
}
function record(value: unknown, label: string): Data {
  const result = asRecord(value);
  if (!result)
    throw new NativeActionError(
      "incomplete_response",
      `The authorization service omitted ${label}.`,
    );
  return result;
}
function id(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return required(value, "stable identity");
}
function lifetime(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 31_536_000)
    throw new NativeActionError(
      "incomplete_response",
      "The authorization service returned an invalid lifetime.",
    );
  return new Date(Date.now() + value * 1000);
}
function granted(value: unknown, delimiter: RegExp): string[] {
  if (typeof value !== "string")
    throw new NativeActionError(
      "incomplete_response",
      "The authorization service omitted actual granted scopes.",
    );
  return [...new Set(value.split(delimiter).filter(Boolean))];
}
function mismatch(
  message = "The verified authorization belongs to a different actor or workspace.",
): never {
  throw new NativeActionError("authorization_required", message);
}
function same(previous: NativeAuthorization, next: NativeAuthorization): NativeAuthorization {
  if (
    previous.identity.authority !== next.identity.authority ||
    previous.identity.subject !== next.identity.subject ||
    previous.identity.tenant !== next.identity.tenant ||
    previous.identity.context.actorType !== next.identity.context.actorType ||
    previous.identity.context.tokenType !== next.identity.context.tokenType
  )
    return mismatch();
  return next;
}
function actor(config: NativeAppConfig, permitted: string[]): string {
  const selected = NativeConfigSettingsSchema.parse(config.config).actor;
  if (!selected || !permitted.includes(selected))
    throw new NativeActionError(
      "not_configured",
      "This connection source needs an explicit supported actor.",
    );
  return selected;
}
function token(body: Data, previous?: NativeTokenMaterial, rotating = false): NativeTokenMaterial {
  if (String(body.token_type).toLowerCase() !== "bearer")
    throw new NativeActionError(
      "incomplete_response",
      "The OAuth service returned an unsupported token type.",
    );
  const refresh = body.refresh_token;
  if (rotating && (typeof refresh !== "string" || !refresh))
    throw new NativeActionError(
      "incomplete_response",
      "The rotating authorization omitted its new refresh token.",
    );
  return {
    accessToken: required(body.access_token, "an access token"),
    refreshToken:
      refresh === undefined
        ? (previous?.refreshToken ?? null)
        : required(refresh, "a refresh token"),
  };
}

/** Fixed protocol adapters. Secret persistence and rotation fencing stay in NativeOAuthStore. */
export class CollaborationOAuthAuthorities {
  private readonly fetch: SafeRemoteFetch;
  constructor(network: RemoteTransportDependencies = {}) {
    this.fetch = createNativeFetch(network);
  }
  close(): Promise<void> {
    return this.fetch.close();
  }

  authorizationUrl(config: NativeAppConfig, state: string, verifier: string): string {
    if (config.credentialKind !== "oauth")
      throw new NativeActionError("invalid_input", "This credential does not use browser OAuth.");
    const settings = NativeConfigSettingsSchema.parse(config.config),
      clientId = required(settings.clientId, "an application client ID");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let url: URL;
    if (config.appId === "github") {
      actor(config, ["user"]);
      url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("scope", "offline_access");
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
    } else if (config.appId === "linear") {
      url = new URL("https://linear.app/oauth/authorize");
      url.searchParams.set("actor", actor(config, ["user", "app"]));
      url.searchParams.set("scope", settings.scopes.join(","));
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
    } else if (config.appId === "slack") {
      if (new URL(config.callbackUri).protocol !== "https:")
        throw new NativeActionError(
          "not_configured",
          "Slack OAuth requires a registered HTTPS callback.",
        );
      url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set(
        actor(config, ["bot", "user"]) === "bot" ? "scope" : "user_scope",
        settings.scopes.join(","),
      );
      // Standard confidential Slack OAuth works without the separately enabled PKCE feature.
      if (settings.tenantId) url.searchParams.set("team", settings.tenantId);
    } else throw new NativeActionError("invalid_input", "Unsupported collaboration authority.");
    for (const [key, value] of Object.entries({
      client_id: clientId,
      state,
      redirect_uri: config.callbackUri,
    }))
      url.searchParams.set(key, value);
    return url.toString();
  }

  async exchange(
    config: NativeAppConfig,
    secret: string,
    code: string,
    verifier: string,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    const settings = NativeConfigSettingsSchema.parse(config.config),
      clientId = required(settings.clientId, "an application client ID");
    if (config.appId === "github") {
      actor(config, ["user"]);
      const { body } = await this.form(
        "https://github.com/login/oauth/access_token",
        {
          client_id: clientId,
          client_secret: secret,
          code,
          redirect_uri: config.callbackUri,
          code_verifier: verifier,
        },
        signal,
      );
      const tokens = token(body, undefined, true);
      if (!lifetime(body.expires_in))
        throw new NativeActionError(
          "incomplete_response",
          "GitHub omitted the expiring user token lifetime.",
        );
      if (!tokens.accessToken.startsWith("ghu_"))
        throw new NativeActionError("incomplete_response", "Expected a GitHub App user token.");
      return {
        tokens,
        identity: await this.githubUser(tokens.accessToken, "user", signal),
        scopes: granted(body.scope, /[ ,]+/),
        expiresAt: lifetime(body.expires_in),
      };
    }
    if (config.appId === "linear") {
      actor(config, ["user", "app"]);
      const { body } = await this.form(
        "https://api.linear.app/oauth/token",
        {
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: secret,
          code,
          redirect_uri: config.callbackUri,
          code_verifier: verifier,
        },
        signal,
      );
      const tokens = token(body, undefined, true);
      if (!lifetime(body.expires_in))
        throw new NativeActionError(
          "incomplete_response",
          "Linear omitted the rotating token lifetime.",
        );
      return {
        tokens,
        identity: await this.linearIdentity(config, tokens.accessToken, false, signal),
        scopes: granted(body.scope, /[ ,]+/),
        expiresAt: lifetime(body.expires_in),
      };
    }
    if (config.appId === "slack") {
      actor(config, ["bot", "user"]);
      const { body } = await this.form(
        "https://slack.com/api/oauth.v2.access",
        { code, redirect_uri: config.callbackUri },
        signal,
        this.basic(clientId, secret),
      );
      return this.slackAuthorization(config, body, signal, false);
    }
    throw new NativeActionError("invalid_input", "Unsupported collaboration authority.");
  }

  async refresh(
    config: NativeAppConfig,
    secret: string,
    previous: NativeAuthorization,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    if (config.appId === "github" && config.credentialKind === "github_app_installation") {
      const material = previous.tokens.githubInstallation;
      if (!material)
        throw new NativeActionError(
          "authorization_required",
          "The encrypted installation signing material is missing.",
        );
      return same(previous, await this.installation(config, material, signal));
    }
    const settings = NativeConfigSettingsSchema.parse(config.config),
      clientId = required(settings.clientId, "an application client ID");
    if (!previous.tokens.refreshToken)
      throw new NativeActionError(
        "authorization_expired",
        "This account needs a new authorization.",
      );
    let receivedRotation = false;
    try {
      if (config.appId === "github") {
        const { body } = await this.form(
          "https://github.com/login/oauth/access_token",
          {
            grant_type: "refresh_token",
            client_id: clientId,
            client_secret: secret,
            refresh_token: previous.tokens.refreshToken,
          },
          signal,
        );
        receivedRotation = true;
        const tokens = token(body, previous.tokens, true);
        if (!lifetime(body.expires_in))
          throw new NativeActionError(
            "incomplete_response",
            "GitHub omitted the rotated token lifetime.",
          );
        if (!tokens.accessToken.startsWith("ghu_"))
          throw new NativeActionError("incomplete_response", "Expected a GitHub App user token.");
        return same(previous, {
          tokens,
          identity: await this.githubUser(tokens.accessToken, "user", signal),
          scopes: granted(body.scope, /[ ,]+/),
          expiresAt: lifetime(body.expires_in),
        });
      }
      if (config.appId === "linear") {
        const { body } = await this.form(
          "https://api.linear.app/oauth/token",
          {
            grant_type: "refresh_token",
            client_id: clientId,
            client_secret: secret,
            refresh_token: previous.tokens.refreshToken,
          },
          signal,
        );
        receivedRotation = true;
        const tokens = token(body, previous.tokens, true);
        if (!lifetime(body.expires_in))
          throw new NativeActionError(
            "incomplete_response",
            "Linear omitted the rotated token lifetime.",
          );
        return same(previous, {
          tokens,
          identity: await this.linearIdentity(config, tokens.accessToken, false, signal),
          scopes: granted(body.scope, /[ ,]+/),
          expiresAt: lifetime(body.expires_in),
        });
      }
      if (config.appId === "slack") {
        const { body } = await this.form(
          "https://slack.com/api/oauth.v2.access",
          { grant_type: "refresh_token", refresh_token: previous.tokens.refreshToken },
          signal,
          this.basic(clientId, secret),
        );
        receivedRotation = true;
        return same(previous, await this.slackAuthorization(config, body, signal, true));
      }
      throw new NativeActionError("invalid_input", "Unsupported collaboration authority.");
    } catch (error) {
      const uncertain =
        receivedRotation ||
        (error instanceof NativeActionError && error.options.uncertain === true);
      if (uncertain)
        throw new NativeActionError(
          error instanceof NativeActionError ? error.kind : "temporarily_unavailable",
          "The token rotation outcome is not safely persisted. Do not reuse the old pair without the provider's recovery protocol.",
          {
            uncertain: true,
            recovery: {
              authority: config.appId,
              ...(config.appId === "linear" ? { refresh_replay_grace_seconds: 1800 } : {}),
            },
          },
        );
      throw error;
    }
  }

  async verifyStatic(
    config: NativeAppConfig,
    credential: string,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    if (config.appId === "github" && config.credentialKind === "github_app_installation") {
      actor(config, ["installation"]);
      let material: Data;
      try {
        material = record(JSON.parse(credential), "installation credentials");
      } catch {
        throw new NativeActionError(
          "invalid_input",
          "Enter the protected GitHub App signing credential bundle.",
        );
      }
      if (
        Object.keys(material).some(
          (key) => !["appId", "installationId", "privateKeyPem"].includes(key),
        )
      )
        throw new NativeActionError("invalid_input", "Unexpected installation credential fields.");
      return this.installation(
        config,
        {
          appId: required(material.appId, "an app ID"),
          installationId: required(material.installationId, "an installation ID"),
          privateKeyPem: required(material.privateKeyPem, "an RSA private key"),
        },
        signal,
      );
    }
    if (config.appId === "github" && config.credentialKind === "personal_token") {
      actor(config, ["user"]);
      if (!/^github_pat_[A-Za-z0-9_]{10,}$/.test(credential))
        throw new NativeActionError(
          "invalid_input",
          "Use a fine-grained GitHub personal access token.",
        );
      return {
        tokens: { accessToken: credential, refreshToken: null },
        identity: await this.githubUser(credential, "fine_grained_pat", signal),
        scopes: [],
        expiresAt: null,
      };
    }
    if (config.appId === "linear" && config.credentialKind === "personal_token") {
      actor(config, ["user"]);
      if (!credential || /[\r\n]/.test(credential))
        throw new NativeActionError("invalid_input", "Enter a valid Linear personal API key.");
      return {
        tokens: { accessToken: credential, refreshToken: null },
        identity: await this.linearIdentity(config, credential, true, signal),
        scopes: [],
        expiresAt: null,
      };
    }
    if (
      config.appId === "slack" &&
      ["personal_token", "bot_token"].includes(config.credentialKind)
    ) {
      const selected = actor(config, ["bot", "user"]);
      if (
        (selected === "bot") !== (config.credentialKind === "bot_token") ||
        !(selected === "bot" ? /^xoxb-[A-Za-z0-9-]+$/ : /^xoxp-[A-Za-z0-9-]+$/).test(credential)
      )
        throw new NativeActionError(
          "invalid_input",
          "Use the selected Slack actor's supported nonrotating token, or connect through OAuth.",
        );
      const me = await this.slackIdentity(config, credential, signal);
      const actualScopes = me.headers.get("x-oauth-scopes");
      if (actualScopes === null)
        throw new NativeActionError(
          "incomplete_response",
          "Slack did not return the token's actual scope header.",
        );
      return {
        tokens: { accessToken: credential, refreshToken: null },
        identity: me.identity,
        scopes: granted(actualScopes, /[ ,]+/),
        expiresAt: null,
      };
    }
    throw new NativeActionError(
      "invalid_input",
      "This connection source does not support the submitted credential kind.",
    );
  }

  private async githubUser(
    accessToken: string,
    actorType: "user" | "fine_grained_pat",
    signal: AbortSignal,
  ): Promise<NativeIdentity> {
    const { body } = await this.json(
      "https://api.github.com/user",
      { headers: { ...GH_HEADERS, Authorization: `Bearer ${accessToken}` } },
      signal,
    );
    if (body.type !== "User")
      return mismatch("Expected an authenticated GitHub user, not a bot or organization.");
    return {
      authority: "https://github.com",
      subject: id(body.id),
      tenant: null,
      displayName: required(body.login, "a user login"),
      context: { actorType },
    };
  }

  private async installation(
    config: NativeAppConfig,
    material: NonNullable<NativeTokenMaterial["githubInstallation"]>,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    actor(config, ["installation"]);
    const settings = NativeConfigSettingsSchema.parse(config.config);
    if (
      !/^[1-9][0-9]*$/.test(material.appId) ||
      !/^[1-9][0-9]*$/.test(material.installationId) ||
      (settings.githubAppId && settings.githubAppId !== material.appId) ||
      (settings.githubInstallationId && settings.githubInstallationId !== material.installationId)
    )
      throw new NativeActionError(
        "invalid_input",
        "The signing credentials do not match this configured app and installation.",
      );
    let jwt: string;
    try {
      const key = createPrivateKey(material.privateKeyPem);
      if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
        throw Error("Unsupported key");
      const now = Math.floor(Date.now() / 1000),
        encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const message = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: material.appId, iat: now - 60, exp: now + 9 * 60 })}`;
      jwt = `${message}.${sign("RSA-SHA256", Buffer.from(message), key).toString("base64url")}`;
    } catch {
      throw new NativeActionError(
        "invalid_input",
        "A valid RSA private key of at least 2048 bits is required.",
      );
    }
    const headers = { ...GH_HEADERS, Authorization: `Bearer ${jwt}` };
    const app = (await this.json("https://api.github.com/app", { headers }, signal)).body;
    if (id(app.id) !== material.appId)
      return mismatch("The private key belongs to another GitHub App.");
    const install = (
      await this.json(
        `https://api.github.com/app/installations/${material.installationId}`,
        { headers },
        signal,
      )
    ).body;
    if (
      id(install.id) !== material.installationId ||
      id(install.app_id) !== material.appId ||
      install.suspended_at
    )
      return mismatch("The GitHub installation is unavailable or belongs to another app.");
    const account = record(install.account, "the installation account");
    const body = (
      await this.json(
        `https://api.github.com/app/installations/${material.installationId}/access_tokens`,
        { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" },
        signal,
      )
    ).body;
    const permissions = record(body.permissions, "the installation token permissions");
    const allowed: Data = {};
    for (const [name, value] of Object.entries(permissions))
      if (["read", "write"].includes(String(value))) allowed[name] = value;
    const expiresAt = new Date(required(body.expires_at, "the installation expiry"));
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())
      throw new NativeActionError(
        "incomplete_response",
        "GitHub returned an invalid installation token expiry.",
      );
    const accessToken = required(body.token, "an installation access token");
    return {
      tokens: { accessToken, refreshToken: null, githubInstallation: { ...material } },
      scopes: [],
      expiresAt,
      identity: {
        authority: "https://github.com",
        subject: `installation:${material.installationId}`,
        tenant: id(account.id),
        displayName: required(account.login, "an installation account name"),
        context: {
          actorType: "installation",
          installationId: material.installationId,
          appId: material.appId,
          githubPermissions: allowed,
        },
      },
    };
  }

  private async linearIdentity(
    config: NativeAppConfig,
    accessToken: string,
    apiKey: boolean,
    signal: AbortSignal,
  ): Promise<NativeIdentity> {
    const { body } = await this.json(
      "https://api.linear.app/graphql",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: apiKey ? accessToken : `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query: IDENTITY_QUERY }),
      },
      signal,
      false,
    );
    if (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length))
      throw new NativeActionError(
        "incomplete_response",
        "Linear identity query returned errors or partial data.",
      );
    const viewer = record(record(body.data, "identity data").viewer, "the authenticated viewer"),
      organization = record(viewer.organization, "the authenticated organization");
    const selected = actor(config, ["user", "app"]);
    if (typeof viewer.app !== "boolean" || viewer.app !== (selected === "app"))
      return mismatch("Linear returned a different user/app actor than requested.");
    const tenant = id(organization.id),
      settings = NativeConfigSettingsSchema.parse(config.config);
    if (settings.tenantId && tenant !== settings.tenantId) return mismatch();
    return {
      authority: "https://linear.app",
      subject: id(viewer.id),
      tenant,
      displayName: required(viewer.name, "a viewer name"),
      context: {
        actorType: selected,
        credentialType: apiKey ? "api_key" : "oauth",
        organizationId: tenant,
      },
    };
  }

  private async slackIdentity(
    config: NativeAppConfig,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<{ identity: NativeIdentity; headers: Headers }> {
    const result = await this.json(
      "https://slack.com/api/auth.test",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: "{}",
      },
      signal,
      false,
    );
    this.slackOk(result.body);
    const selected = actor(config, ["bot", "user"]),
      body = result.body,
      subject = required(body.user_id, "a Slack user ID"),
      teamId = required(body.team_id, "a workspace ID"),
      settings = NativeConfigSettingsSchema.parse(config.config);
    if (
      (selected === "bot") !== (typeof body.bot_id === "string" && Boolean(body.bot_id)) ||
      (settings.tenantId && settings.tenantId !== teamId)
    )
      return mismatch();
    return {
      identity: {
        authority: "https://slack.com",
        subject,
        tenant: teamId,
        displayName: typeof body.user === "string" && body.user ? body.user : subject,
        context: {
          tokenType: selected,
          teamId,
          enterpriseId: typeof body.enterprise_id === "string" ? body.enterprise_id : null,
          ...(selected === "bot"
            ? { botUserId: subject, botId: body.bot_id }
            : { userId: subject }),
          slackUserDataAllowed: settings.capabilities.includes("slack_user_data_allowed"),
          slackLegacySearchAllowed: settings.capabilities.includes("slack_legacy_search_allowed"),
        },
      },
      headers: result.headers,
    };
  }
  private async slackAuthorization(
    config: NativeAppConfig,
    body: Data,
    signal: AbortSignal,
    refreshing: boolean,
  ): Promise<NativeAuthorization> {
    this.slackOk(body);
    const selected = actor(config, ["bot", "user"]),
      material =
        !refreshing && selected === "user"
          ? record(body.authed_user, "the selected personal authorization")
          : body;
    if (material.token_type !== selected)
      return mismatch("Slack returned another token actor type.");
    const accessToken = required(material.access_token, "an access token"),
      refreshToken =
        material.refresh_token === undefined
          ? null
          : required(material.refresh_token, "a refresh token");
    if (refreshing && !refreshToken)
      throw new NativeActionError(
        "incomplete_response",
        "Slack omitted its rotated refresh token.",
      );
    if (refreshToken && !lifetime(material.expires_in))
      throw new NativeActionError(
        "incomplete_response",
        "Slack omitted the rotating token lifetime.",
      );
    const { identity } = await this.slackIdentity(config, accessToken, signal);
    if (body.is_enterprise_install === true)
      throw new NativeActionError(
        "not_configured",
        "Org-wide Slack installations require an explicit per-workspace authorization protocol.",
      );
    const team = asRecord(body.team);
    if (!refreshing && (!team || team.id !== identity.tenant))
      return mismatch("Slack OAuth and auth.test returned different workspace identities.");
    const expectedActor = selected === "bot" ? body.bot_user_id : material.id;
    if (expectedActor !== undefined && expectedActor !== identity.subject) return mismatch();
    if (
      body.enterprise &&
      record(body.enterprise, "enterprise metadata").id !== identity.context.enterpriseId
    )
      return mismatch();
    return {
      tokens: { accessToken, refreshToken },
      identity,
      scopes: granted(material.scope, /[ ,]+/),
      expiresAt: lifetime(material.expires_in),
    };
  }
  private slackOk(body: Data): void {
    if (body.ok === true) return;
    const code = body.error;
    throw new NativeActionError(
      ["bad_client_secret", "invalid_client_id", "pkce_not_allowed"].includes(String(code))
        ? "not_configured"
        : [
              "invalid_auth",
              "token_expired",
              "token_revoked",
              "invalid_refresh_token",
              "invalid_grant",
            ].includes(String(code))
          ? "authorization_expired"
          : code === "ratelimited"
            ? "rate_limited"
            : "authorization_required",
      "Slack rejected the authorization request.",
      {
        uncertain: [
          "internal_error",
          "fatal_error",
          "request_timeout",
          "service_unavailable",
        ].includes(String(code)),
      },
    );
  }
  private basic(clientId: string, secret: string): string {
    return `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
  }
  private form(
    url: string,
    parameters: Record<string, string>,
    signal: AbortSignal,
    authorization?: string,
  ): Promise<{ body: Data; headers: Headers }> {
    return this.json(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: new URLSearchParams(parameters),
      },
      signal,
    );
  }
  private async json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    tokenMutation = init.method === "POST",
  ): Promise<{ body: Data; headers: Headers }> {
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
    let body: Data | undefined;
    try {
      const read = await nativeAbortable(readBoundedText(response, 1_000_000), bounded);
      if (!read.truncated) body = asRecord(JSON.parse(read.text));
    } catch {
      /* Never expose response text, credentials or upstream diagnostic payload. */
    }
    if (!response.ok || (body?.error !== undefined && !url.startsWith("https://slack.com/"))) {
      const code = body?.error;
      throw new NativeActionError(
        code === "invalid_client" || code === "incorrect_client_credentials"
          ? "not_configured"
          : response.status === 401 ||
              ["invalid_grant", "bad_refresh_token", "expired_token"].includes(String(code))
            ? "authorization_expired"
            : response.status === 429
              ? "rate_limited"
              : response.status >= 500
                ? "temporarily_unavailable"
                : "authorization_required",
        "The authorization service rejected this request.",
        {
          uncertain:
            tokenMutation &&
            (response.status === 408 ||
              response.status >= 500 ||
              ["internal_error", "fatal_error", "service_unavailable"].includes(String(code))),
        },
      );
    }
    if (!body)
      throw new NativeActionError(
        "incomplete_response",
        "The authorization response was incomplete.",
        { uncertain: tokenMutation },
      );
    return { body, headers: response.headers };
  }
}
