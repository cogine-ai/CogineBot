import { randomBytes, randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { NativeEventAuthorizationProof } from "@rakazo/contracts";
import { NativeConfigInputSchema, nativeEventResource } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import {
  ComputerLimitError,
  createDb,
  currentDbContext,
  ensureComputerRecord,
  restoreBotUnderComputerQuota,
  rlsBypassKey,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSecretPersistence } from "../secret-persistence.js";
import { EncryptedSecretStore } from "../secrets.js";
import type { NativeAuthorization, NativeOAuthAuthorities } from "./authorities.js";
import { NativeConfigStore } from "./config.js";
import { NativeNotionHookStore } from "./events/notion-hooks.js";
import { NativeSlackHookStore } from "./events/slack-hooks.js";
import { nativeEventConnectionSnapshot, replaceNativeRoutineTriggersTx } from "./events/store.js";
import { NativeOAuthStore } from "./oauth.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("mixed database authority on a restricted single-connection pool", () => {
  const suffix = randomBytes(10).toString("hex");
  const role = `mixed_context_${suffix}`;
  const password = randomBytes(24).toString("hex");
  const policy = `mixed_context_${suffix}`;
  const organizationId = randomUUID();
  const userId = randomUUID();
  const userIds = new Set<string>([userId]);
  const spaceId = randomUUID();
  const otherSpaceId = randomUUID();
  const tenant = { userId, spaceId };
  const otherTenant = { userId, spaceId: otherSpaceId };
  const tenantPredicate =
    "\"spaceId\" = NULLIF(current_setting('app.space_id', true), '') AND \"userId\" = NULLIF(current_setting('app.user_id', true), '')";
  // Controlled policies exercise mixed call sites; these do not activate the
  // full product policy set or change the deployment's runtime role.
  const policies = new Map([
    ["native_app_configs", "false"],
    ["native_notion_hooks", "false"],
    ["native_slack_hooks", "false"],
    ["native_slack_event_inbox", "false"],
    ["connections", tenantPredicate],
    ["native_oauth_grants", tenantPredicate],
    ["native_oauth_sessions", tenantPredicate],
    ["secrets", tenantPredicate],
    ["bots", tenantPredicate],
    ["routines", tenantPredicate],
    ["space_members", tenantPredicate],
    ["computers", "\"spaceId\" = NULLIF(current_setting('app.space_id', true), '')"],
    [
      "native_routine_triggers",
      'EXISTS (SELECT 1 FROM routines r WHERE r.id = native_routine_triggers."routineId")',
    ],
  ]);
  const previousRls = new Map<string, boolean>();
  const configIds = new Set<string>();
  let owner: ReturnType<typeof createDb>;
  let runtime: ReturnType<typeof createDb>;
  let runtimeUrl: string;
  let roleCreated = false;

  const settings = (tx: Pick<Prisma.TransactionClient, "$queryRaw">) => tx.$queryRaw<
    Array<{ pid: number; space: string; user: string; bypass: string; key: string }>
  >`SELECT pg_backend_pid() AS pid, current_setting('app.space_id', true) AS space,
    current_setting('app.user_id', true) AS "user", current_setting('app.rls_bypass', true) AS bypass,
    current_setting('app.rls_bypass_key', true) AS key`;

  beforeAll(async () => {
    owner = createDb(databaseUrl!);
    const target = new URL(databaseUrl!);
    target.username = role;
    target.password = password;
    target.searchParams.delete("user");
    target.searchParams.delete("password");
    runtimeUrl = target.toString();
    await owner.pool.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD '${password}'`,
    );
    roleCreated = true;
    const database = await owner.pool.query<{ name: string }>("SELECT current_database() AS name");
    await owner.pool.query(
      `GRANT CONNECT ON DATABASE "${database.rows[0]!.name.replaceAll('"', '""')}" TO "${role}"`,
    );
    await owner.pool.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await owner.pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
    );
    await owner.pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    await owner.pool.query(
      "INSERT INTO cogine_private.rls_bypass_keys (digest) VALUES (sha256(convert_to($1, 'UTF8'))) ON CONFLICT DO NOTHING",
      [rlsBypassKey(runtimeUrl)],
    );
    for (const [table, predicate] of policies) {
      const state = await owner.pool.query<{ relrowsecurity: boolean }>(
        "SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass",
        [table],
      );
      previousRls.set(table, state.rows[0]!.relrowsecurity);
      await owner.pool.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await owner.pool.query(
        `CREATE POLICY "${policy}" ON "${table}" USING ((SELECT app_rls_bypass()) OR (${predicate}))`,
      );
    }
    runtime = createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
    expect(
      await runtime.prisma.$queryRaw`
      SELECT session_user AS name, rolsuper, rolbypassrls,
        (SELECT relowner = (SELECT oid FROM pg_roles WHERE rolname = session_user)
          FROM pg_class WHERE oid = 'native_app_configs'::regclass) AS owns_config
      FROM pg_roles WHERE rolname = session_user
    `,
    ).toEqual([{ name: role, rolsuper: false, rolbypassrls: false, owns_config: false }]);
    await owner.prisma.user.create({
      data: { id: userId, name: "Synthetic mixed context", email: `${userId}@example.test` },
    });
    await owner.prisma.organization.create({
      data: {
        id: organizationId,
        name: "Synthetic mixed context",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await owner.prisma.member.create({
      data: { id: randomUUID(), organizationId, userId, role: "member", createdAt: new Date() },
    });
    for (const id of [spaceId, otherSpaceId]) {
      await owner.prisma.space.create({
        data: { id, organizationId, name: "Synthetic mixed context" },
      });
      await owner.prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          spaceId: id,
          userId,
          organizationId,
          role: "member",
          createdAt: new Date(),
        },
      });
    }
  });

  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(async () => runtime?.prisma.$disconnect());
    await cleanup(async () => runtime?.pool.end());
    if (owner) {
      for (const table of policies.keys()) {
        await cleanup(() => owner.pool.query(`DROP POLICY IF EXISTS "${policy}" ON "${table}"`));
        if (previousRls.get(table) === false)
          await cleanup(() =>
            owner.pool.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`),
          );
      }
      await cleanup(() => owner.prisma.organization.deleteMany({ where: { id: organizationId } }));
      await cleanup(() =>
        owner.prisma.nativeAppConfig.deleteMany({ where: { id: { in: [...configIds] } } }),
      );
      await cleanup(() => owner.prisma.user.deleteMany({ where: { id: { in: [...userIds] } } }));
      if (runtimeUrl)
        await cleanup(() =>
          owner.pool.query(
            "DELETE FROM cogine_private.rls_bypass_keys WHERE digest = sha256(convert_to($1, 'UTF8'))",
            [rlsBypassKey(runtimeUrl)],
          ),
        );
      if (roleCreated) {
        await cleanup(() => owner.pool.query(`DROP OWNED BY "${role}"`));
        await cleanup(() => owner.pool.query(`DROP ROLE "${role}"`));
      }
      await cleanup(() => owner.prisma.$disconnect());
      await cleanup(() => owner.pool.end());
    }
    if (failures.length) throw new AggregateError(failures, "Mixed context fixture cleanup failed");
  });

  async function nativeFixture() {
    const config = await owner.prisma.nativeAppConfig.create({
      data: {
        appId: "google-calendar",
        label: "Synthetic mixed config",
        ownership: "byo",
        credentialKind: "oauth",
        callbackUri: "https://bot.example.test/api/connectors/oauth/callback",
        config: {},
      },
    });
    configIds.add(config.id);
    const secret = await owner.prisma.secret.create({
      data: { ...tenant, kind: "native_grant", ciphertext: "synthetic-not-used-for-network" },
    });
    const grant = await owner.prisma.nativeOAuthGrant.create({
      data: {
        ...tenant,
        id: randomUUID(),
        configId: config.id,
        configRevision: config.revision,
        authority: "https://accounts.example.test",
        subject: "synthetic",
        secretId: secret.id,
        scopes: [],
      },
    });
    const authorizationRevision = `${grant.id}:${grant.authGeneration}`;
    const connection = await owner.prisma.connection.create({
      data: {
        ...tenant,
        connectorId: "native",
        provider: "google-calendar",
        providerRef: grant.id,
        displayName: "Synthetic",
        status: "connected",
        oauthGrantId: grant.id,
        nativeConfigId: config.id,
        nativeConfigRevision: config.revision,
        metadata: { authRevision: authorizationRevision },
      },
    });
    const bot = await owner.prisma.bot.create({
      data: { ...tenant, name: "Synthetic mixed Bot", color: "ink" },
    });
    const routine = await owner.prisma.routine.create({
      data: {
        ...tenant,
        botId: bot.id,
        name: "Original",
        prompt: "Synthetic",
        crons: ["0 9 * * *"],
      },
    });
    const spec = {
      kind: "calendar.event_changed",
      calendarId: "primary",
      target: { kind: "calendar" },
    } as const;
    const proof: NativeEventAuthorizationProof = {
      ...tenant,
      connectionId: connection.id,
      authorizationRevision,
      grantId: grant.id,
      authGeneration: grant.authGeneration,
      configId: config.id,
      configRevision: config.revision,
      appId: "google-calendar",
      resource: nativeEventResource(spec),
      spec,
    };
    return {
      config,
      connection,
      routine,
      prepared: [{ input: { connectionId: connection.id, spec }, proof }],
    };
  }

  it("reads exact native metadata and restores tenant authority inside the same transaction", async () => {
    const fixture = await nativeFixture();
    const foreign = await owner.prisma.bot.create({
      data: { ...otherTenant, name: "Other space Bot", color: "ink" },
    });
    expect(await owner.prisma.bot.count({ where: { id: foreign.id } })).toBe(1);
    await runAsTenant(tenant, async () => {
      expect(await runtime.prisma.nativeAppConfig.count()).toBe(0);
      expect(
        (await nativeEventConnectionSnapshot(runtime.prisma, tenant, fixture.connection.id))
          .configId,
      ).toBe(fixture.config.id);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...tenant });
      expect(await runtime.prisma.nativeAppConfig.count()).toBe(0);
      const rollback = new Error("Synthetic outer rollback");
      await expect(
        runtime.prisma.$transaction(async (tx) => {
          const before = await settings(tx);
          expect(before[0]).toMatchObject({ space: spaceId, user: userId, bypass: "off", key: "" });
          expect(
            (await nativeEventConnectionSnapshot(tx, tenant, fixture.connection.id)).configId,
          ).toBe(fixture.config.id);
          await tx.routine.update({
            where: { id: fixture.routine.id },
            data: { name: "Uncommitted" },
          });
          expect(
            await replaceNativeRoutineTriggersTx(tx, tenant, fixture.routine.id, fixture.prepared),
          ).toHaveLength(1);
          expect(await settings(tx)).toEqual(before);
          await expect(
            nativeEventConnectionSnapshot(tx, otherTenant, fixture.connection.id),
          ).rejects.toThrow("authorization is no longer available");
          const stale = fixture.prepared.map((item) => ({
            ...item,
            proof: { ...item.proof, configRevision: item.proof.configRevision + 1 },
          }));
          await expect(
            replaceNativeRoutineTriggersTx(tx, tenant, fixture.routine.id, stale),
          ).rejects.toThrow("authorization is no longer available");
          expect(await settings(tx)).toEqual(before);
          expect(currentDbContext()).toEqual({ kind: "tenant", ...tenant });
          expect(await tx.nativeAppConfig.count()).toBe(0);
          expect(await tx.bot.count({ where: { spaceId: otherSpaceId } })).toBe(0);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    });
    expect(
      (await owner.prisma.routine.findUniqueOrThrow({ where: { id: fixture.routine.id } })).name,
    ).toBe("Original");
    expect(
      await owner.prisma.nativeRoutineTrigger.count({ where: { routineId: fixture.routine.id } }),
    ).toBe(0);
    expect(runtime.pool.totalCount).toBe(1);
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("connects a tenant account through exact global config fences without bypassing membership or revision", async () => {
    const context: AdapterContext = {
      ...tenant,
      operationId: "mixed-native-connect",
      traceId: "mixed-native-connect",
      signal: new AbortController().signal,
    };
    const secrets = new EncryptedSecretStore("offline-mixed-native-key");
    const configs = new NativeConfigStore(runtime.prisma, secrets, "https://bot.example.test");
    let changeRevision = false;
    let configId = "";
    const verifyNotionToken = vi.fn(async () => {
      if (changeRevision)
        await owner.prisma.nativeAppConfig.update({
          where: { id: configId },
          data: { revision: { increment: 1 } },
        });
      return {
        authority: "notion",
        subject: "synthetic-mixed-notion",
        tenant: null,
        displayName: "Synthetic",
        context: { capabilities: ["read_content"] },
      };
    });
    const authorities = { verifyNotionToken } as unknown as NativeOAuthAuthorities;
    const oauth = new NativeOAuthStore(runtime.prisma, secrets, configs, authorities);
    await runAsTenant(tenant, async () => {
      const configured = await configs.save(
        {
          appId: "notion",
          ownership: "byo",
          credentialKind: "internal_token",
          label: "Synthetic Notion",
          enabled: true,
          scopes: [],
          capabilities: ["read_content"],
          knowledgeBaseIds: [],
        },
        context,
        true,
      );
      configId = configured.id;
      configIds.add(configId);
      const connected = await oauth.connectNotionToken(configId, "synthetic-notion-token", context);
      const authorization = await oauth.authorization(connected.connectionId, context);
      expect(authorization.grant.spaceId).toBe(spaceId);
      expect(authorization.config.id).toBe(configId);
      expect(authorization.auth.tokens.accessToken).toBe("synthetic-notion-token");
      expect(await runtime.prisma.nativeAppConfig.count()).toBe(0);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...tenant });
      const calls = verifyNotionToken.mock.calls.length;
      const outsider = { ...context, userId: randomUUID() };
      await expect(
        runAsTenant(outsider, () =>
          oauth.connectNotionToken(configId, "synthetic-notion-token", outsider),
        ),
      ).rejects.toThrow();
      expect(verifyNotionToken.mock.calls).toHaveLength(calls);
      const count = await runtime.prisma.connection.count();
      const secretCount = await runtime.prisma.secret.count();
      changeRevision = true;
      await expect(
        oauth.connectNotionToken(configId, "synthetic-stale-token", context),
      ).rejects.toThrow("authorization attempt is no longer available");
      expect(await runtime.prisma.connection.count()).toBe(count);
      expect(await runtime.prisma.secret.count()).toBe(secretCount);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...tenant });
    });
    expect(runtime.pool.totalCount).toBe(1);
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("manages deployment hooks from a tenant while retaining owner and setup fences", async () => {
    const context: AdapterContext = {
      ...tenant,
      operationId: "mixed-hook",
      traceId: "mixed-hook",
      signal: new AbortController().signal,
    };
    const secrets = new EncryptedSecretStore("offline-mixed-hook-key");
    const recordId = randomUUID();
    const material = await secrets.put("synthetic-hook-client-secret", context, { recordId });
    const notionConfig = await owner.prisma.nativeAppConfig.create({
      data: {
        appId: "notion",
        label: "Synthetic hook app",
        ownership: "byo",
        credentialKind: "oauth",
        callbackUri: "https://bot.example.test/api/connectors/oauth/callback",
        secretRecordId: recordId,
        ciphertext: material.ciphertext,
        config: {
          clientId: "synthetic-hook-client",
          scopes: [],
          capabilities: ["read_content"],
          knowledgeBaseIds: [],
        },
      },
    });
    configIds.add(notionConfig.id);
    const slackConfig = await owner.prisma.nativeAppConfig.create({
      data: {
        appId: "slack",
        label: "Synthetic Slack app",
        ownership: "byo",
        credentialKind: "bot_token",
        callbackUri: "https://bot.example.test/api/connectors/oauth/callback",
        config: {
          actor: "bot",
          scopes: ["channels:read", "channels:history"],
          capabilities: [],
          knowledgeBaseIds: [],
        },
      },
    });
    configIds.add(slackConfig.id);
    const notion = new NativeNotionHookStore(runtime.prisma, secrets, "https://bot.example.test");
    const slack = new NativeSlackHookStore(runtime.prisma, secrets, "https://bot.example.test");
    await runAsTenant(tenant, async () => {
      await expect(notion.begin({ configId: notionConfig.id }, context, false)).rejects.toThrow(
        "Deployment configuration",
      );
      const pending = await notion.begin({ configId: notionConfig.id }, context, true);
      expect(
        (await notion.status({ configId: notionConfig.id }, context, true)).hooks,
      ).toHaveLength(1);
      const token = "synthetic-notion-verification-token";
      expect(
        await runAsSystem("receive a synthetic pending hook challenge", () =>
          notion.captureChallenge(
            pending.id,
            Buffer.from(JSON.stringify({ verification_token: token })),
          ),
        ),
      ).toBe(true);
      const challenged = (await notion.status({ configId: notionConfig.id }, context, true))
        .hooks[0]!;
      const existing = {
        configId: notionConfig.id,
        id: challenged.id,
        expectedRevision: challenged.revision,
      };
      await expect(
        notion.reveal(existing, { ...context, userId: randomUUID() }, true),
      ).rejects.toThrow("setup owner");
      expect((await notion.reveal(existing, context, true)).verificationToken).toBe(token);
      const confirmed = await notion.confirm(
        { ...existing, integrationId: randomUUID(), verifiedInNotion: true },
        context,
        true,
      );
      expect(confirmed.enabled).toBe(true);
      expect(
        (await notion.disable({ ...existing, expectedRevision: confirmed.revision }, context, true))
          .enabled,
      ).toBe(false);
      const slackInput = {
        configId: slackConfig.id,
        appId: `A${randomUUID().replaceAll("-", "").toUpperCase()}`,
        signingSecret: "synthetic-slack-signing-secret",
        botEvents: ["app_mention"],
        botSubscriptionsConfirmed: true,
      };
      await expect(slack.save(slackInput, context, false)).rejects.toThrow(
        "Deployment configuration",
      );
      const saved = await slack.save(slackInput, context, true);
      expect((await slack.status({ configId: slackConfig.id }, context, true)).hooks).toHaveLength(
        1,
      );
      expect(
        (
          await slack.disable(
            { configId: saved.configId, id: saved.id, expectedRevision: saved.revision },
            context,
            true,
          )
        ).enabled,
      ).toBe(false);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...tenant });
      expect(await runtime.prisma.nativeNotionHook.count()).toBe(0);
      expect(await runtime.prisma.nativeSlackHook.count()).toBe(0);
    });
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("completes Figma refresh cleanup after the held transaction without losing global references", async () => {
    const context: AdapterContext = {
      ...tenant,
      operationId: "mixed-figma",
      traceId: "mixed-figma",
      signal: new AbortController().signal,
    };
    const secrets = new EncryptedSecretStore("offline-mixed-figma-key");
    const deleted = vi.spyOn(secrets, "delete");
    let rejectGrantWrite = false;
    let sharePrepared = false;
    let prepared: { id: string; ciphertext: string } | undefined;
    const originalPut = secrets.put.bind(secrets);
    vi.spyOn(secrets, "put").mockImplementation(async (...args) => {
      const material = await originalPut(...args);
      if (rejectGrantWrite) {
        prepared = material;
        if (sharePrepared) {
          const reference = await owner.prisma.nativeAppConfig.create({
            data: {
              appId: "notion",
              label: "Synthetic shared prepared reference",
              ownership: "byo",
              credentialKind: "internal_token",
              callbackUri: "https://bot.example.test/api/connectors/oauth/callback",
              ciphertext: material.ciphertext,
              secretRecordId: material.id,
              config: { scopes: [], capabilities: ["read_content"], knowledgeBaseIds: [] },
            },
          });
          configIds.add(reference.id);
        }
      }
      return material;
    });
    const failure = new Error("Synthetic Figma grant write rejected");
    const instrumented = runtime.prisma.$extends({
      query: {
        secret: {
          create({ args, query }) {
            if (rejectGrantWrite && args.data.kind === "native_grant") throw failure;
            return query(args);
          },
        },
      },
    });
    const database = withSecretPersistence(instrumented as typeof runtime.prisma, secrets);
    const configs = new NativeConfigStore(database, secrets, "https://bot.example.test");
    let tokenVersion = 0;
    const authorization = (): NativeAuthorization => ({
      tokens: {
        accessToken: `synthetic-figma-access-${++tokenVersion}`,
        refreshToken: `synthetic-figma-refresh-${tokenVersion}`,
      },
      identity: {
        authority: "https://figma.example.test",
        subject: "synthetic-figma-person",
        tenant: null,
        displayName: "Synthetic",
        context: {
          actorType: "user",
          credentialType: "oauth",
          scopeAuthority: "provider_enforced",
        },
      },
      scopes: ["current_user:read", "file_content:read"],
      expiresAt: new Date(Date.now() + 3600000),
    });
    const authorities = {
      authorizationUrl: (_config: unknown, state: string) =>
        `https://authorize.example.test/?state=${encodeURIComponent(state)}`,
      exchange: async () => authorization(),
      refresh: async () => authorization(),
    } as unknown as NativeOAuthAuthorities;
    const oauth = new NativeOAuthStore(database, secrets, configs, authorities);
    await runAsTenant(tenant, async () => {
      const config = await configs.save(
        NativeConfigInputSchema.parse({
          appId: "figma",
          ownership: "official",
          credentialKind: "oauth",
          actor: "user",
          label: "Synthetic mixed Figma",
          clientId: `synthetic-figma-client-${randomUUID()}`,
          clientSecret: "synthetic-figma-client-secret",
          scopes: ["current_user:read", "file_content:read"],
        }),
        context,
        true,
      );
      configIds.add(config.id);
      const connect = async () => {
        const start = await oauth.begin(config.id, context);
        const state = new URL(start.authorizationUrl).searchParams.get("state")!;
        // Browser callbacks enter through the existing verified global carrier.
        await runAsSystem("launch a synthetic authenticated native callback", () =>
          oauth.launch(state, userId, context.signal),
        );
        await runAsSystem("accept a synthetic authenticated native callback", () =>
          oauth.callback({ state, code: "synthetic-figma-code" }, context.signal, userId),
        );
        return owner.prisma.connection.findUniqueOrThrow({
          where: { id: start.connectionId },
          include: { oauthGrant: true },
        });
      };
      const first = await connect();
      await owner.prisma.nativeOAuthGrant.update({
        where: { id: first.oauthGrantId! },
        data: { accessExpiresAt: new Date(0) },
      });
      const refreshed = await oauth.authorization(first.id, context, true);
      expect(refreshed.grant.tokenVersion).toBe(2);
      const failRefresh = async (connectionId: string, shared: boolean) => {
        const connection = await owner.prisma.connection.findUniqueOrThrow({
          where: { id: connectionId },
        });
        await owner.prisma.nativeOAuthGrant.update({
          where: { id: connection.oauthGrantId! },
          data: { accessExpiresAt: new Date(0) },
        });
        rejectGrantWrite = true;
        sharePrepared = shared;
        prepared = undefined;
        try {
          await expect(oauth.authorization(connectionId, context, true)).rejects.toBe(failure);
        } finally {
          rejectGrantWrite = false;
        }
        expect(prepared).toBeDefined();
        expect(await owner.prisma.secret.count({ where: { id: prepared!.id } })).toBe(0);
        const retired = deleted.mock.calls.some(
          ([ciphertext]) => ciphertext === prepared!.ciphertext,
        );
        expect(retired).toBe(!shared);
        expect(currentDbContext()).toEqual({ kind: "tenant", ...tenant });
        expect(await runtime.prisma.nativeAppConfig.count()).toBe(0);
        expect(runtime.pool.waitingCount).toBe(0);
      };
      await failRefresh(first.id, true);
      const second = await connect();
      await failRefresh(second.id, false);
    });
    expect(runtime.pool.totalCount).toBe(1);
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("counts live computers across spaces without creating a nested transaction or leaking rows", async () => {
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "1");
    const active = await owner.prisma.bot.create({
      data: { ...tenant, name: "Live quota owner", color: "ink" },
    });
    const archived = await owner.prisma.bot.create({
      data: { ...otherTenant, name: "Archived quota target", color: "ink", archivedAt: new Date() },
    });
    for (const [scope, bot] of [
      [tenant, active],
      [otherTenant, archived],
    ] as const) {
      const computer = await owner.prisma.computer.create({
        data: {
          ...scope,
          scope: "dedicated",
          scopeKey: `bot:${bot.id}`,
          homeKey: bot.id,
          kind: "fake",
        },
      });
      await owner.prisma.bot.update({ where: { id: bot.id }, data: { computerId: computer.id } });
    }
    const archivedBot = await owner.prisma.bot.findUniqueOrThrow({ where: { id: archived.id } });
    await runAsTenant(otherTenant, () =>
      runtime.prisma.$transaction(async (tx) => {
        const before = await settings(tx);
        expect(before[0]).toMatchObject({
          space: otherSpaceId,
          user: userId,
          bypass: "off",
          key: "",
        });
        const count = await tx.computer.count();
        expect(count).toBe(1);
        await expect(
          ensureComputerRecord(tx, {
            ...otherTenant,
            mode: "dedicated",
            botId: randomUUID(),
            kind: "fake",
          }),
        ).rejects.toThrow(ComputerLimitError);
        expect(await settings(tx)).toEqual(before);
        await expect(
          restoreBotUnderComputerQuota(tx, {
            userId,
            botId: archived.id,
            computerId: archivedBot.computerId!,
          }),
        ).rejects.toThrow(ComputerLimitError);
        expect(await settings(tx)).toEqual(before);
        expect(currentDbContext()).toEqual({ kind: "tenant", ...otherTenant });
        expect(await tx.computer.count()).toBe(count);
      }),
    );
    expect(
      (await owner.prisma.bot.findUniqueOrThrow({ where: { id: archived.id } })).archivedAt,
    ).not.toBeNull();
    await owner.prisma.bot.update({ where: { id: active.id }, data: { archivedAt: new Date() } });
    const foreignUser = randomUUID();
    userIds.add(foreignUser);
    await owner.prisma.user.create({
      data: {
        id: foreignUser,
        name: "Synthetic other quota owner",
        email: `${foreignUser}@example.test`,
      },
    });
    await owner.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId,
        userId: foreignUser,
        role: "member",
        createdAt: new Date(),
      },
    });
    await owner.prisma.spaceMember.create({
      data: {
        id: randomUUID(),
        organizationId,
        spaceId,
        userId: foreignUser,
        role: "member",
        createdAt: new Date(),
      },
    });
    const foreignBot = await owner.prisma.bot.create({
      data: { userId: foreignUser, spaceId, name: "Other user's live Computer", color: "ink" },
    });
    const foreignComputer = await owner.prisma.computer.create({
      data: {
        userId: foreignUser,
        spaceId,
        scope: "dedicated",
        scopeKey: `bot:${foreignBot.id}`,
        homeKey: foreignBot.id,
        kind: "fake",
      },
    });
    await owner.prisma.bot.update({
      where: { id: foreignBot.id },
      data: { computerId: foreignComputer.id },
    });
    await runAsTenant(otherTenant, () =>
      runtime.prisma.$transaction(async (tx) => {
        const before = await settings(tx);
        await restoreBotUnderComputerQuota(tx, {
          userId,
          botId: archived.id,
          computerId: archivedBot.computerId!,
        });
        expect(await settings(tx)).toEqual(before);
        expect(await tx.bot.findUniqueOrThrow({ where: { id: archived.id } })).toMatchObject({
          archivedAt: null,
        });
      }),
    );
    expect(runtime.pool.waitingCount).toBe(0);
  });
});
