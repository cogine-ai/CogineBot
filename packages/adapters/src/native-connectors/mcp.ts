import { createHash } from "node:crypto";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  auth,
  exchangeAuthorization,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  InvalidClientError,
  InvalidGrantError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { readBoundedResponseBytes } from "@rakazo/core";
import type { NativeAppConfig } from "@rakazo/db";
import { z } from "zod";
import { asRecord } from "../connector-http.js";
import { combineSignals } from "../connector-safety.js";
import type { OAuthMaterial } from "../mcp-oauth.js";
import { StoredMcpOAuthProvider } from "../mcp-oauth.js";
import type { RemoteTransportDependencies, SafeRemoteFetch } from "../remote-mcp.js";
import { limitRemoteMcpPayload } from "../remote-mcp.js";
import { NativeActionError } from "./action.js";
import type { NativeAuthorization } from "./authorities.js";
import { NativeConfigSettingsSchema } from "./config.js";
import { createNativeFetch, nativeAbortable } from "./network.js";

/** Discovery is never exposed as a model tool; only these business calls are callable. */
export const NATIVE_X_TOOLS = new Set([
  "ContentSearch",
  "CreateDocument",
  "CreateXTask",
  "GetXTaskStatus",
  "ListEntities",
  "NameSearch",
  "PostXTaskThreadMessage",
  "ReadChannelThread",
  "ReadContent",
  "ReadMetadata",
  "RenameDocument",
  "SendChannelMessage",
  "SetXTaskStatus",
]);
const TeamContext = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), teamId: z.uuid() }).strict(),
  z.object({ state: z.literal("none") }).strict(),
  z.object({ state: z.literal("temporarilyUnavailable") }).strict(),
]);
export const NativeXContextSchema = z
  .object({
    schemaVersion: z.literal(2),
    resource: z.url(),
    accountIssuer: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) =>
        /^https?:\/\//.test(value)
          ? URL.canParse(value)
          : /^(?=.{1,253}$)[a-zA-Z0-9.-]+$/.test(value),
      ),
    accountSubject: z.uuid(),
    principal: z.string().min(1).max(512),
    organizationId: z.number().int().nullable(),
    teamContext: TeamContext,
  })
  .strict();
export type NativeXContext = z.infer<typeof NativeXContextSchema>;
export type NativeMcpPending = {
  material: OAuthMaterial;
  authorizationUrl: string;
};

function unavailable(message = "This CogineX account requires a new authorization.") {
  return new NativeActionError("authorization_required", message);
}
function endpointFor(config: NativeAppConfig): URL {
  const settings = NativeConfigSettingsSchema.parse(config.config);
  if (config.appId !== "coginex" || config.credentialKind !== "mcp_oauth" || !settings.endpoint)
    throw new NativeActionError("not_configured", "Choose a configured CogineX MCP source.");
  return new URL(settings.endpoint);
}
function authorityFor(endpoint: URL): string {
  return endpoint.origin;
}
function exactAuthority(value: string | undefined, endpoint: URL): boolean {
  if (!value) return false;
  try {
    return new URL(value).toString() === new URL(authorityFor(endpoint)).toString();
  } catch {
    return false;
  }
}
function assertDiscovery(value: OAuthDiscoveryState, endpoint: URL): void {
  const metadata = value.authorizationServerMetadata;
  const resource = value.resourceMetadata;
  if (
    !exactAuthority(value.authorizationServerUrl, endpoint) ||
    resource?.resource !== endpoint.toString() ||
    resource.authorization_servers?.length !== 1 ||
    !exactAuthority(resource.authorization_servers[0], endpoint) ||
    !metadata ||
    !exactAuthority(metadata.issuer, endpoint)
  )
    throw new NativeActionError(
      "authorization_required",
      "CogineX OAuth resource or authority does not match this source.",
    );
  for (const url of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ]) {
    if (!url || new URL(url).origin !== endpoint.origin)
      throw new NativeActionError(
        "authorization_required",
        "CogineX OAuth endpoints must remain on this source's authority.",
      );
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256"))
    throw new NativeActionError("authorization_required", "CogineX requires S256 PKCE.");
}

