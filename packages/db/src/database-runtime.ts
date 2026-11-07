import { createDb } from "./client.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { Prisma } from "./generated/prisma/client.js";
import type {
  RowSecurityCatalogOptions,
  RowSecurityPolicyStatus,
} from "./row-security-policies.js";
import { describeRowSecurityPolicies } from "./row-security-policies.js";

/** Permit the unprotected legacy phase, but never an owner or partial-policy fallback once protected. */
export async function verifyRuntimeDatabase(
  prisma: PrismaClient,
  options?: RowSecurityCatalogOptions,
): Promise<RowSecurityPolicyStatus> {
  const status = await describeRowSecurityPolicies(prisma, options);
  if (status.connectionEnforced) return status;
  const [policies] = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::int AS count FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'cogine_pages')
  `);
  const legacy =
    policies?.count === 0 &&
    status.guardValid &&
    status.legacyPolicyCount === 0 &&
    status.problems.every((problem) => problem === "runtime-not-prepared") &&
    status.tables.every((table) => table.present && !table.enabled);
  if (!legacy)
    throw new Error("The service database role, policies, or system guard are not ready");
  return status;
}

/** Check the actual listener endpoint independently, including direct connections around a pooler. */
export async function verifyRealtimeDatabase(
  url: string,
  requireRowSecurity: boolean,
  requirePrepared = requireRowSecurity,
  options?: RowSecurityCatalogOptions,
): Promise<void> {
  const { prisma, pool } = createDb(url, {
    poolMax: 1,
    applicationName: "rakazo-realtime-readiness",
    rowSecurity: true,
  });
  try {
    const status = await verifyRuntimeDatabase(prisma, options);
    if (
      (requireRowSecurity && !status.connectionEnforced) ||
      (requirePrepared && status.problems.includes("runtime-not-prepared"))
    )
      throw new Error("The realtime database role, policies, or system guard are not ready");
  } finally {
    try {
      await prisma.$disconnect();
    } finally {
      await pool.end();
    }
  }
}
