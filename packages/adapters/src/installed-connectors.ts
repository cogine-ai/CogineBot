import { domainToUnicode } from "node:url";
import { MIMEType } from "node:util";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import {
  AuthSchema,
  applyCredential,
  asRecord,
  assertNoSensitiveQuery,
  HeaderName,
  isSensitiveHeader,
  PublicHeadersSchema,
  readBoundedText,
  requireCredential,
} from "./connector-http.js";
import {
  combineSignals,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";
import { executeGraphqlOperation, GraphqlConfigSchema } from "./graphql-connectors.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  catalogGroupLabel,
  DIRECT_TOOL_LIMIT,
  disambiguateInstalledToolNames,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  MAX_DESCRIPTION_LENGTH,
  parseConnectorToolArgs,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import type { OpenApiImportDiagnostic } from "./openapi-import.js";
import {
  assertOpenApiArguments,
  compileOpenApiDocument,
  OpenApiCompileError,
  parseOpenApiText,
} from "./openapi-import.js";
import { actorMayUsePrivateEndpoint } from "./private-endpoint.js";
import type { RemoteTransportDependencies, RemoteUrlPolicy } from "./remote-mcp.js";
import {
  assertSafeRemoteUrl,
  callRemoteMcpTool,
  createSafeRemoteFetch,
  listRemoteMcpTools,
} from "./remote-mcp.js";

const ModelHeaderName = HeaderName.refine(
  (name) => !isSensitiveHeader(name),
  "Sensitive headers cannot be model-controlled",
);
const McpAuthSchema = z
  .object({
    type: z.enum(["none", "bearer", "header"]).default("none"),
    name: HeaderName.optional(),
  })
  .default({ type: "none" });

const McpConfigSchema = z.object({
  preset: z.enum(["treg", "custom"]).default("custom"),
  auth: McpAuthSchema,
  headers: PublicHeadersSchema,
});

const ApiOperationSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2_000).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/").max(2_048),
  inputSchema: z.record(z.string(), z.unknown()).default({
    type: "object",
    properties: {},
  }),
  readOnly: z.boolean().default(false),
  queryParameters: z.array(z.string().min(1).max(120)).default([]),
  headerParameters: z.array(ModelHeaderName).default([]),
  importPolicy: z.literal("openapi-v1").optional(),
});

const ApiConfigSchema = z.object({
  auth: AuthSchema,
  headers: PublicHeadersSchema,
  operations: z.array(ApiOperationSchema).min(1).max(100),
});

type ApiOperation = z.infer<typeof ApiOperationSchema>;
type InstalledRow = {
  id: string;
  kind: string;
  name: string;
  source: string;
  secretId: string | null;
  config: unknown;
};

export type RemoteConnectorDependencies = RemoteTransportDependencies;
type RemoteRequestPolicy = RemoteConnectorDependencies & RemoteUrlPolicy;

export class InstalledConnectorProvider implements ConnectorProvider {
  private readonly strictInputSchemas = new WeakSet<Record<string, unknown>>();

