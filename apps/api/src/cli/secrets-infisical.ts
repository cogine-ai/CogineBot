import {
  ComposedSecretStore,
  EncryptedSecretStore,
  InfisicalSecretStore,
  migrateSecrets,
  PostgresRealtimeFanout,
  secretStoreOptionsFromEnv,
} from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb } from "@rakazo/db";
import { cleanupOrphanedTransfers } from "../deployment-transfer-cleanup.js";
import {
  createSecretMigrationRepository,
  secretMigrationReportIdentity,
} from "../secret-migration.js";
import { parseSecretMigrationOptions } from "./secret-migration-options.js";

loadRootEnv();

const args = process.argv.slice(2);
const command = parseSecretMigrationOptions(args);
const options = secretStoreOptionsFromEnv({
  ...process.env,
  ...(!command.cleanupOrphanedTransfers ? { SECRET_STORE: "infisical" } : {}),
});
if (!process.env.DATABASE_URL || (!command.cleanupOrphanedTransfers && !options))
  throw new Error("Secret storage and database configuration are required");
const { prisma, pool } = createDb(process.env.DATABASE_URL);
const encryptionKey = resolveEncryptionKey(process.env);
const realtime = new PostgresRealtimeFanout({
  connectionString: process.env.REALTIME_DATABASE_URL ?? process.env.DATABASE_URL,
  publisher: pool,
});
const encrypted = new ComposedSecretStore(
  new EncryptedSecretStore(encryptionKey),
  undefined,
  realtime,
);
const infisical = new ComposedSecretStore(
  new EncryptedSecretStore(encryptionKey),
  options ? new InfisicalSecretStore(options) : undefined,
  realtime,
);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const repository = createSecretMigrationRepository(prisma);
try {
  await encrypted.start();
  await infisical.start();
  if (command.cleanupOrphanedTransfers) {
    const result = await cleanupOrphanedTransfers({
      prisma,
      secrets: infisical,
      dryRun: command.dryRun,
      signal: controller.signal,
    });
    process.stdout.write(`Transfer cleanup: ${JSON.stringify(result)}\n`);
    if (result.uncertain || controller.signal.aborted) process.exitCode = 1;
  } else {
    const result = await migrateSecrets(
      repository,
      encrypted,
      infisical,
      {
        operationId: "secret-migration",
        traceId: "secret-migration",
        userId: "migration",
        spaceId: "migration",
        signal: controller.signal,
      },
      {
        direction: command.reverse ? "reverse" : "forward",
        dryRun: command.dryRun,
        report: (row, status) =>
          process.stdout.write(`${secretMigrationReportIdentity(row)}: ${status}\n`),
      },
    );
    if (result.failed || controller.signal.aborted) process.exitCode = 1;
  }
} catch {
  process.stderr.write(
    command.cleanupOrphanedTransfers ? "Transfer cleanup failed\n" : "Secret migration failed\n",
  );
  process.exitCode = 1;
} finally {
  await infisical.close();
  await encrypted.close();
  await realtime.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