/** Reuse the existing DCR/PKCE provider, with stricter binding only for Native X. */
class NativeMcpProvider extends StoredMcpOAuthProvider {
  constructor(
    material: OAuthMaterial,
    private readonly endpoint: URL,
    redirectUri: string,
    state: string,
    onAuthorization?: (url: URL) => void,
  ) {
    super("native-coginex", material, async () => {}, {
      redirectUri,
      state,
      onAuthorization,
    });
  }
  override get clientMetadata(): OAuthClientMetadata {
    return { ...super.clientMetadata, scope: "mcp" };
  }
  override async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL> {
    if (resource !== this.endpoint.toString())
      throw new NativeActionError(
        "authorization_required",
        "The advertised CogineX resource changed.",
      );
    return this.endpoint;
  }
  override async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    assertDiscovery(value, this.endpoint);
    return super.saveDiscoveryState(value);
  }
  override async redirectToAuthorization(url: URL): Promise<void> {
    if (
      url.origin !== this.endpoint.origin ||
      url.searchParams.get("scope") !== "mcp" ||
      url.searchParams.get("resource") !== this.endpoint.toString() ||
      url.searchParams.get("code_challenge_method") !== "S256"
    )
      throw new NativeActionError(
        "authorization_required",
        "The CogineX authorization request changed.",
      );
    return super.redirectToAuthorization(url);
  }
}

export function assertNativeXContext(
  value: unknown,
  resource: string,
  previous?: unknown,
): NativeXContext {
  const parsed = NativeXContextSchema.safeParse(value);
  if (!parsed.success || parsed.data.resource !== resource)
    throw unavailable("The verified CogineX identity is unavailable.");
  if (parsed.data.teamContext.state === "temporarilyUnavailable")
    throw new NativeActionError(
      "temporarily_unavailable",
      "CogineX Team context is temporarily unavailable.",
    );
  if (previous !== undefined) {
    const old = NativeXContextSchema.safeParse(previous);
    if (!old.success || JSON.stringify(old.data) !== JSON.stringify(parsed.data))
      throw new NativeActionError(
        "authorization_expired",
        "The CogineX account or Team context changed. Reauthorize this account.",
      );
  }
  return parsed.data;
}
function resultBody(value: unknown): Record<string, unknown> {
  const response = asRecord(value);
  const body = asRecord(response?.structuredContent);
  if (response?.isError === true) {
    if (body?.code === "identityContextUnavailable")
      throw new NativeActionError(
        "temporarily_unavailable",
        "CogineX identity context is temporarily unavailable.",
      );
    throw new NativeActionError("incomplete_response", "CogineX could not confirm this operation.");
  }
  if (!body)
    throw new NativeActionError("incomplete_response", "CogineX returned no structured result.");
  return body;
}
function authorization(
  config: NativeAppConfig,
  material: OAuthMaterial,
  identity: NativeXContext,
): NativeAuthorization {
  const tokens = material.oauth?.tokens;
  if (
    !tokens?.access_token ||
    tokens.token_type.toLowerCase() !== "bearer" ||
    !tokens.scope?.split(/\s+/).includes("mcp")
  )
    throw unavailable("CogineX did not confirm the required MCP permission.");
  // The broker issues rotating refresh tokens for this registered grant. Never
  // invent an expiry or reuse an old token if the rotating response omits it.
  if (!tokens.refresh_token)
    throw unavailable("CogineX did not return its rotating refresh token.");
  const expires = tokens.expires_in;
  if (
    typeof expires !== "number" ||
    !Number.isFinite(expires) ||
    expires <= 0 ||
    expires > 31_536_000
  )
    throw new NativeActionError(
      "incomplete_response",
      "CogineX returned an invalid token lifetime.",
    );
  return {
    tokens: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      mcp: material,
    },
    identity: {
      authority: authorityFor(endpointFor(config)),
      subject: identity.accountSubject,
      tenant: identity.organizationId === null ? null : String(identity.organizationId),
      displayName: "CogineX",
      context: {
        xConnectionContext: identity,
        allowedEntityTypes: ["document"],
      },
    },
    scopes: ["mcp"],
    expiresAt: new Date((material.oauth?.obtainedAt ?? Date.now()) + expires * 1000),
  };
}

