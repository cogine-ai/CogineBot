import type { NativeAppConfig } from "@rakazo/db";
import type { RemoteTransportDependencies } from "../../remote-mcp.js";
import { NativeActionError } from "../action.js";
import type { NativeAuthorization } from "../authorities.js";
import { object, text } from "../collaboration-action.js";
import { NativeHttpClient } from "../http.js";
import { BOT_PLATFORM_METADATA, isBotPlatformApp } from "./metadata.js";
import type { VerifiedTarget } from "./permissions.js";
import {
  discordBot,
  discordTarget,
  id,
  settings,
  telegramBot,
  telegramTarget,
} from "./permissions.js";

export class BotPlatformAuthorities {
  constructor(private readonly network: RemoteTransportDependencies = {}) {}
  async close(): Promise<void> {}
  async verifyStatic(
    config: NativeAppConfig,
    credential: string,
    signal: AbortSignal,
  ): Promise<NativeAuthorization> {
    const s = settings(config);
    if (!isBotPlatformApp(config.appId) || !credential || /[\r\n]/.test(credential))
      throw new NativeActionError("invalid_input", "Enter a supported bot token.");
    const telegram = config.appId === "telegram-bot";
    const client = new NativeHttpClient(
      BOT_PLATFORM_METADATA[config.appId].baseUrl,
      async () =>
        telegram
          ? { kind: "telegram_bot", value: credential }
          : { kind: "raw", value: `Bot ${credential}` },
      { signal, readOnly: true, network: this.network },
    );
    try {
      const request = client.request.bind(client),
        user = telegram ? await telegramBot(request) : await discordBot(request),
        botId = id(user.id),
        verifiedTargets: VerifiedTarget[] = [];
      let applicationId: string | undefined;
      let interactionPublicKey: string | undefined;
      if (!telegram) {
        const app = object(
          (await request({ method: "GET", path: "/oauth2/applications/@me" })).body,
        );
        applicationId = id(app.id);
        if (app.bot !== undefined && id(object(app.bot).id) !== botId)
          throw new NativeActionError(
            "authorization_required",
            "Discord returned another application bot.",
          );
        if (typeof app.verify_key !== "string" || !/^[0-9a-f]{64}$/i.test(app.verify_key))
          throw new NativeActionError(
            "incomplete_response",
            "Discord omitted the application verification key.",
          );
        interactionPublicKey = app.verify_key;
      }
      for (const targetId of s.targetIds) {
        if (telegram) {
          await telegramTarget(request, botId, targetId);
          verifiedTargets.push({ id: targetId });
        } else {
          const proof = await discordTarget(request, botId, s.tenantId!, targetId);
          verifiedTargets.push({
            id: targetId,
            guildId: s.tenantId!,
            permissions: proof.permissions.toString(),
          });
        }
      }
      return {
        tokens: { accessToken: credential, refreshToken: null },
        scopes: [],
        expiresAt: null,
        identity: {
          authority: telegram ? "https://api.telegram.org" : "https://discord.com",
          subject: botId,
          tenant: telegram ? null : s.tenantId!,
          displayName: telegram
            ? typeof user.username === "string"
              ? `@${user.username}`
              : text(user.first_name)
            : text(user.username),
          context: {
            actorType: "bot",
            credentialType: "bot_token",
            scopeAuthority: "provider_enforced",
            botId,
            boundSpaceId: s.boundSpaceId,
            configRevision: config.revision,
            verifiedTargets,
            ...(applicationId
              ? { applicationId, interactionPublicKey, bindingNamespace: "guild" }
              : {}),
            ...(telegram
              ? { canReadAllGroupMessages: user.can_read_all_group_messages === true }
              : {}),
          },
        },
      };
    } finally {
      await client.close();
    }
  }
}
