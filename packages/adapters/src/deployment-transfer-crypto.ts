import type { KeyObject } from "node:crypto";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

export { normalizeDeploymentTransferOrigin } from "@rakazo/contracts";

export const DEPLOYMENT_TRANSFER_PROTOCOL = "coginebot.transfer/1";
export const DEPLOYMENT_TRANSFER_MAX_WIRE_BYTES = 512 * 1024;
const OPERATIONS = [
  "challenge",
  "proposal",
  "plan",
  "grant",
  "item",
  "status",
  "cancel",
  "ack",
  "receipt",
  "binding",
] as const;
export type DeploymentTransferOperation = (typeof OPERATIONS)[number];
const operations = new Set<string>(OPERATIONS);

/** One bounded JSON representation for wire encoding, signatures and plan digests. */
export function encodeDeploymentTransferJson(value: unknown): string {
  let nodes = 0;
  function encode(item: unknown, depth: number): string {
    if (++nodes > 10_000 || depth > 20) throw new Error("Invalid deployment transfer message");
    if (item === null) return "null";
    if (typeof item === "string") {
      if (item.length > DEPLOYMENT_TRANSFER_MAX_WIRE_BYTES)
        throw new Error("Invalid deployment transfer message");
      return JSON.stringify(item);
    }
    if (typeof item === "boolean") return String(item);
    if (typeof item === "number" && Number.isSafeInteger(item)) return String(item);
    if (Array.isArray(item)) {
      if (item.length > 10_000) throw new Error("Invalid deployment transfer message");
      return `[${Array.from(item, (entry) => encode(entry, depth + 1)).join(",")}]`;
    }
    if (
      typeof item !== "object" ||
      (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
    )
      throw new Error("Invalid deployment transfer message");
    const object = item as Record<string, unknown>;
    const keys = Object.keys(object);
    if (keys.length > 10_000) throw new Error("Invalid deployment transfer message");
    return `{${keys
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${encode(object[key], depth + 1)}`)
      .join(",")}}`;
  }
  const json = encode(value, 0);
  if (Buffer.byteLength(json, "utf8") > DEPLOYMENT_TRANSFER_MAX_WIRE_BYTES)
    throw new Error("Invalid deployment transfer message");
  return json;
}

function message(operation: DeploymentTransferOperation, value: unknown): Buffer {
  if (!operations.has(operation)) throw new Error("Invalid deployment transfer message");
  return Buffer.from(
    `${DEPLOYMENT_TRANSFER_PROTOCOL}:${operation}\n${encodeDeploymentTransferJson(value)}`,
  );
}

function decode(value: string, bytes: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length !== Math.ceil((bytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new Error("Invalid deployment transfer identity");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value)
    throw new Error("Invalid deployment transfer identity");
  return decoded;
}

function publicKey(value: string): KeyObject {
  try {
    const bytes = decode(value, 44);
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !key.export({ format: "der", type: "spki" }).equals(bytes)
    )
      throw new Error();
    return key;
  } catch {
    throw new Error("Invalid deployment transfer identity");
  }
}

function privateKey(value: string): KeyObject {
  try {
    const bytes = decode(value, 48);
    const key = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !key.export({ format: "der", type: "pkcs8" }).equals(bytes)
    )
      throw new Error();
    return key;
  } catch {
    throw new Error("Invalid deployment transfer identity");
  }
}

export function deploymentTransferPublicKeyFromPrivate(value: string): string {
  return createPublicKey(privateKey(value))
    .export({ format: "der", type: "spki" })
    .toString("base64url");
}

export function deploymentTransferFingerprint(value: string): string {
  return createHash("sha256")
    .update(publicKey(value).export({ format: "der", type: "spki" }))
    .digest("hex");
}

export function createDeploymentTransferKeyPair(): {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
} {
  const key = generateKeyPairSync("ed25519");
  const encodedPublic = key.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return {
    privateKey: key.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: encodedPublic,
    fingerprint: deploymentTransferFingerprint(encodedPublic),
  };
}

export function deploymentTransferDigest(
  operation: DeploymentTransferOperation,
  value: unknown,
): string {
  return createHash("sha256").update(message(operation, value)).digest("hex");
}

export function signDeploymentTransferMessage(
  key: string,
  operation: DeploymentTransferOperation,
  value: unknown,
): string {
  return sign(null, message(operation, value), privateKey(key)).toString("base64url");
}

export function verifyDeploymentTransferMessage(
  key: string,
  operation: DeploymentTransferOperation,
  value: unknown,
  signature: string,
): boolean {
  try {
    return verify(null, message(operation, value), publicKey(key), decode(signature, 64));
  } catch {
    return false;
  }
}
