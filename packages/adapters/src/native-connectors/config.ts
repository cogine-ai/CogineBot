import { randomUUID } from "node:crypto";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type {
  NativeConfigEditable,
  NativeConfigInput,
  NativeConfigStatus,
} from "@rakazo/contracts";
import {
  NATIVE_OAUTH_CALLBACK_PATH,
  NativeConfigEditableSchema,
  NativeConfigInputSchema,
  NativeGoogleWatchConfigSchema,
} from "@rakazo/contracts";
import type { NativeAppConfig, PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { assertNoSensitiveQuery } from "../connector-http.js";
import { actorMayUsePrivateEndpoint } from "../private-endpoint.js";
import type { RemoteTransportDependencies } from "../remote-mcp.js";
import { assertSafeRemoteUrl } from "../remote-mcp.js";
import { persistPreparedSecret } from "../secret-persistence.js";
import { COLLABORATION_SCOPES, SLACK_POLICY_CAPABILITIES } from "./collaboration-config.js";
import { GOOGLE_NATIVE_APPS, isGoogleNativeApp } from "./google.js";

export const CALENDAR_SCOPE_PREFIX = "https://www.googleapis.com/auth/";
export const CALENDAR_SCOPES = [
  "openid",
  "email",
  `${CALENDAR_SCOPE_PREFIX}calendar.calendarlist.readonly`,
  `${CALENDAR_SCOPE_PREFIX}calendar.events.readonly`,
  `${CALENDAR_SCOPE_PREFIX}calendar.events`,
  `${CALENDAR_SCOPE_PREFIX}calendar.freebusy`,
  `${CALENDAR_SCOPE_PREFIX}calendar.events.freebusy`,
] as const;

export const NativeConfigSettingsSchema = z.object({
  endpoint: z.string().optional(),
  clientId: z.string().optional(),
  scopes: z.array(z.string()),
  capabilities: z.array(z.string()),
  knowledgeBaseIds: z.array(z.string()),
  tenantId: z.string().optional(),
  actor: z.enum(["user", "app", "bot", "installation"]).optional(),
  githubAppId: z.string().optional(),
  githubInstallationId: z.string().optional(),
  googleWatch: NativeGoogleWatchConfigSchema.optional(),
});
export type NativeConfigSettings = z.infer<typeof NativeConfigSettingsSchema>;

const NOTION_CAPABILITIES = new Set([
  "read_content",
  "insert_content",
  "update_content",
  "read_comments",
  "insert_comments",
]);
const KNOWAI_CAPABILITIES = new Set(["retrieve", "ingest", "chat"]);

export function nativeCallbackUri(apiUrl: string): string {
  const origin = new URL(apiUrl);
  if (origin.username || origin.password || origin.search || origin.hash)
    throw new Error("API origin must not contain credentials, query, or fragment");
  if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  )
    throw new Error("OAuth callback requires HTTPS or an explicit loopback API origin");
  return new URL(NATIVE_OAUTH_CALLBACK_PATH, origin.origin).toString();
}

