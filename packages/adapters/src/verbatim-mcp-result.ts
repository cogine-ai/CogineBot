import type { Message } from "@earendil-works/pi-ai";
import type { AgentRunRequest, ConnectorRoute } from "@rakazo/adapter-kit";

/** Trusted selected servers. Tool names and catalog aliases cannot establish server identity. */
export type VerbatimMcpServers = NonNullable<AgentRunRequest["verbatimMcpServers"]>;

const resultRoutes = new WeakMap<readonly unknown[], Readonly<ConnectorRoute>>();

/** Bind executor-owned identity to this execution's content, outside provider-controlled data. */
export function markMcpToolResultRoute<T>(content: T[], route: ConnectorRoute | undefined): T[] {
  if (route) resultRoutes.set(content, { ...route });
  else resultRoutes.delete(content);
  return content;
}

/** Read live executor ownership rather than fields supplied in the provider result. */
export function mcpToolResultRoute(content: unknown): Readonly<ConnectorRoute> | undefined {
  return Array.isArray(content) ? resultRoutes.get(content) : undefined;
}

/** Identity must survive labeling even when a result has no history-reference metadata. */
export function copyMcpToolResultRoute<T>(source: unknown, content: T[]): T[] {
  const route = mcpToolResultRoute(source);
  if (route) resultRoutes.set(content, route);
  else resultRoutes.delete(content);
  return content;
}

export function toolCallIdentity(
  call: unknown,
  fallbackName?: string,
): { name?: string; arguments?: unknown } {
  if (!call || typeof call !== "object") return { name: fallbackName };
  const record = call as { name?: unknown; arguments?: unknown };
  return {
    name: typeof record.name === "string" ? record.name : fallbackName,
    arguments: record.arguments,
  };
}

/** Use the resolved route: aliases, tool names, and legal server slugs can overlap. */
export function isVerbatimMcpResult(
  route: Readonly<ConnectorRoute> | undefined,
  servers: VerbatimMcpServers | undefined,
): boolean {
  if (!servers || route?.connectorId !== "mcp" || !route.resourceId) return false;
  return (
    servers.ids.includes(route.resourceId) ||
    (route.catalogGroup !== undefined && servers.slugs.includes(route.catalogGroup))
  );
}

/** Match each result to the actual preceding call occurrence before any content is transformed. */
export function verbatimMcpToolResultIndexes(
  messages: readonly Message[],
  servers: VerbatimMcpServers | undefined,
): ReadonlySet<number> {
  const indexes = new Set<number>();
  if (!servers) return indexes;
  let calls = new Map<string, { name: string; arguments: unknown }>();
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      calls = new Map(
        message.content.flatMap((part) =>
          part.type === "toolCall"
            ? [[part.id, { name: part.name, arguments: part.arguments }] as const]
            : [],
        ),
      );
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      if (call && isVerbatimMcpResult(mcpToolResultRoute(message.content), servers))
        indexes.add(index);
    } else {
      calls.clear();
    }
  }
  return indexes;
}
