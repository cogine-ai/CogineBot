import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ArtifactStore,
  ConnectorCall,
  ConnectorEvent,
  ConnectorTool,
  ManagedConnectorProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { ConnectionCatalogItem, NativeBeginInputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { z } from "zod";
import {
  assertBoundConnectorAccount,
  connectionAuthorizationRevision,
  connectorAccountRevision,
} from "../connector-account-binding.js";
import { asRecord } from "../connector-http.js";
import { redactConnectorPayload } from "../connector-safety.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  DIRECT_TOOL_LIMIT,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  loadCatalogEntry,
} from "../lazy-tool-catalog.js";
import { actorMayUsePrivateEndpoint } from "../private-endpoint.js";
import type { RemoteTransportDependencies } from "../remote-mcp.js";
import { assertSafeRemoteUrl } from "../remote-mcp.js";
import type { NativeAction, NativeActionContext } from "./action.js";
import { NativeActionError } from "./action.js";
import { NativeOAuthAuthorities, NOTION_VERSION } from "./authorities.js";
import { calendarActions } from "./calendar.js";
import { coginexActions } from "./coginex.js";
import { NativeConfigSettingsSchema, NativeConfigStore } from "./config.js";
import { nativeEffectCheckpoint } from "./effect.js";
import { NativeHttpClient } from "./http.js";
import { knowaiActions } from "./knowai.js";
import { notionActions } from "./notion.js";
import { NativeOAuthStore } from "./oauth.js";
import { validateNativeInput } from "./validation.js";

const APPS = [
  { slug: "coginex", name: "CogineX", actions: coginexActions },
  { slug: "knowai", name: "Knowai", actions: knowaiActions },
  { slug: "google-calendar", name: "Google Calendar", actions: calendarActions },
  { slug: "notion", name: "Notion", actions: notionActions },
] as const;

