import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalPiProviderId } from "@rakazo/contracts";
import { LiveCatalogCache } from "./pi-live-cache.js";
import { isChatModelId, providerCatalogModel } from "./pi-live-model.js";
import {
  catalogProviderProbeBaseUrl,
  listPiCatalog,
  probeCatalogProviderModels,
} from "./pi-models.js";

import type { StoredModelSecret } from "./pi-oauth.js";

type CatalogConnection = {
  id: string;
  userId: string;
  provider: string;
  secretId: string;
  connectionRevision: number;
  ciphertext: string;
};

type ApiKeySecret = Extract<StoredModelSecret, { kind: "api_key" }>;
type CatalogOwner = Pick<CatalogConnection, "id" | "userId" | "provider"> & {
  providerCatalogSelection?: unknown;
};

/** Bind the application-owned choice to its exact account, connection and key. */
export class ProviderCatalogSelections {
  constructor(private readonly key: string) {}

  read(owner: CatalogOwner, secret: StoredModelSecret): string[] {
    const proof = owner.providerCatalogSelection;
    if (
      secret.kind !== "api_key" ||
      !proof ||
      typeof proof !== "object" ||
      !("modelIds" in proof) ||
      !Array.isArray(proof.modelIds) ||
      !proof.modelIds.every((id): id is string => typeof id === "string") ||
      !("signature" in proof) ||
      typeof proof.signature !== "string" ||
      !/^[0-9a-f]{64}$/.test(proof.signature)
    )
      return [];
    const signature = Buffer.from(proof.signature, "hex");
    const expected = this.signature(owner, secret, proof.modelIds);
    if (!timingSafeEqual(signature, expected)) return [];
    return proof.modelIds.filter(
      (id) => !id.includes(secret.key.trim()) && providerCatalogModel(owner.provider, id),
    );
  }

  sign(owner: CatalogOwner, secret: ApiKeySecret, modelIds: string[]) {
    return { modelIds, signature: this.signature(owner, secret, modelIds).toString("hex") };
  }

  private signature(owner: CatalogOwner, secret: ApiKeySecret, modelIds: string[]): Buffer {
    return createHmac("sha256", this.key)
      .update(
        JSON.stringify([
          "model-directory:selection:v1",
          owner.userId,
          owner.id,
          owner.provider,
          secret.key.trim(),
          modelIds,
        ]),
      )
      .digest();
  }
}

/** Cached catalog observations for exactly one revision of an owned API key. */
export class ApiKeyModelCatalog {
  private readonly cache: LiveCatalogCache<string>;
  private readonly probe: typeof probeCatalogProviderModels;
  private readonly versionKey = randomBytes(32);
  private manualObservationOrder = 0;

  constructor({
    probe = probeCatalogProviderModels,
    now = Date.now,
  }: { probe?: typeof probeCatalogProviderModels; now?: () => number } = {}) {
    this.probe = probe;
    this.cache = new LiveCatalogCache({
      now,
      ttlMs: 6 * 60 * 60_000,
      failureTtlMs: 10 * 60_000,
      waitMs: 1_500,
      deadlineMs: 5_000,
      staleMaxAgeMs: 24 * 60 * 60_000,
      maxEntries: 256,
    });
  }

  async read(
    connection: CatalogConnection,
    apiKey: string,
    current: () => Promise<boolean>,
  ): Promise<string[] | undefined> {
    return (await this.observe(connection, apiKey, current)).models;
  }

  async observe(
    connection: CatalogConnection,
    apiKey: string,
    current: () => Promise<boolean>,
  ): Promise<{ models: string[] | undefined; fresh: boolean }> {
    const scope = this.scope(connection, apiKey);
    if (!scope) return { models: undefined, fresh: false };
    const models = await this.cache.read(scope.key, async (signal) => {
      if (!(await current()) || signal.aborted) return { attempted: false };
      const listed = await this.probe({ provider: scope.provider, apiKey }, undefined, signal);
      return { attempted: true, models: trustedModels(scope, apiKey, listed) };
    });
    return { models, fresh: models !== undefined && this.cache.isFresh(scope.key, models) };
  }

  nextManualObservationOrder(): number {
    return ++this.manualObservationOrder;
  }

  /** Reuse the exact-key result of a successful manual directory check. */
  record(
    connection: CatalogConnection,
    apiKey: string,
    listed: readonly string[],
    manualObservationOrder: number,
  ): boolean {
    const scope = this.scope(connection, apiKey);
    if (!scope) return false;
    const models = trustedModels(scope, apiKey, listed);
    if (!models) return false;
    return this.cache.record(scope.key, models, manualObservationOrder);
  }

  private scope(connection: CatalogConnection, apiKey: string) {
    const provider = canonicalPiProviderId(connection.provider);
    const endpoint = catalogProviderProbeBaseUrl(provider);
    if (!endpoint || !apiKey) return undefined;
    const version = createHash("sha256").update(connection.ciphertext).digest("hex");
    // External stores can rotate a key in place without changing the persisted reference.
    const keyVersion = createHmac("sha256", this.versionKey).update(apiKey).digest("hex");
    return {
      provider,
      endpoint,
      key: JSON.stringify([
        connection.userId,
        connection.id,
        provider,
        endpoint,
        connection.secretId,
        connection.connectionRevision,
        version,
        keyVersion,
      ]),
    };
  }
}

function trustedModels(
  { provider, endpoint }: { provider: string; endpoint: string },
  apiKey: string,
  listed: readonly string[],
) {
  const bundled = listPiCatalog().filter((entry) => entry.provider === provider);
  const eligible = [...new Set(listed)].filter(
    (id) => isChatModelId(id) && !id.endsWith(":batch") && !id.includes(apiKey),
  );
  const known = new Set(bundled.map(({ id }) => id));
  const eligibleKnownCount = eligible.filter((id) => known.has(id)).length;
  if (known.size === 0 || eligibleKnownCount < Math.ceil(bundled.length / 4)) return undefined;
  return eligible.filter(
    (id) => known.has(id) || providerCatalogModel(provider, id)?.baseUrl === endpoint,
  );
}
