import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  databaseRestoreFence,
  databaseUrls,
  prepareDatabaseRestore,
  verifyDatabaseRestore,
} from "@rakazo/db";
import { formatDatabasePreparationFailure } from "./migrate-database-error.js";

async function main(): Promise<void> {
  const [command, ...extra] = process.argv.slice(2);
  if (command === "fence") process.env.DOTENV_CONFIG_QUIET = "true";
  loadRootEnv();
  if ((command !== "prepare" && command !== "verify" && command !== "fence") || extra.length > 0)
    throw new Error("Use db:restore prepare or db:restore verify");
  const urls = databaseUrls(process.env);
  const runtimeUrls = [urls.url];
  const realtime = process.env.REALTIME_DATABASE_URL?.trim();
  if (realtime) runtimeUrls.push(realtime);
  if (command === "fence") {
    process.stdout.write(`${await databaseRestoreFence(urls.migrationUrl, runtimeUrls)}\n`);
    return;
  }
  if (command === "prepare") {
    await prepareDatabaseRestore(urls.migrationUrl, runtimeUrls);
    process.stdout.write("Restore role prerequisites are ready.\n");
    return;
  }
  const status = await verifyDatabaseRestore(urls.migrationUrl, runtimeUrls);
  process.stdout.write(
    status.connectionEnforced
      ? "Restore database validation: row-level isolation verified.\n"
      : "Restore database validation: role and system key ready; row-level isolation is not enabled.\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(formatDatabasePreparationFailure(error));
  process.exitCode = 1;
});
