import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { NativeActionError } from "../action.js";
import type { Data } from "./common.js";
import { object, text } from "./common.js";
export interface EnterpriseCallbackConfig {
  appId: "feishu-lark" | "wecom";
  clientId: string;
  tenantId?: string;
  region?: "feishu" | "lark";
  verificationToken: string;
  encryptionKey: string;
}
export interface EnterpriseCallbackInput {
  rawBody?: string | Uint8Array;
  headers?: Record<string, string | undefined>;
  query?: { msg_signature?: string; timestamp?: string; nonce?: string; echostr?: string };
}
export type EnterpriseCallbackResult =
  | { type: "challenge"; challenge: string }
  | {
      type: "ticket";
      platform: "feishu-lark" | "wecom";
      appId: string;
      ticket: string;
      issuedAt: number;
      eventId: string;
    }
  | {
      type: "installation";
      platform: "wecom";
      action: "create" | "change" | "cancel";
      appId: string;
      tenantId?: string;
      authorizationCode?: string;
      issuedAt: number;
      eventId: string;
    };
function reject(): never {
  throw new NativeActionError(
    "authorization_required",
    "The enterprise callback signature or application identity is invalid.",
  );
}
function same(a: string, b: string): boolean {
  const first = Buffer.from(a),
    second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
function bounded(value: string | Uint8Array | undefined): string {
  const raw = typeof value === "string" ? value : Buffer.from(value ?? []).toString("utf8");
  if (!raw || Buffer.byteLength(raw) > 262144) return reject();
  return raw;
}
function fresh(value: unknown, now: number): number {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || Math.abs(now - seconds * 1000) > 300000)
    return reject();
  return seconds;
}
function xml(value: string): Data {
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(value) || value.length > 262144) return reject();
  const wrapped = /^\s*(?:<\?xml[^?]*\?>\s*)?<xml>\s*([\s\S]*?)\s*<\/xml>\s*$/.exec(value);
  if (!wrapped) return reject();
  const source = wrapped[1]!,
    row: Data = {};
  let consumed = "";
  const re = /<([A-Za-z][A-Za-z0-9_]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  let match: RegExpExecArray | null = re.exec(source);
  while (match) {
    if (source.slice(consumed.length, match.index).trim()) return reject();
    const key = match[1]!;
    if (Object.hasOwn(row, key)) return reject();
    let content = match[2] ?? match[3] ?? "";
    if (match[2] === undefined) {
      if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(content)) return reject();
      content = content.replace(
        /&(amp|lt|gt|quot|apos);/g,
        (_whole, key: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[key]!,
      );
    }
    row[key] = content;
    consumed = source.slice(0, re.lastIndex);
    match = re.exec(source);
  }
  if (source.slice(consumed.length).trim()) return reject();
  return row;
}
function wecom(
  config: EnterpriseCallbackConfig,
  input: EnterpriseCallbackInput,
  now: number,
): EnterpriseCallbackResult {
  const query = input.query ?? {},
    timestamp = String(query.timestamp ?? ""),
    nonce = String(query.nonce ?? "");
  fresh(timestamp, now);
  if (
    !nonce ||
    nonce.length > 256 ||
    !query.msg_signature ||
    !/^[A-Za-z0-9+/]{43}$/.test(config.encryptionKey)
  )
    return reject();
  const cipher = query.echostr ?? text(xml(bounded(input.rawBody)).Encrypt);
  if (cipher.length > 262144 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cipher)) return reject();
  const signature = createHash("sha1")
    .update([config.verificationToken, timestamp, nonce, cipher].sort().join(""))
    .digest("hex");
  if (!same(signature, query.msg_signature)) return reject();
  const key = Buffer.from(`${config.encryptionKey}=`, "base64"),
    encoded = Buffer.from(cipher, "base64");
  if (key.length !== 32 || encoded.length % 16 !== 0) return reject();
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    plain = Buffer.concat([decipher.update(encoded), decipher.final()]);
  } catch {
    return reject();
  }
  const pad = plain[plain.length - 1]!;
  if (
    pad < 1 ||
    pad > 32 ||
    plain.length < 20 + pad ||
    !plain.subarray(-pad).every((v) => v === pad)
  )
    return reject();
  plain = plain.subarray(0, -pad);
  const size = plain.readUInt32BE(16);
  if (size < 1 || size > plain.length - 20) return reject();
  const body = plain.subarray(20, 20 + size).toString("utf8"),
    receiveId = plain.subarray(20 + size).toString("utf8");
  const expected = config.clientId || config.tenantId;
  if (!expected || !same(receiveId, expected)) return reject();
  if (query.echostr) return { type: "challenge", challenge: body };
  const data = xml(body),
    appId = text(data.SuiteId ?? data.ToUserName);
  if (appId !== config.clientId) return reject();
  const issuedAt = fresh(data.TimeStamp, now),
    eventId = createHash("sha256").update(body).digest("hex"),
    kind = data.InfoType;
  if (kind === "suite_ticket")
    return {
      type: "ticket",
      platform: "wecom",
      appId,
      ticket: text(data.SuiteTicket),
      issuedAt,
      eventId,
    };
  if (["create_auth", "change_auth", "cancel_auth"].includes(String(kind)))
    return {
      type: "installation",
      platform: "wecom",
      action: kind === "create_auth" ? "create" : kind === "change_auth" ? "change" : "cancel",
      appId,
      ...(typeof data.AuthCorpId === "string" ? { tenantId: data.AuthCorpId } : {}),
      ...(typeof data.AuthCode === "string" ? { authorizationCode: data.AuthCode } : {}),
      issuedAt,
      eventId,
    };
  return reject();
}
function feishu(
  config: EnterpriseCallbackConfig,
  input: EnterpriseCallbackInput,
  now: number,
): EnterpriseCallbackResult {
  const raw = bounded(input.rawBody),
    headers = new Headers(
      Object.fromEntries(
        Object.entries(input.headers ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    ),
    timestamp = headers.get("x-lark-request-timestamp"),
    nonce = headers.get("x-lark-request-nonce"),
    signature = headers.get("x-lark-signature");
  let body: Data;
  try {
    body = object(JSON.parse(raw));
  } catch {
    return reject();
  }
  const encrypted = body.encrypt;
  if (
    typeof encrypted !== "string" ||
    encrypted.length > 262144 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)
  )
    return reject();
  // The platform encrypts the JSON with IV prepended and a SHA256-derived AES key.
  try {
    const bytes = Buffer.from(encrypted, "base64");
    const decipher = createDecipheriv(
      "aes-256-cbc",
      createHash("sha256").update(config.encryptionKey).digest(),
      bytes.subarray(0, 16),
    );
    body = object(
      JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString("utf8"),
      ),
    );
  } catch {
    return reject();
  }
  const header = body.header && typeof body.header === "object" ? object(body.header) : {},
    token = body.token ?? header.token;
  if (typeof token !== "string" || !same(token, config.verificationToken)) return reject();
  if (body.type === "url_verification") {
    return { type: "challenge", challenge: text(body.challenge) };
  }
  if (!timestamp || !nonce || !signature) return reject();
  fresh(timestamp, now);
  const expected = createHash("sha256")
    .update(timestamp + nonce + config.encryptionKey + raw)
    .digest("hex");
  if (!same(expected, signature)) return reject();
  const event = object(body.event),
    appId = text(header.app_id ?? event.app_id);
  if (appId !== config.clientId) return reject();
  const kind = header.event_type ?? event.type;
  if (kind !== "app_ticket" && kind !== "application.app_ticket") return reject();
  const eventTime = header.create_time ?? body.ts ?? timestamp,
    issuedAt = fresh(
      Number(eventTime) > 100000000000 ? Math.floor(Number(eventTime) / 1000) : eventTime,
      now,
    );
  return {
    type: "ticket",
    platform: "feishu-lark",
    appId,
    ticket: text(event.app_ticket),
    issuedAt,
    eventId:
      typeof header.event_id === "string"
        ? header.event_id
        : createHash("sha256").update(raw).digest("hex"),
  };
}
/** Returns authenticated protocol facts only. The caller persists tickets/installation receipts with its existing CAS and dedup. */
export function verifyEnterpriseCallback(
  config: EnterpriseCallbackConfig,
  input: EnterpriseCallbackInput,
  now = Date.now(),
): EnterpriseCallbackResult {
  if (!config.verificationToken || !config.encryptionKey || !config.clientId) return reject();
  return config.appId === "wecom" ? wecom(config, input, now) : feishu(config, input, now);
}
