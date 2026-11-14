import { Client, escapeIdentifier } from "pg";
import { createDb } from "./client.js";
import { databaseUrls, describeRowSecurity } from "./database-access.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { Prisma } from "./generated/prisma/client.js";

export type RowSecurityPolicyScope = "tenant" | "user/account" | "explicit-system";

export interface RowSecurityTableStatus {
  model: string;
  table: string;
  scope: RowSecurityPolicyScope;
  present: boolean;
  enabled: boolean;
  active: boolean;
  policyMatch: boolean;
  problems: string[];
}

export interface RowSecurityPolicyStatus {
  expectedTables: number;
  policyInstalled: boolean;
  policyEnabled: boolean;
  connectionEnforced: boolean;
  deploymentEnforced: false;
  guardValid: boolean;
  legacyPolicyCount: number;
  tables: RowSecurityTableStatus[];
  problems: string[];
}

interface PolicyDefinition {
  readonly model: string;
  readonly table: string;
  readonly schema?: "cogine_pages";
  readonly scope: RowSecurityPolicyScope;
  readonly tenantPredicate?: string;
}

export interface RowSecurityCatalogOptions {
  /** Recovery may verify the exact predecessor when the Pages namespace does not exist. */
  allowPrePages?: boolean;
}

const space = "NULLIF(current_setting('app.space_id'::text, true), ''::text)";
const user = "NULLIF(current_setting('app.user_id'::text, true), ''::text)";
const system = "( SELECT public.app_rls_bypass() AS app_rls_bypass)";
const equal = (left: string, right: string) => `(${left} = ${right})`;
const all = (...parts: string[]) => (parts.length === 1 ? parts[0]! : `(${parts.join(" AND ")})`);
const either = (...parts: string[]) => `(${parts.join(" OR ")})`;
const exists = (from: string, ...conditions: string[]) =>
  `(EXISTS ( SELECT 1 FROM ${from} WHERE ${all(...conditions)}))`;
const belongs = (table: string, alias: string, parentId: string) =>
  exists(
    `public.${table} ${alias}`,
    equal(`${alias}.id`, parentId),
    equal(`${alias}."spaceId"`, space),
  );
const own = (field = '"userId"') => equal(field, user);
const local = () => equal('"spaceId"', space);
const accountOrganization = (field: string) =>
  exists("public.member m", equal('m."organizationId"', field), own('m."userId"'));
const optional = (field: string, predicate: string) => either(`(${field} IS NULL)`, predicate);

