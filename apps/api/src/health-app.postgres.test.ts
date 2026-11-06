import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as adapters from "@rakazo/adapters";
import * as database from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ROW_SECURITY_POLICIES } from "../../../packages/db/src/row-security-policies.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

describePostgres("database readiness app wiring", () => {
  const options = (dataDir: string) => ({
    databaseUrl: process.env.DATABASE_URL!,
    dataDir,
    sandboxProvider: "fake",
    agentRuntime: "scripted",
    wakeupDriver: "memory",
  });

  it("owns one probe, uses it for requests and closes it during shutdown", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "readiness-app-"));
    const createProbe = database.createReadinessProbe;
    const owned: Array<{
      check: ReturnType<typeof vi.fn<() => Promise<void>>>;
      close: ReturnType<typeof vi.fn<() => Promise<void>>>;
    }> = [];
    const factory = vi.spyOn(database, "createReadinessProbe").mockImplementation((url) => {
      const probe = createProbe(url);
      const tracked = { check: vi.fn(probe.check), close: vi.fn(probe.close) };
      owned.push(tracked);
      return tracked;
    });
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      handles = await createApp(options(dataDir));
      expect(factory).toHaveBeenCalledExactlyOnceWith(process.env.DATABASE_URL);
      expect(owned[0]!.check).not.toHaveBeenCalled();
      expect((await handles.app.request("/health")).status).toBe(200);
      expect(owned[0]!.check).not.toHaveBeenCalled();
      for (let poll = 0; poll < 2; poll += 1) {
        const response = await handles.app.request("/ready");
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true, degraded: false });
      }
      expect(owned[0]!.check).toHaveBeenCalledTimes(2);
      await handles.stop();
      handles = undefined;
      expect(owned[0]!.close).toHaveBeenCalledTimes(1);
      await expect(owned[0]!.check()).rejects.toThrow();
    } finally {
      await handles?.stop();
      factory.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not open a hidden pool for an injected database", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "readiness-injected-"));
    const created = database.createDb(process.env.DATABASE_URL!);
    const factory = vi.spyOn(database, "createReadinessProbe");
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      handles = await createApp({ ...options(dataDir), prisma: created.prisma });
      expect((await handles.app.request("/ready")).status).toBe(200);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await handles?.stop();
      await created.prisma.$disconnect();
      await created.pool.end();
      factory.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("uses an explicit check with database injection %s", async (inject) => {
    const dataDir = await mkdtemp(join(tmpdir(), "readiness-override-"));
    const created = inject ? database.createDb(process.env.DATABASE_URL!) : undefined;
    const factory = vi.spyOn(database, "createReadinessProbe");
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(undefined);
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      handles = await createApp({
        ...options(dataDir),
        ...(created ? { prisma: created.prisma } : {}),
        readinessCheck: check,
      });
      const failed = await handles.app.request("/ready");
      expect(failed.status).toBe(503);
      await expect(failed.json()).resolves.toEqual({
        ok: false,
        degraded: false,
        database: "unreachable",
      });
      expect((await handles.app.request("/ready")).status).toBe(200);
      expect(check).toHaveBeenCalledTimes(2);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await handles?.stop();
      await created?.prisma.$disconnect();
      await created?.pool.end();
      factory.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describePostgres("protected database app composition", () => {
  const ownerUrl = process.env.DATABASE_URL!;
  const suffix = randomBytes(10).toString("hex");
  const login = `health_main_${suffix}`;
  const listenerLogin = `health_listener_${suffix}`;
  const ownedLogins = new Set<string>();
  const { Client, escapeIdentifier } = createRequire(
    new URL("../../../packages/db/package.json", import.meta.url),
  )("pg") as {
    Client: new (options: {
      connectionString: string;
    }) => {
      host: string;
      port: number;
      database?: string;
      user?: string;
      password?: unknown;
    };
    escapeIdentifier(value: string): string;
  };
  const managedPolicies = ROW_SECURITY_POLICIES.flatMap((definition) => [
    ...(definition.tenantPredicate ? [`${definition.table}_tenant`] : []).map((policy) => ({
      table: definition.table,
      policy,
    })),
    { table: definition.table, policy: `${definition.table}_system` },
  ]);
  let owner: ReturnType<typeof database.createDb> | undefined;
  let runtimeUrl: string;
  let listenerUrl: string;
  let grantRole: string;
  let groupOwned = false;
  let policiesOwned = false;
  let previousSecretStore: string | undefined;
  let secretStoreChanged = false;

  const options = (dataDir: string, mainUrl: string, realtimeUrl: string) => ({
    databaseUrl: mainUrl,
    realtimeDatabaseUrl: realtimeUrl,
    dataDir,
    sandboxProvider: "fake",
    agentRuntime: "scripted",
    wakeupDriver: "memory",
    cloudAgentProvider: "emulator",
    defaultProvider: "fake",
    defaultModel: "fake",
    deploymentModelConfigured: false,
    deploymentModelKey: undefined,
    deploymentModelHostCredentials: false,
    composioApiKey: undefined,
    integrationsCatalogUrl: undefined,
    pipedreamClientId: undefined,
    pipedreamClientSecret: undefined,
    pipedreamProjectId: undefined,
    smtpUrl: undefined,
    emailEmulator: false,
    stripeSecretKey: undefined,
    stripeWebhookSecret: undefined,
    stripePriceId: undefined,
    slackBotToken: undefined,
    slackSigningSecret: undefined,
    whatsappAccessToken: undefined,
    whatsappPhoneNumberId: undefined,
    whatsappAppSecret: undefined,
    whatsappVerifyToken: undefined,
    telegramBotToken: undefined,
    telegramWebhookSecret: undefined,
    larkAppId: undefined,
    larkAppSecret: undefined,
    teamChatBotId: undefined,
    sendblueApiKeyId: undefined,
    sendblueApiSecret: undefined,
    sendblueSigningSecret: undefined,
    cursorApiKey: undefined,
    e2bApiKey: undefined,
    daytonaApiKey: undefined,
    boxApiKey: undefined,
    updaterUrl: undefined,
    updaterToken: undefined,
    mcpStdioEnabled: false,
    passwordAuth: true,
    oidc: undefined,
  });

  async function legacyCatalog() {
    expect(
      (
        await owner!.pool.query(
          `SELECT p.polname FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
           JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`,
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await owner!.pool.query(
          `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity`,
        )
      ).rows,
    ).toEqual([]);
  }

  async function noAppConnections() {
    await vi.waitFor(
      async () => {
        expect(
          (
            await owner!.pool.query(
              `SELECT usename,application_name FROM pg_stat_activity
               WHERE datname=current_database() AND pid<>pg_backend_pid()
                 AND backend_type='client backend' AND (usename=ANY($1::text[])
                   OR application_name IN ('rakazo-api','rakazo-realtime','rakazo-realtime-readiness'))`,
              [[login, listenerLogin]],
            )
          ).rows,
        ).toEqual([]);
      },
      { timeout: 2_000, interval: 25 },
    );
  }

  beforeAll(async () => {
    const target = new Client({ connectionString: ownerUrl });
    if (
      !["127.0.0.1", "localhost", "::1"].includes(target.host) ||
      !Number.isInteger(target.port) ||
      target.port <= 1024 ||
      typeof target.database !== "string" ||
      !/^integration_(0|[1-9][0-9]*)$/.test(target.database) ||
      process.env.VERIFY_ROW_SECURITY_POLICIES !== "harness_isolated" ||
      process.env.VERIFY_ROW_SECURITY_POLICIES_DATABASE !== target.database
    )
      throw new Error("Protected app tests require the explicitly isolated policy harness");
    owner = database.createDb(ownerUrl);
    await legacyCatalog();
    expect(ROW_SECURITY_POLICIES).toHaveLength(84);
    grantRole = (
      await owner.pool.query<{ role: string }>(
        "SELECT 'coginebot_app_' || oid::text AS role FROM pg_database WHERE datname=current_database()",
      )
    ).rows[0]!.role;
    groupOwned = !(await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [grantRole]))
      .rowCount;
    const credentialUrl = (name: string) => {
      const url = new URL(ownerUrl);
      const password = randomBytes(24).toString("hex");
      if (password === target.password) throw new Error("The generated credential is not distinct");
      url.username = name;
      url.password = password;
      url.searchParams.delete("user");
      url.searchParams.delete("password");
      return url.toString();
    };
    runtimeUrl = credentialUrl(login);
    listenerUrl = credentialUrl(listenerLogin);
    for (const [name, url] of [
      [login, runtimeUrl],
      [listenerLogin, listenerUrl],
    ]) {
      expect(
        (await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name])).rows,
      ).toEqual([]);
      ownedLogins.add(name!);
      await database.provisionRuntimeRole(ownerUrl, url!);
    }
    policiesOwned = true;
    expect(await database.applyRowSecurityPolicies(ownerUrl, runtimeUrl)).toMatchObject({
      expectedTables: 84,
      connectionEnforced: true,
    });
    previousSecretStore = process.env.SECRET_STORE;
    process.env.SECRET_STORE = "encrypted";
    secretStoreChanged = true;
  }, 120_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    if (owner) {
      if (policiesOwned)
        await cleanup(async () => {
          for (const { table, policy } of managedPolicies)
            await owner!.pool.query(
              `DROP POLICY IF EXISTS ${escapeIdentifier(policy)} ON public.${escapeIdentifier(table)}`,
            );
          for (const { table } of ROW_SECURITY_POLICIES)
            await owner!.pool.query(
              `ALTER TABLE public.${escapeIdentifier(table)} DISABLE ROW LEVEL SECURITY`,
            );
          await legacyCatalog();
        });
      for (const name of ownedLogins)
        await cleanup(async () => {
          if (
            !(await owner!.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name])).rowCount
          )
            return;
          await owner!.pool.query(`DROP OWNED BY ${escapeIdentifier(name)}`);
          await owner!.pool.query(`DROP ROLE ${escapeIdentifier(name)}`);
        });
      for (const url of [runtimeUrl, listenerUrl].filter(Boolean))
        await cleanup(() =>
          owner!.pool.query(
            "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
            [database.rlsBypassKey(url)],
          ),
        );
      if (groupOwned)
        await cleanup(async () => {
          if (
            !(await owner!.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [grantRole]))
              .rowCount
          )
            return;
          const policies = await owner!.pool.query<{
            schema: string;
            table: string;
            policy: string;
          }>(
            `SELECT n.nspname AS schema,c.relname AS table,p.polname AS policy
             FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
             JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE p.polname=$1 AND $2::regrole::oid=ANY(p.polroles)`,
            [database.JOB_QUEUE_POLICY, grantRole],
          );
          for (const policy of policies.rows)
            await owner!.pool.query(
              `DROP POLICY ${escapeIdentifier(policy.policy)} ON ${escapeIdentifier(policy.schema)}.${escapeIdentifier(policy.table)}`,
            );
          await owner!.pool.query(`DROP OWNED BY ${escapeIdentifier(grantRole)}`);
          await owner!.pool.query(`DROP ROLE ${escapeIdentifier(grantRole)}`);
        });
      await cleanup(() => owner!.prisma.$disconnect());
      await cleanup(() => owner!.pool.end());
    }
    if (secretStoreChanged) {
      if (previousSecretStore === undefined) delete process.env.SECRET_STORE;
      else process.env.SECRET_STORE = previousSecretStore;
    }
    if (failures.length) throw new AggregateError(failures, "Protected app fixture cleanup failed");
  }, 60_000);

  it("starts the default app with protected main and listener connections and stops both", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "protected-app-"));
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      handles = await createApp(options(dataDir, runtimeUrl, listenerUrl));
      expect((await handles.app.request("/health")).status).toBe(200);
      const ready = await handles.app.request("/ready");
      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toEqual({ ok: true, degraded: false });
      await handles.stop();
      handles = undefined;
      await noAppConnections();
    } finally {
      await handles?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  async function refusesBeforeSecrets(mainUrl: string, realtimeUrl: string) {
    const dataDir = await mkdtemp(join(tmpdir(), "protected-app-refusal-"));
    const secrets = vi.spyOn(adapters, "createSecretStore");
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    let failure: unknown;
    try {
      try {
        handles = await createApp(options(dataDir, mainUrl, realtimeUrl));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "The service database role, policies, or system guard are not ready",
      );
      expect(secrets).not.toHaveBeenCalled();
      await noAppConnections();
    } finally {
      await handles?.stop();
      secrets.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  it("refuses a protected owner main connection before initializing secret storage", async () => {
    await refusesBeforeSecrets(ownerUrl, listenerUrl);
  }, 20_000);

  it("refuses an owner listener even when the main connection is protected", async () => {
    await refusesBeforeSecrets(runtimeUrl, ownerUrl);
  }, 20_000);

  it("refuses an owner Graphile job endpoint before side effects with an injected trusted database", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "protected-app-jobs-refusal-"));
    const trusted = database.createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
    const secrets = vi.spyOn(adapters, "createSecretStore");
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      expect(await database.verifyRuntimeDatabase(trusted.prisma)).toMatchObject({
        expectedTables: 84,
        connectionEnforced: true,
      });
      const settings = await owner!.prisma.deploymentSettings.findMany({ orderBy: { id: "asc" } });
      let failure: unknown;
      try {
        handles = await createApp({
          ...options(dataDir, ownerUrl, listenerUrl),
          prisma: trusted.prisma,
          wakeupDriver: "graphile",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "The service database role, policies, or system guard are not ready",
      );
      expect(secrets).not.toHaveBeenCalled();
      expect(await owner!.prisma.deploymentSettings.findMany({ orderBy: { id: "asc" } })).toEqual(
        settings,
      );
    } finally {
      await handles?.stop();
      secrets.mockRestore();
      await trusted.prisma.$disconnect();
      await trusted.pool.end();
      await rm(dataDir, { recursive: true, force: true });
    }
    await noAppConnections();
    expect(
      (
        await owner!.pool.query(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
           AND backend_type='client backend' AND application_name='rakazo-api-jobs'`,
        )
      ).rows,
    ).toEqual([]);
  }, 20_000);
});
