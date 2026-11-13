import { readFileSync } from "node:fs";
import { expect } from "vitest";

// Independent of the runtime registry: missing registrations must fail coverage.
const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
export const schemaPolicyTables = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(
  ([, model, body]) => ({
    model: model!,
    table: body!.match(/@@map\(\s*"([^"]+)"\s*\)/)?.[1] ?? model!,
    schema: body!.match(/@@schema\(\s*"([^"]+)"\s*\)/)?.[1] ?? "public",
  }),
);
// Reviewed system-only boundaries; schema alone cannot infer which tables expose tenant rows.
const systemOnly = new Set([
  "verification",
  "rateLimit",
  "deployment_settings",
  "messaging_install_sessions",
  "messaging_installations",
  "messaging_credential_cleanups",
  "messaging_channels",
  "messaging_channel_members",
  "agent_connections",
  "deployment_identities",
  "deployment_transfer_sessions",
  "deployment_transfer_items",
  "integration_provider_configs",
  "native_app_configs",
  "native_notion_hooks",
  "native_slack_hooks",
  "native_slack_event_inbox",
]);
export function expectRegisteredPolicyTables(
  registry: readonly { model: string; table: string; schema?: string }[],
) {
  expect(schemaPolicyTables).toContainEqual({
    model: "McpCreateRequest",
    schema: "public",
    table: "mcp_create_requests",
  });
  const normalized = registry.map(({ model, table, schema = "public" }) => ({
    model,
    table,
    schema,
  }));
  expect(normalized.sort((a, b) => a.model.localeCompare(b.model))).toEqual(
    [...schemaPolicyTables].sort((a, b) => a.model.localeCompare(b.model)),
  );
}
export function expectExactPolicyCatalog(
  rows: { schema: string; table: string; policy: string }[],
) {
  const expected = schemaPolicyTables
    .flatMap(({ schema, table }) => [
      `${schema}.${table}.${table}_system`,
      ...(systemOnly.has(table) ? [] : [`${schema}.${table}.${table}_tenant`]),
    ])
    .sort();
  expect(rows.map(({ schema, table, policy }) => `${schema}.${table}.${policy}`).sort()).toEqual(
    expected,
  );
}
export async function expectPhysicalPolicyTables(
  query: (sql: string) => Promise<{ rows: { schema: string; table: string }[] }>,
) {
  const actual = await query(
    "SELECT n.nspname AS schema,c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','cogine_pages') AND c.relkind IN ('r','p') AND c.relname <> '_prisma_migrations'",
  );
  expect(actual.rows.map(({ schema, table }) => `${schema}.${table}`).sort()).toEqual(
    schemaPolicyTables.map(({ schema, table }) => `${schema}.${table}`).sort(),
  );
}
