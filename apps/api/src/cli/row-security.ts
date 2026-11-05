import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { RowSecurityPolicyStatus } from "@rakazo/db";
import {
  applyRowSecurityPolicies,
  createDb,
  databaseUrls,
  describeRowSecurityPolicies,
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
  if ((command !== "status" && command !== "apply") || extra.length > 0)
    throw new Error("Use db:row-security status or db:row-security apply");
  const urls = databaseUrls(process.env);
  if (command === "apply") {
    print(await applyRowSecurityPolicies(urls.migrationUrl, urls.url));
    return;
  }
  const { prisma, pool } = createDb(urls.url, { poolMax: 1, rowSecurity: true });
  try {
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
    "Database policies were committed, but runtime verification failed",
    "Database policies were committed, but runtime verification failed. The policy installation was not rolled back.",
  ],
  [
    "Use db:row-security status or db:row-security apply",
    "Use db:row-security status or db:row-security apply.",
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
