import * as z from "zod";

export const McpTransportSchema = z.enum(["streamable_http", "sse", "stdio"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export function isLocalMcpHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export const McpRemoteEndpointSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      if (value.endsWith("#")) return false;
      const url = new URL(value);
      if (url.username || url.password || url.hash) return false;
      // Persist HTTP(S). Runtime SSRF still requires HTTPS for public hosts and
      // blocks private LAN targets unless the deployment-owner escape is on.
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "MCP remote endpoint must be an HTTP(S) URL without credentials or a fragment");

export const McpHeadersSchema = z
  .record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(4096))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 32) {
      ctx.addIssue({ code: "custom", message: "At most 32 headers are allowed" });
    }
  });

export const McpStdioOAuthClientSchema = z.strictObject({
  authorizationServer: McpRemoteEndpointSchema.refine((value) => {
    const url = URL.parse(value);
    return url?.protocol === "https:" && !value.includes("?");
  }, "MCP OAuth issuer must be an HTTPS URL without a query"),
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().min(1).max(4096).optional(),
  scope: z.string().trim().max(2000).optional(),
});
export type McpStdioOAuthClient = z.infer<typeof McpStdioOAuthClientSchema>;

export const McpStdioFilesSchema = z
  .record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), z.string().max(65536))
  .refine((files) => Object.keys(files).length <= 8, "At most 8 credential files are allowed");

export const MCP_STDIO_OAUTH_FIELDS = [
  "access_token",
  "refresh_token",
  "client_id",
  "client_secret",
  "expires_at",
  "scope",
  "token_type",
] as const;
export const MCP_STDIO_OAUTH_REFERENCE = /\{\{\s*oauth\.([^{}]*)\}\}/g;
export const MCP_STDIO_OAUTH_REFERENCE_START = /\{\{\s*oauth\s*\./;

/** Check the effective environment after the server's stored declaration is merged. */
export function validateMcpStdioCredentials(config: {
  args?: readonly string[];
  env?: Record<string, string>;
  files?: Record<string, string>;
  oauthClient?: McpStdioOAuthClient | null;
}): string | undefined {
  if (config.args?.some((arg) => MCP_STDIO_OAUTH_REFERENCE_START.test(arg))) {
    return "Use environment variables or files for MCP OAuth credentials";
  }
  const env = config.env ?? {};
  const files = config.files ?? {};
  if (Object.keys(files).some((name) => Object.hasOwn(env, name))) {
    return "MCP credential files and environment variables must use different names";
  }
  for (const value of [...Object.values(env), ...Object.values(files)]) {
    if (!MCP_STDIO_OAUTH_REFERENCE_START.test(value)) continue;
    if (!config.oauthClient) return "MCP OAuth references require an OAuth client";
    const fields = MCP_STDIO_OAUTH_FIELDS as readonly string[];
    for (const [, name] of value.matchAll(MCP_STDIO_OAUTH_REFERENCE)) {
      const field = name?.trim();
      if (!field || !fields.includes(field)) return "Invalid MCP OAuth field reference";
      if (field === "client_secret" && !config.oauthClient.clientSecret) {
        return "The MCP OAuth reference requires a client secret";
      }
    }
    if (MCP_STDIO_OAUTH_REFERENCE_START.test(value.replaceAll(MCP_STDIO_OAUTH_REFERENCE, ""))) {
      return "Invalid MCP OAuth field reference";
    }
  }
}

/** A connection edit preserves configuration and separately approved tool access. */
export const McpConnectionHeadersSchema = McpHeadersSchema.superRefine((headers, context) => {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      name.length > 120 ||
      /^(connection|content-length|host|proxy-authorization|proxy-connection|te|trailer|transfer-encoding|upgrade)$/.test(
        normalized,
      ) ||
      /[\r\n\0]/.test(value) ||
      names.has(normalized)
    ) {
      context.addIssue({ code: "custom", message: "Invalid MCP connection headers" });
    }
    names.add(normalized);
  }
});

export const PluginServerConnectionInputSchema = z
  .object({
    id: z.string().min(1),
    connection: z
      .object({
        revision: z.number().int().positive(),
        enabled: z.boolean(),
        headerUpdates: McpConnectionHeadersSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type PluginServerConnectionInput = z.infer<typeof PluginServerConnectionInputSchema>;
