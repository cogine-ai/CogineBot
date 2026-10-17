import { createHmac } from "node:crypto";
import type {
  AdapterContext,
  ConnectedConnector,
  ConnectorCall,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { catalogToolPrefix } from "./approval-effect.js";
import { collectPages, filterCatalog } from "./composio-connector.js";
import {
  assertBoundConnectorAccount,
  connectorAccountRevision,
} from "./connector-account-binding.js";
import {
  combineSignals,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  DIRECT_TOOL_LIMIT,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  parseConnectorToolArgs,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import {
  callRemoteMcpTool,
  listRemoteMcpTools,
  type RemoteTransportDependencies,
} from "./remote-mcp.js";
import { isVitestRuntime } from "./test-runtime.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

const API_BASE = "https://api.pipedream.com";
const MCP_ENDPOINT = "https://remote.mcp.pipedream.net/v3";
const DIRECTORY_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Local authorization selector, never forwarded as an upstream business argument. */
export const PIPEDREAM_CONNECTION_SELECTOR = "__connectionId";
export const MAX_PIPEDREAM_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface PipedreamConnectorConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: "development" | "production";
  identitySecret: string;
}

export interface PipedreamEnvironmentValues {
  pipedreamClientId?: string;
  pipedreamClientSecret?: string;
  pipedreamProjectId?: string;
  pipedreamEnvironment?: string;
  encryptionKey: string;
}

export function pipedreamConfigFromEnv(
  values: PipedreamEnvironmentValues,
): PipedreamConnectorConfig {
  return {
    clientId: values.pipedreamClientId ?? "",
    clientSecret: values.pipedreamClientSecret ?? "",
    projectId: values.pipedreamProjectId ?? "",
    environment: values.pipedreamEnvironment === "production" ? "production" : "development",
    identitySecret: values.encryptionKey,
  };
}

export type PipedreamConnectorDependencies = RemoteTransportDependencies;

type PipedreamApp = {
  id: string;
  name_slug: string;
  name: string;
  img_src?: string;
};

type PipedreamAccount = {
  id: string;
  healthy?: boolean;
  dead?: boolean;
  app?: PipedreamApp;
};

export function isPipedreamEnabled(config: Partial<PipedreamConnectorConfig>): boolean {
  return Boolean(
    config.clientId &&
      config.clientSecret &&
      config.projectId &&
      config.environment &&
      config.identitySecret &&
      !isVitestRuntime(),
  );
}

function securePipedreamConnectUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Pipedream did not return a secure HTTPS connect URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Pipedream did not return a secure HTTPS connect URL");
  }
  return url;
}

export class PipedreamConnector implements ManagedConnectorProvider {
  private accessToken?: { value: string; expiresAt: number };
  private accessTokenRequest?: Promise<string>;
  private directory?: { value: PipedreamApp[]; expiresAt: number };
  private directoryRequest?: Promise<PipedreamApp[]>;

  constructor(
    private readonly config: PipedreamConnectorConfig,
    private readonly dependencies: PipedreamConnectorDependencies = {},
  ) {}

