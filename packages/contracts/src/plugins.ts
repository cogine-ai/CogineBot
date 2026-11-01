import { z } from "zod";

export const PluginSourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const PluginDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const PluginSourceSchema = z.string().min(1).max(2048);
export const PluginNonceSchema = z.string().min(1).max(128);

export const PluginSkippedSchema = z.object({
  kind: z.enum([
    "mcp_stdio",
    "mcp_invalid",
    "skill_invalid",
    "editor_only",
    "unsupported_transport",
    "unsupported_field",
  ]),
  name: z.string().max(2048),
  reason: z.string().max(4000),
});

/** Public preview includes reviewed instructions, never encrypted MCP header values. */
export const PluginPreviewSchema = z
  .object({
    source: PluginSourceSchema,
    sourceSha: PluginSourceShaSchema,
    digest: PluginDigestSchema,
    format: z.enum(["agent-plugins", "cursor", "grok"]),
    name: z.string().min(1).max(64),
    description: z.string().max(4000),
    version: z.string().max(128).nullable(),
    skills: z
      .array(
        z.object({
          name: z.string().min(1).max(80),
          description: z.string().min(1).max(2000),
          content: z
            .string()
            .max(100_000)
            .refine(withinSkillByteLimit, "Skill content exceeds its byte limit"),
        }),
      )
      .max(200),
    mcpServers: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          transport: z.enum(["streamable_http", "sse"]),
          endpoint: z.string().max(2048),
          headerKeys: z.array(z.string().min(1).max(120)).max(32),
        }),
      )
      .max(200),
    skipped: z.array(PluginSkippedSchema),
  })
  .refine(
    (value) => value.skills.length + value.mcpServers.length <= 200,
    "Plugin has too many components",
  );
export type PluginPreview = z.infer<typeof PluginPreviewSchema>;
export type PluginSkipped = z.infer<typeof PluginSkippedSchema>;

function withinSkillByteLimit(value: string): boolean {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > 100_000) return false;
  }
  return true;
}

export const PluginInstallStatusSchema = z.enum([
  "installing",
  "installed",
  "failed",
  "uninstalling",
  "cleanup_failed",
  "removed",
]);
export type PluginInstallStatus = z.infer<typeof PluginInstallStatusSchema>;

/** Nonce and revision identify durable outcomes, including a removed installation. */
export const PluginInstallReceiptSchema = z.object({
  id: z.string().min(1),
  clientNonce: PluginNonceSchema,
  source: PluginSourceSchema,
  sourceSha: PluginSourceShaSchema,
  digest: PluginDigestSchema,
  name: z.string(),
  status: PluginInstallStatusSchema,
  revision: z.number().int().positive(),
  installedAt: z.string().datetime().nullable(),
  skills: z.array(z.object({ id: z.string().min(1), name: z.string() })),
  mcpServers: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      endpoint: z.string(),
      transport: z.enum(["streamable_http", "sse"]),
    }),
  ),
});
export type PluginInstallReceipt = z.infer<typeof PluginInstallReceiptSchema>;

/** Separate administrative visibility from receipts used to recover the caller's writes. */
export const PluginInstallListingSchema = z.object({
  owned: z.array(PluginInstallReceiptSchema),
  managed: z.array(
    z.object({ receipt: PluginInstallReceiptSchema, ownerName: z.string().nullable() }),
  ),
});
export type PluginInstallListing = z.infer<typeof PluginInstallListingSchema>;

export const PluginPreviewInputSchema = z.object({ source: PluginSourceSchema }).strict();
export const PluginInstallInputSchema = z
  .object({
    source: PluginSourceSchema,
    sourceSha: PluginSourceShaSchema,
    digest: PluginDigestSchema,
    clientNonce: PluginNonceSchema,
  })
  .strict();
export type PluginInstallInput = z.infer<typeof PluginInstallInputSchema>;
export const PluginUninstallInputSchema = z
  .object({ installId: z.string().min(1), expectedRevision: z.number().int().positive() })
  .strict();
export type PluginUninstallInput = z.infer<typeof PluginUninstallInputSchema>;
