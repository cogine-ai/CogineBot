import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { JobPublisher, JobWorkerHost } from "@rakazo/adapter-kit";
import {
  ComposioConnector,
  IntegrationProviderSettings,
  NativeConnectorProvider,
  NativeRoutineEventService,
} from "@rakazo/adapters";
import { parsePlatformModelAllowlist } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { stopOnShutdownSignals } from "@rakazo/core/node/shutdown-signals";
import { createWorkerSecretStore } from "./secret-store.js";

loadRootEnv();

import {
  ChatSdkMessagingSurface,
  CodexCatalogCache,
  createBackgroundJobHandlers,
  createCloudAgentConnection,
  createConnectorStack,
  createGroupRunTeardownRecovery,
  createJobReconciler,
  createMessagingContextLoader,
  createPostgresReconciliationLeadership,
  createReservedGraphileJobWorkerHost,
  createRunExecutor,
  createRunSandbox,
  createRunSecretWriter,
  createTicketChangeNotifier,
  createWebProvider,
  databaseCapacityBackoffMs,
  ExpoPushProvider,
  GraphileJobPublisher,
  InMemoryJobQueue,
  InstalledConnectorProvider,
  isComposioEnabled,
  isMessagingSurfaceEnabled,
  isPipedreamEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  McpConnector,
  McpOAuthBroker,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  PiAgentRuntime,
  PipedreamConnector,
  PostgresRealtimeFanout,
  pipedreamConfigFromEnv,
  RunJobPublisher,
  RunStarter,
  RunWorkerHost,
  reconcileCloudAgents,
  reconcileComputerUpdates,
  resolveDeploymentModel,
  resolvePiSessionRoot,
  resolveSandboxProvider,
  ScriptedAgentRuntime,
  SpaceMemoryProviderResolver,
  sandboxProviderOptionsFromEnv,
  withRunWorker,
  withSecretPersistence,
} from "@rakazo/adapters";
import { resolveEncryptionKey, resolveSupervisorToken } from "@rakazo/core";
import {
  createBoardEvents,
  createDb,
  createThreadEvents,
  isTooManyDatabaseConnections,
  parsePositiveInteger,
  pushSessionExpiresAt,
  runAsSystem,
  verifyRealtimeDatabase,
  verifyRuntimeDatabase,
} from "@rakazo/db";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { MarkdownMemoryStore } from "@rakazo/memory";