  private readonly parseArgs = (
    tool: ConnectorTool,
    args: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (!this.strictInputSchemas.has(tool.inputSchema))
      return parseConnectorToolArgs(tool.inputSchema, args);
    assertOpenApiArguments(tool.inputSchema, args);
    return args;
  };

  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly remote: RemoteConnectorDependencies = {},
    /** Instance flag letting every user reach loopback / LAN endpoints. */
    private readonly allowPrivateEndpoint = false,
  ) {}

  /** Decided per request from the install owner's current standing, so an install saved
   * before an ownership change cannot keep reaching private endpoints. */
  private async remoteFor(context: AdapterContext): Promise<RemoteRequestPolicy> {
    return {
      ...this.remote,
      allowPrivateEndpoint: await actorMayUsePrivateEndpoint(
        this.prisma,
        context.userId,
        this.allowPrivateEndpoint,
      ),
    };
  }

  describe() {
    return {
      id: "installed",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const tools = await this.authorizedTools(context);
    if (tools.length <= DIRECT_TOOL_LIMIT) return tools;
    return lazyCatalogTools("installed", "installed", "API", catalogEntries(tools));
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    // Wrappers have no resourceId; real tools always do.
    if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
    return resolveCatalogCall(
      call,
      catalogEntries(await this.authorizedTools(context)),
      this.parseArgs,
    );
  }

  async assertCallArgs(call: ConnectorCall, context: AdapterContext): Promise<boolean> {
    if (call.route?.connectorId !== "installed" || !call.route.resourceId) return false;
    const install = await this.authorizedInstall(call.route.resourceId, context);
    if (!install) throw new Error("Installed connector is unavailable");
    if (install.kind !== "api") return false;
    const config = ApiConfigSchema.parse(install.config);
    const operation = config.operations.find((candidate) => candidate.id === call.route?.toolName);
    if (!operation) throw new Error("API operation is unavailable");
    if (operation.importPolicy !== "openapi-v1") return false;
    // Installed API routes bind an immutable install ID and declare no separate revision.
    if (call.route.resourceRevision !== undefined)
      throw new Error("Installed connector revision changed");
    assertOpenApiArguments(operation.inputSchema, call.args);
    return true;
  }

  private authorizedInstall(id: string, context: AdapterContext): Promise<InstalledRow | null> {
    return this.prisma.capabilityInstall.findFirst({
      where: {
        id,
        spaceId: context.spaceId,
        userId: context.userId,
        kind: { in: ["mcp", "api", "graphql"] },
      },
    });
  }

  private async authorizedTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const installs = await this.prisma.capabilityInstall.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        kind: { in: ["mcp", "api", "graphql"] },
      },
      orderBy: { createdAt: "asc" },
    });
    // Only MCP installs reach the network during discovery.
    const remote = installs.some((install) => install.kind === "mcp")
      ? await this.remoteFor(context)
      : this.remote;
    const tools: ConnectorTool[] = [];
    for (let offset = 0; offset < installs.length; offset += 4) {
      const groups = await Promise.all(
        installs
          .slice(offset, offset + 4)
          .map((install) => this.discoverInstall(install, context, remote)),
      );
      tools.push(...groups.flat());
    }
    return disambiguateInstalledToolNames(tools);
  }

  private async discoverInstall(
    install: InstalledRow,
    context: AdapterContext,
    remote: RemoteRequestPolicy,
  ): Promise<ConnectorTool[]> {
    const catalogGroup = catalogGroupLabel(install.name, install.kind, install.id);
    try {
      if (install.kind === "mcp") {
        const config = McpConfigSchema.parse(install.config);
        const credential = await this.loadCredential(install, context);
        const tools = await listRemoteMcpTools({
          ...remote,
          endpoint: install.source,
          headers: connectorHeaders(config, credential),
          signal: context.signal,
        });
        return tools.map((tool) => ({
          ...tool,
          route: {
            connectorId: "installed",
            resourceId: install.id,
            toolName: tool.name,
            catalogGroup,
          },
        }));
      }
      if (install.kind === "api") {
        const config = ApiConfigSchema.parse(install.config);
        for (const operation of config.operations)
          if (operation.importPolicy === "openapi-v1")
            this.strictInputSchemas.add(operation.inputSchema);
        return config.operations.map((operation) => ({
          name: operation.name ?? operation.id,
          description: operationDescription(
            `${operation.method} ${operation.path}`,
            operation.description,
          ),
          inputSchema: operation.inputSchema,
          // The stored method is authoritative: a read-only flag cannot make a write a read.
          readOnly: operation.readOnly && operation.method === "GET",
          route: {
            connectorId: "installed",
            resourceId: install.id,
            toolName: operation.id,
            catalogGroup,
          },
        }));
      }
      if (install.kind === "graphql") {
        const config = GraphqlConfigSchema.parse(install.config);
        return config.operations.map((operation) => ({
          name: operation.name ?? operation.id,
          description: operationDescription(
            `${operation.operationType} ${operation.fieldName}`,
            operation.description,
          ),
          inputSchema: operation.inputSchema,
          readOnly: operation.readOnly && operation.operationType === "query",
          route: {
            connectorId: "installed",
            resourceId: install.id,
            toolName: operation.id,
            catalogGroup,
          },
        }));
      }
    } catch {
      // One unavailable user-installed source must not hide the other tools.
    }
    return [];
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.route?.connectorId === "installed" && isLazyCatalogControlRoute(call.route)) {
      try {
        yield* executeLazyCatalogControl(
          call,
          catalogEntries(await this.authorizedTools(context)),
          (resolved) => this.execute(resolved, context),
          this.parseArgs,
        );
      } catch (error) {
        yield { type: "error", message: sanitizeConnectorError(error) };
      }
      return;
    }
    const installId = call.route?.resourceId;
    if (!installId) {
      yield { type: "error", message: "Installed connector route is missing" };
      return;
    }
    const install = await this.authorizedInstall(installId, context);
    if (!install) {
      yield { type: "error", message: "Installed connector is unavailable" };
      return;
    }
    let credential: string | undefined;
    try {
      credential = await this.loadCredential(install, context);
      const remote = await this.remoteFor(context);
      if (install.kind === "mcp") {
        const config = McpConfigSchema.parse(install.config);
        const result = await callRemoteMcpTool(
          {
            ...remote,
            endpoint: install.source,
            headers: connectorHeaders(config, credential),
            signal: context.signal,
          },
          call.route?.toolName ?? call.tool,
          call.args,
        );
        yield {
          type: "result",
          data: redactConnectorPayload(result, credential ? [credential] : []),
        };
        return;
      }
      if (install.kind === "graphql") {
        const config = GraphqlConfigSchema.parse(install.config);
        const operation = config.operations.find(
          (candidate) => candidate.id === (call.route?.toolName ?? call.tool),
        );
        if (!operation) throw new Error("GraphQL operation is unavailable");
        const result = await executeGraphqlOperation(
          install.source,
          config,
          operation,
          call.args,
          credential,
          context.signal,
          remote,
        );
        yield {
          type: "result",
          data: redactConnectorPayload(result, credential ? [credential] : []),
        };
        return;
      }
      const config = ApiConfigSchema.parse(install.config);
      const operation = config.operations.find(
        (candidate) => candidate.id === (call.route?.toolName ?? call.tool),
      );
      if (!operation) throw new Error("API operation is unavailable");
      const result = await executeApiOperation(
        install.source,
        config,
        operation,
        call.args,
        credential,
        context.signal,
        remote,
      );
      yield {
        type: "result",
        data: redactConnectorPayload(result, credential ? [credential] : []),
      };
    } catch (error) {
      yield {
        type: "error",
        message: sanitizeConnectorError(error, credential ? [credential] : []),
      };
    }
  }

  private async loadCredential(
    install: Pick<InstalledRow, "secretId">,
    context: AdapterContext,
  ): Promise<string | undefined> {
    if (!install.secretId) return undefined;
    const row = await this.prisma.secret.findFirst({
      where: {
        id: install.secretId,
        spaceId: context.spaceId,
        userId: context.userId,
      },
    });
    return row ? await this.secrets.load(row.ciphertext, row.id) : undefined;
  }
}

