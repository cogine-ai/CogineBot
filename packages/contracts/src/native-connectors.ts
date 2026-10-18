import { z } from "zod";
import { Id } from "./ids.js";

export const NativeGoogleAppIdSchema = z.enum([
  "google-calendar",
  "gmail",
  "google-drive",
  "google-docs",
  "google-sheets",
  "google-slides",
  "google-tasks",
]);
export const NativeAppIdSchema = z.enum([
  "coginex",
  "knowai",
  ...NativeGoogleAppIdSchema.options,
  "notion",
  "github",
  "linear",
  "slack",
]);
export type NativeAppId = z.infer<typeof NativeAppIdSchema>;

export const NativeCredentialKindSchema = z.enum([
  "mcp_oauth",
  "machine_key",
  "oauth",
  "internal_token",
  "personal_token",
  "bot_token",
  "github_app_installation",
]);

/** Optional deployment-owned Gmail Pub/Sub subscription. No service-account private key is stored. */
export const NativeGoogleWatchConfigSchema = z
  .object({
    projectId: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
    topicName: z.string().min(1).max(512),
    subscriptionName: z.string().min(1).max(512),
    callbackAudience: z.url().max(2048),
    pushServiceAccountEmail: z.string().email().max(320),
  })
  .strict()
  .superRefine((value, ctx) => {
    const base = `projects/${value.projectId}/`;
    if (
      !value.topicName.startsWith(`${base}topics/`) ||
      !/^[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(value.topicName.slice(`${base}topics/`.length))
    )
      ctx.addIssue({
        code: "custom",
        path: ["topicName"],
        message: "The topic must belong to the configured Google project.",
      });
    if (
      !value.subscriptionName.startsWith(`${base}subscriptions/`) ||
      !/^[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(
        value.subscriptionName.slice(`${base}subscriptions/`.length),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["subscriptionName"],
        message: "The subscription must belong to the configured Google project.",
      });
  });
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
    actor: z.enum(["user", "app", "bot", "installation"]).optional(),
    githubAppId: z.string().regex(/^\d+$/).max(32).optional(),
    githubInstallationId: z.string().regex(/^\d+$/).max(32).optional(),
    googleWatch: NativeGoogleWatchConfigSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (value.googleWatch && value.appId !== "gmail")
      issue("googleWatch", "Only Gmail uses this Pub/Sub configuration.");
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
    if (NativeGoogleAppIdSchema.safeParse(value.appId).success && value.credentialKind !== "oauth")
      issue("credentialKind", "Google applications require user OAuth");
    if (value.appId === "github") {
      if (!["oauth", "personal_token", "github_app_installation"].includes(value.credentialKind))
        issue("credentialKind", "Select the actual GitHub App or personal credential type");
      if (
        value.actor !==
        (value.credentialKind === "github_app_installation" ? "installation" : "user")
      )
        issue("actor", "Choose the exact GitHub credential actor");
      if (
        value.credentialKind === "github_app_installation" &&
        (!value.githubAppId || !value.githubInstallationId)
      )
        issue("githubInstallationId", "Configure the GitHub App and installation identities");
    }
    if (value.appId === "linear") {
      if (!["oauth", "personal_token"].includes(value.credentialKind))
        issue("credentialKind", "Linear requires OAuth or a personal API key");
      if (
        !["user", "app"].includes(value.actor ?? "") ||
        (value.credentialKind === "personal_token" && value.actor !== "user")
      )
        issue("actor", "Choose the actual Linear user or app actor");
    }
    if (value.appId === "slack") {
      if (!["oauth", "personal_token", "bot_token"].includes(value.credentialKind))
        issue("credentialKind", "Select the actual Slack token type");
      if (
        !["bot", "user"].includes(value.actor ?? "") ||
        (value.credentialKind === "bot_token" && value.actor !== "bot") ||
        (value.credentialKind === "personal_token" && value.actor !== "user")
      )
        issue("actor", "Choose the exact Slack bot or user actor");
    }
    if (
      value.appId === "notion" &&
      !["oauth", "internal_token", "personal_token"].includes(value.credentialKind)
    )
      issue("credentialKind", "Select the actual Notion credential type");
    if (value.credentialKind === "oauth" && !value.clientId)
      issue("clientId", "OAuth client ID is required");
    if (
      (NativeGoogleAppIdSchema.safeParse(value.appId).success ||
        ["notion", "github", "linear", "slack"].includes(value.appId)) &&
      value.endpoint
    )
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
  actor: z.enum(["user", "app", "bot", "installation"]).optional(),
  driveFilePickerAvailable: z.boolean().optional(),
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
    authorizationFlow: z.literal("drive_picker").optional(),
    previousConnectionId: Id.optional(),
    credential: z.string().min(1).max(16384).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.authorizationFlow === "drive_picker" &&
      (value.previousConnectionId || value.credential)
    )
      context.addIssue({
        code: "custom",
        message: "File selection creates a separate Drive connection.",
        path: ["authorizationFlow"],
      });
  });

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