/** Exact model coverage; each predicate is also the expected native catalog expression. */
export const ROW_SECURITY_POLICIES: readonly PolicyDefinition[] = Object.freeze(
  (
    [
      {
        model: "AiDataConsent",
        table: "ai_data_consents",
        scope: "tenant",
        tenantPredicate: all(local(), own()),
      },
      { model: "User", table: "user", scope: "user/account", tenantPredicate: own("id") },
      { model: "Session", table: "session", scope: "user/account", tenantPredicate: own() },
      { model: "Account", table: "account", scope: "user/account", tenantPredicate: own() },
      { model: "Verification", table: "verification", scope: "explicit-system" },
      { model: "RateLimit", table: "rateLimit", scope: "explicit-system" },
      {
        model: "Organization",
        table: "organization",
        scope: "user/account",
        tenantPredicate: accountOrganization("organization.id"),
      },
      {
        model: "BillingAccount",
        table: "billing_accounts",
        scope: "user/account",
        tenantPredicate: accountOrganization('billing_accounts."organizationId"'),
      },
      {
        model: "ActionApprovalRule",
        table: "action_approval_rules",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "ActionAutoReviewPreference",
        table: "action_auto_review_preferences",
        scope: "tenant",
        tenantPredicate: all(local(), own()),
      },
      { model: "Member", table: "member", scope: "user/account", tenantPredicate: own() },
      {
        model: "Space",
        table: "spaces",
        scope: "user/account",
        tenantPredicate: exists(
          "public.space_members sm",
          equal('sm."spaceId"', "spaces.id"),
          own('sm."userId"'),
        ),
      },
      {
        model: "SpaceMember",
        table: "space_members",
        scope: "user/account",
        tenantPredicate: own(),
      },
      {
        model: "SpaceCollaborationChange",
        table: "space_collaboration_changes",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "Invitation",
        table: "invitation",
        scope: "user/account",
        tenantPredicate: accountOrganization('invitation."organizationId"'),
      },
      { model: "DeploymentSettings", table: "deployment_settings", scope: "explicit-system" },
      {
        model: "UserModelCredential",
        table: "user_model_credentials",
        scope: "user/account",
        tenantPredicate: own(),
      },
      {
        model: "UserVoiceCredential",
        table: "user_voice_credentials",
        scope: "user/account",
        tenantPredicate: own(),
      },
      {
        model: "SpaceModelPreference",
        table: "space_model_preferences",
        scope: "tenant",
        tenantPredicate: all(local(), own()),
      },
      {
        model: "SpaceBackupModel",
        table: "space_backup_models",
        scope: "tenant",
        tenantPredicate: all(local(), own()),
      },
      {
        model: "SpaceVoicePreference",
        table: "space_voice_preferences",
        scope: "tenant",
        tenantPredicate: all(local(), own()),
      },
      { model: "Bot", table: "bots", scope: "tenant", tenantPredicate: local() },
      {
        model: "BotPackagePreview",
        table: "bot_package_previews",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "BotPackageImport",
        table: "bot_package_imports",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "BotPackageComponent",
        table: "bot_package_components",
        scope: "tenant",
        tenantPredicate: exists(
          "public.bot_package_imports i, public.bots b",
          equal("i.id", 'bot_package_components."importId"'),
          equal("b.id", 'bot_package_components."botId"'),
          equal('i."spaceId"', space),
          equal('b."spaceId"', space),
        ),
      },
      { model: "BotSection", table: "bot_sections", scope: "tenant", tenantPredicate: local() },
      { model: "BotDeletion", table: "bot_deletions", scope: "tenant", tenantPredicate: local() },
      { model: "ChatGroup", table: "chat_groups", scope: "tenant", tenantPredicate: local() },
      {
        model: "ChatGroupMember",
        table: "chat_group_members",
        scope: "tenant",
        tenantPredicate: exists(
          "public.chat_groups g, public.bots b",
          equal("g.id", 'chat_group_members."groupId"'),
          equal("b.id", 'chat_group_members."botId"'),
          equal('g."spaceId"', space),
          equal('b."spaceId"', space),
        ),
      },
      { model: "Thread", table: "threads", scope: "tenant", tenantPredicate: local() },
      {
        model: "Message",
        table: "messages",
        scope: "tenant",
        tenantPredicate: belongs("threads", "t", 'messages."threadId"'),
      },
      { model: "Event", table: "events", scope: "tenant", tenantPredicate: local() },
      { model: "Task", table: "tasks", scope: "tenant", tenantPredicate: local() },
      { model: "Run", table: "runs", scope: "tenant", tenantPredicate: local() },
      {
        model: "SteeringMessage",
        table: "steering_messages",
        scope: "tenant",
        tenantPredicate: all(
          exists(
            "public.bots b, public.messages m, public.threads t",
            equal("b.id", 'steering_messages."botId"'),
            equal("m.id", 'steering_messages."messageId"'),
            equal("t.id", 'm."threadId"'),
            equal('b."spaceId"', space),
            equal('t."spaceId"', space),
          ),
          optional('"runId"', belongs("runs", "r", 'steering_messages."runId"')),
        ),
      },
      {
        model: "Attempt",
        table: "attempts",
        scope: "tenant",
        tenantPredicate: belongs("runs", "r", 'attempts."runId"'),
      },
      { model: "CloudAgent", table: "cloud_agents", scope: "tenant", tenantPredicate: local() },
      {
        model: "ExternalEffect",
        table: "external_effects",
        scope: "tenant",
        tenantPredicate: all(local(), belongs("runs", "r", 'external_effects."runId"')),
      },
      {
        model: "RoutineMutation",
        table: "routine_mutations",
        scope: "tenant",
        tenantPredicate: all(local(), own()),
      },
      { model: "Routine", table: "routines", scope: "tenant", tenantPredicate: local() },
      {
        model: "ScratchpadItem",
        table: "scratchpad_items",
        scope: "tenant",
        tenantPredicate: local(),
      },
      { model: "TaughtSkill", table: "taught_skills", scope: "tenant", tenantPredicate: local() },
      { model: "AgentSkill", table: "agent_skills", scope: "tenant", tenantPredicate: local() },
      { model: "Connection", table: "connections", scope: "tenant", tenantPredicate: local() },
      {
        model: "CapabilityInstall",
        table: "capability_installs",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "OpenApiImportReceipt",
        table: "openapi_import_receipts",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "MemoryDocument",
        table: "memory_documents",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "MemoryRevision",
        table: "memory_revisions",
        scope: "tenant",
        tenantPredicate: belongs("memory_documents", "d", 'memory_revisions."documentId"'),
      },
      { model: "AgentHome", table: "agent_homes", scope: "tenant", tenantPredicate: local() },
      {
        model: "BrowserProfile",
        table: "browser_profiles",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "ComputerUpdate",
        table: "computer_updates",
        scope: "tenant",
        tenantPredicate: belongs("computers", "c", 'computer_updates."computerId"'),
      },
      { model: "Computer", table: "computers", scope: "tenant", tenantPredicate: local() },
      {
        model: "ComputerExecutionLease",
        table: "computer_execution_leases",
        scope: "tenant",
        tenantPredicate: belongs("computers", "c", 'computer_execution_leases."computerId"'),
      },
      { model: "Artifact", table: "artifacts", scope: "tenant", tenantPredicate: local() },
      { model: "UsageRecord", table: "usage_records", scope: "tenant", tenantPredicate: local() },
      {
        model: "NotificationPreference",
        table: "notification_preferences",
        scope: "tenant",
        tenantPredicate: all(local(), own()),
      },
      {
        model: "SpaceMemoryConfig",
        table: "space_memory_configs",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "Secret",
        table: "secrets",
        scope: "tenant",
        tenantPredicate: either(local(), all('("spaceId" IS NULL)', own())),
      },
      { model: "McpServer", table: "mcp_servers", scope: "tenant", tenantPredicate: local() },
      {
        model: "McpOAuthSession",
        table: "mcp_oauth_sessions",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "BotMcpServer",
        table: "bot_mcp_servers",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "MessagingInstallSession",
        table: "messaging_install_sessions",
        scope: "explicit-system",
      },
      {
        model: "MessagingInstallation",
        table: "messaging_installations",
        scope: "explicit-system",
      },
      {
        model: "MessagingCredentialCleanup",
        table: "messaging_credential_cleanups",
        scope: "explicit-system",
      },
      {
        model: "MessagingIdentity",
        table: "messaging_identities",
        scope: "tenant",
        tenantPredicate: local(),
      },
      { model: "MessagingChannel", table: "messaging_channels", scope: "explicit-system" },
      {
        model: "MessagingChannelMember",
        table: "messaging_channel_members",
        scope: "explicit-system",
      },
      {
        model: "MessagingLinkCode",
        table: "messaging_link_codes",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "Page",
        table: "pages",
        schema: "cogine_pages",
        scope: "tenant",
        tenantPredicate: all(local(), own()),
      },
      {
        model: "PageVersion",
        table: "page_versions",
        schema: "cogine_pages",
        scope: "tenant",
        tenantPredicate: exists(
          "cogine_pages.pages p",
          equal("p.id", 'page_versions."pageId"'),
          equal('p."spaceId"', space),
          own('p."userId"'),
        ),
      },
      {
        model: "MessagingOutbound",
        table: "messaging_outbound",
        scope: "tenant",
        tenantPredicate: either(
          belongs("messaging_identities", "i", 'messaging_outbound."identityId"'),
          exists(
            "public.messages m, public.threads t",
            equal("m.id", 'messaging_outbound."sourceMessageId"'),
            equal("t.id", 'm."threadId"'),
            equal('t."spaceId"', space),
          ),
        ),
      },
      { model: "AgentConnection", table: "agent_connections", scope: "explicit-system" },
      { model: "BotSecret", table: "bot_secrets", scope: "tenant", tenantPredicate: local() },
      { model: "DeploymentIdentity", table: "deployment_identities", scope: "explicit-system" },
      {
        model: "DeploymentTransferSession",
        table: "deployment_transfer_sessions",
        scope: "explicit-system",
      },
      {
        model: "DeploymentTransferItem",
        table: "deployment_transfer_items",
        scope: "explicit-system",
      },
      {
        model: "ExternalConversation",
        table: "external_conversations",
        scope: "tenant",
        tenantPredicate: local(),
      },
      {
        model: "ExternalMessage",
        table: "external_messages",
        scope: "tenant",
        tenantPredicate: all(
          belongs("external_conversations", "c", 'external_messages."externalConversationId"'),
          optional('"runId"', belongs("runs", "r", 'external_messages."runId"')),
          optional(
            '"threadMessageId"',
            exists(
              "public.messages m, public.threads t",
              equal("m.id", 'external_messages."threadMessageId"'),
              equal("t.id", 'm."threadId"'),
              equal('t."spaceId"', space),
            ),
          ),
        ),
      },
      { model: "AgentSecret", table: "agent_secrets", scope: "tenant", tenantPredicate: local() },
      {
        model: "IntegrationProviderConfig",
        table: "integration_provider_configs",
        scope: "explicit-system",
      },
      { model: "Board", table: "boards", scope: "tenant", tenantPredicate: local() },
      { model: "Ticket", table: "tickets", scope: "tenant", tenantPredicate: local() },
      {
        model: "TicketComment",
        table: "ticket_comments",
        scope: "tenant",
        tenantPredicate: local(),
      },
      { model: "NativeAppConfig", table: "native_app_configs", scope: "explicit-system" },
      {
        model: "NativeOAuthSession",
        table: "native_oauth_sessions",
        scope: "tenant",
        tenantPredicate: all(
          local(),
          own(),
          exists(
            "public.connections c",
            equal("c.id", 'native_oauth_sessions."connectionId"'),
            equal('c."spaceId"', space),
            own('c."userId"'),
          ),
        ),
      },
      {
        model: "NativeOAuthGrant",
        table: "native_oauth_grants",
        scope: "tenant",
        tenantPredicate: all(local(), own()),
      },
      {
        model: "NativeRoutineTrigger",
        table: "native_routine_triggers",
        scope: "tenant",
        tenantPredicate: exists(
          "public.routines r, public.connections c, public.native_oauth_grants g",
          equal("r.id", 'native_routine_triggers."routineId"'),
          equal("c.id", 'native_routine_triggers."connectionId"'),
          equal("g.id", 'native_routine_triggers."grantId"'),
          equal('r."spaceId"', space),
          equal('c."spaceId"', space),
          equal('g."spaceId"', space),
          equal('r."userId"', 'c."userId"'),
          equal('c."userId"', 'g."userId"'),
          equal('c."oauthGrantId"', "g.id"),
        ),
      },
      { model: "NativeNotionHook", table: "native_notion_hooks", scope: "explicit-system" },
      { model: "NativeSlackHook", table: "native_slack_hooks", scope: "explicit-system" },
      {
        model: "NativeSlackEventInbox",
        table: "native_slack_event_inbox",
        scope: "explicit-system",
      },
    ] satisfies PolicyDefinition[]
  ).map((definition) => Object.freeze(definition)),
);

