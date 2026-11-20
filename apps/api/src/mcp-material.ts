import { isDeepStrictEqual } from "node:util";
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

const StdioMaterialSchema = ConnectionMaterialSchema.omit({ headers: true }).strip();

/** Connection patches must never replace unreadable credential material. */
export function parseMcpConnectionMaterial(value: string): McpSecretMaterial {
  const parsed = ConnectionMaterialSchema.safeParse(JSON.parse(value));
  if (!parsed.success) throw new Error("Stored MCP credentials are unavailable");
  return parsed.data;
}

export function parseMcpStdioMaterial(value: string): McpSecretMaterial {
  const material = StdioMaterialSchema.parse(JSON.parse(value));
  if (material.env && Object.keys(material.env).length === 0) delete material.env;
  return material;
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
 * Remote headers replace the full set and a new endpoint drops its OAuth grant.
 * Stdio keeps omitted env/files on the same launch target. A change to the
 * registered OAuth client drops its grant. */
export function buildMcpUpdateMaterial(
  existing: McpSecretMaterial,
  config: McpServerConfigInput,
  options: { clearOAuth?: boolean; replaceCredentials?: boolean } = {},
): McpMaterialUpdate {
  if (config.transport === "stdio") {
    const material = buildMcpStdioMaterial(options.replaceCredentials ? {} : existing, config);
    const clearing = config.clearCredential && Object.keys(material).length === 0;
    return !options.replaceCredentials && !clearing && isDeepStrictEqual(existing, material)
      ? { action: "keep" }
      : { action: "store", material };
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

export function buildMcpStdioMaterial(
  previous: McpSecretMaterial,
  config: Extract<McpServerConfigInput, { transport: "stdio" }>,
): McpSecretMaterial {
  const registered = previous.oauthClient;
  let oauthClient = config.oauthClient === undefined ? registered : config.oauthClient;
  if (
    registered?.clientSecret &&
    oauthClient &&
    oauthClient.clientId === registered.clientId &&
    oauthClient.authorizationServer === registered.authorizationServer &&
    oauthClient.clientSecret === undefined
  ) {
    oauthClient = { ...oauthClient, clientSecret: registered.clientSecret };
  }
  const oauth =
    oauthClient && isDeepStrictEqual(registered, oauthClient) ? previous.oauth : undefined;
  const secret = config.secret || previous.secret;
  const env = config.env ?? previous.env;
  const files = config.files ?? previous.files;
  return {
    ...(oauthClient ? { oauthClient } : {}),
    ...(oauth ? { oauth } : {}),
    ...(!config.clearCredential && secret ? { secret } : {}),
    ...(!config.clearCredential && env && Object.keys(env).length ? { env } : {}),
    ...(!config.clearCredential && files && Object.keys(files).length ? { files } : {}),
  };
}
