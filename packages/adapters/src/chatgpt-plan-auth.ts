import type { JsonWebKey } from "node:crypto";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

export const CHATGPT_PLAN_ISSUER = "https://auth.openai.com";
export const CHATGPT_PLAN_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_PLAN_TERMINAL_REFRESH_ERROR_CODES = [
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
] as const;
export const MAX_CHATGPT_PLAN_TOKEN_RESPONSE_BYTES = 64 * 1024;
const DISCOVERY_URL = `${CHATGPT_PLAN_ISSUER}/.well-known/openid-configuration`;
const AUTHORIZE_URL = `${CHATGPT_PLAN_ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${CHATGPT_PLAN_ISSUER}/api/accounts/oauth/token`;
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const SCOPES = `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_SCOPE}`;
const MAX_METADATA_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const AUTHORIZATION_TTL_MS = 15 * 60 * 1000;
const METADATA_TTL_MS = 5 * 60 * 1000;
const CLOCK_TOLERANCE_SECONDS = 5;
const consumedAuthorizations = new WeakSet<ChatGPTPlanAuthorization>();

/** A registration survives sign-out. A newly issued ID can be saved before identity is known. */
export type ChatGPTPlanRegistration = {
  clientId: string;
  issuer?: string;
  subject?: string;
  email?: string;
};

export type ChatGPTPlanCredential = OAuthCredential & {
  clientId: string;
  issuer: string;
  subject: string;
  hostId: string;
  idToken: string;
  scopes: string[];
  email?: string;
  earliestRefreshAt?: number;
  /** Encrypted recovery state. Never usable for inference before identity verification. */
  pendingRotation?: ChatGPTPlanPendingRotation;
};

type ChatGPTPlanPendingRotation = {
  receivedAt: number;
  response: {
    access_token: string;
    refresh_token: string;
    id_token: string;
    expires_in: number;
    scope: string;
    token_type?: "Bearer";
    earliest_refresh_at?: number | string;
  };
};

const rotationCheckpoints = new WeakMap<object, ChatGPTPlanCredential>();

/** The token set is deliberately absent from enumerable properties, messages and causes. */
export class ChatGPTPlanRotationPendingError extends Error {
  constructor() {
    super("ChatGPT token renewal needs identity verification. Try again or reconnect ChatGPT.");
    this.name = "ChatGPTPlanRotationPendingError";
  }
}

export function chatGPTPlanRotationCheckpoint(error: unknown): ChatGPTPlanCredential | undefined {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 10; depth += 1) {
    if (current === null || typeof current !== "object" || seen.has(current)) return undefined;
    const checkpoint = rotationCheckpoints.get(current);
    if (checkpoint) return checkpoint;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

export function isChatGPTPlanRotationPendingError(error: unknown): boolean {
  return chatGPTPlanRotationCheckpoint(error) !== undefined;
}

export type ChatGPTPlanLoginContext = {
  hostId: string;
  redirectUri: string;
  registration?: ChatGPTPlanRegistration;
  idTokenHint?: string;
  agentName?: string;
  onRegistration?: (registration: ChatGPTPlanRegistration) => Promise<void> | void;
};

export type ChatGPTPlanAuthorization = {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  hostId: string;
  registration?: ChatGPTPlanRegistration;
  expiresAt: number;
};

export type ChatGPTPlanAuthOptions = {
  fetch?: typeof fetch;
  now?: () => number;
};

type CompleteOptions = ChatGPTPlanAuthOptions & {
  signal?: AbortSignal;
  onRegistration?: ChatGPTPlanLoginContext["onRegistration"];
};

type Discovery = { issuer: string; jwksUri: string; revocationEndpoint?: string };
type VerifiedIdentity = { issuer: string; subject: string; email?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validClientId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value) && value !== DYNAMIC_CLIENT_ID
  );
}

function validHostId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ) ||
      /^urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}$/.test(value) ||
      /^did:key:z[1-9A-HJ-NP-Za-km-z]{16,256}$/.test(value))
  );
}

function readScopes(value: unknown): string[] | undefined {
  const scopes = typeof value === "string" ? value.trim().split(/\s+/) : value;
  if (
    !Array.isArray(scopes) ||
    scopes.length > 64 ||
    scopes.some(
      (scope) => typeof scope !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope),
    )
  ) {
    return undefined;
  }
  return [...new Set(scopes)] as string[];
}

