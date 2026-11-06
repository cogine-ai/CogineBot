import { execFileSync } from "node:child_process";
import { migrateJobQueue } from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  createDb,
  createPool,
  databaseUrls,
  describeRowSecurity,
  migratePageRowSecurityPolicies,
  provisionRuntimeRole,
  SINGLE_DATABASE_URL_WARNING,
  verifyRealtimeDatabase,
  verifyRuntimeDatabase,
} from "@rakazo/db";
import { formatDatabasePreparationFailure } from "./migrate-database-error.js";

async function main() {
  loadRootEnv();
  const urls = databaseUrls(process.env);
  if (!urls.separate) {
    const pool = createPool(urls.url, { poolMax: 1 });
    try {
      await pool.query("SELECT 1");
    } finally {
      await pool.end();
    }
  }
  const migrationUrl = new URL(urls.migrationUrl);
  migrationUrl.searchParams.set("schema", "public");
  execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_MIGRATION_URL: migrationUrl.toString(),
      DATABASE_URL: migrationUrl.toString(),
    },
  });
  await migrateJobQueue(urls.migrationUrl);
  if (!urls.separate) {
    await migratePageRowSecurityPolicies(urls.migrationUrl, urls.url);
    process.stderr.write(`WARNING: ${SINGLE_DATABASE_URL_WARNING}\n`);
  } else {
    await provisionRuntimeRole(urls.migrationUrl, urls.url);
    await migratePageRowSecurityPolicies(urls.migrationUrl, urls.url);
    const { prisma, pool } = createDb(urls.url, { poolMax: 1, rowSecurity: true });
    try {
      const status = await describeRowSecurity(prisma);
      if (!status.prepared) throw new Error(status.reason ?? "Runtime role preparation failed");
      const policyStatus = await verifyRuntimeDatabase(prisma);
      const realtimeUrl = process.env.REALTIME_DATABASE_URL?.trim();
      if (realtimeUrl && realtimeUrl !== urls.url)
        await verifyRealtimeDatabase(realtimeUrl, policyStatus.connectionEnforced, true);
      process.stdout.write(
        "Runtime role and system key are ready. This command preserves the database protection phase and does not activate service contexts.\n",
      );
    } finally {
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(formatDatabasePreparationFailure(error));
  process.exitCode = 1;
});
