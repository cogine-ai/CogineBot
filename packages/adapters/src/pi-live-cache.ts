export type CatalogFetch<T> = { attempted: false } | { attempted: true; models: T[] | undefined };

type CatalogEntry<T> = {
  models?: T[];
  fetchedAt: number;
  expiresAt: number;
  manualObservationOrder?: number;
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
  private readonly pending = new Map<
    string,
    { result: Promise<T[] | undefined>; superseded: { value: boolean } }
  >();

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
      const superseded = { value: false };
      work = { result: this.refresh(key, fetchModels, superseded), superseded };
      this.pending.set(key, work);
    }
    if (entry || waitMs === 0) return lastGood;

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), waitMs);
      void work.result.then((models) => {
        clearTimeout(timer);
        resolve(models);
      });
    });
  }

  record(key: string, models: T[], manualObservationOrder: number): boolean {
    if ((this.entries.get(key)?.manualObservationOrder ?? 0) > manualObservationOrder) return false;
    const pending = this.pending.get(key);
    if (pending) pending.superseded.value = true;
    const fetchedAt = this.options.now();
    this.store(key, {
      models,
      fetchedAt,
      manualObservationOrder,
      expiresAt: fetchedAt + this.options.ttlMs,
    });
    return true;
  }

  isFresh(key: string, models: readonly T[]): boolean {
    const entry = this.entries.get(key);
    return entry?.models === models && this.options.now() < entry.fetchedAt + this.options.ttlMs;
  }

  private trusted(entry: CatalogEntry<T> | undefined, now: number): T[] | undefined {
    return entry && now < entry.fetchedAt + this.options.staleMaxAgeMs ? entry.models : undefined;
  }

  private async refresh(
    key: string,
    fetchModels: (signal: AbortSignal) => Promise<CatalogFetch<T>>,
    superseded: { value: boolean },
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
    const prior = this.entries.get(key);
    const now = this.options.now();
    if (superseded.value) return this.trusted(prior, now);
    if (!result.attempted) return undefined;
    const models = result.models?.length ? result.models : undefined;
    const entry = models
      ? { models, fetchedAt: now, expiresAt: now + this.options.ttlMs }
      : {
          models: this.trusted(prior, now),
          fetchedAt: prior?.fetchedAt ?? now,
          expiresAt: now + this.options.failureTtlMs,
        };
    this.store(key, { ...entry, manualObservationOrder: prior?.manualObservationOrder });
    return models;
  }

  private store(key: string, entry: CatalogEntry<T>) {
    if (!this.entries.has(key) && this.entries.size >= this.options.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, entry);
  }
}
