import { describe, expect, it, vi } from "vitest";
import { listPiCatalog } from "./pi-models.js";
import { parseModelSecret } from "./pi-oauth.js";
import { ApiKeyModelCatalog, ProviderCatalogSelections } from "./pi-provider-catalog.js";

const snapshot = {
  id: "connection-one",
  userId: "account-one",
  provider: "openai",
  secretId: "secret-one",
  connectionRevision: 1,
  ciphertext: "sealed-fixture-one",
};
const bundled = listPiCatalog()
  .filter(({ provider }) => provider === snapshot.provider)
  .map(({ id }) => id);
const hour = 60 * 60_000;

describe("saved catalog selections", () => {
  it("uses only server-confirmed IDs for the same account, connection and key", () => {
    const signer = new ProviderCatalogSelections("fixture-deployment-key");
    const id = "gpt-fixture-live";
    const secret = { kind: "api_key" as const, key: "fixture-api-key" };
    const signed = signer.sign(snapshot, secret, [id]);
    const owner = { ...snapshot, providerCatalogSelection: signed };
    expect(signer.read(owner, secret)).toEqual([id]);
    for (const other of [
      { ...owner, id: "other-connection" },
      { ...owner, userId: "other-user" },
      { ...owner, provider: "openrouter" },
    ]) {
      expect(signer.read(other, secret)).toEqual([]);
    }
    expect(signer.read(owner, { ...secret, key: "fixture-new-key" })).toEqual([]);
    expect(
      signer.read(
        {
          ...owner,
          providerCatalogSelection: { ...signed, modelIds: [id, "gpt-fixture-forged"] },
        },
        secret,
      ),
    ).toEqual([]);
    expect(
      signer.read(
        {
          ...owner,
          providerCatalogSelection: { ...signed, signature: "0".repeat(64) },
        },
        secret,
      ),
    ).toEqual([]);
    expect(
      signer.read(
        snapshot,
        parseModelSecret(
          JSON.stringify({
            ...secret,
            providerCatalogSelection: signed,
          }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("saved API key model catalog", () => {
  it("shares results only for the exact connection and sealed credential version", async () => {
    const probe = vi.fn().mockResolvedValue(bundled);
    const catalog = new ApiKeyModelCatalog({ probe });
    const current = vi.fn(async () => true);
    const key = "fixture-api-key";
    expect(await catalog.read(snapshot, key, current)).toContain(bundled[0]);
    expect(await catalog.read({ ...snapshot }, key, current)).toContain(bundled[0]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
    expect(await catalog.read(snapshot, "fixture-key-rotated-in-place", current)).toContain(
      bundled[0],
    );
    for (const update of [
      { id: "other-connection" },
      { userId: "other-account" },
      { secretId: "other-secret" },
      { ciphertext: "changed-ciphertext" },
      { connectionRevision: 2 },
    ]) {
      expect(await catalog.read({ ...snapshot, ...update }, key, current)).toContain(bundled[0]);
    }
    expect(probe).toHaveBeenCalledTimes(7);
    expect(
      await catalog.read({ ...snapshot, provider: "openai-compatible" }, key, current),
    ).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(7);
  });

  it("keeps bundled batch-only variants out of the chat ranking", async () => {
    const provider = "openrouter";
    const ids = listPiCatalog()
      .filter((entry) => entry.provider === provider)
      .map(({ id }) => id);
    const batch = ids.filter((id) => id.endsWith(":batch"));
    expect(batch.length).toBeGreaterThan(0);
    const catalog = new ApiKeyModelCatalog({ probe: vi.fn().mockResolvedValue(ids) });
    const ranked = await catalog.read(
      { ...snapshot, provider },
      "fixture-api-key",
      async () => true,
    );
    expect(ranked?.length).toBeGreaterThan(0);
    expect(ranked?.some((id) => id.endsWith(":batch"))).toBe(false);
  });

  it("expires successful results after six hours, backs off failures and stops serving old lists after a day", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn().mockResolvedValueOnce(bundled).mockRejectedValue(new Error("fixture"));
      const catalog = new ApiKeyModelCatalog({ probe });
      const read = () => catalog.read(snapshot, "fixture-api-key", async () => true);
      expect(await read()).toContain(bundled[0]);
      await vi.advanceTimersByTimeAsync(6 * hour - 1);
      expect(await read()).toContain(bundled[0]);
      expect(probe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await read()).toContain(bundled[0]);
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      expect(await read()).toContain(bundled[0]);
      expect(probe).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await read()).toContain(bundled[0]);
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(18 * hour - 10 * 60_000);
      expect(await read()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