interface RelationRow {
  schema: string;
  table: string;
  kind: string;
  enabled: boolean;
  active: boolean;
}
interface PolicyRow {
  schema: string;
  table: string;
  name: string;
  command: string;
  permissive: boolean;
  publicRole: boolean;
  predicate: string | null;
  check: string | null;
}
interface GuardRow {
  body: string;
  attributes: boolean;
  privateAcl: boolean;
}
interface Catalog {
  relations: RelationRow[];
  policies: PolicyRow[];
  guard: GuardRow | undefined;
  versionFunction: boolean;
  pageSchemaPresent: boolean;
}
type Query = <T>(statement: Prisma.Sql) => Promise<T[]>;

const guardBody = `SELECT coalesce(current_setting('app.rls_bypass', true) = 'on', false)
  AND NULLIF(current_setting('app.rls_bypass_key', true), '') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM cogine_private.rls_bypass_keys
    WHERE digest = sha256(convert_to(current_setting('app.rls_bypass_key', true), 'UTF8'))
  )`;
const normalized = (sql: string | null) => sql?.replace(/\s+/g, " ").trim();
const publicDefinitions = ROW_SECURITY_POLICIES.filter(({ schema }) => schema === undefined);
const pageDefinitions = ROW_SECURITY_POLICIES.filter(({ schema }) => schema === "cogine_pages");
const tableKey = ({ schema, table }: { schema?: string; table: string }) =>
  `${schema ?? "public"}.${table}`;
