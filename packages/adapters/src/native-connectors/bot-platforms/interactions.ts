import { createPublicKey, verify } from "node:crypto";
import { NativeActionError } from "../action.js";
import type { Data } from "../collaboration-action.js";
import { array, object } from "../collaboration-action.js";

export interface DiscordInteractionAuthority {
  key: string;
  applicationId: string;
}
export type VerifiedDiscordInteraction =
  | { kind: "ping"; id: string; applicationId: string }
  | {
      kind: "command";
      id: string;
      applicationId: string;
      guildId: string;
      channelId: string;
      commandId: string;
      commandName: string;
      userId: string;
      options: Array<{ name: string; type: 3 | 4 | 5; value: string | number | boolean }>;
    };
const invalid = (): never => {
  throw new NativeActionError(
    "authorization_required",
    "The Discord interaction could not be authenticated.",
  );
};
function snow(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{5,20}$/.test(value)) return invalid();
  return value;
}
/** Raw-byte Ed25519 verification; the public key/application pair must come from verified configuration. */
export function verifyDiscordInteraction(
  rawBody: Uint8Array | string,
  headers: Headers | Record<string, string>,
  publicKey: DiscordInteractionAuthority,
  now = Date.now(),
): VerifiedDiscordInteraction {
  const raw = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody;
  if (
    raw.byteLength < 2 ||
    raw.byteLength > 262144 ||
    !/^[a-f0-9]{64}$/i.test(publicKey.key) ||
    !Number.isFinite(now)
  )
    return invalid();
  const h = headers instanceof Headers ? headers : new Headers(headers),
    signature = h.get("x-signature-ed25519"),
    timestamp = h.get("x-signature-timestamp");
  if (
    !signature ||
    !/^[a-f0-9]{128}$/i.test(signature) ||
    !timestamp ||
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp) * 1000) > 300000
  )
    return invalid();
  let body: Data;
  try {
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKey.key, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    if (
      !verify(
        null,
        Buffer.concat([Buffer.from(timestamp), Buffer.from(raw)]),
        key,
        Buffer.from(signature, "hex"),
      )
    )
      return invalid();
    body = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
  } catch {
    return invalid();
  }
  const applicationId = snow(body.application_id),
    interactionId = snow(body.id);
  if (applicationId !== publicKey.applicationId) return invalid();
  if (body.type === 1) return { kind: "ping", id: interactionId, applicationId };
  if (body.type !== 2) return invalid();
  const data = object(body.data);
  if (data.type !== undefined && data.type !== 1) return invalid();
  if (typeof data.name !== "string" || !/^[a-z0-9_-]{1,32}$/.test(data.name)) return invalid();
  const options = (data.options === undefined ? [] : array(data.options)).map((value) => {
    const option = object(value);
    if (
      typeof option.name !== "string" ||
      !/^[a-z0-9_-]{1,32}$/.test(option.name) ||
      typeof option.type !== "number" ||
      ![3, 4, 5].includes(option.type)
    )
      return invalid();
    if (
      (option.type === 3 && (typeof option.value !== "string" || option.value.length > 6000)) ||
      (option.type === 4 &&
        (typeof option.value !== "number" || !Number.isSafeInteger(option.value))) ||
      (option.type === 5 && typeof option.value !== "boolean")
    )
      return invalid();
    return {
      name: option.name,
      type: option.type as 3 | 4 | 5,
      value: option.value as string | number | boolean,
    };
  });
  if (options.length > 25 || new Set(options.map((o) => o.name)).size !== options.length)
    return invalid();
  return {
    kind: "command",
    id: interactionId,
    applicationId,
    guildId: snow(body.guild_id),
    channelId: snow(body.channel_id),
    commandId: snow(data.id),
    commandName: data.name,
    userId: snow(object(object(body.member).user).id),
    options,
  };
}