export async function verifyMcpInstall(input: {
  source: string;
  config: unknown;
  credential?: string;
  signal?: AbortSignal;
  remote?: RemoteConnectorDependencies;
  /** Loopback / LAN endpoint escape: deployment owner or instance flag. */
  allowPrivateEndpoint?: boolean;
}): Promise<{ config: Record<string, unknown>; toolCount: number }> {
  assertNoSensitiveQuery(input.source);
  const config = McpConfigSchema.parse(input.config);
  requireCredential(config.auth, input.credential);
  const tools = await listRemoteMcpTools({
    ...input.remote,
    endpoint: input.source,
    headers: connectorHeaders(config, input.credential),
    signal: input.signal,
    allowPrivateEndpoint: input.allowPrivateEndpoint,
  });
  if (tools.length === 0) throw new Error("MCP server returned no tools");
  return { config, toolCount: tools.length };
}

export async function prepareApiInstall(input: {
  source: string;
  config: Record<string, unknown>;
  credential?: string;
  signal?: AbortSignal;
  remote?: RemoteConnectorDependencies;
  /** Loopback / LAN endpoint escape: deployment owner or instance flag. */
  allowPrivateEndpoint?: boolean;
}): Promise<{ source: string; config: Record<string, unknown>; operationCount: number }> {
  if (input.config.openApi === true || input.config.openapi === true)
    throw new Error("OpenAPI import requires preview confirmation");
  if (
    Object.hasOwn(input.config, "importPolicy") ||
    (Array.isArray(input.config.operations) &&
      input.config.operations.some((value) => {
        const operation = asRecord(value);
        return operation && Object.hasOwn(operation, "importPolicy");
      }))
  )
    throw new Error("OpenAPI import policy requires preview confirmation");
  const auth = AuthSchema.parse(input.config.auth);
  requireCredential(auth, input.credential);
  const headers = PublicHeadersSchema.parse(input.config.headers);
  assertNoSensitiveQuery(input.source);
  const remote = { ...input.remote, allowPrivateEndpoint: input.allowPrivateEndpoint };
  await assertSafeRemoteUrl(input.source, remote.resolveHostname, remote);
  const config = ApiConfigSchema.parse({ auth, headers, operations: input.config.operations });
  return {
    source: input.source,
    config,
    operationCount: config.operations.length,
  };
}

