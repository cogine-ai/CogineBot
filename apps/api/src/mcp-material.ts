import type { McpServerConfigInput } from "@rakazo/contracts";
import { McpConnectionHeadersSchema } from "@rakazo/contracts";
import { z } from "zod";

/** Shape of the encrypted MCP credential blob. `oauth` holds SDK OAuth state
 * (tokens, client registration, PKCE verifier) managed by McpOAuthBroker. */
export type McpSecretMaterial = {
  secret?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: Record<string, unknown>;
};

export type McpMaterialUpdate =
  | { action: "keep" }
  | { action: "store"; material: McpSecretMaterial };

const ConnectionMaterialSchema = z
  .object({
    secret: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: McpConnectionHeadersSchema.optional(),
    oauth: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/** Connection patches must never replace unreadable credential material. */
export function parseMcpConnectionMaterial(value: string): McpSecretMaterial {
  const parsed = ConnectionMaterialSchema.safeParse(JSON.parse(value));
  if (!parsed.success) throw new Error("Stored MCP credentials are unavailable");
  return parsed.data;
}

/** Omitted/empty patches keep the exact stored credential, including OAuth. */
export function buildMcpConnectionMaterial(
  existing: McpSecretMaterial,
  headerUpdates?: Record<string, string>,
): McpMaterialUpdate {
  if (!headerUpdates || Object.keys(headerUpdates).length === 0) return { action: "keep" };
  const updates = McpConnectionHeadersSchema.parse(headerUpdates);
  const headers = McpConnectionHeadersSchema.parse(existing.headers ?? {});
  for (const [name, value] of Object.entries(updates)) {
    const previous = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    if (previous) delete headers[previous];
    headers[name] = value;
  }
  McpConnectionHeadersSchema.parse(headers);
  return { action: "store", material: { ...existing, headers } };
}

/** Compute the next encrypted credential blob for an MCP server update.
 *
 * - "keep": the update carries no credential data; leave the stored blob as is.
 * - "store": rewrite the blob. An empty material means credentials were
 *   cleared entirely — the caller should delete the secret row and null the
 *   server's secretId instead of storing an empty object.
 *
 * env/headers use full-replace semantics (the update payload is the complete
 * set), matching the create handler. OAuth state is preserved unless the
 * endpoint changed, since tokens issued for one endpoint must never be sent to
 * another server. */
export function buildMcpUpdateMaterial(
  existing: McpSecretMaterial,
  config: McpServerConfigInput,
  options: { clearOAuth?: boolean } = {},
): McpMaterialUpdate {
  const material = options.clearOAuth ? { ...existing } : existing;
  const clearedOAuth = options.clearOAuth === true && material.oauth !== undefined;
  if (options.clearOAuth) delete material.oauth;
  const clearing = config.clearCredential === true;
  if (clearing) {
    return { action: "store", material: material.oauth ? { oauth: material.oauth } : {} };
  }
  const secret = "secret" in config && config.secret ? config.secret : undefined;
  const env = "env" in config ? config.env : undefined;
  const headers = "headers" in config ? config.headers : undefined;
  const existingHasMaterial = Boolean(
    material.secret ||
      (material.env && Object.keys(material.env).length > 0) ||
      (material.headers && Object.keys(material.headers).length > 0) ||
      material.oauth,
  );
  const suppliesMaterial = Boolean(
    secret || (env && Object.keys(env).length > 0) || (headers && Object.keys(headers).length > 0),
  );
  if (!existingHasMaterial && !suppliesMaterial) {
    return clearedOAuth ? { action: "store", material } : { action: "keep" };
  }
  return {
    action: "store",
    material: {
      ...material,
      ...(secret ? { secret } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(headers !== undefined ? { headers } : {}),
    },
  };
}