/** Validate encrypted storage before credentials reach refresh or inference. */
export function readChatGPTPlanCredential(value: unknown): ChatGPTPlanCredential | undefined {
  const data = record(value);
  const scopes = readScopes(data?.scopes);
  if (
    data?.type !== "oauth" ||
    !nonempty(data.access) ||
    !nonempty(data.refresh) ||
    typeof data.expires !== "number" ||
    !Number.isFinite(data.expires) ||
    data.expires < 0 ||
    !validClientId(data.clientId) ||
    data.issuer !== CHATGPT_PLAN_ISSUER ||
    !nonempty(data.subject) ||
    !validHostId(data.hostId) ||
    !nonempty(data.idToken) ||
    !scopes?.includes(CHATGPT_PLAN_SCOPE) ||
    (data.email !== undefined && !nonempty(data.email)) ||
    (data.earliestRefreshAt !== undefined &&
      (typeof data.earliestRefreshAt !== "number" ||
        !Number.isFinite(data.earliestRefreshAt) ||
        data.earliestRefreshAt < 0)) ||
    (data.pendingRotation !== undefined && !readPendingRotation(data.pendingRotation))
  ) {
    return undefined;
  }
  return { ...data, scopes } as ChatGPTPlanCredential;
}

function readPendingRotation(value: unknown): ChatGPTPlanPendingRotation | undefined {
  const data = record(value);
  const response = record(data?.response);
  if (
    !data ||
    !response ||
    typeof data.receivedAt !== "number" ||
    !Number.isFinite(data.receivedAt) ||
    data.receivedAt <= 0 ||
    !nonempty(response.access_token) ||
    !nonempty(response.refresh_token) ||
    !nonempty(response.id_token) ||
    typeof response.expires_in !== "number" ||
    !Number.isFinite(response.expires_in) ||
    response.expires_in <= 0 ||
    !Number.isFinite(data.receivedAt + response.expires_in * 1000) ||
    data.receivedAt + response.expires_in * 1000 > Number.MAX_SAFE_INTEGER ||
    typeof response.scope !== "string" ||
    !readScopes(response.scope)?.includes(CHATGPT_PLAN_SCOPE) ||
    (response.token_type !== undefined && response.token_type !== "Bearer")
  )
    return undefined;
  try {
    earliestRefreshTime(response.earliest_refresh_at);
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_CHATGPT_PLAN_TOKEN_RESPONSE_BYTES + 1024)
      return undefined;
  } catch {
    return undefined;
  }
  return data as ChatGPTPlanPendingRotation;
}

function requireCredential(value: unknown): ChatGPTPlanCredential {
  const credential = readChatGPTPlanCredential(value);
  if (!credential)
    throw new Error("Stored ChatGPT plan credential is invalid. Connect ChatGPT again.");
  return credential;
}

function loopbackUri(value: string): URL {
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\//.test(value)) {
    throw new Error("ChatGPT callback must be an HTTP URL on 127.0.0.1.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ChatGPT callback must be an HTTP URL on 127.0.0.1.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("ChatGPT callback must be an HTTP URL on 127.0.0.1.");
  }
  return url;
}

export function beginChatGPTPlanAuthorization(
  input: ChatGPTPlanLoginContext,
  options: ChatGPTPlanAuthOptions = {},
): { authorizationUrl: string; transaction: ChatGPTPlanAuthorization } {
  if (!validHostId(input.hostId)) throw new Error("ChatGPT requires a stable host identifier.");
  const redirectUri = loopbackUri(input.redirectUri).toString();
  const registration = input.registration;
  if (
    registration &&
    (!validClientId(registration.clientId) ||
      (registration.issuer !== undefined && registration.issuer !== CHATGPT_PLAN_ISSUER) ||
      (registration.subject !== undefined && !nonempty(registration.subject)))
  ) {
    throw new Error("Stored ChatGPT registration is invalid. Connect ChatGPT again.");
  }
  const transaction: ChatGPTPlanAuthorization = {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
    redirectUri,
    hostId: input.hostId,
    registration: registration ? { ...registration } : undefined,
    expiresAt: (options.now ?? Date.now)() + AUTHORIZATION_TTL_MS,
  };
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: registration?.clientId ?? DYNAMIC_CLIENT_ID,
    ext_agent_host_id: input.hostId,
    response_type: "code",
    redirect_uri: redirectUri,
    resource: CHATGPT_PLAN_RESOURCE,
    scope: SCOPES,
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(transaction.verifier).digest("base64url"),
  }).toString();
  if (!registration) url.searchParams.set("agent_name_hint", input.agentName ?? "CogineBot");
  if (registration && input.idTokenHint) url.searchParams.set("id_token_hint", input.idTokenHint);
  if (registration?.email) url.searchParams.set("login_hint", registration.email);
  // Authorization URLs containing id_token_hint must never be logged or saved in diagnostics.
  return { authorizationUrl: url.toString(), transaction };
}

