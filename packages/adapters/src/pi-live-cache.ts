type CatalogObservation<T, Failure> = { models?: T[]; failure?: Failure };
export type CatalogFetch<T, Failure = never> =
  | { attempted: false }
  | ({ attempted: true } & CatalogObservation<T, Failure>);

type CatalogEntry<T, Failure> = CatalogObservation<T, Failure> & {
  fetchedAt: number;
  expiresAt: number;
  manualObservationOrder?: number;
};

type CatalogCacheOptions<Failure> = {
  now: () => number;
  ttlMs: number;
  failureTtlMs: number;
  waitMs: number;
  deadlineMs: number;
  deadlineFailure?: Failure;
  staleMaxAgeMs: number;
  maxEntries: number;
};

/** Bounded stale-while-revalidate lifecycle for account-scoped model catalogs. */
export class LiveCatalogCache<T, Failure = never> {
  private readonly entries = new Map<string, CatalogEntry<T, Failure>>();
  private readonly pending = new Map<
    string,
    { result: Promise<CatalogObservation<T, Failure>>; superseded: { value: boolean } }
  >();

  constructor(private readonly options: CatalogCacheOptions<Failure>) {}

  async read(
    key: string,
    fetchModels: (signal: AbortSignal) => Promise<CatalogFetch<T, Failure>>,
    options?: { waitMs?: number; cacheOnly?: boolean; waitForRevalidation?: boolean },
  ): Promise<T[] | undefined> {
    return (await this.readObservation(key, fetchModels, options)).models;
  }

  async readObservation(
    key: string,
    fetchModels: (signal: AbortSignal) => Promise<CatalogFetch<T, Failure>>,
    {
      waitMs = this.options.waitMs,
      cacheOnly = false,
      waitForRefresh = false,
      waitForRevalidation = false,
    } = {},
  ): Promise<CatalogObservation<T, Failure>> {
    const entry = this.entries.get(key);
    const now = this.options.now();
    const lastGood = this.trusted(entry, now);
    if (
      cacheOnly ||
      (entry &&
        entry.expiresAt > now &&
        (!waitForRefresh || (lastGood && this.isFresh(key, lastGood))))
    )
      return { models: lastGood, failure: entry?.failure };

    let work = this.pending.get(key);
    if (!work) {
      if (this.pending.size >= this.options.maxEntries)
        return waitForRefresh ? {} : { models: lastGood };
      const superseded = { value: false };
      work = { result: this.refresh(key, fetchModels, superseded), superseded };
      this.pending.set(key, work);
    }
    if (waitForRefresh) return work.result;
    if ((entry && !waitForRevalidation) || waitMs === 0) return { models: lastGood };

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({}), waitMs);
      void work.result.then((observation) => {
        clearTimeout(timer);
        resolve(observation);
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

  private trusted(entry: CatalogEntry<T, Failure> | undefined, now: number): T[] | undefined {
    return entry && now < entry.fetchedAt + this.options.staleMaxAgeMs ? entry.models : undefined;
  }

  private async refresh(
    key: string,
    fetchModels: (signal: AbortSignal) => Promise<CatalogFetch<T, Failure>>,
    superseded: { value: boolean },
  ): Promise<CatalogObservation<T, Failure>> {
    const controller = new AbortController();
    const failed: CatalogFetch<T, Failure> = { attempted: true };
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<CatalogFetch<T, Failure>>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ...failed, failure: this.options.deadlineFailure });
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
    if (superseded.value) return { models: this.trusted(prior, now) };
    if (!result.attempted) return {};
    const models = result.models?.length ? result.models : undefined;
    const entry = models
      ? { models, fetchedAt: now, expiresAt: now + this.options.ttlMs }
      : {
          models: this.trusted(prior, now),
          failure: result.failure,
          fetchedAt: prior?.fetchedAt ?? now,
          expiresAt: now + this.options.failureTtlMs,
        };
    this.store(key, { ...entry, manualObservationOrder: prior?.manualObservationOrder });
    return { models, failure: result.failure };
  }

  private store(key: string, entry: CatalogEntry<T, Failure>) {
    if (!this.entries.has(key) && this.entries.size >= this.options.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, entry);
  }
}
