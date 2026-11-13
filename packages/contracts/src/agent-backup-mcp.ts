import * as z from "zod";
import { isCloudMetadataHost, isPrivateNetworkHost } from "./bot-secrets.js";
import { McpRemoteEndpointSchema } from "./mcp.js";

export const AGENT_BACKUP_MAX_MCP = 30;

export function isBackupMcpPath(path: string) {
  return /^mcp\/server-[1-9]\d?$/.test(path);
}

const path = z.string().refine(isBackupMcpPath);
const name = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\p{L}\p{N}_][\p{L}\p{M}\p{N} ._()-]*$/u)
  .refine((value) => value === value.trim());

export const agentBackupMcpOmissionReasons = {
  setup: "This connection needs manual setup.",
  toolPolicy: "This connection's tool restrictions cannot be carried over.",
  disabled: "This connection is disabled in the backup.",
  endpoint: "This connection needs a public HTTPS endpoint without credentials or URL parameters.",
  limit: "Additional connections exceed the import limit.",
} as const;
const reasons = Object.keys(
  agentBackupMcpOmissionReasons,
) as (keyof typeof agentBackupMcpOmissionReasons)[];

export const AgentBackupMcpSchema = z.strictObject({
  path,
  name,
  transport: z.enum(["streamable_http", "sse"]),
  endpoint: McpRemoteEndpointSchema.refine((value) => {
    if (!/^https:\/\//i.test(value) || /[?#@\\\s\u0000-\u001f\u007f]/.test(value)) return false;
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    // This portable format takes public DNS names. Explicit connection still checks resolved IPs.
    return (
      host.includes(".") &&
      !/^[\d.]+$/.test(host) &&
      !isCloudMetadataHost(host) &&
      !isPrivateNetworkHost(host) &&
      !host.endsWith(".internal") &&
      !host.endsWith(".localhost")
    );
  }),
});

export const AgentBackupMcpOmissionSchema = z.strictObject({ path, name, reason: z.enum(reasons) });
export type AgentBackupMcp = z.infer<typeof AgentBackupMcpSchema>;
export type AgentBackupMcpOmission = z.infer<typeof AgentBackupMcpOmissionSchema>;
export const AgentBackupMcpEntriesSchema = z
  .array(z.union([AgentBackupMcpSchema, AgentBackupMcpOmissionSchema]))
  .max(AGENT_BACKUP_MAX_MCP)
  .refine((entries) => new Set(entries.map((entry) => entry.path)).size === entries.length);
