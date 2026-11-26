import { createHash, createHmac, randomBytes } from "node:crypto";
import { canonicalPiProviderId } from "@rakazo/contracts";
import { LiveCatalogCache } from "./pi-live-cache.js";
import { isChatModelId } from "./pi-live-model.js";
import {
  catalogProviderProbeBaseUrl,
  listPiCatalog,
  probeCatalogProviderModels,
} from "./pi-models.js";

type CatalogConnection = {
  id: string;
  userId: string;
  provider: string;
  secretId: string;
  connectionRevision: number;
  ciphertext: string;
};

/** Cached catalog observations for exactly one revision of an owned API key. */
export class ApiKeyModelCatalog {
  private readonly cache: LiveCatalogCache<string>;
  private readonly probe: typeof probeCatalogProviderModels;
  private readonly versionKey = randomBytes(32);

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

  read(
    connection: CatalogConnection,
    apiKey: string,
    current: () => Promise<boolean>,
  ): Promise<string[] | undefined> {
    const provider = canonicalPiProviderId(connection.provider);
    const endpoint = catalogProviderProbeBaseUrl(provider);
    if (!endpoint || !apiKey) return Promise.resolve(undefined);
    const version = createHash("sha256").update(connection.ciphertext).digest("hex");
    // External stores can rotate a key in place without changing the persisted reference.
    const keyVersion = createHmac("sha256", this.versionKey).update(apiKey).digest("hex");
    return this.cache.read(
      JSON.stringify([
        connection.userId,
        connection.id,
        provider,
        endpoint,
        connection.secretId,
        connection.connectionRevision,
        version,
        keyVersion,
      ]),
      async (signal) => {
        if (!(await current()) || signal.aborted) return { attempted: false };
        const listed = new Set(await this.probe({ provider, apiKey }, undefined, signal));
        const bundled = listPiCatalog().filter((entry) => entry.provider === provider);
        const matched = bundled
          .map(({ id }) => id)
          .filter(
            (id) =>
              listed.has(id) && isChatModelId(id) && !id.endsWith(":batch") && !id.includes(apiKey),
          );
        return {
          attempted: true,
          models: matched.length >= Math.ceil(bundled.length / 4) ? matched : undefined,
        };
      },
    );
  }
}