const relationSql = Prisma.sql`SELECT n.nspname AS schema, c.relname AS "table", c.relkind::text AS kind,
  c.relrowsecurity AS enabled, pg_catalog.row_security_active(c.oid) AS active
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'cogine_pages') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  ORDER BY n.nspname, c.relname`;
const policySql = Prisma.sql`SELECT n.nspname AS schema, c.relname AS "table", p.polname AS name,
  p.polcmd::text AS command, p.polpermissive AS permissive,
  p.polroles = ARRAY[0::pg_catalog.oid] AS "publicRole",
  pg_catalog.pg_get_expr(p.polqual, p.polrelid, false) AS predicate,
  pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, false) AS check
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'cogine_pages') ORDER BY n.nspname, c.relname, p.polname`;
const guardSql = Prisma.sql`SELECT f.prosrc AS body,
  (f.prosecdef AND NOT f.proretset AND f.prokind = 'f' AND f.provolatile = 's'
    AND f.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
    AND l.lanname = 'sql'
    AND f.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
    AND k.relkind = 'r' AND f.proowner = k.relowner) AS attributes,
  (NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(
      CASE WHEN pg_catalog.cardinality(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) > 0 THEN COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner)) END) a WHERE a.grantee = 0)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(
      CASE WHEN pg_catalog.cardinality(COALESCE(k.relacl, pg_catalog.acldefault('r', k.relowner))) > 0 THEN COALESCE(k.relacl, pg_catalog.acldefault('r', k.relowner)) END) a WHERE a.grantee = 0)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute c,
      LATERAL pg_catalog.aclexplode(CASE WHEN pg_catalog.cardinality(c.attacl) > 0 THEN c.attacl END) a
      WHERE c.attrelid = k.oid AND c.attnum > 0 AND NOT c.attisdropped AND a.grantee = 0)) AS "privateAcl"
  FROM pg_catalog.pg_proc f
  JOIN pg_catalog.pg_namespace fn ON fn.oid = f.pronamespace AND fn.nspname = 'public'
  JOIN pg_catalog.pg_language l ON l.oid = f.prolang
  JOIN pg_catalog.pg_namespace n ON n.nspname = 'cogine_private'
  JOIN pg_catalog.pg_class k ON k.relnamespace = n.oid AND k.relname = 'rls_bypass_keys'
  WHERE f.proname = 'app_rls_bypass' AND f.pronargs = 0`;