function parseCallback(transaction: ChatGPTPlanAuthorization, input: string, now: number) {
  if (consumedAuthorizations.has(transaction)) throw new Error("ChatGPT sign-in was already used.");
  consumedAuthorizations.add(transaction);
  if (transaction.expiresAt <= now)
    throw new Error("ChatGPT sign-in expired. Start sign-in again.");
  if (input.length > 16 * 1024 || !/^http:\/\/127\.0\.0\.1:/.test(input.trim())) {
    throw new Error("ChatGPT callback URL does not match this sign-in.");
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Paste the complete ChatGPT callback URL.");
  }
  const expected = loopbackUri(transaction.redirectUri);
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("ChatGPT callback URL does not match this sign-in.");
  }
  for (const key of ["state", "code", "client_id", "error"]) {
    if (url.searchParams.getAll(key).length > 1) throw new Error("ChatGPT callback is ambiguous.");
  }
  if (["access_token", "refresh_token", "id_token"].some((key) => url.searchParams.has(key))) {
    throw new Error("ChatGPT callback must not contain credentials.");
  }
  if (url.searchParams.get("state") !== transaction.state)
    throw new Error("ChatGPT OAuth state mismatch.");
  if (url.searchParams.has("error"))
    throw new Error("ChatGPT authorization was declined or failed.");
  const code = url.searchParams.get("code");
  if (!nonempty(code)) throw new Error("ChatGPT callback did not contain an authorization code.");
  const callbackClient = url.searchParams.get("client_id");
  const clientId = callbackClient ?? transaction.registration?.clientId;
  if (!validClientId(clientId))
    throw new Error("ChatGPT registration did not return an issued client ID.");
  if (transaction.registration && clientId !== transaction.registration.clientId) {
    throw new Error("ChatGPT callback changed the selected registration.");
  }
  return { code, clientId };
}

function metadataUrl(value: unknown): string {
  if (!nonempty(value)) throw new Error("ChatGPT discovery metadata is invalid.");
  const url = new URL(value);
  if (url.origin !== CHATGPT_PLAN_ISSUER || url.username || url.password || url.hash) {
    throw new Error("ChatGPT discovery endpoint is invalid.");
  }
  return url.toString();
}

function earliestRefreshTime(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  let timestamp = typeof value === "number" ? value * 1000 : Number.NaN;
  if (typeof value === "string") {
    const iso =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
        value,
      );
    if (iso) {
      const year = Number(iso[1]);
      const month = Number(iso[2]);
      const day = Number(iso[3]);
      const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= monthDays[month - 1]! &&
        Number(iso[4]) < 24 &&
        Number(iso[5]) < 60 &&
        Number(iso[6]) < 60 &&
        (iso[7] === undefined || (Number(iso[7]) < 24 && Number(iso[8]) < 60))
      ) {
        timestamp = Date.parse(value);
      }
    }
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Number.MAX_SAFE_INTEGER) {
    throw new Error("ChatGPT token response has an invalid earliest refresh time.");
  }
  return timestamp;
}

