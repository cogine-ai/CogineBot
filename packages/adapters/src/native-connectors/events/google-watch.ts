import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isPrivateRemoteMcpHostname } from "../../remote-mcp.js";
import type { NativeRequest, NativeResponse } from "../action.js";
import { NativeActionError } from "../action.js";
import { InvalidNativeEventSignal } from "./signals.js";

type Obj = Record<string, unknown>;
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const RENEW_BEFORE = 5 * 60 * 1000;
const RETRY = 5 * 60 * 1000;
const MAX_CHANNELS = 32;
const DRIVE_CALLBACK = "/api/connectors/events/drive";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const optional = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
const clone = <T>(value: T): T => structuredClone(value);
function invalid(message: string): never {
  throw new NativeActionError("invalid_input", message);
}
function incomplete(message: string): never {
  throw new NativeActionError("incomplete_response", message);
}
function integer(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
function validNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - WEEK)
    invalid("The watch clock is invalid.");
}
function bindingHash(key: string): string {
  if (typeof key !== "string" || !key || key.length > 16_384)
    return invalid("A server-owned watch authorization binding is required.");
  return sha256(key);
}
export interface GoogleWatchContext {
  /** Exact trigger/grant/config authorization generation, produced by the server. */
  bindingKey: string;
  state: Obj;
  request(request: NativeRequest): Promise<NativeResponse>;
  /** Resolve only after the existing trigger lease/CAS durably committed this state. */
  persistState(state: Obj): Promise<void>;
}
export interface GmailWatchConfig {
  projectId: string;
  topicName: string;
  callbackAudience?: string;
  pushServiceAccountEmail?: string;
}
export interface DriveWatchConfig {
  /** Deployment API URL, never a Routine/model callback argument. */
  apiUrl: string;
  /** The existing reader's durable changes cursor. */
  pageToken: string;
  driveId?: string;
}
export interface GoogleWatchResult {
  state: Obj;
  /** Confirmed registration only; not proof of end-to-end notification delivery. */
  registered: boolean;
  compensationRequired: true;
  nextAttemptAt: number | null;
}
async function persist(context: GoogleWatchContext, state: Obj): Promise<void> {
  await context.persistState(clone(state));
  context.state = clone(state);
}
function result(
  context: GoogleWatchContext,
  registered: boolean,
  nextAttemptAt: number | null,
): GoogleWatchResult {
  return { state: clone(context.state), registered, compensationRequired: true, nextAttemptAt };
}
function authFailure(error: unknown): boolean {
  return (
    error instanceof NativeActionError &&
    ["authorization_required", "authorization_expired", "insufficient_scope"].includes(error.kind)
  );
}
function errorCode(error: unknown): string {
  return error instanceof NativeActionError ? error.kind : "result_unknown";
}
async function call(context: GoogleWatchContext, request: NativeRequest): Promise<unknown> {
  const response = await context.request(request);
  if (response.status >= 200 && response.status < 300) return response.body;
  if (response.status === 401)
    throw new NativeActionError("authorization_expired", "Reconnect the exact Google account.");
  if (response.status === 403)
    throw new NativeActionError(
      "insufficient_scope",
      "Google did not authorize this watch configuration.",
    );
  if (response.status === 429)
    throw new NativeActionError("rate_limited", "Google watch registration is rate limited.");
  throw new NativeActionError(
    response.status >= 500 || response.status === 408 ? "result_unknown" : "invalid_input",
    "Google did not confirm watch registration.",
    { uncertain: response.status >= 500 || response.status === 408 },
  );
}
function gmailConfiguration(config: GmailWatchConfig): string {
  if (
    typeof config.projectId !== "string" ||
    !/^[A-Za-z0-9-]{1,128}$/.test(config.projectId) ||
    typeof config.topicName !== "string"
  )
    return invalid("Configure the OAuth project's existing Pub/Sub topic.");
  const topic =
    /^projects\/([A-Za-z0-9-]{1,128})\/topics\/([A-Za-z][A-Za-z0-9\-_.~+%]{2,254})$/.exec(
      config.topicName,
    );
  if (!topic || topic[1] !== config.projectId)
    return invalid("The Gmail Pub/Sub topic must belong to the exact OAuth developer project.");
  if (config.callbackAudience !== undefined) {
    let url: URL;
    try {
      url = new URL(config.callbackAudience);
    } catch {
      return invalid("Configure the exact HTTPS Gmail callback audience.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      return invalid("Configure the exact HTTPS Gmail callback audience.");
  }
  if (
    config.pushServiceAccountEmail !== undefined &&
    !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com$/.test(config.pushServiceAccountEmail)
  )
    return invalid("Configure the expected Pub/Sub push service account.");
  return sha256(
    JSON.stringify({
      projectId: config.projectId,
      topicName: config.topicName,
      callbackAudience: config.callbackAudience ?? null,
      pushServiceAccountEmail: config.pushServiceAccountEmail ?? null,
    }),
  );
}
interface GmailRegistration extends Obj {
  historyId: string;
  expiration: number;
  confirmedAt: number;
  renewAfter: number;
}
function gmailRegistration(value: unknown): GmailRegistration | undefined {
  const row = optional(value);
  if (
    typeof row.historyId !== "string" ||
    !/^\d{1,200}$/.test(row.historyId) ||
    integer(row.expiration) === undefined ||
    integer(row.confirmedAt) === undefined ||
    integer(row.renewAfter) === undefined
  )
    return undefined;
  return {
    historyId: row.historyId,
    expiration: Number(row.expiration),
    confirmedAt: Number(row.confirmedAt),
    renewAfter: Number(row.renewAfter),
  };
}
/** One leader per configured Google project/subject calls this; Routine filters stay in history reads. */
export async function ensureGmailWatch(
  context: GoogleWatchContext,
  config: GmailWatchConfig,
  now = Date.now(),
): Promise<GoogleWatchResult> {
  validNow(now);
  const bound = bindingHash(context.bindingKey),
    configurationHash = gmailConfiguration(config);
  const prior = optional(context.state.gmailWatch);
  const saved =
    prior.version === 1 &&
    prior.bindingHash === bound &&
    prior.configurationHash === configurationHash
      ? prior
      : {};
  const active = gmailRegistration(saved.active),
    pending = optional(saved.attempt);
  const registered = !!active && active.expiration > now;
  if (registered && active.renewAfter > now) return result(context, true, active.renewAfter);
  if (integer(pending.retryAt) !== undefined && Number(pending.retryAt) > now)
    return result(context, registered, Number(pending.retryAt));
  const attempt = { id: randomUUID(), requestedAt: now, retryAt: now + RETRY, phase: "pending" };
  const base: Obj = {
    version: 1,
    bindingHash: bound,
    configurationHash,
    ...(active ? { active } : {}),
    attempt,
    delivery: registered ? "registered_unverified" : "polling_watch_unconfirmed",
  };
  await persist(context, { ...context.state, gmailWatch: base });
  let current: GmailRegistration;
  try {
    // No labelFilter fields: Gmail has a mailbox watch, not independent per-Routine subscriptions.
    const response = optional(
      await call(context, {
        method: "POST",
        path: "/users/me/watch",
        body: { topicName: config.topicName },
      }),
    );
    const expiration = integer(response.expiration);
    if (
      typeof response.historyId !== "string" ||
      !/^\d{1,200}$/.test(response.historyId) ||
      expiration === undefined ||
      expiration <= now
    )
      return incomplete("Gmail omitted the actual watch history and expiration.");
    current = {
      historyId: response.historyId,
      expiration,
      confirmedAt: now,
      renewAfter: Math.max(now, Math.min(now + DAY, expiration - RENEW_BEFORE)),
    };
  } catch (error) {
    await persist(context, {
      ...context.state,
      gmailWatch: {
        ...base,
        attempt: { ...attempt, phase: "unconfirmed" },
        lastErrorCode: errorCode(error),
      },
    });
    if (authFailure(error)) throw error;
    return result(context, registered, now + RETRY);
  }
  // Keep this outside the request catch: a stale lease may not write a fallback state after ACK persistence fails.
  await persist(context, {
    ...context.state,
    gmailWatch: {
      version: 1,
      bindingHash: bound,
      configurationHash,
      active: current,
      delivery: "registered_unverified",
      pushVerificationConfigured: !!config.callbackAudience && !!config.pushServiceAccountEmail,
    },
  });
  return result(context, true, current.renewAfter);
}

export interface DriveWatchChannel {
  id: string;
  tokenHash: string;
  phase: "pending" | "active" | "retiring";
  resourceId: string | null;
  resourceUri: string | null;
  expiration: number;
  requestedAt: number;
  startPageTokenHash: string;
}
export function driveChannelTokenHash(token: string): string {
  return sha256(token);
}
function resourceUri(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === "https://www.googleapis.com" &&
      url.pathname === "/drive/v3/changes" &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}
function channel(value: unknown): DriveWatchChannel | undefined {
  const row = optional(value);
  if (
    typeof row.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(row.id) ||
    typeof row.tokenHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.tokenHash) ||
    !["pending", "active", "retiring"].includes(String(row.phase)) ||
    integer(row.expiration) === undefined ||
    integer(row.requestedAt) === undefined ||
    typeof row.startPageTokenHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.startPageTokenHash)
  )
    return undefined;
  if (
    row.resourceId !== null &&
    (typeof row.resourceId !== "string" || !row.resourceId || row.resourceId.length > 1024)
  )
    return undefined;
  if (row.resourceUri !== null && !resourceUri(row.resourceUri)) return undefined;
  if (row.phase !== "pending" && (!row.resourceId || !row.resourceUri)) return undefined;
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    phase: row.phase as DriveWatchChannel["phase"],
    resourceId: row.resourceId as string | null,
    resourceUri: row.resourceUri as string | null,
    expiration: Number(row.expiration),
    requestedAt: Number(row.requestedAt),
    startPageTokenHash: row.startPageTokenHash,
  };
}
/** Caller must supply the current authorization-generation binding when looking up callback channels. */
export function driveWatchChannels(state: Obj, bindingKey: string): readonly DriveWatchChannel[] {
  const saved = optional(state.driveWatch);
  if (
    saved.version !== 1 ||
    saved.bindingHash !== bindingHash(bindingKey) ||
    !Array.isArray(saved.channels)
  )
    return [];
  return saved.channels
    .map(channel)
    .filter((value): value is DriveWatchChannel => value !== undefined);
}
function callbackOrigin(apiUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return invalid("Configure this instance's API URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isPrivateRemoteMcpHostname(url.hostname)
  )
    return undefined;
  return url.origin;
}
function driveConfiguration(config: DriveWatchConfig): { origin?: string; fingerprint: string } {
  const origin = callbackOrigin(config.apiUrl);
  if (typeof config.pageToken !== "string" || !config.pageToken || config.pageToken.length > 8192)
    return invalid("A durable Drive changes cursor is required before watch registration.");
  if (config.driveId !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(config.driveId))
    return invalid("The configured shared drive identity is invalid.");
  // Cursor advancement does not change a channel's resource or require re-registration.
  return {
    origin,
    fingerprint: sha256(
      JSON.stringify({ origin: origin ?? null, driveId: config.driveId ?? null }),
    ),
  };
}
/** Pending nonce is durable before POST; confirmed replacement is durable before old channels stop. */
export async function ensureDriveChangesWatch(
  context: GoogleWatchContext,
  config: DriveWatchConfig,
  now = Date.now(),
): Promise<GoogleWatchResult> {
  validNow(now);
  const bound = bindingHash(context.bindingKey),
    configuration = driveConfiguration(config),
    prior = optional(context.state.driveWatch);
  const sameConfiguration =
    prior.version === 1 &&
    prior.bindingHash === bound &&
    prior.configurationHash === configuration.fingerprint;
  const channels = sameConfiguration
    ? driveWatchChannels(context.state, context.bindingKey).filter((row) => row.expiration > now)
    : [];
  if (!configuration.origin) {
    await persist(context, {
      ...context.state,
      driveWatch: {
        version: 1,
        bindingHash: bound,
        configurationHash: configuration.fingerprint,
        channels: [],
        delivery: "polling_only_no_public_https",
      },
    });
    return result(context, false, null);
  }
  const active = channels.find(
    (row) => row.phase === "active" && row.expiration > now + RENEW_BEFORE,
  );
  if (active) return result(context, true, active.expiration - RENEW_BEFORE);
  const registered = channels.some((row) => row.phase === "active" && row.expiration > now);
  if (sameConfiguration && integer(prior.retryAt) !== undefined && Number(prior.retryAt) > now)
    return result(context, registered, Number(prior.retryAt));
  if (channels.length >= MAX_CHANNELS) {
    const retryAt = Math.min(...channels.map((row) => row.expiration));
    await persist(context, {
      ...context.state,
      driveWatch: {
        version: 1,
        bindingHash: bound,
        configurationHash: configuration.fingerprint,
        channels,
        delivery: "polling_channel_budget",
        retryAt,
      },
    });
    return result(context, registered, retryAt);
  }
  const token = randomBytes(32).toString("base64url");
  const pending: DriveWatchChannel = {
    id: randomUUID(),
    tokenHash: driveChannelTokenHash(token),
    phase: "pending",
    resourceId: null,
    resourceUri: null,
    expiration: now + WEEK,
    requestedAt: now,
    startPageTokenHash: sha256(config.pageToken),
  };
  const base: Obj = {
    version: 1,
    bindingHash: bound,
    configurationHash: configuration.fingerprint,
    channels: [...channels, pending],
    retryAt: now + RETRY,
    delivery: registered ? "registered_unverified" : "polling_watch_unconfirmed",
  };
  await persist(context, { ...context.state, driveWatch: base });
  let response: Obj;
  try {
    response = optional(
      await call(context, {
        method: "POST",
        path: "/changes/watch",
        query: {
          pageToken: config.pageToken,
          spaces: "drive",
          includeRemoved: true,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          ...(config.driveId ? { driveId: config.driveId } : {}),
        },
        body: {
          id: pending.id,
          type: "web_hook",
          address: `${configuration.origin}${DRIVE_CALLBACK}`,
          token,
          expiration: String(pending.expiration),
        },
      }),
    );
    const expiration = integer(response.expiration);
    if (
      response.kind !== "api#channel" ||
      response.id !== pending.id ||
      typeof response.resourceId !== "string" ||
      !response.resourceId ||
      response.resourceId.length > 1024 ||
      !resourceUri(response.resourceUri) ||
      expiration === undefined ||
      expiration <= now ||
      expiration > pending.expiration ||
      (response.token !== undefined && response.token !== token)
    )
      return incomplete(
        "Drive omitted a confirmed channel identity, resource or actual expiration.",
      );
  } catch (error) {
    await persist(context, {
      ...context.state,
      driveWatch: { ...base, lastErrorCode: errorCode(error) },
    });
    if (authFailure(error)) throw error;
    return result(context, registered, now + RETRY);
  }
  const confirmed: DriveWatchChannel = {
    ...pending,
    phase: "active",
    resourceId: String(response.resourceId),
    resourceUri: String(response.resourceUri),
    expiration: Number(response.expiration),
  };
  const overlap = [
    ...channels.map((row) =>
      row.phase === "active" ? { ...row, phase: "retiring" as const } : row,
    ),
    confirmed,
  ];
  const activeState: Obj = {
    version: 1,
    bindingHash: bound,
    configurationHash: configuration.fingerprint,
    channels: overlap,
    delivery: "registered_unverified",
    retryAt: 0,
  };
  await persist(context, { ...context.state, driveWatch: activeState });
  const retained: DriveWatchChannel[] = [];
  for (const old of overlap) {
    if (old.phase !== "retiring" || !old.resourceId) {
      retained.push(old);
      continue;
    }
    try {
      await call(context, {
        method: "POST",
        path: "/channels/stop",
        body: { id: old.id, resourceId: old.resourceId },
      });
    } catch {
      retained.push(old);
    }
  }
  if (retained.length !== overlap.length)
    await persist(context, {
      ...context.state,
      driveWatch: { ...activeState, channels: retained },
    });
  return result(context, true, confirmed.expiration - RENEW_BEFORE);
}
export interface DriveWatchSignal {
  phase: "early_sync" | "wake";
  channelId: string;
  resourceId: string;
  resourceUri: string;
  messageNumber: string;
}
/** Validate a hint only; the HTTP route must durably claim it before ACK or scheduling existing reads. */
export function verifyDriveWatchSignal(
  headers: Headers,
  expected: DriveWatchChannel,
  now = Date.now(),
): DriveWatchSignal | null {
  if (!Number.isSafeInteger(now) || now < 0) throw new InvalidNativeEventSignal();
  const stored = channel(expected),
    id = headers.get("x-goog-channel-id"),
    token = headers.get("x-goog-channel-token"),
    resourceId = headers.get("x-goog-resource-id"),
    uri = headers.get("x-goog-resource-uri"),
    state = headers.get("x-goog-resource-state"),
    number = headers.get("x-goog-message-number");
  if (
    !stored ||
    id !== stored.id ||
    !token ||
    token.length > 256 ||
    !resourceId ||
    resourceId.length > 1024 ||
    !resourceUri(uri) ||
    !number ||
    !/^[1-9][0-9]{0,127}$/.test(number) ||
    now >= stored.expiration ||
    !timingSafeEqual(
      Buffer.from(driveChannelTokenHash(token), "hex"),
      Buffer.from(stored.tokenHash, "hex"),
    )
  )
    throw new InvalidNativeEventSignal();
  if (state === "sync" && number !== "1") throw new InvalidNativeEventSignal();
  if (stored.phase === "pending") {
    if (state !== "sync") throw new InvalidNativeEventSignal();
    return {
      phase: "early_sync",
      channelId: stored.id,
      resourceId,
      resourceUri: uri,
      messageNumber: number,
    };
  }
  if (resourceId !== stored.resourceId || uri !== stored.resourceUri)
    throw new InvalidNativeEventSignal();
  if (!["sync", "change", "changed"].includes(String(state))) return null;
  return {
    phase: "wake",
    channelId: stored.id,
    resourceId,
    resourceUri: uri,
    messageNumber: number,
  };
}
