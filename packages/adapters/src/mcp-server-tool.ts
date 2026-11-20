/** Shared logic for the agent-facing add_mcp_server tool. Pure and unit-tested;
 * the executor wires the parsed result into Prisma + the secret store. */

import { McpRemoteEndpointSchema } from "@rakazo/contracts";
import { deriveMcpSlug } from "@rakazo/core";
import { toStringRecord } from "./memory-provider-factory.js";

export { deriveMcpSlug } from "@rakazo/core";

export type ParsedMcpServerArgs = {
  slug: string;
  name: string;
  description: string;
  transport: "streamable_http" | "sse";
  endpoint: string;
  headers: Record<string, string>;
  secret?: string;
  /** Legacy argument name; requests a shared-policy approval card, never a Bot assignment. */
  assignToSelf: boolean;
};

/** Returns undefined for anything that would fail server-side validation,
 * so the model gets a single actionable error instead of a partial create. */
export function parseMcpServerToolArgs(
  args: Record<string, unknown>,
): ParsedMcpServerArgs | undefined {
  const name = typeof args.name === "string" ? args.name.trim().slice(0, 120) : "";
  if (!name) return undefined;
  const transport = args.transport;
  if (transport !== "streamable_http" && transport !== "sse") return undefined;
  const endpoint = typeof args.endpoint === "string" ? args.endpoint.trim() : "";
  if (!McpRemoteEndpointSchema.safeParse(endpoint).success) return undefined;
  const headers = toStringRecord(args.headers);
  if (Object.keys(headers).length > 32) return undefined;

  return {
    slug: deriveMcpSlug(name),
    name,
    description: typeof args.description === "string" ? args.description.slice(0, 2000) : "",
    transport,
    endpoint,
    headers,
    secret:
      typeof args.secret === "string" && args.secret ? args.secret.slice(0, 16384) : undefined,
    assignToSelf: args.assign_to_self !== false,
  };
}

/** Serialized credential blob for the encrypted secret store; null when the
 * server has no static credential material. */
export function buildMcpCredentialBlob(parsed: {
  secret?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}): string | null {
  const env = parsed.env ?? {};
  const headers = parsed.headers ?? {};
  if (!parsed.secret && Object.keys(env).length === 0 && Object.keys(headers).length === 0) {
    return null;
  }
  return JSON.stringify({ secret: parsed.secret, env, headers });
}

/** Heuristic for whether the approval card should lead with OAuth: remote
 * servers without a static credential usually need browser authorization. */
export function needsOAuthProbe(parsed: {
  secret?: string;
  headers?: Record<string, string>;
}): boolean {
  return !parsed.secret && Object.keys(parsed.headers ?? {}).length === 0;
}