async function readCatalog(query: Query): Promise<Catalog> {
  const relations = await query<RelationRow>(relationSql);
  const policies = await query<PolicyRow>(policySql);
  const [guard] = await query<GuardRow>(guardSql);
  const [metadata] = await query<{ versionFunction: boolean; pageSchemaPresent: boolean }>(
    Prisma.sql`SELECT
      pg_catalog.to_regprocedure('public.app_rls_version()') IS NOT NULL AS "versionFunction",
      pg_catalog.to_regnamespace('cogine_pages') IS NOT NULL AS "pageSchemaPresent"`,
  );
  return {
    relations,
    policies,
    guard,
    versionFunction: metadata?.versionFunction === true,
    pageSchemaPresent: metadata?.pageSchemaPresent !== false,
  };
}

function expectedPolicies(definition: PolicyDefinition) {
  return [
    ...(definition.tenantPredicate
      ? [{ name: `${definition.table}_tenant`, predicate: definition.tenantPredicate }]
      : []),
    { name: `${definition.table}_system`, predicate: system },
  ];
}

/** A FOR ALL policy without WITH CHECK applies its USING predicate to writes too. */
function matches(policy: PolicyRow, predicate: string): boolean {
  return (
    policy.command === "*" &&
    policy.permissive === true &&
    policy.publicRole === true &&
    policy.check === null &&
    normalized(policy.predicate) === normalized(predicate)
  );
}

function isLegacy(policy: PolicyRow): boolean {
  return (
    policy.name.endsWith("_previous_release") || /\bapp_rls_version\b/.test(policy.predicate ?? "")
  );
}

