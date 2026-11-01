import type { KeyObject } from "node:crypto";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";
import type {
  UpdateArtifactIdentity,
  UpdateRevocationClient,
  UpdateRevocationManifest,
  UpdateRevocationStatus,
} from "@rakazo/contracts";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const serialQueues = new Map<string, Promise<void>>();

interface SignedFeed {
  manifest: Uint8Array;
  signature: Uint8Array;
}

export interface UpdateRevocationPocOptions {
  feedOrigin: string;
  publicKeyPem: string;
  serialFile: string;
  now?: () => number;
  readFeed?: () => Promise<SignedFeed>;
  certificateAuthorityPem?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") throw new Error("Invalid timestamp");
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error("Invalid timestamp");
  }
  return time;
}

function digest(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 88 &&
    Buffer.from(value, "base64").length === 64 &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}

function label(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(value);
}

function validArtifact(value: unknown): value is UpdateArtifactIdentity {
  return (
    record(value) &&
    label(value.version) &&
    typeof value.platform === "string" &&
    ["darwin", "win32", "linux"].includes(value.platform) &&
    typeof value.arch === "string" &&
    ["arm64", "x64", "ia32"].includes(value.arch) &&
    digest(value.sha512) &&
    label(value.channel)
  );
}

/** HTTPS only, no redirects, bounded headers/body, and an absolute request deadline. */
function readHttps(url: URL, limit: number, certificateAuthorityPem?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      req.destroy();
      reject(error);
    };
    const req = request(
      url,
      {
        ca: certificateAuthorityPem,
        maxHeaderSize: 8192,
        headers: { "Accept-Encoding": "identity" },
      },
      (response) => {
        if (response.statusCode !== 200 || Number(response.headers["content-length"]) > limit) {
          fail(new Error("Test feed is unavailable or oversized"));
          return;
        }
        response.on("data", (part: Buffer) => {
          size += part.length;
          if (size > limit) fail(new Error("Test feed exceeds its size limit"));
          else parts.push(part);
        });
        response.on("error", fail);
        response.on("aborted", () => fail(new Error("Test feed was interrupted")));
        response.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(Buffer.concat(parts, size));
        });
      },
    );
    const timeout = setTimeout(() => fail(new Error("Test feed request timed out")), 10_000);
    timeout.unref();
    req.once("error", fail);
    req.once("close", () => {
      if (!settled) fail(new Error("Test feed connection closed"));
    });
    req.end();
  });
}

function parseManifest(bytes: Uint8Array, key: KeyObject, signature: Uint8Array, now: number) {
  if (
    bytes.length === 0 ||
    bytes.length > MAX_MANIFEST_BYTES ||
    signature.length !== 64 ||
    !verify(null, bytes, key, signature)
  ) {
    throw new Error("Invalid signed feed");
  }
  // Prototype v1 uses JSON.parse semantics; signed extra fields are ignored.
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.serial) ||
    Number(value.serial) < 0 ||
    !label(value.channel) ||
    !Array.isArray(value.revoked)
  ) {
    throw new Error("Invalid manifest");
  }
  const issuedAt = timestamp(value.issuedAt);
  const expiresAt = timestamp(value.expiresAt);
  if (
    !Number.isFinite(now) ||
    issuedAt > now ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_FRESHNESS_MS
  ) {
    throw new Error("Manifest is not fresh");
  }
  for (const item of value.revoked) {
    if (
      !record(item) ||
      !validArtifact({ ...item, channel: value.channel }) ||
      typeof item.reason !== "string" ||
      item.reason.length > 2048
    ) {
      throw new Error("Invalid revoked artifact");
    }
  }
  return { manifest: value as unknown as UpdateRevocationManifest, issuedAt, expiresAt };
}

/** Serialize clients in this process; the exclusive file lock refuses competing processes. */
async function acceptSerial(file: string, namespace: string, serial: number, hash: string) {
  const key = path.resolve(file);
  const previous = serialQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  serialQueues.set(key, current);
  await previous;
  try {
    await writeSerial(key, namespace, serial, hash);
  } finally {
    release();
    if (serialQueues.get(key) === current) serialQueues.delete(key);
  }
}

