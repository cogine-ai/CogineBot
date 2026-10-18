import type { JSONWebKeySet, JWK, LocalJWKSet } from "jose";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { z } from "zod";
import { readBoundedText } from "../../connector-http.js";
import type { RemoteTransportDependencies, SafeRemoteFetch } from "../../remote-mcp.js";
import { NativeActionError } from "../action.js";
import { createNativeFetch, nativeAbortable } from "../network.js";
import { InvalidNativeEventSignal } from "./signals.js";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const JWKS_LIMIT = 256 * 1024;
const ENVELOPE_LIMIT = 64 * 1024;
const FETCH_TIMEOUT = 10_000;
const REFRESH_COOLDOWN = 30_000;
const MAX_CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_TOKEN_AGE_SECONDS = 65 * 60;
const CLOCK_TOLERANCE_SECONDS = 30;
type Obj = Record<string, unknown>;
const object = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
function reject(): never {
  throw new InvalidNativeEventSignal();
}
function unavailable(): never {
  throw new NativeActionError(
    "temporarily_unavailable",
    "Google's push verification keys are temporarily unavailable.",
  );
}
export interface GmailPushVerificationConfig {
  callbackAudience: string;
  pushServiceAccountEmail: string;
  subscriptionName: string;
}
export interface VerifiedGmailPushSignal {
  /** Pub/Sub delivery identity, never a Gmail message ID. */
  messageId: string;
  publishTime: string;
  emailAddress: string;
  historyId: string;
}
export interface GmailPushVerifier {
  verify(
    input: { authorization?: string | null; rawBody: string | Uint8Array },
    config: GmailPushVerificationConfig,
  ): Promise<VerifiedGmailPushSignal>;
  close(): Promise<void>;
}
const Envelope = z
  .object({
    message: z
      .object({
        data: z.string().min(1).max(8192),
        messageId: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z0-9_-]+$/),
        publishTime: z.iso.datetime({ offset: true }),
        attributes: z
          .record(z.string().max(256), z.string().max(1024))
          .refine((value) => Object.keys(value).length <= 100)
          .optional(),
        orderingKey: z.string().max(1024).optional(),
      })
      .strict(),
    subscription: z.string().min(1).max(1024),
    deliveryAttempt: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict();
const MailboxSignal = z
  .object({ emailAddress: z.email().max(254), historyId: z.string().regex(/^\d{1,200}$/) })
  .strict();
