import { readFileSync } from "node:fs";
import { expect } from "vitest";

// Schema is independent of the runtime registry under test.
const source = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
export const schemaPolicyTables = [...source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(
  ([, model, body]) => ({
    model: model!,
    table: body!.match(/@@map\("([^"]+)"\)/)?.[1] ?? model!,
    schema: body!.match(/@@schema\("([^"]+)"\)/)?.[1] ?? "public",
  }),
);
// Explicitly reviewed system-only boundaries; never inferred from production predicates.
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
  rows: readonly { model: string; table: string; schema?: string }[],
) {
  expect(
    rows.map(({ model, table, schema = "public" }) => `${model}:${schema}.${table}`).sort(),
  ).toEqual(
    schemaPolicyTables.map(({ model, table, schema }) => `${model}:${schema}.${table}`).sort(),
  );
}
export function expectPhysicalPolicyTables(rows: { schema: string; table: string }[]) {
  expect(rows.map((r) => `${r.schema}.${r.table}`).sort()).toEqual(
    schemaPolicyTables.map((r) => `${r.schema}.${r.table}`).sort(),
  );
}
export function expectExactPolicyCatalog(
  rows: { schema: string; relname: string; polname: string }[],
) {
  expect(rows.map((r) => `${r.schema}.${r.relname}.${r.polname}`).sort()).toEqual(
    schemaPolicyTables
      .flatMap(({ schema, table }) => [
        `${schema}.${table}.${table}_system`,
        ...(systemOnly.has(table) ? [] : [`${schema}.${table}.${table}_tenant`]),
      ])
      .sort(),
  );
}
export function isolatedDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("An isolated harness database is required");
  const url = new URL(raw);
  if (
    // The isolated harness uses plain URLs. pg query options can override
    // authority or select additional connection sources; reject them before
    // a Client is constructed, including encoded and duplicate option keys.
    [...url.searchParams].length !== 0 ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    Number(url.port) <= 1024 ||
    !/^integration_(0|[1-9][0-9]*)$/.test(url.pathname.slice(1)) ||
    url.pathname.slice(1) !== process.env.VERIFY_ISOLATED_DATABASE
  )
    throw new Error("An isolated harness database is required");
  return raw;
}
