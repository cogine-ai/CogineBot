import { z } from "zod";
import { Id } from "./ids.js";

export const NativeAppIdSchema = z.enum(["coginex", "knowai", "google-calendar", "notion"]);
export type NativeAppId = z.infer<typeof NativeAppIdSchema>;

export const NativeCredentialKindSchema = z.enum([
  "mcp_oauth",
  "machine_key",
  "oauth",
  "internal_token",
  "personal_token",
]);

/** Instance configuration. Credential values are write-only, never a tool argument. */
export const NativeConfigInputSchema = z
  .object({
    id: Id.optional(),
    expectedRevision: z.number().int().positive().optional(),
    appId: NativeAppIdSchema,
    label: z.string().trim().min(1).max(80),
    ownership: z.enum(["official", "byo"]),
    enabled: z.boolean().default(true),
    credentialKind: NativeCredentialKindSchema,
    endpoint: z.url().max(2048).optional(),
    clientId: z.string().trim().min(1).max(512).optional(),
    clientSecret: z.string().min(1).max(8192).optional(),
    scopes: z.array(z.string().min(1).max(256)).max(24).default([]),
    capabilities: z.array(z.string().min(1).max(80)).max(24).default([]),
    knowledgeBaseIds: z.array(z.string().min(1).max(160)).max(100).default([]),
    tenantId: z.string().min(1).max(160).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (value.id && !value.expectedRevision)
      issue("expectedRevision", "Configuration revision is required");
    if (value.appId === "coginex" && value.credentialKind !== "mcp_oauth")
      issue("credentialKind", "CogineX uses MCP OAuth");
    if (value.appId === "knowai" && value.credentialKind !== "machine_key")
      issue("credentialKind", "Knowai delegated authorization is not configured");
    if (["coginex", "knowai"].includes(value.appId) && !value.endpoint)
      issue("endpoint", "An instance endpoint is required");
    if (value.appId === "knowai" && (!value.knowledgeBaseIds.length || !value.tenantId))
      issue("knowledgeBaseIds", "Specify the tenant and allowed knowledge bases");
    if (value.appId === "google-calendar" && value.credentialKind !== "oauth")
      issue("credentialKind", "Calendar requires user OAuth");
    if (
      value.appId === "notion" &&
      !["oauth", "internal_token", "personal_token"].includes(value.credentialKind)
    )
      issue("credentialKind", "Select the actual Notion credential type");
    if (value.credentialKind === "oauth" && !value.clientId)
      issue("clientId", "OAuth client ID is required");
    if (["google-calendar", "notion"].includes(value.appId) && value.endpoint)
      issue("endpoint", "This service uses its fixed API authority");
    if (value.credentialKind !== "oauth" && value.clientSecret)
      issue("clientSecret", "Account credentials belong to the connecting user");
  });
export type NativeConfigInput = z.infer<typeof NativeConfigInputSchema>;

/** Safe for ordinary members: no client configuration, credential, or private endpoint. */
export const NativeConfigStatusSchema = z.object({
  id: Id,
  appId: NativeAppIdSchema,
  label: z.string(),
  ownership: z.enum(["official", "byo"]),
  credentialKind: NativeCredentialKindSchema,
  enabled: z.boolean(),
  configured: z.boolean(),
  revision: z.number().int().positive(),
  callbackUri: z.url(),
  executionLocation: z.literal("instance"),
});
export type NativeConfigStatus = z.infer<typeof NativeConfigStatusSchema>;

/** Deployment-owner editor values; account credentials and client secrets stay write-only. */
export const NativeConfigEditableSchema = z
  .object(NativeConfigInputSchema.shape)
  .omit({ clientSecret: true, expectedRevision: true })
  .extend({
    id: Id,
    revision: z.number().int().positive(),
    hasClientSecret: z.boolean(),
    callbackUri: z.url(),
  });
export type NativeConfigEditable = z.infer<typeof NativeConfigEditableSchema>;
export const NativeSetupStateSchema = z.object({
  canConfigure: z.boolean(),
  callbackUri: z.url(),
  configurations: z.array(NativeConfigStatusSchema),
});
export type NativeSetupState = z.infer<typeof NativeSetupStateSchema>;
export type NativeBeginInput = z.infer<typeof NativeBeginInputSchema>;

export const NativeBeginInputSchema = z
  .object({
    configId: Id,
    previousConnectionId: Id.optional(),
    credential: z.string().min(1).max(16384).optional(),
  })
  .strict();

export const NativeConnectionInfoSchema = z.object({
  configId: Id,
  configRevision: z.number().int().positive(),
  ownership: z.enum(["official", "byo"]),
  credentialKind: NativeCredentialKindSchema,
  subject: z.string().nullable(),
  tenant: z.string().nullable(),
  scopes: z.array(z.string()),
  executionLocation: z.literal("instance"),
});

/** Fixed backend route; it is deliberately separate from product account login. */
export const NATIVE_OAUTH_CALLBACK_PATH = "/api/connectors/oauth/callback";
