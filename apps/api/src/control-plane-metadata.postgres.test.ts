import { randomBytes } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  applyRowSecurityPolicies,
  botCreationComputerKind,
  createDb,
  createRepos,
  currentDbContext,
  describeRowSecurityPolicies,
  provisionRuntimeRole,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "../../../packages/adapters/src/executor.js";
import {
  compactHistory,
  MAX_COMPACTED_SUMMARY_CHARS,
} from "../../../packages/adapters/src/history-compaction.js";
import { createRunSandbox } from "../../../packages/adapters/src/host-aware-sandbox.js";
import {
  IntegrationProviderSettings,
  prepareManagedConnectorForTransaction,
} from "../../../packages/adapters/src/integration-provider-settings.js";
import { SpaceMemoryProviderResolver } from "../../../packages/adapters/src/memory-provider-factory.js";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets.js";
import { createOpenApiImportService } from "./openapi-import.js";
import { ModelTeamChatEngagementJudge } from "./team-chat-judge.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres =
  process.env.VERIFY_DATABASE === "1" &&
  process.env.VERIFY_ROW_SECURITY_POLICIES === "harness_isolated" &&
  databaseUrl
    ? describe.sequential
    : describe.skip;

postgres("control-plane metadata with complete row policies", () => {
  const suffix = randomBytes(10).toString("hex");
  const id = (name: string) => `metadata-${name}-${suffix}`;
  const role = `metadata_runtime_${suffix}`;
  const userA = id("owner");
  const userB = id("member");
  const spaceA = id("space-a");
  const spaceB = id("space-b");
  let owner: ReturnType<typeof createDb>;
  let runtime: ReturnType<typeof createDb>;
  let groupRole: string;
  const tenant = (userId = userA, spaceId = spaceA) => ({ userId, spaceId });
  const actor = (userId = userA, spaceId = spaceA) => ({
    ...tenant(userId, spaceId),
    email: "synthetic@example.test",
    isDeploymentOwner: userId === userA,
  });
  const inTenant = <T>(fn: () => Promise<T>, userId = userA, spaceId = spaceA) =>
    runAsTenant(tenant(userId, spaceId), fn);
  const assertTenant = (userId = userA, spaceId = spaceA) =>
    expect(currentDbContext()).toEqual({ kind: "tenant", ...tenant(userId, spaceId) });
  const context = (userId = userA): AdapterContext => ({
    operationId: "metadata-fixture",
    traceId: "metadata-fixture",
    spaceId: spaceA,
    userId,
    signal: new AbortController().signal,
  });
  const connectionState = (tx: Prisma.TransactionClient) =>
    tx.$queryRaw<Array<{ pid: number; space: string; user: string; bypass: string; key: boolean }>>`
      SELECT pg_backend_pid() AS pid, current_setting('app.space_id',true) AS space,
      current_setting('app.user_id',true) AS "user",
      current_setting('app.rls_bypass',true) AS bypass,
      coalesce(current_setting('app.rls_bypass_key',true),'')<>'' AS key`;

  function observedTransactions(beforeTransaction?: () => Promise<void>) {
    const observations: Array<{
      before: Awaited<ReturnType<typeof connectionState>>;
      after?: Awaited<ReturnType<typeof connectionState>>;
    }> = [];
    let held: Prisma.TransactionClient | undefined;
    const prisma = new Proxy(runtime.prisma, {
      get(target, property) {
        if (property === "$transaction")
          return async (
            callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
            options?: object,
          ) => {
            await beforeTransaction?.();
            return target.$transaction(async (tx) => {
              const observation = {
                before: await connectionState(tx),
              } as (typeof observations)[number];
              observations.push(observation);
              held = tx;
              try {
                return await callback(tx);
              } finally {
                observation.after = await connectionState(tx);
                held = undefined;
              }
            }, options);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { prisma, observations, held: () => held };
  }

  function assertRestored(
    observations: ReturnType<typeof observedTransactions>["observations"],
    userId = userA,
  ) {
    expect(observations.length).toBeGreaterThan(0);
    for (const entry of observations) {
      expect(entry.after).toEqual(entry.before);
      expect(entry.before[0]).toMatchObject({
        space: spaceA,
        user: userId,
        bypass: "off",
        key: false,
      });
    }
    expect(runtime.pool.waitingCount).toBe(0);
  }

  async function integrationRpc(settings: IntegrationProviderSettings, prisma: PrismaClient) {
    const { RPCHandler } = await import("@orpc/server/fetch");
    const { createRouter } = await import("./router.js");
    const wrapped = settings.providers().find((entry) => entry.describe().id === "composio")!;
    const handler = new RPCHandler(
      createRouter({
        prisma,
        integrationSettings: settings,
        connectors: {
          managed: (provider: string) => (provider === "composio" ? wrapped : undefined),
        },
        jobs: { enqueue: vi.fn() },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "synthetic-rpc-secret",
          sandboxProvider: "fake",
        },
        dataDir: "unused-metadata-fixture",
      } as unknown as Parameters<typeof createRouter>[0]),
    );
    return (path: string, input: unknown, userId = userA) =>
      inTenant(async () => {
        const { response } = await handler.handle(
          new Request(`http://127.0.0.1/rpc/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: input }),
          }),
          { prefix: "/rpc", context: { actor: actor(userId) } },
        );
        if (!response) throw new Error("Synthetic metadata RPC was not matched");
        return response;
      }, userId);
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const database = url.pathname.slice(1);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) <= 1024 ||
      !/^integration_(0|[1-9][0-9]*)$/.test(database) ||
      database !== process.env.VERIFY_ROW_SECURITY_POLICIES_DATABASE
    )
      throw new Error("Metadata tests require the explicitly isolated harness database");
    owner = createDb(databaseUrl!);
    url.username = role;
    url.password = randomBytes(24).toString("hex");
    url.searchParams.delete("user");
    url.searchParams.delete("password");
    const runtimeUrl = url.toString();
    const result = await owner.pool.query<{ oid: number; name: string }>(
      "SELECT oid,datname AS name FROM pg_database WHERE datname=current_database()",
    );
    expect(result.rows[0]!.name).toBe(database);
    groupRole = `coginebot_app_${result.rows[0]!.oid}`;
    await provisionRuntimeRole(databaseUrl!, runtimeUrl);
    runtime = createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
    await owner.prisma.user.createMany({
      data: [userA, userB].map((userId) => ({
        id: userId,
        email: `${userId}@example.test`,
        name: "Synthetic metadata user",
      })),
    });
    const organizationId = id("organization");
    await owner.prisma.organization.create({
      data: { id: organizationId, slug: organizationId, name: "Synthetic", createdAt: new Date() },
    });
    await owner.prisma.member.createMany({
      data: [userA, userB].map((userId) => ({
        id: id(`organization-${userId}`),
        organizationId,
        userId,
        role: userId === userA ? "owner" : "member",
        createdAt: new Date(),
      })),
    });
    await owner.prisma.space.createMany({
      data: [spaceA, spaceB].map((spaceId) => ({ id: spaceId, organizationId, name: "Synthetic" })),
    });
    await owner.prisma.spaceMember.createMany({
      data: [
        [spaceA, userA],
        [spaceA, userB],
        [spaceB, userB],
      ].map(([spaceId, userId]) => ({
        id: id(`membership-${spaceId}-${userId}`),
        spaceId: spaceId!,
        userId: userId!,
        organizationId,
        role: userId === userA ? "owner" : "member",
        createdAt: new Date(),
      })),
    });
    await owner.prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        ownerUserId: userA,
        computerHost: "this-mac",
        defaultModelProvider: "local",
        defaultModelId: "metadata-model",
      },
      update: {
        ownerUserId: userA,
        computerHost: "this-mac",
        defaultModelProvider: "local",
        defaultModelId: "metadata-model",
      },
    });
    const status = await applyRowSecurityPolicies(databaseUrl!, runtimeUrl);
    expect(status).toMatchObject({
      expectedTables: 90,
      connectionEnforced: true,
      deploymentEnforced: false,
    });
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(async () => runtime?.prisma.$disconnect());
    await cleanup(async () => runtime?.pool.end());
    if (owner) {
      for (const name of [role, groupRole].filter(Boolean)) {
        await cleanup(async () => {
          const exists = await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name]);
          if (exists.rowCount) {
            const quoted = `"${name.replaceAll('"', '""')}"`;
            await owner.pool.query(`DROP OWNED BY ${quoted}`);
            await owner.pool.query(`DROP ROLE ${quoted}`);
          }
        });
      }
      await cleanup(() => owner.prisma.$disconnect());
      await cleanup(() => owner.pool.end());
    }
    if (failures.length) throw new AggregateError(failures, "Metadata fixture cleanup failed");
  });

  it("uses a restricted runtime and keeps direct metadata reads hidden", async () => {
    const state = await describeRowSecurityPolicies(runtime.prisma);
    expect(state).toMatchObject({
      expectedTables: 90,
      connectionEnforced: true,
      deploymentEnforced: false,
    });
    const roles = await runtime.prisma.$queryRaw<Array<{ privileged: boolean }>>`
      SELECT r.rolsuper OR r.rolbypassrls OR c.relowner=r.oid AS privileged
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='public.deployment_settings'::regclass`;
    expect(roles).toEqual([{ privileged: false }]);
    await inTenant(async () => {
      expect(
        await runtime.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      ).toBeNull();
      expect(await runtime.prisma.integrationProviderConfig.count()).toBe(0);
      assertTenant();
    });
  });

  it("retains persisted computer selection at public root and held entry points without starting a computer", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "docker");
    await inTenant(async () => {
      expect(await botCreationComputerKind(runtime.prisma)).toBe("desktop");
      const sandbox = createRunSandbox("docker", {
        dataDir: process.env.DATA_DIR!,
        prisma: runtime.prisma,
      });
      expect(await sandbox.provisionKind!()).toBe("desktop");
      const bot = await createRepos(runtime.prisma).createBot(
        { ...tenant(), email: "owner@example.test", isDeploymentOwner: true },
        {
          name: "Synthetic metadata bot",
          title: "",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        },
      );
      expect(bot.spaceId).toBe(spaceA);
      expect(
        await runtime.prisma.bot.findUnique({ where: { id: bot.id }, include: { computer: true } }),
      ).toMatchObject({
        userId: userA,
        spaceId: spaceA,
        computer: { kind: "desktop" },
      });
      await runtime.prisma.$transaction(async (tx) => {
        const before = await connectionState(tx);
        expect(await botCreationComputerKind(tx)).toBe("desktop");
        expect(await connectionState(tx)).toEqual(before);
        expect(await tx.deploymentSettings.findUnique({ where: { id: "default" } })).toBeNull();
        assertTenant();
      });
      assertTenant();
    });
  });

  it("uses persisted model defaults at the public resolver without elevating model or secret access", async () => {
    const executor = createRunExecutor({
      prisma: runtime.prisma,
      secretStore: new EncryptedSecretStore("synthetic-metadata-key"),
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await inTenant(async () => {
      expect(await executor.resolveModel(tenant())).toMatchObject({
        provider: "local",
        id: "metadata-model",
      });
      assertTenant();
      expect(await runtime.prisma.deploymentSettings.count()).toBe(0);
    });
  });

  it("uses persisted judge defaults while executing the model in tenant scope", async () => {
    const requests: AgentRunRequest[] = [];
    const agent = {
      async *run(request: AgentRunRequest) {
        assertTenant();
        requests.push(request);
        yield { type: "done", text: '{"act":true,"reason":"Synthetic decision"}' };
      },
    } as unknown as AgentRuntime;
    const judge = new ModelTeamChatEngagementJudge({
      prisma: runtime.prisma,
      runtime: agent,
      secrets: new EncryptedSecretStore("synthetic-metadata-key"),
      deploymentProvider: "",
      deploymentModel: "",
    });
    const decision = await inTenant(() =>
      judge.decide({
        bot: {
          id: id("judge-bot"),
          userId: userA,
          spaceId: spaceA,
          name: "Synthetic",
          modelProvider: null,
          modelId: null,
          modelCredentialId: null,
        },
        channelId: "synthetic-channel",
        rules: "",
        messages: [],
      }),
    );
    expect(decision.act).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toMatchObject({ provider: "local", id: "metadata-model" });
  });

  it("defers an oversized summary and retries at the committed message threshold in tenant scope", async () => {
    const botId = id("compaction-bot");
    const threadId = id("compaction-thread");
    await owner.prisma.bot.create({
      data: { id: botId, userId: userA, spaceId: spaceA, name: "Synthetic", color: "ink" },
    });
    await owner.prisma.thread.create({
      data: { id: threadId, userId: userA, spaceId: spaceA, botId },
    });
    const appendMessages = (from: number, nextMessageSeq: number) =>
      owner.prisma.$transaction([
        owner.prisma.message.createMany({
          data: Array.from({ length: nextMessageSeq - from }, (_, index) => ({
            threadId,
            seq: from + index,
            role: "user",
            blocks: [{ kind: "text", text: `Synthetic message ${from + index}` }],
          })),
        }),
        owner.prisma.thread.update({ where: { id: threadId }, data: { nextMessageSeq } }),
      ]);
    await appendMessages(0, 100);
    const requests: AgentRunRequest[] = [];
    const agent = {
      describe: () => ({ capabilities: { compaction: true } }),
      async *run(request: AgentRunRequest) {
        assertTenant();
        requests.push(request);
        if (requests.length === 1) {
          await appendMessages(100, 101);
          yield { type: "done", text: "x".repeat(MAX_COMPACTED_SUMMARY_CHARS + 1) };
        } else {
          yield { type: "done", text: "Synthetic compacted summary" };
        }
      },
    } as unknown as AgentRuntime;
    const deps = {
      prisma: runtime.prisma,
      runtime: agent,
      jobs: { enqueue: vi.fn(), cancel: vi.fn(), close: vi.fn() },
      memoryProviders: { resolve: async () => null },
    } as Parameters<typeof compactHistory>[0];
    const readThread = () => runtime.prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
    await inTenant(async () => {
      expect(await readThread()).toMatchObject({ historyCompactionRetryAfterSeq: null });
      await compactHistory(deps, threadId);
      expect(await readThread()).toMatchObject({
        historyCompactedUpToSeq: null,
        historyCompactionSummary: null,
        historyCompactionRetryAfterSeq: 151,
      });
    });
    expect(requests).toHaveLength(1);

    await appendMessages(101, 150);
    await inTenant(() => compactHistory(deps, threadId));
    expect(requests).toHaveLength(1);

    await appendMessages(150, 151);
    await inTenant(async () => {
      await compactHistory(deps, threadId);
      assertTenant();
      expect(await readThread()).toMatchObject({
        historyCompactedUpToSeq: 49,
        historyCompactionSummary: "Synthetic compacted summary",
        historyCompactionRetryAfterSeq: null,
      });
    });
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(request.model).toMatchObject({ provider: "local", id: "metadata-model" });
  });

  it("keeps provider authentication and secrets in tenant scope while persisting and rechecking global metadata", async () => {
    const secrets = new EncryptedSecretStore("synthetic-integration-key");
    const originalPut = secrets.put.bind(secrets);
    const originalLoad = secrets.load.bind(secrets);
    vi.spyOn(secrets, "put").mockImplementation((...args) => {
      assertTenant();
      return originalPut(...args);
    });
    vi.spyOn(secrets, "load").mockImplementation((...args) => {
      assertTenant();
      return originalLoad(...args);
    });
    const verify = vi.fn(async () => {
      assertTenant();
      return [];
    });
    const provider = { listConnectedExternalIds: verify } as unknown as ManagedConnectorProvider;
    const factory = vi.fn(() => {
      assertTenant();
      return provider;
    });
    const settings = new IntegrationProviderSettings(
      runtime.prisma,
      secrets,
      "synthetic-identity",
      {},
      factory,
    );
    await inTenant(async () => {
      await settings.save(
        { provider: "composio", apiKey: "synthetic-integration-key-1" },
        context(),
      );
      expect(await settings.configured("composio")).toBe(true);
      expect(await settings.resolve("composio")).toBe(provider);
      const wrapped = settings.providers().find((entry) => entry.describe().id === "composio")!;
      const prepared = await prepareManagedConnectorForTransaction(wrapped);
      expect(prepared.recheck).toBeDefined();
      await expect(prepared.recheck!(runtime.prisma)).rejects.toThrow();
      await runtime.prisma.$transaction(async (tx) => {
        const before = await connectionState(tx);
        expect(await prepared.recheck!(tx)).toBe(true);
        expect(await connectionState(tx)).toEqual(before);
        const rotated = await originalPut(
          JSON.stringify({ provider: "composio", apiKey: "synthetic-integration-key-2" }),
          context(),
          { recordId: "integration-provider:composio" },
        );
        await owner.prisma.integrationProviderConfig.update({
          where: { id: "composio" },
          data: { ciphertext: rotated.ciphertext },
        });
        expect(await prepared.recheck!(tx)).toBe(false);
        expect(await connectionState(tx)).toEqual(before);
        expect(await tx.integrationProviderConfig.count()).toBe(0);
        assertTenant();
      });
      expect(await settings.resolve("composio")).toBe(provider);
      expect(factory).toHaveBeenLastCalledWith({
        provider: "composio",
        apiKey: "synthetic-integration-key-2",
      });
      expect(verify).toHaveBeenCalledOnce();
      assertTenant();
    });
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("holds the current owner lock through the provider-config write on one connection", async () => {
    let held = false;
    let writes = 0;
    const states: Array<Awaited<ReturnType<typeof connectionState>>> = [];
    const prisma = new Proxy(runtime.prisma, {
      get(target, property) {
        if (property === "$transaction")
          return async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
            target.$transaction(async (tx) => {
              held = true;
              const original = tx.integrationProviderConfig.upsert.bind(
                tx.integrationProviderConfig,
              );
              const write = vi
                .spyOn(tx.integrationProviderConfig, "upsert")
                .mockImplementation((...args) => {
                  const pending = (async () => {
                    writes++;
                    expect(currentDbContext()).toMatchObject({ kind: "system" });
                    states.push(await connectionState(tx));
                    const contender = await owner.pool.connect();
                    try {
                      await contender.query("BEGIN");
                      await contender.query("SET LOCAL lock_timeout='100ms'");
                      await expect(
                        contender.query(
                          "UPDATE deployment_settings SET \"ownerUserId\"=$1 WHERE id='default'",
                          [userA],
                        ),
                      ).rejects.toMatchObject({ code: "55P03" });
                    } finally {
                      await contender.query("ROLLBACK");
                      contender.release();
                    }
                    const result = await original(...args);
                    states.push(await connectionState(tx));
                    return result;
                  })();
                  Object.defineProperty(pending, Symbol.toStringTag, { value: "PrismaPromise" });
                  return pending as ReturnType<typeof original>;
                });
              try {
                return await callback(tx);
              } finally {
                write.mockRestore();
                held = false;
              }
            });
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const secrets = new EncryptedSecretStore("synthetic-owner-lock-key");
    const put = secrets.put.bind(secrets);
    vi.spyOn(secrets, "put").mockImplementation((...args) => {
      assertTenant();
      expect(held).toBe(false);
      return put(...args);
    });
    const settings = new IntegrationProviderSettings(
      prisma,
      secrets,
      "synthetic-identity",
      {},
      () =>
        ({
          listConnectedExternalIds: async () => {
            assertTenant();
            expect(held).toBe(false);
            return [];
          },
        }) as unknown as ManagedConnectorProvider,
    );
    await inTenant(async () => {
      await settings.save({ provider: "composio", apiKey: "synthetic-owner-lock-key" }, context());
      assertTenant();
      expect(await runtime.prisma.integrationProviderConfig.count()).toBe(0);
    });
    expect(writes).toBe(1);
    expect(states).toHaveLength(2);
    expect(states[1]).toEqual(states[0]);
    expect(states[0]![0]).toMatchObject({ bypass: "on", key: true });
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it.each(["changed", "cleared"] as const)(
    "rejects stale owner setup after ownership is %s during secret preparation",
    async (change) => {
      const secrets = new EncryptedSecretStore("synthetic-stale-owner-key");
      const provider = {
        listConnectedExternalIds: vi.fn(async () => {
          assertTenant();
          return [];
        }),
      } as unknown as ManagedConnectorProvider;
      const settings = new IntegrationProviderSettings(
        runtime.prisma,
        secrets,
        "synthetic-identity",
        {},
        () => provider,
      );
      await inTenant(() =>
        settings.save({ provider: "composio", apiKey: "synthetic-working-key" }, context()),
      );
      const previous = await owner.prisma.integrationProviderConfig.findUniqueOrThrow({
        where: { id: "composio" },
      });
      const originalPut = secrets.put.bind(secrets);
      let candidate: Awaited<ReturnType<typeof originalPut>> | undefined;
      vi.spyOn(secrets, "put").mockImplementation(async (...args) => {
        assertTenant();
        candidate = await originalPut(...args);
        await owner.prisma.deploymentSettings.update({
          where: { id: "default" },
          data: { ownerUserId: change === "changed" ? userB : null },
        });
        return candidate;
      });
      const deleted = vi.spyOn(secrets, "delete");
      const call = await integrationRpc(settings, runtime.prisma);
      try {
        const response = await call("integrationSetup/save", {
          provider: "composio",
          apiKey: "synthetic-stale-owner-key",
        });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("Could not verify or save these credentials");
        expect(
          await owner.prisma.integrationProviderConfig.findUnique({ where: { id: "composio" } }),
        ).toEqual(previous);
        expect(candidate).toBeDefined();
        expect(candidate!.ciphertext).not.toBe(previous.ciphertext);
        expect(deleted).toHaveBeenCalledExactlyOnceWith(
          candidate!.ciphertext,
          "integration-provider:composio",
        );
        await inTenant(async () => {
          expect(await settings.resolve("composio")).toBe(provider);
          expect(await runtime.prisma.integrationProviderConfig.count()).toBe(0);
          assertTenant();
        });
        expect(runtime.pool.waitingCount).toBe(0);
      } finally {
        await owner.prisma.deploymentSettings.update({
          where: { id: "default" },
          data: { ownerUserId: userA },
        });
      }
    },
  );

  it("restores the held tenant after an error following the actual provider metadata query", async () => {
    const secrets = new EncryptedSecretStore("synthetic-integration-error-key");
    const provider = {
      listConnectedExternalIds: async () => [],
    } as unknown as ManagedConnectorProvider;
    const settings = new IntegrationProviderSettings(
      runtime.prisma,
      secrets,
      "synthetic-identity",
      {},
      () => provider,
    );
    await inTenant(async () => {
      await settings.save(
        { provider: "composio", apiKey: "synthetic-integration-error" },
        context(),
      );
      const prepared = await prepareManagedConnectorForTransaction(
        settings.providers().find((entry) => entry.describe().id === "composio")!,
      );
      await runtime.prisma.$transaction(async (tx) => {
        const before = await connectionState(tx);
        const original = tx.integrationProviderConfig.findUnique.bind(tx.integrationProviderConfig);
        const failure = new Error("Synthetic post-query failure");
        const query = vi
          .spyOn(tx.integrationProviderConfig, "findUnique")
          .mockImplementation((...args) => {
            const pending = original(...args).then(() => {
              throw failure;
            });
            // Inject after the real SQL while preserving the delegate promise contract.
            Object.defineProperty(pending, Symbol.toStringTag, { value: "PrismaPromise" });
            return pending as ReturnType<typeof original>;
          });
        try {
          await expect(prepared.recheck!(tx)).rejects.toBe(failure);
        } finally {
          query.mockRestore();
        }
        expect(await connectionState(tx)).toEqual(before);
        expect(await tx.integrationProviderConfig.count()).toBe(0);
        assertTenant();
      });
    });
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("retains owner-configured local memory for a Space member and rejects stale ownership before secret or network access", async () => {
    const secrets = new EncryptedSecretStore("synthetic-memory-key");
    const record = await secrets.put(
      JSON.stringify({ apiKey: "synthetic-memory-credential" }),
      context(),
      { recordId: id("memory-secret") },
    );
    await owner.prisma.secret.create({
      data: {
        id: record.id,
        userId: userA,
        spaceId: spaceA,
        kind: "memory",
        ciphertext: record.ciphertext,
      },
    });
    await owner.prisma.spaceMemoryConfig.create({
      data: {
        spaceId: spaceA,
        userId: userA,
        provider: "supermemory",
        settings: { mode: "local", baseUrl: "http://127.0.0.1:6767" },
        secretId: record.id,
        defaultMemoryScope: "shared",
      },
    });
    const load = secrets.load.bind(secrets);
    const secretReads = vi.spyOn(secrets, "load").mockImplementation((...args) => {
      assertTenant(userB);
      return load(...args);
    });
    const fetch = vi.fn(async () => {
      assertTenant(userB);
      return Response.json({ results: [] });
    });
    vi.stubGlobal("fetch", fetch);
    const resolver = new SpaceMemoryProviderResolver(runtime.prisma, secrets);
    try {
      await inTenant(async () => {
        const configured = await resolver.resolve(spaceA);
        expect(configured?.defaultScope).toBe("shared");
        await configured!.provider.recall(
          { query: "Synthetic", scope: "isolated", botId: id("memory-bot"), limit: 1 },
          context(userB),
        );
        expect(fetch).toHaveBeenCalledOnce();
        expect(secretReads).toHaveBeenCalledOnce();
        await owner.prisma.deploymentSettings.update({
          where: { id: "default" },
          data: { ownerUserId: userB },
        });
        expect(await resolver.resolve(spaceA)).toBeNull();
        expect(fetch).toHaveBeenCalledOnce();
        expect(secretReads).toHaveBeenCalledOnce();
        expect(await runtime.prisma.deploymentSettings.count()).toBe(0);
        assertTenant(userB);
      }, userB);
    } finally {
      await owner.prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { ownerUserId: userA },
      });
    }
  });
  it("preserves owner setup and tenant-scoped complete/revoke through public RPCs", async () => {
    const observed = observedTransactions();
    const secrets = new EncryptedSecretStore("synthetic-rpc-integration-key");
    const verify = vi.fn(async () => {
      assertTenant();
      return [];
    });
    const remote = vi.fn(async () => {
      assertTenant();
      expect((await connectionState(observed.held()!))[0]).toMatchObject({
        space: spaceA,
        user: userA,
        bypass: "off",
        key: false,
      });
    });
    const provider = {
      listConnectedExternalIds: verify,
      complete: remote,
      revoke: remote,
      connectionReady: async () => {
        assertTenant();
        return true;
      },
    } as unknown as ManagedConnectorProvider;
    const settings = new IntegrationProviderSettings(
      runtime.prisma,
      secrets,
      "synthetic-identity",
      {},
      () => provider,
    );
    const call = await integrationRpc(settings, observed.prisma);
    const input = { provider: "composio", apiKey: "synthetic-rpc-credential" };
    expect((await call("integrationSetup/save", input, userB)).status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
    expect((await call("integrationSetup/save", input)).status).toBe(200);
    expect(verify).toHaveBeenCalledOnce();
    expect((await call("integrationSetup/get", {})).status).toBe(200);
    const connectionId = id("rpc-connection");
    await owner.prisma.connection.create({
      data: {
        id: connectionId,
        spaceId: spaceA,
        userId: userA,
        connectorId: "composio",
        provider: "fixture",
        providerRef: "fixture",
        displayName: "Synthetic",
        status: "pending",
      },
    });
    expect(
      (await call("connections/complete", { connectionId, code: "synthetic-code" })).status,
    ).toBe(200);
    expect(await owner.prisma.connection.findUnique({ where: { id: connectionId } })).toMatchObject(
      { status: "connected" },
    );
    expect((await call("connections/revoke", { connectionId })).status).toBe(200);
    expect(await owner.prisma.connection.findUnique({ where: { id: connectionId } })).toMatchObject(
      { status: "revoked" },
    );
    expect(remote).toHaveBeenCalledTimes(2);
    assertRestored(observed.observations);
  });

  it.each(["complete", "revoke"] as const)(
    "rejects rotated provider credentials before a public %s side effect",
    async (operation) => {
      const secrets = new EncryptedSecretStore("synthetic-rpc-rotation-key");
      const remote = vi.fn(async () => {
        assertTenant();
      });
      const provider = {
        listConnectedExternalIds: async () => [],
        complete: remote,
        revoke: remote,
        connectionReady: async () => true,
      } as unknown as ManagedConnectorProvider;
      const settings = new IntegrationProviderSettings(
        runtime.prisma,
        secrets,
        "synthetic-identity",
        {},
        () => provider,
      );
      await inTenant(() =>
        settings.save({ provider: "composio", apiKey: "synthetic-before-rotation" }, context()),
      );
      const replacement = await secrets.put(
        JSON.stringify({ provider: "composio", apiKey: "synthetic-after-rotation" }),
        context(),
        { recordId: "integration-provider:composio" },
      );
      let rotated = false;
      const observed = observedTransactions(async () => {
        if (rotated) return;
        rotated = true;
        await owner.prisma.integrationProviderConfig.update({
          where: { id: "composio" },
          data: { ciphertext: replacement.ciphertext },
        });
      });
      const call = await integrationRpc(settings, observed.prisma);
      const connectionId = id(`rotated-${operation}`);
      const status = operation === "complete" ? "pending" : "connected";
      await owner.prisma.connection.create({
        data: {
          id: connectionId,
          spaceId: spaceA,
          userId: userA,
          connectorId: "composio",
          provider: `fixture-${operation}`,
          providerRef: `fixture-${operation}`,
          displayName: "Synthetic",
          status,
        },
      });
      try {
        expect(
          (
            await call(`connections/${operation}`, {
              connectionId,
              ...(operation === "complete" ? { code: "synthetic-code" } : {}),
            })
          ).status,
        ).toBe(409);
        expect(rotated).toBe(true);
        expect(remote).not.toHaveBeenCalled();
        expect(
          await owner.prisma.connection.findUnique({ where: { id: connectionId } }),
        ).toMatchObject({ status });
        assertRestored(observed.observations);
      } finally {
        await owner.prisma.connection.delete({ where: { id: connectionId } });
      }
    },
  );
  it("imports an owner's private endpoint through root and same-PID held authorization", async () => {
    const observed = observedTransactions();
    const secrets = new EncryptedSecretStore("synthetic-openapi-key");
    const put = secrets.put.bind(secrets);
    vi.spyOn(secrets, "put").mockImplementation((...args) => {
      assertTenant();
      return put(...args);
    });
    const fetch = vi.fn(async () => {
      assertTenant();
      return Response.json({
        openapi: "3.0.3",
        servers: [{ url: "http://127.0.0.1:6767/api" }],
        paths: {
          "/items": {
            get: { operationId: "list_items", responses: { "200": { description: "Synthetic" } } },
          },
        },
      });
    });
    const service = createOpenApiImportService({
      prisma: observed.prisma,
      secrets,
      remoteConnectors: { fetch },
      env: { mcpAllowPrivateEndpoint: false },
      openApiPreviewKey: "synthetic-review-signing-key",
    } as unknown as Parameters<typeof createOpenApiImportService>[0]);
    const input = {
      name: "Synthetic private import",
      source: "http://127.0.0.1:6767/openapi.json",
      config: { auth: { type: "bearer" } },
      credential: "synthetic-api-credential",
    };
    await inTenant(async () => {
      const preview = await service.preview({ actor: actor() }, input);
      expect(preview.status).toBe("ready");
      const result = await service.confirm(
        { actor: actor() },
        { ...input, reviewToken: preview.reviewToken! },
      );
      expect(result.status).toBe("installed");
      expect(await service.receipt({ actor: actor() }, preview.reviewToken!)).toMatchObject({
        status: "installed",
        replayed: true,
      });
      expect(await runtime.prisma.deploymentSettings.count()).toBe(0);
      assertTenant();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const member = await inTenant(() => service.preview({ actor: actor(userB) }, input), userB);
    expect(member.status).toBe("invalid");
    expect(fetch).toHaveBeenCalledTimes(2);
    assertRestored(observed.observations);
  });

  it.each(["owner", "membership"] as const)(
    "rechecks changed %s before private import persistence and compensates the prepared secret",
    async (changed) => {
      const observed = observedTransactions();
      const secrets = new EncryptedSecretStore("synthetic-openapi-recheck-key");
      const originalPut = secrets.put.bind(secrets);
      let written: Awaited<ReturnType<typeof originalPut>> | undefined;
      vi.spyOn(secrets, "put").mockImplementation(async (...args) => {
        assertTenant();
        written = await originalPut(...args);
        if (changed === "owner")
          await owner.prisma.deploymentSettings.update({
            where: { id: "default" },
            data: { ownerUserId: userB },
          });
        else
          await owner.prisma.spaceMember.delete({
            where: { spaceId_userId: { spaceId: spaceA, userId: userA } },
          });
        return written;
      });
      const removed = vi.spyOn(secrets, "delete");
      const fetch = vi.fn(async () => {
        assertTenant();
        return Response.json({
          openapi: "3.0.3",
          servers: [{ url: "http://127.0.0.1:6767/api" }],
          paths: {
            "/items": {
              get: {
                operationId: "list_items",
                responses: { "200": { description: "Synthetic" } },
              },
            },
          },
        });
      });
      const service = createOpenApiImportService({
        prisma: observed.prisma,
        secrets,
        remoteConnectors: { fetch },
        env: { mcpAllowPrivateEndpoint: false },
        openApiPreviewKey: "synthetic-review-recheck-key",
      } as unknown as Parameters<typeof createOpenApiImportService>[0]);
      const input = {
        name: `Synthetic changed ${changed}`,
        source: "http://127.0.0.1:6767/openapi.json",
        config: { auth: { type: "bearer" } },
        credential: "synthetic-api-recheck-credential",
      };
      const before = await owner.prisma.capabilityInstall.count();
      try {
        await inTenant(async () => {
          const preview = await service.preview({ actor: actor() }, input);
          expect(preview.status).toBe("ready");
          const confirmation = service.confirm(
            { actor: actor() },
            { ...input, reviewToken: preview.reviewToken! },
          );
          if (changed === "owner") expect(await confirmation).toMatchObject({ status: "stale" });
          else await expect(confirmation).rejects.toMatchObject({ code: "FORBIDDEN" });
          assertTenant();
          expect(await runtime.prisma.deploymentSettings.count()).toBe(0);
        });
        expect(written).toBeDefined();
        expect(await owner.prisma.secret.findUnique({ where: { id: written!.id } })).toBeNull();
        expect(await owner.prisma.capabilityInstall.count()).toBe(before);
        expect(removed).toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(2);
        assertRestored(observed.observations);
      } finally {
        await owner.prisma.deploymentSettings.update({
          where: { id: "default" },
          data: { ownerUserId: userA },
        });
        await owner.prisma.spaceMember.upsert({
          where: { spaceId_userId: { spaceId: spaceA, userId: userA } },
          create: {
            id: id("restored-owner-membership"),
            spaceId: spaceA,
            userId: userA,
            organizationId: id("organization"),
            role: "owner",
            createdAt: new Date(),
          },
          update: {},
        });
      }
    },
  );
  it("reads continuation defaults after real admission and restores the tenant on setup failure", async () => {
    const created = await inTenant(() =>
      createRepos(runtime.prisma).createBot(actor(), {
        name: "Synthetic bootstrap bot",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    );
    const bot = await owner.prisma.bot.findUniqueOrThrow({
      where: { id: created.id },
      include: { thread: true },
    });
    const taskId = id("bootstrap-task");
    const runId = id("bootstrap-run");
    await owner.prisma.task.create({
      data: {
        id: taskId,
        userId: userA,
        spaceId: spaceA,
        botId: bot.id,
        threadId: bot.thread!.id,
        prompt: "Synthetic bootstrap",
        status: "queued",
      },
    });
    await owner.prisma.run.create({
      data: {
        id: runId,
        userId: userA,
        spaceId: spaceA,
        botId: bot.id,
        threadId: bot.thread!.id,
        taskId,
        status: "queued",
        trigger: "human",
      },
    });
    const stop = new Error("Synthetic failure after the bootstrap metadata query");
    const reads: Array<{ row: unknown; context: ReturnType<typeof currentDbContext> }> = [];
    const prisma = new Proxy(runtime.prisma, {
      get(target, property) {
        if (property === "deploymentSettings")
          return {
            findUnique: async (args: Prisma.DeploymentSettingsFindUniqueArgs) => {
              const row = await target.deploymentSettings.findUnique(args);
              reads.push({ row, context: currentDbContext() });
              throw stop;
            },
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const run = vi.fn();
    const executor = createRunExecutor({
      prisma,
      repos: createRepos(prisma),
      runtime: {
        describe: () => ({ id: "metadata-fixture", capabilities: { scripted: false } }),
        run,
      },
      events: { notify: async () => {} },
      jobs: { enqueue: async () => "synthetic-job", cancel: async () => {}, close: async () => {} },
      sandbox: {},
      memory: {},
      memoryProviders: { resolve: async () => null },
      secretStore: new EncryptedSecretStore("synthetic-bootstrap-key"),
      secrets: [],
      web: {},
      browser: {},
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await inTenant(async () => {
      await expect(executor.continueRun(runId, "synthetic-bootstrap-worker")).rejects.toThrow(
        "Run setup failed; retrying",
      );
      assertTenant();
      expect(await runtime.prisma.deploymentSettings.count()).toBe(0);
    });
    expect(reads).toEqual([
      {
        row: { defaultModelProvider: "local", defaultModelId: "metadata-model" },
        context: { kind: "system", reason: "read deployment defaults for a run" },
      },
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(
      (await owner.prisma.run.findUniqueOrThrow({ where: { id: runId } })).leaseFence,
    ).toBeGreaterThan(0);
    expect(runtime.pool.waitingCount).toBe(0);
  });
});