export async function prepareOpenApiInstall(input: Parameters<typeof prepareApiInstall>[0]) {
  const auth = AuthSchema.parse(input.config.auth);
  requireCredential(auth, input.credential);
  const headers = PublicHeadersSchema.parse(input.config.headers);
  assertNoSensitiveQuery(input.source);
  const remote = { ...input.remote, allowPrivateEndpoint: input.allowPrivateEndpoint };
  const documentUrl = new URL(input.source);
  const documentHeaders: Record<string, string> = {
    accept: "application/json, application/yaml;q=0.9",
    ...headers,
  };
  applyCredential(documentUrl, documentHeaders, auth, input.credential);
  let document: Record<string, unknown>;
  try {
    document = await loadOpenApiDocument(documentUrl, documentHeaders, input.signal, remote);
  } catch (error) {
    if (error instanceof OpenApiCompileError) throw error;
    throw new OpenApiCompileError("fetch_failed");
  }
  const compiled = compileOpenApiDocument(document);
  await assertSafeRemoteUrl(compiled.baseUrl, remote.resolveHostname, remote);
  const protectedHeaders = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  if (auth.type === "bearer") protectedHeaders.add("authorization");
  if (auth.type === "header" && auth.name) protectedHeaders.add(auth.name.toLowerCase());
  const contentTypeHeaders = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === "content-type",
  );
  const contentTypeAuth = auth.type === "header" && auth.name?.toLowerCase() === "content-type";
  const contentTypeCompatible = contentTypeHeaders.every(([, value]) => isJsonContentType(value));
  const operations = compiled.operations.filter((operation) => {
    const headerCollision = operation.headerParameters.some((name) =>
      protectedHeaders.has(name.toLowerCase()),
    );
    const queryCollision =
      auth.type === "query" && auth.name && operation.queryParameters.includes(auth.name);
    const contentTypeCollision =
      apiOperationHasJsonBody(operation) && (contentTypeAuth || !contentTypeCompatible);
    if (!headerCollision && !queryCollision && !contentTypeCollision) return true;
    const diagnostic: OpenApiImportDiagnostic = {
      scope: "operation",
      code: headerCollision || contentTypeCollision ? "unsafe_header" : "invalid_parameter",
      operationId: operation.id,
      method: operation.method,
      path: operation.path,
    };
    if (compiled.diagnostics.length < 100) compiled.diagnostics.push(diagnostic);
    else compiled.counts.omittedDiagnostics++;
    compiled.counts.accepted--;
    compiled.counts.rejected++;
    return false;
  });
  if (contentTypeHeaders.length > 0 && operations.some(apiOperationHasJsonBody)) {
    for (const [name] of contentTypeHeaders) delete headers[name];
    headers["content-type"] = "application/json";
  }
  const config = {
    auth,
    headers,
    operations: operations.map((operation) => ApiOperationSchema.parse(operation)),
  };
  return {
    source: compiled.baseUrl,
    // Only for credential exclusion checks; never expose or persist with the public plan.
    rawTarget: (document.servers as Array<{ url: string }>)[0]!.url,
    unicodeHostname: domainToUnicode(new URL(compiled.baseUrl).hostname),
    config,
    operationCount: operations.length,
    diagnostics: compiled.diagnostics,
    counts: compiled.counts,
  };
}

function apiOperationHasJsonBody(operation: ApiOperation): boolean {
  return (
    Object.hasOwn(asRecord(operation.inputSchema.properties) ?? {}, "body") &&
    !operation.queryParameters.includes("body") &&
    !operation.headerParameters.includes("body") &&
    !operation.path.includes("{body}")
  );
}

function isJsonContentType(value: string): boolean {
  try {
    const mime = new MIMEType(value);
    return (
      mime.essence === "application/json" &&
      [...mime.params].every(
        ([name, value]) => name === "charset" && value.toLowerCase() === "utf-8",
      )
    );
  } catch {
    return false;
  }
}

