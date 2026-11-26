export type CatalogFetch<T> = { attempted: false } | { attempted: true; models: T[] | undefined };

type CatalogEntry<T> = {
  models?: T[];
  fetchedAt: number;
  expiresAt: number;
};

type CatalogCacheOptions = {
  now: () => number;
  ttlMs: number;
  failureTtlMs: number;
  waitMs: number;
  deadlineMs: number;
  staleMaxAgeMs: number;
  maxEntries: number;
};

/** Bounded stale-while-revalidate lifecycle for account-scoped model catalogs. */
export class LiveCatalogCache<T> {
  private readonly entries = new Map<string, CatalogEntry<T>>();
  private readonly pending = new Map<string, Promise<T[] | undefined>>();

  constructor(private readonly options: CatalogCacheOptions) {}

  async read(
    key: string,
    fetchModels: (signal: AbortSignal) => Promise<CatalogFetch<T>>,
    { waitMs = this.options.waitMs, cacheOnly = false } = {},
  ): Promise<T[] | undefined> {
    const entry = this.entries.get(key);
    const now = this.options.now();
    const lastGood = this.trusted(entry, now);
    if (cacheOnly || (entry && entry.expiresAt > now)) return lastGood;

    let work = this.pending.get(key);
    if (!work) {
      if (this.pending.size >= this.options.maxEntries) return lastGood;
      work = this.refresh(key, fetchModels);
      this.pending.set(key, work);
    }
    if (entry || waitMs === 0) return lastGood;

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), waitMs);
      void work.then((models) => {
        clearTimeout(timer);
        resolve(models);
      });
    });
  }

  private trusted(entry: CatalogEntry<T> | undefined, now: number): T[] | undefined {
    return entry && now < entry.fetchedAt + this.options.staleMaxAgeMs ? entry.models : undefined;
  }

  private async refresh(
    key: string,
    fetchModels: (signal: AbortSignal) => Promise<CatalogFetch<T>>,
  ): Promise<T[] | undefined> {
    const controller = new AbortController();
    const failed = { attempted: true, models: undefined } as const;
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<CatalogFetch<T>>((resolve) => {
      timer = setTimeout(() => {
        resolve(failed);
        controller.abort(new DOMException("Catalog refresh timed out", "TimeoutError"));
      }, this.options.deadlineMs);
    });
    // Only the winning outcome can enter the cache, even if a transport ignores cancellation.
    const work = (async () => fetchModels(controller.signal))().catch(() => failed);
    const result = await Promise.race([work, deadline]);
    clearTimeout(timer);
    this.pending.delete(key);
    if (!result.attempted) return undefined;

    const prior = this.entries.get(key);
    const now = this.options.now();
    const models = result.models?.length ? result.models : undefined;
    const entry = models
      ? { models, fetchedAt: now, expiresAt: now + this.options.ttlMs }
      : {
          models: this.trusted(prior, now),
          fetchedAt: prior?.fetchedAt ?? now,
          expiresAt: now + this.options.failureTtlMs,
        };
    if (!this.entries.has(key) && this.entries.size >= this.options.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, entry);
    return models;
  }
}
