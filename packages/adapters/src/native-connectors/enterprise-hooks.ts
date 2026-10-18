import type { PrismaClient } from "@rakazo/db";
import { NativeActionError } from "./action.js";
import type { NativeConfigStore } from "./config.js";
import { NativeConfigSettingsSchema } from "./config.js";
import type { EnterpriseCallbackInput, EnterpriseCallbackResult } from "./enterprise/callbacks.js";
import { verifyEnterpriseCallback } from "./enterprise/callbacks.js";
import { enterpriseConfigSecret } from "./enterprise-config-secret.js";

/** Configuration callbacks manage provider tickets and existing grants only. */
export class NativeEnterpriseHookStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly configs: NativeConfigStore,
  ) {}
  async accept(
    configId: string,
    input: EnterpriseCallbackInput,
    signal: AbortSignal,
  ): Promise<EnterpriseCallbackResult> {
    const config = await this.configs.forEnterpriseCallback(configId);
    const settings = NativeConfigSettingsSchema.parse(config.config);
    const secret = enterpriseConfigSecret(await this.configs.credential(config, signal));
    if (!settings.clientId || !secret.verificationToken || !secret.encryptionKey)
      throw new NativeActionError(
        "not_configured",
        "Configure this application's callback credentials first.",
      );
    const result = verifyEnterpriseCallback(
      {
        appId: config.appId as "feishu-lark" | "wecom",
        clientId: settings.clientId,
        tenantId: settings.tenantId,
        region: settings.region,
        verificationToken: secret.verificationToken,
        encryptionKey: secret.encryptionKey,
      },
      input,
    );
    if (result.type === "ticket") {
      if (config.credentialKind !== "oauth")
        throw new NativeActionError(
          "invalid_input",
          "This configuration does not receive store application tickets.",
        );
      await this.configs.recordEnterpriseTicket(
        config.id,
        result.appId,
        config.revision,
        { platform: result.platform, value: result.ticket, issuedAt: result.issuedAt },
        signal,
      );
    }
    if (result.type === "installation" && result.action !== "create") {
      if (!result.tenantId || config.credentialKind !== "oauth")
        throw new NativeActionError(
          "authorization_required",
          "The installation callback omitted its authorized enterprise.",
        );
      // Signed create_auth is acknowledged, never adopted without a browser's
      // one-use state. Old cancellation replays cannot retire newer grants.
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM native_app_configs WHERE id = ${config.id} FOR UPDATE`;
        const current = await tx.nativeAppConfig.findFirst({
          where: { id: config.id, revision: config.revision, enabled: true },
        });
        if (!current)
          throw new NativeActionError(
            "authorization_required",
            "The application configuration changed.",
          );
        const grants = await tx.nativeOAuthGrant.findMany({
          where: {
            configId: config.id,
            configRevision: config.revision,
            tenant: result.tenantId,
            revokedAt: null,
          createdAt: { lt: new Date((result.issuedAt + 1) * 1000) },
          },
        });
        for (const grant of grants) {
          await tx.nativeOAuthGrant.updateMany({
            where: { id: grant.id, revokedAt: null },
            data: {
              revokedAt: new Date(),
              secretId: null,
              authGeneration: { increment: 1 },
              refreshLeaseId: null,
              refreshLeaseUntil: null,
              refreshRecoveryUntil: null,
            },
          });
          await tx.connection.updateMany({
            where: { oauthGrantId: grant.id, status: "connected" },
            data: { status: "error" },
          });
          if (grant.secretId)
            await tx.secret.deleteMany({
              where: { id: grant.secretId, userId: grant.userId, spaceId: grant.spaceId },
            });
        }
      });
    }
    return result;
  }
}
