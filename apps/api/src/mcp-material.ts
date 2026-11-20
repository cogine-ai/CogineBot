import type { McpServerConfigInput, McpStdioOAuthClient } from "@rakazo/contracts";
import {
  McpConnectionHeadersSchema,
  McpStdioFilesSchema,
  McpStdioOAuthClientSchema,
} from "@rakazo/contracts";
import { z } from "zod";

/** Shape of the encrypted MCP credential blob. `oauth` holds SDK OAuth state
 * (tokens, client registration, PKCE verifier) managed by McpOAuthBroker. */
export type McpSecretMaterial = {
  secret?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  files?: Record<string, string>;
  oauthClient?: McpStdioOAuthClient;
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
    files: McpStdioFilesSchema.optional(),
    oauthClient: McpStdioOAuthClientSchema.optional(),
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
  options: { clearOAuth?: boolean; replaceCredentials?: boolean } = {},
): McpMaterialUpdate {
  if (config.transport === "stdio") {
    const previous = options.replaceCredentials ? {} : existing;
    const oauthClient =
      config.oauthClient === undefined ? previous.oauthClient : config.oauthClient;
    const oauth =
      oauthClient && sameStdioClient(previous.oauthClient, oauthClient)
        ? previous.oauth
        : undefined;
    const secret = config.secret || previous.secret;
    const env = config.env ?? previous.env;
    const files = config.files ?? previous.files;
    return {
      action: "store",
      material: {
        ...(oauthClient ? { oauthClient } : {}),
        ...(oauth ? { oauth } : {}),
        ...(!config.clearCredential && secret ? { secret } : {}),
        ...(!config.clearCredential && env && Object.keys(env).length ? { env } : {}),
        ...(!config.clearCredential && files && Object.keys(files).length ? { files } : {}),
      },
    };
  }
  if (options.replaceCredentials) {
    return {
      action: "store",
      material: config.clearCredential
        ? {}
        : {
            ...(config.secret ? { secret: config.secret } : {}),
            ...(Object.keys(config.headers).length ? { headers: config.headers } : {}),
          },
    };
  }
  const material = options.clearOAuth ? { ...existing } : existing;
  const clearedOAuth = options.clearOAuth === true && material.oauth !== undefined;
  if (options.clearOAuth) delete material.oauth;
  const clearing = config.clearCredential === true;
  if (clearing) {
    return { action: "store", material: material.oauth ? { oauth: material.oauth } : {} };
  }
  const secret = "secret" in config && config.secret ? config.secret : undefined;
  const headers = config.headers;
  const existingHasMaterial = Boolean(
    material.secret ||
      (material.env && Object.keys(material.env).length > 0) ||
      (material.headers && Object.keys(material.headers).length > 0) ||
      material.oauth,
  );
  const suppliesMaterial = Boolean(secret || Object.keys(headers).length > 0);
  if (!existingHasMaterial && !suppliesMaterial) {
    return clearedOAuth ? { action: "store", material } : { action: "keep" };
  }
  return {
    action: "store",
    material: {
      ...material,
      ...(secret ? { secret } : {}),
      headers,
    },
  };
}

function sameStdioClient(
  previous: McpStdioOAuthClient | undefined,
  next: McpStdioOAuthClient | null | undefined,
): boolean {
  return (
    previous?.authorizationServer === next?.authorizationServer &&
    previous?.clientId === next?.clientId &&
    previous?.clientSecret === next?.clientSecret &&
    previous?.scope === next?.scope
  );
}
