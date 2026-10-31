export type Shard = { current: number; total: number };

// Match Playwright's one-based --shard=current/total syntax for both harness modes.
export function parseShard(args: readonly string[]): Shard | undefined {
  const options = args.filter((arg) => arg === "--shard" || arg.startsWith("--shard="));
  if (options.length === 0) return undefined;
  if (options.length > 1) throw new Error("Pass --shard only once");
  const match = /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(options[0]!);
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total) || current > total) {
    throw new Error("Pass --shard=current/total with positive integers and current <= total");
  }
  return { current, total };
}

export function selectIntegrationSuites(
  suites: readonly string[],
  spec: string | undefined,
  shard: Shard | undefined,
): string[] {
  const pattern = spec === undefined ? undefined : new RegExp(spec);
  const matching = suites.filter((suite) => !pattern || pattern.test(suite));
  if (matching.length === 0) throw new Error("No integration suites matched --spec");
  // Partition the filtered suite list; every suite still gets its own database/process.
  const selected = shard
    ? matching.filter((_, index) => index % shard.total === shard.current - 1)
    : matching;
  if (shard && selected.length === 0) {
    throw new Error(`No integration suites selected for --shard=${shard.current}/${shard.total}`);
  }
  return selected;
}
