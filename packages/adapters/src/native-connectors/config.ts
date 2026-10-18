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
  remainingNativeProfile,
} from "@rakazo/contracts";
import type { NativeAppConfig, PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { z } from "zod";
import { assertNoSensitiveQuery } from "../connector-http.js";
import { actorMayUsePrivateEndpoint } from "../private-endpoint.js";
import type { RemoteTransportDependencies } from "../remote-mcp.js";
import { assertSafeRemoteUrl } from "../remote-mcp.js";
import { persistPreparedSecret } from "../secret-persistence.js";
import { COLLABORATION_SCOPES, SLACK_POLICY_CAPABILITIES } from "./collaboration-config.js";
import { enterpriseConfigSecret } from "./enterprise-config-secret.js";
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
  region: z.enum(["feishu", "lark"]).optional(),
  agentId: z.string().optional(),
  targetIds: z.array(z.string()).optional(),
  boundSpaceId: z.string().optional(),
  credentialOwner: z.object({ userId: z.string(), spaceId: z.string() }).optional(),
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
  } else if (remainingNativeProfile(input.appId)) {
    const profile = remainingNativeProfile(input.appId)!;
    const allowedScopes: readonly string[] = profile.scopes;
    if (input.scopes.some((scope) => !allowedScopes.includes(scope)))
      throw new Error("Unsupported application scope");
    if (input.appId === "asana" && input.scopes.includes("default") && input.scopes.length !== 1)
      throw new Error("Choose Asana full permissions or individual scopes, not both");
    if (
      [
        "outlook-mail",
        "outlook-calendar",
        "onedrive",
        "microsoft-todo",
        "sharepoint",
        "excel",
        "planner",
        "teams",
      ].includes(input.appId)
    ) {
      if (
        ["openid", "profile", "offline_access", "User.Read"].some(
          (scope) => !input.scopes.includes(scope),
        )
      )
        throw new Error(
          "Microsoft identity requires openid, profile, offline_access and User.Read",
        );
      if (
        input.tenantId &&
        !["common", "organizations", "consumers"].includes(input.tenantId) &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.tenantId)
      )
        throw new Error("Select a supported Microsoft tenant or account audience");
      if (
        ["sharepoint", "excel", "planner", "teams"].includes(input.appId) &&
        input.tenantId === "consumers"
      )
        throw new Error("This Microsoft application requires a business account");
    }
    if (input.appId === "gitlab" && input.endpoint) {
      const url = new URL(input.endpoint);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("GitLab requires a fixed HTTPS origin");
    }
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
          : new Set<string>(remainingNativeProfile(input.appId)?.capabilities ?? []);
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
    ...(input.region ? { region: input.region } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.targetIds?.length ? { targetIds: [...new Set(input.targetIds)].sort() } : {}),
    ...(input.githubAppId ? { githubAppId: input.githubAppId } : {}),
    ...(input.githubInstallationId ? { githubInstallationId: input.githubInstallationId } : {}),
    ...(input.googleWatch ? { googleWatch: input.googleWatch } : {}),
  };
}

export function nativeConfigStatus(row: NativeAppConfig): NativeConfigStatus {
  const settings = NativeConfigSettingsSchema.parse(row.config);
  const managedCredential =
    ["feishu-lark", "dingtalk", "wecom"].includes(row.appId) &&
    row.credentialKind === "machine_key";
  const botPlatform = ["telegram-bot", "discord"].includes(row.appId);
  const secretReady = Boolean(row.ciphertext && row.secretRecordId);
  return {
    id: row.id,
    appId: NativeConfigInputSchema.shape.appId.parse(row.appId),
    label: row.label,
    ownership: row.ownership === "official" ? "official" : "byo",
    credentialKind: NativeConfigInputSchema.shape.credentialKind.parse(row.credentialKind),
    enabled: row.enabled,
    configured: managedCredential
      ? Boolean(secretReady && settings.boundSpaceId)
      : botPlatform
        ? Boolean(
            settings.boundSpaceId &&
              settings.targetIds?.length &&
              (row.ownership !== "official" || secretReady),
          )
        : row.credentialKind !== "oauth" || Boolean(secretReady && settings.clientId),
    revision: row.revision,
    callbackUri: row.callbackUri,
    executionLocation: "instance",
    ...(managedCredential || botPlatform
      ? { usesConfiguredCredential: managedCredential || row.ownership === "official" }
      : {}),
    ...(settings.actor ? { actor: settings.actor } : {}),
    ...(row.appId === "google-drive" && row.credentialKind === "oauth"
      ? {
          driveFilePickerAvailable: settings.scopes.includes(
            "https://www.googleapis.com/auth/drive.file",
          ),
        }
      : {}),
  };
}

