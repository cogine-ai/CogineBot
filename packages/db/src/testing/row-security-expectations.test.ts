import { expect, it } from "vitest";
import { ROW_SECURITY_POLICIES } from "../row-security-policies.js";
import {
  expectExactPolicyCatalog,
  expectPhysicalPolicyTables,
  expectRegisteredPolicyTables,
  schemaPolicyTables,
} from "./row-security-expectations.js";

it("detects missing, extra and count-preserving replacement registrations and tables", () => {
  expectRegisteredPolicyTables(ROW_SECURITY_POLICIES);
  expectPhysicalPolicyTables(schemaPolicyTables);
  for (const rows of [
    schemaPolicyTables.slice(1),
    [...schemaPolicyTables, { model: "Unknown", table: "unknown", schema: "public" }],
    [{ model: "Unknown", table: "unknown", schema: "public" }, ...schemaPolicyTables.slice(1)],
  ]) {
    expect(() => expectRegisteredPolicyTables(rows)).toThrow();
    expect(() => expectPhysicalPolicyTables(rows)).toThrow();
  }
});
it("rejects missing, extra and count-preserving replacement policies", () => {
  const rows = ROW_SECURITY_POLICIES.flatMap((p) => [
    { schema: p.schema ?? "public", relname: p.table, polname: `${p.table}_system` },
    ...(p.tenantPredicate
      ? [{ schema: p.schema ?? "public", relname: p.table, polname: `${p.table}_tenant` }]
      : []),
  ]);
  expectExactPolicyCatalog(rows);
  const extra = { schema: "public", relname: "routine_mutations", polname: "unexpected" };
  for (const changed of [rows.slice(1), [...rows, extra], [extra, ...rows.slice(1)]])
    expect(() => expectExactPolicyCatalog(changed)).toThrow();
});