function validateConfig(config: GmailPushVerificationConfig): void {
  let audience: URL;
  try {
    audience = new URL(config.callbackAudience);
  } catch {
    throw new NativeActionError(
      "invalid_input",
      "Configure the exact Gmail push callback audience.",
    );
  }
  if (
    audience.protocol !== "https:" ||
    audience.username ||
    audience.password ||
    audience.hash ||
    !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com$/.test(
      config.pushServiceAccountEmail,
    ) ||
    !/^projects\/[A-Za-z0-9-]{1,128}\/subscriptions\/[A-Za-z][A-Za-z0-9\-_.~+%]{2,254}$/.test(
      config.subscriptionName,
    )
  )
    throw new NativeActionError(
      "invalid_input",
      "Configure the exact Gmail push audience, service account and subscription.",
    );
}
function parseJson(value: Uint8Array | string, maximum: number): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > maximum) return reject();
    return JSON.parse(value);
  }
  if (!(value instanceof Uint8Array) || value.length > maximum) return reject();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
}
function base64Data(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value) || value.replace(/=+$/, "").length % 4 === 1)
    return reject();
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/"),
    bytes = Buffer.from(normalized, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, ""))
    return reject();
  return bytes;
}
function cacheLifetime(headers: Headers): number {
  const cache = headers.get("cache-control") ?? "";
  if (/\bno-store\b|\bno-cache\b/i.test(cache)) return 0;
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cache)?.[1];
  const ageValue = headers.get("age"),
    age = ageValue && /^\d+$/.test(ageValue) ? Number(ageValue) : 0;
  const seconds = maxAge === undefined ? 300 : Number(maxAge);
  return Math.min(MAX_CACHE_MS, Math.max(0, seconds - age) * 1000);
}
function publicKeys(value: unknown): JSONWebKeySet {
  const raw = object(value).keys;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) return unavailable();
  const ids = new Set<string>(),
    keys: JWK[] = [];
  for (const item of raw) {
    const row = object(item);
    if (
      row.kty !== "RSA" ||
      typeof row.kid !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(row.kid) ||
      ids.has(row.kid) ||
      (row.use !== undefined && row.use !== "sig") ||
      (row.alg !== undefined && row.alg !== "RS256") ||
      typeof row.n !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(row.n) ||
      typeof row.e !== "string" ||
      !/^[A-Za-z0-9_-]{1,16}$/.test(row.e) ||
      ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some((key) => row[key] !== undefined)
    )
      return unavailable();
    const modulusBytes = Buffer.from(row.n, "base64url").length;
    if (modulusBytes < 256 || modulusBytes > 1024) return unavailable();
    ids.add(row.kid);
    keys.push({ kty: "RSA", kid: row.kid, use: "sig", alg: "RS256", n: row.n, e: row.e });
  }
  return { keys };
}
interface KeyCache {
  keys: Set<string>;
  resolver: LocalJWKSet;
  loadedAt: number;
  expiresAt: number;
}
class GoogleGmailPushVerifier implements GmailPushVerifier {
  private readonly fetch: SafeRemoteFetch;
  private readonly now: () => number;
  private cache?: KeyCache;
  private inflight?: Promise<KeyCache>;
  private failedAt?: number;
  private closed = false;
  constructor(options: { network?: RemoteTransportDependencies; now?: () => number }) {
    this.fetch = createNativeFetch(options.network, {}, FETCH_TIMEOUT);
    this.now = options.now ?? Date.now;
  }
  private async load(now: number, force = false): Promise<KeyCache> {
    if (!force && this.cache && this.cache.expiresAt > now) return this.cache;
    if (this.inflight) return this.inflight;
    if (this.failedAt !== undefined && now - this.failedAt < REFRESH_COOLDOWN) return unavailable();
    const pending = (async () => {
      try {
        const signal = AbortSignal.timeout(FETCH_TIMEOUT);
        const response = await this.fetch(JWKS_URL, {
          method: "GET",
          signal,
          headers: { accept: "application/json" },
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          return unavailable();
        }
        const body = await nativeAbortable(readBoundedText(response, JWKS_LIMIT), signal);
        if (body.truncated) return unavailable();
        const jwks = publicKeys(JSON.parse(body.text));
        const cache: KeyCache = {
          keys: new Set(jwks.keys.map((key) => key.kid!)),
          resolver: createLocalJWKSet(jwks),
          loadedAt: now,
          expiresAt: now + cacheLifetime(response.headers),
        };
        this.cache = cache;
        this.failedAt = undefined;
        return cache;
      } catch {
        this.failedAt = now;
        return unavailable();
      }
    })();
    this.inflight = pending;
    try {
      return await pending;
    } finally {
      if (this.inflight === pending) this.inflight = undefined;
    }
  }
  async verify(
    input: { authorization?: string | null; rawBody: string | Uint8Array },
    config: GmailPushVerificationConfig,
  ): Promise<VerifiedGmailPushSignal> {
    validateConfig(config);
    if (this.closed) return unavailable();
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) return unavailable();
    if (
      typeof input.authorization !== "string" ||
      input.authorization.length > 16 * 1024 ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.authorization)
    )
      return reject();
    const token = input.authorization.slice(7);
    // Bound the envelope before spending network/crypto work; do not decode its untrusted data yet.
    if (
      typeof input.rawBody === "string"
        ? Buffer.byteLength(input.rawBody, "utf8") > ENVELOPE_LIMIT
        : !(input.rawBody instanceof Uint8Array) || input.rawBody.length > ENVELOPE_LIMIT
    )
      return reject();
    try {
      const header = decodeProtectedHeader(token);
      if (
        header.alg !== "RS256" ||
        typeof header.kid !== "string" ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(header.kid) ||
        (header.typ !== undefined && header.typ !== "JWT") ||
        ["jku", "jwk", "x5u", "x5c", "crit"].some((key) => header[key] !== undefined)
      )
        return reject();
      let cache = await this.load(now);
      if (!cache.keys.has(header.kid) && now - cache.loadedAt >= REFRESH_COOLDOWN)
        cache = await this.load(now, true);
      if (!cache.keys.has(header.kid)) return reject();
      const { payload } = await jwtVerify(token, cache.resolver, {
        algorithms: ["RS256"],
        issuer: ["accounts.google.com", "https://accounts.google.com"],
        audience: config.callbackAudience,
        requiredClaims: ["iss", "aud", "sub", "iat", "exp", "email", "email_verified"],
        currentDate: new Date(now),
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        maxTokenAge: MAX_TOKEN_AGE_SECONDS,
      });
      if (
        payload.aud !== config.callbackAudience ||
        payload.email !== config.pushServiceAccountEmail ||
        payload.email_verified !== true ||
        typeof payload.sub !== "string" ||
        !payload.sub ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.iat! < 0 ||
        payload.exp! <= payload.iat! ||
        payload.iat! > Math.floor(now / 1000) + CLOCK_TOLERANCE_SECONDS
      )
        return reject();
      const envelope = Envelope.parse(parseJson(input.rawBody, ENVELOPE_LIMIT));
      if (envelope.subscription !== config.subscriptionName) return reject();
      const data = MailboxSignal.parse(parseJson(base64Data(envelope.message.data), 6144));
      return {
        messageId: envelope.message.messageId,
        publishTime: envelope.message.publishTime,
        emailAddress: data.emailAddress,
        historyId: data.historyId,
      };
    } catch (error) {
      if (error instanceof NativeActionError && error.kind === "temporarily_unavailable")
        throw error;
      return reject();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cache = undefined;
    await this.fetch.close();
  }
}
/** The only key authority is Google's pinned HTTPS JWKS; test injection is a transport boundary. */
export function createGmailPushVerifier(
  options: { network?: RemoteTransportDependencies; now?: () => number } = {},
): GmailPushVerifier {
  return new GoogleGmailPushVerifier(options);
}