  describe() {
    return {
      id: "pipedream",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]> {
    const [apps, connected] = await Promise.all([
      this.apps(),
      this.listConnectedExternalIds(context),
    ]);
    const connectedSet = new Set(connected);
    return filterCatalog(
      apps.map((app) => ({
        connectorId: "pipedream",
        slug: app.name_slug,
        name: app.name,
        logo: app.img_src ?? null,
        connected: connectedSet.has(app.name_slug),
        noAuth: false,
      })),
      query ?? "",
    );
  }

  async warmDirectory(): Promise<void> {
    await this.apps();
  }

  async listConnectedExternalIds(context: AdapterContext): Promise<string[]> {
    const accounts = await this.accounts(context);
    return [
      ...new Set(
        accounts
          .filter((account) => account.healthy !== false && account.dead !== true)
          .map((account) => account.app?.name_slug)
          .filter((slug): slug is string => Boolean(slug)),
      ),
    ];
  }

  private async allTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const connections = this.connections(context);
    const apps = connections.map((connection) => connection.externalId);
    if (apps.length === 0) return [];
    const token = await this.token();
    const groups = await Promise.all(
      [...new Set(apps)].map(async (app) => {
        try {
          const accounts = connections.filter((connection) => connection.externalId === app);
          if (accounts.length > 1 && accounts.some((account) => !this.accountRef(account))) {
            throw new Error(
              "Reconnect each Pipedream account before using multiple accounts for this app",
            );
          }
          const perAccount = await Promise.all(
            accounts.map(async (connection) => {
              try {
                return { connection, tools: await this.accountTools(context, connection, token) };
              } catch (error) {
                getLogger().error(
                  "pipedream account discovery failed",
                  sanitizeConnectorError(error),
                );
                return { connection, tools: [] };
              }
            }),
          );
          const byName = new Map<
            string,
            Array<{ connection: ConnectedConnector; tool: ConnectorTool }>
          >();
          for (const { connection, tools } of perAccount) {
            for (const tool of tools) {
              const variants = byName.get(tool.name) ?? [];
              variants.push({ connection, tool });
              byName.set(tool.name, variants);
            }
          }
          return [...byName.values()].map((variants) => {
            const first = variants[0]!;
            if (accounts.length === 1) return first.tool;
            const schemas = variants.map(({ connection, tool }) => {
              const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
              if (properties && PIPEDREAM_CONNECTION_SELECTOR in properties) {
                throw new Error("Pipedream tool schema conflicts with the local account selector");
              }
              return {
                ...tool.inputSchema,
                properties: {
                  ...properties,
                  [PIPEDREAM_CONNECTION_SELECTOR]: {
                    type: "string",
                    const: connection.id,
                    description: `Authorized account: ${connection.displayName} (${connection.id})`,
                  },
                },
                required: [
                  ...new Set([
                    ...(Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []),
                    PIPEDREAM_CONNECTION_SELECTOR,
                  ]),
                ],
              };
            });
            return {
              ...first.tool,
              inputSchema: { type: "object", anyOf: schemas },
              route: {
                connectorId: "pipedream",
                resourceId: app,
                toolName: first.tool.route!.toolName,
                catalogGroup: app,
              },
            };
          });
        } catch (error) {
          // A single unavailable app must not hide tools from other connections.
          getLogger().error(
            `pipedream discovery failed for app ${app}:`,
            sanitizeConnectorError(error),
          );
          return [];
        }
      }),
    );
    return groups.flat();
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const tools = await this.allTools(context);
    if (tools.length <= DIRECT_TOOL_LIMIT) return tools;
    return lazyCatalogTools(
      catalogToolPrefix("pipedream"),
      "pipedream",
      "app",
      catalogEntries(tools),
    );
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    if (!call.route?.resourceId) {
      if (call.route?.toolName !== CATALOG_EXECUTE) return undefined;
      const resolved = resolveCatalogCall(call, catalogEntries(await this.allTools(context)));
      return this.resolveCall(resolved.call, context);
    }
    const app = call.route.resourceId;
    const accounts = this.connections(context).filter(
      (connection) => connection.externalId === app,
    );
    const bound = assertBoundConnectorAccount(call, context);
    const selectedId = call.args[PIPEDREAM_CONNECTION_SELECTOR];
    const requestedId = bound?.id ?? call.connectionId ?? call.route.connectionId ?? selectedId;
    if (selectedId !== undefined && typeof selectedId !== "string")
      throw new Error("Select a valid Pipedream account");
    if (bound && selectedId !== undefined && selectedId !== bound.id)
      throw new Error("Pipedream account selection does not match its authorized route");
    const connection =
      requestedId !== undefined
        ? accounts.find((candidate) => candidate.id === requestedId)
        : accounts.length === 1
          ? accounts[0]
          : undefined;
    if (!connection) throw new Error("Select an available Pipedream account explicitly");
    if (accounts.length > 1 && !this.accountRef(connection))
      throw new Error("Reconnect the selected Pipedream account before using it");
    const tools = await this.accountTools(context, connection, await this.token());
    const tool = tools.find((candidate) => candidate.route?.toolName === call.route?.toolName);
    if (!tool) throw new Error("Pipedream tool is unavailable for the selected account");
    const businessArgs = { ...call.args };
    // Only the adapter-added selector is consumed; upstream `accountId` remains untouched.
    delete businessArgs[PIPEDREAM_CONNECTION_SELECTOR];
    const parsed = parseConnectorToolArgs(tool.inputSchema, businessArgs);
    const explicit = selectedId !== undefined || accounts.length > 1;
    // Keep the local selector in the persisted approval arguments, so approval
    // replay remains executable through the same published multi-account schema.
    const selectedTool = explicit
      ? {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties: {
              ...(tool.inputSchema.properties as Record<string, unknown> | undefined),
              [PIPEDREAM_CONNECTION_SELECTOR]: { type: "string", const: connection.id },
            },
            required: [
              ...new Set([
                ...(Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []),
                PIPEDREAM_CONNECTION_SELECTOR,
              ]),
            ],
          },
        }
      : tool;
    return {
      tool: selectedTool,
      call: {
        ...call,
        connectionId: connection.id,
        route: tool.route,
        args: {
          ...parsed,
          ...(explicit ? { [PIPEDREAM_CONNECTION_SELECTOR]: connection.id } : {}),
        },
      },
    };
  }

  private connections(context: AdapterContext): ConnectedConnector[] {
    return (
      context.connectedConnections?.filter(
        (connection) => connection.connectorId === "pipedream",
      ) ?? []
    );
  }

  private accountRef(connection: ConnectedConnector): string | undefined {
    const ref = connection.providerRef?.trim();
    return ref && ref !== connection.externalId ? ref : undefined;
  }

  private async accountTools(
    context: AdapterContext,
    connection: ConnectedConnector,
    token: string,
  ): Promise<ConnectorTool[]> {
    const tools = await listRemoteMcpTools({
      endpoint: MCP_ENDPOINT,
      headers: this.mcpHeaders(context, connection.externalId, token, this.accountRef(connection)),
      signal: context.signal,
      fetch: this.dependencies.fetch,
      resolveHostname: this.dependencies.resolveHostname,
    });
    return tools.map((tool) => {
      if (
        (tool.inputSchema.properties as Record<string, unknown> | undefined)?.[
          PIPEDREAM_CONNECTION_SELECTOR
        ] !== undefined
      ) {
        throw new Error("Pipedream tool schema conflicts with the local account selector");
      }
      return {
        ...tool,
        route: {
          connectorId: "pipedream",
          resourceId: connection.externalId,
          toolName: tool.name,
          catalogGroup: connection.externalId,
          connectionId: connection.id,
          resourceRevision: connectorAccountRevision(connection),
        },
      };
    });
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (isLazyCatalogControlRoute(call.route)) {
      try {
        yield* executeLazyCatalogControl(
          call,
          catalogEntries(await this.allTools(context)),
          (resolved) => this.execute(resolved, context),
        );
      } catch (error) {
        yield { type: "error", message: sanitizeConnectorError(error) };
      }
      return;
    }
    const app = call.route?.resourceId;
    if (!app) {
      yield { type: "error", message: "Pipedream app route is missing" };
      return;
    }
    let token: string | undefined;
    try {
      const resolved = await this.resolveCall(call, context);
      if (!resolved) throw new Error("Pipedream account route is missing");
      call = resolved.call;
      const connection = assertBoundConnectorAccount(call, context);
      if (!connection) throw new Error("Pipedream account route is missing");
      token = await this.token();
      const businessArgs = { ...call.args };
      delete businessArgs[PIPEDREAM_CONNECTION_SELECTOR];
      const result = await callRemoteMcpTool(
        {
          endpoint: MCP_ENDPOINT,
          headers: this.mcpHeaders(context, app, token, this.accountRef(connection)),
          signal: context.signal,
          fetch: this.dependencies.fetch,
          resolveHostname: this.dependencies.resolveHostname,
        },
        call.route?.toolName ?? call.tool,
        businessArgs,
      );
      yield {
        type: "result",
        data: redactConnectorPayload(result, [token, this.config.clientSecret]),
      };
    } catch (error) {
      yield {
        type: "error",
        message: sanitizeConnectorError(
          error,
          [token, this.config.clientSecret].filter((value): value is string => Boolean(value)),
        ),
      };
    }
  }

  async begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }> {
    const response = await this.request<{ connect_link_url: string }>(
      `/v1/connect/${encodeURIComponent(this.config.projectId)}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          external_user_id: this.externalUserId(context),
          success_redirect_uri: request.redirectUrl,
          error_redirect_uri: request.redirectUrl,
          scope: "connect:accounts:read connect:accounts:write",
        }),
      },
      context.signal,
    );
    const url = securePipedreamConnectUrl(response.connect_link_url);
    url.searchParams.set("app", request.provider);
    return { authorizationUrl: url.toString(), state: request.provider };
  }

  async complete(request: { state: string }): Promise<{ connectionRef: string }> {
    return { connectionRef: request.state };
  }

  /**
   * Prefer a concrete Pipedream account id over the app slug so multi-account
   * revoke can target one authorization. spaceId is required for the hashed
   * external user id Pipedream uses to scope accounts.
   */
  async resolveConnectedAccountId(
    userId: string,
    slug: string,
    currentRef: string | null | undefined,
    excludeIds: string[] = [],
    spaceId?: string,
  ): Promise<string | undefined> {
    const excluded = new Set(excludeIds.filter(Boolean));
    const current = currentRef?.trim() || undefined;
    if (!spaceId) {
      return current && current !== slug && !excluded.has(current) ? current : undefined;
    }
    // Concrete account ids are already authoritative; do not reassign them.
    if (current && current !== slug) {
      return excluded.has(current) ? undefined : current;
    }
    const context = {
      userId,
      spaceId,
      signal: AbortSignal.timeout(30_000),
    } as AdapterContext;
    const accounts = await this.accounts(context, slug);
    const ids = accounts
      .filter((account) => account.healthy !== false && account.dead !== true)
      .map((account) => account.id)
      .filter(Boolean);
    return ids.find((id) => !excluded.has(id));
  }

  async connectionReady(context: AdapterContext, externalId: string): Promise<boolean> {
    const accounts = await this.accounts(context, externalId);
    return accounts.some(
      (account) =>
        account.app?.name_slug === externalId && account.healthy !== false && account.dead !== true,
    );
  }

  async revoke(externalId: string, context: AdapterContext): Promise<void> {
    let accounts: PipedreamAccount[];
    try {
      accounts = await this.accounts(context);
    } catch (error) {
      // Listing failed before any DELETE — mark so callers can restore local retry state.
      if (error && typeof error === "object") {
        (error as { remoteRevokePreDelete?: boolean }).remoteRevokePreDelete = true;
      }
      throw error;
    }
    const targets = accounts.filter(
      (account) => account.id === externalId || account.app?.name_slug === externalId,
    );
    await Promise.all(
      targets.map((account) =>
        this.request(
          `/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts/${encodeURIComponent(account.id)}`,
          { method: "DELETE" },
          context.signal,
        ),
      ),
    );
  }

  /**
   * Delete remote accounts for `slug` that no local row still references. Used when a
   * begin loses a race to revoke and only the app slug is available — never revoke by
   * slug alone, or every sibling authorization would be deleted.
   */
  async revokeUnreferencedAccounts(
    slug: string,
    keepAccountIds: string[],
    context: AdapterContext,
  ): Promise<void> {
    const keep = new Set(keepAccountIds.filter(Boolean));
    const accounts = await this.accounts(context, slug);
    const orphans = accounts.filter(
      (account) =>
        account.app?.name_slug === slug &&
        account.healthy !== false &&
        account.dead !== true &&
        !keep.has(account.id),
    );
    await Promise.all(
      orphans.map((account) =>
        this.request(
          `/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts/${encodeURIComponent(account.id)}`,
          { method: "DELETE" },
          context.signal,
        ),
      ),
    );
  }

  private externalUserId(context: AdapterContext): string {
    return `rkz_${createHmac("sha256", this.config.identitySecret)
      .update(`${context.spaceId}:${context.userId}`)
      .digest("hex")}`;
  }

  private mcpHeaders(
    context: AdapterContext,
    app: string,
    accessToken: string,
    accountId?: string,
  ): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      "x-pd-project-id": this.config.projectId,
      "x-pd-environment": this.config.environment,
      "x-pd-external-user-id": this.externalUserId(context),
      "x-pd-app-slug": app,
      ...(accountId ? { "x-pd-account-id": accountId } : {}),
    };
  }

  private async apps(): Promise<PipedreamApp[]> {
    if (this.directory && this.directory.expiresAt > Date.now()) return this.directory.value;
    if (this.directoryRequest) return this.directoryRequest;
    this.directoryRequest = this.loadApps();
    try {
      return await this.directoryRequest;
    } finally {
      this.directoryRequest = undefined;
    }
  }

  private async loadApps(): Promise<PipedreamApp[]> {
    const apps: PipedreamApp[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: "100", has_actions: "true" });
      if (after) query.set("after", after);
      const response = await this.request<{
        data?: PipedreamApp[];
        page_info?: { end_cursor?: string };
      }>(`/v1/connect/apps?${query}`);
      apps.push(...(response.data ?? []));
      after = response.page_info?.end_cursor;
      if (!after || apps.length >= 5_000) break;
    }
    this.directory = { value: apps, expiresAt: Date.now() + DIRECTORY_TTL_MS };
    return apps;
  }

  private async accounts(context: AdapterContext, app?: string): Promise<PipedreamAccount[]> {
    return collectPages(async (after) => {
      const query = new URLSearchParams({
        external_user_id: this.externalUserId(context),
        limit: "100",
      });
      if (app) query.set("app", app);
      if (after) query.set("after", after);
      const response = await this.request<{
        data?: PipedreamAccount[];
        page_info?: { end_cursor?: string };
      }>(
        `/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts?${query}`,
        {},
        context.signal,
      );
      return { items: response.data ?? [], cursor: response.page_info?.end_cursor };
    }, 20);
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const token = await this.token();
    const requestAbort = combineSignals(signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    const response = await (this.dependencies.fetch ?? globalThis.fetch)(`${API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-pd-environment": this.config.environment,
        ...init.headers,
      },
      signal: requestAbort,
    });
    if (response.status === 401) this.accessToken = undefined;
    const body = await readPipedreamBody(response, requestAbort);
    if (!response.ok) {
      throw new Error(
        sanitizeConnectorError(`Pipedream returned HTTP ${response.status}: ${body}`, [token]),
      );
    }
    return (body ? JSON.parse(body) : {}) as T;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    if (this.accessTokenRequest) return this.accessTokenRequest;
    this.accessTokenRequest = this.fetchToken();
    try {
      return await this.accessTokenRequest;
    } finally {
      this.accessTokenRequest = undefined;
    }
  }

  private async fetchToken(): Promise<string> {
    const requestAbort = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await (this.dependencies.fetch ?? globalThis.fetch)(
      `${API_BASE}/v1/oauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          scope: "connect:*",
        }),
        signal: requestAbort,
      },
    );
    const text = await readPipedreamBody(response, requestAbort);
    const body = (response.ok && text ? JSON.parse(text) : {}) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!response.ok || !body.access_token) {
      throw new Error(`Pipedream authentication failed: ${body.error ?? response.status}`);
    }
    this.accessToken = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3_600) * 1_000,
    };
    return body.access_token;
  }
}

async function readPipedreamBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_PIPEDREAM_RESPONSE_BYTES) {
    const cancel = response.body?.cancel() ?? Promise.resolve();
    // A hanging cancel must not outlive the shared deadline.
    await withAbort(
      cancel.catch(() => undefined),
      signal,
    ).catch(() => undefined);
    throw new Error("Pipedream response is too large.");
  }
  try {
    const bytes = await readBodyCapped(response, MAX_PIPEDREAM_RESPONSE_BYTES, signal);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error("Pipedream response is too large.");
    }
    throw error;
  }
}
