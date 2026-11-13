import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { routineJobKey, routineWakeupJob, runContinueJob, runJobKey } from "@rakazo/adapter-kit";
import * as adapters from "@rakazo/adapters";
import type {
  Actor,
  AppBootstrap,
  Bot,
  ComputerStatus,
  Routine,
  RoutineHistory,
  SpaceNavigation,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { PAGE_RUNTIME_PATH } from "@rakazo/core";
import * as database from "@rakazo/db";
import { ROW_SECURITY_POLICIES } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import {
  expectExactPolicyCatalog,
  expectPhysicalPolicyTables,
  expectRegisteredPolicyTables,
  schemaPolicyTables,
} from "../../../packages/testkit/src/row-security-expectations.js";
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

  it("serves the mounted Page runtime to an anonymous opaque viewer", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "page-runtime-app-"));
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      handles = await createApp(options(dataDir));
      const response = await handles.app.request(PAGE_RUNTIME_PATH, {
        headers: { origin: "null" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toContain("RakazoPage");
      const etag = response.headers.get("etag");
      expect(etag).not.toBeNull();
      const cached = await handles.app.request(PAGE_RUNTIME_PATH, {
        headers: { origin: "null", "if-none-match": `W/${etag}` },
      });
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe("");
      expect((await handles.app.request("/api/v1/assets/private.js")).status).toBe(404);
    } finally {
      await handles?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each(["none", " ", " none "])(
    "loads Bot threads with the computer provider set to %j",
    async (provider) => {
      const dataDir = await mkdtemp(join(tmpdir(), "no-computer-app-"));
      vi.stubEnv("SANDBOX_PROVIDER", provider);
      let handles: Awaited<ReturnType<typeof createApp>> | undefined;
      try {
        const origin = "http://127.0.0.1:5173";
        handles = await createApp({
          ...options(dataDir),
          authUrl: origin,
          webOrigin: origin,
          sandboxProvider: "none",
        });
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            name: "Computer-free User",
            email: `no-computer-${randomUUID()}@example.test`,
            password: "password12",
          }),
        });
        expect(signup.status).toBe(200);
        const app = handles.app;
        const cookie = sessionCookieHeader(signup);
        const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
          const response = await app.request(`/rpc/${procedure}`, {
            method: "POST",
            headers: { origin, cookie, "content-type": "application/json" },
            body: JSON.stringify({ json: input }),
          });
          const result = (await response.json()) as { json: T };
          expect(response.status, JSON.stringify(result)).toBe(200);
          return result.json;
        };
        const bot = await rpc<Bot>("bots/create", { name: "No Computer" });
        const expected = {
          botId: bot.id,
          kind: "none",
          providerDisabled: true,
          state: "stopped",
          canUpdate: false,
          terminalAvailable: false,
          screenAvailable: false,
        };
        const snapshot = { botId: bot.id, computer: expected };
        expect(await rpc<ThreadSnapshot>("threads/get", { botId: bot.id })).toMatchObject(snapshot);
        expect(await rpc<AppBootstrap>("bootstrap", { botId: bot.id })).toMatchObject({
          thread: snapshot,
        });
        expect(await rpc<ComputerStatus>("computer/status", { botId: bot.id })).toMatchObject(
          expected,
        );
      } finally {
        vi.unstubAllEnvs();
        await handles?.stop();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

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
      schema: definition.schema ?? "public",
      table: definition.table,
      policy,
    })),
    {
      schema: definition.schema ?? "public",
      table: definition.table,
      policy: `${definition.table}_system`,
    },
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
           JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','cogine_pages')`,
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await owner!.pool.query(
          `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname IN ('public','cogine_pages') AND c.relkind IN ('r','p') AND c.relrowsecurity`,
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
    await adapters.migrateJobQueue(ownerUrl);
    expectRegisteredPolicyTables(ROW_SECURITY_POLICIES);
    await expectPhysicalPolicyTables((sql) => owner!.pool.query(sql));
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
      expectedTables: schemaPolicyTables.length,
      connectionEnforced: true,
    });
    previousSecretStore = process.env.SECRET_STORE;
    expectExactPolicyCatalog(
      (
        await owner!.pool.query(
          "SELECT n.nspname AS schema,c.relname AS table,p.polname AS policy FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','cogine_pages')",
        )
      ).rows,
    );

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
          for (const { schema, table, policy } of managedPolicies)
            await owner!.pool.query(
              `DROP POLICY IF EXISTS ${escapeIdentifier(policy)} ON ${escapeIdentifier(schema)}.${escapeIdentifier(table)}`,
            );
          for (const { schema = "public", table } of ROW_SECURITY_POLICIES)
            await owner!.pool.query(
              `ALTER TABLE ${escapeIdentifier(schema)}.${escapeIdentifier(table)} DISABLE ROW LEVEL SECURITY`,
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

  it.each(["shared", "separate"] as const)(
    "starts the default app with protected main and %s listener credentials and stops both",
    async (connection) => {
      const dataDir = await mkdtemp(join(tmpdir(), "protected-app-"));
      let handles: Awaited<ReturnType<typeof createApp>> | undefined;
      try {
        handles = await createApp(
          options(dataDir, runtimeUrl, connection === "shared" ? runtimeUrl : listenerUrl),
        );
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
    },
    30_000,
  );

  class JourneyRuntime implements AgentRuntime {
    failing = false;
    writeScratchpad = false;
    createSpaceName?: string;
    readonly spaceContextsAfterTool: Array<ReturnType<typeof database.currentDbContext>> = [];
    readonly calls: Array<{
      runId: string;
      context: Partial<AdapterContext> | undefined;
      databaseContext: ReturnType<typeof database.currentDbContext>;
    }> = [];

    describe() {
      return {
        id: "protected-journey-runtime",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { streaming: true, compaction: false, tools: true, scripted: true },
      };
    }

    async abort(): Promise<void> {}

    async *run(
      request: AgentRunRequest,
      context?: Partial<AdapterContext>,
    ): AsyncIterable<AgentRuntimeEvent> {
      this.calls.push({
        runId: request.runId,
        context,
        databaseContext: database.currentDbContext(),
      });
      if (this.failing) throw new Error("Offline protected journey failure");
      if (this.createSpaceName) {
        yield {
          type: "tool",
          name: "create_space",
          args: { name: this.createSpaceName },
          executionId: `protected-create-space:${request.runId}`,
        };
        this.spaceContextsAfterTool.push(database.currentDbContext());
      }
      if (this.writeScratchpad) {
        yield {
          type: "tool",
          name: "scratchpad_add",
          args: { title: `Protected item ${request.runId}` },
          executionId: `protected-scratchpad:${request.runId}`,
        };
      }
      yield { type: "text", text: `Protected result ${request.runId}.` };
      yield { type: "done" };
    }
  }

  async function openJourney() {
    expect(database.drainUnscopedDatabaseAccess()).toEqual([]);
    const dataDir = await mkdtemp(join(tmpdir(), "protected-journey-"));
    const runtime = new JourneyRuntime();
    const jobsDatabase = database.createDb(runtimeUrl, {
      poolMax: 8,
      rowSecurity: true,
      applicationName: "protected-journey-jobs",
    });
    const realtime = new adapters.PostgresRealtimeFanout({
      connectionString: listenerUrl,
      publisher: jobsDatabase.pool,
    });
    const secrets = new adapters.EncryptedSecretStore("synthetic-protected-journey-key");
    const publisher = new adapters.GraphileJobPublisher(jobsDatabase.pool);
    const host = new adapters.GraphileJobWorkerHost(jobsDatabase.pool, {
      concurrency: 2,
      pollInterval: 25,
    });
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    const close = async () => {
      const failures: unknown[] = [];
      for (const work of [
        () => host.stop(),
        () => publisher.close(),
        () => handles?.stop(),
        () => realtime.close(),
        () => jobsDatabase.prisma.$disconnect(),
        () => jobsDatabase.pool.end(),
        () => rm(dataDir, { recursive: true, force: true }),
      ]) {
        try {
          await work();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, "Protected journey cleanup failed");
      await noAppConnections();
      expect(database.drainUnscopedDatabaseAccess()).toEqual([]);
    };
    try {
      expect(await database.verifyRuntimeDatabase(jobsDatabase.prisma)).toMatchObject({
        expectedTables: schemaPolicyTables.length,
        connectionEnforced: true,
      });
      await owner!.prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          signupsEnabled: true,
          signupAllowlist: "",
          signupPolicyInitialized: true,
        },
        update: { signupsEnabled: true, signupAllowlist: "", signupPolicyInitialized: true },
      });
      handles = await createApp({
        ...options(dataDir, runtimeUrl, listenerUrl),
        signupsEnabled: "true",
        wakeupDriver: "graphile",
        runtime,
        sandbox: new adapters.FakeSandboxProvider(),
        secretStore: secrets,
      });
      const app = handles;
      await database.runAsSystem("start the protected journey worker", () =>
        host.start(
          adapters.createBackgroundJobHandlers({
            prisma: jobsDatabase.prisma,
            executor: app.executor,
            sandbox: app.sandbox,
            home: new adapters.LocalAgentHomeStore(dataDir),
            jobs: app.jobs,
            events: database.createThreadEvents(jobsDatabase.prisma, realtime),
            workerId: "protected-journey-worker",
            runtime,
            secretStore: secrets,
            memoryProviders: { resolve: async () => null },
          }),
        ),
      );
      const raw = (cookie: string, procedure: string, input: unknown = {}, spaceId?: string) =>
        app.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1:5173",
            cookie,
            ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
          },
          body: JSON.stringify({ json: input }),
        });
      const rpc = async <T>(cookie: string, procedure: string, input: unknown = {}) => {
        const response = await raw(cookie, procedure, input);
        expect(response.status).toBe(200);
        return ((await response.json()) as { json: T }).json;
      };
      const account = async () => {
        const response = await app.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1:5173",
          },
          body: JSON.stringify({
            email: `protected-journey-${randomUUID()}@example.test`,
            password: "password12",
            name: "Protected journey",
          }),
        });
        expect(response.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(response);
        const actor = await rpc<Actor>(cookie, "me");
        const bot = await rpc<Bot>(cookie, "bots/create", { name: "Protected journey" });
        await vi.waitFor(
          async () => {
            expect(
              await owner!.prisma.run.count({
                where: { botId: bot.id, status: { notIn: ["completed", "cancelled", "failed"] } },
              }),
            ).toBe(0);
          },
          { timeout: 15_000, interval: 25 },
        );
        const thread = await owner!.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
        return { cookie, actor, bot, thread };
      };
      const drained = (key: string, allowFuture = false) =>
        vi.waitFor(
          async () => {
            const pending = await owner!.pool.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM graphile_worker._private_jobs
               WHERE key=$1 AND (NOT $2::boolean OR locked_at IS NOT NULL OR run_at <= now())`,
              [key, allowFuture],
            );
            expect(pending.rows).toEqual([{ count: 0 }]);
          },
          { timeout: 15_000, interval: 25 },
        );
      const state = async (runId: string) => ({
        run: await owner!.prisma.run.findUniqueOrThrow({
          where: { id: runId },
          select: {
            id: true,
            userId: true,
            spaceId: true,
            botId: true,
            threadId: true,
            taskId: true,
            routineId: true,
            status: true,
          },
        }),
        messages: await owner!.prisma.message.findMany({
          where: { runId },
          orderBy: { id: "asc" },
        }),
        events: await owner!.prisma.event.findMany({
          where: { runId },
          orderBy: { seq: "asc" },
        }),
        effects: await owner!.prisma.externalEffect.findMany({
          where: { runId },
          orderBy: { id: "asc" },
        }),
      });
      return { app, runtime, jobsDatabase, publisher, raw, rpc, account, drained, state, close };
    } catch (error) {
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Protected journey setup failed");
      }
      throw error;
    }
  }

  it("completes a Graphile run as its stored owner and ignores conflicting delivery metadata", async () => {
    const journey = await openJourney();
    try {
      const first = await journey.account();
      const second = await journey.account();
      const runId = randomUUID();
      const taskId = randomUUID();
      const identity = {
        userId: second.actor.userId,
        spaceId: second.actor.spaceId,
        botId: second.bot.id,
        threadId: second.thread.id,
      };
      await owner!.prisma.task.create({
        data: {
          id: taskId,
          ...identity,
          prompt: "Complete the protected queue work.",
          status: "queued",
        },
      });
      await owner!.prisma.run.create({
        data: { id: runId, ...identity, taskId, trigger: "user", status: "queued" },
      });
      const beforeForeign = await owner!.prisma.run.count({ where: { botId: second.bot.id } });
      const rejected = await journey.raw(first.cookie, "threads/send", {
        botId: second.bot.id,
        text: "Foreign work must not run.",
        clientNonce: randomUUID(),
      });
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(await owner!.prisma.run.count({ where: { botId: second.bot.id } })).toBe(
        beforeForeign,
      );
      expect((await journey.raw("", "threads/get", { botId: second.bot.id })).status).toBe(401);
      expect((await journey.raw(first.cookie, "me", {}, second.actor.spaceId)).status).toBe(403);

      journey.runtime.writeScratchpad = true;
      const delivery = runContinueJob(runId);
      Object.assign(delivery.payload, {
        userId: first.actor.userId,
        spaceId: first.actor.spaceId,
        botId: first.bot.id,
      });
      await database.runAsTenant(first.actor, () => journey.publisher.enqueue(delivery));
      expect(database.currentDbContext()).toBeUndefined();
      await vi.waitFor(
        async () => {
          expect((await journey.state(runId)).run.status).toBe("completed");
        },
        { timeout: 15_000, interval: 25 },
      );
      await journey.drained(runJobKey(runId));
      const completed = await journey.state(runId);
      expect(completed.run).toMatchObject(identity);
      expect(completed.messages).toHaveLength(1);
      expect(completed.messages[0]).toMatchObject({ threadId: second.thread.id, role: "bot" });
      expect(JSON.stringify(completed.messages[0]!.blocks)).toContain(`Protected result ${runId}.`);
      expect(completed.events.filter((event) => event.type === "run.completed")).toHaveLength(1);
      expect(completed.effects).toEqual([
        expect.objectContaining({ kind: "scratchpad_add", status: "completed" }),
      ]);
      const items = await owner!.prisma.scratchpadItem.findMany({
        where: { botId: second.bot.id, title: `Protected item ${runId}` },
      });
      expect(items).toEqual([
        expect.objectContaining({
          userId: second.actor.userId,
          spaceId: second.actor.spaceId,
          botId: second.bot.id,
        }),
      ]);
      expect(await owner!.prisma.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        ...identity,
        status: "completed",
      });
      expect(journey.runtime.calls.filter((call) => call.runId === runId)).toEqual([
        expect.objectContaining({
          context: expect.objectContaining({
            userId: identity.userId,
            spaceId: identity.spaceId,
            botId: identity.botId,
            runId,
          }),
          databaseContext: { kind: "tenant", userId: identity.userId, spaceId: identity.spaceId },
        }),
      ]);
      const snapshot = await journey.rpc<ThreadSnapshot>(second.cookie, "threads/get", {
        botId: second.bot.id,
      });
      expect(snapshot.messages.find((message) => message.runId === runId)?.id).toBe(
        completed.messages[0]!.id,
      );
      expect(
        await owner!.prisma.message.count({ where: { runId, threadId: first.thread.id } }),
      ).toBe(0);

      await journey.publisher.enqueue(runContinueJob(runId));
      await journey.drained(runJobKey(runId));
      expect(journey.runtime.calls.filter((call) => call.runId === runId)).toHaveLength(1);
      expect(await journey.state(runId)).toEqual(completed);
      expect(
        await owner!.prisma.scratchpadItem.findMany({
          where: { botId: second.bot.id, title: `Protected item ${runId}` },
        }),
      ).toEqual(items);
    } finally {
      await journey.close();
    }
  }, 60_000);

  it("creates a sibling Space only after approval and keeps its completed delivery idempotent", async () => {
    const journey = await openJourney();
    try {
      const first = await journey.account();
      const second = await journey.account();
      const name = `Protected sibling ${randomUUID()}`;
      const before = await journey.rpc<SpaceNavigation>(first.cookie, "spaces/list");
      const originalSpace = await owner!.prisma.space.findUniqueOrThrow({
        where: { id: first.actor.spaceId },
      });
      journey.runtime.createSpaceName = name;
      const { runId } = await journey.rpc<{ runId: string }>(first.cookie, "threads/send", {
        botId: first.bot.id,
        text: `Create a space named ${name}`,
        clientNonce: randomUUID(),
      });
      await vi.waitFor(
        async () => {
          expect((await journey.state(runId)).run.status).toBe("waiting_input");
        },
        { timeout: 15_000, interval: 25 },
      );
      await journey.drained(runJobKey(runId));
      const paused = await journey.state(runId);
      expect(paused.effects).toEqual([
        expect.objectContaining({ kind: "create_space", status: "intended", request: { name } }),
      ]);
      const snapshot = await journey.rpc<ThreadSnapshot>(first.cookie, "threads/get", {
        botId: first.bot.id,
      });
      const approval = snapshot.messages.find((message) =>
        message.blocks.some(
          (block) => block.kind === "ask" && block.approvalEffectId === paused.effects[0]!.id,
        ),
      );
      expect(approval).toBeDefined();
      expect(approval!.blocks).toContainEqual(
        expect.objectContaining({
          kind: "ask",
          status: "pending",
          actions: [
            { id: "allow", label: "Create space", outcome: "created" },
            { id: "deny", label: "Cancel", outcome: "cancelled" },
          ],
        }),
      );
      const answer = {
        botId: first.bot.id,
        runId,
        messageId: approval!.id,
        answer: "allow",
      };
      const denied = await journey.raw(second.cookie, "threads/answer", answer);
      expect(denied.status).toBeGreaterThanOrEqual(400);
      expect((await journey.state(runId)).run.status).toBe("waiting_input");
      expect(await owner!.prisma.space.count({ where: { name } })).toBe(0);
      const awaitingApproval = await journey.rpc<SpaceNavigation>(first.cookie, "spaces/list");
      expect(awaitingApproval.spaces.map((space) => space.id)).toEqual(
        before.spaces.map((space) => space.id),
      );

      await journey.rpc(first.cookie, "threads/answer", answer);
      await vi.waitFor(
        async () => {
          expect((await journey.state(runId)).run.status).toBe("completed");
        },
        { timeout: 15_000, interval: 25 },
      );
      await journey.drained(runJobKey(runId));
      const completed = await journey.state(runId);
      const spaces = await owner!.prisma.space.findMany({ where: { name } });
      expect(spaces).toEqual([
        expect.objectContaining({
          createdByUserId: first.actor.userId,
          organizationId: originalSpace.organizationId,
        }),
      ]);
      const space = spaces[0]!;
      expect(completed.effects).toEqual([
        expect.objectContaining({
          id: paused.effects[0]!.id,
          kind: "create_space",
          status: "completed",
          result: { ok: true, spaceId: space.id, name },
        }),
      ]);
      expect(completed.events.filter((event) => event.type === "run.completed")).toHaveLength(1);
      expect(await owner!.prisma.spaceMember.findMany({ where: { spaceId: space.id } })).toEqual([
        expect.objectContaining({ userId: first.actor.userId, role: "owner" }),
      ]);
      expect(await owner!.prisma.memoryDocument.findMany({ where: { spaceId: space.id } })).toEqual(
        [
          expect.objectContaining({
            userId: first.actor.userId,
            scope: "user",
            path: "MEMORY.md",
            content: "# Space memory\n\n",
          }),
        ],
      );
      expect(
        await owner!.prisma.notificationPreference.findMany({ where: { spaceId: space.id } }),
      ).toEqual([expect.objectContaining({ userId: first.actor.userId })]);
      const navigation = await journey.rpc<SpaceNavigation>(first.cookie, "spaces/list");
      expect(navigation.current.id).toBe(first.actor.spaceId);
      expect(navigation.spaces).toHaveLength(before.spaces.length + 1);
      expect(navigation.spaces).toContainEqual(expect.objectContaining({ id: space.id, name }));
      const selected = await journey.raw(first.cookie, "me", {}, space.id);
      expect(selected.status).toBe(200);
      expect(((await selected.json()) as { json: Actor }).json.spaceId).toBe(space.id);
      expect((await journey.raw(second.cookie, "me", {}, space.id)).status).toBe(403);
      expect(
        await journey.rpc<ThreadSnapshot>(first.cookie, "threads/get", { botId: first.bot.id }),
      ).toMatchObject({ threadId: first.thread.id });
      const calls = journey.runtime.calls.filter((call) => call.runId === runId);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.databaseContext).toEqual({
          kind: "tenant",
          userId: first.actor.userId,
          spaceId: first.actor.spaceId,
        });
      }
      expect(journey.runtime.spaceContextsAfterTool).toEqual([
        { kind: "tenant", userId: first.actor.userId, spaceId: first.actor.spaceId },
      ]);
      expect(database.currentDbContext()).toBeUndefined();

      await journey.publisher.enqueue(runContinueJob(runId));
      await journey.drained(runJobKey(runId));
      expect(await journey.state(runId)).toEqual(completed);
      expect(journey.runtime.calls.filter((call) => call.runId === runId)).toEqual(calls);
      expect(await owner!.prisma.space.findMany({ where: { name } })).toEqual(spaces);
    } finally {
      await journey.close();
    }
  }, 60_000);

  it.each(["result", "failure"] as const)(
    "settles a Graphile Routine %s once without leaking its tenant",
    async (mode) => {
      const journey = await openJourney();
      try {
        const first = await journey.account();
        const second = await journey.account();
        const anchor = Date.now();
        const nextDailyTime = new Date(anchor + 6 * 60 * 60 * 1_000);
        const routine = await journey.rpc<Routine>(second.cookie, "routines/create", {
          botId: second.bot.id,
          name: "Protected scheduled work",
          prompt: "Complete a protected scheduled result.",
          crons: [`${nextDailyTime.getUTCMinutes()} ${nextDailyTime.getUTCHours()} * * *`],
          timezone: "UTC",
          active: false,
        });
        const scheduledAt = new Date(anchor - 1_000);
        await owner!.prisma.routine.update({
          where: { id: routine.id },
          data: { active: true, nextRunAt: scheduledAt },
        });
        journey.runtime.failing = mode === "failure";
        await database.runAsTenant(first.actor, () =>
          journey.publisher.enqueue(routineWakeupJob(routine.id, scheduledAt)),
        );
        expect(database.currentDbContext()).toBeUndefined();
        await vi.waitFor(
          async () => {
            const rows = await owner!.prisma.run.findMany({ where: { routineId: routine.id } });
            expect(rows).toHaveLength(1);
            expect(rows[0]!.status).toBe(mode === "result" ? "completed" : "failed");
          },
          { timeout: 15_000, interval: 25 },
        );
        await journey.drained(routineJobKey(routine.id), true);
        const run = await owner!.prisma.run.findFirstOrThrow({ where: { routineId: routine.id } });
        const settled = await journey.state(run.id);
        expect(run).toMatchObject({
          userId: second.actor.userId,
          spaceId: second.actor.spaceId,
          botId: second.bot.id,
          threadId: second.thread.id,
          trigger: "routine",
        });
        expect(settled.events.some((event) => event.type === "routine.fired")).toBe(true);
        expect(
          settled.events.filter(
            (event) => event.type === (mode === "result" ? "run.completed" : "run.failed"),
          ),
        ).toHaveLength(1);
        expect(settled.messages).toHaveLength(mode === "result" ? 1 : 0);
        expect(journey.runtime.calls.filter((call) => call.runId === run.id)).toEqual([
          expect.objectContaining({
            context: expect.objectContaining({
              userId: second.actor.userId,
              spaceId: second.actor.spaceId,
              botId: second.bot.id,
              runId: run.id,
            }),
            databaseContext: {
              kind: "tenant",
              userId: second.actor.userId,
              spaceId: second.actor.spaceId,
            },
          }),
        ]);
        const history = await journey.rpc<RoutineHistory>(second.cookie, "routines/history", {
          routineId: routine.id,
        });
        expect(history.runs).toEqual([expect.objectContaining({ id: run.id, status: run.status })]);
        const snapshot = await journey.rpc<ThreadSnapshot>(second.cookie, "threads/get", {
          botId: second.bot.id,
        });
        expect(snapshot.messages.filter((message) => message.runId === run.id)).toHaveLength(
          mode === "result" ? 1 : 0,
        );

        // A repeated old delivery must not replace the next scheduled queue entry.
        const repeated = {
          ...routineWakeupJob(routine.id, scheduledAt),
          replaceKey: `protected-routine-repeat:${randomUUID()}`,
        };
        await journey.publisher.enqueue(repeated);
        await journey.drained(repeated.replaceKey);
        expect(await owner!.prisma.run.count({ where: { routineId: routine.id } })).toBe(1);
        expect(journey.runtime.calls.filter((call) => call.runId === run.id)).toHaveLength(1);
        expect(await journey.state(run.id)).toEqual(settled);
      } finally {
        await journey.close();
      }
    },
    60_000,
  );

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
        expectedTables: schemaPolicyTables.length,
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