/** Protocol only. NativeOAuthStore owns pending state, SecretStore, grant leases and CAS. */
export class NativeMcpProtocol {
  private readonly active = new Set<SafeRemoteFetch>();
  private closed = false;
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active].map((network) => network.close()));
  }
  constructor(private readonly dependencies: RemoteTransportDependencies = {}) {}
  private network(
    endpoint: URL,
    signal: AbortSignal,
    allowPrivateEndpoint = false,
    jsonOnly = false,
  ): SafeRemoteFetch {
    if (this.closed)
      throw new NativeActionError("temporarily_unavailable", "CogineX transport is closed.");
    const bounded = combineSignals(signal, AbortSignal.timeout(30_000));
    const safe = createNativeFetch(this.dependencies, { allowPrivateEndpoint });
    let closing: Promise<void> | undefined;
    const network = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        if (target.origin !== endpoint.origin)
          throw unavailable("CogineX OAuth traffic cannot leave this source's authority.");
        const response = await safe(input, {
          ...init,
          signal: combineSignals(bounded, init?.signal ?? undefined),
        });
        if (!jsonOnly || !response.body) return response;
        const bytes = await readBoundedResponseBytes(response, {
          maxBytes: 1_000_000,
          tooLargeMessage: "CogineX OAuth response is too large",
          read: (operation) => nativeAbortable(operation(), bounded),
        });
        return new Response(new Uint8Array(bytes).buffer, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
      {
        close: () => {
          closing ??= safe.close().finally(() => {
            this.active.delete(network);
          });
          return closing;
        },
      },
    );
    this.active.add(network);
    return network;
  }
  pendingUrl(config: NativeAppConfig, pending: NativeMcpPending, state: string): string {
    const endpoint = endpointFor(config),
      oauth = pending.material.oauth;
    if (!oauth?.discoveryState || !oauth.codeVerifier || !oauth.clientInformation)
      throw unavailable();
    assertDiscovery(oauth.discoveryState, endpoint);
    const url = new URL(pending.authorizationUrl);
    if (
      url.origin !== endpoint.origin ||
      url.searchParams.get("state") !== state ||
      url.searchParams.get("scope") !== "mcp" ||
      url.searchParams.get("resource") !== endpoint.toString() ||
      url.searchParams.get("redirect_uri") !== config.callbackUri ||
      url.searchParams.get("client_id") !== oauth.clientInformation.client_id ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      url.searchParams.get("code_challenge") !==
        createHash("sha256").update(oauth.codeVerifier).digest("base64url")
    )
      throw unavailable("The CogineX authorization attempt changed.");
    return url.toString();
  }
  async begin(
    config: NativeAppConfig,
    state: string,
    signal: AbortSignal,
    allowPrivateEndpoint = false,
  ): Promise<NativeMcpPending> {
    const endpoint = endpointFor(config),
      material: OAuthMaterial = {};
    let authorizationUrl: string | undefined;
    const provider = new NativeMcpProvider(material, endpoint, config.callbackUri, state, (url) => {
      authorizationUrl = url.toString();
    });
    const network = this.network(endpoint, signal, allowPrivateEndpoint, true);
    try {
      const result = await auth(provider, {
        serverUrl: endpoint,
        scope: "mcp",
        fetchFn: network,
      });
      if (result !== "REDIRECT" || !authorizationUrl || !material.oauth?.codeVerifier)
        throw unavailable();
      const pending = { material, authorizationUrl };
      this.pendingUrl(config, pending, state);
      return pending;
    } catch (error) {
      if (error instanceof NativeActionError) throw error;
      throw new NativeActionError(
        "temporarily_unavailable",
        "Could not start CogineX authorization.",
      );
    } finally {
      await network.close();
    }
  }
  async exchange(
    config: NativeAppConfig,
    pending: NativeMcpPending,
    code: string,
    state: string,
    signal: AbortSignal,
    allowPrivateEndpoint = false,
  ): Promise<NativeAuthorization> {
    this.pendingUrl(config, pending, state);
    const endpoint = endpointFor(config),
      material = structuredClone(pending.material);
    const discovery = material.oauth?.discoveryState;
    if (!discovery) throw unavailable();
    assertDiscovery(discovery, endpoint);
    const provider = new NativeMcpProvider(material, endpoint, config.callbackUri, state);
    const network = this.network(endpoint, signal, allowPrivateEndpoint, true);
    try {
      const clientInformation = material.oauth?.clientInformation;
      if (!clientInformation) throw unavailable();
      // The top-level SDK auth() retries InvalidGrantError with the same code.
      // This one-use callback exchanges exactly once through the SDK primitive.
      const tokens = await exchangeAuthorization(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation,
        authorizationCode: code,
        codeVerifier: provider.codeVerifier(),
        redirectUri: config.callbackUri,
        resource: endpoint,
        fetchFn: network,
      });
      await provider.saveTokens(tokens);
      // PKCE verifier is one-use and does not belong in the long-lived grant.
      delete material.oauth?.codeVerifier;
      const identity = await this.identity(config, material, signal, allowPrivateEndpoint);
      return authorization(config, material, identity);
    } catch (error) {
      if (error instanceof NativeActionError) throw error;
      throw unavailable("Could not complete CogineX authorization. Start a new connection.");
    } finally {
      await network.close();
    }
  }
  async refresh(
    config: NativeAppConfig,
    previous: NativeAuthorization,
    signal: AbortSignal,
    allowPrivateEndpoint = false,
  ): Promise<NativeAuthorization> {
    const endpoint = endpointFor(config),
      material = structuredClone(previous.tokens.mcp);
    const discovery = material?.oauth?.discoveryState;
    const clientInformation = material?.oauth?.clientInformation;
    if (
      !material ||
      !discovery ||
      !clientInformation ||
      !previous.tokens.refreshToken ||
      material.oauth?.tokens?.refresh_token !== previous.tokens.refreshToken ||
      material.oauth.tokens.access_token !== previous.tokens.accessToken
    )
      throw unavailable();
    assertDiscovery(discovery, endpoint);
    const network = this.network(endpoint, signal, allowPrivateEndpoint, true);
    let rotating = false;
    let receivedRefresh: string | undefined;
    const tokenFetch: typeof fetch = async (input, init) => {
      rotating = true;
      const response = await network(input, init);
      // A definite rejection did not issue a successor pair. Lost/5xx replies
      // remain uncertain; NativeOAuthStore retires exactly this leased version.
      if (response.status >= 400 && response.status < 500) rotating = false;
      if (response.status === 429) {
        const raw = response.headers.get("Retry-After");
        const delay =
          raw && /^\d+$/.test(raw)
            ? Number(raw)
            : raw
              ? Math.ceil((Date.parse(raw) - Date.now()) / 1000)
              : undefined;
        throw new NativeActionError("rate_limited", "CogineX authorization is rate limited.", {
          retryAfterSeconds:
            delay !== undefined && Number.isFinite(delay) && delay >= 0 ? delay : undefined,
        });
      }
      if (response.ok) {
        const body = asRecord(await response.clone().json());
        if (typeof body?.refresh_token === "string") receivedRefresh = body.refresh_token;
      }
      return response;
    };
    try {
      const tokens: OAuthTokens = await refreshAuthorization(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation,
        refreshToken: previous.tokens.refreshToken,
        resource: endpoint,
        fetchFn: tokenFetch,
      });
      // The SDK normally preserves an omitted refresh token. This broker
      // rotates token families, so only the actual successor on the wire is valid.
      if (!receivedRefresh || receivedRefresh === previous.tokens.refreshToken)
        throw unavailable("CogineX did not return a successor refresh token.");
      material.oauth!.tokens = tokens;
      material.oauth!.obtainedAt = Date.now();
      const identity = await this.identity(
        config,
        material,
        signal,
        allowPrivateEndpoint,
        previous.identity.context.xConnectionContext,
      );
      return authorization(config, material, identity);
    } catch (error) {
      if (error instanceof InvalidClientError)
        throw new NativeActionError(
          "authorization_expired",
          "The CogineX public client is no longer registered. Reconnect this account.",
        );
      if (error instanceof TooManyRequestsError)
        throw new NativeActionError("rate_limited", "CogineX authorization is rate limited.");
      if (error instanceof InvalidGrantError)
        throw new NativeActionError("authorization_expired", "CogineX authorization expired.");
      if (error instanceof NativeActionError)
        throw new NativeActionError(error.kind, error.message, {
          ...error.options,
          uncertain: rotating || error.options.uncertain,
        });
      throw new NativeActionError(
        "temporarily_unavailable",
        "CogineX authorization could not be renewed.",
        { uncertain: rotating },
      );
    } finally {
      await network.close();
    }
  }
  private async identity(
    config: NativeAppConfig,
    material: OAuthMaterial,
    signal: AbortSignal,
    allowPrivateEndpoint: boolean,
    previous?: unknown,
  ): Promise<NativeXContext> {
    const endpoint = endpointFor(config),
      access = material.oauth?.tokens?.access_token;
    if (!access) throw unavailable();
    return this.withClient(
      config,
      signal,
      allowPrivateEndpoint,
      async () => access,
      async (client, bounded) =>
        assertNativeXContext(
          resultBody(
            await client.callTool(
              {
                name: "GetXConnectionContext",
                arguments: {},
              },
              undefined,
              { signal: bounded, timeout: 30_000 },
            ),
          ),
          endpoint.toString(),
          previous,
        ),
    );
  }
  async call(
    config: NativeAppConfig,
    load: (forceRefresh?: boolean) => Promise<NativeAuthorization>,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    allowPrivateEndpoint = false,
  ): Promise<unknown> {
    if (!NATIVE_X_TOOLS.has(tool))
      throw new NativeActionError("invalid_input", "This CogineX tool is unavailable.");
    const expected = await load();
    return this.withClient(
      config,
      signal,
      allowPrivateEndpoint,
      async (force) => {
        const current = await load(force);
        assertNativeXContext(
          current.identity.context.xConnectionContext,
          endpointFor(config).toString(),
          expected.identity.context.xConnectionContext,
        );
        return current.tokens.accessToken;
      },
      async (client, bounded) => {
        assertNativeXContext(
          resultBody(
            await client.callTool({ name: "GetXConnectionContext", arguments: {} }, undefined, {
              signal: bounded,
              timeout: 30_000,
            }),
          ),
          endpointFor(config).toString(),
          expected.identity.context.xConnectionContext,
        );
        return resultBody(
          await client.callTool({ name: tool, arguments: args }, undefined, {
            signal: bounded,
            timeout: 30_000,
          }),
        );
      },
    );
  }
  private async withClient<T>(
    config: NativeAppConfig,
    signal: AbortSignal,
    allowPrivateEndpoint: boolean,
    accessToken: (forceRefresh?: boolean) => Promise<string>,
    run: (client: Client, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const endpoint = endpointFor(config),
      bounded = combineSignals(signal, AbortSignal.timeout(30_000));
    const network = this.network(endpoint, bounded, allowPrivateEndpoint);
    const bearerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init),
        retry = request.clone();
      if (new URL(request.url).pathname !== endpoint.pathname) throw unavailable();
      const send = async (copy: Request, force = false) => {
        const headers = new Headers(copy.headers);
        headers.set("Authorization", `Bearer ${await accessToken(force)}`);
        return network(copy.url, {
          method: copy.method,
          headers,
          body: copy.body ? await copy.arrayBuffer() : undefined,
          signal: bounded,
        });
      };
      const response = await send(request);
      if (response.status !== 401) return response;
      await response.body?.cancel();
      return send(retry, true);
    };
    // No authProvider: the SDK must not refresh grants outside the Native DB lease.
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: bearerFetch,
    });
    const client = new Client({ name: "coginebot-native", version: "0.1.0" });
    try {
      await client.connect(transport, { signal: bounded, timeout: 30_000 });
      return limitRemoteMcpPayload(await run(client, bounded)) as T;
    } finally {
      await client.close().catch(() => undefined);
      await network.close();
    }
  }
}
