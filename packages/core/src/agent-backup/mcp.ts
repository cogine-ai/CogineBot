import type { AgentBackupMcp, AgentBackupMcpOmission, AgentBackupSource } from "@rakazo/contracts";
import {
  AGENT_BACKUP_MAX_MCP,
  AgentBackupMcpOmissionSchema,
  AgentBackupMcpSchema,
} from "@rakazo/contracts";
import { redactSecretText } from "@rakazo/logging/redaction";
import { readBackupConfig } from "./config.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const portableFields = new Set([
  "url",
  "transport",
  "type",
  "enabled",
  "tools",
  "toolFilter",
  "headers",
  "env",
  "timeout",
  "connect_timeout",
  "connectionTimeoutMs",
  "requestTimeoutMs",
  "supportsParallelToolCalls",
]);

// An empty list or an explicitly enabled utility leaves the server catalog unrestricted.
function unrestricted(value: unknown): boolean {
  if (value === undefined) return true;
  const filter = record(value);
  return (
    !!filter &&
    Object.entries(filter).every(([field, setting]) =>
      field === "include" || field === "exclude"
        ? Array.isArray(setting) && setting.length === 0
        : (field === "prompts" || field === "resources") && setting === true,
    )
  );
}

function openClawHasToolPolicy(config: Record<string, unknown>) {
  const restricts = (tools: unknown) => {
    if (tools === undefined) return false;
    const policy = record(tools);
    if (!policy) return true;
    return ["allow", "deny", "alsoAllow", "profile", "byProvider", "sandbox"].some((field) => {
      const value = policy[field];
      return value !== undefined && (!Array.isArray(value) || value.length !== 0);
    });
  };
  const agents = record(config.agents);
  const defaults = record(agents?.defaults);
  const named = Array.isArray(agents?.list)
    ? agents.list
    : Object.values(record(agents?.entries) ?? {});
  return [config, defaults, ...named.map(record)].some(
    (owner) =>
      restricts(owner?.tools) ||
      record(owner?.sandbox)?.mode === "all" ||
      record(owner?.sandbox)?.mode === "non-main",
  );
}

function transport(value: unknown) {
  if (value === "sse") return value;
  if (value === "streamable-http" || value === "streamable_http" || value === "http")
    return "streamable_http";
}

export function isPortableBackupMcp(connection: AgentBackupMcp): boolean {
  try {
    const endpoint = decodeURIComponent(connection.endpoint);
    return (
      redactSecretText(connection.name) === connection.name &&
      !/[?#@\\\s\u0000-\u001f\u007f]/.test(endpoint) &&
      redactSecretText(connection.endpoint) === connection.endpoint &&
      redactSecretText(endpoint) === endpoint
    );
  } catch {
    return false;
  }
}

export function projectBackupMcp(
  source: AgentBackupSource,
  content: string | undefined,
): (AgentBackupMcp | AgentBackupMcpOmission)[] {
  if (content === undefined) return [];
  const config = readBackupConfig(source, content);
  if (!config) return [];
  const sourceMcp = record(config.mcp);
  const value = source === "hermes" ? config.mcp_servers : sourceMcp?.servers;
  if (value === undefined) return [];
  const servers = record(value);
  if (!servers) return [{ path: "mcp/server-1", name: "MCP", reason: "setup" }];
  const entries = Object.entries(servers);
  const outerPolicy = source === "openclaw" && openClawHasToolPolicy(config);
  return entries.slice(0, AGENT_BACKUP_MAX_MCP).map(([rawName, rawServer], index) => {
    const path = `mcp/server-${index + 1}`;
    const parsedName = AgentBackupMcpOmissionSchema.shape.name.safeParse(rawName);
    const name =
      parsedName.success && redactSecretText(rawName) === rawName ? rawName : `MCP ${index + 1}`;
    const omit = (reason: AgentBackupMcpOmission["reason"]) => ({ path, name, reason });
    if (index === AGENT_BACKUP_MAX_MCP - 1 && entries.length > AGENT_BACKUP_MAX_MCP)
      return { path, name: "MCP", reason: "limit" };
    const server = record(rawServer);
    if (!server || name !== rawName) return omit("setup");
    if (server.enabled === false) return omit("disabled");
    if (outerPolicy || !unrestricted(server.tools) || !unrestricted(server.toolFilter))
      return omit("toolPolicy");
    if (
      Object.keys(server).some((field) => !portableFields.has(field)) ||
      (server.enabled !== undefined && server.enabled !== true) ||
      [server.headers, server.env].some(
        (fields) =>
          fields !== undefined && (!record(fields) || Object.keys(record(fields)!).length > 0),
      )
    )
      return omit("setup");
    const primary = transport(server.transport);
    const alias = transport(server.type);
    if (
      (server.transport !== undefined && !primary) ||
      (server.type !== undefined && !alias) ||
      (primary && alias && primary !== alias)
    )
      return omit("setup");
    const candidate = AgentBackupMcpSchema.safeParse({
      path,
      name,
      transport: primary ?? alias ?? (source === "openclaw" ? "sse" : "streamable_http"),
      endpoint: server.url,
    });
    return candidate.success && isPortableBackupMcp(candidate.data)
      ? candidate.data
      : omit("endpoint");
  });
}
