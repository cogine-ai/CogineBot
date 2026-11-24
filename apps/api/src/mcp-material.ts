import { isDeepStrictEqual } from "node:util";
import type { McpServerUpdateConfigInput, McpStdioOAuthClient } from "@rakazo/contracts";
import {
  McpConnectionHeadersSchema,
  McpHeadersSchema,
  McpStdioFilesSchema,
  McpStdioOAuthClientSchema,
  sameMcpEndpoint,
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
const RemoteMaterialSchema = ConnectionMaterialSchema.extend({
  headers: McpHeadersSchema.optional(),
});

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

export function parseMcpRemoteMaterial(value: string): McpSecretMaterial {
  return RemoteMaterialSchema.parse(JSON.parse(value));
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
 * Remote headers replace the full set when supplied. A new target starts with
 * only the static credentials supplied for it.
 * Stdio keeps omitted env/files on the same launch target. A change to the
 * registered OAuth client drops its grant. */
export function buildMcpUpdateMaterial(
  existing: McpSecretMaterial,
  config: McpServerUpdateConfigInput,
  options: { replaceCredentials?: boolean } = {},
): McpMaterialUpdate {
  if (config.transport === "stdio") {
    const material = buildMcpStdioMaterial(options.replaceCredentials ? {} : existing, config);
    const clearing = config.clearCredential && Object.keys(material).length === 0;
    return !options.replaceCredentials && !clearing && isDeepStrictEqual(existing, material)
      ? { action: "keep" }
      : { action: "store", material };
  }
  const previous = options.replaceCredentials ? {} : existing;
  if (config.clearCredential) {
    return { action: "store", material: previous.oauth ? { oauth: previous.oauth } : {} };
  }
  const material = { ...previous, ...(config.secret?.trim() ? { secret: config.secret } : {}) };
  if (config.headers) {
    const headers = Object.fromEntries(
      Object.entries(config.headers).flatMap(([name, value]) => {
        const savedName = Object.keys(previous.headers ?? {}).find(
          (key) => key.toLowerCase() === name.toLowerCase(),
        );
        const next = value.trim() ? value : savedName && previous.headers?.[savedName];
        return next?.trim() ? [[name, next]] : [];
      }),
    );
    if (Object.keys(headers).length) material.headers = headers;
    else delete material.headers;
  }
  return options.replaceCredentials || !isDeepStrictEqual(existing, material)
    ? { action: "store", material }
    : { action: "keep" };
}

export function buildMcpStdioMaterial(
  previous: McpSecretMaterial,
  config: Extract<McpServerUpdateConfigInput, { transport: "stdio" }>,
): McpSecretMaterial {
  const registered = previous.oauthClient;
  let oauthClient = config.oauthClient === undefined ? registered : config.oauthClient;
  if (config.oauthClient && registered?.clientId === config.oauthClient.clientId) {
    const next = config.oauthClient;
    if (sameMcpEndpoint(registered.authorizationServer, next.authorizationServer)) {
      oauthClient = { ...registered, ...next, authorizationServer: registered.authorizationServer };
    }
  }
  if (
    config.oauthClient &&
    (oauthClient?.scope === "" || oauthClient?.authorizationParams === "")
  ) {
    const { scope, authorizationParams, ...client } = oauthClient;
    oauthClient = {
      ...client,
      ...(scope ? { scope } : {}),
      ...(authorizationParams ? { authorizationParams } : {}),
    };
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
