import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ChatSdkMessagingSurface,
  MESSAGING_WEBHOOK_MAX_BODY_BYTES,
  readBoundedText,
} from "./chat-sdk-surface.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

export const SLACK_INSTALL_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:write",
  "im:history",
  "mpim:read",
  "mpim:history",
  "users:read",
  "reactions:write",
  "files:read",
  "files:write",
];

export class SlackInstallProvider {
  readonly provider = "slack";
  constructor(
    private readonly config: {
      clientId: string;
      clientSecret: string;
      signingSecret: string;
      redirectUri: string;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  authorizeUrl(state: string): string {
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      scope: SLACK_INSTALL_SCOPES.join(","),
      redirect_uri: this.config.redirectUri,
      state,
    }).toString();
    return url.toString();
  }

  async exchange(code: string) {
    const response = await this.fetcher("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        code,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readBoundedText(response, 65_536);
    if (body === null) throw new Error("Slack workspace authorization failed");
    const result = JSON.parse(body) as {
      ok?: boolean;
      access_token?: string;
      token_type?: string;
      scope?: string;
      authed_user?: { id?: string };
      bot_user_id?: string;
      team?: { id?: string; name?: string };
      is_enterprise_install?: boolean;
      refresh_token?: string;
    };
    // Org-wide installs and rotating tokens need distinct lifecycle support.
    if (
      !response.ok ||
      result?.ok !== true ||
      result.token_type !== "bot" ||
      typeof result.access_token !== "string" ||
      !result.access_token ||
      !slackId(result.team?.id, "T") ||
      !slackId(result.authed_user?.id, "UW") ||
      !slackId(result.bot_user_id, "UW") ||
      typeof result.scope !== "string" ||
      !SLACK_INSTALL_SCOPES.every((scope) => result.scope!.split(",").includes(scope)) ||
      result.is_enterprise_install ||
      result.refresh_token
    )
      throw new Error("Slack workspace authorization failed");
    return {
      workspaceId: result.team!.id!,
      workspaceName:
        typeof result.team?.name === "string"
          ? result.team.name.trim().slice(0, 160) || "Slack"
          : "Slack",
      installerId: result.authed_user!.id!,
      providerBotId: result.bot_user_id,
      credential: result.access_token,
    };
  }

  surface(credential: string) {
    return new ChatSdkMessagingSurface(
      messagingPlatformsFromEnv({
        slackBotToken: credential,
        slackSigningSecret: this.config.signingSecret,
      }),
    );
  }

  credentialWasRejected(error: unknown): boolean {
    const failure = error as { cause?: { data?: { error?: unknown } } } | null;
    const code = failure?.cause?.data?.error;
    return code === "invalid_auth" || code === "token_revoked" || code === "account_inactive";
  }

  async parseWebhook(request: Request): Promise<{
    request: Request;
    workspaceId?: string;
    challenge?: string;
    eventAt?: Date;
    uninstalled: boolean;
    revokedBots?: string[];
  }> {
    const body = await readBoundedText(request, MESSAGING_WEBHOOK_MAX_BODY_BYTES);
    if (body === null) throw new Error("Invalid webhook");
    const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
    const signature = request.headers.get("x-slack-signature") ?? "";
    if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
      throw new Error("Invalid webhook");
    const expected = `v0=${createHmac("sha256", this.config.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new Error("Invalid webhook");
    const payload = JSON.parse(body) as {
      type?: string;
      challenge?: string;
      team_id?: string;
      event_time?: number;
      event?: { type?: string; tokens?: { bot?: unknown[] } };
    };
    return {
      request: new Request(request.url, { method: request.method, headers: request.headers, body }),
      workspaceId: slackId(payload?.team_id, "T") ? payload.team_id : undefined,
      challenge:
        payload?.type === "url_verification" && typeof payload.challenge === "string"
          ? payload.challenge
          : undefined,
      eventAt:
        Number.isSafeInteger(payload?.event_time) &&
        payload.event_time! > 0 &&
        payload.event_time! <= Math.floor(Date.now() / 1000)
          ? new Date(payload.event_time! * 1000)
          : undefined,
      uninstalled: payload?.event?.type === "app_uninstalled",
      revokedBots:
        payload?.event?.type === "tokens_revoked" && Array.isArray(payload.event.tokens?.bot)
          ? payload.event.tokens.bot.filter((id): id is string => slackId(id, "UW"))
          : undefined,
    };
  }
}

function slackId(value: unknown, prefixes: string): value is string {
  return typeof value === "string" && new RegExp(`^[${prefixes}][A-Z0-9]{1,40}$`).test(value);
}