function report(
  catalog: Catalog,
  prepared: boolean,
  { allowPrePages }: RowSecurityCatalogOptions = {},
): RowSecurityPolicyStatus {
  const definitions =
    allowPrePages && !catalog.pageSchemaPresent ? publicDefinitions : ROW_SECURITY_POLICIES;
  const knownTables = new Set(definitions.map(tableKey));
  const relations = new Map(catalog.relations.map((relation) => [tableKey(relation), relation]));
  const tables = definitions.map((definition): RowSecurityTableStatus => {
    const key = tableKey(definition);
    const relation = relations.get(key);
    const policies = catalog.policies.filter((policy) => tableKey(policy) === key);
    const expected = expectedPolicies(definition);
    const policyMatch =
      policies.length === expected.length &&
      expected.every((wanted) =>
        policies.some((policy) => policy.name === wanted.name && matches(policy, wanted.predicate)),
      );
    const present = relation !== undefined && ["r", "p"].includes(relation.kind);
    const problems: string[] = [];
    if (!present) problems.push("missing-table");
    if (present && !relation.enabled) problems.push("rls-disabled");
    if (!policyMatch) problems.push("policy-mismatch");
    return {
      model: definition.model,
      table: definition.table,
      scope: definition.scope,
      present,
      enabled: present && relation.enabled,
      active: present && relation.active,
      policyMatch,
      problems,
    };
  });
  const problems = catalog.relations
    .filter(
      (relation) =>
        !knownTables.has(tableKey(relation)) && tableKey(relation) !== "public._prisma_migrations",
    )
    .map(
      (relation) =>
        `unmapped-table:${relation.schema === "public" ? relation.table : tableKey(relation)}`,
    );
  const legacyPolicyCount = catalog.policies.filter(isLegacy).length;
  if (legacyPolicyCount > 0 || catalog.versionFunction) problems.push("legacy-policy");
  const guardValid =
    catalog.guard?.attributes === true &&
    catalog.guard.privateAcl === true &&
    normalized(catalog.guard.body) === normalized(guardBody);
  if (!guardValid) problems.push("guard-invalid");
  if (!prepared) problems.push("runtime-not-prepared");
  const policyInstalled =
    tables.every((table) => table.present && table.policyMatch) &&
    !problems.some(
      (problem) => problem.startsWith("unmapped-table:") || problem === "legacy-policy",
    );
  const policyEnabled = tables.every((table) => table.enabled);
  return {
    expectedTables: definitions.length,
    policyInstalled,
    policyEnabled,
    connectionEnforced:
      prepared &&
      guardValid &&
      policyInstalled &&
      policyEnabled &&
      tables.every((table) => table.active),
    deploymentEnforced: false,
    guardValid,
    legacyPolicyCount,
    tables,
    problems,
  };
}

