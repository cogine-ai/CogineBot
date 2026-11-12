import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ChatSdkMessagingSurface,
  MESSAGING_WEBHOOK_MAX_BODY_BYTES,
  MessagingSendError,
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

  get clientId() {
    return this.config.clientId;
  }

  async verifyGrant(credential: string, workspaceId: string, botUserId: string) {
    const response = await this.fetcher("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    const body = response.ok && (await readBoundedText(response, 65_536));
    const result = body
      ? (JSON.parse(body) as { ok?: boolean; error?: unknown; team_id?: string; user_id?: string })
      : null;
    if (result?.ok === true) return result.team_id === workspaceId && result.user_id === botUserId;
    if (isInvalidSlackCredential(result?.error)) return false;
    throw new Error("Slack grant could not be verified");
  }

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
      app_id?: string;
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
      !slackId(result.app_id, "A") ||
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
    const installerName = await this.installerName(result.authed_user!.id!, result.access_token);
    return {
      workspaceId: result.team!.id!,
      appId: result.app_id,
      workspaceName:
        typeof result.team?.name === "string"
          ? result.team.name.trim().slice(0, 160) || "Slack"
          : "Slack",
      installerId: result.authed_user!.id!,
      ...(installerName && { installerName }),
      providerBotId: result.bot_user_id,
      credential: result.access_token,
    };
  }

  private async installerName(userId: string, credential: string) {
    try {
      const url = new URL("https://slack.com/api/users.info");
      url.searchParams.set("user", userId);
      const response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${credential}` },
        redirect: "error",
        signal: AbortSignal.timeout(4_000),
      });
      const text = response.ok && (await readBoundedText(response, 65_536));
      const payload = text
        ? (JSON.parse(text) as {
            user?: { real_name?: unknown; profile?: { display_name?: unknown } };
          })
        : null;
      const name = payload?.user?.profile?.display_name || payload?.user?.real_name;
      return typeof name === "string" ? name.trim().slice(0, 160) : undefined;
    } catch {
      return undefined;
    }
  }

  surface(
    credential: string,
    current: () => Promise<boolean>,
    onSlackAuthFailure?: (error: unknown) => Promise<void>,
  ) {
    return new ChatSdkMessagingSurface(
      messagingPlatformsFromEnv(
        {
          slackBotToken: credential,
          slackSigningSecret: this.config.signingSecret,
        },
        {
          onSlackAuthFailure,
          beforeSlackRequest: async () => {
            if (!(await current())) throw new MessagingSendError("permanent", "rejected");
          },
        },
      ),
    );
  }

  credentialWasRejected(error: unknown): boolean {
    const failure = error as {
      data?: { error?: unknown };
      cause?: { data?: { error?: unknown } };
    } | null;
    const code = failure?.data?.error ?? failure?.cause?.data?.error;
    return isInvalidSlackCredential(code);
  }

  async parseWebhook(request: Request): Promise<{
    request: Request;
    workspaceId?: string;
    appId?: string;
    challenge?: string;
    eventAt?: Date;
    preciseEventTime: boolean;
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
      api_app_id?: string;
      event_time?: number;
      event?: { type?: string; event_ts?: string; ts?: string; tokens?: { bot?: unknown[] } };
    };
    const event = payload?.event;
    const wireTime = event?.event_ts ?? event?.ts;
    const millis =
      typeof wireTime === "string" && /^\d{9,11}\.\d{1,6}$/.test(wireTime)
        ? Math.floor(Number(wireTime) * 1000)
        : undefined;
    const preciseEventTime = millis !== undefined && millis > 0 && millis <= Date.now() + 5_000;
    return {
      request: new Request(request.url, { method: request.method, headers: request.headers, body }),
      workspaceId: slackId(payload?.team_id, "T") ? payload.team_id : undefined,
      appId: slackId(payload?.api_app_id, "A") ? payload.api_app_id : undefined,
      challenge:
        payload?.type === "url_verification" && typeof payload.challenge === "string"
          ? payload.challenge
          : undefined,
      preciseEventTime,
      eventAt: preciseEventTime
        ? new Date(millis!)
        : Number.isSafeInteger(payload?.event_time) &&
            payload.event_time! > 0 &&
            payload.event_time! <= Math.floor(Date.now() / 1000) + 5
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

function isInvalidSlackCredential(code: unknown) {
  return code === "invalid_auth" || code === "token_revoked" || code === "account_inactive";
}
