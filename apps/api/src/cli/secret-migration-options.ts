export function parseSecretMigrationOptions(args: string[]) {
  if (
    args.some((arg) => !["--dry-run", "--reverse", "--cleanup-orphaned-transfers"].includes(arg)) ||
    (args.includes("--reverse") && args.includes("--cleanup-orphaned-transfers"))
  )
    throw new Error(
      "Usage: secrets:infisical [--dry-run] [--reverse | --cleanup-orphaned-transfers]",
    );
  return {
    dryRun: args.includes("--dry-run"),
    reverse: args.includes("--reverse"),
    cleanupOrphanedTransfers: args.includes("--cleanup-orphaned-transfers"),
  };
}
