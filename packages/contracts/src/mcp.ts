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

/** Exact native callback; arbitrary custom schemes and redirect destinations are not accepted. */
export const MCP_NATIVE_REDIRECT_URI = "coginebot:///mcp";
export function isMcpOAuthRedirectAllowed(redirectUri: string, webOrigin: string): boolean {
  return (
    redirectUri === MCP_NATIVE_REDIRECT_URI ||
    redirectUri === new URL("/mcp/oauth/callback", webOrigin).toString()
  );
}

export const McpCreateRequestSchema = z.object({ requestId: z.string().uuid() });
export const McpCreateReceiptSchema = z.object({
  requestId: z.string().uuid(),
  // null is an acknowledged cancellation, not an absence of a receipt.
  serverId: z.string().nullable(),
});
export type McpCreateReceipt = z.infer<typeof McpCreateReceiptSchema>;
