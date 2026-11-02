import type { DeploymentIdentity, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  createDeploymentIdentityReader,
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
    replace: (value: DeploymentIdentity | null) => {
      row = value;
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

describe("verified deployment identity cache", () => {
  async function fixture() {
    const db = database();
    const store = new EncryptedSecretStore("fake-key");
    const original = await ensureDeploymentIdentity({ prisma: db.prisma, secrets: store });
    const read = createDeploymentIdentityReader({ prisma: db.prisma, secrets: store });
    return { db, store, original, read };
  }

  it("coalesces cold reads and rechecks persistence without repeatedly decrypting or sharing mutable results", async () => {
    const { db, store, original, read } = await fixture();
    const load = vi.spyOn(store, "load");
    const results = await Promise.all([read(), read(), read()]);
    expect(results).toEqual([original, original, original]);
    results[0]!.privateKey = "caller mutation";
    expect(await read()).toEqual(original);
    expect(load).toHaveBeenCalledTimes(1);
    expect(db.client.deploymentIdentity.findUnique.mock.calls.length).toBeGreaterThan(4);
  });

  it("does not retain a rejected load or let it poison concurrent readers", async () => {
    const { store, original, read } = await fixture();
    const load = vi.spyOn(store, "load").mockRejectedValueOnce(new Error("synthetic read failure"));
    const failed = await Promise.allSettled([read(), read(), read()]);
    expect(failed.every((entry) => entry.status === "rejected")).toBe(true);
    expect(await read()).toEqual(original);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each(["public-key", "fingerprint", "aad", "ciphertext", "deployment-id"])(
    "invalidates warmed material when the persisted %s is corrupt, then retries after repair",
    async (kind) => {
      const { db, store, original, read } = await fixture();
      const saved = { ...db.row() };
      const load = vi.spyOn(store, "load");
      await read();
      if (kind === "public-key")
        db.corrupt({ publicKey: createDeploymentTransferKeyPair().publicKey });
      if (kind === "fingerprint") db.corrupt({ fingerprint: "0".repeat(64) });
      if (kind === "aad") db.corrupt({ secretRecordId: "different-aad" });
      if (kind === "ciphertext")
        db.corrupt({ ciphertext: `${saved.ciphertext.slice(0, -8)}AAAAAAAA` });
      if (kind === "deployment-id") db.corrupt({ deploymentId: "" });
      await expect(read()).rejects.toBeInstanceOf(DeploymentIdentityUnavailableError);
      db.replace(saved);
      expect(await read()).toEqual(original);
      expect(load).toHaveBeenCalledTimes(3);
    },
  );

  it("revalidates same-key re-encryption and an older restored authority", async () => {
    const { db, store, original, read } = await fixture();
    const saved = { ...db.row() };
    const load = vi.spyOn(store, "load");
    await read();
    const written = await store.put(
      original.privateKey,
      {
        operationId: "cache-test",
        traceId: "cache-test",
        userId: "deployment",
        spaceId: "deployment",
        signal: new AbortController().signal,
      },
      { recordId: "new-identity-aad", ephemeral: true },
    );
    db.corrupt({
      ciphertext: written.ciphertext,
      secretRecordId: written.id,
      updatedAt: new Date(Date.now() + 1000),
    });
    expect(await read()).toEqual(original);
    db.replace(saved);
    expect(await read()).toEqual(original);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("fails closed on a database read error and revalidates after recovery", async () => {
    const { db, store, original, read } = await fixture();
    const load = vi.spyOn(store, "load");
    await read();
    db.client.deploymentIdentity.findUnique.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(read()).rejects.toBeInstanceOf(DeploymentIdentityUnavailableError);
    expect(await read()).toEqual(original);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("creates one persisted replacement after row removal instead of returning a stale key", async () => {
    const { db, store, original, read } = await fixture();
    await read();
    db.replace(null);
    const put = vi.spyOn(store, "put");
    const results = await Promise.all([read(), read(), read()]);
    expect(results[0]).not.toEqual(original);
    expect(results).toEqual([results[0], results[0], results[0]]);
    expect(results[0]!.deploymentId).toBe(db.row().deploymentId);
    expect(put).toHaveBeenCalledTimes(1);
    expect(db.client.deploymentIdentity.create).toHaveBeenCalledTimes(2);
  });

  it("never shares verified material with a different store or database", async () => {
    const { db, original, read } = await fixture();
    await read();
    await expect(
      createDeploymentIdentityReader({
        prisma: db.prisma,
        secrets: new EncryptedSecretStore("wrong-key"),
      })(),
    ).rejects.toBeInstanceOf(DeploymentIdentityUnavailableError);
    const other = await fixture();
    expect((await other.read()).deploymentId).not.toBe(original.deploymentId);
  });

  it.each(["success", "failure"])(
    "does not let a late old %s publish or evict a newer cache entry",
    async (outcome) => {
      const { db, store, read } = await fixture();
      const replacement = await fixture();
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const actualLoad = store.load.bind(store);
      const load = vi.spyOn(store, "load").mockImplementationOnce(async (...args) => {
        entered();
        await waiting;
        if (outcome === "failure") throw new Error("old read failed");
        return actualLoad(...args);
      });
      const old = read();
      const rejected = expect(old).rejects.toBeInstanceOf(DeploymentIdentityUnavailableError);
      await started;
      db.replace({ ...replacement.db.row() });
      expect(await read()).toEqual(replacement.original);
      release();
      await rejected;
      expect(await read()).toEqual(replacement.original);
      expect(load).toHaveBeenCalledTimes(2);
    },
  );
});