function createClient(options: ChatGPTPlanAuthOptions) {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let discoveryCache: { value: Discovery; expires: number } | undefined;
  let jwksCache: { keys: Record<string, unknown>[]; expires: number; uri: string } | undefined;

  async function jsonRequest(
    url: string,
    init: RequestInit,
    maxBytes: number,
  ): Promise<Record<string, unknown>> {
    const signal = AbortSignal.any([
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await withAbort(request(url, { ...init, signal, redirect: "error" }), signal);
    } catch {
      signal.throwIfAborted();
      throw new Error("ChatGPT authorization request could not reach OpenAI.");
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("ChatGPT authorization response is too large.");
    }
    let body: Record<string, unknown> | undefined;
    try {
      const bytes = await readBodyCapped(response, maxBytes, signal);
      body = record(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof Error && error.message === "Response is too large") {
        throw new Error("ChatGPT authorization response is too large.");
      }
      throw new Error(`ChatGPT authorization returned an invalid response (${response.status}).`);
    }
    if (!response.ok) {
      const knownErrors = new Set([
        ...CHATGPT_PLAN_TERMINAL_REFRESH_ERROR_CODES,
        "invalid_client",
        "access_denied",
        "invalid_scope",
        "unauthorized_client",
        "unsupported_grant_type",
        "server_error",
        "temporarily_unavailable",
      ]);
      const errorCode =
        typeof body?.error === "string" && knownErrors.has(body.error) ? ` ${body.error}` : "";
      throw new Error(`ChatGPT OAuth request failed (${response.status})${errorCode}.`);
    }
    if (!body) throw new Error("ChatGPT authorization returned an invalid response.");
    return body;
  }

  async function discovery(signal?: AbortSignal): Promise<Discovery> {
    if (discoveryCache && discoveryCache.expires > now()) return discoveryCache.value;
    const body = await jsonRequest(DISCOVERY_URL, { signal }, MAX_METADATA_BYTES);
    if (body.issuer !== CHATGPT_PLAN_ISSUER)
      throw new Error("ChatGPT discovery issuer does not match.");
    const value: Discovery = {
      issuer: CHATGPT_PLAN_ISSUER,
      jwksUri: metadataUrl(body.jwks_uri),
      ...(body.revocation_endpoint !== undefined
        ? { revocationEndpoint: metadataUrl(body.revocation_endpoint) }
        : {}),
    };
    discoveryCache = { value, expires: now() + METADATA_TTL_MS };
    return value;
  }

  async function keys(uri: string, signal: AbortSignal | undefined, force = false) {
    if (!force && jwksCache?.uri === uri && jwksCache.expires > now()) return jwksCache.keys;
    const body = await jsonRequest(uri, { signal }, MAX_METADATA_BYTES);
    if (
      !Array.isArray(body.keys) ||
      body.keys.length > 64 ||
      body.keys.some((key) => !record(key))
    ) {
      throw new Error("ChatGPT signing keys are invalid.");
    }
    const value = body.keys as Record<string, unknown>[];
    jwksCache = { keys: value, uri, expires: now() + METADATA_TTL_MS };
    return value;
  }

  async function verifyIdentity(
    idToken: string,
    clientId: string,
    signal?: AbortSignal,
    expectedNonce?: string,
    registration?: ChatGPTPlanRegistration,
  ): Promise<VerifiedIdentity> {
    const parts = idToken.split(".");
    if (
      idToken.length > MAX_CHATGPT_PLAN_TOKEN_RESPONSE_BYTES ||
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    ) {
      throw new Error("ChatGPT ID token is invalid.");
    }
    let header: Record<string, unknown> | undefined;
    let claims: Record<string, unknown> | undefined;
    try {
      header = record(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")));
      claims = record(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
    } catch {
      throw new Error("ChatGPT ID token is invalid.");
    }
    if (
      !header ||
      !claims ||
      header.alg !== "RS256" ||
      !nonempty(header.kid) ||
      header.crit !== undefined
    ) {
      throw new Error("ChatGPT ID token signing algorithm is invalid.");
    }
    const config = await discovery(signal);
    const hadCachedKeys = jwksCache?.uri === config.jwksUri && jwksCache.expires > now();
    let candidates = (await keys(config.jwksUri, signal)).filter((key) => key.kid === header.kid);
    if (candidates.length === 0 && hadCachedKeys) {
      candidates = (await keys(config.jwksUri, signal, true)).filter(
        (key) => key.kid === header.kid,
      );
    }
    const key = candidates[0];
    if (
      candidates.length !== 1 ||
      !key ||
      key.kty !== "RSA" ||
      (key.alg !== undefined && key.alg !== "RS256") ||
      (key.use !== undefined && key.use !== "sig") ||
      (key.key_ops !== undefined &&
        (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify")))
    ) {
      throw new Error("ChatGPT ID token signing key is invalid.");
    }
    let signatureValid = false;
    try {
      signatureValid = verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key: key as JsonWebKey, format: "jwk" }),
        Buffer.from(parts[2]!, "base64url"),
      );
    } catch {
      // Malformed public keys and malformed signatures share one safe error.
    }
    if (!signatureValid) throw new Error("ChatGPT ID token signature is invalid.");
    const seconds = now() / 1000;
    const audience = claims.aud;
    const audiences = typeof audience === "string" ? [audience] : audience;
    if (
      claims.iss !== config.issuer ||
      !nonempty(claims.sub) ||
      !Array.isArray(audiences) ||
      audiences.some((aud) => !nonempty(aud)) ||
      !audiences.includes(clientId) ||
      (audiences.length > 1 && claims.azp !== clientId) ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= seconds - CLOCK_TOLERANCE_SECONDS ||
      typeof claims.iat !== "number" ||
      !Number.isFinite(claims.iat) ||
      claims.iat > seconds + CLOCK_TOLERANCE_SECONDS ||
      claims.iat >= claims.exp ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== "number" ||
          !Number.isFinite(claims.nbf) ||
          claims.nbf > seconds + CLOCK_TOLERANCE_SECONDS)) ||
      (expectedNonce !== undefined && claims.nonce !== expectedNonce)
    ) {
      throw new Error("ChatGPT ID token claims do not match this sign-in.");
    }
    if (
      registration?.subject &&
      (claims.sub !== registration.subject ||
        claims.iss !== (registration.issuer ?? CHATGPT_PLAN_ISSUER))
    ) {
      throw new Error("ChatGPT account changed. Connect the intended account again.");
    }
    return {
      issuer: config.issuer,
      subject: claims.sub,
      ...(nonempty(claims.email) ? { email: claims.email } : {}),
    };
  }

  async function tokenRequest(body: URLSearchParams, signal?: AbortSignal) {
    return jsonRequest(
      TOKEN_URL,
      {
        method: "POST",
        signal,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      },
      MAX_CHATGPT_PLAN_TOKEN_RESPONSE_BYTES,
    );
  }

  async function credentialFromResponse(
    body: Record<string, unknown>,
    clientId: string,
    hostId: string,
    signal?: AbortSignal,
    previous?: ChatGPTPlanCredential,
    nonce?: string,
    registration?: ChatGPTPlanRegistration,
    receivedAt = now(),
  ): Promise<ChatGPTPlanCredential> {
    const access = body.access_token;
    const refresh = body.refresh_token;
    const scopes = readScopes(body.scope ?? previous?.scopes);
    if (
      !nonempty(access) ||
      !nonempty(refresh) ||
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0 ||
      receivedAt + body.expires_in * 1000 > Number.MAX_SAFE_INTEGER ||
      (body.token_type !== undefined && body.token_type !== "Bearer") ||
      !scopes?.includes(CHATGPT_PLAN_SCOPE)
    ) {
      throw new Error("ChatGPT token response did not grant valid plan credentials.");
    }
    const idToken = body.id_token ?? previous?.idToken;
    if (!nonempty(idToken)) throw new Error("ChatGPT token response did not contain an ID token.");
    const earliestRefreshAt = earliestRefreshTime(body.earliest_refresh_at);
    let identity: VerifiedIdentity;
    if (previous && body.id_token === undefined) {
      identity = {
        issuer: previous.issuer,
        subject: previous.subject,
        ...(previous.email ? { email: previous.email } : {}),
      };
    } else {
      try {
        identity = await verifyIdentity(idToken, clientId, signal, nonce, registration ?? previous);
      } catch (error) {
        if (!previous) throw error;
        const checkpoint: ChatGPTPlanCredential = {
          ...previous,
          pendingRotation: {
            receivedAt,
            response: {
              access_token: access,
              refresh_token: refresh,
              id_token: idToken,
              expires_in: body.expires_in,
              scope: scopes.join(" "),
              ...(body.token_type === "Bearer" ? { token_type: "Bearer" } : {}),
              ...(body.earliest_refresh_at !== undefined
                ? { earliest_refresh_at: body.earliest_refresh_at as number | string }
                : {}),
            },
          },
        };
        const pending = new ChatGPTPlanRotationPendingError();
        rotationCheckpoints.set(pending, checkpoint);
        throw pending;
      }
    }
    const { pendingRotation: _pending, ...retained } = previous ?? {};
    return {
      ...retained,
      type: "oauth",
      access,
      refresh,
      expires: receivedAt + body.expires_in * 1000,
      clientId,
      hostId,
      idToken,
      scopes,
      earliestRefreshAt,
      ...identity,
    };
  }

  return {
    async complete(
      transaction: ChatGPTPlanAuthorization,
      callbackUrl: string,
      input: CompleteOptions = {},
    ) {
      const { code, clientId } = parseCallback(transaction, callbackUrl, now());
      input.signal?.throwIfAborted();
      if (!transaction.registration) {
        await input.onRegistration?.({ clientId, issuer: CHATGPT_PLAN_ISSUER });
      }
      const body = await tokenRequest(
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: transaction.verifier,
          redirect_uri: transaction.redirectUri,
          resource: CHATGPT_PLAN_RESOURCE,
        }),
        input.signal,
      );
      return credentialFromResponse(
        body,
        clientId,
        transaction.hostId,
        input.signal,
        undefined,
        transaction.nonce,
        transaction.registration,
      );
    },
    async refresh(value: OAuthCredential, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const credential = requireCredential(value);
      // Once rotation begins, the replacement must reach the persistence caller even if
      // the requesting run is cancelled. Abandoning it could invalidate the saved token.
      const refreshSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      if (credential.pendingRotation) {
        return credentialFromResponse(
          credential.pendingRotation.response,
          credential.clientId,
          credential.hostId,
          refreshSignal,
          credential,
          undefined,
          undefined,
          credential.pendingRotation.receivedAt,
        );
      }
      if (credential.earliestRefreshAt !== undefined && now() < credential.earliestRefreshAt) {
        throw new Error("ChatGPT token renewal is not available yet. Try again later.");
      }
      const body = await tokenRequest(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: credential.clientId,
          refresh_token: credential.refresh,
          resource: CHATGPT_PLAN_RESOURCE,
        }),
        refreshSignal,
      );
      return credentialFromResponse(
        body,
        credential.clientId,
        credential.hostId,
        refreshSignal,
        credential,
      );
    },
    async revoke(value: OAuthCredential, signal?: AbortSignal): Promise<{ confirmed: boolean }> {
      const credential = requireCredential(value);
      const requestSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]);
      // Keep the refresh token available through bounded retries before local sign-out clears it.
      for (const backoff of [0, 100, 300]) {
        try {
          if (backoff) await delay(backoff, undefined, { signal: requestSignal });
          requestSignal.throwIfAborted();
          const config = await discovery(requestSignal);
          if (!config.revocationEndpoint) return { confirmed: false };
          const response = await withAbort(
            request(config.revocationEndpoint, {
              method: "POST",
              redirect: "error",
              signal: requestSignal,
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                token: credential.pendingRotation?.response.refresh_token ?? credential.refresh,
                token_type_hint: "refresh_token",
                client_id: credential.clientId,
              }),
            }),
            requestSignal,
          );
          void response.body?.cancel().catch(() => undefined);
          if (response.status === 200) return { confirmed: true };
          if (response.status < 500) return { confirmed: false };
        } catch {
          if (requestSignal.aborted) return { confirmed: false };
        }
      }
      return { confirmed: false };
    },
  };
}

