import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { RowSecurityPolicyStatus } from "@rakazo/db";
import {
  applyRowSecurityPolicies,
  createDb,
  databaseUrls,
  describeRowSecurityPolicies,
  runAsSystem,
  verifyRealtimeDatabase,
  verifyRuntimeDatabase,
} from "@rakazo/db";
import { formatDatabasePreparationFailure } from "./migrate-database-error.js";

function print(status: RowSecurityPolicyStatus): void {
  const enabled = status.tables.filter((table) => table.enabled).length;
  process.stdout.write(
    `Row-level isolation: ${status.connectionEnforced ? "verified for this connection" : "not verified"} (${enabled}/${status.expectedTables} tables enabled).\n` +
      "Deployment isolation: not verified.\n",
  );
  const problems = [
    ...status.problems,
    ...status.tables.flatMap((table) =>
      table.problems.map((problem) => `${table.table}:${problem}`),
    ),
  ];
  if (problems.length > 0) process.stdout.write(`Policy problems: ${problems.join(", ")}.\n`);
}

async function main(): Promise<void> {
  loadRootEnv();
  const [command = "status", ...extra] = process.argv.slice(2);
  const rollback = command === "verify" && extra.length === 1 && extra[0] === "--computer-rollback";
  if (
    (command !== "status" && command !== "verify" && command !== "apply") ||
    (extra.length > 0 && !rollback)
  )
    throw new Error("Use db:row-security status, db:row-security verify or db:row-security apply");
  const urls = databaseUrls(process.env);
  if (command === "apply") {
    print(await applyRowSecurityPolicies(urls.migrationUrl, urls.url));
    return;
  }
  const { prisma, pool } = createDb(urls.url, { poolMax: 1, rowSecurity: true });
  try {
    if (command === "verify") {
      // Recovery uses the candidate image to check the database before it
      // restarts the prior image. The Pages migration may have rolled back.
      const options = { allowPrePages: true };
      const status = await verifyRuntimeDatabase(prisma, options);
      if (status.problems.includes("runtime-not-prepared"))
        throw new Error("Runtime role preparation failed");
      if (rollback) {
        const [schema] = await prisma.$queryRaw<Array<{ present: boolean }>>`
          SELECT EXISTS (
            SELECT FROM pg_attribute WHERE attrelid = 'public.computers'::regclass
              AND attname = 'stopRequestedAt' AND NOT attisdropped
          ) AS present`;
        if (schema?.present) {
          const [computer] = await runAsSystem(
            "verify rollback-safe computer state",
            () =>
              prisma.$queryRaw<Array<{ pending: boolean }>>`
              SELECT EXISTS (
                SELECT FROM public.computers
                WHERE state IN ('quarantined', 'needs_recovery', 'restoring') OR "stopRequestedAt" IS NOT NULL
              ) AS pending`,
          );
          if (computer?.pending) {
            throw new Error("Resolve unconfirmed computer stops before starting an older runtime");
          }
        }
      }
      const realtimeUrl = process.env.REALTIME_DATABASE_URL?.trim();
      if (realtimeUrl && realtimeUrl !== urls.url)
        await verifyRealtimeDatabase(realtimeUrl, status.connectionEnforced, true, options);
      process.stdout.write(
        status.connectionEnforced
          ? "Runtime database validation: row-level isolation verified.\n"
          : "Runtime database validation: role and system key ready; row-level isolation is not enabled.\n",
      );
      return;
    }
    print(await describeRowSecurityPolicies(prisma));
  } finally {
    try {
      await prisma.$disconnect();
    } finally {
      await pool.end();
    }
  }
}

const commandHints = new Map([
  [
    "Resolve unconfirmed computer stops before starting an older runtime",
    "Resolve unconfirmed computer stops before starting an older runtime.",
  ],
  [
    "Database policy commit outcome is uncertain; policies may have committed",
    "Database policy commit outcome is uncertain; policies may have committed. Run db:row-security status before retrying.",
  ],
  [
    "Database policies were committed, but runtime verification failed",
    "Database policies were committed, but runtime verification failed. The policy installation was not rolled back.",
  ],
  [
    "Database policies were committed, but the administrator connection did not close cleanly",
    "Database policies were committed, but the administrator connection did not close cleanly. The policy installation was not rolled back.",
  ],
  [
    "Use db:row-security status, db:row-security verify or db:row-security apply",
    "Use db:row-security status, db:row-security verify or db:row-security apply.",
  ],
]);

main().catch((error: unknown) => {
  let hint: string | undefined;
  try {
    if (error instanceof Error && !("code" in error)) hint = commandHints.get(error.message);
  } catch {
    // Unknown errors retain the same redaction as other administration commands.
  }
  process.stderr.write(hint ? `${hint}\n` : formatDatabasePreparationFailure(error));
  process.exitCode = 1;
});
