import type { DeploymentIdentity, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  DeploymentIdentityUnavailableError,
  ensureDeploymentIdentity,
} from "./deployment-identity.js";
import {
  createDeploymentTransferKeyPair,
  deploymentTransferPublicKeyFromPrivate,
} from "./deployment-transfer-crypto.js";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import { ComposedSecretStore } from "./secret-store-factory.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";

function database() {
  let row: DeploymentIdentity | null = null;
  let loseAcknowledgement = false;
  const empty = { count: vi.fn(async () => 0) };
  const client = {
    deploymentIdentity: {
      findUnique: vi.fn(async () => (row ? { ...row } : null)),
      create: vi.fn(async ({ data }) => {
        if (row) throw Object.assign(new Error("unique singleton"), { code: "P2002" });
        row = { ...data, createdAt: new Date(), updatedAt: new Date() };
        if (loseAcknowledgement) throw new Error("synthetic lost commit acknowledgement");
        return { ...row };
      }),
      count: vi.fn(async ({ where }) => (row?.ciphertext === where.ciphertext ? 1 : 0)),
    },
    secret: empty,
    botSecret: empty,
    integrationProviderConfig: empty,
    nativeAppConfig: empty,
    deploymentTransferSession: empty,
    deploymentTransferItem: empty,
    $queryRaw: vi.fn(async () => [{ referenced: false }]),
  };
  return {
    prisma: client as unknown as PrismaClient,
    client,
    row: () => row!,
    corrupt: (value: Partial<DeploymentIdentity>) => {
      row = { ...row!, ...value };
    },
    loseAck: () => {
      loseAcknowledgement = true;
    },
  };
}

describe("durable deployment identity", () => {
  it("keeps one validated Ed25519 identity through a new store/process with no owner row", async () => {
    const db = database(),
      store = new EncryptedSecretStore("fake-master-key");
    const first = await ensureDeploymentIdentity({ prisma: db.prisma, secrets: store });
    expect(db.row().id).toBe("primary");
    expect(db.row().ciphertext).not.toContain(first.privateKey);
    expect(db.row().secretRecordId).toMatch(/^deployment-identity:/);
    expect(deploymentTransferPublicKeyFromPrivate(first.privateKey)).toBe(first.publicKey);
    const afterRestart = await ensureDeploymentIdentity({
      prisma: db.prisma,
      secrets: new EncryptedSecretStore("fake-master-key"),
    });
    expect(afterRestart).toEqual(first);
    expect(db.client.deploymentIdentity.create).toHaveBeenCalledTimes(1);
  });
  it("routes persistent private material inline even with a remote store configured", async () => {
    const db = database(),
      fake = infisicalFake();
    const store = new ComposedSecretStore(
      new EncryptedSecretStore("fake-key"),
      new InfisicalSecretStore(fake.options),
    );
    const identity = await ensureDeploymentIdentity({ prisma: db.prisma, secrets: store });
    expect(identity.privateKey).toBeTruthy();
    expect(fake.fetcher).not.toHaveBeenCalled();
    expect(db.row().ciphertext).toMatch(/^v2:/);
    await store.close();
  });
  it("returns the persisted winner to concurrent creators rather than their local candidates", async () => {
    const db = database(),
      store = new EncryptedSecretStore("fake-key");
    const [a, b] = await Promise.all([
      ensureDeploymentIdentity({ prisma: db.prisma, secrets: store }),
      ensureDeploymentIdentity({ prisma: db.prisma, secrets: store }),
    ]);
    expect(a).toEqual(b);
    expect(a.publicKey).toBe(db.row().publicKey);
  });
  it("recovers a committed singleton after its acknowledgement was lost without replacing it", async () => {
    const db = database(),
      store = new EncryptedSecretStore("fake-key");
    db.loseAck();
    const identity = await ensureDeploymentIdentity({ prisma: db.prisma, secrets: store });
    expect(identity.publicKey).toBe(db.row().publicKey);
    expect(db.client.deploymentIdentity.create).toHaveBeenCalledTimes(1);
  });
  it.each(["master-key", "public-key", "fingerprint", "aad"])(
    "fails closed on a corrupt %s instead of creating another identity",
    async (kind) => {
      const db = database(),
        store = new EncryptedSecretStore("fake-key");
      await ensureDeploymentIdentity({ prisma: db.prisma, secrets: store });
      if (kind === "public-key")
        db.corrupt({ publicKey: createDeploymentTransferKeyPair().publicKey });
      if (kind === "fingerprint") db.corrupt({ fingerprint: "0".repeat(64) });
      if (kind === "aad") db.corrupt({ secretRecordId: "different-aad" });
      await expect(
        ensureDeploymentIdentity({
          prisma: db.prisma,
          secrets: kind === "master-key" ? new EncryptedSecretStore("wrong-key") : store,
        }),
      ).rejects.toBeInstanceOf(DeploymentIdentityUnavailableError);
      expect(db.client.deploymentIdentity.create).toHaveBeenCalledTimes(1);
    },
  );
  it("does not create material for a cancelled initialization", async () => {
    const db = database(),
      store = new EncryptedSecretStore("fake-key");
    const put = vi.spyOn(store, "put");
    await expect(
      ensureDeploymentIdentity({ prisma: db.prisma, secrets: store, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
  });
});
