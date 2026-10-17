import { randomUUID } from "node:crypto";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { NativeConfigInput, NativeConfigStatus } from "@rakazo/contracts";
import { NATIVE_OAUTH_CALLBACK_PATH, NativeConfigInputSchema } from "@rakazo/contracts";
import type { NativeAppConfig, PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { assertNoSensitiveQuery } from "../connector-http.js";
import { actorMayUsePrivateEndpoint } from "../private-endpoint.js";
import type { RemoteTransportDependencies } from "../remote-mcp.js";
import { assertSafeRemoteUrl } from "../remote-mcp.js";
import { persistPreparedSecret } from "../secret-persistence.js";

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
  if (input.appId === "google-calendar") {
    if (!input.scopes.includes("openid")) throw new Error("Calendar identity requires openid");
    if (input.scopes.some((scope) => !CALENDAR_SCOPES.some((allowed) => allowed === scope)))
      throw new Error("Unsupported Calendar scope");
  } else if (input.scopes.length) {
    throw new Error("This authorization protocol does not accept Calendar OAuth scopes");
  }
  const allowed =
    input.appId === "knowai"
      ? KNOWAI_CAPABILITIES
      : input.appId === "notion"
        ? NOTION_CAPABILITIES
        : new Set<string>();
  if (input.capabilities.some((capability) => !allowed.has(capability)))
    throw new Error("Unsupported service capability");
  return {
    ...(input.endpoint ? { endpoint: input.endpoint.replace(/\/$/, "") } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    scopes: [...new Set(input.scopes)].sort(),
    capabilities: [...new Set(input.capabilities)].sort(),
    knowledgeBaseIds: [...new Set(input.knowledgeBaseIds)].sort(),
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
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
      ? await this.prisma.nativeAppConfig.findUnique({ where: { id: input.id } })
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
          data: { ...data, revision: { increment: 1 } },
        });
        if (!changed.count)
          throw new Error("Application configuration changed; refresh before saving");
        return tx.nativeAppConfig.findUniqueOrThrow({ where: { id: previous.id } });
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
