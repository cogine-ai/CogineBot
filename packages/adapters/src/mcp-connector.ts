import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  SecretStore,
} from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { McpServerHealth } from "@rakazo/contracts";
import { isLocalMcpHost } from "@rakazo/contracts";
import type { McpServer, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  assertManagedPluginActive,
  lockPluginInstall,
  PluginInstallInactiveError,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { catalogToolPrefix } from "./approval-effect.js";
import {
  combineSignals,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";
import { credentialDigest } from "./credential-digest.js";
import { appendToolCompletionAudit } from "./executor.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  DIRECT_TOOL_LIMIT,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import type { McpOAuthBroker, OAuthMaterial } from "./mcp-oauth.js";
import { oauthMaterialSecrets } from "./mcp-oauth.js";
import type { McpHealthUpdate } from "./mcp-server-health.js";
import { mcpHealthError, recordMcpServerHealth } from "./mcp-server-health.js";
import { McpSession } from "./mcp-transport.js";
import { actorMayUsePrivateEndpoint } from "./private-endpoint.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { withAbort } from "./web-ssrf.js";

const STDIO_STARTUP_MS = 30_000;
const STDIO_IDLE_MS = 15 * 60_000;
const DISCOVERY_MS = 20_000;
const DISCOVERY_BACKOFF_MS = 30_000;
const DISCOVERY_BACKOFF_MAX_MS = 5 * 60_000;
const UNAVAILABLE_ROUTE = " connector unavailable ";

type DiscoveryFailure = {
  checkedAt: Date;
  until: number;
  delay: number;
  health: McpHealthUpdate;
};
type DiscoveryState = {
  revision: number;
  checkedAt: Date;
  failure?: DiscoveryFailure;
};

type SessionEntry = {
  session: McpSession;
  revision: number;
  material: OAuthMaterial;
  digest?: string;
  ref?: string;
  recordId?: string;
  active: number;
  lastUsed: number;
  stdio: boolean;
  retired?: boolean;
  closing?: Promise<void>;
};
type PendingSession = {
  revision: number;
  promise: Promise<SessionEntry>;
  invalidated?: boolean;
  ref?: string;
};

function diagnosticSecrets(material: OAuthMaterial): string[] {
  // A custom header or environment variable can carry credentials under any name.
  // Error diagnostics can echo configuration; mask every configured value there.
  return [
    ...oauthMaterialSecrets(material),
    ...Object.values(material.headers ?? {}),
    ...Object.values(material.env ?? {}),
  ];
}

function hasAllowedTools(server: Pick<McpServer, "allowAllTools" | "allowedTools">): boolean {
  return (
    server.allowAllTools ||
    (Array.isArray(server.allowedTools) &&
      server.allowedTools.some((name) => typeof name === "string"))
  );
}

function unavailableTool(server: McpServer): ConnectorTool {
  return {
    name: `mcp__${server.slug}__unavailable`,
    description:
      "This configured MCP server is temporarily unavailable. Call for its current status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    route: {
      connectorId: "mcp",
      resourceId: server.id,
      resourceRevision: server.revision,
      toolName: UNAVAILABLE_ROUTE,
      catalogGroup: server.slug,
    },
  };
}

/** Runtime MCP connector. The actor's shared server policy is checked on every call. */
/**
 * Stale allowlist entries are filtered out below with no error. Discovery already has the
 * live tool list, so compare once and warn when string allowlist names are missing from the
 * server. Non-string JSON values are ignored for both the missing list and the ratio.
 */
export function allowlistDrift(
  allowedTools: unknown,
  offered: Array<{ name: string }>,
): { missing: string[]; offered: number; stringAllowedCount: number } {
  const names = new Set(offered.map((tool) => tool.name));
  const allowed = Array.isArray(allowedTools) ? allowedTools : [];
  const stringAllowed = allowed.filter((name): name is string => typeof name === "string");
  return {
    missing: stringAllowed.filter((name) => !names.has(name)),
    offered: names.size,
    stringAllowedCount: stringAllowed.length,
  };
}

function reportAllowlistDrift(
  server: { allowAllTools: boolean; allowedTools: unknown; slug: string },
  offered: Array<{ name: string }>,
  context: { spaceId: string; botId?: string },
): void {
  if (server.allowAllTools) return;
  const drift = allowlistDrift(server.allowedTools, offered);
  if (drift.missing.length === 0) return;
  getLogger().warn(
    `mcp allowlist drift on ${server.slug}: ${drift.missing.length}/${drift.stringAllowedCount} allowed tools are not offered (server offers ${drift.offered})`,
    {
      spaceId: context.spaceId,
      botId: context.botId,
      // Cap the list: the point is to name the drift, not to print an allowlist.
      missing: drift.missing.slice(0, 10),
    },
  );
}

export class McpConnector implements ConnectorProvider {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly connecting = new Map<string, PendingSession>();
  private readonly discoveries = new Map<string, DiscoveryState>();
  private readonly probes = new Map<string, Promise<McpServerHealth>>();
  private readonly shutdown = new AbortController();
  private readonly retired = new Set<SessionEntry>();
  private reaper?: ReturnType<typeof setInterval>;
  // Discovery runs more than once per run: once up front, then again on every lazy
  // catalog access. Each attempt needs its own executionId.
  private discoverySeq = 0;
  private lastObservationTime = 0;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly options: {
      stdioEnabled?: boolean;
      allowedCommands?: string[];
      network?: RemoteTransportDependencies;
      /** Audit sink for failed discovery. Without it the log line stays the only trace. */
      events?: Pick<ThreadEvents, "append">;
      allowPrivateEndpoint?: boolean;
      discoveryTimeoutMs?: number;
    } = {},
    private readonly oauth?: McpOAuthBroker,
  ) {
    this.unsubscribe =
      this.secrets.onChange?.((ref) => {
        for (const [key, entry] of this.sessions) if (entry.ref === ref) this.retire(key, entry);
        for (const entry of this.connecting.values())
          if (entry.ref === ref) entry.invalidated = true;
      }) ?? (() => {});
  }

  describe() {
    return {
      id: "mcp",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const tools = await this.authorizedTools(context);
    if (tools.length <= DIRECT_TOOL_LIMIT) return tools;
    // The catalog wrappers must not be named `mcp_*`: Anthropic rejects Claude Code OAuth
    // requests that carry a tool whose name starts with "mcp_" (single underscore) with a
    // misleading "You're out of extra usage" 400, on every model. Direct MCP tools are
    // `mcp__server__tool` (double underscore) and are accepted; keep the wrappers off "mcp_".
    return lazyCatalogTools(catalogToolPrefix("mcp"), "mcp", "MCP", catalogEntries(tools));
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    // Wrappers have no resourceId; real tools always do.
    if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
    return resolveCatalogCall(call, catalogEntries(await this.authorizedTools(context)));
  }

  private async authorizedTools(context: AdapterContext): Promise<ConnectorTool[]> {
    if (!context.botId) return [];
    const servers = await this.prisma.mcpServer.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        enabled: true,
      },
    });
    const groups = await Promise.all(
      servers.filter(hasAllowedTools).map(async (server) => {
        try {
          return (await this.discoverServer(server, context)).tools;
        } catch (error) {
          // A removed or inactive installation does not expose a stand-in.
          getLogger().warn("MCP discovery was not available", {
            reason: sanitizeConnectorError(error),
          });
          return [];
        }
      }),
    );
    return groups.flat();
  }

  /** An explicit check can recover a server before its automatic cooldown expires. */
  async check(server: McpServer, context: AdapterContext): Promise<McpServerHealth> {
    if (!server.enabled || server.spaceId !== context.spaceId || server.userId !== context.userId)
      throw new Error("MCP server is unavailable");
    context.signal.throwIfAborted();
    this.shutdown.signal.throwIfAborted();
    const key = `${this.sessionKey(server, context)} ${server.revision}`;
    let probe = this.probes.get(key);
    if (!probe) {
      probe = this.discoverServer(server, { ...context, signal: this.shutdown.signal }, true)
        .then(({ health, checkedAt }) => ({ ...health, checkedAt: checkedAt.toISOString() }))
        .finally(() => this.probes.delete(key));
      this.probes.set(key, probe);
    }
    return withAbort(probe, context.signal);
  }

  private async discoverServer(server: McpServer, context: AdapterContext, force = false) {
    context.signal.throwIfAborted();
    const key = this.sessionKey(server, context);
    const previous = this.discoveries.get(key);
    this.lastObservationTime = Math.max(Date.now(), this.lastObservationTime + 1);
    const checkedAt = new Date(this.lastObservationTime);
    const recovered =
      server.healthRevision === server.revision &&
      server.healthStatus === "ok" &&
      (server.healthCheckedAt?.getTime() ?? 0) > (previous?.failure?.checkedAt.getTime() ?? 0);
    const backoff =
      previous?.revision === server.revision && !recovered ? previous.failure : undefined;
    const signal = combineSignals(
      context.signal,
      this.shutdown.signal,
      AbortSignal.timeout(this.options.discoveryTimeoutMs ?? DISCOVERY_MS),
    );
    const active = async () => {
      if (server.installId)
        await withAbort(assertManagedPluginActive(this.prisma, server.installId, context), signal);
    };
    try {
      await active();
    } catch (error) {
      if (!(error instanceof PluginInstallInactiveError) || !server.installId) throw error;
      const installing = await withAbort(
        this.prisma.capabilityInstall.findFirst({
          where: {
            id: server.installId,
            spaceId: context.spaceId,
            userId: context.userId,
            kind: "plugin",
            clientNonce: { not: null },
            status: "installing",
          },
          select: { id: true },
        }),
        signal,
      );
      if (!installing) throw error;
      const health: McpHealthUpdate = {
        status: "installing",
        message: null,
        code: null,
        toolCount: null,
      };
      const write = recordMcpServerHealth(this.prisma, server, health, checkedAt, force);
      if (force) await withAbort(write, signal).catch(() => undefined);
      return { tools: [], health, checkedAt };
    }
    if (
      !force &&
      backoff &&
      Date.now() < backoff.until &&
      this.sessions.get(key)?.revision !== server.revision
    ) {
      return {
        tools: [unavailableTool(server)],
        health: backoff.health,
        checkedAt: backoff.checkedAt,
      };
    }
    this.startReaper();

    let entry: SessionEntry | undefined;
    let listed: Awaited<ReturnType<McpSession["listTools"]>> | undefined;
    let health: McpHealthUpdate;
    try {
      entry = await this.acquire(server, context, signal);
      listed = await withAbort(entry.session.listTools({ signal }), signal);
      health = { status: "ok", message: null, code: null, toolCount: listed.tools.length };
    } catch (error) {
      context.signal.throwIfAborted();
      this.shutdown.signal.throwIfAborted();
      const reason = signal.aborted ? new Error("MCP tool discovery timed out") : error;
      const secrets = entry ? diagnosticSecrets(entry.material) : [];
      health = mcpHealthError(reason, secrets);
      getLogger().error(`mcp discovery failed for server ${server.slug}:`, health.message);
      await withAbort(
        this.recordDiscoveryFailure(server.slug, reason, context, checkedAt.getTime(), secrets),
        combineSignals(context.signal, AbortSignal.timeout(1_000)),
      ).catch(() => undefined);
    } finally {
      if (entry) this.release(entry);
    }
    if (listed) await active();
    context.signal.throwIfAborted();
    this.shutdown.signal.throwIfAborted();
    const latest = this.discoveries.get(key);
    if (
      !latest ||
      latest.revision < server.revision ||
      (latest.revision === server.revision && latest.checkedAt < checkedAt)
    ) {
      const observation: DiscoveryState = { revision: server.revision, checkedAt };
      if (!listed) {
        if (entry) this.retire(key, entry);
        const delay = Math.min(
          !force && backoff ? backoff.delay * 2 : DISCOVERY_BACKOFF_MS,
          DISCOVERY_BACKOFF_MAX_MS,
        );
        observation.failure = {
          checkedAt,
          delay,
          until: Date.now() + delay,
          health,
        };
      }
      this.discoveries.set(key, observation);
      const write = recordMcpServerHealth(this.prisma, server, health, checkedAt, force);
      if (force) await withAbort(write, signal).catch(() => undefined);
    }
    if (!listed) return { tools: [unavailableTool(server)], health, checkedAt };
    reportAllowlistDrift(server, listed.tools, context);
    const tools = listed.tools
      .filter(
        (tool) =>
          tool.name !== UNAVAILABLE_ROUTE &&
          (server.allowAllTools ||
            (Array.isArray(server.allowedTools) && server.allowedTools.includes(tool.name))),
      )
      .map(
        (tool): ConnectorTool => ({
          name: `mcp__${server.slug}__${tool.name}`,
          description: tool.description ?? tool.name,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          route: {
            connectorId: "mcp",
            resourceId: server.id,
            resourceRevision: server.revision,
            toolName: tool.name,
            catalogGroup: server.slug,
          },
        }),
      );
    return { tools, health, checkedAt };
  }

  /**
   * Leave a failed discovery where every other tool outcome is already visible, as an
   * `agent.tool.completed` event with `outcome: "error"`. Losing a server's tools is
   * otherwise invisible: the run still ends `completed` and the model simply never sees
   * them. Discovery outside a run (settings, tool pickers) has no thread to attach to, so
   * there the log line stays the only trace.
   */
  private async recordDiscoveryFailure(
    slug: string,
    error: unknown,
    context: AdapterContext,
    startedAt: number,
    secrets: string[],
  ): Promise<void> {
    const events = this.options.events;
    if (!events || !context.runId || !context.botId) return;
    const run = await this.prisma.run
      .findUnique({ where: { id: context.runId }, select: { threadId: true } })
      .catch(() => null);
    if (!run) return;
    await appendToolCompletionAudit(
      { events },
      {
        spaceId: context.spaceId,
        threadId: run.threadId,
        botId: context.botId,
        runId: context.runId,
      },
      {
        name: `mcp__${slug}__discovery`,
        executionId: `mcp-discovery-${slug}-${context.runId}-${this.discoverySeq++}`,
        durationMs: Date.now() - startedAt,
        error,
      },
      secrets,
    );
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.route?.connectorId !== "mcp") {
      yield { type: "error", message: `MCP route required for ${call.tool}` };
      return;
    }
    if (isLazyCatalogControlRoute(call.route)) {
      try {
        yield* executeLazyCatalogControl(
          call,
          catalogEntries(await this.authorizedTools(context)),
          (resolved) => this.execute(resolved, context),
        );
      } catch (error) {
        yield { type: "error", message: sanitizeConnectorError(error) };
      }
      return;
    }
    if (!call.route.resourceId) {
      yield { type: "error", message: `MCP route required for ${call.tool}` };
      return;
    }
    if (!context.botId) {
      yield { type: "error", message: "MCP tools require a bot context" };
      return;
    }
    const server = await this.prisma.mcpServer.findFirst({
      where: {
        id: call.route.resourceId,
        spaceId: context.spaceId,
        userId: context.userId,
        enabled: true,
      },
    });
    const statusOnly = call.route.toolName === UNAVAILABLE_ROUTE;
    if (
      !server ||
      (statusOnly
        ? !hasAllowedTools(server)
        : !server.allowAllTools &&
          !(
            Array.isArray(server.allowedTools) && server.allowedTools.includes(call.route.toolName)
          ))
    ) {
      yield { type: "error", message: "MCP tool is not enabled for this space" };
      return;
    }
    if (call.route.resourceRevision !== server.revision) {
      yield { type: "error", message: "MCP server permissions or credentials changed; retry" };
      return;
    }
    if (statusOnly) {
      try {
        if (server.installId)
          await assertManagedPluginActive(this.prisma, server.installId, context);
        const observation = this.discoveries.get(this.sessionKey(server, context));
        const failure = observation?.failure;
        const recovered =
          server.healthRevision === server.revision &&
          server.healthStatus === "ok" &&
          (server.healthCheckedAt?.getTime() ?? 0) > (failure?.checkedAt.getTime() ?? 0);
        const health =
          observation?.revision === server.revision && !recovered ? failure?.health : undefined;
        yield health
          ? {
              type: "error",
              message: health.message ?? "MCP server is temporarily unavailable",
              ...(health.code ? { code: health.code } : {}),
            }
          : { type: "result", data: "Refresh the tool catalog to get the current MCP tools." };
      } catch {
        yield { type: "error", message: "MCP tool is not enabled for this space" };
      }
      return;
    }
    // Capture material before callTool so a concurrent eviction/replace cannot
    // drop this call's OAuth secrets from model-visible redaction. Recompute via
    // oauthMaterialSecrets(material) so in-place token refresh stays covered.
    let material: OAuthMaterial | undefined;
    let admissionRejected = false;
    let entry: SessionEntry | undefined;
    let response: ConnectorEvent;
    const sessionKey = this.sessionKey(server, context);
    try {
      entry = await this.acquire(server, context, context.signal);
      const { session } = entry;
      material = entry.material;
      let dispatched: ReturnType<McpSession["callTool"]> | undefined;
      const dispatch = () => {
        context.signal.throwIfAborted();
        dispatched = session.callTool(call.route!.toolName, call.args, {
          signal: context.signal,
        });
        // The transport may reject before the DB admission transaction has returned.
        void dispatched.catch(() => undefined);
      };
      if (server.installId) {
        try {
          await this.prisma.$transaction(async (tx) => {
            await lockPluginInstall(tx, server.installId!);
            await assertManagedPluginActive(tx, server.installId!, context);
            const current = await tx.mcpServer.findFirst({
              where: {
                id: server.id,
                installId: server.installId,
                spaceId: context.spaceId,
                userId: context.userId,
                enabled: true,
              },
            });
            if (
              !current?.enabled ||
              current.revision !== call.route!.resourceRevision ||
              (!current.allowAllTools &&
                !(
                  Array.isArray(current.allowedTools) &&
                  current.allowedTools.includes(call.route!.toolName)
                ))
            ) {
              throw new Error("MCP server permissions or credentials changed; retry");
            }
            // Invocation is the dispatch boundary. Do not await network work under
            // this lock: OAuth refresh needs its own parent/material transaction.
            dispatch();
          });
        } catch (error) {
          // Once invoked, a transaction acknowledgement failure must not discard
          // the original outcome or dispatch the tool a second time.
          if (!dispatched) {
            admissionRejected = true;
            throw error;
          }
        }
      } else {
        dispatch();
      }
      const result = await dispatched!;
      const secrets = material ? oauthMaterialSecrets(material) : [];
      response = { type: "result", data: redactConnectorPayload(result, secrets) };
    } catch (error) {
      // A thrown call means the transport or auth broke; drop the session so the next call reconnects.
      const secrets = material ? oauthMaterialSecrets(material) : [];
      // Rejecting queued work must not close a session another already-dispatched
      // call is using. Permission changes are enforced by DB checks on every call.
      if (!admissionRejected && !context.signal.aborted && entry) this.retire(sessionKey, entry);
      const health = mcpHealthError(error, secrets);
      response = {
        type: "error",
        message: health.message ?? "MCP tool failed",
        ...(health.code ? { code: health.code } : {}),
      };
    } finally {
      if (entry) this.release(entry);
    }
    yield response;
  }

  async close(): Promise<void> {
    this.unsubscribe();
    this.shutdown.abort();
    clearInterval(this.reaper);
    await Promise.allSettled(this.probes.values());
    await Promise.allSettled([...this.connecting.values()].map(({ promise }) => promise));
    await Promise.allSettled(
      [...this.sessions.values(), ...this.retired].map((entry) => this.closeEntry(entry)),
    );
    this.sessions.clear();
    this.connecting.clear();
    this.retired.clear();
    this.discoveries.clear();
  }

  private sessionKey(server: McpServer, context: AdapterContext): string {
    // Identity headers are applied once, at connect time, so a session is only
    // valid for the identity it connected as. The key has to carry that identity.
    return `${server.id} ${context.spaceId} ${context.userId}`;
  }

  private startReaper(): void {
    this.reaper ??= setInterval(() => this.reapIdle(), 60_000).unref();
  }

  reapIdle(now = Date.now()): void {
    for (const [key, entry] of this.sessions) {
      if (entry.stdio && entry.active === 0 && now - entry.lastUsed >= STDIO_IDLE_MS)
        this.retire(key, entry);
    }
    for (const [key, observation] of this.discoveries) {
      if (now - (observation.failure?.until ?? observation.checkedAt.getTime()) >= STDIO_IDLE_MS)
        this.discoveries.delete(key);
    }
  }

  private retire(key: string, entry: SessionEntry): void {
    if (this.sessions.get(key) !== entry) return;
    this.sessions.delete(key);
    entry.retired = true;
    this.retired.add(entry);
    this.closeRetired(entry);
  }

  private closeRetired(entry: SessionEntry): void {
    if (entry.active === 0 && entry.retired) void this.closeEntry(entry);
  }

  private closeEntry(entry: SessionEntry): Promise<void> {
    entry.closing ??= entry.session
      .close()
      .catch(() => undefined)
      .finally(() => {
        this.retired.delete(entry);
      });
    return entry.closing;
  }

  private release(entry: SessionEntry): void {
    entry.active--;
    entry.lastUsed = Date.now();
    this.closeRetired(entry);
  }

  private async acquire(
    server: McpServer,
    context: AdapterContext,
    signal: AbortSignal,
  ): Promise<SessionEntry> {
    signal.throwIfAborted();
    this.shutdown.signal.throwIfAborted();
    const entry = await withAbort(this.sessionFor(server, { ...context, signal }), signal);
    signal.throwIfAborted();
    this.shutdown.signal.throwIfAborted();
    if (entry.retired) throw new Error("MCP session changed; retry");
    entry.active++;
    return entry;
  }

  private async sessionFor(server: McpServer, context: AdapterContext): Promise<SessionEntry> {
    context.signal.throwIfAborted();
    this.shutdown.signal.throwIfAborted();
    const sessionKey = this.sessionKey(server, context);
    const existing = this.sessions.get(sessionKey);
    if (existing && existing.revision === server.revision) {
      if (existing.ref && server.secretId) {
        try {
          const plaintext = await this.secrets.load(existing.ref, {
            recordId: existing.recordId ?? server.secretId,
            signal: context.signal,
          });
          if (credentialDigest(plaintext) !== existing.digest) this.retire(sessionKey, existing);
        } catch (error) {
          context.signal.throwIfAborted();
          if (!(error instanceof SecretStoreUnavailableError)) {
            this.retire(sessionKey, existing);
            throw new Error("MCP server credentials are unavailable");
          }
          // Keep live sessions usable during a store outage. Never log the error:
          // provider errors can contain credential values or private response data.
          getLogger().warn("MCP secret revalidation failed; retaining the live session");
        }
      }
      // A fresh read can detect rotation and synchronously evict this entry.
      if (this.sessions.get(sessionKey) === existing) return existing;
      return this.sessionFor(server, context);
    }
    const pending = this.connecting.get(sessionKey);
    if (pending?.revision === server.revision) return pending.promise;
    if ((pending?.revision ?? existing?.revision ?? 0) > server.revision)
      throw new Error("MCP server permissions or credentials changed; retry");
    if (pending) {
      await withAbort(pending.promise, context.signal).catch(() => undefined);
      return this.sessionFor(server, context);
    }
    if (existing) this.retire(sessionKey, existing);

    let connected: SessionEntry | undefined;
    const connectSignal = combineSignals(
      this.shutdown.signal,
      AbortSignal.timeout(STDIO_STARTUP_MS),
    );
    const promise = this.connectSession(
      server,
      { ...context, signal: connectSignal },
      (ref, recordId, digest) => {
        const entry = this.connecting.get(sessionKey);
        if (entry?.promise === promise) entry.ref = ref;
        const live = this.sessions.get(sessionKey);
        if (live && live === connected) {
          live.ref = ref;
          live.recordId = recordId;
          live.digest = digest;
        }
      },
    ).then(async ({ session, material, ref, digest, recordId }) => {
      if (connectSignal.aborted || this.connecting.get(sessionKey)?.invalidated) {
        await session.close();
        connectSignal.throwIfAborted();
        throw new Error("Secret changed during MCP connection; retry");
      }
      connected = {
        session,
        revision: server.revision,
        material,
        ref,
        digest,
        recordId,
        active: 0,
        lastUsed: Date.now(),
        stdio: server.transport === "stdio",
      };
      this.sessions.set(sessionKey, connected);
      if (connected.stdio) this.startReaper();
      return connected;
    });
    this.connecting.set(sessionKey, { revision: server.revision, promise });
    try {
      return await promise;
    } finally {
      if (this.connecting.get(sessionKey)?.promise === promise) this.connecting.delete(sessionKey);
    }
  }

  private async connectSession(
    server: McpServer,
    context: AdapterContext,
    onRef: (ref: string, recordId: string, digest?: string) => void,
  ): Promise<{
    session: McpSession;
    material: OAuthMaterial;
    ref?: string;
    digest?: string;
    recordId?: string;
  }> {
    const session = new McpSession({ name: `rakazo-${server.slug}` });
    // Hoisted so a throw after the secret is decoded can still hand the material out.
    let material: OAuthMaterial | undefined;
    try {
      const secret = server.secretId
        ? await withAbort(
            this.prisma.secret.findFirst({
              where: {
                id: server.secretId,
                spaceId: context.spaceId,
                userId: context.userId,
              },
            }),
            context.signal,
          )
        : null;
      if (server.secretId && !secret) throw new Error("MCP server credentials are unavailable");
      let ref = secret?.ciphertext;
      let recordId = secret?.id;
      let digest: string | undefined;
      if (secret) {
        onRef(secret.ciphertext, secret.id);
        try {
          const plaintext = await withAbort(
            this.secrets.load(secret.ciphertext, {
              recordId: secret.id,
              signal: context.signal,
            }),
            context.signal,
          );
          material = JSON.parse(plaintext) as OAuthMaterial;
          digest = credentialDigest(plaintext);
        } catch {
          context.signal.throwIfAborted();
          throw new Error("MCP server credentials are unavailable");
        }
      } else {
        material = {};
      }
      const loaded = { material, ...(secret ? { secretId: secret.id } : {}) };
      const args = Array.isArray(server.args) ? server.args.map(String) : [];
      const env = { ...(material.env ?? {}) };
      context.signal.throwIfAborted();
      if (server.transport === "stdio") {
        if (!this.options.stdioEnabled) throw new Error("MCP stdio is disabled");
        await session.connectStdio({
          command: String(server.command ?? ""),
          args,
          env,
          allowedCommands: this.options.allowedCommands ?? [],
          timeoutMs: STDIO_STARTUP_MS,
          signal: context.signal,
        });
      } else {
        if (!server.endpoint) throw new Error("MCP endpoint is required");
        const endpoint = new URL(server.endpoint);
        const localHttp = endpoint.protocol === "http:" && isLocalMcpHost(endpoint.hostname);
        const allowPrivateEndpoint = await withAbort(
          actorMayUsePrivateEndpoint(
            this.prisma,
            context.userId,
            this.options.allowPrivateEndpoint === true,
          ),
          context.signal,
        );
        const authProvider =
          !localHttp && this.oauth
            ? await withAbort(
                this.oauth.providerFor(server, context, loaded, (record) => {
                  ref = record.ref;
                  recordId = record.id;
                  digest = credentialDigest(JSON.stringify(record.material));
                  onRef(ref, recordId, digest);
                }),
                context.signal,
              )
            : undefined;
        const staticToken = material.secret
          ? material.secret.startsWith("Bearer ")
            ? material.secret
            : `Bearer ${material.secret}`
          : undefined;
        const headers = {
          ...(material.headers ?? {}),
          ...(staticToken ? { Authorization: staticToken } : {}),
        };
        context.signal.throwIfAborted();
        await session.connectRemote({
          url: server.endpoint,
          urlPolicy: {
            allowHttpLocalhost: localHttp,
            allowLocalHttpCredentials: localHttp,
            allowPrivateEndpoint,
          },
          transport: server.transport === "sse" ? "sse" : "streamable-http",
          allowLegacySse: server.transport === "sse",
          headerPolicy: { headers },
          fallbackToSse: false,
          authProvider,
          network: this.options.network,
          signal: context.signal,
        });
      }
      return { session, material, ref, digest, recordId };
    } catch (error) {
      await session.close().catch(() => undefined);
      // Redact here, while the material is still in hand. This one rejection is handed
      // to every caller waiting on the same pending connect, and none of them can see
      // the secrets: the session never reached `sessions`. Sanitizing per caller would
      // cover only whoever looked first.
      if (!material) throw error;
      throw new Error(
        mcpHealthError(error, diagnosticSecrets(material)).message ?? "MCP connection failed",
      );
    }
  }
}