function settingsFor(input: NativeConfigInput): NativeConfigSettings {
  if (isGoogleNativeApp(input.appId)) {
    if (!input.scopes.includes("openid")) throw new Error("Google identity requires openid");
    if (input.appId === "gmail" && !input.scopes.includes("email"))
      throw new Error("Gmail sending identity requires verified email permission");
    if (
      input.scopes.some(
        (scope) =>
          !GOOGLE_NATIVE_APPS[input.appId as keyof typeof GOOGLE_NATIVE_APPS].scopes.includes(
            scope,
          ),
      )
    )
      throw new Error(
        input.appId === "google-calendar"
          ? "Unsupported Calendar scope"
          : "Unsupported Google application scope",
      );
  } else if (input.appId === "coginex") {
    if (input.scopes.some((scope) => scope !== "mcp"))
      throw new Error("CogineX uses the fixed MCP scope");
  } else if (COLLABORATION_SCOPES[input.appId]) {
    if (input.scopes.some((scope) => !COLLABORATION_SCOPES[input.appId]!.includes(scope)))
      throw new Error("Unsupported collaboration application scope");
    if (input.appId === "slack" && input.actor === "bot" && input.scopes.includes("search:read"))
      throw new Error("Slack legacy search requires the selected user actor");
  } else if (input.scopes.length) {
    throw new Error("This authorization protocol does not accept Google OAuth scopes");
  }
  const allowed =
    input.appId === "knowai"
      ? KNOWAI_CAPABILITIES
      : input.appId === "notion"
        ? NOTION_CAPABILITIES
        : input.appId === "slack"
          ? SLACK_POLICY_CAPABILITIES
          : new Set<string>();
  if (input.capabilities.some((capability) => !allowed.has(capability)))
    throw new Error("Unsupported service capability");
  let endpoint = input.endpoint?.replace(/\/$/, "");
  if (endpoint && input.appId === "knowai") {
    // Knowai's copied API URL includes /api/v1; frozen action paths include it too.
    // Keep any reverse-proxy prefix and leave URL credentials/query validation intact.
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
    endpoint = url.toString().replace(/\/$/, "");
  }
  return {
    ...(endpoint ? { endpoint } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    scopes: input.appId === "coginex" ? ["mcp"] : [...new Set(input.scopes)].sort(),
    capabilities: [...new Set(input.capabilities)].sort(),
    knowledgeBaseIds: [...new Set(input.knowledgeBaseIds)].sort(),
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.githubAppId ? { githubAppId: input.githubAppId } : {}),
    ...(input.githubInstallationId ? { githubInstallationId: input.githubInstallationId } : {}),
    ...(input.googleWatch ? { googleWatch: input.googleWatch } : {}),
  };
}

export function nativeConfigStatus(row: NativeAppConfig): NativeConfigStatus {
  const settings = NativeConfigSettingsSchema.parse(row.config);
  return {
    id: row.id,
    appId: NativeConfigInputSchema.shape.appId.parse(row.appId),
    label: row.label,
    ownership: row.ownership === "official" ? "official" : "byo",
    credentialKind: NativeConfigInputSchema.shape.credentialKind.parse(row.credentialKind),
    enabled: row.enabled,
    configured:
      row.credentialKind !== "oauth" ||
      Boolean(row.ciphertext && row.secretRecordId && settings.clientId),
    revision: row.revision,
    callbackUri: row.callbackUri,
    executionLocation: "instance",
    ...(settings.actor ? { actor: settings.actor } : {}),
  };
}