const logger = createRootLogger(SERVICE_NAMES.worker);

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const poolMax = parsePositiveInteger(process.env.DB_POOL_MAX, 8);
  // Three queue listeners and reconciliation leadership hold connections. Leave
  // room for job queries and transactions instead of starting a stalled worker.
  if (process.env.WAKEUP_DRIVER !== "memory" && poolMax < 6)
    throw new Error("DB_POOL_MAX must be at least 6 for the Graphile worker");
  // Prisma, queue publishing, the three queue listeners and reconciliation
  // leadership share one bounded pool rather than opening a pool per component.
  // A larger max competes for Postgres max_connections (53300).
  const created = createDb(databaseUrl, {
    poolMax,
    applicationName: "rakazo-worker",
    rowSecurity: true,
  });
  const { pool } = created;
  let { prisma } = created;
  const realtimeUrl = process.env.REALTIME_DATABASE_URL?.trim() || databaseUrl;
  const status = await verifyRuntimeDatabase(prisma);
  if (realtimeUrl !== databaseUrl)
    await verifyRealtimeDatabase(
      realtimeUrl,
      status.connectionEnforced,
      !status.problems.includes("runtime-not-prepared"),
    );
  const realtime = new PostgresRealtimeFanout({
    connectionString: realtimeUrl,
    publisher: pool,
  });
  const secrets = await createWorkerSecretStore(process.env, realtime);
  if (secrets.describe().capabilities.degraded)
    logger.warn("Secret storage degraded; encrypted credentials remain available");
  prisma = withSecretPersistence(prisma, secrets);
  const events = createThreadEvents(prisma, realtime, {
    runSecretWriter: createRunSecretWriter(secrets),
  });
  const ticketBoardEnabled = process.env.TICKET_BOARD_ENABLED === "true";
  const boardEvents = createBoardEvents(realtime);
  const dataDir = process.env.DATA_DIR ?? "./data";
  const runtime =
    process.env.AGENT_RUNTIME === "scripted"
      ? new ScriptedAgentRuntime()
      : new PiAgentRuntime({ sessionRoot: resolvePiSessionRoot(dataDir) });
  // Same resolver the API uses, so both processes agree on provider, model and key.
  const platformModelAllowlist = parsePlatformModelAllowlist(process.env.PLATFORM_MODEL_ALLOWLIST);
  const { key: deploymentModelKey, configured: deploymentModelConfigured } =
    resolveDeploymentModel();
  const sandboxProvider = resolveSandboxProvider(process.env);
  const sandbox = createRunSandbox(sandboxProvider, {
    ...sandboxProviderOptionsFromEnv(process.env),
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    supervisorToken: sandboxProvider === "docker" ? resolveSupervisorToken(process.env) : undefined,
    dataDir,
    prisma,
  });
  const allowPrivateEndpoint = process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true";
  const mcpOAuth = new McpOAuthBroker(prisma, secrets, {}, allowPrivateEndpoint);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: process.env.MCP_STDIO_ENABLED === "true",
      allowedCommands: (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      events,
      allowPrivateEndpoint,
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv({
    pipedreamClientId: process.env.PIPEDREAM_CLIENT_ID,
    pipedreamClientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
    pipedreamProjectId: process.env.PIPEDREAM_PROJECT_ID,
    pipedreamEnvironment: process.env.PIPEDREAM_ENVIRONMENT,
    encryptionKey: resolveEncryptionKey(process.env),
  });
  const pipedream = isPipedreamEnabled(pipedreamConfig)
    ? new PipedreamConnector(pipedreamConfig)
    : undefined;
  // pollInboundMessages stays false (the default) here: this process
  // only ever sends outbound (messaging.deliver jobs). It must never poll
  // Telegram — that would steal the single getUpdates slot away from the
  // API process, which is the one with the inbound sink actually wired up.
  const messagingPlatforms = messagingPlatformsFromEnv(messagingEnvFromProcess(process.env));
  const messaging = isMessagingSurfaceEnabled(messagingPlatforms, {
    deploymentModelConfigured,
    openSignup: process.env.MESSAGING_OPEN_SIGNUP === "true",
  })
    ? new ChatSdkMessagingSurface(messagingPlatforms)
    : undefined;
  const integrationSettings = new IntegrationProviderSettings(
    prisma,
    secrets,
    resolveEncryptionKey(process.env),
    {
      composio: isComposioEnabled(process.env.COMPOSIO_API_KEY)
        ? new ComposioConnector(process.env.COMPOSIO_API_KEY)
        : undefined,
      pipedream,
    },
  );
  const artifacts = new LocalArtifactStore(dataDir);
  const native = new NativeConnectorProvider(
    prisma,
    secrets,
    process.env.API_URL ?? "http://127.0.0.1:3100",
    { artifacts, allowPrivateEndpoint },
  );
  const stack = createConnectorStack(false, undefined, [
    native,
    new InstalledConnectorProvider(prisma, secrets, {}, allowPrivateEndpoint),
    ...integrationSettings.providers(),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  integrationSettings.warmDirectories();
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  const home = new LocalAgentHomeStore(dataDir);
  const shutdown = new AbortController();
  const inMemoryJobs = process.env.WAKEUP_DRIVER === "memory" ? new InMemoryJobQueue() : undefined;
  const runs = new RunStarter(realtime, { signal: shutdown.signal });
  const jobs: JobPublisher =
    inMemoryJobs ?? new RunJobPublisher(prisma, new GraphileJobPublisher(pool, prisma), runs);
  const ticketChanges = createTicketChangeNotifier({
    boardEvents,
    jobs,
    prisma,
    ticketBoardEnabled,
  });
  // One provider instance so emulator launches and polls share the same Map.
  const cloudAgent = createCloudAgentConnection();
  // Shared with the reconciler so a stuck wait uses the same push path as a finish notice.
  const notifications = new ExpoPushProvider(dataDir, (sessionId) =>
    pushSessionExpiresAt(prisma, sessionId),
  );
  const executor = createRunExecutor({
    prisma,
    runtime,
    // Live per-account Codex catalog; never refreshes or writes credentials.
    codexCatalog: new CodexCatalogCache(),
    sandbox,
    memory: new MarkdownMemoryStore(prisma),
    memoryProviders,
    home,
    artifacts,
    connector: stack.connector,
    connectors: stack.connector,
    listConnectedPluginSlugs: async (userId) => {
      const provider = await integrationSettings.resolve("composio");
      if (!provider) return [];
      return provider.listConnectedExternalIds({
        userId,
        spaceId: "",
        operationId: "connections.sync",
        traceId: "connections.sync",
        signal: AbortSignal.timeout(15_000),
      });
    },
    secrets: [
      deploymentModelKey ?? "",
      process.env.COMPOSIO_API_KEY ?? "",
      process.env.CURSOR_API_KEY ?? "",
      process.env.TYPESAFE_API_KEY ?? "",
    ].filter(Boolean),
    secretStore: secrets,
    mcpAllowPrivateEndpoint: process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
    platformModelAllowlist,
    deploymentModelKey,
    deploymentModelConfigured,
    dataDir,
    notifications,
    jobs,
    events,
    onTicketChange: ticketChanges,
    ticketBoardEnabled,
    messaging: messaging ? createMessagingContextLoader(prisma) : undefined,
    web: createWebProvider(),
    cloudAgent,
    shutdownSignal: shutdown.signal,
  });

  const nativeEvents = new NativeRoutineEventService(
    prisma,
    native.oauth,
    native.eventHooks,
    jobs,
    events,
    process.env.API_URL ?? "http://127.0.0.1:3100",
    undefined,
    native.slackEventHooks,
  );
  const jobHost: JobWorkerHost =
    inMemoryJobs ??
    withRunWorker(
      new RunWorkerHost(prisma, realtime, runs, { pool }),
      createReservedGraphileJobWorkerHost(pool, {
        concurrency: parsePositiveInteger(process.env.GRAPHILE_WORKER_CONCURRENCY, 4),
      }),
    );
  const jobHandlers = createBackgroundJobHandlers({
    nativeEvents,
    executor,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    // Containers share Node's pid, including during rolling deploys.
    workerId: `${hostname()}:${process.pid}`,
    runtime,
    secretStore: secrets,
    memoryProviders,
    platformModelAllowlist,
    deploymentModelKey,
    deploymentModelConfigured,
    messaging,
    cloudAgent,
  });
  const reconciler = createJobReconciler({
    prisma,
    jobs,
    events,
    notifications,
    leadership: createPostgresReconciliationLeadership(pool),
    reconcileCloudAgents: () => reconcileCloudAgents({ prisma, jobs, cloudAgent }),
    reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
    reconcileGroupRunTeardowns: createGroupRunTeardownRecovery({ prisma, sandbox }).reconcile,
    reconcileNativeEvents: () => nativeEvents.reconcile(),
  });
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    shutdown.abort();
    stopPromise = (async () => {
      try {
        await reconciler.stop();
        await jobHost.stop();
        await executor.closeRemoteMcpSessions();
        await jobs.close();
        await secrets.close();
        await realtime.close();
        await connector.stop();
        await mcp.close();
        await nativeEvents.close();
        await native.close();
        await prisma.$disconnect().catch(() => undefined);
        await pool.end().catch(() => undefined);
      } finally {
        await logger.flush({ timeoutMs: 2_000 });
      }
    })();
    return stopPromise;
  };
  stopOnShutdownSignals(stop);
  // graphile-worker fires completeJob() without awaiting it. When pool.connect()
  // then hits Postgres 53300, that rejection is unhandled. Exiting here is the
  // crash loop: Docker restarts the process before Postgres has reaped the old
  // backends, so the next boot cannot connect either. Stay up on that rejection
  // only — do not resume after uncaughtException (Node leaves the process in an
  // undefined state).
  process.on("uncaughtException", (error) => {
    logger.error("uncaughtException", error);
    void stop().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", reason);
    if (isTooManyDatabaseConnections(reason)) return;
    void stop().finally(() => process.exit(1));
  });

  // Direct runs can already be active while the scheduler waits for capacity.
  // Register shutdown first so those runs can drain even before Graphile starts.
  for (let attempt = 0; !stopping; attempt += 1) {
    try {
      await jobHost.start(jobHandlers);
      break;
    } catch (error) {
      if (stopping) return;
      if (!isTooManyDatabaseConnections(error)) {
        await stop();
        throw error;
      }
      logger.error("worker job host start waiting on database capacity", error);
      await sleep(databaseCapacityBackoffMs(attempt), undefined, { signal: shutdown.signal }).catch(
        () => undefined,
      );
    }
  }
  if (stopping) return;
  reconciler.start();

  logger.info("worker ready", { degraded: secrets.describe().capabilities.degraded ?? false });
}

runAsSystem("worker process", main).catch(async (error) => {
  logger.error("worker startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  // jobHost.start retries 53300 without bound above, so a saturated Postgres at
  // that step does not reach here. Other startup failures still exit.
  process.exit(1);
});
