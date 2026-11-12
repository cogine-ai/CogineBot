export function parseSecretMigrationOptions(args: string[]) {
  const modes = ["--reverse", "--cleanup-orphaned-transfers", "--retry-slack-cleanup"];
  if (
    args.some((arg) => arg !== "--dry-run" && !modes.includes(arg)) ||
    modes.filter((mode) => args.includes(mode)).length > 1
  )
    throw new Error(
      "Usage: secrets:infisical [--dry-run] [--reverse | --cleanup-orphaned-transfers | --retry-slack-cleanup]",
    );
  return {
    dryRun: args.includes("--dry-run"),
    reverse: args.includes("--reverse"),
    cleanupOrphanedTransfers: args.includes("--cleanup-orphaned-transfers"),
    retrySlackCleanup: args.includes("--retry-slack-cleanup"),
  };
}