/** Deployment configuration only; account tokens never enter this table or DTO. */
export class NativeConfigStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly apiUrl: string,
    private readonly network: RemoteTransportDependencies = {},
    private readonly allowPrivateEndpoint = false,
  ) {}

  get callbackUri(): string {
    return new URL(NATIVE_OAUTH_CALLBACK_PATH, new URL(this.apiUrl).origin).toString();
  }

  async statuses(): Promise<NativeConfigStatus[]> {
    const rows = await this.prisma.nativeAppConfig.findMany({
      orderBy: [{ appId: "asc" }, { id: "asc" }],
    });
    return rows.map(nativeConfigStatus);
  }

  async configuration(id: string, isDeploymentOwner: boolean): Promise<NativeConfigEditable> {
    if (!isDeploymentOwner)
      throw new Error("Only the deployment administrator can read application configuration");
    const row = await this.prisma.nativeAppConfig.findUniqueOrThrow({
      where: { id },
    });
    return NativeConfigEditableSchema.parse({
      ...NativeConfigSettingsSchema.parse(row.config),
      id: row.id,
      revision: row.revision,
      appId: row.appId,
      label: row.label,
      ownership: row.ownership,
      credentialKind: row.credentialKind,
      enabled: row.enabled,
      hasClientSecret: Boolean(row.ciphertext && row.secretRecordId),
      callbackUri: row.callbackUri,
    });
  }

  async require(id: string): Promise<NativeAppConfig> {
    const row = await this.prisma.nativeAppConfig.findUnique({ where: { id } });
    if (!row?.enabled || !nativeConfigStatus(row).configured)
      throw new Error("This connection source is not configured");
    if (row.callbackUri !== this.callbackUri)
      throw new Error("API origin changed; update the registered application callback");
    return row;
  }

  async save(
    raw: NativeConfigInput,
    context: AdapterContext,
    isDeploymentOwner: boolean,
  ): Promise<NativeConfigStatus> {
    if (!isDeploymentOwner)
      throw new Error("Only the deployment administrator can configure applications");
    const input = NativeConfigInputSchema.parse(raw);
    // An optional OAuth adapter must not prevent an HTTP/LAN core deployment from starting.
    if (["oauth", "mcp_oauth"].includes(input.credentialKind)) nativeCallbackUri(this.apiUrl);
    const config = settingsFor(input);
    if (config.googleWatch) {
      const callback = new URL("/api/connectors/events/gmail", this.apiUrl);
      if (callback.protocol !== "https:" || config.googleWatch.callbackAudience !== callback.href)
        throw new Error(
          "Gmail push requires this instance's exact public HTTPS callback audience.",
        );
      const peers = await this.prisma.nativeAppConfig.findMany({
        where: { appId: "gmail", enabled: true, ...(input.id ? { id: { not: input.id } } : {}) },
        select: { config: true },
      });
      for (const peer of peers) {
        const watch = NativeConfigSettingsSchema.parse(peer.config).googleWatch;
        if (
          watch?.projectId === config.googleWatch.projectId &&
          watch.topicName !== config.googleWatch.topicName
        )
          throw new Error(
            "Gmail configurations in this instance must share one fixed topic per Google project.",
          );
      }
    }

    if (config.endpoint) {
      assertNoSensitiveQuery(config.endpoint);
      await assertSafeRemoteUrl(config.endpoint, this.network.resolveHostname, {
        allowPrivateEndpoint: await actorMayUsePrivateEndpoint(
          this.prisma,
          context.userId,
          this.allowPrivateEndpoint,
        ),
      });
    }
    const previous = input.id
      ? await this.prisma.nativeAppConfig.findUnique({
          where: { id: input.id },
        })
      : null;
    if (input.id && (!previous || previous.revision !== input.expectedRevision))
      throw new Error("Application configuration changed; refresh before saving");
    if (
      previous &&
      (previous.appId !== input.appId ||
        previous.credentialKind !== input.credentialKind ||
        previous.ownership !== input.ownership)
    )
      throw new Error(
        "Create a separate configuration for a different application or authorization type",
      );
    if (
      previous &&
      config.clientId !== NativeConfigSettingsSchema.parse(previous.config).clientId &&
      !input.clientSecret
    )
      throw new Error("Changing the OAuth client requires its matching secret");
    const material = input.clientSecret
      ? await this.prepareSecret(input.clientSecret, context)
      : undefined;
    const advancesAuthorization =
      !previous ||
      Boolean(material) ||
      previous.enabled !== input.enabled ||
      previous.callbackUri !== this.callbackUri ||
      JSON.stringify(NativeConfigSettingsSchema.parse(previous.config)) !== JSON.stringify(config);
    return persistPreparedSecret(this.prisma, this.secrets, material, async () => {
      const row = await this.prisma.$transaction(async (tx) => {
        const data = {
          appId: input.appId,
          label: input.label,
          ownership: input.ownership,
          credentialKind: input.credentialKind,
          enabled: input.enabled,
          config,
          callbackUri: this.callbackUri,
          ciphertext: material?.ciphertext ?? previous?.ciphertext ?? null,
          secretRecordId: material?.id ?? previous?.secretRecordId ?? null,
        };
        if (!previous) return tx.nativeAppConfig.create({ data });
        const changed = await tx.nativeAppConfig.updateMany({
          where: { id: previous.id, revision: input.expectedRevision },
          data: {
            ...data,
            ...(advancesAuthorization ? { revision: { increment: 1 } } : {}),
          },
        });
        if (!changed.count)
          throw new Error("Application configuration changed; refresh before saving");
        return tx.nativeAppConfig.findUniqueOrThrow({
          where: { id: previous.id },
        });
      });
      return nativeConfigStatus(row);
    });
  }

  private async prepareSecret(
    value: string,
    context: AdapterContext,
  ): Promise<{ id: string; ciphertext: string }> {
    const id = randomUUID();
    const stored = await this.secrets.put(value, context, { recordId: id });
    return { id, ciphertext: stored.ciphertext };
  }
}