/** Persist the accepted serial before releasing a result; locked/corrupt stores fail closed. */
async function writeSerial(file: string, namespace: string, serial: number, hash: string) {
  const lock = await open(`${file}.lock`, "wx", 0o600);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    let prior: unknown;
    try {
      const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = Buffer.alloc(4097);
        let length = 0;
        while (length < bytes.length) {
          const result = await input.read(bytes, length, bytes.length - length);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        if (length > 4096) throw new Error("Oversized serial store");
        prior = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
        );
      } finally {
        await input.close();
      }
    } catch (error) {
      if (!record(error) || error.code !== "ENOENT") throw error;
    }
    if (prior !== undefined) {
      if (
        !record(prior) ||
        prior.schemaVersion !== 1 ||
        prior.namespace !== namespace ||
        !Number.isSafeInteger(prior.serial) ||
        Number(prior.serial) < 0 ||
        typeof prior.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(prior.hash) ||
        serial < Number(prior.serial) ||
        (serial === prior.serial && hash !== prior.hash)
      ) {
        throw new Error("Invalid serial progression");
      }
      if (serial === prior.serial) return;
    }
    const output = await open(temporary, "wx", 0o600);
    try {
      await output.writeFile(JSON.stringify({ schemaVersion: 1, namespace, serial, hash }));
      await output.sync();
    } finally {
      await output.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
    await lock.close();
    await unlink(`${file}.lock`);
  }
}

function cleanReason(value: string) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** Test-only protocol client. No production feed, signing key, or updater is installed here. */
export function createUpdateRevocationPoc(
  options: UpdateRevocationPocOptions,
): UpdateRevocationClient {
  if (process.env.NODE_ENV !== "test") throw new Error("Update revocation prototype is test-only");
  const origin = new URL(options.feedOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new Error("A fixed HTTPS feed origin is required");
  }
  const key = createPublicKey(options.publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("An Ed25519 test key is required");
  const fingerprint = createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("hex");
  const now = options.now ?? Date.now;
  const serialFile = options.serialFile;
  const certificateAuthorityPem = options.certificateAuthorityPem;
  const readFeed =
    options.readFeed ??
    (async () => ({
      manifest: await readHttps(
        new URL("/revocations/v1.json", origin),
        MAX_MANIFEST_BYTES,
        certificateAuthorityPem,
      ),
      signature: await readHttps(
        new URL("/revocations/v1.json.sig", origin),
        64,
        certificateAuthorityPem,
      ),
    }));
  return {
    async check(input) {
      const artifact = { ...input };
      const checkedAt = now();
      const unknown: UpdateRevocationStatus = {
        status: "unknown",
        artifact: { ...artifact },
        checkedAt,
        expiresAt: null,
        reason: null,
      };
      try {
        if (!validArtifact(artifact)) return unknown;
        const received = await readFeed();
        if (received.manifest.length > MAX_MANIFEST_BYTES || received.signature.length !== 64)
          return unknown;
        const feed = {
          manifest: Buffer.from(received.manifest),
          signature: Buffer.from(received.signature),
        };
        const { manifest, issuedAt, expiresAt } = parseManifest(
          feed.manifest,
          key,
          feed.signature,
          now(),
        );
        if (manifest.channel !== artifact.channel) return unknown;
        await acceptSerial(
          serialFile,
          createHash("sha256")
            .update(`${origin.origin}\n${artifact.channel}\n${fingerprint}`)
            .digest("hex"),
          manifest.serial,
          createHash("sha256").update(feed.manifest).digest("hex"),
        );
        const completedAt = now();
        if (!Number.isFinite(completedAt) || completedAt < issuedAt || expiresAt <= completedAt)
          return unknown;
        const match = manifest.revoked.find(
          (entry) =>
            entry.version === artifact.version &&
            entry.platform === artifact.platform &&
            entry.arch === artifact.arch &&
            entry.sha512 === artifact.sha512,
        );
        return {
          status: match ? "revoked" : "clear",
          artifact: { ...artifact },
          checkedAt: completedAt,
          expiresAt,
          reason: match ? cleanReason(match.reason) : null,
        };
      } catch {
        return unknown;
      }
    },
  };
}
