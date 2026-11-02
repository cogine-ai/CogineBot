import { randomUUID } from "node:crypto";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { DeploymentIdentity, PrismaClient } from "@rakazo/db";
import {
  createDeploymentTransferKeyPair,
  deploymentTransferFingerprint,
  deploymentTransferPublicKeyFromPrivate,
} from "./deployment-transfer-crypto.js";
import { persistPreparedSecret } from "./secret-persistence.js";

/** Server-only signing material. Public handlers must select metadata explicitly. */
export type DeploymentIdentityKey = {
  deploymentId: string;
  publicKey: string;
  fingerprint: string;
  privateKey: string;
};

export class DeploymentIdentityUnavailableError extends Error {
  constructor() {
    super("The deployment identity could not be confirmed.");
    this.name = "DeploymentIdentityUnavailableError";
  }
}

type IdentityStore = { prisma: PrismaClient; secrets: SecretStore; signal?: AbortSignal };

async function openIdentity(input: IdentityStore, row: DeploymentIdentity) {
  const { secrets, signal } = input;
  signal?.throwIfAborted();
  if (secrets.resourceIdentity?.(row.ciphertext, row.secretRecordId).kind !== "inline")
    throw new DeploymentIdentityUnavailableError();
  const privateKey = await secrets.load(row.ciphertext, { recordId: row.secretRecordId, signal });
  const publicKey = deploymentTransferPublicKeyFromPrivate(privateKey);
  const fingerprint = deploymentTransferFingerprint(publicKey);
  if (publicKey !== row.publicKey || fingerprint !== row.fingerprint || !row.deploymentId)
    throw new DeploymentIdentityUnavailableError();
  return { deploymentId: row.deploymentId, publicKey, fingerprint, privateKey };
}

function sameIdentity(a: DeploymentIdentity | null, b: DeploymentIdentity) {
  return (
    a?.id === b.id &&
    a.deploymentId === b.deploymentId &&
    a.publicKey === b.publicKey &&
    a.fingerprint === b.fingerprint &&
    a.secretRecordId === b.secretRecordId &&
    a.ciphertext === b.ciphertext
  );
}

/** Reuse verified material only while this store's exact persisted authority is unchanged. */
export function createDeploymentIdentityReader(input: Pick<IdentityStore, "prisma" | "secrets">) {
  type Entry = { row: DeploymentIdentity; pending: Promise<DeploymentIdentityKey> };
  let cached: Entry | undefined;
  let initializing: Promise<DeploymentIdentityKey> | undefined;
  const read = () => input.prisma.deploymentIdentity.findUnique({ where: { id: "primary" } });
  return async (): Promise<DeploymentIdentityKey> => {
    let entry = cached;
    try {
      let row = await read();
      if (!row) {
        cached = undefined;
        initializing ??= ensureDeploymentIdentity(input);
        const pending = initializing;
        try {
          await pending;
        } finally {
          if (initializing === pending) initializing = undefined;
        }
        row = await read();
        if (!row) throw new DeploymentIdentityUnavailableError();
      }
      if (!cached || !sameIdentity(row, cached.row)) {
        cached = { row: { ...row }, pending: openIdentity(input, row) };
      }
      entry = cached;
      const key = await entry.pending;
      // A slow old load must not publish a key after restore/replacement, or retire a new entry.
      if (!sameIdentity(await read(), entry.row)) throw new DeploymentIdentityUnavailableError();
      return { ...key };
    } catch {
      if (cached === entry) cached = undefined;
      throw new DeploymentIdentityUnavailableError();
    }
  };
}

/** The singleton row, rather than a process-local candidate, is the identity authority. */
export async function ensureDeploymentIdentity(
  input: IdentityStore,
): Promise<DeploymentIdentityKey> {
  const { prisma, secrets, signal } = input;
  const read = () => prisma.deploymentIdentity.findUnique({ where: { id: "primary" } });
  const open = (row: DeploymentIdentity) => openIdentity(input, row);
  try {
    signal?.throwIfAborted();
    const existing = await read();
    if (existing) return await open(existing);
    const pair = createDeploymentTransferKeyPair();
    const recordId = `deployment-identity:${randomUUID()}`;
    const context: AdapterContext = {
      operationId: "deployment-identity",
      traceId: "deployment-identity",
      userId: "deployment",
      spaceId: "deployment",
      signal: signal ?? new AbortController().signal,
    };
    const written = await secrets.put(pair.privateKey, context, { recordId, ephemeral: true });
    if (
      written.id !== recordId ||
      secrets.resourceIdentity?.(written.ref, recordId).kind !== "inline"
    )
      throw new DeploymentIdentityUnavailableError();
    try {
      const row = await persistPreparedSecret(prisma, secrets, written, () => {
        signal?.throwIfAborted();
        return prisma.deploymentIdentity.create({
          data: {
            id: "primary",
            deploymentId: randomUUID(),
            publicKey: pair.publicKey,
            fingerprint: pair.fingerprint,
            secretRecordId: recordId,
            ciphertext: written.ciphertext,
          },
        });
      });
      return await open(row);
    } catch {
      signal?.throwIfAborted();
      // A concurrent creator or lost commit acknowledgement may already have won.
      const persisted = await read();
      if (persisted) return await open(persisted);
      throw new DeploymentIdentityUnavailableError();
    }
  } catch {
    signal?.throwIfAborted();
    throw new DeploymentIdentityUnavailableError();
  }
}
