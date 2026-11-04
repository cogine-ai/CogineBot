import { rebuildLegacyRunQueue } from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createPool } from "@rakazo/db";
import { formatLegacyRunQueueFailure } from "./legacy-run-queue-error.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Usage: rebuild-legacy-run-queue [--apply]\n" +
        "Checks by default. Stop and drain both worker versions and all Run-writing services " +
        "before applying, and start the legacy release only after blocker-free readback. " +
        "This command cannot prove that maintenance precondition. Counts are planned unless applied is true.\n" +
        "If check reports queue_schema_unavailable, first install the existing Graphile schema in the " +
        "same maintenance window: pnpm --filter @rakazo/adapters exec graphile-worker --schema-only. " +
        "Graphile reads DATABASE_URL from the environment; do not pass credentials as command arguments. " +
        "Then repeat check, inspect all blockers, and apply only after a blocker-free check.\n",
    );
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) {
    throw new Error("Expected no arguments or --apply");
  }
  loadRootEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = createPool(databaseUrl, {
    poolMax: 1,
    applicationName: "rakazo-legacy-queue-rebuild",
  });
  try {
    const result = await rebuildLegacyRunQueue(pool, { apply: args[0] === "--apply" });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.blockers.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Connection errors can contain credentials or deployment addresses.
  process.stderr.write(formatLegacyRunQueueFailure(error));
  process.exitCode = 1;
});