async function loadOpenApiDocument(
  url: URL,
  headers: Record<string, string>,
  signal?: AbortSignal,
  remote: RemoteRequestPolicy = {},
): Promise<Record<string, unknown>> {
  const safeFetch = createSafeRemoteFetch(remote.fetch, remote.resolveHostname, remote);
  try {
    const response = await safeFetch(url, {
      headers,
      signal: combineSignals(signal, AbortSignal.timeout(15_000)),
    });
    if (!response.ok) throw new Error(`OpenAPI document returned HTTP ${response.status}`);
    const size = Number(response.headers.get("content-length") ?? 0);
    if (size > 2_000_000) throw new OpenApiCompileError("document_limit");
    const { text, truncated } = await readBoundedText(response, 2_000_000);
    if (truncated) throw new OpenApiCompileError("document_limit");
    return parseOpenApiText(text);
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

export type {
  OpenApiImportCounts,
  OpenApiImportDiagnostic,
  OpenApiImportDiagnosticCode,
} from "./openapi-import.js";
export { compileOpenApiDocument, OpenApiCompileError, parseOpenApiText } from "./openapi-import.js";

export function importOpenApiDocument(document: Record<string, unknown>) {
  const compiled = compileOpenApiDocument(document);
  if (compiled.operations.length === 0)
    throw new OpenApiCompileError(compiled.diagnostics[0]?.code ?? "invalid_operation");
  return compiled;
}

/** Lead with the validated route; the provider's prose is bounded and labeled as the provider's. */
function operationDescription(route: string, provided: string | undefined): string {
  const prose = provided?.trim().slice(0, MAX_DESCRIPTION_LENGTH);
  return prose && prose !== route ? `${route}. Provider description: ${prose}` : route;
}

function connectorHeaders(
  config: z.infer<typeof McpConfigSchema>,
  credential?: string,
): Record<string, string> {
  const headers = { ...config.headers };
  if (!credential || config.auth.type === "none") return headers;
  const name = config.auth.type === "header" ? config.auth.name : "authorization";
  if (!name) throw new Error("Authentication header name is required");
  headers[name] = config.auth.type === "bearer" ? `Bearer ${credential}` : credential;
  return headers;
}

async function executeApiOperation(
  baseUrl: string,
  config: z.infer<typeof ApiConfigSchema>,
  operation: ApiOperation,
  args: Record<string, unknown>,
  credential: string | undefined,
  signal: AbortSignal,
  remote: RemoteRequestPolicy,
): Promise<unknown> {
  if (operation.importPolicy === "openapi-v1") {
    assertOpenApiArguments(operation.inputSchema, args);
    for (const name of operation.queryParameters) {
      const value = args[name];
      for (const item of Array.isArray(value) ? value : [value]) {
        try {
          if (typeof item === "string") encodeURIComponent(item);
        } catch {
          throw new Error("OpenAPI query parameter is invalid");
        }
      }
    }
  }
  const consumed = new Set<string>();
  const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = args[name];
    if (value == null) throw new Error(`Missing path parameter ${name}`);
    if (operation.importPolicy === "openapi-v1" && /^(?:\.|%2e){1,2}$/i.test(String(value)))
      throw new Error("OpenAPI path parameter cannot be a dot segment");
    consumed.add(name);
    return encodeURIComponent(String(value));
  });
  const url = joinApiUrl(baseUrl, path);
  const headers: Record<string, string> = { accept: "application/json", ...config.headers };
  let body: string | undefined;
  for (const key of operation.headerParameters) {
    const value = args[key];
    consumed.add(key);
    if (
      operation.importPolicy === "openapi-v1" &&
      value != null &&
      (String(value).trim() !== String(value) || /[^\t\x20-\x7e\x80-\xff]/.test(String(value)))
    )
      throw new Error("OpenAPI header parameter is invalid");
    if (value != null) headers[key] = String(value);
  }
  if (operation.method === "GET" || operation.method === "DELETE") {
    for (const [key, value] of Object.entries(args)) {
      if (consumed.has(key) || value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else if (typeof value !== "object") {
        url.searchParams.set(key, String(value));
      }
    }
  } else {
    for (const key of operation.queryParameters) {
      const value = args[key];
      consumed.add(key);
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    if (operation.importPolicy === "openapi-v1") {
      if (Object.hasOwn(args, "body") && apiOperationHasJsonBody(operation)) {
        body = JSON.stringify(args.body);
        headers["content-type"] = "application/json";
      }
    } else {
      const payload =
        args.body ?? Object.fromEntries(Object.entries(args).filter(([key]) => !consumed.has(key)));
      body = JSON.stringify(payload);
      headers["content-type"] = "application/json";
    }
  }
  applyCredential(url, headers, config.auth, credential);
  const safeFetch = createSafeRemoteFetch(remote.fetch, remote.resolveHostname, remote);
  try {
    const response = await safeFetch(url, {
      method: operation.method,
      headers,
      body,
      signal: combineSignals(signal, AbortSignal.timeout(30_000)),
    });
    const { text, truncated } = await readBoundedText(response, 1_000_000);
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Keep non-JSON API responses as bounded text.
    }
    if (!response.ok) {
      return {
        error: true,
        status: response.status,
        data,
        ...(truncated ? { truncated: true } : {}),
      };
    }
    return { status: response.status, data, ...(truncated ? { truncated: true } : {}) };
  } finally {
    await safeFetch.close().catch(() => undefined);
  }
}

function joinApiUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  base.pathname = `${prefix}/${path.replace(/^\//, "")}`;
  base.search = "";
  base.hash = "";
  return base;
}