/** Inspect definitions and this connection, without certifying activation of API or worker pools. */
export async function describeRowSecurityPolicies(
  prisma: PrismaClient,
  options?: RowSecurityCatalogOptions,
): Promise<RowSecurityPolicyStatus> {
  const catalog = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL search_path = pg_catalog, pg_temp`;
    await tx.$executeRaw`SET LOCAL quote_all_identifiers = off`;
    return readCatalog(<T>(statement: Prisma.Sql) => tx.$queryRaw<T[]>(statement));
  });
  const status = report(catalog, false, options);
  if (!status.guardValid) return status;
  const runtime = await describeRowSecurity(prisma);
  return report(catalog, runtime.prepared, options);
}

/** Retire only the registered compatibility shape; other policies need explicit review. */
function canRetire(policy: PolicyRow): boolean {
  if (
    policy.schema !== "public" ||
    !publicDefinitions.some((definition) => definition.table === policy.table) ||
    policy.command !== "*" ||
    !policy.permissive ||
    !policy.publicRole ||
    policy.check !== null
  )
    return false;
  return (
    policy.name === `${policy.table}_previous_release` &&
    normalized(policy.predicate) === "(public.app_rls_version() < 2)"
  );
}

function assertInstallable(catalog: Catalog): void {
  const status = report(catalog, false);
  if (!status.guardValid) throw new Error("The protected database system guard is not ready");
  if (
    status.tables.some((table) => !table.present) ||
    status.problems.some((problem) => problem.startsWith("unmapped-table:"))
  )
    throw new Error("The database schema does not match the registered row-security policies");
  for (const policy of catalog.policies) {
    const definition = ROW_SECURITY_POLICIES.find((entry) => tableKey(entry) === tableKey(policy));
    if (!definition) continue;
    if (expectedPolicies(definition).some((expected) => expected.name === policy.name)) continue;
    if (canRetire(policy)) continue;
    throw new Error("Unrecognized database policies must be reviewed before installation");
  }
}

/**
 * Authenticate the prepared runtime, install in one owner transaction, then verify a fresh runtime.
 * Changes roll back before a commit attempt; a missing commit acknowledgement leaves the outcome
 * uncertain. Verification failure after an acknowledged commit leaves the installation committed.
 * This explicit maintenance operation does not activate services or run in ordinary migrations.
 */
export async function applyRowSecurityPolicies(
  migrationUrl: string,
  runtimeUrl: string,
): Promise<RowSecurityPolicyStatus> {
  const urls = databaseUrls({ DATABASE_MIGRATION_URL: migrationUrl, DATABASE_URL: runtimeUrl });
  const owner = new Client({
    connectionString: urls.migrationUrl,
    connectionTimeoutMillis: 10_000,
  });
  let inTransaction = false;
  let commitAttempted = false;
  let committed = false;
  let failed = false;
  let failure: unknown;
  try {
    await owner.connect();
    await owner.query("SET lock_timeout = '10s'");
    await owner.query(
      "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended(pg_catalog.current_database() || ':coginebot-runtime-role-provision', 0))",
    );
    await owner.query("BEGIN");
    inTransaction = true;
    await owner.query("SET LOCAL search_path = pg_catalog, pg_temp");
    await owner.query("SET LOCAL quote_all_identifiers = off");
    const query: Query = async <T>(statement: Prisma.Sql) =>
      (await owner.query(statement.text, statement.values)).rows as T[];
    const before = await readCatalog(query);
    assertInstallable(before);
    const { prisma, pool } = createDb(urls.url, { poolMax: 1, rowSecurity: true });
    try {
      const runtime = await describeRowSecurity(prisma);
      if (!runtime.prepared) throw new Error("The runtime role and system key are not ready");
    } finally {
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    }
    const ownership = await query<{ owns: boolean }>(Prisma.sql`SELECT
      pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AS owns
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname = 'public' AND c.relname = ANY(${publicDefinitions.map((entry) => entry.table)}::text[]))
        OR (n.nspname = 'cogine_pages' AND c.relname = ANY(${pageDefinitions.map((entry) => entry.table)}::text[]))`);
    if (ownership.length !== ROW_SECURITY_POLICIES.length || ownership.some((row) => !row.owns))
      throw new Error("The administrator must own every registered application table");
    for (const policy of before.policies.filter(canRetire))
      await owner.query(
        `DROP POLICY ${escapeIdentifier(policy.name)} ON public.${escapeIdentifier(policy.table)}`,
      );
    for (const definition of [...ROW_SECURITY_POLICIES].sort((a, b) =>
      a.table.localeCompare(b.table),
    )) {
      const table = `${escapeIdentifier(definition.schema ?? "public")}.${escapeIdentifier(definition.table)}`;
      const key = tableKey(definition);
      for (const policy of expectedPolicies(definition)) {
        const existing = before.policies.find(
          (entry) => tableKey(entry) === key && entry.name === policy.name,
        );
        if (existing && matches(existing, policy.predicate)) continue;
        await owner.query(`DROP POLICY IF EXISTS ${escapeIdentifier(policy.name)} ON ${table}`);
        await owner.query(
          `CREATE POLICY ${escapeIdentifier(policy.name)} ON ${table} FOR ALL TO PUBLIC USING (${policy.predicate})`,
        );
      }
      if (!before.relations.find((relation) => tableKey(relation) === key)?.enabled)
        await owner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
    if (before.versionFunction) await owner.query("DROP FUNCTION public.app_rls_version()");
    const installed = report(await readCatalog(query), false);
    if (!installed.policyInstalled || !installed.policyEnabled || !installed.guardValid)
      throw new Error("The database policy installation did not match the registered definitions");
    commitAttempted = true;
    await owner.query("COMMIT");
    inTransaction = false;
    committed = true;
  } catch (error) {
    if (inTransaction && !commitAttempted) await owner.query("ROLLBACK").catch(() => undefined);
    failed = true;
    failure = error;
  } finally {
    try {
      await owner.end();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed && !committed) {
    if (commitAttempted)
      throw new Error("Database policy commit outcome is uncertain; policies may have committed", {
        cause: failure,
      });
    throw failure;
  }
  let status: RowSecurityPolicyStatus;
  try {
    const { prisma, pool } = createDb(urls.url, { poolMax: 1, rowSecurity: true });
    try {
      status = await describeRowSecurityPolicies(prisma);
      if (!status.connectionEnforced)
        throw new Error("The runtime connection did not verify the installed database policies");
    } finally {
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    }
  } catch (error) {
    throw new Error("Database policies were committed, but runtime verification failed", {
      cause: error,
    });
  }
  if (failed)
    throw new Error(
      "Database policies were committed, but the administrator connection did not close cleanly",
      { cause: failure },
    );
  return status;
}