/** Fixed native actions coexist with third-party long-tail and custom connectors. */
export class NativeConnectorProvider implements ManagedConnectorProvider {
  readonly configurations: NativeConfigStore;
  readonly oauth: NativeOAuthStore;
  private readonly authorities: NativeOAuthAuthorities;
  constructor(
    private readonly prisma: PrismaClient,
    secrets: SecretStore,
    apiUrl: string,
    private readonly options: {
      network?: RemoteTransportDependencies;
      allowPrivateEndpoint?: boolean;
      artifacts: ArtifactStore;
    },
  ) {
    this.configurations = new NativeConfigStore(
      prisma,
      secrets,
      apiUrl,
      options.network,
      options.allowPrivateEndpoint,
    );
    this.authorities = new NativeOAuthAuthorities(options.network);
    this.oauth = new NativeOAuthStore(prisma, secrets, this.configurations, this.authorities);
  }
  describe() {
    return {
      id: "native",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }
  close(): Promise<void> {
    return this.authorities.close();
  }

  async catalog(context: AdapterContext, query?: string): Promise<ConnectionCatalogItem[]> {
    await this.oauth.expireSessions(context);
    const connected = new Set(await this.listConnectedExternalIds(context));
    return APPS.filter((app) => !query || app.name.toLowerCase().includes(query.toLowerCase())).map(
      (app) => ({
        connectorId: "native",
        slug: app.slug,
        name: app.name,
        logo: null,
        noAuth: false,
        connected: connected.has(app.slug),
      }),
    );
  }
  async listConnectedExternalIds(context: AdapterContext): Promise<string[]> {
    const rows = await this.prisma.connection.findMany({
      where: {
        userId: context.userId,
        spaceId: context.spaceId,
        connectorId: "native",
        status: "connected",
      },
      select: { provider: true },
    });
    return [...new Set(rows.map((row) => row.provider))];
  }
  async connectionReady(context: AdapterContext, externalId: string): Promise<boolean> {
    return (await this.listConnectedExternalIds(context)).includes(externalId);
  }

  /** Legacy app-level lifecycle cannot create/adopt a native account. */
  async begin(
    _request: { provider: string; redirectUrl: string },
    _context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }> {
    throw new NativeActionError(
      "invalid_input",
      "Choose this application's native connection source first.",
    );
  }
  async complete(
    _request: { state: string; code?: string },
    _context: AdapterContext,
  ): Promise<{ connectionRef: string }> {
    throw new NativeActionError(
      "invalid_input",
      "Native accounts are completed by their one-use backend callback.",
    );
  }
  async revoke(connectionRef: string, context: AdapterContext): Promise<void> {
    await this.oauth.disconnect(connectionRef, context);
  }

  async connect(
    input: z.infer<typeof NativeBeginInputSchema>,
    context: AdapterContext,
  ): Promise<{ connectionId: string; authorizationUrl: string | null }> {
    const config = await this.configurations.require(input.configId);
    if (config.appId === "knowai") {
      if (!input.credential)
        throw new NativeActionError("authorization_required", "Enter a tenant machine API key.");
      const settings = NativeConfigSettingsSchema.parse(config.config);
      const client = new NativeHttpClient(
        settings.endpoint!,
        async () => ({ kind: "api_key", value: input.credential! }),
        {
          signal: context.signal,
          readOnly: true,
          headers: { "X-Tenant-ID": settings.tenantId! },
          network: this.options.network,
          allowPrivateEndpoint: await actorMayUsePrivateEndpoint(
            this.prisma,
            context.userId,
            this.options.allowPrivateEndpoint ?? false,
          ),
        },
      );
      try {
        const response = asRecord(
          (await client.request({ method: "GET", path: "/api/v1/auth/me" })).body,
        );
        const data = asRecord(response?.data),
          tenant = asRecord(data?.tenant);
        const tenantId = tenant?.id;
        if (
          response?.success !== true ||
          data?.tenant_required === true ||
          !(
            typeof tenantId === "string" ||
            (typeof tenantId === "number" && Number.isSafeInteger(tenantId))
          ) ||
          String(tenantId) !== settings.tenantId
        )
          throw new NativeActionError(
            "authorization_required",
            "This API key does not identify the configured Knowai tenant.",
          );
        return {
          ...(await this.oauth.connectKnowaiMachine(
            config,
            input.credential,
            {
              authority: settings.endpoint!,
              subject: `machine:${randomUUID()}`,
              tenant: settings.tenantId,
              displayName: config.label,
              context: {
                credentialKind: "machine_key",
                scopeAuthority: "local_configuration",
                upstreamKeyScopeVerified: false,
              },
            },
            context,
            input.previousConnectionId,
          )),
          authorizationUrl: null,
        };
      } finally {
        await client.close();
      }
    }
    if (config.appId === "coginex")
      throw new NativeActionError(
        "not_configured",
        "The CogineX native MCP authorization binding is not ready on this instance.",
      );
    if (config.credentialKind === "oauth") {
      if (input.credential)
        throw new NativeActionError(
          "invalid_input",
          "OAuth connections do not accept a pasted account credential.",
        );
      return this.oauth.begin(config.id, context, input.previousConnectionId);
    }
    if (!input.credential)
      throw new NativeActionError(
        "authorization_required",
        "Enter this user's Notion integration token.",
      );
    return {
      ...(await this.oauth.connectNotionToken(
        config.id,
        input.credential,
        context,
        input.previousConnectionId,
      )),
      authorizationUrl: null,
    };
  }

  private async authorizedTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const result: ConnectorTool[] = [];
    for (const selected of context.connectedConnections ?? []) {
      if (selected.connectorId !== "native") continue;
      try {
        const live = await this.oauth.authorization(selected.id, context);
        const app = APPS.find((app) => app.slug === live.connection.provider);
        if (!app) continue;
        const settings = NativeConfigSettingsSchema.parse(live.config.config);
        const scopes = live.grant.scopes.filter((scope) => settings.scopes.includes(scope));
        const account = {
          ...selected,
          providerRef: live.connection.providerRef ?? undefined,
          revision: connectionAuthorizationRevision(live.connection),
        };
        if (
          selected.providerRef !== account.providerRef ||
          (selected.revision && selected.revision !== account.revision)
        )
          continue;
        const suffix = createHash("sha256").update(selected.id).digest("hex").slice(0, 10);
        for (const action of app.actions) {
          if (!this.permitted(action, scopes, settings.capabilities)) continue;
          result.push({
            name: `native__${app.slug.replaceAll("-", "_")}__${suffix}__${action.id.replaceAll(".", "_")}`,
            description: `${action.description} (${live.connection.displayName})`,
            inputSchema: action.inputSchema,
            readOnly: action.readOnly,
            route: {
              connectorId: "native",
              resourceId: app.slug,
              resourceRevision: connectorAccountRevision(account),
              connectionId: selected.id,
              toolName: action.id,
              catalogGroup: `${app.name} · ${live.connection.displayName}`,
            },
          });
        }
      } catch {
        /* Unavailable accounts never select a sibling or hide other sources. */
      }
    }
    return result;
  }
  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const tools = await this.authorizedTools(context);
    return tools.length <= DIRECT_TOOL_LIMIT
      ? tools
      : lazyCatalogTools("native", "native", "native applications", catalogEntries(tools));
  }
  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
    const entry = loadCatalogEntry(catalogEntries(await this.authorizedTools(context)), call.args);
    const args = call.args.arguments;
    validateNativeInput(entry.tool.inputSchema, args);
    return {
      tool: entry.tool,
      call: {
        ...call,
        tool: entry.tool.name,
        args: args as Record<string, unknown>,
        route: entry.tool.route,
      },
    };
  }
  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (isLazyCatalogControlRoute(call.route)) {
      yield* executeLazyCatalogControl(
        call,
        catalogEntries(await this.authorizedTools(context)),
        (resolved) => this.execute(resolved, context),
      );
      return;
    }
    let http: NativeHttpClient | undefined;
    const redactions: string[] = [];
    try {
      const selected = assertBoundConnectorAccount(call, context);
      if (!selected || call.route?.connectorId !== "native")
        throw new NativeActionError(
          "authorization_required",
          "Select the original authorized account for this action.",
        );
      const action = APPS.find((app) => app.slug === selected.externalId)?.actions.find(
        (action) => action.id === call.route?.toolName,
      );
      if (!action)
        throw new NativeActionError("invalid_input", "This native action is unavailable.");
      validateNativeInput(action.inputSchema, call.args);
      const bound = await this.oauth.authorization(selected.id, context);
      redactions.push(
        bound.auth.tokens.accessToken,
        ...(bound.auth.tokens.refreshToken ? [bound.auth.tokens.refreshToken] : []),
      );
      const settings = NativeConfigSettingsSchema.parse(bound.config.config);
      const scopes = bound.grant.scopes.filter((scope) => settings.scopes.includes(scope));
      const revalidate = async () => {
        const live = await this.oauth.authorization(selected.id, context);
        for (const value of [live.auth.tokens.accessToken, live.auth.tokens.refreshToken])
          if (value && !redactions.includes(value)) redactions.push(value);
        const account = {
          ...selected,
          providerRef: live.connection.providerRef ?? undefined,
          revision: connectionAuthorizationRevision(live.connection),
        };
        if (
          connectorAccountRevision(account) !== call.route?.resourceRevision ||
          !this.permitted(
            action,
            live.grant.scopes.filter((scope) => settings.scopes.includes(scope)),
            settings.capabilities,
          )
        )
          throw new NativeActionError(
            "authorization_required",
            "The original account authorization changed. Review this action again.",
          );
        return live;
      };
      await revalidate();
      const checkpoint = action.readOnly
        ? {
            recovery: undefined,
            checkpoint: async () => {
              throw new NativeActionError(
                "invalid_input",
                "A read-only action cannot record a write receipt.",
              );
            },
          }
        : await nativeEffectCheckpoint(
            this.prisma,
            call,
            context,
            async () => {
              await revalidate();
            },
            (value) => redactConnectorPayload(value, redactions) as Record<string, unknown>,
          );
      let requestTokenVersion = bound.grant.tokenVersion;
      http = new NativeHttpClient(
        bound.config.appId === "notion"
          ? "https://api.notion.com"
          : bound.config.appId === "knowai"
            ? settings.endpoint!
            : "https://www.googleapis.com/calendar/v3",
        async () => {
          const live = await revalidate();
          redactions.push(live.auth.tokens.accessToken);
          requestTokenVersion = live.grant.tokenVersion;
          return {
            kind: bound.config.appId === "knowai" ? "api_key" : "bearer",
            value: live.auth.tokens.accessToken,
          };
        },
        {
          network: this.options.network,
          signal: context.signal,
          readOnly: action.readOnly,
          allowPrivateEndpoint: await actorMayUsePrivateEndpoint(
            this.prisma,
            context.userId,
            this.options.allowPrivateEndpoint ?? false,
          ),
          headers:
            bound.config.appId === "notion"
              ? { "Notion-Version": NOTION_VERSION }
              : bound.config.appId === "knowai"
                ? { "X-Tenant-ID": settings.tenantId! }
                : undefined,
          onUnauthorized: async () => {
            const current = await revalidate();
            if (current.grant.tokenVersion === requestTokenVersion)
              await this.oauth.authorization(selected.id, context, true);
          },
          timeoutMs: action.id === "knowai.qa.ask" ? 300_000 : 30_000,
        },
      );
      const actionContext: NativeActionContext = {
        operationId: call.executionId,
        signal: context.signal,
        ...checkpoint,
        principal: {
          subject: bound.grant.subject,
          tenant: bound.grant.tenant,
          scopes,
          capabilities: settings.capabilities,
          knowledgeBaseIds: settings.knowledgeBaseIds,
          context: bound.auth.identity.context,
        },
        request: (request) => http!.request(request),
        callMcp: async () => {
          throw new NativeActionError(
            "not_configured",
            "The native MCP account binding is unavailable.",
          );
        },
        readArtifact: async (id) => {
          await revalidate();
          const row = await this.prisma.artifact.findFirst({
            where: { id, userId: context.userId, spaceId: context.spaceId },
          });
          if (!row || !Number.isSafeInteger(row.size) || row.size < 0)
            throw new NativeActionError(
              "resource_unavailable",
              "This artifact is unavailable to the selected owner and Space.",
            );
          return {
            bytes: await this.options.artifacts.get(row.storageKey, context),
            name: row.name,
            mimeType: row.mimeType,
          };
        },
        validateResourceUrl: async (url) => {
          await assertSafeRemoteUrl(url, this.options.network?.resolveHostname, {
            allowPrivateEndpoint: await actorMayUsePrivateEndpoint(
              this.prisma,
              context.userId,
              this.options.allowPrivateEndpoint ?? false,
            ),
          });
        },
      };
      yield {
        type: "result",
        data: redactConnectorPayload(await action.execute(call.args, actionContext), redactions),
      };
    } catch (error) {
      const failure =
        error instanceof NativeActionError
          ? error
          : new NativeActionError(
              "temporarily_unavailable",
              "The selected native action could not be completed.",
            );
      yield {
        type: "error",
        message:
          failure.options.retryAfterSeconds !== undefined
            ? `${failure.message} Service backoff: ${Math.ceil(failure.options.retryAfterSeconds)} seconds.`
            : failure.message,
        code: failure.kind,
        uncertain: failure.options.uncertain,
        recovery: failure.options.recovery
          ? (redactConnectorPayload(failure.options.recovery, redactions) as Record<
              string,
              unknown
            >)
          : undefined,
      };
    } finally {
      await http?.close();
    }
  }
  private permitted(
    action: NativeAction,
    scopes: readonly string[],
    capabilities: readonly string[],
  ): boolean {
    return (
      (!action.scopesAnyOf?.length || action.scopesAnyOf.some((scope) => scopes.includes(scope))) &&
      (!action.capabilities?.length ||
        action.capabilities.every((capability) => capabilities.includes(capability)))
    );
  }
}
