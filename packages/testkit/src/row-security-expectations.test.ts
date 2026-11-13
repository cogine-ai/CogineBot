import { ROW_SECURITY_POLICIES } from "@rakazo/db";
import { expect, it } from "vitest";
import {
  expectExactPolicyCatalog,
  expectRegisteredPolicyTables,
  schemaPolicyTables,
} from "./row-security-expectations.js";

it("rejects a missing receipt registration even when the registry's own size agrees", () => {
  const incomplete = ROW_SECURITY_POLICIES.filter(({ model }) => model !== "McpCreateRequest");
  expect(() => expectRegisteredPolicyTables(incomplete)).toThrow();
  expectRegisteredPolicyTables(ROW_SECURITY_POLICIES);
});
it("rejects missing or extra native policies independently of the production registry", () => {
  const actual = ROW_SECURITY_POLICIES.flatMap(({ schema = "public", table, tenantPredicate }) => [
    { schema, table, policy: `${table}_system` },
    ...(tenantPredicate ? [{ schema, table, policy: `${table}_tenant` }] : []),
  ]);
  expectExactPolicyCatalog(actual);
  expect(() =>
    expectExactPolicyCatalog(actual.filter(({ table }) => table !== "mcp_create_requests")),
  ).toThrow();
  expect(() =>
    expectExactPolicyCatalog([
      ...actual,
      { schema: "public", table: "mcp_create_requests", policy: "unexpected_permissive" },
    ]),
  ).toThrow();
  expect(schemaPolicyTables.some(({ model }) => model === "McpCreateRequest")).toBe(true);
});
