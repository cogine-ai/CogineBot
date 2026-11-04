import { execFileSync } from "node:child_process";
import { migrateJobQueue } from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  createDb,
  databaseUrls,
  describeRowSecurity,
  provisionRuntimeRole,
  SINGLE_DATABASE_URL_WARNING,
} from "@rakazo/db";

async function main() {
  loadRootEnv();
  const urls = databaseUrls(process.env);
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
    process.stderr.write(`WARNING: ${SINGLE_DATABASE_URL_WARNING}\n`);
  } else {
    const { warning } = await provisionRuntimeRole(urls.migrationUrl, urls.url);
    if (warning) throw new Error(warning);
    const { prisma, pool } = createDb(urls.url, { poolMax: 1, rowSecurity: true });
    try {
      const status = await describeRowSecurity(prisma);
      if (!status.prepared) throw new Error(status.reason ?? "Runtime role preparation failed");
      process.stdout.write(
        "Runtime role and system key are ready; full table policies and application contexts are not activated.\n",
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
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const sqlState = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` (${code})` : "";
  process.stderr.write(
    `Database preparation failed${sqlState}. Check the administrator connection, runtime role grants, and credential configuration.\n`,
  );
  process.exitCode = 1;
});