export function nativeConfigVisibleInSpace(row: NativeAppConfig, spaceId?: string): boolean {
  const settings = NativeConfigSettingsSchema.parse(row.config);
  const bound =
    ["telegram-bot", "discord"].includes(row.appId) ||
    (["feishu-lark", "dingtalk", "wecom"].includes(row.appId) &&
      row.credentialKind === "machine_key");
  return !bound || Boolean(spaceId && settings.boundSpaceId === spaceId);
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

  async statuses(spaceId?: string): Promise<NativeConfigStatus[]> {
    const rows = await this.prisma.nativeAppConfig.findMany({
      orderBy: [{ appId: "asc" }, { id: "asc" }],
    });
    return Promise.all(
      rows.filter((row) => nativeConfigVisibleInSpace(row, spaceId)).map((row) => this.status(row)),
    );
  }

  async configuration(
    id: string,
    isDeploymentOwner: boolean,
    spaceId?: string,
  ): Promise<NativeConfigEditable> {
    if (!isDeploymentOwner)
      throw new Error("Only the deployment administrator can read application configuration");
    const row = await this.prisma.nativeAppConfig.findUniqueOrThrow({
      where: { id },
    });
    if (!nativeConfigVisibleInSpace(row, spaceId))
      throw new Error("Application configuration is unavailable in this space");
    const secret =
      ["feishu-lark", "dingtalk", "wecom"].includes(row.appId) &&
      row.ciphertext &&
      row.secretRecordId
        ? enterpriseConfigSecret(await this.credential(row))
        : undefined;
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
      ...(secret
        ? {
            hasVerificationToken: Boolean(secret.verificationToken),
            hasEncryptionKey: Boolean(secret.encryptionKey),
          }
        : {}),
      callbackUri: row.callbackUri,
      ...(["feishu-lark", "wecom"].includes(row.appId) && row.credentialKind === "oauth"
        ? {
            enterpriseCallbackUri: new URL(
              `/api/connectors/enterprise/${encodeURIComponent(row.id)}`,
              this.apiUrl,
            ).toString(),
          }
        : {}),
    });
  }

  async require(
    id: string,
    database: Pick<PrismaClient, "nativeAppConfig"> = this.prisma,
  ): Promise<NativeAppConfig> {
    const row = await database.nativeAppConfig.findUnique({ where: { id } });
    if (!row?.enabled || !(await this.status(row)).configured)
      throw new Error("This connection source is not configured");
    if (row.callbackUri !== this.callbackUri)
      throw new Error("API origin changed; update the registered application callback");
    return row;
  }

  private async status(row: NativeAppConfig): Promise<NativeConfigStatus> {
    const status = nativeConfigStatus(row);
    if (row.appId === "wecom" && row.credentialKind === "oauth") {
      try {
        const secret = enterpriseConfigSecret(await this.credential(row));
        status.configured = Boolean(
          status.configured &&
            secret.verificationToken &&
            secret.encryptionKey &&
            secret.suiteTicket,
        );
      } catch {
        status.configured = false;
      }
    }
    return status;
  }

  async forEnterpriseCallback(id: string): Promise<NativeAppConfig> {
    const row = await this.prisma.nativeAppConfig.findUnique({ where: { id } });
    if (
      !row?.enabled ||
      !["wecom", "feishu-lark"].includes(row.appId) ||
      row.callbackUri !== this.callbackUri
    )
      throw new Error("Enterprise callback configuration is unavailable");
    return row;
  }

  /** Server-only: inline configuration credentials never enter member or editor DTOs. */
  async credential(row: NativeAppConfig, signal?: AbortSignal): Promise<string> {
    if (!row.ciphertext || !row.secretRecordId)
      throw new Error("Application credential is unavailable");
    return this.secrets.load(row.ciphertext, { recordId: row.secretRecordId, signal });
  }

  /** Verified rotating provider tickets do not change the owner-authorized configuration. */
  async recordEnterpriseTicket(
    configId: string,
    appId: string,
    expectedRevision: number,
    ticket: { platform: "feishu-lark" | "wecom"; value: string; issuedAt: number },
    signal: AbortSignal,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.forEnterpriseCallback(configId);
      const settings = NativeConfigSettingsSchema.parse(row.config);
      if (
        row.revision !== expectedRevision ||
        row.appId !== ticket.platform ||
        settings.clientId !== appId ||
        !settings.credentialOwner
      )
        throw new Error("Enterprise callback application does not match the configuration");
      const current = enterpriseConfigSecret(await this.credential(row, signal));
      const key = ticket.platform === "wecom" ? "suiteTicket" : "appTicket";
      if ((current[key]?.issuedAt ?? 0) >= ticket.issuedAt) return;
      const value = JSON.stringify({
        ...current,
        [key]: { value: ticket.value, issuedAt: ticket.issuedAt },
      });
      enterpriseConfigSecret(value);
      const material = await this.prepareSecret(value, {
        ...settings.credentialOwner,
        operationId: "native.enterprise.ticket",
        traceId: row.id,
        signal,
      });
      const saved = await persistPreparedSecret(this.prisma, this.secrets, material, () =>
        this.prisma.$transaction(
          async (tx) =>
            (
              await tx.nativeAppConfig.updateMany({
                where: {
                  id: row.id,
                  revision: row.revision,
                  enabled: true,
                  ciphertext: row.ciphertext,
                  secretRecordId: row.secretRecordId,
                },
                data: { ciphertext: material.ciphertext, secretRecordId: material.id },
              })
            ).count === 1,
        ),
      );
      if (saved) return;
    }
    throw new Error(
      "Enterprise credentials changed while accepting the ticket; retry the callback",
    );
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
    const botPlatform = ["telegram-bot", "discord"].includes(input.appId);
    const enterprise = ["feishu-lark", "dingtalk", "wecom"].includes(input.appId);
    const spaceBound = botPlatform || (enterprise && input.credentialKind === "machine_key");
    if (spaceBound) config.boundSpaceId = context.spaceId;
    if (enterprise) config.credentialOwner = { userId: context.userId, spaceId: context.spaceId };
    if (config.googleWatch) {
      const callback = new URL("/api/connectors/events/gmail", this.apiUrl);
      if (callback.protocol !== "https:" || config.googleWatch.callbackAudience !== callback.href)
        throw new Error(
          "Gmail push requires this instance's exact public HTTPS callback audience.",
        );
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
      spaceBound &&
      NativeConfigSettingsSchema.parse(previous.config).boundSpaceId !== context.spaceId
    )
      throw new Error("Switch to the space that owns this application configuration");
    if (
      !previous?.ciphertext &&
      !input.clientSecret &&
      ((botPlatform && input.ownership === "official") ||
        (["feishu-lark", "dingtalk", "wecom"].includes(input.appId) &&
          input.credentialKind === "machine_key"))
    )
      throw new Error("Configure this application's write-only credential first");
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
    const secretChanged = Boolean(
      input.clientSecret || input.verificationToken || input.encryptionKey,
    );
    let secretValue = input.clientSecret;
    if (enterprise && secretChanged) {
      const old =
        previous?.ciphertext && previous.secretRecordId
          ? enterpriseConfigSecret(await this.credential(previous))
          : undefined;
      secretValue = JSON.stringify({
        version: 1,
        clientSecret: input.clientSecret ?? old?.clientSecret,
        ...((input.verificationToken ?? old?.verificationToken)
          ? { verificationToken: input.verificationToken ?? old?.verificationToken }
          : {}),
        ...((input.encryptionKey ?? old?.encryptionKey)
          ? { encryptionKey: input.encryptionKey ?? old?.encryptionKey }
          : {}),
      });
      enterpriseConfigSecret(secretValue);
    }
    const material = secretValue ? await this.prepareSecret(secretValue, context) : undefined;
    const advancesAuthorization =
      !previous ||
      Boolean(material) ||
      previous.enabled !== input.enabled ||
      previous.callbackUri !== this.callbackUri ||
      JSON.stringify(NativeConfigSettingsSchema.parse(previous.config)) !== JSON.stringify(config);
    return persistPreparedSecret(this.prisma, this.secrets, material, async () => {
      const row = await this.prisma.$transaction(async (tx) => {
        if (config.googleWatch && input.enabled) {
          const configuredWatch = config.googleWatch;
          // Configuration is deployment-owned. Serialize one project's fixed mailbox topic across admin writers.
          await tx.$executeRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('native-gmail-watch-project'),hashtext(${configuredWatch.projectId}))`,
          );
          const peers = await tx.nativeAppConfig.findMany({
            where: {
              appId: "gmail",
              enabled: true,
              ...(input.id ? { id: { not: input.id } } : {}),
            },
            select: { config: true },
          });
          for (const peer of peers) {
            const watch = NativeConfigSettingsSchema.parse(peer.config).googleWatch;
            if (
              watch?.projectId === configuredWatch.projectId &&
              watch.topicName !== configuredWatch.topicName
            )
              throw new Error(
                "Gmail configurations in this instance must share one fixed topic per Google project.",
              );
            if (
              watch?.subscriptionName === configuredWatch.subscriptionName &&
              (watch.callbackAudience !== configuredWatch.callbackAudience ||
                watch.pushServiceAccountEmail !== configuredWatch.pushServiceAccountEmail)
            )
              throw new Error(
                "A Gmail push subscription requires one exact callback audience and service account.",
              );
          }
        }
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
            appId: data.appId,
            label: data.label,
            ownership: data.ownership,
            credentialKind: data.credentialKind,
            enabled: data.enabled,
            config: data.config,
            callbackUri: data.callbackUri,
            ...(material ? { ciphertext: material.ciphertext, secretRecordId: material.id } : {}),
            ...(advancesAuthorization ? { revision: { increment: 1 } } : {}),
          },
        });
        if (!changed.count)
          throw new Error("Application configuration changed; refresh before saving");
        return tx.nativeAppConfig.findUniqueOrThrow({
          where: { id: previous.id },
        });
      });
      return this.status(row);
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