export async function completeChatGPTPlanAuthorization(
  transaction: ChatGPTPlanAuthorization,
  callbackUrl: string,
  options: CompleteOptions = {},
): Promise<ChatGPTPlanCredential> {
  return createClient(options).complete(transaction, callbackUrl, options);
}

/** The persistence caller serializes refresh and commits the complete replacement token set. */
export async function refreshChatGPTPlanCredential(
  credential: OAuthCredential,
  signal?: AbortSignal,
  options: ChatGPTPlanAuthOptions = {},
): Promise<ChatGPTPlanCredential> {
  return createClient(options).refresh(credential, signal);
}

export async function revokeChatGPTPlanCredential(
  credential: OAuthCredential,
  signal?: AbortSignal,
  options: ChatGPTPlanAuthOptions = {},
): Promise<{ confirmed: boolean }> {
  return createClient(options).revoke(credential, signal);
}

export function createChatGPTPlanOAuthAuth(
  options: ChatGPTPlanAuthOptions & {
    getLoginContext?: () => ChatGPTPlanLoginContext | Promise<ChatGPTPlanLoginContext>;
  } = {},
): OAuthAuth {
  const client = createClient(options);
  return {
    name: "ChatGPT plan",
    isSubscription: true,
    loginLabel: "Continue with ChatGPT",
    async login(interaction) {
      if (!options.getLoginContext)
        throw new Error("ChatGPT sign-in requires a local callback listener.");
      const context = await options.getLoginContext();
      const { authorizationUrl, transaction } = beginChatGPTPlanAuthorization(context, options);
      interaction.notify({ type: "auth_url", url: authorizationUrl });
      const callback = await interaction.prompt({
        type: "manual_code",
        message: "Complete ChatGPT authorization in your browser.",
        placeholder: transaction.redirectUri,
        signal: interaction.signal,
      });
      return client.complete(transaction, callback, {
        signal: interaction.signal,
        onRegistration: context.onRegistration,
      });
    },
    refresh: client.refresh,
    async toAuth(value) {
      const credential = requireCredential(value);
      if (credential.pendingRotation) {
        throw new Error("ChatGPT token renewal needs identity verification before use.");
      }
      return { apiKey: credential.access };
    },
  };
}
